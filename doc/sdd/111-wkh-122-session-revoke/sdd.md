# SDD #111: [WKH-122] Revocación granular e instantánea de session keys

> SPEC_APPROVED: no
> Fecha: 2026-06-19
> Tipo: feature (security)
> SDD_MODE: full
> Branch: feat/111-wkh-122-session-revoke
> Artefactos: doc/sdd/111-wkh-122-session-revoke/

---

## 1. Resumen

El owner de una Agent Key (master key) podrá revocar una session key individual
(`wasi_a2a_sess_*`) sin afectar la master ni las demás sesiones activas. La HU agrega
exactamente dos piezas productivas: la función `keySessionService.revoke(sessionId, ownerId)`
(UPDATE `revoked_at = now()` filtrado por `id` + `owner_ref`) y la ruta `DELETE /auth/key-session/:id`,
ambas espejando el patrón ya en producción de WKH-101 (`delegationService.revoke` +
`DELETE /auth/delegation/:id`). La revocación es **inmediata**: el middleware del branch
`wasi_a2a_sess_` ya rechaza sesiones con `revoked_at != null` (WKH-121, `src/middleware/a2a-key.ts:480-486`)
sin caché — esta HU NO toca el middleware, solo agrega un test de regresión.

Divergencia deliberada vs WKH-101: el ownership mismatch / id inexistente responde **404
`SESSION_NOT_FOUND`** (disclosure-safe), no el 403 `OWNERSHIP_MISMATCH` de delegación. Esto
requiere una clase de error nueva (`SessionNotFoundError`) — verificado que NO existe hoy.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 111 (WKH-122) |
| **Tipo** | feature / security |
| **SDD_MODE** | full |
| **Objetivo** | Endpoint + service para revocar una session key individual con ownership guard y efecto inmediato. |
| **Reglas de negocio** | Solo el owner (autenticado con master key) revoca; sub-sesión NO puede revocar; idempotente; disclosure-safe 404. |
| **Scope IN** | `keySessionService.revoke`, `DELETE /auth/key-session/:id`, `SessionNotFoundError`, tests. |
| **Scope OUT** | Middleware, migración, revocación masiva, auth por firma (WKH-123). |
| **Missing Inputs** | Ambos resueltos en este SDD (§9). |

### Acceptance Criteria (EARS)

