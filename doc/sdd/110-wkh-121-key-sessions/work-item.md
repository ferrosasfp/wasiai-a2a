# Work Item — [WKH-121] Session Keys sin EIP-712 (derivación server-side)

## Resumen

Derivar **session keys efímeras** desde una agent key existente mediante una llamada REST
autenticada con la master key — sin requerir EVM wallet ni firma EIP-712. Un caller que
tiene `wasi_a2a_<master>` puede crear una sesión acotada (`wasi_a2a_session_<token>`) con
TTL, budget máximo por sesión y subset de los allowlists de la key padre. Si la sesión se
filtra, el blast radius queda limitado al scope declarado. La master key sigue funcionando
sin cambios (back-compat total).

> **Grounding WKH-101 (DONE):** WKH-101 implementó sesiones EIP-712 (tabla `a2a_delegations`,
> `delegationService`, middleware branch `wasi_a2a_session_*`, tokens opacos con TTL + límites +
> ownership guard). WKH-121 **complementa**, NO duplica: introduce sesiones **sin wallet/firma**
> (flow server-side puro), reutilizando el token format y el middleware branch existente. El
> Architect (F2) decidirá si WKH-121 usa `a2a_delegations` con `derivation_mode='server'` o crea
> `a2a_key_sessions` como tabla separada — este work-item documenta ambas opciones como DT-1.

---

## Sizing

- **SDD_MODE:** full
- **Estimación:** L
- **Clasificación:** QUALITY (toca identidad + pago + seguridad)
- **Branch sugerido:** `feat/110-wkh-121-key-sessions`

Clasificación QUALITY confirmada: toca la capa de autenticación (middleware), el modelo de
datos de identidad (nueva tabla o extensión de `a2a_delegations`), y el debit de budget.
Justificación para mantener L (no reducir a M): requiere migración DB, nuevo endpoint REST,
extensión del middleware (branch adicional o extensión del branch session), tests de
seguridad (ownership guard, TTL, scope acotado), y análisis de coexistencia con WKH-101.

---

## Skills Router

- **skill-security-identity** — gestión de tokens, ownership guard, blast-radius mitigation
- **skill-db-migrations** — diseño de tabla/extensión, RPCs atómicos Supabase, índices

---

## Contexto técnico grounding (F0)

### Lo que ya existe (WKH-101, DONE — NO duplicar)

| Componente | Ubicación | Estado |
|------------|-----------|--------|
| Tabla `a2a_delegations` | `supabase/migrations/20260601000000_a2a_delegations.sql` | DONE en prod |
| `delegationService` | `src/services/delegation.ts` | DONE |
| Middleware branch `wasi_a2a_session_*` | `src/middleware/a2a-key.ts` L234–432 | DONE |
| Tipos `DelegationRow`, `DelegationPolicy`, etc. | `src/types/a2a-key.ts` L155–260 | DONE |
| Endpoints `POST/DELETE/GET /auth/delegation` | `src/routes/auth.ts` | DONE |
| Error classes `DELEGATION_*`, `OWNERSHIP_MISMATCH` | `src/services/security/errors.ts` | DONE |

WKH-101 requiere EIP-712 + `funding_wallet` bindeado (EVM wallet). Campos clave del row:
`session_key_address` (EOA) · `typed_data_raw` (auditoría) · `nonce` (anti-replay).

### Gap real de WKH-121

Un developer que usa la Agent Key como API key (sin EVM wallet) no puede crear sesiones
acotadas. WKH-101 sólo acepta sesiones firmadas por una EOA. WKH-121 cierra este gap:
un request HTTP autenticado con la master key crea una sesión efímera server-side, sin
necesidad de criptografía EVM del lado del caller.

### Coexistencia con WKH-101

El middleware actual detecta `rawKey.startsWith('wasi_a2a_session_')` y enruta al branch
de delegación (línea 234 de `src/middleware/a2a-key.ts`). Los tokens de WKH-121 usarán el
mismo prefijo o uno diferente para distinguir el tipo de sesión. El Architect decidirá
en F2 (ver DT-1).

---

## Acceptance Criteria (EARS)

### Creación de sesión

