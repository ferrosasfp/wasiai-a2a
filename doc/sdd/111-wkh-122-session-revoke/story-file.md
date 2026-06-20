# Story File — #111: [WKH-122] Revocación granular e instantánea de session keys

> SDD: doc/sdd/111-wkh-122-session-revoke/sdd.md
> Fecha: 2026-06-19
> Branch: feat/111-wkh-122-session-revoke

> ⚠️ Este documento es AUTOCONTENIDO. NO leas el SDD ni el work-item.
> Todo lo que necesitás para implementar está acá. Si algo falta → PARÁ y escalá a Architect (ver Escalation Rule al final). NO inventes.

---

## Goal

Construir la **revocación granular e inmediata de UNA session key** (`wasi_a2a_sess_*`) por parte del owner de la master key, **sin** matar la master ni las demás sesiones activas. La HU agrega exactamente dos piezas productivas:

1. `keySessionService.revoke(sessionId: string, ownerId: string): Promise<void>` — UPDATE `revoked_at = now()` filtrado por `id` + `owner_ref`.
2. Ruta `DELETE /auth/key-session/:id` — autentica con master key, gatea sub-sesiones, delega en el service.

Ambas **espejan el patrón ya en producción de WKH-101** (`delegationService.revoke` + `DELETE /auth/delegation/:id`), con UNA divergencia deliberada (ver abajo).

**Por qué:** paridad con Kite Agent Passport, que revoca por sesión. Hoy el único corte de blast radius es `deactivate` de la master key (mata TODO). WKH-122 permite cortar una sola sesión comprometida.

**Efecto inmediato (NO requiere trabajo nuevo):** el middleware del branch `wasi_a2a_sess_` (`src/middleware/a2a-key.ts:480-486`, WKH-121, en prod) **YA rechaza** sesiones con `revoked_at != null` con 403 `SESSION_TOKEN_INVALID`, sin caché (lookup directo a Supabase por hash). **Esta HU NO toca el middleware** — solo agrega/anota un test de regresión.

**Divergencia deliberada vs WKH-101:** el ownership mismatch / id inexistente responde **404 `SESSION_NOT_FOUND`** (disclosure-safe — no revela si el id existe para otro owner), NO el 403 `OWNERSHIP_MISMATCH` de delegación. Esto requiere una clase de error nueva: `SessionNotFoundError` (verificado que NO existe hoy).

---

## Acceptance Criteria (EARS)

> Estos son los 7 ACs que QA verificará en F4. NO se reescriben.

- **AC-1 (revocación exitosa):** WHEN `DELETE /auth/key-session/:id` es invocado por el owner de la sesión con una master key activa, THEN the system SHALL setear `revoked_at = now()` en la fila de `a2a_key_sessions` y responder HTTP 200 con `{ "revoked": true }`.
- **AC-2 (efecto inmediato en el middleware):** WHEN una sesión tiene `revoked_at != null`, the system SHALL rechazar cualquier request del branch `wasi_a2a_sess_` con HTTP 403 y `error_code: "SESSION_TOKEN_INVALID"` sin delay de caché. *(Ya cubierto por WKH-121; test de regresión obligatorio — NO se modifica el middleware.)*
- **AC-3 (ownership guard disclosure-safe):** IF el `session_id` no existe O pertenece a un `owner_ref` distinto al de la master key autenticada, THEN the system SHALL responder HTTP 404 con `{ "error_code": "SESSION_NOT_FOUND" }` (no revelar si el id existe para otro owner).
- **AC-4 (idempotencia):** WHEN `DELETE /auth/key-session/:id` es invocado sobre una sesión ya revocada que pertenece al caller, the system SHALL responder HTTP 200 con `{ "revoked": true }` sin error (el UPDATE refresca `revoked_at`; 0 rows solo indica ownership mismatch o id inexistente).
- **AC-5 (sub-revocación prohibida):** IF `DELETE /auth/key-session/:id` es invocado con un token de sesión `wasi_a2a_sess_*` como autenticador, THEN the system SHALL responder HTTP 403 con `{ "error_code": "SESSION_NOT_ALLOWED" }` (gate igual que `POST /key-session`).
- **AC-6 (no romper deactivate ni WKH-101):** WHILE `identity.deactivate(keyId)` desactiva la master key, the system SHALL no modificar el comportamiento de `DELETE /auth/delegation/:id` ni el branch `wasi_a2a_session_*` del middleware.
- **AC-7 (ownerId obligatorio en el service):** WHEN `keySessionService.revoke` es invocado, the system SHALL requerir `ownerId: string` (no `string | undefined`) en su firma y filtrar por `.eq('id', sessionId).eq('owner_ref', ownerId)` antes del UPDATE.