- **AC-1** — WHEN `DELETE /auth/key-session/:id` es invocado por el owner con master key activa, THEN the system SHALL setear `revoked_at = now()` en `a2a_key_sessions` y responder 200 `{ "revoked": true }`.
- **AC-2** — WHEN una sesión tiene `revoked_at != null`, the system SHALL rechazar cualquier request del branch `wasi_a2a_sess_` con 403 `SESSION_TOKEN_INVALID` sin delay de caché. (Ya cubierto por WKH-121; test de regresión obligatorio.)
- **AC-3** — IF el `session_id` no existe O pertenece a otro `owner_ref`, THEN the system SHALL responder 404 `{ "error_code": "SESSION_NOT_FOUND" }` (disclosure-safe).
- **AC-4** — WHEN `DELETE` es invocado sobre una sesión ya revocada del caller, the system SHALL responder 200 `{ "revoked": true }` sin error (idempotente).
- **AC-5** — IF `DELETE` es invocado con un token de sesión `wasi_a2a_sess_*` como autenticador, THEN the system SHALL responder 403 `{ "error_code": "SESSION_NOT_ALLOWED" }`.
- **AC-6** — WHILE `identity.deactivate(keyId)` desactiva la master key, the system SHALL no modificar el comportamiento de `DELETE /auth/delegation/:id` ni el branch `wasi_a2a_session_*` del middleware.
- **AC-7** — WHEN `keySessionService.revoke` es invocado, the system SHALL requerir `ownerId: string` (no `string | undefined`) y filtrar por `.eq('id', sessionId).eq('owner_ref', ownerId)` antes del UPDATE.

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón / hallazgo extraído |
|---------|---------|----------------------------|
| `src/services/key-session.ts` (372 L) | Service a extender | `list` (L271-319) usa `.eq('owner_ref', ownerRef)`. `lookupByTokenHash`/`getParentKey` son las ÚNICAS sin owner gate (documentado). `debitSessionAndParent` (L326-382) ya mapea `OWNERSHIP_MISMATCH`+`logOwnershipMismatch({op:'keySessionRevoke',...})`. Imports de errors ya presentes en L28-38. El nuevo `revoke` se inserta entre `list` (L319) y `debitSessionAndParent` (L321). |
| `src/services/delegation.ts` (L320-371) | **Blueprint exacto** de `revoke` | `revoke(delegationId, ownerRef): Promise<void>` → `.update({revoked_at: new Date().toISOString()}).eq('id',...).eq('owner_ref',...).select('id')`; `error` → `throw new Error(...)`; `!data || data.length===0` → `logOwnershipMismatch({op,resourceId,callerOwnerRef}) + throw`. **Diferencia WKH-122**: lanzar `SessionNotFoundError` (no `OwnershipMismatchError`) y `op:'keySessionRevoke'`. |
| `src/routes/auth.ts` (L1054-1083, L1108-1173) | Espejo de ruta + gate | `DELETE /delegation/:id` (L1054): `resolveCallerKey` → check `is_active` → `service.revoke(id, callerKey.owner_ref)` → 200 `{revoked:true}`; catch `OwnershipMismatchError`→403, fallback→500. Gate sub-sesión: `POST /key-session` (L1114-1120) usa `rawKeyFromRequest(req)` + `.startsWith(KEY_SESSION_TOKEN_PREFIX)` → `new SessionNotAllowedError()` → 403 ANTES de `resolveCallerKey`. `KEY_SESSION_TOKEN_PREFIX = 'wasi_a2a_sess_'` (L270). Imports `keySessionService` (L36), `SessionNotAllowedError` (L47), `OwnershipMismatchError` (L46) ya presentes. |
| `src/services/security/errors.ts` (396 L) | Verificar `SessionNotFoundError` | **NO EXISTE** `SessionNotFoundError`. Existen `SessionTokenInvalidError` (L286, `SESSION_TOKEN_INVALID`), `SessionExpiredError`, `SessionBudgetExhaustedError`, `SessionNotAllowedError` (L313, `SESSION_NOT_ALLOWED`), `OwnershipMismatchError` (L9), `logOwnershipMismatch` (L347) + `OwnershipOp` ya incluye `'keySessionRevoke'` (L335). Patrón de clase: `readonly code = '...' as const` + `name`. |
| `src/middleware/a2a-key.ts` (L467-493) | Confirmar AC-2 (NO se toca) | Branch `wasi_a2a_sess_` (L467): tras `lookupByTokenHash`, `if (session.revoked_at !== null)` → `send403session(reply,'SESSION_TOKEN_INVALID','...revoked')` (L480-486). Lookup directo a Supabase por hash, sin caché → efecto inmediato. **CD-2: NO modificar.** |
| `src/routes/auth.delegation.test.ts` (369 L) | Exemplar de route test | Fastify `inject`, `vi.mock` de services, `mockRevoke`, `MASTER_KEY = wasi_a2a_<64>`, `makeKeyRow`, registro `app.register(authRoutes,{prefix:'/auth'})`. T11 (revoke 200), T13 (ownership→error), T16 (sub-delegation 403, `mockLookupByHash` NOT called). |
| `src/services/key-session.test.ts` (head + L88-147, L391+) | Exemplar de service test | `vi.mock('../lib/supabase.js')`, `chainMock()` builder chainable (L88-105: `select/insert/update/eq` retornan `this`, `single`/`order` resuelven). `makeParentKey`, `mockFrom`. T-LIST (L391) ejercita status `revoked` ya. |
| `src/middleware/a2a-key.test.ts` (L1423-1556) | AC-2 ya tiene infra | `describe('...key-session branch')`, `makeKeySessionRow`, `mockSessionLookup`. **Ya existe** test "revoked session → 403 SESSION_TOKEN_INVALID (pre-debit)" (L1543-1556). AC-2 se refuerza/anota acá. |

### Exemplars verificados (Glob/Read confirmados)

