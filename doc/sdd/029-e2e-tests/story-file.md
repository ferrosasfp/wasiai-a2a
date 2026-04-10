# Story File — #029: E2E Test Suite

> SDD: doc/sdd/029-e2e-tests/sdd.md
> Fecha: 2026-04-06
> Branch: feat/029-e2e-tests

---

## Goal

Build a comprehensive E2E test suite that constructs a real Fastify server instance with all middleware (request-id, error-boundary, rate-limit) and all routes wired, then exercises the full request/response cycle via `fastify.inject()`. External dependencies (Supabase, Anthropic SDK, adapter registry) are mocked at module level. Zero production code changes. 20 acceptance criteria covering health, middleware, identity, gasless, dashboard, discovery, error handling, and protected routes.

## Acceptance Criteria (EARS)

### Server bootstrap & health

- AC-1: WHEN the E2E test suite starts, the system SHALL build a Fastify app with all middleware and routes registered without errors.
- AC-2: WHEN GET / is called, the system SHALL return 200 with a JSON body containing `name` and `version` fields.
- AC-3: WHEN GET /.well-known/agent.json is called, the system SHALL return 200 with a valid A2A Agent Card JSON containing `name`, `description`, `url`, `capabilities`, and `skills` fields.

### Middleware chain verification

- AC-4: WHEN any request is processed, the response SHALL include an `x-request-id` header in UUID format.
- AC-5: WHEN a malformed request triggers an error, the system SHALL return a JSON body with `error`, `code`, and `requestId` fields.
- AC-6: WHEN 11 requests from the same context are sent within the rate-limit window, the 11th request SHALL return 429 with a `Retry-After` header.

### Identity flow (full E2E)

- AC-7: WHEN POST /auth/agent-signup is called with a valid `owner_ref`, the system SHALL return 201 with a response containing a key prefixed `wasi_a2a_`.
- AC-8: WHEN GET /auth/me is called with a valid x-a2a-key header, the system SHALL return 200 with budget/scoping info.
- AC-9: WHEN GET /auth/me is called without an x-a2a-key header, the system SHALL return 403.
- AC-10: WHEN GET /auth/me is called with an invalid x-a2a-key, the system SHALL return 403 with code KEY_NOT_FOUND.
- AC-11: WHEN POST /auth/deposit is called, the system SHALL return 501 (verification pending).
- AC-12: WHEN POST /auth/bind/:chain is called, the system SHALL return 501 (not implemented).

### Gasless endpoint

- AC-13: WHEN GET /gasless/status is called, the system SHALL return 200 with a JSON body containing a `funding_state` field with value `unconfigured`, `unfunded`, or `ready`.

### Dashboard

- AC-14: WHEN GET /dashboard is called, the system SHALL return 200 with an HTML response.
- AC-15: WHEN GET /dashboard/api/stats is called, the system SHALL return 200 with a JSON response.

### Discovery

- AC-16: WHEN GET /discover is called, the system SHALL return 200.

### Error handling E2E

- AC-17: WHEN a request is sent with invalid JSON body, the system SHALL return 400 with a structured error response containing `error`, `code`, and `requestId`.
- AC-18: WHEN a request is sent to a non-existent route, the system SHALL return 404.

### Protected routes (a2a-key middleware)

- AC-19: WHEN POST /compose is called without x-a2a-key and without x-payment headers, the system SHALL return 402 (x402 challenge).
- AC-20: WHEN POST /orchestrate is called without x-a2a-key and without x-payment headers, the system SHALL return 402 (x402 challenge).

## Files to Modify/Create

| # | Archivo | Accion | Que hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `src/__tests__/e2e/setup.ts` | Crear | buildTestApp() factory + all vi.mock declarations + mock helpers (makeKeyRow, TEST_KEY constants) | `src/routes/auth.test.ts` + `src/middleware/a2a-key.test.ts` |
| 2 | `src/__tests__/e2e/e2e.test.ts` | Crear | 20+ test cases organized by describe blocks covering AC-1 through AC-20 | `src/routes/auth.test.ts` |

