# Story File — #110: [WKH-121] Session Keys sin EIP-712 (derivación server-side)

> SDD: doc/sdd/110-wkh-121-key-sessions/sdd.md
> Fecha: 2026-06-19
> Branch: feat/110-wkh-121-key-sessions

> ⚠️ Este documento es AUTOCONTENIDO. NO leas el SDD ni el work-item.
> Todo lo que necesitás para implementar está acá. Si algo falta → PARÁ y escalá a Architect (ver Escalation Rule al final). NO inventes.

---

## Goal

Construir **session keys efímeras derivadas server-side** desde una agent key (master) existente, **SIN** wallet EVM ni firma EIP-712. Un caller autenticado con su master key (`wasi_a2a_<…>`) hace `POST /auth/key-session` y recibe un token opaco `wasi_a2a_sess_<random>` (devuelto UNA sola vez) con scope acotado (`⊆ scope(master)`), TTL y budget de sesión propios. Si el token se filtra, el blast radius queda limitado.

**Por qué:** acota el blast radius de la Agent Key. Hoy, una key filtrada da acceso total hasta su `deactivate`.

**Coexistencia crítica (NO romper):** WKH-101 (DONE, en prod) ya implementó session keys **con** EIP-712 (prefijo `wasi_a2a_session_`, tabla `a2a_delegations`, RPC `debit_delegation_and_parent`, branch de middleware en `a2a-key.ts` L234–432). **WKH-121 NO duplica ni toca WKH-101.** Introduce una variante server-side pura que coexiste mediante un **prefijo de token distinto** (`wasi_a2a_sess_`, mutuamente exclusivo con `wasi_a2a_session_`), una **tabla nueva** (`a2a_key_sessions`), un **RPC nuevo** (`debit_session_and_parent`) y un **branch de middleware adicional** insertado ENTRE el branch WKH-101 y el path master.

---

## Acceptance Criteria (EARS)

> Estos son los 15 ACs que QA verificará en F4. NO se reescriben.

### Creación de sesión
- **AC-1 (creación):** WHEN un caller autenticado con una master key activa ejecuta `POST /auth/key-session` con `{ ttl_seconds, max_budget_usd, allowed_registries?, allowed_agent_slugs?, allowed_categories? }`, THE system SHALL crear una entrada de sesión en la DB, retornar `{ session_id, session_token, expires_at, scope }` con HTTP 201, y exponer el `session_token` UNA SOLA VEZ en esta respuesta (nunca se almacena en texto plano).
- **AC-2 (scope acotado):** WHEN se crea una session key, THE system SHALL rechazar la creación (HTTP 400) si cualquier scope declarado excede el de la key padre: `max_budget_usd` > balance disponible del padre, `allowed_registries` contiene registries no presentes en `allowed_registries` del padre (cuando el padre tiene lista no nula), o `allowed_agent_slugs` con slugs no en la lista del padre (cuando no es null). La sesión SHALL tener `scope ⊆ scope(key_padre)`.
- **AC-3 (TTL obligatorio):** WHEN se crea una session key, THE system SHALL rechazar (HTTP 400) si `ttl_seconds <= 0` o `ttl_seconds` supera `SESSION_MAX_TTL_SECONDS` (default 86400 = 24h).

### Autenticación con sesión
- **AC-4 (validación en middleware):** WHEN un request llega con un session token `wasi_a2a_sess_*`, THE system SHALL: (1) lookup por hash SHA-256 en O(1), (2) verificar que no está expirada ni revocada, (3) cargar parent key y verificar `is_active = true`, (4) inyectar `request.a2aKeyRow` con el scoping efectivo de la sesión (no el de la parent completa), (5) debitar del budget de sesión y del parent atómicamente.
- **AC-5 (token inválido):** IF el session token no existe en la DB, THEN THE system SHALL rechazar con HTTP 401 y `error_code: SESSION_TOKEN_INVALID`.
- **AC-6 (sesión expirada):** IF `now() >= session.expires_at`, THEN THE system SHALL rechazar con HTTP 403 y `error_code: SESSION_EXPIRED`.
- **AC-7 (parent key inactiva):** IF `parent_key.is_active = false`, THEN THE system SHALL rechazar con HTTP 403 y `error_code: KEY_INACTIVE`.

### Budget y débito
- **AC-8 (débito atómico):** WHEN un request autenticado con session key se acepta, THE system SHALL debitar el monto del budget de la sesión Y del parent atómicamente (misma transacción DB), sin que un request concurrente pueda exceder el `max_budget_usd` de la sesión ni el budget global del parent.
- **AC-9 (budget de sesión agotado):** IF `session.spent + amount > session.max_budget_usd`, THEN THE system SHALL rechazar con HTTP 403 y `error_code: SESSION_BUDGET_EXHAUSTED`.

### Scope efectivo
- **AC-10 (scope de sesión en request):** WHILE una sesión está activa, THE system SHALL aplicar el scoping efectivo de la sesión (no el del parent) para los checks de `allowed_registries`, `allowed_agent_slugs`, `allowed_categories`.

### Ownership y seguridad
- **AC-11 (ownership guard):** WHILE el servicio opera sobre tablas de sesiones o `a2a_agent_keys`, THE system SHALL incluir `.eq('owner_ref', ownerId)` en toda query/mutación. Toda función del service que reciba un `sessionId` SHALL recibir también `ownerId: string` (no `string | undefined`). Violación → BLOQUEANTE en AR.
- **AC-12 (no sub-delegación):** IF un request porta un session token `wasi_a2a_sess_*` e intenta crear otra sesión en `POST /auth/key-session`, THEN THE system SHALL rechazar con HTTP 403 y `error_code: SESSION_NOT_ALLOWED`.

### Listado
- **AC-13 (listado):** WHEN el caller ejecuta `GET /auth/key-session`, THE system SHALL retornar la lista de sesiones activas, expiradas y revocadas del owner, con: `session_id, expires_at, max_budget_usd, spent, status (active|expired|revoked), scope`.

### Back-compat / coexistencia
- **AC-14 (back-compat bearer):** WHILE WKH-121 está deployado, THE system SHALL continuar aceptando master keys (bearer `wasi_a2a_*` sin prefijo `sess`) sin cambio de comportamiento. El path master de `requirePaymentOrA2AKey` SHALL permanecer intacto.
- **AC-15 (coexistencia WKH-101):** WHILE corren WKH-121 y WKH-101, THE system SHALL distinguir `wasi_a2a_session_*` (EIP-712, WKH-101) de `wasi_a2a_sess_*` (server-side, WKH-121) y enrutar cada uno a su branch.

---

## Files to Modify/Create

> Lista EXHAUSTIVA. NO tocar ningún archivo fuera de esta tabla.

