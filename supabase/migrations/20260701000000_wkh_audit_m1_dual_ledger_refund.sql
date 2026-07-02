-- ============================================================
-- Migration: 20260701000000_wkh_audit_m1_dual_ledger_refund
-- Auditoría 2026-07-01 — hallazgo M1 (dual-ledger refund).
--
-- PROBLEMA: el débito bajo delegación/sesión es DUAL-LEDGER —
-- `debit_delegation_and_parent` / `debit_session_and_parent` incrementan
-- atómicamente AMBOS: (a) el parent (`a2a_agent_keys.budget` + `daily_spent_usd`
-- vía increment_a2a_key_spend / debit_with_dest_policy) Y (b) el contador de la
-- credencial (`a2a_delegations.total_spent` / `a2a_key_sessions.spent_usd`).
--
-- Pero el REFUND era SINGLE-LEDGER: `refund_a2a_key_spend` /
-- `refund_with_dest_policy` sólo revierten el parent — no tocan `total_spent`
-- ni `spent_usd`. El bloque de refund step-0 de `routes/compose.ts` (AUDIT-A1)
-- NO estaba gateado por contexto de delegación/sesión, así que para un compose
-- bajo delegación acreditaba el parent pero NO decrementaba `total_spent` →
-- `total_spent` se arrastra hacia `max_total_amount` con dinero reembolsado y
-- nunca gastado → `DELEGATION_TOTAL_LIMIT_EXCEEDED` prematuro (self-DoS de la
-- delegación). Falla CLOSED (sin pérdida de fondos), pero es un bug contable.
--
-- FIX: dos RPCs de refund DUAL-LEDGER que espejan `debit_*_and_parent`:
--   - refund_delegation_and_parent → refund del parent + GREATEST(total_spent - amt, 0)
--   - refund_session_and_parent    → refund del parent + GREATEST(spent_usd  - amt, 0)
-- Ambos corren en UNA transacción (FOR UPDATE de la credencial + el refund del
-- parent que a su vez toma FOR UPDATE de la key), con el mismo Ownership Guard
-- DB-level que los débitos. Devuelven el ROW_COUNT del refund del PARENT (mismo
-- contrato `reverted = data >= 1` que refund_a2a_key_spend / refund_with_dest_policy).
--
-- INVARIANTES:
--   - clamp GREATEST(..., 0): un refund nunca deja total_spent/spent_usd negativo.
--   - dispatch dest-aware SIMÉTRICO al débito (refund_with_dest_policy si hay
--     destination con política; refund_a2a_key_spend en caso contrario).
--   - no-op defensivo (0 filas) si p_amount_usd <= 0, sin tocar ningún ledger.
--   - Hardening: search_path pinned + REVOKE FROM PUBLIC/anon/authenticated +
--     GRANT a service_role (consistente con los RPCs hermanos).
--
-- Aditiva: CREATE nuevas funciones. El down las dropea.
-- ============================================================

-- ── refund_delegation_and_parent (dual-ledger) ──
-- CR NIT-2: CREATE OR REPLACE → idempotente en re-apply (misma firma).
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
  -- Lock atómico de la delegación (mismo estilo que debit_delegation_and_parent).
  SELECT owner_ref, key_id, total_spent
    INTO v_owner, v_key_id, v_total
    FROM a2a_delegations
    WHERE id = p_delegation_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DELEGATION_NOT_FOUND: %', p_delegation_id;
  END IF;

  -- Ownership Guard DB-level (defensa en profundidad; service usa SERVICE_ROLE).
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: delegation % not owned by caller', p_delegation_id;
  END IF;
  IF v_key_id IS DISTINCT FROM p_key_id THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: delegation % not bound to key %', p_delegation_id, p_key_id;
  END IF;

  -- Un refund nunca es negativo ni cero. Defensivo: no-op sin tocar ledgers.
  IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
    RETURN 0;
  END IF;

  -- (a) refund del PARENT — dispatch dest-aware SIMÉTRICO al débito. El
  -- ROW_COUNT devuelto es el contrato de reversión real que el service lee.
  IF p_destination IS NOT NULL AND p_destination <> '' THEN
    v_rows := refund_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination);
  ELSE
    v_rows := refund_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref);
  END IF;

  -- (b) revertir el contador de la delegación (dual-ledger), clamp a 0.
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

-- ── refund_session_and_parent (dual-ledger) ──
-- CR NIT-2: CREATE OR REPLACE → idempotente en re-apply (misma firma).
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
  -- Lock atómico de la sesión (mismo estilo que debit_session_and_parent).
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

  -- (a) refund del PARENT — dispatch dest-aware SIMÉTRICO al débito.
  IF p_destination IS NOT NULL AND p_destination <> '' THEN
    v_rows := refund_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination);
  ELSE
    v_rows := refund_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref);
  END IF;

  -- (b) revertir el contador de la sesión (dual-ledger), clamp a 0.
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
