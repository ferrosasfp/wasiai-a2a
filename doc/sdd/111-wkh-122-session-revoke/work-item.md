# Work Item — [WKH-122] Revocación granular e instantánea de session keys

## Resumen

El owner de una Agent Key puede revocar una session key individual (`wasi_a2a_sess_*`) sin afectar la master key ni las demás sesiones activas. La revocación es inmediata: el middleware del branch `wasi_a2a_sess_` ya rechaza sesiones con `revoked_at != null` (hallazgo de grounding WKH-121 — sin caché en este path). Esta HU agrega únicamente el endpoint de revocación y la función `revoke` en `key-session.ts`, espejando el patrón existente `DELETE /auth/delegation/:id` + `delegationService.revoke`.

## Sizing

- SDD_MODE: full
- Estimación: M
- Branch sugerido: `feat/111-wkh-122-session-revoke`

## Skills Router

- `identity-authz` — ownership guard, revocación de tokens efímeros
- `api-design` — REST endpoint pattern, idempotencia, disclosure-safe 404

## Hallazgos de grounding (F0)

### Middleware WKH-121 — check de revocación YA EXISTE

El branch `wasi_a2a_sess_` en `src/middleware/a2a-key.ts` (líneas 479-482) contiene:

```
if (session.revoked_at !== null) {
  return send403session(reply, 'SESSION_TOKEN_INVALID', 'Session token has been revoked');
}
```

Conclusión: el middleware YA rechaza sesiones revocadas con efecto inmediato. El scope del middleware NO entra en esta HU. No hay caché en este path (lookup directo a Supabase por hash).

### Tabla a2a_key_sessions — columna revoked_at ya existe

`keySessionService.list` (key-session.ts:276) ya selecciona `revoked_at` y lo usa para derivar `status: 'revoked'`. La columna existe en prod. No se necesita migración.

### Patron de revocación de delegaciones (WKH-101)

`delegationService.revoke(delegationId, ownerRef)` en `src/services/delegation.ts` (línea 351): UPDATE `revoked_at = now()` filtrado por `.eq('id', ...).eq('owner_ref', ...)`. Cero rows → `logOwnershipMismatch` + `OwnershipMismatchError`. Idempotente (el UPDATE refresca `revoked_at` aunque ya estuviera revocada — 0 rows solo ocurre si el id no pertenece al owner).

Patrón espejo para esta HU: `keySessionService.revoke(sessionId, ownerRef)`.

### Endpoint de revocación de delegaciones (WKH-101)

`DELETE /auth/delegation/:id` en `src/routes/auth.ts` (línea 1054): autentica con master key, llama `delegationService.revoke(id, callerKey.owner_ref)`, responde `{ revoked: true }` en 200. `OwnershipMismatchError` → 403 con `OWNERSHIP_MISMATCH` (disclosure-safe — no diferencia "no existe" de "no es tuyo").

### Gate de sub-sesión en POST /key-session

`POST /auth/key-session` ya tiene un gate que detecta si el autenticador es un `wasi_a2a_sess_*` y responde 403 `SESSION_NOT_ALLOWED`. El mismo gate aplica al endpoint de revocación (un token de sesión no puede revocar sesiones de otros).

### RPC debit_session_and_parent — TOCTOU safe

El RPC re-chequea `revoked_at` bajo `FOR UPDATE` en Postgres. La revocación desde el endpoint seteará `revoked_at = now()` directamente en la tabla; el RPC lo detectará en el próximo ciclo.

---

## Acceptance Criteria (EARS)

### AC-1 — Revocación exitosa

WHEN `DELETE /auth/key-session/:id` es invocado por el owner de la sesión con una master key activa, THEN the system SHALL setear `revoked_at = now()` en la fila de `a2a_key_sessions` correspondiente y responder HTTP 200 con `{ "revoked": true }`.

### AC-2 — Efecto inmediato en el middleware

