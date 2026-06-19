# SDD #110: [WKH-121] Session Keys sin EIP-712 (derivación server-side)

> SPEC_APPROVED: no
> Fecha: 2026-06-19
> Tipo: feature (security / identity)
> SDD_MODE: full
> Branch: feat/110-wkh-121-key-sessions
> Artefactos: doc/sdd/110-wkh-121-key-sessions/

---

## 1. Resumen

WKH-121 agrega **session keys efímeras derivadas server-side** desde una agent key
existente, **sin** wallet EVM ni firma EIP-712. Un caller autenticado con su master key
(`wasi_a2a_<…>`) hace `POST /auth/key-session` con `{ ttl_seconds, max_budget_usd,
allowed_* }` y recibe un token opaco `wasi_a2a_sess_<random>` (devuelto una sola vez). El
token autentica requests posteriores con scope acotado (`⊆ scope(master)`), TTL y budget
de sesión propio; si se filtra, el blast radius queda limitado.

WKH-101 (DONE, en prod) ya implementó session keys **con** EIP-712 (`wasi_a2a_session_*`,
tabla `a2a_delegations`). **WKH-121 NO lo duplica ni lo toca**: introduce una variante
server-side pura que coexiste con WKH-101 mediante un **prefijo de token distinto** y un
**branch de middleware adicional**. El path master (back-compat bearer) y el branch
EIP-712 quedan **intactos** (CD-1).

Resultado esperado: nueva tabla `a2a_key_sessions`, nuevo RPC atómico
`debit_session_and_parent`, nuevo service `keySessionService`, branch nuevo en el
middleware, y endpoints `POST/GET /auth/key-session`.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 110 (WKH-121) |
| **Tipo** | feature (security) |
| **SDD_MODE** | full |
| **Objetivo** | Derivar session keys efímeras acotadas desde una master key vía REST, sin firma EVM. |
| **Reglas de negocio** | scope sesión `⊆` scope master; TTL obligatorio acotado; débito atómico sesión + parent; ownership guard en toda query; token plano nunca persistido; sin sub-delegación. |
| **Scope IN** | Ver §6 (tabla + RPC + tipos + service + branch middleware + 2 endpoints + errores + tests). |
| **Scope OUT** | `DELETE /auth/key-session/:id` (WKH-122); auth por firma/passkey (WKH-123); recibos/proof-chain (WKH-124); constraints por destino/ventana (WKH-125); modificar branch EIP-712 WKH-101; RLS Postgres (WKH-SEC-02); rate limiting por sesión. |
| **Missing Inputs** | DT-1..DT-4 resueltos en este SDD (ver §10). Sin residuales bloqueantes. |

### Acceptance Criteria (EARS)

Los 15 ACs del work-item (`work-item.md` L75–159) se mantienen sin cambios. Resumen del
mapeo a implementación en §11 (Plan de tests). Resolución de las decisiones abiertas en §5/§10.

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón extraído |
|---------|---------|-----------------|
| `doc/sdd/110-wkh-121-key-sessions/work-item.md` (1–325) | Contrato aprobado: 15 ACs, 5 DTs, 7 CDs | ACs EARS, opciones DT-1, prefijos DT-2, RPC DT-3, scope DT-4, CDs |
| `.nexus/project-context.md` (1–339) | Fuente de verdad del stack | Fastify + Supabase PG + TS strict; sin `any`; puerto 3001; tablas prefijo `a2a_` |
| `doc/agent-key-vs-passport.md` (1–41) | Origen del épico E16 | Gap: key filtrada = acceso total hasta deactivate; sesiones acotan blast radius |
| `src/middleware/a2a-key.ts` (1–563) | Orden de detección por prefijo + branch delegación WKH-101 (L234–432) + path master (L434–559) | Extracción de `rawKey` (L193–213), branch session por `startsWith` (L234), inyección de `effectiveRow` con scope (L392–404), helper `resolveTargetChain` (L140–179), debit optimista pre-ejecución |
| `supabase/migrations/20260601000000_a2a_delegations.sql` (1–113) | Tabla + RPC `debit_delegation_and_parent` + hardening L104–111 | Tabla con `owner_ref` desnormalizado + `session_token_hash UNIQUE` + `revoked_at` nullable; RPC `FOR UPDATE` → TOCTOU re-check → check budget → `PERFORM increment_a2a_key_spend` → UPDATE; bloque hardening SET search_path/REVOKE/GRANT |
| `src/services/delegation.ts` (1–468) | Service completo a espejar | `create` (token opaco + SHA-256, owner_ref desde parentKey), `lookupByTokenHash` (sin owner gate — no IDOR, L255–275), `getParentKey` (L284–297), `list` con status derivado (L300–342), `debitDelegationAndParent` mapea errores por prefijo (L377–436) |
| `src/types/a2a-key.ts` (1–260) | Tipos `A2AAgentKeyRow`, `DelegationRow`, `DelegationPolicy`, error-code unions | `A2AAgentKeyRow` (L34–68) con `budget`, `allowed_*: string[] \| null`; shapes de input/response/list (L207–231) |
| `src/services/budget.ts` (1–180) | Cómo se debita del parent hoy | `debit` (L62–138) rutea a RPC; `getBalance` con ownership guard (L29–51); `registerDeposit` mapea errores por prefijo de mensaje (L148–179) |
| `src/routes/auth.ts` (1–1051) | Endpoints `/auth/*`, parsing de input, sub-delegación | `POST /delegation` (L897–981), `GET /delegation` (L1022–1033), `resolveCallerKey` (L104–133), `rawKeyFromRequest` (L140–153), sub-delegation gate por prefijo ANTES de resolveCallerKey (L903–906) |
| `src/services/security/errors.ts` (1–348) | Error classes + `logOwnershipMismatch` | Patrón `readonly code = '...' as const` + `name`; overload posicional de `logOwnershipMismatch` (L300–304) acepta solo `'getBalance' \| 'deactivate'`; forma objeto (L305–310) acepta `OwnershipOp` |
| `supabase/migrations/20260406000000_a2a_agent_keys.sql` (1–148) | Columnas reales de `a2a_agent_keys` + `increment_a2a_key_spend` | `owner_ref`, `budget JSONB`, `allowed_*` TEXT[], `is_active`; RPC `increment_a2a_key_spend(uuid,int,numeric)` con `FOR UPDATE` + RAISE `KEY_NOT_FOUND`/`KEY_INACTIVE`/`DAILY_LIMIT`/`INSUFFICIENT_BUDGET` |
| `src/index.ts` (19, 121) | Montaje de rutas | `authRoutes` registrado con `prefix: '/auth'` → el path interno NO lleva `/auth` (path interno `/key-session`) |
| `src/middleware/a2a-key.test.ts` (1–55) | Estructura de tests del middleware | `vi.mock` de identity/budget/delegation; Fastify in-process; `lookupByTokenHash`/`getParentKey`/`debitDelegationAndParent` mockeados |
| `src/services/delegation.test.ts` (1–40) | Estructura de tests del service | `vi.mock('../lib/supabase.js')` con `{ from, rpc }`; aserciones por error class |
| `doc/sdd/101…/auto-blindaje.md`, `104…`, `109…` | Errores recurrentes históricos | Ver §5.6 (CD-AB-*) |

