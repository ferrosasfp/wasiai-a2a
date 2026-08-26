-- ============================================================
-- Migration: 20260823000000_wkh225_suspended_runs
-- WKH-225: un paso de /compose puede SUSPENDERSE — devolver un artefacto opaco
-- del agente (típicamente una URL a la que va una persona) y quedar esperando,
-- con estado DURABLE, en vez de tener que terminar dentro del request HTTP.
--
-- Aditiva 100%. NO toca compose / orchestrate / agent-price / agent-links. Crea:
--   - Tabla a2a_suspended_runs (estado del run; persiste SOLO SHA-256(token)).
--   - Trigger de expires_at: lo escribe POSTGRES, nunca la app (CD-19).
--   - 2 RPC atómicos (FOR UPDATE + status-gate + Ownership Guard DB-level):
--       claim_suspended_run  (suspended→resuming, single-use, cero doble-resume).
--       settle_suspended_run (resuming→resumed|suspended|failed exactly-once).
--     ⛔ NINGUNA de las dos escribe el estado `expired`: esa transición vive en
--     `suspendedRunService.expire`, en una sentencia condicional propia. Ver el
--     bloque «FIX-PACK AR/BLQ-ALTO-1» en la cabecera de `claim_suspended_run`.
--   - RLS deny-by-default (service_role bypassa por BYPASSRLS).
--   - Trigger updated_at (trigger_set_updated_at, mismo que a2a_agent_links).
--
-- Patrón: 20260706000000_wkh137_agent_links.sql (RPC FOR UPDATE + owner guard +
-- status-gate + hardening search_path/REVOKE/GRANT).
--
-- 🔴 DOS DIVERGENCIAS DELIBERADAS DE ESE EXEMPLAR, y ninguna es descuido:
--
--  1. `claim_suspended_run` recibe `p_owner_ref` y FILTRA por él, mientras que
--     `claim_agent_link` toma un solo argumento y no filtra. Es a propósito: el
--     redeem de un link es PÚBLICO (autenticado por posesión del token, el
--     redimidor es un tercero), mientras que el resume lo hace el MISMO dueño
--     que dejó el pipeline a medias. Un dueño distinto tiene que ver
--     exactamente lo que ve alguien que pide un run inexistente.
--
--  2. Cuando el dueño no coincide, el RAISE levanta EL MISMO LITERAL que "no
--     existe" (`RUN_NOT_FOUND`), no un `OWNERSHIP_MISMATCH`. Que el mensaje sea
--     idéntico es lo que hace que el 404 de arriba sea disclosure-safe DE
--     VERDAD: con un código propio, el atacante aprendería que el run existe.
-- ============================================================