| # | Archivo | Acción | Qué hacer | Exemplar | Wave |
|---|---------|--------|-----------|----------|------|
| 1 | `src/types/a2a-key.ts` | Modificar | Agregar `KeySessionRow`, `CreateKeySessionInput`, `KeySessionResponse`, `KeySessionListItem`, `KeySessionStatus`, `KeySessionDebitContext` y la union de error-codes `SESSION_*` | tipos `Delegation*` (L190–231) | W0 |
| 2 | `src/services/security/errors.ts` | Modificar | Agregar `SessionTokenInvalidError`, `SessionExpiredError`, `SessionBudgetExhaustedError`, `SessionNotAllowedError`; agregar `'keySessionRevoke' \| 'keySessionList'` al union `OwnershipOp` (forma objeto) | clases `Delegation*Error` (L144–222) | W0 |
| 3 | `supabase/migrations/20260603000000_a2a_key_sessions.sql` | Crear | Tabla `a2a_key_sessions` + índices + RPC `debit_session_and_parent` + hardening (SQL completo abajo) | `20260601000000_a2a_delegations.sql` (1–113) | W0 |
| 4 | `supabase/migrations/20260603000000_a2a_key_sessions_down.sql` | Crear | DROP del RPC + DROP de la tabla (down migration) | `20260601000000_a2a_delegations_down.sql` | W0 |
| 5 | `.env.example` | Modificar | Agregar `SESSION_MAX_TTL_SECONDS=86400` con comentario, junto al bloque `DELEGATION_*` | bloque `DELEGATION_*` | W0 |
| 6 | `src/services/key-session.ts` | Crear | Service: `create`, `lookupByTokenHash`, `getParentKey`, `list`, `debitSessionAndParent` | `src/services/delegation.ts` (1–468) | W1 |
| 7 | `src/middleware/a2a-key.ts` | Modificar | Branch nuevo `wasi_a2a_sess_*` insertado DESPUÉS del branch WKH-101 (cierre ~L432) y ANTES del master (`let keyRow` ~L434); augment de `request.a2aKeyRow` con scope efectivo; setear `request.keySessionContext`; ampliar `declare module 'fastify'` | branch WKH-101 (L234–432) | W2 |
| 8 | `src/services/budget.ts` | Modificar | `debit` acepta `keySessionContext?` y rutea al RPC nuevo para los steps de débito (espejo de la ruta delegación) | ruta delegación de `debit` (L62–124) | W2 |
| 9 | `src/routes/auth.ts` | Modificar | `POST /key-session` (201) + `GET /key-session` (200); sub-delegation gate (AC-12) ANTES de `resolveCallerKey`. Path interno SIN `/auth` | `POST/GET /delegation` (L897–1033) | W3 |
| 10 | `src/services/key-session.test.ts` | Crear | Unit del service (create/lookup/list/debit + ownership + mapeo de errores) | `src/services/delegation.test.ts` | W4 |
| 11 | `src/middleware/a2a-key.test.ts` | Modificar | Tests del branch nuevo (AC-4/5/6/7/10/14/15) | suite existente | W4 |
| 12 | `src/routes/auth.keySession.test.ts` | Crear | Tests de endpoints (AC-1/2/3/12/13) | `src/routes/auth.delegation.test.ts` | W4 |
| 13 | `src/__tests__/e2e/key-session-atomicity.real.test.ts` | Crear (gated) | Atomicidad del RPC real (AC-8), gateado por `INTEGRATION_TEST_DB_URL` | `delegation-atomicity.real.test.ts` | W4 |
| 14 | `src/types/index.ts` | Modificar | Agregar `keySessionContext?: KeySessionDebitContext` a `interface ComposeRequest` (después de `delegationContext` L272) y a `interface OrchestrateRequest` (después de `delegationContext` L386). Importar `KeySessionDebitContext` de `./a2a-key.js` junto a `DelegationDebitContext`. ESPEJO EXACTO de `delegationContext`. | `delegationContext` en `ComposeRequest` (`src/types/index.ts:266-272`) + `OrchestrateRequest` (`:385-386`) | W5-FIX |
| 15 | `src/services/compose.ts` | Modificar | En la llamada `budgetService.debit(...)` per-step (L159-164) pasar `request.keySessionContext` como **6º arg** (después de `request.delegationContext`, que queda L163 intacto). ESPEJO de la línea `delegationContext`. | `request.delegationContext` 5º arg en `budgetService.debit` (`src/services/compose.ts:159-164`) | W5-FIX |
| 16 | `src/services/orchestrate.ts` | Modificar | En el objeto pasado a `composeService.compose({...})` (L405-421) agregar `keySessionContext: request.keySessionContext,` (justo después de `delegationContext: request.delegationContext,` L411, que queda intacto). ESPEJO de `delegationContext`. | `delegationContext: request.delegationContext` (`src/services/orchestrate.ts:410-411`) | W5-FIX |
| 17 | `src/routes/compose.ts` | Modificar | En el objeto pasado a `composeService.compose({...})` agregar `keySessionContext: request.keySessionContext,` (después de `delegationContext: request.delegationContext,` L160, intacto). `request.keySessionContext` YA está poblado por el middleware (a2a-key.ts:606). ESPEJO de `delegationContext`. | `delegationContext: request.delegationContext` (`src/routes/compose.ts:159-160`) | W5-FIX |
| 18 | `src/routes/orchestrate.ts` | Modificar | En el objeto pasado a `orchestrateService.orchestrate({...})` agregar `keySessionContext: request.keySessionContext,` (después de `delegationContext: request.delegationContext,` L80, intacto). ESPEJO de `delegationContext`. | `delegationContext: request.delegationContext` (`src/routes/orchestrate.ts:79-80`) | W5-FIX |
| 19 | `src/services/compose.test.ts` (o el archivo de test de compose existente) | Crear/Modificar | Test multi-step bajo `keySessionContext` que reproduce BLQ-ALTO-1 y verifica el fix (MNR-1). Ver Test Expectations T-SESS-MULTISTEP. Si no existe un test de compose, crearlo; si existe, agregar el caso. | `src/services/delegation.test.ts` / patrón de tests de `compose` con `budgetService.debit` mockeado | W5-FIX |

> Nota archivo #3: el timestamp `20260603000000` es posterior a la última migración del repo (`20260602000000_reputation_index.sql`). Si al implementar existe una migración con timestamp mayor o igual, usá un timestamp inmediatamente posterior a la última existente y mantené el sufijo `_a2a_key_sessions` / `_a2a_key_sessions_down`. Si dudás del timestamp correcto → escalá.

> **AMPLIACIÓN FIX-PACK (post-AR/CR, 2026-06-19):** las filas #14-#19 cierran el **BLQ-ALTO-1** del AR (el cap de la sesión NO se aplicaba en steps 1..N de compose/orchestrate porque `keySessionContext` nunca se propagaba). El fix ESPEJA el cableado existente de `delegationContext` (WKH-101) por la cadena `routes → ComposeRequest/OrchestrateRequest → orchestrate.ts → compose.ts → budgetService.debit`. Los extremos de la cadena YA están: `budget.debit` acepta el 6º arg `keySessionContext?` (`budget.ts:75`) y el middleware ya setea `request.keySessionContext` (`a2a-key.ts:606`). Solo faltan los eslabones intermedios. Ver **Wave 5-FIX**. NO se rediseña nada de W0-W4 ni se tocan DT-1..DT-5; el branch WKH-101 (`delegationContext`) NO se modifica, solo se replica el patrón.

---

## Contrato de Integración ⚠️ BLOQUEANTE

> Esta HU comunica: cliente HTTP ↔ endpoints REST, y middleware ↔ service ↔ RPC Postgres.

