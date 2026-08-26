-- ============================================================
-- Down migration: 20260823000000_wkh225_suspended_runs
-- WKH-225: revierte los 2 RPC + el trigger de expires_at + la tabla de runs
-- suspendidos. Las firmas de DROP FUNCTION llevan los tipos exactos.
--
-- ⚠️ `trigger_set_updated_at` NO se dropea: es compartida con otras tablas
-- (a2a_agent_links, a2a_payment_intents). Los triggers que la usan se van con
-- el DROP TABLE.
-- ============================================================

BEGIN;
DROP FUNCTION IF EXISTS settle_suspended_run(uuid, text, text, text);
DROP FUNCTION IF EXISTS claim_suspended_run(text, text);
DROP TRIGGER IF EXISTS set_a2a_suspended_runs_expires_at ON a2a_suspended_runs;
DROP FUNCTION IF EXISTS trigger_set_suspended_run_expires_at();
DROP TABLE IF EXISTS a2a_suspended_runs;
COMMIT;
