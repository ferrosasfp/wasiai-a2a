# SDD #026: Hardening — Rate Limiting, Error Boundaries, Circuit Breaker, Backpressure

> SPEC_APPROVED: no
> Fecha: 2026-04-06
> Tipo: improvement
> SDD_MODE: full
> Branch: feat/026-hardening
> Artefactos: doc/sdd/026-hardening/

---

## 1. Resumen

Hardening transversal del gateway WasiAI A2A para produccion. Se agregan 7 subsistemas de resiliencia: rate limiting (via `@fastify/rate-limit`), error boundary global (normaliza todos los errores a una shape estructurada), circuit breaker in-memory para calls a Anthropic SDK y registry HTTP, backpressure con in-flight counter en `/orchestrate`, request ID con propagacion en headers y logs, timeouts explicitos (120s orchestrate, 60s compose), y graceful shutdown con drain de 30s.

El resultado es un gateway que responde de forma predecible bajo carga, reporta errores con shape consistente, y se degrada de forma controlada ante fallos de dependencias externas.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 026 (WKH-18) |
| **Tipo** | improvement |
| **SDD_MODE** | full |
| **Objetivo** | Hardening transversal: rate limiting, error boundaries, circuit breaker, backpressure, timeouts, request ID, graceful shutdown |
| **Reglas de negocio** | Todos los thresholds configurables via env vars con defaults sensatos |
| **Scope IN** | 8 archivos nuevos (middleware + lib + tests), 5 archivos modificados (index, routes, services) |
| **Scope OUT** | Auth changes, per-key rate limiting, Redis store, DDoS/WAF, adapter interfaces, x402 logic |
| **Missing Inputs** | N/A — todos resueltos en work-item |

### Acceptance Criteria (EARS)

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

## 3. Context Map (Codebase Grounding)

### Archivos leidos

| Archivo | Por que | Patron extraido |
|---------|---------|-----------------|
| `src/index.ts` | Entry point: registra plugins, CORS, rutas, listen | Patron: `await fastify.register(plugin)` secuencial, Fastify({ logger: true }), sin error handler, sin graceful shutdown |
| `src/routes/orchestrate.ts` | Ruta principal afectada: POST /orchestrate | Patron: `FastifyPluginAsync`, schema body validation, preHandler array, try/catch con reply.status().send() ad-hoc |
| `src/routes/compose.ts` | Segunda ruta afectada: POST /compose | Patron: mismo que orchestrate, error shapes inconsistentes (`{ error: string }` sin code/requestId) |
| `src/services/orchestrate.ts` | Servicio LLM: usa Anthropic SDK con AbortController timeout (30s) | Patron: `getAnthropicClient()` lazy singleton, `client.messages.create()` con signal, sin circuit breaker |
| `src/services/discovery.ts` | Servicio HTTP: fetch a registries con `Promise.all` + catch | Patron: `fetch(url)` sin timeout, sin circuit breaker, errors swallowed con console.error |
| `src/services/compose.ts` | Pipeline execution: invoca agentes via fetch | Patron: fetch sin timeout explicito, error tracking via eventService |
| `src/middleware/a2a-key.ts` | Middleware existente: preHandler pattern, Fastify augmentation | Patron: `declare module 'fastify' { interface FastifyRequest { ... } }`, `preHandlerAsyncHookHandler`, send403 helper |
| `src/middleware/x402.ts` | Middleware existente: x402 payment | Patron: factory function returning `preHandlerHookHandler[]` |
| `src/middleware/a2a-key.test.ts` | Test exemplar: crea Fastify app, registra route con preHandler, usa `app.inject()` | Patron: vi.mock para dependencias, beforeAll/afterAll para app lifecycle, describe/it blocks |
| `src/services/compose.test.ts` | Test exemplar: mocks globales top-level, helper factories | Patron: `vi.mock()` top level, `makeAgent()` factories, `mockFetch` stubGlobal |
| `package.json` | Dependencias actuales | Solo `fastify`, `@fastify/cors`, `@anthropic-ai/sdk`, `@supabase/supabase-js`, `viem` — NO tiene `@fastify/rate-limit` |
| `src/types/index.ts` | Tipos centrales | Patron: interfaces exportadas, type aliases |

