-- ============================================================
-- ROLLBACK: 20260731000000_wkh315_solana_deposit_down
-- WKH-315 — revierte el depósito Solana.
--
-- DESTINO: `bdwv` UNICAMENTE. `caldz` PROHIBIDA (CD-12).
-- ============================================================
--
-- ⚠️ ESTE `_down` DESTRUYE DATOS, Y ESA ES LA RAZON POR LA QUE ARCHIVA PRIMERO.
--
-- Dropear `vm_family` no es una operación reversible por sí sola: al volver a
-- correr el `up`, la columna se re-crea con `DEFAULT 'evm'` y TODAS las filas
-- —incluidas las Solana— quedan 'evm'. O sea AFUERA del índice parcial
-- `uq_a2a_key_deposits_solana_sig`. O sea con su unicidad dependiendo otra vez de
-- `UNIQUE (chain_id, tx_hash)`, que depende del sentinel env-driven.
--
-- Resultado sin el backup: un ciclo `down → up` RE-ABRE PARA RE-CREDITO todos los
-- depósitos Solana ya acreditados. El rollback se vuelve el exploit.
--
-- Un `_down` no es una operación aislada: es la MITAD DE UN CICLO, y el ciclo
-- tiene que ser identidad. Es el mismo bug que WKH-307 §MNR-4 documentó (CD-17).
--
-- Por eso: acá se ARCHIVA `(id, tx_hash)` de las filas Solana, y el `up`
-- RE-HIDRATA desde ese archivo si la tabla existe. La tabla de backup NO se borra
-- nunca automáticamente — borrarla es una decisión humana, con la evidencia
-- delante.
-- ============================================================

BEGIN;

-- ── 0. ARCHIVAR ANTES DE DESTRUIR (CD-17) — va PRIMERO, no al final ──────────
-- `CREATE TABLE IF NOT EXISTS ... AS SELECT` no re-inserta si la tabla ya existe
-- (un down→up→down repetido no duplica), así que el INSERT complementario cubre
-- las filas Solana nuevas del segundo ciclo.
CREATE TABLE IF NOT EXISTS a2a_key_deposits_solana_backup_wkh315 AS
  SELECT id, tx_hash
    FROM a2a_key_deposits
    WHERE vm_family = 'solana';

INSERT INTO a2a_key_deposits_solana_backup_wkh315 (id, tx_hash)
  SELECT d.id, d.tx_hash
    FROM a2a_key_deposits d
    WHERE d.vm_family = 'solana'
      AND NOT EXISTS (
        SELECT 1 FROM a2a_key_deposits_solana_backup_wkh315 b WHERE b.id = d.id
      );

-- ── 1. El índice parcial del anti-replay Solana ──────────────────────────────
DROP INDEX IF EXISTS uq_a2a_key_deposits_solana_sig;

-- ── 2. El CHECK de vm_family ─────────────────────────────────────────────────
ALTER TABLE a2a_key_deposits
  DROP CONSTRAINT IF EXISTS chk_a2a_key_deposits_vm_family;

-- ── 3. Las dos columnas nuevas ───────────────────────────────────────────────
DROP INDEX IF EXISTS uq_a2a_agent_keys_funding_wallet_solana;

ALTER TABLE a2a_agent_keys
  DROP COLUMN IF EXISTS funding_wallet_solana;

ALTER TABLE a2a_key_deposits
  DROP COLUMN IF EXISTS vm_family;

-- ── 4. La fn de 7 params, y la RESTAURACION de la de 6 ───────────────────────
--
-- No alcanza con dropear la de 7: hay que RE-CREAR la de 6, porque
-- `budgetService.registerDeposit` la llama con args nombrados y sin ella el
-- fondeo EVM queda muerto tras el rollback. Cuerpo idéntico al de
-- `20260529000000_a2a_key_deposits.sql` (exemplar `:27-31` para el idioma del
-- DROP+restauración).
DROP FUNCTION IF EXISTS register_a2a_key_deposit(uuid, integer, numeric, text, text, text, text);

CREATE OR REPLACE FUNCTION register_a2a_key_deposit(
  p_key_id     UUID,
  p_chain_id   INT,
  p_amount_usd NUMERIC,
  p_owner_ref  TEXT,
  p_tx_hash    TEXT,
  p_token      TEXT DEFAULT NULL
)
RETURNS TEXT AS $$
DECLARE
  v_budget   JSONB;
  v_owner    TEXT;
  v_active   BOOLEAN;
  v_chain    TEXT := p_chain_id::TEXT;
  v_current  NUMERIC;
  v_new      NUMERIC;
BEGIN
  SELECT budget, owner_ref, is_active
    INTO v_budget, v_owner, v_active
    FROM a2a_agent_keys
    WHERE id = p_key_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'KEY_NOT_FOUND: key_id % does not exist', p_key_id;
  END IF;

  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key_id % does not belong to caller', p_key_id;
  END IF;

  IF NOT v_active THEN
    RAISE EXCEPTION 'KEY_INACTIVE: key_id % is deactivated', p_key_id;
  END IF;

  BEGIN
    INSERT INTO a2a_key_deposits (key_id, owner_ref, chain_id, tx_hash, amount_usd, token)
    VALUES (p_key_id, p_owner_ref, p_chain_id, p_tx_hash, p_amount_usd, p_token);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DEPOSIT_ALREADY_CREDITED: chain % tx % already credited', v_chain, p_tx_hash;
  END;

  v_current := COALESCE((v_budget ->> v_chain)::NUMERIC, 0);
  v_new := v_current + p_amount_usd;

  UPDATE a2a_agent_keys
  SET budget = jsonb_set(COALESCE(v_budget, '{}'::jsonb), ARRAY[v_chain], to_jsonb(v_new::TEXT))
  WHERE id = p_key_id;

  RETURN v_new::TEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.register_a2a_key_deposit(uuid, integer, numeric, text, text, text)
  SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.register_a2a_key_deposit(uuid, integer, numeric, text, text, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.register_a2a_key_deposit(uuid, integer, numeric, text, text, text)
  TO service_role;

-- ── 4b. RECARGA DEL SCHEMA-CACHE DE PostgREST (fix-pack AR · BLQ-MED-2) ──────
-- El swap es INVERSO al del `up` (dropea la de 7, restaura la de 6) y tiene la misma
-- ventana: con el caché viejo, `budgetService.registerDeposit` le pide a PostgREST una
-- firma que ya no existe y el fondeo EVM contesta 500 justo después de un rollback,
-- que es el peor momento posible para un síntoma nuevo. Exemplar del idioma:
-- `20260730000000_wkh307_solana_settle_intents_down.sql:63`.
NOTIFY pgrst, 'reload schema';

-- ── 5. INVENTARIO PREVIO AL ROLLBACK, para el operador ───────────────────────
-- Antes de correr esto, mirá qué se va a archivar:
--   SELECT count(*) FROM a2a_key_deposits WHERE vm_family = 'solana';
-- Y después de correrlo, que el archivo tenga esa misma cuenta:
--   SELECT count(*) FROM a2a_key_deposits_solana_backup_wkh315;
-- Si no coinciden, NO vuelvas a correr el `up` hasta entender por qué: el `up`
-- re-hidrata SOLO lo que esté en esa tabla.

COMMIT;
