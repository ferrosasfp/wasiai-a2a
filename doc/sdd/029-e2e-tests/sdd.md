# SDD #029: E2E Test Suite

> SPEC_APPROVED: no
> Fecha: 2026-04-06
> Tipo: feature
> SDD_MODE: full
> Branch: feat/029-e2e-tests
> Artefactos: doc/sdd/029-e2e-tests/

---

## 1. Resumen

Build a comprehensive E2E test suite that constructs a real Fastify server instance with all middleware registered (request-id, error-boundary, rate-limit) and all routes wired, then exercises the full request/response cycle via `fastify.inject()`. External dependencies (Supabase, Anthropic SDK, Kite adapters) are mocked at module level. The suite covers 20 acceptance criteria spanning health, middleware chain, identity flow, gasless, dashboard, discovery, error handling, and protected routes.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 029 |
| **Tipo** | feature |
| **SDD_MODE** | full |
| **Objetivo** | E2E test coverage for all HTTP endpoints with real middleware chain |
| **Reglas de negocio** | Zero production code changes; mock only externals; real middleware |
| **Scope IN** | `src/__tests__/e2e/setup.ts`, `src/__tests__/e2e/e2e.test.ts` |
| **Scope OUT** | Production code, unit tests, new deps, CI/CD, perf testing |
| **Missing Inputs** | All resolved (see Section 9) |

### Acceptance Criteria (EARS)

AC-1 through AC-20 as defined in work-item.md (inherited verbatim).

## 3. Context Map (Codebase Grounding)

### Archivos leidos

| Archivo | Por que | Patron extraido |
|---------|---------|-----------------|
| `src/index.ts` | Understand app construction sequence | Fastify instance creation, middleware registration order (request-id -> error-boundary -> rate-limit), route registration order with prefixes, top-level `await initAdapters()` + `await fastify.listen()` preventing direct import |
| `src/middleware/request-id.ts` | Understand genReqId + onSend hook | `genReqId` export (UUID v4), `registerRequestIdHook` adds `x-request-id` header via onSend hook |
| `src/middleware/error-boundary.ts` | Error normalization shape | `setErrorHandler` returns `{ error, code, details?, requestId }`, handles validation (400), coded errors, rate-limit (429), default (500) |
| `src/middleware/rate-limit.ts` | Rate limit config | `@fastify/rate-limit` plugin, reads `RATE_LIMIT_MAX` + `RATE_LIMIT_WINDOW_MS` from env, custom errorResponseBuilder throws Error with statusCode/code/retryAfterMs |
| `src/middleware/a2a-key.ts` | Protected route middleware | `requirePaymentOrA2AKey()` checks x-a2a-key header first, falls back to x402. Imports `identityService`, `budgetService`, `authzService`, `getChainConfig` |
| `src/middleware/x402.ts` | x402 payment challenge | `requirePayment()` returns 402 with x402 response when no x-payment header, calls `getPaymentAdapter()` |
| `src/adapters/registry.ts` | Adapter init + getters | `initAdapters()` dynamically imports `kite-ozone/index.js`, sets module-level vars. Has `_resetRegistry()` for testing. Getters throw if not initialized |
| `src/adapters/types.ts` | Adapter interface shapes | `PaymentAdapter`, `AttestationAdapter`, `GaslessAdapter`, `IdentityBindingAdapter` interfaces with all required methods |
| `src/routes/auth.ts` | Auth route handlers | POST /agent-signup calls `identityService.createKey`, GET /me calls `identityService.lookupByHash` via SHA-256 hash, POST /deposit returns 501, POST /bind/:chain returns 501 |
| `src/routes/well-known.ts` | Agent card route | GET /.well-known/agent.json calls `agentCardService.buildSelfAgentCard()`, exempt from rate limit |
| `src/routes/gasless.ts` | Gasless status | GET /gasless/status calls `getGaslessAdapter().status()`, exempt from rate limit |
| `src/routes/dashboard.ts` | Dashboard routes | GET /dashboard reads HTML from `src/static/dashboard.html`, GET /dashboard/api/stats calls `eventService.stats()`, both exempt from rate limit |
| `src/routes/discover.ts` | Discovery route | GET /discover calls `discoveryService.discover()`, exempt from rate limit |
| `src/routes/compose.ts` | Compose route | POST /compose uses `requirePaymentOrA2AKey()` + timeout preHandler |
| `src/routes/orchestrate.ts` | Orchestrate route | POST /orchestrate uses `requirePaymentOrA2AKey()` + backpressure + timeout preHandlers |
| `src/services/identity.ts` | Identity service | `createKey` returns `{ key: "wasi_a2a_...", key_id: uuid }`, `lookupByHash` returns `A2AAgentKeyRow` or null |
| `src/services/event.ts` | Event/stats service | `eventService.stats()` queries Supabase, returns `DashboardStats` |
| `src/lib/supabase.ts` | Supabase singleton | `createClient()` at module level, calls `process.exit(1)` if env vars missing -- MUST be mocked |
| `src/routes/auth.test.ts` | Test pattern exemplar | vi.mock at top, `Fastify()` + `register(route)` + `app.ready()` in beforeAll, `app.inject()` for requests, `vi.clearAllMocks()` in beforeEach |
| `src/middleware/a2a-key.test.ts` | Mock pattern for adapters | vi.mock for `../adapters/registry.js` with all 6 exports mocked as vi.fn() returning objects matching adapter interfaces |

