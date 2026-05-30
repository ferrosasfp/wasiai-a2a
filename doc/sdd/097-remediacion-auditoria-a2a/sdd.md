# SDD — [WKH-AUDIT-A2A] Remediación Auditoría Profesional — Hardening + Hygiene

> Fase F2 (QUALITY). Input: `doc/sdd/097-remediacion-auditoria-a2a/work-item.md` (HU_APPROVED).
> Este SDD especifica el CÓMO. No contiene código de producción. El Story File (F2.5) se genera después de SPEC_APPROVED.

---

## 1. Context Map (archivos leídos + patrón extraído)

| Archivo:línea | Por qué se leyó | Qué se extrajo / confirmó |
|---------------|-----------------|----------------------------|
| `src/routes/dashboard.ts:29-47` | H1/AC-1/AC-2 — `requireAdminToken` | preHandler. `if (!expected) return;` en línea **31** = fail-open. Las rutas con `preHandler: requireAdminToken` son **`/api/stats`** (línea 83) y **`/api/events`** (línea 107). La página HTML `GET /` (línea 66-72) NO tiene el preHandler y NO se toca (CD-2). |
| `src/routes/dashboard.ts:66-72` | CD-2 — página HTML pública | `GET /` con `config: { rateLimit: false }` y sin `preHandler`. PROHIBIDO tocar. |
| `src/index.ts:36` | DT-1/CD-3 — constante de entorno | `const isProduction = process.env.NODE_ENV === 'production';` ya existe. Se reusa para mock-registry (CD-3) y se replica el literal en dashboard (DT-1). |
| `src/index.ts:108` | H4/AC-6 — montaje incondicional de mock-registry | `await fastify.register(mockRegistryRoutes, { prefix: '/mock-registry/agents' });` sin guard. |
| `src/routes/mock-registry.ts:1-95` | H4 — confirmar que la ruta no tiene guard interno | Datos hardcodeados (`MOCK_AGENTS`). El guard debe ir en el **registro** (`index.ts`), no en la ruta (CD-3 + Scope IN). |
| `src/routes/discover.ts:22-23, 62-64, 116-118` | H3/AC-5 — `rateLimit: false` | GET `/` (línea 23), POST `/` (línea 64) **y** GET `/:slug` (línea 118) tienen `config: { rateLimit: false }`. El work-item Scope IN solo menciona GET y POST (ver §3 Decisión D-2). |
| `src/middleware/rate-limit.ts:1-46` | H3/AC-5 — cómo cae al global | `registerRateLimit` registra `global: true, max=RATE_LIMIT_MAX (60), timeWindow=RATE_LIMIT_WINDOW_MS (60000)`. Quitar `config: { rateLimit: false }` de una ruta hace que herede el límite global. El comentario líneas 9-11 lista `/discover` como exempt — **debe actualizarse** (drift de comentario, ver §3 D-3). |
| `src/middleware/rate-limit.ts:19-32` | AC-5 — shape real del body 429 | `errorResponseBuilder` retorna un `Error` con `.message='Too Many Requests'`, `.code='RATE_LIMIT_EXCEEDED'`, `.statusCode=429`. El body emitido NO es `{ error: 'RATE_LIMIT_EXCEEDED' }` (ver §6 discrepancia AC-5). |
| `src/services/discovery.ts:262-266` | NEEDS CLARIFICATION — `DISCOVERY_REGISTRY_TIMEOUT_MS` | **SÍ se consume**: `parseInt(process.env.DISCOVERY_REGISTRY_TIMEOUT_MS ?? '5000', 10)` — timeout HTTP por-registry del fanout. La premisa del work-item ("no se encontró su consumo") es **incorrecta**. Resuelto en §5. |
| `.env.example:74` | H2/AC-3 — var Supabase real | `SUPABASE_SERVICE_KEY=your-service-role-key-here`. Correcto (CD-4). Falta `DASHBOARD_ADMIN_TOKEN` y `DISCOVERY_REGISTRY_TIMEOUT_MS`. |
| `.env.example:281-290` | AC-3/AC-5 — sección rate-limit existente | Comentario líneas 283 lista `/discover` como exempt — **debe corregirse** junto con el cambio de código. |
| `CLAUDE.md:140` | H2/AC-4 — naming drift en docs | `El cliente de Supabase usa \`SUPABASE_SERVICE_ROLE_KEY\`` → drift, debe ser `SUPABASE_SERVICE_KEY`. |
| `.nexus/project-context.md:258` | H2/AC-4 — naming drift en docs | `SUPABASE_SERVICE_ROLE_KEY=sb_secret_...` → drift (el work-item citó línea 259; la real es **258**). |
| `src/lib/bazaar.ts:88-90` | H5/AC-7 — diff biome | `biome format` colapsa la firma multilínea `compileOrCollectErrors(schema: ...): string[] {` a una sola línea. Confirmado con `biome format` (ver §6 evidencia). |
| `src/types/index.ts:214` | H5/AC-7 — diff biome | `biome format` expande el tipo inline `scopeDeniedTarget?: { registry: string; agent_slug: string; category?: string };` a multilínea. Confirmado. |
| `src/middleware/rate-limit.test.ts:1-80` | Exemplar — patrón de test 429 | Patrón: `Fastify({ genReqId })` + `registerRequestIdHook` + `registerErrorBoundary` + `registerRateLimit` + `app.inject`, seteando `process.env.RATE_LIMIT_MAX='3'` en `beforeAll` y limpiándolo en `afterAll`. Asserts sobre `statusCode===429` y `body.code==='RATE_LIMIT_EXCEEDED'`. |
| `src/services/mock-registry.test.ts:1-20` | Exemplar — registro de ruta en test | `Fastify()` + `fastify.register(mockRegistryRoutes, { prefix: '/mock-registry/agents' })` + `inject`. |
| `src/routes/auth.test.ts:1-70` | Exemplar — test de route con inject + mocks vitest | Patrón `vi.mock` de servicios + `Fastify()` aislado por test file. |
| `package.json (scripts)` | AC-7 — comandos | `lint: biome check src/`, `format: biome format --write src/`, `test: vitest run`. |

