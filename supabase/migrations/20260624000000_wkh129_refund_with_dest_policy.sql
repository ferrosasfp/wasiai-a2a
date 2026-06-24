-- ============================================================
-- Migration: 20260624000000_wkh129_refund_with_dest_policy
-- WKH-129 (AC-1/AC-2/AC-3/AC-4/AC-5): refund completo del dest-cap. Espeja
-- refund_a2a_key_spend (20260623000000): FOR UPDATE + Ownership Guard, acredita
-- budget + revierte daily_spent (clamp a 0), Y ADEMÁS inserta una fila
-- compensatoria NEGATIVA en a2a_key_dest_spend_ledger (DT-1, append-only) para
-- devolver el headroom del cap por destino consumido por el débito fallido.
-- Aditiva: función NUEVA (sin DROP de previas — CD-3). El down dropea por firma.
-- ============================================================

CREATE OR REPLACE FUNCTION refund_with_dest_policy(
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
  -- CD-1: lock atómico de la key (mismo estilo que refund_a2a_key_spend).
  --       Serializa contra débitos/refunds concurrentes sobre la misma key.
  SELECT * INTO v_row
    FROM a2a_agent_keys
    WHERE id = p_key_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'KEY_NOT_FOUND: key_id % does not exist', p_key_id;
  END IF;

  -- CD-2: Ownership Guard DB-level (defensa en profundidad; service usa SERVICE_ROLE
  --       que bypassea RLS). BAJO LOCK (TOCTOU-safe).
  IF v_row.owner_ref IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key % not owned by caller', p_key_id;
  END IF;

  -- CD-5/AC-5: un refund nunca es negativo ni cero. No-op defensivo si <= 0 o NULL.
  --       (espeja refund_a2a_key_spend L38-40). NO inserta fila en el ledger.
  IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
    RETURN;
  END IF;

  -- AC-2(a): credit budget de la chain (inverso del débito de debit_with_dest_policy).
  v_chain_key   := p_chain_id::TEXT;
  v_current_bal := COALESCE((v_row.budget ->> v_chain_key)::NUMERIC, 0);
  v_new_bal     := v_current_bal + p_amount_usd;

  -- AC-2(b): revertir el incremento del daily_spent, clamp a 0 (no crear "deuda").
  v_new_daily := GREATEST(v_row.daily_spent_usd - p_amount_usd, 0);

  UPDATE a2a_agent_keys
  SET
    budget          = jsonb_set(budget, ARRAY[v_chain_key], to_jsonb(v_new_bal::TEXT)),
    daily_spent_usd = v_new_daily,
    last_used_at    = NOW()
  WHERE id = p_key_id;

  -- AC-1/AC-2(c)/CD-4: fila compensatoria NEGATIVA en el ledger del dest-cap.
  --       Mismo (key_id, owner_ref, destination) que el débito original; amount
  --       estrictamente -p_amount_usd (PROHIBIDO positivo). debited_at = now()
  --       (default) → cae dentro de la ventana rolling del débito (DT-3 / AC-4).
  --       El SUM del cap (COALESCE(SUM(amount_usd),0), sin filtro de signo)
  --       descuenta este -X → headroom restaurado. TODO en la misma tx (CD-1).
  --
  -- WKH-129 fix-pack (AR MNR-1): SIMETRÍA con debit_with_dest_policy, que SOLO
  -- inserta el ledger `IF v_has_policy` (20260606000000:96,126-128). El refund
  -- debe insertar la reversa SOLO si existe política para (key, destination); de
  -- lo contrario el débito no insertó nada y una fila -X huérfana debilitaría una
  -- política FUTURA sobre ese destino. Guard bajo el mismo lock (FOR UPDATE arriba).
  IF p_destination IS NOT NULL AND p_destination <> '' AND EXISTS (
    SELECT 1 FROM a2a_key_spend_policies
      WHERE key_id = p_key_id AND destination = p_destination
  ) THEN
    INSERT INTO a2a_key_dest_spend_ledger (key_id, owner_ref, destination, amount_usd)
    VALUES (p_key_id, p_owner_ref, p_destination, -p_amount_usd);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- DT-4: Hardening (consistente con refund_a2a_key_spend / debit_with_dest_policy).
ALTER FUNCTION public.refund_with_dest_policy(uuid, integer, numeric, text, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.refund_with_dest_policy(uuid, integer, numeric, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_with_dest_policy(uuid, integer, numeric, text, text)
  TO service_role;