## Exemplars

### Exemplar 1: vi.mock pattern for services
**Archivo**: `src/routes/auth.test.ts`
**Usar para**: File #1 (`setup.ts`) -- service mocking pattern
**Patron clave**:
- `vi.mock('../services/identity.js', () => ({ identityService: { createKey: vi.fn(), lookupByHash: vi.fn(), deactivate: vi.fn() } }))`
- Mock declared at top level BEFORE any imports of the mocked module
- After mock declaration, import the mocked module: `import { identityService } from '../services/identity.js'`
- Create typed references: `const mockCreateKey = vi.mocked(identityService.createKey)`
- Helper: `makeKeyRow(overrides)` returns full `A2AAgentKeyRow` with sensible defaults
- Constants: `TEST_KEY = 'wasi_a2a_' + 'a'.repeat(64)`, `TEST_KEY_HASH = crypto.createHash('sha256').update(TEST_KEY).digest('hex')`

### Exemplar 2: vi.mock pattern for adapter registry
**Archivo**: `src/middleware/a2a-key.test.ts` (lines 31-52)
**Usar para**: File #1 (`setup.ts`) -- adapter registry mocking
**Patron clave**:
- Mock `../adapters/registry.js` with all 7 exports as vi.fn() returning correct shapes:
  - `getPaymentAdapter`: returns object with `name`, `chainId`, `supportedTokens`, `getScheme`, `getNetwork`, `getToken`, `getMaxTimeoutSeconds`, `getMerchantName`, `settle`, `verify`, `quote`, `sign`
  - `getChainConfig`: returns `{ name: 'kite-ozone-testnet', chainId: 2368, explorerUrl: 'https://testnet.kitescan.ai' }`
  - `getGaslessAdapter`: returns object with `status` returning `{ funding_state: 'unconfigured' }`
  - `getAttestationAdapter`, `getIdentityBindingAdapter`: vi.fn()
  - `initAdapters`, `_resetRegistry`: vi.fn()

### Exemplar 3: Fastify test lifecycle + inject pattern
**Archivo**: `src/routes/auth.test.ts` (lines 69-214)
**Usar para**: File #2 (`e2e.test.ts`) -- test structure
**Patron clave**:
- `let app: ReturnType<typeof Fastify>`
- `beforeAll(async () => { app = await buildTestApp(); })` (in E2E: call buildTestApp)
- `afterAll(() => app.close())`
- `beforeEach(() => { vi.clearAllMocks() })`
- Request: `const res = await app.inject({ method: 'GET', url: '/path', headers?: {}, payload?: {} })`
- Assert: `expect(res.statusCode).toBe(200)`, `res.json()`, `res.headers['x-request-id']`

## Constraint Directives

### OBLIGATORIO

- Every E2E test SHALL exercise the real middleware chain (request-id, error-boundary, rate-limit) -- CD-3
- Internal middleware runs as REAL code: request-id, error-boundary, rate-limit, a2a-key, x402, timeout, backpressure -- CD-5
- `buildTestApp()` MUST register routes in the SAME ORDER as `src/index.ts` (see Section "buildTestApp Design" below)
- Follow `src/routes/auth.test.ts` for vi.mock + Fastify creation + inject pattern
- Follow `src/middleware/a2a-key.test.ts` lines 31-52 for adapter registry mock shape
- Set `process.env.RATE_LIMIT_MAX = '10'` BEFORE calling `buildTestApp()` for deterministic rate-limit tests
- Set `process.env.RATE_LIMIT_WINDOW_MS = '60000'` BEFORE calling `buildTestApp()`
- Set `process.env.KITE_WALLET_ADDRESS = '0x1234567890123456789012345678901234567890'` BEFORE calling `buildTestApp()` so x402 returns 402 instead of 503
- Imports in setup.ts: only modules that EXIST (verified via Glob in SDD phase)
- Use UUID regex for x-request-id assertions: `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`

