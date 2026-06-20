-- WKH-125 down-migration.
-- Restaura debit_session_and_parent a su firma de 5 params (pre-WKH-125) y elimina
-- el RPC dest-aware + las 2 tablas.

-- 1. Drop de la versión 6-params de debit_session_and_parent.
DROP FUNCTION IF EXISTS debit_session_and_parent(uuid, text, uuid, integer, numeric, text);

-- 2. Restaurar debit_session_and_parent original (5 params, PERFORM increment).
CREATE OR REPLACE FUNCTION debit_session_and_parent(
  p_session_id UUID,
  p_owner_ref  TEXT,
  p_key_id     UUID,
  p_chain_id   INT,
  p_amount_usd NUMERIC
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
  PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd);
  UPDATE a2a_key_sessions SET spent_usd = v_new_spent WHERE id = p_session_id;
  RETURN v_new_spent;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric)
  TO service_role;

-- 3. Drop del RPC dest-aware y las 2 tablas.
DROP FUNCTION IF EXISTS debit_with_dest_policy(uuid, integer, numeric, text, text);
DROP TABLE IF EXISTS a2a_key_dest_spend_ledger;
DROP TABLE IF EXISTS a2a_key_spend_policies;
