/**
 * Receipt types — WKH-124 KEY-RECEIPTS
 *
 * Recibos inmutables HMAC-encadenados (append-only) por owner. Tipos en archivo
 * propio (CD-8: cero fanout sobre row-types existentes). NUMERIC → string;
 * nullables como `T | null`. TS strict, sin `any`.
 */

// WKH-126b: 'deposit_verified' agregado para el recibo del depósito escrow
// verificado on-chain (AC-11/DT-11). PROVISIONAL — VERIFY-AT-IMPL: confirmar que
// la columna `receipt_type` / RPC `insert_receipt` lo acepta (posible CHECK
// constraint en `a2a_receipts`). `emit` es best-effort → un rechazo degrada a
// WARN sin romper el depósito (Story File §9 R-3).
// WKH-139: 4 tipos de recibo del árbitro autónomo (release/refund/split/hold).
// El CHECK de `a2a_receipts.receipt_type` se amplía en la migración
// 20260704100000_wkh139_arbiter.sql; `emit` es best-effort (un rechazo degrada a
// WARN sin romper el arbitraje).
export type ReceiptType =
  | 'protocol_fee'
  | 'budget_debit'
  | 'deposit_verified'
  | 'arbitration_release'
  | 'arbitration_refund'
  | 'arbitration_split'
  | 'arbitration_hold';

/**
 * Modela EXACTO las columnas de `a2a_receipts`. `amount_usd` (NUMERIC) llega de
 * Supabase como string; los timestamps como ISO string.
 */
export interface ReceiptRow {
  id: string;
  owner_ref: string;
  agent_key_id: string | null;
  session_id: string | null;
  delegation_id: string | null;
  receipt_type: ReceiptType;
  amount_usd: string;
  chain_id: number;
  tx_hash: string | null;
  counterparty: string | null;
  orchestration_id: string | null;
  prev_receipt_hash: string | null;
  receipt_hash: string;
  created_at: string;
}

/**
 * Input que arma cada call-site para `receiptService.emit`. `ownerRef` es
 * `string` no-vacío (CD-D): si el call-site no lo tiene → NO llama emit.
 */
export interface EmitReceiptInput {
  ownerRef: string;
  agentKeyId: string | null;
  sessionId: string | null;
  delegationId: string | null;
  receiptType: ReceiptType;
  amountUsd: number | string;
  chainId: number;
  txHash: string | null;
  counterparty: string | null;
  orchestrationId: string | null;
}

/**
 * Resultado de `GET /receipts/:id/verify`. `valid:false` puede portar
 * `tamper_detected` (mismatch) o `reason` (recibo sin firma / secret ausente).
 * El secret NUNCA se expone (CD-4): solo hashes.
 */
export type VerifyReceiptResult =
  | {
      valid: true;
      receipt_id: string;
      computed_hash: string;
      stored_hash: string;
    }
  | {
      valid: false;
      receipt_id: string;
      tamper_detected?: true;
      reason?: 'UNSIGNED' | 'SIGNING_SECRET_UNAVAILABLE';
    };

/**
 * Subset seguro para listar (AC-7). `receipt_hash` es seguro de exponer; el
 * secret NO (CD-4). No incluye nada sensible adicional.
 */
export interface ReceiptListItem {
  id: string;
  owner_ref: string;
  agent_key_id: string | null;
  session_id: string | null;
  delegation_id: string | null;
  receipt_type: ReceiptType;
  amount_usd: string;
  chain_id: number;
  tx_hash: string | null;
  counterparty: string | null;
  orchestration_id: string | null;
  prev_receipt_hash: string | null;
  receipt_hash: string;
  created_at: string;
}
