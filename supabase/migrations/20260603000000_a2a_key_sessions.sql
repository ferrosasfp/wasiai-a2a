CREATE TABLE IF NOT EXISTS a2a_key_sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id              UUID NOT NULL REFERENCES a2a_agent_keys(id) ON DELETE CASCADE,
  owner_ref           TEXT NOT NULL,                 -- desnormalizado (Ownership Guard, CD-2)
  session_token_hash  TEXT NOT NULL UNIQUE,          -- SHA-256(token) — hot-path lookup (AC-4)
  ttl_seconds         INT  NOT NULL,                 -- valor solicitado (auditoría)
  expires_at          TIMESTAMPTZ NOT NULL,          -- now() + ttl_seconds (server-side, CD-5)
  max_budget_usd      NUMERIC(20,8) NOT NULL,        -- budget de la sesión (AC-9)
  spent_usd           NUMERIC(20,8) NOT NULL DEFAULT 0,
  allowed_registries  JSONB,                         -- NULL = hereda restricción del padre (DT-4)
  allowed_agent_slugs JSONB,                         -- NULL = hereda restricción del padre (DT-4)
  allowed_categories  JSONB,                         -- NULL = hereda restricción del padre (DT-4)
  derivation_mode     TEXT NOT NULL DEFAULT 'server',-- discrimina vs EIP-712 (futuro-proof)
  revoked_at          TIMESTAMPTZ,                   -- NULL = activa (WKH-122)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- UNIQUE(session_token_hash) ya provee el índice btree O(1) del hot-path (AC-4);
-- NO crear un índice explícito redundante sobre esa columna (lección WKH-101).
CREATE INDEX IF NOT EXISTS idx_a2a_key_sessions_key_owner
  ON a2a_key_sessions (key_id, owner_ref);
CREATE INDEX IF NOT EXISTS idx_a2a_key_sessions_owner
  ON a2a_key_sessions (owner_ref);

-- ============================================================
-- RPC atómico: debit_session_and_parent
-- ============================================================
CREATE OR REPLACE FUNCTION debit_session_and_parent(
  p_session_id UUID,
  p_owner_ref  TEXT,
  p_key_id     UUID,
  p_chain_id   INT,
  p_amount_usd NUMERIC
) RETURNS NUMERIC AS $$
DECLARE
  v_owner     TEXT;
  v_key_id    UUID;
  v_revoked   TIMESTAMPTZ;
  v_expires   TIMESTAMPTZ;
  v_spent     NUMERIC;
  v_max       NUMERIC;
  v_new_spent NUMERIC;
BEGIN
  -- 1. Lock de la sesión (FOR UPDATE — serializa débitos concurrentes; AC-8).
  SELECT owner_ref, key_id, revoked_at, expires_at, spent_usd, max_budget_usd
    INTO v_owner, v_key_id, v_revoked, v_expires, v_spent, v_max
    FROM a2a_key_sessions
    WHERE id = p_session_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SESSION_NOT_FOUND: %', p_session_id;
  END IF;

  -- 2. Ownership Guard a nivel DB (CD-2 — el service usa SERVICE_ROLE / bypass RLS).
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: session % not owned by caller', p_session_id;
  END IF;
  IF v_key_id IS DISTINCT FROM p_key_id THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: session % not bound to key %', p_session_id, p_key_id;
  END IF;

  -- 3. Revocación / expiry re-chequeados BAJO LOCK (TOCTOU-safe, DT-3).
  IF v_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'SESSION_REVOKED: %', p_session_id;
  END IF;
  IF NOW() >= v_expires THEN
    RAISE EXCEPTION 'SESSION_EXPIRED: %', p_session_id;
  END IF;

  -- 4. Check del budget de la sesión (AC-9) ANTES del debit del parent.
  v_new_spent := v_spent + p_amount_usd;
  IF v_new_spent > v_max THEN
    RAISE EXCEPTION 'SESSION_BUDGET_EXHAUSTED: % + % > %', v_spent, p_amount_usd, v_max;
  END IF;

  -- 5. Debit del parent budget reusando la fn existente (AC-8).
  --    increment_a2a_key_spend RAISE 'INSUFFICIENT_BUDGET'/'DAILY_LIMIT'/'KEY_INACTIVE'/
  --    'KEY_NOT_FOUND' si corresponde → se propagan, toda la tx hace ROLLBACK
  --    (spent_usd no se incrementa). NO se hace scope check acá (CD-4: ya en creación).
  PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd);

  -- 6. Recién acá incrementamos spent_usd (orden 4→5→6 defensivo).
  UPDATE a2a_key_sessions SET spent_usd = v_new_spent WHERE id = p_session_id;

  RETURN v_new_spent;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Hardening obligatorio (CD-7).
ALTER FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric)
  TO service_role;
