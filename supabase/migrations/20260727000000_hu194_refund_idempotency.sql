-- ============================================================
-- Migration: 20260727000000_hu194_refund_idempotency
-- HU-194 — el refund-outbox podía ACREDITAR DOS VECES.
--
-- PROBLEMA (camino de EXCEPCIÓN, no cubierto por A2/M6):
--   `refund_a2a_key_spend` COMMITEA y la respuesta se pierde (socket reset,
--   timeout post-commit, pod matado). `budgetService.credit` rechaza →
--   el call-site entra al `catch` → encola en `a2a_refund_outbox` →
--   `processRefundOutbox` reintenta el credit → EL CALLER RECIBE EL MONTO DOS
--   VECES y su budget queda inflado.
--   El invariante declarado en `src/services/refund-outbox.ts` ("SOLO se encola
--   cuando NADA se aplicó") es demostrable para `success:false` (el check de
--   filas de A2, 20260625000000) pero NO para la excepción: ahí el error puede
--   ser del READ de la respuesta, no de la ACCIÓN. Misma ambigüedad que resolvió
--   HU-192 para el transfer gasless.
--
-- POR QUÉ UNA CLAVE SÓLO EN EL OUTBOX NO ALCANZA:
--   Si la dedup vive únicamente en `a2a_refund_outbox`, el crédito ORIGINAL (el
--   que commiteó y cuya respuesta se perdió) NO dejó ningún rastro con esa clave
--   → el reintento del sweep sería la PRIMERA fila con esa clave → se aplicaría
--   igual. El rastro tiene que quedar en la MISMA transacción que mueve el
--   dinero, del lado de Postgres. De ahí este diseño.
--
-- FIX (3 piezas):
--   1. `a2a_refund_applications`: ledger de refunds APLICADOS, con
--      `idem_key` como PRIMARY KEY. La fila se inserta en la MISMA transacción
--      que acredita el budget → si el UPDATE commiteó, el marcador commiteó.
--   2. `refund_idem_claim(...)`: TRUE si esta llamada reclamó la clave (hay que
--      aplicar), FALSE si ya estaba aplicada (no-op). La serialización la da el
--      PRIMARY KEY (unique_violation), NO un guard en TypeScript: dos instancias
--      concurrentes del sweep se serializan en Postgres.
--   3. Las 4 RPC de refund aceptan `p_idem_key TEXT DEFAULT NULL` y, cuando
--      viene, consultan el claim ANTES de mover dinero. Ya aplicada ⟹ RETURN 1
--      (el contrato `reverted = data >= 1` que leen los services sigue valiendo:
--      "la plata está de vuelta", que es lo que el retry adaptativo de /compose
--      necesita saber para decidir si re-debita).
--
-- CLAVE = REFUND LÓGICO, NO INTENTO. La arma la app
-- (`src/lib/refund-idem.ts`): `v1:<key_id>:<chain_id>:<base-uuid-del-request>:<slot>`.
--   - `base` es un UUID por request (memoizado), NO `request.id` (que llega por
--     header y es caller-controlled) ni un contador de proceso.
--   - `slot` distingue los refunds LÓGICOS DISTINTOS de una misma operación
--     (p. ej. `compose-step:3:d1` = refund del 1er débito del step 3 y
--     `compose-step:3:d2` = refund del débito del retry adaptativo del MISMO
--     step: dos créditos legítimos, dos claves → NO se colapsan).
--   - Los REINTENTOS del mismo refund lógico (call-site + sweep x N) comparten
--     clave → se aplican UNA sola vez.
--
-- AMOUNT MISMATCH: si llega la misma clave con OTRO monto es reuso indebido de
-- clave (bug), no un reintento. Se levanta `REFUND_IDEM_AMOUNT_MISMATCH` y NO se
-- aplica nada (fail-closed y VISIBLE: el entry del outbox muere en `dead` con
-- `last_error` para revisión manual, en vez de acreditar un monto ambiguo).
--
-- NO DESTRUCTIVA / COMPATIBLE:
--   - `a2a_refund_outbox.idem_key` es una columna NUEVA NULLABLE: las filas ya
--     encoladas quedan con NULL y el sweep las sigue procesando EXACTAMENTE como
--     hoy (`p_idem_key => NULL` ⟹ cero dedup ⟹ comportamiento byte-idéntico).
--     No se puede deducir a posteriori una clave para ellas: nadie registró el
--     crédito original. Se documenta el residuo, no se inventa.
--   - El índice único del outbox es PARCIAL (`WHERE idem_key IS NOT NULL`): no
--     puede fallar por datos preexistentes (todos NULL) ni por duplicados
--     históricos. Por eso NO se necesita `CREATE UNIQUE INDEX CONCURRENTLY`
--     (que además no corre dentro del bloque transaccional de una migración y
--     dejaría un índice INVALID si falla a mitad). La tabla es un outbox chico y
--     el lock ACCESS EXCLUSIVE es de milisegundos. Si en el futuro la tabla
--     crece, la variante concurrente equivalente es:
--       CREATE UNIQUE INDEX CONCURRENTLY uq_refund_outbox_idem_key
--         ON a2a_refund_outbox (idem_key) WHERE idem_key IS NOT NULL;
--     (fuera de transacción, en su propio archivo).
--   - Ningún DROP de datos. Los `DROP FUNCTION` son de FIRMA (esquema), el
--     patrón ya usado en 20260625000000:28,95 para agregar el RETURNS INT, y son
--     necesarios porque PostgREST no puede elegir entre dos overloads. Los
--     cuerpos se recrean IDÉNTICOS salvo el bloque de claim.
--   - Llamadas SQL existentes de 4 args (`20260704100000_wkh139_arbiter.sql:337,
--     349,353`) siguen resolviendo por el DEFAULT NULL → sin dedup, igual a hoy.
--
-- ORDEN DE LOCKS (anti-deadlock): a2a_delegations/a2a_key_sessions →
-- a2a_agent_keys → a2a_refund_applications → a2a_key_dest_spend_ledger, en TODOS
-- los caminos. Por eso los wrappers dual-ledger toman el `FOR UPDATE` de la key
-- ANTES de reclamar la clave (el refund del parent lo tomaría igual un momento
-- después). Sin esa normalización, el camino master (key → marcador) y el
-- wrapper (marcador → key) podrían cruzarse.
--
-- RLS: ENABLE sin policy (deny-by-default para anon/authenticated), igual que
-- a2a_refund_outbox (20260627000000:48). El service usa SERVICE_ROLE.
-- ============================================================

