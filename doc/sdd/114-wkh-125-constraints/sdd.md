# SDD #114: [WKH-125] KEY-CONSTRAINTS — Caps de gasto por destino + ventanas rolling/total

> SPEC_APPROVED: no
> Fecha: 2026-06-19
> Tipo: feature
> SDD_MODE: full
> Branch: feat/114-wkh-125-constraints
> Artefactos: doc/sdd/114-wkh-125-constraints/

---

## 1. Resumen

Se amplía el modelo de constraints de la Agent Key (master + sessions) para limitar el **gasto acumulado por destino** (un agente, identificado como `<registry>/<slug>`) dentro de una **ventana de tiempo** (rolling en segundos, o total de por vida). Dos tablas nuevas (`a2a_key_spend_policies` para las políticas, `a2a_key_dest_spend_ledger` para el acumulado), un RPC atómico nuevo (`debit_with_dest_policy`) que extiende el patrón de `debit_session_and_parent`, y la propagación del destino desde compose/orchestrate al débito. El resultado cierra el gap con el Kite Passport ("no gastar más de $50 con vendor X") manteniendo back-compat absoluta: una key/sesión sin políticas se comporta exactamente igual que hoy (WKH-121..124 intactos).

Es la **última HU de la épica E16** (Agent Key mejor que Kite Passport). WKH-121/122/123/124 están DONE y mergeadas.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 114 (WKH-125) |
| **Tipo** | feature |
| **SDD_MODE** | full |
| **Objetivo** | Cap de gasto acumulado por destino + ventana de tiempo configurable, atómico, con back-compat total |
| **Reglas de negocio** | Atomicidad (check cap + debit + ledger en 1 tx); null = sin restricción; sin tocar `increment_a2a_key_spend`; ownership por `key_id + owner_ref` |
| **Scope IN** | Ver §6 |
| **Scope OUT** | Ver §6 |
| **Missing Inputs** | `destination` = string `<registry>/<slug>` (SUPUESTO conservador, resuelto en §10) |

### Acceptance Criteria (EARS)

- **AC-1 (SET-POLICY)**: WHEN un owner llama `PUT /auth/keys/me/spend-policies` con `{ destination, max_usd, window }` válido y su `owner_ref`, THE sistema SHALL persistir la política en `a2a_key_spend_policies` filtrando por `owner_ref` y retornar 200 con la política guardada.
- **AC-2 (CAP-REJECT)**: WHEN se solicita un débito para un destino con política activa Y el acumulado en la ventana + el monto excedería `max_usd`, THE sistema SHALL rechazar con `DEST_CAP_EXCEEDED` (HTTP 402) y SHALL NOT decrementar el budget de la key.
- **AC-3 (WINDOW-RESET)**: WHILE una política tiene `window_type='rolling'` con `window_secs=N`, THE sistema SHALL computar el acumulado SOLO sobre débitos con `debited_at >= now() - N segundos` (rolling, no calendar-reset).
- **AC-4 (ATOMIC-DEBIT)**: WHEN el sistema chequea el cap por destino y debita el budget, ambas operaciones SHALL ejecutarse en la misma transacción PostgreSQL con `FOR UPDATE` sobre `a2a_key_spend_policies` + `a2a_agent_keys`, de modo que débitos concurrentes al mismo destino SHALL serializar y SHALL NOT producir race condition.
- **AC-5 (BACK-COMPAT)**: WHILE una key/sesión NO tiene políticas, THE sistema SHALL comportarse exactamente como hoy (paths WKH-121/122/123/124 sin cambios; sin nuevos checks ni errores en el hot-path).
- **AC-6 (SESSION-INHERIT)**: WHEN se crea una key session, THE sistema SHALL aplicar las políticas activas de la parent key a esa sesión (herencia). El override por sesión queda acotado — ver DT-AC6 / §10.
- **AC-7 (OWNERSHIP-GUARD)**: WHEN cualquier service lee/escribe `a2a_key_spend_policies` o `a2a_key_dest_spend_ledger`, la query SHALL incluir `.eq('key_id', keyId).eq('owner_ref', ownerId)` con `ownerId: string` (no-opcional), y SHALL lanzar `OwnershipMismatchError` si el row no existe bajo ese owner.

