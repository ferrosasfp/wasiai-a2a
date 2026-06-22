# Story File — WKH-SEC-02b: Ownership Guard DB-level en `increment_a2a_key_spend`

> Contrato autocontenido para el Dev (F3). El Dev SOLO lee este archivo.
> NO releer el SDD. Todo lo necesario (snippets exemplar con archivo:línea reales) está aquí.
>
> - HU: #119 — WKH-SEC-02b
> - Branch: `feat/119-wkh-sec-02b-owner-ref-rpc` (estás en `fix/117-...`; crear/cambiar a la branch correcta antes de codear)
> - SPEC_APPROVED: SÍ
> - Tipo: security / defensa en profundidad (NO es vuln activa — la RPC ya está REVOKED de anon/authenticated)

---

## 1. Contexto compacto (qué se construye y por qué)

`increment_a2a_key_spend` es el RPC fundacional de todo débito de budget. Hoy NO
valida `owner_ref` internamente: el Ownership Guard vive en la capa app (WKH-53) o
en los RPCs intermedios. Esta HU agrega un guard **Postgres-level dentro de**
`increment_a2a_key_spend` (firma extendida con `p_owner_ref TEXT`) para que
cualquier invocación — directa (caller TS #1) o vía `PERFORM` (callers SQL #2/#3/#4) —
rechace con `OWNERSHIP_MISMATCH` y haga ROLLBACK si el `p_owner_ref` no coincide
con el `owner_ref` de la fila de `a2a_agent_keys`.

Cambio atómico y reversible: 1 migración up (DROP+CREATE de la firma 4-param +
`CREATE OR REPLACE` de los 3 RPCs dependientes) + 1 down + 1 cambio TS en `budget.ts`
(ruta master-no-dest) + tests.

**Los 3 callers SQL ya reciben `p_owner_ref` como parámetro propio** (lo usan para su
propio guard). El único cambio en ellos es agregar `p_owner_ref` al `PERFORM`.
**El dispatch condicional de WKH-125/125b (`IF p_destination ... THEN debit_with_dest_policy ELSE increment_a2a_key_spend`) NO se toca** — solo se modifica el branch ELSE.

---

## 2. Scope IN (lista exhaustiva de archivos a tocar)

| # | Archivo | Acción |
|---|---------|--------|
| 1 | `supabase/migrations/20260609000000_wkh_sec02b_owner_ref_rpc.sql` | **Crear** (up) |
| 2 | `supabase/migrations/20260609000000_wkh_sec02b_owner_ref_rpc_down.sql` | **Crear** (down) |
| 3 | `src/services/budget.ts` | **Modificar** (solo ruta master-no-dest, L297-308) |
| 4 | `src/services/budget.test.ts` | **Modificar** (aserciones 3-arg → 4-arg + tests nuevos del guard) |

### Scope OUT (PROHIBIDO tocar — CD-11)

`src/services/delegation.ts`, `src/services/key-session.ts`, `src/routes/`,
`src/services/compose.ts`, `src/middleware/a2a-key.ts` (su call-site de 3-arg NO cambia),
`register_a2a_key_deposit`, lógica de negocio del débito (daily reset, chain budget,
KEY_INACTIVE, KEY_NOT_FOUND).

---

## 3. Anti-Hallucination Checklist (verificado en F2 — NO re-inventar)

| Hecho verificado | Valor real | Fuente |
|------------------|-----------|--------|
| Firma actual de `increment_a2a_key_spend` | `(p_key_id UUID, p_chain_id INT, p_amount_usd NUMERIC) RETURNS void`, `SECURITY DEFINER`, SIN hardening (no tiene `ALTER FUNCTION SET search_path` ni REVOKE/GRANT) | `20260406000000_a2a_agent_keys.sql:56-121` |
| Cuerpo literal a copiar (resto intacto) | `20260406000000_a2a_agent_keys.sql:60-121` | idem |
| Posición exacta del guard | ENTRE `IF NOT FOUND` (L75-77) y `IF NOT v_row.is_active` (L79-81) | idem |
| Variable de la fila lockeada | `v_row` (tipo `a2a_agent_keys%ROWTYPE`); la columna es `v_row.owner_ref` | `20260406000000:62,70-73` |
| Wording canónico del guard | `IF <owner> IS DISTINCT FROM p_owner_ref THEN RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key % not owned by caller', p_key_id; END IF;` | `20260606000000_a2a_key_spend_policies.sql:81-83` |
| Patrón DROP-antes-de-CREATE (BLQ-MED-1) | `DROP FUNCTION IF EXISTS <fn>(<firma vieja>);` ANTES del CREATE de aridad distinta | `20260606000000:157`, `20260608000000:17` |
| `debit_with_dest_policy` PERFORM actual | `PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd);` | `20260606000000:123` |
| `debit_session_and_parent` (6-param) dispatch | `IF p_destination IS NOT NULL AND p_destination <> '' THEN PERFORM debit_with_dest_policy(...) ELSE PERFORM increment_a2a_key_spend(...) END IF;` | `20260606000000:213-217` |
| `debit_delegation_and_parent` (6-param post-125b) dispatch | idem patrón | `20260608000000:74-78` |
| Hardening de `debit_with_dest_policy` (5-param) | `ALTER FUNCTION public.debit_with_dest_policy(uuid, integer, numeric, text, text) SET search_path = public, pg_temp;` + REVOKE FROM PUBLIC, anon, authenticated + GRANT TO service_role | `20260606000000:134-139` |
| Hardening de `debit_session_and_parent` (6-param) | `...(uuid, text, uuid, integer, numeric, text)` | `20260606000000:227-232` |
| Hardening de `debit_delegation_and_parent` (6-param) | `...(uuid, text, uuid, integer, numeric, text)` | `20260608000000:88-93` |
| SELECT cold-path de owner en `budget.ts` (a espejar) | `budget.ts:247-255` | ver §6 |
| Mapeo `OWNERSHIP_MISMATCH` por string-match | `budget.ts:282-284` | ver §6 |
| `A2AAgentKeyRow` ya importado en budget.ts | sí, `budget.ts:8` | grep verificado |
| Tests que rompen por aridad (3-arg increment) | `budget.test.ts:185-189`, `:234-238`, `:495-499` (3 asserts) | ver §7 |
| Tests que NO rompen | `spend-policy.test.ts:378,399` usan `indexOf('PERFORM increment_a2a_key_spend(')` (prefix-match → matchea 4-arg). `test/migrate-preflight.test.ts:579,1073` usan strings literales hardcodeados (no leen la migración real). | grep verificado |
| `*.real.test.ts` que llaman el RPC directo | NINGUNO (grep vacío) | grep verificado |

> Si algo no está en esta tabla y lo necesitás, NO lo inventes: `Read`/`Grep` el archivo real primero.

---

## 4. Migración SQL — contenido literal

### 4.1 UP — `supabase/migrations/20260609000000_wkh_sec02b_owner_ref_rpc.sql`

> El timestamp `20260609000000` es > `20260608000000` (última migración del repo) → orden de aplicación correcto.

```sql
-- ============================================================
-- Migration: 20260609000000_wkh_sec02b_owner_ref_rpc
-- WKH-SEC-02b: Ownership Guard DB-level dentro de increment_a2a_key_spend.
-- La RPC pasa de 3 a 4 params (+ p_owner_ref TEXT) y valida que el owner_ref
-- pasado coincida con el registrado en a2a_agent_keys (defensa en profundidad;
-- la RPC ya está REVOKED de anon/authenticated). Los 3 RPCs que la invocan vía
-- PERFORM ya reciben p_owner_ref como parámetro propio → solo se agrega al PERFORM.
--
-- BLQ-MED-1 (recurrente ≥3 HUs, ref 114/auto-blindaje#75-95): CREATE OR REPLACE
-- con +1 param crea una SOBRECARGA, no reemplaza. DROP de la firma de 3 params
-- ANTES del CREATE de 4 → una sola función. (CD-1)
-- ============================================================

-- CD-1: DROP de la firma de 3 params ANTES del CREATE de 4.
DROP FUNCTION IF EXISTS increment_a2a_key_spend(uuid, integer, numeric);

-- Firma extendida (4 params). CD-5: cuerpo COPIADO LITERAL de
-- 20260406000000_a2a_agent_keys.sql:60-121; SOLO se agrega p_owner_ref y el
-- bloque del guard entre el IF NOT FOUND y el check de is_active.
CREATE OR REPLACE FUNCTION increment_a2a_key_spend(
  p_key_id     UUID,
  p_chain_id   INT,
  p_amount_usd NUMERIC,
  p_owner_ref  TEXT          -- NUEVO (WKH-SEC-02b): Ownership Guard DB-level
) RETURNS void AS $$
DECLARE
  v_row          a2a_agent_keys%ROWTYPE;
  v_chain_key    TEXT;
  v_current_bal  NUMERIC;
  v_new_bal      NUMERIC;
  v_daily_spent  NUMERIC;
  v_daily_limit  NUMERIC;
BEGIN
  -- Lock the row for atomic update
  SELECT * INTO v_row
    FROM a2a_agent_keys
    WHERE id = p_key_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'KEY_NOT_FOUND: key_id % does not exist', p_key_id;
  END IF;

  -- NUEVO (WKH-SEC-02b, AC-1): Ownership Guard DB-level. La fila ya está lockeada
  -- (FOR UPDATE). El service usa SERVICE_ROLE/bypass RLS → este check es la única
  -- defensa Postgres-level para la ruta directa.
  IF v_row.owner_ref IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key % not owned by caller', p_key_id;
  END IF;

  IF NOT v_row.is_active THEN
    RAISE EXCEPTION 'KEY_INACTIVE: key_id % is deactivated', p_key_id;
  END IF;

  -- Lazy daily reset (DT-5): if daily_reset_at is in the past, reset counters
  IF v_row.daily_reset_at < NOW() THEN
    v_row.daily_spent_usd := 0;
    -- Advance by 24h intervals until in the future
    WHILE v_row.daily_reset_at < NOW() LOOP
      v_row.daily_reset_at := v_row.daily_reset_at + INTERVAL '24 hours';
    END LOOP;
  END IF;

  -- Check daily limit
  v_daily_spent := v_row.daily_spent_usd;
  v_daily_limit := v_row.daily_limit_usd;

  IF v_daily_limit IS NOT NULL AND (v_daily_spent + p_amount_usd) > v_daily_limit THEN
    RAISE EXCEPTION 'DAILY_LIMIT: daily spend would be % + % = %, limit is %',
      v_daily_spent, p_amount_usd, v_daily_spent + p_amount_usd, v_daily_limit;
  END IF;

  -- Check chain budget
  v_chain_key := p_chain_id::TEXT;
  v_current_bal := COALESCE((v_row.budget ->> v_chain_key)::NUMERIC, 0);

  IF v_current_bal < p_amount_usd THEN
    RAISE EXCEPTION 'INSUFFICIENT_BUDGET: chain % balance is %, requested %',
      v_chain_key, v_current_bal, p_amount_usd;
  END IF;

  -- Debit
  v_new_bal := v_current_bal - p_amount_usd;

  UPDATE a2a_agent_keys
  SET
    budget          = jsonb_set(budget, ARRAY[v_chain_key], to_jsonb(v_new_bal::TEXT)),
    daily_spent_usd = v_row.daily_spent_usd + p_amount_usd,
    daily_reset_at  = v_row.daily_reset_at,
    last_used_at    = NOW()
  WHERE id = p_key_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- CD-6: Hardening de la NUEVA firma de 4 params (consistente con los RPCs hermanos).
ALTER FUNCTION public.increment_a2a_key_spend(uuid, integer, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.increment_a2a_key_spend(uuid, integer, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_a2a_key_spend(uuid, integer, numeric, text)
  TO service_role;

-- ============================================================
-- Caller #4: debit_with_dest_policy (firma INTACTA, 5 params). CREATE OR REPLACE
-- SIN DROP (la aridad no cambia). Solo se agrega p_owner_ref al PERFORM (L123 orig).
-- CD-10: el cuerpo es copia literal de 20260606000000:55-131 con ese único cambio.
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
  SELECT owner_ref INTO v_key_owner
    FROM a2a_agent_keys
    WHERE id = p_key_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KEY_NOT_FOUND: key_id % does not exist', p_key_id;
  END IF;

  IF v_key_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key % not owned by caller', p_key_id;
  END IF;

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

  IF v_has_policy THEN
    IF v_pol_wtype = 'rolling' THEN
      SELECT COALESCE(SUM(amount_usd), 0) INTO v_accum
        FROM a2a_key_dest_spend_ledger
        WHERE key_id = p_key_id
          AND destination = p_destination
          AND debited_at >= now() - (v_pol_wsecs * interval '1 second');
    ELSE
      SELECT COALESCE(SUM(amount_usd), 0) INTO v_accum
        FROM a2a_key_dest_spend_ledger
        WHERE key_id = p_key_id
          AND destination = p_destination;
    END IF;

    IF (v_accum + p_amount_usd) > v_pol_max THEN
      RAISE EXCEPTION 'DEST_CAP_EXCEEDED: dest % accum % + % > cap %',
        p_destination, v_accum, p_amount_usd, v_pol_max;
    END IF;
  END IF;

  -- WKH-SEC-02b: se agrega p_owner_ref al PERFORM (antes era 3-arg).
  PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref);

  IF v_has_policy THEN
    INSERT INTO a2a_key_dest_spend_ledger (key_id, owner_ref, destination, amount_usd)
    VALUES (p_key_id, p_owner_ref, p_destination, p_amount_usd);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.debit_with_dest_policy(uuid, integer, numeric, text, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.debit_with_dest_policy(uuid, integer, numeric, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_with_dest_policy(uuid, integer, numeric, text, text)
  TO service_role;

-- ============================================================
-- Caller #3: debit_session_and_parent (6 params, dispatch 125 INTACTO).
-- CREATE OR REPLACE SIN DROP (aridad no cambia). CD-10: SOLO el PERFORM del branch
-- ELSE pasa a 4-arg; el branch IF (debit_with_dest_policy) se preserva intacto.
-- Cuerpo: copia literal de 20260606000000:159-224 con ese único cambio.
-- ============================================================
CREATE OR REPLACE FUNCTION debit_session_and_parent(
  p_session_id  UUID,
  p_owner_ref   TEXT,
  p_key_id      UUID,
  p_chain_id    INT,
  p_amount_usd  NUMERIC,
  p_destination TEXT DEFAULT NULL
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
  SELECT owner_ref, key_id, revoked_at, expires_at, spent_usd, max_budget_usd
    INTO v_owner, v_key_id, v_revoked, v_expires, v_spent, v_max
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

  IF v_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'SESSION_REVOKED: %', p_session_id;
  END IF;
  IF NOW() >= v_expires THEN
    RAISE EXCEPTION 'SESSION_EXPIRED: %', p_session_id;
  END IF;

  v_new_spent := v_spent + p_amount_usd;
  IF v_new_spent > v_max THEN
    RAISE EXCEPTION 'SESSION_BUDGET_EXHAUSTED: % + % > %', v_spent, p_amount_usd, v_max;
  END IF;

  -- CD-10: dispatch 125 PRESERVADO. Solo el branch ELSE pasa p_owner_ref al PERFORM.
  IF p_destination IS NOT NULL AND p_destination <> '' THEN
    PERFORM debit_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination);
  ELSE
    PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref);
  END IF;

  UPDATE a2a_key_sessions SET spent_usd = v_new_spent WHERE id = p_session_id;

  RETURN v_new_spent;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric, text)
  TO service_role;

-- ============================================================
-- Caller #2: debit_delegation_and_parent (6 params post-125b, dispatch INTACTO).
-- CREATE OR REPLACE SIN DROP (aridad no cambia). CD-10: parte de la versión 6-param
-- de 125b; SOLO el PERFORM del branch ELSE pasa a 4-arg; el branch IF
-- (debit_with_dest_policy) se PRESERVA. Cuerpo: copia literal de 20260608000000:19-85.
-- ============================================================
CREATE OR REPLACE FUNCTION debit_delegation_and_parent(
  p_delegation_id UUID,
  p_owner_ref     TEXT,
  p_key_id        UUID,
  p_chain_id      INT,
  p_amount_usd    NUMERIC,
  p_destination   TEXT DEFAULT NULL
) RETURNS NUMERIC AS $$
DECLARE
  v_owner     TEXT;
  v_key_id    UUID;
  v_revoked   TIMESTAMPTZ;
  v_expires   TIMESTAMPTZ;
  v_total     NUMERIC;
  v_max_total NUMERIC;
  v_new_total NUMERIC;
BEGIN
  SELECT owner_ref, key_id, revoked_at, expires_at, total_spent,
         (policy->>'max_total_amount')::NUMERIC
    INTO v_owner, v_key_id, v_revoked, v_expires, v_total, v_max_total
    FROM a2a_delegations
    WHERE id = p_delegation_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DELEGATION_NOT_FOUND: %', p_delegation_id;
  END IF;

  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: delegation % not owned by caller', p_delegation_id;
  END IF;
  IF v_key_id IS DISTINCT FROM p_key_id THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: delegation % not bound to key %', p_delegation_id, p_key_id;
  END IF;

  IF v_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'DELEGATION_REVOKED: %', p_delegation_id;
  END IF;
  IF NOW() >= v_expires THEN
    RAISE EXCEPTION 'DELEGATION_EXPIRED: %', p_delegation_id;
  END IF;

  v_new_total := v_total + p_amount_usd;
  IF v_max_total IS NOT NULL AND v_new_total > v_max_total THEN
    RAISE EXCEPTION 'DELEGATION_TOTAL_LIMIT_EXCEEDED: % + % > %', v_total, p_amount_usd, v_max_total;
  END IF;

  -- CD-10: dispatch 125b PRESERVADO. Solo el branch ELSE pasa p_owner_ref al PERFORM.
  IF p_destination IS NOT NULL AND p_destination <> '' THEN
    PERFORM debit_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination);
  ELSE
    PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd, p_owner_ref);
  END IF;

  UPDATE a2a_delegations SET total_spent = v_new_total WHERE id = p_delegation_id;

  RETURN v_new_total;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric, text)
  TO service_role;
```

> ⚠️ ORDEN DDL OBLIGATORIO en el up: (1) DROP `increment` 3-param → (2) CREATE
> `increment` 4-param + hardening → (3) `debit_with_dest_policy` → (4) `debit_session_and_parent`
> → (5) `debit_delegation_and_parent`. `increment` 4-param DEBE existir antes de los 3
> `CREATE OR REPLACE` que la referencian en su PERFORM (PL/pgSQL resuelve el PERFORM en
> runtime, no en parse, así que técnicamente el orden de los 3 RPCs entre sí es libre;
> mantené igual este orden por claridad).

### 4.2 DOWN — `supabase/migrations/20260609000000_wkh_sec02b_owner_ref_rpc_down.sql`

Restaura: `increment` a 3-param (cuerpo literal original, **SIN hardening** — la
original `20260406000000` NO lo tenía, CD-6) + los 3 RPCs a su estado post-125b
(PERFORM 3-arg, dispatch preservado, hardening 6-param restaurado).

```sql
-- WKH-SEC-02b down-migration. Restaura:
--  - increment_a2a_key_spend a su firma de 3 params (cuerpo literal de
--    20260406000000:56-121, SIN hardening — la original no lo tenía, CD-6).
--  - los 3 RPCs dependientes a su estado post-125b (PERFORM 3-arg en el branch ELSE,
--    dispatch a debit_with_dest_policy preservado).
-- Rollback atómico reversible (CD-2/AC-4).

-- 1. DROP de la firma 4-param + CREATE de la 3-param original (literal).
DROP FUNCTION IF EXISTS increment_a2a_key_spend(uuid, integer, numeric, text);

CREATE OR REPLACE FUNCTION increment_a2a_key_spend(
  p_key_id    UUID,
  p_chain_id  INT,
  p_amount_usd NUMERIC
) RETURNS void AS $$
DECLARE
  v_row          a2a_agent_keys%ROWTYPE;
  v_chain_key    TEXT;
  v_current_bal  NUMERIC;
  v_new_bal      NUMERIC;
  v_daily_spent  NUMERIC;
  v_daily_limit  NUMERIC;
BEGIN
  SELECT * INTO v_row
    FROM a2a_agent_keys
    WHERE id = p_key_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'KEY_NOT_FOUND: key_id % does not exist', p_key_id;
  END IF;

  IF NOT v_row.is_active THEN
    RAISE EXCEPTION 'KEY_INACTIVE: key_id % is deactivated', p_key_id;
  END IF;

  IF v_row.daily_reset_at < NOW() THEN
    v_row.daily_spent_usd := 0;
    WHILE v_row.daily_reset_at < NOW() LOOP
      v_row.daily_reset_at := v_row.daily_reset_at + INTERVAL '24 hours';
    END LOOP;
  END IF;

  v_daily_spent := v_row.daily_spent_usd;
  v_daily_limit := v_row.daily_limit_usd;

  IF v_daily_limit IS NOT NULL AND (v_daily_spent + p_amount_usd) > v_daily_limit THEN
    RAISE EXCEPTION 'DAILY_LIMIT: daily spend would be % + % = %, limit is %',
      v_daily_spent, p_amount_usd, v_daily_spent + p_amount_usd, v_daily_limit;
  END IF;

  v_chain_key := p_chain_id::TEXT;
  v_current_bal := COALESCE((v_row.budget ->> v_chain_key)::NUMERIC, 0);

  IF v_current_bal < p_amount_usd THEN
    RAISE EXCEPTION 'INSUFFICIENT_BUDGET: chain % balance is %, requested %',
      v_chain_key, v_current_bal, p_amount_usd;
  END IF;

  v_new_bal := v_current_bal - p_amount_usd;

  UPDATE a2a_agent_keys
  SET
    budget          = jsonb_set(budget, ARRAY[v_chain_key], to_jsonb(v_new_bal::TEXT)),
    daily_spent_usd = v_row.daily_spent_usd + p_amount_usd,
    daily_reset_at  = v_row.daily_reset_at,
    last_used_at    = NOW()
  WHERE id = p_key_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
-- (sin hardening: la firma original de 3 params nunca lo tuvo — CD-6.)

-- 2. debit_with_dest_policy: restaurar PERFORM 3-arg (estado post-125).
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
  SELECT owner_ref INTO v_key_owner
    FROM a2a_agent_keys
    WHERE id = p_key_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KEY_NOT_FOUND: key_id % does not exist', p_key_id;
  END IF;

  IF v_key_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key % not owned by caller', p_key_id;
  END IF;

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

  IF v_has_policy THEN
    IF v_pol_wtype = 'rolling' THEN
      SELECT COALESCE(SUM(amount_usd), 0) INTO v_accum
        FROM a2a_key_dest_spend_ledger
        WHERE key_id = p_key_id
          AND destination = p_destination
          AND debited_at >= now() - (v_pol_wsecs * interval '1 second');
    ELSE
      SELECT COALESCE(SUM(amount_usd), 0) INTO v_accum
        FROM a2a_key_dest_spend_ledger
        WHERE key_id = p_key_id
          AND destination = p_destination;
    END IF;

    IF (v_accum + p_amount_usd) > v_pol_max THEN
      RAISE EXCEPTION 'DEST_CAP_EXCEEDED: dest % accum % + % > cap %',
        p_destination, v_accum, p_amount_usd, v_pol_max;
    END IF;
  END IF;

  PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd);

  IF v_has_policy THEN
    INSERT INTO a2a_key_dest_spend_ledger (key_id, owner_ref, destination, amount_usd)
    VALUES (p_key_id, p_owner_ref, p_destination, p_amount_usd);
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.debit_with_dest_policy(uuid, integer, numeric, text, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.debit_with_dest_policy(uuid, integer, numeric, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_with_dest_policy(uuid, integer, numeric, text, text)
  TO service_role;

-- 3. debit_session_and_parent: restaurar PERFORM 3-arg en el branch ELSE (post-125).
CREATE OR REPLACE FUNCTION debit_session_and_parent(
  p_session_id  UUID,
  p_owner_ref   TEXT,
  p_key_id      UUID,
  p_chain_id    INT,
  p_amount_usd  NUMERIC,
  p_destination TEXT DEFAULT NULL
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
  SELECT owner_ref, key_id, revoked_at, expires_at, spent_usd, max_budget_usd
    INTO v_owner, v_key_id, v_revoked, v_expires, v_spent, v_max
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

  IF v_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'SESSION_REVOKED: %', p_session_id;
  END IF;
  IF NOW() >= v_expires THEN
    RAISE EXCEPTION 'SESSION_EXPIRED: %', p_session_id;
  END IF;

  v_new_spent := v_spent + p_amount_usd;
  IF v_new_spent > v_max THEN
    RAISE EXCEPTION 'SESSION_BUDGET_EXHAUSTED: % + % > %', v_spent, p_amount_usd, v_max;
  END IF;

  IF p_destination IS NOT NULL AND p_destination <> '' THEN
    PERFORM debit_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination);
  ELSE
    PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd);
  END IF;

  UPDATE a2a_key_sessions SET spent_usd = v_new_spent WHERE id = p_session_id;

  RETURN v_new_spent;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric, text)
  TO service_role;

-- 4. debit_delegation_and_parent: restaurar PERFORM 3-arg en el branch ELSE (post-125b).
CREATE OR REPLACE FUNCTION debit_delegation_and_parent(
  p_delegation_id UUID,
  p_owner_ref     TEXT,
  p_key_id        UUID,
  p_chain_id      INT,
  p_amount_usd    NUMERIC,
  p_destination   TEXT DEFAULT NULL
) RETURNS NUMERIC AS $$
DECLARE
  v_owner     TEXT;
  v_key_id    UUID;
  v_revoked   TIMESTAMPTZ;
  v_expires   TIMESTAMPTZ;
  v_total     NUMERIC;
  v_max_total NUMERIC;
  v_new_total NUMERIC;
BEGIN
  SELECT owner_ref, key_id, revoked_at, expires_at, total_spent,
         (policy->>'max_total_amount')::NUMERIC
    INTO v_owner, v_key_id, v_revoked, v_expires, v_total, v_max_total
    FROM a2a_delegations
    WHERE id = p_delegation_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DELEGATION_NOT_FOUND: %', p_delegation_id;
  END IF;

  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: delegation % not owned by caller', p_delegation_id;
  END IF;
  IF v_key_id IS DISTINCT FROM p_key_id THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: delegation % not bound to key %', p_delegation_id, p_key_id;
  END IF;

  IF v_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'DELEGATION_REVOKED: %', p_delegation_id;
  END IF;
  IF NOW() >= v_expires THEN
    RAISE EXCEPTION 'DELEGATION_EXPIRED: %', p_delegation_id;
  END IF;

  v_new_total := v_total + p_amount_usd;
  IF v_max_total IS NOT NULL AND v_new_total > v_max_total THEN
    RAISE EXCEPTION 'DELEGATION_TOTAL_LIMIT_EXCEEDED: % + % > %', v_total, p_amount_usd, v_max_total;
  END IF;

  IF p_destination IS NOT NULL AND p_destination <> '' THEN
    PERFORM debit_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination);
  ELSE
    PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd);
  END IF;

  UPDATE a2a_delegations SET total_spent = v_new_total WHERE id = p_delegation_id;

  RETURN v_new_total;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric, text)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_delegation_and_parent(uuid, text, uuid, integer, numeric, text)
  TO service_role;
```

---

## 5. Exemplars verificados (espejá ESTOS — archivo:línea real)

### 5.1 Guard owner_ref (espejado en el up de `increment`)

`supabase/migrations/20260606000000_a2a_key_spend_policies.sql:81-83`:
```sql
  IF v_key_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: key % not owned by caller', p_key_id;
  END IF;
```
En `increment` la variable es `v_row.owner_ref` (no `v_key_owner`), porque ahí el row se
trae con `SELECT *` a `v_row` (`20260406000000:70`).

### 5.2 DROP-antes-de-CREATE (BLQ-MED-1)

`supabase/migrations/20260606000000_a2a_key_spend_policies.sql:157`:
```sql
DROP FUNCTION IF EXISTS debit_session_and_parent(uuid, text, uuid, integer, numeric);
```
`supabase/migrations/20260608000000_wkh125b_delegation_dest_cap.sql:17`:
```sql
DROP FUNCTION IF EXISTS debit_delegation_and_parent(uuid, text, uuid, integer, numeric);
```
→ en esta HU: `DROP FUNCTION IF EXISTS increment_a2a_key_spend(uuid, integer, numeric);` ANTES del CREATE de 4-param. Solo `increment` necesita DROP (es la única que cambia de aridad).

### 5.3 Dispatch condicional 125b (PRESERVAR — solo tocar el branch ELSE)

`supabase/migrations/20260608000000_wkh125b_delegation_dest_cap.sql:74-78`:
```sql
  IF p_destination IS NOT NULL AND p_destination <> '' THEN
    PERFORM debit_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination);
  ELSE
    PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd);   -- ← solo este pasa a 4-arg
  END IF;
```

### 5.4 SELECT cold-path de owner (espejado en `budget.ts` caller #1)

`src/services/budget.ts:247-255`:
```ts
      const { data: keyRow, error: ownerErr } = await supabase
        .from('a2a_agent_keys')
        .select('owner_ref')
        .eq('id', keyId)
        .single();
      if (ownerErr || !keyRow) {
        return { success: false, error: 'KEY_NOT_FOUND' };
      }
      const ownerRef = (keyRow as Pick<A2AAgentKeyRow, 'owner_ref'>).owner_ref;
```

### 5.5 Mapeo OWNERSHIP_MISMATCH por string-match

`src/services/budget.ts:282-284`:
```ts
        if (msg.includes('OWNERSHIP_MISMATCH')) {
          return { success: false, error: 'OWNERSHIP_MISMATCH' };
        }
```

---

## 6. Cambio TS exacto — `src/services/budget.ts` (caller #1, ruta master-no-dest)

**Estado actual** (`budget.ts:297-308`):
```ts
    // ── RUTA MASTER KEY — INTACTA (camino actual, CD-5) ──
    const { error } = await supabase.rpc('increment_a2a_key_spend', {
      p_key_id: keyId,
      p_chain_id: chainId,
      p_amount_usd: amountUsd,
    });

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  },
```

**Reemplazar por** (SELECT cold-path → `p_owner_ref` → mapeo OWNERSHIP_MISMATCH):
```ts
    // ── RUTA MASTER KEY — owner guard DB-level (WKH-SEC-02b) ──
    // El RPC ahora exige p_owner_ref. Mismo SELECT cold-path que la ruta
    // dest-aware (L247-255); solo esta ruta directa de baja frecuencia.
    const { data: keyRow, error: ownerErr } = await supabase
      .from('a2a_agent_keys')
      .select('owner_ref')
      .eq('id', keyId)
      .single();
    if (ownerErr || !keyRow) {
      return { success: false, error: 'KEY_NOT_FOUND' };
    }
    const ownerRef = (keyRow as Pick<A2AAgentKeyRow, 'owner_ref'>).owner_ref;

    const { error } = await supabase.rpc('increment_a2a_key_spend', {
      p_key_id: keyId,
      p_chain_id: chainId,
      p_amount_usd: amountUsd,
      p_owner_ref: ownerRef, // WKH-SEC-02b (AC-2)
    });

    if (error) {
      // CD-3/AC-6: no propagar el msg crudo de PG para OWNERSHIP_MISMATCH.
      if (error.message.includes('OWNERSHIP_MISMATCH')) {
        return { success: false, error: 'OWNERSHIP_MISMATCH' };
      }
      return { success: false, error: error.message };
    }

    return { success: true };
  },
```

Notas:
- `A2AAgentKeyRow` YA está importado (`budget.ts:8`). No agregar import.
- El branch genérico `return { success: false, error: error.message }` se **mantiene**
  para DAILY_LIMIT / INSUFFICIENT_BUDGET / KEY_INACTIVE (regresión cero — tests L193-223).
- NO cambiar la firma de `debit()` (DT-4 opción a). Cero cambios en call-sites.

---

## 7. Tests existentes que rompen por aridad (3-arg → 4-arg) — fix exacto

Tres aserciones esperan el `rpc('increment_a2a_key_spend', { 3 props })`. Tras el cambio,
el RPC recibe `p_owner_ref` ⇒ esas aserciones fallan. Además, ahora hay un SELECT
cold-path previo, así que el mock `supabase.from(...)` debe devolver `owner_ref`.

| Test | Línea | Fix |
|------|-------|-----|
| `'calls supabase.rpc with correct params and returns success (AC-9)'` | `budget.test.ts:180-191` | (a) mockear el SELECT owner: `mockFrom.mockReturnValue` con `single → { data: { owner_ref: 'user-1' }, error: null }` (usar `chainMock`); (b) agregar `p_owner_ref: 'user-1'` al objeto esperado en `toHaveBeenCalledWith` (L185-189). |
| `'T14 master key path uses increment_a2a_key_spend, not the delegation RPC (AC-13)'` | `budget.test.ts:229-241` | mismo fix: mock SELECT owner + agregar `p_owner_ref: 'user-1'` (L234-238). `mockDebitDelegation` NO se llama (intacto). |
| `'AC-5 back-compat: no destination → increment_a2a_key_spend directo'` | `budget.test.ts:490-505` | mismo fix: mock SELECT owner + agregar `p_owner_ref: 'user-1'` (L495-499). Mantener el `expect(mockRpc).not.toHaveBeenCalledWith('debit_with_dest_policy', ...)`. |

> Helper disponible: `chainMock(overrides)` (`budget.test.ts:91-105`) y el patrón
> `mockOwnerSelect(ownerRef)` (`budget.test.ts:473-486`) que ya hace exactamente este
> mock del SELECT cold-path. **Reusá `mockOwnerSelect('user-1')`** antes de cada
> `debit('key-1', ...)` 3-arg afectado (ya está en el mismo `describe('debit')`).

### Tests que NO rompen (verificado — no tocar)

- `spend-policy.test.ts:378` y `:399` usan `indexOf('PERFORM increment_a2a_key_spend')` /
  `toContain('PERFORM increment_a2a_key_spend(')` → prefix match, sigue matcheando el 4-arg.
- `test/migrate-preflight.test.ts:579,1073` usan strings SQL hardcodeados como fixtures
  del analizador, NO leen la migración real.
- Ningún `*.real.test.ts` invoca `increment_a2a_key_spend` directamente (grep vacío).

---

## 8. Tests nuevos requeridos (≥1 por AC) — todos en `budget.test.ts`, `describe('debit')`

| Test (nombre sugerido) | AC | Caso |
|------------------------|-----|------|
| `WKH-SEC-02b master: válido pasa p_owner_ref al RPC` | AC-2 | `mockOwnerSelect('user-1')` + `mockRpc → {error:null}`; `debit('key-1', 2368, 1.5)` ⇒ `rpc('increment_a2a_key_spend', { p_key_id:'key-1', p_chain_id:2368, p_amount_usd:1.5, p_owner_ref:'user-1' })` y `{ success:true }`. |
| `WKH-SEC-02b master: OWNERSHIP_MISMATCH mapea a code estable` | AC-1, AC-6 | `mockOwnerSelect('user-1')` + `mockRpc → { error: { message: 'OWNERSHIP_MISMATCH: key x not owned by caller' } }`; resultado `{ success:false, error:'OWNERSHIP_MISMATCH' }` (NO el msg crudo). |
| `WKH-SEC-02b master: KEY_NOT_FOUND en SELECT cold-path no llama al RPC` | AC-2 (borde) | `mockOwnerSelect(null)` (devuelve `{data:null,error:{code:'PGRST116'}}`); resultado `{ success:false, error:'KEY_NOT_FOUND' }` y `expect(mockRpc).not.toHaveBeenCalled()`. |
| `WKH-SEC-02b master: DAILY_LIMIT/INSUFFICIENT_BUDGET siguen devolviendo msg previo` | AC-5 | regresión: ya cubierto por L193-223 tras el fix de mock (verificar que siguen verdes con el SELECT mockeado). |

> AC-3 (PERFORM 4-arg en los 3 RPCs + dispatch preservado) y AC-4 (down restaura) se validan
> por **inspección del SQL en CR/QA** (no hay infra de test SQL estructural para esta migración;
> `spend-policy.test.ts` lee solo `20260606000000`). Si querés cubrirlo en código sin
> ampliar scope, NO crees un test SQL nuevo que lea el archivo (riesgo CD-7 de substring
> frágil); dejalo para evidencia archivo:línea en QA. AC-5 (suite verde + tsc + biome) en §9.

---

## 9. Definition of Done

- [ ] `supabase/migrations/20260609000000_wkh_sec02b_owner_ref_rpc.sql` creado (up, §4.1).
- [ ] `supabase/migrations/20260609000000_wkh_sec02b_owner_ref_rpc_down.sql` creado (down, §4.2).
- [ ] `src/services/budget.ts` ruta master-no-dest modificada (§6) — sin cambiar la firma de `debit()`.
- [ ] `src/services/budget.test.ts`: 3 aserciones 3-arg arregladas (§7) + 4 tests nuevos (§8).
- [ ] `npx tsc --noEmit` → 0 errores.
- [ ] `./node_modules/.bin/biome check src/services/budget.ts src/services/budget.test.ts` → 0 (CD-8).
- [ ] `npm test` (o el runner del repo) → suite completa verde, sin regresión (AC-5).
- [ ] `git diff origin/main --name-only` toca SOLO los 4 archivos del Scope IN (CD-9/CD-11).
- [ ] ≥1 test por AC (AC-1, AC-2, AC-6 con tests TS; AC-3/AC-4 por evidencia SQL en QA; AC-5 por suite).

---

## 10. Constraint Directives por wave (CD-1..11)

| CD | Regla | Wave |
|----|-------|------|
| CD-1 | DROP `increment_a2a_key_spend(uuid, integer, numeric)` ANTES del CREATE de 4-param (BLQ-MED-1). | W0 |
| CD-2 | El down restaura EXACTAMENTE la firma 3-param + cuerpo original y los 3 RPCs a estado post-125b. | W0 |
| CD-3 | NO propagar el msg crudo de PG `OWNERSHIP_MISMATCH`; mapear a `{success:false,error:'OWNERSHIP_MISMATCH'}`. | W1 |
| CD-4 | Migración idempotente: `DROP ... IF EXISTS` + `CREATE OR REPLACE`; re-run down+up consistente. | W0 |
| CD-5 | NO modificar la lógica existente de `increment` (daily reset, chain budget, KEY_INACTIVE, KEY_NOT_FOUND). Solo agregar el guard entre `IF NOT FOUND` y `is_active`; resto copiado literal de `20260406000000:60-121`. | W0 |
| CD-6 | Hardening (`search_path`+REVOKE+GRANT) en la NUEVA firma 4-param de `increment`. El down NO agrega hardening a la firma 3-param (la original no lo tenía). | W0 |
| CD-7 | Si se escribe algún test estructural SQL: contar sentencias DDL completas, NO substrings de comentarios (WKH-116). En esta HU se recomienda evidencia por inspección en QA en vez de test SQL nuevo. | W2 |
| CD-8 | Aserciones de test largas ya multilínea; correr `biome check` sobre archivos tocados antes de cerrar. | W2 |
| CD-9 | NO expandir scope para lint pre-existente; separar con `git diff origin/main -- <file>`; lint scopeado a los 4 archivos = 0. | W3 |
| CD-10 | NO romper el dispatch condicional 125/125b en `debit_session_and_parent` y `debit_delegation_and_parent`. Partir de la firma 6-param; el branch `IF p_destination ... THEN debit_with_dest_policy` se preserva intacto; solo el branch ELSE pasa `p_owner_ref`. | W0 |
| CD-11 | PROHIBIDO tocar `register_a2a_key_deposit`, `delegation.ts`, `key-session.ts`, `src/routes/`, `compose.ts`, el call-site 3-arg de `a2a-key.ts`. Caller #1 TS = exclusivamente la ruta master-no-dest de `budget.ts`. | todas |

---

## 11. Orden serial de waves

```
W0 (Serial Gate — migración SQL)
  W0.1  crear up   (§4.1): DROP increment 3p → CREATE increment 4p+guard+hardening (CD-1/5/6)
                   → CREATE OR REPLACE debit_with_dest_policy (PERFORM 4-arg)
                   → CREATE OR REPLACE debit_session_and_parent (branch ELSE 4-arg, dispatch intacto, CD-10)
                   → CREATE OR REPLACE debit_delegation_and_parent (branch ELSE 4-arg, dispatch intacto, CD-10)
  W0.2  crear down (§4.2): DROP increment 4p → CREATE increment 3p (literal, sin hardening, CD-6)
                   → restaurar PERFORM 3-arg en los 3 RPCs (post-125b, dispatch intacto)
        ↓ (gate: el TS depende de la firma nueva)
W1 (TS — caller #1)
  W1.1  budget.ts ruta master-no-dest (§6): SELECT cold-path owner + p_owner_ref + mapeo (CD-3)
        ↓
W2 (Tests)
  W2.1  budget.test.ts: arreglar 3 asserts 3-arg (§7) + 4 tests nuevos (§8); biome (CD-8)
        ↓
W3 (Verificación final)
  W3.1  tsc 0 · biome 0 (archivos tocados) · suite verde · git diff = solo Scope IN (CD-9/11)
```

---

*Story File generado por NexusAgil — Architect F2.5. Contrato autocontenido; no requiere releer el SDD.*
