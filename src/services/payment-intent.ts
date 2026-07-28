/**
 * Payment Intent Service — WKH-135 · `session` (metered) + `upto` (dual-signed cap)
 *
 * Dos intents de pago aditivos al money-path (NO tocan charge/compose/orchestrate):
 *   - session (metered): openSession reserva un deposit contra el budget prepago
 *     (increment_a2a_key_spend dentro del RPC open); addVoucher acumula uso
 *     idempotente; closeSession settlea min(Σvouchers, deposit) al seller + refund
 *     del residual (refund_a2a_key_spend) al buyer.
 *   - upto (cap dual-firmado): createUpto verifica un cap EIP-712 anclado a
 *     funding_wallet (NO reserva); settleUpto cobra exactamente min(cap, uso),
 *     clampando al cap (nunca rechaza, nunca > cap).
 *
 * Reglas money-path (SDD §5):
 *   - CD-1: idempotencia por PK del intent (UUID server-side generado en el route).
 *   - CD-2: Ownership Guard owner_ref (string, NO undefined) en TODO RPC.
 *   - CD-3: vouchers idempotentes por UNIQUE(intent_id, voucher_id); settle por
 *     transición open→closing bajo FOR UPDATE.
 *   - CD-5: verifyDefaultChainSettle ANTES de marcar settled; contradicción → failed.
 *   - CD-6: montos en micro-USD entero (decimalStringToMicroUsd copiado de
 *     delegation.ts — es privado allá); residual = max(0, deposit − consumido).
 *   - CD-7: el settle NUNCA rechaza la promise → { status:'failed' } + finalize best-effort.
 *   - CD-8: viem only (recoverTypedDataAddress).
 *
 * SEAM WKH-136: `settlePaymentIntentOnChain` es interfaz estable (splits bps la
 * van a envolver). NO dupliques la lógica sign/settle/verify en cada método.
 */

import { recoverTypedDataAddress } from 'viem';
import {
  captureDebitSignatureBestEffort,
  type DebitCaptureInput,
  isEscrowSettleEnabled,
  readValidDebitSignature,
} from '../adapters/escrow/debit-capture.js';
import {
  executeDebitHop1,
  recordDebitHop1,
  recordDebitSettleStatus,
} from '../adapters/escrow/debit-executor.js';
import { resolveEscrowContract } from '../adapters/escrow-verifier.js';
import { getDefaultChainKey, getPaymentAdapter } from '../adapters/registry.js';
import { verifyDefaultChainSettle } from '../adapters/settle-verifier.js';
import type { SignResult } from '../adapters/types.js';
import { getLogger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import type {
  AddVoucherInput,
  CreateUptoInput,
  OpenSessionInput,
  SettleOutcome,
  UptoCapTypedData,
  UptoEip712Domain,
} from '../types/index.js';

const log = getLogger('payment-intent');

const PG_UNIQUE_VIOLATION = '23505';
const DEFAULT_TTL_SECONDS = 3600;
// BLQ-2: cuánto debe llevar un intent en 'closing' antes de que expireStale lo
// trate como huérfano (settle on-chain OK pero finalize falló). Ventana amplia
// para no correr contra un settle in-flight.
const DEFAULT_CLOSING_STALE_SECONDS = 300;

// ── Error de negocio (self-contained: NO se puede tocar security/errors.js) ──

/**
 * Códigos estables mapeados a HTTP en el route (tabla de errores del Story File).
 * NUNCA propagamos el mensaje crudo de Postgres al cliente (CD-2 disclosure-safe).
 */
export type PaymentIntentErrorCode =
  | 'INVALID_INPUT'
  | 'CAP_SIGNATURE_INVALID'
  | 'OWNERSHIP_MISMATCH'
  | 'INTENT_NOT_FOUND'
  | 'INTENT_NOT_OPEN'
  | 'INSUFFICIENT_BUDGET'
  | 'INTERNAL';

export class PaymentIntentError extends Error {
  readonly code: PaymentIntentErrorCode;
  constructor(code: PaymentIntentErrorCode) {
    super(code);
    this.name = 'PaymentIntentError';
    this.code = code;
  }
}

// ── EIP-712 del cap upto (mirror exacto de delegation.ts:53-81) ──

/** Domain del server. `verifyingContract` se omite a propósito (NC-3). */
function buildUptoDomain(): UptoEip712Domain {
  return {
    name: process.env.UPTO_EIP712_NAME ?? 'WasiAI-a2a Upto',
    version: process.env.UPTO_EIP712_VERSION ?? '1',
    chainId: Number(process.env.KITE_CHAIN_ID),
  };
}

// types EIP-712 del cap. `as const`; NO se incluye EIP712Domain (viem lo infiere).
const UPTO_TYPES = {
  UptoCap: [
    { name: 'seller_ref', type: 'string' },
    { name: 'cap', type: 'string' }, // decimal USD como string (sin float64)
    { name: 'chain_id', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'expires_at', type: 'uint64' },
  ],
} as const;

// ── Helpers puros (micro-USD entero, CD-6) ──────────────────────

/**
 * Convierte un string decimal USD (p.ej. "0.50", "100", "1.234567") a un entero
 * de micro-USD (×1e6) SIN pasar por float64. Devuelve null si el formato es
 * inválido. Trunca a 6 decimales. COPIA del helper privado de delegation.ts:112-120
 * (no está exportado allá — CD-6 pide replicarlo, no importarlo).
 */
function decimalStringToMicroUsd(raw: string): number | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [intPart, fracPartRaw = ''] = s.split('.');
  const fracPart = `${fracPartRaw}000000`.slice(0, 6); // pad/truncate a 6 dec
  const micro = Number(intPart) * 1_000_000 + Number(fracPart);
  return Number.isFinite(micro) ? micro : null;
}

/**
 * Normaliza un NUMERIC del RPC (llega como number en el tipo generado, pero
 * defensivamente aceptamos string) a micro-USD entero. Nunca lanza.
 */
function numericToMicro(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'string') {
    const m = decimalStringToMicroUsd(v);
    if (m !== null) return m;
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 1_000_000) : 0;
  }
  return Number.isFinite(v) ? Math.round(v * 1_000_000) : 0;
}

function numericToUsd(v: number | string | null | undefined): number {
  return numericToMicro(v) / 1_000_000;
}

/**
 * USD → unidad atómica del token, decimals-aware (WKH-192).
 *
 * `micro` = micro-USD entero (6 decimales), IDÉNTICO al legacy `usdToWei`.
 * Escala por `10^(decimals-6)` con BigInt entero puro (sin float64 nuevo, sin
 * parseUnits, sin toFixed). Byte-idéntico al legacy cuando `decimals === 18`
 * (mismo `micro`, `10^12`) POR CONSTRUCCIÓN — no por muestreo.
 * Rama `< 6` decimales: floor defensivo, hoy inalcanzable (ningún token < 6d).
 *
 * @internal exported ONLY for byte-identical convergence tests (WKH-192).
 */
export function usdToAtomic(usd: number, decimals: number): string {
  const micro = BigInt(Math.round(usd * 1_000_000));
  return String(
    decimals >= 6
      ? micro * 10n ** BigInt(decimals - 6)
      : micro / 10n ** BigInt(6 - decimals),
  );
}

function resolveTtlSeconds(): number {
  const raw = process.env.PAYMENT_INTENT_TTL_SECONDS;
  if (raw === undefined || raw === '') return DEFAULT_TTL_SECONDS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_SECONDS;
}