### Cliente → `POST /auth/key-session` (crear sesión)

**Request (autenticado con master key `wasi_a2a_*` vía bearer/header de auth, igual que `/delegation`):**
```json
{
  "ttl_seconds": "int > 0 y <= SESSION_MAX_TTL_SECONDS — requerido",
  "max_budget_usd": "decimal (string o number) > 0 — requerido",
  "allowed_registries": "string[] — opcional (ausente = hereda restricción del padre)",
  "allowed_agent_slugs": "string[] — opcional (ausente = hereda restricción del padre)",
  "allowed_categories": "string[] — opcional (ausente = hereda restricción del padre)"
}
```

**Response exitoso (201):**
```json
{
  "session_id": "uuid",
  "session_token": "wasi_a2a_sess_<hex> — token plano, SOLO en esta respuesta, nunca más",
  "expires_at": "ISO timestamp (now + ttl_seconds, server-side)",
  "scope": {
    "max_budget_usd": "decimal",
    "allowed_registries": "string[] | null",
    "allowed_agent_slugs": "string[] | null",
    "allowed_categories": "string[] | null"
  }
}
```

**Errores:**
| HTTP | error_code | Cuándo |
|---|---|---|
| 400 | `INVALID_INPUT` | `ttl_seconds <= 0` o `> SESSION_MAX_TTL_SECONDS`; `max_budget_usd <= 0` o formato inválido (AC-3) |
| 400 | `SCOPE_EXCEEDS_PARENT` | scope de sesión ⊄ scope del padre, o `max_budget_usd` > balance del padre (AC-2) |
| 403 | `SESSION_NOT_ALLOWED` | el caller se autenticó con un token `wasi_a2a_sess_*` (sub-delegación, AC-12) |
| 401 | (auth estándar) | master key inválida (mismo manejo que `/delegation`) |

### Cliente → `GET /auth/key-session` (listar sesiones)

**Response (200):**
```json
[
  {
    "session_id": "uuid",
    "expires_at": "ISO timestamp",
    "max_budget_usd": "decimal",
    "spent": "decimal (spent_usd)",
    "status": "active | expired | revoked",
    "scope": {
      "allowed_registries": "string[] | null",
      "allowed_agent_slugs": "string[] | null",
      "allowed_categories": "string[] | null"
    }
  }
]
```

### Cliente → cualquier endpoint protegido con `wasi_a2a_sess_*` (autenticación con sesión)

> El middleware `requirePaymentOrA2AKey` detecta el prefijo, valida, debita y deja seguir.

**Errores del branch (cuerpo con `error_code`, sin `error.message` crudo de PG):**
| HTTP | error_code | Cuándo |
|---|---|---|
| 401 | `SESSION_TOKEN_INVALID` | hash del token no existe en la DB (AC-5) |
| 403 | `SESSION_EXPIRED` | `now() >= expires_at` (AC-6) |
| 403 | `KEY_INACTIVE` | parent key `is_active = false` (AC-7) |
| 403 | `SESSION_BUDGET_EXHAUSTED` | `spent + amount > max_budget_usd` (AC-9) |
| 403 | `OWNERSHIP_MISMATCH` | mismatch detectado en RPC/list (AC-11) |
| 503 | `SERVICE_ERROR` | error inesperado del service (SIN msg crudo de PG) |

---

## Modelo de datos — SQL COMPLETO de la migración (archivo #3)

> Copiá este SQL TEXTUAL. NO improvises SQL. Tabla + índices + RPC + hardening.

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
  revoked_at          TIMESTAMPTZ,                   -- NULL = activa (WKH-122)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- UNIQUE(session_token_hash) ya provee el índice btree O(1) del hot-path (AC-4);
-- NO crear un índice explícito redundante sobre esa columna (lección WKH-101).
CREATE INDEX IF NOT EXISTS idx_a2a_key_sessions_key_owner
  ON a2a_key_sessions (key_id, owner_ref);
CREATE INDEX IF NOT EXISTS idx_a2a_key_sessions_owner
  ON a2a_key_sessions (owner_ref);

-- ============================================================
-- RPC atómico: debit_session_and_parent
-- ============================================================
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

-- Hardening obligatorio (CD-7).
ALTER FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric)
  SET search_path = public, pg_temp;
REVOKE EXECUTE ON FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_session_and_parent(uuid, text, uuid, integer, numeric)
  TO service_role;
```

### SQL COMPLETO de la down migration (archivo #4)

```sql
-- ============================================================
-- Down migration: 20260603000000_a2a_key_sessions
-- WKH-121: revierte tabla a2a_key_sessions + RPC debit_session_and_parent.
-- ============================================================