### Exemplars

| Para crear/modificar | Seguir patron de | Razon |
|---------------------|------------------|-------|
| `src/middleware/error-boundary.ts` | `src/middleware/a2a-key.ts` | Mismo directorio, misma convulsion de export function + Fastify types |
| `src/middleware/rate-limit.ts` | `src/middleware/x402.ts` | Plugin config exported como factory |
| `src/middleware/backpressure.ts` | `src/middleware/a2a-key.ts` | preHandler pattern con counter atomico |
| `src/middleware/request-id.ts` | `src/middleware/a2a-key.ts` | Fastify augmentation via `declare module 'fastify'` |
| `src/lib/circuit-breaker.ts` | `src/services/orchestrate.ts` (getAnthropicClient pattern) | Clase stateful in-memory, lazy init, singleton pattern |
| `test/hardening/rate-limit.test.ts` | `src/middleware/a2a-key.test.ts` | Fastify inject pattern, describe/it, vi.mock |
| `test/hardening/error-boundary.test.ts` | `src/middleware/a2a-key.test.ts` | Mismo patron Fastify inject |
| `test/hardening/circuit-breaker.test.ts` | `src/services/compose.test.ts` | Unit test puro, vi.useFakeTimers |
| `test/hardening/backpressure.test.ts` | `src/middleware/a2a-key.test.ts` | Fastify inject con concurrencia |
| `test/hardening/timeout.test.ts` | `src/middleware/a2a-key.test.ts` | Fastify inject pattern |
| `test/hardening/request-id.test.ts` | `src/middleware/a2a-key.test.ts` | Header verification |
| `test/hardening/graceful-shutdown.test.ts` | `src/middleware/a2a-key.test.ts` | Process signal testing |

### Estado de BD relevante

N/A — Este hardening no requiere cambios de BD. Todos los estados (circuit breaker, rate limiting, backpressure) son in-memory.

### Componentes reutilizables encontrados

- `eventService` en `src/services/event.ts` — reutilizar para logging estructurado de hardening events (opcional, no obligatorio)
- `crypto.randomUUID()` en `src/routes/orchestrate.ts:45` — mismo patron para requestId
- Patron `AbortController` + `setTimeout` en `src/services/orchestrate.ts:104-106` — reutilizar para timeouts

## 4. Diseno Tecnico

### 4.1 Archivos a crear/modificar

