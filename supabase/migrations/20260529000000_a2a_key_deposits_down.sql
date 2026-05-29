-- ============================================================
-- Down Migration: 20260529000000_a2a_key_deposits
-- WKH-35: Drops the deposits table + restores register_a2a_key_deposit v1
-- Idempotent: safe to run multiple times
-- ============================================================

-- Drop the v2 function (firma nueva con 6 args).
DROP FUNCTION IF EXISTS register_a2a_key_deposit(UUID, INT, NUMERIC, TEXT, TEXT, TEXT);

-- Drop the anti-replay table (FK depende de a2a_agent_keys; se dropea primero).
DROP TABLE IF EXISTS a2a_key_deposits;

-- Restore v1 (sin owner_ref, sin txHash) — firma vieja (uuid, int, numeric).
CREATE OR REPLACE FUNCTION register_a2a_key_deposit(
  p_key_id UUID,
  p_chain_id INT,
  p_amount_usd NUMERIC
)
RETURNS TEXT AS $$
DECLARE
  v_budget JSONB;
  v_chain TEXT := p_chain_id::TEXT;
  v_current NUMERIC;
  v_new NUMERIC;
BEGIN
  SELECT budget INTO v_budget FROM a2a_agent_keys WHERE id = p_key_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'key_not_found'; END IF;
  v_current := COALESCE((v_budget ->> v_chain)::NUMERIC, 0);
  v_new := v_current + p_amount_usd;
  UPDATE a2a_agent_keys
  SET budget = jsonb_set(COALESCE(v_budget, '{}'::jsonb), ARRAY[v_chain], to_jsonb(v_new::TEXT))
  WHERE id = p_key_id;
  RETURN v_new::TEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Restore v1 search_path hardening (patrón 20260427160000).
ALTER FUNCTION public.register_a2a_key_deposit(uuid, integer, numeric)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.register_a2a_key_deposit(uuid, integer, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_a2a_key_deposit(uuid, integer, numeric)
  TO service_role;
