# Work Item — [WKH-34] Agentic Economy Primitives L3

## Resumen

Implement wasiai-a2a's own off-chain, chain-agnostic identity/budget/authorization primitives as defined in `doc/architecture/CHAIN-ADAPTIVE.md` section L3. This creates the `a2a_agent_keys` table, three domain services (Identity, Budget, Authz), four `/auth/*` endpoints, and an optional `x-a2a-key` middleware that coexists with the existing x402 flow. The goal is to decouple identity from Kite Passport and give agents a pre-paid budget model with daily caps and scoped permissions.

## Sizing

- SDD_MODE: full
- Estimation: L (large) -- new DB table + Postgres function + 3 services + 4 endpoints + middleware + tests
- Case Type: DB-MIGRATION (has DB schema + has auth layer)
- Flow: QUALITY (mandatory for wasiai-a2a per CLAUDE.md)
- Branch: `feat/024-agentic-economy-l3`
- Skills: `blockchain-identity`, `api-auth-middleware`

## Acceptance Criteria (EARS)

### Data Layer

- AC-1: WHEN the migration `YYYYMMDD_a2a_agent_keys.sql` is applied, the system SHALL create table `a2a_agent_keys` with all columns per CHAIN-ADAPTIVE.md L3 schema (id UUID PK, owner_ref TEXT NOT NULL, key_hash TEXT UNIQUE NOT NULL, display_name TEXT, budget JSONB, daily_limit_usd NUMERIC(18,6), daily_spent_usd NUMERIC(18,6) DEFAULT 0, daily_reset_at TIMESTAMPTZ, allowed_registries TEXT[], allowed_agent_slugs TEXT[], allowed_categories TEXT[], max_spend_per_call_usd NUMERIC(18,6), is_active BOOLEAN DEFAULT true, last_used_at TIMESTAMPTZ, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, erc8004_identity JSONB, kite_passport JSONB, agentkit_wallet JSONB, metadata JSONB).

- AC-2: WHEN the migration is applied, the system SHALL create Postgres function `increment_a2a_key_spend(p_key_id UUID, p_chain_id INT, p_amount_usd NUMERIC)` that atomically debits budget for the given chain, increments `daily_spent_usd`, updates `last_used_at`, and raises an exception if budget is insufficient or daily limit is exceeded.

- AC-3: WHEN the down migration is executed, the system SHALL drop function `increment_a2a_key_spend` and table `a2a_agent_keys` cleanly, leaving no residual objects.

- AC-4: WHEN the migration is applied, the system SHALL create an index on `key_hash` (already UNIQUE) and a partial index on `is_active = true` for lookup performance.

### IdentityService

- AC-5: WHEN `IdentityService.createKey(owner_ref, display_name?, scoping?)` is called, the system SHALL generate a cryptographically random key with prefix `wasi_a2a_`, compute its SHA-256 hash, store a row in `a2a_agent_keys`, and return the plaintext key exactly once (never stored).

- AC-6: WHEN `IdentityService.lookupByHash(key_hash)` is called, the system SHALL return the full `a2a_agent_keys` row or null if not found.

- AC-7: WHEN `IdentityService.deactivate(key_id)` is called, the system SHALL set `is_active = false` and `updated_at = NOW()`.

### BudgetService

- AC-8: WHEN `BudgetService.getBalance(key_id, chain_id)` is called, the system SHALL return the current balance for that chain from the `budget` JSONB field, or `"0"` if no entry exists for that chain.

- AC-9: WHEN `BudgetService.debit(key_id, chain_id, amount_usd)` is called, the system SHALL invoke `increment_a2a_key_spend` and return success/failure. IF the debit would exceed `daily_limit_usd` or chain budget, THEN the system SHALL reject with a descriptive error without modifying any balance.

- AC-10: WHEN `BudgetService.registerDeposit(key_id, chain_id, amount_usd)` is called, the system SHALL atomically increment `budget->{chain_id}` by the given amount and return the new balance.

