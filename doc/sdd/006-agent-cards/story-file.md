# Story File — WKH-15: Agent Cards (A2A Protocol)

> **Branch:** `feat/wkh-15-agent-cards` | **Talla:** S-M | **Fecha:** 2026-04-03

---

## Resumen

Implementar dos endpoints que generan Agent Cards conformes al estándar Google A2A Protocol:

1. **`GET /agents/:slug/agent-card`** — Retorna el Agent Card de un agente descubierto vía registries
2. **`GET /.well-known/agent.json`** — Retorna el Agent Card del propio gateway WasiAI

Los Agent Cards se generan on-the-fly (sin persistencia) a partir de los datos existentes en `discoveryService` y `registryService`.

---

## Acceptance Criteria

| # | Tipo | Criterio |
|---|------|----------|
| AC-1 | WHEN | WHEN un cliente hace `GET /agents/:slug/agent-card` con un slug válido, THEN retorna HTTP 200 con JSON conforme al schema AgentCard |
| AC-2 | WHEN | WHEN el agente no existe en ningún registry, THEN retorna HTTP 404 con `{ "error": "Agent not found" }` |
| AC-3 | IF | IF el agente tiene capabilities, THEN se mapean a `skills[]` con `id`, `name` y `description` |
| AC-4 | WHEN | WHEN se genera el Agent Card, THEN incluye `capabilities.streaming: false`, `capabilities.pushNotifications: false` |
| AC-5 | WHEN | WHEN se genera el Agent Card, THEN `authentication.schemes` se deriva dinámicamente: `'bearer'` → `["bearer"]`, `'header'` → `["apiKey"]`, `'query'` → `[]`, sin auth → `[]` |
| AC-6 | IF | IF el query param `?registry=<id>` está presente, THEN la búsqueda se filtra a ese registry |
| AC-7 | WHEN | WHEN un cliente hace `GET /.well-known/agent.json`, THEN retorna HTTP 200 con el Agent Card del gateway (name="WasiAI A2A Gateway", skills: discover/compose/orchestrate) |

---

## Constraint Directives

| # | Prohibición |
|---|-------------|
| CD-1 | **NO `any`** — TypeScript strict, todos los tipos explícitos |
| CD-2 | **NO ethers.js** — si se necesita crypto, usar `viem` |
| CD-3 | **NO hardcodes de auth schemes** — usar `resolveAuthSchemes()` dinámico |
| CD-4 | **NO clases** — singleton object literals (patrón codebase) |
| CD-5 | **NO `require()`** — ESM only (`import/export`) |
| CD-6 | **NO persistencia de Agent Cards** — se generan on-the-fly |
| CD-7 | **NO modificar** `discoveryService` ni `registryService` — consumir interfaces existentes |
| CD-8 | **NO campos A2A v2** (`provider`, `version`, `defaultInputModes`) — diferidos |
| CD-9 | **`Agent.registry`** almacena el **name** del registry, no el id. Match por name: `registries.find(r => r.name === agent.registry)` |
| CD-10 | **Puerto 3001** — no cambiar |
| CD-11 | **NO usar `request.protocol` directamente** — usar `resolveBaseUrl(request)` que respeta `BASE_URL` env → `X-Forwarded-Proto` → fallback `request.protocol` |
| CD-12 | **NO asumir modalidades del agente** — usar default `['text/plain']` hasta que `Agent` incluya `inputModes`/`outputModes` |

---

## Exemplars — Archivos de referencia

Lee estos archivos antes de codificar. Son el patrón a seguir:

| Patrón | Archivo | Qué observar |
|--------|---------|--------------|
| Servicio singleton | `src/services/discovery.ts` | Object literal exportado, métodos async, funciones puras |
| Ruta Fastify | `src/routes/discover.ts` | `FastifyPluginAsync`, `export default`, typed `Params`/`Querystring`, `reply.send()`/`reply.status(404).send()` |
| Tests vitest | `src/services/kite-client.test.ts` | `describe/it/expect/vi`, `vi.mock` para dependencias |
| Registro de rutas | `src/index.ts` | `await fastify.register(routes, { prefix })` — líneas 42-45 |
| Tipos | `src/types/index.ts` | Interfaces planas al final del archivo, sin clases |

