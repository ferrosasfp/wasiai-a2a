-- ============================================================
-- Down Migration: 20260406000000_a2a_agent_keys
-- WKH-34: Drops all objects created by the up migration
-- Idempotent: safe to run multiple times
-- ============================================================

DROP TRIGGER IF EXISTS set_updated_at ON a2a_agent_keys;
DROP FUNCTION IF EXISTS increment_a2a_key_spend(UUID, INT, NUMERIC);
DROP TABLE IF EXISTS a2a_agent_keys;
-- Note: trigger_set_updated_at() is NOT dropped (shared with tasks table)