### Exemplars

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `supabase/migrations/<ts>_a2a_key_sessions.sql` (nuevo) | `supabase/migrations/20260601000000_a2a_delegations.sql` (1–113) | Tabla + RPC atómico + hardening idénticos en forma |
| `src/services/key-session.ts` (nuevo) | `src/services/delegation.ts` (1–468) | `create`/`lookupByTokenHash`/`list`/`debitSessionAndParent` |
| `src/middleware/a2a-key.ts` branch nuevo | branch WKH-101 (L234–432) del mismo archivo | Estructura del branch: lookup → checks pre-debit → parent → chain → debit atómico → effectiveRow → header → `return` |
| `src/routes/auth.ts` endpoints nuevos | `POST/GET /delegation` (L897–981, L1022–1033) | Auth via `resolveCallerKey`, sub-delegation gate, validación de input, mapeo error→HTTP |
| `src/types/a2a-key.ts` tipos nuevos | `DelegationRow`/`CreateDelegationInput`/`DelegationListItem` (L190–231) | Interfaces tipadas, comentarios de origen |
| `src/services/security/errors.ts` clases nuevas | clases `Delegation*Error` (L144–222) | `readonly code = '…' as const` + `name` |
| `src/services/key-session.test.ts` (nuevo) | `src/services/delegation.test.ts` | Mock `supabase {from,rpc}`, aserciones por error class |
| `src/middleware/a2a-key.test.ts` (modificar) | suite existente | Mock `keySessionService` + tests del nuevo branch |
| `src/routes/auth.keySession.test.ts` (nuevo) | `src/routes/auth.delegation.test.ts` | Fastify in-process, 201/200/400/403 |

### Estado de BD relevante

| Tabla | Existe | Columnas relevantes |
|-------|--------|---------------------|
| `a2a_agent_keys` | Sí (20260406000000) | `id`, `owner_ref`, `budget` JSONB, `allowed_registries/agent_slugs/categories` TEXT[], `is_active` |
| `a2a_delegations` | Sí (20260601000000) | WKH-101 EIP-712 — **NO se toca** (DT-1) |
| `a2a_key_sessions` | **No — se crea en W0** (DT-1 Opción A) | ver §4.2 |
| RPC `increment_a2a_key_spend(uuid,int,numeric)` | Sí | Se **reusa** vía `PERFORM` en el RPC nuevo (DT-3) |

### Componentes reutilizables encontrados

- `increment_a2a_key_spend` (20260406000000 L56–121) — reusar en el RPC nuevo para debitar el parent (NO reimplementar el debit del budget JSONB).
- `resolveTargetChain` (a2a-key.ts L140–179) — reusar para resolver `chainId` en el branch nuevo (ya lo reusa el branch WKH-101 y el master).
- `resolveCallerKey` / `rawKeyFromRequest` (auth.ts L104–153) — reusar en los endpoints nuevos.
- `logOwnershipMismatch` (errors.ts L300–348) — reusar; **NO** ampliar el union de ops sin que `errors.ts` esté en scope (lo está — ver CD-AB-4).

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Qué hace | Exemplar | Wave |
|---------|--------|----------|----------|------|
| `src/types/a2a-key.ts` | Modificar | `KeySessionRow`, `CreateKeySessionInput`, `KeySessionResponse`, `KeySessionListItem`, `KeySessionStatus`, `KeySessionDebitContext`, error-code union `SESSION_*` | tipos `Delegation*` (L190–231) | W0 |
| `src/services/security/errors.ts` | Modificar | `SessionTokenInvalidError`, `SessionExpiredError`, `SessionBudgetExhaustedError`, `SessionNotAllowedError`; agregar `'keySessionRevoke'`/`'keySessionList'` a `OwnershipOp` (forma objeto) | clases `Delegation*Error` (L144–222) | W0 |
| `supabase/migrations/<ts>_a2a_key_sessions.sql` (nuevo) | Crear | Tabla `a2a_key_sessions` + índices + RPC `debit_session_and_parent` + hardening | `20260601000000_a2a_delegations.sql` | W0 |
| `supabase/migrations/<ts>_a2a_key_sessions_down.sql` (nuevo) | Crear | DROP de la tabla + RPC (down migration, patrón del repo) | `*_a2a_delegations_down.sql` | W0 |
| `.env.example` | Modificar | `SESSION_MAX_TTL_SECONDS=86400` con comentario | bloque `DELEGATION_*` (L145–155) | W0 |
| `src/services/key-session.ts` (nuevo) | Crear | `create`, `lookupByTokenHash`, `getParentKey`, `list`, `debitSessionAndParent` | `src/services/delegation.ts` | W1 |
| `src/middleware/a2a-key.ts` | Modificar | Branch nuevo `wasi_a2a_sess_*` (insertado DESPUÉS del branch WKH-101, ANTES del master); augment de `request.a2aKeyRow` con scope efectivo; `request.keySessionContext` | branch WKH-101 (L234–432) | W2 |
| `src/services/budget.ts` | Modificar | `debit` acepta `keySessionContext?` y rutea al RPC nuevo (steps 2..N de compose) | ruta delegación de `debit` (L62–124) | W2 |
| `src/routes/auth.ts` | Modificar | `POST /key-session` (201), `GET /key-session` (200); sub-delegation gate (AC-12) | `POST/GET /delegation` (L897–1033) | W3 |
| `src/services/key-session.test.ts` (nuevo) | Crear | Unit del service (create/lookup/list/debit + ownership + mapeo errores) | `delegation.test.ts` | W4 |
| `src/middleware/a2a-key.test.ts` | Modificar | Tests del branch nuevo (AC-4/5/6/7/8/9/10/14/15) | suite existente | W4 |
| `src/routes/auth.keySession.test.ts` (nuevo) | Crear | Tests de endpoints (AC-1/2/3/12/13) | `auth.delegation.test.ts` | W4 |
| `src/__tests__/e2e/key-session-atomicity.real.test.ts` (nuevo, opcional gated) | Crear | Atomicidad del RPC real (AC-8) gateado por `INTEGRATION_TEST_DB_URL` | `delegation-atomicity.real.test.ts` | W4 |