-- ── Tabla a2a_suspended_runs ────────────────────────────────
CREATE TABLE IF NOT EXISTS a2a_suspended_runs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash               TEXT NOT NULL UNIQUE,          -- SHA-256(token); UNIQUE = btree O(1)
  owner_ref                TEXT NOT NULL,                 -- Ownership Guard app-layer (CD-4)
  key_id                   UUID NOT NULL REFERENCES a2a_agent_keys(id) ON DELETE CASCADE,
  -- La credencial EXACTA a la que queda atada la reanudación. Misma precedencia
  -- que el binding del token (delegación → sesión → key): el owner NO alcanza,
  -- porque el mismo dueño con otra de sus keys no debe poder reanudar.
  caller_kind              TEXT NOT NULL CHECK (caller_kind IN ('key','session','delegation')),
  caller_id                TEXT NOT NULL,
  -- Correlación con el run de compose Y clave de idempotencia del fee de
  -- protocolo (CD-18): el `request.id` del POST /compose/resume es OTRO, así que
  -- usarlo cobraría el fee dos veces por el mismo pipeline.
  compose_run_id           UUID NOT NULL,
  step_index               INT  NOT NULL CHECK (step_index >= 0),
  -- Los StepResult COMPLETOS de lo ya ejecutado, no una versión reducida: la
  -- emisión del residuo lee `downstreamTxHash`, `txHash`, `costUsdc`,
  -- `agent.slug`, `agent.registry` y `agent.payment.chain` de acá.
  steps_json               JSONB NOT NULL,
  last_output              JSONB,
  remaining_steps          JSONB NOT NULL,
  frozen_step_prices       JSONB,
  total_cost_usdc          NUMERIC(20,8) NOT NULL CHECK (total_cost_usdc >= 0),
  -- 🔴 FIX-PACK AR/BLQ-MED-1 — el techo de gasto DECLARADO POR EL CALLER.
  -- Sin esta columna, el `maxBudget` del `POST /compose` original no sobrevivía
  -- a la suspensión: el tramo reanudado corría con `maxBudget` ausente y
  -- `totalCost` en 0, así que el techo del caller Y el del operador valían UNA
  -- VEZ POR MITAD, o sea el DOBLE para un run suspendido. Se persiste junto con
  -- `total_cost_usdc` porque el guard del pipeline reanudado necesita los dos:
  -- el techo y lo que ya se gastó contra él.
  -- NULL ⇒ el caller no declaró techo (que es el 100% del tráfico de hoy), y el
  -- único que aplica es el del operador (`PIPELINE_EXPOSURE_CEILING_USD`).
  max_budget_usdc          NUMERIC(20,8) CHECK (max_budget_usdc >= 0),
  total_latency_ms         INT NOT NULL CHECK (total_latency_ms >= 0),
  -- 🔴 CD-17 — la traza del guard anti-bucle de capa 1. Sin estos tres, la
  -- reanudación arrancaría con cadena vacía y profundidad 0, o sea REINICIANDO
  -- el contador a pedido de quien reanuda: el costo exponencial que WKH-360
  -- cerró volvería a estar abierto, y el `self_host_hint` ausente dejaría los
  -- dos sitios del guard INERTES (conjunto de identidad vacío).
  contracting_chain        JSONB,
  contracting_depth        INT NOT NULL DEFAULT 0 CHECK (contracting_depth >= 0),
  self_host_hint           TEXT,
  chain_id                 INT,
  -- Espejo del CHECK del exemplar CON UN ESTADO MÁS: `expired` es terminal y
  -- DISTINGUIBLE de `failed`, porque el residuo se emite SÓLO en la transición
  -- a `expired` y esa transición sólo puede ocurrir una vez.
  status                   TEXT NOT NULL DEFAULT 'suspended'
                           CHECK (status IN ('suspended','resuming','resumed','failed','expired')),
  -- El rango lo hace cumplir la BASE, no un comentario. El piso es el techo de
  -- wall-clock del propio /compose más un segundo; el techo, las 24 h que este
  -- repo ya eligió dos veces para credenciales con las que una persona vuelve.
  ttl_seconds              INT NOT NULL CHECK (ttl_seconds BETWEEN 181 AND 86400),
  -- CD-15: instante en que vence la garantía del quote que congeló los precios
  -- de este run, si hubo. Es una ENTRADA del trigger de abajo, no el
  -- vencimiento: el `LEAST` lo toma Postgres.
  frozen_prices_expires_at TIMESTAMPTZ,
  -- 🔴 CD-19: LO ESCRIBE EL TRIGGER, NUNCA LA APP. En la LECTURA los dos lados
  -- del `NOW() >= v_expires` salen del mismo reloj (Postgres), así que un skew
  -- entre Node y la base no puede volver reanudable un run vencido. El único
  -- punto donde ese skew se colaría es la ESCRITURA — que es justo lo que el
  -- exemplar hace en Node y acá NO se replica.
  expires_at               TIMESTAMPTZ NOT NULL,
  resumed_at               TIMESTAMPTZ,
  error_message            TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_a2a_suspended_runs_key_owner ON a2a_suspended_runs (key_id, owner_ref);
