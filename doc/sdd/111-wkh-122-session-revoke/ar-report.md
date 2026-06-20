# Adversarial Review (AR) — WKH-122: Revocación granular de session keys

> Branch: `feat/111-wkh-122-session-revoke`
> Base: `origin/main` (incluye WKH-121 + WKH-101)
> Fecha: 2026-06-19
> Revisor: nexus-adversary
> Story File: `doc/sdd/111-wkh-122-session-revoke/story-file.md`

## Estado del entorno

- `npx tsc --noEmit` → **0 errores**.
- `npx vitest run` → **1429 passed | 3 skipped (1432)**, 90 test files passed | 2 skipped. Coincide con el esperado (~1429).
- `npm run lint` (biome) → exit 0. El único diagnóstico es un `info` pre-existente en `src/services/reputation.ts:116` (NO tocado por WKH-122, NO es error).

## Superficie revisada (diff)

Archivos productivos modificados (exactamente el Scope IN, 3 `.ts` de producción):
- `src/services/security/errors.ts` — `+SessionNotFoundError` (`code = 'SESSION_NOT_FOUND' as const`).
- `src/services/key-session.ts` — `+async revoke(sessionId, ownerId)`.
- `src/routes/auth.ts` — `+DELETE /key-session/:id` (path interno sin `/auth`).

Tests:
- `src/services/key-session.test.ts` (modificado) — `describe('revoke')`.
- `src/routes/auth.key-session.test.ts` (NUEVO).
- `src/middleware/a2a-key.test.ts` (modificado) — solo anotación de comentario AC-2, sin cambio de lógica.

Confirmado vía `git status --porcelain`:
- `src/middleware/a2a-key.ts` (producción) **NO modificado**.
- `src/services/delegation.ts` / `auth.delegation.test.ts` **NO modificados**.
- Sin migración (`supabase/migrations/*` sin cambios).
- Sin `any` / `@ts-ignore` / `as unknown` en código de producción.

---

## Categorías de ataque (8)

### 1. Security — **OK**

Foco principal de la HU. Verificado en profundidad:

- **Ownership Guard / IDOR (CD-1/AC-7):** `key-session.ts:331-336` la query es
  `.update({revoked_at}).eq('id', sessionId).eq('owner_ref', ownerId).select('id')`.
  Incluye **ambos** filtros. Firma `revoke(sessionId: string, ownerId: string)` —
  `ownerId` es `string` ESTRICTO (no `string | undefined`). El `ownerId` proviene de
  `callerKey.owner_ref` del caller autenticado (`auth.ts`), **nunca** del body/param
  (`req.params.id` solo alimenta `sessionId`). No hay vector IDOR.
- **Disclosure-safe (AC-3/CD-6):** id inexistente e id-de-otro-owner recorren el mismo
  camino → ambos producen `data.length === 0` → mismo `SessionNotFoundError` → 404
  `{error_code:'SESSION_NOT_FOUND'}` idéntico. No hay enumeración (no se distingue
  "existe pero ajeno" de "no existe"). Verificado en `key-session.ts:338-345` y mapeo
  en `auth.ts`.
- **Gate sub-sesión (AC-5/CD-5):** `auth.ts` el bloque
  `rawKeyFromRequest(req)` + `startsWith(KEY_SESSION_TOKEN_PREFIX)` → 403
  `SESSION_NOT_ALLOWED` corre **ANTES** de `resolveCallerKey`. El test
  `T-SUBSESSION` prueba que `mockLookupByHash` NOT called (gate corta antes de auth).
  No hay forma de que una sesión `wasi_a2a_sess_*` revoque otras sesiones.
- **Prefix boundaries (verificado por ejecución):**
  - Master key `wasi_a2a_<64hex>` NO matchea `wasi_a2a_sess_` → no cae en el gate. OK.
  - Token EIP-712 `wasi_a2a_session_*` (WKH-101) NO matchea `wasi_a2a_sess_` (la `i`
    en posición 13 rompe el prefix); igual es rechazado por `resolveCallerKey`
    (no es master key → `lookupByHash` null → 403 "Invalid or inactive API key").
    Comportamiento correcto, sin colisión de prefijos.
- No hay secrets en código, no hay SQL dinámico, no hay input sin validar (el único
  input externo es `:id`, que solo se usa como filtro `.eq('id', ...)` parametrizado
  por el cliente Supabase).

### 2. Error Handling — **OK**

