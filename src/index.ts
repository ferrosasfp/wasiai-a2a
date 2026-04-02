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
