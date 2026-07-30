-- ============================================================
-- Migration: 20260731000000_wkh315_solana_deposit
-- WKH-315 — la pared B: fondear la clave prepaga en Solana (deposit inbound).
--
-- DESTINO: `bdwv` UNICAMENTE. `caldz` PROHIBIDA (CD-12).
-- Aditiva e idempotente. NO altera ninguna fila EVM existente.
--
-- ORDEN DE RELEASE, NO NEGOCIABLE (Story File §7.3):
--   1. esta migración   2. las envs (A2A_DEPOSIT_SOLANA_OWNER)
--   3. el flag A2A_SOLANA_DEPOSIT_ENABLED=true  ← ULTIMO
-- Migración antes del código ⇒ sin ventana (la columna existe y nadie la usa).
-- Orden inverso ⇒ el flag OFF por default hace que el camino Solana no exista:
-- degradación RUIDOSA y recuperable, nunca un crédito duplicado.
-- ============================================================
--
-- ⚠️ EL FOOTGUN QUE ESTA MIGRACION EXISTE PARA CERRAR (CD-8 / AC-13).
--
-- El `chain_id` de Solana es un SENTINEL SINTETICO leído de env
-- (`SOLANA_SYNTHETIC_CHAIN_ID`, default 900001) y por lo tanto CAMBIABLE EN
-- CALIENTE. La única clave anti-replay de depósitos que existe hoy es
-- `UNIQUE (chain_id, tx_hash)`. Con eso, cambiar el sentinel de 900001 a 900002
-- RE-ABRE PARA RE-CREDITO TODOS LOS DEPOSITOS SOLANA PASADOS: la misma firma con
-- otro `chain_id` es otra fila y no colisiona con nada. Plata duplicada por un
-- typo en una variable de entorno.
--
-- Se cierra EN LA BASE, no con un guard en la aplicación: un índice parcial UNIQUE
-- sobre `tx_hash` que **NO MENCIONA `chain_id`**. Tres propiedades:
--   (1) ninguna mutación de env puede crear una segunda fila creditable;
--   (2) `UNIQUE (chain_id, tx_hash)` queda INTACTO ⇒ la rama EVM es byte-idéntica;
--   (3) el `EXCEPTION WHEN unique_violation THEN RAISE 'DEPOSIT_ALREADY_CREDITED'`
--       de `register_a2a_key_deposit` es AGNOSTICO de qué índice se violó, así que
--       el 409 se hereda sin una línea de plpgsql nueva.
--
-- Si alguien cambia el sentinel igual, el peor caso pasa a ser *un bucket de saldo
-- que no se puede gastar desde el bucket viejo* (recuperable, visible) en vez de
-- *saldo duplicado* (irreversible). Cuando los dos errores no cuestan lo mismo, el
-- default va del lado barato.
-- ============================================================

BEGIN;

-- ── 1. `vm_family` en a2a_key_deposits ───────────────────────────────────────
-- El DEFAULT 'evm' es lo que mantiene byte-idénticas las filas existentes: toda
-- fila histórica queda 'evm' y por lo tanto FUERA del índice parcial nuevo.
ALTER TABLE a2a_key_deposits
  ADD COLUMN IF NOT EXISTS vm_family TEXT NOT NULL DEFAULT 'evm';

-- DROP+ADD en vez de `ADD CONSTRAINT IF NOT EXISTS` (que Postgres no tiene):
-- idempotencia por el mismo idioma que `20260611000000_a2a_receipts_..._check.sql`.
ALTER TABLE a2a_key_deposits
  DROP CONSTRAINT IF EXISTS chk_a2a_key_deposits_vm_family;
ALTER TABLE a2a_key_deposits
  ADD CONSTRAINT chk_a2a_key_deposits_vm_family
  CHECK (vm_family IN ('evm', 'solana'));