---

## 2. Decisiones técnicas (DT-N)

**Heredadas del work-item (vinculantes):**
- **DT-1:** El fix de `requireAdminToken` usa el literal `process.env.NODE_ENV === 'production'`, consistente con `src/index.ts:36`. No se crea una constante nueva.
- **DT-2:** `/discover` cae al rate-limit global (`RATE_LIMIT_MAX`, default 60/min) al quitar `config: { rateLimit: false }`. Sin tier propio.
- **DT-3:** Dashboard fail-closed usa **503** (`service_unavailable`), distinto del 401 (token incorrecto). 503 = "no habilitado en este entorno", sin filtrar si el token existe.
- **DT-4:** `DISCOVERY_REGISTRY_TIMEOUT_MS` se documenta en `.env.example`. **Corrección F2:** el código SÍ lo consume (ver DT-5), así que NO se marca `[TBD implementación]` — se documenta como variable activa.

**Nuevas en F2:**
- **DT-5:** `DISCOVERY_REGISTRY_TIMEOUT_MS` es una variable **activa y consumida** en `src/services/discovery.ts:264` (timeout del fetch HTTP por-registry en el fanout de discovery, default `5000` ms). El comentario en `.env.example` la documenta como tal (NO como "reservada"). Esto invalida la premisa del work-item Missing Inputs y el `[TBD implementación]` de DT-4.
- **DT-6:** El guard de mock-registry envuelve el `register` en `if (!isProduction) { ... }` reusando la constante `isProduction` de `src/index.ts:36` (CD-3). En producción la ruta no se monta → cualquier request a `/mock-registry/agents` cae al 404 default de Fastify (no se agrega handler explícito).
- **DT-7:** El cambio de dashboard se aplica DENTRO de `requireAdminToken`: nueva rama ANTES del `if (!expected) return;`. La rama es: `if (!expected) { if (NODE_ENV==='production') → 503; else → return (dev passthrough) }`. Así CD-1 (dev abierto) y AC-1 (prod cerrado) conviven sin tocar la lógica de comparación timing-safe existente (líneas 39-46).
- **DT-8:** Los diffs biome se resuelven ejecutando `npm run format` (que escribe in-place). No se editan los archivos a mano para evitar divergencia con el formateador. AC-7 se valida con `npm run lint` (zero errors).

---

## 3. Resolución de decisiones de scope

