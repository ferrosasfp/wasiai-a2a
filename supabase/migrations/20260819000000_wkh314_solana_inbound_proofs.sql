-- ============================================================
-- WKH-314 — USO UNICO DE LAS PRUEBAS DE PAGO INBOUND EN SOLANA
-- Un tercero le paga al gateway en Solana devnet presentando la FIRMA de un SPL
-- transfer que ya aterrizo. Esa firma se puede presentar N veces y la cadena no
-- objeta nada: no hay nada que gastar de nuevo. Esta tabla es LA defensa.
-- ============================================================
--
-- ⚠️ ORDEN DE RELEASE (GATE): ESTA MIGRACION SE APLICA **ANTES** DE DEPLOYAR EL CODIGO,
-- y **A bdwv, NUNCA A caldz** (caldz es mainnet y esta PROHIBIDA).
--
-- El orden correcto no tiene ventana:
--   · La tabla nace vacia y NADIE la lee hasta que el codigo nuevo este arriba, y aun
--     entonces el camino esta apagado por flag (SOLANA_X402_INBOUND_ENABLED=false).
--   · Las 3 funciones nacen con su firma y su tipo de retorno DEFINITIVOS, asi que una
--     migracion futura puede CREATE OR REPLACE sin DROP y sin la ventana de
--     schema-cache de PostgREST (PGRST202).
--
-- CONSECUENCIA DEL ORDEN INVERSO (codigo primero):
--   · El preflight inbound (src/adapters/solana/inbound-preflight.ts) da veredicto
--     negativo y **el cobro Solana no verifica nada**: sigue saliendo el rechazo de
--     hoy. Degradacion RUIDOSA y RECUPERABLE, no servicio gratis.
--
-- ── POR QUE UNA TABLA Y NO EL ANTI-REPLAY QUE YA EXISTE ──────────────────────
--
-- `a2a_x402_nonces` (services/x402-nonce.ts) NO sirve aca por dos motivos medidos:
-- falla ABIERTO por diseño, y su justificacion escrita es que "el nonce EIP-3009 ya es
-- single-use a nivel token on-chain" — cierto en EVM y FALSO en Solana. Una prueba
-- Solana es una firma ya aterrizada: re-presentarla no revierte nada.
--
-- ── QUE CREA ESTA MIGRACION ─────────────────────────────────────────────────
--
-- (1) TABLA a2a_solana_inbound_proofs. PK sobre (caip2, signature): ESO es el uso
--     unico. No es defensa en profundidad — es LA defensa. Dos requests concurrentes
--     con la misma firma tienen exactamente un ganador, y lo decide Postgres.
--
--     SIN owner_ref y SIN RLS — DECISION EXPLICITA, no un olvido. En el camino x402
--     puro no hay identidad de caller: el pagador se identifica con su firma de pago
--     (lo dice el propio middleware: "`null` = path x402 puro: aca NO hay agent-key").
--     Es dedup GLOBAL del gateway, mismo criterio que a2a_solana_settle_intents. La
--     regla de Ownership Guard del CLAUDE.md aplica a tablas CON columna de owner;
--     esta no la tiene y no debe tenerla. Se declara para que AR lo evalue como
--     decision y no lo encuentre como omision.
--
--     amount_atomic es TEXT, NUNCA NUMERIC (convencion WKH-196): PostgREST devuelve
--     NUMERIC como numero JSON y JSON.parse redondea por encima de 2^53.
--
-- (2) TRES FUNCIONES plpgsql SECURITY DEFINER. La tabla se toca EXCLUSIVAMENTE a
--     traves de ellas. Toda transicion es UNA SOLA sentencia que informa en su propio
--     resultado si aplico (nunca un SELECT que decide y un UPDATE que ejecuta: entre
--     los dos entra otro proceso). Y el reloj es el de POSTGRES, no el de Node.
--
--     ⚠️ NINGUNA DEVUELVE BOOLEAN. Un `false` colapsa "el guard lo rechazo" / "la
--     escritura fallo" / "el store no esta", que tienen remedios DISTINTOS.
--
-- (3) p_probe en peek_solana_inbound_proof: cuando es true hace
--     RAISE EXCEPTION 'WKH314_PROBE_OK' COMO PRIMERA SENTENCIA, antes de tocar una
--     sola fila. Es la prueba POSITIVA del preflight: recibir esa excepcion demuestra
--     que la funcion deployada es LA NUEVA (no una homonima vieja), sin leer ni
--     escribir nada. Leer un catalogo no probaria lo mismo: una funcion homonima con
--     el cuerpo viejo figuraria igual.
--
--     Y la MISMA funcion con p_probe=false es la que prueba que la TABLA resuelve: un
--     peek sobre una firma centinela devuelve 0 filas si la tabla existe y 42P01 si
--     no. Por eso el peek y el probe viven juntos: son las dos preguntas del preflight
--     sobre el mismo objeto.
--
-- ── INVENTARIO OPERATIVO (no hay job de limpieza, a proposito) ───────────────
--
--   -- Pruebas observadas que nunca se consumieron (el pagador no volvio, o el
--   -- veredicto de la cadena nunca dio grant)
--   SELECT caip2, signature, resource, amount_atomic, attempts, observed_at
--     FROM public.a2a_solana_inbound_proofs
--    WHERE status = 'observed'
--    ORDER BY observed_at;
--
--   -- Pruebas cobradas: la evidencia de a quien se le sirvio
--   SELECT caip2, signature, resource, amount_atomic, consumed_at
--     FROM public.a2a_solana_inbound_proofs
--    WHERE status = 'consumed'
--    ORDER BY consumed_at DESC;
--
-- ROLLBACK: 20260819000000_wkh314_solana_inbound_proofs_down.sql
-- ============================================================