### PROHIBIDO

- CD-1: NO modify any file under `src/` that is NOT inside `src/__tests__/`
- CD-2: NO add new npm dependencies
- CD-4: NO mock internal middleware -- they run as real code
- NO import `src/index.ts` directly (top-level await makes it non-importable)
- NO use `fastify.listen()` -- use `fastify.inject()` only
- NO hardcode expected UUIDs in x-request-id assertions -- use UUID regex
- NO create patterns different from existing test files
- NO call real external APIs (Supabase, Anthropic, Kite RPC)
- NO modify files outside the table "Files to Modify/Create"

## buildTestApp() Design (CRITICAL -- read fully)

This is the core of setup.ts. It replicates what `src/index.ts` does at the top level, minus `initAdapters()` and `fastify.listen()`.

### Step-by-step construction

```
1. import Fastify from 'fastify'
2. import cors from '@fastify/cors'
3. import { genReqId, registerRequestIdHook } from '../../../middleware/request-id.js'  // REAL
4. import { registerErrorBoundary } from '../../../middleware/error-boundary.js'          // REAL
5. import { registerRateLimit } from '../../../middleware/rate-limit.js'                  // REAL
6. import all 11 route modules (see route registration order below)                      // REAL

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
```

### Module-level vi.mock declarations (in setup.ts, BEFORE any imports)

These MUST be at the top of setup.ts, before any `import` of modules that transitively import the mocked modules.

**Layer 1 -- Supabase client** (prevents `process.exit(1)` from missing env vars):
```
vi.mock('../../../lib/supabase.js', () => ({
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
```

**Layer 2 -- Services** (each is a named export object with vi.fn() methods):
```
vi.mock('../../../services/identity.js', () => ({
  identityService: {
    createKey: vi.fn(),
    lookupByHash: vi.fn(),
    deactivate: vi.fn(),
  },
}))

vi.mock('../../../services/budget.js', () => ({
  budgetService: {
    getBalance: vi.fn(),
    debit: vi.fn(),
    registerDeposit: vi.fn(),
  },
}))

vi.mock('../../../services/authz.js', () => ({
  authzService: {
    checkScoping: vi.fn().mockReturnValue({ allowed: true }),
  },
}))

vi.mock('../../../services/event.js', () => ({
  eventService: {
    track: vi.fn().mockResolvedValue(undefined),
    stats: vi.fn().mockResolvedValue({ total_events: 0, events_24h: 0 }),
    recent: vi.fn().mockResolvedValue([]),
  },
}))

vi.mock('../../../services/discovery.js', () => ({
  discoveryService: {
    discover: vi.fn().mockResolvedValue({ agents: [], total: 0 }),
    queryRegistry: vi.fn().mockResolvedValue([]),
    mapAgent: vi.fn(),
    getAgent: vi.fn().mockResolvedValue(null),
  },
}))

vi.mock('../../../services/compose.js', () => ({
  composeService: {
    compose: vi.fn().mockResolvedValue({ success: true, output: null, steps: [], totalCostUsdc: 0, totalLatencyMs: 0 }),
    resolveAgent: vi.fn(),
    invokeAgent: vi.fn(),
  },
}))

vi.mock('../../../services/orchestrate.js', () => ({
  orchestrateService: {
    orchestrate: vi.fn().mockResolvedValue({ success: true, agents: [], result: null }),
  },
}))

vi.mock('../../../services/registry.js', () => ({
  registryService: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(undefined),
    register: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('../../../services/agent-card.js', () => ({
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

vi.mock('../../../services/task.js', () => ({
  taskService: {
    create: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    cancel: vi.fn(),
    update: vi.fn(),
  },
  TaskNotFoundError: class TaskNotFoundError extends Error { constructor(id: string) { super(`Task ${id} not found`); this.name = 'TaskNotFoundError' } },
  TerminalStateError: class TerminalStateError extends Error { constructor(msg: string) { super(msg); this.name = 'TerminalStateError' } },
}))
```

