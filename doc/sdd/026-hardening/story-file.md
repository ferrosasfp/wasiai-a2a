# Story File -- #026: Hardening — Rate Limiting, Error Boundaries, Circuit Breaker, Backpressure

> SDD: doc/sdd/026-hardening/sdd.md
> Fecha: 2026-04-06
> Branch: feat/026-hardening

---

## Goal

Harden the WasiAI A2A gateway for production by adding 7 resilience subsystems: rate limiting (via `@fastify/rate-limit`), a global error boundary that normalizes all error responses, a custom in-memory circuit breaker for Anthropic SDK and registry HTTP calls, backpressure via in-flight counter on `/orchestrate`, request ID (UUID v4) propagated in headers and logs, explicit timeouts (120s orchestrate, 60s compose), and graceful shutdown with 30-second drain. The result is a gateway that degrades predictably under load and reports errors with a consistent shape.

## Acceptance Criteria (EARS)

1. **AC-1**: WHEN a single IP exceeds 10 requests per minute to POST /orchestrate or POST /compose, the system SHALL respond with HTTP 429 and `{ error: "Too Many Requests", code: "RATE_LIMIT_EXCEEDED", retryAfterMs: <number> }`.
2. **AC-2**: WHEN a rate-limited response is returned, the system SHALL include a `Retry-After` header with seconds until the window resets.
3. **AC-3**: WHEN any route returns an error (4xx or 5xx), the system SHALL respond with `{ error: <string>, code: <string>, details?: <object>, requestId: <string> }`.
4. **AC-4**: WHEN a Fastify schema validation error occurs, the system SHALL respond with HTTP 400 and `code: "VALIDATION_ERROR"` including the validation details.
5. **AC-5**: WHILE the Anthropic SDK call failure count reaches 5 consecutive failures within a 60-second window, the system SHALL open the circuit and reject subsequent LLM calls immediately with `code: "CIRCUIT_OPEN"` for a 30-second cooldown period.
6. **AC-6**: WHILE a registry HTTP call failure count reaches 5 consecutive failures within a 60-second window, the system SHALL open the circuit for that specific registry and reject calls to it with `code: "CIRCUIT_OPEN"` for a 30-second cooldown period.
7. **AC-7**: WHILE the number of in-flight /orchestrate requests exceeds a configurable queue depth limit (default: 20), the system SHALL reject new requests with HTTP 503 and `code: "BACKPRESSURE"`.
8. **AC-8**: WHEN a POST /orchestrate request exceeds 120 seconds of total processing, the system SHALL abort and respond with HTTP 504 and `code: "TIMEOUT"`.
9. **AC-9**: WHEN a POST /compose request exceeds 60 seconds of total processing, the system SHALL abort and respond with HTTP 504 and `code: "TIMEOUT"`.
10. **AC-10**: WHEN any request arrives, the system SHALL generate a `requestId` (UUID v4), attach it to the Fastify request, include it in the response header `x-request-id`, and include it in all log lines for that request.
11. **AC-11**: WHEN a POST /orchestrate request is processed, the system SHALL include the `orchestrationId` in all structured log entries for that request.
12. **AC-12**: WHEN the process receives SIGTERM or SIGINT, the system SHALL stop accepting new connections, drain in-flight requests with a 30-second grace period, and then exit with code 0.

## Files to Modify/Create

