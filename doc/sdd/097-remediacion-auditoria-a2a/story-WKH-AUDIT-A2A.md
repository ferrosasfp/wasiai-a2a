# Story File — [WKH-AUDIT-A2A] Remediación Auditoría Profesional — Hardening + Hygiene

> Contrato autocontenido para el Dev (F3). **Implementá leyendo SOLO este archivo.** No necesitás re-leer el SDD ni explorar el codebase: todo lo verificado está acá. Si algo falta, NO inventes — escalá.
> Fuente: `sdd.md` (SPEC_APPROVED). Branch sugerido: `feat/097-wkh-audit-a2a-hardening`.

---

## 1. Contexto compacto (qué se construye y por qué)

Cierra 5 hallazgos de una auditoría staff-level (Medium/Low) para subir de A− a A+:
- **H1** Dashboard admin **fail-open** en prod → fail-closed con 503.
- **H2** `.env.example` incompleto + naming drift en docs (`SUPABASE_SERVICE_ROLE_KEY` vs `SUPABASE_SERVICE_KEY`).
- **H3** `/discover` sin rate-limit frente a fanout externo → cae al límite global.
- **H4** mock-registry montado en prod → gateado por `NODE_ENV !== 'production'`.
- **H5** 2 diffs de formato Biome (+ verificación de TODOs, que es no-op).

No se toca: lógica de negocio, Redis, RLS Postgres, `errorResponseBuilder`, `src/lib/supabase.ts`.

---

## 2. Scope IN — lista EXHAUSTIVA de archivos a tocar

**Producción (código):**
| Archivo | Cambio | Wave |
|---------|--------|------|
| `src/routes/dashboard.ts` | Rama prod→503 dentro de `requireAdminToken` | W1 |
| `src/index.ts` | Envolver `register(mockRegistryRoutes)` en `if (!isProduction)` | W2a |
| `src/routes/discover.ts` | Quitar `config: { rateLimit: false }` de GET `/` y POST `/` | W2b |
| `src/middleware/rate-limit.ts` | Corregir comentario líneas 9-11 (quitar `/discover` de exempt) | W2b |
| `src/lib/bazaar.ts` | `npm run format` (no editar a mano) | W4 |
| `src/types/index.ts` | `npm run format` (no editar a mano) | W4 |

**Documentación / config:**
| Archivo | Cambio | Wave |
|---------|--------|------|
| `.env.example` | +`DASHBOARD_ADMIN_TOKEN`, +`DISCOVERY_REGISTRY_TIMEOUT_MS`, ampliar comentario `SUPABASE_SERVICE_KEY`, corregir comentario rate-limit línea 283 | W3 |
| `CLAUDE.md` | línea 140: `SUPABASE_SERVICE_ROLE_KEY` → `SUPABASE_SERVICE_KEY` | W3 |
| `.nexus/project-context.md` | línea 258: `SUPABASE_SERVICE_ROLE_KEY` → `SUPABASE_SERVICE_KEY` | W3 |

**Tests (nuevos):**
| Archivo | AC |
|---------|----|
| `src/routes/dashboard.test.ts` (NUEVO) | AC-1, AC-2, +regresión 401/200-con-token |
| `src/routes/discover.test.ts` (NUEVO) | AC-5 |
| `src/index.test.ts` (NUEVO) o test dedicado | AC-6 |
| AC-3 / AC-4: aserto sobre `.env.example` y docs (puede vivir en `dashboard.test.ts` o test propio) | AC-3, AC-4 |

---

## 3. Anti-Hallucination Checklist (CRÍTICO — correcciones del SDD que el Dev DEBE respetar)

> Estas son trampas reales detectadas en F2. Violar cualquiera = AR BLOQUEANTE.

- [ ] **AC-5 body shape:** el body 429 real (emitido por `errorResponseBuilder` en `src/middleware/rate-limit.ts:19-32`) es:
  ```json
  { "error": "Too Many Requests", "code": "RATE_LIMIT_EXCEEDED", "retryAfterMs": <number>, "requestId": <string> }
  ```
  → El test de AC-5 DEBE assertear `body.code === 'RATE_LIMIT_EXCEEDED'`, **NUNCA** `body.error === 'RATE_LIMIT_EXCEEDED'`. (CD-6)