**Layer 3 -- Adapters** (same shape as `src/middleware/a2a-key.test.ts` lines 31-52):
```
vi.mock('../../../adapters/registry.js', () => ({
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
```

**Layer 4 -- Anthropic SDK** (imported by orchestrate and transform services):
```
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: vi.fn() },
  })),
}))
```

**Layer 5 -- Circuit breaker** (imported by orchestrate service):
```
vi.mock('../../../lib/circuit-breaker.js', () => ({
  anthropicCircuitBreaker: {
    fire: vi.fn().mockRejectedValue(new Error('Circuit breaker mocked')),
    isOpen: vi.fn().mockReturnValue(false),
    status: 'closed',
  },
  CircuitOpenError: class CircuitOpenError extends Error { constructor() { super('Circuit open'); this.name = 'CircuitOpenError' } },
}))
```

**Layer 6 -- LLM Transform** (imported by compose service):
```
vi.mock('../../../services/llm/transform.js', () => ({
  maybeTransform: vi.fn().mockResolvedValue({ transformed: false, data: null }),
}))
```

### Exports from setup.ts

```typescript
export { buildTestApp }
// Also re-export mocked services for test manipulation:
export { identityService } from '../../../services/identity.js'
export { budgetService } from '../../../services/budget.js'
export { eventService } from '../../../services/event.js'
export { discoveryService } from '../../../services/discovery.js'
```

## Mock Helpers (in setup.ts)

Reuse the `makeKeyRow()` pattern from `src/routes/auth.test.ts` (lines 41-65):

```typescript
import crypto from 'node:crypto'
import type { A2AAgentKeyRow } from '../../../types/index.js'

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
```

## Test Expectations

| Test (describe block) | ACs que cubre | Framework | Tipo |
|----------------------|--------------|-----------|------|
| `src/__tests__/e2e/e2e.test.ts` — "Server bootstrap + health" | AC-1, AC-2 | vitest | e2e |
| `src/__tests__/e2e/e2e.test.ts` — "Well-known agent card" | AC-3 | vitest | e2e |
| `src/__tests__/e2e/e2e.test.ts` — "Middleware — request-id" | AC-4 | vitest | e2e |
| `src/__tests__/e2e/e2e.test.ts` — "Middleware — error boundary" | AC-5 | vitest | e2e |
| `src/__tests__/e2e/e2e.test.ts` — "Middleware — rate limit" | AC-6 | vitest | e2e |
| `src/__tests__/e2e/e2e.test.ts` — "Identity — agent-signup" | AC-7 | vitest | e2e |
| `src/__tests__/e2e/e2e.test.ts` — "Identity — me" | AC-8, AC-9, AC-10 | vitest | e2e |
| `src/__tests__/e2e/e2e.test.ts` — "Identity — deposit + bind" | AC-11, AC-12 | vitest | e2e |
| `src/__tests__/e2e/e2e.test.ts` — "Gasless status" | AC-13 | vitest | e2e |
| `src/__tests__/e2e/e2e.test.ts` — "Dashboard" | AC-14, AC-15 | vitest | e2e |
| `src/__tests__/e2e/e2e.test.ts` — "Discovery" | AC-16 | vitest | e2e |
| `src/__tests__/e2e/e2e.test.ts` — "Error handling" | AC-17, AC-18 | vitest | e2e |
| `src/__tests__/e2e/e2e.test.ts` — "Protected routes" | AC-19, AC-20 | vitest | e2e |

### Criterio Test-First

| Tipo de cambio | Test-first? |
|----------------|-------------|
| Test infrastructure (setup.ts) | N/A -- is itself test code |
| E2E tests (e2e.test.ts) | N/A -- is itself test code |

## AC-to-test mapping (describe/it blocks)

