# Story File — #114: [WKH-125] KEY-CONSTRAINTS (caps de gasto por destino + ventanas rolling/total)

> SDD: doc/sdd/114-wkh-125-constraints/sdd.md
> Fecha: 2026-06-19
> Branch: feat/114-wkh-125-constraints
> Épica: E16 (Agent Key mejor que Kite Passport) — **última HU**. WKH-121/122/123/124 DONE y mergeadas.

---

## Goal

Limitar el **gasto acumulado por destino** de una Agent Key (un agente, identificado
como `"<registry>/<slug>"`) dentro de una **ventana de tiempo** (rolling en segundos, o
total de por vida). Se agregan **2 tablas** (`a2a_key_spend_policies` para las políticas;
`a2a_key_dest_spend_ledger` para el acumulado), **1 RPC atómico nuevo** (`debit_with_dest_policy`)
que extiende el patrón de `debit_session_and_parent`, un service de CRUD ownership-guarded
(`spend-policy.ts`), endpoints `PUT/GET /auth/keys/me/spend-policies`, y la propagación del
destino desde compose/orchestrate/step-0 al débito.

Cierra el gap con el Kite Passport ("no gastar más de $50 con vendor X") con **back-compat
absoluta**: una key/sesión **sin políticas** se comporta EXACTAMENTE igual que hoy
(WKH-121/122/123/124 intactos; cero checks nuevos, cero errores nuevos, cero regresión en el
hot-path).

**Atomicidad TOTAL en el RPC**: check del cap + debit del budget + INSERT en el ledger ocurren
en la MISMA transacción PostgreSQL, con `FOR UPDATE` sobre la policy + la key. Débitos
concurrentes al mismo destino serializan y NO producen race condition.

---

## Acceptance Criteria (EARS)

> Copiados del SDD/work-item aprobados. QA los verifica en F4 con evidencia archivo:línea.

1. **AC-1 (SET-POLICY)** WHEN un owner llama `PUT /auth/keys/me/spend-policies` con `{ destination, max_usd, window }` válido y su `owner_ref`, THE sistema SHALL persistir la política en `a2a_key_spend_policies` filtrando por `owner_ref` y retornar 200 con la política guardada.
2. **AC-2 (CAP-REJECT)** WHEN se solicita un débito para un destino con política activa Y el acumulado en la ventana + el monto excedería `max_usd`, THE sistema SHALL rechazar con `DEST_CAP_EXCEEDED` (HTTP **402**) y SHALL NOT decrementar el budget de la key.
3. **AC-3 (WINDOW-RESET)** WHILE una política tiene `window_type='rolling'` con `window_secs=N`, THE sistema SHALL computar el acumulado SOLO sobre débitos con `debited_at >= now() - N segundos` (rolling, NO calendar-reset). Débitos fuera de la ventana NO cuentan.
4. **AC-4 (ATOMIC-DEBIT)** WHEN el sistema chequea el cap por destino y debita el budget, ambas operaciones SHALL ejecutarse en la misma transacción PostgreSQL con `FOR UPDATE` sobre `a2a_key_spend_policies` + `a2a_agent_keys`, de modo que débitos concurrentes al mismo destino SHALL serializar y SHALL NOT producir race condition que deje pasar dos cuando solo uno debía.
5. **AC-5 (BACK-COMPAT)** WHILE una key/sesión NO tiene políticas, THE sistema SHALL comportarse exactamente como hoy (paths WKH-121/122/123/124 sin cambios; sin nuevos checks ni errores en el hot-path).
6. **AC-6 (SESSION-INHERIT)** WHEN se crea/usa una key session, THE sistema SHALL aplicar las políticas activas de la parent key a esa sesión (herencia, vía dispatch interno del RPC de sesión a `debit_with_dest_policy`). El override per-session real es **`[TBD-FUTURO]`** (el campo `spend_policies?` se agrega al tipo pero su semántica "override por la vida de la sesión" NO se implementa en este MVP).
7. **AC-7 (OWNERSHIP-GUARD)** WHEN cualquier service lee/escribe `a2a_key_spend_policies` o `a2a_key_dest_spend_ledger`, la query SHALL incluir `.eq('key_id', keyId).eq('owner_ref', ownerId)` con `ownerId: string` (no-opcional), y SHALL lanzar `OwnershipMismatchError` si el row no existe bajo ese owner. En el RPC: ownership guard DB-layer (`v_key_owner IS DISTINCT FROM p_owner_ref`).

---

