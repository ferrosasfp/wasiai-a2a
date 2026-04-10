/**
 * E2E Test Setup — WKH-029
 *
 * Builds a real Fastify server with all middleware and routes,
 * mocking only external dependencies (Supabase, Anthropic, adapters).
 */

import { vi } from 'vitest'

// ── Layer 1: Supabase client ──────────────────────────────────
vi.mock('../../lib/supabase.js', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    })),
  },
}))

// ── Layer 2: Services ─────────────────────────────────────────
vi.mock('../../services/identity.js', () => ({
  identityService: {
    createKey: vi.fn(),
    lookupByHash: vi.fn(),
    deactivate: vi.fn(),
  },
}))

vi.mock('../../services/budget.js', () => ({
  budgetService: {
    getBalance: vi.fn(),
    debit: vi.fn(),
    registerDeposit: vi.fn(),
  },
}))

vi.mock('../../services/authz.js', () => ({
  authzService: {
    checkScoping: vi.fn().mockReturnValue({ allowed: true }),
  },
}))

vi.mock('../../services/event.js', () => ({
  eventService: {
    track: vi.fn().mockResolvedValue(undefined),
    stats: vi.fn().mockResolvedValue({ total_events: 0, events_24h: 0 }),
    recent: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('../../services/discovery.js', () => ({
  discoveryService: {
    discover: vi.fn().mockResolvedValue({ agents: [], total: 0 }),
    queryRegistry: vi.fn().mockResolvedValue([]),
    mapAgent: vi.fn(),
    getAgent: vi.fn().mockResolvedValue(null),
  },
}))

vi.mock('../../services/compose.js', () => ({
  composeService: {
    compose: vi.fn().mockResolvedValue({ success: true, output: null, steps: [], totalCostUsdc: 0, totalLatencyMs: 0 }),
    resolveAgent: vi.fn(),
    invokeAgent: vi.fn(),
  },
}))

vi.mock('../../services/orchestrate.js', () => ({
  orchestrateService: {
    orchestrate: vi.fn().mockResolvedValue({ success: true, agents: [], result: null }),
  },
}))

vi.mock('../../services/registry.js', () => ({
  registryService: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
    register: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('../../services/agent-card.js', () => ({
  agentCardService: {
    resolveAuthSchemes: vi.fn().mockReturnValue([]),
    buildAgentCard: vi.fn(),
    buildSelfAgentCard: vi.fn().mockReturnValue({
      name: 'WasiAI A2A Protocol',
      description: 'Agent discovery service',
      url: 'http://localhost:3001',
      capabilities: { streaming: true, pushNotifications: true },
      skills: [{ id: 'discover', name: 'Discover', description: 'Find agents' }],
    }),
  },
  resolveBaseUrl: vi.fn().mockReturnValue('http://localhost:3001'),
}))

vi.mock('../../services/task.js', () => ({
  taskService: {
    create: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    cancel: vi.fn(),
    update: vi.fn(),
  },
  TaskNotFoundError: class TaskNotFoundError extends Error {
    constructor(id: string) { super(`Task ${id} not found`); this.name = 'TaskNotFoundError' }
  },
  TerminalStateError: class TerminalStateError extends Error {
    constructor(msg: string) { super(msg); this.name = 'TerminalStateError' }
  },
}))

// ── Layer 3: Adapters ─────────────────────────────────────────
vi.mock('../../adapters/registry.js', () => ({
  initAdapters: vi.fn(),
  _resetRegistry: vi.fn(),
  getPaymentAdapter: vi.fn(() => ({
    name: 'mock',
    chainId: 2368,
    supportedTokens: [],
    getScheme: () => 'exact',
    getNetwork: () => 'kite-ozone-testnet',
    getToken: () => '0x0000000000000000000000000000000000000000',
    getMaxTimeoutSeconds: () => 60,
    getMerchantName: () => 'WasiAI Test',
    settle: vi.fn(),
    verify: vi.fn(),
    quote: vi.fn().mockResolvedValue({ amountWei: '1000000000000000000', token: { symbol: 'PYUSD', address: '0x0', decimals: 6 }, facilitatorUrl: '' }),
    sign: vi.fn(),
  })),
  getChainConfig: vi.fn(() => ({
    name: 'kite-ozone-testnet',
    chainId: 2368,
    explorerUrl: 'https://testnet.kitescan.ai',
  })),
  getGaslessAdapter: vi.fn(() => ({
    status: vi.fn().mockResolvedValue({ funding_state: 'unconfigured' }),
    transfer: vi.fn(),
  })),
  getAttestationAdapter: vi.fn(),
  getIdentityBindingAdapter: vi.fn(),
}))

// ── Layer 4: Anthropic SDK ────────────────────────────────────
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: vi.fn() },
  })),
}))

