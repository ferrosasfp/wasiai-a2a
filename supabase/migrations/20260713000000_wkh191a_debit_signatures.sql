-- ============================================================
-- Migration: 20260713000000_wkh191a_debit_signatures
-- WKH-191a: captura + persistencia de la firma EIP-712 DebitAuthorization
-- (INERTE — 191a NO mueve fondos, cero on-chain). Aditiva 100%. NO toca
-- a2a_payment_intents ni sus 5 RPC (wkh135). Crea:
--   - Tabla a2a_payment_intent_debit_signatures (historial 1:N por intent).
--   - Índice único PARCIAL uq_debit_sig_valid_nonce (anti-replay: SOLO una
--     firma 'valid' reserva (key_id, nonce) — espejo de _usedNonces del contrato,
--     que consume el nonce SOLO en un debit() exitoso).
--   - RPC capture_debit_signature (SECURITY DEFINER, owner-guarded, atómico).
--   - RLS deny-by-default (service_role bypassa por BYPASSRLS).
-- Patrón: 20260704000000_wkh135_payment_intents.sql.
-- ============================================================

BEGIN;

-- ── Tabla a2a_payment_intent_debit_signatures (sibling, append-only) ──
CREATE TABLE IF NOT EXISTS a2a_payment_intent_debit_signatures (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id               UUID NOT NULL REFERENCES a2a_payment_intents(id) ON DELETE CASCADE,
  owner_ref               TEXT NOT NULL,                 -- Ownership Guard (CD-6/WKH-53)
  key_id                  UUID NOT NULL,                 -- == intent.key_id (para el índice anti-replay)
  debit_key_id_hash       TEXT NOT NULL,                 -- keccak256(stringToBytes(key_id)) — bytes32 hex firmado
  debit_amount_atomic     NUMERIC(78,0) NOT NULL,        -- uint256 firmado (unidades atómicas del token escrow)
  debit_deadline          BIGINT NOT NULL,               -- epoch seconds firmado
  debit_nonce             NUMERIC(78,0) NOT NULL,        -- uint256 nonce firmado (escopeado por key_id)
  debit_signature         TEXT NOT NULL,                 -- 0x… la firma cruda del cliente
  debit_signer_recovered  TEXT,                          -- address recuperada (NULL si el recover lanzó)
  debit_validation_status TEXT NOT NULL
    CHECK (debit_validation_status IN ('valid','invalid','not_provided','not_applicable')),
  debit_validation_reason TEXT,                          -- motivo si invalid
  captured_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_debit_sig_intent ON a2a_payment_intent_debit_signatures (intent_id);
CREATE INDEX IF NOT EXISTS idx_debit_sig_owner  ON a2a_payment_intent_debit_signatures (owner_ref);

-- Anti-replay (AC-5, DT-5): espejo de _usedNonces[keyId][nonce]. SOLO una firma
-- VALIDA reserva el (key_id, nonce). Intentos 'invalid' NO queman el nonce.
-- NO reusa uq_a2a_payment_intents_cap_nonce (dominio del cap upto, distinto).
CREATE UNIQUE INDEX IF NOT EXISTS uq_debit_sig_valid_nonce
  ON a2a_payment_intent_debit_signatures (key_id, debit_nonce)
  WHERE debit_validation_status = 'valid';

-- RLS deny-by-default (patrón wkh135: service_role bypassa por BYPASSRLS).
ALTER TABLE a2a_payment_intent_debit_signatures ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- RPC: capture_debit_signature (SECURITY DEFINER, atómico, owner-guarded)
-- Persiste la fila con el veredicto ya computado en TS, re-chequeando el
-- anti-replay del nonce dentro de la MISMA tx (race-safe). NUNCA mueve dinero.
-- Devuelve el status/reason EFECTIVAMENTE persistido (puede degradar a
-- NONCE_ALREADY_USED si otra firma 'valid' ganó el (key_id, nonce)).
-- ============================================================
CREATE OR REPLACE FUNCTION capture_debit_signature(
  p_intent_id     UUID,
  p_owner_ref     TEXT,
  p_key_id        UUID,
  p_key_id_hash   TEXT,
  p_amount_atomic NUMERIC,
  p_deadline      BIGINT,
  p_nonce         NUMERIC,
  p_signature     TEXT,
  p_recovered     TEXT,
  p_status        TEXT,
  p_reason        TEXT
) RETURNS TABLE(persisted_status TEXT, persisted_reason TEXT) AS $$
DECLARE
  v_owner  TEXT;
  v_status TEXT := p_status;
  v_reason TEXT := p_reason;
  v_exists INT;
BEGIN
  -- Ownership Guard DB-level (CD-6): el intent debe existir y pertenecer al caller.
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

  -- Anti-replay (AC-5): si se pretende persistir 'valid' pero el (key_id, nonce)
  -- ya tiene una firma 'valid', degradar a invalid/NONCE_ALREADY_USED.
  IF v_status = 'valid' THEN
    SELECT 1 INTO v_exists
      FROM a2a_payment_intent_debit_signatures
      WHERE key_id = p_key_id
        AND debit_nonce = p_nonce
        AND debit_validation_status = 'valid'
      LIMIT 1;
    IF FOUND THEN
      v_status := 'invalid';
      v_reason := 'NONCE_ALREADY_USED';
    END IF;
  END IF;

  -- INSERT con backstop de carrera: el índice parcial uq_debit_sig_valid_nonce
  -- rechaza un 'valid' concurrente → capturamos 23505 y re-insertamos como invalid.
  BEGIN
    INSERT INTO a2a_payment_intent_debit_signatures (
      intent_id, owner_ref, key_id, debit_key_id_hash, debit_amount_atomic,
      debit_deadline, debit_nonce, debit_signature, debit_signer_recovered,
      debit_validation_status, debit_validation_reason
    ) VALUES (
      p_intent_id, p_owner_ref, p_key_id, p_key_id_hash, p_amount_atomic,
      p_deadline, p_nonce, p_signature, p_recovered,
      v_status, v_reason
    );
  EXCEPTION WHEN unique_violation THEN
    v_status := 'invalid';
    v_reason := 'NONCE_ALREADY_USED';
    INSERT INTO a2a_payment_intent_debit_signatures (
      intent_id, owner_ref, key_id, debit_key_id_hash, debit_amount_atomic,
      debit_deadline, debit_nonce, debit_signature, debit_signer_recovered,
      debit_validation_status, debit_validation_reason
    ) VALUES (
      p_intent_id, p_owner_ref, p_key_id, p_key_id_hash, p_amount_atomic,
      p_deadline, p_nonce, p_signature, p_recovered,
      v_status, v_reason
    );
  END;

  persisted_status := v_status;
  persisted_reason := v_reason;
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.capture_debit_signature(uuid, text, uuid, text, numeric, bigint, numeric, text, text, text, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.capture_debit_signature(uuid, text, uuid, text, numeric, bigint, numeric, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capture_debit_signature(uuid, text, uuid, text, numeric, bigint, numeric, text, text, text, text)
  TO service_role;

COMMIT;
