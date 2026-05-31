BEGIN;
-- WKH-100 FIX v2 (MNR-2) rollback: drop the partial UNIQUE index added by
-- 20260531000000_erc8004_token_unique.sql. Idempotent (IF EXISTS).
DROP INDEX IF EXISTS uq_a2a_agent_keys_erc8004_token;
COMMIT;