BEGIN;
DROP FUNCTION IF EXISTS debit_session_and_parent(uuid, text, uuid, integer, numeric);
DROP TABLE IF EXISTS a2a_key_sessions;
COMMIT;
```

---

## Mapeo de prefijos RAISE → error class → HTTP

> En `keySessionService.debitSessionAndParent` enumerá TODOS los prefijos de la cadena, incluido el `PERFORM increment_a2a_key_spend`. **NUNCA** propagar `error.message` crudo de PG al body.

| Prefijo RAISE (en `error.message` de PG) | Origen | Error class (TS) | HTTP final |
|---|---|---|---|
| `SESSION_BUDGET_EXHAUSTED` | RPC propio | `SessionBudgetExhaustedError` | 403 |
| `SESSION_REVOKED` | RPC propio | `SessionTokenInvalidError` (o dedicado) | 403 |
| `SESSION_EXPIRED` | RPC propio | `SessionExpiredError` | 403 |
| `SESSION_NOT_FOUND` | RPC propio | `SessionTokenInvalidError` | 401/403 |
| `OWNERSHIP_MISMATCH` | RPC propio | `OwnershipMismatchError` | 403 |
| `INSUFFICIENT_BUDGET` | `increment_a2a_key_spend` | `AgentKeyBudgetExhaustedError` (reuso) | 403 |
| `DAILY_LIMIT` | `increment_a2a_key_spend` | `DailyLimitExceededError` (reuso) | 403 |
| `KEY_INACTIVE` | `increment_a2a_key_spend` | `AgentKeyInactiveError` (reuso) | 403 |
| `KEY_NOT_FOUND` | `increment_a2a_key_spend` | `AgentKeyNotFoundError` (reuso) | 403 |
| (cualquier otro) | — | `Error('SESSION_DEBIT_FAILED')` SIN msg crudo | 503 |

> En el branch de middleware, el pre-debit check de `revoked_at`/`expires_at` ya devuelve 403 antes del RPC; el RAISE bajo lock cubre la carrera TOCTOU. Las clases de error reusadas (`AgentKeyBudgetExhaustedError`, `DailyLimitExceededError`, `AgentKeyInactiveError`, `AgentKeyNotFoundError`, `OwnershipMismatchError`) YA existen en `src/services/security/errors.ts` — confirmá su nombre exacto al leer el exemplar antes de importarlas; si alguna no existe con ese nombre, escalá.

---

## Regla de scope efectivo (DT-4) — TEXTUAL

> Intersección inyectada en `request.a2aKeyRow.allowed_*` para que `composeService`/`orchestrateService` apliquen los checks existentes sin modificación (igual que el branch WKH-101 con `effectiveRow`, a2a-key.ts L392–404).

Regla por dimensión (`allowed_registries`, `allowed_agent_slugs`, `allowed_categories`):

- sesión `null` (no declara) + padre `null` (sin restricción) → efectivo `null` (sin restricción).
- sesión `null` + padre `[A,B]` → efectivo `[A,B]` (**hereda la restricción del padre**, NO la elimina).
- sesión `[A]` + padre `null` → efectivo `[A]` (la sesión puede restringir aunque el padre no).
- sesión `[A]` + padre `[A,B]` → efectivo `[A]` (subset; válido).
- sesión `[A,C]` + padre `[A,B]` → **RECHAZO en creación** (`C ∉ padre`, AC-2/CD-4).

Implementación: `effective = (sesión === null) ? padre : sesión`, **tras** validar `sesión ⊆ padre` en creación.

**Budget del parent en la validación de creación (AC-2):** `max_budget_usd <=` balance disponible del padre. El `budget` del padre es por-chain (`{"2368":"10.00"}`). La validación de creación compara `max_budget_usd` contra el balance del **chain por defecto** (`getDefaultChainKey`) o, si el padre tiene un único chain con fondos, ese. La garantía dura del cap por-chain la da el RPC en tiempo de débito (`increment_a2a_key_spend`). La validación de creación es un **early-fail guard**, no la línea de defensa final. (Este es el único [TBD] de implementación no bloqueante: si dudás de la fn exacta para el balance, leé cómo `delegation.ts` resuelve el balance del padre en `create` y replicá.)

---

## Exemplars

> Fragmentos reales del codebase. Seguilos como patrón. Todos los paths y line ranges verificados.

### Exemplar 1: Service completo a espejar
**Archivo**: `src/services/delegation.ts` (1–468)
**Usar para**: archivo #6 (`src/services/key-session.ts`)
**Patrón clave**:
- `create`: genera token opaco (`<prefijo>_<crypto.randomBytes>.hex`), persiste SOLO `SHA-256(token)`, `owner_ref` + `key_id` desde la `parentKey` (NUNCA del body), devuelve `session_token` plano SOLO en el objeto de retorno (ver L247–252: `session_token: token, // plano, SOLO acá`).
- `lookupByTokenHash(hash)` (L262–275): **SIN** `.eq('owner_ref', ...)` a propósito — el caller se autentica CON el token (NO es IDOR). `PGRST116 → null`. Esta es la ÚNICA fn del service sin owner gate.
- `getParentKey(keyId)` (L284–297): lectura interna server-side, sin owner gate (key_id sale del row de la sesión, no del body). `PGRST116 → null`.
- `list(ownerRef)` (L300–342): **CON** `.eq('owner_ref', ownerRef)` (Ownership Guard). Deriva `status` (`revoked` si `revoked_at !== null`, sino `expired` si `now >= expires_at`, sino `active`).
- error mapping por prefijo de `error.message`: `if (error.message.includes('SESSION_BUDGET_EXHAUSTED')) throw new SessionBudgetExhaustedError()` … fallback `throw new Error('SESSION_DEBIT_FAILED')` SIN msg crudo.
- Constante de prefijo: definí `const KEY_SESSION_TOKEN_PREFIX = 'wasi_a2a_sess_'` (espejo de `SESSION_TOKEN_PREFIX` en `delegation.ts` L45).

### Exemplar 2: Migración tabla + RPC + hardening
**Archivo**: `supabase/migrations/20260601000000_a2a_delegations.sql` (1–113)
**Usar para**: archivo #3 (`..._a2a_key_sessions.sql`)
**Patrón clave**: tabla con `owner_ref` desnormalizado + `session_token_hash TEXT UNIQUE` + `revoked_at` nullable; RPC `FOR UPDATE` → ownership re-check → TOCTOU re-check (revoked/expiry) → check budget → `PERFORM increment_a2a_key_spend` → UPDATE; bloque hardening (`SET search_path` / `REVOKE` / `GRANT`) al final (L104–111). Down migration: ver `20260601000000_a2a_delegations_down.sql` (DROP FUNCTION; DROP TABLE; dentro de `BEGIN`/`COMMIT`).

### Exemplar 3: Branch de middleware
**Archivo**: `src/middleware/a2a-key.ts`, branch WKH-101 (L234–432) del mismo archivo
**Usar para**: archivo #7 (branch nuevo)
**Patrón clave**:
- Extracción de `rawKey` (L193–213): el regex YA captura `wasi_a2a_*` (incluye ambos prefijos de sesión). NO se modifica.
- Estructura del branch: `lookupByTokenHash` → checks pre-debit (revoked/expiry/parent activo) → `getParentKey` → `resolveTargetChain(req, reply)` → debit atómico → construir `effectiveRow` con scope intersectado → setear `request.a2aKeyRow` (L392–404) → header `x-a2a-remaining-budget` → `return` (NO sigue al master).
- **Orden de inserción EXACTO:** el branch nuevo va DESPUÉS del `}` que cierra el branch WKH-101 (~L432) y ANTES del `let keyRow` del master (~L434). NO se edita ninguna línea de L234–432 ni de L434–559: solo se INSERTA entre ambos.
- `resolveTargetChain` (a2a-key.ts L140–179): reusalo para resolver `chainId` (igual que el branch WKH-101 y el master).

### Exemplar 4: Endpoints REST
**Archivo**: `src/routes/auth.ts`, `POST /delegation` (L897–981) + `GET /delegation` (L1022–1033)
**Usar para**: archivo #9 (endpoints nuevos)
**Patrón clave**:
- `resolveCallerKey(req)` (L104–133) + `rawKeyFromRequest(req)` (L140–153): autenticación de la master key.
- **Sub-delegation gate (AC-12):** chequear el prefijo del raw key ANTES de `resolveCallerKey` (igual que L903–906 para `/delegation`): si `rawKeyFromRequest(req)?.startsWith('wasi_a2a_sess_')` → 403 `SESSION_NOT_ALLOWED`.
- Path interno SIN `/auth`: `fastify.post('/key-session', …)` y `fastify.get('/key-session', …)` → URL pública `/auth/key-session` (porque `authRoutes` se monta con `prefix: '/auth'` en `index.ts:121`). Si ponés `/auth/key-session` en el handler, la URL real sería `/auth/auth/key-session` → MAL.
- Mapeo error→HTTP en el catch del handler.

### Exemplar 5: Tipos
**Archivo**: `src/types/a2a-key.ts`, tipos `DelegationRow` / `CreateDelegationInput` / `DelegationListItem` (L190–231); `A2AAgentKeyRow` (L34–68)
**Usar para**: archivo #1
**Patrón clave**: interfaces tipadas con comentarios de origen; `A2AAgentKeyRow` tiene `budget` (JSONB por-chain), `allowed_*: string[] | null`. Para `KeySessionRow`: `allowed_*: string[] | null` (en TS; en DB es JSONB — serializar array→JSONB al INSERT y castear de vuelta al leer). `KeySessionStatus = 'active' | 'expired' | 'revoked'`.

