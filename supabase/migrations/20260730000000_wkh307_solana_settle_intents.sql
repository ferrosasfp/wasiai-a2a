-- ============================================================
-- WKH-307 — IDEMPOTENCIA DURABLE DEL SETTLE SOLANA
-- El registro de "a que intentId ya se le pago y con que firma" deja de vivir en
-- un Map de proceso y pasa a esta tabla. Un restart ya no borra la respuesta a
-- "¿ya le pague a este agente?".
-- ============================================================
--
-- ⚠️ ORDEN DE RELEASE (GATE): ESTA MIGRACION SE APLICA **ANTES** DE DEPLOYAR EL CODIGO.
--
-- El orden correcto NO tiene ventana:
--   · La tabla nace vacia y NADIE la lee hasta que el codigo nuevo este arriba.
--     Comportamiento de dinero byte-identico al de hoy mientras tanto.
--   · Las 4 funciones nacen con su firma y su tipo de retorno DEFINITIVOS (las cuatro
--     devuelven la MISMA fila), asi que una migracion futura puede CREATE OR REPLACE
--     sin DROP y sin la ventana de schema-cache de PostgREST (PGRST202) que mordio a
--     20260728010000/20260728020000.
--
-- CONSECUENCIA DEL ORDEN INVERSO (codigo primero):
--   · El preflight de esquema (src/adapters/solana/schema-preflight.ts) da veredicto
--     negativo y **el leg Solana NO settlea** hasta que esta migracion este aplicada.
--     Es una degradacion RUIDOSA y RECUPERABLE, no un doble pago. Ese es exactamente
--     el punto de que el gate sea codigo y no un comentario pidiendo por favor.
--
-- ── POR QUE UNA TABLA Y NO UN Map ─────────────────────────────────────────────
--
-- Solana no tiene backstop on-chain: a diferencia de EIP-3009 —cuyo nonce
-- deterministico hace que un segundo broadcast REVIERTA en el token— un SPL transfer
-- re-transmitido se ejecuta de nuevo y paga de nuevo. Este seam de aplicacion es LA
-- UNICA defensa contra el doble pago. Un Map de proceso la pierde en cada deploy.
--
-- ── LA INVARIANTE QUE HACE RECUPERABLE EL CASO FEO (I2) ───────────────────────
--
-- El codigo firma la transaccion, PERSISTE la firma (status='signed'), y RECIEN
-- AHI transmite. Por lo tanto:
--
--   una fila en 'claimed' (sin firma) DEMUESTRA que nunca se transmitio nada.
--
-- De ahi sale que un reclamo huerfano se pueda tomar sin riesgo: no es una apuesta
-- por tiempo, es una demostracion. Y una fila 'signed' da la firma exacta para
-- preguntarle a la cadena en vez de adivinar.
--
-- ── QUE CREA ESTA MIGRACION ──────────────────────────────────────────────────
--
-- (1) TABLA a2a_solana_settle_intents. PK sobre intent_id: ES lo que hace atomico el
--     reclamo (dos requests concurrentes, un solo ganador, decidido por Postgres).
--
--     SIN owner_ref y SIN RLS — DECISION EXPLICITA, no un olvido. Es dedup GLOBAL del
--     gateway: el intentId identifica una ejecucion del propio gateway, no un objeto
--     de un tenant (el adapter ni siquiera recibe owner_ref — ver SolanaSettleRequest
--     en src/adapters/types.ts). La regla de Ownership Guard del CLAUDE.md aplica a
--     tablas CON columna de owner (a2a_agent_keys, tasks); esta no la tiene y no debe
--     tenerla. Mismo criterio que facilitator_solana_settlements y
--     facilitator_solana_release_claims. Se declara para que AR lo evalue como
--     decision y no lo encuentre como omision.
--
--     amount_atomic es TEXT, NUNCA NUMERIC (conveccion WKH-196): PostgREST devuelve
--     NUMERIC como numero JSON y JSON.parse redondea por encima de 2^53. Esa
--     precision perdida ya rompio el escrow una vez.
--
-- (2) INDICE UNIQUE PARCIAL sobre settle_signature. **NO es defensa en profundidad:
--     REPONE una proteccion que el codigo pierde.** Al dejar de usar
--     sendAndConfirmTransaction (necesario para conocer la firma ANTES de transmitir)
--     se pierde un bucle interno del SDK que re-firmaba ante firmas repetidas. Sin
--     ese bucle, dos legs del mismo run que le pagan al MISMO agente el MISMO monto
--     bajo el MISMO blockhash producen un mensaje identico ⟹ firma ed25519 IDENTICA
--     ⟹ UNA SOLA transferencia on-chain contabilizada como DOS pagos: el agente
--     cobraria la mitad y las dos filas dirian que se le pago.
--     El choque 23505 ocurre al persistir 'signed', o sea ANTES del broadcast:
--     todavia no salio nada, se re-firma con blockhash fresco y listo.
--     Es MAS fuerte que el bucle que reemplaza: aquel era un Set en memoria de la
--     Connection (por proceso, se pierde en el restart); este es durable y cross-proceso.
--     ⚠️ SI ESTE INDICE SALE SIN `UNIQUE`, LA HU DEJA EL SISTEMA PEOR QUE COMO LO ENCONTRO.
--
-- (3) CUATRO FUNCIONES plpgsql SECURITY DEFINER. Toda transicion es UNA SOLA operacion
--     que informa en su propio resultado si aplico (nunca un SELECT que decide y un
--     UPDATE que ejecuta: entre los dos entra otro proceso).
--
--     Y EL RELOJ ES EL DE POSTGRES, NO EL DE NODE. El umbral del lease se calcula con
--     now() adentro de la funcion. Si se calculara en JS y se mandara como parametro,
--     el reloj seria el del CLIENTE: dos instancias del gateway con skew tienen leases
--     distintos y la adelantada ROBA UN LEASE VIVO ⟹ dos broadcasts. Con now() hay un
--     solo reloj para todos los procesos.
--
-- (4) p_probe: cuando es true, claim_solana_settle_intent hace RAISE EXCEPTION
--     'WKH307_PROBE_OK' COMO PRIMERA SENTENCIA, antes de tocar una sola fila. Es la
--     prueba POSITIVA del preflight: recibir esa excepcion demuestra que la funcion
--     deployada es LA NUEVA (no una homonima vieja), sin escribir nada.
--
-- ── INVENTARIO OPERATIVO (no hay job de limpieza, a proposito) ────────────────
--
--   -- Reclamos posiblemente trabados (sin confirmar hace mas de 15 min)
--   SELECT intent_id, status, settle_signature, attempts, claimed_at, signed_at
--     FROM public.a2a_solana_settle_intents
--    WHERE status <> 'confirmed' AND claimed_at < now() - INTERVAL '15 minutes'
--    ORDER BY claimed_at;
--
--   -- Intents que necesitaron re-firma (colision de firma o blockhash expirado)
--   SELECT intent_id, attempts, cardinality(expired_signatures) AS expiradas
--     FROM public.a2a_solana_settle_intents
--    WHERE attempts > 1 OR cardinality(expired_signatures) > 0;
--
-- ROLLBACK: 20260730000000_wkh307_solana_settle_intents_down.sql
-- ============================================================

