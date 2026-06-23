-- WKH-126b/126a escrow: permitir receipt_type='deposit_verified' (recibo del
-- depósito al escrow no-custodial). Additive: amplía el set permitido del CHECK.
-- El escrow-verifier (126b) emite 'deposit_verified' best-effort; sin esto el
-- INSERT lo rechaza y el recibo se pierde silenciosamente (never-throw).
-- Aplicar a prod JUNTO con la activación del escrow (ESCROW_MODE_ENABLED=true).
BEGIN;
ALTER TABLE a2a_receipts DROP CONSTRAINT IF EXISTS a2a_receipts_receipt_type_check;
ALTER TABLE a2a_receipts ADD CONSTRAINT a2a_receipts_receipt_type_check
  CHECK (receipt_type IN ('protocol_fee', 'budget_debit', 'deposit_verified'));
COMMIT;