- [ ] **NO modificar `errorResponseBuilder`** ni el shape del 429. Está fuera de scope y es patrón global.
- [ ] **`DISCOVERY_REGISTRY_TIMEOUT_MS` ES ACTIVO.** Se consume en `src/services/discovery.ts:264` (`parseInt(process.env.DISCOVERY_REGISTRY_TIMEOUT_MS ?? '5000', 10)` — timeout HTTP per-registry del fanout). En `.env.example` documentarlo como **variable activa** con default 5000 ms y su propósito. **PROHIBIDO** marcarlo como "reservado / TBD / no implementado". (CD-7)
- [ ] **TODOs = falso positivo.** Los matches de "TODOS" en `src/routes/registries.ts:13` y `src/lib/price.ts:36` son la palabra española dentro de JSDoc, NO marcadores `TODO:`. No hay ningún TODO/FIXME/XXX accionable en `src/`. AC-7 TODO-resolution es **no-op**: **NO tocar esos comentarios**, NO inventar TODOs. Solo dejar constancia en el AR de que el grep arroja 0 marcadores reales.
- [ ] **Drift project-context está en línea 258** (no 259): `SUPABASE_SERVICE_ROLE_KEY=sb_secret_...`. Corregirla por contenido.
- [ ] **Comentarios drift a corregir junto con el código** (CD-8): al sacar `/discover` del exempt, corregir `src/middleware/rate-limit.ts:9-11` (quitar `/discover` de la lista) y `.env.example:283` (quitar `/discover` de la lista exempt).
- [ ] **NO tocar `src/routes/discover.ts:118`** (`GET /:slug`, también tiene `rateLimit: false`). Fuera de Scope IN. (CD-9)
- [ ] **NO tocar `src/lib/supabase.ts`.** `SUPABASE_SERVICE_KEY` es correcto en código; solo se corrige documentación. (CD-4)
- [ ] **NO tocar `GET /dashboard` (`src/routes/dashboard.ts:66-72`).** La página HTML es pública por diseño: conserva `rateLimit: false` y SIN `preHandler`. (CD-2)
- [ ] **NO tocar la lógica timing-safe** (`timingSafeEqual`, `src/routes/dashboard.ts:39-46`) ni el 401 existente. El cambio AC-1 es SOLO una rama adicional en el bloque `if (!expected)`. (CD-5)
- [ ] **CD-10 (orden de plugins en test):** `@fastify/rate-limit` **THROWS** el Error de `errorResponseBuilder` (no lo `send`-ea). En el test de AC-5 registrar `registerErrorBoundary(app)` **ANTES** de `registerRateLimit(app)`, si no el Error no se convierte en respuesta 429. NO downgradear `@fastify/rate-limit` (`^10.3.0`, Fastify 5).
- [ ] **CD-3:** el guard de mock-registry en `src/index.ts` DEBE reusar la constante `isProduction` (ya existe en `src/index.ts:36`). NO hardcodear el string `'production'` de nuevo.

---

## 4. Constraint Directives (heredadas — vinculantes)

- **CD-1:** PROHIBIDO cambiar el comportamiento dev-local del dashboard. Sin `DASHBOARD_ADMIN_TOKEN` Y con `NODE_ENV !== 'production'` (incluye ausente/undefined), `/dashboard/api/stats` y `/dashboard/api/events` DEBEN seguir abiertos sin token. Solo `NODE_ENV === 'production'` activa el 503.
- **CD-2:** PROHIBIDO tocar `GET /dashboard` (HTML público, `src/routes/dashboard.ts:66-72`).
- **CD-3:** OBLIGATORIO reusar `isProduction` (`src/index.ts:36`) para el guard de mock-registry.
- **CD-4:** PROHIBIDO tocar `src/lib/supabase.ts`.
- **CD-5:** PROHIBIDO cambiar la comparación timing-safe / el 401 (`src/routes/dashboard.ts:39-46`).
- **CD-6:** PROHIBIDO inventar el body del 429. Test asserta `statusCode===429` + `body.code==='RATE_LIMIT_EXCEEDED'`.
- **CD-7:** PROHIBIDO marcar `DISCOVERY_REGISTRY_TIMEOUT_MS` como reservada/no implementada — es activa (default 5000 ms).
- **CD-8:** OBLIGATORIO corregir los comentarios drift (`rate-limit.ts:9-11`, `.env.example:283`) en la misma wave que `/discover`.
- **CD-9:** PROHIBIDO tocar `src/routes/discover.ts:118` (`GET /:slug`).
- **CD-10:** OBLIGATORIO `registerErrorBoundary` antes de `registerRateLimit` en el test de AC-5. NO cambiar versión de `@fastify/rate-limit`.