---

## Files to Modify/Create

> Lista EXHAUSTIVA. NO tocar ningún archivo fuera de esta tabla.

| # | Archivo | Acción | Qué hacer | Exemplar | Wave |
|---|---------|--------|-----------|----------|------|
| 1 | `src/services/security/errors.ts` | Modificar | Agregar `SessionNotFoundError` (`code = 'SESSION_NOT_FOUND' as const`) inmediatamente DESPUÉS de `SessionNotAllowedError` (cierra L319). NO tocar el enum `OwnershipOp` (`'keySessionRevoke'` ya existe). | `SessionNotAllowedError` (`errors.ts:313-319`) | W0 |
| 2 | `src/services/key-session.ts` | Modificar | Agregar `async revoke(sessionId: string, ownerId: string): Promise<void>` ENTRE `list` (cierra L319) y `debitSessionAndParent` (abre L321). Importar `SessionNotFoundError` en el bloque de imports de errores (L28-38). | `delegationService.revoke` (`delegation.ts:351-371`) | W1 |
| 3 | `src/routes/auth.ts` | Modificar | Agregar `fastify.delete('/key-session/:id', …)` (path interno **SIN** `/auth`) inmediatamente DESPUÉS del `GET /key-session` (cierra L1173). Gate sub-sesión (CD-5/CD-8) + `resolveCallerKey` + `revoke` + mapeo `instanceof SessionNotFoundError` → 404 / fallback → 500. Importar `SessionNotFoundError`. | `DELETE /delegation/:id` (`auth.ts:1054-1083`) + gate (`auth.ts:1114-1120`) | W2 |
| 4 | `src/services/key-session.test.ts` | Modificar | Tests del nuevo `revoke`: happy (AC-1/AC-7 con assert `.eq('owner_ref', ownerId)`), idempotente (AC-4), 0-rows → `SessionNotFoundError` (AC-3). | builder `chainMock` + create tests (este mismo archivo) | W3 |
| 5 | `src/routes/auth.key-session.test.ts` | **Crear** | Route tests: AC-1 (200 `{revoked:true}`, `revoke` llamado con `(id, owner_ref)`), AC-3 (404 `SESSION_NOT_FOUND`), AC-4 (idempotente 200), AC-5 (403 `SESSION_NOT_ALLOWED`, `revoke` NOT called). | `src/routes/auth.delegation.test.ts` (T11/T13/T16) | W3 |
| 6 | `src/middleware/a2a-key.test.ts` | Modificar | Reforzar/anotar el test existente "revoked session → 403 SESSION_TOKEN_INVALID (pre-debit)" (L1543-1556) como cobertura explícita de **AC-2** (regresión con token revocado). NO cambiar la lógica del test, solo el comentario/anotación AC-2. | test existente `a2a-key.test.ts:1543-1556` | W3 |

> **NO hay migración.** La columna `revoked_at` (nullable timestamptz) ya existe en `a2a_key_sessions` (WKH-121, prod). Verificado: `keySessionService.list` ya la selecciona (`key-session.ts:275`).

---

## Contrato de Integración ⚠️ BLOQUEANTE

> Esta HU comunica: cliente HTTP ↔ endpoint REST `DELETE /auth/key-session/:id` ↔ `keySessionService.revoke` ↔ tabla Supabase.

### Cliente → `DELETE /auth/key-session/:id` (revocar una sesión)