| # | Archivo | Accion | Que hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `src/lib/circuit-breaker.ts` | Crear | CircuitBreaker class + CircuitOpenError (see design below) | `src/services/orchestrate.ts` (lazy singleton pattern) |
| 2 | `src/middleware/request-id.ts` | Crear | `onSend` hook for `x-request-id` header + exported `genReqId` function | `src/middleware/a2a-key.ts` (Fastify augmentation pattern) |
| 3 | `src/middleware/error-boundary.ts` | Crear | `setErrorHandler` wrapper normalizing all errors to `{ error, code, details?, requestId }` | `src/middleware/a2a-key.ts` (export function + Fastify types) |
| 4 | `src/middleware/rate-limit.ts` | Crear | `@fastify/rate-limit` config wrapper for /orchestrate and /compose | `src/middleware/x402.ts` (factory export) |
| 5 | `src/middleware/backpressure.ts` | Crear | In-flight counter preHandler factory + `getInFlightCount()` | `src/middleware/a2a-key.ts` (preHandler pattern) |
| 6 | `src/middleware/timeout.ts` | Crear | Timeout preHandler factory with configurable ms | `src/middleware/a2a-key.ts` (preHandler pattern) |
| 7 | `src/index.ts` | Modificar | Register genReqId, error boundary, rate-limit plugin, graceful shutdown | N/A (self) |
| 8 | `src/routes/orchestrate.ts` | Modificar | Add backpressure+timeout preHandlers, replace console.error with request.log, throw to error boundary | `src/routes/compose.ts` (same pattern) |
| 9 | `src/routes/compose.ts` | Modificar | Add timeout preHandler, replace console.error, throw to error boundary | `src/routes/orchestrate.ts` |
| 10 | `src/services/orchestrate.ts` | Modificar | Wrap `client.messages.create()` with `anthropicCircuitBreaker.execute()` | N/A (self) |
| 11 | `src/services/discovery.ts` | Modificar | Wrap `fetch()` in `queryRegistry` with per-registry circuit breaker | N/A (self) |
| 12 | `package.json` | Modificar | Add `@fastify/rate-limit` to dependencies | N/A |
| 13 | `src/lib/circuit-breaker.test.ts` | Crear | Unit tests: state machine, timing, AC-5, AC-6 | `src/services/compose.test.ts` (vi.useFakeTimers) |
| 14 | `src/middleware/error-boundary.test.ts` | Crear | Integration tests: AC-3, AC-4 | `src/middleware/a2a-key.test.ts` (Fastify inject) |
| 15 | `src/middleware/rate-limit.test.ts` | Crear | Integration tests: AC-1, AC-2 | `src/middleware/a2a-key.test.ts` (Fastify inject) |
| 16 | `src/middleware/backpressure.test.ts` | Crear | Integration tests: AC-7 | `src/middleware/a2a-key.test.ts` (Fastify inject) |
| 17 | `src/middleware/timeout.test.ts` | Crear | Integration tests: AC-8, AC-9 | `src/middleware/a2a-key.test.ts` (Fastify inject) |
| 18 | `src/middleware/request-id.test.ts` | Crear | Integration tests: AC-10 | `src/middleware/a2a-key.test.ts` (Fastify inject) |
| 19 | `src/middleware/graceful-shutdown.test.ts` | Crear | Integration test: AC-12 | `src/middleware/a2a-key.test.ts` (process signal) |

> NOTE: The SDD specified `test/hardening/` paths, but ALL existing tests in this project are colocated with source (e.g., `src/middleware/a2a-key.test.ts`, `src/services/compose.test.ts`). Tests MUST follow the existing convention: colocate test files next to their source files.

## Exemplars

### Exemplar 1: Middleware with Fastify Augmentation
**Archivo**: `src/middleware/a2a-key.ts`
**Usar para**: Files #2, #3, #5, #6
**Patron clave**:
- Import types: `import type { FastifyRequest, FastifyReply, preHandlerAsyncHookHandler } from 'fastify'`
- Augmentation: `declare module 'fastify' { interface FastifyRequest { fieldName: Type } }`
- Export factory function returning `preHandlerAsyncHookHandler` or `preHandlerAsyncHookHandler[]`
- Error responses via `reply.status(N).send({ ... })`

### Exemplar 2: Plugin Config Factory
**Archivo**: `src/middleware/x402.ts`
**Usar para**: File #4 (rate-limit config)
**Patron clave**:
- Export named function (not default export)
- `declare module 'fastify'` for request augmentation when needed
- Factory pattern: `export function registerRateLimit(fastify: FastifyInstance): Promise<void>`