CREATE INDEX IF NOT EXISTS idx_a2a_suspended_runs_owner     ON a2a_suspended_runs (owner_ref);
CREATE INDEX IF NOT EXISTS idx_a2a_suspended_runs_status    ON a2a_suspended_runs (status);
CREATE INDEX IF NOT EXISTS idx_a2a_suspended_runs_expires   ON a2a_suspended_runs (expires_at);

-- ── RLS deny-by-default (patrón WKH-SEC-02, SIN policy permisiva) ──
-- service_role bypassa por BYPASSRLS; anon/authenticated → deny-all.
ALTER TABLE a2a_suspended_runs
  ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Trigger de expires_at (CD-19). La app manda `ttl_seconds`; el INSTANTE lo
-- calcula la base con SU reloj. Con CD-15, si el run llevaba precios
-- congelados, se toma el LEAST contra el vencimiento de esa garantía: un
-- pipeline reanudado NUNCA debita un precio congelado cuya garantía venció.
--
-- BEFORE INSERT y no BEFORE INSERT OR UPDATE a propósito: el vencimiento se fija
-- UNA vez, al abrir. Recalcularlo en cada UPDATE haría que el propio claim
-- —que es un UPDATE— corriera el vencimiento hacia adelante.
-- ============================================================
CREATE OR REPLACE FUNCTION trigger_set_suspended_run_expires_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.expires_at := now() + make_interval(secs => NEW.ttl_seconds);
  -- 🔴 FIX-PACK AR/MNR-4 — EL `LEAST` SOLO SE TOMA SI LA GARANTÍA SIGUE VIVA.
  --
  -- Sin el `> now()`, un `frozen_prices_expires_at` YA VENCIDO producía una fila
  -- que NACÍA VENCIDA (medido contra Postgres 16: `expires_at < created_at`), y
  -- el caller recibía un 202 con un token irredimible DESPUÉS de que el step ya
  -- había cobrado. Cerrarlo con un piso artificial (`GREATEST(..., now()+1s)`)
  -- sería peor: dejaría vivo un run que debitaría precios congelados cuya
  -- garantía venció, que es exactamente lo que CD-15 prohíbe.
  --
  -- La salida correcta es la de abajo: si la garantía ya venció, el run vive su
  -- TTL completo pero SIN precios congelados. La cola se debita a precio VIVO,
  -- que es lo que significa un quote vencido, y CD-15 se cumple literalmente —
  -- ningún precio congelado se debita después de que su garantía expiró.
  IF NEW.frozen_prices_expires_at IS NOT NULL THEN
    IF NEW.frozen_prices_expires_at > now() THEN
      NEW.expires_at := LEAST(NEW.expires_at, NEW.frozen_prices_expires_at);
    ELSE
      NEW.frozen_step_prices       := NULL;
      NEW.frozen_prices_expires_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION public.trigger_set_suspended_run_expires_at()
  SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS set_a2a_suspended_runs_expires_at ON a2a_suspended_runs;
CREATE TRIGGER set_a2a_suspended_runs_expires_at
  BEFORE INSERT ON a2a_suspended_runs
  FOR EACH ROW EXECUTE FUNCTION trigger_set_suspended_run_expires_at();