### Exemplar 6: Error classes + logOwnershipMismatch
**Archivo**: `src/services/security/errors.ts`, clases `Delegation*Error` (L144–222), `logOwnershipMismatch` (L300–348)
**Usar para**: archivo #2
**Patrón clave**: cada clase con `readonly code = '…' as const` + `name`. Para `logOwnershipMismatch`: usar la **forma objeto** `logOwnershipMismatch({ op, resourceId, callerOwnerRef })` (L305–310) y ampliar el union `OwnershipOp` (L283–289 aprox.) con `'keySessionRevoke' | 'keySessionList'`. **NUNCA** usar el overload posicional con un literal nuevo (solo acepta `'getBalance' | 'deactivate'`).

### Exemplar 7: RPC del parent (reuso, NO reimplementar)
**Archivo**: `supabase/migrations/20260406000000_a2a_agent_keys.sql`, `increment_a2a_key_spend(uuid,int,numeric)` (L56–121)
**Usar para**: lo invoca el RPC nuevo vía `PERFORM`. Emite RAISE `KEY_NOT_FOUND` / `KEY_INACTIVE` / `DAILY_LIMIT` / `INSUFFICIENT_BUDGET`. NO reimplementar el débito del budget JSONB del parent.

### Exemplar 8: Tests
**Archivos**: `src/services/delegation.test.ts` (mock `supabase {from, rpc}`, aserciones por error class) y `src/middleware/a2a-key.test.ts` (1–55: `vi.mock` de identity/budget/delegation; Fastify in-process; mocks de `lookupByTokenHash`/`getParentKey`/`debitDelegationAndParent`) y `src/routes/auth.delegation.test.ts` (Fastify in-process, 201/200/400/403).
**Usar para**: archivos #10/#11/#12/#13.

---

## Constraint Directives

### OBLIGATORIO
- **CD-1 (back-compat):** path master (a2a-key.ts L434–559) y branch WKH-101 (L234–432) NO se modifican; el branch nuevo se INSERTA entre ambos. Orden de detección: `wasi_a2a_session_` → `wasi_a2a_sess_` → master.
- **CD-2 (ownership guard):** toda query/mutación sobre `a2a_key_sessions` o `a2a_agent_keys` filtra por `owner_ref`. Toda fn del service que recibe `sessionId` recibe `ownerId: string` (NO `string | undefined`). `lookupByTokenHash` es la ÚNICA sin owner gate (el caller se autentica CON el token — NO es IDOR). Violación → BLOQUEANTE en AR.
- **CD-3 (token plano):** el token solo se expone en la 201; la DB guarda solo `SHA-256(token)`; nunca se loga.
- **CD-4 (scope ⊆ padre):** validado en la capa de aplicación ANTES del INSERT (creación). El RPC NO revalida scope.
- **CD-5 (TTL):** `ttl_seconds` requerido; `expires_at = now() + ttl_seconds` calculado server-side; rango `(0, SESSION_MAX_TTL_SECONDS]`. Leer env con `Number(process.env.SESSION_MAX_TTL_SECONDS ?? 86400)`; si NaN o `<= 0` usar default 86400 (fail-safe).
- **CD-6 (TS strict):** sin `any`, `as unknown`, `@ts-ignore`. Todos los tipos en `src/types/a2a-key.ts`.
- **CD-7 (RPC hardening):** `SET search_path = public, pg_temp` + `REVOKE … FROM PUBLIC, anon, authenticated` + `GRANT … TO service_role`.
- **CD-AB-1 (RPC error mapping completo):** enumerar TODOS los prefijos de la cadena (incl. los de `increment_a2a_key_spend`) antes de mapear; ver tabla arriba. NUNCA propagar `error.message` de PG al body.
- **CD-AB-2 (prefijo de ruta):** path interno SIN `/auth` (`fastify.post('/key-session', …)`).
- **CD-AB-3 (validación de amounts/ttl):** validar `max_budget_usd` (decimal `> 0`) y `ttl_seconds` (entero `> 0`) como formato + rango en el parser del body. No asumir que el shape implica validez semántica.
- **CD-AB-4 (`logOwnershipMismatch`):** forma objeto + ampliar `OwnershipOp` con `'keySessionRevoke' | 'keySessionList'`. NUNCA el overload posicional con literal nuevo.
- **CD-AB-5 (tests):** para tests que dependen de AUSENCIA de `SESSION_MAX_TTL_SECONDS` usar `delete process.env.SESSION_MAX_TTL_SECONDS` (NO `= undefined`). Setup que puede lanzar va en `beforeAll`. Resetear mocks (`mockReset`) en tests nuevos.

### PROHIBIDO
- NO modificar `a2a_delegations`, `debit_delegation_and_parent`, ni el branch L234–432 de `a2a-key.ts` (WKH-101).
- NO modificar el path master de `a2a-key.ts` (L434–559).
- NO usar EIP-712 / `recoverTypedDataAddress` / `viem` / `ethers` / wallets EVM (este flow es server-side puro, sin firma).
- NO almacenar el token plano; NO logear tokens.
- NO agregar dependencias nuevas (ninguna).
- NO crear un índice redundante sobre `session_token_hash` (ya es UNIQUE).
- NO propagar `error.message` crudo de Postgres al body del cliente.
- NO hacer scope check dentro del RPC de débito (ya garantizado en creación, CD-4).
- NO romper la firma master de `budget.ts#debit` (el arg `keySessionContext?` es opcional; cuidado con `toHaveBeenCalledWith` exactos en tests existentes).
- NO modificar archivos fuera de la tabla "Files to Modify/Create".
- NO "mejorar" código adyacente ni refactorizar lo existente.

---

## Anti-Hallucination Checklist (específico WKH-121)

Antes de escribir cada archivo, confirmá:

- [ ] NO toqué `a2a_delegations`, `debit_delegation_and_parent`, ni `a2a-key.ts` L234–432 (branch WKH-101). El branch nuevo se INSERTA entre L432 y L434.
- [ ] NO usé EIP-712 / viem / ethers / wallets EVM en ningún lugar (flow server-side puro).
- [ ] El orden de detección de prefijo es `wasi_a2a_session_` (WKH-101) → `wasi_a2a_sess_` (WKH-121) → master. Los prefijos son mutuamente exclusivos: `'wasi_a2a_session_x'.startsWith('wasi_a2a_sess_')` es `false`.
- [ ] Path interno de los endpoints SIN `/auth` (`fastify.post('/key-session', …)`), porque `authRoutes` se monta con `prefix: '/auth'` (`index.ts:121`).
- [ ] El token plano se devuelve SOLO en la 201; la DB guarda únicamente `SHA-256(token)`.
- [ ] Toda fn del service que recibe `sessionId` tiene firma con `ownerId: string` y filtra `.eq('owner_ref', ownerId)`. EXCEPCIÓN única: `lookupByTokenHash` (se autentica con el token — NO IDOR).
- [ ] NO creé índice redundante sobre `session_token_hash` (ya es UNIQUE).
- [ ] NO propago `error.message` crudo de PG: el fallback es `Error('SESSION_DEBIT_FAILED')` / `SERVICE_ERROR` 503.
- [ ] `logOwnershipMismatch` usado en forma OBJETO; `OwnershipOp` ampliado con `'keySessionRevoke' | 'keySessionList'`.
- [ ] RPC con hardening completo (`SET search_path` + `REVOKE` + `GRANT TO service_role`).
- [ ] TS strict: sin `any`, sin `as unknown`, sin `@ts-ignore`.
- [ ] Migración con timestamp posterior a `20260602000000` y sufijo `_a2a_key_sessions` (+ `_down`).