-- ============================================================
-- 1. Ledger de refunds APLICADOS (dedup DB-level)
-- ============================================================
CREATE TABLE IF NOT EXISTS a2a_refund_applications (
  -- Clave del refund LÓGICO. PRIMARY KEY = índice único = punto de
  -- serialización entre procesos concurrentes.
  idem_key    TEXT        PRIMARY KEY,
  key_id      UUID        NOT NULL,
  chain_id    INT         NOT NULL,
  amount_usd  NUMERIC     NOT NULL,
  owner_ref   TEXT        NOT NULL,
  destination TEXT,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auditoría / soporte: "qué refunds se le aplicaron a esta key".
CREATE INDEX IF NOT EXISTS idx_refund_applications_key_applied
  ON a2a_refund_applications (key_id, applied_at DESC);

ALTER TABLE public.a2a_refund_applications ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 2. a2a_refund_outbox.idem_key (aditivo, nullable) + único parcial
-- ============================================================
ALTER TABLE a2a_refund_outbox
  ADD COLUMN IF NOT EXISTS idem_key TEXT;

-- Defensa en profundidad #2: dos procesos que encolan el MISMO refund lógico
-- dejan UNA sola fila pendiente (el service trata 23505 como no-op).
CREATE UNIQUE INDEX IF NOT EXISTS uq_refund_outbox_idem_key
  ON a2a_refund_outbox (idem_key)
  WHERE idem_key IS NOT NULL;

-- ============================================================
-- 3. refund_idem_claim — TRUE = reclamada acá (aplicar), FALSE = ya aplicada
-- ============================================================
CREATE OR REPLACE FUNCTION refund_idem_claim(
  p_idem_key    TEXT,
  p_key_id      UUID,
  p_chain_id    INT,
  p_amount_usd  NUMERIC,
  p_owner_ref   TEXT,
  p_destination TEXT DEFAULT NULL
) RETURNS BOOLEAN AS $$
DECLARE
  v_applied_amount NUMERIC;
BEGIN
  -- Sin clave (llamadas legacy / filas encoladas antes de esta migración):
  -- comportamiento IDÉNTICO al de hoy, sin dedup.
  IF p_idem_key IS NULL OR p_idem_key = '' THEN
    RETURN TRUE;
  END IF;

  BEGIN
    INSERT INTO a2a_refund_applications (
      idem_key, key_id, chain_id, amount_usd, owner_ref, destination
    ) VALUES (
      p_idem_key, p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination
    );
    -- Reclamada por ESTA transacción: hay que aplicar el crédito. Si la
    -- transacción aborta, el marcador se va con ella (el refund NO ocurrió) y un
    -- reintento posterior vuelve a reclamar. Si commitea, el marcador y el
    -- crédito commitean JUNTOS.
    RETURN TRUE;
  EXCEPTION WHEN unique_violation THEN
    -- Ya aplicada. Si otra transacción la estaba insertando sin commitear, el
    -- INSERT de arriba esperó a que resolviera: si abortó, insertamos nosotros;
    -- si commiteó, caemos acá y el SELECT (nuevo snapshot, READ COMMITTED) ve la
    -- fila ganadora.
    SELECT amount_usd INTO v_applied_amount
      FROM a2a_refund_applications
      WHERE idem_key = p_idem_key;

    -- Tolerancia de 1e-9 USD: absorbe el ida y vuelta float↔NUMERIC del monto
    -- (el mismo refund reintentado NO debe fallar por representación), pero
    -- sigue cazando el reuso real de clave con otro monto.
    IF v_applied_amount IS NULL
       OR abs(v_applied_amount - p_amount_usd) > 1e-9 THEN
      RAISE EXCEPTION
        'REFUND_IDEM_AMOUNT_MISMATCH: idem_key % ya aplicada por % , reintento con %',
        p_idem_key, v_applied_amount, p_amount_usd;
    END IF;

    RETURN FALSE;
  END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.refund_idem_claim(text, uuid, integer, numeric, text, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.refund_idem_claim(text, uuid, integer, numeric, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_idem_claim(text, uuid, integer, numeric, text, text)
  TO service_role;

-- ============================================================
-- 4. refund_a2a_key_spend + p_idem_key
--    Cuerpo IDÉNTICO a 20260625000000 salvo el bloque de claim.
-- ============================================================
DROP FUNCTION IF EXISTS refund_a2a_key_spend(uuid, integer, numeric, text);

CREATE OR REPLACE FUNCTION refund_a2a_key_spend(
  p_key_id     UUID,
  p_chain_id   INT,
  p_amount_usd NUMERIC,
  p_owner_ref  TEXT,
  p_idem_key   TEXT DEFAULT NULL
) RETURNS INT AS $$
DECLARE
  v_row          a2a_agent_keys%ROWTYPE;
  v_chain_key    TEXT;
  v_current_bal  NUMERIC;
  v_new_bal      NUMERIC;
  v_new_daily    NUMERIC;
  v_rows         INT;
BEGIN
  -- CD-3: lock atómico (mismo estilo que increment_a2a_key_spend).
  SELECT * INTO v_row
    FROM a2a_agent_keys
    WHERE id = p_key_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'KEY_NOT_FOUND: key_id % does not exist', p_key_id;
  END IF;

  -- CD-4: Ownership Guard DB-level (defensa en profundidad; service usa SERVICE_ROLE).
  IF v_row.owner_ref IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key % not owned by caller', p_key_id;
  END IF;

  -- Un refund nunca es negativo ni cero. Defensivo: no-op si <= 0 → 0 filas.
  IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
    RETURN 0;
  END IF;

  -- HU-194: dedup DB-level DESPUÉS de los guards y BAJO el lock de la key.
  -- FALSE ⟹ este refund lógico YA se acreditó (p. ej. el crédito original
  -- commiteó y su respuesta se perdió) ⟹ NO acreditar de nuevo. Devuelve 1
  -- porque la plata SÍ está de vuelta: el contrato `reverted = data >= 1` que
  -- leen los services (y el sweep para marcar `done`) sigue siendo verdadero.
  IF NOT refund_idem_claim(
       p_idem_key, p_key_id, p_chain_id, p_amount_usd, p_owner_ref, NULL
     ) THEN
    RETURN 1;
  END IF;

  -- Credit budget for the chain (inverso del débito de increment).
  v_chain_key   := p_chain_id::TEXT;
  v_current_bal := COALESCE((v_row.budget ->> v_chain_key)::NUMERIC, 0);
  v_new_bal     := v_current_bal + p_amount_usd;

  -- AC-7 / CD-14: revertir el incremento del daily_spent, clamp a 0 (no crear "deuda").
  v_new_daily := GREATEST(v_row.daily_spent_usd - p_amount_usd, 0);

  UPDATE a2a_agent_keys
  SET
    budget          = jsonb_set(budget, ARRAY[v_chain_key], to_jsonb(v_new_bal::TEXT)),
    daily_spent_usd = v_new_daily,
    last_used_at    = NOW()
  WHERE id = p_key_id;

  -- A2 (audit 2026-06-24): nº de filas revertidas. El service lo lee para
  -- distinguir reversión real (>=1) de un no-op (0) y NO re-debitar si fue 0.
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- CD-13: Hardening (consistente con los RPCs hermanos).
ALTER FUNCTION public.refund_a2a_key_spend(uuid, integer, numeric, text, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.refund_a2a_key_spend(uuid, integer, numeric, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_a2a_key_spend(uuid, integer, numeric, text, text)
  TO service_role;

-- ============================================================
-- 5. refund_with_dest_policy + p_idem_key
--    Cuerpo IDÉNTICO a 20260625000000 salvo el bloque de claim.
-- ============================================================
DROP FUNCTION IF EXISTS refund_with_dest_policy(uuid, integer, numeric, text, text);

CREATE OR REPLACE FUNCTION refund_with_dest_policy(
  p_key_id      UUID,
  p_chain_id    INT,
  p_amount_usd  NUMERIC,
  p_owner_ref   TEXT,
  p_destination TEXT,
  p_idem_key    TEXT DEFAULT NULL
) RETURNS INT AS $$
DECLARE
  v_row          a2a_agent_keys%ROWTYPE;
  v_chain_key    TEXT;
  v_current_bal  NUMERIC;
  v_new_bal      NUMERIC;
  v_new_daily    NUMERIC;
  v_rows         INT := 0;
  v_ledger_rows  INT := 0;
BEGIN
  -- CD-1: lock atómico de la key (mismo estilo que refund_a2a_key_spend).
  SELECT * INTO v_row
    FROM a2a_agent_keys
    WHERE id = p_key_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'KEY_NOT_FOUND: key_id % does not exist', p_key_id;
  END IF;

  -- CD-2: Ownership Guard DB-level (defensa en profundidad). BAJO LOCK (TOCTOU-safe).
  IF v_row.owner_ref IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key % not owned by caller', p_key_id;
  END IF;

  -- CD-5/AC-5: un refund nunca es negativo ni cero. No-op defensivo → 0 filas.
  IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
    RETURN 0;
  END IF;

  -- HU-194: dedup DB-level (ver refund_a2a_key_spend). Ya aplicada ⟹ RETURN 1
  -- sin re-acreditar el budget NI re-insertar la fila compensatoria del
  -- dest-cap (doble reversión del cap = headroom regalado).
  IF NOT refund_idem_claim(
       p_idem_key, p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination
     ) THEN
    RETURN 1;
  END IF;

  -- AC-2(a): credit budget de la chain (inverso del débito de debit_with_dest_policy).
  v_chain_key   := p_chain_id::TEXT;
  v_current_bal := COALESCE((v_row.budget ->> v_chain_key)::NUMERIC, 0);
  v_new_bal     := v_current_bal + p_amount_usd;

  -- AC-2(b): revertir el incremento del daily_spent, clamp a 0 (no crear "deuda").
  v_new_daily := GREATEST(v_row.daily_spent_usd - p_amount_usd, 0);

  UPDATE a2a_agent_keys
  SET
    budget          = jsonb_set(budget, ARRAY[v_chain_key], to_jsonb(v_new_bal::TEXT)),
    daily_spent_usd = v_new_daily,
    last_used_at    = NOW()
  WHERE id = p_key_id;

  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- AC-1/AC-2(c)/CD-4: fila compensatoria NEGATIVA en el ledger del dest-cap.
  -- WKH-129 fix-pack (AR MNR-1): SIMETRÍA con debit_with_dest_policy — el INSERT
  -- ocurre SOLO si existe política para (key, destination). Guard bajo el mismo
  -- lock (FOR UPDATE arriba).
  --
  -- A2 (audit 2026-06-24): el dest-cap SOLO se revierte de verdad si esta fila
  -- compensatoria se inserta. Si el destino divergía del débito (no hay política
  -- para ese destino), el INSERT NO ocurre y el headroom del dest-cap NO se
  -- libera → el service debe tratarlo como "no revertido" y NO re-debitar.
  -- Por eso el retorno es el ROW_COUNT del INSERT del ledger (no el del UPDATE
  -- del budget): es el indicador fiel de la reversión del cap por destino.
  IF p_destination IS NOT NULL AND p_destination <> '' AND EXISTS (
    SELECT 1 FROM a2a_key_spend_policies
      WHERE key_id = p_key_id AND destination = p_destination
  ) THEN
    INSERT INTO a2a_key_dest_spend_ledger (key_id, owner_ref, destination, amount_usd)
    VALUES (p_key_id, p_owner_ref, p_destination, -p_amount_usd);
    GET DIAGNOSTICS v_ledger_rows = ROW_COUNT;
    RETURN v_ledger_rows;
  END IF;

  -- Sin política para el destino: el débito original tampoco insertó en el
  -- ledger (debit_with_dest_policy es simétrico), así que el budget SÍ se
  -- revirtió pero NO había cap por destino que liberar. Devolvemos el ROW_COUNT
  -- del UPDATE del budget (>=1) — la reversión del dinero es real.
  RETURN v_rows;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- DT-4: Hardening (consistente con refund_a2a_key_spend / debit_with_dest_policy).
ALTER FUNCTION public.refund_with_dest_policy(uuid, integer, numeric, text, text, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.refund_with_dest_policy(uuid, integer, numeric, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_with_dest_policy(uuid, integer, numeric, text, text, text)
  TO service_role;

-- ============================================================
-- 6. refund_delegation_and_parent + p_idem_key (dual-ledger)
--    Cuerpo IDÉNTICO a 20260701000000 salvo el lock de la key + el claim.
-- ============================================================
DROP FUNCTION IF EXISTS refund_delegation_and_parent(uuid, text, uuid, integer, numeric, text);

CREATE OR REPLACE FUNCTION refund_delegation_and_parent(
  p_delegation_id UUID,
  p_owner_ref     TEXT,
  p_key_id        UUID,
  p_chain_id      INT,
  p_amount_usd    NUMERIC,
  p_destination   TEXT DEFAULT NULL,
  p_idem_key      TEXT DEFAULT NULL
) RETURNS INT AS $$
DECLARE
  v_owner     TEXT;
  v_key_id    UUID;
  v_total     NUMERIC;
  v_new_total NUMERIC;
  v_rows      INT := 0;
BEGIN
  -- Lock atómico de la delegación (mismo estilo que debit_delegation_and_parent).
  SELECT owner_ref, key_id, total_spent
    INTO v_owner, v_key_id, v_total
    FROM a2a_delegations
    WHERE id = p_delegation_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DELEGATION_NOT_FOUND: %', p_delegation_id;
  END IF;

  -- Ownership Guard DB-level (defensa en profundidad; service usa SERVICE_ROLE).
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: delegation % not owned by caller', p_delegation_id;
  END IF;
  IF v_key_id IS DISTINCT FROM p_key_id THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: delegation % not bound to key %', p_delegation_id, p_key_id;
  END IF;

  -- Un refund nunca es negativo ni cero. Defensivo: no-op sin tocar ledgers.
  IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
    RETURN 0;
  END IF;

  -- HU-194: el claim vive ACÁ (función más externa) porque este refund es
  -- DUAL-LEDGER: si sólo dedupeáramos el parent, un reintento no acreditaría de
  -- nuevo el budget pero SÍ volvería a decrementar `total_spent` (skew M1 al
  -- revés). El parent se invoca sin clave (ya reclamada acá).
  -- El `FOR UPDATE` de la key va ANTES del claim para mantener el MISMO orden de
  -- locks que el camino master (key → marcador) y evitar deadlocks; el refund
  -- del parent iba a tomar ese lock igual.
  PERFORM 1 FROM a2a_agent_keys WHERE id = p_key_id FOR UPDATE;

  IF NOT refund_idem_claim(
       p_idem_key, p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination
     ) THEN
    RETURN 1;
  END IF;

  -- (a) refund del PARENT — dispatch dest-aware SIMÉTRICO al débito. El
  -- ROW_COUNT devuelto es el contrato de reversión real que el service lee.
  IF p_destination IS NOT NULL AND p_destination <> '' THEN
    v_rows := refund_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination);
  ELSE
    v_rows := refund_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref);
  END IF;

  -- (b) revertir el contador de la delegación (dual-ledger), clamp a 0.
  v_new_total := GREATEST(v_total - p_amount_usd, 0);
  UPDATE a2a_delegations SET total_spent = v_new_total WHERE id = p_delegation_id;

  RETURN v_rows;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.refund_delegation_and_parent(uuid, text, uuid, integer, numeric, text, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.refund_delegation_and_parent(uuid, text, uuid, integer, numeric, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_delegation_and_parent(uuid, text, uuid, integer, numeric, text, text)
  TO service_role;

-- ============================================================
-- 7. refund_session_and_parent + p_idem_key (dual-ledger)
--    Cuerpo IDÉNTICO a 20260701000000 salvo el lock de la key + el claim.
-- ============================================================
DROP FUNCTION IF EXISTS refund_session_and_parent(uuid, text, uuid, integer, numeric, text);

CREATE OR REPLACE FUNCTION refund_session_and_parent(
  p_session_id  UUID,
  p_owner_ref   TEXT,
  p_key_id      UUID,
  p_chain_id    INT,
  p_amount_usd  NUMERIC,
  p_destination TEXT DEFAULT NULL,
  p_idem_key    TEXT DEFAULT NULL
) RETURNS INT AS $$
DECLARE
  v_owner     TEXT;
  v_key_id    UUID;
  v_spent     NUMERIC;
  v_new_spent NUMERIC;
  v_rows      INT := 0;
BEGIN
  -- Lock atómico de la sesión (mismo estilo que debit_session_and_parent).
  SELECT owner_ref, key_id, spent_usd
    INTO v_owner, v_key_id, v_spent
    FROM a2a_key_sessions
    WHERE id = p_session_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SESSION_NOT_FOUND: %', p_session_id;
  END IF;

  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: session % not owned by caller', p_session_id;
  END IF;
  IF v_key_id IS DISTINCT FROM p_key_id THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: session % not bound to key %', p_session_id, p_key_id;
  END IF;

  IF p_amount_usd IS NULL OR p_amount_usd <= 0 THEN
    RETURN 0;
  END IF;

  -- HU-194: claim en la función más externa + orden de locks normalizado
  -- (ver refund_delegation_and_parent).
  PERFORM 1 FROM a2a_agent_keys WHERE id = p_key_id FOR UPDATE;

  IF NOT refund_idem_claim(
       p_idem_key, p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination
     ) THEN
    RETURN 1;
  END IF;

  -- (a) refund del PARENT — dispatch dest-aware SIMÉTRICO al débito.
  IF p_destination IS NOT NULL AND p_destination <> '' THEN
    v_rows := refund_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination);
  ELSE
    v_rows := refund_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref);
  END IF;

  -- (b) revertir el contador de la sesión (dual-ledger), clamp a 0.
  v_new_spent := GREATEST(v_spent - p_amount_usd, 0);
  UPDATE a2a_key_sessions SET spent_usd = v_new_spent WHERE id = p_session_id;

  RETURN v_rows;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.refund_session_and_parent(uuid, text, uuid, integer, numeric, text, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.refund_session_and_parent(uuid, text, uuid, integer, numeric, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_session_and_parent(uuid, text, uuid, integer, numeric, text, text)
  TO service_role;
