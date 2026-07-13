-- ============================================================
-- Migration: 20260712000000_wkh189_arb_hold_override
-- WKH-189: habilita el override humano admin-gated de intents en 'arb_hold'.
-- Aditiva sobre WKH-139 v2. NO toca record_settle_outcome/finalize_payment_intent
-- (CD-6), ni charge/compose/orchestrate. Cambios:
--   1. close_payment_intent_for_arbitration: ensancha SOLO el predicado del
--      status-gate de la rama que transiciona a arb_closing:
--      'disputed' -> IN ('disputed','arb_hold'). Toda la logica de dinero
--      (clamp [0,deposit], persistencia en consumed_usd, rama recovery
--      'arb_closing') queda BYTE-IDENTICA (patron Option B).
--   2. a2a_arbitrations.method CHECK += 'admin_override'.
--   3. a2a_arbitrations += resolved_by / resolved_at / resolution_note (nullable).
-- ============================================================

BEGIN;

-- 1. Columnas de auditoria humana (additive, nullable)
ALTER TABLE a2a_arbitrations ADD COLUMN IF NOT EXISTS resolved_by      TEXT;
ALTER TABLE a2a_arbitrations ADD COLUMN IF NOT EXISTS resolved_at      TIMESTAMPTZ;
ALTER TABLE a2a_arbitrations ADD COLUMN IF NOT EXISTS resolution_note  TEXT;

-- 2. Ensanchar CHECK a2a_arbitrations.method (+admin_override)
ALTER TABLE a2a_arbitrations DROP CONSTRAINT IF EXISTS a2a_arbitrations_method_check;
ALTER TABLE a2a_arbitrations ADD CONSTRAINT a2a_arbitrations_method_check
  CHECK (method IN ('rules','llm','hold','admin_override'));

-- 3. Ensanchar close_payment_intent_for_arbitration (Option B)
--    Cuerpo VERBATIM de 20260704100000_wkh139_arbiter.sql, cambiando UNA linea:
--    'IF v_status = ''disputed''' -> 'IF v_status IN (''disputed'',''arb_hold'')'.
--    NINGUNA rama de dinero cambia. Re-declara search_path/REVOKE/GRANT.
CREATE OR REPLACE FUNCTION close_payment_intent_for_arbitration(
  p_intent_id  UUID,
  p_owner_ref  TEXT,
  p_arb_amount NUMERIC
) RETURNS TABLE(
  final_amount   NUMERIC,
  prev_status    TEXT,
  intent_type    TEXT,
  key_id         UUID,
  chain_id       INT,
  pay_to         TEXT,
  authorized_usd NUMERIC,
  consumed_usd   NUMERIC,
  settle_tx_hash TEXT,
  settle_outcome TEXT
) AS $$
DECLARE
  v_owner    TEXT;
  v_status   TEXT;
  v_type     TEXT;
  v_key      UUID;
  v_chain    INT;
  v_payto    TEXT;
  v_auth     NUMERIC;
  v_consumed NUMERIC;
  v_tx       TEXT;
  v_outcome  TEXT;
  v_final    NUMERIC;
  v_arb      NUMERIC;
BEGIN
  SELECT pi.owner_ref, pi.status, pi.intent_type, pi.key_id, pi.chain_id,
         pi.pay_to, pi.authorized_usd, pi.consumed_usd, pi.settle_tx_hash,
         pi.settle_outcome
    INTO v_owner, v_status, v_type, v_key, v_chain,
         v_payto, v_auth, v_consumed, v_tx, v_outcome
    FROM a2a_payment_intents pi
    WHERE pi.id = p_intent_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENT_NOT_FOUND: %', p_intent_id;
  END IF;
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: intent % not owned by caller', p_intent_id;
  END IF;

  -- Clamp: NUNCA settlea > deposit ni < 0 ("no crear plata"). BYTE-IDENTICO.
  v_arb := GREATEST(0, LEAST(v_auth, COALESCE(p_arb_amount, 0)));

  -- WKH-189: predicado ensanchado. arb_hold entra por la MISMA rama que disputed
  -- (transicion a arb_closing persistiendo el monto forzado). El resto verbatim.
  IF v_status IN ('disputed','arb_hold') THEN
    v_final    := v_arb;
    v_consumed := v_arb;
    UPDATE a2a_payment_intents
      SET status = 'arb_closing', consumed_usd = v_arb
      WHERE id = p_intent_id;
  ELSIF v_status = 'arb_closing' THEN
    -- Recovery: NO re-transiciona, NO re-clampa. Lee el monto persistido.
    v_final := v_consumed;
  ELSE
    RAISE EXCEPTION 'INTENT_NOT_OPEN: intent % is %', p_intent_id, v_status;
  END IF;

  final_amount   := v_final;
  prev_status    := v_status;
  intent_type    := v_type;
  key_id         := v_key;
  chain_id       := v_chain;
  pay_to         := v_payto;
  authorized_usd := v_auth;
  consumed_usd   := v_consumed;
  settle_tx_hash := v_tx;
  settle_outcome := v_outcome;
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.close_payment_intent_for_arbitration(uuid, text, numeric)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.close_payment_intent_for_arbitration(uuid, text, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_payment_intent_for_arbitration(uuid, text, numeric)
  TO service_role;

COMMIT;