---

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón / hallazgo extraído |
|---------|---------|----------------------------|
| `src/services/budget.ts:34-237` | El `debit()` actual con sus 3 rutas | Firma `debit(keyId, chainId, amountUsd, delegationContext?, keySessionContext?)`. La ruta master (L225-236) llama `supabase.rpc('increment_a2a_key_spend', {p_key_id, p_chain_id, p_amount_usd})` y retorna `error.message` crudo si falla. Las rutas delegación/sesión mapean errores por `instanceof` a `{success,error:code}`. CD-5 mantiene la ruta master "INTACTA". |
| `supabase/migrations/20260406000000_a2a_agent_keys.sql:56-121` | La lógica completa de `increment_a2a_key_spend` que el nuevo RPC debe REUSAR vía `PERFORM` | `FOR UPDATE` en `a2a_agent_keys`; lazy daily-reset; check `daily_limit`; check chain budget (`budget ->> chain_key`); UPDATE de budget+daily_spent+last_used_at. Prefijos `RAISE`: `KEY_NOT_FOUND`, `KEY_INACTIVE`, `DAILY_LIMIT`, `INSUFFICIENT_BUDGET`. `SECURITY DEFINER`. |
| `supabase/migrations/20260603000000_a2a_key_sessions.sql:28-96` | El RPC `debit_session_and_parent` — PATRÓN EXACTO a espejar | Secuencia: `SELECT ... FOR UPDATE` (lock); ownership guard DB-layer (`v_owner IS DISTINCT FROM p_owner_ref`); checks bajo lock; `PERFORM increment_a2a_key_spend(...)`; UPDATE final. Bloque de hardening al final: `ALTER FUNCTION ... SET search_path = public, pg_temp` + `REVOKE ... FROM PUBLIC, anon, authenticated` + `GRANT ... TO service_role`. |
| `supabase/migrations/20260605000000_a2a_receipts.sql` (tail) | Confirmar la convención del hardening block en la migración más reciente | Idéntico patrón `ALTER/REVOKE/GRANT` con la firma tipada completa de la función. |
| `src/services/key-session.ts:439-495` | `debitSessionAndParent` — patrón de service-call al RPC + mapeo de errores por prefijo de mensaje | `supabase.rpc('debit_session_and_parent', {...})`; mapea `msg.includes('PREFIX')` a error classes (incluyendo los prefijos heredados de `increment_a2a_key_spend`); fallback `throw new Error('SESSION_DEBIT_FAILED')` (nunca propaga msg crudo). |
| `src/services/key-session.ts:124-248` | `create()` — dónde inyectar la herencia/copia de políticas (AC-6) | El INSERT del row de sesión está en L208-226. `effectiveScope` (L97-99) modela `null = hereda del padre`. AC-6 reusa este patrón conceptual. |
| `src/services/compose.ts:69-179` | El call-site de `budgetService.debit` per-step (L159) + disponibilidad de `agent.slug`/`agent.registry` | `agent.registry` y `agent.slug` están disponibles tras `resolveAgent` (L71) y ya se usan en `AuthzTarget` (L85-89) y en el evento (L288-289). El débito per-step (guard `i>0 && scopingKeyRow && chainId!==undefined`, L131) pasa hoy `(scopingKeyRow.id, chainId, debitAmount, delegationContext, keySessionContext)`. |
| `src/services/orchestrate.ts:406-425` | El call-site equivalente que arma `ComposeRequest` | Orchestrate NO llama `debit` directo; delega en `composeService.compose(...)`. La propagación del destino se resuelve íntegramente dentro de compose.ts (orchestrate NO cambia su firma a `debit`). |
| `src/middleware/a2a-key.ts:692-817` | El débito de STEP 0 (master key) — clave para el scope de AC-2 | El step-0 debit (L789) llama `budgetService.debit(keyRow.id, chainId, estimatedCostUsd)` SIN delegation/session ctx. Aquí el agente NO está resuelto; sólo el precio (`resolveAgentPriceUsdc`). El `firstStep.agent` (slug) y `firstStep.registry` SÍ están en el body del request. Mapeo HTTP: insuf budget → `send403(reply, 'INSUFFICIENT_BUDGET', ...)`. |
| `src/routes/compose.ts:40-180` | preHandler `resolveComposePriceHandler` + mapeo de errores de compose-result | El step-0 price se resuelve en el preHandler; el debit lo hace el middleware `requirePaymentOrA2AKey`. Mid-pipeline debit failure → `result.error` string → route mapea a 400 (default) salvo `errorCode==='SCOPE_DENIED'` → 403. |
| `src/routes/auth.ts:1116-1300` | Exemplar de endpoints `POST/GET/DELETE/PATCH /key-session` + Ownership Guard | `resolveCallerKey(req)`; check `!callerKey?.is_active` → 403; service-call con `callerKey.owner_ref`; mapeo de error classes a `error_code`. Patrón a copiar para `PUT/GET /auth/keys/me/spend-policies`. |
| `src/services/agent-price.ts:40-62` | Confirmar que `resolveAgentPriceUsdc` NO devuelve registry/slug | Devuelve sólo `number|null`. Confirma que el destino de step-0 debe derivarse del body (`firstStep.agent`/`firstStep.registry`), no del price resolver. |
| `src/types/a2a-key.ts:34-355` | Dónde agregar `SpendPolicy*` + cómo viajan los contexts | `A2AAgentKeyRow`, `CreateKeyInput` (L78-86), `CreateKeySessionInput` (L303-310), `KeySessionDebitContext` (L351-355), `DelegationDebitContext` (L245-250). Los tipos se re-exportan vía `src/types/index.js`. |
| `src/services/security/errors.ts:9-330` | Patrón de error classes (`readonly code = '...' as const` + `name`) | Para crear `DestCapExceededError` + `SpendPolicyNotFoundError`/reuse de `OwnershipMismatchError`. |
| `src/services/budget.test.ts:178-268` + `src/services/compose.test.ts:1109-1675` + `src/services/orchestrate.billing.test.ts:220-274` | Blast-radius de la aridad de `debit` (lección WKH-121) | Ver DT-1. |

### Exemplars (verificados con Glob/Read)

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `supabase/migrations/20260606000000_a2a_key_spend_policies.sql` (RPC `debit_with_dest_policy`) | `supabase/migrations/20260603000000_a2a_key_sessions.sql:28-96` | Estructura `FOR UPDATE → checks → PERFORM increment_a2a_key_spend → UPDATE/INSERT` + hardening block idéntico |
| `src/services/spend-policy.ts` (CRUD + ownership) | `src/services/key-session.ts:295-373` (`list`/`revoke` con `.eq('owner_ref', ...)`) | Ownership Guard app-layer, mismo shape Supabase |
| `src/services/spend-policy.ts` (debit-aware) | `src/services/key-session.ts:439-495` (`debitSessionAndParent`) | `supabase.rpc(...)` + mapeo de errores por prefijo de mensaje |
| `src/routes/auth.ts` (PUT/GET `/keys/me/spend-policies`) | `src/routes/auth.ts:1174-1233` (GET/DELETE `/key-session`) | `resolveCallerKey` + ownership + error mapping |
| `src/services/security/errors.ts` (`DestCapExceededError`) | `src/services/security/errors.ts:304-310` (`SessionBudgetExhaustedError`) | `readonly code = '...' as const` + `name` |
| `src/types/a2a-key.ts` (`SpendPolicy`) | `src/types/a2a-key.ts:351-355` (`KeySessionDebitContext`) | Interfaces tipadas, sin `any` |

