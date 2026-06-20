-- WKH-125 KEY-CONSTRAINTS: caps de gasto por destino + ventanas rolling/total.
-- Aditiva y reversible. 2 tablas nuevas + RPC atómico debit_with_dest_policy
-- (espeja debit_session_and_parent) + CREATE OR REPLACE de debit_session_and_parent
-- extendido para dispatch interno a la política (AC-6, firma TS intacta — CD-4).
-- Back-compat: sin políticas → comportamiento byte-idéntico a hoy (CD-5).

-- ============================================================
-- Tabla 1: políticas de gasto por destino (1 por destino por key)
-- ============================================================
CREATE TABLE IF NOT EXISTS a2a_key_spend_policies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id      UUID NOT NULL REFERENCES a2a_agent_keys(id) ON DELETE CASCADE,
  owner_ref   TEXT NOT NULL,                                  -- Ownership Guard app-layer (CD-3)
  destination TEXT NOT NULL,                                  -- "<registry>/<slug>" normalizado (trim+lowercase)
  max_usd     NUMERIC(18,6) NOT NULL CHECK (max_usd >= 0),
  window_type TEXT NOT NULL CHECK (window_type IN ('total','rolling')),
  window_secs INT CHECK (window_secs IS NULL OR window_secs > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (key_id, destination)                                -- 1 política por destino por key (upsert target)
);

CREATE INDEX IF NOT EXISTS idx_a2a_key_spend_policies_key_owner
  ON a2a_key_spend_policies (key_id, owner_ref);

-- Trigger: updated_at (reuse existing function from tasks migration)
DROP TRIGGER IF EXISTS set_updated_at ON a2a_key_spend_policies;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON a2a_key_spend_policies
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

-- ============================================================
-- Tabla 2: ledger de débitos por destino (acumulado hot-path)
-- ============================================================
CREATE TABLE IF NOT EXISTS a2a_key_dest_spend_ledger (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id      UUID NOT NULL REFERENCES a2a_agent_keys(id) ON DELETE CASCADE,
  owner_ref   TEXT NOT NULL,
  destination TEXT NOT NULL,                                  -- mismo formato normalizado
  amount_usd  NUMERIC(18,6) NOT NULL,
  debited_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índice hot-path para el SUM por ventana (AC-3): (key_id, destination, debited_at).
CREATE INDEX IF NOT EXISTS idx_a2a_key_dest_spend_ledger_key_dest_at
  ON a2a_key_dest_spend_ledger (key_id, destination, debited_at);

-- ============================================================
-- RPC atómico: debit_with_dest_policy
-- Espeja debit_session_and_parent: lock key → ownership → lock policy → SUM ledger
-- en ventana → check cap → PERFORM increment_a2a_key_spend → INSERT ledger.
-- TODO en 1 tx (CD-1). Self-back-compat: sin política → solo PERFORM + 0 inserts (CD-5).
-- ============================================================
CREATE OR REPLACE FUNCTION debit_with_dest_policy(
  p_key_id      UUID,
  p_chain_id    INT,
  p_amount_usd  NUMERIC,
  p_owner_ref   TEXT,
  p_destination TEXT
) RETURNS void AS $$
DECLARE
  v_key_owner   TEXT;
  v_pol_max     NUMERIC;
  v_pol_wtype   TEXT;
  v_pol_wsecs   INT;
  v_accum       NUMERIC;
  v_has_policy  BOOLEAN := false;
BEGIN
  -- 1. Lock de la key (serializa contra otros débitos al mismo key ANTES de leer
  --    el ledger; evita TOCTOU entre SUM y debit; AC-4).
  SELECT owner_ref INTO v_key_owner
    FROM a2a_agent_keys
    WHERE id = p_key_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KEY_NOT_FOUND: key_id % does not exist', p_key_id;
  END IF;

  -- 2. Ownership Guard DB-layer (CD-3 — el service usa SERVICE_ROLE/bypass RLS).
  IF v_key_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key % not owned by caller', p_key_id;
  END IF;

  -- 3. Política activa para el destino (SELECT FOR UPDATE — serializa AC-4).
  IF p_destination IS NOT NULL AND p_destination <> '' THEN
    SELECT max_usd, window_type, window_secs
      INTO v_pol_max, v_pol_wtype, v_pol_wsecs
      FROM a2a_key_spend_policies
      WHERE key_id = p_key_id AND destination = p_destination
      FOR UPDATE;
    IF FOUND THEN
      v_has_policy := true;
    END IF;
  END IF;

  -- 4. Si hay política: acumular sobre el ledger en la ventana activa.
  IF v_has_policy THEN
    IF v_pol_wtype = 'rolling' THEN
      SELECT COALESCE(SUM(amount_usd), 0) INTO v_accum
        FROM a2a_key_dest_spend_ledger
        WHERE key_id = p_key_id
          AND destination = p_destination
          AND debited_at >= now() - (v_pol_wsecs * interval '1 second');
    ELSE  -- 'total': sin filtro temporal
      SELECT COALESCE(SUM(amount_usd), 0) INTO v_accum
        FROM a2a_key_dest_spend_ledger
        WHERE key_id = p_key_id
          AND destination = p_destination;
    END IF;

    -- 5. Check del cap (AC-2). ANTES del debit del parent (orden defensivo).
    IF (v_accum + p_amount_usd) > v_pol_max THEN
      RAISE EXCEPTION 'DEST_CAP_EXCEEDED: dest % accum % + % > cap %',
        p_destination, v_accum, p_amount_usd, v_pol_max;
    END IF;
  END IF;

  -- 6. Debit del parent REUSANDO la fn existente (CD-2 — NO se reimplementa
  --    daily/budget). Su FOR UPDATE re-lockea la misma fila ya lockeada (no-op,
  --    re-entrante en la misma tx). Propaga INSUFFICIENT_BUDGET/DAILY_LIMIT/
  --    KEY_INACTIVE/KEY_NOT_FOUND → ROLLBACK de toda la tx (ledger no se inserta).
  PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd);

  -- 7. Sólo si hay política: registrar el débito en el ledger (misma tx).
  IF v_has_policy THEN
    INSERT INTO a2a_key_dest_spend_ledger (key_id, owner_ref, destination, amount_usd)
    VALUES (p_key_id, p_owner_ref, p_destination, p_amount_usd);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Hardening obligatorio (CD-1/CD-3).