- AC-11: WHILE `daily_reset_at` is in the past, the system SHALL reset `daily_spent_usd` to 0 and advance `daily_reset_at` by 24 hours before evaluating any debit.

### AuthzService

- AC-12: WHEN `AuthzService.checkScoping(key_row, target)` is called with target `{registry?, agent_slug?, category?, estimated_cost_usd?}`, the system SHALL return `{allowed: true}` only if the target matches all non-empty scoping arrays AND `estimated_cost_usd <= max_spend_per_call_usd` (when set). IF any check fails, THEN the system SHALL return `{allowed: false, reason: string}`.

### L4 Endpoints

- AC-13: WHEN `POST /auth/agent-signup` is called with body `{owner_ref, display_name?, daily_limit_usd?, allowed_registries?, allowed_agent_slugs?, allowed_categories?, max_spend_per_call_usd?}`, the system SHALL create a new agent key via IdentityService and return `{key: "wasi_a2a_...", key_id: UUID}` with status 201. The plaintext key SHALL appear only in this response.

- AC-14: WHEN `POST /auth/deposit` is called with body `{key_id, chain_id, token, amount, tx_hash}` and valid `x-a2a-key` header, the system SHALL verify the caller owns the key, register the deposit amount in BudgetService, and return `{balance: string, chain_id}`. On-chain verification is [TBD -- requires PaymentAdapter.verify from WKH-35].

- AC-15: WHEN `GET /auth/me` is called with a valid `x-a2a-key` header, the system SHALL return the key's full status: `{key_id, display_name, budget, daily_limit_usd, daily_spent_usd, daily_reset_at, scoping: {allowed_registries, allowed_agent_slugs, allowed_categories, max_spend_per_call_usd}, is_active, bindings: {erc8004_identity, kite_passport, agentkit_wallet}, created_at}`.

- AC-16: WHEN `POST /auth/bind/:chain` is called, the system SHALL return `{status: "not_implemented", message: "..."}` with HTTP 501. This is an interface placeholder for Fase 2.

### Middleware

- AC-17: WHEN a request to `/compose` or `/orchestrate` includes header `x-a2a-key`, the system SHALL hash the key, look up in `a2a_agent_keys`, validate `is_active`, check daily limit, check scoping against the request target, execute the request, and on success atomically debit via BudgetService. The response SHALL include `x-a2a-remaining-budget` header.

- AC-18: WHEN a request to `/compose` or `/orchestrate` does NOT include header `x-a2a-key`, the system SHALL fall through to the existing x402 payment flow with zero behavioral change.

- AC-19: IF `x-a2a-key` header is present but the key is invalid, inactive, over daily limit, out of budget, or fails scoping, THEN the system SHALL return HTTP 403 with `{error: string, code: "KEY_INVALID" | "KEY_INACTIVE" | "DAILY_LIMIT" | "INSUFFICIENT_BUDGET" | "SCOPE_DENIED"}`.

## Scope IN