### Anti-Hallucination — Wave 5-FIX (BLQ-ALTO-1 + MNRs)
- [ ] El cap de la sesión se respeta en **multi-step** (compose/orchestrate), NO solo en el step 0: `request.keySessionContext` se propaga como 6º arg de `budgetService.debit` para cada step `i>0`.
- [ ] La cadena `delegationContext` de WKH-101 **sigue funcionando igual** — la replico, NO la modifico (líneas `delegationContext` quedan intactas en `types/index.ts:272/386`, `compose.ts:163`, `orchestrate.ts:411`, `routes/compose.ts:160`, `routes/orchestrate.ts:80`).
- [ ] El 6º arg de `budget.debit` (`keySessionContext?`) y el `request.keySessionContext` del middleware YA existen — NO los re-creo; solo conecto los eslabones intermedios.
- [ ] `keySessionContext` y `delegationContext` son **mutuamente exclusivos** en runtime (un request es de sesión O de delegación, nunca ambos); no rompo la precedencia de `budget.debit` (`if (keySessionContext)` antes de `if (delegationContext)`, budget.ts:79/125).
- [ ] MNR-3: `SessionNotAllowedError` queda CONSUMIDA en el route (auth.ts:1114-1115); el HTTP final sigue siendo 403 `SESSION_NOT_ALLOWED` y T-SUBDELEG no cambia.
- [ ] MNR-4: `KeySessionErrorCode` (a2a-key.ts:334-339) ELIMINADO; `tsc` verde confirma que no tenía consumidores.
- [ ] Suite completa verde sin regresión de WKH-101 (`delegationContext`) ni de los 89 tests de WKH-121.

---

## Test Expectations

> Framework del proyecto: **vitest**. ≥1 test por AC. Mock `../lib/supabase.js` con `{ from, rpc }`; Fastify in-process para tests de rutas/middleware.

| Test (id) | AC | Archivo | Qué verifica |
|---|---|---|---|
| T-CREATE-1 | AC-1 | `src/routes/auth.keySession.test.ts` | POST 201 con `{session_id, session_token, expires_at, scope}`; token plano SOLO en la respuesta; DB guarda solo hash |
| T-SCOPE-1 | AC-2 | `src/routes/auth.keySession.test.ts` | 400 `SCOPE_EXCEEDS_PARENT` si `allowed_registries` ⊄ padre |
| T-SCOPE-2 | AC-2 | `src/services/key-session.test.ts` | `max_budget_usd` > balance del padre → 400 |
| T-TTL-1 | AC-3 | `src/routes/auth.keySession.test.ts` | `ttl_seconds <= 0` → 400; `> SESSION_MAX_TTL_SECONDS` → 400; válido → 201 (usar `delete process.env` para default) |
| T-MW-LOOKUP | AC-4 | `src/middleware/a2a-key.test.ts` | branch `wasi_a2a_sess_*` hace lookup por hash, inyecta `a2aKeyRow` con scope efectivo, debita |
| T-MW-INVALID | AC-5 | `src/middleware/a2a-key.test.ts` | token inexistente → 401 `SESSION_TOKEN_INVALID` |
| T-MW-EXPIRED | AC-6 | `src/middleware/a2a-key.test.ts` | `now() >= expires_at` → 403 `SESSION_EXPIRED` |
| T-MW-KEYINACTIVE | AC-7 | `src/middleware/a2a-key.test.ts` | parent `is_active=false` → 403 `KEY_INACTIVE` |
| T-RPC-ATOMIC | AC-8 | `src/services/key-session.test.ts` + `src/__tests__/e2e/key-session-atomicity.real.test.ts` (gated) | débito atómico sesión + parent; concurrencia no excede budget (real DB gated por `INTEGRATION_TEST_DB_URL`) |
| T-BUDGET-EXH | AC-9 | `src/services/key-session.test.ts` | `spent + amount > max_budget_usd` → `SessionBudgetExhaustedError` → 403 |
| T-SCOPE-EFF | AC-10 | `src/middleware/a2a-key.test.ts` | `a2aKeyRow.allowed_*` = intersección (no el del padre completo); incluye caso sesión `null` + padre `[A,B]` → `[A,B]` |
| T-OWNERSHIP-1 | AC-11 | `src/services/key-session.test.ts` | `list`/`debit` filtran por `owner_ref`; firma exige `ownerId: string`; cross-owner → `OwnershipMismatchError` |
| T-SUBDELEG | AC-12 | `src/routes/auth.keySession.test.ts` | token `wasi_a2a_sess_*` en `POST /auth/key-session` → 403 `SESSION_NOT_ALLOWED` |
| T-LIST | AC-13 | `src/routes/auth.keySession.test.ts` | `GET /auth/key-session` 200 con `status` derivado (active/expired/revoked) y scope |
| T-BACKCOMPAT | AC-14 | `src/middleware/a2a-key.test.ts` | master key `wasi_a2a_*` sin prefijo → path master intacto |
| T-COEXIST | AC-15 | `src/middleware/a2a-key.test.ts` | `wasi_a2a_session_*` → branch WKH-101 (delegationService); `wasi_a2a_sess_*` → branch WKH-121 (keySessionService); no se cruzan |
| T-RPC-MAP | (CD-AB-1) | `src/services/key-session.test.ts` | cada prefijo RAISE (incl. `INSUFFICIENT_BUDGET`/`DAILY_LIMIT`/`KEY_INACTIVE`/`KEY_NOT_FOUND`) → error class correcta; inesperado → `SESSION_DEBIT_FAILED` sin msg crudo |
| **T-SESS-MULTISTEP** | **AC-8/AC-9 (BLQ-ALTO-1, MNR-1)** | `src/services/compose.test.ts` | **Multi-step bajo sesión: el cap se respeta en TODOS los steps, no solo el step 0.** Setup: `composeService.compose({ steps: [N≥2 steps], scopingKeyRow, chainId, keySessionContext: { sessionId, ownerRef, keyId } })` con `budgetService.debit` espiado/mockeado. Asserts: **(a)** `budgetService.debit` se invoca por cada step ≥1 (`i>0`) **con `keySessionContext` definido** como 6º arg (NO `undefined`) → `expect(debitSpy).toHaveBeenCalledWith(scopingKeyRow.id, chainId, expect.any(Number), <delegationContext o undefined>, keySessionContext)`. **(b)** Caso cap-exhausted a mitad de camino: el mock de `debit` devuelve `{ success: false, error: 'SESSION_BUDGET_EXHAUSTED' }` en el step k → `compose` corta ahí, devuelve `success:false` con el step k fallido, y NO sigue debitando steps > k. Esto reproduce el BLQ (antes del fix: el 6º arg llegaba `undefined` → ruta master → cap ignorado). **(c) Anti-regresión WKH-101:** un segundo caso con `delegationContext` definido y `keySessionContext` undefined → `debit` se invoca con el 5º arg `delegationContext` y el 6º `undefined` (la cadena WKH-101 sigue intacta). |