BEGIN;

-- ── (1) La tabla ──
CREATE TABLE IF NOT EXISTS public.a2a_solana_settle_intents (
  intent_id                TEXT        PRIMARY KEY,
  caip2                    TEXT        NOT NULL,
  pay_to                   TEXT        NOT NULL,
  -- TEXT y no NUMERIC: ver la nota de WKH-196 en la cabecera.
  amount_atomic            TEXT        NOT NULL,
  mint                     TEXT        NOT NULL,
  status                   TEXT        NOT NULL DEFAULT 'claimed'
                                       CHECK (status IN ('claimed','signed','confirmed')),
  settle_signature         TEXT        NULL,
  last_valid_block_height  BIGINT      NULL,
  -- La evidencia NO se borra: una firma que expiro sin aterrizar queda archivada.
  expired_signatures       TEXT[]      NOT NULL DEFAULT '{}',
  attempts                 INTEGER     NOT NULL DEFAULT 1,
  claimed_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  signed_at                TIMESTAMPTZ NULL,
  confirmed_at             TIMESTAMPTZ NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.a2a_solana_settle_intents IS
  'WKH-307: dedup GLOBAL del gateway para el settle Solana (sin owner_ref y sin RLS a proposito: el intent_id identifica una ejecucion del gateway, no un objeto de un tenant). Maquina claimed->signed->confirmed. Una fila claimed SIN firma demuestra que nunca se transmitio nada (invariante I2: se persiste la firma ANTES de transmitir).';

COMMENT ON COLUMN public.a2a_solana_settle_intents.amount_atomic IS
  'TEXT, NUNCA NUMERIC (WKH-196): PostgREST devuelve NUMERIC como numero JSON y JSON.parse redondea por encima de 2^53.';

COMMENT ON COLUMN public.a2a_solana_settle_intents.settle_signature IS
  'Firma base58. NOT NULL desde el estado signed. El indice UNIQUE parcial sobre esta columna repone la proteccion anti-firma-duplicada que se pierde al dejar sendAndConfirmTransaction.';

COMMENT ON COLUMN public.a2a_solana_settle_intents.last_valid_block_height IS
  'Habilita la PRUEBA "esta tx ya no puede aterrizar" (getBlockHeight() > este valor), que es como sale del estado signed sin apostar por tiempo.';

COMMENT ON COLUMN public.a2a_solana_settle_intents.expired_signatures IS
  'Historial de firmas que expiraron sin aterrizar. La evidencia de que se intento pagar no se borra nunca.';

-- ── (2) Indices ──
-- EL UNIQUE ES OBLIGATORIO. Ver el bloque (2) de la cabecera: repone una proteccion,
-- no la agrega. Parcial porque una fila en 'claimed' todavia no tiene firma y todos
-- los NULL deben poder coexistir.
CREATE UNIQUE INDEX IF NOT EXISTS ux_a2a_solana_settle_intents_signature
  ON public.a2a_solana_settle_intents (settle_signature)
  WHERE settle_signature IS NOT NULL;

-- Superficie del inventario operativo de la cabecera.
CREATE INDEX IF NOT EXISTS idx_a2a_solana_settle_intents_status_claimed_at
  ON public.a2a_solana_settle_intents (status, claimed_at);

-- La tabla se toca EXCLUSIVAMENTE a traves de las 4 funciones SECURITY DEFINER.
REVOKE ALL ON public.a2a_solana_settle_intents FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.a2a_solana_settle_intents TO service_role;

-- ── (3a) claim_solana_settle_intent — EL RECLAMO ATOMICO ──
--
-- Es la primera operacion de dinero de todo el settle. El INSERT ... ON CONFLICT DO
-- UPDATE ... WHERE ... RETURNING es UNA sola sentencia: gana uno solo y el resultado
-- mismo dice si gano. No hay ventana entre decidir y ejecutar.
--
-- El DO UPDATE solo aplica si la fila esta 'claimed' Y su lease vencio Y los terminos
-- coinciden. Todo lo demas devuelve 0 filas y se CLASIFICA con el unico SELECT
-- permitido de este diseño: el que corre DESPUES de que la escritura ya decidio que
-- no aplica. Ese SELECT no puede autorizar nada — el unico camino que devuelve
-- outcome='claimed' es el que la escritura atomica devolvio CON fila.
CREATE OR REPLACE FUNCTION public.claim_solana_settle_intent(
  p_intent_id     TEXT,
  p_caip2         TEXT,
  p_pay_to        TEXT,
  p_amount_atomic TEXT,
  p_mint          TEXT,
  p_lease_ms      INTEGER,
  p_probe         BOOLEAN DEFAULT FALSE
) RETURNS TABLE(
  applied                 BOOLEAN,
  outcome                 TEXT,
  status                  TEXT,
  settle_signature        TEXT,
  last_valid_block_height TEXT,
  attempts                INTEGER
) AS $$
DECLARE
  v_applied   BOOLEAN := FALSE;
  v_outcome   TEXT;
  v_status    TEXT;
  v_sig       TEXT;
  v_lvbh      TEXT;
  v_attempts  INTEGER;
  v_pay_to    TEXT;
  v_amount    TEXT;
  v_mint      TEXT;
BEGIN
  -- PRIMERA SENTENCIA, antes de cualquier escritura: la prueba POSITIVA del
  -- preflight. Recibir esta excepcion demuestra que la funcion deployada es la nueva.
  IF p_probe THEN
    RAISE EXCEPTION 'WKH307_PROBE_OK';
  END IF;

  INSERT INTO public.a2a_solana_settle_intents AS t (
    intent_id, caip2, pay_to, amount_atomic, mint, status
  ) VALUES (
    p_intent_id, p_caip2, p_pay_to, p_amount_atomic, p_mint, 'claimed'
  )
  ON CONFLICT (intent_id) DO UPDATE
    SET attempts   = t.attempts + 1,
        claimed_at = now(),
        updated_at = now()
    WHERE t.status = 'claimed'
      -- EL LEASE, con el reloj de POSTGRES. Un reclamo huerfano solo se toma si
      -- vencio; y tomarlo es seguro por la invariante I2 (claimed sin firma
      -- demuestra que no se transmitio nada), no porque "paso suficiente tiempo".
      AND t.claimed_at < now() - make_interval(
            secs => (p_lease_ms::numeric / 1000.0)::double precision)
      -- Los terminos del intent no pueden cambiar entre reintentos: si el caller
      -- manda otro destino/monto/mint, NO es el mismo pago (AC-8).
      AND t.pay_to        = EXCLUDED.pay_to
      AND t.amount_atomic = EXCLUDED.amount_atomic
      AND t.mint          = EXCLUDED.mint
  RETURNING TRUE,
            'claimed',
            t.status,
            t.settle_signature,
            t.last_valid_block_height::TEXT,
            t.attempts
    INTO v_applied, v_outcome, v_status, v_sig, v_lvbh, v_attempts;

  IF NOT FOUND THEN
    -- Clasificacion del perdedor. NO autoriza: ningun camino de aca abajo puede
    -- producir outcome='claimed'.
    SELECT t.status, t.settle_signature, t.last_valid_block_height::TEXT, t.attempts,
           t.pay_to, t.amount_atomic, t.mint
      INTO v_status, v_sig, v_lvbh, v_attempts, v_pay_to, v_amount, v_mint
      FROM public.a2a_solana_settle_intents t
     WHERE t.intent_id = p_intent_id;

    v_applied := FALSE;

    IF NOT FOUND THEN
      -- La fila no esta y el INSERT tampoco gano: estado imposible bajo la PK.
      -- Fail-closed — se trata como "hay algo en vuelo", nunca como via libre.
      v_outcome := 'in_progress';
    ELSIF v_pay_to IS DISTINCT FROM p_pay_to
       OR v_amount IS DISTINCT FROM p_amount_atomic
       OR v_mint   IS DISTINCT FROM p_mint THEN
      -- Los terminos mandan por encima del estado: un intent con otro destino no es
      -- este pago, aunque el anterior este confirmado.
      v_outcome := 'terms_conflict';
    ELSIF v_status = 'claimed' THEN
      -- Dentro del lease: hay otro request en vuelo que todavia no firmo.
      v_outcome := 'in_progress';
    ELSE
      -- 'signed' o 'confirmed': el caller decide con la cadena, no con la tabla.
      v_outcome := v_status;
    END IF;
  END IF;

  applied                 := v_applied;
  outcome                 := v_outcome;
  status                  := v_status;
  settle_signature        := v_sig;
  last_valid_block_height := v_lvbh;
  attempts                := v_attempts;
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── (3b) record_solana_settle_signed — PERSISTIR ANTES DE TRANSMITIR ──
--
-- Este es el paso que crea la invariante I2. Si no aplica, el caller NO transmite:
-- la transaccion firmada se descarta sin haber tocado la red.
--
-- ⚠️ El 23505 del indice UNIQUE parcial NO se atrapa aca a proposito: aflora como
-- excepcion para que el caller la distinga de "no estaba claimed" y re-firme con
-- blockhash fresco. Atraparla y devolver 'not_claimed' colapsaria dos situaciones con
-- remedios opuestos.
CREATE OR REPLACE FUNCTION public.record_solana_settle_signed(
  p_intent_id               TEXT,
  p_signature               TEXT,
  p_last_valid_block_height TEXT
) RETURNS TABLE(
  applied                 BOOLEAN,
  outcome                 TEXT,
  status                  TEXT,
  settle_signature        TEXT,
  last_valid_block_height TEXT,
  attempts                INTEGER
) AS $$
DECLARE
  v_applied  BOOLEAN := FALSE;
  v_outcome  TEXT;
  v_status   TEXT;
  v_sig      TEXT;
  v_lvbh     TEXT;
  v_attempts INTEGER;
BEGIN
  UPDATE public.a2a_solana_settle_intents t
     SET status                  = 'signed',
         settle_signature        = p_signature,
         last_valid_block_height = p_last_valid_block_height::BIGINT,
         signed_at               = now(),
         updated_at              = now()
   WHERE t.intent_id = p_intent_id
     AND t.status    = 'claimed'
  RETURNING TRUE, 'applied', t.status, t.settle_signature,
            t.last_valid_block_height::TEXT, t.attempts
    INTO v_applied, v_outcome, v_status, v_sig, v_lvbh, v_attempts;

  IF NOT FOUND THEN
    SELECT t.status, t.settle_signature, t.last_valid_block_height::TEXT, t.attempts
      INTO v_status, v_sig, v_lvbh, v_attempts
      FROM public.a2a_solana_settle_intents t
     WHERE t.intent_id = p_intent_id;
    v_applied := FALSE;
    v_outcome := 'not_claimed';
  END IF;

  applied                 := v_applied;
  outcome                 := v_outcome;
  status                  := v_status;
  settle_signature        := v_sig;
  last_valid_block_height := v_lvbh;
  attempts                := v_attempts;
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── (3c) record_solana_settle_confirmed ──
--
-- Exige que la firma coincida: confirmar "el intent" sin decir CUAL firma permitiria
-- marcar confirmado un pago distinto del que aterrizo. Acepta status 'confirmed'
-- ademas de 'signed' para que un reintento del mismo confirm sea idempotente.
CREATE OR REPLACE FUNCTION public.record_solana_settle_confirmed(
  p_intent_id TEXT,
  p_signature TEXT
) RETURNS TABLE(
  applied                 BOOLEAN,
  outcome                 TEXT,
  status                  TEXT,
  settle_signature        TEXT,
  last_valid_block_height TEXT,
  attempts                INTEGER
) AS $$
DECLARE
  v_applied  BOOLEAN := FALSE;
  v_outcome  TEXT;
  v_status   TEXT;
  v_sig      TEXT;
  v_lvbh     TEXT;
  v_attempts INTEGER;
BEGIN
  UPDATE public.a2a_solana_settle_intents t
     SET status       = 'confirmed',
         confirmed_at = now(),
         updated_at   = now()
   WHERE t.intent_id        = p_intent_id
     AND t.settle_signature = p_signature
     AND t.status IN ('signed','confirmed')
  RETURNING TRUE, 'applied', t.status, t.settle_signature,
            t.last_valid_block_height::TEXT, t.attempts
    INTO v_applied, v_outcome, v_status, v_sig, v_lvbh, v_attempts;

  IF NOT FOUND THEN
    SELECT t.status, t.settle_signature, t.last_valid_block_height::TEXT, t.attempts
      INTO v_status, v_sig, v_lvbh, v_attempts
      FROM public.a2a_solana_settle_intents t
     WHERE t.intent_id = p_intent_id;
    v_applied := FALSE;
    v_outcome := 'signature_mismatch';
  END IF;

  applied                 := v_applied;
  outcome                 := v_outcome;
  status                  := v_status;
  settle_signature        := v_sig;
  last_valid_block_height := v_lvbh;
  attempts                := v_attempts;
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── (3d) reclaim_solana_settle_intent ──
--
-- Solo se invoca cuando el caller PROBO que la firma vieja ya no puede aterrizar
-- (getBlockHeight() > last_valid_block_height). Archiva la firma en
-- expired_signatures — la evidencia no se borra — y devuelve la fila a 'claimed'
-- para que se pueda re-firmar.
CREATE OR REPLACE FUNCTION public.reclaim_solana_settle_intent(
  p_intent_id TEXT,
  p_signature TEXT
) RETURNS TABLE(
  applied                 BOOLEAN,
  outcome                 TEXT,
  status                  TEXT,
  settle_signature        TEXT,
  last_valid_block_height TEXT,
  attempts                INTEGER
) AS $$
DECLARE
  v_applied  BOOLEAN := FALSE;
  v_outcome  TEXT;
  v_status   TEXT;
  v_sig      TEXT;
  v_lvbh     TEXT;
  v_attempts INTEGER;
BEGIN
  UPDATE public.a2a_solana_settle_intents t
     SET status                  = 'claimed',
         expired_signatures      = t.expired_signatures || ARRAY[t.settle_signature],
         settle_signature        = NULL,
         last_valid_block_height = NULL,
         attempts                = t.attempts + 1,
         claimed_at              = now(),
         updated_at              = now()
   WHERE t.intent_id        = p_intent_id
     AND t.status           = 'signed'
     AND t.settle_signature = p_signature
  RETURNING TRUE, 'applied', t.status, t.settle_signature,
            t.last_valid_block_height::TEXT, t.attempts
    INTO v_applied, v_outcome, v_status, v_sig, v_lvbh, v_attempts;

  IF NOT FOUND THEN
    SELECT t.status, t.settle_signature, t.last_valid_block_height::TEXT, t.attempts
      INTO v_status, v_sig, v_lvbh, v_attempts
      FROM public.a2a_solana_settle_intents t
     WHERE t.intent_id = p_intent_id;
    v_applied := FALSE;
    v_outcome := 'not_signed';
  END IF;

  applied                 := v_applied;
  outcome                 := v_outcome;
  status                  := v_status;
  settle_signature        := v_sig;
  last_valid_block_height := v_lvbh;
  attempts                := v_attempts;
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── (4) search_path fijo + GRANTs ──
-- SECURITY DEFINER sin search_path fijo es escalable por un esquema plantado.
ALTER FUNCTION public.claim_solana_settle_intent(text, text, text, text, text, integer, boolean)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.record_solana_settle_signed(text, text, text)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.record_solana_settle_confirmed(text, text)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.reclaim_solana_settle_intent(text, text)
  SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.claim_solana_settle_intent(text, text, text, text, text, integer, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_solana_settle_signed(text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.record_solana_settle_confirmed(text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reclaim_solana_settle_intent(text, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_solana_settle_intent(text, text, text, text, text, integer, boolean)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_solana_settle_signed(text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.record_solana_settle_confirmed(text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.reclaim_solana_settle_intent(text, text)
  TO service_role;

COMMENT ON FUNCTION public.claim_solana_settle_intent(text, text, text, text, text, integer, boolean) IS
  'WKH-307: reclamo ATOMICO del derecho a transmitir un settle Solana. INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING: una sola sentencia decide y informa. outcome: claimed|in_progress|signed|confirmed|terms_conflict. p_probe=true hace RAISE WKH307_PROBE_OK como primera sentencia (preflight, sin escribir).';

-- Cerrar la ventana del schema-cache de PostgREST: las 4 funciones son nuevas, asi que
-- aca NO es defensa en profundidad — sin esto el primer rpc() puede dar PGRST202.
NOTIFY pgrst, 'reload schema';

COMMIT;
