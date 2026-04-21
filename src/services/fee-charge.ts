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

import { getPaymentAdapter } from '../adapters/registry.js';
import type { SignResult } from '../adapters/types.js';
import { supabase } from '../lib/supabase.js';

// ─── Tipos públicos ─────────────────────────────────────────

export interface FeeChargeParams {
  orchestrationId: string;
  budgetUsdc: number;
  feeRate: number;
}

/**
 * Resultado del intento de cobro. Discriminated union por `status` — el
 * caller hace `switch`/`if` sobre `result.status` para narrowing seguro.
 */
export type FeeChargeResult =
  | { status: 'charged'; feeUsdc: number; txHash: string }
  | {
      status: 'already-charged';
      feeUsdc: number;
      txHash?: string;
      inProgress?: boolean;
    }
  | { status: 'skipped'; feeUsdc: number; reason: 'WALLET_UNSET' }
  | { status: 'failed'; feeUsdc: number; error: string };

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
 * Infinity → fallback `0.01` + `console.error`.
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
    console.error(
      `[FeeCharge] Invalid PROTOCOL_FEE_RATE="${raw}" (must be finite number in [${MIN_FEE_RATE}, ${MAX_FEE_RATE}]); falling back to ${DEFAULT_FEE_RATE}`,
    );
    return DEFAULT_FEE_RATE;
  }

  return parsed;
}

// ─── chargeProtocolFee ──────────────────────────────────────

/**
 * Convierte feeUsdc a wei (18 decimals). Patrón idéntico a
 * `src/services/compose.ts:188-190`:
 *   BigInt(Math.round(usdc * 1e6)) * BigInt(1e12)
 *
 * Rationale: USDC tiene 6 decimals lógicos; 1e12 escala a 18 decimals para
 * el token PYUSD.
 */