> **Sobre T-SESS-MULTISTEP:** es un test de UNIT del service (`composeService.compose`) con `budgetService.debit` mockeado — NO un e2e con DB real (la atomicidad del RPC ya la cubre T-RPC-ATOMIC gated). El objetivo es probar la **propagación del 6º arg** (`keySessionContext`) por la cadena, que es exactamente el eslabón que el BLQ dejó roto. Si en el repo `compose` se testea en otro archivo, agregar el caso ahí en vez de crear `compose.test.ts`. Mirror del patrón con el que (si existe) se testea la propagación de `delegationContext` per-step.

### Criterio Test-First
Lógica de negocio (service, RPC mapping, scope), APIs (endpoints) y middleware con condicionales → **Test-first SÍ**. Configuración (`.env.example`) → No.

---

## Waves

### Wave -1: Environment Gate (OBLIGATORIO — verificar antes de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a
npm install 2>/dev/null || echo "Sin package.json"
# Archivos base del Scope IN deben existir:
ls src/types/a2a-key.ts src/services/security/errors.ts src/services/delegation.ts \
   src/middleware/a2a-key.ts src/services/budget.ts src/routes/auth.ts \
   supabase/migrations/20260601000000_a2a_delegations.sql \
   supabase/migrations/20260406000000_a2a_agent_keys.sql 2>/dev/null || echo "FALTA archivo base"
