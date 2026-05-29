-- ============================================================
-- Migration: 20260529000000_a2a_key_deposits
-- WKH-35: Fondeo verificado on-chain (anti-replay + ownership)
-- ============================================================

-- 1. Tabla anti-replay (auditable; no infla el row de la key) — DT-4 / CD-2
CREATE TABLE IF NOT EXISTS a2a_key_deposits (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id      UUID          NOT NULL REFERENCES a2a_agent_keys(id),
  owner_ref   TEXT          NOT NULL,              -- snapshot del owner que acreditó
  chain_id    INT           NOT NULL,
  tx_hash     TEXT          NOT NULL,
  amount_usd  NUMERIC(18,6) NOT NULL,
  token       TEXT,                                 -- símbolo/asset acreditado (auditoría)
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  -- CD-2: unicidad a nivel DB; el mismo (chain, tx) jamás se acredita dos veces.
  CONSTRAINT uq_a2a_key_deposits_chain_tx UNIQUE (chain_id, tx_hash)
);

CREATE INDEX IF NOT EXISTS idx_a2a_key_deposits_key
  ON a2a_key_deposits (key_id);

-- 2. register_a2a_key_deposit v2 — idempotente + atómica + ownership (CD-1/CD-2/CD-5)
--    Reemplaza la v1 (sin owner_ref, sin txHash). Firma NUEVA → la única
--    call-site es budgetService.registerDeposit (endpoint estaba 501).
--
--    FIX-2 (MNR): la v1 (3 args) NO valida owner_ref ni anti-replay y quedaba
--    GRANTed a service_role tras esta migración (CREATE OR REPLACE de la v2 no
--    toca la v1 porque la firma difiere). Se la dropea explícitamente ANTES de
--    crear la v2 para no dejar una fn insegura accesible. El _down restaura la
--    v1, así que el cambio sigue siendo reversible.
DROP FUNCTION IF EXISTS register_a2a_key_deposit(uuid, integer, numeric);

CREATE OR REPLACE FUNCTION register_a2a_key_deposit(
  p_key_id     UUID,
  p_chain_id   INT,
  p_amount_usd NUMERIC,
  p_owner_ref  TEXT,
  p_tx_hash    TEXT,
  p_token      TEXT DEFAULT NULL
)
RETURNS TEXT AS $$
DECLARE
  v_budget   JSONB;
  v_owner    TEXT;
  v_active   BOOLEAN;
  v_chain    TEXT := p_chain_id::TEXT;
  v_current  NUMERIC;
  v_new      NUMERIC;
BEGIN
  -- Lock the key row (atomic) — patrón FOR UPDATE de increment_a2a_key_spend.
  SELECT budget, owner_ref, is_active
    INTO v_budget, v_owner, v_active
    FROM a2a_agent_keys
    WHERE id = p_key_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'KEY_NOT_FOUND: key_id % does not exist', p_key_id;
  END IF;

  -- CD-1: Ownership Guard a nivel DB (service usa SERVICE_ROLE → bypassa RLS).
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key_id % does not belong to caller', p_key_id;
  END IF;

  IF NOT v_active THEN
    RAISE EXCEPTION 'KEY_INACTIVE: key_id % is deactivated', p_key_id;
  END IF;

  -- CD-2: anti-replay. El UNIQUE(chain_id, tx_hash) hace que el segundo
  -- INSERT con el mismo (chain, tx) levante unique_violation; lo traducimos
  -- a un error explícito y NO acreditamos (la tx queda abortada/rollback).
  BEGIN
    INSERT INTO a2a_key_deposits (key_id, owner_ref, chain_id, tx_hash, amount_usd, token)
    VALUES (p_key_id, p_owner_ref, p_chain_id, p_tx_hash, p_amount_usd, p_token);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DEPOSIT_ALREADY_CREDITED: chain % tx % already credited', v_chain, p_tx_hash;
  END;

  -- Crédito al budget de la chain verificada (CD-5: chain del bundle).
  v_current := COALESCE((v_budget ->> v_chain)::NUMERIC, 0);
  v_new := v_current + p_amount_usd;

  UPDATE a2a_agent_keys
  SET budget = jsonb_set(COALESCE(v_budget, '{}'::jsonb), ARRAY[v_chain], to_jsonb(v_new::TEXT))
  WHERE id = p_key_id;

  RETURN v_new::TEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Search-path hardening sobre la firma v2 (TBD-1 resuelto — patrón
--    20260427160000_secure_rpc_search_path.sql). SECURITY DEFINER sin
--    search_path fijo = schema-hijacking. Aplicar también GRANT/REVOKE.
ALTER FUNCTION public.register_a2a_key_deposit(uuid, integer, numeric, text, text, text)
  SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.register_a2a_key_deposit(uuid, integer, numeric, text, text, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.register_a2a_key_deposit(uuid, integer, numeric, text, text, text)
  TO service_role;