### Exemplars

| Para crear/modificar | Seguir patron de | Razon |
|---------------------|------------------|-------|
| `src/__tests__/e2e/setup.ts` | `src/routes/auth.test.ts` (lines 6-33) + `src/middleware/a2a-key.test.ts` (lines 14-52) | vi.mock pattern for services + adapters, Fastify instance creation |
| `src/__tests__/e2e/e2e.test.ts` | `src/routes/auth.test.ts` (lines 69-214) | describe/it structure, app.inject() pattern, beforeAll/afterAll lifecycle |

### Componentes reutilizables encontrados

- `makeKeyRow()` helper in `src/routes/auth.test.ts` lines 41-65 -- reuse the same shape for A2AAgentKeyRow construction in E2E tests
- `genReqId` export from `src/middleware/request-id.ts` -- import directly (real code, not mocked)
- `registerRequestIdHook` + `registerErrorBoundary` + `registerRateLimit` from middleware modules -- import and call in buildTestApp (real code, not mocked)

## 4. Diseno Tecnico

### 4.1 Archivos a crear/modificar

| Archivo | Accion | Descripcion | Exemplar |
|---------|--------|-------------|----------|
| `src/__tests__/e2e/setup.ts` | Crear | `buildTestApp()` factory + module-level vi.mock declarations + mock helpers | `src/routes/auth.test.ts` + `src/middleware/a2a-key.test.ts` |
| `src/__tests__/e2e/e2e.test.ts` | Crear | 20+ test cases organized by describe blocks, covering AC-1 through AC-20 | `src/routes/auth.test.ts` |

### 4.2 Modelo de datos

N/A -- no DB changes.

### 4.3 Componentes / Servicios

#### `buildTestApp()` -- The core E2E helper

This function replicates what `src/index.ts` does at the top level, but without `initAdapters()` or `fastify.listen()`:

1. Create `Fastify({ logger: false, genReqId })` (logger: false to reduce test noise)
2. Register CORS via `@fastify/cors`
3. Call `registerRequestIdHook(fastify)` -- REAL
4. Call `registerErrorBoundary(fastify)` -- REAL
5. Call `await registerRateLimit(fastify)` -- REAL (reads env vars, so set RATE_LIMIT_MAX=10 before)
6. Register inline health route (GET /) -- replicate the 7-line handler from index.ts
7. Register all route plugins with their prefixes: registries, discover, compose, orchestrate, agents, well-known, tasks, dashboard, mock-registry, gasless, auth
8. Call `await fastify.ready()`
9. Return the fastify instance

#### Mock strategy (DT-3 from work-item)

Three layers of mocking, all via `vi.mock()` at module level in `setup.ts`:

**Layer 1 -- Supabase client** (`src/lib/supabase.ts`):
Mock the module to export a fake `supabase` object. This prevents `process.exit(1)` from the missing env vars guard. The mock provides chainable `.from().select().eq().single()` etc. However, since services that use supabase are also mocked, this is primarily a safety net.

**Layer 2 -- Services** (modules that call Supabase/external APIs):
- `src/services/identity.js` -- mock `identityService.createKey`, `lookupByHash`, `deactivate`
- `src/services/budget.js` -- mock `budgetService.getBalance`, `debit`, `registerDeposit`
- `src/services/event.js` -- mock `eventService.stats`, `recent`, `record`
- `src/services/discovery.js` -- mock `discoveryService.discover`
- `src/services/compose.js` -- mock `composeService.execute`
- `src/services/orchestrate.js` -- mock `orchestrateService.plan`
- `src/services/registry.js` -- mock `registryService.getEnabled`, `get`, `register`, `delete`

**Layer 3 -- Adapters** (`src/adapters/registry.js`):
Mock all exports: `initAdapters` (no-op), `getPaymentAdapter` (returns mock PaymentAdapter), `getChainConfig` (returns `{ name: 'kite-ozone-testnet', chainId: 2368, explorerUrl: 'https://testnet.kitescan.ai' }`), `getGaslessAdapter` (returns mock with `status()` returning `{ funding_state: 'unconfigured', ... }`), `getAttestationAdapter`, `getIdentityBindingAdapter`, `_resetRegistry`.

**What runs REAL (CD-5):**
- `src/middleware/request-id.ts` -- genReqId + onSend hook
- `src/middleware/error-boundary.ts` -- setErrorHandler
- `src/middleware/rate-limit.ts` -- @fastify/rate-limit plugin
- `src/middleware/a2a-key.ts` -- the middleware itself (but its service imports are mocked)
- `src/middleware/x402.ts` -- the middleware itself (but getPaymentAdapter is mocked)
- `src/middleware/timeout.ts` -- real timeout handler
- `src/middleware/backpressure.ts` -- real backpressure handler
- All route handlers in `src/routes/*.ts` -- real code, calling mocked services

### 4.4 Flujo principal (Happy Path)

1. Test file imports `buildTestApp` from `setup.ts`
2. `beforeAll` calls `buildTestApp()` which constructs Fastify with all middleware + routes
3. Each test calls `app.inject({ method, url, headers?, payload? })`
4. Request flows through real middleware chain (request-id -> error-boundary -> rate-limit -> route-specific preHandlers)
5. Route handler executes, calling mocked services
6. Response flows back through onSend hooks (x-request-id header added)
7. Test asserts on status code, headers, body shape

### 4.5 Flujo de error

1. If `buildTestApp()` fails (e.g., a module vi.mock is missing), all tests in the suite fail in beforeAll with a clear error
2. If a mocked service throws unexpectedly, the real error-boundary catches it and returns `{ error, code, requestId }` -- this is actually tested by AC-5
3. Rate limit tests: after 10 requests (RATE_LIMIT_MAX=10), the 11th returns 429 with Retry-After header

### 4.6 Rate-limit testing strategy (DT-4)

Set `process.env.RATE_LIMIT_MAX = '10'` and `process.env.RATE_LIMIT_WINDOW_MS = '60000'` BEFORE calling `buildTestApp()`. The rate-limit describe block fires 11 requests to a rate-limited endpoint (e.g., GET /discover which has rate limiting enabled via global: true). The 11th request asserts 429 + `Retry-After` header.

Important: routes with `config: { rateLimit: false }` (health, well-known, dashboard) are EXEMPT. The rate-limit test must target a route WITHOUT this exemption. GET /discover is a good candidate since it has `config: { rateLimit: false }` -- actually checking... it does have rateLimit: false. Need a route that does NOT exempt itself. The auth routes do NOT set `rateLimit: false`, so POST /auth/agent-signup or GET /auth/me are valid targets for rate-limit testing.

### 4.7 Identity flow testing strategy (DT-5)

For AC-7 (agent-signup): mock `identityService.createKey` to return `{ key: 'wasi_a2a_test...', key_id: 'uuid' }`.

