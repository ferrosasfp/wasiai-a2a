-- ============================================================
-- Down: 20260712000000_wkh189_arb_hold_override
-- Revierte SOLO los cambios de WKH-189. Restaura el predicado del RPC a
-- 'disputed' (cuerpo verbatim de WKH-139 v2), el CHECK method sin
-- 'admin_override', y dropea las 3 columnas de auditoria humana.
-- NOTA OPS: si existen filas con method='admin_override' o intents en
-- 'arb_hold' pendientes, resolverlos ANTES de aplicar este down (el
-- CHECK restaurado rechazaria las filas admin_override).
-- ============================================================

BEGIN;

-- 1. Restaurar close_payment_intent_for_arbitration al predicado 'disputed'.
CREATE OR REPLACE FUNCTION close_payment_intent_for_arbitration(
  p_intent_id  UUID,
  p_owner_ref  TEXT,
  p_arb_amount NUMERIC
) RETURNS TABLE(
  final_amount   NUMERIC, prev_status TEXT, intent_type TEXT, key_id UUID,
  chain_id INT, pay_to TEXT, authorized_usd NUMERIC, consumed_usd NUMERIC,
  settle_tx_hash TEXT, settle_outcome TEXT
) AS $$
DECLARE
  v_owner TEXT; v_status TEXT; v_type TEXT; v_key UUID; v_chain INT;
  v_payto TEXT; v_auth NUMERIC; v_consumed NUMERIC; v_tx TEXT; v_outcome TEXT;
  v_final NUMERIC; v_arb NUMERIC;
BEGIN
  SELECT pi.owner_ref, pi.status, pi.intent_type, pi.key_id, pi.chain_id,
         pi.pay_to, pi.authorized_usd, pi.consumed_usd, pi.settle_tx_hash,
         pi.settle_outcome
    INTO v_owner, v_status, v_type, v_key, v_chain,
         v_payto, v_auth, v_consumed, v_tx, v_outcome
    FROM a2a_payment_intents pi WHERE pi.id = p_intent_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INTENT_NOT_FOUND: %', p_intent_id; END IF;
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: intent % not owned by caller', p_intent_id;
  END IF;
  v_arb := GREATEST(0, LEAST(v_auth, COALESCE(p_arb_amount, 0)));
  IF v_status = 'disputed' THEN
    v_final := v_arb; v_consumed := v_arb;
    UPDATE a2a_payment_intents SET status = 'arb_closing', consumed_usd = v_arb
      WHERE id = p_intent_id;
  ELSIF v_status = 'arb_closing' THEN
    v_final := v_consumed;
  ELSE
    RAISE EXCEPTION 'INTENT_NOT_OPEN: intent % is %', p_intent_id, v_status;
  END IF;
  final_amount := v_final; prev_status := v_status; intent_type := v_type;
  key_id := v_key; chain_id := v_chain; pay_to := v_payto;
  authorized_usd := v_auth; consumed_usd := v_consumed;
  settle_tx_hash := v_tx; settle_outcome := v_outcome;
  RETURN NEXT; RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.close_payment_intent_for_arbitration(uuid, text, numeric)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.close_payment_intent_for_arbitration(uuid, text, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_payment_intent_for_arbitration(uuid, text, numeric)
  TO service_role;

-- 2. Restaurar CHECK method sin admin_override.
ALTER TABLE a2a_arbitrations DROP CONSTRAINT IF EXISTS a2a_arbitrations_method_check;
ALTER TABLE a2a_arbitrations ADD CONSTRAINT a2a_arbitrations_method_check
  CHECK (method IN ('rules','llm','hold'));

-- 3. Dropear columnas de auditoria humana.
ALTER TABLE a2a_arbitrations DROP COLUMN IF EXISTS resolution_note;
ALTER TABLE a2a_arbitrations DROP COLUMN IF EXISTS resolved_at;
ALTER TABLE a2a_arbitrations DROP COLUMN IF EXISTS resolved_by;

COMMIT;