Each AC maps to at least one `it()` block in `e2e.test.ts`:

| AC | describe block | it() description | Key assertion |
|----|---------------|-----------------|---------------|
| AC-1 | Server bootstrap + health | `buildTestApp() completes without errors` | `expect(app).toBeDefined()` in beforeAll |
| AC-2 | Server bootstrap + health | `GET / returns 200 with name and version` | `statusCode === 200`, body has `name`, `version` |
| AC-3 | Well-known agent card | `GET /.well-known/agent.json returns valid Agent Card` | `statusCode === 200`, body has `name`, `description`, `url`, `capabilities`, `skills` |
| AC-4 | Middleware -- request-id | `every response includes x-request-id in UUID format` | `headers['x-request-id']` matches UUID regex |
| AC-5 | Middleware -- error boundary | `error responses have structured shape` | body has `error`, `code`, `requestId` fields |
| AC-6 | Middleware -- rate limit | `11th request returns 429 with Retry-After` | loop 11 requests, last `statusCode === 429`, has `retry-after` header |
| AC-7 | Identity -- agent-signup | `POST /auth/agent-signup returns 201 with wasi_a2a_ key` | `statusCode === 201`, `body.key` starts with `wasi_a2a_` |
| AC-8 | Identity -- me | `GET /auth/me with valid key returns 200` | `statusCode === 200`, body has budget/scoping |
| AC-9 | Identity -- me | `GET /auth/me without header returns 403` | `statusCode === 403` |
| AC-10 | Identity -- me | `GET /auth/me with invalid key returns 403` | `statusCode === 403`, mock `lookupByHash` returns null |
| AC-11 | Identity -- deposit + bind | `POST /auth/deposit returns 501` | `statusCode === 501` |
| AC-12 | Identity -- deposit + bind | `POST /auth/bind/kite returns 501` | `statusCode === 501` |
| AC-13 | Gasless status | `GET /gasless/status returns 200 with funding_state` | `statusCode === 200`, body has `funding_state` |
| AC-14 | Dashboard | `GET /dashboard returns 200 with text/html` | `statusCode === 200`, `content-type` contains `text/html` |
| AC-15 | Dashboard | `GET /dashboard/api/stats returns 200 with JSON` | `statusCode === 200`, `content-type` contains `application/json` |
| AC-16 | Discovery | `GET /discover returns 200` | `statusCode === 200` |
| AC-17 | Error handling | `POST with invalid JSON returns 400 with structured error` | `statusCode === 400`, body has `error`, `code`, `requestId` |
| AC-18 | Error handling | `GET /nonexistent returns 404` | `statusCode === 404` |
| AC-19 | Protected routes | `POST /compose without auth returns 402` | `statusCode === 402` |
| AC-20 | Protected routes | `POST /orchestrate without auth returns 402` | `statusCode === 402` |

## Waves

### Wave -1: Environment Gate (OBLIGATORIO -- verificar antes de tocar codigo)

```bash
# Verify vitest is available
npx vitest --version

# Verify tsc clean
npx tsc --noEmit

# Verify existing tests pass
npx vitest run --reporter=verbose 2>&1 | tail -5

# Verify target directory does NOT exist yet
ls src/__tests__/e2e/ 2>/dev/null && echo "EXISTS -- unexpected" || echo "OK -- directory does not exist"

# Verify critical source files exist
ls src/index.ts src/middleware/request-id.ts src/middleware/error-boundary.ts src/middleware/rate-limit.ts src/static/dashboard.html

# Verify route modules exist
ls src/routes/registries.ts src/routes/discover.ts src/routes/compose.ts src/routes/orchestrate.ts src/routes/agent-card.ts src/routes/well-known.ts src/routes/tasks.ts src/routes/dashboard.ts src/routes/mock-registry.ts src/routes/gasless.ts src/routes/auth.ts
```

**Si algo falla en Wave -1:** PARAR y reportar al orquestador antes de continuar.