// ── Layer 5: Circuit breaker ──────────────────────────────────
vi.mock('../../lib/circuit-breaker.js', () => ({
  anthropicCircuitBreaker: {
    fire: vi.fn().mockRejectedValue(new Error('Circuit breaker mocked')),
    isOpen: vi.fn().mockReturnValue(false),
    status: 'closed',
  },
  CircuitOpenError: class CircuitOpenError extends Error {
    constructor() { super('Circuit open'); this.name = 'CircuitOpenError' }
  },
}))

// ── Layer 6: LLM Transform ───────────────────────────────────
vi.mock('../../services/llm/transform.js', () => ({
  maybeTransform: vi.fn().mockResolvedValue({ transformed: false, data: null }),
}))

// ── Imports (after mocks) ─────────────────────────────────────
import Fastify from 'fastify'
import cors from '@fastify/cors'
import crypto from 'node:crypto'
import type { A2AAgentKeyRow } from '../../types/index.js'
import { genReqId, registerRequestIdHook } from '../../middleware/request-id.js'
import { registerErrorBoundary } from '../../middleware/error-boundary.js'
import { registerRateLimit } from '../../middleware/rate-limit.js'

import registriesRoutes from '../../routes/registries.js'
import discoverRoutes from '../../routes/discover.js'
import composeRoutes from '../../routes/compose.js'
import orchestrateRoutes from '../../routes/orchestrate.js'
import agentCardRoutes from '../../routes/agent-card.js'
import wellKnownRoutes from '../../routes/well-known.js'
import tasksRoutes from '../../routes/tasks.js'
import dashboardRoutes from '../../routes/dashboard.js'
import mockRegistryRoutes from '../../routes/mock-registry.js'
import gaslessRoutes from '../../routes/gasless.js'
import authRoutes from '../../routes/auth.js'

// ── Helpers ───────────────────────────────────────────────────

export const TEST_KEY = 'wasi_a2a_' + 'a'.repeat(64)
export const TEST_KEY_HASH = crypto.createHash('sha256').update(TEST_KEY).digest('hex')
export const TEST_KEY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

export function makeKeyRow(overrides: Partial<A2AAgentKeyRow> = {}): A2AAgentKeyRow {
  return {
    id: TEST_KEY_ID,
    owner_ref: 'user-1',
    key_hash: TEST_KEY_HASH,
    display_name: 'Test Key',
    budget: { '2368': '10.000000' },
    daily_limit_usd: '100.000000',
    daily_spent_usd: '5.000000',
    daily_reset_at: new Date(Date.now() + 86400000).toISOString(),
    allowed_registries: null,
    allowed_agent_slugs: null,
    allowed_categories: null,
    max_spend_per_call_usd: null,
    is_active: true,
    last_used_at: null,
    created_at: '2026-04-06T12:00:00.000Z',
    updated_at: '2026-04-06T12:00:00.000Z',
    erc8004_identity: null,
    kite_passport: null,
    agentkit_wallet: null,
    metadata: {},
    ...overrides,
  }
}

// ── buildTestApp ──────────────────────────────────────────────

export async function buildTestApp() {
  const app = Fastify({ logger: false, genReqId })

  // CORS
  await app.register(cors, { origin: '*' })

  // Middleware (same order as index.ts)
  registerRequestIdHook(app)
  registerErrorBoundary(app)
  await registerRateLimit(app)

  // Health route (inline, same as index.ts lines 42-57)
  app.get('/', { config: { rateLimit: false } }, async (_request, reply) => {
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

  // Routes (same order as index.ts lines 60-75)
  await app.register(registriesRoutes, { prefix: '/registries' })
  await app.register(discoverRoutes, { prefix: '/discover' })
  await app.register(composeRoutes, { prefix: '/compose' })
  await app.register(orchestrateRoutes, { prefix: '/orchestrate' })
  await app.register(agentCardRoutes, { prefix: '/agents' })
  await app.register(wellKnownRoutes, { prefix: '/.well-known' })
  await app.register(tasksRoutes, { prefix: '/tasks' })
  await app.register(dashboardRoutes, { prefix: '/dashboard' })
  await app.register(mockRegistryRoutes, { prefix: '/mock-registry/agents' })
  await app.register(gaslessRoutes, { prefix: '/gasless' })
  await app.register(authRoutes, { prefix: '/auth' })

  await app.ready()
  return app
}

// ── Re-export mocked services for test manipulation ───────────
export { identityService } from '../../services/identity.js'
export { budgetService } from '../../services/budget.js'
export { eventService } from '../../services/event.js'
export { discoveryService } from '../../services/discovery.js'
