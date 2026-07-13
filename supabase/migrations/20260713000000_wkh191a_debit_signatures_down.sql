-- ============================================================
-- Down: 20260713000000_wkh191a_debit_signatures
-- Revierte SOLO lo de WKH-191a: el RPC + la tabla (con su índice parcial y RLS,
-- que caen con el DROP TABLE). NO toca nada de wkh135.
-- ============================================================

BEGIN;
DROP FUNCTION IF EXISTS capture_debit_signature(uuid, text, uuid, text, numeric, bigint, numeric, text, text, text, text);
DROP TABLE IF EXISTS a2a_payment_intent_debit_signatures;
COMMIT;
