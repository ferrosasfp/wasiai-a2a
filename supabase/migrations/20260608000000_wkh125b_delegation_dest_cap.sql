-- ============================================================
-- Migration: 20260608000000_wkh125b_delegation_dest_cap
-- WKH-125b: aplicar el cap por destino (a2a_key_spend_policies) a la ruta de
-- delegación EIP-712. Espejo del fix de WKH-125 W3.4 para debit_session_and_parent
-- (20260606000000_a2a_key_spend_policies.sql:141-232).
--
-- El paso 5 (PERFORM increment_a2a_key_spend) pasa a ser un dispatch condicional:
-- con destino → PERFORM debit_with_dest_policy (cap atómico, reusado, NO se toca);
-- sin destino → increment_a2a_key_spend (back-compat byte-idéntico, CD-3).
--
-- BLQ-MED-1 (REPETIDO de WKH-125): CREATE OR REPLACE con +1 param crea una
-- SOBRECARGA, no reemplaza. DROP de la firma vieja de 5 params ANTES del CREATE
-- de 6 params → una sola función. (114/auto-blindaje#75-95)
-- ============================================================

-- CD-2: DROP de la firma vieja de 5 params ANTES del CREATE OR REPLACE de 6.
DROP FUNCTION IF EXISTS debit_delegation_and_parent(uuid, text, uuid, integer, numeric);

CREATE OR REPLACE FUNCTION debit_delegation_and_parent(
  p_delegation_id UUID,
  p_owner_ref     TEXT,
  p_key_id        UUID,
  p_chain_id      INT,
  p_amount_usd    NUMERIC,
  p_destination   TEXT DEFAULT NULL          -- NUEVO (WKH-125b): "<registry>/<slug>" o NULL
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
  -- 1. Lock de la delegación (FOR UPDATE — serializa débitos concurrentes).
  SELECT owner_ref, key_id, revoked_at, expires_at, total_spent,
         (policy->>'max_total_amount')::NUMERIC
    INTO v_owner, v_key_id, v_revoked, v_expires, v_total, v_max_total
    FROM a2a_delegations
    WHERE id = p_delegation_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DELEGATION_NOT_FOUND: %', p_delegation_id;
  END IF;

  -- 2. Ownership Guard a nivel DB.
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: delegation % not owned by caller', p_delegation_id;
  END IF;
  IF v_key_id IS DISTINCT FROM p_key_id THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: delegation % not bound to key %', p_delegation_id, p_key_id;
  END IF;

  -- 3. Revocación / expiry re-chequeados bajo lock (TOCTOU-safe).
  IF v_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'DELEGATION_REVOKED: %', p_delegation_id;
  END IF;
  IF NOW() >= v_expires THEN
    RAISE EXCEPTION 'DELEGATION_EXPIRED: %', p_delegation_id;
  END IF;

  -- 4. Check del total acumulado ANTES del debit del parent.
  v_new_total := v_total + p_amount_usd;
  IF v_max_total IS NOT NULL AND v_new_total > v_max_total THEN
    RAISE EXCEPTION 'DELEGATION_TOTAL_LIMIT_EXCEEDED: % + % > %', v_total, p_amount_usd, v_max_total;
  END IF;

  -- 5. Debit del parent. WKH-125b: si hay destino → dispatch al RPC dest-aware
  --    (la delegación aplica/consume el cap por destino de la PARENT key). Si no →
  --    increment_a2a_key_spend directo (back-compat byte-idéntico, CD-3).
  --    debit_with_dest_policy RAISE DEST_CAP_EXCEEDED → ROLLBACK total (CD-1).
  IF p_destination IS NOT NULL AND p_destination <> '' THEN
    PERFORM debit_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination);
  ELSE
    PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd);
  END IF;

  -- 6. Recién acá incrementamos total_spent (orden 4→5→6 defensivo).
  UPDATE a2a_delegations SET total_spent = v_new_total WHERE id = p_delegation_id;

  RETURN v_new_total;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- CD-6: Hardening de la firma NUEVA de 6 params.
ALTER FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric, text)
  TO service_role;
