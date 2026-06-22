-- ============================================================
-- Migration: 20260609000000_wkh_sec02b_owner_ref_rpc
-- WKH-SEC-02b: Ownership Guard DB-level dentro de increment_a2a_key_spend.
-- La RPC pasa de 3 a 4 params (+ p_owner_ref TEXT) y valida que el owner_ref
-- pasado coincida con el registrado en a2a_agent_keys (defensa en profundidad;
-- la RPC ya está REVOKED de anon/authenticated). Los 3 RPCs que la invocan vía
-- PERFORM ya reciben p_owner_ref como parámetro propio → solo se agrega al PERFORM.
--
-- BLQ-MED-1 (recurrente ≥3 HUs, ref 114/auto-blindaje#75-95): CREATE OR REPLACE
-- con +1 param crea una SOBRECARGA, no reemplaza. DROP de la firma de 3 params
-- ANTES del CREATE de 4 → una sola función. (CD-1)
-- ============================================================

-- CD-1: DROP de la firma de 3 params ANTES del CREATE de 4.
DROP FUNCTION IF EXISTS increment_a2a_key_spend(uuid, integer, numeric);

-- Firma extendida (4 params). CD-5: cuerpo COPIADO LITERAL de
-- 20260406000000_a2a_agent_keys.sql:60-121; SOLO se agrega p_owner_ref y el
-- bloque del guard entre el IF NOT FOUND y el check de is_active.
CREATE OR REPLACE FUNCTION increment_a2a_key_spend(
  p_key_id     UUID,
  p_chain_id   INT,
  p_amount_usd NUMERIC,
  p_owner_ref  TEXT          -- NUEVO (WKH-SEC-02b): Ownership Guard DB-level
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

  -- NUEVO (WKH-SEC-02b, AC-1): Ownership Guard DB-level. La fila ya está lockeada
  -- (FOR UPDATE). El service usa SERVICE_ROLE/bypass RLS → este check es la única
  -- defensa Postgres-level para la ruta directa.
  IF v_row.owner_ref IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key % not owned by caller', p_key_id;
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

-- CD-6: Hardening de la NUEVA firma de 4 params (consistente con los RPCs hermanos).
ALTER FUNCTION public.increment_a2a_key_spend(uuid, integer, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.increment_a2a_key_spend(uuid, integer, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_a2a_key_spend(uuid, integer, numeric, text)
  TO service_role;

-- ============================================================
-- Caller #4: debit_with_dest_policy (firma INTACTA, 5 params). CREATE OR REPLACE
-- SIN DROP (la aridad no cambia). Solo se agrega p_owner_ref al PERFORM (L123 orig).
-- CD-10: el cuerpo es copia literal de 20260606000000:55-131 con ese único cambio.
-- ============================================================
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

  -- WKH-SEC-02b: se agrega p_owner_ref al PERFORM (antes era 3-arg).
  PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref);

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

-- ============================================================
-- Caller #3: debit_session_and_parent (6 params, dispatch 125 INTACTO).
-- CREATE OR REPLACE SIN DROP (aridad no cambia). CD-10: SOLO el PERFORM del branch
-- ELSE pasa a 4-arg; el branch IF (debit_with_dest_policy) se preserva intacto.
-- Cuerpo: copia literal de 20260606000000:159-224 con ese único cambio.
-- ============================================================
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

  -- CD-10: dispatch 125 PRESERVADO. Solo el branch ELSE pasa p_owner_ref al PERFORM.
  IF p_destination IS NOT NULL AND p_destination <> '' THEN
    PERFORM debit_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination);
  ELSE
    PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref);
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

-- ============================================================
-- Caller #2: debit_delegation_and_parent (6 params post-125b, dispatch INTACTO).
-- CREATE OR REPLACE SIN DROP (aridad no cambia). CD-10: parte de la versión 6-param
-- de 125b; SOLO el PERFORM del branch ELSE pasa a 4-arg; el branch IF
-- (debit_with_dest_policy) se PRESERVA. Cuerpo: copia literal de 20260608000000:19-85.
-- ============================================================
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

  -- CD-10: dispatch 125b PRESERVADO. Solo el branch ELSE pasa p_owner_ref al PERFORM.
  IF p_destination IS NOT NULL AND p_destination <> '' THEN
    PERFORM debit_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination);
  ELSE
    PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref);
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
