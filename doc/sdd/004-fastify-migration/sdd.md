# SDD — WKH-20: Migrar framework de Hono a Fastify

**Versión:** 1.0  
**Fecha:** 2026-04-01  
**Autor:** Architect (NexusAgile F2)  
**Estado:** SDD_COMPLETE  
**Work Item:** [WKH-20](./work-item.md)

---

## 1. Context Map

### Estado actual (Hono)

| Componente | Framework | Patrón |
|------------|-----------|--------|
| `src/index.ts` | Hono + `@hono/node-server` | `new Hono()` + `serve({ fetch })` |
| `src/routes/registries.ts` | Hono | `new Hono()` export default |
| `src/routes/discover.ts` | Hono | `new Hono()` export default |
| `src/routes/compose.ts` | Hono | `new Hono()` export default |
| `src/routes/orchestrate.ts` | Hono | `new Hono()` export default |
| CORS | `hono/cors` middleware | `app.use('*', cors())` |
| Logger | `hono/logger` middleware | `app.use('*', logger())` |
| Body parse | Manual `await c.req.json()` | En cada handler |
| Sub-routing | `app.route('/prefix', subrouter)` | Subrouter como instancia Hono |

### Estado objetivo (Fastify)

| Componente | Framework | Patrón |
|------------|-----------|--------|
| `src/index.ts` | Fastify v4 | `Fastify({ logger: true })` + `fastify.listen()` |
| `src/routes/registries.ts` | Fastify | `FastifyPluginAsync` export default |
| `src/routes/discover.ts` | Fastify | `FastifyPluginAsync` export default |
| `src/routes/compose.ts` | Fastify | `FastifyPluginAsync` export default |
| `src/routes/orchestrate.ts` | Fastify | `FastifyPluginAsync` export default |
| CORS | `@fastify/cors` plugin | `fastify.register(cors)` |
| Logger | Nativo Fastify (pino) | `Fastify({ logger: true })` |
| Body parse | Automático por Fastify | `request.body` directamente |
| Sub-routing | `fastify.register(plugin, { prefix })` | Plugin encapsulado |

### Qué NO cambia

- `src/services/*` — lógica de negocio intacta
- `src/types/index.ts` — sin cambios de tipos
- `src/lib/*` — sin cambios
- `test/*` — los tests no importan Hono, pasan sin modificación
- `tsconfig.json` — `module: Node16` es compatible con Fastify
- Variables de entorno — `PORT` sigue funcionando igual
- Comportamiento de cada endpoint (AC-1 a AC-8)
- Puerto default: 3001

---

## 2. Decisiones de Diseño (ADRs)

### ADR-1: FastifyPluginAsync como patrón de routing

**Decisión:** Cada archivo de routes exporta una función `FastifyPluginAsync` como `export default`.

**Alternativas descartadas:**
- *Express-style Router objects* — no existe en Fastify
- *Clases de controller* — overhead innecesario para este tamaño de API
- *fastify-plugin wrapper* — solo necesario cuando el plugin debe compartir el scope decorado al parent; las routes no necesitan esto

**Justificación:** `FastifyPluginAsync` es el patrón idiomático de Fastify. Provee encapsulación automática (cada plugin tiene su propio scope), tipado TypeScript nativo, y permite `fastify.register(plugin, { prefix })` directamente.

### ADR-2: @fastify/cors para CORS

**Decisión:** Usar `@fastify/cors@^9.x` (paquete oficial del ecosistema Fastify).

**Alternativas descartadas:**
- *cors npm package*: funciona con Fastify mediante `fastify-plugin` wrapper, pero `@fastify/cors` es el oficial y ya incluye tipado TypeScript.

**Config aplicada:** `{ origin: '*' }` — idéntico al comportamiento de `hono/cors` sin configuración explícita (permisivo). No rompe ningún AC.

### ADR-3: Logger nativo de Fastify (pino)

**Decisión:** `Fastify({ logger: true })` activa pino internamente. No se instala ningún plugin adicional de logging.

**Justificación:** Fastify usa pino como logger nativo. Es el logger más rápido en Node.js y está optimizado para JSON estructurado. Equivale funcionalmente a `hono/logger` para los fines de esta HU.