BEGIN;

-- ── (0) GATE DEL CICLO down → up (CD-14) ──
--
-- El `_down` RENOMBRA la tabla a `..._backup_wkh314` en vez de borrarla (la evidencia
-- de a quien se le sirvio no se destruye). Pero entonces re-aplicar ESTE up crea una
-- tabla NUEVA Y VACIA, y eso **borra el uso unico de toda prueba ya gastada**: cada
-- firma historica vuelve a ser presentable y compra el servicio de nuevo. Servicio
-- gratis para todo el que guarde sus firmas viejas.
--
-- El paso de re-hidratacion no puede ser prosa en un runbook: seria exactamente el
-- "gate que nadie corre". Asi que el up FALLA RUIDOSO si detecta un backup con filas
-- ya consumidas.
--
-- Las filas `observed` NO bloquean, a proposito: una prueba observada y no consumida
-- todavia no compro nada, asi que perderla no regala servicio — obliga a volver a
-- preguntarle a la cadena, que es caro pero correcto. Lo peligroso es lo YA COBRADO.
--
-- COMO DESTRABAR (re-hidratar, y recien despues re-aplicar este up):
--   INSERT INTO public.a2a_solana_inbound_proofs
--   SELECT * FROM public.a2a_solana_inbound_proofs_backup_wkh314
--   ON CONFLICT (caip2, signature) DO NOTHING;
-- (crear primero la tabla con este archivo comentando este bloque, volcar, y seguir).
DO $wkh314$
DECLARE
  v_spent INT;
