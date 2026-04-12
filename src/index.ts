/**
 * WasiAI A2A Protocol
 *
 * Agent discovery, composition, and orchestration service.
 * Supports multiple marketplace registries via configuration.
 */

import Fastify from 'fastify'
import cors from '@fastify/cors'
import { genReqId, registerRequestIdHook } from './middleware/request-id.js'
import { registerErrorBoundary } from './middleware/error-boundary.js'
import { registerEventTracking } from './middleware/event-tracking.js'
import { registerRateLimit } from './middleware/rate-limit.js'

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
import authRoutes from './routes/auth.js'
import metricsRoutes from './routes/metrics.js'

import { initAdapters, getChainConfig } from './adapters/registry.js'

// Initialize chain-adaptive adapters before server starts
await initAdapters()

const fastify = Fastify({ logger: true, genReqId })

// CORS
await fastify.register(cors, { origin: '*' })

// Resilience middleware (order matters: request-id -> error boundary -> rate limit)
registerRequestIdHook(fastify)
registerEventTracking(fastify)
registerErrorBoundary(fastify)
await registerRateLimit(fastify)

// Health check
fastify.get('/', { config: { rateLimit: false } }, async (_request, reply) => {
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

// Health endpoint (WKH-HEALTH)
fastify.get('/health', { config: { rateLimit: false } }, async (_request, reply) => {
  return reply.send({
    status: 'ok',
    version: '0.1.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
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

// DT-1 (WKH-38): always register gasless routes — /gasless/status must be
// discoverable even when disabled; it returns funding_state for degradation info.
await fastify.register(gaslessRoutes, { prefix: '/gasless' })

// WKH-34: Auth routes (agent-signup, deposit, me, bind)
await fastify.register(authRoutes, { prefix: '/auth' })

// Prometheus metrics (Doctor 4: APM)
await fastify.register(metricsRoutes, { prefix: '/metrics' })

// Start server
const port = parseInt(process.env.PORT ?? '3001')

console.log(`
╔═══════════════════════════════════════════════════════════╗
║           WasiAI A2A Protocol                             ║
║   Agent Discovery, Composition & Orchestration Service    ║
╠═══════════════════════════════════════════════════════════╣
║   Server running on http://localhost:${port}                  ║
║   Chain: ${(() => { try { const c = getChainConfig(); return `${c.name} (chainId: ${c.chainId})`.padEnd(27); } catch { return 'not configured              '; } })()}║
║                                                           ║
║   Endpoints:                                              ║
║   • GET  /registries     — List marketplaces              ║
║   • POST /registries     — Register marketplace           ║
║   • GET|POST /discover   — Search agents                  ║
║   • POST /compose        — Execute pipeline               ║
║   • POST /orchestrate    — Goal-based orchestration       ║
╚═══════════════════════════════════════════════════════════╝
`)

await fastify.listen({ port, host: '0.0.0.0' })

// Graceful shutdown (AC-12)
async function gracefulShutdown(signal: string) {
  fastify.log.info({ signal }, 'Received signal, starting graceful shutdown')
  const graceMs = parseInt(process.env.SHUTDOWN_GRACE_MS ?? '30000')
  const forceTimer = setTimeout(() => {
    fastify.log.error('Graceful shutdown timed out, forcing exit')
    process.exit(1)
  }, graceMs)
  forceTimer.unref()
  try {
    await fastify.close()
    process.exit(0)
  } catch (err) {
    fastify.log.error({ err }, 'Error during graceful shutdown')
    process.exit(1)
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
