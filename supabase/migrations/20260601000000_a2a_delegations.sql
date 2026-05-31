-- ============================================================
-- Migration: 20260601000000_a2a_delegations
-- WKH-101: Fase 2 — EIP-712 delegation + session keys + server-side enforcement
-- ============================================================

BEGIN;

-- 1. Tabla de delegaciones (session keys). El owner (master key) firma una
--    policy EIP-712 anclada a su funding_wallet (CD-11) y autoriza una session
--    key efímera. SOLO se persiste el hash del token (nunca el token plano).
CREATE TABLE IF NOT EXISTS a2a_delegations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id              UUID NOT NULL REFERENCES a2a_agent_keys(id) ON DELETE CASCADE,
  owner_ref           TEXT NOT NULL,            -- desnormalizado (Ownership Guard, CD-2)
  session_key_address TEXT NOT NULL,            -- lowercase
  session_token_hash  TEXT NOT NULL UNIQUE,     -- SHA-256(token) — hot-path lookup (AC-5)
  policy              JSONB NOT NULL,
  total_spent         NUMERIC(20,8) NOT NULL DEFAULT 0,
  expires_at          TIMESTAMPTZ NOT NULL,
  revoked_at          TIMESTAMPTZ,              -- NULL = activa
  typed_data_raw      JSONB NOT NULL,           -- auditoría del typed-data firmado
  nonce               TEXT NOT NULL,            -- bytes32 hex
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- AC-4 / CD-4: anti-replay. El mismo (key_id, nonce) jamás se acepta dos veces.
  CONSTRAINT uq_a2a_delegations_key_nonce UNIQUE (key_id, nonce)
);

-- UNIQUE(session_token_hash) ya crea índice btree O(1) para el lookup del hot
-- path (AC-5); el idx_a2a_delegations_token_hash explícito del work-item sería
-- REDUNDANTE sobre una columna UNIQUE → NO se crea (SDD §1.3).
CREATE INDEX IF NOT EXISTS idx_a2a_delegations_key_owner
  ON a2a_delegations (key_id, owner_ref);
CREATE INDEX IF NOT EXISTS idx_a2a_delegations_owner
  ON a2a_delegations (owner_ref);

-- 2. debit_delegation_and_parent — corazón de la HU (CD-8/CD-12).
--    Check-and-debit ATÓMICO del total acumulado de la delegación Y del parent
--    budget[chainId], bajo FOR UPDATE. Cero read-then-write en app (CD-12).
--    Patrón calcado de register_a2a_key_deposit v2 (20260529000000):
--    FOR UPDATE + RAISE EXCEPTION 'CODE: detalle' + SECURITY DEFINER + hardening.
CREATE OR REPLACE FUNCTION debit_delegation_and_parent(
  p_delegation_id UUID,
  p_owner_ref     TEXT,
  p_key_id        UUID,
  p_chain_id      INT,
  p_amount_usd    NUMERIC
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

  -- 2. Ownership Guard a nivel DB (CD-2 — service usa SERVICE_ROLE).
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: delegation % not owned by caller', p_delegation_id;
  END IF;
  -- 2b. La delegación debe pertenecer a la parent key declarada.
  IF v_key_id IS DISTINCT FROM p_key_id THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: delegation % not bound to key %', p_delegation_id, p_key_id;
  END IF;

  -- 3. Revocación / expiry re-chequeados bajo lock (TOCTOU-safe, CD-10).
  IF v_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'DELEGATION_REVOKED: %', p_delegation_id;
  END IF;
  IF NOW() >= v_expires THEN
    RAISE EXCEPTION 'DELEGATION_EXPIRED: %', p_delegation_id;
  END IF;

  -- 4. Check del total acumulado (AC-8/CD-12) ANTES del debit del parent.
  v_new_total := v_total + p_amount_usd;
  IF v_max_total IS NOT NULL AND v_new_total > v_max_total THEN
    RAISE EXCEPTION 'DELEGATION_TOTAL_LIMIT_EXCEEDED: % + % > %', v_total, p_amount_usd, v_max_total;
  END IF;

  -- 5. Debit del parent budget reusando la fn existente (AC-9/DT-5).
  --    increment_a2a_key_spend RAISE 'INSUFFICIENT_BUDGET' si no alcanza →
  --    se propaga, toda la tx hace ROLLBACK (total_spent no se incrementa).
  PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd);

  -- 6. Recién acá incrementamos total_spent (orden 4→5→6 defensivo).
  UPDATE a2a_delegations SET total_spent = v_new_total WHERE id = p_delegation_id;

  RETURN v_new_total;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Hardening obligatorio (patrón 20260427160000 / 20260529000000).
--    SECURITY DEFINER sin search_path fijo = schema-hijacking.
ALTER FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric)
  TO service_role;

COMMIT;