| Para crear/modificar | Seguir patrón de | Razón |
|---------------------|------------------|-------|
| `keySessionService.revoke` | `src/services/delegation.ts:351-371` (`revoke`) | UPDATE owner-guarded + 0-rows handling idéntico; cambia error class + `op`. |
| `DELETE /auth/key-session/:id` | `src/routes/auth.ts:1054-1083` (`DELETE /delegation/:id`) | Estructura de handler idéntica; cambia service, gate y mapeo de error. |
| gate sub-sesión en el DELETE | `src/routes/auth.ts:1114-1120` (`POST /key-session`) | `rawKeyFromRequest` + prefix + `SessionNotAllowedError` ANTES de `resolveCallerKey`. |
| `SessionNotFoundError` | `src/services/security/errors.ts:313-319` (`SessionNotAllowedError`) | Mismo shape `readonly code = '...' as const` + `name`. |
| route test | `src/routes/auth.delegation.test.ts` (T11/T13/T16) | Mock service + `inject` + assertions de status/error_code. |
| service test | `src/services/key-session.test.ts` (`chainMock` + create tests) | Mock supabase chainable + assert de `.eq('owner_ref',...)`. |
| middleware regresión AC-2 | `src/middleware/a2a-key.test.ts:1543-1556` (revoked session) | Ya existe; reforzar comentario AC-2. |

### Estado de BD relevante

| Tabla | Existe | Columnas relevantes |
|-------|--------|---------------------|
| `a2a_key_sessions` | Sí (prod, WKH-121) | `id`, `owner_ref`, `revoked_at` (nullable timestamptz). `revoked_at` ya seleccionada por `list` (`key-session.ts:275`). **NO hay migración** (Scope OUT). |

### Componentes reutilizables encontrados

- `logOwnershipMismatch({op,resourceId,callerOwnerRef})` (`errors.ts:347`) — reusar, con `op: 'keySessionRevoke'` (ya en el enum `OwnershipOp`, L335).
- `rawKeyFromRequest` (`auth.ts:147`) — reusar para el gate.
- `KEY_SESSION_TOKEN_PREFIX` (`auth.ts:270`) — reusar.
- `resolveCallerKey` (`auth.ts:111`) — reusar.

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar |
|---------|--------|-------------|----------|
| `src/services/security/errors.ts` | Modificar | Agregar `SessionNotFoundError` (`code='SESSION_NOT_FOUND'`) tras `SessionNotAllowedError` (L319). | `errors.ts:313-319` |
| `src/services/key-session.ts` | Modificar | Agregar `revoke(sessionId: string, ownerId: string): Promise<void>` entre `list` (L319) y `debitSessionAndParent` (L321). Importar `SessionNotFoundError`. | `delegation.ts:351-371` |
| `src/routes/auth.ts` | Modificar | Agregar `DELETE /key-session/:id` (path interno SIN `/auth`) tras el GET `/key-session` (L1173). Gate sub-sesión + `resolveCallerKey` + mapeo `SessionNotFoundError`→404. Importar `SessionNotFoundError`. | `auth.ts:1054-1083` + `1114-1120` |
| `src/services/key-session.test.ts` | Modificar | Tests de `revoke`: happy (AC-1/AC-7 con assert `.eq('owner_ref',...)`), idempotente (AC-4), 0-rows→`SessionNotFoundError` (AC-3). | `key-session.test.ts` create tests |
| `src/routes/auth.key-session.test.ts` | **Crear** | Route tests: AC-1 (200), AC-3 (404), AC-4 (idempotente 200), AC-5 (403 sub-sesión, lookup NOT called). | `auth.delegation.test.ts` (T11/T13/T16) |
| `src/middleware/a2a-key.test.ts` | Modificar | Reforzar/anotar el test revoked-session existente (L1543) como cobertura explícita de **AC-2** (regresión). | test existente L1543-1556 |

### 4.2 Modelo de datos

N/A — sin cambios de BD. `revoked_at` ya existe (verificado §3).

### 4.3 Componentes / Servicios