| Archivo | Accion | Descripcion | Exemplar |
|---------|--------|-------------|----------|
| `src/middleware/request-id.ts` | Crear | Fastify plugin: onRequest hook genera UUID v4, augmenta `request.requestId`, onSend hook agrega `x-request-id` header | `src/middleware/a2a-key.ts` |
| `src/middleware/error-boundary.ts` | Crear | `fastify.setErrorHandler()` wrapper: normaliza toda excepcion a `{ error, code, details, requestId }`. Maneja validation errors con `code: "VALIDATION_ERROR"` | `src/middleware/a2a-key.ts` |
| `src/middleware/rate-limit.ts` | Crear | Config para `@fastify/rate-limit` plugin: 10 req/min per IP en /orchestrate y /compose. Custom error response con `code: "RATE_LIMIT_EXCEEDED"` y `retryAfterMs` | `src/middleware/x402.ts` |
| `src/middleware/backpressure.ts` | Crear | preHandler para /orchestrate: in-flight atomic counter, rechaza con 503 `code: "BACKPRESSURE"` cuando excede limit. onResponse decrementa | `src/middleware/a2a-key.ts` |
| `src/middleware/timeout.ts` | Crear | preHandler factory: envuelve request handler con AbortController + setTimeout, responde 504 `code: "TIMEOUT"` al expirar | `src/middleware/a2a-key.ts` |
| `src/lib/circuit-breaker.ts` | Crear | Clase `CircuitBreaker` con estados closed/open/half-open. Configurable: failureThreshold, windowMs, cooldownMs. Metodo `execute<T>(fn)` que wrappea calls | `src/services/orchestrate.ts` |
| `src/index.ts` | Modificar | Registrar request-id plugin, error boundary, rate-limit plugin, graceful shutdown (SIGTERM/SIGINT handlers con `fastify.close()` + drain timeout) | N/A (self) |
| `src/routes/orchestrate.ts` | Modificar | Agregar backpressure preHandler, usar `request.requestId` en logs, remover try/catch ad-hoc (delegar a error boundary) | `src/routes/compose.ts` |
| `src/routes/compose.ts` | Modificar | Usar `request.requestId` en logs, remover try/catch ad-hoc (delegar a error boundary) | `src/routes/orchestrate.ts` |
| `src/services/orchestrate.ts` | Modificar | Wrap `client.messages.create()` con circuit breaker instance para Anthropic. Timeout total de 120s via AbortController en la capa de ruta (no duplicar aqui, pero respetar abort signal) | N/A (self) |
| `src/services/discovery.ts` | Modificar | Wrap `fetch()` en `queryRegistry` con circuit breaker per-registry instance. Propagar abort signal | N/A (self) |
| `package.json` | Modificar | Agregar `@fastify/rate-limit` a dependencies | N/A |
| `test/hardening/rate-limit.test.ts` | Crear | Tests AC-1, AC-2 | `src/middleware/a2a-key.test.ts` |
| `test/hardening/error-boundary.test.ts` | Crear | Tests AC-3, AC-4 | `src/middleware/a2a-key.test.ts` |
| `test/hardening/circuit-breaker.test.ts` | Crear | Tests AC-5, AC-6 | `src/services/compose.test.ts` |
| `test/hardening/backpressure.test.ts` | Crear | Test AC-7 | `src/middleware/a2a-key.test.ts` |
| `test/hardening/timeout.test.ts` | Crear | Tests AC-8, AC-9 | `src/middleware/a2a-key.test.ts` |
| `test/hardening/request-id.test.ts` | Crear | Tests AC-10, AC-11 | `src/middleware/a2a-key.test.ts` |
| `test/hardening/graceful-shutdown.test.ts` | Crear | Test AC-12 | `src/middleware/a2a-key.test.ts` |

### 4.2 Modelo de datos

N/A — No hay cambios de BD.

### 4.3 Componentes / Servicios

#### 4.3.1 Request ID Plugin (`src/middleware/request-id.ts`)

Fastify plugin registrado como primer hook. Augmenta `FastifyRequest` con `requestId: string`.

- **onRequest hook**: genera UUID v4 via `crypto.randomUUID()`, lo asigna a `request.requestId`
- **onSend hook**: agrega header `x-request-id` a toda response
- **Fastify augmentation**: `declare module 'fastify' { interface FastifyRequest { requestId: string } }`

Nota: Fastify ya tiene `request.id` (string counter). Usamos `requestId` (UUID) como campo separado para no colisionar con el id interno de Fastify. La augmentation agrega un campo `requestId` de tipo `string` en `FastifyRequest`.

#### 4.3.2 Error Boundary (`src/middleware/error-boundary.ts`)

Registrado via `fastify.setErrorHandler()`. Normaliza TODO error a:

```
{
  error: string,       // human-readable message
  code: string,        // machine-readable code
  details?: object,    // optional extra info (validation errors, etc.)
  requestId: string    // from request-id plugin
}
```

Logica:
1. Si `error.validation` existe (Fastify schema validation) -> 400, `code: "VALIDATION_ERROR"`, `details: error.validation`
2. Si `error.statusCode === 429` (de rate-limit plugin) -> 429, `code: "RATE_LIMIT_EXCEEDED"` (ya manejado por rate-limit config, pero este es fallback)
3. Si `error.code` ya viene como string custom (ej: `"CIRCUIT_OPEN"`, `"BACKPRESSURE"`, `"TIMEOUT"`) -> usar ese code, status del error
4. Default -> 500, `code: "INTERNAL_ERROR"`, message sanitizado (no leakear stack traces en produccion)

