/**
 * WasiAI A2A Protocol
 *
 * Agent discovery, composition, and orchestration service.
 * Supports multiple marketplace registries via configuration.
 */

import cors, { type FastifyCorsOptions } from '@fastify/cors';
import Fastify from 'fastify';
import { isEscrowSettleEnabled } from './adapters/escrow/debit-capture.js';
import { warmEscrowSchemaPreflight } from './adapters/escrow/schema-preflight.js';
import {
  getChainConfig,
  getInitializedChainKeys,
  initAdapters,
} from './adapters/registry.js';
import {
  warmPayoutRoutePreflight,
  readPayoutRouteHealth,
} from './adapters/solana/facilitator-settle.js';
import { warmSolanaSchemaPreflight } from './adapters/solana/schema-preflight.js';
import {
  assertDepositMinimumEnv,
  assertRequiredEnv,
  isProduction,
  parseTrustProxy,
} from './lib/env.js';
import { assertGasOverheadConfigured } from './lib/gas-overhead.js';
import { REDACT_PATHS } from './lib/logger.js';
import {
  assertSelfPublishedAuthEnv,
  SELF_PUBLISHED_AUTH_ENV,
} from './lib/self-published-auth.js';
import { isPipelineCeilingMisconfigured } from './lib/stranded-payment.js';
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
import inboundRoutes from './routes/inbound.js';
import metricsRoutes from './routes/metrics.js';
import mockRegistryRoutes from './routes/mock-registry.js';
import orchestrateRoutes from './routes/orchestrate.js';
import paymentsRoutes from './routes/payments.js';
import receiptsRoutes from './routes/receipts.js';
import registriesRoutes from './routes/registries.js';
import tasksRoutes from './routes/tasks.js';
import wellKnownRoutes from './routes/well-known.js';
import { refundOutbox } from './services/refund-outbox.js';
// HU-306 (AC-5): indicador de exposición varada para `/health`. Con el umbral sin
// configurar no consulta nada y el campo ni aparece.
import {
  describeStrandedThresholdStartup,
  getStrandedHealthField,
} from './services/stranded-alert.js';

// F-08 (audit 2026-06-29): fail loudly at boot if required secrets are missing
// in production (before any adapter init or server bind).
assertRequiredEnv();

// Fix-pack AR 2026-07-31: el mínimo de depósito se EVALÚA al arrancar, no sólo se
// chequea su presencia. `A2A_DEPOSIT_MIN_USDC='1,5'` está presente y no vacía, así que
// `assertRequiredEnv()` la daría por buena; el guard, en cambio, no la puede leer y
// cierra TODOS los depósitos. Mal escrita → no bootea (con el valor en el mensaje);
// ausente → warning ruidoso más abajo, cuando el logger ya existe.
const depositMinimumWarning = assertDepositMinimumEnv();

// Mismo criterio que el mínimo de depósito, sobre la credencial OUTBOUND hacia
// agentes self-published: PRESENTE PERO ILEGIBLE → no bootea. Si degradara a "sin
// credencial" en silencio, el síntoma sería un 401 permanente del lado del agente y
// nadie miraría la env var del gateway. AUSENTE es un estado válido y silencioso
// (es el default: nadie recibe credencial). Devuelve los HOSTS declarados — nunca
// los secretos — para que el arranque publique a quién se le va a mandar.
const selfPublishedAuthHosts = assertSelfPublishedAuthEnv();

// Initialize chain-adaptive adapters before server starts
await initAdapters();

// G-01 (audit 2026-06-30): in production, refuse to boot if any configured
// MAINNET chain lacks a per-step gas overhead env pin — otherwise the gateway
// silently loses gas on every settled mainnet step. No-op in dev/test and for
// testnet-only deploys. Runs AFTER initAdapters so the chain set is known.
assertGasOverheadConfigured(
  getInitializedChainKeys().map((key) => getChainConfig(key).chainId),
);

// HU-306 (fix-pack CR): el techo de exposición por pipeline hace fail-OPEN ante un valor
// ilegible —un techo que se cae a 0 por un typo rechazaría TODO el tráfico—, pero eso no
// puede ser mudo: sin este aviso, `PIPELINE_EXPOSURE_CEILING_USD=1O` y la env sin setear
// se comportan igual y se ven igual, y el operador creería tener puesto un techo que no
// existe. Se evalúa UNA vez, al arrancar; no cuesta nada por request.
const strandedCeilingMisconfigured = isPipelineCeilingMisconfigured();

// Fix-pack observabilidad 2026-07-31: el mismo aviso, para la OTRA variable de la HU-306.
// El techo de arriba ya se delataba; el UMBRAL, que es el que decide SI SUENA la alerta,
// no decia una palabra al arrancar. Un `19` escrito `1O` no da error: da una alerta que
// nunca suena, que se ve igual que "no hay nada que alertar". Tres estados (ausente /
// puesta y legible / puesta e ilegible), evaluados UNA vez, sin costo por request.
const strandedThresholdStartup = describeStrandedThresholdStartup();

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

if (strandedCeilingMisconfigured) {
  fastify.log.warn(
    '⚠️  PIPELINE_EXPOSURE_CEILING_USD is SET but unreadable (not a positive number) — ' +
      'the gateway is running WITHOUT a per-pipeline exposure ceiling, exactly as if the ' +
      'variable were unset. Fail-open is deliberate (a ceiling that collapses to 0 would ' +
      'reject ALL traffic), but the value you configured is doing nothing. See .env.example.',
  );
}

if (depositMinimumWarning !== null) {
  fastify.log.warn(`⚠️  ${depositMinimumWarning}`);
}