- **Leak de PG (CD-7):** el handler (`auth.ts`) loguea solo
  `errorClass: err.constructor.name`, **nunca** `error.message`. El service envuelve el
  error de BD en `new Error('Failed to revoke key session: ...')` (mensaje interno) y el
  handler lo cae al fallback 500 `KEY_SESSION_REVOKE_FAILED` sin exponer el texto crudo.
- **Mapeo por instanceof (CD-9):** `instanceof SessionNotFoundError` → 404; fallback → 500.
  No hay string-matching frágil.
- **Auth inválida:** `!callerKey?.is_active` → 403 "Invalid or inactive API key" (mismo
  shape que `/delegation`).
- Sin errores silenciados; el path de error de BD propaga al 500.

### 3. Data Integrity — **OK**

- **Idempotencia (AC-4):** el UPDATE siempre se ejecuta; sobre una sesión ya revocada del
  owner sigue matcheando 1 row → refresca `revoked_at` → `≥1 row` → retorna void sin
  lanzar. Revocar 2 veces → 200/200. El segundo UPDATE no rompe nada (es un UPDATE
  idempotente sobre la misma fila).
- **Carrera revoke vs débito concurrente (TOCTOU):** el RPC `debit_session_and_parent`
  (`supabase/migrations/20260603000000_a2a_key_sessions.sql:44-66`, WKH-121, NO tocado)
  hace `SELECT ... revoked_at ... FOR UPDATE` y re-chequea `IF v_revoked IS NOT NULL THEN
  RAISE 'SESSION_REVOKED'`. El re-check está **bajo lock de fila**, así un débito que
  arranca después de que el revoke commitea ve `revoked_at` y aborta. Ventana TOCTOU
  cerrada. (Esto es WKH-121 prod, pero confirmado como cobertura del efecto inmediato.)
- **Efecto inmediato sin caché:** el middleware (`a2a-key.ts:480-486`, no tocado) hace
  lookup directo a Supabase por hash y rechaza `revoked_at != null` con 403
  `SESSION_TOKEN_INVALID`. La HU no introduce ninguna capa de caché entre revoke y rechazo.

### 4. Performance — **OK**

- `revoke` es un solo UPDATE indexado por PK (`id`) + `owner_ref`. Sin N+1, sin loops, sin
  operaciones bloqueantes. El handler hace 1 lookup (auth) + 1 UPDATE. No degrada hot path.

### 5. Integration / Backwards compat — **OK** (No regresión)

- `DELETE /auth/delegation/:id` (WKH-101) intacto — `delegation.ts` y su test no tocados.
- Branch EIP-712 `wasi_a2a_session_*` del middleware intacto.
- Branch `wasi_a2a_sess_*` del middleware (WKH-121) intacto.
- Path interno `/key-session/:id` SIN `/auth` (CD-8) — el prefix `/auth` lo agrega el
  registro de `authRoutes`. El test usa `url: '/auth/key-session/<id>'` y responde 200,
  confirmando que NO hay doble prefix `/auth/auth/...`.
- Suite completa verde (1429), incluidos WKH-121/WKH-101 sin regresión.

### 6. Type Safety — **OK**

- `revoke(sessionId: string, ownerId: string)` — sin `string | undefined`.
- `SessionNotFoundError.code = 'SESSION_NOT_FOUND' as const`.
- Sin `any` / `@ts-ignore` / `as unknown` en producción (verificado por grep sobre el diff
  de los 3 archivos productivos). `tsc --noEmit` 0 errores.
- Los `as unknown` presentes están solo en `key-session.test.ts`, son el patrón
  pre-existente del archivo (10 ocurrencias, el cast del `chainMock` mockeado) — no aplica
  CD-11 (que apunta a código de producción).

### 7. Test Coverage — **OK** (con 1 MENOR)

Cobertura por AC:
- AC-1/AC-7: `T-REVOKE-OK` (route, 200 + `revoke('sess-1','user-1')`) y `T-SVC-OWNERSHIP`
  (service, assert `.eq('id',...)` + `.eq('owner_ref',...)`).
- AC-2: `T-MW-REVOKED` anotado (regresión middleware, lógica intacta).
- AC-3: `T-NOTFOUND-ROUTE` (404) + `T-NOTFOUND-SVC` (0 rows → `SessionNotFoundError`, y
  assert `not.toBeInstanceOf(OwnershipMismatchError)` — confirma la divergencia CD-6).
