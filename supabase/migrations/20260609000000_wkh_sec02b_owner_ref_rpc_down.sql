-- WKH-SEC-02b down-migration. Restaura:
--  - increment_a2a_key_spend a su firma de 3 params (cuerpo literal de
--    20260406000000:56-121, SIN hardening — la original no lo tenía, CD-6).
--  - los 3 RPCs dependientes a su estado post-125b (PERFORM 3-arg en el branch ELSE,
--    dispatch a debit_with_dest_policy preservado).
-- Rollback atómico reversible (CD-2/AC-4).

-- 1. DROP de la firma 4-param + CREATE de la 3-param original (literal).
DROP FUNCTION IF EXISTS increment_a2a_key_spend(uuid, integer, numeric, text);

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

  IF v_row.daily_reset_at < NOW() THEN
    v_row.daily_spent_usd := 0;
    WHILE v_row.daily_reset_at < NOW() LOOP
      v_row.daily_reset_at := v_row.daily_reset_at + INTERVAL '24 hours';
    END LOOP;
  END IF;

  v_daily_spent := v_row.daily_spent_usd;
  v_daily_limit := v_row.daily_limit_usd;

  IF v_daily_limit IS NOT NULL AND (v_daily_spent + p_amount_usd) > v_daily_limit THEN
    RAISE EXCEPTION 'DAILY_LIMIT: daily spend would be % + % = %, limit is %',
      v_daily_spent, p_amount_usd, v_daily_spent + p_amount_usd, v_daily_limit;
  END IF;

  v_chain_key := p_chain_id::TEXT;
  v_current_bal := COALESCE((v_row.budget ->> v_chain_key)::NUMERIC, 0);

  IF v_current_bal < p_amount_usd THEN
    RAISE EXCEPTION 'INSUFFICIENT_BUDGET: chain % balance is %, requested %',
      v_chain_key, v_current_bal, p_amount_usd;
  END IF;

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
-- (sin hardening: la firma original de 3 params nunca lo tuvo — CD-6.)

-- 2. debit_with_dest_policy: restaurar PERFORM 3-arg (estado post-125).
CREATE OR REPLACE FUNCTION debit_with_dest_policy(
  p_key_id      UUID,
  p_chain_id    INT,
  p_amount_usd  NUMERIC,
  p_owner_ref   TEXT,
  p_destination TEXT
) RETURNS void AS $$
DECLARE
  v_key_owner   TEXT;
  v_pol_max     NUMERIC;
  v_pol_wtype   TEXT;
  v_pol_wsecs   INT;
  v_accum       NUMERIC;
  v_has_policy  BOOLEAN := false;
