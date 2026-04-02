# Story File — WKH-20: Migrar framework de Hono a Fastify

**Estado:** Listo para implementación  
**Rama:** `feat/wkh-20-fastify-migration`  
**Modo:** QUALITY

---

## Contexto

El codebase actual usa Hono como framework HTTP, pero el golden path del proyecto define Fastify. Esta HU migra `src/index.ts` y los 4 archivos de routes de Hono a Fastify v4, restaurando la coherencia con el stack oficial. La lógica de negocio (`src/services/*`, `src/types/*`, `src/lib/*`) no se toca en absoluto.

El cambio es puro framework swap: mismos endpoints, mismos contratos, mismo comportamiento. El Dev implementa leyendo solo este archivo — no hay preguntas, no hay ambigüedades.

---

## Branch

```bash
git checkout -b feat/wkh-20-fastify-migration
```

---

## Archivos a crear/modificar

| Archivo | Acción |
|---------|--------|
| `package.json` | MODIFICAR — quitar Hono, añadir Fastify |
| `src/index.ts` | REEMPLAZAR completo |
| `src/routes/registries.ts` | REEMPLAZAR completo |
| `src/routes/discover.ts` | REEMPLAZAR completo |
| `src/routes/compose.ts` | REEMPLAZAR completo |
| `src/routes/orchestrate.ts` | REEMPLAZAR completo |

**No tocar:** `src/services/*`, `src/types/*`, `src/lib/*`, `tsconfig.json`, `test/*`, `doc/*`

---

## Implementación Wave por Wave

### Wave 0: package.json + `"type":"module"`

**Paso 1 — Verificar que existe `"type": "module"` en package.json:**

```bash
cat package.json | grep '"type"'
```

- Si aparece `"type": "module"` → continúa.
- Si NO aparece → añadirlo al `package.json` (al mismo nivel que `"name"`, `"version"`, etc.).

**Paso 2 — Reemplazar dependencias de Hono con Fastify:**

En la sección `dependencies` de `package.json`:

Remover:
```json
"@hono/node-server": "^1.8.0",
"hono": "^4.0.0"
```

Añadir:
```json
"fastify": "^4",
"@fastify/cors": "^9"
```

La sección `dependencies` resultante debe quedar:
```json
"dependencies": {
  "fastify": "^4",
  "@fastify/cors": "^9",
  "viem": "^2.47.6"
}
```

**Paso 3 — Instalar:**

```bash
npm uninstall hono @hono/node-server
npm install fastify@^4 @fastify/cors@^9
```

**Verificación Wave 0:**
```bash
npm ls fastify
# Esperado: fastify@4.x.x (NO v5)

cat package.json | grep '"type"'
# Esperado: "type": "module"
```

---

### Wave 1: src/index.ts — CÓDIGO COMPLETO

Reemplaza el contenido completo de `src/index.ts` con esto:

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

**Verificación Wave 1:**
```bash
npm run dev
# Esperado: servidor arranca en :3001 sin errores
```

---

### Wave 2: src/routes/* — CÓDIGO COMPLETO (4 archivos)

Los 4 archivos pueden reemplazarse simultáneamente.

---

#### src/routes/registries.ts

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

#### src/routes/discover.ts

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

#### src/routes/compose.ts

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

#### src/routes/orchestrate.ts

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

### Wave 3: Verificación

```bash
# Build TypeScript — debe completar sin errores de tipos
npm run build

# Tests existentes — deben pasar sin modificaciones
npm test

# Verificar que no quedan imports de Hono
grep -r "from 'hono'" src/
# Esperado: sin output (vacío)

grep -r "from '@hono" src/
# Esperado: sin output (vacío)
```

---

## Verificación por Wave (comandos exactos)