- **D-1 (mock-registry guard ubicación):** El guard va en `src/index.ts:108` (el `register`), NO dentro de `src/routes/mock-registry.ts`. Razón: CD-3 obliga a reusar `isProduction` que vive en `index.ts`; y el Scope IN del work-item lista `src/index.ts` como el archivo a tocar para H4. `mock-registry.ts` NO se modifica.
- **D-2 (`/discover/:slug`):** El work-item Scope IN menciona solo GET y POST `/discover`. La ruta `GET /:slug` (línea 118) también tiene `rateLimit: false`. **Decisión:** se mantiene fuera de scope (igual que el work-item) para no exceder el Scope IN aprobado por el humano. Si la auditoría quisiera cubrir `:slug`, es un nuevo work-item. Se documenta como nota, NO se toca.
- **D-3 (comentarios drift):** Al quitar `rateLimit: false` de `/discover`, dos comentarios quedan desactualizados y DEBEN corregirse en la misma wave para no introducir nuevo drift:
  - `src/middleware/rate-limit.ts:9-11` ("Endpoints exempt ... /discover ...") → quitar `/discover` de la lista.
  - `.env.example:283` ("/discover → exempt") → quitar `/discover`.

---

## 4. Constraint Directives (CD-N)

**Heredadas (vinculantes, copiar al Story File):**
- **CD-1:** PROHIBIDO cambiar el comportamiento dev-local del dashboard. Sin `DASHBOARD_ADMIN_TOKEN` Y con `NODE_ENV !== 'production'` (incluye ausente/undefined), `/dashboard/api/stats` y `/dashboard/api/events` DEBEN seguir abiertos sin token. Solo `NODE_ENV === 'production'` activa el 503.
- **CD-2:** PROHIBIDO remover `rateLimit: false` ni agregar `requireAdminToken` a `GET /dashboard` (`src/routes/dashboard.ts:66-72`). La página HTML es pública por diseño.
- **CD-3:** OBLIGATORIO: el guard de mock-registry en `src/index.ts` DEBE reusar la constante `isProduction` (línea 36) o el literal idéntico `process.env.NODE_ENV === 'production'`. NO hardcodear strings nuevos.
- **CD-4:** PROHIBIDO tocar `src/lib/supabase.ts`. `SUPABASE_SERVICE_KEY` es correcto en código. Solo se corrige documentación (CLAUDE.md + project-context.md).