### 4.2 Modelo de datos — DT-1: tabla separada `a2a_key_sessions` (Opción A)

**Decisión: Opción A (tabla nueva).** Justificación de impacto (ver §5 DT-1).

```sql
CREATE TABLE IF NOT EXISTS a2a_key_sessions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id              UUID NOT NULL REFERENCES a2a_agent_keys(id) ON DELETE CASCADE,
  owner_ref           TEXT NOT NULL,                 -- desnormalizado (Ownership Guard, CD-2)
  session_token_hash  TEXT NOT NULL UNIQUE,          -- SHA-256(token) — hot-path lookup (AC-4)
  ttl_seconds         INT  NOT NULL,                 -- valor solicitado (auditoría)
  expires_at          TIMESTAMPTZ NOT NULL,          -- now() + ttl_seconds (server-side, CD-5)
  max_budget_usd      NUMERIC(20,8) NOT NULL,        -- budget de la sesión (AC-9)
  spent_usd           NUMERIC(20,8) NOT NULL DEFAULT 0,
  allowed_registries  JSONB,                         -- NULL = hereda restricción del padre (DT-4)
  allowed_agent_slugs JSONB,                         -- NULL = hereda restricción del padre (DT-4)
  allowed_categories  JSONB,                         -- NULL = hereda restricción del padre (DT-4)
  derivation_mode     TEXT NOT NULL DEFAULT 'server',-- discrimina vs EIP-712 (futuro-proof)
  revoked_at          TIMESTAMPTZ,                   -- NULL = activa (WKH-122, nota 4 work-item)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- UNIQUE(session_token_hash) ya provee el índice btree O(1) del hot-path (AC-4);
-- NO crear un índice explícito redundante sobre esa columna (lección WKH-101 SDD §1.3).
CREATE INDEX IF NOT EXISTS idx_a2a_key_sessions_key_owner
  ON a2a_key_sessions (key_id, owner_ref);
CREATE INDEX IF NOT EXISTS idx_a2a_key_sessions_owner
  ON a2a_key_sessions (owner_ref);
```

Notas:
- `allowed_*` se almacena como **JSONB** (`["kite","wasiai"]` o `NULL`). El work-item DT-1
  Opción A lo especifica como JSONB; el service serializa el array TS → JSONB y al leer
  castea de vuelta. (La tabla padre usa `TEXT[]`; acá usamos JSONB para alinear con DT-1 y
  con el `policy` JSONB de WKH-101. La intersección se calcula en TS, no en SQL.)
- `revoked_at TIMESTAMPTZ` (nullable) **presente desde W0** → WKH-122 no necesita migración (nota 4).
- `derivation_mode` con default `'server'` deja la puerta abierta a unificar a futuro sin migración de datos.

### 4.3 RPC atómico — DT-3: `debit_session_and_parent`

SQL **completo** (calcado de `debit_delegation_and_parent`, 20260601000000 L41–111). Reusa
`increment_a2a_key_spend` para el parent. Incluye hardening (CD-7).

```sql
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
  -- 1. Lock de la sesión (FOR UPDATE — serializa débitos concurrentes; AC-8).
  SELECT owner_ref, key_id, revoked_at, expires_at, spent_usd, max_budget_usd
    INTO v_owner, v_key_id, v_revoked, v_expires, v_spent, v_max
    FROM a2a_key_sessions
    WHERE id = p_session_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SESSION_NOT_FOUND: %', p_session_id;
  END IF;

  -- 2. Ownership Guard a nivel DB (CD-2 — el service usa SERVICE_ROLE / bypass RLS).
  IF v_owner IS DISTINCT FROM p_owner_ref THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: session % not owned by caller', p_session_id;
  END IF;
  IF v_key_id IS DISTINCT FROM p_key_id THEN
    RAISE EXCEPTION 'OWNERSHIP_MISMATCH: session % not bound to key %', p_session_id, p_key_id;
  END IF;

  -- 3. Revocación / expiry re-chequeados BAJO LOCK (TOCTOU-safe, DT-3).
  IF v_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'SESSION_REVOKED: %', p_session_id;
  END IF;
  IF NOW() >= v_expires THEN
    RAISE EXCEPTION 'SESSION_EXPIRED: %', p_session_id;
  END IF;

  -- 4. Check del budget de la sesión (AC-9) ANTES del debit del parent.
  v_new_spent := v_spent + p_amount_usd;
  IF v_new_spent > v_max THEN
    RAISE EXCEPTION 'SESSION_BUDGET_EXHAUSTED: % + % > %', v_spent, p_amount_usd, v_max;
  END IF;

  -- 5. Debit del parent budget reusando la fn existente (AC-8).
  --    increment_a2a_key_spend RAISE 'INSUFFICIENT_BUDGET'/'DAILY_LIMIT'/'KEY_INACTIVE'/
  --    'KEY_NOT_FOUND' si corresponde → se propagan, toda la tx hace ROLLBACK
  --    (spent_usd no se incrementa). NO se hace scope check acá (CD-4: ya en creación).
  PERFORM increment_a2a_key_spend(p_key_id, p_chain_id, p_amount_usd);

  -- 6. Recién acá incrementamos spent_usd (orden 4→5→6 defensivo).
  UPDATE a2a_key_sessions SET spent_usd = v_new_spent WHERE id = p_session_id;

  RETURN v_new_spent;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Hardening obligatorio (CD-7; patrón 20260601000000 L104–111).
ALTER FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric)
  TO service_role;
```