---

## 5. Waves de implementación

> W0 es serial. W1/W2/W3/W4 son secuenciales por afinidad de scope; W2a y W2b son independientes entre sí.

### W0 — Verificación baseline (serial, sin escribir código de prod)

1. Anti-hallucination pass — confirmar (ya verificado en F2, re-confirmar en F3):
   - `isProduction` en `src/index.ts:36`. ✓
   - `requireAdminToken` en `src/routes/dashboard.ts:29`. ✓
   - `DISCOVERY_REGISTRY_TIMEOUT_MS` consumido en `src/services/discovery.ts:264`. ✓
   - `grep -rn "TODO\|FIXME\|XXX" src/` → solo matches "TODOS" en JSDoc (`registries.ts:13`, `price.ts:36`) → no-op. ✓
2. `npm run build` + `npx tsc --noEmit` → verde antes de tocar nada.
3. `vitest run` → baseline verde.
4. `npm run lint` → registrar los **2 errores biome esperados** (`bazaar.ts`, `types/index.ts`) como baseline conocido.

---

### W1 — Dashboard fail-closed (AC-1 + AC-2)

**Archivo:** `src/routes/dashboard.ts` — SOLO dentro de `requireAdminToken` (líneas 29-31).

**Cambio concreto:** en el bloque `if (!expected)` (actualmente `if (!expected) return; // not configured → allow (dev mode)` en línea 31), reemplazar el early-return por una rama:
- Si `process.env.NODE_ENV === 'production'` → `reply.status(503).send({ error: 'service_unavailable', message: 'Dashboard API not configured' })` (y `return`).
- Else → `return;` (passthrough dev, CD-1).

**Exemplar de patrón:** el literal `process.env.NODE_ENV === 'production'` se usa idéntico en `src/index.ts:36`. El `reply.status(...).send({...})` sigue el mismo patrón que el 401 ya presente en `dashboard.ts:34-37` y `42-45`.

**Prohibido:** NO tocar líneas 32-47 (header check + 401 + `timingSafeEqual`, CD-5). NO tocar `GET /` (CD-2). Las rutas afectadas (que usan este preHandler) son `/api/stats` (línea 83) y `/api/events` (línea 107) — no se editan, heredan el fix vía el preHandler.

**Tests — `src/routes/dashboard.test.ts` (NUEVO):**
- Patrón base: `Fastify()` aislado + `fastify.register(dashboardRoutes, { prefix: '/dashboard' })` + `fastify.inject`. Mockear `eventService` con `vi.mock('../services/event.js', ...)` (patrón de `src/routes/auth.test.ts:21-43`) para que `/api/stats` y `/api/events` no peguen a DB real.
- Manejo de `NODE_ENV` y `DASHBOARD_ADMIN_TOKEN` por test: setear/`delete` `process.env.NODE_ENV` y `process.env.DASHBOARD_ADMIN_TOKEN` en `beforeEach`/`afterEach` (o registrar app por test) y limpiarlos en `afterAll` — patrón de `src/middleware/rate-limit.test.ts:14-45`.
- Casos:
  | Caso | Setup | Assert |
  |------|-------|--------|
  | AC-1 prod sin token | `NODE_ENV='production'`, `DASHBOARD_ADMIN_TOKEN` unset → `GET /dashboard/api/stats` | `statusCode===503`, `body.error==='service_unavailable'`, `body.message==='Dashboard API not configured'` |
  | AC-2 dev sin token | `NODE_ENV` unset/`'development'`, token unset → `GET /dashboard/api/stats` | `statusCode===200` (con `eventService.stats` mockeado) |
  | reg prod token OK | `NODE_ENV='production'`, `DASHBOARD_ADMIN_TOKEN='secret'`, header `X-Admin-Token: secret` | `statusCode===200` (passthrough) |
  | reg prod token MAL | `NODE_ENV='production'`, token seteado, header incorrecto/ausente | `statusCode===401`, `body.error==='unauthorized'` (CD-5 regresión) |

---

### W2a — mock-registry gate (AC-6)

**Archivo:** `src/index.ts` (línea 108).

**Cambio concreto:** envolver el `register` existente en el guard reusando `isProduction` (línea 36):
- Línea 108 actual: `await fastify.register(mockRegistryRoutes, { prefix: '/mock-registry/agents' });`
- Pasa a estar dentro de `if (!isProduction) { ... }`. En prod la ruta no se monta → cualquier request a `/mock-registry/agents` cae al 404 default de Fastify (no se agrega handler explícito de 404).

