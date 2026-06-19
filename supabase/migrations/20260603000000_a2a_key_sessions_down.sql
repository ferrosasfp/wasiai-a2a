-- ============================================================
-- Down migration: 20260603000000_a2a_key_sessions
-- WKH-121: revierte tabla a2a_key_sessions + RPC debit_session_and_parent.
-- ============================================================

BEGIN;
DROP FUNCTION IF EXISTS debit_session_and_parent(uuid, text, uuid, integer, numeric);
DROP TABLE IF EXISTS a2a_key_sessions;
COMMIT;