**Mapeo de prefijos → error class** en `keySessionService.debitSessionAndParent` (CD-AB-1: enumerar
TODOS los RAISE de la cadena, incluido el `PERFORM increment_a2a_key_spend`):

| Prefijo RAISE | Origen | Error class (TS) | HTTP final |
|---------------|--------|------------------|-----------|
| `SESSION_BUDGET_EXHAUSTED` | RPC propio | `SessionBudgetExhaustedError` | 403 |
| `SESSION_REVOKED` | RPC propio | `SessionTokenInvalidError`* / dedicado | 403 |
| `SESSION_EXPIRED` | RPC propio | `SessionExpiredError` | 403 |
| `SESSION_NOT_FOUND` | RPC propio | `SessionTokenInvalidError` | 401/403 |
| `OWNERSHIP_MISMATCH` | RPC propio | `OwnershipMismatchError` | 403 |
| `INSUFFICIENT_BUDGET` | `increment_a2a_key_spend` | `AgentKeyBudgetExhaustedError` (reuso) | 403 |
| `DAILY_LIMIT` | `increment_a2a_key_spend` | `DailyLimitExceededError` (reuso) | 403 |
| `KEY_INACTIVE` | `increment_a2a_key_spend` | `AgentKeyInactiveError` (reuso) | 403 |
| `KEY_NOT_FOUND` | `increment_a2a_key_spend` | `AgentKeyNotFoundError` (reuso) | 403 |
| (cualquier otro) | — | `Error('SESSION_DEBIT_FAILED')` SIN msg crudo | 503 |

\* En el branch de middleware, el pre-debit check de `revoked_at`/`expires_at` ya devuelve
403 antes del RPC; el RAISE bajo lock cubre la carrera TOCTOU. **Nunca** propagar `error.message`
crudo de PG al body (CD-AB-1 / AR-MNR-2).

### 4.4 Flujo principal (Happy Path)

**Creación (`POST /auth/key-session`):**
1. `resolveCallerKey(req)` autentica la master key (igual que `/delegation`).
2. Sub-delegation gate: si `rawKeyFromRequest` empieza con `wasi_a2a_sess_` → 403 `SESSION_NOT_ALLOWED` (AC-12), ANTES de resolver.
3. Validar input: `ttl_seconds` entero `> 0` y `<= SESSION_MAX_TTL_SECONDS` (AC-3/CD-5); `max_budget_usd` decimal `> 0`; `allowed_*` opcionales (array de strings o ausente).
4. Verificar scope `⊆` master (CD-4/AC-2) en la capa de aplicación, ANTES del INSERT:
   - `max_budget_usd <= balance disponible del parent` (sumar `budget` por chain o validar contra el chain por defecto — ver §5 DT-4 nota budget).
   - para cada allowlist no-null en la sesión: si el padre tiene lista no-null, `sesión ⊆ padre`; si el padre tiene `null` (sin restricción), cualquier subset declarado es válido.
5. Generar token `wasi_a2a_sess_<crypto.randomBytes(48).hex>`; persistir SOLO `SHA-256(token)` (CD-3).
6. `expires_at = now() + ttl_seconds` calculado server-side (CD-5).
7. INSERT con `key_id`/`owner_ref` desde `callerKey` (NUNCA del body).
8. Responder 201 `{ session_id, session_token, expires_at, scope }` — token plano SOLO acá (AC-1).

**Autenticación con sesión (middleware, branch nuevo):**
1. `rawKey.startsWith('wasi_a2a_sess_')` → entra al branch (DESPUÉS del branch WKH-101, ANTES del master).
2. `lookupByTokenHash(sha256(rawKey))`; null → 401 `SESSION_TOKEN_INVALID` (AC-5).
3. `revoked_at !== null` → 403 (pre-debit); `now() >= expires_at` → 403 `SESSION_EXPIRED` (AC-6).
4. `getParentKey(key_id)`; `!is_active` → 403 `KEY_INACTIVE` (AC-7).
5. `resolveTargetChain(req, reply)` → `chainId` (reuso del helper).
6. Debit atómico `debitSessionAndParent(session.id, parent.owner_ref, parent.id, chainId, estimatedCostUsd)` (AC-8/AC-9).
7. Construir `effectiveRow = { ...parent, allowed_* = intersección(sesión, parent) }` (DT-4); setear `request.a2aKeyRow`, `request.keySessionContext`.
8. Header `x-a2a-remaining-budget`; `return` (no continuar al master).

**Listado (`GET /auth/key-session`):**
1. Auth master key. 2. `list(owner_ref)` con ownership guard. 3. 200 con `session_id, expires_at, max_budget_usd, spent, status, scope` (AC-13).

### 4.5 Flujo de error

| Condición | HTTP | error_code |
|-----------|------|-----------|
| token no existe | 401 | `SESSION_TOKEN_INVALID` (AC-5) |
| `now() >= expires_at` | 403 | `SESSION_EXPIRED` (AC-6) |
| parent `is_active=false` | 403 | `KEY_INACTIVE` (AC-7) |
| `spent + amount > max_budget_usd` | 403 | `SESSION_BUDGET_EXHAUSTED` (AC-9) |
| sub-delegación (token sesión crea sesión) | 403 | `SESSION_NOT_ALLOWED` (AC-12) |
| `ttl_seconds <= 0` o `> SESSION_MAX_TTL_SECONDS` | 400 | `INVALID_INPUT` (AC-3) |
| scope sesión `⊄` master | 400 | `SCOPE_EXCEEDS_PARENT` (AC-2) |
| ownership mismatch (RPC/list) | 403 | `OWNERSHIP_MISMATCH` (AC-11) |
| error inesperado de servicio | 503 | `SERVICE_ERROR` (sin msg crudo de PG) |

