/**
 * Fee Charge Service — WKH-44 · 1% Protocol Fee Real Charge
 *
 * Encapsula la lógica de cobro del protocol fee:
 *   - `getProtocolFeeRate()`: lee `PROTOCOL_FEE_RATE` de env en cada request,
 *     con safety guard rango [0.0, 0.10] y fallback 0.01.
 *   - `chargeProtocolFee(params)`: transfer EIP-712 best-effort hacia
 *     `WASIAI_PROTOCOL_FEE_WALLET` con idempotencia DB (tabla
 *     `a2a_protocol_fees`, PK en `orchestration_id`).
 *
 * Reglas críticas (SDD §5):
 *   - CD-B: `chargeProtocolFee` JAMÁS rechaza la promise — captura todo
 *     error y retorna `{status:'failed', ...}`.
 *   - CD-G: el rate NUNCA se cachea ni se hardcodea; se re-lee en cada call.
 *   - CD-E: el guard usa `Number.isFinite` (rechaza NaN + Infinity).
 *   - CD-F: `let` antes de try/catch con tipo explícito.
 *   - CD-1: cero `any` explícito.
 *   - CD-2: si `WASIAI_PROTOCOL_FEE_WALLET` vacío → skip silencioso (warn).
 *   - CD-7: viem only (reusamos el PaymentAdapter existente).
 */

import { hasBroadcastEvidence } from '../adapters/errors.js';
import { getPaymentAdapter } from '../adapters/registry.js';
import { verifyDefaultChainSettle } from '../adapters/settle-verifier.js';
import type { SignResult } from '../adapters/types.js';
import {
  getSplitConfig,
  type SplitConfig,
  SplitConfigError,
} from '../config/split-config.js';
import { getLogger } from '../lib/logger.js';
import { classifyOperatorError } from '../lib/operator-funding.js';
import { supabase } from '../lib/supabase.js';
import {
  computeSplits,
  resolveRecipients,
  type SplitContext,
  type SplitLeg,
  type SplitPartyRef,
  settleFeeSplits,
} from './fee-split.js';
import { usdToAtomic } from './payment-intent.js';

const log = getLogger('fee-charge');

// ─── Tipos públicos ─────────────────────────────────────────

export interface FeeChargeParams {
  orchestrationId: string;
  /**
   * Base sobre la que se aplica el rate. NO es "el budget declarado":
   * es el COSTO REAL del pipeline (compose.ts:539 y orchestrate execute pasan
   * result/pipeline.totalCostUsdc). El guard interno `feeUsdc > feeBaseUsdc`
   * es entonces cost-vs-cost (⟺ rate>1), el safety guard del fee.
   */
  feeBaseUsdc: number;
  feeRate: number;
  /**
   * WKH-143 (DT-1) — contexto YA resuelto del creador del pipeline primario.
   * Aditivo: un caller que NO lo pase se comporta idéntico a hoy (creator se
   * re-ruta a plataforma vía SG-6). Resuelto SOLO server-side (CD-4).
   */
  creator?: SplitPartyRef | null;
  /**
   * WKH-143 (DT-1/DT-6) — contexto de referral. El seam queda cableado, pero el
   * call-site lo resuelve `null` siempre en v1 (Scope OUT).
   */
  referral?: SplitPartyRef | null;
}

/**
 * Resultado del intento de cobro. Discriminated union por `status` — el
 * caller hace `switch`/`if` sobre `result.status` para narrowing seguro.
 */
export type FeeChargeResult =
  | { status: 'charged'; feeUsdc: number; txHash: string; splits?: SplitLeg[] }
  | {
      status: 'already-charged';
      feeUsdc: number;
      txHash?: string | undefined;
      inProgress?: boolean | undefined;
      splits?: SplitLeg[] | undefined;
    }
  | {
      status: 'skipped';
      feeUsdc: number;
      reason: 'WALLET_UNSET';
      splits?: SplitLeg[] | undefined;
    }
  | { status: 'failed'; feeUsdc: number; error: string; splits?: SplitLeg[] };

/**
 * Error de validación (rate > budget u otro caso irrecuperable antes del
 * transfer). Fastify usa `statusCode` en la serialización → HTTP 400.
 */
export class ProtocolFeeError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolFeeError';
  }
}

// ─── Constantes ─────────────────────────────────────────────

