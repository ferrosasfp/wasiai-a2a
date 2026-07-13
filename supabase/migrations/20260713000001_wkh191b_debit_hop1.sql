-- ============================================================
-- Migration: 20260713000001_wkh191b_debit_hop1
-- WKH-191b: consumo de la firma DebitAuthorization (two-hop settle). Extiende
-- ADITIVAMENTE la tabla de 191a con la evidencia del hop 1 ejecutado + el estado
-- del ciclo de vida del consumo. NO toca a2a_payment_intents ni sus RPC (wkh135),
-- NO toca capture_debit_signature (191a). NUNCA mueve dinero.
-- Patrón: 20260713000000_wkh191a_debit_signatures.sql.
-- ============================================================

BEGIN;

-- ── Columnas nullable aditivas (DT-9) ──
ALTER TABLE a2a_payment_intent_debit_signatures
  ADD COLUMN IF NOT EXISTS debit_hop1_tx_hash      TEXT,          -- tx de escrow.debit() (hop 1)
  ADD COLUMN IF NOT EXISTS debit_hop1_confirmed_at TIMESTAMPTZ,   -- confirmación on-chain de hop 1
  ADD COLUMN IF NOT EXISTS debit_settle_status     TEXT
    CHECK (debit_settle_status IS NULL OR
           debit_settle_status IN ('hop1_confirmed','settled','reconciliation_pending'));

-- Query de 191c: firmas con hop 1 movido pero settle no completado.
CREATE INDEX IF NOT EXISTS idx_debit_sig_settle_status
  ON a2a_payment_intent_debit_signatures (debit_settle_status)
  WHERE debit_settle_status IN ('hop1_confirmed','reconciliation_pending');

-- ============================================================
-- RPC: record_debit_hop1 (SECURITY DEFINER, owner-guarded, idempotente)
-- Persiste el tx hash de hop 1 ANTES de intentar hop 2 (BLQ-DR). Idempotente:
-- COALESCE → la 1ª escritura gana; un retry NO sobreescribe el hash. Devuelve el
-- hash EFECTIVO de la fila. NUNCA mueve dinero.
-- ============================================================
CREATE OR REPLACE FUNCTION record_debit_hop1(
  p_intent_id UUID,
  p_owner_ref TEXT,
  p_key_id    UUID,
  p_nonce     NUMERIC,
  p_tx_hash   TEXT
) RETURNS TABLE(persisted_tx_hash TEXT) AS $$
DECLARE
  v_owner TEXT;
  v_hash  TEXT;
BEGIN
  -- Ownership Guard DB-level (CD-6/WKH-53).
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

  UPDATE a2a_payment_intent_debit_signatures
     SET debit_hop1_tx_hash      = COALESCE(debit_hop1_tx_hash, p_tx_hash),
         debit_hop1_confirmed_at = COALESCE(debit_hop1_confirmed_at, now()),
         debit_settle_status     = COALESCE(debit_settle_status, 'hop1_confirmed')
   WHERE key_id = p_key_id
     AND debit_nonce = p_nonce
     AND debit_validation_status = 'valid'
  RETURNING debit_hop1_tx_hash INTO v_hash;

  persisted_tx_hash := v_hash;
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.record_debit_hop1(uuid, text, uuid, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.record_debit_hop1(uuid, text, uuid, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_debit_hop1(uuid, text, uuid, numeric, text)
  TO service_role;

-- ============================================================
-- RPC: record_debit_settle_status (SECURITY DEFINER, owner-guarded)
-- Flip terminal del ciclo de vida del consumo tras resolver hop 2. NO mueve dinero.
-- p_status ∈ ('settled','reconciliation_pending').
-- ============================================================
CREATE OR REPLACE FUNCTION record_debit_settle_status(
  p_intent_id UUID,
  p_owner_ref TEXT,
  p_key_id    UUID,
  p_nonce     NUMERIC,
  p_status    TEXT
) RETURNS void AS $$
DECLARE
  v_owner TEXT;
BEGIN
  IF p_status NOT IN ('settled','reconciliation_pending') THEN
    RAISE EXCEPTION 'INVALID_SETTLE_STATUS: %', p_status;
  END IF;

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

  UPDATE a2a_payment_intent_debit_signatures
     SET debit_settle_status = p_status
   WHERE key_id = p_key_id
     AND debit_nonce = p_nonce
     AND debit_validation_status = 'valid';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.record_debit_settle_status(uuid, text, uuid, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.record_debit_settle_status(uuid, text, uuid, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_debit_settle_status(uuid, text, uuid, numeric, text)
  TO service_role;

COMMIT;