- AC-4: `T-IDEMPOTENT-ROUTE` + `T-IDEMPOTENT-SVC`.
- AC-5: `T-SUBSESSION` (403 + `revoke`/`lookupByHash` NOT called).

Ver `MNR-1` abajo (assert faltante de `logOwnershipMismatch` en `T-NOTFOUND-SVC`).

### 8. Scope Drift — **OK**

- Solo los 6 archivos del Scope IN fueron tocados (5 mod + 1 nuevo). Confirmado por
  `git status --porcelain`: los únicos `.ts` de producción modificados son `auth.ts`,
  `key-session.ts`, `errors.ts`.
- Los untracked `doc/jury-qa*.md` y `doc/agent-key-vs-passport.md` están datados
  Jun 13-15 (pre-WKH-122, fecha 19-Jun) → **NO** son output de esta HU, son archivos
  preexistentes del repo.
- `BACKLOG.md` / `HACKATHON-FINAL.md` ya aparecían modificados en el git status inicial de
  la sesión, no atribuibles a WKH-122.
- `doc/sdd/_INDEX.md` + carpeta `doc/sdd/111-...` son los artefactos propios de la HU.
- Sin "mejoras" de código adyacente, sin refactors no autorizados.

---

## Categorías nuevas (9-11)

### 9. Destructive Migrations — **N/A**
La HU no crea ni modifica migraciones. `revoked_at` ya existe (WKH-121, prod). El
`supabase/migrations/*` no tiene cambios.

### 10. RPC con SECURITY DEFINER — **N/A** (sin cambios; nota informativa)
La HU no crea ni modifica RPCs. El `debit_session_and_parent` (`SECURITY DEFINER` con
`SET search_path = public, pg_temp` ya fijado, WKH-121) se inspeccionó solo para validar el
re-check de `revoked_at` bajo lock (ver Data Integrity); no fue tocado.

### 11. Cache Invalidation Logic — **N/A**
La HU explícitamente NO introduce caché (CD-4). El efecto de revocación es inmediato por
lookup directo a Supabase en el middleware. No hay nueva capa de cache que invalidar.

---

## Findings

### MNR-1 (Test Coverage) — MENOR
- **Archivo:** `src/services/key-session.test.ts` (`T-NOTFOUND-SVC`).
- **Descripción:** El Test Plan (T-NOTFOUND-SVC) pide verificar que en el camino de 0 rows
  se llama `logOwnershipMismatch({ op: 'keySessionRevoke', ... })`. El test asserta el tipo
  de error (`SessionNotFoundError`) y la divergencia (`not OwnershipMismatchError`) pero
  **no** asserta la invocación de `logOwnershipMismatch` ni el `op` literal.
- **Impacto:** Bajo. El código de producción SÍ llama `logOwnershipMismatch(...)` con
  `op: 'keySessionRevoke'` (`key-session.ts:343-347`, verificado), el `op` está en el enum
  `OwnershipOp` (`errors.ts:344`) y `tsc` valida el literal. El comportamiento de seguridad
  (log + 404 disclosure-safe) está implementado correctamente; solo falta la aserción
  explícita de la llamada de log. No rompe ningún AC.
- **Reproducción:** N/A (no es un bug ejecutable; es un assert de telemetría ausente).
- **Sugerencia:** Mockear/spyear `logOwnershipMismatch` y assertear
  `toHaveBeenCalledWith({ op: 'keySessionRevoke', resourceId: 'sess-unknown', callerOwnerRef: 'user-1' })`.
  No bloquea DONE; puede ir al backlog o en el mismo fix-pack si el Dev itera.

---

## Veredicto

**APROBADO con MENORs**

- BLOQUEANTES (ALTO/MED/BAJO): **0**.
- MENORes: **1** (`MNR-1`, assert de telemetría faltante en test de servicio).

Las 8 categorías clásicas → OK. Las 3 nuevas (9-11) → N/A justificado. El foco de seguridad
(Ownership Guard / IDOR, disclosure-safe 404, gate de sub-sesión, efecto inmediato sin
caché, idempotencia, no-leak de PG, no-regresión, sin scope drift) está sólido y verificado
con evidencia archivo:línea + suite verde (1429 pass). El gate **NO** se bloquea: `MNR-1` no
bloquea DONE.

Recomendación: el Dev puede absorber `MNR-1` en el mismo ciclo (1 assert) o moverlo a
backlog; a criterio del orquestador. No requiere re-lanzamiento obligatorio del Dev.