-- ── 2. RE-HIDRATACION desde el backup del `_down` (CD-17) ────────────────────
--
-- ⚠️ POR QUE ESTO VA ACA Y POR QUE VA **ANTES** DEL INDICE. El `_down` de esta
-- migración DESTRUYE DATOS: dropea `vm_family`. Un ciclo `down → up` sin esto
-- dejaría todas las filas Solana en `vm_family='evm'`, o sea AFUERA del índice
-- parcial, o sea con su unicidad dependiendo otra vez del sentinel ⇒ todos los
-- depósitos Solana pasados vuelven a ser re-creditables. El rollback se
-- convertiría en el exploit.
--
-- Es el mismo bug que WKH-307 §MNR-4 documentó, en otra ropa: un `_down` no es una
-- operación aislada, es la mitad de un CICLO, y el ciclo tiene que ser identidad.
--
-- El `_down` archiva `(id, tx_hash)` de las filas Solana en
-- `a2a_key_deposits_solana_backup_wkh315`; acá se re-marcan por `id` si esa tabla
-- existe. Idempotente (el `WHERE vm_family <> 'solana'` la vuelve un no-op en la
-- segunda corrida) y no-op en una base virgen (la tabla no existe).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'a2a_key_deposits_solana_backup_wkh315'
  ) THEN
    UPDATE a2a_key_deposits d
      SET vm_family = 'solana'
      FROM a2a_key_deposits_solana_backup_wkh315 b
      WHERE d.id = b.id
        AND d.vm_family <> 'solana';
    RAISE NOTICE 'WKH-315: re-hidratadas las filas Solana desde a2a_key_deposits_solana_backup_wkh315';
  END IF;
END
$$;

-- ── 3. El índice parcial: anti-replay SIN `chain_id` (AC-13 / CD-8) ──────────
-- SIN `chain_id` A PROPOSITO — ver la cabecera. Y sin `lower()`: la igualdad de
-- `TEXT` en Postgres ya es byte-exacta, y bajar a minúsculas una firma base58 la
-- DESTRUIRIA (mapea dos firmas distintas a la misma).
CREATE UNIQUE INDEX IF NOT EXISTS uq_a2a_key_deposits_solana_sig
  ON a2a_key_deposits (tx_hash)
  WHERE vm_family = 'solana';

-- ── 4. `funding_wallet_solana` en a2a_agent_keys (AC-7 / AC-8 / CD-6) ────────
--
-- COLUMNA NUEVA, no reuso de `funding_wallet`, por tres razones:
--   (a) `funding_wallet` se persiste LOWERCASE desde la app y su migración lo
--       declara contrato (`20260529000001:14`) — cambiarlo toca el camino EVM;
--   (b) con una sola columna un owner NO podría tener las dos wallets bindeadas,
--       y cruzar de riel ya es conducta de producción;
--   (c) decidir qué gate de seguridad se aplica OLFATEANDO el formato del valor
--       almacenado es implícito y se rompe en silencio. Con dos columnas el gate
--       lo elige `bundle.payment.vmFamily`, explícito y visible al compilador.
ALTER TABLE a2a_agent_keys
  ADD COLUMN IF NOT EXISTS funding_wallet_solana TEXT;

-- UNIQUE PLANO sobre la columna CRUDA — espejo exacto de `20260529000001:29-31`.
-- PROHIBIDO `lower()` acá (CD-6/AC-8): case-sensitive es el requisito, no un
-- accidente. Parcial: NULL = sin bindear, y los NULL no colisionan entre sí.
CREATE UNIQUE INDEX IF NOT EXISTS uq_a2a_agent_keys_funding_wallet_solana
  ON a2a_agent_keys (funding_wallet_solana)
  WHERE funding_wallet_solana IS NOT NULL;

-- ── 5. DROP de la firma de 6 params ANTES del CREATE OR REPLACE de 7 ─────────
--
-- ⚠️ ESTO NO ES OPCIONAL. `CREATE OR REPLACE FUNCTION` con una LISTA DE TIPOS DE
-- ENTRADA DISTINTA no reemplaza nada: crea una SOBRECARGA. Con las dos firmas
-- vivas, `supabase.rpc('register_a2a_key_deposit', {...})` recibe
-- `function ... is not unique` y el fondeo entero se cae. Es el bug ya documentado
-- en `20260529000000:27-31` (FIX-2), donde el `DROP` de la v1 se agregó por
-- exactamente este motivo. El `_down` restaura la de 6, así que sigue reversible.
DROP FUNCTION IF EXISTS register_a2a_key_deposit(uuid, integer, numeric, text, text, text);

