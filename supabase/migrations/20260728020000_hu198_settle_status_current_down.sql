-- ============================================================
-- ROLLBACK HU-198 fix-pack AR#2 (BLQ-BAJO-1): vuelve `record_debit_settle_status` a
-- `RETURNS TABLE(applied boolean)` — el cuerpo de 20260728010000, SIN `current_status`.
-- ============================================================
--
-- ⚠️ ORDEN DE ROLLBACK (GATE): ESTE DOWN SE APLICA **DESPUÉS** DE REVERTIR EL CÓDIGO —
-- el espejo del up.
--
-- CONSECUENCIA DEL ORDEN INVERSO (down primero, con el código nuevo vivo): el código
-- leería `current_status` como `undefined` y su log diría "estado actual: desconocido".
-- Degradación de un MENSAJE; `applied` (lo que gobierna) sigue llegando. Sin impacto en
-- decisiones de dinero.
--
-- ⚠️ NO revierte 20260728010000 ni 20260728000000: el `applied`, el guard de transición,
-- el `AND intent_id` y la rama refund de MNR-4 siguen vigentes. Para revertir esas,
-- aplicar sus propios `_down` DESPUÉS de este, en orden inverso.
--
-- ⚠️ MISMA VENTANA DE SCHEMA CACHE que el up (PostgREST / `PGRST202`): el `NOTIFY` va
-- incluido.
-- ============================================================

BEGIN;

-- ── (1) + (3) record_debit_settle_status → RETURNS TABLE(applied boolean) ──
DROP FUNCTION IF EXISTS public.record_debit_settle_status(uuid, text, uuid, numeric, text);

CREATE FUNCTION record_debit_settle_status(
  p_intent_id UUID,
  p_owner_ref TEXT,
  p_key_id    UUID,
  p_nonce     NUMERIC,
  p_status    TEXT
) RETURNS TABLE(applied BOOLEAN) AS $$
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
     -- MNR-3: el intent verificado arriba y la fila escrita son el MISMO.
     AND intent_id = p_intent_id
     AND debit_validation_status = 'valid'
     -- Guard de transición SÓLO para el valor nuevo (20260728000000). Los dos valores
     -- de 191b pasan sin precondición: comportamiento preexistente intacto.
     AND (
       p_status <> 'resolving_settle'
       OR debit_settle_status IS NULL
       OR debit_settle_status IN ('hop1_confirmed','reconciliation_pending')
     );
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- BLQ-MEDIO-2: el caller necesita saber si el estado quedó escrito. `false` acá NO
  -- es un error del RPC: es "el guard de transición lo rechazó" (o la fila no existe),
  -- o sea que la fila CONSERVA un estado que NO es el que este write quería.
  -- (AR#2 BLQ-BAJO-1: la versión original de este comentario decía "la fila SIGUE
  -- auto-reclamable", y era FALSO en todos los casos alcanzables — el guard sólo rechaza
  -- desde estados que ni el lado settle ni el refund pueden reclamar para mandar un
  -- hop 2. Se corrige acá también para no reintroducir la afirmación falsa al revertir.)
  applied := v_rows > 0;
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

NOTIFY pgrst, 'reload schema';

COMMIT;