-- ── updated_at trigger (reusa trigger_set_updated_at, igual que a2a_agent_links) ──
DROP TRIGGER IF EXISTS set_a2a_suspended_runs_updated_at ON a2a_suspended_runs;
CREATE TRIGGER set_a2a_suspended_runs_updated_at
  BEFORE UPDATE ON a2a_suspended_runs
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ============================================================
-- RPC 1: claim_suspended_run
-- Transición atómica suspended→resuming bajo FOR UPDATE (single-use). N resumes
-- concurrentes: sólo el primero gana el lock con status='suspended' y lo
-- transiciona; los demás pierden el lock-race, releen status<>'suspended' →
-- RUN_ALREADY_USED. Cero doble-resume garantizado por el lock + status-gate.
--
-- 🔴 EL ORDEN DE LOS GUARDS ES LOAD-BEARING:
--   1. lock por token_hash; NOT FOUND → RUN_NOT_FOUND;
--   2. dueño distinto → RUN_NOT_FOUND, EL MISMO LITERAL (disclosure-safe);
--   3. suspendido y vencido → RUN_EXPIRED, SIN ESCRIBIR NADA;
--   4. ya registrado como `expired` → RUN_EXPIRED también (mismo desenlace para
--      el caller en el 1er intento y en el N-ésimo);
--   5. cualquier otro estado → RUN_ALREADY_USED;
--   6. recién ahora, el claim.
-- Invertir 2 y 3 filtraría la existencia del run por el código de error.
--
-- ⛔⛔ FIX-PACK AR/BLQ-ALTO-1 — POR QUÉ EL GUARD 3 **NO** ESCRIBE, Y NO PUEDE.
--
-- Esta función tenía, entre el guard 3 y su `RAISE`, un
-- `UPDATE … SET status = 'expired'`. Un `RAISE EXCEPTION` sin bloque `EXCEPTION`
-- que lo atrape ABORTA LA TRANSACCIÓN ENTERA, y PostgREST corre cada `rpc()` en
-- una transacción propia: ese UPDATE se DESCARTABA siempre. Medido contra
-- Postgres 16 con la migración aplicada tal cual — tres claims seguidos sobre
-- una fila vencida dejaban el status en `suspended` las tres veces, o sea que
-- `expired` era un estado INALCANZABLE y cada intento volvía a emitir el residuo
-- de plata varada. Un caller autenticado podía encender la alerta de
-- `/health` a voluntad repitiendo el mismo token vencido.
--
-- ⛔ "Escribir y levantar" NO se arregla reordenando ni agregando un
-- `EXCEPTION WHEN OTHERS`: si la función no levanta, el service no puede
-- distinguir el desenlace por el mensaje, que es el contrato que este repo usa
-- (`key-session.ts` / `agent-link.ts`). La transición vive AFUERA, en una
-- sentencia propia y CONDICIONAL (`… WHERE status = 'suspended'`), que es lo
-- que hace que "exactamente un residuo" sea una propiedad del MOTOR y no una
-- promesa: la segunda pasada afecta 0 filas y no emite nada. La escribe
-- `suspendedRunService.expire` (`src/services/suspended-run.ts`).
--
-- El exemplar hace lo mismo y lo dice: `20260706000000_wkh137_agent_links.sql`
-- (`-- open + expirado → LINK_EXPIRED (no consume)`), sin UPDATE antes del RAISE.
-- ============================================================
CREATE OR REPLACE FUNCTION claim_suspended_run(
  p_token_hash TEXT,
  p_owner_ref  TEXT
) RETURNS TABLE(
  id                 UUID,
  owner_ref          TEXT,
  key_id             UUID,
  caller_kind        TEXT,
  caller_id          TEXT,
  compose_run_id     UUID,
  step_index         INT,
  steps_json         JSONB,
  last_output        JSONB,
  remaining_steps    JSONB,
  frozen_step_prices JSONB,
  -- 🔴 FIX-PACK AR/MNR-3 — TEXT, no NUMERIC (doctrina WKH-196). PostgREST
  -- entrega los NUMERIC como número JSON y `JSON.parse` los redondea. El resto
  -- de esta misma HU ya lo aplicaba (`suspended-run.ts` y `reconciliation.ts`
  -- seleccionan `total_cost_usdc::text`); esta función era la divergencia, y
  -- `SuspendedRunClaim.total_cost_usdc: string` ya declaraba lo que acá no
  -- pasaba. El `::text` está en el `RETURN QUERY` de abajo.
  total_cost_usdc    TEXT,
  max_budget_usdc    TEXT,
  total_latency_ms   INT,
  contracting_chain  JSONB,
  contracting_depth  INT,
  self_host_hint     TEXT,
  chain_id           INT
) AS $$
DECLARE
  v_id       UUID;
  v_owner    TEXT;
  v_status   TEXT;
  v_expires  TIMESTAMPTZ;