**Nuevas en F2:**
- **CD-5:** PROHIBIDO cambiar la lógica de comparación timing-safe (`timingSafeEqual`, `src/routes/dashboard.ts:39-46`) ni el 401 existente. El cambio AC-1 es **solo** una rama adicional en el bloque `if (!expected)`.
- **CD-6:** PROHIBIDO inventar el body del 429. El shape lo emite `errorResponseBuilder` (`src/middleware/rate-limit.ts:19-32`): `{ error: 'Too Many Requests', code: 'RATE_LIMIT_EXCEEDED', retryAfterMs, requestId }`. El test de AC-5 DEBE assertear `statusCode===429` y `body.code==='RATE_LIMIT_EXCEEDED'` (NO `body.error==='RATE_LIMIT_EXCEEDED'` — ver §6).
- **CD-7:** PROHIBIDO marcar `DISCOVERY_REGISTRY_TIMEOUT_MS` como "reservada/no implementada". El código la consume (`src/services/discovery.ts:264`). El comentario en `.env.example` la documenta como timeout HTTP por-registry activo, default 5000 ms.
- **CD-8:** OBLIGATORIO corregir los comentarios drift de §3 D-3 (`rate-limit.ts:9-11` y `.env.example:283`) en la misma wave que el cambio de código de `/discover`.
- **CD-9:** PROHIBIDO tocar `src/routes/discover.ts:118` (`GET /:slug`). Fuera de Scope IN (D-2).
- **CD-10 (auto-blindaje #026):** El plugin `@fastify/rate-limit` THROWS el resultado de `errorResponseBuilder` (no lo `send`-ea). El proyecto ya usa `@fastify/rate-limit@^10.3.0` con Fastify 5 — NO downgradear ni cambiar la versión del plugin. El test de AC-5 DEBE incluir `registerErrorBoundary` antes de `registerRateLimit` para que el Error thrown se convierta en respuesta 429 (mismo patrón que `src/middleware/rate-limit.test.ts:7-22`). Ref: WKH-18 / `026-hardening/auto-blindaje.md` #2-#4.

---

## 5. Resolución NEEDS CLARIFICATION + TODOs

### NEEDS CLARIFICATION — `DISCOVERY_REGISTRY_TIMEOUT_MS`
**RESUELTO.** Grep en todo el codebase:
```
src/services/discovery.ts:264:  process.env.DISCOVERY_REGISTRY_TIMEOUT_MS ?? '5000',
```
La variable **SÍ se consume** como timeout (ms) del `AbortController` que corta el fetch HTTP a cada registry durante el fanout de discovery (default 5000). **Acción para AC-3:** documentarla en `.env.example` como variable activa con su default 5000 ms y propósito (timeout per-registry). NO usar `[TBD implementación]` (anula DT-4 parcial / CD-7).

### TODOs reales
**RESUELTO — no hay TODOs accionables.** Grep `TODO|FIXME|XXX` en `src/`:
```
src/routes/registries.ts:13:  ... compartido entre TODOS los payers x402 ...
src/lib/price.ts:36:  ... un cap de 0 cerraría TODOS los transfers ...
```
Ambos matches son la palabra española **"TODOS"** dentro de comentarios JSDoc, NO marcadores `TODO:`. **No existe ningún TODO/FIXME/XXX accionable en `src/`.** El item "resolver TODOs" del Scope IN es un **no-op verificado**. El Dev NO debe inventar ni eliminar nada por este concepto; solo dejar constancia en el AR de que el grep arroja 0 marcadores reales.

---

## 6. Discrepancias detectadas (escalables — el humano/Adversary decide)

1. **AC-5 body shape (MENOR — corregir el AC, no el código).** El AC-5 dice `respond HTTP 429 with { error: 'RATE_LIMIT_EXCEEDED' }`. El body **real** que emite `errorResponseBuilder` (`src/middleware/rate-limit.ts:19-32`) es `{ error: 'Too Many Requests', code: 'RATE_LIMIT_EXCEEDED', retryAfterMs, requestId }`. La constante `RATE_LIMIT_EXCEEDED` está en `body.code`, no en `body.error`. **Decisión F2:** NO modificar el `errorResponseBuilder` (está fuera de Scope IN y es un patrón global consistente con todas las rutas). El test de AC-5 asserta `statusCode===429` + `body.code==='RATE_LIMIT_EXCEEDED'`. Se recomienda que QA acepte esta interpretación del AC. NO bloqueante.

2. **AC-3 incluye `SUPABASE_SERVICE_KEY` "with inline comment explaining naming differs from legacy docs".** `.env.example:68-74` ya tiene `SUPABASE_SERVICE_KEY` con un comentario. **Acción:** ampliar el comentario existente para aclarar que el nombre runtime es `SUPABASE_SERVICE_KEY` (no `SUPABASE_SERVICE_ROLE_KEY` que aparecía en docs legacy). NO se renombra la var (CD-4).

3. **Línea de drift en project-context.md.** El work-item cita `.nexus/project-context.md:259`; la línea real del drift es **258** (`SUPABASE_SERVICE_ROLE_KEY=sb_secret_...`). Sin impacto — el fix es por contenido, no por número de línea.

Ninguna discrepancia es bloqueante. Todas tienen resolución determinística arriba.

### Evidencia biome (F2, corrida real)
`./node_modules/.bin/biome format src/lib/bazaar.ts src/types/index.ts` → `Found 2 errors`:
- `bazaar.ts:88-90`: firma multilínea → 1 línea.
- `types/index.ts:214`: tipo inline → 5 líneas multilínea.
Ambos se resuelven con `npm run format` (DT-8).

---

## 7. Waves de implementación

### W0 — Verificación (serial, sin escribir código)
- Anti-hallucination pass: confirmar que `isProduction` está en `src/index.ts:36`, que `requireAdminToken` es `src/routes/dashboard.ts:29`, que `DISCOVERY_REGISTRY_TIMEOUT_MS` está en `discovery.ts:264`, que grep TODO arroja solo "TODOS" en comentarios.
- `npm run test` baseline (verde antes de tocar nada).
- `npm run lint` baseline (registrar los 2 errores biome esperados).

### W1 — Dashboard fail-closed (AC-1 + AC-2)
- **Archivo:** `src/routes/dashboard.ts` (solo dentro de `requireAdminToken`, líneas 29-31).
- Agregar rama en el bloque `if (!expected)`: si `process.env.NODE_ENV === 'production'` → `reply.status(503).send({ error: 'service_unavailable', message: 'Dashboard API not configured' })`; else → `return` (passthrough dev, CD-1).
- NO tocar líneas 32-47 (401 + timingSafeEqual, CD-5). NO tocar `GET /` (CD-2).
- **Test:** crear `src/routes/dashboard.test.ts` (no existe). AC-1 (prod sin token → 503), AC-2 (dev sin token → passthrough/200), + caso prod CON token válido → passthrough (regresión).

### W2 — mock-registry gate (AC-6) + /discover rate-limit (AC-5)
*(Independientes entre sí; pueden paralelizarse, pero comparten wave por afinidad de scope.)*
- **W2a — mock-registry (AC-6):** `src/index.ts:108`. Envolver el `register` en `if (!isProduction) { await fastify.register(...) }` (CD-3, reusa constante línea 36). NO tocar `src/routes/mock-registry.ts` (CD-9 N/A; D-1).
  - **Test:** extender/crear test con `NODE_ENV=production` que monta el server (o el subset de rutas) y verifica `inject GET /mock-registry/agents → 404`. Patrón exemplar: `src/services/mock-registry.test.ts`.
- **W2b — /discover rate-limit (AC-5):** `src/routes/discover.ts` — quitar `config: { rateLimit: false }` de GET `/` (línea 22-23) y POST `/` (línea 62-64). NO tocar `GET /:slug` (CD-9). Corregir comentario `src/middleware/rate-limit.ts:9-11` (CD-8).
  - **Test:** crear `src/routes/discover.test.ts` (o extender). Patrón exemplar `src/middleware/rate-limit.test.ts`: `RATE_LIMIT_MAX` bajo en `beforeAll`, `registerRequestIdHook + registerErrorBoundary + registerRateLimit + register(discoverRoutes)`, N+1 injects → última 429 con `body.code==='RATE_LIMIT_EXCEEDED'` (CD-6, CD-10). Mockear `discoveryService.discover` para no hacer fanout real.

### W3 — .env.example + docs naming drift (AC-3 + AC-4)
- **`.env.example`:** agregar `DASHBOARD_ADMIN_TOKEN` (opt-in admin token para `/dashboard/api/*`; unset = dev abierto, set = X-Admin-Token requerido). Agregar `DISCOVERY_REGISTRY_TIMEOUT_MS` (timeout HTTP per-registry del fanout de discovery, default 5000, CD-7). Ampliar comentario de `SUPABASE_SERVICE_KEY` (aclarar naming vs docs legacy). Corregir comentario rate-limit línea 283 (quitar `/discover` de exempt, CD-8).
- **`CLAUDE.md:140`:** `SUPABASE_SERVICE_ROLE_KEY` → `SUPABASE_SERVICE_KEY`.
- **`.nexus/project-context.md:258`:** `SUPABASE_SERVICE_ROLE_KEY` → `SUPABASE_SERVICE_KEY`.
  - **Nota:** otras menciones de `SUPABASE_SERVICE_ROLE_KEY` en `CLAUDE.md` (bloque Security Conventions, ~líneas 138-150) son explicación conceptual de RLS; el Dev decide si alinearlas — recomendado para consistencia total, pero el AC-4 mínimo es la tabla de vars. Documentar en AR cuáles se cambiaron.
  - **Test:** script/aserto `grep -rn SUPABASE_SERVICE_ROLE_KEY .nexus/project-context.md` → 0 matches en la tabla de vars (AC-4). `grep` de las 3 vars en `.env.example` → presentes (AC-3).

### W4 — Biome format (AC-7)
- Ejecutar `npm run format` (DT-8) → escribe `src/lib/bazaar.ts` y `src/types/index.ts` (+ cualquier archivo tocado en W1-W3).
- Ejecutar `npm run lint` → debe reportar **zero errors**.
- TODOs: no-op verificado (§5). Documentar en AR.

---

## 8. Exemplars verificados (paths confirmados)

| Propósito | Exemplar (path:línea real) |
|-----------|----------------------------|
| Test de 429 con rate-limit + error-boundary | `src/middleware/rate-limit.test.ts:1-80` |
| Registro de ruta con prefix + inject en test | `src/services/mock-registry.test.ts:1-20` |
| Test de route con `vi.mock` de servicio + Fastify aislado | `src/routes/auth.test.ts:1-70` |
| Constante `isProduction` a reusar | `src/index.ts:36` |
| preHandler timing-safe a NO romper | `src/routes/dashboard.ts:29-47` |
| Body 429 / errorResponseBuilder | `src/middleware/rate-limit.ts:19-32` |
| Consumo real de `DISCOVERY_REGISTRY_TIMEOUT_MS` | `src/services/discovery.ts:262-266` |

---

## 9. Plan de tests (≥1 por AC)

| AC | Test | Archivo | Assert clave |
|----|------|---------|--------------|
| AC-1 | prod + token ausente → 503 | `src/routes/dashboard.test.ts` (nuevo) | `statusCode===503`, `body.error==='service_unavailable'`, `body.message==='Dashboard API not configured'` |
| AC-2 | dev (NODE_ENV unset/development) + token ausente → passthrough | `src/routes/dashboard.test.ts` | `statusCode===200` (stats/events mockeado) |
| (reg) | prod + token correcto → passthrough | `src/routes/dashboard.test.ts` | `statusCode===200`; token incorrecto → 401 (CD-5 regresión) |
| AC-3 | `.env.example` contiene las 3 vars | aserto/script (puede ir en `dashboard.test.ts` o script) | `readFileSync('.env.example')` incluye `DASHBOARD_ADMIN_TOKEN`, `DISCOVERY_REGISTRY_TIMEOUT_MS`, `SUPABASE_SERVICE_KEY` |
| AC-4 | docs sin `SUPABASE_SERVICE_ROLE_KEY` en tabla de vars | aserto/script | `grep -rn SUPABASE_SERVICE_ROLE_KEY .nexus/project-context.md` → 0 en línea de var; CLAUDE.md tabla → 0 |
| AC-5 | N+1 requests a GET /discover → 429 | `src/routes/discover.test.ts` (nuevo) | `RATE_LIMIT_MAX` bajo; última request `statusCode===429`, `body.code==='RATE_LIMIT_EXCEEDED'` (CD-6) |
| AC-6 | prod → `GET /mock-registry/agents` → 404 | `src/index.test.ts` o test dedicado | con `NODE_ENV=production` la ruta no monta → `statusCode===404` |
| AC-7 | `npm run lint` zero errors | evidencia AR (terminal) | `biome check src/` exit 0 |

**Nota AC-6 test:** montar el server completo en test es costoso (top-level await en `index.ts`). Alternativa pragmática: test que registra condicionalmente `mockRegistryRoutes` replicando el guard (`if (!isProduction)`) con `NODE_ENV=production` y verifica 404, mismo patrón que `src/services/mock-registry.test.ts`. El Dev elige; ambas validan AC-6.

---

## 10. Readiness Check (F2)

- [x] Work-item leído completo (7 ACs, 4 CDs, Scope IN/OUT).
- [x] `project-context.md` leído; drift `SUPABASE_SERVICE_ROLE_KEY` confirmado (línea 258, no 259).
- [x] Todos los exemplars verificados con Read (paths reales, §8).
- [x] `isProduction` confirmado en `src/index.ts:36` (CD-3 viable).
- [x] `requireAdminToken` y rutas con preHandler confirmadas (`/api/stats:83`, `/api/events:107`; HTML `/`:66 sin preHandler).
- [x] `rateLimit: false` confirmado en discover GET:23 / POST:64 / :slug:118.
- [x] Mecánica de caída al global verificada (`rate-limit.ts:34-46`).
- [x] **NEEDS CLARIFICATION resuelto:** `DISCOVERY_REGISTRY_TIMEOUT_MS` SÍ se consume (`discovery.ts:264`) → documentar como activa (CD-7), NO como reservada.
- [x] **TODOs resueltos:** 0 marcadores reales en `src/` (grep). Item del Scope IN = no-op verificado.
- [x] Diffs biome confirmados con corrida real (`bazaar.ts:88-90`, `types/index.ts:214`).
- [x] Plan de tests ≥1 por AC (§9).
- [x] Discrepancias documentadas (AC-5 body shape, comentario línea, project-context línea) — todas con resolución determinística, ninguna bloqueante.
- [x] Sin `[NEEDS CLARIFICATION]` pendientes.

**Estado: LISTO para SPEC_APPROVED.**