`keySessionService.revoke(sessionId, ownerId)`:
1. `supabase.from('a2a_key_sessions').update({ revoked_at: <ISO now> }).eq('id', sessionId).eq('owner_ref', ownerId).select('id')`.
2. `if (error)` → `throw new Error('Failed to revoke key session: ...')` (NUNCA propaga el msg crudo al cliente — el handler nunca lo expone; CD-7).
3. `if (!data || data.length === 0)` → `logOwnershipMismatch({ op: 'keySessionRevoke', resourceId: sessionId, callerOwnerRef: ownerId })` + `throw new SessionNotFoundError()`.
4. Retorna `void` en éxito (≥1 row matcheado → idempotente: refresca `revoked_at` aunque ya estuviera revocada).

`SessionNotFoundError`: `readonly code = 'SESSION_NOT_FOUND' as const`, `name = 'SessionNotFoundError'`, message genérico.

### 4.4 Flujo principal (Happy Path)

1. Owner llama `DELETE /auth/key-session/<id>` con master key (header `x-a2a-key` o `Bearer wasi_a2a_*`).
2. Gate sub-sesión: `rawKeyFromRequest(req)` NO empieza con `wasi_a2a_sess_` → continúa.
3. `resolveCallerKey(req)` → master key activa.
4. `keySessionService.revoke(req.params.id, callerKey.owner_ref)` → UPDATE matchea 1 row del owner.
5. Respuesta 200 `{ revoked: true }`.

### 4.5 Flujo de error

1. **Sub-sesión** (`wasi_a2a_sess_*` autenticador): gate (paso 2) → 403 `{ error_code: 'SESSION_NOT_ALLOWED' }`, `resolveCallerKey` NO se ejecuta.
2. **Sin master key válida**: `resolveCallerKey` null o `is_active=false` → 403 `{ error: 'Invalid or inactive API key' }`.
3. **id inexistente o de otro owner**: service 0-rows → `SessionNotFoundError` → handler 404 `{ error_code: 'SESSION_NOT_FOUND' }`.
4. **Error inesperado de BD**: catch fallback → 500 `{ error_code: 'KEY_SESSION_REVOKE_FAILED' }` + `fastify.log.error({ errorClass })` (sin msg crudo de PG).

## 5. Constraint Directives (Anti-Alucinación)

### Heredados del work-item

- **CD-1 OBLIGATORIO**: `keySessionService.revoke` recibe `ownerId: string` (no `string|undefined`); la query incluye `.eq('owner_ref', ownerId)` además de `.eq('id', sessionId)`. Violación → BLOQUEANTE en AR.
- **CD-2 OBLIGATORIO**: el middleware `wasi_a2a_sess_` NO se modifica.
- **CD-3 PROHIBIDO**: `string | undefined` para `ownerId`. Type `string` estricto.
- **CD-4 PROHIBIDO**: agregar caché de sesiones entre revocación y chequeo del middleware. Efecto inmediato.
- **CD-5 OBLIGATORIO**: el `DELETE /key-session/:id` tiene el gate de sub-sesión (`wasi_a2a_sess_*`) ANTES de `resolveCallerKey`.
- **CD-6 PROHIBIDO**: responder 403 `OWNERSHIP_MISMATCH` para id inexistente/de otro owner. Debe ser 404 `SESSION_NOT_FOUND`.
- **CD-7 PROHIBIDO**: propagar el mensaje crudo de Postgres al cliente en cualquier error path.

### Específicos del SDD

- **CD-8 OBLIGATORIO**: el path INTERNO de la ruta en el plugin `authRoutes` es `/key-session/:id` (SIN `/auth`). El prefix `/auth` lo agrega `src/index.ts` al registrar. (Auto-blindaje WKH-101 W2: `/auth/auth/delegation` bug por duplicar el prefix.)
- **CD-9 OBLIGATORIO**: reusar la clase de error vía `instanceof` en el handler (no string-matching). `SessionNotFoundError`→404, fallback→500.
- **CD-10 OBLIGATORIO**: `op` en `logOwnershipMismatch` debe ser exactamente `'keySessionRevoke'` (ya en el enum `OwnershipOp`, no agregar nuevo valor).
- **CD-11 PROHIBIDO**: agregar dependencias nuevas o `any`/`as unknown` (TS strict, project-context regla 8).

### PROHIBIDO (general)

- NO modificar `src/middleware/a2a-key.ts`, `delegation.ts`, ni el branch `wasi_a2a_session_*`.
- NO crear migración.
- NO tocar archivos fuera de la tabla 4.1.
- NO hardcodear el prefix de token (reusar `KEY_SESSION_TOKEN_PREFIX`).

