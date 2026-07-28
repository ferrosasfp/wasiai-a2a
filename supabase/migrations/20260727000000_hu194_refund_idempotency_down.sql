-- ============================================================
-- DOWN: 20260727000000_hu194_refund_idempotency
--
-- Restaura las 4 RPC de refund a la firma SIN `p_idem_key` (tal como quedaban
-- tras 20260625000000 y 20260701000000) y saca las piezas nuevas.
--
-- ORDEN IMPORTANTE: primero las funciones (dejan de referenciar
-- `refund_idem_claim`), después el claim, después la columna/índice del outbox y
-- por último la tabla de marcadores.
--
-- OJO (pérdida de dedup, no de dinero): dropear `a2a_refund_applications`
-- borra el historial de refunds aplicados. Si hay refunds en vuelo cuando se
-- revierte, se vuelve al comportamiento anterior (posible doble crédito por
-- respuesta perdida). Antes de correr este down conviene volcar la tabla:
--   \copy a2a_refund_applications TO 'refund_applications.csv' CSV HEADER
-- ============================================================

-- ── 1. refund_session_and_parent → firma sin p_idem_key ──
DROP FUNCTION IF EXISTS refund_session_and_parent(uuid, text, uuid, integer, numeric, text, text);

CREATE OR REPLACE FUNCTION refund_session_and_parent(
  p_session_id  UUID,
  p_owner_ref   TEXT,
  p_key_id      UUID,
  p_chain_id    INT,
  p_amount_usd  NUMERIC,
  p_destination TEXT DEFAULT NULL
) RETURNS INT AS $$
DECLARE
  v_owner     TEXT;
  v_key_id    UUID;
  v_spent     NUMERIC;
  v_new_spent NUMERIC;
  v_rows      INT := 0;
BEGIN
  SELECT owner_ref, key_id, spent_usd
    INTO v_owner, v_key_id, v_spent
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

  IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
    RETURN 0;
  END IF;

  IF p_destination IS NOT NULL AND p_destination <> '' THEN
    v_rows := refund_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination);
  ELSE
    v_rows := refund_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref);
  END IF;

  v_new_spent := GREATEST(v_spent - p_amount_usd, 0);
  UPDATE a2a_key_sessions SET spent_usd = v_new_spent WHERE id = p_session_id;

  RETURN v_rows;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.refund_session_and_parent(uuid, text, uuid, integer, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.refund_session_and_parent(uuid, text, uuid, integer, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_session_and_parent(uuid, text, uuid, integer, numeric, text)
  TO service_role;

-- ── 2. refund_delegation_and_parent → firma sin p_idem_key ──
DROP FUNCTION IF EXISTS refund_delegation_and_parent(uuid, text, uuid, integer, numeric, text, text);

CREATE OR REPLACE FUNCTION refund_delegation_and_parent(
  p_delegation_id UUID,
  p_owner_ref     TEXT,
  p_key_id        UUID,
  p_chain_id      INT,
  p_amount_usd    NUMERIC,
  p_destination   TEXT DEFAULT NULL
) RETURNS INT AS $$
DECLARE
  v_owner     TEXT;
  v_key_id    UUID;
  v_total     NUMERIC;
  v_new_total NUMERIC;
  v_rows      INT := 0;
BEGIN
  SELECT owner_ref, key_id, total_spent
    INTO v_owner, v_key_id, v_total
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

  IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
    RETURN 0;
  END IF;

  IF p_destination IS NOT NULL AND p_destination <> '' THEN
    v_rows := refund_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination);
  ELSE
    v_rows := refund_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref);
  END IF;

  v_new_total := GREATEST(v_total - p_amount_usd, 0);
  UPDATE a2a_delegations SET total_spent = v_new_total WHERE id = p_delegation_id;

  RETURN v_rows;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.refund_delegation_and_parent(uuid, text, uuid, integer, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.refund_delegation_and_parent(uuid, text, uuid, integer, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_delegation_and_parent(uuid, text, uuid, integer, numeric, text)
  TO service_role;

-- ── 3. refund_with_dest_policy → firma sin p_idem_key ──
DROP FUNCTION IF EXISTS refund_with_dest_policy(uuid, integer, numeric, text, text, text);

CREATE OR REPLACE FUNCTION refund_with_dest_policy(
  p_key_id      UUID,
  p_chain_id    INT,
  p_amount_usd  NUMERIC,
  p_owner_ref   TEXT,
  p_destination TEXT
) RETURNS INT AS $$
DECLARE
  v_row          a2a_agent_keys%ROWTYPE;
  v_chain_key    TEXT;
  v_current_bal  NUMERIC;
  v_new_bal      NUMERIC;
  v_new_daily    NUMERIC;
  v_rows         INT := 0;
  v_ledger_rows  INT := 0;
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
    RETURN 0;
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

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF p_destination IS NOT NULL AND p_destination <> '' AND EXISTS (
    SELECT 1 FROM a2a_key_spend_policies
      WHERE key_id = p_key_id AND destination = p_destination
  ) THEN
    INSERT INTO a2a_key_dest_spend_ledger (key_id, owner_ref, destination, amount_usd)
    VALUES (p_key_id, p_owner_ref, p_destination, -p_amount_usd);
    GET DIAGNOSTICS v_ledger_rows = ROW_COUNT;
    RETURN v_ledger_rows;
  END IF;

  RETURN v_rows;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.refund_with_dest_policy(uuid, integer, numeric, text, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.refund_with_dest_policy(uuid, integer, numeric, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_with_dest_policy(uuid, integer, numeric, text, text)
  TO service_role;

-- ── 4. refund_a2a_key_spend → firma sin p_idem_key ──
DROP FUNCTION IF EXISTS refund_a2a_key_spend(uuid, integer, numeric, text, text);

CREATE OR REPLACE FUNCTION refund_a2a_key_spend(
  p_key_id     UUID,
  p_chain_id   INT,
  p_amount_usd NUMERIC,
  p_owner_ref  TEXT
) RETURNS INT AS $$
DECLARE
  v_row          a2a_agent_keys%ROWTYPE;
  v_chain_key    TEXT;
  v_current_bal  NUMERIC;
  v_new_bal      NUMERIC;
  v_new_daily    NUMERIC;
  v_rows         INT;
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
    RETURN 0;
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

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.refund_a2a_key_spend(uuid, integer, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.refund_a2a_key_spend(uuid, integer, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_a2a_key_spend(uuid, integer, numeric, text)
  TO service_role;

-- ── 5. claim + outbox + tabla de marcadores ──
DROP FUNCTION IF EXISTS refund_idem_claim(text, uuid, integer, numeric, text, text);

DROP INDEX IF EXISTS uq_refund_outbox_idem_key;
ALTER TABLE a2a_refund_outbox DROP COLUMN IF EXISTS idem_key;

DROP TABLE IF EXISTS a2a_refund_applications;
