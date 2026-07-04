/**
 * Arbiter deterministic rules engine — WKH-139 v2 (W1.2)
 *
 * Motor **puro** (sin I/O): dada la evidencia on-chain/DB, decide un desenlace
 * inequívoco (`release`/`refund`/`split`) o escala con `{ ambiguous, reason }`
 * cuando la evidencia es genuinamente contradictoria/rota.
 *
 * Toda comparación/aritmética en micro-USD entero (CD-6), con tolerancia de
 * micro-USD para absorber ruido de redondeo NUMERIC. Ambigüedad genuina = SÓLO
 * las reglas 1–3 (integridad rota / contradicción); ninguna otra rama escala.
 */

import type { DisputeEvidence } from '../../types/arbiter.js';

/** Tolerancia de comparación: 1 micro-USD (absorbe ruido de redondeo). */
const TOLERANCE_MICRO = 1;

function toMicro(usd: number): number {
  return Math.round(usd * 1_000_000);
}

export type RulesDecision =
  | { decision: 'release' | 'refund' | 'split'; settleUsd: number }
  | { ambiguous: true; reason: string };

/**
 * Clasifica la disputa de forma determinística. Orden EXACTO (el primero que
 * matchea gana):
 *   1. G-INTEGRITY     — proof-chain con integridad rota → ambiguous.
 *   2. A-EMPTY-LEDGER  — consumed>0 pero sin vouchers → ambiguous.
 *   3. A-RECEIPT-MISMATCH — recibos de settle no corroboran consumed → ambiguous.
 *   4. R-REFUND        — consumed==0 → refund (settle 0).
 *   5. R-RELEASE       — consumed>=deposit → release (settle=deposit).
 *   6. R-SPLIT         — 0<consumed<deposit y ledger corrobora → split (settle=consumed).
 * Si en R-SPLIT el ledger NO corrobora dentro de tolerancia → ambiguous
 * (meter_receipt_mismatch), NUNCA settlea a ciegas.
 */
export function classify(ev: DisputeEvidence): RulesDecision {
  const consumedMicro = toMicro(ev.consumedUsd);
  const depositMicro = toMicro(ev.authorizedUsd);
  const vouchersMicro = toMicro(ev.vouchersTotalUsd);

  // 1. G-INTEGRITY: proof-chain rota (tamper) → no se puede decidir.
  if (!ev.proofChainOk) {
    return { ambiguous: true, reason: 'proof_chain_tampered' };
  }

  // 2. A-EMPTY-LEDGER: hay consumo pero el ledger de vouchers está vacío →
  //    evidencia incompleta (el consumo no está respaldado).
  if (consumedMicro > 0 && ev.voucherCount === 0) {
    return { ambiguous: true, reason: 'evidence_incomplete' };
  }

  // 3. A-RECEIPT-MISMATCH: los recibos de settle existen pero contradicen el
  //    meter (consumed) más allá de la tolerancia → fuentes en conflicto.
  if (ev.receiptSettleTotalUsd !== null) {
    const receiptMicro = toMicro(ev.receiptSettleTotalUsd);
    if (Math.abs(receiptMicro - consumedMicro) > TOLERANCE_MICRO) {
      return { ambiguous: true, reason: 'meter_receipt_mismatch' };
    }
  }

  // 4. R-REFUND: nada consumido → todo al Buyer.
  if (consumedMicro === 0) {
    return { decision: 'refund', settleUsd: 0 };
  }

  // 5. R-RELEASE: consumo >= deposit → todo al Seller (clamp al deposit).
  if (consumedMicro >= depositMicro) {
    return { decision: 'release', settleUsd: depositMicro / 1_000_000 };
  }

  // 6. R-SPLIT: 0 < consumed < deposit y el ledger corrobora → parcial al meter.
  if (Math.abs(vouchersMicro - consumedMicro) <= TOLERANCE_MICRO) {
    return { decision: 'split', settleUsd: consumedMicro / 1_000_000 };
  }

  // El ledger NO corrobora el consumo → contradicción, escala (no settlea a ciegas).
  return { ambiguous: true, reason: 'meter_receipt_mismatch' };
}
