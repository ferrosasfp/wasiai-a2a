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
  IF NEW.frozen_prices_expires_at IS NOT NULL THEN
    NEW.expires_at := LEAST(NEW.expires_at, NEW.frozen_prices_expires_at);
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
--   3. suspendido y vencido → marcar `expired` EN LA MISMA TRANSACCIÓN y
--      RUN_EXPIRED. La transición y el raise JUNTOS son lo que hace que se emita
--      EXACTAMENTE UN residuo: la fila sólo puede pasar suspended→expired una
--      vez, así que un segundo intento cae en el guard 4 y no vuelve a emitir;
--   4. cualquier otro estado → RUN_ALREADY_USED;
--   5. recién ahora, el claim.
-- Invertir 2 y 3 filtraría la existencia del run por el código de error.
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
  total_cost_usdc    NUMERIC,
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

  -- suspendido + vencido → terminal `expired` en ESTA transacción, y raise.
  IF v_status = 'suspended' AND NOW() >= v_expires THEN
    UPDATE a2a_suspended_runs
      SET status = 'expired'
      WHERE a2a_suspended_runs.id = v_id;
    RAISE EXCEPTION 'RUN_EXPIRED';
  END IF;

  -- ya en uso / terminal (incluye el 2º resume concurrente que perdió el lock,
  -- y el 2º intento sobre uno ya marcado `expired`).
  IF v_status <> 'suspended' THEN
    RAISE EXCEPTION 'RUN_ALREADY_USED';
  END IF;

  UPDATE a2a_suspended_runs SET status = 'resuming'
    WHERE a2a_suspended_runs.id = v_id;

  RETURN QUERY
    SELECT r.id, r.owner_ref, r.key_id, r.caller_kind, r.caller_id,
           r.compose_run_id, r.step_index, r.steps_json, r.last_output,
           r.remaining_steps, r.frozen_step_prices, r.total_cost_usdc,
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
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: run % not owned by caller', p_id;
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
