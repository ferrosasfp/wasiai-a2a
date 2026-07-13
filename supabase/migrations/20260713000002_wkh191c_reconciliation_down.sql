-- ============================================================
-- Down: 20260713000002_wkh191c_reconciliation
-- Revierte SOLO lo de 191c. NO destruye datos de 191a/191b. Restaura el CHECK de
-- 191b (3 valores). NOTA: si existen filas en estados resolving_*/resolved_*, el
-- restore del CHECK las rechazaría — el down asume que no hay resoluciones en vuelo
-- (revert en dev/CI antes de datos reales).
-- ============================================================

BEGIN;
DROP FUNCTION IF EXISTS record_reconciliation_resolution(uuid, text, uuid, numeric, text, text, integer, numeric);
DROP FUNCTION IF EXISTS claim_reconciliation(uuid, text, uuid, numeric, text);
DROP INDEX IF EXISTS idx_debit_sig_resolving;
ALTER TABLE a2a_payment_intent_debit_signatures
  DROP COLUMN IF EXISTS debit_resolved_at,
  DROP COLUMN IF EXISTS debit_resolution_tx_hash;
ALTER TABLE a2a_payment_intent_debit_signatures
  DROP CONSTRAINT IF EXISTS a2a_payment_intent_debit_signatures_debit_settle_status_check;
ALTER TABLE a2a_payment_intent_debit_signatures
  ADD  CONSTRAINT a2a_payment_intent_debit_signatures_debit_settle_status_check
  CHECK (debit_settle_status IS NULL OR debit_settle_status IN
    ('hop1_confirmed','settled','reconciliation_pending'));
COMMIT;
