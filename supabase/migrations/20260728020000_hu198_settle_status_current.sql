-- ============================================================
-- HU-198 fix-pack AR#2 (BLQ-BAJO-1) — el RPC devuelve el estado REAL de la fila,
-- para que la alerta pueda nombrarlo en vez de afirmar una consecuencia falsa.
-- ============================================================
--
-- ⚠️ ORDEN DE RELEASE (GATE): ESTA MIGRACIÓN SE APLICA **ANTES** DE DEPLOYAR EL
-- CÓDIGO, y DESPUÉS de 20260728010000.
--
-- El orden correcto NO tiene ventana: agregar una COLUMNA al `RETURNS TABLE` es
-- transparente para el código viejo, que lee `data?.[0]?.applied` y no mira el resto.
--
-- CONSECUENCIA DEL ORDEN INVERSO (código primero): el código nuevo leería
-- `current_status` como `undefined` y su log diría "estado actual: desconocido" en vez
-- de nombrarlo. Degradación de un MENSAJE, cero impacto en decisiones de dinero: el
-- `applied` (que es lo que gobierna) ya viene desde 20260728010000. Es el orden inverso
-- MENOS grave de las tres migraciones de esta HU.
--
-- ── POR QUÉ (AR#2 BLQ-BAJO-1) ──────────────────────────────────────────────
-- La alerta de `recordDebitSettleStatus` afirmaba *"the row REMAINS auto-claimable and
-- the reconciler could resend hop2 blind"*. **Es falso en TODOS sus casos alcanzables**:
-- `applied=false` sólo ocurre cuando el guard de transición rechazó, o sea cuando el
-- status NO está en (NULL, 'hop1_confirmed', 'reconciliation_pending'). Cruzado con el
-- `WHERE` de `claim_reconciliation`: 'settled'/'resolved_*' no los reclama nadie, y
-- 'resolving_*' sólo el lado refund, que nunca manda un hop 2. O sea que en ningún caso
-- alcanzable ese write rechazado puede provocar un re-envío.
--
-- Y el escenario donde la alerta más importa es el PEOR: en el caso F (ver TD-198-01)
-- el operador leía "la fila sigue auto-reclamable, reconciliá a mano" cuando la verdad
-- es que el seller YA COBRÓ DOS VECES. El mensaje lo mandaba a mirar lo que no era.
--
-- Con `current_status` el log puede decir el HECHO ("el guard rechazó; la fila está en
-- 'settled'") en vez de una consecuencia inventada.
--
-- ⚠️ RUNBOOK — VENTANA DEL SCHEMA CACHE DE PostgREST (AR#2 MNR-5): un DROP+CREATE que
-- cambia la FIRMA de retorno puede hacer que PostgREST responda `PGRST202`
-- ("Could not find the function ... in the schema cache") hasta que recargue su cache.
-- En el código eso cae en la rama `error` de `recordDebitSettleStatus` ⟹ `return false`
-- ⟹ log loud, sin decisión de dinero equivocada. Para cerrar la ventana: `NOTIFY pgrst,
-- 'reload schema';` (incluido abajo) o esperar el reload automático. Aplica también a
-- 20260728010000, cuyo header omitía esto.
--
-- ROLLBACK: 20260728020000_hu198_settle_status_current_down.sql
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.record_debit_settle_status(uuid, text, uuid, numeric, text);

CREATE FUNCTION record_debit_settle_status(
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
     -- Guard de transición SÓLO para el valor nuevo (heredado de 20260728000000; esta
     -- migración reescribe la función COMPLETA, así que tiene que reproducirlo o el
     -- guard desaparece en silencio).
     AND (
       p_status <> 'resolving_settle'
       OR debit_settle_status IS NULL
       OR debit_settle_status IN ('hop1_confirmed','reconciliation_pending')
     );
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  applied := v_rows > 0;

  -- AR#2 BLQ-BAJO-1: el estado REAL con el que quedó la fila. Se lee DESPUÉS del UPDATE
  -- y dentro de la misma transacción, así que con `applied=true` es `p_status` y con
  -- `applied=false` es el estado que el guard preservó — que es exactamente el dato que
  -- el operador necesita y que antes la alerta inventaba. NULL si la fila no existe.
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

-- MNR-5: cerrar la ventana del schema cache de PostgREST explícitamente.
NOTIFY pgrst, 'reload schema';

COMMIT;