WHEN una sesión tiene `revoked_at != null`, the system SHALL rechazar cualquier request que llegue al middleware `wasi_a2a_sess_` con HTTP 403 y `error_code: "SESSION_TOKEN_INVALID"` sin delay de caché.

> Nota: este AC ya está cubierto por WKH-121 (middleware líneas 479-482). El test de regresión lo debe verificar explícitamente con un token revocado.

### AC-3 — Ownership guard: sesión de otro owner → 404/403

IF el `session_id` solicitado no existe O pertenece a un `owner_ref` distinto al de la master key autenticada, THEN the system SHALL responder HTTP 404 con `{ "error_code": "SESSION_NOT_FOUND" }` (disclosure-safe — no revelar si el id existe para otro owner).

> DT-1: se elige 404 sobre 403 para evitar enumeration. El service lanza `SessionNotFoundError` en ambos casos (no existe + ownership mismatch). Difiere del patrón delegación (que usa 403 OWNERSHIP_MISMATCH) por ser disclosure-safe. Esta diferencia debe documentarse en el SDD.

### AC-4 — Idempotencia

WHEN `DELETE /auth/key-session/:id` es invocado sobre una sesión ya revocada que pertenece al caller, the system SHALL responder HTTP 200 con `{ "revoked": true }` sin error (el UPDATE refresca `revoked_at`; 0 rows solo indica ownership mismatch o id inexistente).

### AC-5 — Autenticación requerida master key

IF `DELETE /auth/key-session/:id` es invocado con un token de sesión `wasi_a2a_sess_*` como autenticador, THEN the system SHALL responder HTTP 403 con `{ "error_code": "SESSION_NOT_ALLOWED" }` (sub-revocación prohibida — igual que el gate de POST /key-session).

### AC-6 — No romper deactivate ni WKH-101

WHILE `identity.deactivate(keyId)` desactiva la master key, the system SHALL no modificar el comportamiento de revocación de delegaciones (`DELETE /auth/delegation/:id`) ni el branch `wasi_a2a_session_*` del middleware.

### AC-7 — Parámetro ownerId obligatorio en el service

WHEN `keySessionService.revoke` es invocado, the system SHALL requerir `ownerId: string` (no `string | undefined`) en su firma y filtrar por `.eq('id', sessionId).eq('owner_ref', ownerId)` antes de cualquier UPDATE.

---

## Scope IN

| Archivo | Cambio |
|---------|--------|
| `src/services/key-session.ts` | Agregar función `revoke(sessionId: string, ownerId: string): Promise<void>` con ownership guard + idempotencia |
| `src/routes/auth.ts` | Agregar `DELETE /key-session/:id` espejando `DELETE /delegation/:id`; gate de sub-sesión antes de `resolveCallerKey` |
| `src/services/security/errors.ts` | Verificar si existe `SessionNotFoundError`; agregar si no existe |
| Tests (vitest) | Al menos 1 test por AC: revocación OK, ownership mismatch → 404, idempotencia, sub-sesión → 403 |

## Scope OUT

- **Revocación masiva por key** (`deactivate` de master key) — ya existe en `identityService.deactivate`. Esta HU es granular (una sesión).
- **Auth por firma / passkey** — WKH-123.
- **Migración de base de datos** — `revoked_at` ya existe en `a2a_key_sessions` (WKH-121, confirmado en grounding).
- **Modificar el middleware `wasi_a2a_sess_`** — ya chequea `revoked_at` (WKH-121). Solo agregar test de regresión AC-2.
- **Modificar el branch delegación** (`wasi_a2a_session_*`) — out of scope.
- **Endpoint de revocación masiva de sesiones** — eso es `DELETE /auth/key-session` (sin id), fuera de esta HU.

---

## Decisiones técnicas (DT-N)

### DT-1 — Verbo HTTP: DELETE vs POST /revoke

Se elige `DELETE /auth/key-session/:id` (mismo patrón que `DELETE /auth/delegation/:id`, WKH-101). Justificación: REST semántico (DELETE sobre el recurso), consistencia interna del codebase, evita ambigüedad de routing con `POST /auth/key-session` (create).

