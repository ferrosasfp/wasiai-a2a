-- ============================================================
-- HU-198 fix-pack (AR) — el candado tiene que poder reportar su propio fracaso,
-- y el refund legítimo del buyer no puede quedar inalcanzable.
-- ============================================================
--
-- ⚠️ ORDEN DE RELEASE (GATE): ESTA MIGRACIÓN SE APLICA **ANTES** DE DEPLOYAR EL
-- CÓDIGO DEL FIX-PACK, y DESPUÉS de 20260728000000 (la de esta misma HU, que es la
-- que introdujo el guard de transición cuyo fracaso acá se vuelve observable).
--
-- El orden correcto NO tiene ventana: el código VIEJO hace
-- `await supabase.rpc('record_debit_settle_status', …)` DESCARTANDO `data`, así que
-- pasar de `RETURNS void` a `RETURNS TABLE(applied boolean)` le es transparente
-- (PostgREST devuelve filas donde antes devolvía null; nadie las lee). Y el cambio de
-- `claim_reconciliation` sólo AGREGA una fila reclamable para el lado refund.
--
-- CONSECUENCIA DEL ORDEN INVERSO (código primero):
--   · `recordDebitSettleStatus` leería `data?.[0]?.applied` de un `void` ⇒ `undefined`
--     ⇒ el caller lo trata como "no sé" y loguea un warn por cada escritura. Ruidoso
--     pero NO peligroso: NO cambia el estado escrito ni la decisión de dinero. Es el
--     orden inverso MENOS grave de las dos migraciones de esta HU (el de
--     20260728000000 sí re-abría el doble pago).
--   · El refund del buyer del caso MNR-4 seguiría inalcanzable hasta que se aplique.
--
-- ── QUÉ CAMBIA ─────────────────────────────────────────────────────────────
--
-- (1) BLQ-MEDIO-2 — `record_debit_settle_status` pasa de `RETURNS void` a
--     `RETURNS TABLE(applied boolean)`.
--     POR QUÉ: el guard de transición que agregó 20260728000000 hace que un UPDATE de
--     0 filas sea un RESULTADO NORMAL (no un error), así que con `void` el caller NO
--     PODÍA distinguir "escribí resolving_settle" de "el guard lo rechazó y la fila
--     sigue auto-reclamable" — o sea que el candado colgaba de un write que no podía
--     reportar su propio fracaso. El `log.error` que el fix agregó sólo dispara con
--     `error` del RPC, no con el 0-row silencioso.
--     Patrón idéntico a `record_reconciliation_resolution` (191c), que ya devuelve
--     `TABLE(applied BOOLEAN)` por esta misma razón.
--     ⚠️ Requiere DROP + CREATE: Postgres NO permite cambiar el tipo de retorno con
--     `CREATE OR REPLACE FUNCTION`. El DROP va dentro de la misma transacción, así que
--     no hay ventana en la que la función no exista (otras sesiones esperan el lock).
--
-- (2) MNR-4 — `claim_reconciliation` acepta reclamar una fila `resolving_settle`
--     CUANDO EL LADO ES REFUND.
--     POR QUÉ (regresión introducida por 20260728000000): una fila que quedó en
--     `resolving_settle` (hop 2 desconocido) cuyo hop 1 después re-verifica
--     `not_confirmed` (reorg / desacuerdo on-chain) necesita el REFUND del budget del
--     buyer: si el hop 1 no movió, los fondos del buyer nunca salieron del escrow y el
--     débito off-chain tiene que revertirse. Antes del fix esa fila era
--     `reconciliation_pending` y el refund procedía; después quedaba en 0 filas ⇒
--     `already_resolved` ⇒ el budget del buyer NUNCA se acreditaba solo.
--     ES SEGURO por el mismo argumento que 191c ya usa para el re-claim del refund:
--     "refund : budget-only e idempotente (el crédito vive status-gated dentro de
--     record_reconciliation_resolution) → re-claim siempre seguro". El refund NO manda
--     ningún hop 2, así que esto NO re-abre el doble pago: el lado SETTLE sigue sin
--     poder reclamar `resolving_settle` sin tx previa (asimetría deliberada).
--     RESIDUO ACEPTADO Y NOMBRADO: si el hop 2 desconocido SÍ había desembolsado
--     (operador→seller) y el hop 1 no movió, el operador se come esa salida. Es
--     pérdida del OPERADOR, no un crédito indebido al buyer ni un cobro doble: las dos
--     patas son hechos independientes y el refund del buyer es correcto igual. Al
--     flipear a `resolved_refunded` la fila sale de `PENDING_STATUSES`, así que ese
--     residuo hay que buscarlo en el ledger del operador, no en `listPending()`.
--
-- (3) MNR-3 — el UPDATE de `record_debit_settle_status` agrega
--     `AND intent_id = p_intent_id`. Heredado de 191b: la función valida el ownership
--     contra `p_intent_id` pero después escribía por `(key_id, debit_nonce)` sin
--     cruzarlo, así que el intent verificado y la fila escrita podían divergir. No es
--     alcanzable hoy (la firma es 1-a-1 con el intent), es defensa en profundidad.
--
-- ROLLBACK: 20260728010000_hu198_settle_status_applied_down.sql
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
  -- y en el caso `resolving_settle` significa que la fila SIGUE auto-reclamable.
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

-- ── (2) claim_reconciliation: el lado REFUND puede reclamar resolving_settle ──
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
       -- HU-198 MNR-4: una fila parada en `resolving_settle` (hop 2 de resultado
       -- DESCONOCIDO) todavía necesita poder REEMBOLSAR al buyer si el hop 1
       -- re-verifica `not_confirmed`. Sin esta rama el débito off-chain del buyer
       -- quedaba sin acreditar para siempre. El lado SETTLE sigue excluido (no está
       -- esta condición para 'settle'), así que el re-envío ciego sigue cerrado.
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

COMMIT;