### Exemplar 3: Test with Fastify Inject
**Archivo**: `src/middleware/a2a-key.test.ts`
**Usar para**: All test files (#13-#19)
**Patron clave**:
- `import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'`
- `import Fastify from 'fastify'`
- `vi.mock(...)` at top level for dependencies
- `app = Fastify()` in `beforeAll`, register test routes, `await app.ready()`
- `afterAll(() => app.close())`
- `beforeEach(() => vi.clearAllMocks())`
- Assertions via `const response = await app.inject({ method, url, headers, payload })`
- Check `response.statusCode`, `response.json()`, `response.headers[...]`

### Exemplar 4: Lazy Singleton + AbortController
**Archivo**: `src/services/orchestrate.ts` (lines 44-53, 104-106)
**Usar para**: File #1 (circuit-breaker.ts), File #10 (wrapping Anthropic call)
**Patron clave**:
- Lazy singleton: `let _instance: Type | null = null; function getInstance(): Type { if (!_instance) _instance = new Type(...); return _instance }`
- AbortController: `const controller = new AbortController(); const timeoutId = setTimeout(() => controller.abort(), MS)`
- Pass `{ signal: controller.signal }` as second arg to `client.messages.create()`
- `clearTimeout(timeoutId)` in finally block

## Contrato de Integracion -- BLOQUEANTE

This HU involves communication between middleware components and routes/services. All error shapes and status codes are specified below.

### Error Response Shape (ALL errors)

Every error response from any route MUST match this shape:

```json
{
  "error": "string — human-readable message",
  "code": "string — machine-readable code (RATE_LIMIT_EXCEEDED, VALIDATION_ERROR, CIRCUIT_OPEN, BACKPRESSURE, TIMEOUT, INTERNAL_ERROR)",
  "details": "object | undefined — extra info (e.g., validation errors)",
  "requestId": "string — UUID v4 from request.id"
}
```

### Error Codes and HTTP Status Mapping

| HTTP | code | Cuando |
|------|------|--------|
| 400 | `VALIDATION_ERROR` | Fastify schema validation fails (`error.validation` present) |
| 429 | `RATE_LIMIT_EXCEEDED` | IP exceeds 10 req/min on /orchestrate or /compose |
| 503 | `CIRCUIT_OPEN` | Anthropic or registry circuit breaker is open |
| 503 | `BACKPRESSURE` | In-flight /orchestrate count >= max (default 20) |
| 504 | `TIMEOUT` | Request exceeds timeout (120s orchestrate, 60s compose) |
| 500 | `INTERNAL_ERROR` | Any unhandled error (sanitize stack in production) |

### Response Headers

| Header | Cuando | Valor |
|--------|--------|-------|
| `x-request-id` | ALWAYS (all responses, including errors) | UUID v4 from `request.id` |
| `Retry-After` | When 429 returned | Seconds until window resets (set by `@fastify/rate-limit` automatically) |

## Constraint Directives

### OBLIGATORIO
- CD-1: Use `@fastify/rate-limit` as official Fastify plugin -- NO custom rate limiting
- CD-2: ALL error responses go through the error boundary -- NO ad-hoc `reply.send({ error: "..." })` with inconsistent shapes from routes
- CD-3: Circuit breaker is stateless between restarts (in-memory only) -- NO Redis/DB persistence
- CD-5: `x-request-id` header in ALL responses, including errors
- CD-6: ALL thresholds read from env vars with defaults (see Env Vars table below)
- CD-7: Follow existing middleware pattern: `preHandlerAsyncHookHandler` or `fastify.register()`
- CD-9: ALL tests use `app.inject()` pattern (like `src/middleware/a2a-key.test.ts`) -- NO supertest, NO real HTTP
- CD-10: Error boundary MUST handle `error.validation` from Fastify for AC-4
- CD-12: Do NOT change business logic in orchestrate/compose/discovery -- only ADD resilience wrappers
- Follow existing import pattern: `.js` extension in imports (e.g., `import { X } from './foo.js'`)
- Tests colocated with source files (e.g., `src/middleware/error-boundary.test.ts` next to `src/middleware/error-boundary.ts`)

### PROHIBIDO
- NO dependencies beyond `@fastify/rate-limit` -- circuit breaker, backpressure, timeout are custom
- NO modifying adapter interfaces (`src/adapters/types.ts`)
- NO modifying files outside the table above
- NO hardcoding thresholds (rate limit, circuit breaker, backpressure, timeouts)
- NO creating patterns different from existing ones
- NO `any` type
- NO modifying x402 middleware logic
- NO changing the existing business logic in orchestrate/compose/discovery services

## Env Vars (new)

| Variable | Default | Used in | AC |
|----------|---------|---------|-----|
| `RATE_LIMIT_MAX` | `10` | rate-limit.ts | AC-1 |
| `RATE_LIMIT_WINDOW_MS` | `60000` | rate-limit.ts | AC-1 |
| `CB_ANTHROPIC_FAILURES` | `5` | circuit-breaker instances | AC-5 |
| `CB_ANTHROPIC_WINDOW_MS` | `60000` | circuit-breaker instances | AC-5 |
| `CB_ANTHROPIC_COOLDOWN_MS` | `30000` | circuit-breaker instances | AC-5 |
| `CB_REGISTRY_FAILURES` | `5` | circuit-breaker instances | AC-6 |
| `CB_REGISTRY_WINDOW_MS` | `60000` | circuit-breaker instances | AC-6 |
| `CB_REGISTRY_COOLDOWN_MS` | `30000` | circuit-breaker instances | AC-6 |
| `BACKPRESSURE_MAX` | `20` | backpressure.ts | AC-7 |
| `TIMEOUT_ORCHESTRATE_MS` | `120000` | timeout preHandler | AC-8 |
| `TIMEOUT_COMPOSE_MS` | `60000` | timeout preHandler | AC-9 |
| `SHUTDOWN_GRACE_MS` | `30000` | index.ts | AC-12 |

## Circuit Breaker Class Design

This is the core design for `src/lib/circuit-breaker.ts`. Dev implements this as specified.

### State Machine

```
CLOSED  --[failures >= threshold within window]--> OPEN
OPEN    --[cooldown expired]--> HALF_OPEN
HALF_OPEN --[fn succeeds]--> CLOSED
HALF_OPEN --[fn fails]--> OPEN
```

### Interface

```typescript
interface CircuitBreakerConfig {
  name: string                  // for logging ("anthropic", "registry:wasiai")
  failureThreshold: number      // default 5
  windowMs: number              // default 60000
  cooldownMs: number            // default 30000
}

class CircuitBreaker {
  // State: 'closed' | 'open' | 'half_open'
  // Internal: failures count, lastFailureTime, windowStart

  constructor(config: CircuitBreakerConfig)

  async execute<T>(fn: () => Promise<T>): Promise<T>
  // - OPEN + cooldown not expired: throw CircuitOpenError
  // - OPEN + cooldown expired: transition to HALF_OPEN, try fn
  // - HALF_OPEN + fn succeeds: transition to CLOSED, reset
  // - HALF_OPEN + fn fails: transition to OPEN, reset cooldown
  // - CLOSED + fn fails: increment failures; if >= threshold within window -> OPEN
  // - CLOSED + fn succeeds: noop (reset if window expired)

  getState(): { state: string; failures: number; lastFailureTime: number }
  reset(): void  // for testing
}

class CircuitOpenError extends Error {
  code = 'CIRCUIT_OPEN'
  statusCode = 503
  constructor(name: string) {
    super(`Circuit breaker "${name}" is open`)
  }
}
```

### Singleton Instances

```typescript
// Anthropic circuit breaker -- single instance
export const anthropicCircuitBreaker = new CircuitBreaker({
  name: 'anthropic',
  failureThreshold: parseInt(process.env.CB_ANTHROPIC_FAILURES ?? '5'),
  windowMs: parseInt(process.env.CB_ANTHROPIC_WINDOW_MS ?? '60000'),
  cooldownMs: parseInt(process.env.CB_ANTHROPIC_COOLDOWN_MS ?? '30000'),
})

// Per-registry circuit breakers -- Map keyed by registry name
const registryBreakers = new Map<string, CircuitBreaker>()

export function getRegistryCircuitBreaker(registryName: string): CircuitBreaker {
  let cb = registryBreakers.get(registryName)
  if (!cb) {
    cb = new CircuitBreaker({
      name: `registry:${registryName}`,
      failureThreshold: parseInt(process.env.CB_REGISTRY_FAILURES ?? '5'),
      windowMs: parseInt(process.env.CB_REGISTRY_WINDOW_MS ?? '60000'),
      cooldownMs: parseInt(process.env.CB_REGISTRY_COOLDOWN_MS ?? '30000'),
    })
    registryBreakers.set(registryName, cb)
  }
  return cb
}
```

## Error Boundary Design

For `src/middleware/error-boundary.ts`:

```typescript
export function registerErrorBoundary(fastify: FastifyInstance): void {
  fastify.setErrorHandler((error, request, reply) => {
    const requestId = request.id  // set by genReqId

    // 1. Fastify schema validation error
    if (error.validation) {
      return reply.status(400).send({
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: error.validation,
        requestId,
      })
    }

    // 2. Custom errors with code (CircuitOpenError, etc.)
    if ('code' in error && typeof (error as any).code === 'string') {
      const statusCode = (error as any).statusCode ?? 500
      return reply.status(statusCode).send({
        error: error.message,
        code: (error as any).code,
        requestId,
      })
    }

    // 3. Rate limit (fallback -- plugin usually handles directly)
    if (error.statusCode === 429) {
      return reply.status(429).send({
        error: 'Too Many Requests',
        code: 'RATE_LIMIT_EXCEEDED',
        requestId,
      })
    }

    // 4. Default: internal error
    const isDev = process.env.NODE_ENV === 'development'
    return reply.status(error.statusCode ?? 500).send({
      error: isDev ? error.message : 'Internal server error',
      code: 'INTERNAL_ERROR',
      details: isDev ? { stack: error.stack } : undefined,
      requestId,
    })
  })
}
```

## Request ID Design (DT-6)

Instead of a separate plugin, use Fastify's built-in `genReqId`:

In `src/middleware/request-id.ts`:
```typescript
import crypto from 'node:crypto'
import type { FastifyInstance } from 'fastify'

// Export genReqId function for use in Fastify constructor options
export const genReqId = () => crypto.randomUUID()

// Register onSend hook to add x-request-id header to ALL responses
export function registerRequestIdHook(fastify: FastifyInstance): void {
  fastify.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id)
  })
}
```

In `src/index.ts`, change:
```typescript
// BEFORE:
const fastify = Fastify({ logger: true })
// AFTER:
import { genReqId, registerRequestIdHook } from './middleware/request-id.js'
const fastify = Fastify({ logger: true, genReqId })
registerRequestIdHook(fastify)
```

This makes `request.id` a UUID v4 everywhere, and pino child logger automatically includes it.

## Backpressure Design

For `src/middleware/backpressure.ts`:

```typescript
import type { preHandlerAsyncHookHandler } from 'fastify'

let inFlight = 0

export function createBackpressureHandler(opts?: { max?: number }): preHandlerAsyncHookHandler {
  const maxInFlight = opts?.max ?? parseInt(process.env.BACKPRESSURE_MAX ?? '20')

  return async (request, reply) => {
    if (inFlight >= maxInFlight) {
      return reply.status(503).send({
        error: 'Service overloaded',
        code: 'BACKPRESSURE',
        requestId: request.id,
      })
    }
    inFlight++
    // Decrement on response (always, even on error)
    request.server.addHook('onResponse', async () => { inFlight-- })
    // NOTE: Consider using reply.then() or onResponse scoped to this request
    // to avoid registering a new global hook per request. Alternative: use
    // request.raw.on('close', ...) or track per-request via WeakSet.
    // The exact mechanism is up to Dev as long as counter never leaks.
  }
}

export function getInFlightCount(): number {
  return inFlight
}

// For testing: reset counter
export function resetInFlightCount(): void {
  inFlight = 0
}
```

IMPORTANT: The decrement mechanism above is illustrative. The challenge is ensuring `inFlight--` runs exactly once per request that passed the gate, even if the handler throws. Dev must ensure no counter leak. Recommended approach: register the decrement in `onResponse` scoped to the specific request, or use `reply.raw.on('close', ...)`.

## Timeout Design

For `src/middleware/timeout.ts`:

```typescript
import type { preHandlerAsyncHookHandler } from 'fastify'

export function createTimeoutHandler(timeoutMs: number): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    const timer = setTimeout(() => {
      if (!reply.sent) {
        reply.status(504).send({
          error: 'Request timeout',
          code: 'TIMEOUT',
          requestId: request.id,
        })
      }
    }, timeoutMs)

    // Clean up timer when response is sent
    reply.raw.on('close', () => clearTimeout(timer))
  }
}
```

## Graceful Shutdown Design

Add to `src/index.ts` after `fastify.listen()`:

```typescript
async function gracefulShutdown(signal: string) {
  fastify.log.info({ signal }, 'Received signal, starting graceful shutdown')
  const graceMs = parseInt(process.env.SHUTDOWN_GRACE_MS ?? '30000')
  const forceTimer = setTimeout(() => {
    fastify.log.error('Graceful shutdown timed out, forcing exit')
    process.exit(1)
  }, graceMs)
  // Prevent timer from keeping the event loop alive
  forceTimer.unref()
  try {
    await fastify.close()  // stops accepting, drains in-flight
    process.exit(0)
  } catch (err) {
    fastify.log.error({ err }, 'Error during graceful shutdown')
    process.exit(1)
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))
```

## Modifications to Existing Files

### src/index.ts (File #7)

Changes required:
1. Import `genReqId` and `registerRequestIdHook` from `./middleware/request-id.js`
2. Import `registerErrorBoundary` from `./middleware/error-boundary.js`
3. Import `registerRateLimit` from `./middleware/rate-limit.js`
4. Change `Fastify({ logger: true })` to `Fastify({ logger: true, genReqId })`
5. After CORS registration, BEFORE routes:
   - `registerRequestIdHook(fastify)`
   - `registerErrorBoundary(fastify)`
   - `await registerRateLimit(fastify)`
6. After `fastify.listen()`: add graceful shutdown handlers (see design above)

Order matters: request-id BEFORE error boundary BEFORE rate limit BEFORE routes.

### src/routes/orchestrate.ts (File #8)

Changes required:
1. Import `createBackpressureHandler` from `../middleware/backpressure.js`
2. Import `createTimeoutHandler` from `../middleware/timeout.js`
3. Add to `preHandler` array: `createBackpressureHandler()` and `createTimeoutHandler(parseInt(process.env.TIMEOUT_ORCHESTRATE_MS ?? '120000'))`
4. Replace `console.error('[Orchestrate] Error:', message)` with `request.log.error({ orchestrationId, err: message }, 'Orchestration failed')`
5. Remove the try/catch block. Instead, let errors propagate to the error boundary. The `orchestrationId` should be set early and included in the thrown error or handled by the boundary.

IMPORTANT: The orchestrationId must still appear in the response. Two approaches:
- (a) Throw a custom error that includes orchestrationId, and let error boundary pass it through.
- (b) Keep a minimal catch that adds orchestrationId to the thrown error before re-throwing.

Dev decides, but orchestrationId MUST be in error responses for /orchestrate.

### src/routes/compose.ts (File #9)

Changes required:
1. Import `createTimeoutHandler` from `../middleware/timeout.js`
2. Add to `preHandler` array: `createTimeoutHandler(parseInt(process.env.TIMEOUT_COMPOSE_MS ?? '60000'))`
3. Replace ad-hoc error handling: remove the outer try/catch, let errors flow to error boundary
4. Keep business-logic validation (empty steps, >5 steps) but throw structured errors instead of `reply.send`

### src/services/orchestrate.ts (File #10)

Changes required:
1. Import `anthropicCircuitBreaker` from `../lib/circuit-breaker.js`
2. In `llmPlan()` function, wrap the `client.messages.create()` call:
   ```typescript
   // BEFORE (lines 108-116):
   const response = await client.messages.create({ ... }, { signal: controller.signal })
   // AFTER:
   const response = await anthropicCircuitBreaker.execute(() =>
     client.messages.create({ ... }, { signal: controller.signal })
   )
   ```
3. The existing `catch` block already returns `null` on failure. `CircuitOpenError` should propagate UP (not be caught here) so the route's error boundary can return 503. Adjust the catch:
   ```typescript
   } catch (err) {
     // Let CircuitOpenError propagate to error boundary
     if (err instanceof CircuitOpenError) throw err
     console.error('[Orchestrate] LLM planning failed:', ...)
     return null
   }
   ```
4. Import `CircuitOpenError` from `../lib/circuit-breaker.js`

### src/services/discovery.ts (File #11)

Changes required:
1. Import `getRegistryCircuitBreaker` from `../lib/circuit-breaker.js`
2. In `queryRegistry()` method, wrap the `fetch()` call (line 84):
   ```typescript
   // BEFORE:
   const response = await fetch(url.toString(), { headers })
   // AFTER:
   const cb = getRegistryCircuitBreaker(registry.name)
   const response = await cb.execute(() => fetch(url.toString(), { headers }))
   ```
3. The existing `.catch()` in `discover()` (line 24) will catch `CircuitOpenError` from a specific registry and log it, which is correct behavior (other registries continue). No change needed there.

## Test Expectations

| Test | ACs | Framework | Tipo |
|------|-----|-----------|------|
| `src/lib/circuit-breaker.test.ts` | AC-5, AC-6 | vitest | Unit (state machine, fake timers) |
| `src/middleware/error-boundary.test.ts` | AC-3, AC-4 | vitest | Integration (Fastify inject) |
| `src/middleware/rate-limit.test.ts` | AC-1, AC-2 | vitest | Integration (Fastify inject, 11+ requests) |
| `src/middleware/backpressure.test.ts` | AC-7 | vitest | Integration (Fastify inject, concurrent) |
| `src/middleware/timeout.test.ts` | AC-8, AC-9 | vitest | Integration (Fastify inject, slow handler) |
| `src/middleware/request-id.test.ts` | AC-10 | vitest | Integration (Fastify inject, header check) |
| `src/middleware/graceful-shutdown.test.ts` | AC-12 | vitest | Integration (signal simulation) |

### Test Guidance per File

**circuit-breaker.test.ts**: Use `vi.useFakeTimers()` to control time. Test: closed->open after N failures, open rejects immediately, open->half_open after cooldown, half_open->closed on success, half_open->open on failure, window reset, per-registry isolation.

**error-boundary.test.ts**: Create Fastify app, register error boundary, add routes that throw different errors (validation, custom code, generic). Verify response shape matches contract for each case.

**rate-limit.test.ts**: Create Fastify app, register rate-limit plugin, add a test POST route. Fire 11 requests in loop. Verify requests 1-10 return 200, request 11 returns 429 with correct body shape and `Retry-After` header.

**backpressure.test.ts**: Create Fastify app with backpressure handler (max=2 for testing). Start 2 slow requests, fire 3rd request, verify 3rd gets 503 BACKPRESSURE. Verify counter decrements after slow requests complete.

**timeout.test.ts**: Create Fastify app with timeout handler (100ms for testing). Add route that sleeps 500ms. Verify 504 TIMEOUT response. Test that fast routes complete normally.

**request-id.test.ts**: Create Fastify app with genReqId and onSend hook. Fire request, verify `x-request-id` header is UUID v4 format. Verify requestId appears in response body (via error boundary test route that throws).

**graceful-shutdown.test.ts**: Test the `gracefulShutdown` function by mocking `fastify.close()`. Verify it calls close, verify exit behavior. Note: testing actual process signals in vitest is tricky -- focus on the shutdown function logic.

### Criterio Test-First

| Tipo de cambio | Test-first? |
|----------------|-------------|
| Circuit breaker state machine | Si |
| Error boundary logic | Si |
| Rate limit config | Si |
| Backpressure counter | Si |
| Timeout behavior | Si |
| Request ID hook | No (config) |
| Graceful shutdown | No (infrastructure) |
| Service modifications (CB wrapping) | No (thin wrapper) |

## Waves

### Wave -1: Environment Gate (OBLIGATORIO)

```bash
# Verify dependencies installed
cd /home/ferdev/.openclaw/workspace/wasiai-a2a && npm install

# Verify base files exist
ls src/index.ts src/routes/orchestrate.ts src/routes/compose.ts src/services/orchestrate.ts src/services/discovery.ts src/middleware/a2a-key.ts src/middleware/x402.ts

# Verify no middleware files already exist for hardening
ls src/middleware/error-boundary.ts src/middleware/rate-limit.ts src/middleware/backpressure.ts src/middleware/timeout.ts src/middleware/request-id.ts src/lib/circuit-breaker.ts 2>&1 | grep "No such file"

# Verify tsc clean
npx tsc --noEmit

# Verify existing tests pass (192 expected)
npx vitest run

# Verify @fastify/rate-limit is NOT yet installed
node -e "try{require('@fastify/rate-limit');console.log('ALREADY INSTALLED')}catch{console.log('NOT INSTALLED - OK')}"
```

**Si algo falla en Wave -1:** PARAR y reportar al orquestador antes de continuar.

### Wave 0 (Serial Gate -- types and contracts)

- [ ] W0.1: `package.json` -- add `@fastify/rate-limit` to dependencies, run `npm install`
- [ ] W0.2: `src/lib/circuit-breaker.ts` -- CircuitBreaker class, CircuitOpenError, anthropicCircuitBreaker singleton, getRegistryCircuitBreaker factory (see design above)
- [ ] W0.3: `src/lib/circuit-breaker.test.ts` -- unit tests for state machine (closed/open/half_open transitions, timing, reset, per-target isolation)

**Verificacion W0:**
```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a && npx tsc --noEmit && npx vitest run src/lib/circuit-breaker.test.ts
```

### Wave 1 (Parallelizable -- foundational middleware)

- [ ] W1.1: `src/middleware/request-id.ts` -- `genReqId` function + `registerRequestIdHook`
- [ ] W1.2: `src/middleware/error-boundary.ts` -- `registerErrorBoundary` with full error shape normalization
- [ ] W1.3: `src/middleware/rate-limit.ts` -- `registerRateLimit` wrapping `@fastify/rate-limit` with per-route config
- [ ] W1.4: `src/middleware/backpressure.ts` -- `createBackpressureHandler` + `getInFlightCount` + `resetInFlightCount`
- [ ] W1.5: `src/middleware/timeout.ts` -- `createTimeoutHandler(timeoutMs)`
- [ ] W1.6: `src/middleware/request-id.test.ts` -- AC-10
- [ ] W1.7: `src/middleware/error-boundary.test.ts` -- AC-3, AC-4
- [ ] W1.8: `src/middleware/rate-limit.test.ts` -- AC-1, AC-2
- [ ] W1.9: `src/middleware/backpressure.test.ts` -- AC-7

**Verificacion W1:**
```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a && npx tsc --noEmit && npx vitest run src/middleware/request-id.test.ts src/middleware/error-boundary.test.ts src/middleware/rate-limit.test.ts src/middleware/backpressure.test.ts
```

### Wave 2 (Depends on W0+W1 -- integration)

- [ ] W2.1: `src/index.ts` -- register genReqId in Fastify constructor, registerRequestIdHook, registerErrorBoundary, registerRateLimit (BEFORE routes), graceful shutdown handlers (AFTER listen)
- [ ] W2.2: `src/routes/orchestrate.ts` -- add backpressure+timeout preHandlers, replace console.error with request.log, remove ad-hoc try/catch (throw to error boundary), keep orchestrationId in error
- [ ] W2.3: `src/routes/compose.ts` -- add timeout preHandler, replace console.error, throw to error boundary
- [ ] W2.4: `src/services/orchestrate.ts` -- wrap `client.messages.create()` with `anthropicCircuitBreaker.execute()`, let CircuitOpenError propagate
- [ ] W2.5: `src/services/discovery.ts` -- wrap `fetch()` in `queryRegistry` with `getRegistryCircuitBreaker(registry.name).execute()`
- [ ] W2.6: `src/middleware/timeout.test.ts` -- AC-8, AC-9
- [ ] W2.7: `src/middleware/graceful-shutdown.test.ts` -- AC-12

**Verificacion W2:**
```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a && npx tsc --noEmit && npx vitest run
```

### Wave 3 (Final -- AC-11 and full verification)

- [ ] W3.1: Verify AC-11 in orchestrate route -- `request.log.info/error({ orchestrationId, ... })` uses structured logging. Adjust if needed.
- [ ] W3.2: Full test suite: `npx vitest run` -- ALL existing 192 tests + new tests pass, 0 regressions
- [ ] W3.3: Verify all 12 env vars have defaults and are documented

**Verificacion W3:**
```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a && npx tsc --noEmit && npx vitest run
```

### Verificacion Incremental

| Wave | Verificacion al completar |
|------|--------------------------|
| W-1 | env ready, tsc clean, 192 tests pass |
| W0 | tsc clean + circuit-breaker tests pass |
| W1 | tsc clean + all new middleware tests pass |
| W2 | tsc clean + ALL tests pass (existing + new) |
| W3 | tsc clean + ALL tests pass + AC-11 confirmed |

## Out of Scope

- Authentication/authorization changes (WKH-34)
- Per-user/per-key rate limiting (future)
- Redis-backed rate limiting
- DDoS protection / WAF
- Changes to x402 middleware logic
- Changes to adapter interfaces (`src/adapters/types.ts`)
- Logging library changes (pino comes with Fastify)
- ANY file not listed in the Files table above
- NO "improving" adjacent code
- NO adding functionality not listed

## Escalation Rule

> **Si algo no esta en este Story File, Dev PARA y pregunta a Architect.**
> No inventar. No asumir. No improvisar.

Situaciones de escalation:
- An exemplar file no longer exists or has different structure
- An import needed is not available
- The backpressure decrement mechanism causes test issues
- There is ambiguity in an AC
- The change requires touching files outside the table
- `@fastify/rate-limit` API differs from expected (check docs at https://github.com/fastify/fastify-rate-limit)
- Fastify's `genReqId` does not propagate to pino child logger as expected

---

*Story File generado por NexusAgil -- F2.5*