---

## Plan de Waves

### Wave 1 — Tipos (bloqueante)

| Archivo | Acción | Detalle |
|---------|--------|---------|
| `src/types/index.ts` | MODIFICAR | Agregar al final del archivo |

**Código a agregar al final de `src/types/index.ts`:**

```typescript
// ============================================================
// AGENT CARD TYPES (Google A2A Protocol)
// ============================================================

export interface AgentSkill {
  id: string
  name: string
  description: string
}

export interface AgentCard {
  name: string
  description: string
  url: string
  capabilities: {
    streaming: boolean
    pushNotifications: boolean
  }
  skills: AgentSkill[]
  inputModes: string[]
  outputModes: string[]
  authentication: {
    schemes: string[]
  }
}
```

---

### Wave 2 — Servicio + Tests unitarios

| Archivo | Acción | Detalle |
|---------|--------|---------|
| `src/services/agent-card.ts` | CREAR | Servicio con `resolveBaseUrl`, `resolveAuthSchemes`, `buildAgentCard`, `buildSelfAgentCard` |
| `src/services/agent-card.test.ts` | CREAR | Tests unitarios |

**`src/services/agent-card.ts`** — código completo:

```typescript
import type { FastifyRequest } from 'fastify'
import type { Agent, AgentCard, AgentSkill, RegistryConfig } from '../types/index.js'

/**
 * Resolve the public base URL for the gateway.
 *
 * Resolution order:
 *   1. env `BASE_URL` (explicit, highest priority)
 *   2. `X-Forwarded-Proto` header (set by most proxies) + request.hostname
 *   3. Fallback: request.protocol + request.hostname
 */
export function resolveBaseUrl(request: FastifyRequest): string {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/$/, '')
  }

  const proto = (request.headers['x-forwarded-proto'] as string | undefined) ?? request.protocol
  return `${proto}://${request.hostname}`
}

