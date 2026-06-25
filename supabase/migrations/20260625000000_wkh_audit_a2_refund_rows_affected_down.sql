-- ============================================================
-- DOWN: 20260625000000_wkh_audit_a2_refund_rows_affected
-- Restaura ambas RPC de refund a su versión `RETURNS void` (pre-A2).
-- ============================================================

DROP FUNCTION IF EXISTS refund_a2a_key_spend(uuid, integer, numeric, text);

CREATE FUNCTION refund_a2a_key_spend(
  p_key_id     UUID,
  p_chain_id   INT,
  p_amount_usd NUMERIC,
  p_owner_ref  TEXT
) RETURNS void AS $$
DECLARE
  v_row          a2a_agent_keys%ROWTYPE;
  v_chain_key    TEXT;
  v_current_bal  NUMERIC;
  v_new_bal      NUMERIC;
  v_new_daily    NUMERIC;
BEGIN
  SELECT * INTO v_row
    FROM a2a_agent_keys
    WHERE id = p_key_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'KEY_NOT_FOUND: key_id % does not exist', p_key_id;
  END IF;

  IF v_row.owner_ref IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key % not owned by caller', p_key_id;
  END IF;

  IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
    RETURN;
  END IF;

  v_chain_key   := p_chain_id::TEXT;
  v_current_bal := COALESCE((v_row.budget ->> v_chain_key)::NUMERIC, 0);
  v_new_bal     := v_current_bal + p_amount_usd;
  v_new_daily   := GREATEST(v_row.daily_spent_usd - p_amount_usd, 0);

  UPDATE a2a_agent_keys
  SET
    budget          = jsonb_set(budget, ARRAY[v_chain_key], to_jsonb(v_new_bal::TEXT)),
    daily_spent_usd = v_new_daily,
    last_used_at    = NOW()
  WHERE id = p_key_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.refund_a2a_key_spend(uuid, integer, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.refund_a2a_key_spend(uuid, integer, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_a2a_key_spend(uuid, integer, numeric, text)
  TO service_role;

DROP FUNCTION IF EXISTS refund_with_dest_policy(uuid, integer, numeric, text, text);

CREATE FUNCTION refund_with_dest_policy(
  p_key_id      UUID,
  p_chain_id    INT,
  p_amount_usd  NUMERIC,
  p_owner_ref   TEXT,
  p_destination TEXT
) RETURNS void AS $$
DECLARE
  v_row          a2a_agent_keys%ROWTYPE;
  v_chain_key    TEXT;
  v_current_bal  NUMERIC;
  v_new_bal      NUMERIC;
  v_new_daily    NUMERIC;
BEGIN
  SELECT * INTO v_row
    FROM a2a_agent_keys
    WHERE id = p_key_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'KEY_NOT_FOUND: key_id % does not exist', p_key_id;
  END IF;

  IF v_row.owner_ref IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key % not owned by caller', p_key_id;
  END IF;

  IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
    RETURN;
  END IF;

  v_chain_key   := p_chain_id::TEXT;
  v_current_bal := COALESCE((v_row.budget ->> v_chain_key)::NUMERIC, 0);
  v_new_bal     := v_current_bal + p_amount_usd;
  v_new_daily   := GREATEST(v_row.daily_spent_usd - p_amount_usd, 0);

  UPDATE a2a_agent_keys
  SET
    budget          = jsonb_set(budget, ARRAY[v_chain_key], to_jsonb(v_new_bal::TEXT)),
    daily_spent_usd = v_new_daily,
    last_used_at    = NOW()
  WHERE id = p_key_id;

  IF p_destination IS NOT NULL AND p_destination <> '' AND EXISTS (
    SELECT 1 FROM a2a_key_spend_policies
      WHERE key_id = p_key_id AND destination = p_destination
  ) THEN
    INSERT INTO a2a_key_dest_spend_ledger (key_id, owner_ref, destination, amount_usd)
    VALUES (p_key_id, p_owner_ref, p_destination, -p_amount_usd);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.refund_with_dest_policy(uuid, integer, numeric, text, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.refund_with_dest_policy(uuid, integer, numeric, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_with_dest_policy(uuid, integer, numeric, text, text)
  TO service_role;
