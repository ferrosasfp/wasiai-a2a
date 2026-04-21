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

// ─── Helpers ────────────────────────────────────────────────

const DEFAULT_FEE_RATE = 0.01;
const MAX_FEE_RATE = 0.1;
const MIN_FEE_RATE = 0.0;

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

// ─── chargeProtocolFee (W2) ────────────────────────────────

/**
 * Transfer del fee via EIP-712 sign + settle. Best-effort, nunca rechaza
 * (CD-B). Idempotencia DB via PK `a2a_protocol_fees.orchestration_id`.
 *
 * Flujo (ver SDD §3 DT-6):
 *   1. Si `WASIAI_PROTOCOL_FEE_WALLET` vacío → skip sin tocar DB.
 *   2. Calcular `feeUsdc = budget * rate` (6 decimales).
 *   3. Query idempotency por `orchestration_id`.
 *   4. INSERT `pending` con ON CONFLICT DO NOTHING.
 *   5. `paymentAdapter.sign({...})` + `settle({...})`.
 *   6. UPDATE status `charged` + tx_hash (o `failed` + error_message).
 *
 * **No implementado aún** — la impl entra en Wave 2.
 */
export async function chargeProtocolFee(
  params: FeeChargeParams,
): Promise<FeeChargeResult> {
  // Referencias para que el linter no se queje en el skeleton
  void getPaymentAdapter;
  void supabase;
  const _signResultType: SignResult | undefined = undefined;
  void _signResultType;

  const feeUsdc = Number((params.budgetUsdc * params.feeRate).toFixed(6));

  return {
    status: 'failed',
    feeUsdc,
    error: 'NOT_IMPLEMENTED',
  };
}
