-- ============================================================
-- Down: 20260713000001_wkh191b_debit_hop1
-- Revierte SOLO lo de 191b. No destruye datos de 191a (la tabla persiste; solo
-- se dropean las 3 columnas aditivas + el índice + los 2 RPC).
-- ============================================================

BEGIN;
DROP FUNCTION IF EXISTS record_debit_settle_status(uuid, text, uuid, numeric, text);
DROP FUNCTION IF EXISTS record_debit_hop1(uuid, text, uuid, numeric, text);
DROP INDEX IF EXISTS idx_debit_sig_settle_status;
ALTER TABLE a2a_payment_intent_debit_signatures
  DROP COLUMN IF EXISTS debit_settle_status,
  DROP COLUMN IF EXISTS debit_hop1_confirmed_at,
  DROP COLUMN IF EXISTS debit_hop1_tx_hash;
COMMIT;