**AC-1 (creación):** WHEN un caller autenticado con una master key activa ejecuta
`POST /auth/key-session` con `{ ttl_seconds, max_budget_usd, allowed_registries?,
allowed_agent_slugs?, allowed_categories? }`, the system SHALL crear una entrada de
sesión en la DB, retornar `{ session_id, session_token, expires_at, scope }` con HTTP 201,
y exponer el `session_token` UNA SOLA VEZ en esta respuesta (nunca se almacena en
texto plano).

**AC-2 (scope acotado):** WHEN se crea una session key, the system SHALL rechazar la
creación (HTTP 400) si cualquiera de los siguientes scopes declarados excede el de la
key padre: `max_budget_usd` > balance disponible del padre, `allowed_registries` contiene
registries no presentes en `allowed_registries` del padre (cuando el padre tiene lista no
nula), o `allowed_agent_slugs` contiene slugs no en la lista del padre (cuando no es null).
La sesión creada SHALL tener `scope ⊆ scope(key_padre)` — nunca mayor.

**AC-3 (TTL obligatorio):** WHEN se crea una session key, the system SHALL rechazar la
creación (HTTP 400) si `ttl_seconds <= 0` o `ttl_seconds` supera el límite máximo
configurado por env var `SESSION_MAX_TTL_SECONDS` (default: 86400 segundos = 24h).

### Autenticación con sesión

**AC-4 (validación en middleware):** WHEN un request llega con un session token de
WKH-121 (formato a definir en F2, ej. `wasi_a2a_sess_*`), the system SHALL: (1) hacer
lookup por hash SHA-256 del token en O(1), (2) verificar que la sesión no está expirada
ni revocada, (3) cargar la parent key y verificar que `is_active = true`, (4) si pasa
todos los checks, inyectar `request.a2aKeyRow` con el scoping efectivo de la sesión
(no el de la parent key completa), (5) debitar del budget de la sesión y del parent
atómicamente.

**AC-5 (token inválido):** IF el session token no existe en la DB, THEN the system
SHALL rechazar con HTTP 401 y `error_code: SESSION_TOKEN_INVALID`.

**AC-6 (sesión expirada):** IF `now() >= session.expires_at`, THEN the system SHALL
rechazar con HTTP 403 y `error_code: SESSION_EXPIRED`.

**AC-7 (parent key inactiva):** IF `parent_key.is_active = false`, THEN the system
SHALL rechazar con HTTP 403 y `error_code: KEY_INACTIVE`.

### Budget y débito

**AC-8 (débito atómico):** WHEN un request autenticado con session key se acepta, the
system SHALL debitar el monto del budget de la sesión Y del parent atómicamente (misma
transacción DB), sin posibilidad de que un request concurrente exceda el `max_budget_usd`
de la sesión ni el budget global del parent.

**AC-9 (budget de sesión agotado):** IF `session.spent + amount > session.max_budget_usd`,
THEN the system SHALL rechazar con HTTP 403 y `error_code: SESSION_BUDGET_EXHAUSTED`.

**AC-10 (scope de sesión en request):** WHILE una sesión está activa, the system SHALL
aplicar el scoping efectivo de la sesión (not del parent) para los checks de
`allowed_registries`, `allowed_agent_slugs`, `allowed_categories` en el paso de
validación de agente.

### Ownership y seguridad

**AC-11 (ownership guard — toda query):** WHILE el servicio opera sobre tablas de sesiones
o `a2a_agent_keys`, the system SHALL incluir `.eq('owner_ref', ownerId)` en toda query
o mutación sobre esas tablas. Toda función del service que reciba un `sessionId` SHALL
recibir también `ownerId: string` (no `string | undefined`). Violación de este invariante
SHALL ser marcada BLOQUEANTE en AR.

**AC-12 (no sub-delegación):** IF un request porta un session token de WKH-121 intenta
crear otra sesión en `POST /auth/key-session`, THEN the system SHALL rechazar con HTTP 403
y `error_code: SESSION_NOT_ALLOWED` (sesiones no pueden crear sub-sesiones).

### Listado y gestión

**AC-13 (listado):** WHEN el caller ejecuta `GET /auth/key-session`, the system SHALL
retornar la lista de sesiones activas, expiradas y revocadas del owner, con campos:
`session_id, expires_at, max_budget_usd, spent, status (active|expired|revoked), scope`.