## 5. Decisiones técnicas (DT-N)

### DT-1 (modelo de datos) — RESUELTO: Opción A, tabla separada `a2a_key_sessions`

Análisis de impacto:
- **`a2a_delegations` tiene columnas `NOT NULL` específicas de EIP-712**: `session_key_address`
  (L15), `typed_data_raw` (L21), `nonce` (L22), y `CONSTRAINT uq_a2a_delegations_key_nonce
  UNIQUE (key_id, nonce)` (L25). La Opción B exigiría: (a) hacer nullable esas 3 columnas,
  (b) eliminar/refactorizar la constraint UNIQUE (que es anti-replay del flow firmado), (c)
  null-handling en `delegationService` y en el RPC `debit_delegation_and_parent`. Cada uno de
  esos cambios **toca código DONE en prod** (WKH-101) y arriesga drift con los rows existentes.
- **El RPC de débito difiere**: WKH-101 debita contra `total_spent` vs `policy->>'max_total_amount'`;
  WKH-121 debita contra `spent_usd` vs `max_budget_usd` (columna escalar, no JSONB). Compartir
  un RPC obligaría a branching por `derivation_mode` adentro del RPC → más superficie de error.
- **CD-1 (no tocar WKH-101)**: una tabla separada garantiza por construcción que el branch
  EIP-712 y su RPC quedan intactos. Riesgo de regresión = 0 sobre `a2a_delegations`.
- **Análisis de paralelismo del work-item (L299–302)**: "Opción A → no hay riesgo de conflicto
  de merge". Confirmado.

**Decisión: Opción A.** Tabla `a2a_key_sessions` + RPC `debit_session_and_parent` propios.
`derivation_mode TEXT DEFAULT 'server'` queda como hook de unificación futura sin migración.

### DT-2 (prefijo de token + orden de detección) — RESUELTO: `wasi_a2a_sess_`

- **Prefijo elegido:** `wasi_a2a_sess_` (más legible que `wasi_a2a_sk_`; consistente con la
  familia `wasi_a2a_session_`).
- **Hallazgo verificado (load-bearing):** `wasi_a2a_session_*` **NO** empieza con
  `wasi_a2a_sess_` — el carácter tras `sess` es `i`, no `_`. Verificado:
  ```
  'wasi_a2a_session_abc'.startsWith('wasi_a2a_sess_')   === false
  'wasi_a2a_sess_xyz'.startsWith('wasi_a2a_session_')   === false
  ```
  Los dos prefijos son **mutuamente exclusivos**: ningún token de un branch matchea el otro.
  No hay colisión en ninguna dirección.
- **Orden de detección EXACTO en `requirePaymentOrA2AKey`** (CD-1, crítico):
  1. `rawKey.startsWith('wasi_a2a_session_')` → branch WKH-101 (EIP-712) — **se mantiene PRIMERO** (L234, intacto).
  2. `rawKey.startsWith('wasi_a2a_sess_')` → **branch nuevo WKH-121** (insertado entre el `}` del branch WKH-101, ~L432, y el `let keyRow` del master, L434).
  3. fallback → path master bearer (`wasi_a2a_*` sin prefijo de sesión) — intacto (L434+).
  El regex de extracción de `rawKey` (L203) ya captura ambos prefijos (ambos empiezan con `wasi_a2a_`); no se modifica.
- **Constante:** definir `const KEY_SESSION_TOKEN_PREFIX = 'wasi_a2a_sess_'` en `key-session.ts`
  (espejo de `SESSION_TOKEN_PREFIX` en `delegation.ts` L45) y reusar en middleware + routes (importar o re-declarar local — ver CD-AB-2).

### DT-3 (RPC atómico) — RESUELTO

Ver SQL completo en §4.3. `FOR UPDATE` sobre la sesión, re-check TOCTOU de revocación/expiry
bajo lock, check `spent + amount <= max_budget_usd`, `PERFORM increment_a2a_key_spend` para el
parent (ROLLBACK propaga su RAISE), UPDATE de `spent_usd` al final, hardening completo.

### DT-4 (scope efectivo) — RESUELTO + [NEEDS CLARIFICATION] resuelto

- **Intersección inyectada en `request.a2aKeyRow.allowed_*`** para que `composeService`/
  `orchestrateService` apliquen los checks existentes sin modificación (igual que el branch
  WKH-101 con `effectiveRow`, a2a-key.ts L392–404).
- **Resolución del `[NEEDS CLARIFICATION]` (work-item L228–231):** confirmado el comportamiento
  más seguro. Regla de intersección por dimensión:
  - sesión `null` (no declara) + padre `null` (sin restricción) → efectivo `null` (sin restricción).
  - sesión `null` + padre `[A,B]` → efectivo `[A,B]` (**hereda la restricción del padre**, NO se elimina).
  - sesión `[A]` + padre `null` → efectivo `[A]` (la sesión puede restringir aunque el padre no).
  - sesión `[A]` + padre `[A,B]` → efectivo `[A]` (subset; válido).
  - sesión `[A,C]` + padre `[A,B]` → **RECHAZO en creación** (`C ∉ padre`, AC-2/CD-4).
  Implementación: `effective = sesión === null ? padre : sesión` (tras validar `sesión ⊆ padre` en creación).
- **Budget del parent en la validación de creación (AC-2):** `max_budget_usd <=` budget
  disponible del padre. El `budget` del padre es por-chain (`{"2368":"10.00"}`). La validación
  en creación compara `max_budget_usd` contra **el balance del chain por defecto** (`getDefaultChainKey`)
  o, si el padre tiene un único chain con fondos, ese. La garantía dura del cap por-chain la da
  el RPC en tiempo de débito (el parent no puede gastar más de su `budget[chainId]`). La
  validación de creación es un guard early-fail, no la línea de defensa final.

