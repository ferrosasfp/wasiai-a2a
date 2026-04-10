# Work Item — [WKH-18] Hardening: Rate Limiting, Error Boundaries, Circuit Breaker, Backpressure

## Resumen

Hardening transversal del gateway WasiAI A2A para produccion. Agrega rate limiting global, error responses estandarizados, circuit breaker en calls externos (Anthropic SDK, registry HTTP), backpressure en /orchestrate, request ID en logs y headers, timeouts explicitos y graceful shutdown. Dirigido a operadores del gateway y consumidores de la API para garantizar estabilidad bajo carga y observabilidad en produccion.

## Sizing

- SDD_MODE: full
- Estimacion: L (toca middleware global, afecta todas las rutas, 5 subsistemas independientes)
- Branch sugerido: feat/026-hardening
- Skills: [resilience-patterns, fastify-middleware]

## Acceptance Criteria (EARS)

### Rate Limiting
- AC-1: WHEN a single IP exceeds 10 requests per minute to POST /orchestrate or POST /compose, the system SHALL respond with HTTP 429 and a JSON body `{ error: "Too Many Requests", code: "RATE_LIMIT_EXCEEDED", retryAfterMs: <number> }`.
- AC-2: WHEN a rate-limited response is returned, the system SHALL include a `Retry-After` header with seconds until the window resets.

### Structured Error Responses
- AC-3: WHEN any route returns an error (4xx or 5xx), the system SHALL respond with the shape `{ error: <string>, code: <string>, details?: <object>, requestId: <string> }`.
- AC-4: WHEN a Fastify schema validation error occurs, the system SHALL respond with HTTP 400 and `code: "VALIDATION_ERROR"` including the validation details.

### Circuit Breaker
- AC-5: WHILE the Anthropic SDK call failure count reaches 5 consecutive failures within a 60-second window, the system SHALL open the circuit and reject subsequent LLM calls immediately with `code: "CIRCUIT_OPEN"` for a 30-second cooldown period.
- AC-6: WHILE a registry HTTP call failure count reaches 5 consecutive failures within a 60-second window, the system SHALL open the circuit for that specific registry and reject calls to it with `code: "CIRCUIT_OPEN"` for a 30-second cooldown period.

### Backpressure
- AC-7: WHILE the number of in-flight /orchestrate requests exceeds a configurable queue depth limit (default: 20), the system SHALL reject new requests with HTTP 503 and `code: "BACKPRESSURE"`.

### Timeouts
- AC-8: WHEN a POST /orchestrate request exceeds 120 seconds of total processing, the system SHALL abort and respond with HTTP 504 and `code: "TIMEOUT"`.
- AC-9: WHEN a POST /compose request exceeds 60 seconds of total processing, the system SHALL abort and respond with HTTP 504 and `code: "TIMEOUT"`.

### Request ID and Logging
- AC-10: WHEN any request arrives, the system SHALL generate a `requestId` (UUID v4), attach it to the Fastify request, include it in the response header `x-request-id`, and include it in all log lines for that request.
- AC-11: WHEN a POST /orchestrate request is processed, the system SHALL include the `orchestrationId` in all structured log entries for that request.

### Graceful Shutdown
- AC-12: WHEN the process receives SIGTERM or SIGINT, the system SHALL stop accepting new connections, drain in-flight requests with a 30-second grace period, and then exit with code 0.

## Scope IN

- `src/index.ts` — register rate-limit plugin, error handler, graceful shutdown, request-id hook
- `src/middleware/rate-limit.ts` — NEW: @fastify/rate-limit config
- `src/middleware/error-boundary.ts` — NEW: global setErrorHandler with structured shape
- `src/middleware/backpressure.ts` — NEW: in-flight counter for /orchestrate
- `src/lib/circuit-breaker.ts` — NEW: generic circuit breaker utility (stateful, per-target)
- `src/services/orchestrate.ts` — wrap Anthropic call with circuit breaker, apply 120s timeout
- `src/services/compose.ts` — apply 60s timeout
- `src/services/discovery.ts` — wrap registry HTTP calls with per-registry circuit breaker
- `src/routes/orchestrate.ts` — attach backpressure preHandler, pass requestId to logs
- `src/routes/compose.ts` — pass requestId to logs
- `package.json` — add `@fastify/rate-limit` dependency
- `test/` — tests for rate limiting, error shape, circuit breaker, backpressure, timeouts