### Back-compat

**AC-14 (back-compat bearer):** WHILE el sistema está corriendo con WKH-121 deployado,
the system SHALL continuar aceptando master keys (bearer `wasi_a2a_*` sin prefijo `sess`)
sin ningún cambio en su comportamiento. El path master de `requirePaymentOrA2AKey`
SHALL permanecer intacto.

**AC-15 (coexistencia WKH-101):** WHILE el sistema corre WKH-121 y WKH-101 en
producción, the system SHALL distinguir tokens de delegación EIP-712 (`wasi_a2a_session_*`)
de tokens de sesión server-side (prefijo WKH-121) y enrutar cada uno a su branch de
validación correspondiente.

---

## Scope IN

| Artefacto | Descripción |
|-----------|-------------|
| `src/types/a2a-key.ts` | Tipos nuevos: `KeySessionRow`, `CreateKeySessionInput`, `KeySessionResponse`, error codes `SESSION_*` |
| `src/services/key-session.ts` (nuevo) | Service: `create`, `lookupByTokenHash`, `list`, `debitAndParent` con ownership guard completo |
| `src/middleware/a2a-key.ts` | Nuevo branch para el prefijo de token de WKH-121 (branch adicional, sin tocar los branches master y delegation de WKH-101) |
| `src/routes/auth.ts` | Endpoints: `POST /auth/key-session` (201), `GET /auth/key-session` (200) |
| `supabase/migrations/YYYYMMDD_a2a_key_sessions.sql` | Tabla nueva O extensión de `a2a_delegations` (decisión F2, ver DT-1) + RPC atómico `debit_session_and_parent` + índices + hardening |
| `src/services/security/errors.ts` | Error classes nuevas: `SessionTokenInvalidError`, `SessionExpiredError`, `SessionBudgetExhaustedError`, `SessionNotAllowedError` |
| Tests unitarios e integración | Cobertura de todos los ACs, incluyendo tests de ownership guard, TTL, scope acotado, atomicidad |

---

## Scope OUT

| Exclusión | Justificación |
|-----------|---------------|
| Revocación granular por sesión (`DELETE /auth/key-session/:id`) | Es el scope de WKH-122 (la HU siguiente); WKH-121 puede incluir solo la lectura del estado |
| Auth por firma / passkey (EIP-712 / WebAuthn) | Es el scope de WKH-123 |
| Recibos inmutables / proof-chain | Es el scope de WKH-124 |
| Constraints por destino/vendor y ventanas de tiempo arbitrarias | Es el scope de WKH-125 |
| Modificar el branch EIP-712 de WKH-101 (`wasi_a2a_session_*`) | WKH-101 está DONE; WKH-121 coexiste sin modificarlo |
| RLS real a nivel Postgres (`ALTER TABLE … ENABLE ROW LEVEL SECURITY`) | Trackeado en WKH-SEC-02; defensa en profundidad pero fuera de scope aquí |
| Rate limiting por sesión | No mencionado por el humano; marcar [NEEDS CLARIFICATION] si aparece en F2 |

---

## Decisiones técnicas (DT-N)

**DT-1 (modelo de datos — decisión para Architect en F2):** Dos opciones válidas:

- **Opción A — tabla separada `a2a_key_sessions`:** columnas `id, key_id (FK), owner_ref,
  session_token_hash (UNIQUE), ttl_seconds, expires_at, max_budget_usd, spent_usd,
  allowed_registries (JSONB|NULL), allowed_agent_slugs (JSONB|NULL), allowed_categories (JSONB|NULL),
  derivation_mode TEXT DEFAULT 'server', revoked_at, created_at`. Ventaja: separación limpia
  de las sesiones EIP-712 (WKH-101) vs. server-side (WKH-121). Desventaja: duplicación de
  lógica de débito (aunque el RPC puede ser reutilizado o extendido).