### DT-5 (env var) — RESUELTO

`SESSION_MAX_TTL_SECONDS` (default 86400 = 24h). Agregar a `.env.example` junto al bloque
`DELEGATION_*` (L145–155). Leer con `Number(process.env.SESSION_MAX_TTL_SECONDS ?? 86400)`;
si NaN o `<= 0`, usar default 86400 (fail-safe). NO inventar otro chainId/secret.

### 5.6 — Auto-Blindaje histórico (lecciones de WKH-101/104/117) → CD-AB-*

Patrones recurrentes detectados (≥1 con alto impacto en HUs adyacentes de identidad/pago):

- **CD-AB-1 (RPC error mapping completo):** WKH-101 auto-blindaje#FixPack-AR-MNR-1 — un RPC que
  hace `PERFORM`/`SELECT FROM otra_fn()` re-emite los RAISE de la fn anidada. Enumerar **todos**
  los prefijos de la cadena (incl. `increment_a2a_key_spend`: `INSUFFICIENT_BUDGET`/`DAILY_LIMIT`/
  `KEY_INACTIVE`/`KEY_NOT_FOUND`) antes de mapear. **NUNCA** propagar `error.message` de PG al body. (ya en §4.3)
- **CD-AB-2 (prefijo de ruta en plugin con prefix):** WKH-101 auto-blindaje#W2 — `authRoutes` se
  registra con `prefix: '/auth'` (index.ts:121). El path interno del handler **NO** lleva `/auth`:
  usar `fastify.post('/key-session', …)` → URL pública `/auth/key-session`.
- **CD-AB-3 (decimales sin float lossy / validación de amounts):** WKH-101 auto-blindaje#CR-MNR-1
  — validar `max_budget_usd`/`ttl_seconds` como formato + rango en el parser del body (decimal
  `> 0` para budget, entero `> 0` para ttl), no asumir que el shape implica validez semántica.
- **CD-AB-4 (`logOwnershipMismatch` op union):** WKH-117 auto-blindaje#W3 — el overload posicional
  solo acepta `'getBalance' \| 'deactivate'`. Como `errors.ts` **está en Scope IN** de WKH-121,
  se permite agregar `'keySessionRevoke'`/`'keySessionList'` al union `OwnershipOp` (forma objeto,
  L283–289) y usar la **forma objeto** `logOwnershipMismatch({ op, resourceId, callerOwnerRef })`.
  Si por alguna razón `errors.ts` quedara fuera de scope, reusar la forma objeto con una op
  existente — NUNCA el overload posicional con un literal nuevo.
- **CD-AB-5 (tests — env var ausente + mocks):** WKH-104 auto-blindaje — para tests que dependen
  de AUSENCIA de `SESSION_MAX_TTL_SECONDS` usar `delete process.env.X` (no `= undefined`). Setup
  que puede lanzar va en `beforeAll`, no en el cuerpo del `describe` (relevante para el test e2e
  gateado por `INTEGRATION_TEST_DB_URL`). Resetear cola de mocks (`mockReset`) en tests nuevos.

## 6. Scope

**IN:** (idéntico a §4.1)
- Tabla `a2a_key_sessions` + down migration + RPC `debit_session_and_parent` + hardening.
- Tipos `KeySession*` + error-code union; error classes `Session*`; `OwnershipOp` += `keySession*`.
- `src/services/key-session.ts` (`create`, `lookupByTokenHash`, `getParentKey`, `list`, `debitSessionAndParent`).
- Branch nuevo en `src/middleware/a2a-key.ts`; `keySessionContext` en `budget.ts`.
- Endpoints `POST/GET /auth/key-session`.
- `.env.example` += `SESSION_MAX_TTL_SECONDS`.
- Tests (≥1 por AC).

**OUT:** (idéntico a §2 / work-item L177–188)
- `DELETE /auth/key-session/:id` (WKH-122); auth firma/passkey (WKH-123); recibos (WKH-124);
  constraints destino/ventana (WKH-125); modificar branch EIP-712 (WKH-101); RLS Postgres
  (WKH-SEC-02); rate limiting por sesión.

## 7. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| Romper back-compat del path master/branch WKH-101 | B | A | Branch nuevo aislado por prefijo mutuamente-excluyente (DT-2); tests AC-14/AC-15 explícitos; NO se editan L234–432 ni L434–559 (solo se inserta entre ellos) |
| RPC mapeo incompleto → 503 + leak PG | M | M | CD-AB-1: tabla §4.3 enumera toda la cadena; test que asserta error_code estable, no msg crudo |
| Scope efectivo mal calculado (sesión null vacía la restricción del padre) | M | A | DT-4 regla explícita + test `sesión null + padre [A,B] → [A,B]` |
| Débito no atómico bajo concurrencia | B | A | `FOR UPDATE` + re-check bajo lock; test e2e gated AC-8 (atomicidad real) |
| Prefijo de ruta duplicado `/auth/auth/key-session` | M | M | CD-AB-2: path interno sin `/auth`; test 201 contra `/auth/key-session` |
| `max_budget_usd` por-chain ambiguo | M | B | RPC garantiza cap por `budget[chainId]`; validación de creación documentada como early-fail (DT-4) |

## 8. Dependencias

- `a2a_agent_keys` + `increment_a2a_key_spend` (existen, 20260406000000).
- Branch WKH-101 (`a2a_delegations`, `debit_delegation_and_parent`) existe y se preserva.
- `resolveCallerKey`/`rawKeyFromRequest`/`resolveTargetChain`/`logOwnershipMismatch` (existen).
- WKH-121 **bloquea** WKH-122 (revocación) y WKH-123 (firma); no bloquea WKH-124/125/118.

## 9. Missing Inputs