# Última migración existente (el nuevo timestamp debe ser posterior):
ls supabase/migrations/ | sort | tail -3
```

**Si algo falla en Wave -1:** PARAR y reportar al orquestador. No implementar sobre un entorno roto.

### Wave 0 (Serial Gate — contratos: tipos + migración + errores + env)
- [ ] W0.1: `src/types/a2a-key.ts` — agregar `KeySessionRow`, `CreateKeySessionInput`, `KeySessionResponse`, `KeySessionListItem`, `KeySessionStatus`, `KeySessionDebitContext`, union `SESSION_*`. (Exemplar 5)
- [ ] W0.2: `src/services/security/errors.ts` — `SessionTokenInvalidError`, `SessionExpiredError`, `SessionBudgetExhaustedError`, `SessionNotAllowedError`; `OwnershipOp` += `'keySessionRevoke' | 'keySessionList'`. (Exemplar 6)
- [ ] W0.3: `supabase/migrations/20260603000000_a2a_key_sessions.sql` + `_down.sql` — tabla + índices + RPC + hardening (SQL completo arriba). (Exemplar 2)
- [ ] W0.4: `.env.example` — `SESSION_MAX_TTL_SECONDS=86400`.

### Wave 1 (Service — depende de W0)
- [ ] W1.1: `src/services/key-session.ts` — `create` (validación scope ⊆ padre + TTL + token + hash + INSERT), `lookupByTokenHash`, `getParentKey`, `list` (ownership guard), `debitSessionAndParent` (mapeo de errores por prefijo). (Exemplar 1)

### Wave 2 (Middleware + budget — depende de W1)
- [ ] W2.1: `src/middleware/a2a-key.ts` — branch nuevo `wasi_a2a_sess_*` insertado entre L432 y L434; `effectiveRow` con intersección (DT-4); `request.keySessionContext`; ampliar `declare module 'fastify'` con `keySessionContext?`/`keySessionRow?`. (Exemplar 3)
- [ ] W2.2: `src/services/budget.ts` — `debit` acepta `keySessionContext?` y rutea al RPC nuevo. NO romper la firma master.

### Wave 3 (Rutas — depende de W1)
- [ ] W3.1: `src/routes/auth.ts` — `POST /key-session` (sub-delegation gate AC-12 ANTES de `resolveCallerKey`; validación input; `keySessionService.create`; 201) + `GET /key-session` (list; 200). Path SIN `/auth`. (Exemplar 4)

### Wave 4 (Tests + cierre)
- [ ] W4.1: completar `key-session.test.ts`, `a2a-key.test.ts` (branch nuevo), `auth.keySession.test.ts`, e2e gated `key-session-atomicity.real.test.ts`.
- [ ] W4.2: `npm run format` ANTES de `npm run lint`; `tsc` strict; suite completa verde.

### Wave 5-FIX (Fix-pack BLQ-ALTO-1 + MNR-1/MNR-3/MNR-4 — depende de W2/W3 ya implementadas)

> **Contexto del bug (AR BLQ-ALTO-1):** el débito del **step 0** lo hace el middleware atómicamente vía `debit_session_and_parent` (correcto). Pero los **steps 1..N** de un `/compose` o `/orchestrate` se debitan en `compose.ts:159` con `keySessionContext = undefined` → caen a la **ruta master** de `budget.debit` (`budget.ts:182` → `increment_a2a_key_spend` directo sobre el parent) → debitan el budget del parent **SIN** chequear `max_budget_usd` de la sesión ni tocar `a2a_key_sessions.spent_usd`. Un token de sesión filtrado drena el parent vía multi-step → derrota la HU. Rompe AC-8/AC-9 para todo flujo de ≥2 steps.
>
> **El fix es ESPEJAR el cableado de `delegationContext` (WKH-101)**, que ya recorre exactamente esta cadena. Los EXTREMOS ya existen y NO se tocan: `budget.debit` ya acepta el 6º arg `keySessionContext?` (verificado `budget.ts:75`, rutea al RPC en `budget.ts:79-88`) y el middleware ya pobla `request.keySessionContext` (verificado `a2a-key.ts:606`). **Solo faltan los eslabones intermedios** que el Story File original omitió.

**Cadena exacta del exemplar `delegationContext` a espejar (line ranges verificados 2026-06-19):**

| Eslabón | Exemplar `delegationContext` (NO tocar) | Acción para `keySessionContext` |
|---|---|---|
| Tipo `ComposeRequest` | `src/types/index.ts:266-272` (`delegationContext?: DelegationDebitContext;`) | Agregar `keySessionContext?: KeySessionDebitContext;` justo después (L272+). Importar el tipo de `./a2a-key.js`. |
| Tipo `OrchestrateRequest` | `src/types/index.ts:385-386` (`delegationContext?: DelegationDebitContext;`) | Agregar `keySessionContext?: KeySessionDebitContext;` justo después (L386+). |
| Service compose → debit | `src/services/compose.ts:159-164` (`request.delegationContext` como **5º arg** de `budgetService.debit`) | Agregar `request.keySessionContext` como **6º arg** (línea nueva después de L163). |
| Service orchestrate → compose | `src/services/orchestrate.ts:410-411` (`delegationContext: request.delegationContext,`) | Agregar `keySessionContext: request.keySessionContext,` justo debajo (L411+). |
| Route compose → service | `src/routes/compose.ts:159-160` (`delegationContext: request.delegationContext,`) | Agregar `keySessionContext: request.keySessionContext,` justo debajo (L160+). |
| Route orchestrate → service | `src/routes/orchestrate.ts:79-80` (`delegationContext: request.delegationContext,`) | Agregar `keySessionContext: request.keySessionContext,` justo debajo (L80+). |

- [ ] W5.1: `src/types/index.ts` — campo `keySessionContext?` en `ComposeRequest` (#14) y `OrchestrateRequest` (#14) + import del tipo. (archivo #14)
- [ ] W5.2: `src/services/orchestrate.ts` — propagar `keySessionContext: request.keySessionContext` a `composeService.compose({...})`. (archivo #16)
- [ ] W5.3: `src/services/compose.ts` — pasar `request.keySessionContext` como 6º arg de `budgetService.debit(...)`. (archivo #15)
- [ ] W5.4: `src/routes/compose.ts` + `src/routes/orchestrate.ts` — inyectar `keySessionContext: request.keySessionContext` (#17, #18).
- [ ] W5.5: **MNR-3 (foldear):** en `src/routes/auth.ts:1114-1115` reemplazar el literal `reply.status(403).send({ error_code: 'SESSION_NOT_ALLOWED' })` por `throw new SessionNotAllowedError()` (o el mapeo equivalente que use el catch del handler), de modo que la clase `SessionNotAllowedError` (errors.ts) quede CONSUMIDA, por consistencia con las demás error classes. Importar `SessionNotAllowedError` de `../services/security/errors.js`. Verificar que el HTTP final sigue siendo **403** con `error_code: 'SESSION_NOT_ALLOWED'` (el test T-SUBDELEG en `auth.keySession.test.ts:252` NO debe cambiar de aserción). **Elegimos USAR la clase (no eliminarla)** porque WKH-122 reusará el gate. (archivo `src/routes/auth.ts` ya está en Files #9 — esto es un cambio de 1-2 líneas dentro del handler existente, NO un archivo nuevo.)
- [ ] W5.6: **MNR-4 (foldear):** eliminar el type `KeySessionErrorCode` de `src/types/a2a-key.ts:334-339` (queda sin consumidores tras el fix). El tipo canónico de error-codes del runtime es `KeySessionMiddlewareErrorCode` (`a2a-key.ts:112-121`), que es un **superset** (incluye `AGENT_KEY_BUDGET_EXHAUSTED`/`DAILY_LIMIT`/`KEY_NOT_FOUND`/`OWNERSHIP_MISMATCH`) y vive junto a su único consumidor (`send403session`). **Decisión: ELIMINAR `KeySessionErrorCode`** (no consolidar) — el superset del middleware ya cubre el dominio y no hay otro consumidor. Verificar con `tsc` que nadie lo importaba.
- [ ] W5.7: `src/services/compose.test.ts` — test multi-step bajo sesión (T-SESS-MULTISTEP, resuelve MNR-1). Ver Test Expectations.
- [ ] W5.8: `npm run format` → `npm run lint` → `tsc` strict → suite completa verde (incl. los 89 tests de WKH-121 y los del branch `delegationContext` de WKH-101, que NO deben regresar).

> **PROHIBIDO en W5-FIX:** NO tocar el branch WKH-101 ni la cadena `delegationContext` (solo se replica, no se modifica). NO tocar `a2a_delegations` / `debit_delegation_and_parent`. NO usar EIP-712/viem/ethers. NO reescribir lógica de W0-W4. El cambio es puramente de **propagación** (pasar un arg que ya existe en ambos extremos) + 2 limpiezas cosméticas (MNR-3/MNR-4).

### Verificación Incremental

| Wave | Verificación al completar |
|------|--------------------------|
| W0 | `tsc` pasa (tipos/errores); revisión SQL contra Exemplar 2 |
| W1 | `tsc` + `key-session.test.ts` (parcial) |
| W2 | `tsc` + `a2a-key.test.ts` (branch) + `budget.test.ts` |
| W3 | `tsc` + `auth.keySession.test.ts` |
| W4 | full QA (drift detection + evidencia por AC) |
| W5-FIX | `tsc` + T-SESS-MULTISTEP verde (cap respetado en steps 1..N) + suite completa sin regresión de WKH-101 (`delegationContext` sigue funcionando) |

---

## Out of Scope

> NO tocar bajo ninguna circunstancia:
- `DELETE /auth/key-session/:id` (es WKH-122).
- Auth por firma/passkey EIP-712/WebAuthn (WKH-123).
- Recibos inmutables / proof-chain (WKH-124).
- Constraints por destino/vendor y ventanas de tiempo (WKH-125).
- El branch EIP-712 de WKH-101 (`wasi_a2a_session_*`), su tabla `a2a_delegations`, su RPC, su service `delegation.ts`.
- RLS real a nivel Postgres (`ALTER TABLE … ENABLE ROW LEVEL SECURITY`) — WKH-SEC-02.
- Rate limiting por sesión.
- El path master de `requirePaymentOrA2AKey`.
- NO "mejorar" código adyacente. NO refactors no solicitados. NO funcionalidad no listada.

---

## Done Definition

- [ ] `tsc` strict verde (sin `any`/`as unknown`/`@ts-ignore`).
- [ ] `npm run format` ejecutado ANTES de `npm run lint` (orden obligatorio).
- [ ] `npm run lint` verde.
- [ ] Suite completa verde: tests existentes (no regresan) + los 16 tests nuevos de la tabla Test Expectations.
- [ ] Los 15 ACs cubiertos por ≥1 test cada uno.
- [ ] Branch WKH-101 (L234–432), path master (L434–559), `a2a_delegations`, `debit_delegation_and_parent` y `delegation.ts` SIN modificar.
- [ ] Migración con timestamp posterior a `20260602000000` + down migration.
- [ ] **(Fix-pack BLQ-ALTO-1)** El cap de la sesión (`max_budget_usd`) se respeta en **multi-step** (compose/orchestrate), no solo en el step 0: `keySessionContext` se propaga por toda la cadena `routes → ComposeRequest/OrchestrateRequest → orchestrate.ts → compose.ts → budgetService.debit`. T-SESS-MULTISTEP verde.
- [ ] **(Anti-regresión)** WKH-101 `delegationContext` sigue funcionando igual — su cableado existente NO se rompe (se replicó, no se modificó). Suite de WKH-101 sin regresión.
- [ ] **(MNR-3)** `SessionNotAllowedError` consumida en el route (no dead code).
- [ ] **(MNR-4)** `KeySessionErrorCode` eliminado (no dead code); `KeySessionMiddlewareErrorCode` queda como tipo canónico.

---

## Escalation Rule

> **Si algo no está en este Story File, Dev PARA y escala a Architect.** No inventar. No asumir. No improvisar.

Situaciones de escalation:
- Un archivo del exemplar ya no existe o sus line ranges no coinciden.
- Una error class reusada (`AgentKeyBudgetExhaustedError`, `DailyLimitExceededError`, `AgentKeyInactiveError`, `AgentKeyNotFoundError`, `OwnershipMismatchError`) no existe con ese nombre exacto en `errors.ts`.
- `budget.ts#debit` no tiene la forma esperada para enchufar `keySessionContext?` sin romper la firma master.
- La firma de `resolveCallerKey` / `rawKeyFromRequest` / `resolveTargetChain` difiere de lo descrito.
- Ambigüedad en cómo obtener el balance del padre por-chain para la validación de creación (AC-2) más allá de lo documentado en DT-4.
- El cambio requiere tocar archivos fuera de la tabla "Files to Modify/Create".

---

*Story File generado por NexusAgil — F2.5 — WKH-121*