- **Opción B — extensión de `a2a_delegations`:** agregar columna `derivation_mode TEXT`
  (`'eip712'|'server'`), hacer opcionales `session_key_address`, `typed_data_raw`, `nonce`
  (solo para EIP-712). Ventaja: unifica el modelo de sesión. Desventaja: `CONSTRAINT
  uq_a2a_delegations_key_nonce UNIQUE (key_id, nonce)` rompe para rows server-side (nonce
  nulo); requiere refactor de la constraint y posible null-handling en `delegationService`.

  El Architect deberá evaluar el impacto en `debit_delegation_and_parent` RPC. Si se elige
  Opción B, la migration debe ser retrocompatible con los rows WKH-101 existentes.

**DT-2 (prefijo de token — distinción con WKH-101):** El token de WKH-121 debe usar un
prefijo distinto de `wasi_a2a_session_` para que el middleware pueda distinguir el branch.
Candidatos: `wasi_a2a_sess_` (más corto) o `wasi_a2a_sk_`. El Architect elige en F2 y
lo fija en la Constraint Directive correspondiente.

**DT-3 (RPC atómico):** El débito de sesión debe implementarse en un RPC Postgres con
`FOR UPDATE`, análogo a `debit_delegation_and_parent` (WKH-101). El RPC SHALL:
(1) lockear la row de sesión, (2) re-verificar TTL y revocación bajo lock (TOCTOU-safe),
(3) verificar `spent + amount <= max_budget_usd`, (4) llamar `increment_a2a_key_spend` o
el equivalente para el parent, (5) actualizar `spent_usd`. El Architect define el nombre
y firma exactos en el SDD.

**DT-4 (scope check):** El scoping efectivo inyectado en `request.a2aKeyRow` (para que
`composeService` y `orchestrateService` apliquen los checks existentes sin modificación)
debe ser la intersección del scope de la sesión con el scope de la parent key. Si la sesión
declara `allowed_registries = ['kite']` y la parent key tiene `allowed_registries = null`
(sin restricción), el scope efectivo es `['kite']`. Si la parent tiene `['kite', 'wasiai']`
y la sesión tiene `['kite']`, el scope efectivo es `['kite']`. [NEEDS CLARIFICATION: el
humano no especificó qué pasa si la sesión declara null (sin restricción) para un allowlist
— asumir que null en sesión hereda el allowlist del padre (más seguro que eliminar la
restricción).]

**DT-5 (env var configuración):** `SESSION_MAX_TTL_SECONDS` — máximo TTL permitido en
la creación de sesiones. Default 86400 (24h). Debe agregarse a `.env.example`.

---

## Constraint Directives (CD-N)

**CD-1 (back-compat bearer — OBLIGATORIO):** El path master de `requirePaymentOrA2AKey`
(bearer `wasi_a2a_*` sin prefijo de sesión) SHALL permanecer intacto. No se modifica
ningún check existente del branch master ni del branch EIP-712 (WKH-101). El nuevo
branch se inserta DESPUÉS de la detección del token de sesión WKH-101 y ANTES del
fallback al master path.

**CD-2 (ownership guard — OBLIGATORIO):** Toda query o mutación sobre la tabla de sesiones
o `a2a_agent_keys` DEBE filtrar por `owner_ref` además del `id`. Toda función del service
de sesiones que reciba un `sessionId` DEBE recibir también `ownerId: string` (no
`string | undefined`). Violación → BLOQUEANTE en AR (mismo estándar que WKH-53/CLAUDE.md).

**CD-3 (token plano nunca almacenado — OBLIGATORIO):** El token de sesión en texto plano
solo se expone en la respuesta HTTP 201. La DB solo almacena SHA-256(token). Nunca se
loga, nunca se persiste en otro campo. Mismo patrón que WKH-101.

**CD-4 (scope de sesión ⊆ scope de key padre — OBLIGATORIO):** La creación de una
sesión SHALL fallar (HTTP 400) si cualquier dimensión del scope de la sesión es más
permisiva que el scope de la parent key. El service verifica esto en la capa de aplicación
ANTES del INSERT. El RPC de débito NO lo verifica (ya está garantizado en creación).

**CD-5 (TTL obligatorio — OBLIGATORIO):** `ttl_seconds` es campo requerido en el
request de creación; `expires_at = now() + ttl_seconds` se calcula server-side (el cliente
no pasa `expires_at` directamente). El valor debe estar en rango `(0, SESSION_MAX_TTL_SECONDS]`.