For AC-8 (GET /me with valid key): mock `identityService.lookupByHash` to return a valid `A2AAgentKeyRow`. The test sends `x-a2a-key: wasi_a2a_<64hex>` header. The route hashes it with SHA-256 and calls `lookupByHash(hash)` -- the mock responds to any hash.

For AC-9 (GET /me without key): no x-a2a-key header -> route returns 403 directly (no hash lookup needed).

For AC-10 (GET /me with invalid key): mock `lookupByHash` to return null -> route returns 403.

### 4.8 Protected routes strategy (AC-19, AC-20)

POST /compose and POST /orchestrate use `requirePaymentOrA2AKey()` as preHandler. When neither `x-a2a-key` nor `x-payment` headers are present:
1. `requirePaymentOrA2AKey` sees no x-a2a-key -> delegates to x402 fallback
2. x402 handler sees no x-payment header -> returns 402 with x402 challenge body

The mock `getPaymentAdapter()` must return a valid PaymentAdapter mock (with getScheme, getNetwork, getToken, etc.) so the 402 response body can be constructed. The `PAYMENT_WALLET_ADDRESS` or `KITE_WALLET_ADDRESS` env var must be set to avoid 503.

## 5. Constraint Directives (Anti-Alucinacion)

### OBLIGATORIO seguir

- CD-3: Every E2E test SHALL exercise the real middleware chain (request-id, error-boundary, rate-limit)
- CD-5: Internal middleware runs as real code -- request-id, error-boundary, rate-limit, a2a-key, x402
- Patron de test setup: follow `src/routes/auth.test.ts` for vi.mock + Fastify creation + inject pattern
- Patron de adapter mock: follow `src/middleware/a2a-key.test.ts` lines 32-52 for registry mock shape
- `buildTestApp()` MUST register routes in the same order as `src/index.ts` to match real behavior
- Set `process.env.RATE_LIMIT_MAX = '10'` before app construction for deterministic rate-limit tests
- Set `process.env.KITE_WALLET_ADDRESS = '0x...'` (any non-empty value) before app construction for x402 to return 402 instead of 503
- Imports in setup.ts: only modules that EXIST (verified via Glob)

### PROHIBIDO

- CD-1: PROHIBIDO modify any file under `src/` that is not inside `src/__tests__/`
- CD-2: PROHIBIDO add new npm dependencies
- CD-4: PROHIBIDO mock internal middleware -- they run as real code
- PROHIBIDO import `src/index.ts` directly (top-level await makes it non-importable)
- PROHIBIDO use `fastify.listen()` -- use `fastify.inject()` only (DT-2)
- PROHIBIDO hardcode expected UUIDs in x-request-id assertions -- use UUID regex pattern
- PROHIBIDO create patterns different from existing test files
- PROHIBIDO call real external APIs (Supabase, Anthropic, Kite RPC)

## 6. Scope

**IN:**
- `src/__tests__/e2e/setup.ts` -- buildTestApp() helper + mock wiring
- `src/__tests__/e2e/e2e.test.ts` -- 20+ test cases for AC-1 through AC-20

**OUT:**
- Production code changes
- Unit test modifications
- New npm dependencies
- CI/CD pipeline changes
- Performance/load testing

## 7. Riesgos

| Riesgo | Probabilidad | Impacto | Mitigacion |
|--------|-------------|---------|------------|
| vi.mock hoisting may not cover all transitive imports | M | A | Mock at the deepest dependency level (supabase.js, adapters/registry.js) to catch all import chains |
| Dashboard route reads `src/static/dashboard.html` at module load time via `readFileSync` | M | M | The file exists (verified via Glob). If the relative path resolution fails in test context, mock the dashboard routes module or ensure cwd matches |
| Rate-limit state leaks between describe blocks | M | M | Use a fresh `buildTestApp()` for the rate-limit describe block, or run rate-limit tests last |
| `@fastify/rate-limit` uses in-memory store by default -- state persists within same Fastify instance | B | M | Create a dedicated Fastify instance for rate-limit tests via a separate `buildTestApp()` call |

## 8. Dependencias