### Estado de BD relevante

| Tabla | Existe | Columnas relevantes |
|-------|--------|---------------------|
| `a2a_agent_keys` | Sí | `id`, `owner_ref`, `budget` (JSONB per-chain), `daily_limit_usd`, `daily_spent_usd`, `is_active` |
| `a2a_key_sessions` | Sí | `id`, `key_id`, `owner_ref`, `spent_usd`, `max_budget_usd` |
| `a2a_key_spend_policies` | **No (se crea)** | Ver DT-2 |
| `a2a_key_dest_spend_ledger` | **No (se crea)** | Ver DT-3 |

### Componentes reutilizables encontrados

- `increment_a2a_key_spend` (RPC existente) — REUSAR vía `PERFORM` dentro del nuevo RPC (NO reimplementar daily/budget; CD-2).
- `OwnershipMismatchError` (`security/errors.ts:9`) — reusar para AC-7.
- `resolveCallerKey` (`auth.ts:113`) + `callerKey.owner_ref` — reusar para los endpoints.
- Bloque de hardening `ALTER/REVOKE/GRANT` (migración sesiones/recibos) — copiar literal con la firma tipada nueva.

---

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar |
|---------|--------|-------------|----------|
| `supabase/migrations/20260606000000_a2a_key_spend_policies.sql` | Crear | 2 tablas + índices + RPC `debit_with_dest_policy` + hardening | `20260603000000_a2a_key_sessions.sql` |
| `supabase/migrations/20260606000000_a2a_key_spend_policies_down.sql` | Crear | DROP de las 2 tablas + RPC | `20260603000000_a2a_key_sessions_down.sql` |
| `src/types/a2a-key.ts` | Modificar | `SpendPolicy`, `SpendPolicyWindowType`, `SpendPolicyInput`, `SpendPolicyRow`; extender `CreateKeySessionInput` (opcional `spend_policies`) | `a2a-key.ts:351-355` |
| `src/services/security/errors.ts` | Modificar | `DestCapExceededError` (code `DEST_CAP_EXCEEDED`) | `errors.ts:304-310` |
| `src/services/spend-policy.ts` | Crear | `set`/`list`/`delete` (ownership) + `getActivePolicyDestinations(keyId, ownerId)` para resolver si hay políticas | `key-session.ts:295-373` |
| `src/services/budget.ts` | Modificar | Nueva rama en `debit()`: si hay `destination` Y la key tiene políticas activas para ese destino → RPC `debit_with_dest_policy`; si no → camino actual intacto | `budget.ts:225-236` |
| `src/services/compose.ts` | Modificar | Propagar `destination = \`${agent.registry}/${agent.slug}\`` al `debit()` per-step (L159) | `compose.ts:159-165` |
| `src/middleware/a2a-key.ts` | Modificar | Step-0 (master): derivar `destination` del `firstStep` del body de compose y pasarlo a `debit()`; mapear `DEST_CAP_EXCEEDED` → HTTP 402 | `a2a-key.ts:789-817` |
| `src/routes/compose.ts` | Modificar | Mapear `error_code === 'DEST_CAP_EXCEEDED'` del compose-result a HTTP 402 (mid-pipeline) | `routes/compose.ts:179-180` |
| `src/routes/auth.ts` | Modificar | `PUT /auth/keys/me/spend-policies` (set) + `GET /auth/keys/me/spend-policies` (list) + `DELETE .../:destination` (opcional) | `auth.ts:1174-1233` |
| `src/services/key-session.ts` | Modificar | `create()`: AC-6 — copiar políticas activas de la parent key a la sesión (o aceptar override `input.spend_policies`) | `key-session.ts:201-226` |
| `src/services/budget.test.ts` | Modificar | Actualizar aserciones de aridad de `debit` (ver DT-1) + tests del nuevo path | — |
| `src/services/compose.test.ts` | Modificar | Actualizar 8 aserciones `mockDebit` (6º arg) + test de propagación de destino | — |
| `src/services/orchestrate.billing.test.ts` | Modificar | Actualizar 4 aserciones `mockDebit` (6º arg) | — |
| `src/services/spend-policy.test.ts` | Crear | Tests CRUD + ownership + window + back-compat + concurrencia | `key-session.test.ts` |
| `src/routes/auth.spend-policies.test.ts` | Crear | Tests de endpoints PUT/GET | `auth.key-session.test.ts` |

### 4.2 Modelo de datos

#### DT-2: Tabla `a2a_key_spend_policies`

```
a2a_key_spend_policies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id      UUID NOT NULL REFERENCES a2a_agent_keys(id) ON DELETE CASCADE,
  owner_ref   TEXT NOT NULL,                 -- Ownership Guard app-layer (CD-3)
  destination TEXT NOT NULL,                 -- "<registry>/<slug>" normalizado (trim+lowercase)
  max_usd     NUMERIC(18,6) NOT NULL CHECK (max_usd >= 0),
  window_type TEXT NOT NULL CHECK (window_type IN ('total','rolling')),
  window_secs INT CHECK (window_secs IS NULL OR window_secs > 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (key_id, destination)               -- 1 política por destino por key (upsert target)
)
CREATE INDEX ON a2a_key_spend_policies (key_id, owner_ref);
-- Trigger updated_at: reusar trigger_set_updated_at (existe; ver migración keys)
```