/** BLQ-2: umbral (ms) para barrer intents 'closing' huérfanos en expireStale. */
function resolveClosingStaleMs(): number {
  const raw = process.env.PAYMENT_INTENT_CLOSING_STALE_SECONDS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return (
    (Number.isFinite(n) && n > 0 ? n : DEFAULT_CLOSING_STALE_SECONDS) * 1000
  );
}

interface PgError {
  code?: string;
  message?: string;
}

/**
 * Mapea el error crudo de un RPC/insert a un PaymentIntentError estable (CD-2).
 * `nonceContext=true` interpreta el 23505 como replay del cap upto.
 */
function mapPgError(error: PgError, ctx: string, nonceContext: boolean): never {
  const msg = error.message ?? '';
  if (
    nonceContext &&
    (error.code === PG_UNIQUE_VIOLATION ||
      msg.includes('uq_a2a_payment_intents_cap_nonce') ||
      msg.includes('duplicate key'))
  ) {
    // cap_nonce reusado → anti-replay (CD-2).
    throw new PaymentIntentError('CAP_SIGNATURE_INVALID');
  }
  if (msg.includes('OWNERSHIP_MISMATCH') || msg.includes('KEY_NOT_FOUND')) {
    // key_id de otro owner o inexistente → disclosure-safe 403.
    throw new PaymentIntentError('OWNERSHIP_MISMATCH');
  }
  if (msg.includes('INTENT_NOT_FOUND')) {
    throw new PaymentIntentError('INTENT_NOT_FOUND');
  }
  if (msg.includes('INTENT_NOT_OPEN')) {
    throw new PaymentIntentError('INTENT_NOT_OPEN');
  }
  if (
    msg.includes('INSUFFICIENT_BUDGET') ||
    msg.includes('DAILY_LIMIT') ||
    msg.includes('KEY_INACTIVE')
  ) {
    // no se pudo reservar el deposit (session) → 400.
    throw new PaymentIntentError('INSUFFICIENT_BUDGET');
  }
  log.error({ ctx, detail: msg }, 'payment intent RPC error');
  throw new PaymentIntentError('INTERNAL');
}

/**
 * BLQ-DR (money-path): veredicto persistido del settle. El refund vive AHORA dentro
 * de finalize_payment_intent (misma tx que el status flip, status-gated), y la
 * recovery LEE este veredicto en vez de asumir éxito.
 */
export type SettleVerdict =
  | 'settled'
  | 'failed_unequivocal'
  | 'failed_ambiguous';

/**
 * BLQ-DR: persiste el VEREDICTO del settle (money-free) mientras el intent está en
 * 'closing', ANTES de invocar finalize (que mueve el refund). Si finalize falla, la
 * recovery lee este veredicto y aplica la acción CORRECTA — nunca asume éxito.
 *
 * Best-effort (idempotente en el RPC): un fallo del write se loguea pero NO aborta —
 * finalize re-afirma settle_outcome dentro de su propia tx. La única ventana residual
 * (record Y finalize fallan ambos) es money-safe: la recovery cae a 'failed_ambiguous'
 * (NO refund, reconcile), nunca a un doble-refund.
 */
async function recordSettleOutcome(
  intentId: string,
  ownerRef: string,
  outcome: SettleVerdict,
  txHash: string | null,
  residual: number | null,
  errorMessage: string | null,
): Promise<void> {
  try {
    const { error } = await supabase.rpc('record_settle_outcome', {
      p_intent_id: intentId,
      p_owner_ref: ownerRef,
      p_outcome: outcome,
      p_tx_hash: txHash,
      p_residual: residual,
      p_error: errorMessage,
    });
    if (error) {
      log.error(
        { intentId, detail: error.message },
        'record_settle_outcome failed (finalize re-afirmará el veredicto)',
      );
    }
  } catch (err) {
    log.error(
      { intentId, detail: err instanceof Error ? err.message : String(err) },
      'record_settle_outcome threw',
    );
  }
}

/**
 * finalize (CD-7 + BLQ-DR): aplica el veredicto del settle ATÓMICAMENTE — money
 * (refund) + status flip en la MISMA tx, status-gated en 'closing'. Re-invocar
 * cuando ya es terminal = no-op ⇒ el refund se aplica EXACTAMENTE UNA VEZ bajo
 * cualquier retry/expireStale (era la causa raíz del double-refund: el refund
 * estaba FUERA de la tx del status).
 *
 * Devuelve `true` sólo si el RPC corrió sin error (la fila quedó finalizada o ya no
 * estaba en 'closing'). `false` si falló/lanzó → el intent sigue 'closing' con el
 * veredicto persistido (por recordSettleOutcome) → la recovery lo re-aplica.
 */
async function finalizePaymentIntent(
  intentId: string,
  ownerRef: string,
  txHash: string | null,
  finalAmount: number,
  residual: number | null,
  outcome: SettleVerdict,
  errorMessage: string | null,
): Promise<boolean> {
  try {
    const { error } = await supabase.rpc('finalize_payment_intent', {
      p_intent_id: intentId,
      p_owner_ref: ownerRef,
      p_tx_hash: txHash,
      p_final_amount: finalAmount,
      p_residual: residual,
      p_outcome: outcome,
      p_error: errorMessage,
    });
    if (error) {
      log.error(
        { intentId, detail: error.message },
        'finalize_payment_intent failed',
      );
      return false;
    }
    return true;
  } catch (err) {
    log.error(
      { intentId, detail: err instanceof Error ? err.message : String(err) },
      'finalize_payment_intent threw',
    );
    return false;
  }
}

/**
 * BLQ-1: debita el budget prepago del buyer (increment_a2a_key_spend, 4-arg con
 * Ownership Guard `p_owner_ref`). Insuficiente / ownership / key inactiva →
 * PaymentIntentError (fail-closed): el caller aborta ANTES de transferir al seller.
 */
async function debitBuyer(
  keyId: string,
  chainId: number,
  amountUsd: number,
  ownerRef: string,
): Promise<void> {
  const { error } = await supabase.rpc('increment_a2a_key_spend', {
    p_key_id: keyId,
    p_chain_id: chainId,
    p_amount_usd: amountUsd,
    p_owner_ref: ownerRef,
  });
  if (error) mapPgError(error, 'upto-debit', false);
}

/**
 * AR MNR-1 — ¿el resultado del hop 2 es DESCONOCIDO (y por lo tanto NO se puede
 * re-enviar solo)?
 *
 * El test es `!== 'unequivocal'`, NO `=== 'ambiguous'`. Los dos son equivalentes HOY
 * (el tipo tiene exactamente 2 valores), pero difieren en el DEFAULT, y acá el default
 * decide dinero:
 *   · con `=== 'ambiguous'`, un `failureKind` ausente o un 3er valor futuro caería en
 *     `reconciliation_pending` ⟹ fila auto-reclamable ⟹ el reconciliador re-envía el
 *     hop 2 a ciegas ⟹ doble pago al seller.
 *   · con `!== 'unequivocal'` cae en `resolving_settle` ⟹ revisión manual.
 * O sea: SÓLO el veredicto EXPLÍCITO de "probado que no se ejecutó" habilita el
 * re-envío. Cualquier otra cosa, incluida la ignorancia, va al lado seguro.
 *
 * Está extraída como función pura EXPORTADA a propósito: la diferencia entre las dos
 * formas es inalcanzable por el camino de integración (todos los `return failed` del
 * seam setean `failureKind`), así que sin este seam la invariante del default no se
 * podía candar con un test — sería una afirmación sin evidencia.
 */
