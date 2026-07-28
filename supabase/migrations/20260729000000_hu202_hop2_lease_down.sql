-- ============================================================
-- ROLLBACK HU-202 (lease del hop 2): devuelve las dos funciones al cuerpo previo —
-- `record_debit_settle_status` al de 20260728020000 y `claim_reconciliation` al de
-- 20260728010000. **NO borra la columna** (ver abajo).
-- ============================================================
--
-- ⚠️ ORDEN DE ROLLBACK (GATE): ESTE DOWN SE APLICA **DESPUÉS** DE REVERTIR EL CÓDIGO —
-- el espejo del up.
--
-- CONSECUENCIA DEL ORDEN INVERSO (down primero, con el código de HU-202 todavía vivo):
--   · El código sigue tomando el lease vía `record_debit_settle_status('resolving_settle')`
--     y el flip de status sigue funcionando (es escribible desde 20260728000000), así que
--     **el caso F sigue cerrado por el status**. Lo que se pierde es el stamp y el guard
--     independiente del status. Degradación, NO re-apertura inmediata del doble pago.
--   · ⚠️ PERO SÍ SE RE-ABRE ESTO: las filas que quedaron con `debit_hop2_attempted_at`
--     seteado y `debit_settle_status` bajado a `reconciliation_pending`/`hop1_confirmed`
--     por cualquier camino vuelven a ser auto-reclamables por el lado settle, porque el
--     guard del stamp ya no existe. Inventariarlas ANTES de revertir (query abajo).
--
-- ⚠️ LA COLUMNA `debit_hop2_attempted_at` **NO SE BORRA**, A PROPÓSITO.
-- Es la ÚNICA evidencia persistida de qué hop 2 se intentó y cuándo. Un `DROP COLUMN`
-- destruiría exactamente el dato con el que se decide si un seller cobró dos veces, y lo
-- haría en el momento de máxima incertidumbre (un rollback). Queda huérfana y sin escritor:
-- inofensiva. Si se decide borrarla, hacerlo en una migración PROPIA y DESPUÉS de haber
-- inventariado y resuelto las filas de la query de abajo.
--
-- INVENTARIO OBLIGATORIO ANTES DE REVERTIR — cada fila que salga acá es un hop 2 de
-- resultado DESCONOCIDO que, sin el guard, vuelve a poder re-enviarse a ciegas:
--   SELECT intent_id, key_id, debit_settle_status, debit_hop2_attempted_at,
--          debit_resolution_tx_hash, debit_amount_atomic::text
--     FROM a2a_payment_intent_debit_signatures
--    WHERE debit_hop2_attempted_at IS NOT NULL
--      AND debit_resolution_tx_hash IS NULL
--      AND debit_settle_status NOT IN ('settled','resolved_settled','resolved_refunded');
--
-- ⚠️ NO revierte 20260728020000 / 20260728010000 / 20260728000000: `applied`,
-- `current_status`, el guard de transición, el `AND intent_id` y la rama refund de MNR-4
-- siguen vigentes. Para revertir esas, aplicar sus propios `_down` DESPUÉS de este, en
-- orden inverso.
--
-- ⚠️ Sin ventana de schema-cache: las dos firmas y los dos tipos de retorno quedan iguales
-- ⟹ `CREATE OR REPLACE`, sin `DROP FUNCTION`. El `NOTIFY` va igual, por las dudas.
-- ============================================================

BEGIN;

-- ── record_debit_settle_status → cuerpo de 20260728020000 (sin el stamp) ──
CREATE OR REPLACE FUNCTION record_debit_settle_status(
  p_intent_id UUID,
  p_owner_ref TEXT,
  p_key_id    UUID,
  p_nonce     NUMERIC,
  p_status    TEXT
) RETURNS TABLE(applied BOOLEAN, current_status TEXT) AS $$
DECLARE
  v_owner TEXT;
  v_rows  INT;
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
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  applied := v_rows > 0;

  SELECT s.debit_settle_status INTO current_status
    FROM a2a_payment_intent_debit_signatures s
    WHERE s.key_id = p_key_id
      AND s.debit_nonce = p_nonce
      AND s.intent_id = p_intent_id
      AND s.debit_validation_status = 'valid';

  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.record_debit_settle_status(uuid, text, uuid, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.record_debit_settle_status(uuid, text, uuid, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_debit_settle_status(uuid, text, uuid, numeric, text)
  TO service_role;

-- ── claim_reconciliation → cuerpo de 20260728010000 (sin el guard del lease) ──
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
       OR (p_side = 'refund' AND debit_settle_status = 'resolving_settle')
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

NOTIFY pgrst, 'reload schema';

COMMIT;