Invariante a validar en `spend-policy.ts` (CD-6): `window_type='total'` ⇒ `window_secs IS NULL`; `window_type='rolling'` ⇒ `window_secs > 0`.

#### DT-3: Tabla `a2a_key_dest_spend_ledger`

```
a2a_key_dest_spend_ledger (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id      UUID NOT NULL REFERENCES a2a_agent_keys(id) ON DELETE CASCADE,
  owner_ref   TEXT NOT NULL,
  destination TEXT NOT NULL,                 -- mismo formato normalizado
  amount_usd  NUMERIC(18,6) NOT NULL,
  debited_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)
CREATE INDEX ON a2a_key_dest_spend_ledger (key_id, destination, debited_at);  -- hot-path SUM
```

Sin purga automática en el MVP (DT-10 del work-item; aceptado — ver Riesgos).

### DT-RPC: `debit_with_dest_policy` (SQL completo, resuelto)

```sql
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
  -- 1. Lock de la key (mismo lock que increment_a2a_key_spend usará luego; AC-4).
  --    Se lockea ACÁ explícito para serializar contra otros débitos al mismo key
  --    ANTES de leer el ledger (evita TOCTOU entre SUM y debit).
  SELECT owner_ref INTO v_key_owner
    FROM a2a_agent_keys
    WHERE id = p_key_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'KEY_NOT_FOUND: key_id % does not exist', p_key_id;
  END IF;

  -- 2. Ownership Guard DB-layer (CD-3) — el service usa SERVICE_ROLE/bypass RLS.
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

  -- 7. Sólo si hay política: registrar el débito en el ledger (dentro de la misma tx).
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
```

**Mapeo de prefijos RAISE → error en `spend-policy.ts` / `budget.ts`** (mismo patrón que `debitSessionAndParent`):

| Prefijo RAISE | Origen | Error class / code | HTTP |
|---------------|--------|--------------------|------|
| `DEST_CAP_EXCEEDED` | RPC nuevo (paso 5) | `DestCapExceededError` → `'DEST_CAP_EXCEEDED'` | **402** |
| `OWNERSHIP_MISMATCH` | RPC nuevo (paso 2) | `OwnershipMismatchError` → `'OWNERSHIP_MISMATCH'` | 403 |
| `INSUFFICIENT_BUDGET` | `increment_a2a_key_spend` (PERFORM) | `AgentKeyBudgetExhaustedError` → `'AGENT_KEY_BUDGET_EXHAUSTED'` | 403 |
| `DAILY_LIMIT` | `increment_a2a_key_spend` | `DailyLimitExceededError` → `'DAILY_LIMIT'` | 403 |
| `KEY_INACTIVE` | `increment_a2a_key_spend` | `AgentKeyInactiveError` → `'KEY_INACTIVE'` | 403 |
| `KEY_NOT_FOUND` | RPC / `increment_a2a_key_spend` | `AgentKeyNotFoundError` → `'KEY_NOT_FOUND'` | 403/404 |
| (otro) | inesperado | `Error('DEST_POLICY_DEBIT_FAILED')` (msg crudo NUNCA al cliente) | 400/500 |

### DT-1: Aridad de `budgetService.debit` — APPROACH ELEGIDO (lección WKH-121, CRÍTICO)

**Opciones evaluadas:**

- **(a) Param posicional `destination?: string` al final** → `debit(keyId, chainId, amountUsd, delegationContext?, keySessionContext?, destination?)`. Blast radius (verificado por grep): **12 aserciones de aridad** que enumeran args de `mockDebit` rompen y requieren añadir el trailing `undefined`/valor: 8 en `compose.test.ts` (L1115, L1411, L1490, L1668 `toHaveBeenCalledWith` + L1559, L1567, L1613, L1621 `toHaveBeenNthCalledWith`) + 4 en `orchestrate.billing.test.ts` (L222, L230, L262, L269). Las llamadas directas de 3 args (middleware/gasless step-0) NO rompen. Es exactamente el patrón que WKH-121 ya sufrió (su auto-blindaje documenta 11 aserciones tocadas).
- **(b) `destination` dentro de un context object** (nuevo `debitMeta?: { destination?: string }` como 6º param, o dentro de los contexts existentes) → mismo blast radius de aridad que (a) si es 6º param posicional; si se mete dentro de `keySessionContext`/`delegationContext` rompería sus shapes y los call-sites que los construyen (viola CD-4). No reduce el problema.
- **(c) Método nuevo `debitWithPolicy(...)`** que sólo el call-site con destino llama, dejando `debit()` intacto → **0 aserciones de aridad rotas en los tests existentes** de compose/orchestrate/budget. El precio es duplicar el mapeo de errores y el dispatch en los 3 call-sites (middleware step-0, compose per-step). Pero el código de las rutas delegación/sesión NO necesita destino en este MVP (Scope OUT: delegaciones no extienden políticas), así que el destino sólo aplica al path master → la duplicación es acotada.

**DECISIÓN: opción (a) — param posicional `destination?: string` al final de `debit()`.**

Justificación: (1) Mantiene UN solo punto de dispatch (`debit`) que ya conoce las 3 rutas — agregar un método paralelo `debitWithPolicy` reintroduce la lógica de routing master/delegation/session que `debit` ya centraliza, aumentando el riesgo de drift (un futuro cambio en una ruta tendría que replicarse). (2) El blast radius (12 aserciones, todas en 2 archivos, todas mecánicas: añadir `undefined` / el string de destino) es **conocido, acotado y ya documentado** por el auto-blindaje de WKH-121; el Dev tiene el playbook exacto. (3) El destino sólo se evalúa en la ruta master (las ramas delegación/sesión retornan ANTES de llegar al RPC master en `debit`, L80-223), así que `destination` se consume únicamente en el bloque L225-236 — cambio localizado. (4) CD-4 se respeta: no se tocan las firmas de los contexts ni de `debitSessionAndParent`/`debitDelegationAndParent`.