### DT-2 — Respuesta de ownership mismatch: 404 vs 403

Se elige HTTP 404 con `SESSION_NOT_FOUND` (no `OWNERSHIP_MISMATCH`). Justificación: disclosure-safe — un caller no puede inferir si un session_id existe para otro owner. Difiere del patrón delegación (que usa 403 OWNERSHIP_MISMATCH) deliberadamente. El SDD debe documentar esta divergencia.

### DT-3 — Middleware: sin cambios de comportamiento

El middleware WKH-121 ya chequea `revoked_at !== null` en líneas 479-482. No se modifica el middleware. Solo se agrega un test de regresión explícito (AC-2).

### DT-4 — Idempotencia vía UPDATE siempre-ejecutado

Igual que `delegationService.revoke`: el UPDATE ejecuta siempre para el owner; 0 rows indica que el id no existe o pertenece a otro owner → `SessionNotFoundError`. Un row ya revocado también matchea el UPDATE (refresca `revoked_at`). Esto hace la operación naturalmente idempotente.

### DT-5 — Clase de error: SessionNotFoundError

Verificar en `src/services/security/errors.ts` si ya existe. Si no, agregar con `code = 'SESSION_NOT_FOUND'`. El handler mapea → 404.

---

## Constraint Directives (CD-N)

- **CD-1 OBLIGATORIO**: la función `keySessionService.revoke` DEBE recibir `ownerId: string` (no `string | undefined`) y la query Supabase DEBE incluir `.eq('owner_ref', ownerId)` además de `.eq('id', sessionId)`. Violación → BLOQUEANTE en AR.
- **CD-2 OBLIGATORIO**: el middleware `wasi_a2a_sess_` NO debe modificarse como parte de esta HU. Si el check `revoked_at !== null` no estuviera (confirmado: está), sería scope separado previo a esta HU.
- **CD-3 PROHIBIDO**: usar `string | undefined` para `ownerId` en la firma del service. El type debe ser `string` estricto.
- **CD-4 PROHIBIDO**: agregar caché de sesiones entre la revocación y el chequeo en el middleware. El efecto debe ser inmediato (hot path consulta Supabase directamente).
- **CD-5 OBLIGATORIO**: el endpoint `DELETE /key-session/:id` DEBE tener el gate de sub-sesión (detectar `wasi_a2a_sess_*` como autenticador ANTES de `resolveCallerKey`) igual que `POST /key-session`.
- **CD-6 PROHIBIDO**: la respuesta de error para id inexistente o de otro owner DEBE ser 404 `SESSION_NOT_FOUND` (no 403 OWNERSHIP_MISMATCH) — disclosure-safe.
- **CD-7 PROHIBIDO**: propagar el mensaje crudo de Postgres al cliente en ningún error path.

---

## Missing Inputs

- [resuelto en F2] Confirmar si `SessionNotFoundError` existe en `src/services/security/errors.ts` antes de agregar. El Architect debe verificar y documentar en el SDD.
- [resuelto en F2] Determinar si el test de AC-2 (middleware rechaza sesión revocada) va en `test/` como test de integración o como test unitario del middleware. El Architect decide en el SDD.

---

## Análisis de paralelismo

- **Depende de**: WKH-121 (DONE, en prod) — la columna `revoked_at` y el check en middleware ya existen.
- **Bloquea**: WKH-123 (auth por firma) no depende de WKH-122, pueden ir en paralelo. WKH-124 (proof-chain) tampoco depende directamente.
- **Puede ir en paralelo con**: cualquier HU que no toque `src/routes/auth.ts` ni `src/services/key-session.ts`. Si WKH-123 arranca antes, habrá conflicto de merge en `auth.ts` — coordinar.
- **Conflicto de merge potencial**: si WKH-123 toca `auth.ts` en paralelo, requiere coordinación de branch al merge.