ALTER FUNCTION public.debit_with_dest_policy(uuid, integer, numeric, text, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.debit_with_dest_policy(uuid, integer, numeric, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_with_dest_policy(uuid, integer, numeric, text, text)
  TO service_role;

-- ============================================================
-- AC-6: debit_session_and_parent extendido — dispatch interno a la política.
-- CREATE OR REPLACE en ESTA migración (CD-4: agrega 1 param NUEVO p_destination
-- con DEFAULT NULL → la firma TS del service puede pasar p_destination o no;
-- las llamadas existentes de 5 args siguen válidas por el DEFAULT).
-- El paso 5 (PERFORM increment_a2a_key_spend) se reemplaza por PERFORM
-- debit_with_dest_policy cuando hay destino → la sesión aplica el cap de la parent.
--
-- BLQ-MED-1 (fix-pack): DROP de la firma de 5 params (20260603000000) ANTES del
-- CREATE OR REPLACE de 6 params. En Postgres `CREATE OR REPLACE FUNCTION`
-- reemplaza SOLO cuando los tipos de entrada coinciden exactamente; agregar
-- `p_destination` produce una SOBRECARGA y la de 5 params PERSISTE → un caller
-- de 5 args da `ERROR: function debit_session_and_parent(...) is not unique`.
-- El DROP elimina la sobrecarga vieja dejando UNA sola función de 6 params.
-- (El _down.sql dropea la de 6 y restaura la de 5 → reversibilidad intacta.)
-- ============================================================
DROP FUNCTION IF EXISTS debit_session_and_parent(uuid, text, uuid, integer, numeric);

CREATE OR REPLACE FUNCTION debit_session_and_parent(
  p_session_id  UUID,
  p_owner_ref   TEXT,
  p_key_id      UUID,
  p_chain_id    INT,
  p_amount_usd  NUMERIC,
  p_destination TEXT DEFAULT NULL          -- NUEVO (AC-6): "<registry>/<slug>" o NULL
) RETURNS NUMERIC AS $$
DECLARE
  v_owner     TEXT;
  v_key_id    UUID;
  v_revoked   TIMESTAMPTZ;
  v_expires   TIMESTAMPTZ;
  v_spent     NUMERIC;
  v_max       NUMERIC;
  v_new_spent NUMERIC;
BEGIN
  -- 1. Lock de la sesión (FOR UPDATE — serializa débitos concurrentes).
  SELECT owner_ref, key_id, revoked_at, expires_at, spent_usd, max_budget_usd
    INTO v_owner, v_key_id, v_revoked, v_expires, v_spent, v_max
    FROM a2a_key_sessions
    WHERE id = p_session_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SESSION_NOT_FOUND: %', p_session_id;
  END IF;

  -- 2. Ownership Guard DB-layer.
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: session % not owned by caller', p_session_id;
  END IF;
  IF v_key_id IS DISTINCT FROM p_key_id THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: session % not bound to key %', p_session_id, p_key_id;
  END IF;

  -- 3. Revocación / expiry re-chequeados BAJO LOCK (TOCTOU-safe).
  IF v_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'SESSION_REVOKED: %', p_session_id;
  END IF;
  IF NOW() >= v_expires THEN
    RAISE EXCEPTION 'SESSION_EXPIRED: %', p_session_id;
  END IF;

  -- 4. Check del budget de la sesión ANTES del debit del parent.
  v_new_spent := v_spent + p_amount_usd;
  IF v_new_spent > v_max THEN
    RAISE EXCEPTION 'SESSION_BUDGET_EXHAUSTED: % + % > %', v_spent, p_amount_usd, v_max;
  END IF;

  -- 5. Debit del parent. AC-6: si hay destino → enruta al RPC dest-aware
  --    (la sesión aplica/consume el cap por destino de la PARENT key, sin tabla
  --    por sesión). Si no → increment_a2a_key_spend directo (back-compat, CD-5).
  --    Ambos RAISE INSUFFICIENT_BUDGET/DAILY_LIMIT/KEY_INACTIVE/KEY_NOT_FOUND y
  --    debit_with_dest_policy además RAISE DEST_CAP_EXCEEDED → ROLLBACK total.
  IF p_destination IS NOT NULL AND p_destination <> '' THEN
    PERFORM debit_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination);
  ELSE
    PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd);
  END IF;

  -- 6. Recién acá incrementamos spent_usd (orden 4→5→6 defensivo).
  UPDATE a2a_key_sessions SET spent_usd = v_new_spent WHERE id = p_session_id;

  RETURN v_new_spent;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Hardening de la firma NUEVA de debit_session_and_parent (6 params).
ALTER FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric, text)
  TO service_role;