- Ninguno bloqueante. DT-1..DT-5 resueltos en §5. `SESSION_MAX_TTL_SECONDS` se agrega a `.env.example`.

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| ~~[NEEDS CLARIFICATION] sesión `allowed_*=null`~~ | DT-4 | RESUELTO: null en sesión hereda restricción del padre | No |
| ~~[NEEDS CLARIFICATION] DELETE en WKH-121~~ | Scope OUT | RESUELTO por work-item: OUT (WKH-122). `revoked_at` ya en el modelo | No |
| [TBD] precisión exacta de la comparación budget por-chain en creación | DT-4 | El Dev usa `getDefaultChainKey` o el único chain con fondos; el cap real lo da el RPC. No bloqueante | No |

> Gate: sin [NEEDS CLARIFICATION] pendientes. El [TBD] es de implementación, no de negocio.

## 11. Plan de tests (≥1 por AC)

| Test (id) | AC | Archivo | Wave | Qué verifica |
|-----------|----|---------|------|--------------|
| T-CREATE-1 | AC-1 | `auth.keySession.test.ts` | W4 | POST 201 con `{session_id, session_token, expires_at, scope}`; token plano SOLO en la respuesta; DB guarda solo hash |
| T-SCOPE-1 | AC-2 | `auth.keySession.test.ts` | W4 | 400 `SCOPE_EXCEEDS_PARENT` si `allowed_registries` ⊄ padre |
| T-SCOPE-2 | AC-2 | `key-session.test.ts` | W4 | `max_budget_usd` > balance del padre → 400 |
| T-TTL-1 | AC-3 | `auth.keySession.test.ts` | W4 | `ttl_seconds <= 0` → 400; `> SESSION_MAX_TTL_SECONDS` → 400; válido → 201 (usar `delete process.env` para default, CD-AB-5) |
| T-MW-LOOKUP | AC-4 | `a2a-key.test.ts` | W4 | branch `wasi_a2a_sess_*` hace lookup por hash, inyecta `a2aKeyRow` con scope efectivo, debita |
| T-MW-INVALID | AC-5 | `a2a-key.test.ts` | W4 | token inexistente → 401 `SESSION_TOKEN_INVALID` |
| T-MW-EXPIRED | AC-6 | `a2a-key.test.ts` | W4 | `now() >= expires_at` → 403 `SESSION_EXPIRED` |
| T-MW-KEYINACTIVE | AC-7 | `a2a-key.test.ts` | W4 | parent `is_active=false` → 403 `KEY_INACTIVE` |
| T-RPC-ATOMIC | AC-8 | `key-session.test.ts` + `key-session-atomicity.real.test.ts` (gated) | W4 | débito atómico sesión + parent; concurrencia no excede budget (real DB gated por `INTEGRATION_TEST_DB_URL`, CD-AB-5) |
| T-BUDGET-EXH | AC-9 | `key-session.test.ts` | W4 | `spent + amount > max_budget_usd` → `SessionBudgetExhaustedError` → 403 |
| T-SCOPE-EFF | AC-10 | `a2a-key.test.ts` | W4 | `a2aKeyRow.allowed_*` = intersección (no el del padre completo); incluye caso sesión `null` + padre `[A,B]` → `[A,B]` (DT-4) |
| T-OWNERSHIP-1 | AC-11 | `key-session.test.ts` | W4 | `list`/`debit` filtran por `owner_ref`; firma de service exige `ownerId: string`; cross-owner → `OwnershipMismatchError` |
| T-SUBDELEG | AC-12 | `auth.keySession.test.ts` | W4 | token `wasi_a2a_sess_*` en `POST /auth/key-session` → 403 `SESSION_NOT_ALLOWED` |
| T-LIST | AC-13 | `auth.keySession.test.ts` | W4 | `GET /auth/key-session` 200 con `status` derivado (active/expired/revoked) y scope |
| T-BACKCOMPAT | AC-14 | `a2a-key.test.ts` | W4 | master key `wasi_a2a_*` sin prefijo → path master intacto (debit master, mismo comportamiento) |
| T-COEXIST | AC-15 | `a2a-key.test.ts` | W4 | `wasi_a2a_session_*` → branch WKH-101 (delegationService); `wasi_a2a_sess_*` → branch WKH-121 (keySessionService); no se cruzan |
| T-RPC-MAP | (CD-AB-1) | `key-session.test.ts` | W4 | cada prefijo RAISE (incl. `INSUFFICIENT_BUDGET`/`DAILY_LIMIT`/`KEY_INACTIVE`/`KEY_NOT_FOUND`) → error class correcta; inesperado → `SESSION_DEBIT_FAILED` sin msg crudo |

## 12. Waves de implementación

### Wave 0 (Serial Gate — contratos: tipos + migración + errores + env)
- W0.1: `src/types/a2a-key.ts` — agregar `KeySessionRow`, `CreateKeySessionInput`, `KeySessionResponse`, `KeySessionListItem`, `KeySessionStatus`, `KeySessionDebitContext`, union `SESSION_*`. Exemplar: tipos `Delegation*` (L190–231).
- W0.2: `src/services/security/errors.ts` — `SessionTokenInvalidError`, `SessionExpiredError`, `SessionBudgetExhaustedError`, `SessionNotAllowedError`; `OwnershipOp` += `'keySessionRevoke' | 'keySessionList'`. Exemplar: `Delegation*Error` (L144–222).
- W0.3: `supabase/migrations/<ts>_a2a_key_sessions.sql` + `_down.sql` — tabla + índices + RPC `debit_session_and_parent` + hardening (§4.2/§4.3). Exemplar: `20260601000000_a2a_delegations.sql`.
- W0.4: `.env.example` — `SESSION_MAX_TTL_SECONDS=86400`.
- Verificación: `tsc` (tipos/errores) + revisión SQL contra exemplar.

### Wave 1 (Service — depende de W0)
- W1.1: `src/services/key-session.ts` — `create` (validación scope ⊆ padre + TTL + token + hash + INSERT), `lookupByTokenHash`, `getParentKey`, `list`, `debitSessionAndParent` (mapeo §4.3). Ownership guard en `list` (`.eq('owner_ref', ownerId)`). Exemplar: `delegation.ts`.
- Verificación: `tsc` + `key-session.test.ts` (parcial).