const DEFAULT_FEE_RATE = 0.01;
const MAX_FEE_RATE = 0.1;
const MIN_FEE_RATE = 0.0;
const FEES_TABLE = 'a2a_protocol_fees';
const PG_UNIQUE_VIOLATION = '23505';

// Tipos minimos de los rows que tocamos (CD-1 — nada de any).
interface ExistingFeeRow {
  status: 'pending' | 'charged' | 'failed' | 'skipped';
  tx_hash: string | null;
}

interface SupabaseError {
  code?: string;
  message?: string;
}

// ─── getProtocolFeeRate ─────────────────────────────────────

/**
 * Lee `PROTOCOL_FEE_RATE` de `process.env` por request. Sin cache (CD-G).
 *
 * Rango válido: [0.0, 0.10]. Fuera de rango / no parseable / NaN /
 * Infinity → fallback `0.01` + structured `log.error`.
 *
 * @returns el rate aplicable (0.01 por default)
 */
export function getProtocolFeeRate(): number {
  const raw = process.env.PROTOCOL_FEE_RATE;
  if (raw === undefined || raw === '') return DEFAULT_FEE_RATE;

  const parsed = Number.parseFloat(raw);

  // CD-E: Number.isFinite rechaza NaN e Infinity en una sola llamada
  // (parseFloat("abc") → NaN; parseFloat("Infinity") → Infinity).
  if (
    !Number.isFinite(parsed) ||
    parsed < MIN_FEE_RATE ||
    parsed > MAX_FEE_RATE
  ) {
    log.error(
      { raw, min: MIN_FEE_RATE, max: MAX_FEE_RATE, fallback: DEFAULT_FEE_RATE },
      'Invalid PROTOCOL_FEE_RATE (must be finite number in range); falling back to default',
    );
    return DEFAULT_FEE_RATE;
  }

  return parsed;
}

// ─── chargeProtocolFee ──────────────────────────────────────

/**
 * Convierte feeUsdc al valor atómico del token de la default chain (WKH-195).
 *
 * Deriva los decimales del `getPaymentAdapter()` SIN `chainKey`: el registry
 * devuelve el mismo default-chain singleton determinístico (registry.ts:185-200)
 * que usan el sign/settle de `chargeProtocolFee` (:448/:471) y de `settleFeeSplits`
 * (fee-split.ts:417/432) → los decimales acá son los MISMOS que firman/settlean,
 * sin drift. Delega la conversión en `usdToAtomic` (WKH-192, reuse DRY), que es
 * byte-idéntico al legado `× 1e12` cuando `decimals === 18` (Kite/PYUSD) por
 * construcción, y correcto para 6d (Base/USDC).
 *
 * Fallback `?? 18` sin throw: si el adapter no expone `supportedTokens` (vacío o
 * undefined), cae a 18d — preserva la garantía CD-B de que `chargeProtocolFee`
 * jamás rechaza la promise.
 */
export function feeUsdcToWei(feeUsdc: number): string {
  const adapter = getPaymentAdapter();
  const decimals = adapter.supportedTokens?.[0]?.decimals ?? 18; // CD-4
  return usdToAtomic(feeUsdc, decimals); // CD-1 (reuse WKH-192)
}

/**
 * Trunca a 180 chars para encajar en `error_message TEXT` sin problemas
 * (Postgres acepta cualquier tamaño, pero acá cortamos por prolijidad).
 */
function truncateError(msg: string): string {
  return msg.length > 180 ? `${msg.slice(0, 177)}...` : msg;
}

/**
 * Transfer del fee via EIP-712 sign + settle. Best-effort, nunca rechaza
 * (CD-B), excepto cuando `feeUsdc > budget` (safety guard → ProtocolFeeError).
 * Idempotencia DB via PK `a2a_protocol_fees.orchestration_id`.
 *
 * Flujo (SDD §3 DT-6):
 *   1. Si `WASIAI_PROTOCOL_FEE_WALLET` vacío → skip sin tocar DB.
 *   2. Calcular `feeUsdc = budget * rate` (6 decimales) + safety guard.
 *   3. Query idempotency por `orchestration_id`.
 *      - charged → retornar already-charged con txHash existente.
 *      - pending → retornar already-charged inProgress=true (otra llamada activa).
 *      - failed / skipped → avanza al paso 4, y ahí el insert choca contra la
 *        PK ⇒ already-charged inProgress=true. NO hay reintento del cobro: ver
 *        el comentario del paso 3 antes de intentar habilitarlo (una fila
 *        `failed` puede llevar el hash de un broadcast real).
 *   4. INSERT `pending` con ON CONFLICT DO NOTHING.
 *      - error 23505 (unique_violation) → already-charged inProgress=true.
 *   5. `paymentAdapter.sign({...})` + `settle({...})` con mismo patrón que
 *      `src/services/compose.ts:191-213`.
 *   6. UPDATE status `charged` + tx_hash (o `failed` + error_message).
 */