export function isHop2ResultUnknown(
  failureKind: SettleOutcome['failureKind'] | undefined,
): boolean {
  return failureKind !== 'unequivocal';
}

/**
 * BLQ-DR: normaliza el `settle_outcome` persistido a un veredicto. NULL/desconocido
 * → 'failed_ambiguous' (money-safe): sin veredicto NO asumimos éxito ni refund; se
 * marca reconciliable. NUNCA default a 'settled' (esa asunción era la causa raíz).
 */
function normalizeVerdict(raw: string | null | undefined): SettleVerdict {
  return raw === 'settled' ||
    raw === 'failed_unequivocal' ||
    raw === 'failed_ambiguous'
    ? raw
    : 'failed_ambiguous';
}

// ── SEAM WKH-136: settle on-chain compartido (SP-1/SP-2) ────────

/**
 * Único punto de settle on-chain (closeSession y settleUpto DEBEN delegar acá).
 * Espejo de fee-charge.ts:256-345. NUNCA rechaza (CD-7): todo error → failed.
 * WKH-136 (splits bps) va a envolver esta función — interfaz estable, NO duplicar.
 */
export async function settlePaymentIntentOnChain(params: {
  intentId: string;
  ownerRef: string;
  payTo: string;
  finalAmountUsd: number;
  chainId: number;
}): Promise<SettleOutcome> {
  const { intentId, payTo, finalAmountUsd } = params;
  try {
    const adapter = getPaymentAdapter();
    const decimals = adapter.supportedTokens?.[0]?.decimals ?? 18;
    const wei = usdToAtomic(finalAmountUsd, decimals);

    // 1. sign (try/catch propio → failed).
    let signResult: SignResult;
    try {
      signResult = await adapter.sign({
        to: payTo as `0x${string}`,
        value: wei,
      });
    } catch (signErr) {
      const detail =
        signErr instanceof Error ? signErr.message : String(signErr);
      log.error({ intentId, detail }, 'settle sign() failed');
      // INEQUÍVOCO: el sign() lanzó ANTES de cualquier broadcast → no hubo tx.
      return {
        status: 'failed',
        txHash: null,
        finalAmountUsd,
        error: detail,
        failureKind: 'unequivocal',
      };
    }

    // 2. settle (try/catch propio → failed).
    const { paymentRequest } = signResult;
    let settleTxHash: string;
    try {
      const settleResult = await adapter.settle({
        authorization: paymentRequest.authorization,
        signature: paymentRequest.signature,
        network: paymentRequest.network ?? '',
      });
      if (!settleResult.success) {
        const detail = `settle failed: ${settleResult.error ?? 'unknown'}`;
        log.error({ intentId, detail }, 'settle reported failure');
        // INEQUÍVOCO: el facilitator confirmó que el settle NO se ejecutó → no
        // se movieron fondos → refund seguro del deposit/débito.
        return {
          status: 'failed',
          txHash: null,
          finalAmountUsd,
          error: detail,
          failureKind: 'unequivocal',
        };
      }
      settleTxHash = settleResult.txHash;
    } catch (settleErr) {
      const detail =
        settleErr instanceof Error ? settleErr.message : String(settleErr);
      log.error({ intentId, detail }, 'settle() threw');
      // AMBIGUO: el settle() lanzó pero la tx PUDO haberse broadcasteado antes
      // del throw → NO sabemos si los fondos se movieron → NO refundar.
      //
      // HU-198: este `ambiguous` es la MISMA semántica que
      // `SettleValueDisposition = 'unknown'` (`adapters/errors.ts`), y por eso el
      // techo de wall-clock del hop `pieverse` NO necesitó tocar esta función: un
      // abort del `/settle` llega acá como throw y ya cae del lado money-safe (no
      // refund → reconciliación). Se clasifican TODOS los throws como ambiguos a
      // propósito, incluido el `'not-sent'`: acá lo conservador cuesta una revisión
      // manual, y lo optimista costaría un doble crédito.
      return {
        status: 'failed',
        txHash: null,
        finalAmountUsd,
        error: detail,
        failureKind: 'ambiguous',
      };
    }

    // 3. re-verify on-chain ANTES de marcar settled (CD-5).
    const verified = await verifyDefaultChainSettle({
      txHash: settleTxHash,
      payTo,
      requiredAmountAtomic: BigInt(wei),
    });
    if (verified.warn) {
      // RPC_UNAVAILABLE → fail-OPEN (confiar en el facilitator) + warn.
      log.warn(
        { intentId, reason: verified.reason },
        'settle on-chain re-verify unavailable, trusting facilitator',
      );
    }
    if (!verified.ok) {
      // contradicción definitiva → fail-CLOSED. NO settled, NO refund.
      const detail = `settle re-verification failed: ${verified.reason ?? 'unknown'}`;
      log.error({ intentId, detail }, 'settle re-verification failed');
      // AMBIGUO: la tx se envió (settleTxHash existe) pero la re-verificación la
      // contradijo → los fondos PUDIERON moverse on-chain → NO refundar.
      return {
        status: 'failed',
        txHash: null,
        finalAmountUsd,
        error: detail,
        failureKind: 'ambiguous',
      };
    }

    return { status: 'settled', txHash: settleTxHash, finalAmountUsd };
  } catch (err) {
    // CD-7: jamás rechazar (p.ej. BigInt(wei) o el builder de supabase lanzan).
    const detail = err instanceof Error ? err.message : String(err);
    log.error(
      { intentId, detail },
      'settlePaymentIntentOnChain unexpected error',
    );
    // AMBIGUO por seguridad: no podemos garantizar en qué punto lanzó (pudo ser
    // después del broadcast) → NO refundar, reconciliar (evita doble-gasto).
    return {
      status: 'failed',
      txHash: null,
      finalAmountUsd,
      error: detail,
      failureKind: 'ambiguous',
    };
  }
}

// ── WKH-191b: wrapper escrow-aware del settle (two-hop, flag-gated) ──────────

/**
 * Envuelve el seam WKH-136 (`settlePaymentIntentOnChain`, byte-idéntico) con el
 * two-hop non-custodial: (hop 1) `escrow.debit()` mueve fondos del buyer del
 * escrow al operador; (hop 2) el operador reenvía al seller vía el seam SIN cambios.
 *
 * Con el flag OFF (default), sin firma `valid`, sin escrow en la chain, o si hop 1
 * `not_moved`, delega en el seam con los MISMOS params → comportamiento byte-idéntico
 * al path operator-custodial de HOY (CD-2). NUNCA rechaza la promise (CD-S5): cualquier
 * throw inesperado (reader/executor/RPC) → fallback al seam.
 *
 * Money-safety (CD-3/CD-4/CD-S4): tras un hop 1 `confirmed` se persiste el tx hash
 * ANTES de hop 2; si hop 2 falla, se marca reconciliation-pending y se REMAPEA el
 * `failureKind` a `ambiguous` (los fondos del buyer ya salieron on-chain → un refund
 * off-chain sería doble-crédito). reconciliation-pending NUNCA reembolsa.
 */