### New files
- `supabase/migrations/YYYYMMDD_a2a_agent_keys.sql` -- up migration
- `supabase/migrations/YYYYMMDD_a2a_agent_keys_down.sql` -- down migration
- `src/services/identity.ts` -- IdentityService
- `src/services/budget.ts` -- BudgetService
- `src/services/authz.ts` -- AuthzService
- `src/routes/auth.ts` -- /auth/* endpoints
- `src/middleware/a2a-key.ts` -- x-a2a-key middleware
- `src/types/a2a-key.ts` -- types for agent keys, budget, scoping
- `test/services/identity.test.ts`
- `test/services/budget.test.ts`
- `test/services/authz.test.ts`
- `test/routes/auth.test.ts`
- `test/middleware/a2a-key.test.ts`

### Modified files
- `src/index.ts` -- register auth routes + a2a-key middleware on compose/orchestrate
- `src/types/index.ts` -- re-export from `a2a-key.ts`
- `src/routes/compose.ts` -- add a2a-key preHandler (optional)
- `src/routes/orchestrate.ts` -- add a2a-key preHandler (optional)

## Scope OUT

- Multi-chain simultaneous deposit/spend (per-chain budget is stored but cross-chain arbitrage is Fase 2)
- ERC-8004 real on-chain binding flow (POST /auth/bind/:chain returns 501)
- Kite Passport adapter (blocked on Kite publishing integration path)
- On-chain deposit verification in POST /auth/deposit (requires PaymentAdapter.verify from WKH-35 -- mark [TBD])
- RateLimitService (hourly caps, per-call throttling -- mentioned in CHAIN-ADAPTIVE.md L3 but not in WKH-34 Jira scope)
- PricingService (USD to token conversion -- out of scope for this HU)
- Changes to existing x402 middleware behavior
- Admin endpoints for key management (list all keys, revoke by admin)

## Decisiones tecnicas (DT-N)

- DT-1: Key format is `wasi_a2a_` + 32 bytes of `crypto.randomBytes` encoded as hex (64 chars). Total: `wasi_a2a_` (9 chars) + 64 hex = 73 chars. Justification: prefix makes keys recognizable in logs/headers; 256 bits of entropy is standard for API keys.

- DT-2: Hash algorithm is SHA-256 via Node.js `crypto.createHash('sha256')`. Stored as hex string. Justification: matches CHAIN-ADAPTIVE.md spec; fast, collision-resistant, no need for bcrypt since the key has high entropy.

- DT-3: Budget JSONB structure is `{chain_id_string: amount_string}` e.g. `{"2368": "10.00"}`. Keys are string (not int) because JSONB keys are always strings. Amounts are string (not number) to avoid floating-point precision issues with NUMERIC.

- DT-4: Middleware precedence: `a2a-key` middleware runs BEFORE x402. If `x-a2a-key` header is present, x402 is skipped entirely. If absent, x402 runs as before. This is implemented as a Fastify `preHandler` that either handles the request or calls `done()` to pass through.

- DT-5: Daily reset is lazy -- checked and reset on each debit call, not via cron. The `increment_a2a_key_spend` Postgres function checks `daily_reset_at < NOW()` and resets if needed, atomically. Justification: simpler, no external scheduler dependency.

- DT-6: The `a2a_agent_keys` table does NOT use the `a2a_` prefix on the table name because the column-level naming already disambiguates and the spec in CHAIN-ADAPTIVE.md uses `a2a_agent_keys`. Wait -- the spec does use `a2a_agent_keys`. Confirmed: table name is `a2a_agent_keys` per spec.

- DT-7: POST /auth/deposit registers the deposit amount in the off-chain budget immediately. On-chain verification via PaymentAdapter.verify() is [TBD] until WKH-35 lands the adapter interface. For now, the endpoint trusts the caller's `tx_hash` claim. This is acceptable for testnet; production will require verification.

## Constraint Directives (CD-N)

- CD-1: OBLIGATORIO -- down migration must be idempotent and drop all objects (table, function, indexes) created by the up migration.

- CD-2: OBLIGATORIO -- `increment_a2a_key_spend` must be atomic (single transaction). No partial debits. Use `SECURITY DEFINER` to bypass RLS.

- CD-3: PROHIBIDO -- no shared tables with wasiai-v2. The `a2a_agent_keys` table is wasiai-a2a only. No FK to `auth.users`.

- CD-4: OBLIGATORIO -- plaintext key returned ONLY in POST /auth/agent-signup response. Never stored in DB. Never logged. Never returned again.

- CD-5: PROHIBIDO -- no `ethers.js`. All crypto via Node.js `crypto` module (SHA-256) or `viem` if chain operations are needed.

- CD-6: OBLIGATORIO -- TypeScript strict. No `any`. All new types in `src/types/a2a-key.ts`.

- CD-7: OBLIGATORIO -- every new endpoint and service method must have at least 1 test.

- CD-8: PROHIBIDO -- no hardcoded chain IDs, RPC URLs, or token addresses in services. Chain context comes from env or function parameters.

- CD-9: OBLIGATORIO -- Fastify request augmentation for `a2aKeyRow` must use `declare module 'fastify'` pattern (same as x402 middleware does for `kiteTxHash`).

## Missing Inputs

- [TBD -- resolved in F2] Exact cost estimation strategy for AC-17 debit. The middleware needs to know the USD cost of the request BEFORE executing it for the scoping check (`max_spend_per_call_usd`). Options: (a) use PaymentAdapter.quote() from WKH-35, (b) use a fixed estimate per endpoint, (c) debit after execution based on actual cost. Decision deferred to SDD.

- [TBD -- resolved in F2] Header naming: `x-a2a-key` vs `Authorization: Bearer wasi_a2a_xxx`. CHAIN-ADAPTIVE.md section 7 item 5 flags this as open. Recommend `x-a2a-key` for simplicity (avoids collision with other Bearer tokens). Final decision in SDD.

- [NEEDS CLARIFICATION] Should POST /auth/deposit require the caller to be the key owner (authenticated via `x-a2a-key`)? Or can anyone deposit into any key? The Jira description implies self-deposit. Defaulting to self-only for security.

## DB-MIGRATION Case Type Checklist

- [ ] Up migration is idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`)
- [ ] Down migration exists and drops all created objects
- [ ] Down migration is idempotent (`DROP TABLE IF EXISTS`, `DROP FUNCTION IF EXISTS`)
- [ ] No data-loss operations in up (this is a new table, N/A)
- [ ] Indexes created for query patterns (key_hash UNIQUE, is_active partial)
- [ ] SECURITY DEFINER on functions that bypass RLS
- [ ] Migration filename follows convention: `YYYYMMDD_a2a_agent_keys.sql`
- [ ] Tested with `supabase db reset` (verify in F3)

## Analisis de paralelismo

- **WKH-35 (L2 adapter refactor)**: WKH-34 is partially blocked by WKH-35 for on-chain deposit verification (AC-14 [TBD]) and cost estimation in middleware (AC-17 [TBD]). However, all other ACs can proceed independently. The middleware can use a stub/placeholder for quote() until WKH-35 lands.
- **Internal parallelism**: IdentityService, BudgetService, and AuthzService have no circular dependencies. They can be implemented in parallel once the DB migration and types are in place.
- **This work-item does NOT block** any other WKH in the current sprint.

## Wave suggestion for F3

| Wave | Scope | Depends on |
|------|-------|------------|
| W1 | Types (`src/types/a2a-key.ts`) + DB migration (up + down) + `trigger_set_updated_at` reuse | Nothing |
| W2 | IdentityService + BudgetService + AuthzService + unit tests | W1 |
| W3 | `/auth/*` endpoints + route tests | W1, W2 |
| W4 | `a2a-key` middleware + integration with compose/orchestrate routes + middleware tests | W1, W2, W3 |

## Resumen ejecutivo

- **New files**: 13 (1 migration up, 1 migration down, 3 services, 1 route, 1 middleware, 1 types, 5 test files)
- **Modified files**: 4 (index.ts, types/index.ts, routes/compose.ts, routes/orchestrate.ts)
- **AC count**: 19
- **Waves**: 4 (types+migration -> services -> endpoints -> middleware)
- **DB migration**: 1 new table `a2a_agent_keys`, 1 Postgres function `increment_a2a_key_spend`, 2 indexes
- **Key risks**: (1) Cost estimation in middleware depends on WKH-35 PaymentAdapter.quote() -- mitigated by [TBD] marker and stub strategy. (2) Deposit without on-chain verification is testnet-only acceptable. (3) Daily reset logic in Postgres function needs careful atomic handling.
- **Dependency on WKH-35**: non-blocking for F0-F3; the two [TBD] items (deposit verification + cost quote) can be stubbed and completed when WKH-35 merges.
