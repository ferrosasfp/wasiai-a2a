-- ============================================================
-- HU-198 — `record_debit_settle_status` puede escribir `resolving_settle`
-- ============================================================
--
-- ⚠️ ORDEN DE RELEASE (GATE): ESTA MIGRACIÓN SE APLICA **ANTES** DE DEPLOYAR EL
-- CÓDIGO DE HU-198.
--
-- El orden correcto NO tiene ventana de riesgo: el código VIEJO nunca pasa
-- `'resolving_settle'` (sólo manda 'settled' / 'reconciliation_pending'), así que
-- ampliar el conjunto permitido es un NO-OP observable para él. Se puede aplicar con
-- el código viejo corriendo y sin coordinar.
--
-- CONSECUENCIA DEL ORDEN INVERSO (código primero) — es SILENCIOSA, que es lo peor:
--   `settleEscrowAware` intenta marcar `resolving_settle` cuando el hop 2 quedó de
--   resultado DESCONOCIDO. Sin esta migración el RPC responde `INVALID_SETTLE_STATUS`
--   y NO actualiza la fila, que se queda en `hop1_confirmed`. Ese estado SÍ es
--   auto-reclamable por `claim_reconciliation`, así que el reconciliador vuelve a
--   poder RE-ENVIAR el hop 2 sin evidencia ⟹ si el hop 2 original aterrizó, el seller
--   COBRA DOS VECES: exactamente el agujero que HU-198 cierra.
--   Mitigación parcial ya incluida en el código: `recordDebitSettleStatus`
--   (src/adapters/escrow/debit-executor.ts) ahora LOGUEA el error del RPC en vez de
--   descartarlo, así que el orden inverso deja rastro alertable. Igual: migración
--   PRIMERO.
--
-- QUÉ CAMBIA, EXACTAMENTE: una línea. El guard de `p_status` pasa de 2 a 3 valores.
-- NO se toca la tabla, NO se agrega columna, NO se agrega índice, NO se migran datos.
--   · La columna `debit_settle_status` YA acepta `resolving_settle`: el CHECK lo
--     incluye desde 191c (20260713000002, "Widen CHECK ... 3 → 7 valores").
--   · El índice parcial `idx_debit_sig_resolving` (191c) YA cubre
--     `('resolving_settle','resolving_refund')`.
--   Lo único que faltaba era el permiso de ESCRITURA desde este RPC.
--
-- POR QUÉ `resolving_settle` Y NO UN ESTADO NUEVO: el estado que hace falta ("hay un
-- hop 2 cuyo resultado no conozco: no lo re-mandes solo, pero seguí mostrándolo") ya
-- existe con esa semántica exacta:
--   · el LADO SETTLE de `claim_reconciliation` NO lo reclama sin
--     `debit_resolution_tx_hash` ⟹ el reconciliador NO auto-PAGA esa fila.
--   · Sigue en `PENDING_STATUSES` (`src/services/reconciliation.ts`) ⟹ aparece en
--     `GET /dashboard/api/reconciliation` para que un humano lo resuelva.
--
-- ⚠️ CORRECCIÓN (AR#2 MNR-3): la versión original de este header decía que el claim no lo
-- reclamaba "ni por el lado settle ni por el refund" y que "NO auto-reembolsa". Quedó
-- FALSO con la migración siguiente (20260728010000, MNR-4), que habilita el lado REFUND a
-- propósito: si el hop 1 re-verifica `not_confirmed`, el débito off-chain del buyer tiene
-- que revertirse igual, y bloquearlo era una regresión. Lo que este estado bloquea es EL
-- RE-ENVÍO del hop 2, no el reembolso.
-- Agregar un 8º valor al CHECK habría duplicado esa semántica en dos nombres.
--
-- GUARD DE TRANSICIÓN (más estricto que el resto del RPC, a propósito): el valor nuevo
-- sólo se acepta desde un estado NO resuelto (NULL / 'hop1_confirmed' /
-- 'reconciliation_pending'). Sin este guard, `resolving_settle` podría pisar un
-- `resolved_settled`/`settled` y dejar la fila varada (no la haría cobrar dos veces
-- —una fila `resolving_settle` sin tx no se reclama— pero perdería un terminal ya
-- resuelto). Los dos valores VIEJOS conservan su comportamiento byte-idéntico, sin
-- precondición de estado: esta migración NO endurece nada preexistente.
--
-- ROLLBACK: 20260728000000_hu198_settle_unknown_status_down.sql
--   (restaura el cuerpo de 191b tal cual; ver la nota de orden en ese archivo).
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
  -- HU-198: 'resolving_settle' se suma a los 2 valores de 191b.
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
     AND debit_validation_status = 'valid'
     -- HU-198: guard de transición SÓLO para el valor nuevo. Los dos valores de 191b
     -- pasan sin precondición (comportamiento preexistente intacto).
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

COMMIT;