**Request:** autenticado con la **master key** del owner (`wasi_a2a_<…>` vía header `x-a2a-key` o `Bearer`, exactamente igual que `DELETE /auth/delegation/:id`). `:id` es el `session_id` (UUID) de la sesión a revocar. Sin body.

**Response exitoso (200):**
```json
{ "revoked": true }
```

**Errores:**

| HTTP | body | Cuándo |
|---|---|---|
| 403 | `{ "error_code": "SESSION_NOT_ALLOWED" }` | el caller se autenticó con un token `wasi_a2a_sess_*` (sub-revocación prohibida, AC-5). Detectado por el gate ANTES de `resolveCallerKey`. |
| 403 | `{ "error": "Invalid or inactive API key" }` | master key inválida o `is_active = false` (resultado de `resolveCallerKey` null / inactiva). Mismo shape que `/delegation`. |
| 404 | `{ "error_code": "SESSION_NOT_FOUND" }` | el `session_id` no existe O pertenece a otro `owner_ref` (disclosure-safe, AC-3). |
| 500 | `{ "error_code": "KEY_SESSION_REVOKE_FAILED" }` | error inesperado de BD. Loguear `errorClass` (`err.constructor.name`), **NUNCA** el `error.message` crudo de PG (CD-7). |

### `keySessionService.revoke(sessionId, ownerId)` (service)

- **Firma exacta:** `async revoke(sessionId: string, ownerId: string): Promise<void>` — `ownerId` es `string` ESTRICTO (NO `string | undefined`, CD-1/CD-3/AC-7).
- **Query:** `supabase.from('a2a_key_sessions').update({ revoked_at: new Date().toISOString() }).eq('id', sessionId).eq('owner_ref', ownerId).select('id')`.
- **`if (error)`** → `throw new Error('Failed to revoke key session: …')` (mensaje interno; el handler NUNCA lo expone, CD-7).
- **`if (!data || data.length === 0)`** → `logOwnershipMismatch({ op: 'keySessionRevoke', resourceId: sessionId, callerOwnerRef: ownerId })` + `throw new SessionNotFoundError()`.
- **Éxito (≥1 row matcheado):** retorna `void`. Idempotente: si la sesión ya estaba revocada, el UPDATE matchea igual el row del owner y refresca `revoked_at` → sigue siendo 1 row → NO lanza (AC-4).

---

## Anti-Hallucination Checklist (específico WKH-122)

Antes de escribir cada archivo, confirmá:

- [ ] **NO creo migración.** `revoked_at` ya existe en `a2a_key_sessions` (WKH-121, prod). NO hay archivos `supabase/migrations/*`.
- [ ] **NO toco el middleware** (`src/middleware/a2a-key.ts`). El check `if (session.revoked_at !== null)` → 403 `SESSION_TOKEN_INVALID` ya existe (L480-486). Solo se anota un test de regresión (AC-2).
- [ ] **NO toco el branch EIP-712 de WKH-101** (`delegationService`, `a2a_delegations`, `DELETE /auth/delegation/:id`, branch `wasi_a2a_session_*` del middleware). Solo lo USO como exemplar.
- [ ] La firma del service es `revoke(sessionId: string, ownerId: string)` — `ownerId` es `string` ESTRICTO, NO `string | undefined` (CD-1/CD-3/AC-7).
- [ ] La query del service incluye **ambos** `.eq('id', sessionId)` Y `.eq('owner_ref', ownerId)` antes del `.select('id')` (Ownership Guard, evita IDOR).
- [ ] Idempotencia vía UPDATE siempre-ejecutado: `0 rows` → `SessionNotFoundError` (id inexistente o de otro owner); `≥1 row` (incluso ya revocada) → OK sin error (CD / AC-4).
- [ ] El error de id inexistente / otro owner es **404 `SESSION_NOT_FOUND`**, NO 403 `OWNERSHIP_MISMATCH` (CD-6 — divergencia deliberada del patrón delegación; NO copiar el 403 del exemplar).
- [ ] El gate de sub-sesión rechaza `wasi_a2a_sess_*` como autenticador con **403 `SESSION_NOT_ALLOWED`** y corre **ANTES** de `resolveCallerKey` (CD-5).
- [ ] El path interno de la ruta es `/key-session/:id` (SIN `/auth`). El prefix `/auth` lo agrega `src/index.ts` al registrar `authRoutes`. Si ponés `/auth/key-session/:id` → URL real `/auth/auth/key-session/:id` → MAL (CD-8, auto-blindaje WKH-101 W2).
- [ ] **NO propago el `error.message` crudo de Postgres** al body en ningún error path (CD-7). El fallback 500 logea solo `errorClass`.
- [ ] **NO agrego caché** de sesiones entre la revocación y el chequeo del middleware. Efecto inmediato (hot path consulta Supabase directo, CD-4).
- [ ] El handler mapea por `instanceof SessionNotFoundError` (NO string-matching) → 404; fallback → 500 (CD-9).
- [ ] `op` en `logOwnershipMismatch` es exactamente `'keySessionRevoke'` (literal YA presente en el enum `OwnershipOp`, `errors.ts:335` — NO agregar valor nuevo) (CD-10).
- [ ] Uso la **forma OBJETO** de `logOwnershipMismatch({ op, resourceId, callerOwnerRef })`, NO el overload posicional (que solo acepta `'getBalance' | 'deactivate'`).
- [ ] TS strict: sin `any`, sin `as unknown`, sin `@ts-ignore` (CD-11).
- [ ] **NO agrego dependencias nuevas.** Todos los imports que necesito ya existen en `auth.ts` (`keySessionService`, `SessionNotAllowedError`, `OwnershipMismatchError`, `rawKeyFromRequest`, `KEY_SESSION_TOKEN_PREFIX`, `resolveCallerKey`); solo agrego `SessionNotFoundError`.
- [ ] **Cuidado con `toHaveBeenCalledWith`** en tests: `revoke` es función NUEVA, no cambia la firma de fns ya mockeadas. NO agrego args a funciones existentes. (Auto-blindaje WKH-101/WKH-121 recurrente: aserciones de arity rotas al mutar firmas.)

---

## Exemplars

> Fragmentos reales del codebase. Seguilos como patrón. Todos los paths y line ranges verificados.

### Exemplar 1: `revoke` del service (blueprint exacto)
**Archivo**: `src/services/delegation.ts:351-371`
**Usar para**: archivo #2 (`keySessionService.revoke`)
```ts
async revoke(delegationId: string, ownerRef: string): Promise<void> {
  const { data, error } = await supabase
    .from('a2a_delegations')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', delegationId)
    .eq('owner_ref', ownerRef)
    .select('id');

  if (error) {
    throw new Error(`Failed to revoke delegation: ${error.message}`);
  }

  if (!data || data.length === 0) {
    logOwnershipMismatch({
      op: 'delegationRevoke',
      resourceId: delegationId,
      callerOwnerRef: ownerRef,
    });
    throw new OwnershipMismatchError();
  }
},
```
**Diferencias WKH-122 (3 cambios, el resto IDÉNTICO):**
1. Tabla: `'a2a_key_sessions'` (no `'a2a_delegations'`).
2. `op: 'keySessionRevoke'` (no `'delegationRevoke'`).
3. `throw new SessionNotFoundError()` (no `OwnershipMismatchError`).
Firma destino: `async revoke(sessionId: string, ownerId: string): Promise<void>`. Ubicación: entre `list` (cierra L319) y `debitSessionAndParent` (abre L321).