### Wave 0 (Serial Gate -- test infrastructure)

- [ ] W0.1: Create `src/__tests__/e2e/setup.ts`
  - All vi.mock declarations (Layer 1-6 as specified in "buildTestApp Design" section above)
  - `buildTestApp()` function (exact construction sequence from "buildTestApp Design")
  - Export helpers: `makeKeyRow()`, `TEST_KEY`, `TEST_KEY_HASH`, `TEST_KEY_ID`
  - Re-export mocked services for test manipulation
  - **Exemplar**: `src/routes/auth.test.ts` (vi.mock pattern) + `src/middleware/a2a-key.test.ts` (adapter mock shape)

- [ ] W0.2: Create `src/__tests__/e2e/e2e.test.ts`
  - Import from `./setup.js`
  - Set env vars BEFORE buildTestApp: `RATE_LIMIT_MAX=10`, `RATE_LIMIT_WINDOW_MS=60000`, `KITE_WALLET_ADDRESS=0x1234567890123456789012345678901234567890`
  - Skeleton: `describe('E2E')` with nested describes for each AC group
  - `beforeAll(async () => { app = await buildTestApp() })`
  - `afterAll(() => app.close())`
  - `beforeEach(() => { vi.clearAllMocks() })`
  - Empty describe blocks (no it() yet)
  - **Exemplar**: `src/routes/auth.test.ts` (lifecycle pattern)

**Verificacion W0:**
```bash
npx vitest run src/__tests__/e2e/ --reporter=verbose
# Expected: 0 tests, 0 failures (app builds without errors)
```

### Wave 1 (Parallelizable -- basic endpoints)

- [ ] W1.1: Health + well-known tests (AC-1, AC-2, AC-3, AC-4)
  - AC-1: implicit in beforeAll succeeding
  - AC-2: `GET /` -> 200, body has `name: 'WasiAI A2A Protocol'`, `version: '0.1.0'`
  - AC-3: `GET /.well-known/agent.json` -> 200, body has `name`, `description`, `url`, `capabilities`, `skills` (mock returns this shape)
  - AC-4: check `x-request-id` header on any response matches UUID regex

- [ ] W1.2: Error handling tests (AC-5, AC-17, AC-18)
  - AC-5: trigger error by calling a service mock that throws, verify response has `error`, `code`, `requestId` fields. Strategy: mock a service (e.g., `discoveryService.discover`) to throw, then call `GET /discover`. The real error-boundary catches it and returns structured error.
  - AC-17: send `POST /orchestrate` with `Content-Type: application/json` but invalid JSON body -> Fastify returns 400 with parse error. The real error-boundary normalizes it to `{ error, code, requestId }`.
  - AC-18: `GET /this-route-does-not-exist` -> 404

- [ ] W1.3: Dashboard + discovery + gasless tests (AC-13, AC-14, AC-15, AC-16)
  - AC-13: `GET /gasless/status` -> 200, body has `funding_state: 'unconfigured'` (from mock)
  - AC-14: `GET /dashboard` -> 200, `content-type` contains `text/html`
  - AC-15: `GET /dashboard/api/stats` -> 200, `content-type` contains `application/json`
  - AC-16: `GET /discover` -> 200 (mock returns `{ agents: [], total: 0 }`)

**Verificacion W1:**
```bash
npx vitest run src/__tests__/e2e/ --reporter=verbose
# Expected: 12+ tests passing
```

### Wave 2 (Depends on W0 + W1 -- complex flows)

