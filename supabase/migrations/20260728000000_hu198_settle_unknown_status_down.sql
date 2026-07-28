-- ============================================================
-- ROLLBACK HU-198 — restaura `record_debit_settle_status` al cuerpo de 191b
-- (20260713000001_wkh191b_debit_hop1.sql), o sea `p_status` limitado a
-- ('settled','reconciliation_pending') y sin guard de transición.
-- ============================================================
--
-- ⚠️ ORDEN DE ROLLBACK (GATE): ESTE DOWN SE APLICA **DESPUÉS** DE REVERTIR EL CÓDIGO
-- DE HU-198 — el espejo exacto del up.
--
-- CONSECUENCIA DEL ORDEN INVERSO (down primero, con el código nuevo todavía vivo): el
-- código nuevo sigue intentando escribir `resolving_settle`, el RPC vuelve a rechazarlo
-- con `INVALID_SETTLE_STATUS`, la fila queda en `hop1_confirmed` (auto-reclamable) y el
-- reconciliador puede re-enviar el hop 2 sin evidencia ⟹ riesgo de doble pago al
-- seller. Es el MISMO agujero que el orden inverso del up.
--
-- ⚠️ NO ES UN ROLLBACK COMPLETO — DATOS QUE QUEDAN: las filas que HU-198 ya dejó en
-- `debit_settle_status = 'resolving_settle'` NO se tocan, a propósito. Cada una es un
-- hop 2 de resultado DESCONOCIDO (el pago pudo haberse hecho), así que reescribirlas a
-- `reconciliation_pending` las volvería auto-reclamables y podría disparar justo el
-- doble pago que se quería evitar. Se quedan visibles en
-- `GET /dashboard/api/reconciliation` (`resolving_settle` sigue en `PENDING_STATUSES`)
-- para resolución manual. Esas filas siguen siendo válidas para el CHECK, que las
-- acepta desde 191c y que este down NO modifica.
--
-- Para inventariarlas antes de revertir:
--   SELECT intent_id, key_id, debit_nonce, debit_amount_atomic
--     FROM a2a_payment_intent_debit_signatures
--    WHERE debit_settle_status = 'resolving_settle'
--      AND debit_resolution_tx_hash IS NULL;
-- ============================================================

BEGIN;

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