**Exemplar de patrón:** `isProduction` ya declarado en `src/index.ts:36` y usado en `if (!isProduction)` en línea 40. Reusar exactamente esa constante (CD-3).

**Prohibido:** NO tocar `src/routes/mock-registry.ts` (el guard va en el `register`, no en la ruta — D-1).

**Test — AC-6 (`src/index.test.ts` NUEVO o test dedicado):**
- Montar el server completo es costoso (top-level await en `index.ts`). **Alternativa pragmática recomendada:** test que replica el guard con un `Fastify()` aislado:
  - `process.env.NODE_ENV = 'production'` en `beforeAll`; `delete` en `afterAll`.
  - Registrar condicionalmente: `if (process.env.NODE_ENV !== 'production') { await app.register(mockRegistryRoutes, { prefix: '/mock-registry/agents' }) }` (replica el guard de `index.ts`).
  - `await app.ready()`.
  - `app.inject({ method: 'GET', url: '/mock-registry/agents' })` → `expect(statusCode).toBe(404)`.
- Patrón de registro+inject: `src/services/mock-registry.test.ts:1-30`. Import: `import mockRegistryRoutes from '../routes/mock-registry.js'`.

---

### W2b — /discover rate-limit (AC-5) + comentario drift

**Archivo 1:** `src/routes/discover.ts`.
**Cambio concreto:**
- GET `/` (líneas 21-23): quitar `{ config: { rateLimit: false } }` del objeto de opciones — la ruta queda `fastify.get('/', async (request, reply) => { ... })`. Si no quedan otras opciones, eliminar el objeto de config por completo.
- POST `/` (líneas 62-64): mismo cambio, quitar `{ config: { rateLimit: false } }`.
- **NO tocar** `GET /:slug` (línea 116-118) — conserva su `rateLimit: false` (CD-9).
- Al quitar `rateLimit: false`, ambas rutas heredan el límite global (`RATE_LIMIT_MAX`, default 60/min) registrado por `registerRateLimit` en `src/index.ts:65`. Sin tier propio (DT-2).

**Archivo 2:** `src/middleware/rate-limit.ts` (comentario líneas 9-11).
**Cambio concreto:** en el comentario `Endpoints exempt (rateLimit: false): /, /health, /discover, /gasless/status, /.well-known/agent.json` → **quitar `/discover`** de la lista (CD-8). NO tocar el código del módulo, solo el JSDoc.

**Exemplar de patrón (cómo se ve hoy):** `discover.ts:23` y `discover.ts:64` tienen `{ config: { rateLimit: false } }` exactamente como `src/index.ts:68` (`{ config: { rateLimit: false } }`). El patrón "quitar el config para heredar el global" no tiene exemplar previo — simplemente se elimina la opción.

**Test — `src/routes/discover.test.ts` (NUEVO), AC-5:**
- Patrón base: `src/middleware/rate-limit.test.ts:1-70` (ESTE es el exemplar exacto a copiar la estructura).
- Setup `beforeAll`:
  - `process.env.RATE_LIMIT_MAX = '3'` (límite bajo); `process.env.RATE_LIMIT_WINDOW_MS = '60000'`.
  - `app = Fastify({ genReqId })` — import `genReqId, registerRequestIdHook` de `../middleware/request-id.js`.
  - `registerRequestIdHook(app)`.
  - **`registerErrorBoundary(app)`** — import de `../middleware/error-boundary.js` — **ANTES** de rate-limit (CD-10).
  - `await registerRateLimit(app)` — import de `../middleware/rate-limit.js`.
  - `await app.register(discoverRoutes, { prefix: '/discover' })` — import default de `./discover.js`.
  - `await app.ready()`.
- `afterAll`: `delete process.env.RATE_LIMIT_MAX; delete process.env.RATE_LIMIT_WINDOW_MS; await app.close()`.
- **Mockear el service** para no hacer fanout real: `vi.mock('../services/discovery.js', () => ({ discoveryService: { discover: vi.fn().mockResolvedValue({ agents: [], total: 0 }) } }))` (patrón `vi.mock` de `src/routes/auth.test.ts:21-43`). Ajustar el shape devuelto a lo que el handler espera (cualquier objeto sirve, no se asserta sobre él).
- Casos:
  | Caso | Setup | Assert |
  |------|-------|--------|
  | AC-5 GET dentro del límite | 3 × `inject GET /discover` | cada uno `statusCode===200` |
  | AC-5 GET excede | request N+1 (4ª) `inject GET /discover` | `statusCode===429`, `body.code==='RATE_LIMIT_EXCEEDED'` (CD-6, **NO** `body.error`) |
  | (opcional) POST excede | igual con `POST /discover` body JSON | `statusCode===429`, `body.code==='RATE_LIMIT_EXCEEDED'` |