CREATE OR REPLACE FUNCTION register_a2a_key_deposit(
  p_key_id     UUID,
  p_chain_id   INT,
  p_amount_usd NUMERIC,
  p_owner_ref  TEXT,
  p_tx_hash    TEXT,
  p_token      TEXT DEFAULT NULL,
  -- WKH-315: 7º param. El `DEFAULT 'evm'` es lo que mantiene VALIDA la llamada de
  -- 6 args de la rama EVM (`supabase-js` pasa args NOMBRADOS, así que una llamada
  -- que no lo manda recibe 'evm'). Exemplar del idioma: `p_destination TEXT
  -- DEFAULT NULL` en `20260606000000:165`.
  --
  -- ⚠️ EL DEFAULT ES UN GUARD DE DINERO, NO UNA COMODIDAD: sin él, la llamada
  -- EVM de 6 args deja de resolver y el fondeo EVM se cae entero (CD-1).
  p_vm_family  TEXT DEFAULT 'evm'
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
  -- Lock the key row (atomic) — patrón FOR UPDATE de increment_a2a_key_spend.
  SELECT budget, owner_ref, is_active
    INTO v_budget, v_owner, v_active
    FROM a2a_agent_keys
    WHERE id = p_key_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'KEY_NOT_FOUND: key_id % does not exist', p_key_id;
  END IF;

  -- CD-1: Ownership Guard a nivel DB (service usa SERVICE_ROLE → bypassa RLS).
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key_id % does not belong to caller', p_key_id;
  END IF;

  IF NOT v_active THEN
    RAISE EXCEPTION 'KEY_INACTIVE: key_id % is deactivated', p_key_id;
  END IF;

  -- CD-2: anti-replay. Con `vm_family='evm'` lo impone `UNIQUE(chain_id, tx_hash)`
  -- (intacto); con `vm_family='solana'` lo impone ADEMAS el índice parcial sobre
  -- `(tx_hash)` SOLO. El handler es el MISMO porque `unique_violation` no dice qué
  -- índice se violó — por eso el 409 se hereda sin plpgsql nuevo.
  BEGIN
    INSERT INTO a2a_key_deposits (key_id, owner_ref, chain_id, tx_hash, amount_usd, token, vm_family)
    VALUES (p_key_id, p_owner_ref, p_chain_id, p_tx_hash, p_amount_usd, p_token, p_vm_family);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'DEPOSIT_ALREADY_CREDITED: chain % tx % already credited', v_chain, p_tx_hash;
  END;

  -- Crédito al budget de la chain verificada (CD-5: chain del bundle).
  v_current := COALESCE((v_budget ->> v_chain)::NUMERIC, 0);
  v_new := v_current + p_amount_usd;

  UPDATE a2a_agent_keys
  SET budget = jsonb_set(COALESCE(v_budget, '{}'::jsonb), ARRAY[v_chain], to_jsonb(v_new::TEXT))
  WHERE id = p_key_id;

  RETURN v_new::TEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 6. Hardening sobre la firma de 7 params (exemplar `20260529000000:93-103`) ──
-- SECURITY DEFINER sin `search_path` fijo = schema-hijacking. El REVOKE/GRANT es
-- por FIRMA: la de 6 params ya no existe (se dropeó arriba), así que sin esto la
-- de 7 quedaría con los defaults de PUBLIC.
ALTER FUNCTION public.register_a2a_key_deposit(uuid, integer, numeric, text, text, text, text)
  SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.register_a2a_key_deposit(uuid, integer, numeric, text, text, text, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.register_a2a_key_deposit(uuid, integer, numeric, text, text, text, text)
  TO service_role;

-- ── 7. RLS: nada que hacer (MI-7) ────────────────────────────────────────────
-- `a2a_key_deposits` ya tiene RLS ON sin policy = deny-all para anon/authenticated;
-- el service usa `service_role`, que bypassa. Las columnas nuevas heredan eso.

COMMIT;
