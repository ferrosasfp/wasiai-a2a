-- ============================================================
-- Down migration: 20260704000000_wkh135_payment_intents
-- WKH-135: revierte los 4 RPC + las 2 tablas de payment intents.
-- Las firmas de DROP FUNCTION llevan los tipos exactos (R-1).
-- ============================================================

BEGIN;
DROP FUNCTION IF EXISTS finalize_payment_intent(uuid, text, text, numeric, numeric, text, text);
DROP FUNCTION IF EXISTS record_settle_outcome(uuid, text, text, text, numeric, text);
DROP FUNCTION IF EXISTS close_payment_intent_for_settle(uuid, text, numeric);
DROP FUNCTION IF EXISTS accumulate_payment_voucher(uuid, text, text, numeric);
DROP FUNCTION IF EXISTS open_payment_intent(uuid, text, text, uuid, text, text, text, integer, numeric, text, text, timestamptz);
DROP TABLE IF EXISTS a2a_payment_vouchers;
DROP TABLE IF EXISTS a2a_payment_intents;
COMMIT;