export async function settleEscrowAware(params: {
  intentId: string;
  ownerRef: string;
  payTo: string;
  finalAmountUsd: number;
  chainId: number;
  keyId: string;
}): Promise<SettleOutcome> {
  const { intentId, ownerRef, payTo, finalAmountUsd, chainId, keyId } = params;
  const base = { intentId, ownerRef, payTo, finalAmountUsd, chainId };
  try {
    // 0. Flag OFF (default) → fast-path byte-idéntico (CD-1/CD-2/AC-2), 1ª línea:
    //    cero lecturas DB / on-chain.
    if (!isEscrowSettleEnabled()) return settlePaymentIntentOnChain(base);

    // 1. Escrow configurado en la default chain (AC-6). Sin chain/escrow → seam.
    const chainKey = getDefaultChainKey();
    if (!chainKey) return settlePaymentIntentOnChain(base);
    const escrowContract = resolveEscrowContract(chainKey);
    if (!escrowContract) return settlePaymentIntentOnChain(base);

    // 2. Firma `valid` persistida por 191a (el reader ya re-validó amount/deadline).
    //    Sin firma → path operator-custodial (AC-2/AC-7).
    const row = await readValidDebitSignature({
      intentId,
      ownerRef,
      chainKey,
      finalAmountUsd,
    });
    if (!row) return settlePaymentIntentOnChain(base);

    // 3. Exactly-once (AC-5/CD-3): hop 1 YA ejecutado (tx persistido) → skip a hop 2.
    let hop1TxHash = row.debit_hop1_tx_hash;
    if (!hop1TxHash) {
      // 4. Hop 1: mover fondos del buyer del escrow al operador.
      const o1 = await executeDebitHop1({
        chainKey,
        escrowContract,
        keyIdHash: row.debit_key_id_hash,
        amount: BigInt(row.debit_amount_atomic),
        deadline: BigInt(row.debit_deadline),
        nonce: BigInt(row.debit_nonce),
        signature: row.debit_signature,
      });

      if (o1.kind === 'not_moved') {
        // AC-3: cero evidencia de movimiento → fallback operador-custodial (hop 2 solo).
        return settlePaymentIntentOnChain(base);
      }

      if (o1.kind === 'ambiguous') {
        // CD-4: la tx PUDO minarse → NO hop 2, NO refund → reconciliation-pending.
        if (o1.txHash) {
          await recordDebitHop1({
            intentId,
            ownerRef,
            keyId,
            nonce: row.debit_nonce,
            txHash: o1.txHash,
          });
        }
        await recordDebitSettleStatus({
          intentId,
          ownerRef,
          keyId,
          nonce: row.debit_nonce,
          status: 'reconciliation_pending',
        });
        return {
          status: 'failed',
          txHash: null,
          finalAmountUsd,
          failureKind: 'ambiguous',
          error: `RECONCILE-ESCROW: hop1 ambiguous (${o1.reason})`,
        };
      }

      // o1.kind === 'confirmed': persistir el tx hash ANTES de hop 2 (BLQ-DR/CD-3).
      const persisted = await recordDebitHop1({
        intentId,
        ownerRef,
        keyId,
        nonce: row.debit_nonce,
        txHash: o1.txHash,
      });
      hop1TxHash = persisted ?? o1.txHash;
    }

    // 5. Hop 2: el seam WKH-136 SIN cambios (operador → seller).
    const o2 = await settlePaymentIntentOnChain(base);
    if (o2.status === 'settled') {
      await recordDebitSettleStatus({
        intentId,
        ownerRef,
        keyId,
        nonce: row.debit_nonce,
        status: 'settled',
      });
      return o2;
    }
    if (o2.status === 'failed') {
      // CD-S4: hop 1 ya movió fondos on-chain → remap unequivocal→ambiguous (jamás
      // refund off-chain = doble-crédito) + reconciliation-pending.
      //
      // HU-198 — EL ESTADO DEPENDE DE SI EL HOP 2 PUDO HABER PAGADO.
      //
      // Antes los dos casos caían en `reconciliation_pending`, y ese estado lo
      // AUTO-RECLAMA `claim_reconciliation` (migración 20260713000002, el `IN
      // ('hop1_confirmed','reconciliation_pending')`). Sin `debit_resolution_tx_hash`
      // que verificar, `reconciliation.ts` salta el verify y RE-ENVÍA el hop 2
      // (`reconciliation.ts` §6) ⟹ si el hop 2 original SÍ aterrizó, el seller cobra
      // DOS VECES. Con el techo de wall-clock del hop `pieverse` ese caso pasa de
      // raro a rutinario, así que hay que distinguirlo.
      //
      // El dato para distinguir YA ESTABA COMPUTADO: `failureKind`.
      //   · 'unequivocal' → el hop 2 PROBADAMENTE no se ejecutó (el sign falló, o el
      //     facilitator contestó `success:false`). Re-enviar es CORRECTO y es para
      //     lo que el reconciliador existe ⟹ `reconciliation_pending` (sin cambio).
      //   · 'ambiguous'   → el hop 2 pudo haber pagado (el settle TIRÓ, o la
      //     re-verificación on-chain lo contradijo) ⟹ `resolving_settle`, que el LADO
      //     SETTLE del claim NO reclama sin tx previa, pero que SIGUE en
      //     `PENDING_STATUSES` ⟹ no auto-PAGA, y aparece igual en `listPending()` para
      //     que un humano lo resuelva.
      //
      //     ⚠️ CORRECCIÓN (AR#2 MNR-3): la versión anterior de este comentario decía "ni
      //     por el lado settle ni por el refund" y "no auto-reembolsa". Es FALSO desde la
      //     migración 20260728010000 (MNR-4): el lado REFUND **sí** puede reclamar esta
      //     fila, a propósito. Si el hop 1 re-verifica `not_confirmed`, los fondos del
      //     buyer nunca salieron del escrow y su débito off-chain TIENE que revertirse;
      //     bloquear eso era una regresión. La asimetría es el punto: el refund es
      //     budget-only e idempotente y no manda ningún hop 2, así que no puede
      //     doble-pagar. Lo que este estado bloquea es EL RE-ENVÍO, no el reembolso.
      //
      // NO se inventó un estado nuevo: `resolving_settle` ya existe en el CHECK y en
      // el índice `idx_debit_sig_resolving` desde 191c. Lo único que hizo falta fue
      // dejar que `record_debit_settle_status` lo escriba (migración de esta HU).
      const unknownHop2 = isHop2ResultUnknown(o2.failureKind);
      await recordDebitSettleStatus({
        intentId,
        ownerRef,
        keyId,
        nonce: row.debit_nonce,
        status: unknownHop2 ? 'resolving_settle' : 'reconciliation_pending',
      });
      return {
        status: 'failed',
        txHash: null,
        finalAmountUsd,
        failureKind: 'ambiguous',
        error: `RECONCILE-ESCROW: hop1=${hop1TxHash} hop2-failed: ${o2.error ?? 'unknown'}`,
      };
    }
    // in_progress (no ocurre en el settle real) → devolver sin marcar reconcile.
    return o2;
  } catch (err) {
    // CD-S5: cualquier throw inesperado (reader/executor/RPC) → fallback al seam.
    // NUNCA rechazar la promise (espejo del contrato del seam).
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(
      { intentId, detail },
      'settleEscrowAware fell back to seam (unexpected error)',
    );
    return settlePaymentIntentOnChain(base);
  }
}

// ── Service ─────────────────────────────────────────────────────

