# Work Item — WKH-20: Migrar framework de Hono a Fastify

**ID:** WKH-20  
**Tipo:** tech-task / refactor  
**Modo:** QUALITY  
**Branch:** `feat/wkh-20-fastify-migration`  
**Estado:** F1_COMPLETE — Listo para HU_APPROVED  
**Bloquea:** WKH-6, WKH-7 (y cualquier HU que toque routes)

---

## Objetivo

El código actual usa Hono pero `.nexus/project-context.md` define Fastify como framework del golden path. Esta HU migra todo el codebase de Hono a Fastify para restaurar la coherencia con el stack oficial antes de continuar con el sprint.

---

## Codebase Grounding (F0)

### Imports de Hono por archivo

| Archivo | Imports actuales |
|---------|-----------------|
| `src/index.ts` | `serve` de `@hono/node-server`, `Hono`, `cors` de `hono/cors`, `logger` de `hono/logger` |
| `src/routes/registries.ts` | `Hono` de `hono` |
| `src/routes/discover.ts` | `Hono` de `hono` |
| `src/routes/compose.ts` | `Hono` de `hono` |
| `src/routes/orchestrate.ts` | `Hono` de `hono` |
| `src/services/kite-client.test.ts` | Sin imports de Hono ✅ no necesita cambios |

### Tabla de migración Hono → Fastify

| Patrón Hono | Equivalente Fastify |
|-------------|---------------------|
| `new Hono()` | `Fastify({ logger: true })` |
| `app.use('*', cors())` | `fastify.register(cors)` via `@fastify/cors` |
| `app.use('*', logger())` | Logger nativo — `Fastify({ logger: true })` |
| `app.get('/', (c) => ...)` | `fastify.get('/', async (req, reply) => ...)` |
| `app.route('/prefix', subrouter)` | `fastify.register(plugin, { prefix: '/prefix' })` |
| `c.json({...})` | `reply.send({...})` |
| `c.json({...}, 404)` | `reply.status(404).send({...})` |
| `c.req.param('id')` | `(request.params as { id: string }).id` |
| `c.req.query()` | `request.query` |
| `await c.req.json()` | `request.body` (body parsing automático en Fastify) |
| `serve({ fetch: app.fetch, port })` | `fastify.listen({ port, host: '0.0.0.0' })` |
| Sub-router: `new Hono()` + export | `FastifyPluginAsync` + export |

---

## Acceptance Criteria (EARS)

| # | Criterio |
|---|----------|
| AC-1 | WHEN `GET /`, THEN retorna el mismo JSON de health/info que el actual (name, version, endpoints). |
| AC-2 | WHEN `POST /registries`, `GET /registries`, `GET /registries/:id`, `PATCH /registries/:id`, `DELETE /registries/:id`, THEN comportamiento funcional idéntico al actual. |
| AC-3 | WHEN `GET /discover` o `POST /discover`, THEN comportamiento funcional idéntico al actual. |
| AC-4 | WHEN `POST /compose`, THEN comportamiento funcional idéntico al actual. |
| AC-5 | WHEN `POST /orchestrate`, THEN comportamiento funcional idéntico al actual. |
| AC-6 | WHEN `npm run dev`, THEN el servidor arranca en puerto 3001 sin errores de compilación ni runtime. |
| AC-7 | WHEN `npm run build && node dist/index.js`, THEN el servidor arranca en producción sin errores. |
| AC-8 | WHEN `npm test`, THEN todos los tests existentes pasan sin modificaciones (los tests no usan Hono directamente). |
| AC-9 | IF algún archivo del proyecto importa `hono` o `@hono/node-server` después de esta HU, THEN es un error de implementación — el grep `grep -r "from 'hono'" src/` debe retornar vacío. |

---

## Scope IN

| Archivo | Acción | Descripción |
|---------|--------|-------------|
| `package.json` | MODIFICAR | Remover `hono`, `@hono/node-server`. Añadir `fastify@^4`, `@fastify/cors@^9` |
| `src/index.ts` | MODIFICAR | Reemplazar Hono app + serve() con Fastify server + listen() |
| `src/routes/registries.ts` | MODIFICAR | Migrar a `FastifyPluginAsync` |
| `src/routes/discover.ts` | MODIFICAR | Migrar a `FastifyPluginAsync` |
| `src/routes/compose.ts` | MODIFICAR | Migrar a `FastifyPluginAsync` |
| `src/routes/orchestrate.ts` | MODIFICAR | Migrar a `FastifyPluginAsync` |

## Scope OUT

| Archivo | Razón |
|---------|-------|
| `src/services/*` | Lógica de negocio no cambia |
| `src/types/index.ts` | Sin cambios de tipos |
| `src/lib/kite-chain.ts` | Sin cambios |
| `src/services/kite-client.ts` | Sin cambios |
| `src/services/kite-client.test.ts` | No usa Hono — sin cambios |
| `tsconfig.json` | `module: Node16` es compatible con Fastify |
| `doc/` | Sin cambios |

---

## Dependencias

- **Bloquea:** WKH-6, WKH-7 — deben reescribir sus work items con patrones Fastify una vez mergeada esta HU
- **No depende de:** ninguna HU anterior del sprint
- **Rama base:** `main` (no `feat/wkh-5-kite-chain` — la migración va sobre main limpio)

---

## Definition of Ready (DoR)

- [x] Objetivo definido (restaurar coherencia con golden path)
- [x] 9 ACs en formato EARS
- [x] Scope IN/OUT explícitos
- [x] Tabla de migración Hono→Fastify como referencia para el Dev
- [x] Sin [NEEDS CLARIFICATION] bloqueantes
- [x] Sin dependencias bloqueantes

---

F1_COMPLETE_V2 — Reescrito por Requirements Reviewer (2026-04-01)
