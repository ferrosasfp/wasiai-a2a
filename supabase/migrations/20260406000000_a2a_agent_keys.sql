-- ============================================================
-- Migration: 20260406000000_a2a_agent_keys
-- WKH-34: Agentic Economy Primitives L3
-- Creates table a2a_agent_keys + function increment_a2a_key_spend
-- ============================================================

-- Table: a2a_agent_keys
CREATE TABLE IF NOT EXISTS a2a_agent_keys (
  id                      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_ref               TEXT          NOT NULL,
  key_hash                TEXT          UNIQUE NOT NULL,
  display_name            TEXT,

  -- budget: per-chain balance as JSONB {"chain_id_string": "amount_string"}
  budget                  JSONB         DEFAULT '{}'::jsonb,
  daily_limit_usd         NUMERIC(18,6),
  daily_spent_usd         NUMERIC(18,6) DEFAULT 0,
  daily_reset_at          TIMESTAMPTZ   DEFAULT NOW(),

  -- scoping
  allowed_registries      TEXT[],
  allowed_agent_slugs     TEXT[],
  allowed_categories      TEXT[],
  max_spend_per_call_usd  NUMERIC(18,6),

  -- lifecycle
  is_active               BOOLEAN       DEFAULT true,
  last_used_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- optional on-chain bindings (JSONB to stay chain-agnostic)
  erc8004_identity        JSONB,
  kite_passport           JSONB,
  agentkit_wallet         JSONB,

  metadata                JSONB         DEFAULT '{}'::jsonb
);

-- Index: partial index on active keys for lookup performance (AC-4)
CREATE INDEX IF NOT EXISTS idx_a2a_agent_keys_active
  ON a2a_agent_keys (is_active)
  WHERE is_active = true;

-- Trigger: updated_at (reuse existing function from tasks migration)
DROP TRIGGER IF EXISTS set_updated_at ON a2a_agent_keys;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON a2a_agent_keys
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

-- Function: increment_a2a_key_spend
-- Atomically debits budget for a given chain, increments daily_spent_usd,
-- updates last_used_at. Lazy daily reset per DT-5.
-- Raises exception if budget insufficient or daily limit exceeded.
CREATE OR REPLACE FUNCTION increment_a2a_key_spend(
  p_key_id    UUID,
  p_chain_id  INT,
  p_amount_usd NUMERIC
) RETURNS void AS $$
DECLARE
  v_row          a2a_agent_keys%ROWTYPE;
  v_chain_key    TEXT;
  v_current_bal  NUMERIC;
  v_new_bal      NUMERIC;
  v_daily_spent  NUMERIC;
  v_daily_limit  NUMERIC;
BEGIN
  -- Lock the row for atomic update
  SELECT * INTO v_row
    FROM a2a_agent_keys
    WHERE id = p_key_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'KEY_NOT_FOUND: key_id % does not exist', p_key_id;
  END IF;

  IF NOT v_row.is_active THEN
    RAISE EXCEPTION 'KEY_INACTIVE: key_id % is deactivated', p_key_id;
  END IF;

  -- Lazy daily reset (DT-5): if daily_reset_at is in the past, reset counters
  IF v_row.daily_reset_at < NOW() THEN
    v_row.daily_spent_usd := 0;
    -- Advance by 24h intervals until in the future
    WHILE v_row.daily_reset_at < NOW() LOOP
      v_row.daily_reset_at := v_row.daily_reset_at + INTERVAL '24 hours';
    END LOOP;
  END IF;

  -- Check daily limit
  v_daily_spent := v_row.daily_spent_usd;
  v_daily_limit := v_row.daily_limit_usd;

  IF v_daily_limit IS NOT NULL AND (v_daily_spent + p_amount_usd) > v_daily_limit THEN
    RAISE EXCEPTION 'DAILY_LIMIT: daily spend would be % + % = %, limit is %',
      v_daily_spent, p_amount_usd, v_daily_spent + p_amount_usd, v_daily_limit;
  END IF;

  -- Check chain budget
  v_chain_key := p_chain_id::TEXT;
  v_current_bal := COALESCE((v_row.budget ->> v_chain_key)::NUMERIC, 0);

  IF v_current_bal < p_amount_usd THEN
    RAISE EXCEPTION 'INSUFFICIENT_BUDGET: chain % balance is %, requested %',
      v_chain_key, v_current_bal, p_amount_usd;
  END IF;

  -- Debit
  v_new_bal := v_current_bal - p_amount_usd;

  UPDATE a2a_agent_keys
  SET
    budget          = jsonb_set(budget, ARRAY[v_chain_key], to_jsonb(v_new_bal::TEXT)),
    daily_spent_usd = v_row.daily_spent_usd + p_amount_usd,
    daily_reset_at  = v_row.daily_reset_at,
    last_used_at    = NOW()
  WHERE id = p_key_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