export const agentCardService = {
  /**
   * Resolve auth schemes from registry config.
   * bearer → ["bearer"], header → ["apiKey"], query → [], undefined → []
   */
  resolveAuthSchemes(registryConfig: RegistryConfig): string[] {
    if (!registryConfig.auth?.type) return []

    switch (registryConfig.auth.type) {
      case 'bearer':
        return ['bearer']
      case 'header':
        return ['apiKey']
      case 'query':
        return []
    }

    return []
  },

  /**
   * Build an A2A Agent Card from an internal Agent + its registry config.
   */
  buildAgentCard(agent: Agent, registryConfig: RegistryConfig, baseUrl: string): AgentCard {
    const skills: AgentSkill[] = agent.capabilities.map((cap) => ({
      id: cap,
      name: cap,
      description: cap,
    }))

    return {
      name: agent.name,
      description: agent.description,
      url: `${baseUrl}/agents/${agent.slug}`,
      capabilities: {
        streaming: false,
        pushNotifications: false,
      },
      skills,
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
      authentication: {
        schemes: this.resolveAuthSchemes(registryConfig),
      },
    }
  },

  /**
   * Build the gateway's own Agent Card (self-card).
   */
  buildSelfAgentCard(baseUrl: string): AgentCard {
    return {
      name: 'WasiAI A2A Gateway',
      description:
        'A2A-compliant gateway that discovers, composes, and orchestrates AI agents from multiple registries',
      url: baseUrl,
      capabilities: {
        streaming: false,
        pushNotifications: false,
      },
      skills: [
        {
          id: 'discover',
          name: 'Discover Agents',
          description: 'Search and discover AI agents across multiple registries',
        },
        {
          id: 'compose',
          name: 'Compose Agents',
          description: 'Execute multi-agent pipelines with sequential steps',
        },
        {
          id: 'orchestrate',
          name: 'Orchestrate Agents',
          description: 'Goal-based orchestration that automatically selects and chains agents',
        },
      ],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
      authentication: {
        schemes: [],
      },
    }
  },
}
```

**`src/services/agent-card.test.ts`** — tests unitarios:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { agentCardService, resolveBaseUrl } from './agent-card.js'
import type { Agent, RegistryConfig } from '../types/index.js'

// ---------- resolveAuthSchemes ----------

describe('agentCardService', () => {
  describe('resolveAuthSchemes', () => {
    it('returns ["bearer"] for auth.type bearer', () => {
      const config = { auth: { type: 'bearer', token: 'x' } } as RegistryConfig
      expect(agentCardService.resolveAuthSchemes(config)).toEqual(['bearer'])
    })

    it('returns ["apiKey"] for auth.type header', () => {
      const config = { auth: { type: 'header', name: 'X-Key', value: 'x' } } as RegistryConfig
      expect(agentCardService.resolveAuthSchemes(config)).toEqual(['apiKey'])
    })

    it('returns [] for auth.type query', () => {
      const config = { auth: { type: 'query', name: 'key', value: 'x' } } as RegistryConfig
      expect(agentCardService.resolveAuthSchemes(config)).toEqual([])
    })

    it('returns [] when auth is undefined', () => {
      const config = {} as RegistryConfig
      expect(agentCardService.resolveAuthSchemes(config)).toEqual([])
    })
  })

  // ---------- buildAgentCard ----------

  describe('buildAgentCard', () => {
    const agent: Agent = {
      slug: 'test-agent',
      name: 'Test Agent',
      description: 'A test agent',
      capabilities: ['summarize', 'translate'],
      registry: 'my-registry',
    } as Agent

    const registryConfig = {
      auth: { type: 'bearer', token: 'tok' },
    } as RegistryConfig

    const baseUrl = 'https://api.wasiai.io'

    it('maps agent fields to AgentCard fields', () => {
      const card = agentCardService.buildAgentCard(agent, registryConfig, baseUrl)
      expect(card.name).toBe('Test Agent')
      expect(card.description).toBe('A test agent')
    })

    it('maps capabilities to skills with id/name/description', () => {
      const card = agentCardService.buildAgentCard(agent, registryConfig, baseUrl)
      expect(card.skills).toEqual([
        { id: 'summarize', name: 'summarize', description: 'summarize' },
        { id: 'translate', name: 'translate', description: 'translate' },
      ])
    })

    it('sets streaming and pushNotifications to false', () => {
      const card = agentCardService.buildAgentCard(agent, registryConfig, baseUrl)
      expect(card.capabilities).toEqual({ streaming: false, pushNotifications: false })
    })

    it('sets inputModes and outputModes to ["text/plain"]', () => {
      const card = agentCardService.buildAgentCard(agent, registryConfig, baseUrl)
      expect(card.inputModes).toEqual(['text/plain'])
      expect(card.outputModes).toEqual(['text/plain'])
    })

    it('constructs url from baseUrl + /agents/ + slug', () => {
      const card = agentCardService.buildAgentCard(agent, registryConfig, baseUrl)
      expect(card.url).toBe('https://api.wasiai.io/agents/test-agent')
    })

    it('delegates auth to resolveAuthSchemes', () => {
      const card = agentCardService.buildAgentCard(agent, registryConfig, baseUrl)
      expect(card.authentication.schemes).toEqual(['bearer'])
    })
  })

  // ---------- buildSelfAgentCard ----------

  describe('buildSelfAgentCard', () => {
    it('returns gateway card with correct name', () => {
      const card = agentCardService.buildSelfAgentCard('https://gw.wasiai.io')
      expect(card.name).toBe('WasiAI A2A Gateway')
    })

    it('includes discover, compose, orchestrate skills', () => {
      const card = agentCardService.buildSelfAgentCard('https://gw.wasiai.io')
      expect(card.skills.map((s) => s.id)).toEqual(['discover', 'compose', 'orchestrate'])
    })

    it('sets empty auth schemes', () => {
      const card = agentCardService.buildSelfAgentCard('https://gw.wasiai.io')
      expect(card.authentication.schemes).toEqual([])
    })

    it('uses baseUrl as url', () => {
      const card = agentCardService.buildSelfAgentCard('https://gw.wasiai.io')
      expect(card.url).toBe('https://gw.wasiai.io')
    })
  })
})

// ---------- resolveBaseUrl ----------

describe('resolveBaseUrl', () => {
  const originalEnv = process.env.BASE_URL

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.BASE_URL
    } else {
      process.env.BASE_URL = originalEnv
    }
  })

  it('returns BASE_URL env when set (strips trailing slash)', () => {
    process.env.BASE_URL = 'https://api.wasiai.io/'
    const request = { headers: {}, protocol: 'http', hostname: 'localhost' } as any
    expect(resolveBaseUrl(request)).toBe('https://api.wasiai.io')
  })

  it('uses X-Forwarded-Proto header when present', () => {
    delete process.env.BASE_URL
    const request = {
      headers: { 'x-forwarded-proto': 'https' },
      protocol: 'http',
      hostname: 'api.wasiai.io',
    } as any
    expect(resolveBaseUrl(request)).toBe('https://api.wasiai.io')
  })

  it('falls back to request.protocol when no proxy headers', () => {
    delete process.env.BASE_URL
    const request = { headers: {}, protocol: 'http', hostname: 'localhost:3001' } as any
    expect(resolveBaseUrl(request)).toBe('http://localhost:3001')
  })
})
```