// A qué hosts self-published se les manda credencial. Se publica SIEMPRE, incluso
// vacío, porque "no le mando credencial a nadie" es justamente el estado que hoy
// deja inerte la auth ya desplegada del otro lado, y el operador tiene que poder
// confirmarlo desde el log sin entrar al panel del hosting. Salen los HOSTS, nunca
// los secretos: `assertSelfPublishedAuthEnv` no devuelve valores.
fastify.log.info(
  {
    setting: SELF_PUBLISHED_AUTH_ENV,
    hosts: selfPublishedAuthHosts,
    count: selfPublishedAuthHosts.length,
  },
  selfPublishedAuthHosts.length === 0
    ? 'sin credencial outbound para agentes self-published (variable ausente): ningun agente self-published recibe Authorization del gateway'
    : 'credencial outbound para agentes self-published activa para los hosts listados (solo https)',
);

// El estado del umbral de la alerta de exposicion varada. `setting`/`value` estructurados
// (misma forma que los avisos de configuracion del facilitator) para que el operador
// CONFIRME DESDE EL LOG el numero que quedo activo, sin entrar al panel del hosting. Un
// umbral no es un secreto. Ausente => `info` (esta apagada a proposito, no es un error);
// ilegible => `warn` (grita, como el techo).
if (strandedThresholdStartup.level === 'warn') {
  fastify.log.warn(
    {
      setting: strandedThresholdStartup.setting,
      value: strandedThresholdStartup.value,
    },
    strandedThresholdStartup.message,
  );
} else {
  fastify.log.info(
    {
      setting: strandedThresholdStartup.setting,
      value: strandedThresholdStartup.value,
    },
    strandedThresholdStartup.message,
  );
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
      // HU-306 (AC-5): campo ADITIVO de tres estados. Con el umbral SIN SETEAR devuelve
      // `{}` ⟹ la respuesta es byte-idéntica a la de antes; con el umbral puesto e
      // ILEGIBLE el campo aparece diciendo `'unknown'` (fix-pack 2026-07-31: un typo en
      // la env no puede hacer desaparecer del canal push al indicador de que la alerta
      // está rota, porque un campo ausente se lee como "no hay problema"). Síncrono, sin
      // `await` a la base y sin poder tirar (CD-10). ⚠️ La MISMA línea está en
      // `src/__tests__/e2e/setup.ts`, que duplica este handler porque este módulo hace
      // `await initAdapters()` a nivel de módulo y no se puede importar desde un test.
      ...getStrandedHealthField(),
      // El carril de payout Solana, que hasta acá NO aparecía en esta respuesta: la
      // palabra "solana" no figuraba ni una vez, y este servicio es el que rutea los
      // pagos a los agentes Solana. El facilitator sí sondea el RPC y lo publica por
      // cadena; lo que faltaba era lo que sólo sabe el gateway, que es si su propio
      // carril de salida está armado y qué contestó el último sondeo de la ruta.
      //
      // ⚠️ Campo SIEMPRE presente, a diferencia del de arriba que devuelve `{}` cuando
      // su umbral no está seteado. Acá un campo ausente se leería como "no hay
      // problema", y `rail_off` es información: dice que el carril NO está armado.
      // Síncrono y no-throw como exige CD-10; `readPayoutRouteHealth` no sondea.
      solanaPayoutRoute: readPayoutRouteHealth(),
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
// WKH-115: inbound adapter (push/webhook de tareas externas → orchestrate
// in-process). Parser raw-body ENCAPSULADO al plugin (additive-only). Aditivo.
await fastify.register(inboundRoutes, { prefix: '/inbound' });
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

// AR de HU-202, BLOQUEANTE 1 — que la alarma del gate de orden de release suene AL
// ARRANCAR y no en medio de una transferencia. Sólo cuando el camino escrow está
// habilitado: con el flag OFF (el default) esto no hace ni una consulta, así que no
// puede romper el arranque de un entorno que no usa escrow.
//
// FIRE-AND-FORGET A PROPÓSITO: un blip de red contra la DB no debe impedir que el
// servicio levante y sirva discover/compose/orchestrate, que no tienen nada que ver con
// el escrow. Esto NO es el gate — el gate real es `ensureEscrowSchemaReady()` dentro de
// `settleEscrowAware`, que comparte este mismo veredicto memoizado (no pueden divergir).
if (isEscrowSettleEnabled()) warmEscrowSchemaPreflight();

// WKH-307: lo mismo para el ledger del settle Solana. Mismo razonamiento y mismo
// contrato: fire-and-forget, comparte el veredicto memoizado con el gate real
// (`ensureSolanaSchemaReady()` dentro de `settle()`), y solo corre cuando el adapter
// esta habilitado. Sin esto, la primera noticia de que falta la migracion llegaria en
// medio de una transferencia en vez de en el arranque.
if (process.env.SOLANA_ADAPTER_ENABLED === 'true') warmSolanaSchemaPreflight();

// WKH-342: sondear si el facilitator configurado tiene registrada `POST /solana/payout`,
// para que "esa ruta no existe" se sepa en el arranque y no leg por leg. Fire-and-forget
// por el mismo motivo que los dos de arriba.
//
// ⚠️ SIN `if` EN ESTE CALL-SITE, y eso es una diferencia deliberada con las dos líneas de
// arriba: el criterio (`SOLANA_SETTLE_VIA_FACILITATOR === 'true'` + hay URL) vive DENTRO
// de `ensurePayoutRouteReady`, que es también el gate perezoso del leg de pago. Duplicarlo
// acá daría dos copias de la condición que pueden divergir. Con la bandera apagada esta
// llamada no hace ni un `fetch`.
warmPayoutRoutePreflight();

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
