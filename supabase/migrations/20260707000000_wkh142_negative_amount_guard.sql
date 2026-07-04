-- ============================================================
-- Migration: 20260707000000_wkh142_negative_amount_guard
-- WKH-142: guard de importe negativo en el money-path (defensa final).
-- Proyecto: wasiai-a2a
--
-- WKH-134 dejó abierta la defensa contra importes negativos en el punto de
-- débito. Un p_amount_usd negativo que llegue al RPC SUMA al budget prepago
-- (new_bal = current - (-X)) y neutraliza el check de fondos + el daily-limit.
-- Esta migración cierra 3 huecos en UNA transacción:
--
--   1. DB choke-point: guard NULL / < 0 / NaN dentro de increment_a2a_key_spend
--      (los 4 RPC de débito la atraviesan vía PERFORM → un IF cierra las 4
--      rutas, sin duplicar). CD-7: el prefijo del guard aparece UNA sola vez.
--   2. Clamp de datos preexistentes (price_usdc < 0 OR NaN → 0) ANTES del constraint.
--   3. CHECK (price_usdc >= 0 AND <> NaN) en a2a_agents (simetría con el guard RPC).
--
-- CD-1: la firma de increment_a2a_key_spend NO cambia (uuid, integer, numeric,
--       text). Solo se inserta el IF. NO se hace DROP (la aridad no cambia).
-- CD-2: refund_* NO se tocan. Los 3 RPC hermanos (debit_with_dest_policy /
--       debit_session_and_parent / debit_delegation_and_parent) NO se redefinen.
-- CD-4: el hardening (search_path + REVOKE + GRANT) se re-aplica íntegro.
-- CD-9: p_amount_usd = 0 sigue VÁLIDO (guard estrictamente < 0).
-- ============================================================
BEGIN;

-- ------------------------------------------------------------
-- (1) increment_a2a_key_spend — CREATE OR REPLACE con el guard nuevo.
-- Cuerpo COPIA LITERAL de 20260609000000_wkh_sec02b_owner_ref_rpc.sql:20-93
-- con UN SOLO bloque insertado entre el ownership guard y el is_active check.
-- ------------------------------------------------------------
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

  -- WKH-142 (AC-1): defensa en profundidad. Rechaza NULL / < 0 / NaN ANTES de
  -- tocar budget/daily_spent. Choke-point único: los 4 RPC de débito heredan el
  -- guard vía PERFORM (AC-2). CD-9: 0 sigue siendo válido (estrictamente < 0).
  IF p_amount_usd IS NULL OR p_amount_usd < 0 OR p_amount_usd = 'NaN'::numeric THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: p_amount_usd % must be a non-negative number', p_amount_usd;
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

-- CD-4: Hardening re-aplicado (copia literal de sec02b L95-101).
ALTER FUNCTION public.increment_a2a_key_spend(uuid, integer, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.increment_a2a_key_spend(uuid, integer, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_a2a_key_spend(uuid, integer, numeric, text)
  TO service_role;

-- ------------------------------------------------------------
-- (2) Clamp de datos preexistentes ANTES del constraint (CD-3, misma tx).
-- Incluye NaN: en Postgres 'NaN' >= 0 es true, así que WHERE price_usdc < 0 NO lo
-- limpia. Se clampea explícitamente para que el constraint no falle sobre una fila
-- NaN preexistente.
-- ------------------------------------------------------------
UPDATE public.a2a_agents SET price_usdc = 0 WHERE price_usdc < 0 OR price_usdc = 'NaN'::numeric;

-- ------------------------------------------------------------
-- (3) Constraint no-negativo (después del clamp, misma tx). Rechaza también NaN
-- (en Postgres 'NaN' >= 0 es true) → simetría con el guard del RPC.
-- ------------------------------------------------------------
ALTER TABLE public.a2a_agents
  ADD CONSTRAINT a2a_agents_price_usdc_nonneg CHECK (price_usdc >= 0 AND price_usdc <> 'NaN'::numeric);

COMMIT;
