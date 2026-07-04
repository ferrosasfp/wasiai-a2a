/**
 * Arbiter evidence reader — WKH-139 v2 (W1.1)
 *
 * Lee la evidencia determinística de una disputa **SÓLO on-chain/DB** (CD-8):
 *   (a) estado del intent (owner-guarded SELECT sobre a2a_payment_intents),
 *   (b) ledger de vouchers (a2a_payment_vouchers, owner-guarded),
 *   (c) proof-chain de recibos de la sesión (receiptService.verify por integridad).
 *
 * PROHIBIDO cualquier input off-chain de las partes (texto libre, adjuntos). Todas
 * las queries llevan Ownership Guard `owner_ref` (CD-2). Montos en micro-USD entero
 * para las comparaciones aguas abajo (rules.ts).
 *
 * Exemplar: src/services/receipt.ts (list/getById/verify, owner-guard).
 */

import { getLogger } from '../../lib/logger.js';
import { supabase } from '../../lib/supabase.js';
import { ArbiterError, type DisputeEvidence } from '../../types/arbiter.js';
import type { ReceiptType } from '../../types/receipt.js';
import { receiptService } from '../receipt.js';

const log = getLogger('arbiter-evidence');

// Recibos que representan dinero settleado/debitado de la sesión. Su Σ debe
// corroborar `consumed_usd` (rules.ts A-RECEIPT-MISMATCH); si no hay ninguno → null.
const SETTLE_RECEIPT_TYPES: ReadonlySet<ReceiptType> = new Set([
  'budget_debit',
  'arbitration_release',
  'arbitration_split',
]);

/**
 * Normaliza un NUMERIC (string en runtime desde Supabase, number en el tipo
 * generado) a micro-USD entero. Nunca lanza. Réplica del helper privado de
 * payment-intent.ts (CD-6 pide replicar, no importar privados).
 */
function numericToMicro(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? Math.round(n * 1_000_000) : 0;
}

/**
 * Lee la evidencia de la disputa para `intentId`, owner-guarded. Lanza
 * ArbiterError('INTENT_NOT_FOUND') si el intent no existe o no es del caller
 * (disclosure-safe). Nunca incorpora datos off-chain.
 */
export async function readEvidence(
  intentId: string,
  ownerRef: string,
): Promise<DisputeEvidence> {
  // (a) snapshot del intent (owner-guarded).
  const intentRes = await supabase
    .from('a2a_payment_intents')
    .select('authorized_usd, consumed_usd, chain_id, pay_to, seller_ref')
    .eq('id', intentId)
    .eq('owner_ref', ownerRef)
    .single();
  if (intentRes.error) {
    if (intentRes.error.code === 'PGRST116') {
      throw new ArbiterError('INTENT_NOT_FOUND');
    }
    log.error(
      { intentId, detail: intentRes.error.message },
      'evidence intent query failed',
    );
    throw new ArbiterError('INTERNAL');
  }
  const intent = intentRes.data;

  // (b) ledger de vouchers (owner-guarded).
  const vouchersRes = await supabase
    .from('a2a_payment_vouchers')
    .select('amount_usd')
    .eq('intent_id', intentId)
    .eq('owner_ref', ownerRef);
  if (vouchersRes.error) {
    log.error(
      { intentId, detail: vouchersRes.error.message },
      'evidence vouchers query failed',
    );
    throw new ArbiterError('INTERNAL');
  }
  const voucherRows = vouchersRes.data ?? [];
  const voucherCount = voucherRows.length;
  const vouchersTotalMicro = voucherRows.reduce(
    (acc, r) => acc + numericToMicro(r.amount_usd),
    0,
  );

  // (c) proof-chain de recibos de la sesión (owner-guarded) + verify de integridad.
  const receiptsRes = await supabase
    .from('a2a_receipts')
    .select('id, receipt_type, amount_usd')
    .eq('session_id', intentId)
    .eq('owner_ref', ownerRef);
  if (receiptsRes.error) {
    log.error(
      { intentId, detail: receiptsRes.error.message },
      'evidence receipts query failed',
    );
    throw new ArbiterError('INTERNAL');
  }
  const receiptRows = receiptsRes.data ?? [];

  let proofChainOk = true;
  let receiptSettleMicro = 0;
  let hasSettleReceipt = false;
  for (const r of receiptRows) {
    // Integridad: un recibo alterado (tamper) rompe la proof-chain. Un recibo sin
    // firma / secret ausente NO es tamper (config) → no invalida la cadena.
    const verdict = await receiptService.verify(r.id, ownerRef);
    if (verdict.valid === false && verdict.tamper_detected === true) {
      proofChainOk = false;
    }
    if (SETTLE_RECEIPT_TYPES.has(r.receipt_type as ReceiptType)) {
      hasSettleReceipt = true;
      receiptSettleMicro += numericToMicro(r.amount_usd);
    }
  }

  return {
    intentId,
    authorizedUsd: numericToMicro(intent.authorized_usd) / 1_000_000,
    consumedUsd: numericToMicro(intent.consumed_usd) / 1_000_000,
    chainId: intent.chain_id,
    payTo: intent.pay_to,
    sellerRef: intent.seller_ref,
    voucherCount,
    vouchersTotalUsd: vouchersTotalMicro / 1_000_000,
    proofChainOk,
    receiptSettleTotalUsd: hasSettleReceipt
      ? receiptSettleMicro / 1_000_000
      : null,
  };
}
