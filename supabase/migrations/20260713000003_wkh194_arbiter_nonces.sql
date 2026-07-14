-- ============================================================
-- Migration: 20260713000003_wkh194_arbiter_nonces
-- WKH-194: persistencia exactly-once del nonce del árbitro (anti-griefing MNR-1/R-3).
-- INERTE — no mueve fondos, cero on-chain. Aditiva 100%. NO toca a2a_payment_intents,
-- a2a_arbitrations, ni ningún RPC existente. Crea:
--   - Tabla a2a_arbiter_nonces (un nonce inmutable por intent, intent_id PK).
--   - RPC get_or_create_arbiter_nonce (SECURITY DEFINER, owner-guarded, first-writer-wins).
--   - RLS deny-by-default (service_role bypassa por BYPASSRLS).
-- Patrón: 20260713000000_wkh191a_debit_signatures.sql + record_debit_hop1 (191b).
-- ============================================================

BEGIN;

-- ── Tabla a2a_arbiter_nonces (un nonce inmutable por intent) ──
CREATE TABLE IF NOT EXISTS a2a_arbiter_nonces (
  intent_id   UUID PRIMARY KEY REFERENCES a2a_payment_intents(id) ON DELETE CASCADE,
  owner_ref   TEXT NOT NULL,            -- Ownership Guard (WKH-53)
  key_id_hash TEXT NOT NULL,            -- keccak256(stringToBytes(key_id)) — auditoría
  nonce       NUMERIC(78,0) NOT NULL,   -- uint256 disjunto (bit-255) — persistido, inmutable
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_arbiter_nonces_owner ON a2a_arbiter_nonces (owner_ref);

-- RLS deny-by-default (patrón wkh191a: service_role bypassa por BYPASSRLS).
ALTER TABLE a2a_arbiter_nonces ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- RPC: get_or_create_arbiter_nonce (SECURITY DEFINER, owner-guarded, atómico)
-- First-writer-wins: el PRIMER writer persiste su candidate; cualquier writer
-- posterior lee el nonce YA persistido (ON CONFLICT DO NOTHING + re-SELECT).
-- NUNCA mueve dinero. Devuelve el nonce EFECTIVAMENTE persistido (ganador).
-- ============================================================
CREATE OR REPLACE FUNCTION get_or_create_arbiter_nonce(
  p_intent_id   UUID,
  p_owner_ref   TEXT,
  p_key_id_hash TEXT,
  p_nonce       NUMERIC
) RETURNS TABLE(persisted_nonce NUMERIC) AS $$
DECLARE
  v_owner TEXT;
  v_nonce NUMERIC;
BEGIN
  -- Ownership Guard DB-level (WKH-53): el intent debe existir y pertenecer al caller.
  SELECT owner_ref INTO v_owner
    FROM a2a_payment_intents
    WHERE id = p_intent_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENT_NOT_FOUND: %', p_intent_id;
  END IF;
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: intent % not owned by caller', p_intent_id;
  END IF;

  -- First-writer-wins: el primer INSERT gana; un writer posterior es no-op.
  INSERT INTO a2a_arbiter_nonces (intent_id, owner_ref, key_id_hash, nonce)
    VALUES (p_intent_id, p_owner_ref, p_key_id_hash, p_nonce)
    ON CONFLICT (intent_id) DO NOTHING;

  -- Re-SELECT: devuelve el valor GANADOR (recién insertado o pre-existente).
  SELECT nonce INTO v_nonce
    FROM a2a_arbiter_nonces
    WHERE intent_id = p_intent_id;

  persisted_nonce := v_nonce;
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.get_or_create_arbiter_nonce(uuid, text, text, numeric)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.get_or_create_arbiter_nonce(uuid, text, text, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_or_create_arbiter_nonce(uuid, text, text, numeric)
  TO service_role;

COMMIT;