**Plan de tests explícito (W4):**
- `compose.test.ts`: en las 8 aserciones, añadir un 6º arg. Para las que hoy esperan destino real propagado (steps con agente resuelto), el valor será `\`${registry}/${slug}\`` del `makeAgent` correspondiente; para las que no aplican destino, `undefined`. (El Dev decide por test según si el step pasa destino — pero el camino compose SIEMPRE pasará destino cuando hay agente, así que la mayoría llevará el string.)
- `orchestrate.billing.test.ts`: las 4 aserciones reciben el 6º arg = destino del agente del step (los `makeAgent` definen slug/registry).
- `budget.test.ts`: las llamadas existentes de 3/4/5 args siguen válidas (param opcional, ausencia = `undefined`); se AGREGAN tests nuevos del path destino (ver §Plan de tests).
- Middleware step-0 (`a2a-key.ts:789`): la llamada pasa de 3 a 4 args (agrega destino derivado del body). No hay aserción de aridad de esa llamada en tests de middleware que enumere args (verificado: las aserciones de 3-arg directas no se tocan según auto-blindaje WKH-121); el Dev confirmará con grep antes de tocar.

### DT-AC6: Herencia/override de políticas en sesiones — RESUELTO

**Mecanismo (simple, MVP):** la sesión hereda las políticas de la parent key **por copia en el momento de creación**, no por referencia dinámica. Concretamente:

- El débito de sesión (`debit_session_and_parent`) opera sobre el `key_id` de la **parent key** (ver `key-session.ts:81` → `PERFORM increment_a2a_key_spend(p_key_id, ...)` donde `p_key_id` es la parent). El ledger y las políticas viven contra `key_id` = parent. Por tanto, **una sesión que debita contra su parent key ya consume y respeta el cap por destino de la parent automáticamente** — siempre que el débito de sesión también enrute al RPC dest-aware cuando hay destino+política.
- Implementación en W3: extender `debitSessionAndParent` para que, cuando reciba destino y la parent tenga política, su paso 5 (`PERFORM increment_a2a_key_spend`) se reemplace por `PERFORM debit_with_dest_policy(p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination)`. Esto da AC-6 (la sesión aplica las políticas de la parent) SIN tabla nueva por sesión.

**Override por sesión (`CreateKeySessionInput.spend_policies`): ACOTADO A SCOPE FUTURO.** Se agrega el campo opcional `spend_policies?: SpendPolicyInput[]` al tipo `CreateKeySessionInput` (para no romper el contrato más adelante), pero en este MVP el `create()` **persiste esas policies contra la parent key** (upsert por `key_id+destination`) o las ignora si no se implementa el almacenamiento per-session. La semántica "override (no merge) por la vida de la sesión" requiere una tabla `session_id`-scoped o una columna en `a2a_key_sessions` — eso queda fuera de este MVP. AC-6 se cumple en su parte de **herencia** (la sesión aplica las políticas de la parent); el override se marca `[TBD-FUTURO]` (no bloqueante — ver §10).

> Esta acotación está habilitada por el work-item: Missing Inputs L179 ("el mecanismo exacto... se define en F2") y la instrucción explícita "si es muy grande, acotá AC-6 a 'la sesión hereda las políticas de la parent key' y deja el override como scope futuro".

### DT-4: Ventanas (window edge)

| `window_type` | `window_secs` | SQL del SUM |
|---|---|---|
| `total` | NULL | `SUM(amount_usd) WHERE key_id=? AND destination=?` (sin filtro temporal) |
| `rolling` | N>0 | `SUM(amount_usd) WHERE key_id=? AND destination=? AND debited_at >= now() - (N * interval '1 second')` |

Confirmado en el SQL del RPC (paso 4). El borde rolling usa `>=` (inclusivo) sobre `now() - N*1s` evaluado en el server (UTC).

### 4.3 Componentes / Servicios

- **`spend-policy.ts`**: `set(callerKey, input)` (upsert por `key_id+destination`, normaliza destino, valida window invariante), `list(keyId, ownerId)`, `delete(keyId, ownerId, destination)`, `hasAnyPolicy(keyId, ownerId): Promise<boolean>` (para back-compat: si false, `budget.debit` NO llama al RPC nuevo). Todas con `.eq('key_id', keyId).eq('owner_ref', ownerId)` (AC-7).
- **`budget.ts` debit** (ruta master extendida): si `destination` truthy → llamar `debit_with_dest_policy(keyId, chainId, amount, ownerRef, destination)` SIEMPRE que haya destino (el RPC mismo decide si hay política; si no hay, sólo hace `PERFORM increment_a2a_key_spend` + NO inserta ledger → comportamiento idéntico). **Decisión back-compat:** para garantizar AC-5 sin un round-trip extra, si `destination` es falsy se usa el camino actual (`increment_a2a_key_spend` directo, INTACTO). El RPC nuevo es self-back-compat (sin política → equivalente a `increment_a2a_key_spend`).

> **Nota de diseño (CD-5 / hot-path):** el RPC `debit_with_dest_policy` es seguro de llamar incluso sin política (degrada a `increment_a2a_key_spend` + 0 inserts). Llamarlo siempre que haya `destination` evita un SELECT previo de "¿tiene política?" en el hot-path. El path SIN destino (gasless, x402, rutas no-compose) sigue por `increment_a2a_key_spend` directo, byte-idéntico a hoy.

