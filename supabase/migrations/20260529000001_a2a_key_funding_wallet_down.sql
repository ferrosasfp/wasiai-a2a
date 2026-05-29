-- ============================================================
-- Down Migration: 20260529000001_a2a_key_funding_wallet
-- WKH-35 FIX-1: drops the funding_wallet unique index + column.
-- Idempotent: safe to run multiple times.
-- ============================================================

BEGIN;

DROP INDEX IF EXISTS uq_a2a_agent_keys_funding_wallet;

ALTER TABLE a2a_agent_keys
  DROP COLUMN IF EXISTS funding_wallet;

COMMIT;