### Exemplar 2: handler `DELETE` (estructura del route)
**Archivo**: `src/routes/auth.ts:1054-1083`
**Usar para**: archivo #3 (`DELETE /key-session/:id`)
```ts
fastify.delete(
  '/delegation/:id',
  async (
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) => {
    const callerKey = await resolveCallerKey(req);
    if (!callerKey?.is_active) {
      return reply.status(403).send({ error: 'Invalid or inactive API key' });
    }

    try {
      await delegationService.revoke(req.params.id, callerKey.owner_ref);
      return reply.status(200).send({ revoked: true });
    } catch (err) {
      if (err instanceof OwnershipMismatchError) {
        return reply.status(403).send({ error_code: 'OWNERSHIP_MISMATCH' });
      }
      fastify.log.error(
        {
          errorClass: err instanceof Error ? err.constructor.name : 'unknown',
        },
        'delegation revoke failed',
      );
      return reply
        .status(500)
        .send({ error_code: 'DELEGATION_REVOKE_FAILED' });
    }
  },
);
```
**Diferencias WKH-122:**
1. Path `'/key-session/:id'`.
2. **Agregar el gate de sub-sesión ANTES de `resolveCallerKey`** (ver Exemplar 3).
3. `keySessionService.revoke(req.params.id, callerKey.owner_ref)`.
4. El catch mapea `instanceof SessionNotFoundError` → **404** `{ error_code: 'SESSION_NOT_FOUND' }` (NO 403 OWNERSHIP_MISMATCH).
5. Fallback 500 → `{ error_code: 'KEY_SESSION_REVOKE_FAILED' }` + log con `errorClass` (sin msg crudo).

### Exemplar 3: gate de sub-sesión (ANTES de `resolveCallerKey`)
**Archivo**: `src/routes/auth.ts:1114-1120` (dentro de `POST /key-session`)
**Usar para**: el bloque inicial del handler `DELETE /key-session/:id`
```ts
const rawKey = rawKeyFromRequest(req);
if (rawKey?.startsWith(KEY_SESSION_TOKEN_PREFIX)) {
  const err = new SessionNotAllowedError();
  return reply.status(403).send({ error_code: err.code });
}
```
- `KEY_SESSION_TOKEN_PREFIX = 'wasi_a2a_sess_'` ya está definido (`auth.ts:270`). NO hardcodear el literal.
- `rawKeyFromRequest` (`auth.ts:147`) y `SessionNotAllowedError` (importado en `auth.ts:47`) YA existen.
- Este bloque va PRIMERO en el handler, ANTES de `await resolveCallerKey(req)`. Si va después, `resolveCallerKey` ya devolvió null y se pierde el código exacto.

### Exemplar 4: `SessionNotFoundError` (molde)
**Archivo**: `src/services/security/errors.ts:313-319` (`SessionNotAllowedError`)
**Usar para**: archivo #1
```ts
export class SessionNotAllowedError extends Error {
  readonly code = 'SESSION_NOT_ALLOWED' as const;
  constructor() {
    super('Sub-delegation is not allowed');
    this.name = 'SessionNotAllowedError';
  }
}
```
**La clase nueva (insertar tras L319):**
```ts
export class SessionNotFoundError extends Error {
  readonly code = 'SESSION_NOT_FOUND' as const;
  constructor() {
    super('Key session not found');
    this.name = 'SessionNotFoundError';
  }
}
```
> El enum `OwnershipOp` (`errors.ts:328-336`) YA incluye `'keySessionRevoke'` — NO lo modifiques.

### Exemplar 5: query con ownership guard (referencia de patrón)
**Archivo**: `src/services/key-session.ts:271-319` (`list`)
**Usar para**: confirmar el shape de la cadena Supabase y el `.eq('owner_ref', …)`. `list` usa `.eq('owner_ref', ownerRef)` + manejo de `error`. Tu `revoke` reusa el mismo cliente `supabase` ya importado en el archivo.

