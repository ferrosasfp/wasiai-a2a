# Work Item — [WKH-E2E] E2E Test Suite

## Resumen

Create a comprehensive E2E test suite that spins up a real Fastify server instance with all middleware registered and tests the full request/response cycle. Unlike the existing 229 unit tests (which mock services), these tests exercise the real middleware chain (request-id, error boundary, rate limiting) plus the actual route handlers, mocking only external dependencies (Supabase, Anthropic SDK, Kite RPC).

## Sizing

- SDD_MODE: full
- Estimation: M (1-2 test files, zero prod changes, but non-trivial mock setup for adapter registry + Supabase + identity service)
- Branch suggested: feat/029-e2e-tests
- Skills: testing-e2e, fastify

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

## Scope IN

- `src/__tests__/e2e/` directory (new) -- all E2E test files
- `src/__tests__/e2e/setup.ts` -- shared app builder + mock wiring
- `src/__tests__/e2e/e2e.test.ts` -- main E2E test file covering AC-1 through AC-20

## Scope OUT

- Production code changes (zero modifications to `src/` outside of `__tests__/`)
- Unit test modifications
- New dependencies
- CI/CD pipeline changes
- Performance/load testing

## Technical Decisions (DT-N)

- DT-1: **App construction in test setup** -- Since `src/index.ts` uses top-level `await initAdapters()` and `await fastify.listen()`, it cannot be imported directly by tests. The E2E test setup SHALL replicate the app construction (Fastify instantiation + middleware registration + route registration) in a `buildTestApp()` helper. This is the only viable approach given the CD-1 constraint of zero production code changes. Future HU may extract a `buildApp()` factory from `index.ts`.
- DT-2: **Fastify inject()** -- Use `fastify.inject()` for all requests. No actual HTTP server or network port needed. This is faster, deterministic, and avoids port conflicts.
- DT-3: **Mock strategy** -- Mock ONLY external dependencies at the module level via `vi.mock()`: (a) `@supabase/supabase-js` -- all DB calls, (b) `@anthropic-ai/sdk` -- LLM calls, (c) `src/adapters/kite-ozone/` -- blockchain RPC, (d) `src/adapters/registry.js` -- `initAdapters()` returns mock adapters. Internal middleware (request-id, error-boundary, rate-limit) runs REAL.
- DT-4: **Rate-limit testing** -- Set `RATE_LIMIT_MAX=10` and `RATE_LIMIT_WINDOW_MS=60000` via env before app construction, then fire 11 requests to verify the 429.
- DT-5: **Identity service mock** -- Mock `identityService` to return controlled data for signup/me/deposit flows. The hash-based lookup in auth routes needs the mock to respond to the SHA-256 hash of the test key.

## Constraint Directives (CD-N)

- CD-1: PROHIBIDO modify any file under `src/` that is not inside `src/__tests__/`.
- CD-2: PROHIBIDO add new npm dependencies -- use only vitest + fastify inject (already available).
- CD-3: OBLIGATORIO every E2E test SHALL exercise the real middleware chain (request-id, error-boundary, rate-limit).
- CD-4: OBLIGATORIO mock external services (Supabase, Anthropic, Kite RPC) -- never call real external APIs in tests.
- CD-5: PROHIBIDO mock internal middleware -- request-id, error-boundary, rate-limit, a2a-key middleware SHALL run as real code.

## Missing Inputs

- [resuelto en F2] Exact mock shape for `createKiteOzoneAdapters()` return value -- Architect will derive from `src/adapters/types.ts` and existing test mocks in `src/adapters/__tests__/`.
- [resuelto en F2] Whether `identityService.createKey` returns the raw key or a masked version -- Architect will verify from `src/services/identity.ts`.
- [resuelto en F2] Dashboard routes may read from Supabase for stats -- need to confirm mock shape for `GET /dashboard/api/stats`.

## Dependency Analysis

- This HU does NOT block any other HU.
- This HU does NOT depend on any in-progress HU (025, 026, 028) -- it tests the current main branch state.
- Can run in parallel with WKH-28 (README rewrite) and WKH-25 (a2a-key middleware, already merged to main equivalent).
