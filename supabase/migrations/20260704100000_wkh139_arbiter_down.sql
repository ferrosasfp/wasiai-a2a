-- ============================================================
-- Down migration: 20260704100000_wkh139_arbiter
-- WKH-139: revierte el arbitraje. DROP RPCs nuevos + tabla; restaura
-- record_settle_outcome/finalize_payment_intent al gate ='closing' original
-- (cuerpo verbatim de WKH-135); restaura ambos CHECK (status, receipt_type)
-- a su set previo. Las firmas de DROP FUNCTION llevan los tipos exactos.
-- ============================================================

BEGIN;

-- 1. DROP RPCs nuevos + tabla de arbitraje.
DROP FUNCTION IF EXISTS close_payment_intent_for_arbitration(uuid, text, numeric);
DROP FUNCTION IF EXISTS open_dispute(uuid, text);
DROP TABLE IF EXISTS a2a_arbitrations;

-- 2. Restaurar record_settle_outcome al gate ='closing' (cuerpo original WKH-135).
CREATE OR REPLACE FUNCTION record_settle_outcome(
  p_intent_id    UUID,
  p_owner_ref    TEXT,
  p_outcome      TEXT,
  p_tx_hash      TEXT,
  p_residual     NUMERIC,
  p_error        TEXT
) RETURNS void AS $$
DECLARE
  v_owner  TEXT;
  v_status TEXT;
BEGIN
  SELECT owner_ref, status
    INTO v_owner, v_status
    FROM a2a_payment_intents
    WHERE id = p_intent_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENT_NOT_FOUND: %', p_intent_id;
  END IF;
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: intent % not owned by caller', p_intent_id;
  END IF;

  IF v_status <> 'closing' THEN
    RETURN;
  END IF;

  UPDATE a2a_payment_intents
    SET settle_outcome = p_outcome,
        settle_tx_hash = COALESCE(p_tx_hash, settle_tx_hash),
        residual_usd   = p_residual,
        error_message  = p_error
    WHERE id = p_intent_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.record_settle_outcome(uuid, text, text, text, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.record_settle_outcome(uuid, text, text, text, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_settle_outcome(uuid, text, text, text, numeric, text)
  TO service_role;

-- 3. Restaurar finalize_payment_intent al gate ='closing' (cuerpo original WKH-135).
CREATE OR REPLACE FUNCTION finalize_payment_intent(
  p_intent_id    UUID,
  p_owner_ref    TEXT,
  p_tx_hash      TEXT,
  p_final_amount NUMERIC,
  p_residual     NUMERIC,
  p_outcome      TEXT,
  p_error        TEXT
) RETURNS void AS $$
DECLARE
  v_owner    TEXT;
  v_status   TEXT;
  v_type     TEXT;
  v_key      UUID;
  v_chain    INT;
  v_auth     NUMERIC;
  v_consumed NUMERIC;
BEGIN
  SELECT owner_ref, status, intent_type, key_id, chain_id, authorized_usd, consumed_usd
    INTO v_owner, v_status, v_type, v_key, v_chain, v_auth, v_consumed
    FROM a2a_payment_intents
    WHERE id = p_intent_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTENT_NOT_FOUND: %', p_intent_id;
  END IF;
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: intent % not owned by caller', p_intent_id;
  END IF;

  IF v_status <> 'closing' THEN
    RETURN;
  END IF;

  IF p_outcome = 'settled' THEN
    UPDATE a2a_payment_intents
      SET status = 'settled', settle_tx_hash = p_tx_hash,
          residual_usd = p_residual, settle_outcome = 'settled'
      WHERE id = p_intent_id;
    IF v_type = 'session' AND p_residual IS NOT NULL AND p_residual > 0 THEN
      PERFORM refund_a2a_key_spend(v_key, v_chain, p_residual, p_owner_ref);
    END IF;

  ELSIF p_outcome = 'failed_unequivocal' THEN
    UPDATE a2a_payment_intents
      SET status = 'refunded', settle_outcome = 'failed_unequivocal',
          error_message = COALESCE(p_error, error_message)
      WHERE id = p_intent_id;
    IF v_type = 'session' THEN
      IF v_auth IS NOT NULL AND v_auth > 0 THEN
        PERFORM refund_a2a_key_spend(v_key, v_chain, v_auth, p_owner_ref);
      END IF;
    ELSE
      IF v_consumed IS NOT NULL AND v_consumed > 0 THEN
        PERFORM refund_a2a_key_spend(v_key, v_chain, v_consumed, p_owner_ref);
      END IF;
    END IF;

  ELSE
    UPDATE a2a_payment_intents
      SET status = 'failed', settle_outcome = 'failed_ambiguous',
          error_message = COALESCE(p_error, error_message)
      WHERE id = p_intent_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.finalize_payment_intent(uuid, text, text, numeric, numeric, text, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.finalize_payment_intent(uuid, text, text, numeric, numeric, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_payment_intent(uuid, text, text, numeric, numeric, text, text)
  TO service_role;

-- 4. Restaurar status CHECK a su set previo (sin los 3 estados de arbitraje).
ALTER TABLE a2a_payment_intents DROP CONSTRAINT IF EXISTS a2a_payment_intents_status_check;
ALTER TABLE a2a_payment_intents ADD CONSTRAINT a2a_payment_intents_status_check
  CHECK (status IN ('open','closing','settled','refunded','expired','failed'));

-- 5. Restaurar receipt_type CHECK a su set previo (post-126b).
ALTER TABLE a2a_receipts DROP CONSTRAINT IF EXISTS a2a_receipts_receipt_type_check;
ALTER TABLE a2a_receipts ADD CONSTRAINT a2a_receipts_receipt_type_check
  CHECK (receipt_type IN ('protocol_fee','budget_debit','deposit_verified'));

COMMIT;