### Exemplar 6: check de revocación del middleware (NO se toca — solo se anota)
**Archivo**: `src/middleware/a2a-key.ts:480-486`
```ts
if (session.revoked_at !== null) {
  return send403session(
    reply,
    'SESSION_TOKEN_INVALID',
    'Session token has been revoked',
  );
}
```
> **NO MODIFICAR.** Esto ya cubre AC-2. Solo se refuerza/anota el test que lo ejercita (archivo #6).

### Exemplar 7: route test (Fastify in-process + mock service)
**Archivo**: `src/routes/auth.delegation.test.ts` (369 L) — patrones T11 (revoke 200), T13 (ownership → error mapeado), T16 (sub-delegation 403, mock del lookup NOT called)
**Usar para**: archivo #5 (`auth.key-session.test.ts`, NUEVO)
**Patrón clave:** `vi.mock` del service (`keySessionService` con `mockRevoke`), `app.inject({ method: 'DELETE', url: '/auth/key-session/<id>', headers: { 'x-a2a-key' / Bearer master } })`, `app.register(authRoutes, { prefix: '/auth' })`, `MASTER_KEY = wasi_a2a_<64 hex>`, helper `makeKeyRow`. Asserts de `res.statusCode` + `res.json().error_code` + `mockRevoke` llamado con `(id, owner_ref)` (AC-1/AC-7) o NOT called (AC-5).

### Exemplar 8: service test (mock supabase chainable)
**Archivo**: `src/services/key-session.test.ts` — builder `chainMock()` (L88-105: `select`/`insert`/`update`/`eq` retornan `this`; `single`/`order` resuelven), `vi.mock('../lib/supabase.js')`, `mockFrom`
**Usar para**: archivo #4 (tests de `revoke`)
**Patrón clave:** configurar el `chainMock` para que `.select('id')` resuelva con `{ data: [{ id }], error: null }` (happy/idempotente) o `{ data: [], error: null }` (0-rows → `SessionNotFoundError`). Assert de que la cadena recibió `.eq('owner_ref', ownerId)` (AC-7).

---

## Constraint Directives

### OBLIGATORIO
- **CD-1:** `keySessionService.revoke` recibe `ownerId: string` (no `string | undefined`); la query incluye `.eq('owner_ref', ownerId)` además de `.eq('id', sessionId)`. Violación → BLOQUEANTE en AR (IDOR).
- **CD-5:** el `DELETE /key-session/:id` tiene el gate de sub-sesión (`wasi_a2a_sess_*` → 403 `SESSION_NOT_ALLOWED`) ANTES de `resolveCallerKey`.
- **CD-8:** el path INTERNO de la ruta en el plugin `authRoutes` es `/key-session/:id` (SIN `/auth`). El prefix `/auth` lo agrega `src/index.ts`. (Auto-blindaje WKH-101 W2: bug `/auth/auth/delegation` por duplicar prefix.)
- **CD-9:** el handler mapea la clase de error vía `instanceof` (no string-matching): `SessionNotFoundError` → 404, fallback → 500.
- **CD-10:** `op` en `logOwnershipMismatch` debe ser exactamente `'keySessionRevoke'` (ya en el enum `OwnershipOp`; NO agregar valor nuevo).

### PROHIBIDO
- **CD-2:** NO modificar el middleware `wasi_a2a_sess_` (`src/middleware/a2a-key.ts`). El check `revoked_at !== null` ya existe.
- **CD-3:** NO usar `string | undefined` para `ownerId`. Type `string` estricto.
- **CD-4:** NO agregar caché de sesiones entre la revocación y el chequeo del middleware. Efecto inmediato.
- **CD-6:** NO responder 403 `OWNERSHIP_MISMATCH` para id inexistente / de otro owner. Debe ser **404 `SESSION_NOT_FOUND`**.
- **CD-7:** NO propagar el `error.message` crudo de Postgres al cliente en ningún error path.
- **CD-11:** NO agregar dependencias nuevas ni `any` / `as unknown` / `@ts-ignore` (TS strict).
- NO crear migración (la columna `revoked_at` ya existe).
- NO tocar `delegation.ts`, `DELETE /auth/delegation/:id`, ni el branch `wasi_a2a_session_*`.
- NO hardcodear el prefijo de token (reusar `KEY_SESSION_TOKEN_PREFIX`).
- NO modificar archivos fuera de la tabla "Files to Modify/Create".
- NO "mejorar" código adyacente ni refactorizar lo existente.

---

## Test Expectations

> Framework del proyecto: **vitest**. ≥1 test por AC. Mock `../lib/supabase.js` (service tests) y mock del service `keySessionService` (route tests); Fastify in-process para rutas/middleware.

| Test (id) | AC | Archivo | Qué verifica |
|---|---|---|---|
| T-REVOKE-OK | AC-1, AC-7 | `src/routes/auth.key-session.test.ts` | `DELETE /auth/key-session/<id>` con master key activa → 200 `{ revoked: true }`; `keySessionService.revoke` llamado con `(<id>, <owner_ref>)`. |
| T-SVC-OWNERSHIP | AC-7 | `src/services/key-session.test.ts` | `revoke` ejecuta el UPDATE y la cadena incluye `.eq('id', sessionId)` Y `.eq('owner_ref', ownerId)` antes de resolver; firma exige `ownerId: string`. |
| T-MW-REVOKED (anotado) | AC-2 | `src/middleware/a2a-key.test.ts:1543-1556` | sesión con `revoked_at != null` (`makeKeySessionRow({ revoked_at: … })`) → branch `wasi_a2a_sess_` rechaza con 403 `SESSION_TOKEN_INVALID`, `mockSessionDebit` NOT called. **Test ya existente — anotar como AC-2 (regresión), NO cambiar lógica.** |
| T-NOTFOUND-ROUTE | AC-3 | `src/routes/auth.key-session.test.ts` | `revoke` mockeado lanza `SessionNotFoundError` → handler responde 404 `{ error_code: 'SESSION_NOT_FOUND' }`. |
| T-NOTFOUND-SVC | AC-3 | `src/services/key-session.test.ts` | `.select('id')` resuelve `{ data: [], error: null }` (0 rows) → `revoke` lanza `SessionNotFoundError` y llama `logOwnershipMismatch({ op: 'keySessionRevoke', … })`. |
| T-IDEMPOTENT-ROUTE | AC-4 | `src/routes/auth.key-session.test.ts` | 2ª invocación sobre sesión ya revocada del caller (`revoke` resuelve void) → 200 `{ revoked: true }` sin error. |
| T-IDEMPOTENT-SVC | AC-4 | `src/services/key-session.test.ts` | `.select('id')` resuelve `{ data: [{ id }], error: null }` (≥1 row, ya revocada) → `revoke` retorna void sin lanzar. |
| T-SUBSESSION | AC-5 | `src/routes/auth.key-session.test.ts` | autenticador `wasi_a2a_sess_*` → 403 `{ error_code: 'SESSION_NOT_ALLOWED' }`; `keySessionService.revoke` NOT called (gate corta antes). |
| T-NO-REGRESSION (existente) | AC-6 | `src/routes/auth.delegation.test.ts` (existente, no se rompe) | `DELETE /delegation/:id` sigue 200/403 y el branch `wasi_a2a_session_*` queda intacto. La suite completa de delegación + WKH-121 debe pasar sin cambios. |

### Criterio Test-First
Lógica de negocio (`revoke`, error mapping, ownership guard) + API (endpoint) → **Test-first SÍ**.

---

## Waves

### Wave -1: Environment Gate (OBLIGATORIO — verificar antes de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a
npm install 2>/dev/null || echo "Sin package.json"
# Archivos base del Scope IN deben existir:
ls src/services/security/errors.ts src/services/key-session.ts \
   src/routes/auth.ts src/services/delegation.ts \
   src/services/key-session.test.ts src/routes/auth.delegation.test.ts \
   src/middleware/a2a-key.test.ts 2>/dev/null || echo "FALTA archivo base"
# NO debe existir aún (lo creás en W3):
ls src/routes/auth.key-session.test.ts 2>/dev/null && echo "OJO: ya existe" || echo "OK: a crear"
```
**Si algo falla en Wave -1:** PARAR y reportar al orquestador. No implementar sobre un entorno roto.

### Wave 0 (Serial Gate — error class)
- [ ] **W0.1:** `src/services/security/errors.ts` — agregar `SessionNotFoundError` (`code = 'SESSION_NOT_FOUND' as const` + `name`) tras `SessionNotAllowedError` (L319). NO tocar `OwnershipOp`. (Exemplar 4)
- **Verificación:** `npx tsc --noEmit` → 0 errores.

### Wave 1 (Service — depende de W0)
- [ ] **W1.1:** `src/services/key-session.ts` — agregar `async revoke(sessionId: string, ownerId: string): Promise<void>` entre `list` (L319) y `debitSessionAndParent` (L321); importar `SessionNotFoundError` en el bloque de imports de errores (L28-38). UPDATE owner-guarded → 0 rows → `logOwnershipMismatch({ op: 'keySessionRevoke', … })` + `SessionNotFoundError`. (Exemplar 1) — CD-1/CD-3/CD-6/CD-7/CD-10.
- **Verificación:** `npx tsc --noEmit` + `npx vitest run src/services/key-session.test.ts` (tras W3.1).

### Wave 2 (Route — depende de W1)
- [ ] **W2.1:** `src/routes/auth.ts` — agregar `fastify.delete('/key-session/:id', …)` tras el `GET /key-session` (L1173); importar `SessionNotFoundError`. Gate sub-sesión (Exemplar 3, CD-5/CD-8) → `resolveCallerKey` → `keySessionService.revoke(req.params.id, callerKey.owner_ref)` → 200 `{ revoked: true }`; catch `instanceof SessionNotFoundError` → 404, fallback → 500 `KEY_SESSION_REVOKE_FAILED`. (Exemplar 2) — CD-6/CD-7/CD-8/CD-9.
- **Verificación:** `npx tsc --noEmit`.

### Wave 3 (Tests — depende de W1 + W2)
- [ ] **W3.1:** `src/services/key-session.test.ts` — tests de `revoke`: happy/idempotente (AC-1/AC-4/AC-7) y 0-rows → `SessionNotFoundError` (AC-3). (Exemplar 8)
- [ ] **W3.2:** `src/routes/auth.key-session.test.ts` (**NUEVO**) — AC-1, AC-3, AC-4, AC-5. (Exemplar 7)
- [ ] **W3.3:** `src/middleware/a2a-key.test.ts` — anotar el test L1543-1556 como cobertura explícita de AC-2 (regresión). NO cambiar la lógica. (Exemplar 6)
- **Verificación:** `npx vitest run` completo (incluidos tests de WKH-121/WKH-101 — deben seguir verdes) + `npm run format` ANTES de `npm run lint`.

---

## Done Definition

El Dev marca la HU lista para AR cuando:

- [ ] Los 6 archivos de la tabla "Files to Modify/Create" están en su estado final (5 modificados + 1 creado). NINGÚN archivo fuera de la tabla fue tocado.
- [ ] `npx tsc --noEmit` → **0 errores** (TS strict, sin `any`/`as unknown`/`@ts-ignore`).
- [ ] `npm run format` ejecutado **ANTES** de `npm run lint` (auto-blindaje WKH-101 W5: el linter falla si el formateo no corrió primero).
- [ ] `npm run lint` → 0 errores.
- [ ] `npx vitest run` (suite completa) → **toda verde**, incluidos los tests de WKH-121 y WKH-101 sin regresión (delegación + key-sessions + middleware).
- [ ] Los **7 ACs** tienen cobertura de test según el Test Plan (AC-1..AC-7).
- [ ] El Anti-Hallucination Checklist está 100% confirmado.
- [ ] NO se creó migración. NO se modificó el middleware. NO se tocó el branch EIP-712 de WKH-101.

---

## Escalation Rule

Si durante la implementación encontrás CUALQUIERA de estos, **PARÁ y escalá al orquestador** (no inventes):

- Un exemplar (path o line range) no coincide con lo descrito acá → escalá (puede haber drift desde la generación del SDD).
- La columna `revoked_at` NO existe en `a2a_key_sessions` → escalá (el SDD asume WKH-121 en prod).
- El enum `OwnershipOp` NO incluye `'keySessionRevoke'` → escalá (CD-10 asume que ya está).
- `KEY_SESSION_TOKEN_PREFIX` o `rawKeyFromRequest` o `SessionNotAllowedError` no están importados en `auth.ts` → escalá.
- El test L1543-1556 de `a2a-key.test.ts` no existe o no ejercita `revoked_at` → escalá (AC-2 depende de él).
- Necesitás tocar un archivo fuera de la tabla → escalá (es señal de scope creep).

---

*Story File generado por NexusAgil — Architect F2.5 — autocontenido para nexus-dev.*