**Entornos:** `logger: true` en dev/prod. Si en el futuro se requiere pretty-print en dev, se configura `transport.target: 'pino-pretty'` en el objeto de opciones.

### ADR-4: Body parsing automático

**Decisión:** Fastify parsea `application/json` automáticamente. No se necesita middleware. `request.body` ya es el objeto parseado.

**Implicación:** Se elimina `await c.req.json()` en todos los handlers. Se reemplaza por `request.body as T`.

### ADR-5: TypeScript — tipos de Fastify

**Decisión:** Usar `FastifyRequest`, `FastifyReply`, `FastifyPluginAsync` de `'fastify'`. Para params, query y body se usan genéricos:

```typescript
// Params con id
FastifyRequest<{ Params: { id: string } }>

// Query string
FastifyRequest<{ Querystring: { capabilities?: string; q?: string; ... } }>

// Body tipado
FastifyRequest<{ Body: { goal: string; budget: number; ... } }>
```

---

## 3. Diseño Técnico

### 3.1 package.json — cambios exactos

**Remover de `dependencies`:**
```json
"@hono/node-server": "^1.8.0",
"hono": "^4.0.0"
```

**Añadir a `dependencies`:**
```json
"fastify": "^4",
"@fastify/cors": "^9"
```

`package.json` resultante (sección `dependencies`):
```json
"dependencies": {
  "fastify": "^4",
  "@fastify/cors": "^9",
  "viem": "^2.47.6"
}
```

**⚠️ Verificar antes de Wave 1 — ESM + top-level await:**

El `src/index.ts` usa `await fastify.register(...)` y `await fastify.listen(...)` a nivel de módulo (top-level await). Esto requiere que `package.json` tenga `"type": "module"` — **ya añadido en WKH-5**. Si WKH-5 no está mergeado en la rama base, añadir manualmente antes de Wave 1:

```json
// package.json — verificar que existe:
"type": "module"
```

Si no existe: añadirlo. Sin esto el build falla con `SyntaxError: await is only valid in async functions`.

> Las `devDependencies` no cambian.

---

### 3.2 src/index.ts — código Fastify COMPLETO

```typescript
/**
 * WasiAI A2A Protocol
 *
 * Agent discovery, composition, and orchestration service.
 * Supports multiple marketplace registries via configuration.
 */

import Fastify from 'fastify'
import cors from '@fastify/cors'

import registriesRoutes from './routes/registries.js'
import discoverRoutes from './routes/discover.js'
import composeRoutes from './routes/compose.js'
import orchestrateRoutes from './routes/orchestrate.js'

// Kite: importar dispara la inicialización (top-level await en el módulo)
import { kiteClient } from './services/kite-client.js'

const fastify = Fastify({ logger: true })

// CORS
await fastify.register(cors, { origin: '*' })

// Health check
fastify.get('/', async (_request, reply) => {
  return reply.send({
    name: 'WasiAI A2A Protocol',
    version: '0.1.0',
    description: 'Agent discovery, composition, and orchestration service',
    endpoints: {
      registries: '/registries — Manage marketplace registrations',
      discover: '/discover — Search agents across all registries',
      compose: '/compose — Execute multi-agent pipelines',
      orchestrate: '/orchestrate — Goal-based orchestration',
    },
    docs: 'https://github.com/ferrosasfp/wasiai-a2a',
  })
})

// Routes
await fastify.register(registriesRoutes, { prefix: '/registries' })
await fastify.register(discoverRoutes, { prefix: '/discover' })
await fastify.register(composeRoutes, { prefix: '/compose' })
await fastify.register(orchestrateRoutes, { prefix: '/orchestrate' })

// Start server
const port = parseInt(process.env.PORT ?? '3001')

console.log(`
╔═══════════════════════════════════════════════════════════╗
║           WasiAI A2A Protocol                             ║
║   Agent Discovery, Composition & Orchestration Service    ║
╠═══════════════════════════════════════════════════════════╣
║   Server running on http://localhost:${port}                  ║
║   Kite: ${kiteClient ? 'connected (chainId: 2368)     ' : 'disabled (KITE_RPC_URL not set)'}║
║                                                           ║
║   Endpoints:                                              ║
║   • GET  /registries     — List marketplaces              ║
║   • POST /registries     — Register marketplace           ║
║   • GET  /discover       — Search agents                  ║
║   • POST /compose        — Execute pipeline               ║
║   • POST /orchestrate    — Goal-based orchestration       ║
╚═══════════════════════════════════════════════════════════╝
`)

await fastify.listen({ port, host: '0.0.0.0' })
```