export async function chargeProtocolFee(
  params: FeeChargeParams,
): Promise<FeeChargeResult> {
  const { orchestrationId, feeBaseUsdc, feeRate } = params;

  // Paso 2 parcial: cálculo del fee TOTAL (siempre retornado en el shape). Es la
  // magnitud que WKH-132/133 reporta al caller; los splits la SUBDIVIDEN, NUNCA
  // la cambian (CD-5/CD-P4/AC-5).
  const feeUsdc = Number((feeBaseUsdc * feeRate).toFixed(6));

  // Safety guard (CD-3): si el fee supera el budget, esto no se cobra; es
  // síntoma de un rate corrupto → ProtocolFeeError (HTTP 400 en el route).
  if (feeUsdc > feeBaseUsdc) {
    throw new ProtocolFeeError(
      `Protocol fee (${feeUsdc}) exceeds budget (${feeBaseUsdc}) — check PROTOCOL_FEE_RATE env var.`,
    );
  }

  // WKH-136 (CD-1/AC-2) + BLQ-MED-1: config de splits fail-CLOSED ANTES de
  // cualquier transfer. Una config corrupta (Σ≠10000 / bps inválido) es
  // `SplitConfigError`. Semántica: NO se cobra nada (fail-CLOSED — cero cobro
  // parcial, nunca a la wallet equivocada).
  //
  // MECANISMO de propagación (BLQ-MED-1): NO se hace `throw`. Se captura acá y
  // se devuelve como el shape CD-B `{status:'failed', ...}` — idéntico a los
  // demás fallos de fee. Rationale: `chargeProtocolFee` corre DESPUÉS de que el
  // pipeline tuvo éxito y el caller ya fue debitado. `/compose` envuelve la
  // llamada en try/catch (compose.ts:611) y responde 200 con `feeChargeError`,
  // pero `/orchestrate/execute` (orchestrate.ts:1065) NO tiene try/catch → un
  // throw acá propagaba hasta routes/orchestrate.ts:451-461 y el caller recibía
  // un error EN VEZ de su resultado ya pagado. Devolver `failed` en lugar de
  // throw hace que AMBOS call-sites se comporten igual: fee no cobrado, pero la
  // orquestación exitosa se responde 200 (invariante orchestrate.ts:1061-1063).
  // CD-P1: la firma pública NO cambia.
  let splitConfig: SplitConfig;
  try {
    splitConfig = getSplitConfig();
  } catch (cfgErr) {
    if (cfgErr instanceof SplitConfigError) {
      log.error(
        { orchestrationId, detail: cfgErr.message },
        'invalid split config; fee NOT charged (fail-CLOSED)',
      );
      return { status: 'failed', feeUsdc, error: cfgErr.message };
    }
    throw cfgErr;
  }

  // Paso 1 (CD-2): wallet vacía → skip silencioso. NO tocamos DB.
  const walletAddress = process.env.WASIAI_PROTOCOL_FEE_WALLET;
  if (!walletAddress || walletAddress === '') {
    log.warn('WASIAI_PROTOCOL_FEE_WALLET not set, skipping fee transfer');
    return { status: 'skipped', feeUsdc, reason: 'WALLET_UNSET' };
  }

  // WKH-136/WKH-143 (CD-6/CD-4): recipients resueltos SOLO server-side. El
  // contexto de creator/referral ya viene resuelto por el call-site (helper
  // `resolveAgentSplitContext`) y se transporta vía `params`. Si el caller NO lo
  // pasa (o el gate `splitsActive()` estaba en `false`), creator/referral quedan
  // ausentes → su bps se re-ruta a plataforma (fila `skipped`, SG-6). Con la
  // config default 10000/0/0 hay UN solo recipient (plataforma) con
  // amount==feeUsdc ⇒ byte-idéntico a WKH-44/132.
  //
  // CD-8 (exactOptionalPropertyTypes): asignación condicional — NUNCA
  // `creator: cond ? v : undefined`.
  const ctx: SplitContext = { platformWallet: walletAddress };
  if (params.creator) ctx.creator = params.creator;
  if (params.referral) ctx.referral = params.referral;
  const resolution = resolveRecipients(splitConfig, ctx);
  const amounts = computeSplits(feeUsdc, resolution.effectiveBps);
  const platformAmount = amounts.platform;
  const platformBpsEff = resolution.effectiveBps.platform;
  const extraRecipients = resolution.recipients
    .filter((r) => r.role !== 'platform')
    .map((r) => ({ ...r, amountUsdc: amounts[r.role] }))
    .filter((r) => r.amountUsdc > 0);

  // A partir de acá todo va wrappeado en try/catch (CD-B: jamás rechazar).
  try {
    // Legs ADICIONALES (creador/referral) + filas `skipped` → `a2a_fee_splits`
    // (CD-2, engine idempotente por recipient). En default NO hay extras ni
    // skipped ⇒ NO se invoca ⇒ cero writes a `a2a_fee_splits` ⇒ byte-idéntico.
    let extraLegs: SplitLeg[] = [];
    let extrasFailed: string | undefined;
    if (extraRecipients.length > 0 || resolution.skipped.length > 0) {
      const extra = await settleFeeSplits({
        orchestrationId,
        recipients: extraRecipients,
        skipped: resolution.skipped,
      });
      extraLegs = extra.legs;
      if (extra.status === 'failed')
        extrasFailed = extra.error ?? 'split leg failed';
    }

    // MNR-3 (WKH-143 / AC-6 / DT-7 — cerrado): con el seam cableado, un leg
    // ADICIONAL (creator/referral) puede fallar su settle. `extrasFailed` ya está
    // calculado (arriba) ANTES de los returns tempranos, así que cada uno de
    // ellos (`already-charged` charged/in-progress + 23505 unique_violation)
    // TAMBIÉN lo consulta y degrada el agregado a 'failed' — para no reportar
    // 'already-charged' cuando un split adicional obligatorio quedó roto.
    // Simétrico al path de éxito (:~489).

    // Construye el array de splits: leg de plataforma (a2a_protocol_fees, CD-2:
    // NO reusa esa PK para >1 recipient) + los legs adicionales.
    const buildSplits = (
      status: SplitLeg['status'],
      txHash?: string,
      error?: string,
    ): SplitLeg[] => {
      const platformLeg: SplitLeg = {
        role: 'platform',
        wallet: walletAddress,
        ownerRef: 'platform',
        bps: platformBpsEff,
        amountUsdc: platformAmount,
        status,
      };
      if (txHash !== undefined) platformLeg.txHash = txHash;
      if (error !== undefined) platformLeg.error = error;
      return [platformLeg, ...extraLegs];
    };

    // Paso 3: idempotency query (leg de plataforma).
    const { data: existing, error: selectErr } = (await supabase
      .from(FEES_TABLE)
      .select('status, tx_hash')
      .eq('orchestration_id', orchestrationId)
      .maybeSingle()) as {
      data: ExistingFeeRow | null;
      error: SupabaseError | null;
    };

    if (selectErr) {
      log.error(
        { orchestrationId, detail: selectErr.message },
        'DB select error',
      );
      return {
        status: 'failed',
        feeUsdc,
        error: `DB_ERROR: ${selectErr.message ?? 'unknown'}`,
        splits: buildSplits(
          'failed',
          undefined,
          `DB_ERROR: ${selectErr.message ?? 'unknown'}`,
        ),
      };
    }

    if (existing) {
      if (existing.status === 'charged') {
        // MNR-3 (AC-6): un leg adicional obligatorio falló → agregado 'failed'
        // aunque el leg de plataforma esté already-charged.
        if (extrasFailed !== undefined) {
          return {
            status: 'failed',
            feeUsdc,
            error: extrasFailed,
            splits: buildSplits(
              'already-charged',
              existing.tx_hash ?? undefined,
            ),
          };
        }
        return {
          status: 'already-charged',
          feeUsdc,
          txHash: existing.tx_hash ?? undefined,
          splits: buildSplits('already-charged', existing.tx_hash ?? undefined),
        };
      }
      if (existing.status === 'pending') {
        // MNR-3 (AC-6): leg adicional falló → 'failed' aunque el leg de
        // plataforma esté in-progress.
        if (extrasFailed !== undefined) {
          return {
            status: 'failed',
            feeUsdc,
            error: extrasFailed,
            splits: buildSplits('in-progress'),
          };
        }
        // Otra request activa — evita race en retries.
        return {
          status: 'already-charged',
          feeUsdc,
          inProgress: true,
          splits: buildSplits('in-progress'),
        };
      }
      // 'failed' | 'skipped' → NO se reintenta. Cae al insert de abajo y ese
      // insert SIEMPRE choca: `orchestration_id` es PK
      // (`20260421015829_a2a_protocol_fees.sql:8`) y la fila que acabamos de
      // leer ya ocupa esa clave. El 23505 de abajo (línea ~419) devuelve
      // `already-charged { inProgress: true }`, así que `sign()`/`settle()` NO
      // se ejecutan: un fee genuinamente `failed` no se cobra nunca más por
      // este camino. (Falsable: si un 2º `chargeProtocolFee` con el mismo
      // `orchestrationId` sobre una fila `failed` llamara a `sign()`, esta
      // frase sería falsa — lo fija FT-12b en `fee-charge.test.ts`.)
      //
      // ⚠️ SI ALGUIEN VIENE A HABILITAR EL REINTENTO, LEER ESTO PRIMERO.
      // Desde el merge `700341a` (HU-201, `hasBroadcastEvidence` en
      // `adapters/errors.ts`), una fila `failed` PUEDE llevar en `tx_hash` el
      // hash de un broadcast que SÍ ocurrió: `failed` significa "el settle no
      // se pudo confirmar", NO "probado que no se movió plata" (ver el
      // docstring de `markFailed`). Reintentar sin cruzar antes ese `tx_hash`
      // contra la cadena es exactamente cómo se paga dos veces. Cualquier
      // cambio acá es cambio de comportamiento en el money-path y necesita su
      // propio análisis adversarial: no alcanza con borrar este comentario.
    }

    // Paso 4: INSERT pending (ON CONFLICT DO NOTHING via unique_violation). El
    // leg de plataforma transfiere SU share (`platformAmount`); en default ==
    // feeUsdc (byte-idéntico).
    const feeWei = feeUsdcToWei(platformAmount);
    const { error: insertErr } = (await supabase.from(FEES_TABLE).insert({
      orchestration_id: orchestrationId,
      budget_usdc: feeBaseUsdc,
      fee_rate: feeRate,
      fee_usdc: platformAmount,
      // WKH-167: fee TOTAL del protocolo (= budget × rate = protocolFeeUsdc del
      // quote), aditivo. `fee_usdc` sigue siendo SOLO la pata de plataforma
      // post-split (WKH-136) — money-path invariante, sin tocar.
      fee_total_usdc: feeUsdc,
      fee_wallet: walletAddress,
      status: 'pending',
    })) as { error: SupabaseError | null };

    if (insertErr) {
      if (insertErr.code === PG_UNIQUE_VIOLATION) {
        // MNR-3 (AC-6): leg adicional falló → 'failed' aunque el leg de
        // plataforma esté in-progress (race).
        if (extrasFailed !== undefined) {
          return {
            status: 'failed',
            feeUsdc,
            error: extrasFailed,
            splits: buildSplits('in-progress'),
          };
        }
        // Race condition — otro request insertó primero. Retornamos
        // already-charged inProgress; el otro worker se encargará.
        return {
          status: 'already-charged',
          feeUsdc,
          inProgress: true,
          splits: buildSplits('in-progress'),
        };
      }
      // Otro error de DB → failed (CD-B, nunca rechazar).
      log.error(
        { orchestrationId, detail: insertErr.message },
        'DB insert error',
      );
      return {
        status: 'failed',
        feeUsdc,
        error: `DB_ERROR: ${insertErr.message ?? 'unknown'}`,
        splits: buildSplits(
          'failed',
          undefined,
          `DB_ERROR: ${insertErr.message ?? 'unknown'}`,
        ),
      };
    }

    // Paso 5: sign + settle (CD-F: tipo explícito en let antes de try).
    let signResult: SignResult;
    try {
      signResult = await getPaymentAdapter().sign({
        to: walletAddress as `0x${string}`,
        value: feeWei,
      });
    } catch (signErr) {
      // WKH-71 AC-3: relabel an operator-gas-funding failure (CD-5: message/log
      // only, still returns failed without rejecting).
      const { message: msg, reason } = describeChargeError(signErr);
      log.error(
        { orchestrationId, detail: msg, ...(reason ? { reason } : {}) },
        'sign() failed',
      );
      await markFailed(orchestrationId, msg);
      return {
        status: 'failed',
        feeUsdc,
        error: msg,
        splits: buildSplits('failed', undefined, msg),
      };
    }

    const { paymentRequest } = signResult;
    try {
      const settleResult = await getPaymentAdapter().settle({
        authorization: paymentRequest.authorization,
        signature: paymentRequest.signature,
        network: paymentRequest.network ?? '',
      });

      if (!settleResult.success) {
        // WKH-71 AC-3: relabel operator-gas-funding failures surfaced by the
        // settle adapter (CD-5: message/log only).
        const { message: baseMsg, reason } = describeChargeError(
          `settle failed: ${settleResult.error ?? 'unknown'}`,
        );
        // HU-201 (extensión a los 2 caminos de fee): el `txHash` que viene CON el
        // `success:false` es EVIDENCIA DE BROADCAST y NO se descarta. Mismo
        // clasificador y misma doctrina que `payment-intent.ts:434-469`
        // (`adapters/errors.ts` — "no entender la respuesta es lo contrario de
        // tener una prueba"). Acá el veredicto NO decide refund ni reintento (el
        // reintento ya lo bloquea el 23505 de :419), así que lo que se perdía era
        // otra cosa y no menos grave: el ÚNICO puntero para cruzar contra la
        // cadena un fee que PUDO haberse movido. La fila sigue `failed` — el hash
        // es evidencia de un intento, nunca prueba de cobro.
        const evidenceHash = hasBroadcastEvidence(settleResult.txHash)
          ? String(settleResult.txHash)
          : undefined;
        // El hash viaja además en el mensaje (y por ende en `error_message`), pero
        // `truncateError` corta a 180 chars: la columna `tx_hash` es el lugar
        // AUTORITATIVO, el texto es conveniencia.
        const errMsg =
          evidenceHash !== undefined
            ? `${baseMsg} [broadcast tx: ${evidenceHash}]`
            : baseMsg;
        log.error(
          {
            orchestrationId,
            detail: errMsg,
            broadcastEvidence: evidenceHash !== undefined,
            ...(evidenceHash !== undefined
              ? { settleTxHash: evidenceHash }
              : {}),
            ...(reason ? { reason } : {}),
          },
          'settle reported failure',
        );
        await markFailed(orchestrationId, errMsg, evidenceHash);
        return {
          status: 'failed',
          feeUsdc,
          error: errMsg,
          splits: buildSplits('failed', evidenceHash, errMsg),
        };
      }

      // TB-01 (audit 2026-06-30): re-verify the fee settle on-chain BEFORE
      // marking it charged. Re-read the returned tx and confirm it really moved
      // `>= feeWei` of the token to the fee wallet. A forged/insufficient settle
      // is treated as a failed charge (row marked failed, not charged). Gated
      // behind SETTLE_VERIFY_ONCHAIN (default ON); no-op when OFF.
      const feeReVerified = await verifyDefaultChainSettle({
        txHash: settleResult.txHash,
        payTo: walletAddress,
        requiredAmountAtomic: BigInt(feeWei),
      });
      // MNR-1: RPC_UNAVAILABLE (a2a couldn't independently check) → ALLOW the
      // charge (facilitator already confirmed it) but log a clear warning.
      if (feeReVerified.warn) {
        log.warn(
          { orchestrationId, reason: feeReVerified.reason },
          'settle on-chain re-verify unavailable, trusting facilitator confirmation',
        );
      }
      // A DEFINITIVE contradiction (forged/insufficient settle) → failed charge.
      if (!feeReVerified.ok) {
        const errMsg = `settle on-chain re-verification failed: ${feeReVerified.reason ?? 'unknown'}`;
        log.error(
          { orchestrationId, detail: errMsg },
          'settle re-verification failed',
        );
        await markFailed(orchestrationId, errMsg);
        return {
          status: 'failed',
          feeUsdc,
          error: errMsg,
          splits: buildSplits('failed', undefined, errMsg),
        };
      }

      // Paso 6: UPDATE charged.
      const txHash = settleResult.txHash;
      const { error: updateErr } = (await supabase
        .from(FEES_TABLE)
        .update({
          status: 'charged',
          tx_hash: txHash,
        })
        .eq('orchestration_id', orchestrationId)) as {
        error: SupabaseError | null;
      };

      if (updateErr) {
        // El transfer salió OK pero la DB no se actualizó. Igual retornamos
        // charged — el fee se cobró; el row queda en 'pending' (auditable).
        log.error(
          { orchestrationId, detail: updateErr.message },
          'DB update-charged error',
        );
      }

      // AC-3: si un leg ADICIONAL obligatorio falló, el agregado NUNCA es
      // `charged` — la plataforma cobró pero el settlement está incompleto.
      if (extrasFailed !== undefined) {
        return {
          status: 'failed',
          feeUsdc,
          error: extrasFailed,
          splits: buildSplits('charged', txHash),
        };
      }

      return {
        status: 'charged',
        feeUsdc,
        txHash,
        splits: buildSplits('charged', txHash),
      };
    } catch (settleErr) {
      // WKH-71 AC-3: relabel operator-gas-funding failures (CD-5: message/log
      // only, still returns failed without rejecting).
      const { message: msg, reason } = describeChargeError(settleErr);
      log.error(
        { orchestrationId, detail: msg, ...(reason ? { reason } : {}) },
        'settle() threw',
      );
      await markFailed(orchestrationId, msg);
      return {
        status: 'failed',
        feeUsdc,
        error: msg,
        splits: buildSplits('failed', undefined, msg),
      };
    }
  } catch (err) {
    // Captura cualquier excepción sincrónica / async no prevista (ej. el
    // cliente de supabase lanza al construir el builder). CD-B: jamás
    // rechazar la promise.
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ orchestrationId, detail: msg }, 'Unexpected error');
    return { status: 'failed', feeUsdc, error: `DB_ERROR: ${msg}` };
  }
}