### Wave 2 (Middleware + budget — depende de W1)
- W2.1: `src/middleware/a2a-key.ts` — branch nuevo `wasi_a2a_sess_*` insertado entre L432 y L434 (DT-2 orden); augment `effectiveRow` con intersección (DT-4); `request.keySessionContext`. `declare module 'fastify'` += `keySessionContext?` + `keySessionRow?`. Exemplar: branch WKH-101 (L234–432).
- W2.2: `src/services/budget.ts` — `debit` acepta `keySessionContext?` y rutea al RPC nuevo para steps 2..N (espejo de la ruta delegación L62–124). NO romper la firma master (4º/5º arg opcional — cuidado con `toHaveBeenCalledWith` exactos, lección WKH-101 auto-blindaje#W4).
- Verificación: `tsc` + `a2a-key.test.ts` (branch nuevo) + `budget.test.ts`.

### Wave 3 (Rutas — depende de W1)
- W3.1: `src/routes/auth.ts` — `POST /key-session` (sub-delegation gate AC-12 ANTES de resolveCallerKey; validación input; `keySessionService.create`; 201) y `GET /key-session` (list; 200). Path interno SIN `/auth` (CD-AB-2). Exemplar: `POST/GET /delegation` (L897–1033).
- Verificación: `tsc` + `auth.keySession.test.ts`.

### Wave 4 (Tests + cierre)
- W4.1: completar `key-session.test.ts`, `a2a-key.test.ts` (branch), `auth.keySession.test.ts`, e2e gated `key-session-atomicity.real.test.ts`.
- W4.2: `npm run format` ANTES de `npm run lint` (lección WKH-101 auto-blindaje#W5); `tsc` strict; suite verde.
- Verificación: full QA (drift detection + evidencia por AC).

## 13. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir
- **CD-1 (back-compat):** path master (a2a-key.ts L434–559) y branch WKH-101 (L234–432) NO se modifican; el branch nuevo se inserta ENTRE ambos. Orden de detección: `session_` → `sess_` → master (DT-2).
- **CD-2 (ownership guard):** toda query/mutación sobre `a2a_key_sessions` o `a2a_agent_keys` filtra por `owner_ref`. Toda fn del service que recibe `sessionId` recibe `ownerId: string` (NO `string | undefined`). `lookupByTokenHash` es la única sin owner gate (el caller se autentica CON el token — NO es IDOR, igual que `delegationService.lookupByTokenHash` L255–275). Violación → BLOQUEANTE en AR.
- **CD-3 (token plano):** el token solo se expone en la 201; la DB guarda solo `SHA-256(token)`; nunca se loga.
- **CD-4 (scope ⊆ padre):** validado en la capa de aplicación ANTES del INSERT (creación). El RPC NO revalida scope (DT-3).
- **CD-5 (TTL):** `ttl_seconds` requerido; `expires_at` calculado server-side; rango `(0, SESSION_MAX_TTL_SECONDS]`.
- **CD-6 (TS strict):** sin `any`, `as unknown`, `@ts-ignore`. Todos los tipos en `src/types/a2a-key.ts`.
- **CD-7 (RPC hardening):** `SET search_path = public, pg_temp` + `REVOKE … FROM PUBLIC, anon, authenticated` + `GRANT … TO service_role` (§4.3).
- **CD-AB-1..5:** ver §5.6 (mapeo RPC completo; path sin `/auth`; validar amounts/ttl; `logOwnershipMismatch` forma objeto; tests env/mocks).
- Imports: solo módulos que EXISTEN (`viem` NO se usa en este flow — server-side puro, sin firma).

### PROHIBIDO
- NO modificar `a2a_delegations`, `debit_delegation_and_parent`, ni el branch L234–432 (WKH-101).
- NO usar EIP-712 / `recoverTypedDataAddress` / wallets EVM (este flow es server-side puro).
- NO almacenar el token plano; NO logear tokens.
- NO usar `ethers.js`; NO agregar dependencias nuevas.
- NO crear un índice redundante sobre `session_token_hash` (ya es UNIQUE).
- NO propagar `error.message` crudo de Postgres al body del cliente.
- NO usar el overload posicional de `logOwnershipMismatch` con un literal nuevo.
- NO hacer scope check dentro del RPC de débito (ya garantizado en creación, CD-4).
- NO modificar archivos fuera de §4.1.

---

## Readiness Check

```
[x] Cada AC (15) tiene ≥1 test asociado en §11
[x] Cada archivo en §4.1 tiene un Exemplar verificado con Glob/Read (line ranges reales)
[x] No hay [NEEDS CLARIFICATION] pendientes (DT-4 y DELETE resueltos; resta 1 [TBD] no bloqueante)
[x] Constraint Directives incluyen >3 PROHIBIDO (9 items)
[x] Context Map tiene >2 archivos leídos (14 archivos)
[x] Scope IN y OUT explícitos (§6)
[x] BD: tablas verificadas — a2a_agent_keys (existe), increment_a2a_key_spend (existe), a2a_key_sessions (se crea en W0)
[x] Happy Path completo (§4.4: creación + auth + listado)
[x] Flujo de error definido (§4.5: 9 casos con HTTP + error_code)
```

Verificaciones de anti-alucinación clave (todas confirmadas contra el código real):
- Mount de `authRoutes` con `prefix: '/auth'` → path interno `/key-session` (index.ts:121).
- `increment_a2a_key_spend(uuid,int,numeric)` existe y emite `INSUFFICIENT_BUDGET`/`DAILY_LIMIT`/`KEY_INACTIVE`/`KEY_NOT_FOUND` (20260406000000 L56–121).
- Prefijos `wasi_a2a_session_` vs `wasi_a2a_sess_` mutuamente exclusivos (verificado en runtime).
- `logOwnershipMismatch` forma objeto acepta `OwnershipOp` ampliable (errors.ts L305–310).
- `resolveTargetChain` reutilizable (a2a-key.ts L140–179).

---

*SDD generado por NexusAgil — FULL — WKH-121*
