-- ============================================================
-- Down: 20260713000003_wkh194_arbiter_nonces
-- Revierte SOLO lo de 194. Aditivo: dropea el RPC + la tabla nueva.
-- No toca a2a_payment_intents ni a2a_arbitrations ni datos de otras HUs.
-- ============================================================

BEGIN;
DROP FUNCTION IF EXISTS get_or_create_arbiter_nonce(uuid, text, text, numeric);
DROP TABLE IF EXISTS a2a_arbiter_nonces;
COMMIT;
