-- ============================================================
-- Migration: 20260625000000_wkh_audit_a2_refund_rows_affected
-- Auditoría 2026-06-24 — item A2 (hardening money/security).
--
-- PROBLEMA: el retry adaptativo de /compose (WKH-130) hace refund#1 y luego
-- re-debita asumiendo `refund1ok ⟹ budget revertido`. Pero las RPC de refund
-- devolvían `void`: el service no podía distinguir entre "revertí de verdad" y
-- "la RPC corrió pero afectó 0 filas" (p. ej. mismatch de destino → la fila
-- compensatoria del dest-cap NO se inserta). Riesgo: doble consumo de dest-cap.
--
-- FIX: ambas RPC de refund pasan de `RETURNS void` a `RETURNS INT` y devuelven
-- el número de filas afectadas (UPDATE de la key + INSERT compensatorio del
-- ledger). El service interpreta `0 ⟹ no se revirtió ⟹ NO re-debitar`.
--
-- INVARIANTES PRESERVADAS (NO se toca la lógica de montos):
--   - FOR UPDATE (lock atómico de la key) intacto.
--   - Ownership Guard DB-level intacto.
--   - GREATEST(..., 0) clamp del daily_spent intacto.
--   - Simetría del INSERT del ledger SOLO si existe política (WKH-129 AR MNR-1).
--   - Hardening (search_path + REVOKE/GRANT) re-aplicado para la nueva firma.
--
-- Aditiva vía CREATE OR REPLACE. El down restaura la versión `RETURNS void`.
-- NOTA: CREATE OR REPLACE FUNCTION no puede cambiar el tipo de retorno → se
-- hace DROP previo de la firma void exacta antes del CREATE de la firma INT.
-- ============================================================

-- ── refund_a2a_key_spend → RETURNS INT (filas afectadas) ──
DROP FUNCTION IF EXISTS refund_a2a_key_spend(uuid, integer, numeric, text);

CREATE FUNCTION refund_a2a_key_spend(
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

  -- Un refund nunca es negativo ni cero. Defensivo: no-op si <= 0 → 0 filas.
  IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
    RETURN 0;
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

  -- A2 (audit 2026-06-24): nº de filas revertidas. El service lo lee para
  -- distinguir reversión real (>=1) de un no-op (0) y NO re-debitar si fue 0.
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- CD-13: Hardening (consistente con los RPCs hermanos).
ALTER FUNCTION public.refund_a2a_key_spend(uuid, integer, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.refund_a2a_key_spend(uuid, integer, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_a2a_key_spend(uuid, integer, numeric, text)
  TO service_role;

-- ── refund_with_dest_policy → RETURNS INT (filas afectadas) ──
DROP FUNCTION IF EXISTS refund_with_dest_policy(uuid, integer, numeric, text, text);

CREATE FUNCTION refund_with_dest_policy(
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
  -- CD-1: lock atómico de la key (mismo estilo que refund_a2a_key_spend).
  SELECT * INTO v_row
    FROM a2a_agent_keys
    WHERE id = p_key_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'KEY_NOT_FOUND: key_id % does not exist', p_key_id;
  END IF;

  -- CD-2: Ownership Guard DB-level (defensa en profundidad). BAJO LOCK (TOCTOU-safe).
  IF v_row.owner_ref IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key % not owned by caller', p_key_id;
  END IF;

  -- CD-5/AC-5: un refund nunca es negativo ni cero. No-op defensivo → 0 filas.
  IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
    RETURN 0;
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

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- AC-1/AC-2(c)/CD-4: fila compensatoria NEGATIVA en el ledger del dest-cap.
  -- WKH-129 fix-pack (AR MNR-1): SIMETRÍA con debit_with_dest_policy — el INSERT
  -- ocurre SOLO si existe política para (key, destination). Guard bajo el mismo
  -- lock (FOR UPDATE arriba).
  --
  -- A2 (audit 2026-06-24): el dest-cap SOLO se revierte de verdad si esta fila
  -- compensatoria se inserta. Si el destino divergía del débito (no hay política
  -- para ese destino), el INSERT NO ocurre y el headroom del dest-cap NO se
  -- libera → el service debe tratarlo como "no revertido" y NO re-debitar.
  -- Por eso el retorno es el ROW_COUNT del INSERT del ledger (no el del UPDATE
  -- del budget): es el indicador fiel de la reversión del cap por destino.
  IF p_destination IS NOT NULL AND p_destination <> '' AND EXISTS (
    SELECT 1 FROM a2a_key_spend_policies
      WHERE key_id = p_key_id AND destination = p_destination
  ) THEN
    INSERT INTO a2a_key_dest_spend_ledger (key_id, owner_ref, destination, amount_usd)
    VALUES (p_key_id, p_owner_ref, p_destination, -p_amount_usd);
    GET DIAGNOSTICS v_ledger_rows = ROW_COUNT;
    RETURN v_ledger_rows;
  END IF;

  -- Sin política para el destino: el débito original tampoco insertó en el
  -- ledger (debit_with_dest_policy es simétrico), así que el budget SÍ se
  -- revirtió pero NO había cap por destino que liberar. Devolvemos el ROW_COUNT
  -- del UPDATE del budget (>=1) — la reversión del dinero es real.
  RETURN v_rows;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- DT-4: Hardening (consistente con refund_a2a_key_spend / debit_with_dest_policy).
ALTER FUNCTION public.refund_with_dest_policy(uuid, integer, numeric, text, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.refund_with_dest_policy(uuid, integer, numeric, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_with_dest_policy(uuid, integer, numeric, text, text)
  TO service_role;