BEGIN
  SELECT r.id, r.owner_ref, r.status, r.expires_at
    INTO v_id, v_owner, v_status, v_expires
    FROM a2a_suspended_runs r
    WHERE r.token_hash = p_token_hash
    FOR UPDATE;
  IF NOT FOUND THEN
    -- ⛔ El token NO entra al mensaje (CD-8): es la credencial.
    RAISE EXCEPTION 'RUN_NOT_FOUND';
  END IF;

  -- Ownership Guard DB-level. MISMO literal que "no existe", a propósito.
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'RUN_NOT_FOUND';
  END IF;

  -- suspendido + vencido → RUN_EXPIRED. ⛔ SIN ESCRIBIR: ver la cabecera. La
  -- marca durable la aplica `suspendedRunService.expire` en una sentencia propia
  -- y condicional, porque este `RAISE` descarta todo lo que se escriba acá.
  -- El reloj del vencimiento es el de POSTGRES en los DOS lados (CD-19).
  IF v_status = 'suspended' AND NOW() >= v_expires THEN
    RAISE EXCEPTION 'RUN_EXPIRED';
  END IF;

  -- Ya REGISTRADO como vencido. Mismo literal que el guard de arriba a
  -- propósito: el caller que reintenta con un token vencido tiene que recibir
  -- el MISMO 410 la primera vez y la décima, y no un 409 que le diga que el run
  -- "se usó" cuando lo que pasó es que se le venció. Que el residuo no se
  -- vuelva a emitir NO depende de este mensaje: depende de que el UPDATE
  -- condicional de `expire` afecte 0 filas.
  IF v_status = 'expired' THEN
    RAISE EXCEPTION 'RUN_EXPIRED';
  END IF;

  -- ya en uso / terminal (incluye el 2º resume concurrente que perdió el lock).
  --
  -- ⚠️ LÍMITE CONOCIDO, DECLARADO Y NO CERRADO EN ESTE CORTE (AR/MNR-6): un run
  -- que muere en `resuming` —proceso caído entre el claim y el settle— cae acá
  -- para siempre. No vence (el guard de vencimiento exige `suspended`) y por lo
  -- tanto nunca deja constancia del pago varado de su primera mitad.
  --
  -- 🔴 FIX-PACK AR/MNR-11 — LA RAZÓN QUE ESTABA ESCRITA ACÁ ERA FALSA. Decía
  -- que bajar el guard a `resuming` dejaría que un claim concurrente marcara
  -- `expired` un run EN EJECUCIÓN. Eso ya no puede pasar: desde el fix-pack de
  -- BLQ-ALTO-1 esta función NO transiciona nada, y el único escritor de
  -- `expired` es el `UPDATE … WHERE status = 'suspended'` de
  -- `suspendedRunService.expire` (`src/services/suspended-run.ts`), que sobre un
  -- run en `resuming` afecta 0 FILAS — y sin fila no hay residuo emitido.
  --
  -- Lo que un guard más laxo cambiaría de verdad es el CÓDIGO que ve el segundo
  -- caller: un 410 RUN_EXPIRED en vez del 409 RUN_ALREADY_USED que le
  -- corresponde a un run que otro proceso está reanudando. Molesto y engañoso,
  -- no destructivo.
  --
  -- LA DECISIÓN NO CAMBIA, y el motivo verdadero es que un guard laxo no
  -- ARREGLA nada: no marcaría la fila, no emitiría el residuo que MNR-6 echa de
  -- menos, y a cambio degradaría un código de error correcto. El remedio sigue
  -- siendo un barrido con antigüedad mínima (NC-3 / TD-225-01, fuera de scope
  -- del corte A), que es lo único que distingue un run abandonado de uno que se
  -- está reanudando ahora mismo.
  --
  -- Y el estado actual NO es invisible para el operador: `listSuspendedRuns`
  -- (`src/services/reconciliation.ts`) no filtra por status, así que un run
  -- atascado en `resuming` aparece en el reporte admin. La pérdida real es la
  -- que MNR-6 nombra: no hay residuo automático.
  IF v_status <> 'suspended' THEN
    RAISE EXCEPTION 'RUN_ALREADY_USED';
  END IF;

  UPDATE a2a_suspended_runs SET status = 'resuming'
    WHERE a2a_suspended_runs.id = v_id;

  RETURN QUERY
    SELECT r.id, r.owner_ref, r.key_id, r.caller_kind, r.caller_id,
           r.compose_run_id, r.step_index, r.steps_json, r.last_output,
           r.remaining_steps, r.frozen_step_prices,
           r.total_cost_usdc::text, r.max_budget_usdc::text,
           r.total_latency_ms, r.contracting_chain, r.contracting_depth,
           r.self_host_hint, r.chain_id
      FROM a2a_suspended_runs r
      WHERE r.id = v_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.claim_suspended_run(text, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.claim_suspended_run(text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_suspended_run(text, text)
  TO service_role;

-- ============================================================
-- RPC 2: settle_suspended_run
-- Cierre exactly-once de un run 'resuming' (idempotente + Ownership Guard).
--   p_outcome = 'resumed' → status=resumed + resumed_at.
--   p_outcome = 'reopen'  → status=suspended (SOLO desde guards PRE-débito).
--   p_outcome = <otro>    → status=failed + error_message (terminal, NO reabrir).
-- El status-gate (IF v_status <> 'resuming' THEN RETURN) da idempotencia: un
-- segundo settle sobre un run ya terminal es no-op → cero doble-escritura.
--
-- ⛔ `reopen` SÓLO desde guards que corren ANTES de cualquier débito o invoke de
-- los steps restantes. Todo lo que pase después es terminal (`failed`) y nunca
-- se reabre. Es la MISMA decisión que tomó WKH-137 para su settle, no una nueva:
-- reabrir después de un débito ambiguo es ofrecer un segundo cobro.
--
-- ⚠️ El `reopen` NO reescribe `expires_at`: el vencimiento se fijó al abrir y
-- reabrir no compra tiempo. Si el run ya venció, el próximo claim lo marca
-- `expired` como corresponde.
-- ============================================================
CREATE OR REPLACE FUNCTION settle_suspended_run(
  p_id        UUID,
  p_owner_ref TEXT,
  p_outcome   TEXT,
  p_error     TEXT
) RETURNS void AS $$
DECLARE
  v_owner  TEXT;
  v_status TEXT;
BEGIN
  SELECT owner_ref, status
    INTO v_owner, v_status
    FROM a2a_suspended_runs
    WHERE id = p_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RUN_NOT_FOUND';
  END IF;
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    -- 🔴 FIX-PACK AR/MNR-7 — SIN el `p_id` en el mensaje. El claim se cuida de
    -- no discriminar (mismo literal para "no existe" y "dueño ajeno"); esta
    -- función interpolaba el id del run en el error, que es la asimetría que el
    -- propio archivo declara evitar. Hoy es inalcanzable (el único caller pasa
    -- el `owner_ref` que el claim ya validó), y por eso mismo el mensaje no le
    -- sirve a nadie: cuando aparezca, aparecerá en un log de PostgREST.
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH';
  END IF;

  -- Idempotencia exactly-once: sólo se cierra una transición 'resuming'.
  IF v_status <> 'resuming' THEN
    RETURN;
  END IF;

  IF p_outcome = 'resumed' THEN
    UPDATE a2a_suspended_runs
      SET status = 'resumed', resumed_at = now()
      WHERE id = p_id;
  ELSIF p_outcome = 'reopen' THEN
    UPDATE a2a_suspended_runs SET status = 'suspended' WHERE id = p_id;
  ELSE
    UPDATE a2a_suspended_runs
      SET status = 'failed', error_message = p_error
      WHERE id = p_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.settle_suspended_run(uuid, text, text, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.settle_suspended_run(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_suspended_run(uuid, text, text, text)
  TO service_role;
