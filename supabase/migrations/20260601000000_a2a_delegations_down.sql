-- ============================================================
-- Down migration: 20260601000000_a2a_delegations
-- WKH-101: revierte tabla a2a_delegations + RPC debit_delegation_and_parent.
-- ============================================================

BEGIN;
DROP FUNCTION IF EXISTS debit_delegation_and_parent(uuid, text, uuid, integer, numeric);
DROP TABLE IF EXISTS a2a_delegations;
COMMIT;
