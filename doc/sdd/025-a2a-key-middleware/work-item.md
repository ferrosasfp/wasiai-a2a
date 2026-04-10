# Work Item — [WKH-34-W4] A2A Key Middleware

## Resumen

Middleware Fastify `requirePaymentOrA2AKey` que intercepta requests a `/compose` y `/orchestrate`. Cuando el header `x-a2a-key` esta presente, valida la key, chequea budget/scoping, ejecuta el request y debita atomicamente. Cuando esta ausente, delega al flujo x402 existente sin cambios.

Wave 4 de WKH-34 (Agentic Economy L3). W1-W3 merged (PR #7). Desbloqueada por WKH-35 (adapter refactor merged).

## Sizing

- SDD_MODE: mini (inherits design from SDD 024 section 4.6)
- Estimacion: M
- Branch sugerido: feat/025-a2a-key-middleware

## Acceptance Criteria (EARS)

- AC-1: WHEN request to `/compose` or `/orchestrate` includes `x-a2a-key` header, the system SHALL hash the key with SHA-256, look up the row in `a2a_agent_keys`, validate `is_active`, check daily limit via lazy reset, check scoping via `authzService.checkScoping()`, execute the request, debit atomically via `budgetService.debit()`, and include `x-a2a-remaining-budget` response header with the post-debit balance.

- AC-2: WHEN request to `/compose` or `/orchestrate` does NOT include `x-a2a-key` header, the system SHALL fall through to the existing `requirePayment()` x402 flow with zero behavioral change.

- AC-3: IF `x-a2a-key` header is present but the key is invalid (not found), inactive, over daily limit, out of budget, or scope-denied, THEN the system SHALL return HTTP 403 with a JSON body containing a specific `error_code` field distinguishing the failure reason (one of: `KEY_NOT_FOUND`, `KEY_INACTIVE`, `DAILY_LIMIT`, `INSUFFICIENT_BUDGET`, `SCOPE_DENIED`).

- AC-4: WHEN `x-a2a-key` header is present and valid, the system SHALL augment `FastifyRequest` with `a2aKeyRow` property (typed via `declare module 'fastify'`) so downstream handlers can access the authenticated key.

- AC-5: WHEN `x-a2a-key` header is present and `max_spend_per_call_usd` is set on the key row, IF the estimated cost of the request exceeds that limit, THEN the system SHALL return 403 with `error_code: 'PER_CALL_LIMIT'`.

## Scope IN

- `src/middleware/a2a-key.ts` — NEW: the middleware factory `requirePaymentOrA2AKey(x402Opts)`
- `src/middleware/a2a-key.test.ts` — NEW: unit tests (mock identity, budget, authz services)
- `src/routes/compose.ts` — MODIFY: swap `requirePayment(...)` to `requirePaymentOrA2AKey(...)`
- `src/routes/orchestrate.ts` — MODIFY: same swap
- `src/middleware/x402.ts` — READ ONLY: import `requirePayment` from here as fallback path

## Scope OUT

- Auth routes (`/agent-signup`, `/deposit`, `/me`, `/bind`) — already done in W1-W3
- DB migrations — `a2a_agent_keys` table already exists (W1)
- `budgetService`, `authzService`, `identityService` — already implemented (W1-W3), consumed as-is
- Deposit verification via on-chain proof — deferred (separate HU)
- Cost estimation refinement (real USD pricing) — uses `PaymentAdapter.quote()` stub for now

## Decisiones tecnicas (DT-N)

- DT-1: `requirePaymentOrA2AKey(x402Opts)` returns `preHandlerHookHandler[]` (same signature as `requirePayment`), making the swap in routes a single import change. Internally, the first handler checks for `x-a2a-key`; if absent, delegates to `requirePayment(x402Opts)`.
- DT-2: Cost estimation for per-call limit uses `getPaymentAdapter().quote(1.0)` as a placeholder. Real pricing is out of scope.
- DT-3: The middleware does NOT catch errors from `budgetService.debit()` silently — PG exceptions from `increment_a2a_key_spend` are parsed to extract the error code prefix (e.g., `DAILY_LIMIT:`, `INSUFFICIENT_BUDGET:`).

## Constraint Directives (CD-N)

- CD-1: PROHIBIDO modificar `requirePayment()` en `x402.ts` — es el fallback path, debe quedar intacto.
- CD-2: PROHIBIDO usar `any` en la augmentacion de FastifyRequest — usar tipos estrictos de `A2AAgentKeyRow`.
- CD-3: OBLIGATORIO que los tests cubran ambos paths: con header (happy + cada error code) y sin header (fallback a x402).
- CD-4: PROHIBIDO hardcodear chain IDs — obtener via `getChainConfig().chainId` del adapter registry.

## Missing Inputs

- [resuelto en F2] Exact cost estimation strategy for `max_spend_per_call_usd` check — placeholder via `quote()` is sufficient for W4.

## Analisis de paralelismo

- Esta HU NO bloquea otras. Es la ultima wave de WKH-34.
- NO depende de ninguna HU en curso (WKH-35 ya merged).
- Puede ejecutarse inmediatamente.
