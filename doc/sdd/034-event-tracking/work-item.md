# Work Item -- [WKH-EVENT-TRACKING] Global Event Tracking Middleware

## Resumen

The dashboard (WKH-27) shows eventsTotal=0 for all traffic except /compose and /orchestrate because event tracking is hard-coded inside those two services only. This HU adds a Fastify onResponse hook that tracks events for all significant endpoints via the existing `eventService.track()`, so the dashboard reflects real gateway activity.

## Sizing

- SDD_MODE: mini
- Estimation: S
- Branch suggested: feat/034-event-tracking
- Flow: FAST+AR (external-api risk: Supabase writes)

## Skills

- backend-fastify
- observability

## Acceptance Criteria (EARS)

- AC-1: WHEN any HTTP request completes on endpoints /discover, /orchestrate, /compose, /auth/agent-signup, or /gasless/*, the system SHALL call `eventService.track()` with an event containing: eventType (derived from route), endpoint (request URL path), method (HTTP method), status ('success' for 2xx/3xx, 'failed' for 4xx/5xx), latencyMs (response time in milliseconds), and requestId (from request.id).
- AC-2: WHEN a tracked endpoint responds, the system SHALL compute latencyMs as the difference between request start time and response send time, with millisecond precision.
- AC-3: IF `eventService.track()` throws an error, THEN the system SHALL log the error and NOT propagate it to the client response (fire-and-forget pattern, matching existing compose/orchestrate behavior).
- AC-4: WHEN requests hit non-tracked endpoints (/, /health, /dashboard/*, /mock-registry/*, static assets), the system SHALL NOT create events to avoid noise in analytics.
- AC-5: WHILE the onResponse hook is active, the system SHALL NOT interfere with existing per-step tracking in compose and orchestrate services (those track granular compose_step / orchestrate_* events; the hook tracks the top-level request event).

## Scope IN

- `src/middleware/event-tracking.ts` -- new file, Fastify onResponse hook
- `src/index.ts` -- register the hook (one import + one call, after request-id hook)
- `src/services/event.ts` -- no schema changes expected; `track()` input already accepts arbitrary eventType and metadata

## Scope OUT

- Dashboard UI changes (already renders from a2a_events)
- Database schema changes (a2a_events table is sufficient as-is; endpoint/method go in metadata or eventType)
- Modifying existing compose/orchestrate per-step tracking
- Tracking WebSocket or SSE streaming connections
- Deduplication between hook-level and service-level events (different eventType values distinguish them)

## Decisiones tecnicas (DT-N)

- DT-1: Use Fastify `onResponse` hook (not `onSend`) because it fires after the response is fully sent, giving accurate latency. The hook has access to `request`, `reply`, and `reply.statusCode`.
- DT-2: Use a configurable allowlist of route prefixes to track, not a denylist. Safer -- new endpoints are silent by default until explicitly opted in.
- DT-3: eventType for hook events SHALL use format `request:<method>:<route>` (e.g. `request:POST:/discover`) to distinguish from existing granular events (`compose_step`, `orchestrate_plan`, etc.).
- DT-4: Latency measurement uses `request` timing -- store start time in `onRequest` hook, read in `onResponse`. Fastify does not expose start time natively on the request object.

## Constraint Directives (CD-N)

- CD-1: PROHIBIDO modify the existing `eventService.track()` signature -- the new hook must use the current input shape.
- CD-2: PROHIBIDO block the response on event tracking -- must be fire-and-forget with `.catch()`.
- CD-3: OBLIGATORIO the hook must respect the existing request-id from `request.id` (already set by request-id middleware).
- CD-4: PROHIBIDO track /dashboard/* requests (would create recursive event noise when dashboard polls stats).

## Missing Inputs

- [resuelto en F2] Whether the a2a_events table metadata column is sufficient for storing endpoint+method or if a dedicated column is preferred. Current assumption: use metadata field + eventType string.

## Analisis de paralelismo

- This HU does NOT block any other HU.
- Can run in parallel with WKH-025 (a2a-key middleware), WKH-026 (hardening), WKH-029 (e2e tests).
- Depends on WKH-27 (dashboard) being DONE -- confirmed DONE in _INDEX.