## 6. Scope

**IN:** `SessionNotFoundError`; `keySessionService.revoke`; `DELETE /auth/key-session/:id` + gate; tests (service, route, regresión middleware AC-2).

**OUT:** middleware, migración, revocación masiva (`DELETE /auth/key-session` sin id), auth por firma (WKH-123), modificar delegación.

## 7. Riesgos

| Riesgo | Prob | Impacto | Mitigación |
|--------|------|---------|------------|
| Path duplicado `/auth/auth/key-session` | M | A | CD-8 + test de route ejercita `/auth/key-session/:id` y debe dar 200/404 (no 404 de routing). |
| Aserción `toHaveBeenCalledWith` se rompe al cambiar firmas mockeadas | B | M | `revoke` es función nueva; no cambia firmas existentes. NO se agregan args a fns ya mockeadas. (Auto-blindaje WKH-101/WKH-121 recurrente.) |
| Filtrar ownership con `.eq('id')` sin `.eq('owner_ref')` → IDOR | B | A | CD-1; test AC-3 verifica 404 y assert de la cadena `.eq('owner_ref', ...)`. |
| Leak de msg crudo de PG en error path | B | M | CD-7; handler mapea por `instanceof` y fallback genérico sin `err.message`. (Auto-blindaje WKH-101 fix-pack.) |

## 8. Dependencias

- WKH-121 (DONE, prod): columna `revoked_at` + check en middleware ya existen.
- Imports ya presentes en `auth.ts` (`keySessionService`, `SessionNotAllowedError`, `OwnershipMismatchError`, `rawKeyFromRequest`, `KEY_SESSION_TOKEN_PREFIX`); solo agregar `SessionNotFoundError`.

## 9. Missing Inputs — RESUELTOS

- **[RESUELTO] `SessionNotFoundError` no existe en `errors.ts`** → se **crea** en W0 (`code='SESSION_NOT_FOUND'`), tras `SessionNotAllowedError` (L319). Verificado por Read del archivo completo (396 L).
- **[RESUELTO] Ubicación del test AC-2** → **test de integración del middleware**, en `src/middleware/a2a-key.test.ts` (branch key-session, `describe` existente L1450). El test "revoked session → 403 SESSION_TOKEN_INVALID (pre-debit)" (L1543-1556) **ya existe** desde WKH-121: se **refuerza/anota** como cobertura explícita de AC-2 (regresión con token revocado vía `makeKeySessionRow({ revoked_at: ... })`). No se crea archivo nuevo de middleware.

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| — | — | Ninguno. Todos los inputs resueltos. | No |

---

## Plan de Implementación (Waves)

> Sin TBDs: todos resueltos en F2.

### Wave 0 (Serial Gate) — tipos/errores
- [ ] **W0.1**: `SessionNotFoundError` en `src/services/security/errors.ts` (tras L319). Exemplar: `errors.ts:313-319`. Verificación: `tsc`.

### Wave 1 (depende de W0) — service
- [ ] **W1.1**: `keySessionService.revoke(sessionId: string, ownerId: string): Promise<void>` en `src/services/key-session.ts` (entre L319 y L321) + import `SessionNotFoundError`. Exemplar: `delegation.ts:351-371`. CD-1/CD-3/CD-6/CD-7/CD-10.

### Wave 2 (depende de W1) — ruta
- [ ] **W2.1**: `DELETE /key-session/:id` en `src/routes/auth.ts` (tras L1173) + import `SessionNotFoundError`. Gate sub-sesión (CD-5/CD-8) + `resolveCallerKey` + `revoke` + mapeo `instanceof SessionNotFoundError`→404 / fallback→500. Exemplar: `auth.ts:1054-1083` + `1114-1120`.

### Wave 3 (depende de W1+W2) — tests
- [ ] **W3.1**: `src/services/key-session.test.ts` — tests de `revoke` (AC-1/AC-4/AC-7 happy+idempotente, AC-3 0-rows→`SessionNotFoundError`). Exemplar: `key-session.test.ts` `chainMock`.
- [ ] **W3.2**: `src/routes/auth.key-session.test.ts` (NUEVO) — AC-1/AC-3/AC-4/AC-5. Exemplar: `auth.delegation.test.ts`.
- [ ] **W3.3**: `src/middleware/a2a-key.test.ts` — anotar L1543-1556 como AC-2 (regresión). Exemplar: test existente.