## Scope OUT

- Authentication / authorization changes (WKH-34 scope)
- Per-user/per-key rate limiting (future, depends on WKH-34 a2a_agent_keys)
- Redis-backed rate limiting (in-memory is sufficient for single-instance; Redis upgrade is post-hackathon)
- DDoS protection / WAF (infra-level, not application)
- Changes to x402 middleware logic
- Changes to adapter interfaces or chain-adaptive layer

## Decisiones tecnicas (DT-N)

- DT-1: Use `@fastify/rate-limit` (official Fastify plugin) with in-memory store. Justification: avoids reinventing rate limiting, already proven in Fastify ecosystem, and in-memory is appropriate for single-instance deployment. Redis store can be swapped later with zero code change.
- DT-2: Circuit breaker is a custom lightweight class (not a library like opossum). Justification: our needs are simple (consecutive failure count, cooldown timer, per-target state). A 50-line utility avoids a new dependency and stays transparent.
- DT-3: Backpressure uses an atomic in-flight counter (not BullMQ queue). Justification: /orchestrate is sync request-response today; a counter preHandler is minimal overhead and does not require queue infrastructure changes.
- DT-4: Error boundary via `fastify.setErrorHandler()` — single global handler that normalizes all errors into `{ error, code, details, requestId }`. Route-level catch blocks remain for business logic but throw structured errors upward.
- DT-5: Timeout implementation uses `AbortController` with `setTimeout` for Anthropic SDK calls (SDK supports abort signal natively) and `Promise.race` with a timeout promise for compose pipeline and registry HTTP calls.

## Constraint Directives (CD-N)

- CD-1: OBLIGATORIO que `@fastify/rate-limit` se use como plugin oficial — PROHIBIDO rate limiting artesanal.
- CD-2: OBLIGATORIO que TODOS los error responses pasen por el error boundary — PROHIBIDO enviar `reply.send({ error: "..." })` con shapes ad-hoc desde rutas.
- CD-3: OBLIGATORIO que el circuit breaker sea stateless entre restarts (in-memory) — PROHIBIDO persistir estado de circuit en DB o Redis para esta iteracion.
- CD-4: PROHIBIDO modificar la interfaz publica de los adapters (`src/adapters/types.ts`).
- CD-5: OBLIGATORIO que requestId se propague como header `x-request-id` en TODAS las responses, incluyendo errores.
- CD-6: PROHIBIDO hardcodear thresholds — todos los valores (rate limit, circuit breaker failures, cooldown, backpressure depth, timeouts) deben leerse de env vars con defaults sensatos.

## Missing Inputs

- [resuelto en F2] Threshold exacto de circuit breaker para Anthropic (5 failures / 60s / 30s cooldown son defaults razonables, Architect decide en SDD).
- [resuelto en F2] Backpressure queue depth default (20 propuesto, Architect decide).

## Analisis de paralelismo

- Esta HU NO bloquea a otras HUs activas.
- WKH-34 (agentic economy primitives) puede ir en paralelo; rate limiting per-key se construira sobre WKH-34 despues.
- Esta HU DEBERIA ejecutarse antes del final submission (21-30 abril) ya que hardening es pre-requisito de produccion.

## Wave suggestion (para Architect)

- Wave 1: request-id hook + error boundary global + graceful shutdown (foundational, all routes benefit immediately)
- Wave 2: rate limiting plugin (@fastify/rate-limit) + backpressure middleware
- Wave 3: circuit breaker utility + integration in orchestrate (Anthropic) and discovery (registry HTTP)
- Wave 4: explicit timeouts (120s orchestrate, 60s compose) + structured logging with orchestrationId
