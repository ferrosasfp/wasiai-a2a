-- Down de 20260611000000: vuelve el CHECK al set original (sin 'deposit_verified').
-- Requiere que no existan filas con receipt_type='deposit_verified' (si las hay,
-- el ADD CONSTRAINT fallaría — borrarlas o conservarlas según el caso).
BEGIN;
ALTER TABLE a2a_receipts DROP CONSTRAINT IF EXISTS a2a_receipts_receipt_type_check;
ALTER TABLE a2a_receipts ADD CONSTRAINT a2a_receipts_receipt_type_check
  CHECK (receipt_type IN ('protocol_fee', 'budget_debit'));
COMMIT;
