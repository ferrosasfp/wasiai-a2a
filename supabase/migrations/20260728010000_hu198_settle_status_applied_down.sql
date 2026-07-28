-- ============================================================
-- ROLLBACK del fix-pack HU-198 (AR): vuelve `record_debit_settle_status` a
-- `RETURNS void` (con el guard de transición de 20260728000000 intacto) y
-- `claim_reconciliation` al cuerpo de 191c (sin la rama refund de MNR-4).
-- ============================================================
--
-- ⚠️ ORDEN DE ROLLBACK (GATE): ESTE DOWN SE APLICA **DESPUÉS** DE REVERTIR EL CÓDIGO
-- DEL FIX-PACK — el espejo del up.
--
-- CONSECUENCIA DEL ORDEN INVERSO (down primero, con el código del fix-pack vivo):
--   · `recordDebitSettleStatus` leería `applied` de un `void` ⇒ `undefined` ⇒ el caller
--     loguea "no se pudo confirmar" en CADA escritura. Ruidoso, NO peligroso: el estado
--     se escribe igual y ninguna decisión de dinero cambia.
--   · El refund del buyer de MNR-4 vuelve a quedar inalcanzable para las filas paradas
--     en `resolving_settle`: si el hop 1 re-verifica `not_confirmed`, el budget del
--     buyer NO se acredita solo y hay que hacerlo a mano.
--
-- ⚠️ NO ES UN ROLLBACK COMPLETO — QUÉ QUEDA:
--   · Las filas ya en `resolving_settle` NO se tocan (mismo criterio que el down de
--     20260728000000: reescribirlas las volvería auto-reclamables y podría disparar el
--     doble pago). Siguen visibles en `GET /dashboard/api/reconciliation`.
--   · Las filas que MNR-4 ya reembolsó quedan en `resolved_refunded`. Correcto: el
--     crédito del budget ya ocurrió, es idempotente y no se revierte con un DDL.
--
-- Este down NO revierte 20260728000000 (el `IN` ampliado con `resolving_settle` sigue
-- vigente). Para revertir esa también, aplicar su propio `_down` DESPUÉS de este.
-- ============================================================

BEGIN;

-- ── record_debit_settle_status → RETURNS void (cuerpo de 20260728000000) ──
DROP FUNCTION IF EXISTS public.record_debit_settle_status(uuid, text, uuid, numeric, text);

CREATE FUNCTION record_debit_settle_status(
  p_intent_id UUID,
  p_owner_ref TEXT,
  p_key_id    UUID,
  p_nonce     NUMERIC,
  p_status    TEXT
) RETURNS void AS $$
DECLARE
  v_owner TEXT;
BEGIN
  IF p_status NOT IN ('settled','reconciliation_pending','resolving_settle') THEN
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
     AND intent_id = p_intent_id
     AND debit_validation_status = 'valid'
     AND (
       p_status <> 'resolving_settle'
       OR debit_settle_status IS NULL
       OR debit_settle_status IN ('hop1_confirmed','reconciliation_pending')
     );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.record_debit_settle_status(uuid, text, uuid, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.record_debit_settle_status(uuid, text, uuid, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_debit_settle_status(uuid, text, uuid, numeric, text)
  TO service_role;

-- ── claim_reconciliation → cuerpo de 191c (sin la rama refund de MNR-4) ──
CREATE OR REPLACE FUNCTION claim_reconciliation(
  p_intent_id UUID,
  p_owner_ref TEXT,
  p_key_id    UUID,
  p_nonce     NUMERIC,
  p_side      TEXT
) RETURNS TABLE(
  claimed            BOOLEAN,
  resolution_tx_hash TEXT,
  amount_atomic      TEXT
) AS $$
DECLARE
  v_owner   TEXT;
  v_target  TEXT;
  v_rows    INT;
BEGIN
  IF p_side NOT IN ('settle','refund') THEN
    RAISE EXCEPTION 'INVALID_SIDE: %', p_side;
  END IF;
  v_target := CASE p_side WHEN 'settle' THEN 'resolving_settle' ELSE 'resolving_refund' END;

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
     SET debit_settle_status = v_target
   WHERE key_id = p_key_id
     AND debit_nonce = p_nonce
     AND debit_validation_status = 'valid'
     AND (
       debit_settle_status IN ('hop1_confirmed','reconciliation_pending')
       OR (
         debit_settle_status = v_target
         AND (p_side = 'refund' OR debit_resolution_tx_hash IS NOT NULL)
       )
     );
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  IF v_rows > 0 THEN
    SELECT TRUE,
           s.debit_resolution_tx_hash,
           s.debit_amount_atomic::TEXT
      INTO claimed, resolution_tx_hash, amount_atomic
      FROM a2a_payment_intent_debit_signatures s
      WHERE s.key_id = p_key_id
        AND s.debit_nonce = p_nonce
        AND s.debit_validation_status = 'valid';
  ELSE
    claimed := FALSE;
  END IF;
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.claim_reconciliation(uuid, text, uuid, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.claim_reconciliation(uuid, text, uuid, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_reconciliation(uuid, text, uuid, numeric, text)
  TO service_role;

COMMIT;