BEGIN
  SELECT owner_ref INTO v_key_owner
    FROM a2a_agent_keys
    WHERE id = p_key_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KEY_NOT_FOUND: key_id % does not exist', p_key_id;
  END IF;

  IF v_key_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key % not owned by caller', p_key_id;
  END IF;

  IF p_destination IS NOT NULL AND p_destination <> '' THEN
    SELECT max_usd, window_type, window_secs
      INTO v_pol_max, v_pol_wtype, v_pol_wsecs
      FROM a2a_key_spend_policies
      WHERE key_id = p_key_id AND destination = p_destination
      FOR UPDATE;
    IF FOUND THEN
      v_has_policy := true;
    END IF;
  END IF;

  IF v_has_policy THEN
    IF v_pol_wtype = 'rolling' THEN
      SELECT COALESCE(SUM(amount_usd), 0) INTO v_accum
        FROM a2a_key_dest_spend_ledger
        WHERE key_id = p_key_id
          AND destination = p_destination
          AND debited_at >= now() - (v_pol_wsecs * interval '1 second');
    ELSE
      SELECT COALESCE(SUM(amount_usd), 0) INTO v_accum
        FROM a2a_key_dest_spend_ledger
        WHERE key_id = p_key_id
          AND destination = p_destination;
    END IF;

    IF (v_accum + p_amount_usd) > v_pol_max THEN
      RAISE EXCEPTION 'DEST_CAP_EXCEEDED: dest % accum % + % > cap %',
        p_destination, v_accum, p_amount_usd, v_pol_max;
    END IF;
  END IF;

  PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd);

  IF v_has_policy THEN
    INSERT INTO a2a_key_dest_spend_ledger (key_id, owner_ref, destination, amount_usd)
    VALUES (p_key_id, p_owner_ref, p_destination, p_amount_usd);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.debit_with_dest_policy(uuid, integer, numeric, text, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.debit_with_dest_policy(uuid, integer, numeric, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_with_dest_policy(uuid, integer, numeric, text, text)
  TO service_role;

-- 3. debit_session_and_parent: restaurar PERFORM 3-arg en el branch ELSE (post-125).
CREATE OR REPLACE FUNCTION debit_session_and_parent(
  p_session_id  UUID,
  p_owner_ref   TEXT,
  p_key_id      UUID,
  p_chain_id    INT,
  p_amount_usd  NUMERIC,
  p_destination TEXT DEFAULT NULL
) RETURNS NUMERIC AS $$
DECLARE
  v_owner     TEXT;
  v_key_id    UUID;
  v_revoked   TIMESTAMPTZ;
  v_expires   TIMESTAMPTZ;
  v_spent     NUMERIC;
  v_max       NUMERIC;
  v_new_spent NUMERIC;
BEGIN
  SELECT owner_ref, key_id, revoked_at, expires_at, spent_usd, max_budget_usd
    INTO v_owner, v_key_id, v_revoked, v_expires, v_spent, v_max
    FROM a2a_key_sessions
    WHERE id = p_session_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SESSION_NOT_FOUND: %', p_session_id;
  END IF;

  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: session % not owned by caller', p_session_id;
  END IF;
  IF v_key_id IS DISTINCT FROM p_key_id THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: session % not bound to key %', p_session_id, p_key_id;
  END IF;

  IF v_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'SESSION_REVOKED: %', p_session_id;
  END IF;
  IF NOW() >= v_expires THEN
    RAISE EXCEPTION 'SESSION_EXPIRED: %', p_session_id;
  END IF;

  v_new_spent := v_spent + p_amount_usd;
  IF v_new_spent > v_max THEN
    RAISE EXCEPTION 'SESSION_BUDGET_EXHAUSTED: % + % > %', v_spent, p_amount_usd, v_max;
  END IF;

  IF p_destination IS NOT NULL AND p_destination <> '' THEN
    PERFORM debit_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination);
  ELSE
    PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd);
  END IF;

  UPDATE a2a_key_sessions SET spent_usd = v_new_spent WHERE id = p_session_id;

  RETURN v_new_spent;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric, text)
  TO service_role;

-- 4. debit_delegation_and_parent: restaurar PERFORM 3-arg en el branch ELSE (post-125b).
CREATE OR REPLACE FUNCTION debit_delegation_and_parent(
  p_delegation_id UUID,
  p_owner_ref     TEXT,
  p_key_id        UUID,
  p_chain_id      INT,
  p_amount_usd    NUMERIC,
  p_destination   TEXT DEFAULT NULL
) RETURNS NUMERIC AS $$
DECLARE
  v_owner     TEXT;
  v_key_id    UUID;
  v_revoked   TIMESTAMPTZ;
  v_expires   TIMESTAMPTZ;
  v_total     NUMERIC;
  v_max_total NUMERIC;
  v_new_total NUMERIC;
BEGIN
  SELECT owner_ref, key_id, revoked_at, expires_at, total_spent,
         (policy->>'max_total_amount')::NUMERIC
    INTO v_owner, v_key_id, v_revoked, v_expires, v_total, v_max_total
    FROM a2a_delegations
    WHERE id = p_delegation_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DELEGATION_NOT_FOUND: %', p_delegation_id;
  END IF;

  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: delegation % not owned by caller', p_delegation_id;
  END IF;
  IF v_key_id IS DISTINCT FROM p_key_id THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: delegation % not bound to key %', p_delegation_id, p_key_id;
  END IF;

  IF v_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'DELEGATION_REVOKED: %', p_delegation_id;
  END IF;
  IF NOW() >= v_expires THEN
    RAISE EXCEPTION 'DELEGATION_EXPIRED: %', p_delegation_id;
  END IF;

  v_new_total := v_total + p_amount_usd;
  IF v_max_total IS NOT NULL AND v_new_total > v_max_total THEN
    RAISE EXCEPTION 'DELEGATION_TOTAL_LIMIT_EXCEEDED: % + % > %', v_total, p_amount_usd, v_max_total;
  END IF;

  IF p_destination IS NOT NULL AND p_destination <> '' THEN
    PERFORM debit_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination);
  ELSE
    PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd);
  END IF;

  UPDATE a2a_delegations SET total_spent = v_new_total WHERE id = p_delegation_id;

  RETURN v_new_total;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric, text)
  TO service_role;