| Wave | Comando | Resultado esperado |
|------|---------|-------------------|
| Wave 0 | `npm ls fastify` | `fastify@4.x.x` (NO v5) |
| Wave 0 | `cat package.json \| grep '"type"'` | `"type": "module"` |
| Wave 1 | `npm run dev` | Servidor arranca en `:3001` sin errores |
| Wave 3 | `npm run build` | Sin errores de TypeScript |
| Wave 3 | `npm test` | Todos los tests pasan |
| Wave 3 | `grep -r "from 'hono'" src/` | Sin output (vacío) |
| Wave 3 | `grep -r "from '@hono" src/` | Sin output (vacío) |

---

## Acceptance Criteria (9 ACs EARS)

| # | Criterio |
|---|----------|
| AC-1 | WHEN `GET /`, THEN retorna JSON con campos `name`, `version`, `description`, `endpoints`, `docs`. |
| AC-2 | WHEN `POST /registries`, `GET /registries`, `GET /registries/:id`, `PATCH /registries/:id`, `DELETE /registries/:id`, THEN comportamiento funcional idéntico al actual. |
| AC-3 | WHEN `GET /discover` con query params (`capabilities`, `q`, `maxPrice`, `minReputation`, `limit`, `registry`), THEN comportamiento funcional idéntico al actual. |
| AC-4 | WHEN `GET /discover/:slug`, THEN retorna el agente o `404` con `{ error: 'Agent not found' }`. |
| AC-5 | WHEN `POST /compose` con `steps` array válido (1–5 pasos), THEN comportamiento funcional idéntico al actual. |
| AC-6 | WHEN `POST /orchestrate` con `goal` y `budget` válidos, THEN comportamiento funcional idéntico al actual. |
| AC-7 | WHEN `npm run dev`, THEN el servidor arranca en puerto `3001` sin errores de compilación ni runtime. |
| AC-8 | WHEN `npm run build && node dist/index.js`, THEN el servidor arranca en producción sin errores. |
| AC-9 | IF algún archivo en `src/` importa `hono` o `@hono/node-server` tras esta HU, THEN es un error — `grep -r "from 'hono'" src/` debe retornar vacío. |

---

## Prohibiciones

- **PROHIBIDO** usar `fastify@^5.x` — solo `^4`.
- **PROHIBIDO** usar el paquete `cors` sin wrapper oficial — usar únicamente `@fastify/cors@^9`.
- **PROHIBIDO** usar `await request.json()` en handlers — Fastify parsea automáticamente; usar `request.body`.
- **PROHIBIDO** modificar cualquier archivo en `src/services/`, `src/types/`, `src/lib/`.
- **PROHIBIDO** añadir `@ts-ignore` o `eslint-disable` para silenciar errores de tipos. Si hay error de tipos, corregir la causa raíz.
- **PROHIBIDO** eliminar los comentarios JSDoc de cada route (`GET /registries`, `POST /registries`, etc.).
- **PROHIBIDO** eliminar o modificar el banner ASCII del `console.log` en `src/index.ts`.
- **PROHIBIDO** exportar la instancia `fastify` desde `src/index.ts` — no se necesita.

---

## Definition of Done (checklist)

- [ ] `package.json` tiene `"type": "module"`, `fastify@^4`, `@fastify/cors@^9`; sin `hono` ni `@hono/node-server`
- [ ] `src/index.ts` usa `Fastify({ logger: true })` + `fastify.listen()`
- [ ] Los 4 archivos de routes exportan `FastifyPluginAsync` como `export default`
- [ ] `npm run dev` — servidor arranca en `:3001` sin errores
- [ ] `npm run build` — sin errores de TypeScript
- [ ] `npm test` — todos los tests pasan sin modificaciones
- [ ] `grep -r "from 'hono'" src/` — retorna vacío
- [ ] `grep -r "from '@hono" src/` — retorna vacío
- [ ] `src/services/*`, `src/types/*`, `src/lib/*` — sin cambios (verificar con `git diff`)
- [ ] PR abierta hacia `main` con descripción del cambio
