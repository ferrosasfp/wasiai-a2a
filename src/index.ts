/**
 * WasiAI A2A Protocol
 *
 * Agent discovery, composition, and orchestration service.
 * Supports multiple marketplace registries via configuration.
 */

import cors, { type FastifyCorsOptions } from '@fastify/cors';
import Fastify from 'fastify';
import {
  getChainConfig,
  getInitializedChainKeys,
  initAdapters,
} from './adapters/registry.js';
import { assertRequiredEnv, isProduction, parseTrustProxy } from './lib/env.js';
import { assertGasOverheadConfigured } from './lib/gas-overhead.js';
import { REDACT_PATHS } from './lib/logger.js';
import mcpPlugin from './mcp/index.js';
import { registerErrorBoundary } from './middleware/error-boundary.js';
import { registerEventTracking } from './middleware/event-tracking.js';
import { registerRateLimit } from './middleware/rate-limit.js';
import { genReqId, registerRequestIdHook } from './middleware/request-id.js';
import { registerSecurityHeaders } from './middleware/security-headers.js';
import agentCardRoutes from './routes/agent-card.js';
import agentLinkRoutes from './routes/agent-links.js';
import agentsRoutes from './routes/agents.js';
import authRoutes from './routes/auth.js';
import capabilitiesRoutes from './routes/capabilities.js';
import composeRoutes from './routes/compose.js';
import dashboardRoutes from './routes/dashboard.js';
import discoverRoutes from './routes/discover.js';
import gaslessRoutes from './routes/gasless.js';
import metricsRoutes from './routes/metrics.js';
import mockRegistryRoutes from './routes/mock-registry.js';
import orchestrateRoutes from './routes/orchestrate.js';
import paymentsRoutes from './routes/payments.js';
import receiptsRoutes from './routes/receipts.js';
import registriesRoutes from './routes/registries.js';
import tasksRoutes from './routes/tasks.js';
import wellKnownRoutes from './routes/well-known.js';
import { refundOutbox } from './services/refund-outbox.js';

// F-08 (audit 2026-06-29): fail loudly at boot if required secrets are missing
// in production (before any adapter init or server bind).
assertRequiredEnv();

// Initialize chain-adaptive adapters before server starts
await initAdapters();

// G-01 (audit 2026-06-30): in production, refuse to boot if any configured
// MAINNET chain lacks a per-step gas overhead env pin — otherwise the gateway
// silently loses gas on every settled mainnet step. No-op in dev/test and for
// testnet-only deploys. Runs AFTER initAdapters so the chain set is known.
assertGasOverheadConfigured(
  getInitializedChainKeys().map((key) => getChainConfig(key).chainId),
);

const fastify = Fastify({
  // F-06 (audit 2026-06-29): redact credential-bearing fields from request logs
  // (Authorization / x-payment / x-a2a-key headers + any *.secret/*.signature).
  logger: { redact: REDACT_PATHS },
  genReqId,
  // H3 (audit 2026-07-01): resolve `request.ip` from X-Forwarded-For when behind
  // a trusted proxy (Railway edge). Env-driven (TRUST_PROXY) so the per-IP
  // rate-limiters bucket per real client instead of one shared proxy bucket.
  // Default (unset) is `false` → unchanged behavior. MUST be set BEFORE
  // registerRateLimit()/routes (Fastify reads it at instance construction).
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
});

// CORS — env-aware (WKH-SEC-01 AC-4/AC-5/AC-6)
const prod = isProduction();
const originsEnv = process.env.CORS_ALLOWED_ORIGINS;

let corsOptions: FastifyCorsOptions;
if (!prod) {
  corsOptions = { origin: '*' };
} else {
  const origins = (originsEnv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (origins.length > 0) {
    corsOptions = { origin: origins };
  } else {
    // Behavior is UNCHANGED (origin: false). We do NOT flip prod to a
    // permissive default — but we emit a loud, actionable startup warning so
    // the operator knows cross-origin requests are being blocked because
    // CORS_ALLOWED_ORIGINS is unset. Set it (comma-separated origin list,
    // e.g. https://wasiai.io,https://www.wasiai.io) to allow your frontends.
    // See .env.example for the recommended value.
    fastify.log.warn(
      '⚠️  CORS_ALLOWED_ORIGINS is UNSET in production — ALL cross-origin requests are being BLOCKED. ' +
        'Set CORS_ALLOWED_ORIGINS to a comma-separated origin list (e.g. https://wasiai.io,https://www.wasiai.io) ' +
        'to allow your frontend(s). See .env.example.',
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
      capabilities: '/capabilities — Read-only gateway capabilities summary',
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
await fastify.register(capabilitiesRoutes, { prefix: '/capabilities' });
await fastify.register(composeRoutes, { prefix: '/compose' });
await fastify.register(orchestrateRoutes, { prefix: '/orchestrate' });
// WKH-135: payment intents (session metered + upto cap dual-firmado). Aditivo.
await fastify.register(paymentsRoutes, { prefix: '/payments' });
await fastify.register(agentCardRoutes, { prefix: '/agents' });
// WKH-134: self-serve agent publishing (POST/PATCH/DELETE/GET /agents). Mismo
// prefijo que agentCardRoutes (Fastify soporta varios plugins por prefijo);
// no colisiona con GET /agents/:slug/agent-card (método+path distintos).
await fastify.register(agentsRoutes, { prefix: '/agents' });
// WKH-137: invocation links (mint + redeem). Mismo prefijo /agents (Fastify
// soporta varios plugins por prefijo). POST /agents/:slug/link (mint, master
// key) + POST /agents/links/:token/redeem (público). Aditivo.
await fastify.register(agentLinkRoutes, { prefix: '/agents' });
await fastify.register(wellKnownRoutes, { prefix: '/.well-known' });
await fastify.register(tasksRoutes, { prefix: '/tasks' });
await fastify.register(dashboardRoutes, { prefix: '/dashboard' });
// AC-6 (CD-3): mock-registry is dev-only; not mounted in production → 404.
if (!prod) {
  await fastify.register(mockRegistryRoutes, {
    prefix: '/mock-registry/agents',
  });
}

// DT-1 (WKH-38): always register gasless routes — /gasless/status must be
// discoverable even when disabled; it returns funding_state for degradation info.
await fastify.register(gaslessRoutes, { prefix: '/gasless' });

// WKH-34: Auth routes (agent-signup, deposit, me, bind)
await fastify.register(authRoutes, { prefix: '/auth' });

// WKH-124: Receipts routes (list / get / verify HMAC-chained receipts)
await fastify.register(receiptsRoutes, { prefix: '/receipts' });

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

// M6 (audit 2026-06-24): sweep periódico del outbox de refunds. Reintenta los
// refunds best-effort que NO aplicaron nada. processRefundOutbox NUNCA tira
// (best-effort), pero atamos un .catch() por defensa en profundidad. .unref()
// para no bloquear el shutdown del proceso; el interval se limpia explícitamente
// en gracefulShutdown.
const refundSweepMs = parseInt(
  process.env.REFUND_OUTBOX_SWEEP_MS ?? '60000',
  10,
);
const refundSweepTimer = setInterval(() => {
  refundOutbox.processRefundOutbox().catch(() => {});
}, refundSweepMs);
refundSweepTimer.unref();

// Graceful shutdown (AC-12)
async function gracefulShutdown(signal: string) {
  fastify.log.info({ signal }, 'Received signal, starting graceful shutdown');
  clearInterval(refundSweepTimer);
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