/**
 * WKH-71 (AC-3): relabel a raw sign/settle failure. When the underlying viem/
 * RPC error is an operator-gas-funding failure ("insufficient funds for gas"),
 * the returned `message` is prefixed with the stable `operator-funding-low`
 * reason and `reason` is set, so logs (the ops signal) can identify it instead
 * of surfacing an anonymous RPC string. CD-5: this ONLY changes the
 * message/log — the caller's control flow (never rejects the promise, always
 * returns `{status:'failed'}`) is unchanged. Non-funding errors pass through
 * untouched (original message preserved).
 */
function describeChargeError(raw: unknown): {
  message: string;
  reason: string | null;
} {
  const c = classifyOperatorError(raw);
  return { message: c.message, reason: c.reason };
}

/**
 * Helper para marcar el row como `failed` sin propagar errores (best-effort).
 *
 * `evidenceTxHash` (HU-201): hash de broadcast que acompañó a un `success:false`.
 * Se persiste en la columna `tx_hash` DE UNA FILA `failed` — que es un estado
 * legítimo y distinto de `charged`: NINGÚN lector infiere cobro desde el hash.
 * Los tres que leen esa columna cruzan siempre el `status` antes
 * (`fee-charge.ts:355` y `fee-split.ts:379` sólo la leen si `charged`;
 * `reverseFeeSplits` saltea todo row que no sea `charged`, `fee-split.ts:652`),
 * y `trace.recentCalls()` la emite JUNTO al status y le arma el link al explorer
 * (`trace.ts:502-512`) — o sea que esta evidencia ya tiene dónde verse, que es
 * la pregunta de control que dejó el fix-pack AR de HU-201.
 */
async function markFailed(
  orchestrationId: string,
  errorMessage: string,
  evidenceTxHash?: string,
): Promise<void> {
  try {
    await supabase
      .from(FEES_TABLE)
      .update({
        status: 'failed',
        error_message: truncateError(errorMessage),
        ...(evidenceTxHash !== undefined ? { tx_hash: evidenceTxHash } : {}),
      })
      .eq('orchestration_id', orchestrationId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ orchestrationId, detail: msg }, 'failed to mark row as failed');
  }
}
