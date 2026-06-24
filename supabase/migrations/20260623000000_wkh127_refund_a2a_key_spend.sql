-- ============================================================
-- Migration: 20260623000000_wkh127_refund_a2a_key_spend
-- WKH-127 (AC-5/AC-6/AC-7, CD-3/CD-4): credit-back atómico para reembolsar el
-- débito step-0 de /orchestrate cuando el pipeline falla. Espejo INVERSO de
-- increment_a2a_key_spend (20260609000000): FOR UPDATE + Ownership Guard, pero
-- acredita budget y revierte daily_spent (clamp a 0). Aditiva: el down dropea.
-- ============================================================

CREATE OR REPLACE FUNCTION refund_a2a_key_spend(
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
  -- CD-3: lock atómico (mismo estilo que increment_a2a_key_spend).
  SELECT * INTO v_row
    FROM a2a_agent_keys
    WHERE id = p_key_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'KEY_NOT_FOUND: key_id % does not exist', p_key_id;
  END IF;

  -- CD-4: Ownership Guard DB-level (defensa en profundidad; service usa SERVICE_ROLE).
  IF v_row.owner_ref IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key % not owned by caller', p_key_id;
  END IF;

  -- Un refund nunca es negativo ni cero. Defensivo: no-op si <= 0.
  IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
    RETURN;
  END IF;

  -- Credit budget for the chain (inverso del débito de increment).
  v_chain_key   := p_chain_id::TEXT;
  v_current_bal := COALESCE((v_row.budget ->> v_chain_key)::NUMERIC, 0);
  v_new_bal     := v_current_bal + p_amount_usd;

  -- AC-7 / CD-14: revertir el incremento del daily_spent, clamp a 0 (no crear "deuda").
  v_new_daily := GREATEST(v_row.daily_spent_usd - p_amount_usd, 0);

  UPDATE a2a_agent_keys
  SET
    budget          = jsonb_set(budget, ARRAY[v_chain_key], to_jsonb(v_new_bal::TEXT)),
    daily_spent_usd = v_new_daily,
    last_used_at    = NOW()
  WHERE id = p_key_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- CD-13: Hardening (consistente con los RPCs hermanos, 20260609000000:95-101).
ALTER FUNCTION public.refund_a2a_key_spend(uuid, integer, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.refund_a2a_key_spend(uuid, integer, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_a2a_key_spend(uuid, integer, numeric, text)
  TO service_role;