**CD-6 (TypeScript strict — OBLIGATORIO):** Sin `any` explícito, sin `as unknown`, sin
`@ts-ignore`. Todos los tipos de la tabla de sesiones deben estar definidos en
`src/types/a2a-key.ts` con interfaces tipadas.

**CD-7 (RPC SECURITY DEFINER + search_path — OBLIGATORIO):** Todo nuevo RPC Postgres
que se cree DEBE incluir el bloque de hardening: `ALTER FUNCTION ... SET search_path = public, pg_temp`,
`REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated`, `GRANT EXECUTE ... TO service_role`.
Patrón de `20260601000000_a2a_delegations.sql` lines 104–111.

---

## Missing Inputs

| Item | Estado | Acción |
|------|--------|--------|
| ¿El prefijo del token WKH-121 debe ser distinto de `wasi_a2a_session_`? | Asumido que SÍ (DT-2) para evitar colisión con branch WKH-101 | Confirmar en F2 (Architect) |
| ¿Qué pasa si la sesión declara `allowed_registries = null`? (hereda del padre vs. sin restricción) | Asumido: null en sesión = hereda restricción del padre (DT-4) | Confirmar en F2 |
| ¿Queremos endpoint `DELETE /auth/key-session/:id` en WKH-121 o lo deja todo a WKH-122? | Asumido OUT (WKH-122) para mantener el scope manejable | [NEEDS CLARIFICATION si el humano quiere revocación mínima en WKH-121] |
| ¿La migration usa tabla nueva (`a2a_key_sessions`) o extiende `a2a_delegations`? | Resolución del Architect en F2 (DT-1) | Bloqueante para la migration — decidir en F2 antes de F3 |

---

## Análisis de paralelismo

- **WKH-121 bloquea a WKH-122** (revocación granular por sesión): WKH-122 asume que la tabla
  de sesiones existe y tiene `revoked_at`. No puede implementarse sin el modelo de WKH-121.

- **WKH-121 bloquea a WKH-123** (auth por firma/passkey): WKH-123 agrega una capa de
  autenticación sobre el token de sesión; el token de sesión debe existir primero.

- **WKH-121 NO bloquea a WKH-124** (recibos inmutables) ni a **WKH-125** (constraints
  programables) — pueden diseñarse en paralelo.

- **WKH-121 NO bloquea a WKH-118** (fee en /compose) — sin dependencia.

- **WKH-121 es independiente de WKH-101** (ya DONE). No hay riesgo de conflicto de merge
  si la implementación de WKH-121 introduce nueva tabla y nuevo prefijo (Opción A en DT-1).
  Si se elige Opción B (extender `a2a_delegations`), el Architect debe analizar el riesgo
  de drift con los rows existentes antes de aprobar SPEC.

---

## Notas de diseño para el Architect (F2)

1. **Prioridad de lectura antes de diseñar:** `src/middleware/a2a-key.ts` L234–432
   (branch delegación WKH-101), `supabase/migrations/20260601000000_a2a_delegations.sql`
   (tabla + RPC), `src/services/delegation.ts` (service completo). El SDD debe mostrar
   explícitamente cómo el nuevo branch coexiste con el branch `wasi_a2a_session_*`.

2. **El middleware recibe el token ANTES de conocer su tipo.** La detección del tipo de
   sesión ocurre por prefijo de string. El Architect debe definir el orden exacto de
   detección: `wasi_a2a_session_` (WKH-101) → `wasi_a2a_sess_` (WKH-121 propuesto) →
   master bearer. Este orden es crítico para back-compat (CD-1).

3. **Atomicidad:** El RPC de débito es el componente de mayor riesgo. El SDD debe
   especificar el SQL completo del nuevo RPC o del cambio al RPC existente, con los
   mismos controles de TOCTOU que `debit_delegation_and_parent`.

4. **WKH-122 (revocación granular):** Aunque está fuera de scope de WKH-121, la tabla
   DEBE incluir la columna `revoked_at TIMESTAMPTZ` (nullable) para que WKH-122 pueda
   agregar el endpoint sin migración adicional.