- vitest (already in devDependencies)
- @fastify/cors (already in dependencies)
- @fastify/rate-limit (already in dependencies)
- `src/static/dashboard.html` must exist (verified: it does)
- All route modules in `src/routes/` must be importable (they are -- only their service dependencies need mocking)

## 9. Missing Inputs (resolved)

- [x] Mock shape for `createKiteOzoneAdapters()`: Not needed -- we mock `src/adapters/registry.js` at the getter level (getPaymentAdapter, getGaslessAdapter, etc.), not the kite-ozone factory. Pattern verified from `src/middleware/a2a-key.test.ts` lines 32-52.
- [x] `identityService.createKey` returns `{ key: 'wasi_a2a_<64hex>', key_id: uuid }` -- verified from `src/services/identity.ts` lines 17-48.
- [x] Dashboard stats mock shape: `eventService.stats()` returns a `DashboardStats` object -- mock it to return any valid object. The test only checks 200 + JSON response, not specific fields.

## 10. Uncertainty Markers

None. All inputs resolved.

---

## Plan de Implementacion (Waves)

### Wave 0 (Serial Gate -- test infrastructure)

- [ ] W0.1: Create `src/__tests__/e2e/setup.ts` with all vi.mock declarations + `buildTestApp()` factory
- [ ] W0.2: Create `src/__tests__/e2e/e2e.test.ts` with skeleton: imports from setup, beforeAll/afterAll, empty describe blocks for each AC group

**Verificacion W0:** `npx vitest run src/__tests__/e2e/` passes with 0 tests (no errors from mock wiring or app construction)

### Wave 1 (Parallelizable -- basic endpoints)

- [ ] W1.1: Health + well-known tests (AC-1, AC-2, AC-3, AC-4)
- [ ] W1.2: Error handling tests (AC-5, AC-17, AC-18)
- [ ] W1.3: Dashboard + discovery + gasless tests (AC-13, AC-14, AC-15, AC-16)

**Verificacion W1:** `npx vitest run src/__tests__/e2e/` -- 12+ tests pass

### Wave 2 (Depends on W0 + W1 -- complex flows)

- [ ] W2.1: Identity flow tests (AC-7, AC-8, AC-9, AC-10, AC-11, AC-12)
- [ ] W2.2: Rate-limit test (AC-6) -- separate Fastify instance to avoid state pollution
- [ ] W2.3: Protected routes tests (AC-19, AC-20) -- x402 challenge verification

**Verificacion W2:** `npx vitest run src/__tests__/e2e/` -- 20+ tests pass, all ACs covered

### Wave 3 (Final)

- [ ] W3.1: Run full test suite `npx vitest run` to verify no regressions in existing 229 unit tests
- [ ] W3.2: Cleanup any console noise from test output

## Test Plan

| Test (describe block) | ACs covered | Wave | File |
|----------------------|-------------|------|------|
| Server bootstrap + health | AC-1, AC-2 | W1.1 | `src/__tests__/e2e/e2e.test.ts` |
| Well-known agent card | AC-3 | W1.1 | `src/__tests__/e2e/e2e.test.ts` |
| Middleware chain -- request-id | AC-4 | W1.1 | `src/__tests__/e2e/e2e.test.ts` |
| Middleware chain -- error boundary | AC-5 | W1.2 | `src/__tests__/e2e/e2e.test.ts` |
| Middleware chain -- rate limit | AC-6 | W2.2 | `src/__tests__/e2e/e2e.test.ts` |
| Identity -- agent-signup | AC-7 | W2.1 | `src/__tests__/e2e/e2e.test.ts` |
| Identity -- me (valid) | AC-8 | W2.1 | `src/__tests__/e2e/e2e.test.ts` |
| Identity -- me (no header) | AC-9 | W2.1 | `src/__tests__/e2e/e2e.test.ts` |
| Identity -- me (invalid key) | AC-10 | W2.1 | `src/__tests__/e2e/e2e.test.ts` |
| Identity -- deposit | AC-11 | W2.1 | `src/__tests__/e2e/e2e.test.ts` |
| Identity -- bind | AC-12 | W2.1 | `src/__tests__/e2e/e2e.test.ts` |
| Gasless -- status | AC-13 | W1.3 | `src/__tests__/e2e/e2e.test.ts` |
| Dashboard -- HTML | AC-14 | W1.3 | `src/__tests__/e2e/e2e.test.ts` |
| Dashboard -- API stats | AC-15 | W1.3 | `src/__tests__/e2e/e2e.test.ts` |
| Discovery | AC-16 | W1.3 | `src/__tests__/e2e/e2e.test.ts` |
| Error -- invalid JSON | AC-17 | W1.2 | `src/__tests__/e2e/e2e.test.ts` |
| Error -- 404 | AC-18 | W1.2 | `src/__tests__/e2e/e2e.test.ts` |
| Protected -- compose 402 | AC-19 | W2.3 | `src/__tests__/e2e/e2e.test.ts` |
| Protected -- orchestrate 402 | AC-20 | W2.3 | `src/__tests__/e2e/e2e.test.ts` |

