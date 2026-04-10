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
import agentCardRoutes from './routes/agent-card.js'
import mockRegistryRoutes from './routes/mock-registry.js'
import wellKnownRoutes from './routes/well-known.js'
import tasksRoutes from './routes/tasks.js'
import dashboardRoutes from './routes/dashboard.js'
import gaslessRoutes from './routes/gasless.js'

import { initAdapters, getChainConfig } from './adapters/registry.js'

const fastify = Fastify({ logger: true })

// CORS
await fastify.register(cors, { origin: '*' })

// Initialize adapters before route registration
await initAdapters()

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
      agentCard: '/agents/:slug/agent-card — A2A Agent Card',
      wellKnown: '/.well-known/agent.json — Gateway self Agent Card',
    },
    docs: 'https://github.com/ferrosasfp/wasiai-a2a',
  })
})

// Routes
await fastify.register(registriesRoutes, { prefix: '/registries' })
await fastify.register(discoverRoutes, { prefix: '/discover' })
await fastify.register(composeRoutes, { prefix: '/compose' })
await fastify.register(orchestrateRoutes, { prefix: '/orchestrate' })
await fastify.register(agentCardRoutes, { prefix: '/agents' })
await fastify.register(wellKnownRoutes, { prefix: '/.well-known' })
await fastify.register(tasksRoutes, { prefix: '/tasks' })
await fastify.register(dashboardRoutes, { prefix: '/dashboard' })
await fastify.register(mockRegistryRoutes, { prefix: '/mock-registry/agents' })
await fastify.register(gaslessRoutes, { prefix: '/gasless' })

// Start server
const port = parseInt(process.env.PORT ?? '3001')

let chainInfo = 'no chain configured'
try { const cfg = getChainConfig(); chainInfo = `${cfg.name} (chainId: ${cfg.chainId})` } catch { /* adapter not initialized */ }

console.log(`
╔═══════════════════════════════════════════════════════════╗
║           WasiAI A2A Protocol                             ║
║   Agent Discovery, Composition & Orchestration Service    ║
╠═══════════════════════════════════════════════════════════╣
║   Server running on http://localhost:${port}                  ║
║   Chain: ${chainInfo.padEnd(45)}║
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