### 4.4 Flujo principal (Happy Path)

1. Owner: `PUT /auth/keys/me/spend-policies {destination:"wasiai/kyc-agent", max_usd:"50", window:{type:"rolling", secs:86400}}` → `spendPolicyService.set(...)` upsert filtrado por owner → 200 con la política.
2. Caller (compose): step con agente `wasiai/kyc-agent`. Compose resuelve el agente, arma `destination="wasiai/kyc-agent"`, llama `budgetService.debit(keyId, chainId, price, delegationCtx, sessionCtx, destination)`.
3. `debit` (master, con destino) → RPC `debit_with_dest_policy`: lock key + lock policy → SUM ledger en ventana → `accum+price <= 50` OK → `PERFORM increment_a2a_key_spend` (debita budget) → INSERT ledger → commit.
4. Resultado: budget decrementado, ledger registra el débito, pipeline continúa.

### 4.5 Flujo de error

1. El acumulado del destino + el monto excede `max_usd` → RPC `RAISE 'DEST_CAP_EXCEEDED'` → ROLLBACK (budget NO se toca, ledger NO inserta) → `budget.debit` retorna `{success:false, error:'DEST_CAP_EXCEEDED'}`.
2. **Step-0 (middleware):** mapea a **HTTP 402** con `error_code:'DEST_CAP_EXCEEDED'`.
3. **Mid-pipeline (steps 1..N):** `composeService.compose` retorna `{success:false, error:'... DEST_CAP_EXCEEDED', errorCode:'DEST_CAP_EXCEEDED'}`; `routes/compose.ts` mapea `errorCode==='DEST_CAP_EXCEEDED'` → **HTTP 402** (nuevo branch junto al de `SCOPE_DENIED`→403).
4. Concurrencia (AC-4): 2 débitos al mismo destino → el `FOR UPDATE` de la policy serializa; el segundo lee el ledger ya actualizado por el primero → si excede, rechaza. Nunca ambos pasan.

---

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir
- **CD-A**: RPC `debit_with_dest_policy` espeja la estructura de `debit_session_and_parent` (lock → checks → `PERFORM increment_a2a_key_spend` → mutación) + el hardening block `ALTER/REVOKE/GRANT` con la firma tipada exacta.
- **CD-B**: el mapeo de errores en `spend-policy.ts`/`budget.ts` usa `msg.includes('PREFIX')` (mismo patrón que `key-session.ts:454-491`) y NUNCA propaga el `error.message` crudo de Postgres al cliente.
- **CD-C**: endpoints siguen `resolveCallerKey` + ownership (`callerKey.owner_ref`) del exemplar `auth.ts:1174-1233`.
- **CD-D**: nuevos tipos completamente tipados; sin `any`, sin `as unknown` (TS strict).

### PROHIBIDO (heredados del work-item CD-1..CD-6 + específicos)
- **CD-1 (ATOMICIDAD)**: PROHIBIDO chequear el cap en app-layer y debitar en RPC separado. Check cap + INSERT ledger + debit budget en la MISMA tx (RPC) con `FOR UPDATE` sobre policy + key.
- **CD-2 (BACK-COMPAT increment)**: PROHIBIDO modificar la firma o el cuerpo de `increment_a2a_key_spend`. El RPC nuevo lo REUSA vía `PERFORM`.
- **CD-3 (OWNERSHIP)**: PROHIBIDO acceder a `a2a_key_spend_policies`/`a2a_key_dest_spend_ledger` sin `.eq('key_id', keyId).eq('owner_ref', ownerId)` (`ownerId: string` no-opcional). En el RPC, ownership guard DB-layer (`v_key_owner IS DISTINCT FROM p_owner_ref`).
- **CD-4 (NO ROMPER WKH-121..124)**: PROHIBIDO alterar las firmas de `debitSessionAndParent`/`debitDelegationAndParent`/`KeySessionDebitContext`/`DelegationDebitContext` de forma que rompa call-sites. La extensión de sesión (AC-6) cambia SOLO el cuerpo del RPC `debit_session_and_parent` (dispatch interno a `debit_with_dest_policy`), no su firma TS.
- **CD-5 (NULL = SIN RESTRICCIÓN)**: PROHIBIDO ejecutar cualquier check nuevo cuando no hay política. Path sin `destination` → `increment_a2a_key_spend` directo (byte-idéntico). RPC con destino pero sin política → degrada a `increment_a2a_key_spend` + 0 inserts.
- **CD-6 (TS-STRICT / no ethers)**: sin `any`; validar invariante de ventana (`total`⇒`secs=null`, `rolling`⇒`secs>0`) en `spend-policy.ts`.
- **CD-7 (guard `i>0` intacto)**: PROHIBIDO tocar el guard `i > 0 && scopingKeyRow && chainId !== undefined` de `compose.ts:131` (única defensa anti-double-charge del step 0 — lección WKH-101/102).
- **CD-8 (aridad — auto-blindaje WKH-121)**: al agregar el 6º param a `debit`, grep OBLIGATORIO `'mockDebit).toHaveBeen'` / `'Debit).toHaveBeenNthCalledWith'` en TODO `src/` ANTES de tocar; actualizar las 12 aserciones enumeradas (8 compose + 4 orchestrate.billing). Distinguir llamadas que pasan por la cadena compose (suman arg) de las directas de 3 args (no suman).

---

## 6. Scope

