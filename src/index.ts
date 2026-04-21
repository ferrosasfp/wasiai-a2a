/**
 * WasiAI A2A Protocol
 *
 * Agent discovery, composition, and orchestration service.
 * Supports multiple marketplace registries via configuration.
 */

import cors, { type FastifyCorsOptions } from '@fastify/cors';
import Fastify from 'fastify';
import { getChainConfig, initAdapters } from './adapters/registry.js';
import mcpPlugin from './mcp/index.js';
import { registerErrorBoundary } from './middleware/error-boundary.js';
import { registerEventTracking } from './middleware/event-tracking.js';
import { registerRateLimit } from './middleware/rate-limit.js';
import { genReqId, registerRequestIdHook } from './middleware/request-id.js';
import { registerSecurityHeaders } from './middleware/security-headers.js';
import agentCardRoutes from './routes/agent-card.js';
import authRoutes from './routes/auth.js';
import composeRoutes from './routes/compose.js';
import dashboardRoutes from './routes/dashboard.js';
import discoverRoutes from './routes/discover.js';
import gaslessRoutes from './routes/gasless.js';
import metricsRoutes from './routes/metrics.js';
import mockRegistryRoutes from './routes/mock-registry.js';
import orchestrateRoutes from './routes/orchestrate.js';
import registriesRoutes from './routes/registries.js';
import tasksRoutes from './routes/tasks.js';
import wellKnownRoutes from './routes/well-known.js';

// Initialize chain-adaptive adapters before server starts
await initAdapters();

const fastify = Fastify({ logger: true, genReqId });

// CORS — env-aware (WKH-SEC-01 AC-4/AC-5/AC-6)
const isProduction = process.env.NODE_ENV === 'production';
const originsEnv = process.env.CORS_ALLOWED_ORIGINS;

let corsOptions: FastifyCorsOptions;
if (!isProduction) {
  corsOptions = { origin: '*' };
} else {
  const origins = (originsEnv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (origins.length > 0) {
    corsOptions = { origin: origins };
  } else {
    fastify.log.warn(
      'CORS_ALLOWED_ORIGINS not set in production — blocking all cross-origin requests',
    );
    corsOptions = { origin: false };
  }
}

await fastify.register(cors, corsOptions);

// Resilience middleware (order matters: request-id -> error boundary -> rate limit)
registerRequestIdHook(fastify);
registerSecurityHeaders(fastify);
registerEventTracking(fastify);
registerErrorBoundary(fastify);
await registerRateLimit(fastify);

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
  });
});

// Health endpoint (WKH-HEALTH)
fastify.get(
  '/health',
  { config: { rateLimit: false } },
  async (_request, reply) => {
    return reply.send({
      status: 'ok',
      version: '0.1.0',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  },
);

// Routes
await fastify.register(registriesRoutes, { prefix: '/registries' });
await fastify.register(discoverRoutes, { prefix: '/discover' });
await fastify.register(composeRoutes, { prefix: '/compose' });
await fastify.register(orchestrateRoutes, { prefix: '/orchestrate' });
await fastify.register(agentCardRoutes, { prefix: '/agents' });
await fastify.register(wellKnownRoutes, { prefix: '/.well-known' });
await fastify.register(tasksRoutes, { prefix: '/tasks' });
await fastify.register(dashboardRoutes, { prefix: '/dashboard' });
await fastify.register(mockRegistryRoutes, { prefix: '/mock-registry/agents' });

// DT-1 (WKH-38): always register gasless routes — /gasless/status must be
// discoverable even when disabled; it returns funding_state for degradation info.
await fastify.register(gaslessRoutes, { prefix: '/gasless' });

// WKH-34: Auth routes (agent-signup, deposit, me, bind)
await fastify.register(authRoutes, { prefix: '/auth' });

// Prometheus metrics (Doctor 4: APM)
await fastify.register(metricsRoutes, { prefix: '/metrics' });

// WKH-MCP-X402: MCP Server plugin (CD-14: DESPUÉS de metricsRoutes, ANTES de server start)
await fastify.register(mcpPlugin, { prefix: '/mcp' });

// Start server
const port = parseInt(process.env.PORT ?? '3001', 10);

console.log(`
╔═══════════════════════════════════════════════════════════╗
║           WasiAI A2A Protocol                             ║
║   Agent Discovery, Composition & Orchestration Service    ║
╠═══════════════════════════════════════════════════════════╣
║   Server running on http://localhost:${port}                  ║
║   Chain: ${(() => {
  try {
    const c = getChainConfig();
    return `${c.name} (chainId: ${c.chainId})`.padEnd(27);
  } catch {
    return 'not configured              ';
  }
})()}║
║                                                           ║
║   Endpoints:                                              ║
║   • GET  /registries     — List marketplaces              ║
║   • POST /registries     — Register marketplace           ║
║   • GET|POST /discover   — Search agents                  ║
║   • POST /compose        — Execute pipeline               ║
║   • POST /orchestrate    — Goal-based orchestration       ║
╚═══════════════════════════════════════════════════════════╝
`);

await fastify.listen({ port, host: '0.0.0.0' });

// Graceful shutdown (AC-12)
async function gracefulShutdown(signal: string) {
  fastify.log.info({ signal }, 'Received signal, starting graceful shutdown');
  const graceMs = parseInt(process.env.SHUTDOWN_GRACE_MS ?? '30000', 10);
  const forceTimer = setTimeout(() => {
    fastify.log.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, graceMs);
  forceTimer.unref();
  try {
    await fastify.close();
    process.exit(0);
  } catch (err) {
    fastify.log.error({ err }, 'Error during graceful shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