> Nota: el rate-limit cuenta por IP; todos los `inject` sin `remoteAddress` comparten la IP default, así que la 4ª request supera el `max=3` (mismo comportamiento que `rate-limit.test.ts`).

---

### W3 — .env.example + docs naming drift (AC-3 + AC-4)

**Archivo 1:** `.env.example`.
**Cambios concretos:**
1. **+`DASHBOARD_ADMIN_TOKEN`** — agregar entrada con comentario: opt-in admin token para `/dashboard/api/*`; **unset = dev abierto, set = `X-Admin-Token` header requerido**. (Ubicación libre; sugerido cerca de la sección de seguridad / dashboard si existe, si no al final de una sección coherente.)
2. **+`DISCOVERY_REGISTRY_TIMEOUT_MS`** — agregar entrada con comentario: **timeout HTTP per-registry (ms) del fanout de discovery; default 5000.** Documentar como **variable activa** (consumida en `discovery.ts:264`) — NO como reservada (CD-7).
3. **Ampliar comentario de `SUPABASE_SERVICE_KEY`** (línea 74, bloque 67-74): aclarar que el nombre runtime es `SUPABASE_SERVICE_KEY` (NO `SUPABASE_SERVICE_ROLE_KEY` que aparecía en docs legacy). NO renombrar la var (CD-4).
4. **Corregir comentario rate-limit línea 283**: `# /health, /discover, /gasless/status, /.well-known → exempt (rateLimit: false)` → **quitar `/discover`** (CD-8).

**Archivo 2:** `CLAUDE.md` línea 140.
**Cambio concreto:** `El cliente de Supabase usa \`SUPABASE_SERVICE_ROLE_KEY\`, que **bypassea RLS**.` → reemplazar `SUPABASE_SERVICE_ROLE_KEY` por `SUPABASE_SERVICE_KEY`.
> Hay otras menciones conceptuales de `SUPABASE_SERVICE_ROLE_KEY` en el bloque Security Conventions de `CLAUDE.md` (explicación de RLS). El AC-4 mínimo es la referencia a la var runtime. **Recomendado** alinearlas todas para consistencia; **documentar en el AR** cuáles se cambiaron. Si se cambian todas, asegurarse de que el sentido conceptual (RLS bypass) se mantenga.

**Archivo 3:** `.nexus/project-context.md` línea 258.
**Cambio concreto:** `SUPABASE_SERVICE_ROLE_KEY=sb_secret_...` → `SUPABASE_SERVICE_KEY=sb_secret_...`.

**Tests — AC-3 / AC-4 (aserto, en `dashboard.test.ts` o test propio `src/routes/env-docs.test.ts`):**
- AC-3: `readFileSync('.env.example', 'utf-8')` (resolver path absoluto desde `process.cwd()` o `import.meta.url`) → incluye los strings `DASHBOARD_ADMIN_TOKEN`, `DISCOVERY_REGISTRY_TIMEOUT_MS`, `SUPABASE_SERVICE_KEY`.
- AC-4: `readFileSync('.nexus/project-context.md')` → línea de var NO contiene `SUPABASE_SERVICE_ROLE_KEY=`. (Aserto simple: el contenido no incluye `SUPABASE_SERVICE_ROLE_KEY=sb_secret_`.) Análogo para la tabla/línea de `CLAUDE.md`.
> El aserto debe ser robusto a número de línea: buscar por substring, no por índice de línea.

---

### W4 — Biome format + lint (AC-7)

**Cambio concreto:**
1. Ejecutar `npm run format` (= `biome format --write src/`) — escribe in-place `src/lib/bazaar.ts`, `src/types/index.ts` (+ cualquier archivo tocado en W1-W2 que el formateador ajuste). **NO editar a mano** (DT-8).
   - Diffs confirmados que el formateador resolverá:
     - `src/lib/bazaar.ts:88-90`: firma multilínea `compileOrCollectErrors(schema: Record<string, unknown>,): string[] {` → colapsa a 1 línea.
     - `src/types/index.ts:214`: tipo inline `scopeDeniedTarget?: { registry: string; agent_slug: string; category?: string };` → expande a multilínea.