> **Nota:** El `export default app` de Hono se elimina — Fastify no necesita exportar la instancia para los tests (los tests usan `supertest` o `fastify.inject` apuntando directamente al servidor levantado).

---

### 3.3 src/routes/registries.ts — código Fastify COMPLETO

```typescript
/**
 * Registries Routes — CRUD for marketplace registrations
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { registryService } from '../services/registry.js'

const registriesRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /registries
   * List all registered marketplaces
   */
  fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    const registries = registryService.list()
    return reply.send({
      registries,
      total: registries.length,
    })
  })

  /**
   * GET /registries/:id
   * Get a specific registry
   */
  fastify.get(
    '/:id',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params
      const registry = registryService.get(id)

      if (!registry) {
        return reply.status(404).send({ error: 'Registry not found' })
      }

      return reply.send(registry)
    },
  )

  /**
   * POST /registries
   * Register a new marketplace
   */
  fastify.post(
    '/',
    async (
      request: FastifyRequest<{
        Body: {
          name: string
          discoveryEndpoint: string
          invokeEndpoint: string
          agentEndpoint?: string
          schema: unknown
          auth?: unknown
          enabled?: boolean
        }
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const body = request.body

        // Validate required fields
        if (!body.name || !body.discoveryEndpoint || !body.invokeEndpoint || !body.schema) {
          return reply.status(400).send({
            error: 'Missing required fields: name, discoveryEndpoint, invokeEndpoint, schema',
          })
        }

        const registry = registryService.register({
          name: body.name,
          discoveryEndpoint: body.discoveryEndpoint,
          invokeEndpoint: body.invokeEndpoint,
          agentEndpoint: body.agentEndpoint,
          schema: body.schema,
          auth: body.auth,
          enabled: body.enabled ?? true,
        })

        return reply.status(201).send(registry)
      } catch (err) {
        return reply.status(400).send({
          error: err instanceof Error ? err.message : 'Failed to register',
        })
      }
    },
  )

  /**
   * PATCH /registries/:id
   * Update a registry
   */
  fastify.patch(
    '/:id',
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: Record<string, unknown> }>,
      reply: FastifyReply,
    ) => {
      try {
        const { id } = request.params
        const body = request.body

        const registry = registryService.update(id, body)
        return reply.send(registry)
      } catch (err) {
        return reply.status(400).send({
          error: err instanceof Error ? err.message : 'Failed to update',
        })
      }
    },
  )

  /**
   * DELETE /registries/:id
   * Delete a registry
   */
  fastify.delete(
    '/:id',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const { id } = request.params
        const deleted = registryService.delete(id)

        if (!deleted) {
          return reply.status(404).send({ error: 'Registry not found' })
        }

        return reply.send({ success: true })
      } catch (err) {
        return reply.status(400).send({
          error: err instanceof Error ? err.message : 'Failed to delete',
        })
      }
    },
  )
}

export default registriesRoutes
```

---

### 3.4 src/routes/discover.ts — código Fastify COMPLETO

