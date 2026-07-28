-- ============================================================
-- HU-202 — LEASE DEL HOP 2: el re-envío al seller deja de salir sin evidencia
-- persistida de que el hop 2 no se intentó. Cierra TD-198-01 (casos B, C, F, G).
-- ============================================================
--
-- ⚠️ ORDEN DE RELEASE (GATE): ESTA MIGRACIÓN SE APLICA **ANTES** DE DEPLOYAR EL CÓDIGO,
-- y DESPUÉS de 20260728020000 (cuyo cuerpo de `record_debit_settle_status` esta
-- migración reescribe COMPLETO y por lo tanto tiene que reproducir).
--
-- El orden correcto NO tiene ventana:
--   · La firma (5 args) y el tipo de retorno de `record_debit_settle_status` NO cambian
--     ⟹ `CREATE OR REPLACE` sin `DROP` ⟹ NO hay ventana de schema-cache de PostgREST
--     (`PGRST202`), que es la que mordió a 20260728010000/20260728020000.
--   · Sin código nuevo NADIE estampa `debit_hop2_attempted_at`, así que la columna queda
--     NULL en el 100% de las filas y la rama nueva del `WHERE` de `claim_reconciliation`
--     no excluye NADA. Comportamiento de dinero byte-idéntico al de hoy.
--
-- CONSECUENCIA DEL ORDEN INVERSO (código primero):
--   · `record_debit_settle_status` viejo no conoce la columna, así que NO estampa ni
--     limpia. El lease igual se toma —el flip a `resolving_settle` es escribible desde
--     20260728000000 y es el status lo que bloquea el claim— o sea que **el caso F sigue
--     cerrado**. Lo que falta es el guard INDEPENDIENTE del status y la edad en la
--     superficie (`hop2_attempted_at` sale NULL). Es una DEGRADACIÓN, no un agujero nuevo.
--   · `claim_reconciliation` viejo: sin la rama del stamp, la refusal del lado settle queda
--     colgando sólo del status. Mismo razonamiento.
--
-- ── EL AGUJERO QUE CIERRA ─────────────────────────────────────────────────────
--
-- `record_debit_hop1` (191b) escribe `debit_settle_status='hop1_confirmed'` ANTES de que el
-- hop 2 se intente, y `settleEscrowAware` deja la fila así durante TODA la ventana del hop 2
-- (`sign` + `/settle` con techo de 30s + re-verify). El `WHERE` de `claim_reconciliation`
-- acepta `hop1_confirmed` para el lado SETTLE ⟹ un click en
-- `POST /dashboard/api/reconciliation/:id/resolve` —o un barrido concurrente— durante un
-- settle lento NORMAL re-envía el hop 2 y **paga dos veces al seller, con el proceso vivo y
-- sano**. No hace falta que nada se caiga. Es el caso (F) de TD-198-01.
--
-- El reconciliador YA tiene la disciplina que le falta al camino normal: su propio
-- `claim_reconciliation` flipea a `resolving_settle` ANTES de re-enviar. O sea que **el claim
-- ES el lease**. Esta migración le da al camino normal el mismo hecho persistido.
--
-- ── QUÉ CAMBIA ────────────────────────────────────────────────────────────────
--
-- (1) COLUMNA NUEVA `debit_hop2_attempted_at TIMESTAMPTZ` (aditiva, nullable).
--     ES EL HECHO QUE FALTABA: "el hop 2 se intentó, y a esta hora". Dos usos, los dos
--     load-bearing:
--       · GUARD independiente del status (ver (3)): si alguien en el futuro baja el status
--         a `hop1_confirmed`/`reconciliation_pending` con un hop 2 de resultado desconocido
--         encima, el re-envío sigue bloqueado. El candado deja de depender de que ningún
--         caller se equivoque con un string.
--       · EDAD en la superficie: una fila `resolving_settle` de hace 2 segundos es un settle
--         EN VUELO sano; una de hace 40 minutos es plata parada. Sin timestamp las dos se
--         ven igual y la lista se vuelve ruido que nadie mira — el modo de falla exacto que
--         HU-201 documentó ("un estado que no auto-actúa y que nadie lista es plata retenida
--         en silencio").
--
-- (2) `record_debit_settle_status` estampa y LIMPIA la columna según el status escrito:
--       · `resolving_settle`      → stamp = now()  (TOMA el lease)
--       · `reconciliation_pending`→ stamp = NULL   (LIBERA el lease)
--       · `settled`               → stamp intacto  (auditoría del terminal)
--     ⚠️ POR QUÉ `reconciliation_pending` LIMPIA, y por qué NO es un agujero: ese status
--     significa EXACTAMENTE "el reconciliador puede tomar esto y re-enviar", y su único
--     escritor tras un hop 2 es la rama `unequivocal` — el veredicto que el repo ya trata
--     como "probado que no se ejecutó" (`isHop2ResultUnknown`). Si NO se limpiara, el guard
--     de (3) dejaría al caso (D) —el rechazo NORMAL del facilitator— sin re-envío
--     automático ⟹ **el seller sin cobrar y nadie mirando esas filas**. Sobre-corregir acá
--     es tan caro como no corregir.
--     ⚠️ RESIDUO HEREDADO, NO ARREGLADO ACÁ: `unequivocal` incluye un `2xx {success:false}`
--     SIN txHash, que es una LECTURA de la semántica de un tercero, no una prueba (ver
--     TD-201-03). El lease hereda esa inferencia tal cual.
--     NO se agrega ningún parámetro: la firma queda idéntica a propósito (ver el gate de
--     orden de arriba — un parámetro nuevo forzaría un DROP+CREATE y la ventana PGRST202).
--
-- (3) `claim_reconciliation`: el lado SETTLE no reclama una fila con un hop 2 estampado y
--     sin `debit_resolution_tx_hash`, CUALQUIERA SEA SU STATUS; y estampa al reclamar
--     (su propio re-envío también es un intento de hop 2, así que la columna nunca miente).
--     El lado REFUND NO se toca: sigue pudiendo reclamar `resolving_settle` (rama MNR-4 de
--     HU-198). La asimetría es el punto — el refund es budget-only, idempotente y no manda
--     ningún hop 2, así que no puede doble-pagar.
--
-- ── QUÉ **NO** CIERRA (declarado) ─────────────────────────────────────────────
--   · Los casos (A) y (D) siguen re-enviando SIN prueba dura de que el hop 2 no pagó. Esta
--     migración los vuelve DISTINGUIBLES de (B)/(C)/(F)/(G); no convierte la inferencia de
--     (D) en prueba. Eso es TD-201-01 (lector de `authorizationState`) y el agujero (a) del
--     nonce determinístico (en modo `pieverse`, el DEFAULT, la firma no es un
--     `TransferWithAuthorization` contra el token).
--   · Filas que YA estaban en `hop1_confirmed` cuando esto se aplica siguen siendo
--     auto-reclamables: nadie persistió evidencia de su hop 2 y esta migración no la puede
--     inventar retroactivamente. Inventario:
--       SELECT intent_id, debit_settle_status, debit_hop1_confirmed_at
--         FROM a2a_payment_intent_debit_signatures
--        WHERE debit_settle_status = 'hop1_confirmed'
--          AND debit_hop2_attempted_at IS NULL;
--
-- ROLLBACK: 20260729000000_hu202_hop2_lease_down.sql
-- ============================================================

BEGIN;

-- ── (1) La columna del hecho persistido (aditiva, nullable, sin default) ──
ALTER TABLE a2a_payment_intent_debit_signatures
  ADD COLUMN IF NOT EXISTS debit_hop2_attempted_at TIMESTAMPTZ;

COMMENT ON COLUMN a2a_payment_intent_debit_signatures.debit_hop2_attempted_at IS
  'HU-202: cuando se INTENTO el hop 2 (operador->seller). NOT NULL + debit_resolution_tx_hash NULL = intento de resultado DESCONOCIDO: el lado settle de claim_reconciliation NO lo reclama. Se limpia al escribir reconciliation_pending (veredicto unequivocal = probado que no se ejecuto).';

-- Superficie: las filas leaseadas sin resolver, que es lo que el operador tiene que ver.
CREATE INDEX IF NOT EXISTS idx_debit_sig_hop2_attempted
  ON a2a_payment_intent_debit_signatures (debit_hop2_attempted_at)
  WHERE debit_hop2_attempted_at IS NOT NULL AND debit_resolution_tx_hash IS NULL;

-- ── (2) record_debit_settle_status: toma / libera el lease ──
-- Cuerpo completo de 20260728020000 + el CASE del stamp. Firma y RETURNS idénticos
-- ⟹ CREATE OR REPLACE, sin DROP, sin ventana de schema-cache.
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
     SET debit_settle_status = p_status,
         -- HU-202: el hecho persistido del hop 2. `resolving_settle` TOMA el lease,
         -- `reconciliation_pending` lo LIBERA (veredicto unequivocal), `settled` lo
         -- preserva para auditoría del terminal.
         debit_hop2_attempted_at = CASE
           WHEN p_status = 'resolving_settle'       THEN now()
           WHEN p_status = 'reconciliation_pending' THEN NULL
           ELSE debit_hop2_attempted_at
         END
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

-- ── (3) claim_reconciliation: el lado settle respeta el lease ──
-- Cuerpo completo de 20260728010000 (incluida la rama refund de MNR-4) + el guard del
-- stamp + el stamp propio del re-envío del reconciliador.
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
     SET debit_settle_status = v_target,
         -- HU-202: el re-envío del reconciliador TAMBIÉN es un intento de hop 2. Si no se
         -- estampara, la columna diría "nunca se intentó" sobre una fila a la que el
         -- reconciliador le acaba de mandar un pago, y el guard de abajo sería una
         -- afirmación falsa. El lado refund no manda hop 2 ⟹ no estampa.
         debit_hop2_attempted_at = CASE
           WHEN p_side = 'settle' THEN now()
           ELSE debit_hop2_attempted_at
         END
   WHERE key_id = p_key_id
     AND debit_nonce = p_nonce
     AND debit_validation_status = 'valid'
     -- HU-202 — GUARD DEL LEASE, INDEPENDIENTE DEL STATUS. Un hop 2 estampado y sin tx
     -- de resolución es un intento de resultado DESCONOCIDO: re-enviarlo puede pagar dos
     -- veces al seller. Vale cualquiera sea el `debit_settle_status`, así que el candado
     -- ya no cuelga de que ningún caller baje el status por error. El lado REFUND es
     -- inmune (budget-only, idempotente, no manda hop 2).
     AND (
       p_side = 'refund'
       OR debit_hop2_attempted_at IS NULL
       OR debit_resolution_tx_hash IS NOT NULL
     )
     AND (
       debit_settle_status IN ('hop1_confirmed','reconciliation_pending')
       OR (
         debit_settle_status = v_target
         AND (p_side = 'refund' OR debit_resolution_tx_hash IS NOT NULL)
       )
       -- HU-198 MNR-4: una fila parada en `resolving_settle` (hop 2 de resultado
       -- DESCONOCIDO) todavía necesita poder REEMBOLSAR al buyer si el hop 1
       -- re-verifica `not_confirmed`. Sin esta rama el débito off-chain del buyer
       -- quedaba sin acreditar para siempre. El lado SETTLE sigue excluido, así que
       -- el re-envío ciego sigue cerrado.
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

-- Cerrar explícitamente la ventana del schema-cache de PostgREST (MNR-5 de HU-198). Acá
-- la firma no cambia, así que es defensa en profundidad, no un requisito.
NOTIFY pgrst, 'reload schema';

COMMIT;