## Files to Modify/Create

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `src/types/a2a-key.ts` | **Modificar** | `SpendPolicyWindowType`, `SpendPolicyInput`, `SpendPolicyRow`, `SpendPolicy` (response shape); extender `CreateKeySessionInput` con `spend_policies?: SpendPolicyInput[]` (campo `[TBD-FUTURO]`, ver AC-6). | `src/types/a2a-key.ts:351-355` (`KeySessionDebitContext`) |
| 2 | `src/services/security/errors.ts` | **Modificar** | `DestCapExceededError` (`readonly code = 'DEST_CAP_EXCEEDED' as const`). Reusar `OwnershipMismatchError` existente. | `src/services/security/errors.ts:304-310` (`SessionBudgetExhaustedError`) |
| 3 | `supabase/migrations/20260606000000_a2a_key_spend_policies.sql` | **Crear** | 2 tablas + índices + RPC `debit_with_dest_policy` + `CREATE OR REPLACE` de `debit_session_and_parent` extendido (AC-6) + hardening. **SQL textual abajo — copiar tal cual.** | `supabase/migrations/20260603000000_a2a_key_sessions.sql:1-100` |
| 4 | `supabase/migrations/20260606000000_a2a_key_spend_policies_down.sql` | **Crear** | DROP RPC nuevo + DROP de las 2 tablas + restaurar `debit_session_and_parent` original. **SQL textual abajo.** | `..._a2a_key_sessions_down.sql` |
| 5 | `src/services/spend-policy.ts` | **Crear** | `set`/`list`/`delete`/`hasAnyPolicy` (CRUD ownership-guarded + normalización de destino + validación de invariante de ventana). | `src/services/key-session.ts:295-373` (`list`/`revoke`) |
| 6 | `src/services/budget.ts` | **Modificar** | 6º param posicional `destination?: string` en `debit()`. Rama master: si `destination` truthy → `rpc('debit_with_dest_policy', ...)` con mapeo de errores por prefijo; si falsy → `increment_a2a_key_spend` **INTACTO**. | `src/services/budget.ts:225-236` (ruta master) + `src/services/key-session.ts:454-491` (mapeo) |
| 7 | `src/services/compose.ts` | **Modificar** | Armar `destination = \`${agent.registry}/${agent.slug}\`` y pasarlo como **6º arg** de `debit` en el call-site per-step (L159). Guard `i>0` (CD-7) intacto. | `src/services/compose.ts:159-165` |
| 8 | `src/routes/compose.ts` | **Modificar** | (a) En `resolveComposePriceHandler` augmentar `request.composeDestination = \`${registry}/${slug}\`` (normalizado) cuando se resuelve `firstStep`. (b) Branch `errorCode==='DEST_CAP_EXCEEDED'` → **402** en el mapeo de compose-result. | `src/routes/compose.ts:43-80` + `:179-181` |
| 9 | `src/middleware/a2a-key.ts` | **Modificar** | (a) Declarar `composeDestination?: string` en la module-augmentation de `FastifyRequest` (~L60, junto a `composeEstimatedCostUsd`). (b) Step-0 debit: **condicional** — si `request.composeDestination` truthy → llamar `debit(keyRow.id, chainId, estimatedCostUsd, undefined, undefined, request.composeDestination)`; si no → dejar la llamada de 3 args INTACTA. (c) Mapear `DEST_CAP_EXCEEDED` → **402**. | `src/middleware/a2a-key.ts:60` + `:789-817` |
| 10 | `src/routes/auth.ts` | **Modificar** | `PUT /auth/keys/me/spend-policies` (set, 200) + `GET /auth/keys/me/spend-policies` (list) + `DELETE /auth/keys/me/spend-policies/:destination` (opcional). `resolveCallerKey` + ownership + error mapping. | `src/routes/auth.ts:1116-1240` (key-session endpoints) |
| 11 | `src/services/key-session.ts` | **Modificar** | `debitSessionAndParent`: agregar param posicional `destination?: string` AL FINAL; pasar `p_destination` al RPC; agregar mapeo `DEST_CAP_EXCEEDED`→`DestCapExceededError`. (El dispatch interno a `debit_with_dest_policy` vive en el SQL del RPC `debit_session_and_parent`, archivo #3.) | `src/services/key-session.ts:439-495` |
| 12 | `src/services/compose.test.ts` | **Modificar** | Actualizar TODAS las aserciones de aridad de `mockDebit` que enumeran los 5 args (agregar 6º arg `destination` o `undefined`) — ver §Aridad. | — |
| 13 | `src/services/orchestrate.billing.test.ts` | **Modificar** | Ídem — agregar 6º arg a las aserciones de 5 args. | — |
| 14 | `src/services/budget.test.ts` | **Modificar** | Tests del path dest-aware (RPC) + back-compat (sin destino = `increment` directo). | — |
| 15 | `src/services/spend-policy.test.ts` | **Crear** | CRUD + ownership + window invariante + window rolling + concurrencia. | `src/services/key-session.test.ts` |
| 16 | `src/routes/auth.spend-policies.test.ts` | **Crear** | Endpoints PUT/GET (persiste + ownership). | `src/routes/auth.ts` (key-session route tests) |

> **NO se toca `src/services/orchestrate.ts`** (verificado): orchestrate NO llama `debit` directo;
> delega en `composeService.compose(...)`. La propagación del destino se resuelve íntegramente
> dentro de `compose.ts`. (El work-item lista orchestrate.ts en Scope IN, pero el SDD §3 lo descarta:
> orchestrate no cambia su firma a `debit`.)

---

## Aridad de `budgetService.debit` — APPROACH EXACTO (CRÍTICO, lección WKH-121)

**Decisión (SDD DT-1):** `destination?: string` como **param posicional AL FINAL** de `debit`:

```
async debit(
  keyId: string,
  chainId: number,
  amountUsd: number,
  delegationContext?: DelegationDebitContext,
  keySessionContext?: KeySessionDebitContext,
  destination?: string,   // ← NUEVO, 6º param posicional
): Promise<{ success: boolean; error?: string }>
```

### Regla para los call-sites de `debit`

- **`compose.ts:159` (per-step):** SIEMPRE pasa el 6º arg `destination` (hay agente resuelto → `\`${agent.registry}/${agent.slug}\``). Va como 6º posicional (delegation/session ctx ya son 4º/5º).
- **`a2a-key.ts:789` (step-0 / master / gasless / x402):** la llamada es **compartida** por TODAS las rutas. **CONDICIONAL** (CD-8b): si `request.composeDestination` truthy → `debit(keyRow.id, chainId, estimatedCostUsd, undefined, undefined, request.composeDestination)` (6 args); si no → **dejar la llamada actual de 3 args INTACTA** `debit(keyRow.id, chainId, estimatedCostUsd)`. Así las rutas master/gasless/x402 NO suman arg y sus tests de 3-arg NO rompen.

### Las aserciones de los tests — INSTRUCCIÓN VINCULANTE

> El SDD enumeró ~12, pero el grep real muestra MÁS. **NO confiar en un número fijo.**
> El Dev DEBE correr el grep ANTES de tocar y actualizar CADA aserción que enumere los args.

```bash
grep -rn "Debit).toHaveBeenCalledWith\|Debit).toHaveBeenNthCalledWith" src/
```

Regla mecánica por aserción:

1. **Aserciones que enumeran 5 args** (`KEY, chain, amount, ctxA, ctxB`) en
   `compose.test.ts` (~20 ocurrencias: L1115, 1158, 1166, 1220, 1228, 1411, 1490, 1559, 1567, 1613, 1621, 1668, … — confirmá con el grep) y `orchestrate.billing.test.ts` (~6: L222, 230, 262, 269, …):
   estas llamadas pasan por la cadena **compose** → AHORA reciben un **6º arg = destino**.
   - Para tests con agente real resuelto (la mayoría): el 6º arg = `\`${registry}/${slug}\`` del `makeAgent` correspondiente (normalizado: `.trim().toLowerCase()`).
   - Para los pocos sin destino aplicable: 6º arg = `undefined`.
   - En las `.not.toHaveBeenCalledWith(...)` (anti-double-charge), agregá el 6º arg coherente con la llamada que NO debe ocurrir.
2. **Aserciones de 3 args** (`KEY, chain, amount`) en `a2a-key.test.ts` (~18: master/x402/gasless/compose-MW) y `gasless.test.ts` (L213, 258, 363): **NO se tocan** SI la llamada del middleware se mantiene condicional (3-arg cuando no hay `composeDestination`). Los tests `T-MW-COMPOSE-1/2` (a2a-key.test.ts L1112/1129) inyectan solo `composeEstimatedCostUsd`, NO `composeDestination` → siguen siendo 3-arg → NO se tocan.
3. **`toHaveBeenCalledTimes` / `mockSessionDebit`**: no enumeran args → NO se tocan (salvo el de sesión, ver §sesión).

> **Por qué condicional en el middleware:** la llamada step-0 es compartida por master/gasless/x402/compose. Pasar siempre 6 args rompería ~21 aserciones de 3-arg ajenas a esta HU. Pasarla solo cuando hay `composeDestination` mantiene esas aserciones intactas (back-compat de tests + AC-5).

### Vitest 4: trailing args importan

`expect(mockDebit).toHaveBeenCalledWith(a, b, c)` **falla** si el call real fue `debit(a, b, c, undefined, undefined, "x")`. Por eso: las llamadas no-compose del middleware DEBEN seguir siendo de 3 args literales, y las aserciones de 5-arg en compose/orchestrate DEBEN sumar el 6º arg explícito.

---

## SQL de la migración (textual — copiar tal cual)

### `supabase/migrations/20260606000000_a2a_key_spend_policies.sql`

```sql
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
-- ============================================================
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
```

> **`updated_at` trigger:** si en el repo existe `trigger_set_updated_at` (revisar la migración
> de keys), agregá el `CREATE TRIGGER ... BEFORE UPDATE ON a2a_key_spend_policies` espejando esa
> convención. Si NO existe el helper, omití el trigger (el service setea `updated_at` en el upsert)
> y NO inventes una función de trigger nueva. **Verificá con grep antes** (`grep -rn "trigger_set_updated_at" supabase/migrations/`).

### `supabase/migrations/20260606000000_a2a_key_spend_policies_down.sql`

```sql
-- WKH-125 down-migration.
-- Restaura debit_session_and_parent a su firma de 5 params (pre-WKH-125) y elimina
-- el RPC dest-aware + las 2 tablas.

-- 1. Drop de la versión 6-params de debit_session_and_parent.
DROP FUNCTION IF EXISTS debit_session_and_parent(uuid, text, uuid, integer, numeric, text);

-- 2. Restaurar debit_session_and_parent original (5 params, PERFORM increment).
CREATE OR REPLACE FUNCTION debit_session_and_parent(
  p_session_id UUID,
  p_owner_ref  TEXT,
  p_key_id     UUID,
  p_chain_id   INT,
  p_amount_usd NUMERIC
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
  PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd);
  UPDATE a2a_key_sessions SET spent_usd = v_new_spent WHERE id = p_session_id;
  RETURN v_new_spent;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

ALTER FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric)
  TO service_role;

-- 3. Drop del RPC dest-aware y las 2 tablas.
DROP FUNCTION IF EXISTS debit_with_dest_policy(uuid, integer, numeric, text, text);
DROP TABLE IF EXISTS a2a_key_dest_spend_ledger;
DROP TABLE IF EXISTS a2a_key_spend_policies;
```

---

## Mapeo de prefijos RAISE → error class → HTTP (vinculante)

Mismo patrón `msg.includes('PREFIX')` que `debitSessionAndParent` (`key-session.ts:454-491`).
**NUNCA propagar el `error.message` crudo de Postgres al cliente** (CD-B).

| Prefijo RAISE | Origen | Error class / code (en service) | HTTP |
|---------------|--------|---------------------------------|------|
| `DEST_CAP_EXCEEDED` | RPC nuevo (paso 5) | `DestCapExceededError` → `'DEST_CAP_EXCEEDED'` | **402** |
| `OWNERSHIP_MISMATCH` | RPC nuevo (paso 2) | `OwnershipMismatchError` → `'OWNERSHIP_MISMATCH'` | 403 |
| `INSUFFICIENT_BUDGET` | `increment_a2a_key_spend` (PERFORM) | `AgentKeyBudgetExhaustedError` → `'AGENT_KEY_BUDGET_EXHAUSTED'` | 403 |
| `DAILY_LIMIT` | `increment_a2a_key_spend` | `DailyLimitExceededError` → `'DAILY_LIMIT'` | 403 |
| `KEY_INACTIVE` | `increment_a2a_key_spend` | `AgentKeyInactiveError` → `'KEY_INACTIVE'` | 403 |
| `KEY_NOT_FOUND` | RPC / `increment_a2a_key_spend` | `AgentKeyNotFoundError` → `'KEY_NOT_FOUND'` | 403/404 |
| (otro / inesperado) | — | `Error('DEST_POLICY_DEBIT_FAILED')` (msg crudo NUNCA al cliente) | 400/500 |

### Cómo `budget.debit` (ruta master) consume esto

En la **rama master extendida** de `debit()`:
- Si `destination` falsy → **camino actual INTACTO**: `rpc('increment_a2a_key_spend', {...})`, retorna `error.message` crudo igual que hoy (CD-5, byte-idéntico).
- Si `destination` truthy → `rpc('debit_with_dest_policy', { p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination })`. En `error`, mapear por prefijo: `DEST_CAP_EXCEEDED`→`{success:false, error:'DEST_CAP_EXCEEDED'}`, etc. (devolver el **code** corto, NO el msg crudo).

> **`ownerRef` para el RPC master:** `debit()` hoy NO recibe `owner_ref` en la firma. El RPC nuevo
> necesita `p_owner_ref`. El RPC valida ownership DB-layer, pero `debit()` no tiene el owner en
> scope en la ruta master. **Solución (verificá scope antes de codear):** el call-site de compose
> (`compose.ts`) tiene `scopingKeyRow.owner_ref` disponible — pero `debit()` recibe solo `keyId`.
> Para no romper CD-4, el RPC puede derivar el owner internamente del lock de la key (`v_key_owner`)
> y usarlo si `p_owner_ref` viene NULL. **Decisión vinculante:** pasá `p_owner_ref` = el owner del
> caller cuando esté disponible; si `debit()` NO lo tiene en la ruta master, el service hace un
> `SELECT owner_ref` de la key ANTES del RPC (cold-path aceptable solo cuando hay destino) y lo
> pasa. **Si esto exige ampliar la firma de `debit` con un `ownerRef`, ESCALÁ a Architect** — NO
> agregues un 7º param sin confirmación (impactaría más call-sites). La opción preferida es derivar
> el owner dentro del RPC (`p_owner_ref := COALESCE(p_owner_ref, v_key_owner)` tras el lock).

> **NOTA Architect:** el SDD asume que `debit_with_dest_policy` recibe `p_owner_ref`. El RPC ya
> hace `SELECT owner_ref INTO v_key_owner ... FOR UPDATE` (paso 1). Si `p_owner_ref` no está
> disponible en la ruta master de `debit()`, la forma SDD-consistente es: el RPC usa
> `v_key_owner` como owner efectivo (el ownership real lo garantiza el call-site que ya
> autenticó la key). **No rompas firmas para conseguir el owner.** Mapeo de error por prefijo
> tal cual la tabla.

---

## Derivación del destino por call-site (vinculante)

Formato: `"<registry>/<slug>"`, **normalizado** (`String(x).trim().toLowerCase()`). Si falta
registry → `slug` solo. La normalización vive en `spend-policy.ts` (helper `normalizeDestination`)
y se aplica TANTO al persistir la política COMO al derivar el destino en el débito (así el
`destination` de la policy y el del ledger coinciden byte a byte).

| Call-site | Archivo:línea | De dónde sale el destino |
|-----------|---------------|--------------------------|
| **Steps 1..N (compose)** | `compose.ts:159` | `agent.registry` / `agent.slug` (ya disponibles tras `resolveAgent`, L71; usados en el evento L283-285). `destination = normalize(\`${agent.registry}/${agent.slug}\`)`. |
| **Step-0 (middleware)** | `a2a-key.ts:789-817` | El middleware NO lee body (CD-7, L281). El destino se augmenta en `routes/compose.ts:resolveComposePriceHandler` (donde `firstStep.agent`/`firstStep.registry` SÍ están, L43-51) como `request.composeDestination = normalize(...)`. El middleware lo lee de `request.composeDestination` y lo pasa **condicionalmente** (ver §Aridad). |
| **Orchestrate** | — | Equivalente: orchestrate delega en `composeService.compose` → la derivación de compose cubre los steps. **NO se toca orchestrate.ts.** |

> **`composeEstimatedCostUsd` es el modelo a espejar:** `resolveComposePriceHandler` ya augmenta
> `request.composeEstimatedCostUsd` (routes/compose.ts:75,80). Agregá `request.composeDestination`
> en los mismos puntos (happy-path L80 y fallback L75). Declarala en la module-augmentation de
> `FastifyRequest` en `a2a-key.ts:60` (junto a `composeEstimatedCostUsd?: number`).

---

## Tipos (`src/types/a2a-key.ts`) — contrato (TS strict, sin `any`)

```ts
export type SpendPolicyWindowType = 'total' | 'rolling';

// Input del owner (PUT endpoint + override de sesión [TBD-FUTURO]).
export interface SpendPolicyInput {
  destination: string;                 // se normaliza en spend-policy.ts
  max_usd: string;                     // NUMERIC → string (consistente con budget/amount)
  window_type: SpendPolicyWindowType;
  window_secs?: number | null;         // null/ausente para 'total'; >0 para 'rolling'
}

// Fila tal cual en DB.
export interface SpendPolicyRow {
  id: string;
  key_id: string;
  owner_ref: string;
  destination: string;
  max_usd: string;                     // NUMERIC → string
  window_type: SpendPolicyWindowType;
  window_secs: number | null;
  created_at: string;
  updated_at: string;
}

// Shape de respuesta (subset seguro para list/PUT 200).
export interface SpendPolicy {
  destination: string;
  max_usd: string;
  window_type: SpendPolicyWindowType;
  window_secs: number | null;
  created_at: string;
  updated_at: string;
}
```

Extender `CreateKeySessionInput` (campo `[TBD-FUTURO]`, ver AC-6):
```ts
// ...campos existentes...
spend_policies?: SpendPolicyInput[];   // [TBD-FUTURO]: override per-session NO implementado en MVP.
```

> **Re-export:** si `src/types/index.ts` re-exporta los tipos de `a2a-key`, agregá los nuevos
> (verificá con grep `from './a2a-key`). Sin `any`, sin `as unknown` (CD-D).

---

## Service `spend-policy.ts` — firmas (Ownership Guard CD-3)

```
normalizeDestination(raw: string) -> string                          // trim().toLowerCase(); "" inválido → throw InvalidInput
set(callerKey: A2AAgentKeyRow, input: SpendPolicyInput) -> Promise<SpendPolicy>  // upsert por (key_id,destination), valida window invariante
list(keyId: string, ownerId: string) -> Promise<SpendPolicy[]>       // .eq('key_id').eq('owner_ref')
delete(keyId: string, ownerId: string, destination: string) -> Promise<void>    // ownership; 0 rows → OwnershipMismatchError
hasAnyPolicy(keyId: string, ownerId: string) -> Promise<boolean>     // para back-compat (no se usa en hot-path del debit; ver nota)
```

- **Invariante de ventana (CD-6):** `window_type='total'` ⇒ `window_secs` debe ser `null`/ausente;
  `window_type='rolling'` ⇒ `window_secs` entero `> 0`. Si se viola → lanzar error de input (400).
- **Upsert** por `(key_id, destination)` (target del `UNIQUE`): `.upsert({...}, { onConflict: 'key_id,destination' })`. `owner_ref = callerKey.owner_ref`, `key_id = callerKey.id`. Setear `updated_at = now()` si no hay trigger.
- **TODO acceso** a `a2a_key_spend_policies` / `a2a_key_dest_spend_ledger` incluye `.eq('key_id', keyId).eq('owner_ref', ownerId)` con `ownerId: string` (NUNCA `string | undefined`). `PGRST116` (0 rows) → `OwnershipMismatchError` (AC-7).
- **`hasAnyPolicy`:** NO se usa en el hot-path del débito (el RPC `debit_with_dest_policy` es self-back-compat: sin política → degrada a `increment_a2a_key_spend`). Se expone para tests/diagnóstico. El `debit` master llama al RPC **siempre que haya `destination`** (sin un SELECT previo de "¿tiene política?", DT-nota del SDD).

---

## Endpoints (`src/routes/auth.ts`) — exemplar `auth.ts:1116-1240`

- **`PUT /auth/keys/me/spend-policies`** → `resolveCallerKey(req)` → gate `!callerKey?.is_active` → 403. Parsear body (`destination`, `max_usd`, `window`/`window_type`+`window_secs`). `spendPolicyService.set(callerKey, input)` → **200** con la política. Invalid input → 400 `INVALID_INPUT`. `OwnershipMismatchError` → 403.
- **`GET /auth/keys/me/spend-policies`** → `resolveCallerKey` + gate → `spendPolicyService.list(callerKey.id, callerKey.owner_ref)` → 200 array de `SpendPolicy`.
- **`DELETE /auth/keys/me/spend-policies/:destination`** (opcional) → `spendPolicyService.delete(callerKey.id, callerKey.owner_ref, decodeURIComponent(params.destination))` → 200. `OwnershipMismatchError` → 404 disclosure-safe.

> Reusar `resolveCallerKey` (`auth.ts:113`) y el shape de error mapping del bloque de
> key-session (`auth.ts:1149-1167`). Sub-session token como authenticator → mismo gate que los
> demás endpoints `/keys/me/*` si aplica (verificá el patrón `KEY_SESSION_TOKEN_PREFIX`).

---

## Exemplars (verificados con Read — paths y rangos reales)

### Exemplar 1: RPC FOR UPDATE → checks → PERFORM increment → mutación + hardening
**Archivo:** `supabase/migrations/20260603000000_a2a_key_sessions.sql:1-100`
**Usar para:** la migración entera (copiar el SQL textual de este doc — no re-derivar).
**Patrón clave:** `CREATE TABLE IF NOT EXISTS` + `gen_random_uuid()` + FK `ON DELETE CASCADE`; RPC con `SELECT ... FOR UPDATE` → ownership guard (`v_owner IS DISTINCT FROM p_owner_ref` → `RAISE 'OWNERSHIP_MISMATCH'`) → checks bajo lock → `PERFORM increment_a2a_key_spend(...)` → UPDATE; hardening `ALTER ... SET search_path = public, pg_temp` + `REVOKE ... FROM PUBLIC, anon, authenticated` + `GRANT ... TO service_role` con la firma tipada completa.

### Exemplar 2: service-call al RPC + mapeo de errores por prefijo de mensaje
**Archivo:** `src/services/key-session.ts:439-495` (`debitSessionAndParent`)
**Usar para:** la rama master dest-aware de `budget.ts` y el `debitSessionAndParent` extendido (#11).
**Patrón clave:** `supabase.rpc('...', {...})`; `if (error)` → `const msg = error.message` → cadena de `if (msg.includes('PREFIX')) throw new XxxError()` (incluye los prefijos heredados de `increment_a2a_key_spend`: `INSUFFICIENT_BUDGET`/`DAILY_LIMIT`/`KEY_INACTIVE`/`KEY_NOT_FOUND`) + `OWNERSHIP_MISMATCH` → `logOwnershipMismatch` + `OwnershipMismatchError`; fallback `throw new Error('...')` (msg crudo NUNCA al cliente).

### Exemplar 3: CRUD ownership-guarded (list/revoke con `.eq('owner_ref')`)
**Archivo:** `src/services/key-session.ts:295-373`
**Usar para:** `spend-policy.ts` (`list`/`delete`/`set`).
**Patrón clave:** `.from(table).select(...).eq('owner_ref', ownerRef)`; UPDATE/DELETE con `.eq('id'/'key_id', ...).eq('owner_ref', ownerId).select('id')`; `0 rows → logOwnershipMismatch + XxxNotFound/OwnershipMismatchError`. `ownerId: string` siempre.

### Exemplar 4: endpoints REST + resolveCallerKey + ownership + error mapping
**Archivo:** `src/routes/auth.ts:1116-1240`
**Usar para:** `PUT`/`GET`/`DELETE /auth/keys/me/spend-policies`.
**Patrón clave:** `resolveCallerKey(req)` → gate `!callerKey?.is_active` → 403; service-call con `callerKey.owner_ref`; `try/catch` que mapea error classes a `reply.status(...).send({ error_code })`. `FastifyPluginAsync`.

### Exemplar 5: error class
**Archivo:** `src/services/security/errors.ts:304-310` (`SessionBudgetExhaustedError`)
**Usar para:** `DestCapExceededError`.
**Patrón clave:** `export class XxxError extends Error { readonly code = '...' as const; constructor() { super('...'); this.name = 'XxxError'; } }`.

### Exemplar 6: ruta master del debit (a NO romper)
**Archivo:** `src/services/budget.ts:225-236`
**Usar para:** la rama master extendida de `debit`.
**Patrón clave:** `// ── RUTA MASTER KEY — INTACTA (CD-5) ──` → `supabase.rpc('increment_a2a_key_spend', { p_key_id, p_chain_id, p_amount_usd })` → `if (error) return { success:false, error: error.message }` → `return { success:true }`. **Este bloque se ejecuta tal cual cuando `destination` es falsy.** Cuando `destination` truthy, se añade la rama paralela `debit_with_dest_policy` ANTES, con mapeo por prefijo (Exemplar 2).

### Exemplar 7: call-site per-step de `debit` (steps 1..N)
**Archivo:** `src/services/compose.ts:159-165`
**Usar para:** propagar el destino.
**Patrón clave:** `await budgetService.debit(scopingKeyRow.id, chainId, debitAmount, request.delegationContext, request.keySessionContext)` → AGREGAR 6º arg `normalize(\`${agent.registry}/${agent.slug}\`)`. **Guard `i > 0 && scopingKeyRow && chainId !== undefined` (L131) INTACTO (CD-7).**

### Exemplar 8: step-0 debit + augmentación de request (composeEstimatedCostUsd)
**Archivo:** `src/middleware/a2a-key.ts:60` (module-aug), `:284-291` (lectura de campos augmentados), `:789-817` (debit step-0)
**Usar para:** declarar `composeDestination?: string` y la llamada condicional del step-0.
**Patrón clave:** `composeEstimatedCostUsd?: number;` (L60) es el modelo exacto para `composeDestination?: string`. El debit (L789) es compartido; envolvé el 6-arg en un `if (request.composeDestination)` para no romper las llamadas de 3 args (master/gasless/x402).

### Exemplar 9: preHandler que augmenta request desde firstStep del body
**Archivo:** `src/routes/compose.ts:34-91` (`resolveComposePriceHandler`)
**Usar para:** augmentar `request.composeDestination`.
**Patrón clave:** lee `body.steps[0]` → `firstStep.agent` / `firstStep.registry`; inyecta `request.composeEstimatedCostUsd` en happy-path (L80) y fallback (L75). Agregá `request.composeDestination = normalize(...)` en esos mismos puntos. El mapeo `errorCode==='SCOPE_DENIED'`→403 está cerca de L179-181 — agregá el branch `=== 'DEST_CAP_EXCEEDED'`→402.

---

## Constraint Directives

### OBLIGATORIO
- **CD-A (RPC estructura):** `debit_with_dest_policy` espeja `debit_session_and_parent` (lock key → ownership → lock policy → SUM ledger → check cap → `PERFORM increment_a2a_key_spend` → INSERT ledger) + hardening `ALTER/REVOKE/GRANT` con la firma tipada exacta. **SQL copiado textual de este doc.**
- **CD-B (mapeo por prefijo):** el mapeo de errores en `spend-policy.ts`/`budget.ts`/`key-session.ts` usa `msg.includes('PREFIX')` (patrón `key-session.ts:454-491`) y **NUNCA propaga el `error.message` crudo de Postgres** al cliente.
- **CD-C (endpoints):** siguen `resolveCallerKey` + ownership (`callerKey.owner_ref`/`callerKey.id`) del exemplar `auth.ts:1116-1240`.
- **CD-D (TS strict):** nuevos tipos completamente tipados; sin `any`, sin `as unknown`.

### PROHIBIDO
- **CD-1 (ATOMICIDAD):** PROHIBIDO chequear el cap en app-layer y debitar en RPC separado. Check cap + INSERT ledger + debit budget en la MISMA tx (RPC) con `FOR UPDATE` sobre policy + key.
- **CD-2 (BACK-COMPAT increment):** PROHIBIDO modificar la firma o el cuerpo de `increment_a2a_key_spend`. El RPC nuevo lo REUSA vía `PERFORM`.
- **CD-3 (OWNERSHIP):** PROHIBIDO acceder a `a2a_key_spend_policies`/`a2a_key_dest_spend_ledger` sin `.eq('key_id', keyId).eq('owner_ref', ownerId)` (`ownerId: string` no-opcional). En el RPC, ownership guard DB-layer (`v_key_owner IS DISTINCT FROM p_owner_ref`). [WKH-53]
- **CD-4 (NO ROMPER WKH-121..124):** PROHIBIDO alterar las firmas TS de `debitDelegationAndParent`/`KeySessionDebitContext`/`DelegationDebitContext`. `debitSessionAndParent` agrega `destination?` AL FINAL (param opcional, no rompe call-sites). El RPC `debit_session_and_parent` agrega `p_destination TEXT DEFAULT NULL` (las llamadas de 5 args siguen válidas por el DEFAULT).
- **CD-5 (NULL = SIN RESTRICCIÓN):** PROHIBIDO ejecutar cualquier check nuevo cuando no hay política. Path sin `destination` → `increment_a2a_key_spend` directo (byte-idéntico). RPC con destino pero sin política → degrada a `increment_a2a_key_spend` + 0 inserts.
- **CD-6 (invariante ventana):** validar en `spend-policy.ts`: `total`⇒`secs=null`; `rolling`⇒`secs>0`. Sin `any` (CD-D).
- **CD-7 (guard `i>0` intacto):** PROHIBIDO tocar el guard `i > 0 && scopingKeyRow && chainId !== undefined` de `compose.ts:131` (anti-double-charge del step 0; lección WKH-101/102). El middleware NO lee `request.body` (sólo campos augmentados, `a2a-key.ts:281`).
- **CD-8 (aridad — auto-blindaje WKH-121):** al agregar el 6º param a `debit`: (a) grep OBLIGATORIO `'Debit).toHaveBeenCalledWith'` / `'Debit).toHaveBeenNthCalledWith'` en TODO `src/` ANTES de tocar; (b) actualizar CADA aserción que enumere 5 args (compose ~20 + orchestrate.billing ~6) sumando el 6º arg; (c) las aserciones de 3 args (a2a-key ~18 + gasless 3) NO se tocan porque la llamada step-0 del middleware se mantiene **condicional** (3-arg sin `composeDestination`, 6-arg con él).

---

## Anti-Hallucination Checklist (específico WKH-125)

Antes de cerrar cada wave, verificar:

- [ ] **Atomicidad (CD-1):** TODO el check+debit+ledger vive en `debit_with_dest_policy` (RPC). `spend-policy.ts`/`budget.ts` NO hacen un check de cap en app-layer seguido de un debit separado. Cero SELECT-then-debit.
- [ ] **`increment_a2a_key_spend` intacto (CD-2):** el archivo `20260406000000_a2a_agent_keys.sql` NO se modifica. El RPC nuevo lo reusa vía `PERFORM increment_a2a_key_spend(...)`.
- [ ] **Ownership (CD-3):** todo acceso a las 2 tablas nuevas en `spend-policy.ts` incluye `.eq('key_id', keyId).eq('owner_ref', ownerId)` con `ownerId: string`. RPC tiene `v_key_owner IS DISTINCT FROM p_owner_ref → RAISE OWNERSHIP_MISMATCH`.
- [ ] **Back-compat (CD-5):** `debit()` sin `destination` ejecuta `increment_a2a_key_spend` directo, byte-idéntico (mismo bloque `budget.ts:225-236`). RPC con destino sin política → solo `PERFORM` + 0 inserts. Test de back-compat verde.
- [ ] **Firmas WKH-121..124 (CD-4):** `KeySessionDebitContext`/`DelegationDebitContext`/`debitDelegationAndParent` SIN cambios. `debitSessionAndParent` solo agrega `destination?` al final. `grep -rn "Debit).toHaveBeen" src/` → ninguna aserción de 5-arg rota sin actualizar.
- [ ] **Aridad (CD-8):** las aserciones de 5-arg en compose.test.ts y orchestrate.billing.test.ts tienen su 6º arg; las de 3-arg en a2a-key.test.ts y gasless.test.ts intactas; la llamada step-0 del middleware es condicional.
- [ ] **Mapeo sin leak (CD-B):** ningún `error.message` crudo de PG llega al cliente. `DEST_CAP_EXCEEDED`→402; demás prefijos según la tabla.
- [ ] **402 en ambos puntos:** step-0 (middleware) y mid-pipeline (`routes/compose.ts`) mapean `DEST_CAP_EXCEEDED` → HTTP **402** (no 400, no 403).
- [ ] **Destino normalizado:** policy y ledger usan el MISMO `normalizeDestination` (trim+lowercase). El destino derivado en compose/step-0 también. Coinciden byte a byte.
- [ ] **RPC hardening:** `debit_with_dest_policy` y el `debit_session_and_parent` de 6 params llevan `SET search_path = public, pg_temp` + `REVOKE EXECUTE FROM PUBLIC, anon, authenticated` + `GRANT EXECUTE TO service_role`.
- [ ] **Migración:** `20260606000000` (último existente es `20260605000000`, verificado) + su `_down.sql` que restaura `debit_session_and_parent` a 5 params y dropea RPC nuevo + 2 tablas.
- [ ] **AC-6 herencia:** `debit_session_and_parent` con destino → `PERFORM debit_with_dest_policy` (la sesión aplica el cap de la parent). Override per-session = `[TBD-FUTURO]` (campo en el tipo, semántica NO implementada).
- [ ] **`request.body` no se lee en middleware:** el destino de step-0 viene de `request.composeDestination` (augmentado en `routes/compose.ts`), NO de releer body en el middleware (CD-7).
- [ ] **TS strict:** sin `any`, sin `as unknown`. Todas las interfaces nuevas tipadas.
- [ ] **Orden de herramientas:** `npm run format` ANTES de `npm run lint` (biome organizeImports por imports nuevos), luego `tsc`.

---

## Test Expectations (≥1 por AC)

| Test | AC / objetivo | Archivo | Tipo |
|------|----------------|---------|------|
| PUT persiste política + `.eq('owner_ref')` + 200 con la política | AC-1, AC-7 | `src/routes/auth.spend-policies.test.ts` | integration |
| débito a destino con cap excedido → `DEST_CAP_EXCEEDED`, budget intacto (mock RPC rechaza con prefijo) | AC-2 | `src/services/budget.test.ts` | unit |
| `DEST_CAP_EXCEEDED` → HTTP **402** (step-0 middleware + mid-pipeline route) | AC-2 | `src/services/compose.test.ts` o `src/routes/compose.test.ts` | integration |
| rolling window: estructura del SUM `debited_at >= now() - secs*interval` (assert sobre el SQL/mapeo); débitos fuera de ventana no cuentan | AC-3 | `src/services/spend-policy.test.ts` | unit |
| **concurrencia (AC-4):** 2 débitos al mismo destino, cap=1, monto=1 c/u → exactamente 1 pasa. El test verifica (a) que el service llama a `debit_with_dest_policy` (NO un check app-layer separado) y (b) el ordenamiento `FOR UPDATE policy → SUM → check → debit` está en el SQL (assert estructural). | AC-4 | `src/services/spend-policy.test.ts` o `budget.test.ts` | unit |
| **back-compat (AC-5):** `debit` SIN destino → `increment_a2a_key_spend` directo (sin nuevos checks); con destino sin política → RPC degrada igual | AC-5 | `src/services/budget.test.ts` | unit |
| sesión cuya parent tiene cap por destino → el cap se aplica al debitar (RPC sesión dispatcha a `debit_with_dest_policy`) | AC-6 | `src/services/key-session.test.ts` o `budget.test.ts` | unit |
| read/write con owner ajeno → `OwnershipMismatchError` (`.eq('key_id').eq('owner_ref')`) | AC-7 | `src/services/spend-policy.test.ts` | unit |
| invariante de ventana (`total`⇒`secs=null`; `rolling`⇒`secs>0`) → input inválido rechazado | AC-1/CD-6 | `src/services/spend-policy.test.ts` | unit |

> **Mocks Supabase:** `vi.mock('../lib/supabase.js')` con `{ from: vi.fn(), rpc: vi.fn() }` (patrón
> de los services existentes). El test de concurrencia NO abre 2 conexiones PG reales (los services
> mockean Supabase); verifica el dispatch al RPC + el assert estructural sobre el orden de locks en
> el SQL. Un test de integración PG real es deseable pero queda sujeto a la infra existente.

### Criterio Test-First

| Tipo de cambio | Test-first? |
|----------------|-------------|
| `spend-policy.ts` (CRUD + normalize + window invariante) | Sí |
| `budget.ts` rama dest-aware + back-compat | Sí |
| endpoints PUT/GET | Sí |
| migración SQL / tipos | No (cubiertos por consumidores) |
| aserciones de aridad (mecánicas) | No (se actualizan al final de la wave de débito) |

---

## Waves

### Wave -1: Environment Gate (OBLIGATORIO antes de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a
npm install 2>/dev/null || echo "Sin package.json"
# Archivos base del Scope IN deben existir:
ls src/types/a2a-key.ts src/services/security/errors.ts src/services/budget.ts \
   src/services/compose.ts src/middleware/a2a-key.ts src/routes/compose.ts \
   src/routes/auth.ts src/services/key-session.ts \
   supabase/migrations/20260603000000_a2a_key_sessions.sql \
   supabase/migrations/20260605000000_a2a_receipts.sql 2>/dev/null || echo "FALTA archivo base"
# La migración nueva NO debe existir aún:
ls supabase/migrations/20260606000000_a2a_key_spend_policies.sql 2>/dev/null && echo "YA EXISTE — revisar"
# Confirmar trigger updated_at:
grep -rn "trigger_set_updated_at" supabase/migrations/ | head -1
# Blast radius de aridad (CD-8) — anotá las líneas:
grep -rn "Debit).toHaveBeenCalledWith\|Debit).toHaveBeenNthCalledWith" src/
# tsc baseline limpio:
npx tsc --noEmit && echo "tsc baseline OK"
```

**Si algo falla en Wave -1:** PARAR y reportar al orquestador.

### Wave 0 — Serial Gate (contratos: tipos + errores + migración)
- [ ] **W0.1** `src/types/a2a-key.ts` (#1): `SpendPolicyWindowType`, `SpendPolicyInput`, `SpendPolicyRow`, `SpendPolicy`; extender `CreateKeySessionInput.spend_policies?`. → `tsc`.
- [ ] **W0.2** `src/services/security/errors.ts` (#2): `DestCapExceededError`. → Exemplar 5.
- [ ] **W0.3** `supabase/migrations/20260606000000_a2a_key_spend_policies.sql` (#3): 2 tablas + índices + RPC `debit_with_dest_policy` + `CREATE OR REPLACE debit_session_and_parent` (6 params) + hardening. **SQL textual — copiar tal cual.** → Exemplar 1.
- [ ] **W0.4** `supabase/migrations/20260606000000_a2a_key_spend_policies_down.sql` (#4): restaura `debit_session_and_parent` (5 params) + DROP RPC nuevo + DROP 2 tablas. **SQL textual.**
- [ ] **W0.5** re-export en `src/types/index.ts` si aplica.
- Verificación: `npx tsc --noEmit` pasa.

### Wave 1 — Service de políticas (depende de W0)
- [ ] **W1.1** `src/services/spend-policy.ts` (#5): `normalizeDestination`, `set`/`list`/`delete`/`hasAnyPolicy` (ownership + window invariante). → Exemplar 3.
- [ ] **W1.2** (test-first) `src/services/spend-policy.test.ts` (#15): CRUD + ownership + window.
- Verificación: `tsc` + `spend-policy.test.ts`.

### Wave 2 — Débito dest-aware + propagación (depende de W0 + W1)
- [ ] **W2.1** `src/services/budget.ts` (#6): 6º param `destination?`; rama master dest-aware (`debit_with_dest_policy` + mapeo por prefijo) / falsy → `increment` INTACTO. → Exemplar 6 + 2.
- [ ] **W2.2** `src/services/compose.ts` (#7): 6º arg `destination` per-step (L159). Guard `i>0` intacto. → Exemplar 7.
- [ ] **W2.3** (test-first) `src/services/budget.test.ts` (#14): path dest-aware + back-compat.
- Verificación: `tsc` + budget tests.

### Wave 3 — Rutas + step-0 + AC-6 (depende de W2)
- [ ] **W3.1** `src/middleware/a2a-key.ts` (#9): `composeDestination?` en module-aug (L60); step-0 condicional (6-arg con destino / 3-arg sin); mapear `DEST_CAP_EXCEEDED`→**402**. → Exemplar 8.
- [ ] **W3.2** `src/routes/compose.ts` (#8): augmentar `request.composeDestination` en `resolveComposePriceHandler`; branch `errorCode==='DEST_CAP_EXCEEDED'`→**402**. → Exemplar 9.
- [ ] **W3.3** `src/routes/auth.ts` (#10): `PUT`/`GET`/`DELETE` `/keys/me/spend-policies`. → Exemplar 4.
- [ ] **W3.4** `src/services/key-session.ts` (#11): `debitSessionAndParent` agrega `destination?` + pasa `p_destination` + mapeo `DEST_CAP_EXCEEDED`. (El dispatch interno ya vive en el SQL del RPC, W0.3.) → Exemplar 2.
- [ ] **W3.5** (test-first) `src/routes/auth.spend-policies.test.ts` (#16): PUT/GET.

### Wave 4 — Tests (incluye concurrencia + aridad)
- [ ] **W4.1** **Aridad (CD-8):** actualizar las aserciones de 5-arg en `compose.test.ts` (#12) + `orchestrate.billing.test.ts` (#13) con el 6º arg. NO tocar las de 3-arg en a2a-key/gasless. (Correr el grep primero.)
- [ ] **W4.2** test de concurrencia (AC-4) + window rolling (AC-3) + AC-6 herencia, en sus archivos (`spend-policy.test.ts`/`budget.test.ts`/`key-session.test.ts`).
- [ ] **W4.3** `npx tsc --noEmit` → 0; **format ANTES de lint**; suite completa verde.

### Dependencias
| Tarea | Depende de | Razón |
|-------|-----------|-------|
| W1.* | W0.1, W0.2, W0.3 | tipos + errores + RPC |
| W2.* | W0.3, W1.1 | RPC + service |
| W3.* | W2.* | débito propagado |
| W4.* | W0–W3 | testea todo + aridad |

---

## Done Definition

- `npx tsc --noEmit` → **0 errores** (TS strict, sin `any`, sin `as unknown`).
- **format ANTES de lint**; lint limpio.
- Suite completa verde, **sin romper WKH-101 / WKH-121 / WKH-122 / WKH-123 / WKH-124** (especialmente las aserciones de aridad de `budgetService.debit`).
- Las aserciones de 5-arg de `mockDebit` (compose.test.ts + orchestrate.billing.test.ts) actualizadas con el 6º arg; las de 3-arg (a2a-key/gasless) intactas (llamada step-0 condicional).
- `increment_a2a_key_spend` SIN diff (CD-2). `debit_with_dest_policy` lo reusa vía `PERFORM`.
- Atomicidad TOTAL en el RPC (check cap + debit + ledger en 1 tx con `FOR UPDATE` policy+key) — CD-1.
- Back-compat: `debit` sin destino byte-idéntico a hoy; RPC con destino sin política degrada a `increment` + 0 inserts — CD-5/AC-5.
- Ownership Guard `.eq('key_id').eq('owner_ref')` con `ownerId: string` en `spend-policy.ts`; ownership DB-layer en el RPC — CD-3/AC-7.
- `DEST_CAP_EXCEEDED` → HTTP **402** en step-0 y mid-pipeline; ningún msg crudo de PG al cliente — CD-B.
- Migración `20260606000000` + `_down.sql` aditiva y **reversible** (el down restaura `debit_session_and_parent` a 5 params).
- Los **7 ACs** cubiertos por al menos un test cada uno (incluye concurrencia AC-4 y back-compat AC-5).

---

## Out of Scope

> Dev NO toca bajo ninguna circunstancia:

- `src/services/orchestrate.ts` (la propagación va por compose; orchestrate NO llama `debit` directo).
- `supabase/migrations/20260406000000_a2a_agent_keys.sql` / `increment_a2a_key_spend` (CD-2).
- Las firmas TS de `debitDelegationAndParent` / `KeySessionDebitContext` / `DelegationDebitContext` (CD-4).
- Override per-session real (`spend_policies` con semántica "override por la vida de la sesión") — `[TBD-FUTURO]`; solo se agrega el campo opcional al tipo.
- Cap por categoría / por chain (solo por `<registry>/<slug>`, USD cross-chain). Ventana calendárica.
- Extender políticas a delegaciones EIP-712. Purga/TTL del ledger. RLS Postgres-level (WKH-SEC-02). UI (API-only).
- NO "mejorar" código adyacente ni refactors no solicitados.

## Escalation Rule

> **Si algo no está en este Story File, Dev PARA y escala a Architect.** No inventar. No asumir.

Escalar si: un exemplar ya no existe en esos rangos; las líneas de un call-site difieren del rango
indicado (~L159 compose, ~L789 middleware, ~L80 routes/compose, ~L439 key-session); conseguir el
`owner_ref` en la ruta master de `debit` parece exigir un 7º param (NO lo agregues — usá `v_key_owner`
en el RPC, ver §Mapeo); `trigger_set_updated_at` no existe (omití el trigger, no inventes uno);
el grep de aridad arroja más aserciones de las esperadas (actualizalas TODAS — la lista no es
exhaustiva por diseño).

---

*Story File generado por NexusAgil — F2.5 — WKH-125 (E16 final)*