#### 4.3.3 Rate Limit Config (`src/middleware/rate-limit.ts`)

Exporta una funcion `registerRateLimit(fastify)` que registra `@fastify/rate-limit` con:

- **Global**: deshabilitado (no rate-limit en health, discover, etc.)
- **Per-route**: aplicado via `config: { rateLimit: { max, timeWindow } }` en las rutas /orchestrate y /compose
- **max**: `parseInt(process.env.RATE_LIMIT_MAX ?? '10')`
- **timeWindow**: `parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000')` (1 minuto)
- **keyGenerator**: `(request) => request.ip` (default de @fastify/rate-limit)
- **errorResponseBuilder**: custom function que retorna `{ error: "Too Many Requests", code: "RATE_LIMIT_EXCEEDED", retryAfterMs }` con status 429
- **addHeadersOnExceeding**: `{ 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'x-ratelimit-reset': true }`
- `Retry-After` header: el plugin lo agrega automaticamente

Alternativa de implementacion: en lugar de per-route config, se puede usar `routeConfig` en la ruta o `allowList` global. El Dev decide la mecanica exacta siempre que cumpla AC-1/AC-2 y solo aplique a /orchestrate y /compose.

#### 4.3.4 Circuit Breaker (`src/lib/circuit-breaker.ts`)

Clase `CircuitBreaker` con state machine in-memory:

```
States: CLOSED -> OPEN -> HALF_OPEN -> CLOSED (or OPEN)

Config (all from env with defaults):
- failureThreshold: number (default: 5)
- windowMs: number (default: 60000)
- cooldownMs: number (default: 30000)
- name: string (for logging)

State:
- state: 'closed' | 'open' | 'half_open'
- failures: number
- lastFailureTime: number
- windowStart: number

Methods:
- execute<T>(fn: () => Promise<T>): Promise<T>
  - If OPEN and cooldown not expired -> throw CircuitOpenError
  - If OPEN and cooldown expired -> transition to HALF_OPEN, try fn
  - If HALF_OPEN and fn succeeds -> transition to CLOSED, reset failures
  - If HALF_OPEN and fn fails -> transition to OPEN, reset cooldown
  - If CLOSED and fn fails -> increment failures, check threshold
    - If failures >= threshold within window -> transition to OPEN
  - If CLOSED and fn succeeds -> (noop unless window expired, then reset)
- getState(): { state, failures, lastFailureTime }
- reset(): void (for testing)
```

Custom error class `CircuitOpenError` with `code: "CIRCUIT_OPEN"` and `statusCode: 503`.

**Instances**:
- `anthropicCircuitBreaker` — singleton, used in `orchestrate.ts` around `client.messages.create()`
- Per-registry circuit breakers — `Map<string, CircuitBreaker>`, used in `discovery.ts` around `fetch()`. Key is `registry.name`.

Env vars:
- `CB_ANTHROPIC_FAILURES` (default 5)
- `CB_ANTHROPIC_WINDOW_MS` (default 60000)
- `CB_ANTHROPIC_COOLDOWN_MS` (default 30000)
- `CB_REGISTRY_FAILURES` (default 5)
- `CB_REGISTRY_WINDOW_MS` (default 60000)
- `CB_REGISTRY_COOLDOWN_MS` (default 30000)

#### 4.3.5 Backpressure Middleware (`src/middleware/backpressure.ts`)

Exporta factory `createBackpressureHandler(opts)` que retorna un `preHandlerAsyncHookHandler`.