## AC-to-file mapping

| AC | Test assertion | File |
|----|---------------|------|
| AC-1 | `buildTestApp()` completes without throwing | `e2e.test.ts` beforeAll |
| AC-2 | GET / returns 200, body has `name` + `version` | `e2e.test.ts` |
| AC-3 | GET /.well-known/agent.json returns 200, body has `name`, `description`, `url`, `capabilities`, `skills` | `e2e.test.ts` |
| AC-4 | Any response has `x-request-id` header matching UUID regex | `e2e.test.ts` |
| AC-5 | Trigger error -> response has `error`, `code`, `requestId` fields | `e2e.test.ts` |
| AC-6 | 11th request returns 429 + `retry-after` header | `e2e.test.ts` |
| AC-7 | POST /auth/agent-signup returns 201, body.key starts with `wasi_a2a_` | `e2e.test.ts` |
| AC-8 | GET /auth/me with valid x-a2a-key returns 200 with budget/scoping | `e2e.test.ts` |
| AC-9 | GET /auth/me without header returns 403 | `e2e.test.ts` |
| AC-10 | GET /auth/me with invalid key returns 403, body.error contains info | `e2e.test.ts` |
| AC-11 | POST /auth/deposit returns 501 | `e2e.test.ts` |
| AC-12 | POST /auth/bind/kite returns 501 | `e2e.test.ts` |
| AC-13 | GET /gasless/status returns 200, body has `funding_state` | `e2e.test.ts` |
| AC-14 | GET /dashboard returns 200, content-type text/html | `e2e.test.ts` |
| AC-15 | GET /dashboard/api/stats returns 200, content-type application/json | `e2e.test.ts` |
| AC-16 | GET /discover returns 200 | `e2e.test.ts` |
| AC-17 | POST with invalid JSON body returns 400 with `error`, `code`, `requestId` | `e2e.test.ts` |
| AC-18 | GET /nonexistent returns 404 | `e2e.test.ts` |
| AC-19 | POST /compose without x-a2a-key/x-payment returns 402 | `e2e.test.ts` |
| AC-20 | POST /orchestrate without x-a2a-key/x-payment returns 402 | `e2e.test.ts` |

## Estimacion

- Archivos nuevos: 2
- Archivos modificados: 0
- Tests nuevos: 20+
- Lineas estimadas: ~350-450

---

## Readiness Check

- [x] Cada AC tiene al menos 1 archivo asociado en tabla 4.1
- [x] Cada archivo en tabla 4.1 tiene un Exemplar valido (verificado con Glob: `src/routes/auth.test.ts`, `src/middleware/a2a-key.test.ts`)
- [x] No hay [NEEDS CLARIFICATION] pendientes
- [x] Constraint Directives incluyen al menos 3 PROHIBIDO (8 listed)
- [x] Context Map tiene al menos 2 archivos leidos (20 listed)
- [x] Scope IN y OUT son explicitos y no ambiguos
- [x] Si hay BD: N/A -- no DB changes
- [x] Flujo principal (Happy Path) esta completo
- [x] Flujo de error esta definido (3 cases)

---

*SDD generado por NexusAgil -- FULL*