**IN:**
- 2 tablas + RPC `debit_with_dest_policy` (migración `20260606000000`).
- `SpendPolicy*` types + `DestCapExceededError`.
- `spend-policy.ts` (CRUD + ownership + `hasAnyPolicy`).
- Rama dest-aware en `budget.debit` (path master) + propagación de destino en compose + step-0 middleware.
- Mapeo `DEST_CAP_EXCEEDED` → HTTP 402 (step-0 middleware + mid-pipeline route).
- Endpoints `PUT`/`GET` `/auth/keys/me/spend-policies` (+ `DELETE` opcional).
- AC-6: la sesión hereda las políticas de la parent (vía dispatch interno del RPC de sesión).
- Tests: 7 ACs + concurrencia (AC-4) + back-compat (AC-5) + window (AC-3).

**OUT:**
- Cap por categoría / por chain (sólo por `<registry>/<slug>`, USD cross-chain).
- Ventana calendárica (weekly-monday-reset). Sólo `rolling`(secs) y `total`.
- Override de políticas per-session real (`[TBD-FUTURO]`, DT-AC6).
- Extender políticas a delegaciones EIP-712 (DelegationPolicy mantiene su modelo).
- Purga/TTL del ledger (housekeeping futuro).
- RLS Postgres-level (sigue app-layer, deuda WKH-SEC-02).
- UI de gestión (API-only).

---

## 7. Riesgos

| Riesgo | Prob | Impacto | Mitigación |
|--------|------|---------|------------|
| Aridad de `debit` rompe tests no obvios | M | M | CD-8: grep obligatorio en TODO `src/`; blast radius ya mapeado (12 aserciones, 2 archivos) |
| Step-0 destino mal derivado del body (compose) | M | M | Derivar de `firstStep.agent`/`firstStep.registry`; tests de step-0 dest. Si `firstStep.registry` ausente, destino = `slug` solo (DT-8 del work-item) |
| `DEST_CAP_EXCEEDED` no mapeado a 402 en mid-pipeline | M | A (AC-2) | Branch explícito en `routes/compose.ts` junto a `SCOPE_DENIED`; test de mid-pipeline 402 |
| Ledger crece sin purga | B | B | Aceptado MVP; índice `(key_id,destination,debited_at)` mantiene SUM rápido; purga futura |
| Doble-lock de la key (RPC nuevo + `increment_a2a_key_spend`) | B | B | `FOR UPDATE` re-entrante en la misma tx (no-op); ordenado para evitar deadlock (siempre key→policy) |
| Sesión no aplica cap parent (AC-6) | M | M | Dispatch interno del RPC de sesión a `debit_with_dest_policy`; test de sesión+cap |

## 8. Dependencias

- WKH-121/122/123/124 DONE (mergeadas). Sin dependencias pendientes.
- Migración `20260606000000` libre (última existente: `20260605000000`, verificado).
- `increment_a2a_key_spend` y `trigger_set_updated_at` existen (verificado).

## 9. Missing Inputs

- [x] Formato de `destination`: resuelto → `<registry>/<slug>` normalizado (trim+lowercase). Si falta registry → `slug` solo.
- [ ] Override per-session real: `[TBD-FUTURO]` — no bloqueante (AC-6 cumplido en su parte de herencia).
- [x] Purga del ledger: sin purga en MVP (aceptado).

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| [TBD-FUTURO] | DT-AC6 | Override per-session (`spend_policies` con semántica "override por la vida de la sesión") requiere tabla/columna session-scoped. MVP: herencia de la parent. | No |
| [SUPUESTO] | DT-8 | `destination` = `<registry>/<slug>` string (no UUID). Conservador; ajustable post-MVP. | No |

> No hay `[NEEDS CLARIFICATION]` bloqueantes. Atomicidad y aridad RESUELTAS.

---

## 11. Plan de Implementación (Waves)

### Wave 0 — Serial Gate (contratos: tipos + migración + errores)
- [ ] W0.1: `src/types/a2a-key.ts` — `SpendPolicyWindowType` (`'total'|'rolling'`), `SpendPolicyInput` (`destination`, `max_usd`, `window_type`, `window_secs?`), `SpendPolicyRow`, `SpendPolicy` (response shape); extender `CreateKeySessionInput` con `spend_policies?: SpendPolicyInput[]`. → Exemplar: `a2a-key.ts:351-355`
- [ ] W0.2: `src/services/security/errors.ts` — `DestCapExceededError` (`code='DEST_CAP_EXCEEDED'`). → Exemplar: `errors.ts:304-310`
- [ ] W0.3: `supabase/migrations/20260606000000_a2a_key_spend_policies.sql` — 2 tablas (DT-2/DT-3) + índices + RPC `debit_with_dest_policy` (DT-RPC SQL completo) + hardening. + `..._down.sql`. → Exemplar: `20260603000000_a2a_key_sessions.sql`
- [ ] W0.4: re-export en `src/types/index.ts` si aplica.

### Wave 1 — Service de políticas (paralelizable tras W0)
- [ ] W1.1: `src/services/spend-policy.ts` — `set`/`list`/`delete`/`hasAnyPolicy` (ownership por `key_id+owner_ref`, normalización de destino, validación de invariante de ventana). → Exemplar: `key-session.ts:295-373`

### Wave 2 — Débito dest-aware + propagación (depende de W0 + W1)
- [ ] W2.1: `src/services/budget.ts` — 6º param `destination?: string`; rama master: si `destination` truthy → `rpc('debit_with_dest_policy', {p_key_id, p_chain_id, p_amount_usd, p_owner_ref, p_destination})` con mapeo de errores por prefijo; si falsy → `increment_a2a_key_spend` INTACTO. → Exemplar: `budget.ts:225-236` + `key-session.ts:454-491`
- [ ] W2.2: `src/services/compose.ts` — armar `destination=\`${agent.registry}/${agent.slug}\`` y pasarlo como 6º arg de `debit` (L159). Guard `i>0` (CD-7) intacto. → Exemplar: `compose.ts:159-165`