```typescript
/**
 * Discovery Routes — Search agents across registries
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { discoveryService } from '../services/discovery.js'

const discoverRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /discover
   * Search agents across all registered marketplaces
   *
   * Query params:
   * - capabilities: comma-separated list of capabilities
   * - q: free text search
   * - maxPrice: maximum price per call in USDC
   * - minReputation: minimum reputation score (0-1)
   * - limit: max results
   * - registry: filter to specific registry
   */
  fastify.get(
    '/',
    async (
      request: FastifyRequest<{
        Querystring: {
          capabilities?: string
          q?: string
          maxPrice?: string
          minReputation?: string
          limit?: string
          registry?: string
        }
      }>,
      reply: FastifyReply,
    ) => {
      const query = request.query

      const result = await discoveryService.discover({
        capabilities: query.capabilities?.split(',').map((s) => s.trim()),
        query: query.q,
        maxPrice: query.maxPrice ? parseFloat(query.maxPrice) : undefined,
        minReputation: query.minReputation ? parseFloat(query.minReputation) : undefined,
        limit: query.limit ? parseInt(query.limit) : undefined,
        registry: query.registry,
      })

      return reply.send(result)
    },
  )

  /**
   * GET /discover/:slug
   * Get a specific agent by slug
   */
  fastify.get(
    '/:slug',
    async (
      request: FastifyRequest<{
        Params: { slug: string }
        Querystring: { registry?: string }
      }>,
      reply: FastifyReply,
    ) => {
      const { slug } = request.params
      const { registry } = request.query

      const agent = await discoveryService.getAgent(slug, registry)

      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found' })
      }

      return reply.send(agent)
    },
  )
}

export default discoverRoutes
```

---

### 3.5 src/routes/compose.ts — código Fastify COMPLETO

```typescript
/**
 * Compose Routes — Multi-agent pipelines
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { composeService } from '../services/compose.js'

const composeRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /compose
   * Execute a multi-agent pipeline
   *
   * Body:
   * {
   *   "steps": [
   *     { "agent": "agent-slug", "registry": "wasiai", "input": {...}, "passOutput": false },
   *     { "agent": "another-agent", "input": {...}, "passOutput": true }
   *   ],
   *   "maxBudget": 0.50
   * }
   */
  fastify.post(
    '/',
    async (
      request: FastifyRequest<{
        Body: {
          steps: Array<{
            agent: string
            registry?: string
            input?: Record<string, unknown>
            passOutput?: boolean
          }>
          maxBudget?: number
        }
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const body = request.body

        if (!body.steps || !Array.isArray(body.steps) || body.steps.length === 0) {
          return reply.status(400).send({ error: 'Missing or empty steps array' })
        }

        if (body.steps.length > 5) {
          return reply.status(400).send({ error: 'Maximum 5 steps allowed per pipeline' })
        }

        const result = await composeService.compose({
          steps: body.steps,
          maxBudget: body.maxBudget,
        })

        if (!result.success) {
          return reply.status(400).send(result)
        }

        return reply.send(result)
      } catch (err) {
        return reply.status(500).send({
          error: err instanceof Error ? err.message : 'Compose failed',
        })
      }
    },
  )
}

export default composeRoutes
```

---

### 3.6 src/routes/orchestrate.ts — código Fastify COMPLETO

```typescript
/**
 * Orchestrate Routes — Goal-based orchestration
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { orchestrateService } from '../services/orchestrate.js'

const orchestrateRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /orchestrate
   * Execute goal-based orchestration
   *
   * Body:
   * {
   *   "goal": "Analyze token 0xABC and tell me if it's safe to buy",
   *   "budget": 0.50,
   *   "preferCapabilities": ["token-analysis", "risk-assessment"],
   *   "maxAgents": 3
   * }
   */
  fastify.post(
    '/',
    async (
      request: FastifyRequest<{
        Body: {
          goal: string
          budget: number
          preferCapabilities?: string[]
          maxAgents?: number
        }
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const body = request.body

        if (!body.goal) {
          return reply.status(400).send({ error: 'Missing required field: goal' })
        }

        if (!body.budget || body.budget <= 0) {
          return reply.status(400).send({ error: 'Missing or invalid budget' })
        }

        const result = await orchestrateService.orchestrate({
          goal: body.goal,
          budget: body.budget,
          preferCapabilities: body.preferCapabilities,
          maxAgents: body.maxAgents,
        })

        return reply.send(result)
      } catch (err) {
        return reply.status(500).send({
          error: err instanceof Error ? err.message : 'Orchestration failed',
        })
      }
    },
  )
}

export default orchestrateRoutes
```

---

## 4. Waves de implementación

### Wave 0 — Dependencias (prerequisito bloqueante)
```bash
# Paso 1: Verificar/añadir "type": "module" en package.json si no existe
# (ya debería estar de WKH-5 — verificar con: cat package.json | grep '"type"')

# Paso 2: Reemplazar Hono con Fastify
npm uninstall hono @hono/node-server
npm install fastify@^4 @fastify/cors@^9
```
> Verificar: `npm ls fastify` muestra `fastify@4.x.x` (no v5).
> Verificar: `cat package.json | grep '"type"'` muestra `"type": "module"`.