2. Ejecutar `npm run lint` (= `biome check src/`) → debe reportar **zero errors** (exit 0). Capturar la salida para evidencia AR.
3. **TODOs:** no-op verificado (W0). NO tocar `registries.ts:13` ni `price.ts:36`. Documentar en AR: "grep TODO/FIXME/XXX en src/ → 0 marcadores reales (solo la palabra española 'TODOS' en JSDoc)".

---

## 6. Comandos de verificación (correr al cerrar)

```bash
npm run build          # tsc compila
npx tsc --noEmit       # type-check estricto, sin any
vitest run             # toda la suite verde (incluye los 3 tests nuevos)
npm run format         # biome format --write src/  (W4)
npm run lint           # biome check src/  → exit 0, zero errors (AC-7)
```

---

## 7. Done Definition (por AC)

| AC | Done cuando | Evidencia |
|----|-------------|-----------|
| AC-1 | prod + token ausente → 503 `{error:'service_unavailable', message:'Dashboard API not configured'}` | test `dashboard.test.ts` verde |
| AC-2 | dev + token ausente → passthrough 200 | test `dashboard.test.ts` verde |
| reg | prod + token OK → 200; token MAL → 401 (CD-5 intacto) | test `dashboard.test.ts` verde |
| AC-3 | `.env.example` contiene las 3 vars con comentarios; `SUPABASE_SERVICE_KEY` aclara naming legacy; `DISCOVERY_REGISTRY_TIMEOUT_MS` documentada como activa | test aserto + lectura |
| AC-4 | `CLAUDE.md` y `project-context.md` referencian `SUPABASE_SERVICE_KEY` (no `_ROLE_`) en la var | test aserto + grep 0 matches en línea de var |
| AC-5 | N+1 reqs a GET/POST `/discover` → 429 con `body.code==='RATE_LIMIT_EXCEEDED'`; comentarios drift corregidos | test `discover.test.ts` verde |
| AC-6 | prod → `GET /mock-registry/agents` → 404 (ruta no montada) | test AC-6 verde |
| AC-7 | `npm run lint` exit 0; `npm run format` sin cambios pendientes; TODOs = no-op documentado | salida terminal en AR |

**Global DoD:**
- [ ] `npm run build` + `npx tsc --noEmit` OK (sin `any`).
- [ ] `vitest run` 100% verde.
- [ ] `npm run format && npm run lint` zero errors.
- [ ] Todos los CD respetados (sección 4).
- [ ] Anti-Hallucination Checklist (sección 3) cumplido íntegro.
- [ ] AR documenta: TODOs no-op, qué menciones de `SUPABASE_SERVICE_ROLE_KEY` se alinearon en CLAUDE.md.
- [ ] NO commit (lo maneja el pipeline tras CR/QA).

---

## 8. Exemplars verificados (paths reales — confirmados en F2.5)

| Propósito | Exemplar (path:línea) |
|-----------|------------------------|
| Test 429 con rate-limit + error-boundary (ESTRUCTURA EXACTA para AC-5) | `src/middleware/rate-limit.test.ts:1-70` |
| Registro de ruta con prefix + inject en test (AC-6) | `src/services/mock-registry.test.ts:1-30` |
| `vi.mock` de servicio + Fastify aislado (mock de `event`/`discovery`) | `src/routes/auth.test.ts:21-43` |
| Constante `isProduction` a reusar (CD-3) | `src/index.ts:36` (usada en línea 40) |
| preHandler timing-safe a NO romper (CD-5) | `src/routes/dashboard.ts:29-47` |
| Body 429 / `errorResponseBuilder` (CD-6) | `src/middleware/rate-limit.ts:19-32` |
| Consumo real de `DISCOVERY_REGISTRY_TIMEOUT_MS` (CD-7) | `src/services/discovery.ts:262-266` |
| `register(mockRegistryRoutes)` a gatear | `src/index.ts:108` |
| `rateLimit: false` a quitar de discover | `src/routes/discover.ts:21-23` (GET), `62-64` (POST) |
| `rateLimit: false` a CONSERVAR (CD-9) | `src/routes/discover.ts:116-118` (`:slug`) |
| Comentario exempt a corregir | `src/middleware/rate-limit.ts:9-11`, `.env.example:283` |
| Drift docs a corregir | `CLAUDE.md:140`, `.nexus/project-context.md:258` |
| Diffs biome (W4) | `src/lib/bazaar.ts:88-90`, `src/types/index.ts:214` |