- [ ] W2.1: Identity flow tests (AC-7, AC-8, AC-9, AC-10, AC-11, AC-12)
  - AC-7: mock `identityService.createKey` to return `{ key: TEST_KEY, key_id: TEST_KEY_ID }`. POST `/auth/agent-signup` with `{ owner_ref: 'user-1' }` -> 201, `body.key` starts with `wasi_a2a_`
  - AC-8: mock `identityService.lookupByHash` to return `makeKeyRow()`. GET `/auth/me` with `x-a2a-key: <TEST_KEY>` -> 200, body has budget + scoping
  - AC-9: GET `/auth/me` without x-a2a-key header -> 403
  - AC-10: mock `lookupByHash` to return null. GET `/auth/me` with `x-a2a-key: wasi_a2a_bad` -> 403
  - AC-11: POST `/auth/deposit` -> 501
  - AC-12: POST `/auth/bind/kite` -> 501

- [ ] W2.2: Rate-limit test (AC-6)
  - **IMPORTANT**: Use a SEPARATE `buildTestApp()` instance to avoid rate-limit state pollution from W1 tests
  - Create a nested describe with its own `beforeAll`/`afterAll` calling `buildTestApp()`
  - Fire 11 requests to `POST /auth/agent-signup` (a rate-limited endpoint -- auth routes do NOT set `rateLimit: false`)
  - Mock `identityService.createKey` to return a valid result for each call
  - The 11th request -> 429 with `retry-after` header (lowercase, per HTTP standard)

- [ ] W2.3: Protected routes tests (AC-19, AC-20)
  - AC-19: POST `/compose` without `x-a2a-key` or `x-payment` -> 402. The `KITE_WALLET_ADDRESS` env var is already set (Wave -1 env setup), so x402 returns 402 (not 503)
  - AC-20: POST `/orchestrate` without `x-a2a-key` or `x-payment` -> 402. Same as AC-19 but different endpoint.
  - Note: POST /orchestrate has a JSON schema validation (`required: ['goal', 'budget']`). Since the x402/a2a-key preHandler runs BEFORE body validation, the 402 should still be returned even without a body. Verify this -- if it fails, send `{ goal: 'test', budget: 1 }` as payload to pass schema validation.

**Verificacion W2:**
```bash
npx vitest run src/__tests__/e2e/ --reporter=verbose
# Expected: 20+ tests passing, all ACs covered
```

### Wave 3 (Final -- full regression)

- [ ] W3.1: Run full test suite to verify no regressions in existing 229 unit tests
```bash
npx vitest run --reporter=verbose
# Expected: 229 + 20+ tests all passing
```

- [ ] W3.2: Run tsc to verify no type errors
```bash
npx tsc --noEmit
```

### Verificacion Incremental

| Wave | Verificacion al completar |
|------|--------------------------|
| W-1 | Environment gate: all tools available, all source files exist |
| W0 | `npx vitest run src/__tests__/e2e/` -- 0 tests, 0 failures, app builds |
| W1 | `npx vitest run src/__tests__/e2e/` -- 12+ tests pass |
| W2 | `npx vitest run src/__tests__/e2e/` -- 20+ tests pass |
| W3 | `npx vitest run` -- all tests pass (229 existing + 20+ new), tsc clean |

## Out of Scope

- Production code (anything in `src/` outside of `src/__tests__/`)
- Existing unit tests (no modifications)
- New npm dependencies
- CI/CD pipeline changes
- Performance/load testing
- Browser/UI testing
- Any file not listed in "Files to Modify/Create"
- NO "mejorar" codigo adyacente
- NO agregar funcionalidad no listada
- NO refactors no solicitados

## Escalation Rule

> **Si algo no esta en este Story File, Dev PARA y pregunta a Architect.**
> No inventar. No asumir. No improvisar.
> Architect resuelve y actualiza el Story File antes de que Dev continue.

Situaciones de escalation:
- A vi.mock path does not resolve correctly (module not found)
- A route module fails to register in buildTestApp()
- An exemplar file has changed since SDD was written
- The `dashboard.html` readFileSync fails due to path resolution in test context
- A mock shape does not match the expected interface (type errors)
- The rate-limit test does not trigger 429 after 11 requests
- The x402 middleware returns 503 instead of 402 (env var issue)
- Any ambiguity in an AC

---

*Story File generado por NexusAgil -- F2.5*
