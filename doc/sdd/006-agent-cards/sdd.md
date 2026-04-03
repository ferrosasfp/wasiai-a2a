# SDD-006 — Agent Cards (WKH-15)

> **Fase:** F2 (SDD) | **Fecha:** 2026-04-03 | **Work Item:** `doc/sdd/006-agent-cards/work-item.md`

---

## 1. Context Map

### 1.1 Archivos leídos

| Archivo | Rol | Patrones extraídos |
|---------|-----|--------------------|
| `src/types/index.ts` | Tipos centrales | Interfaces planas, sin clases. `Agent`, `RegistryConfig`, `RegistryAuth` son las que consumimos |
| `src/services/discovery.ts` | Servicio de descubrimiento | Singleton `const discoveryService = { ... }` con métodos async. `getAgent(slug, registryId?)` resuelve por slug |
| `src/services/registry.ts` | Registry CRUD (Supabase) | `registryService.get(id)` → `RegistryConfig \| undefined`. Auth en `registry.auth?.type` |
| `src/routes/discover.ts` | Ruta discover | `FastifyPluginAsync`, `export default`, typed `Params`/`Querystring`, `reply.send()` / `reply.status(404).send({ error })` |
| `src/index.ts` | Entrypoint | `await fastify.register(routes, { prefix })` patrón. Puerto 3001 |
| `src/services/kite-client.test.ts` | Test existente | vitest, `describe/it/expect/vi`, `vi.mock` para dependencias externas |

### 1.2 Exemplars

- **Servicio:** `src/services/discovery.ts` → singleton object literal, funciones puras
- **Ruta:** `src/routes/discover.ts` → `FastifyPluginAsync`, default export, typed generics
- **Test:** `src/services/kite-client.test.ts` → vitest, vi.mock, describe/it blocks
- **Registro:** `src/index.ts` → `await fastify.register(X, { prefix: '/Y' })`

### 1.3 Dependencias del diseño

| Dependencia | Interfaz | Estado |
|-------------|----------|--------|
| `discoveryService.getAgent(slug, registryId?)` | `Promise<Agent \| null>` | ✅ Existe |
| `registryService.get(id)` | `Promise<RegistryConfig \| undefined>` | ✅ Existe |
| `registryService.getEnabled()` | `Promise<RegistryConfig[]>` | ✅ Existe |
| Tipo `Agent` | `{ slug, name, description, capabilities, registry, ... }` | ✅ Existe |
| Tipo `RegistryConfig` | `{ auth?: RegistryAuth, ... }` | ✅ Existe |

**Problema identificado:** `discoveryService.getAgent()` retorna un `Agent` con `registry: string` (el **name** del registry, no el id). Para obtener el `RegistryConfig` necesario para `resolveAuthSchemes`, debemos buscar el registry cuyo `name` coincida. La solución: iterar `registryService.getEnabled()` y matchear por `name`, o bien usar `registryService.get()` con el id. Dado que `Agent.registry` almacena el **name** (ver `mapAgent`: `registry: registry.name`), necesitamos `getEnabled()` + find by name.

---

## 2. Diseño detallado

### 2.1 Tipos nuevos — `src/types/index.ts`

Agregar al final del archivo:

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

### 2.2 Servicio — `src/services/agent-card.ts`

Nuevo archivo. Singleton object literal (patrón `discoveryService`).

```typescript
import type { FastifyRequest } from 'fastify'
import type { Agent, AgentCard, AgentSkill, RegistryConfig } from '../types/index.js'

/**
 * Resolve the public base URL for the gateway.
 * Behind a reverse-proxy / load-balancer (Railway, Render, etc.)
 * `request.protocol` returns "http" even when the client connected over HTTPS.
 *
 * Resolution order:
 *   1. env `BASE_URL` (explicit, highest priority)
 *   2. `X-Forwarded-Proto` header (set by most proxies) + request.hostname
 *   3. Fallback: request.protocol + request.hostname
 */
export function resolveBaseUrl(request: FastifyRequest): string {
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/$/, '') // strip trailing slash
  }

  const proto = (request.headers['x-forwarded-proto'] as string | undefined) ?? request.protocol
  return `${proto}://${request.hostname}`
}