---

### Wave 3 — Rutas + Registro + Tests integración

| Archivo | Acción | Detalle |
|---------|--------|---------|
| `src/routes/agent-card.ts` | CREAR | `GET /:slug/agent-card` |
| `src/routes/well-known.ts` | CREAR | `GET /agent.json` |
| `src/index.ts` | MODIFICAR | Import + register rutas + actualizar health check endpoints |
| `src/routes/agent-card.test.ts` | CREAR | Tests integración |

**`src/routes/agent-card.ts`** — código completo:

```typescript
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { discoveryService } from '../services/discovery.js'
import { registryService } from '../services/registry.js'
import { agentCardService, resolveBaseUrl } from '../services/agent-card.js'

const agentCardRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /agents/:slug/agent-card
   * Returns an A2A-compliant Agent Card for the given agent.
   */
  fastify.get(
    '/:slug/agent-card',
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

      // ⚠️ CD-9: Agent.registry = name, NOT id. Match by name.
      const registries = await registryService.getEnabled()
      const registryConfig = registries.find((r) => r.name === agent.registry)

      if (!registryConfig) {
        return reply.status(404).send({ error: 'Agent not found' })
      }

      const baseUrl = resolveBaseUrl(request)
      const card = agentCardService.buildAgentCard(agent, registryConfig, baseUrl)

      return reply.send(card)
    },
  )
}

export default agentCardRoutes
```

**`src/routes/well-known.ts`** — código completo:

```typescript
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { agentCardService, resolveBaseUrl } from '../services/agent-card.js'

const wellKnownRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /.well-known/agent.json
   * Returns the gateway's own A2A Agent Card.
   */
  fastify.get(
    '/agent.json',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const baseUrl = resolveBaseUrl(request)
      const card = agentCardService.buildSelfAgentCard(baseUrl)
      return reply.send(card)
    },
  )
}

export default wellKnownRoutes
```

**Modificaciones a `src/index.ts`:**

1. **Agregar imports** después de la línea `import orchestrateRoutes from './routes/orchestrate.js'`:

```typescript
import agentCardRoutes from './routes/agent-card.js'
import wellKnownRoutes from './routes/well-known.js'
```

2. **Registrar rutas** después de `await fastify.register(orchestrateRoutes, { prefix: '/orchestrate' })`:

```typescript
await fastify.register(agentCardRoutes, { prefix: '/agents' })
await fastify.register(wellKnownRoutes, { prefix: '/.well-known' })
```

3. **Actualizar health check endpoints** — agregar dentro del objeto `endpoints`:

```typescript
agentCard: '/agents/:slug/agent-card — A2A Agent Card',
wellKnown: '/.well-known/agent.json — Gateway self Agent Card',
```

**`src/routes/agent-card.test.ts`** — tests integración:

```typescript
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import agentCardRoutes from './agent-card.js'
import wellKnownRoutes from './well-known.js'

// ⚠️ NO importar src/index.ts — tiene side-effects (kite-client top-level await)

// Mock dependencies
vi.mock('../services/discovery.js', () => ({
  discoveryService: {
    getAgent: vi.fn(),
  },
}))

vi.mock('../services/registry.js', () => ({
  registryService: {
    getEnabled: vi.fn(),
  },
}))

import { discoveryService } from '../services/discovery.js'
import { registryService } from '../services/registry.js'

const mockGetAgent = vi.mocked(discoveryService.getAgent)
const mockGetEnabled = vi.mocked(registryService.getEnabled)

describe('agent-card routes', () => {
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    app = Fastify()
    await app.register(agentCardRoutes, { prefix: '/agents' })
    await app.register(wellKnownRoutes, { prefix: '/.well-known' })
    await app.ready()
  })

  afterAll(() => app.close())

  describe('GET /agents/:slug/agent-card', () => {
    it('returns 200 with valid AgentCard for existing agent', async () => {
      mockGetAgent.mockResolvedValue({
        slug: 'my-agent',
        name: 'My Agent',
        description: 'Does things',
        capabilities: ['chat'],
        registry: 'test-registry',
      } as any)

      mockGetEnabled.mockResolvedValue([
        { name: 'test-registry', auth: { type: 'bearer', token: 'x' } },
      ] as any)

      const res = await app.inject({ method: 'GET', url: '/agents/my-agent/agent-card' })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.name).toBe('My Agent')
      expect(body.url).toContain('/agents/my-agent')
      expect(body.skills).toHaveLength(1)
      expect(body.authentication.schemes).toEqual(['bearer'])
    })

    it('returns 404 when agent not found', async () => {
      mockGetAgent.mockResolvedValue(null)

      const res = await app.inject({ method: 'GET', url: '/agents/nonexistent/agent-card' })

      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'Agent not found' })
    })

    it('passes ?registry query param to discoveryService', async () => {
      mockGetAgent.mockResolvedValue(null)

      await app.inject({ method: 'GET', url: '/agents/x/agent-card?registry=my-reg' })

      expect(mockGetAgent).toHaveBeenCalledWith('x', 'my-reg')
    })
  })

  describe('GET /.well-known/agent.json', () => {
    it('returns 200 with gateway self AgentCard', async () => {
      const res = await app.inject({ method: 'GET', url: '/.well-known/agent.json' })

      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.name).toBe('WasiAI A2A Gateway')
      expect(body.skills.map((s: any) => s.id)).toEqual(['discover', 'compose', 'orchestrate'])
      expect(body.authentication.schemes).toEqual([])
    })
  })
})
```

---

## Tests — Resumen

| Archivo | Tipo | Casos |
|---------|------|-------|
| `src/services/agent-card.test.ts` | Unitario | 11 tests — resolveAuthSchemes (4), buildAgentCard (6), buildSelfAgentCard (4), resolveBaseUrl (3) |
| `src/routes/agent-card.test.ts` | Integración | 4 tests — GET agent-card 200/404/registry param, GET well-known 200 |

**Ejecutar:** `npx vitest run src/services/agent-card.test.ts src/routes/agent-card.test.ts`

---

## Definition of Done

- [ ] Todos los ACs (AC-1 a AC-7) pasan
- [ ] `npx vitest run` — todos los tests nuevos verdes
- [ ] `npx tsc --noEmit` — sin errores de tipos
- [ ] Ningún `any` en código nuevo (CD-1)
- [ ] Ningún `require()` — solo ESM imports (CD-5)
- [ ] Ninguna clase — solo object literals (CD-4)
- [ ] `discoveryService` y `registryService` NO modificados (CD-7)
- [ ] Agent.registry matched por name, NO por id (CD-9)
- [ ] URLs construidas vía `resolveBaseUrl()`, NO `request.protocol` directo (CD-11)
- [ ] Branch: `feat/wkh-15-agent-cards`
- [ ] Commit message: `feat(agent-card): add A2A Agent Card endpoints (WKH-15)`