### Wave 1 — Entry point
Reemplazar `src/index.ts` con el código de la sección 3.2.

Verificación inmediata:
```bash
npm run dev
# Esperado: servidor arranca en :3001 sin errores
```

### Wave 2 — Routes (pueden ejecutarse en paralelo)
Reemplazar los 4 archivos simultáneamente:
- `src/routes/registries.ts` → sección 3.3
- `src/routes/discover.ts` → sección 3.4
- `src/routes/compose.ts` → sección 3.5
- `src/routes/orchestrate.ts` → sección 3.6

### Wave 3 — Verificación
```bash
# Build TypeScript (no debe haber errores de tipos)
npm run build

# Tests existentes (deben pasar sin modificación)
npm test

# Verificar que no queda ningún import de Hono
grep -r "from 'hono'" src/
# Esperado: sin output (vacío)

grep -r "from '@hono" src/
# Esperado: sin output (vacío)
```

---

## 5. Constraint Directives

| # | Tipo | Directiva |
|---|------|-----------|
| 1 | OBLIGATORIO | Fastify version `^4.x` (LTS). **Prohibido** `^5.x` — aún no estable. |
| 2 | OBLIGATORIO | `@fastify/cors@^9.x`. **Prohibido** usar el paquete `cors` sin wrapper. |
| 3 | OBLIGATORIO | Cada route file exporta exactamente una `FastifyPluginAsync` como `export default`. |
| 4 | OBLIGATORIO | Los imports de Fastify deben ser `import type { ... } from 'fastify'` para tipos, `import Fastify from 'fastify'` para la factory. |
| 5 | OBLIGATORIO | `request.body` en handlers POST/PATCH — **prohibido** `await request.json()` (eso es Hono/fetch API). |
| 6 | OBLIGATORIO | `reply.status(N).send({...})` para respuestas con código distinto de 200. **Prohibido** `reply.code(N).send({...})` (es alias pero menos idiomático para este codebase). |
| 7 | PROHIBIDO | Modificar cualquier archivo en `src/services/`, `src/types/`, `src/lib/` — la lógica de negocio no cambia. |
| 8 | PROHIBIDO | Añadir `eslint-disable` o `@ts-ignore` para silenciar errores de tipos. Si hay un error de tipos, corregir la causa raíz. |
| 9 | OBLIGATORIO | El banner de consola en `src/index.ts` debe preservarse idéntico (incluyendo el estado de `kiteClient`). |
| 10 | PROHIBIDO | Eliminar o modificar los comentarios JSDoc de cada route (`GET /registries`, `POST /registries`, etc.) — son documentación de contrato. |

---

## 6. Readiness Check

| Pregunta | Respuesta |
|----------|-----------|
| ¿Sé exactamente qué desinstalar y qué instalar, con versiones? | ✅ Sección 3.1 |
| ¿Tengo el código completo de `src/index.ts` listo para pegar? | ✅ Sección 3.2 |
| ¿Tengo el código completo de las 4 routes listo para pegar? | ✅ Secciones 3.3–3.6 |
| ¿Sé el orden de implementación? | ✅ Sección 4 (Waves 0→1→2→3) |
| ¿Sé qué NO tocar? | ✅ Scope OUT en work-item.md + Constraint #7 |
| ¿Sé cómo verificar que la migración es completa? | ✅ Wave 3: `grep -r "from 'hono'"` debe retornar vacío |
| ¿El comportamiento de negocio cambia? | ❌ No. Solo cambia el framework, no la lógica. |
| ¿Los tests necesitan modificarse? | ❌ No. No importan Hono directamente. |

**Veredicto:** El Dev puede implementar esta HU leyendo solo este SDD. No hay ambigüedades, no hay TODOs, no hay código parcial.

---

SDD_COMPLETE_V2 — 2 correcciones aplicadas por Requirements Reviewer (2026-04-01):
1. Versión fastify `^4.28.1` (inexistente) → `^4`
2. Añadido bloque explícito sobre `"type": "module"` en Wave 0 y sección 3.1