export const agentCardService = {
  /**
   * Resolve auth schemes from registry config.
   * Mapping: bearer→["bearer"], header→["apiKey"], kite/x402→["x402"], else []
   */
  resolveAuthSchemes(registryConfig: RegistryConfig): string[] {
    if (!registryConfig.auth?.type) return []

    switch (registryConfig.auth.type) {
      case 'bearer':
        return ['bearer']
      case 'header':
        return ['apiKey']
      case 'query':
        // "query" auth has no equivalent in the A2A spec — return empty
        return []
    }

    // No other auth types currently defined in RegistryAuth,
    // but future-proof for x402/kite
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
      // Default modes — extensible when the Agent type adds inputModes/outputModes fields
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
      // Default modes — extensible when the Agent type adds inputModes/outputModes fields
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
      authentication: {
        schemes: [],
      },
    }
  },
}
```

**Nota sobre x402/kite:** El tipo `RegistryAuth.type` actual es `'header' | 'query' | 'bearer'`. No incluye `'x402'` ni hay campo `RegistryConfig.type`. El work item menciona `kite`/`x402` pero el type system actual no lo soporta. Para v1, `resolveAuthSchemes` cubre los 3 tipos existentes. Cuando se agregue soporte x402 al tipo, se extiende el switch sin romper nada.

### 2.3 Ruta — `src/routes/agent-card.ts`

Nuevo archivo. Patrón idéntico a `discover.ts`.

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

      // Resolve the registry config to get auth info
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

### 2.4 Ruta — `src/routes/well-known.ts`

Nuevo archivo.

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

### 2.5 Registro en `src/index.ts`

Agregar import y register:

```typescript
import agentCardRoutes from './routes/agent-card.js'
import wellKnownRoutes from './routes/well-known.js'

// ... después de los registers existentes:
await fastify.register(agentCardRoutes, { prefix: '/agents' })
await fastify.register(wellKnownRoutes, { prefix: '/.well-known' })
```

Actualizar el health check `endpoints` para incluir:
```typescript
agentCard: '/agents/:slug/agent-card — A2A Agent Card',
wellKnown: '/.well-known/agent.json — Gateway self Agent Card',
```

### 2.6 Tests

#### `src/services/agent-card.test.ts` — Tests unitarios

```
describe('agentCardService')
  describe('resolveAuthSchemes')
    it('returns ["bearer"] for auth.type bearer')
    it('returns ["apiKey"] for auth.type header')
    it('returns [] for auth.type query')  // query auth has no A2A spec equivalent
    it('returns [] when auth is undefined')

  describe('buildAgentCard')
    it('maps agent fields to AgentCard fields')
    it('maps capabilities to skills with id/name/description')
    it('sets streaming and pushNotifications to false')
    it('sets inputModes and outputModes to ["text/plain"]')
    it('constructs url from baseUrl + /agents/ + slug')
    it('delegates auth to resolveAuthSchemes')

  describe('buildSelfAgentCard')
    it('returns gateway card with correct name')
    it('includes discover, compose, orchestrate skills')
    it('sets empty auth schemes')
    it('uses baseUrl as url')

describe('resolveBaseUrl')
  it('returns BASE_URL env when set (strips trailing slash)')
  it('uses X-Forwarded-Proto header when present')
  it('falls back to request.protocol when no proxy headers')
```

**Estrategia:** Funciones puras → tests directos, sin mocks (excepto `process.env` para `resolveBaseUrl`).

#### `src/routes/agent-card.test.ts` — Tests de integración

**Setup de la instancia Fastify para tests de integración:**

```typescript
import Fastify from 'fastify'
import agentCardRoutes from './agent-card.js'
import wellKnownRoutes from './well-known.js'

// ⚠️ NO importar src/index.ts — tiene side-effects de kite-client