### Archivos involucrados

| Archivo | Existe | Acción | Wave | Exemplar |
|---------|--------|--------|------|----------|
| `src/services/security/errors.ts` | Sí | Modificar | W0.1 | `errors.ts:313-319` |
| `src/services/key-session.ts` | Sí | Modificar | W1.1 | `delegation.ts:351-371` |
| `src/routes/auth.ts` | Sí | Modificar | W2.1 | `auth.ts:1054-1083` |
| `src/services/key-session.test.ts` | Sí | Modificar | W3.1 | `key-session.test.ts` |
| `src/routes/auth.key-session.test.ts` | No | Crear | W3.2 | `auth.delegation.test.ts` |
| `src/middleware/a2a-key.test.ts` | Sí | Modificar | W3.3 | L1543-1556 |

### Test Plan (≥1 por AC)

| Test | AC | Archivo | Wave |
|------|-----|---------|------|
| `DELETE` happy del owner → 200 `{revoked:true}`, `revoke` llamado con `(id, owner_ref)` | AC-1, AC-7 | `auth.key-session.test.ts` | W3.2 |
| middleware: sesión `revoked_at != null` → 403 `SESSION_TOKEN_INVALID`, sin debit | AC-2 | `a2a-key.test.ts` (L1543, anotado) | W3.3 |
| `DELETE` id inexistente / de otro owner → 404 `SESSION_NOT_FOUND` (service 0-rows→`SessionNotFoundError`) | AC-3 | `auth.key-session.test.ts` + `key-session.test.ts` | W3.1/W3.2 |
| `DELETE` 2ª vez sobre sesión ya revocada del caller → 200 `{revoked:true}` | AC-4 | `auth.key-session.test.ts` + `key-session.test.ts` | W3.1/W3.2 |
| `DELETE` con `wasi_a2a_sess_*` autenticador → 403 `SESSION_NOT_ALLOWED`, `resolveCallerKey`/lookup NO llamado | AC-5 | `auth.key-session.test.ts` | W3.2 |
| Regresión: `DELETE /delegation/:id` sigue 200/403 + branch `wasi_a2a_session_*` intacto | AC-6 | `auth.delegation.test.ts` (existente, no se rompe) | — |
| `revoke` service: assert cadena incluye `.eq('owner_ref', ownerId)` antes de resolver | AC-7 | `key-session.test.ts` | W3.1 |

### Verificación Incremental

| Wave | Verificación |
|------|--------------|
| W0 | `tsc` (npm run build / typecheck) |
| W1 | `tsc` + `vitest src/services/key-session.test.ts` |
| W2 | `tsc` |
| W3 | `vitest` completo + `npm run format` antes de `npm run lint` (auto-blindaje WKH-101 W5) |

### Estimación

- Archivos nuevos: 1 (`auth.key-session.test.ts`)
- Archivos modificados: 5
- Tests nuevos: ~7
- Líneas estimadas: ~150 (prod ~45, tests ~105)

---

## Readiness Check

```
[x] Cada AC tiene al menos 1 archivo asociado en tabla 4.1 / Test Plan
[x] Cada archivo en 4.1 tiene Exemplar verificado con Read/Glob (paths + líneas reales)
[x] No hay [NEEDS CLARIFICATION] pendientes (ambos Missing Inputs resueltos §9)
[x] Constraint Directives incluyen ≥3 PROHIBIDO (CD-3,4,6,7,11 + sección PROHIBIDO general)
[x] Context Map tiene ≥2 archivos leídos (8 archivos)
[x] Scope IN y OUT explícitos y no ambiguos
[x] BD: tabla a2a_key_sessions verificada que existe, revoked_at presente, sin migración
[x] Happy Path completo (§4.4)
[x] Flujo de error definido (§4.5, 4 casos)
```

**SDD listo para SPEC_APPROVED.**

---

*SDD generado por NexusAgil — FULL — Architect F2*