export const paymentIntentService = {
  /**
   * Recupera el firmante del cap EIP-712 (mirror de delegation.verifyTypedData).
   * Domain binding ANTES del recover. Throws PaymentIntentError('CAP_SIGNATURE_INVALID').
   */
  async verifyCapSignature(
    typedData: UptoCapTypedData,
    signature: string,
  ): Promise<`0x${string}`> {
    const serverDomain = buildUptoDomain();
    if (
      typedData.domain.name !== serverDomain.name ||
      typedData.domain.version !== serverDomain.version ||
      typedData.domain.chainId !== serverDomain.chainId
    ) {
      throw new PaymentIntentError('CAP_SIGNATURE_INVALID');
    }
    try {
      const m = typedData.message;
      return await recoverTypedDataAddress({
        domain: {
          name: serverDomain.name,
          version: serverDomain.version,
          chainId: serverDomain.chainId,
        },
        types: UPTO_TYPES,
        primaryType: 'UptoCap',
        message: {
          seller_ref: m.seller_ref,
          cap: m.cap,
          chain_id: BigInt(m.chain_id),
          nonce: m.nonce,
          expires_at: BigInt(m.expires_at),
        },
        signature: signature as `0x${string}`,
      });
    } catch {
      throw new PaymentIntentError('CAP_SIGNATURE_INVALID');
    }
  },

  /**
   * session: crea el intent + reserva el deposit (increment_a2a_key_spend dentro
   * del RPC, atómico). Propaga INSUFFICIENT_BUDGET/ownership. El intentId lo
   * genera el route (crypto.randomUUID, CD-1). expires_at server-side.
   */
  async openSession(
    input: OpenSessionInput,
  ): Promise<{ intentId: string; expiresAt: string }> {
    const ttl =
      input.ttlSeconds !== undefined && input.ttlSeconds > 0
        ? input.ttlSeconds
        : resolveTtlSeconds();
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    const { error } = await supabase.rpc('open_payment_intent', {
      p_id: input.intentId,
      p_intent_type: 'session',
      p_owner_ref: input.ownerRef,
      p_key_id: input.keyId,
      p_buyer_wallet: input.buyerWallet,
      p_seller_ref: input.sellerRef,
      p_pay_to: input.payTo,
      p_chain_id: input.chainId,
      p_authorized_usd: input.depositUsd,
      p_cap_signature: null,
      p_cap_nonce: null,
      p_expires_at: expiresAt,
    });
    if (error) mapPgError(error, 'open-session', false);
    return { intentId: input.intentId, expiresAt };
  },

  /**
   * session: acumula un voucher idempotente (UNIQUE(intent_id, voucher_id)).
   * Duplicado → consumed NO incrementa (duplicate:true). Clamp al deposit en el RPC.
   */
  async addVoucher(
    input: AddVoucherInput,
  ): Promise<{ accepted: boolean; consumedUsd: number; duplicate: boolean }> {
    const { data, error } = await supabase.rpc('accumulate_payment_voucher', {
      p_intent_id: input.intentId,
      p_owner_ref: input.ownerRef,
      p_voucher_id: input.voucherId,
      p_amount: input.amountUsd,
    });
    if (error) mapPgError(error, 'add-voucher', false);
    const row = data?.[0];
    if (!row) throw new PaymentIntentError('INTERNAL');
    return {
      accepted: true,
      consumedUsd: numericToUsd(row.consumed),
      duplicate: row.is_duplicate,
    };
  },

  /**
   * session: cierra y settlea min(Σvouchers, deposit) al seller + refund del
   * residual al buyer (AC-1/AC-2). Idempotente: el 2º close ve prev_status!=='open'
   * y NO re-settlea. Delega el on-chain a settlePaymentIntentOnChain (seam).
   */
  async closeSession(
    intentId: string,
    ownerRef: string,
    allowStaleRecovery = false,
    debitCapture?: DebitCaptureInput,
  ): Promise<SettleOutcome> {
    const { data, error } = await supabase.rpc(
      'close_payment_intent_for_settle',
      { p_intent_id: intentId, p_owner_ref: ownerRef, p_reported_usage: 0 },
    );
    if (error) mapPgError(error, 'close-session', false);
    const row = data?.[0];
    if (!row) throw new PaymentIntentError('INTENT_NOT_FOUND');

    // WKH-139 (AC-4): guarda anti-race con el árbitro. Un intent en disputa
    // (disputed/arb_closing/arb_hold) NO puede settlearse por el cierre normal →
    // previene doble-settle. Rama MUERTA con ARBITER_ENABLED OFF (ningún intent
    // alcanza esos estados) ⇒ byte-idéntico apagado (CD-11). Sin esta guarda, el
    // fallthrough de abajo devolvería 'settled' erróneamente para esos estados.
    if (
      row.prev_status === 'disputed' ||
      row.prev_status === 'arb_closing' ||
      row.prev_status === 'arb_hold'
    ) {
      throw new PaymentIntentError('INTENT_NOT_OPEN');
    }

    const depositMicro = numericToMicro(row.authorized_usd);
    const consumedMicro = numericToMicro(row.consumed_usd);
    const consumedUsd = consumedMicro / 1_000_000;

    // Idempotencia (AC-1) + BLQ-DR recovery: el intent ya NO está 'open'.
    if (row.prev_status !== 'open') {
      const settledMicro = Math.min(consumedMicro, depositMicro);
      const residualMicro = Math.max(0, depositMicro - settledMicro);
      const settledUsd = settledMicro / 1_000_000;
      const residualUsd = residualMicro / 1_000_000;

      // BLQ-DR: huérfano en 'closing' (finalize falló DESPUÉS de conocerse el
      // veredicto). Re-aplicamos el veredicto PERSISTIDO (settle_outcome) — el refund
      // vive dentro de finalize (status-gated) ⇒ exactamente una vez. NUNCA asumimos
      // éxito: sin veredicto (NULL) → 'failed_ambiguous' (NO refund, reconcile).
      if (row.prev_status === 'closing') {
        // BLQ-MED-1 (race): un 'closing' FRESCO con settle_outcome=NULL NO es huérfano
        // — es otro caller settleando in-flight (aún no llamó record_settle_outcome).
        // Tratarlo como huérfano lo finalizaría 'failed_ambiguous' y DESCARTARÍA el
        // veredicto real (refund-cero / inconsistencia on-chain). NO finalizar, NO mover
        // estado ni dinero: devolver 'in_progress' y dejar que el caller in-flight lo
        // complete (o expireStale, allowStaleRecovery=true, tras CLOSING_STALE_SECONDS,
        // cuando el NULL SÍ es un huérfano genuino → 'failed_ambiguous' reconciliable).
        if (!row.settle_outcome && !allowStaleRecovery) {
          log.warn(
            { intentId, txHash: row.settle_tx_hash },
            'close concurrente sobre closing sin veredicto (settle in-flight): no-op, lo completa el caller in-flight/expireStale',
          );
          return {
            status: 'in_progress',
            txHash: row.settle_tx_hash,
            finalAmountUsd: settledUsd,
            consumedUsd,
            residualUsd: 0,
          };
        }
        const verdict = normalizeVerdict(row.settle_outcome);
        log.warn(
          { intentId, txHash: row.settle_tx_hash, verdict },
          'recuperando intent en closing con el veredicto persistido del settle',
        );
        const finalized = await finalizePaymentIntent(
          intentId,
          ownerRef,
          verdict === 'settled' ? row.settle_tx_hash : null,
          settledUsd,
          verdict === 'settled' ? residualUsd : null,
          verdict,
          verdict === 'failed_ambiguous' && !row.settle_outcome
            ? 'RECONCILE: closing sin veredicto persistido'
            : null, // el detalle persistido sobrevive por COALESCE en el RPC
        );
        if (!finalized) throw new PaymentIntentError('INTERNAL');
        if (verdict === 'settled') {
          return {
            status: 'settled',
            txHash: row.settle_tx_hash,
            finalAmountUsd: settledUsd,
            consumedUsd,
            residualUsd,
          };
        }
        return {
          status: 'failed',
          txHash: null,
          finalAmountUsd: settledUsd,
          consumedUsd,
          // unequívoco → deposit COMPLETO reembolsado (dentro de finalize); ambiguo → 0.
          residualUsd:
            verdict === 'failed_unequivocal' ? depositMicro / 1_000_000 : 0,
        };
      }
      return {
        status:
          row.prev_status === 'failed' || row.prev_status === 'refunded'
            ? 'failed'
            : 'settled',
        txHash: row.settle_tx_hash,
        finalAmountUsd: settledUsd,
        consumedUsd,
        residualUsd,
      };
    }

    // Transición open→closing efectuada. final = min(consumed, deposit).
    const finalMicro = Math.min(consumedMicro, depositMicro);
    const residualMicro = Math.max(0, depositMicro - finalMicro); // AC-2, nunca negativo
    const finalUsd = finalMicro / 1_000_000;
    const residualUsd = residualMicro / 1_000_000;

    // WKH-191a: captura INERTE de la firma DebitAuthorization (best-effort, no-throw,
    // NO altera el settle; cero on-chain). Solo cuando el flag ON pasó la firma.
    if (debitCapture) {
      await captureDebitSignatureBestEffort({
        intentId,
        ownerRef,
        keyId: row.key_id,
        chainId: row.chain_id,
        finalAmountUsd: finalUsd,
        capture: debitCapture,
      });
    }

    // Σvouchers = 0 → nada que cobrar al seller: full refund, sin tx on-chain.
    if (finalMicro <= 0) {
      // BLQ-DR: persistir veredicto ANTES de finalize (recovery-safe si finalize blip).
      await recordSettleOutcome(
        intentId,
        ownerRef,
        'settled',
        null,
        residualUsd,
        null,
      );
      await finalizePaymentIntent(
        intentId,
        ownerRef,
        null,
        finalUsd,
        residualUsd,
        'settled',
        null,
      );
      return {
        status: 'settled',
        txHash: null,
        finalAmountUsd: 0,
        consumedUsd,
        residualUsd,
      };
    }

    const outcome = await settleEscrowAware({
      intentId,
      ownerRef,
      payTo: row.pay_to,
      finalAmountUsd: finalUsd,
      chainId: row.chain_id,
      keyId: row.key_id,
    });

    if (outcome.status === 'settled') {
      // BLQ-DR: veredicto persistido ANTES del finalize. Si finalize blip, el intent
      // queda 'closing' con settle_outcome='settled' → recovery acredita el residual.
      await recordSettleOutcome(
        intentId,
        ownerRef,
        'settled',
        outcome.txHash,
        residualUsd,
        null,
      );
      await finalizePaymentIntent(
        intentId,
        ownerRef,
        outcome.txHash,
        finalUsd,
        residualUsd,
        'settled',
        null,
      );
      return {
        status: 'settled',
        txHash: outcome.txHash,
        finalAmountUsd: finalUsd,
        consumedUsd,
        residualUsd,
      };
    }

    // BLQ-ALTO-1 / BLQ-DR (money-path CRÍTICO): openSession debitó el deposit COMPLETO
    // (authorized_usd) contra el budget prepago. Si el settle falla, el refund se
    // aplica DENTRO de finalize (misma tx que el status flip, status-gated) ⇒ jamás
    // dos veces. La acción depende del subcaso (inequívoco vs ambiguo):
    if (outcome.failureKind === 'unequivocal') {
      // sign() lanzó / settle.success===false → CIERTO que NO hubo transfer: refund del
      // deposit COMPLETO (authorized_usd) dentro de finalize (budget_post==budget_pre).
      const errMsg = outcome.error ?? 'settle failed';
      await recordSettleOutcome(
        intentId,
        ownerRef,
        'failed_unequivocal',
        null,
        null,
        errMsg,
      );
      const finalized = await finalizePaymentIntent(
        intentId,
        ownerRef,
        null,
        finalUsd,
        null,
        'failed_unequivocal',
        errMsg,
      );
      // El refund vive en finalize: si falló, NO afirmamos que reembolsamos →
      // INTERNAL para que el retry/expireStale re-aplique el veredicto persistido.
      if (!finalized) throw new PaymentIntentError('INTERNAL');
      return {
        status: 'failed',
        txHash: null,
        finalAmountUsd: finalUsd,
        consumedUsd,
        residualUsd: depositMicro / 1_000_000,
        error: outcome.error,
      };
    }

    // AMBIGUO (verify contradijo / settle lanzó tras posible broadcast): el
    // transfer PUDO ocurrir on-chain → NO refundar (evitar doble-gasto). Pero NO
    // lo dejamos terminal silencioso: flag RECONCILE en error_message + log.warn
    // explícito para que la reconciliación manual verifique on-chain.
    log.warn(
      { intentId, detail: outcome.error },
      'settle ambiguo (session): deposit NO reembolsado, requiere reconciliación manual',
    );
    const ambiguousErr = `RECONCILE: ${outcome.error ?? 'settle ambiguous'}`;
    await recordSettleOutcome(
      intentId,
      ownerRef,
      'failed_ambiguous',
      null,
      null,
      ambiguousErr,
    );
    const finalizedAmbiguous = await finalizePaymentIntent(
      intentId,
      ownerRef,
      null,
      finalUsd,
      null,
      'failed_ambiguous',
      ambiguousErr,
    );
    if (!finalizedAmbiguous) throw new PaymentIntentError('INTERNAL');
    return {
      status: 'failed',
      txHash: null,
      finalAmountUsd: finalUsd,
      consumedUsd,
      residualUsd: 0,
      error: outcome.error,
    };
  },

  /**
   * upto: crea el intent tras verificar el cap EIP-712 (anclado a funding_wallet).
   * NO reserva/debita. cap_nonce UNIQUE → anti-replay (23505 → CAP_SIGNATURE_INVALID).
   */
  async createUpto(
    input: CreateUptoInput,
  ): Promise<{ intentId: string; expiresAt: string }> {
    // 1. recuperar firmante (domain binding adentro).
    const recovered = await this.verifyCapSignature(
      input.typedData,
      input.capSignature,
    );
    // 2. firmante == funding_wallet (ancla EXCLUSIVA).
    if (recovered.toLowerCase() !== input.buyerWallet.toLowerCase()) {
      throw new PaymentIntentError('CAP_SIGNATURE_INVALID');
    }
    // 3. el cap firmado DEBE coincidir con los params del request (anti-swap).
    const m = input.typedData.message;
    const capMicroSigned = decimalStringToMicroUsd(m.cap);
    if (
      capMicroSigned === null ||
      capMicroSigned !== Math.round(input.capUsd * 1_000_000) ||
      m.seller_ref !== input.sellerRef ||
      m.chain_id !== input.chainId ||
      m.nonce.toLowerCase() !== input.capNonce.toLowerCase()
    ) {
      throw new PaymentIntentError('CAP_SIGNATURE_INVALID');
    }
    // 4. expires_at del cap firmado, en el futuro.
    const expiresAtMs = m.expires_at * 1000;
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new PaymentIntentError('CAP_SIGNATURE_INVALID');
    }
    const expiresAt = new Date(expiresAtMs).toISOString();

    // 5. INSERT (upto NO debita). nonce colisión → replay.
    const { error } = await supabase.rpc('open_payment_intent', {
      p_id: input.intentId,
      p_intent_type: 'upto',
      p_owner_ref: input.ownerRef,
      p_key_id: input.keyId,
      p_buyer_wallet: input.buyerWallet,
      p_seller_ref: input.sellerRef,
      p_pay_to: input.payTo,
      p_chain_id: input.chainId,
      p_authorized_usd: input.capUsd,
      p_cap_signature: input.capSignature,
      p_cap_nonce: input.capNonce,
      p_expires_at: expiresAt,
    });
    if (error) mapPgError(error, 'create-upto', true);
    return { intentId: input.intentId, expiresAt };
  },

  /**
   * upto: settlea min(cap, reportedUsage) al seller (AC-3). Clampa al cap (nunca
   * rechaza, nunca > cap) + telemetría cap_exceeded. Idempotente (prev_status).
   */
  async settleUpto(
    intentId: string,
    ownerRef: string,
    reportedUsageUsd: number,
    allowStaleRecovery = false,
    debitCapture?: DebitCaptureInput,
  ): Promise<SettleOutcome> {
    const { data, error } = await supabase.rpc(
      'close_payment_intent_for_settle',
      {
        p_intent_id: intentId,
        p_owner_ref: ownerRef,
        p_reported_usage: reportedUsageUsd,
      },
    );
    if (error) mapPgError(error, 'settle-upto', false);
    const row = data?.[0];
    if (!row) throw new PaymentIntentError('INTENT_NOT_FOUND');

    const capMicro = numericToMicro(row.authorized_usd);
    const reportedMicro = Math.max(0, Math.round(reportedUsageUsd * 1_000_000));
    const cappedAt = reportedMicro >= capMicro;
    if (reportedMicro > capMicro) {
      // SG-2: uso > cap → telemetría, se cobra exactamente el cap.
      log.warn(
        {
          intentId,
          capUsd: capMicro / 1_000_000,
          reportedUsd: reportedUsageUsd,
        },
        'cap_exceeded',
      );
    }

    // Idempotencia (AC-1) + MNR-2 + BLQ-DR: el intent ya NO está 'open'.
    if (row.prev_status !== 'open') {
      // MNR-2: reportar el monto REALMENTE settleado (persistido en consumed_usd
      // por el close RPC al transicionar), NO un recompute con el reportedUsage
      // del request actual (que en un retry/sweep puede diferir del original).
      const settledMicro = numericToMicro(row.consumed_usd);
      const settledUsd = settledMicro / 1_000_000;
      // BLQ-DR: huérfano en 'closing' → re-aplicar el veredicto PERSISTIDO. upto NO
      // refunda residual; en 'failed_unequivocal' finalize reembolsa el débito
      // (consumed_usd) dentro de su tx status-gated ⇒ una sola vez. NUNCA asume éxito.
      if (row.prev_status === 'closing') {
        // BLQ-MED-1 (race): 'closing' FRESCO + settle_outcome=NULL = otro caller
        // settleando in-flight, NO huérfano. NO finalizar ni mover dinero → 'in_progress';
        // el caller in-flight (o expireStale, allowStaleRecovery=true) lo completa.
        if (!row.settle_outcome && !allowStaleRecovery) {
          log.warn(
            { intentId, txHash: row.settle_tx_hash },
            'settle upto concurrente sobre closing sin veredicto (in-flight): no-op, lo completa el caller in-flight/expireStale',
          );
          return {
            status: 'in_progress',
            txHash: row.settle_tx_hash,
            finalAmountUsd: settledUsd,
            cappedAt,
          };
        }
        const verdict = normalizeVerdict(row.settle_outcome);
        log.warn(
          { intentId, txHash: row.settle_tx_hash, verdict },
          'recuperando intent upto en closing con el veredicto persistido del settle',
        );
        const finalized = await finalizePaymentIntent(
          intentId,
          ownerRef,
          verdict === 'settled' ? row.settle_tx_hash : null,
          settledUsd,
          null,
          verdict,
          verdict === 'failed_ambiguous' && !row.settle_outcome
            ? 'RECONCILE: closing sin veredicto persistido'
            : null,
        );
        if (!finalized) throw new PaymentIntentError('INTERNAL');
        if (verdict === 'settled') {
          return {
            status: 'settled',
            txHash: row.settle_tx_hash,
            finalAmountUsd: settledUsd,
            cappedAt,
          };
        }
        return {
          status: 'failed',
          txHash: null,
          finalAmountUsd: settledUsd,
          cappedAt,
        };
      }
      return {
        status:
          row.prev_status === 'failed' || row.prev_status === 'refunded'
            ? 'failed'
            : 'settled',
        txHash: row.settle_tx_hash,
        finalAmountUsd: settledUsd,
        cappedAt,
      };
    }

    const finalMicro = Math.min(capMicro, reportedMicro); // = row.final_amount (AC-3)
    const finalUsd = finalMicro / 1_000_000;

    // WKH-191a: captura INERTE de la firma DebitAuthorization (best-effort, no-throw,
    // NO altera el settle; cero on-chain). Solo cuando el flag ON pasó la firma.
    if (debitCapture) {
      await captureDebitSignatureBestEffort({
        intentId,
        ownerRef,
        keyId: row.key_id,
        chainId: row.chain_id,
        finalAmountUsd: finalUsd,
        capture: debitCapture,
      });
    }

    // uso 0 → nada que cobrar: mark settled sin tx (upto NO refunda).
    if (finalMicro <= 0) {
      await recordSettleOutcome(
        intentId,
        ownerRef,
        'settled',
        null,
        null,
        null,
      );
      await finalizePaymentIntent(
        intentId,
        ownerRef,
        null,
        finalUsd,
        null,
        'settled',
        null,
      );
      return { status: 'settled', txHash: null, finalAmountUsd: 0, cappedAt };
    }

    // BLQ-1 (invariante money-path): DEBITAR el budget prepago del buyer por
    // min(cap,uso) ANTES de la transferencia on-chain al seller. upto NO reservó
    // en el open, así que el débito ocurre acá (NO en finalize, que corre DESPUÉS
    // del transfer → seguiría drenando el gateway). Fail-closed: si el budget es
    // insuficiente → NO se transfiere, NO se marca settled; se marca failed y se
    // propaga INSUFFICIENT_BUDGET (política v1 documentada).
    try {
      await debitBuyer(row.key_id, row.chain_id, finalUsd, ownerRef);
    } catch (debitErr) {
      const code =
        debitErr instanceof PaymentIntentError ? debitErr.code : 'INTERNAL';
      // debit falló → NADA se debitó → NO refund. 'failed_ambiguous' marca failed sin
      // reembolsar (usar 'failed_unequivocal' aquí reembolsaría un débito inexistente).
      await finalizePaymentIntent(
        intentId,
        ownerRef,
        null,
        finalUsd,
        null,
        'failed_ambiguous',
        `buyer debit failed: ${code}`,
      );
      throw debitErr;
    }

    const outcome = await settleEscrowAware({
      intentId,
      ownerRef,
      payTo: row.pay_to,
      finalAmountUsd: finalUsd,
      chainId: row.chain_id,
      keyId: row.key_id,
    });

    if (outcome.status === 'settled') {
      await recordSettleOutcome(
        intentId,
        ownerRef,
        'settled',
        outcome.txHash,
        null,
        null,
      );
      await finalizePaymentIntent(
        intentId,
        ownerRef,
        outcome.txHash,
        finalUsd,
        null,
        'settled',
        null,
      );
      return {
        status: 'settled',
        txHash: outcome.txHash,
        finalAmountUsd: finalUsd,
        cappedAt,
      };
    }

    // BLQ-1 + BLQ-ALTO-1 + BLQ-DR (atomicidad): el transfer on-chain falló DESPUÉS
    // del débito. El refund del débito vive DENTRO de finalize (misma tx que el
    // status flip, status-gated) ⇒ exactamente una vez. Solo en el caso inequívoco;
    // el ambiguo PUDO transferir → NO refundar (doble-gasto).
    if (outcome.failureKind === 'unequivocal') {
      // sign() lanzó / settle.success===false → no hubo transfer: buyer whole.
      const errMsg = outcome.error ?? 'settle failed';
      await recordSettleOutcome(
        intentId,
        ownerRef,
        'failed_unequivocal',
        null,
        null,
        errMsg,
      );
      const finalized = await finalizePaymentIntent(
        intentId,
        ownerRef,
        null,
        finalUsd,
        null,
        'failed_unequivocal',
        errMsg,
      );
      if (!finalized) throw new PaymentIntentError('INTERNAL');
      return {
        status: 'failed',
        txHash: null,
        finalAmountUsd: finalUsd,
        cappedAt,
        error: outcome.error,
      };
    }

    // AMBIGUO: NO refundar (evita doble-gasto). Flag RECONCILE + log.warn para
    // reconciliación manual (verificar on-chain si el transfer se ejecutó).
    log.warn(
      { intentId, detail: outcome.error },
      'settle ambiguo (upto): débito NO reembolsado, requiere reconciliación manual',
    );
    const ambiguousErr = `RECONCILE: ${outcome.error ?? 'settle ambiguous'}`;
    await recordSettleOutcome(
      intentId,
      ownerRef,
      'failed_ambiguous',
      null,
      null,
      ambiguousErr,
    );
    const finalizedAmbiguous = await finalizePaymentIntent(
      intentId,
      ownerRef,
      null,
      finalUsd,
      null,
      'failed_ambiguous',
      ambiguousErr,
    );
    if (!finalizedAmbiguous) throw new PaymentIntentError('INTERNAL');
    return {
      status: 'failed',
      txHash: null,
      finalAmountUsd: finalUsd,
      cappedAt,
      error: outcome.error,
    };
  },

  /**
   * AC-6: resuelve intents vencidos determinísticamente (auto-settle del
   * consumido + refund del residual para session; auto-settle 0 para upto sin
   * reporte). Barrido de sistema (cron): el owner guard usa el owner_ref de la
   * propia fila — NO es IDOR (mismo patrón que delegation.getParentKey).
   */
  async expireStale(): Promise<void> {
    const nowIso = new Date().toISOString();
    // 1. Intents 'open' vencidos (AC-6): auto-settle determinístico.
    const openRes = await supabase
      .from('a2a_payment_intents')
      .select('id, owner_ref, intent_type')
      .eq('status', 'open')
      .lt('expires_at', nowIso);
    if (openRes.error) {
      log.error(
        { detail: openRes.error.message },
        'expireStale open query failed',
      );
    }
    // 2. BLQ-DR: intents 'closing' huérfanos (finalize falló tras conocerse el
    //    veredicto) con updated_at viejo. Re-invocar close/settle: el short-circuit
    //    de 'closing' re-aplica el veredicto PERSISTIDO (settle_outcome) vía finalize
    //    idempotente (refund status-gated ⇒ exactamente una vez, jamás doble).
    const staleIso = new Date(
      Date.now() - resolveClosingStaleMs(),
    ).toISOString();
    const closingRes = await supabase
      .from('a2a_payment_intents')
      .select('id, owner_ref, intent_type')
      .eq('status', 'closing')
      .lt('updated_at', staleIso);
    if (closingRes.error) {
      log.error(
        { detail: closingRes.error.message },
        'expireStale closing query failed',
      );
    }
    // WKH-139 (AC-4/CD-13): barrer también intents 'arb_closing' huérfanos (el
    // árbitro settleó pero finalize blipeó). recoverArbClosing re-aplica el veredicto
    // persistido vía finalize idempotente (refund status-gated ⇒ exactamente una vez).
    const arbClosingRes = await supabase
      .from('a2a_payment_intents')
      .select('id, owner_ref')
      .eq('status', 'arb_closing')
      .lt('updated_at', staleIso);
    if (arbClosingRes.error) {
      log.error(
        { detail: arbClosingRes.error.message },
        'expireStale arb_closing query failed',
      );
    }
    // WKH-139 BLQ-BAJO-1 (defensa en profundidad): barrer intents 'disputed' huérfanos
    // (un openDispute que transicionó open→disputed pero murió antes de resolver/rollback).
    // Revertir →open (money-free, owner+status-guarded) los desbrickea → el settlement
    // normal (closeSession/expiry) vuelve a estar disponible. Mismo patrón que arb_closing.
    const disputedRes = await supabase
      .from('a2a_payment_intents')
      .select('id, owner_ref')
      .eq('status', 'disputed')
      .lt('updated_at', staleIso);
    if (disputedRes.error) {
      log.error(
        { detail: disputedRes.error.message },
        'expireStale disputed query failed',
      );
    }
    // Import dinámico: arbiter.ts importa settlePaymentIntentOnChain de este módulo;
    // un import estático de arbiterService acá crearía un ciclo. El import dinámico
    // dentro del sweep lo rompe (se resuelve en runtime, no en el grafo de módulos).
    const arbClosingStale = arbClosingRes.data ?? [];
    const disputedStale = disputedRes.data ?? [];
    if (arbClosingStale.length > 0 || disputedStale.length > 0) {
      const { arbiterService } = await import('./arbiter.js');
      for (const stale of arbClosingStale) {
        try {
          await arbiterService.recoverArbClosing(
            stale.id,
            stale.owner_ref,
            true,
          );
        } catch (err) {
          log.warn(
            {
              intentId: stale.id,
              detail: err instanceof Error ? err.message : String(err),
            },
            'expireStale arb_closing recovery failed for intent',
          );
        }
      }
      for (const stale of disputedStale) {
        try {
          await arbiterService.revertDisputeToOpen(stale.id, stale.owner_ref);
        } catch (err) {
          log.warn(
            {
              intentId: stale.id,
              detail: err instanceof Error ? err.message : String(err),
            },
            'expireStale disputed revert failed for intent',
          );
        }
      }
    }
    const rows = [...(openRes.data ?? []), ...(closingRes.data ?? [])];
    for (const stale of rows) {
      try {
        // BLQ-MED-1: allowStaleRecovery=true — estas filas YA se filtraron por
        // updated_at < staleIso, así que un settle_outcome=NULL acá SÍ es un huérfano
        // genuino (el settler murió) y debe finalizarse ('failed_ambiguous' reconcile),
        // a diferencia del path directo/concurrente donde el NULL es un settle in-flight.
        if (stale.intent_type === 'session') {
          await this.closeSession(stale.id, stale.owner_ref, true);
        } else {
          await this.settleUpto(stale.id, stale.owner_ref, 0, true);
        }
      } catch (err) {
        log.warn(
          {
            intentId: stale.id,
            detail: err instanceof Error ? err.message : String(err),
          },
          'expireStale settle failed for intent',
        );
      }
    }
  },
};