describe('agent-card routes', () => {
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    app = Fastify()
    await app.register(agentCardRoutes, { prefix: '/agents' })
    await app.register(wellKnownRoutes, { prefix: '/.well-known' })
    await app.ready()
  })

  afterAll(() => app.close())

  // ... tests con app.inject({ method: 'GET', url: '...' })
})
```

```
describe('GET /agents/:slug/agent-card')
  it('returns 200 with valid AgentCard for existing agent')
  it('returns 404 when agent not found')
  it('passes ?registry query param to discoveryService')

describe('GET /.well-known/agent.json')
  it('returns 200 with gateway self AgentCard')
  it('response has name "WasiAI A2A Gateway"')
```

**Estrategia:** `vi.mock` para `discoveryService` y `registryService`. Instancia Fastify fresca con solo las rutas bajo test. NO importar `src/index.ts` completo (evitar side effects de kite-client).

---

## 3. Constraint Directives

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
| CD-9 | **`Agent.registry`** almacena el **name** del registry, no el id. Match por name al buscar config |
| CD-10 | **Puerto 3001** — no cambiar |
| CD-11 | **NO usar `request.protocol` directamente para construir URLs públicas** — usar `resolveBaseUrl(request)` que respeta `BASE_URL` env, `X-Forwarded-Proto`, y fallback a `request.protocol` |
| CD-12 | **NO asumir modalidades del agente** — usar default `['text/plain']` hasta que el tipo `Agent` incluya `inputModes`/`outputModes` |

---

## 4. Plan de Waves

### Wave 1 — Tipos (bloqueante)

| Archivo | Acción | Tarea |
|---------|--------|-------|
| `src/types/index.ts` | MODIFICAR | Agregar `AgentSkill` y `AgentCard` interfaces al final |

### Wave 2 — Servicio + Tests unitarios (después de W1)

| Archivo | Acción | Tarea |
|---------|--------|-------|
| `src/services/agent-card.ts` | CREAR | `agentCardService` con `resolveBaseUrl`, `resolveAuthSchemes`, `buildAgentCard`, `buildSelfAgentCard` |
| `src/services/agent-card.test.ts` | CREAR | Tests unitarios (ver §2.6) |

### Wave 3 — Rutas + Registro + Tests integración (después de W2)

| Archivo | Acción | Tarea |
|---------|--------|-------|
| `src/routes/agent-card.ts` | CREAR | `GET /:slug/agent-card` |
| `src/routes/well-known.ts` | CREAR | `GET /agent.json` |
| `src/index.ts` | MODIFICAR | Import + register ambas rutas, actualizar health check endpoints |
| `src/routes/agent-card.test.ts` | CREAR | Tests integración con vi.mock + fastify.inject (setup Fastify fresco) |

---

## 5. Readiness Check

| Criterio | ✅/❌ | Notas |
|----------|:-----:|-------|
| Todos los ACs tienen diseño que los cubre | ✅ | AC-1→buildAgentCard, AC-2→404 en ruta, AC-3→mapeo capabilities→skills, AC-4→defaults, AC-5→resolveAuthSchemes, AC-6→?registry param, AC-7→buildSelfAgentCard |
| Tipos definidos sin ambigüedad | ✅ | `AgentCard`, `AgentSkill` con campos exactos |
| Interfaces de dependencias verificadas en código real | ✅ | `getAgent`, `get`, `getEnabled` leídos y confirmados |
| Constraint Directives cubren riesgos | ✅ | CD-9 (registry name vs id), CD-11 (proxy-safe baseUrl), CD-12 (inputModes default) |
| Tests especificados con estrategia de mock | ✅ | Puras para servicio, vi.mock para rutas |
| Sin ambigüedades para el implementador | ✅ | Setup Fastify para integration tests explícito en §2.6 |

### ⚠️ Riesgos identificados y mitigados

1. **`Agent.registry` = name, no id.** El implementador DEBE usar `registries.find(r => r.name === agent.registry)`, NO `registryService.get(agent.registry)`. Esto está explícito en CD-9 y en el código de §2.3.
2. **`baseUrl` detrás de proxy.** `request.protocol` retorna `http` detrás de Railway/load balancer. Mitigado con `resolveBaseUrl()` (CD-11).

---

**READINESS: ✅ LISTO PARA IMPLEMENTAR**