### Wave 3 — Rutas + step-0 + AC-6 (depende de W2)
- [ ] W3.1: `src/middleware/a2a-key.ts` — step-0: derivar `destination` del `firstStep` del body de compose; pasar a `debit`; mapear `DEST_CAP_EXCEEDED` → **402**. → Exemplar: `a2a-key.ts:789-817`
- [ ] W3.2: `src/routes/compose.ts` — branch `errorCode==='DEST_CAP_EXCEEDED'` → **402** (junto a `SCOPE_DENIED`→403). → Exemplar: `routes/compose.ts:179-180`
- [ ] W3.3: `src/routes/auth.ts` — `PUT`/`GET` `/keys/me/spend-policies` (+`DELETE`). → Exemplar: `auth.ts:1174-1233`
- [ ] W3.4: AC-6 — `supabase/migrations/20260606000000...sql` RPC `debit_session_and_parent` se actualiza para dispatch interno a `debit_with_dest_policy` cuando hay destino+política (recrear la función vía `CREATE OR REPLACE` en la MISMA migración nueva, firma TS intacta — CD-4); `key-session.ts:debitSessionAndParent` agrega param `destination?` y mapeo `DEST_CAP_EXCEEDED`. → Exemplar: `key-session.sql:28-96`

### Wave 4 — Tests (incluye concurrencia)
- [ ] W4.1: actualizar 12 aserciones de aridad (CD-8) en `compose.test.ts` (8) + `orchestrate.billing.test.ts` (4).
- [ ] W4.2: `src/services/spend-policy.test.ts` — CRUD + ownership + window invariante.
- [ ] W4.3: `src/services/budget.test.ts` — path dest-aware + back-compat.
- [ ] W4.4: `src/routes/auth.spend-policies.test.ts` — PUT/GET endpoints.
- [ ] W4.5: test de concurrencia (AC-4) + back-compat (AC-5) + window (AC-3).

### Test Plan

| Test | AC | Wave | Framework |
|------|-----|------|-----------|
| `auth.spend-policies.test.ts` — PUT persiste + ownership | AC-1, AC-7 | W4.4 | vitest |
| `budget.test.ts` — débito a destino con cap excedido → `DEST_CAP_EXCEEDED`, budget intacto | AC-2 | W4.3 | vitest |
| `routes/compose.test.ts` — `DEST_CAP_EXCEEDED` → HTTP 402 (step-0 + mid-pipeline) | AC-2 | W4.1 | vitest |
| `spend-policy.test.ts` — rolling window: débitos fuera de `window_secs` no cuentan | AC-3 | W4.5 | vitest |
| `spend-policy.test.ts` / `budget.test.ts` — **concurrencia**: 2 débitos simultáneos al mismo destino con cap=1, monto=1 c/u → exactamente 1 pasa (mock del RPC serializado o assert sobre el SUM bajo lock) | AC-4 | W4.5 | vitest |
| `budget.test.ts` — sin política: `debit` SIN destino → `increment_a2a_key_spend` directo (byte-idéntico, sin nuevos checks); con destino sin política → RPC degrada igual | AC-5 | W4.3 | vitest |
| `key-session.test.ts` — sesión cuya parent tiene cap por destino → el cap se aplica al debitar | AC-6 | W4.5 | vitest |
| `spend-policy.test.ts` — read/write con owner ajeno → `OwnershipMismatchError` | AC-7 | W4.2 | vitest |

> Nota AC-4: el test de concurrencia en vitest no abre 2 conexiones PG reales (los services mockean Supabase). El test verifica (a) que el service llama al RPC `debit_with_dest_policy` (no a un check app-layer separado) y (b) la lógica de serialización vía el ordenamiento `FOR UPDATE policy → SUM → check → debit` está en el SQL. La garantía de race real la da el `FOR UPDATE` del RPC (assert estructural sobre el SQL + test unitario del mapeo). Un test de integración PG real es deseable pero queda sujeto a la infra de tests existente.

### Estimación
- Archivos nuevos: 4 (migración + down + spend-policy.ts + 2 tests) — ~2 servicios/migración + 2 tests.
- Archivos modificados: ~8 (types, errors, budget, compose, a2a-key, routes/compose, routes/auth, key-session) + 2 tests existentes.
- Tests nuevos/actualizados: ~8 nuevos + 12 aserciones de aridad.

---

## 12. Implementation Readiness Check

```
READINESS CHECK:
[x] Cada AC tiene >=1 archivo asociado en §4.1 (AC1→auth.ts/spend-policy; AC2→budget/RPC/routes; AC3→RPC/spend-policy; AC4→RPC; AC5→budget; AC6→key-session/RPC; AC7→spend-policy)
[x] Cada archivo en §4.1 tiene Exemplar verificado con Glob/Read (líneas reales citadas)
[x] No hay [NEEDS CLARIFICATION] bloqueantes (atomicidad + aridad resueltas)
[x] Constraint Directives incluyen >=3 PROHIBIDO (CD-1..CD-8)
[x] Context Map tiene >=2 archivos leídos (14 archivos)
[x] Scope IN/OUT explícitos
[x] BD: tablas verificadas (a2a_agent_keys/a2a_key_sessions existen; las 2 nuevas se crean; timestamp 20260606000000 libre)
[x] Happy Path completo (§4.4)
[x] Flujo de error definido (§4.5: DEST_CAP_EXCEEDED, concurrencia, ROLLBACK)
```

---

*SDD generado por NexusAgil — FULL — WKH-125 (E16 final)*