- `maxInFlight`: `parseInt(process.env.BACKPRESSURE_MAX ?? '20')`
- Internal counter: module-level `let inFlight = 0`
- preHandler: `if (inFlight >= maxInFlight)` -> reply.status(503).send({ error: "Service overloaded", code: "BACKPRESSURE" })
- Si pasa: `inFlight++`
- onResponse hook (registrado en el plugin, no en la ruta): `inFlight--`
- Exportar `getInFlightCount()` para testing/observability

#### 4.3.6 Timeout Middleware (`src/middleware/timeout.ts`)

Exporta factory `createTimeoutHandler(timeoutMs: number)` que retorna un `preHandlerAsyncHookHandler`.

Implementacion: en el preHandler, setea un `setTimeout` que llama `reply.status(504).send({ error: "Request timeout", code: "TIMEOUT" })` si el response no se ha enviado. En `onResponse`, limpia el timer.

Alternativa: usar `request.socket.setTimeout()` a nivel Fastify. El Dev elige la mecanica siempre que cumpla AC-8/AC-9 y el error shape sea correcto.

Env vars:
- `TIMEOUT_ORCHESTRATE_MS` (default 120000)
- `TIMEOUT_COMPOSE_MS` (default 60000)

#### 4.3.7 Graceful Shutdown (en `src/index.ts`)

Registrar handlers para `SIGTERM` y `SIGINT`:

```
process.on('SIGTERM', gracefulShutdown)
process.on('SIGINT', gracefulShutdown)

async function gracefulShutdown(signal) {
  log('Received signal, shutting down...')
  const graceMs = parseInt(process.env.SHUTDOWN_GRACE_MS ?? '30000')
  const timer = setTimeout(() => process.exit(1), graceMs)
  try {
    await fastify.close()  // stops accepting, drains in-flight
    clearTimeout(timer)
    process.exit(0)
  } catch {
    clearTimeout(timer)
    process.exit(1)
  }
}
```

#### 4.3.8 Structured Logging Integration

No se agrega una libreria de logging nueva (pino ya viene con Fastify `logger: true`). Lo que cambia:

- Cada log en routes/services usa `request.log.info()` / `request.log.error()` en lugar de `console.error()`
- El request-id plugin asegura que `request.id` (Fastify's default child logger) ya incluye el requestId si se configura `genReqId` en Fastify options
- En `src/routes/orchestrate.ts`: reemplazar `console.error('[Orchestrate] Error:', message)` con `request.log.error({ orchestrationId, err: message }, 'Orchestration failed')`

DT-6: Usar `genReqId` de Fastify en lugar de un hook manual para request ID. `Fastify({ logger: true, genReqId: () => crypto.randomUUID() })` asigna UUID v4 a `request.id` y lo propaga automaticamente a pino child logger. Esto elimina la necesidad de un plugin separado de request-id. El header `x-request-id` se agrega via `onSend` hook.

### 4.4 Flujo principal (Happy Path)

1. Request llega al gateway
2. `genReqId` genera UUID v4, asignado a `request.id`
3. Rate-limit plugin evalua IP contra window (pasa si bajo limite)
4. Schema validation ejecuta (pasa si body valido)
5. Backpressure preHandler evalua in-flight count (pasa si bajo limite)
6. Timeout preHandler arma AbortController con timer
7. Route handler ejecuta (orchestrate/compose)
8. Circuit breaker wrappea calls a Anthropic/registry (pasa si circuito closed)
9. Response se envia exitosamente
10. `onSend` hook agrega `x-request-id` header
11. `onResponse` hook decrementa in-flight counter, limpia timeout timer

### 4.5 Flujos de error

**Rate limit exceeded:**
1. IP excede 10 req/min en /orchestrate o /compose
2. Plugin responde 429 con shape `{ error, code: "RATE_LIMIT_EXCEEDED", retryAfterMs }`
3. Header `Retry-After` incluido automaticamente

**Schema validation error:**
1. Body no cumple JSON schema
2. Fastify llama `setErrorHandler` con `error.validation`
3. Error boundary responde 400 con `{ error, code: "VALIDATION_ERROR", details: validation, requestId }`

**Circuit open:**
1. 5+ consecutive failures en Anthropic SDK o registry HTTP
2. Circuito abierto, siguiente call rechazado inmediatamente
3. `CircuitOpenError` propagado al error boundary
4. Response 503 con `{ error, code: "CIRCUIT_OPEN", requestId }`

**Backpressure:**
1. in-flight count >= 20 en /orchestrate
2. preHandler responde 503 con `{ error, code: "BACKPRESSURE", requestId }`

**Timeout:**
1. Request excede 120s (orchestrate) o 60s (compose)
2. Timeout handler responde 504 con `{ error, code: "TIMEOUT", requestId }`

**Graceful shutdown:**
1. SIGTERM/SIGINT recibido
2. Gateway deja de aceptar conexiones nuevas
3. In-flight requests se drain hasta 30s
4. Si timeout de drain: exit(1). Si drain completo: exit(0)

## 5. Constraint Directives (Anti-Alucinacion)

### OBLIGATORIO seguir

- CD-1: OBLIGATORIO que `@fastify/rate-limit` se use como plugin oficial — PROHIBIDO rate limiting artesanal.
- CD-2: OBLIGATORIO que TODOS los error responses pasen por el error boundary — PROHIBIDO enviar `reply.send({ error: "..." })` con shapes ad-hoc desde rutas.
- CD-3: OBLIGATORIO que el circuit breaker sea stateless entre restarts (in-memory) — PROHIBIDO persistir estado de circuit en DB o Redis para esta iteracion.
- CD-4: PROHIBIDO modificar la interfaz publica de los adapters (`src/adapters/types.ts`).
- CD-5: OBLIGATORIO que requestId se propague como header `x-request-id` en TODAS las responses, incluyendo errores.
- CD-6: PROHIBIDO hardcodear thresholds — todos los valores (rate limit, circuit breaker failures, cooldown, backpressure depth, timeouts) deben leerse de env vars con defaults sensatos.
- CD-7: OBLIGATORIO seguir el patron de middleware existente: `preHandlerAsyncHookHandler` o Fastify plugin con `fastify.register()`.
- CD-8: PROHIBIDO agregar dependencias nuevas mas alla de `@fastify/rate-limit` — circuit breaker es custom, backpressure es custom, timeout es custom.
- CD-9: OBLIGATORIO que los tests usen `app.inject()` pattern de Fastify (como en `src/middleware/a2a-key.test.ts`) — PROHIBIDO tests con supertest o http requests reales.
- CD-10: OBLIGATORIO que el error boundary maneje `error.validation` de Fastify para AC-4.
- CD-11: PROHIBIDO modificar archivos fuera de Scope IN.
- CD-12: PROHIBIDO cambiar la logica de negocio existente en orchestrate/compose/discovery — solo agregar wrappers de resiliencia.

### Heredados del work-item

- Todos los CD-1 a CD-6 del work-item estan incluidos arriba.

## 6. Scope

**IN:**
- Rate limiting via `@fastify/rate-limit` en /orchestrate y /compose (10/min per IP)
- Error boundary global via `setErrorHandler` con shape consistente
- Circuit breaker in-memory para Anthropic SDK y registry HTTP (5 failures / 60s / 30s cooldown)
- Backpressure counter en /orchestrate (default: 20 max in-flight)
- Timeouts: 120s orchestrate, 60s compose
- Request ID (UUID v4) en todas las requests, propagado via header y logs
- Graceful shutdown con 30s drain
- Tests para los 12 ACs

**OUT:**
- Authentication/authorization changes (WKH-34 scope)
- Per-user/per-key rate limiting (futuro)
- Redis-backed rate limiting
- DDoS/WAF
- Changes to x402 middleware logic
- Changes to adapter interfaces
- Logging library changes (pino ya viene con Fastify)

## 7. Decisiones Tecnicas

| DT | Decision | Justificacion |
|----|----------|---------------|
| DT-1 | `@fastify/rate-limit` con in-memory store | Plugin oficial Fastify, no reinventar, Redis swap futuro sin code changes |
| DT-2 | Circuit breaker custom (~60 lineas) en lugar de opossum | Necesidades simples: consecutive failures + cooldown. Evita dependencia nueva |
| DT-3 | Backpressure via in-flight counter, no BullMQ queue | /orchestrate es sync request-response hoy; counter minimal overhead |
| DT-4 | Error boundary via `fastify.setErrorHandler()` | Punto unico de normalizacion, todas las rutas se benefician |
| DT-5 | Timeouts via AbortController + setTimeout | Patron ya usado en `src/services/orchestrate.ts:104-106` para LLM calls |
| DT-6 | Request ID via `genReqId` de Fastify en vez de plugin separado | `Fastify({ genReqId })` asigna UUID a `request.id` y pino child logger automaticamente. Solo necesita un `onSend` hook para el header |
| DT-7 | Graceful shutdown en `src/index.ts` con `fastify.close()` | Fastify ya drena in-flight requests en `.close()`. Solo necesita signal handlers + force timeout |

## 8. Riesgos

| Riesgo | Probabilidad | Impacto | Mitigacion |
|--------|-------------|---------|------------|
| Rate limit plugin interfiere con x402/a2a-key preHandlers | B | M | Rate limit se registra antes que rutas; la evaluacion de rate limit ocurre antes de auth. Si IP pasa rate limit, auth sigue ejecutandose normalmente |
| Circuit breaker false positive (abre circuito por errores transitorios) | M | M | Window de 60s + threshold de 5 da margen. Half-open permite recovery automatico |
| Backpressure counter leak (incrementa pero no decrementa en edge cases) | B | A | Usar try/finally o onResponse hook que SIEMPRE decrementa. Test especifico para esto |
| Error boundary oculta errores utiles en dev | B | B | En NODE_ENV=development incluir stack trace en details |
| Timeout race condition (response ya enviada cuando timer fires) | M | B | Verificar `reply.sent` antes de enviar timeout response |

## 9. Dependencias

- `@fastify/rate-limit` debe agregarse a package.json ANTES de cualquier codigo que lo importe
- Request-id plugin debe registrarse ANTES del error boundary (para que requestId este disponible en error responses)
- Error boundary debe registrarse ANTES de las rutas
- Rate limit plugin debe registrarse ANTES de las rutas

## 10. Waves de Implementacion

### Wave 0 (Serial Gate — tipos y contratos)

- [ ] W0.1: Agregar `@fastify/rate-limit` a `package.json` dependencies
- [ ] W0.2: Crear `src/lib/circuit-breaker.ts` — clase CircuitBreaker + CircuitOpenError
- [ ] W0.3: Crear `test/hardening/circuit-breaker.test.ts` — unit tests de la state machine (closed->open->half_open->closed, timing, reset)

Verificacion: `npm install && npx tsc --noEmit && npx vitest run test/hardening/circuit-breaker`

### Wave 1 (Parallelizable — middleware foundational)

- [ ] W1.1: Crear `src/middleware/request-id.ts` — `onSend` hook para header `x-request-id` + Fastify `genReqId` setup exportado
- [ ] W1.2: Crear `src/middleware/error-boundary.ts` — `setErrorHandler` con shape normalizada
- [ ] W1.3: Crear `src/middleware/backpressure.ts` — in-flight counter preHandler factory
- [ ] W1.4: Crear `src/middleware/timeout.ts` — timeout preHandler factory
- [ ] W1.5: Crear `src/middleware/rate-limit.ts` — `@fastify/rate-limit` config wrapper
- [ ] W1.6: Crear `test/hardening/request-id.test.ts` — AC-10
- [ ] W1.7: Crear `test/hardening/error-boundary.test.ts` — AC-3, AC-4
- [ ] W1.8: Crear `test/hardening/backpressure.test.ts` — AC-7
- [ ] W1.9: Crear `test/hardening/rate-limit.test.ts` — AC-1, AC-2

Verificacion: `npx tsc --noEmit && npx vitest run test/hardening/`

### Wave 2 (Depende de W0 + W1 — integracion)

- [ ] W2.1: Modificar `src/index.ts` — registrar request-id genReqId, error boundary, rate limit plugin, graceful shutdown handlers
- [ ] W2.2: Modificar `src/routes/orchestrate.ts` — agregar backpressure + timeout preHandlers, reemplazar console.error con request.log, remover try/catch ad-hoc (throw al error boundary), propagar orchestrationId en logs
- [ ] W2.3: Modificar `src/routes/compose.ts` — agregar timeout preHandler, reemplazar console.error, remover try/catch ad-hoc
- [ ] W2.4: Modificar `src/services/orchestrate.ts` — wrap `client.messages.create()` con `anthropicCircuitBreaker.execute()`
- [ ] W2.5: Modificar `src/services/discovery.ts` — wrap `fetch()` en `queryRegistry` con per-registry circuit breaker
- [ ] W2.6: Crear `test/hardening/timeout.test.ts` — AC-8, AC-9
- [ ] W2.7: Crear `test/hardening/graceful-shutdown.test.ts` — AC-12

Verificacion: `npx tsc --noEmit && npx vitest run`

### Wave 3 (Final — AC-11 y smoke)

- [ ] W3.1: Verificar AC-11 en orchestrate route (orchestrationId en log entries) — puede requerir ajuste en W2.2
- [ ] W3.2: Run full test suite `npx vitest run` — verificar 192 tests existentes + nuevos pasan
- [ ] W3.3: Verificar que todos los env vars tienen defaults documentados

Verificacion: `npx vitest run` (ALL tests pass, 0 regressions)

## 11. Test Plan

| Test file | ACs que cubre | Wave | Tipo |
|-----------|--------------|------|------|
| `test/hardening/circuit-breaker.test.ts` | AC-5, AC-6 | W0.3 | Unit (state machine pura, fake timers) |
| `test/hardening/request-id.test.ts` | AC-10 | W1.6 | Integration (Fastify inject, verify header + request augmentation) |
| `test/hardening/error-boundary.test.ts` | AC-3, AC-4 | W1.7 | Integration (Fastify inject, throw errors, verify shape) |
| `test/hardening/backpressure.test.ts` | AC-7 | W1.8 | Integration (Fastify inject, concurrent requests, verify 503) |
| `test/hardening/rate-limit.test.ts` | AC-1, AC-2 | W1.9 | Integration (Fastify inject, 11+ requests, verify 429 + Retry-After) |
| `test/hardening/timeout.test.ts` | AC-8, AC-9 | W2.6 | Integration (Fastify inject, slow handler mock, verify 504) |
| `test/hardening/graceful-shutdown.test.ts` | AC-12 | W2.7 | Integration (process signal simulation, verify drain) |

Estimacion: ~7 archivos de test nuevos, ~35-50 test cases total.

## 12. Env Vars (nuevas)

| Variable | Default | Usado en | AC |
|----------|---------|----------|-----|
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

## 13. Uncertainty Markers

Ninguno. Todos los parametros estan definidos con defaults en el work-item.

## 14. Missing Inputs

Ninguno.

---

## READINESS CHECK

- [x] Cada AC tiene al menos 1 archivo asociado en tabla 4.1
- [x] Cada archivo en tabla 4.1 tiene un Exemplar valido (verificado con Glob)
- [x] No hay [NEEDS CLARIFICATION] pendientes
- [x] Constraint Directives incluyen al menos 3 PROHIBIDO (incluye 7)
- [x] Context Map tiene al menos 2 archivos leidos (tiene 12)
- [x] Scope IN y OUT son explicitos y no ambiguos
- [x] Si hay BD: N/A
- [x] Flujo principal (Happy Path) esta completo
- [x] Flujo de error esta definido (5 casos)

---

*SDD generado por NexusAgil — FULL*
