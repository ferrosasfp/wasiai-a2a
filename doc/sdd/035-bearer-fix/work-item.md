# Work Item -- [WKH-BEARER-FIX] Bearer Auth Fix on /auth/* + Test Hardening

## Resumen

`resolveCallerKey` in `src/routes/auth.ts` only reads `x-a2a-key` header. Bearer tokens (`Authorization: Bearer wasi_a2a_*`) are silently ignored on `/auth/me` and `/auth/deposit`, even though the same Bearer pattern IS accepted on `/compose` and `/orchestrate` via the `a2a-key.ts` middleware (lines 86-93). This creates an auth inconsistency confirmed in prod audit. Fix the inconsistency and harden the test suites (unit, smoke, E2E) to cover new endpoints and features.

## Sizing

- SDD_MODE: bugfix
- Estimation: S
- Classification: FAST+AR (touches auth path -- requires Adversarial Review)
- Branch suggested: feat/035-bearer-fix
- Skills: auth-rbac, testing

## Acceptance Criteria (EARS)

### Auth fix

- AC-1: WHEN a request to `/auth/me` includes `Authorization: Bearer wasi_a2a_*` header (and no `x-a2a-key` header), the system SHALL resolve the caller key from the Bearer token using the same sha256 hash logic as `a2a-key.ts` middleware.
- AC-2: WHEN a request to `/auth/me` includes BOTH `x-a2a-key` and `Authorization: Bearer` headers, the system SHALL give priority to `x-a2a-key` (same precedence as `a2a-key.ts` lines 82-94).
- AC-3: WHEN a request to any `/auth/*` route includes `Authorization: Bearer <token>` where `<token>` does NOT start with `wasi_a2a_`, the system SHALL ignore the Bearer header and treat the request as unauthenticated (return 403 on protected routes).

### Unit tests (auth.test.ts)

- AC-4: the system SHALL include a test for `GET /auth/me` with `Authorization: Bearer wasi_a2a_*` returning 200.
- AC-5: the system SHALL include a test for `GET /auth/me` with `Authorization: Bearer non_wasi_token` returning 403.

### Smoke test (smoke-test.sh)

- AC-6: WHEN running `smoke-test.sh`, the system SHALL test `GET /auth/me` with `Authorization: Bearer <key>` (key obtained from agent-signup) and expect 200.
- AC-7: WHEN running `smoke-test.sh`, the system SHALL test `POST /discover` and expect 200.

### E2E tests (e2e.test.ts)

- AC-8: the system SHALL include an E2E test for `GET /auth/me` with Bearer auth returning 200.
- AC-9: the system SHALL include an E2E test for `POST /discover` returning 200.
- AC-10: the system SHALL include an E2E test for `GET /health` returning 200 with `status` and `uptime` fields.
- AC-11: the system SHALL include an E2E test verifying the `invocationNote` field is present in compose/orchestrate error responses (if applicable to current response shape) [TBD -- verify in F2 whether invocationNote is part of error boundary output].

## Scope IN

- `src/routes/auth.ts` -- update `resolveCallerKey` to support Bearer
- `src/routes/auth.test.ts` -- add Bearer test cases
- `scripts/smoke-test.sh` -- add Bearer /auth/me + POST /discover tests
- `src/__tests__/e2e/e2e.test.ts` -- add POST /discover, GET /health, Bearer auth, invocationNote tests
- `src/__tests__/e2e/setup.ts` -- add `/health` route to `buildTestApp` if missing (confirmed missing)

## Scope OUT

- Changes to `src/middleware/a2a-key.ts` -- already correct, no changes needed
- Changes to identity service or budget service logic
- Any new routes or endpoints
- Any DB migrations

## Decisiones tecnicas (DT-N)

- DT-1: Reuse exact regex from `a2a-key.ts` line 89 (`/^bearer\s+(.+)$/i`) and `wasi_a2a_` prefix check (line 90) in `resolveCallerKey`. No abstraction/refactor to shared util -- keep it a local copy for minimal diff. Justification: bugfix scope, shared util can be a follow-up if desired.
- DT-2: Priority order in `resolveCallerKey`: `x-a2a-key` header > `Authorization: Bearer wasi_a2a_*` > null. Matches `a2a-key.ts` precedence exactly.
- DT-3: Bearer scheme match is case-insensitive (`/i` flag), token prefix `wasi_a2a_` is case-sensitive. Same as middleware.

## Constraint Directives (CD-N)

- CD-1: PROHIBIDO cambiar la firma o el comportamiento de `a2a-key.ts` middleware
- CD-2: PROHIBIDO agregar dependencias nuevas
- CD-3: OBLIGATORIO que `resolveCallerKey` mantiene backward compatibility (x-a2a-key sigue funcionando igual)
- CD-4: OBLIGATORIO que los tests nuevos en smoke-test.sh usen las mismas helpers (`report`, `json_has_field`, etc.) del script existente

## Missing Inputs

- [resuelto en F2] AC-11: Verificar si `invocationNote` es parte de la response shape actual de compose/orchestrate errors. Si no existe, AC-11 se marca N/A.

## Analisis de paralelismo

- Esta HU NO bloquea otras HUs.
- Puede ir en paralelo con WKH-028 (README rewrite), WKH-033 (invoke docs).
- Depende implicitamente de que WKH-032 (Bearer Auth middleware) y WKH-034 (event tracking) esten mergeados en la branch base, ya que los E2E tests asumen esos features existen. Current branch `feat/018-gasless-aa` includes those commits.