BEGIN
  IF to_regclass('public.a2a_solana_inbound_proofs_backup_wkh314') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.a2a_solana_inbound_proofs_backup_wkh314 WHERE status = ''consumed'''
      INTO v_spent;
    IF v_spent > 0 THEN
      RAISE EXCEPTION 'WKH314_BACKUP_NOT_REHYDRATED: % already-consumed proofs still live in a2a_solana_inbound_proofs_backup_wkh314. Applying this migration now would create an EMPTY ledger and every one of those signatures would be spendable AGAIN: free service for each historical proof. Re-hydrate them first (see the header of this file).', v_spent;
    END IF;
  END IF;
END
$wkh314$;

-- ── (1) La tabla ──
CREATE TABLE IF NOT EXISTS public.a2a_solana_inbound_proofs (
  caip2         TEXT        NOT NULL,
  -- Firma base58 de la tx del PAGADOR. Con caip2, la PK: ESO es el uso unico.
  signature     TEXT        NOT NULL,
  reference     TEXT        NOT NULL,
  resource      TEXT        NOT NULL,
  pay_to        TEXT        NOT NULL,
  -- TEXT y no NUMERIC: ver la nota de WKH-196 en la cabecera.
  amount_atomic TEXT        NOT NULL,
  mint          TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'observed'
                            CHECK (status IN ('observed','consumed')),
  observed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at   TIMESTAMPTZ NULL,
  attempts      INTEGER     NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (caip2, signature)
);

COMMENT ON TABLE public.a2a_solana_inbound_proofs IS
  'WKH-314: uso unico de las pruebas de pago x402 inbound en Solana (sin owner_ref y sin RLS a proposito: en el camino x402 puro no hay identidad de caller, el pagador se identifica con su firma de pago). La PK (caip2, signature) NO es defensa en profundidad: es LA defensa, porque una firma Solana ya aterrizada se puede re-presentar N veces sin que la cadena objete.';

COMMENT ON COLUMN public.a2a_solana_inbound_proofs.amount_atomic IS
  'TEXT, NUNCA NUMERIC (WKH-196): PostgREST devuelve NUMERIC como numero JSON y JSON.parse redondea por encima de 2^53.';

COMMENT ON COLUMN public.a2a_solana_inbound_proofs.reference IS
  'La referencia del challenge (base58 de 32 bytes, derivada por HMAC del servidor). Va en columna aparte de la PK a proposito: el uso unico es de la FIRMA. Si el uso unico dependiera de (firma, referencia), la misma firma presentada con otra referencia seria una fila nueva y compraria el servicio otra vez.';

COMMENT ON COLUMN public.a2a_solana_inbound_proofs.status IS
  'observed = la cadena ya dio veredicto sobre esta firma (la incertidumbre se paga UNA vez por pago). consumed = se sirvio. Solo observed -> consumed, y esa transicion es la escritura condicional atomica de consume_solana_inbound_proof.';

-- Superficie del inventario operativo de la cabecera.
CREATE INDEX IF NOT EXISTS idx_a2a_solana_inbound_proofs_status_observed_at
  ON public.a2a_solana_inbound_proofs (status, observed_at);

-- La tabla se toca EXCLUSIVAMENTE a traves de las 3 funciones SECURITY DEFINER.
REVOKE ALL ON public.a2a_solana_inbound_proofs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.a2a_solana_inbound_proofs TO service_role;

-- ── (2a) record_solana_inbound_observed — PERSISTIR EL VEREDICTO DE LA CADENA ──
--
-- UNA sola sentencia: INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING.
-- El DO UPDATE solo aplica si la fila sigue 'observed' Y los terminos coinciden; todo
-- lo demas devuelve 0 filas y se CLASIFICA con el unico SELECT permitido de este
-- diseño: el que corre DESPUES de que la escritura ya decidio que no aplica. Ese
-- SELECT no puede autorizar nada.
--
-- ⚠️ LOS TERMINOS SON PARTE DE LA IDENTIDAD DEL PAGO. La misma firma presentada
-- contra otro destino, otro monto, otro mint, otra referencia u otro recurso NO ES
-- ESTE PAGO: es 'terms_conflict', que NO es replay y NO se sirve.
CREATE OR REPLACE FUNCTION public.record_solana_inbound_observed(
  p_caip2         TEXT,
  p_signature     TEXT,
  p_reference     TEXT,
  p_resource      TEXT,
  p_pay_to        TEXT,
  p_amount_atomic TEXT,
  p_mint          TEXT
) RETURNS TABLE(
  applied  BOOLEAN,
  outcome  TEXT,
  status   TEXT,
  attempts INTEGER
) AS $$
DECLARE
  v_applied   BOOLEAN := FALSE;
  v_outcome   TEXT;
  v_status    TEXT;
  v_attempts  INTEGER;
  v_reference TEXT;
  v_resource  TEXT;
  v_pay_to    TEXT;
  v_amount    TEXT;
  v_mint      TEXT;
BEGIN
  INSERT INTO public.a2a_solana_inbound_proofs AS t (
    caip2, signature, reference, resource, pay_to, amount_atomic, mint, status
  ) VALUES (
    p_caip2, p_signature, p_reference, p_resource, p_pay_to, p_amount_atomic,
    p_mint, 'observed'
  )
  ON CONFLICT (caip2, signature) DO UPDATE
    SET attempts   = t.attempts + 1,
        updated_at = now()
    WHERE t.status = 'observed'
      AND t.reference     = EXCLUDED.reference
      AND t.resource      = EXCLUDED.resource
      AND t.pay_to        = EXCLUDED.pay_to
      AND t.amount_atomic = EXCLUDED.amount_atomic
      AND t.mint          = EXCLUDED.mint
  RETURNING TRUE, 'observed', t.status, t.attempts
    INTO v_applied, v_outcome, v_status, v_attempts;

  IF NOT FOUND THEN
    SELECT t.status, t.attempts, t.reference, t.resource, t.pay_to,
           t.amount_atomic, t.mint
      INTO v_status, v_attempts, v_reference, v_resource, v_pay_to, v_amount, v_mint
      FROM public.a2a_solana_inbound_proofs t
     WHERE t.caip2 = p_caip2 AND t.signature = p_signature;

    v_applied := FALSE;

    IF NOT FOUND THEN
      -- La fila no esta y el INSERT tampoco gano: estado imposible bajo la PK.
      -- Fail-closed. NO se llama 'observed' a algo que no se pudo observar.
      v_outcome := 'not_recorded';
    ELSIF v_reference IS DISTINCT FROM p_reference
       OR v_resource  IS DISTINCT FROM p_resource
       OR v_pay_to    IS DISTINCT FROM p_pay_to
       OR v_amount    IS DISTINCT FROM p_amount_atomic
       OR v_mint      IS DISTINCT FROM p_mint THEN
      -- Los terminos mandan por encima del estado: esta firma ya se presento para
      -- OTRO pago. No es replay (el pagador no esta reintentando lo mismo) y no se
      -- sirve.
      v_outcome := 'terms_conflict';
    ELSIF v_status = 'consumed' THEN
      v_outcome := 'consumed';
    ELSE
      -- Estado imposible: 'observed' con terminos iguales lo habria tomado el
      -- DO UPDATE. Fail-closed.
      v_outcome := 'not_recorded';
    END IF;
  END IF;

  applied  := v_applied;
  outcome  := v_outcome;
  status   := v_status;
  attempts := v_attempts;
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── (2b) consume_solana_inbound_proof — EL COBRO, EXACTAMENTE UN GANADOR ──
--
-- La escritura condicional atomica. Dos presentaciones concurrentes de la misma firma
-- entran las dos a este UPDATE; el `status = 'observed'` del WHERE lo cumple UNA sola,
-- y lo decide Postgres, no este codigo ni el de Node.
--
-- ⚠️ ESTA ES LA ULTIMA OPERACION ANTES DE CONCEDER. Si esto no devuelve
-- outcome='consumed' CON applied=true, NO se sirve.
CREATE OR REPLACE FUNCTION public.consume_solana_inbound_proof(
  p_caip2         TEXT,
  p_signature     TEXT,
  p_reference     TEXT,
  p_resource      TEXT,
  p_pay_to        TEXT,
  p_amount_atomic TEXT,
  p_mint          TEXT
) RETURNS TABLE(
  applied  BOOLEAN,
  outcome  TEXT,
  status   TEXT,
  attempts INTEGER
) AS $$
DECLARE
  v_applied   BOOLEAN := FALSE;
  v_outcome   TEXT;
  v_status    TEXT;
  v_attempts  INTEGER;
  v_reference TEXT;
  v_resource  TEXT;
  v_pay_to    TEXT;
  v_amount    TEXT;
  v_mint      TEXT;
BEGIN
  UPDATE public.a2a_solana_inbound_proofs t
     SET status      = 'consumed',
         consumed_at = now(),
         updated_at  = now()
   WHERE t.caip2         = p_caip2
     AND t.signature     = p_signature
     AND t.status        = 'observed'
     AND t.reference     = p_reference
     AND t.resource      = p_resource
     AND t.pay_to        = p_pay_to
     AND t.amount_atomic = p_amount_atomic
     AND t.mint          = p_mint
  RETURNING TRUE, 'consumed', t.status, t.attempts
    INTO v_applied, v_outcome, v_status, v_attempts;

  IF NOT FOUND THEN
    SELECT t.status, t.attempts, t.reference, t.resource, t.pay_to,
           t.amount_atomic, t.mint
      INTO v_status, v_attempts, v_reference, v_resource, v_pay_to, v_amount, v_mint
      FROM public.a2a_solana_inbound_proofs t
     WHERE t.caip2 = p_caip2 AND t.signature = p_signature;

    v_applied := FALSE;

    IF NOT FOUND THEN
      -- Nadie la observo. Estado imposible en la secuencia (P6 corre antes que P7) y
      -- por lo tanto fail-closed: NO se sirve.
      v_outcome := 'not_observed';
    ELSIF v_reference IS DISTINCT FROM p_reference
       OR v_resource  IS DISTINCT FROM p_resource
       OR v_pay_to    IS DISTINCT FROM p_pay_to
       OR v_amount    IS DISTINCT FROM p_amount_atomic
       OR v_mint      IS DISTINCT FROM p_mint THEN
      v_outcome := 'terms_conflict';
    ELSIF v_status = 'consumed' THEN
      -- Ya se sirvio contra esta firma. Replay.
      v_outcome := 'already_consumed';
    ELSE
      -- 'observed' con terminos iguales lo habria tomado el UPDATE: imposible.
      v_outcome := 'not_observed';
    END IF;
  END IF;

  applied  := v_applied;
  outcome  := v_outcome;
  status   := v_status;
  attempts := v_attempts;
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── (2c) peek_solana_inbound_proof — EL PEEK Y EL PROBE, EN LA MISMA FUNCION ──
--
-- El peek (P3) NO autoriza ni impide nada por si mismo: informa. Sirve para dos cosas
-- distintas y las dos importan:
--   · una firma ya 'consumed' se rechaza SIN gastar una sola llamada al RPC;
--   · una firma ya 'observed' salta la consulta a la cadena entera (la incertidumbre
--     de la cadena se paga UNA sola vez en la vida del pago).
-- La autoridad sigue siendo consume_solana_inbound_proof, y su unica puerta es el
-- UPDATE condicional de arriba.
--
-- ⚠️ p_probe COMO PRIMERA SENTENCIA: la prueba POSITIVA del preflight, sin leer ni
-- escribir una fila. Y la MISMA funcion con p_probe=false es la que prueba que la
-- TABLA resuelve (42P01 desde el cuerpo si no existe).
CREATE OR REPLACE FUNCTION public.peek_solana_inbound_proof(
  p_caip2     TEXT,
  p_signature TEXT,
  p_probe     BOOLEAN DEFAULT FALSE
) RETURNS TABLE(
  found         BOOLEAN,
  status        TEXT,
  reference     TEXT,
  resource      TEXT,
  pay_to        TEXT,
  amount_atomic TEXT,
  mint          TEXT,
  attempts      INTEGER
) AS $$
DECLARE
  v_found     BOOLEAN := FALSE;
  v_status    TEXT;
  v_reference TEXT;
  v_resource  TEXT;
  v_pay_to    TEXT;
  v_amount    TEXT;
  v_mint      TEXT;
  v_attempts  INTEGER;
BEGIN
  -- PRIMERA SENTENCIA, antes de tocar una sola fila: la prueba POSITIVA del
  -- preflight. Recibir esta excepcion demuestra que la funcion deployada es la nueva.
  IF p_probe THEN
    RAISE EXCEPTION 'WKH314_PROBE_OK';
  END IF;

  SELECT TRUE, t.status, t.reference, t.resource, t.pay_to, t.amount_atomic,
         t.mint, t.attempts
    INTO v_found, v_status, v_reference, v_resource, v_pay_to, v_amount, v_mint,
         v_attempts
    FROM public.a2a_solana_inbound_proofs t
   WHERE t.caip2 = p_caip2 AND t.signature = p_signature;

  IF NOT FOUND THEN
    v_found := FALSE;
  END IF;

  found         := v_found;
  status        := v_status;
  reference     := v_reference;
  resource      := v_resource;
  pay_to        := v_pay_to;
  amount_atomic := v_amount;
  mint          := v_mint;
  attempts      := v_attempts;
  RETURN NEXT;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── (3) search_path fijo + GRANTs ──
-- SECURITY DEFINER sin search_path fijo es escalable por un esquema plantado.
ALTER FUNCTION public.record_solana_inbound_observed(text, text, text, text, text, text, text)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.consume_solana_inbound_proof(text, text, text, text, text, text, text)
  SET search_path = public, pg_temp;
ALTER FUNCTION public.peek_solana_inbound_proof(text, text, boolean)
  SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.record_solana_inbound_observed(text, text, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.consume_solana_inbound_proof(text, text, text, text, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.peek_solana_inbound_proof(text, text, boolean)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_solana_inbound_observed(text, text, text, text, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_solana_inbound_proof(text, text, text, text, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.peek_solana_inbound_proof(text, text, boolean)
  TO service_role;

COMMENT ON FUNCTION public.record_solana_inbound_observed(text, text, text, text, text, text, text) IS
  'WKH-314: persiste el veredicto de la cadena sobre una firma inbound. INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING: una sola sentencia decide y informa. outcome: observed|consumed(replay)|terms_conflict|not_recorded(fail-closed).';

COMMENT ON FUNCTION public.consume_solana_inbound_proof(text, text, text, text, text, text, text) IS
  'WKH-314: EL COBRO. UPDATE condicional atomico observed->consumed; exactamente un ganador, decidido por Postgres. outcome: consumed|already_consumed(replay)|not_observed(fail-closed)|terms_conflict.';

COMMENT ON FUNCTION public.peek_solana_inbound_proof(text, text, boolean) IS
  'WKH-314: peek de idempotencia (no autoriza ni impide: informa) + probe POSITIVO del preflight. p_probe=true hace RAISE WKH314_PROBE_OK como primera sentencia, sin leer ni escribir.';

-- Cerrar la ventana del schema-cache de PostgREST: las 3 funciones son nuevas, asi que
-- aca NO es defensa en profundidad — sin esto el primer rpc() puede dar PGRST202.
NOTIFY pgrst, 'reload schema';

COMMIT;