function feeUsdcToWei(feeUsdc: number): string {
  return String(BigInt(Math.round(feeUsdc * 1e6)) * BigInt(1e12));
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
 *      - failed  → permitir retry (avanza).
 *   4. INSERT `pending` con ON CONFLICT DO NOTHING.
 *      - error 23505 (unique_violation) → already-charged inProgress=true.
 *   5. `paymentAdapter.sign({...})` + `settle({...})` con mismo patrón que
 *      `src/services/compose.ts:191-213`.
 *   6. UPDATE status `charged` + tx_hash (o `failed` + error_message).
 */
export async function chargeProtocolFee(
  params: FeeChargeParams,
): Promise<FeeChargeResult> {
  const { orchestrationId, budgetUsdc, feeRate } = params;

  // Paso 2 parcial: cálculo del fee (siempre retornado en el shape).
  const feeUsdc = Number((budgetUsdc * feeRate).toFixed(6));

  // Safety guard (CD-3): si el fee supera el budget, esto no se cobra; es
  // síntoma de un rate corrupto → ProtocolFeeError (HTTP 400 en el route).
  if (feeUsdc > budgetUsdc) {
    throw new ProtocolFeeError(
      `Protocol fee (${feeUsdc}) exceeds budget (${budgetUsdc}) — check PROTOCOL_FEE_RATE env var.`,
    );
  }

  // Paso 1 (CD-2): wallet vacía → skip silencioso. NO tocamos DB.
  const walletAddress = process.env.WASIAI_PROTOCOL_FEE_WALLET;
  if (!walletAddress || walletAddress === '') {
    console.warn(
      '[FeeCharge] WASIAI_PROTOCOL_FEE_WALLET not set, skipping fee transfer',
    );
    return { status: 'skipped', feeUsdc, reason: 'WALLET_UNSET' };
  }

  // A partir de acá todo va wrappeado en try/catch (CD-B: jamás rechazar).
  try {
    // Paso 3: idempotency query.
    const { data: existing, error: selectErr } = (await supabase
      .from(FEES_TABLE)
      .select('status, tx_hash')
      .eq('orchestration_id', orchestrationId)
      .maybeSingle()) as {
      data: ExistingFeeRow | null;
      error: SupabaseError | null;
    };

    if (selectErr) {
      console.error(
        `[FeeCharge] DB select error for ${orchestrationId}:`,
        selectErr.message,
      );
      return {
        status: 'failed',
        feeUsdc,
        error: `DB_ERROR: ${selectErr.message ?? 'unknown'}`,
      };
    }

    if (existing) {
      if (existing.status === 'charged') {
        return {
          status: 'already-charged',
          feeUsdc,
          txHash: existing.tx_hash ?? undefined,
        };
      }
      if (existing.status === 'pending') {
        // Otra request activa — evita race en retries.
        return { status: 'already-charged', feeUsdc, inProgress: true };
      }
      // 'failed' | 'skipped' → permitimos retry (cae al insert de abajo).
      // En 'failed' el insert chocará con unique_violation; lo capturamos
      // igual que el path de race.
    }

    // Paso 4: INSERT pending (ON CONFLICT DO NOTHING via unique_violation).
    const feeWei = feeUsdcToWei(feeUsdc);
    const { error: insertErr } = (await supabase.from(FEES_TABLE).insert({
      orchestration_id: orchestrationId,
      budget_usdc: budgetUsdc,
      fee_rate: feeRate,
      fee_usdc: feeUsdc,
      fee_wallet: walletAddress,
      status: 'pending',
    })) as { error: SupabaseError | null };

    if (insertErr) {
      if (insertErr.code === PG_UNIQUE_VIOLATION) {
        // Race condition — otro request insertó primero. Retornamos
        // already-charged inProgress; el otro worker se encargará.
        return { status: 'already-charged', feeUsdc, inProgress: true };
      }
      // Otro error de DB → failed (CD-B, nunca rechazar).
      console.error(
        `[FeeCharge] DB insert error for ${orchestrationId}:`,
        insertErr.message,
      );
      return {
        status: 'failed',
        feeUsdc,
        error: `DB_ERROR: ${insertErr.message ?? 'unknown'}`,
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
      const msg = signErr instanceof Error ? signErr.message : String(signErr);
      console.error(`[FeeCharge] sign() failed for ${orchestrationId}:`, msg);
      await markFailed(orchestrationId, msg);
      return { status: 'failed', feeUsdc, error: msg };
    }

    const { paymentRequest } = signResult;
    try {
      const settleResult = await getPaymentAdapter().settle({
        authorization: paymentRequest.authorization,
        signature: paymentRequest.signature,
        network: paymentRequest.network ?? '',
      });

      if (!settleResult.success) {
        const errMsg = `settle failed: ${settleResult.error ?? 'unknown'}`;
        console.error(`[FeeCharge] ${errMsg} for ${orchestrationId}`);
        await markFailed(orchestrationId, errMsg);
        return { status: 'failed', feeUsdc, error: errMsg };
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
        console.error(
          `[FeeCharge] DB update-charged error for ${orchestrationId}:`,
          updateErr.message,
        );
      }

      return { status: 'charged', feeUsdc, txHash };
    } catch (settleErr) {
      const msg =
        settleErr instanceof Error ? settleErr.message : String(settleErr);
      console.error(`[FeeCharge] settle() threw for ${orchestrationId}:`, msg);
      await markFailed(orchestrationId, msg);
      return { status: 'failed', feeUsdc, error: msg };
    }
  } catch (err) {
    // Captura cualquier excepción sincrónica / async no prevista (ej. el
    // cliente de supabase lanza al construir el builder). CD-B: jamás
    // rechazar la promise.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[FeeCharge] Unexpected error for ${orchestrationId}:`, msg);
    return { status: 'failed', feeUsdc, error: `DB_ERROR: ${msg}` };
  }
}

/**
 * Helper para marcar el row como `failed` sin propagar errores (best-effort).
 */
async function markFailed(
  orchestrationId: string,
  errorMessage: string,
): Promise<void> {
  try {
    await supabase
      .from(FEES_TABLE)
      .update({
        status: 'failed',
        error_message: truncateError(errorMessage),
      })
      .eq('orchestration_id', orchestrationId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[FeeCharge] failed to mark row as failed for ${orchestrationId}:`,
      msg,
    );
  }
}
