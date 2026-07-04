/**
 * Arbiter types — WKH-139 v2 · Agente-árbitro autónomo de disputas
 *
 * Tipos del árbitro que resuelve disputas sobre payment-intents `session`
 * (WKH-135): `release` (todo al Seller), `refund` (todo al Buyer) o `split`
 * (parcial). Rules-first, anclado en evidencia on-chain/DB; el LLM se invoca sólo
 * ante contradicción y NUNCA mueve fondos.
 *
 * Convención (mirror de receipt.ts): nullables como `T | null` (no `?:`), TS
 * strict, sin `any`. `exactOptionalPropertyTypes` en efecto (CD-15).
 */

/** Desenlace de una disputa. `hold` = congelado, sin movimiento de fondos. */
export type ArbiterDecision = 'release' | 'refund' | 'split' | 'hold';

/** Cómo se decidió: `rules` (determinístico), `llm` (asistido), `hold` (frozen). */
export type ArbiterMethod = 'rules' | 'llm' | 'hold';

/** Códigos estables mapeados a HTTP en el route (disclosure-safe). */
export type ArbiterErrorCode =
  | 'INVALID_INPUT'
  | 'OWNERSHIP_MISMATCH'
  | 'INTENT_NOT_FOUND'
  | 'INTENT_NOT_OPEN'
  | 'CHAIN_NOT_SUPPORTED'
  | 'ARBITER_DISABLED'
  | 'INTERNAL';

export class ArbiterError extends Error {
  readonly code: ArbiterErrorCode;
  constructor(code: ArbiterErrorCode) {
    super(code);
    this.name = 'ArbiterError';
    this.code = code;
  }
}

/**
 * Evidencia determinística de la disputa. SÓLO on-chain/DB (CD-8): estado del
 * intent + ledger de vouchers + proof-chain de recibos. PROHIBIDO input off-chain
 * de las partes (texto libre, adjuntos).
 */
export interface DisputeEvidence {
  intentId: string;
  authorizedUsd: number;
  consumedUsd: number;
  chainId: number;
  payTo: string;
  sellerRef: string;
  voucherCount: number;
  vouchersTotalUsd: number;
  /** false si algún recibo de la sesión falla `verify` (tamper). */
  proofChainOk: boolean;
  /** Σ recibos de settle/budget de la sesión (null si no hay ninguno). */
  receiptSettleTotalUsd: number | null;
}

/**
 * Resultado de una arbitración. `settleUsd` = monto forzado al Seller (0 si
 * refund/hold); `residualUsd` = deposit − settleUsd (refunda al Buyer).
 */
export interface ArbiterOutcome {
  decision: ArbiterDecision;
  method: ArbiterMethod;
  settleUsd: number;
  residualUsd: number;
  atStakeUsd: number;
  status: 'executed' | 'held';
  txHash: string | null;
  ambiguityReason: string | null;
  llmReasoning: string | null;
}
