# Story File -- #024: Agentic Economy Primitives L3

> SDD: doc/sdd/024-agentic-economy-l3/sdd.md
> Fecha: 2026-04-06
> Branch: feat/024-agentic-economy-l3

---

## Goal

Build wasiai-a2a's own off-chain, chain-agnostic identity/budget/authorization primitives (L3 per CHAIN-ADAPTIVE.md). This decouples identity from Kite Passport and gives agents a pre-paid budget model with daily caps and scoped permissions. Includes: DB table `a2a_agent_keys`, Postgres function `increment_a2a_key_spend`, three domain services (Identity, Budget, Authz), four `/auth/*` REST endpoints, and an optional `x-a2a-key` middleware that coexists with the existing x402 flow.

**CRITICAL**: This is a DB-MIGRATION case type. Both up and down migrations must be created and tested with `supabase db reset`.

**BLOCKED**: Wave 4 (middleware + integration with compose/orchestrate) is BLOCKED by WKH-35 (L2 adapter refactor) which provides `PaymentAdapter.quote()`. Implement W1-W3 immediately. W4 can be implemented when WKH-35 lands.

## Acceptance Criteria (EARS)

### Data Layer

- AC-1: WHEN the migration `20260406000000_a2a_agent_keys.sql` is applied, the system SHALL create table `a2a_agent_keys` with all columns per CHAIN-ADAPTIVE.md L3 schema (id UUID PK, owner_ref TEXT NOT NULL, key_hash TEXT UNIQUE NOT NULL, display_name TEXT, budget JSONB, daily_limit_usd NUMERIC(18,6), daily_spent_usd NUMERIC(18,6) DEFAULT 0, daily_reset_at TIMESTAMPTZ, allowed_registries TEXT[], allowed_agent_slugs TEXT[], allowed_categories TEXT[], max_spend_per_call_usd NUMERIC(18,6), is_active BOOLEAN DEFAULT true, last_used_at TIMESTAMPTZ, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, erc8004_identity JSONB, kite_passport JSONB, agentkit_wallet JSONB, metadata JSONB).

- AC-2: WHEN the migration is applied, the system SHALL create Postgres function `increment_a2a_key_spend(p_key_id UUID, p_chain_id INT, p_amount_usd NUMERIC)` that atomically debits budget for the given chain, increments `daily_spent_usd`, updates `last_used_at`, and raises an exception if budget is insufficient or daily limit is exceeded.

- AC-3: WHEN the down migration is executed, the system SHALL drop function `increment_a2a_key_spend` and table `a2a_agent_keys` cleanly, leaving no residual objects.

- AC-4: WHEN the migration is applied, the system SHALL create a partial index on `is_active = true` for lookup performance. (`key_hash` already has UNIQUE constraint index.)

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

---

## Files to Modify/Create

| # | Archivo | Accion | Que hacer | Wave | Exemplar |
|---|---------|--------|-----------|------|----------|
| 1 | `src/types/a2a-key.ts` | Crear | All type definitions (see section "Type Definitions" below) | W1 | `src/types/index.ts` |
| 2 | `src/types/index.ts` | Modificar | Add `export * from './a2a-key.js'` re-export at the end | W1 | Existing barrel pattern |
| 3 | `supabase/migrations/20260406000000_a2a_agent_keys.sql` | Crear | Up migration (see section "Migration SQL" below) | W1 | `supabase/migrations/20260403180000_tasks.sql` |
| 4 | `supabase/migrations/20260406000000_a2a_agent_keys_down.sql` | Crear | Down migration (see section "Migration SQL" below) | W1 | N/A |
| 5 | `src/services/identity.ts` | Crear | IdentityService: createKey, lookupByHash, deactivate | W2 | `src/services/event.ts` |
| 6 | `src/services/identity.test.ts` | Crear | Unit tests for IdentityService (AC-5, AC-6, AC-7) | W2 | `src/services/compose.test.ts` |
| 7 | `src/services/budget.ts` | Crear | BudgetService: getBalance, debit, registerDeposit | W2 | `src/services/event.ts` |
| 8 | `src/services/budget.test.ts` | Crear | Unit tests for BudgetService (AC-8, AC-9, AC-10, AC-11) | W2 | `src/services/compose.test.ts` |
| 9 | `src/services/authz.ts` | Crear | AuthzService: checkScoping (pure function, no DB) | W2 | `src/services/event.ts` |
| 10 | `src/services/authz.test.ts` | Crear | Unit tests for AuthzService (AC-12) | W2 | `src/services/compose.test.ts` |
| 11 | `src/routes/auth.ts` | Crear | `/auth/*` endpoints: agent-signup, deposit, me, bind/:chain | W3 | `src/routes/gasless.ts` |
| 12 | `src/routes/auth.test.ts` | Crear | Route integration tests (AC-13, AC-14, AC-15, AC-16) | W3 | `src/routes/tasks.test.ts` |
| 13 | `src/index.ts` | Modificar | Register auth routes: `import authRoutes` + `await fastify.register(authRoutes, { prefix: '/auth' })` | W3 | Existing route registration pattern in `src/index.ts` |
| 14 | `src/middleware/a2a-key.ts` | Crear | `requirePaymentOrA2AKey()` middleware factory | W4 | `src/middleware/x402.ts` |
| 15 | `src/middleware/a2a-key.test.ts` | Crear | Middleware tests (AC-17, AC-18, AC-19) | W4 | `src/lib/gasless-signer.test.ts` |
| 16 | `src/routes/compose.ts` | Modificar | Change `preHandler: requirePayment(...)` to `preHandler: requirePaymentOrA2AKey(...)` | W4 | Current preHandler pattern |
| 17 | `src/routes/orchestrate.ts` | Modificar | Change `preHandler: requirePayment(...)` to `preHandler: requirePaymentOrA2AKey(...)` | W4 | Current preHandler pattern |

**Total: 13 new + 4 modified = 17 files**

---

## Exemplars

### Exemplar 1: Service pattern (`export const xxxService = { ... }`)
**Archivo**: `src/services/event.ts`
**Usar para**: Files #5, #7, #9 (identity.ts, budget.ts, authz.ts)
**Patron clave**:
- Import types from `'../types/index.js'`
- Import supabase from `'../lib/supabase.js'`
- Internal `interface Row` for DB row shape
- `function rowToDomain(row: Row): DomainType` mapper
- `export const xxxService = { async method(...): Promise<T> { ... } }`
- Error pattern: `if (error) throw new Error(\`Failed to ...: ${error.message}\`)`

### Exemplar 2: Route plugin (no payment middleware)
**Archivo**: `src/routes/gasless.ts`
**Usar para**: File #11 (auth.ts)
**Patron clave**:
- `import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'`
- `const xxxRoutes: FastifyPluginAsync = async (fastify) => { ... }`
- `export default xxxRoutes`
- Multiple endpoints inside one plugin
- Error sanitization: `fastify.log.error(...)` with sanitized messages, never expose internal details
- `return reply.status(N).send({ error: '...' })`

### Exemplar 3: Route plugin with payment middleware
**Archivo**: `src/routes/compose.ts`
**Usar para**: Files #16, #17 (compose.ts, orchestrate.ts modifications)
**Patron clave**:
- `import { requirePayment } from '../middleware/x402.js'`
- `preHandler: requirePayment({ description: '...' })`
- After W4 this changes to: `import { requirePaymentOrA2AKey } from '../middleware/a2a-key.js'`
- `preHandler: requirePaymentOrA2AKey({ description: '...' })`

### Exemplar 4: Middleware factory (`preHandlerHookHandler[]`)
**Archivo**: `src/middleware/x402.ts`
**Usar para**: File #14 (a2a-key.ts)
**Patron clave**:
- `import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify'`
- `declare module 'fastify' { interface FastifyRequest { ... } }` for request augmentation
- `export interface PaymentMiddlewareOptions { description: string; amount?: string }`
- `export function requirePayment(opts: PaymentMiddlewareOptions): preHandlerHookHandler[]`
- Returns `[handler]` array with single async handler
- Early return via `return reply.status(N).send(...)` for errors
- On success: augment request properties and return (no reply.send)

### Exemplar 5: Service unit tests with mocks
**Archivo**: `src/services/compose.test.ts`
**Usar para**: Files #6, #8, #10 (identity.test.ts, budget.test.ts, authz.test.ts)
**Patron clave**:
- `import { describe, it, expect, vi, beforeEach } from 'vitest'`
- `vi.mock('./dependency.js', () => ({ ... }))` for mocking dependencies
- `vi.mock('../lib/supabase.js', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }))` for DB mocks
- `const mockX = vi.mocked(dependency.method)`
- `describe('ServiceName', () => { it('should ...', async () => { ... }) })`

### Exemplar 6: Route integration tests with `fastify.inject()`
**Archivo**: `src/routes/tasks.test.ts`
**Usar para**: File #12 (auth.test.ts)
**Patron clave**:
- `import Fastify from 'fastify'`
- `vi.mock('../services/xxx.js', () => ({ xxxService: { method: vi.fn() } }))`
- Create Fastify instance, register route plugin, use `fastify.inject()` for requests
- `const res = await fastify.inject({ method: 'POST', url: '/endpoint', payload: {...}, headers: {...} })`
- `expect(res.statusCode).toBe(201)` + `expect(JSON.parse(res.payload)).toMatchObject({...})`

### Exemplar 7: Migration pattern
**Archivo**: `supabase/migrations/20260403180000_tasks.sql`
**Usar para**: File #3 (up migration)
**Patron clave**:
- `CREATE TABLE IF NOT EXISTS` for idempotency
- `CREATE INDEX IF NOT EXISTS` for each query pattern
- `CREATE OR REPLACE FUNCTION trigger_set_updated_at()` -- already exists, DO NOT redefine
- `DROP TRIGGER IF EXISTS set_updated_at ON tablename; CREATE TRIGGER set_updated_at ...`
- `EXECUTE FUNCTION trigger_set_updated_at()`

---

## Contrato de Integracion -- BLOQUEANTE

> This HU has communication between: auth endpoints <-> services, middleware <-> services, middleware <-> routes.

### POST /auth/agent-signup

**Request:**
```json
{
  "owner_ref": "string -- required, identifies the key owner",
  "display_name": "string | undefined -- optional human label",
  "daily_limit_usd": "number | undefined -- optional daily cap",
  "allowed_registries": "string[] | undefined -- optional registry scoping",
  "allowed_agent_slugs": "string[] | undefined -- optional agent scoping",
  "allowed_categories": "string[] | undefined -- optional category scoping",
  "max_spend_per_call_usd": "number | undefined -- optional per-call cap"
}
```

**Response 201:**
```json
{
  "key": "wasi_a2a_<64hex> -- plaintext, returned ONCE",
  "key_id": "uuid -- the row id"
}
```

**Errors:**
| HTTP | When |
|------|------|
| 400 | `owner_ref` missing or empty |

### POST /auth/deposit

**Headers:** `x-a2a-key: wasi_a2a_xxx` (required)

**Request:**
```json
{
  "key_id": "uuid -- must match caller's key id",
  "chain_id": "number -- e.g. 2368",
  "token": "string -- e.g. 'PYUSD'",
  "amount": "string -- e.g. '10.00'",
  "tx_hash": "string -- on-chain tx hash (trusted for now, TODO(WKH-35) verify)"
}
```

**Response 200:**
```json
{
  "balance": "string -- new balance for chain_id",
  "chain_id": "number"
}
```

**Errors:**
| HTTP | When |
|------|------|
| 400 | Missing required fields |
| 403 | Invalid/inactive key or caller does not own key_id |

### GET /auth/me

**Headers:** `x-a2a-key: wasi_a2a_xxx` (required)

**Response 200:**
```json
{
  "key_id": "uuid",
  "display_name": "string | null",
  "budget": { "2368": "10.00" },
  "daily_limit_usd": "string | null",
  "daily_spent_usd": "string",
  "daily_reset_at": "ISO timestamp",
  "scoping": {
    "allowed_registries": "string[] | null",
    "allowed_agent_slugs": "string[] | null",
    "allowed_categories": "string[] | null",
    "max_spend_per_call_usd": "string | null"
  },
  "is_active": "boolean",
  "bindings": {
    "erc8004_identity": "object | null",
    "kite_passport": "object | null",
    "agentkit_wallet": "object | null"
  },
  "created_at": "ISO timestamp"
}
```

**Errors:**
| HTTP | When |
|------|------|
| 403 | Invalid or inactive key |

### POST /auth/bind/:chain

**Response 501:**
```json
{
  "status": "not_implemented",
  "message": "On-chain identity binding is planned for Fase 2. See doc/architecture/CHAIN-ADAPTIVE.md"
}
```

### Middleware error responses (AC-19)

When `x-a2a-key` is present but validation fails on `/compose` or `/orchestrate`:

**Response 403:**
```json
{
  "error": "string -- descriptive message",
  "code": "KEY_INVALID | KEY_INACTIVE | DAILY_LIMIT | INSUFFICIENT_BUDGET | SCOPE_DENIED"
}
```

### Response header on successful a2a-key auth

```
x-a2a-remaining-budget: <string balance for the chain used>
```

---

## Migration SQL (Complete)

### Up Migration: `supabase/migrations/20260406000000_a2a_agent_keys.sql`

```sql
-- ============================================================
-- Migration: 20260406000000_a2a_agent_keys
-- WKH-34: Agentic Economy Primitives L3
-- Creates table a2a_agent_keys + function increment_a2a_key_spend
-- ============================================================

-- Table: a2a_agent_keys
CREATE TABLE IF NOT EXISTS a2a_agent_keys (
  id                      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_ref               TEXT          NOT NULL,
  key_hash                TEXT          UNIQUE NOT NULL,
  display_name            TEXT,

  -- budget: per-chain balance as JSONB {"chain_id_string": "amount_string"}
  budget                  JSONB         DEFAULT '{}'::jsonb,
  daily_limit_usd         NUMERIC(18,6),
  daily_spent_usd         NUMERIC(18,6) DEFAULT 0,
  daily_reset_at          TIMESTAMPTZ   DEFAULT NOW(),

  -- scoping
  allowed_registries      TEXT[],
  allowed_agent_slugs     TEXT[],
  allowed_categories      TEXT[],
  max_spend_per_call_usd  NUMERIC(18,6),

  -- lifecycle
  is_active               BOOLEAN       DEFAULT true,
  last_used_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- optional on-chain bindings (JSONB to stay chain-agnostic)
  erc8004_identity        JSONB,
  kite_passport           JSONB,
  agentkit_wallet         JSONB,

  metadata                JSONB         DEFAULT '{}'::jsonb
);

-- Index: partial index on active keys for lookup performance (AC-4)
CREATE INDEX IF NOT EXISTS idx_a2a_agent_keys_active
  ON a2a_agent_keys (is_active)
  WHERE is_active = true;

-- Trigger: updated_at (reuse existing function from tasks migration)
DROP TRIGGER IF EXISTS set_updated_at ON a2a_agent_keys;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON a2a_agent_keys
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

-- Function: increment_a2a_key_spend
-- Atomically debits budget for a given chain, increments daily_spent_usd,
-- updates last_used_at. Lazy daily reset per DT-5.
-- Raises exception if budget insufficient or daily limit exceeded.
CREATE OR REPLACE FUNCTION increment_a2a_key_spend(
  p_key_id    UUID,
  p_chain_id  INT,
  p_amount_usd NUMERIC
) RETURNS void AS $$
DECLARE
  v_row          a2a_agent_keys%ROWTYPE;
  v_chain_key    TEXT;
  v_current_bal  NUMERIC;
  v_new_bal      NUMERIC;
  v_daily_spent  NUMERIC;
  v_daily_limit  NUMERIC;
BEGIN
  -- Lock the row for atomic update
  SELECT * INTO v_row
    FROM a2a_agent_keys
    WHERE id = p_key_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'KEY_NOT_FOUND: key_id % does not exist', p_key_id;
  END IF;

  IF NOT v_row.is_active THEN
    RAISE EXCEPTION 'KEY_INACTIVE: key_id % is deactivated', p_key_id;
  END IF;

  -- Lazy daily reset (DT-5): if daily_reset_at is in the past, reset counters
  IF v_row.daily_reset_at < NOW() THEN
    v_row.daily_spent_usd := 0;
    -- Advance by 24h intervals until in the future
    WHILE v_row.daily_reset_at < NOW() LOOP
      v_row.daily_reset_at := v_row.daily_reset_at + INTERVAL '24 hours';
    END LOOP;
  END IF;

  -- Check daily limit
  v_daily_spent := v_row.daily_spent_usd;
  v_daily_limit := v_row.daily_limit_usd;

  IF v_daily_limit IS NOT NULL AND (v_daily_spent + p_amount_usd) > v_daily_limit THEN
    RAISE EXCEPTION 'DAILY_LIMIT: daily spend would be % + % = %, limit is %',
      v_daily_spent, p_amount_usd, v_daily_spent + p_amount_usd, v_daily_limit;
  END IF;

  -- Check chain budget
  v_chain_key := p_chain_id::TEXT;
  v_current_bal := COALESCE((v_row.budget ->> v_chain_key)::NUMERIC, 0);

  IF v_current_bal < p_amount_usd THEN
    RAISE EXCEPTION 'INSUFFICIENT_BUDGET: chain % balance is %, requested %',
      v_chain_key, v_current_bal, p_amount_usd;
  END IF;

  -- Debit
  v_new_bal := v_current_bal - p_amount_usd;

  UPDATE a2a_agent_keys
  SET
    budget          = jsonb_set(budget, ARRAY[v_chain_key], to_jsonb(v_new_bal::TEXT)),
    daily_spent_usd = v_row.daily_spent_usd + p_amount_usd,
    daily_reset_at  = v_row.daily_reset_at,
    last_used_at    = NOW()
  WHERE id = p_key_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

### Down Migration: `supabase/migrations/20260406000000_a2a_agent_keys_down.sql`

```sql
-- ============================================================
-- Down Migration: 20260406000000_a2a_agent_keys
-- WKH-34: Drops all objects created by the up migration
-- Idempotent: safe to run multiple times
-- ============================================================

DROP TRIGGER IF EXISTS set_updated_at ON a2a_agent_keys;
DROP FUNCTION IF EXISTS increment_a2a_key_spend(UUID, INT, NUMERIC);
DROP TABLE IF EXISTS a2a_agent_keys;
-- Note: trigger_set_updated_at() is NOT dropped (shared with tasks table)
```

---

## Type Definitions (`src/types/a2a-key.ts`)

```typescript
// ============================================================
// A2A AGENT KEY TYPES (WKH-34 -- Agentic Economy L3)
// ============================================================

// --- DB Row ---

export interface A2AAgentKeyRow {
  id: string                          // UUID
  owner_ref: string
  key_hash: string
  display_name: string | null
  budget: Record<string, string>      // {"2368": "10.00"}
  daily_limit_usd: string | null      // NUMERIC comes as string from Supabase
  daily_spent_usd: string             // NUMERIC comes as string
  daily_reset_at: string              // ISO timestamp
  allowed_registries: string[] | null
  allowed_agent_slugs: string[] | null
  allowed_categories: string[] | null
  max_spend_per_call_usd: string | null
  is_active: boolean
  last_used_at: string | null
  created_at: string
  updated_at: string
  erc8004_identity: Record<string, unknown> | null
  kite_passport: Record<string, unknown> | null
  agentkit_wallet: Record<string, unknown> | null
  metadata: Record<string, unknown>
}

// --- Service inputs ---

export interface CreateKeyInput {
  owner_ref: string
  display_name?: string
  daily_limit_usd?: number
  allowed_registries?: string[]
  allowed_agent_slugs?: string[]
  allowed_categories?: string[]
  max_spend_per_call_usd?: number
}

export interface DepositInput {
  key_id: string
  chain_id: number
  token: string
  amount: string        // amount string e.g. "10.00"
  tx_hash: string
}

// --- AuthzService ---

export interface AuthzTarget {
  registry?: string
  agent_slug?: string
  category?: string
  estimated_cost_usd?: number
}

export interface AuthzResult {
  allowed: boolean
  reason?: string
}

// --- API response shapes ---

export interface AgentSignupResponse {
  key: string           // plaintext wasi_a2a_xxx (returned once)
  key_id: string        // UUID
}

export interface DepositResponse {
  balance: string
  chain_id: number
}

export interface AgentMeResponse {
  key_id: string
  display_name: string | null
  budget: Record<string, string>
  daily_limit_usd: string | null
  daily_spent_usd: string
  daily_reset_at: string
  scoping: {
    allowed_registries: string[] | null
    allowed_agent_slugs: string[] | null
    allowed_categories: string[] | null
    max_spend_per_call_usd: string | null
  }
  is_active: boolean
  bindings: {
    erc8004_identity: Record<string, unknown> | null
    kite_passport: Record<string, unknown> | null
    agentkit_wallet: Record<string, unknown> | null
  }
  created_at: string
}

// --- Middleware error codes (AC-19) ---

export type A2AKeyErrorCode =
  | 'KEY_INVALID'
  | 'KEY_INACTIVE'
  | 'DAILY_LIMIT'
  | 'INSUFFICIENT_BUDGET'
  | 'SCOPE_DENIED'

export interface A2AKeyError {
  error: string
  code: A2AKeyErrorCode
}
```

---

## Service Interfaces

### IdentityService (`src/services/identity.ts`)

Pattern: `export const identityService = { ... }` (follow `src/services/event.ts`)

```
identityService = {
  createKey(input: CreateKeyInput): Promise<AgentSignupResponse>
    1. Generate 32 random bytes via crypto.randomBytes(32)
    2. Encode as hex, prepend "wasi_a2a_" prefix -> plaintext key (73 chars)
    3. Compute SHA-256 hash via crypto.createHash('sha256').update(plaintext).digest('hex')
    4. Insert row into a2a_agent_keys with key_hash, owner_ref, scoping fields
    5. Return { key: plaintext, key_id: row.id }
    -- Plaintext NEVER stored. NEVER logged.

  lookupByHash(key_hash: string): Promise<A2AAgentKeyRow | null>
    1. SELECT * FROM a2a_agent_keys WHERE key_hash = $1
    2. Return row or null

  deactivate(key_id: string): Promise<void>
    1. UPDATE a2a_agent_keys SET is_active = false WHERE id = $1
    2. (updated_at handled by trigger)
}
```

Imports:
- `import crypto from 'node:crypto'`
- `import { supabase } from '../lib/supabase.js'`
- `import type { A2AAgentKeyRow, CreateKeyInput, AgentSignupResponse } from '../types/index.js'`

### BudgetService (`src/services/budget.ts`)

Pattern: `export const budgetService = { ... }`

```
budgetService = {
  getBalance(key_id: string, chain_id: number): Promise<string>
    1. SELECT budget FROM a2a_agent_keys WHERE id = $1
    2. Return budget[chain_id.toString()] or "0"

  debit(key_id: string, chain_id: number, amount_usd: number): Promise<{ success: boolean; error?: string }>
    1. Call Postgres function: supabase.rpc('increment_a2a_key_spend', { p_key_id, p_chain_id, p_amount_usd })
    2. Catch error and parse error code from message prefix (KEY_NOT_FOUND, KEY_INACTIVE, DAILY_LIMIT, INSUFFICIENT_BUDGET)
    3. Return { success: true } or { success: false, error: "CODE: ..." }

  registerDeposit(key_id: string, chain_id: number, amount_usd: string): Promise<string>
    1. supabase.from('a2a_agent_keys').select('budget').eq('id', key_id).single()
    2. Parse current balance for chain_id (default "0")
    3. Add amount_usd to current balance (string arithmetic or parseFloat + toFixed(6))
    4. supabase.from('a2a_agent_keys').update({ budget: newBudget }).eq('id', key_id)
    5. Return new balance as string
    -- No FOR UPDATE needed: deposits are additive, worst case is slight over-credit (acceptable)
}
```

Imports:
- `import { supabase } from '../lib/supabase.js'`
- `import type { A2AAgentKeyRow } from '../types/index.js'`

### AuthzService (`src/services/authz.ts`)

Pattern: `export const authzService = { ... }`

```
authzService = {
  checkScoping(key_row: A2AAgentKeyRow, target: AuthzTarget): AuthzResult
    -- Pure function, no async, no DB
    1. If key_row.allowed_registries is non-null and non-empty:
       check target.registry is in the array. If not: {allowed: false, reason: "SCOPE_DENIED: registry not in allowed list"}
    2. If key_row.allowed_agent_slugs is non-null and non-empty:
       check target.agent_slug is in the array. If not: {allowed: false, reason: "SCOPE_DENIED: agent not in allowed list"}
    3. If key_row.allowed_categories is non-null and non-empty:
       check target.category is in the array. If not: {allowed: false, reason: "SCOPE_DENIED: category not in allowed list"}
    4. If key_row.max_spend_per_call_usd is not null AND target.estimated_cost_usd is defined:
       check target.estimated_cost_usd <= parseFloat(key_row.max_spend_per_call_usd). If not: {allowed: false, reason: "SCOPE_DENIED: estimated cost exceeds per-call limit"}
    5. Return {allowed: true}
}
```

Imports:
- `import type { A2AAgentKeyRow, AuthzTarget, AuthzResult } from '../types/index.js'`
- No supabase import (pure function)

---

## Middleware Design (`src/middleware/a2a-key.ts`)

**Pattern**: Follow `src/middleware/x402.ts` for the `declare module 'fastify'` augmentation and factory pattern.

**Key design decision (DT-MIDDLEWARE from SDD)**: Export a single factory `requirePaymentOrA2AKey(opts)` that wraps both a2a-key validation AND x402 fallback internally. This replaces `requirePayment()` in compose/orchestrate routes with a single import change.

```
declare module 'fastify' {
  interface FastifyRequest {
    a2aKeyRow?: A2AAgentKeyRow
    a2aKeyId?: string
    a2aRemainingBudget?: string
  }
}

export function requirePaymentOrA2AKey(x402Opts: PaymentMiddlewareOptions): preHandlerHookHandler[]
  Returns array with one async handler:
  1. Check request.headers['x-a2a-key']
  2. If ABSENT: delegate to x402 -- call the requirePayment(x402Opts) handler directly
     (import requirePayment from './x402.js' and invoke its handler)
  3. If PRESENT:
     a. Hash with SHA-256: crypto.createHash('sha256').update(headerValue).digest('hex')
     b. identityService.lookupByHash(hash)
     c. If not found: reply 403 { error: "API key not found", code: "KEY_INVALID" }
     d. If not active: reply 403 { error: "API key is deactivated", code: "KEY_INACTIVE" }
     e. Check daily limit: if daily_limit_usd is set and daily_spent_usd >= daily_limit_usd
        reply 403 { error: "Daily spending limit exceeded", code: "DAILY_LIMIT" }
     f. Check scoping: authzService.checkScoping(row, target from request body)
        If denied: reply 403 { error: reason, code: "SCOPE_DENIED" }
     g. Augment request: request.a2aKeyRow = row, request.a2aKeyId = row.id
     h. Set request.kitePaymentVerified = true (so x402 knows payment is handled)
     i. Return (continue to route handler)
  4. Post-execution debit (via onResponse hook or reply.then):
     -- TODO(WKH-35): use PaymentAdapter.quote() for actual cost
     -- For now: debit amount = 0 (stub, effectively free during testnet)
     -- Set reply header 'x-a2a-remaining-budget' with getBalance result
```

**Route modification pattern** (compose.ts and orchestrate.ts):

Before:
```typescript
import { requirePayment } from '../middleware/x402.js'
// ...
preHandler: requirePayment({ description: '...' })
```

After:
```typescript
import { requirePaymentOrA2AKey } from '../middleware/a2a-key.js'
// ...
preHandler: requirePaymentOrA2AKey({ description: '...' })
```

**Auth helper for /deposit and /me routes** (inline in `src/routes/auth.ts`):

```
async function resolveCallerKey(request: FastifyRequest): Promise<A2AAgentKeyRow | null>
  1. Get x-a2a-key header
  2. If absent: return null
  3. Hash with SHA-256
  4. identityService.lookupByHash(hash)
  5. Return row or null
```

---

## Constraint Directives

### OBLIGATORIO
- CD-1: Down migration must be idempotent and drop all objects (table, function, indexes, trigger)
- CD-2: `increment_a2a_key_spend` must use `FOR UPDATE` row lock and `SECURITY DEFINER`
- CD-4: Plaintext key returned ONLY in POST /auth/agent-signup response. Never stored. Never logged.
- CD-6: TypeScript strict. No `any`. All new types in `src/types/a2a-key.ts`
- CD-7: Every new endpoint and service method must have at least 1 test
- CD-9: Fastify request augmentation uses `declare module 'fastify'` (see x402.ts exemplar)
- CD-NEW-1: Test files MUST be co-located with source files (e.g., `src/services/identity.test.ts`), NOT in a `test/` directory
- CD-NEW-2: Services use `export const xxxService = { ... }` pattern (not classes)
- CD-NEW-3: Route files use `FastifyPluginAsync` and `export default`
- CD-NEW-4: All Supabase operations use the singleton from `src/lib/supabase.ts`
- CD-NEW-5: Do NOT redefine `trigger_set_updated_at()` in the new migration -- it already exists from `20260403180000_tasks.sql`. Just create the trigger that uses it.
- CD-NEW-6: `requirePaymentOrA2AKey()` must import and delegate to `requirePayment()` from x402.ts for the fallback path. Do NOT duplicate x402 logic.

### PROHIBIDO
- CD-3: No shared tables with wasiai-v2. No FK to `auth.users`.
- CD-5: No `ethers.js`. All crypto via Node.js `crypto` module.
- CD-8: No hardcoded chain IDs, RPC URLs, or token addresses in services.
- CD-P-1: Do NOT modify `src/middleware/x402.ts`.
- CD-P-2: Do NOT create a `test/` directory. Tests are co-located.
- CD-P-3: Do NOT add new npm dependencies. `crypto` is built-in. Supabase client exists.
- CD-P-4: Do NOT log plaintext keys. Not in request logs, not in error messages, not in console output.
- CD-P-5: Do NOT create RateLimitService or PricingService (Scope OUT).

---

## Test Expectations

| Test file | ACs covered | Framework | Type | Wave |
|-----------|-------------|-----------|------|------|
| `src/services/identity.test.ts` | AC-5, AC-6, AC-7 | vitest | unit | W2 |
| `src/services/budget.test.ts` | AC-8, AC-9, AC-10, AC-11 | vitest | unit | W2 |
| `src/services/authz.test.ts` | AC-12 | vitest | unit | W2 |
| `src/routes/auth.test.ts` | AC-13, AC-14, AC-15, AC-16 | vitest | integration | W3 |
| `src/middleware/a2a-key.test.ts` | AC-17, AC-18, AC-19 | vitest | integration | W4 |

### Test details

**identity.test.ts** (mock supabase):
- createKey returns `{ key: "wasi_a2a_<64hex>", key_id: "uuid" }` -- verify prefix, length 73, hex chars
- createKey stores SHA-256 hash (not plaintext) -- verify hash matches `crypto.createHash('sha256').update(key).digest('hex')`
- lookupByHash returns row when found, null when not
- deactivate sets is_active = false

**budget.test.ts** (mock supabase):
- getBalance returns "0" for missing chain
- getBalance returns correct balance for existing chain
- debit calls `supabase.rpc('increment_a2a_key_spend', ...)` and returns `{ success: true }`
- debit returns `{ success: false, error: "DAILY_LIMIT: ..." }` on Postgres exception
- debit returns `{ success: false, error: "INSUFFICIENT_BUDGET: ..." }` on Postgres exception
- registerDeposit increments chain budget and returns new balance string

**authz.test.ts** (no mocks needed, pure function):
- Empty/null arrays -> allowed: true (no restrictions)
- Non-empty allowed_registries, target matches -> allowed: true
- Non-empty allowed_registries, target does NOT match -> allowed: false with reason
- Same for allowed_agent_slugs, allowed_categories
- max_spend_per_call_usd set, estimated_cost within -> allowed: true
- max_spend_per_call_usd set, estimated_cost exceeds -> allowed: false
- Combined checks: multiple scoping rules applied

**auth.test.ts** (mock services, use fastify.inject):
- POST /agent-signup with valid body -> 201 + key + key_id
- POST /agent-signup missing owner_ref -> 400
- POST /deposit with valid key and ownership -> 200 + balance
- POST /deposit with invalid key -> 403
- POST /deposit with key not owned by caller -> 403
- GET /me with valid key -> 200 + full status object
- GET /me with invalid key -> 403
- POST /bind/:chain -> 501 with not_implemented message

**a2a-key.test.ts** (mock services, use fastify.inject or direct handler calls):
- Request with x-a2a-key header, valid key -> passes through, request.a2aKeyRow set
- Request without x-a2a-key header -> falls through to x402
- Request with invalid key -> 403 + KEY_INVALID
- Request with inactive key -> 403 + KEY_INACTIVE
- Request with key over daily limit -> 403 + DAILY_LIMIT
- Request with key failing scoping -> 403 + SCOPE_DENIED

### Criterio Test-First

| Tipo de cambio | Test-first? |
|----------------|-------------|
| Services (identity, budget, authz) | Si |
| Routes (/auth/*) | Si |
| Middleware (a2a-key) | Si |
| Types (a2a-key.ts) | No |
| Migration SQL | No |
| index.ts registration | No |

---

## Waves

### Wave -1: Environment Gate (OBLIGATORIO -- verificar antes de tocar codigo)

```bash
# Verify dependencies installed
npm install 2>/dev/null || echo "Sin package.json"

# Verify env vars needed for DB migration
echo "SUPABASE_URL=${SUPABASE_URL:?FALTA}" 2>/dev/null || true
echo "DATABASE_URL=${DATABASE_URL:?FALTA}" 2>/dev/null || true

# Verify base files exist
ls src/types/index.ts src/middleware/x402.ts src/lib/supabase.ts src/routes/compose.ts src/routes/orchestrate.ts src/index.ts 2>/dev/null || echo "FALTA archivo base"

# Verify migration dependency exists (trigger_set_updated_at)
ls supabase/migrations/20260403180000_tasks.sql 2>/dev/null || echo "FALTA migration tasks (trigger_set_updated_at)"

# Verify tsc and tests pass before starting
npx tsc --noEmit && npx vitest run
```

**Si algo falla en Wave -1:** PARAR y reportar al orquestador antes de continuar.

### Wave 1: Types + DB Migration (Serial gate -- completar antes de todo)

- [ ] W1.1: Create `src/types/a2a-key.ts` with all type definitions from section "Type Definitions" above
- [ ] W1.2: Modify `src/types/index.ts` -- add `export * from './a2a-key.js'` at the end of the file
- [ ] W1.3: Create `supabase/migrations/20260406000000_a2a_agent_keys.sql` -- copy verbatim from "Migration SQL" section above
- [ ] W1.4: Create `supabase/migrations/20260406000000_a2a_agent_keys_down.sql` -- copy verbatim from "Migration SQL" section above

**Verification W1:**
```bash
npx tsc --noEmit           # Types compile
supabase db reset           # Migration applies cleanly (up + down tested via reset)
```

### Wave 2: Services + Unit Tests (Parallelizable within wave)

- [ ] W2.1: Create `src/services/identity.ts` -- follow `src/services/event.ts` pattern. Implements createKey, lookupByHash, deactivate per "Service Interfaces" section.
- [ ] W2.2: Create `src/services/identity.test.ts` -- mock supabase. Test key format, hash correctness, lookup, deactivate.
- [ ] W2.3: Create `src/services/budget.ts` -- follow `src/services/event.ts` pattern. Implements getBalance, debit (via supabase.rpc), registerDeposit.
- [ ] W2.4: Create `src/services/budget.test.ts` -- mock supabase. Test balance queries, debit success/failure, deposit increment.
- [ ] W2.5: Create `src/services/authz.ts` -- follow `src/services/event.ts` pattern. Implements checkScoping as pure function.
- [ ] W2.6: Create `src/services/authz.test.ts` -- no mocks needed. Test all scoping combinations.

**Verification W2:**
```bash
npx tsc --noEmit
npx vitest run src/services/identity.test.ts src/services/budget.test.ts src/services/authz.test.ts
```

### Wave 3: Endpoints + Route Tests

- [ ] W3.1: Create `src/routes/auth.ts` -- follow `src/routes/gasless.ts` pattern. Implements POST /agent-signup, POST /deposit, GET /me, POST /bind/:chain. Include local `resolveCallerKey()` helper for deposit and me endpoints.
- [ ] W3.2: Create `src/routes/auth.test.ts` -- follow `src/routes/tasks.test.ts` pattern. Use fastify.inject(). Mock identityService, budgetService.
- [ ] W3.3: Modify `src/index.ts` -- add `import authRoutes from './routes/auth.js'` at top and `await fastify.register(authRoutes, { prefix: '/auth' })` after the gasless registration line.

**Verification W3:**
```bash
npx tsc --noEmit
npx vitest run src/routes/auth.test.ts
npx vitest run   # full suite: all 119 existing + new tests pass
```

### Wave 4: Middleware + Integration (BLOCKED by WKH-35 for debit amount)

> **NOTE**: W4 can be implemented structurally (middleware skeleton + route wiring) without WKH-35. The only stub is the debit amount (= 0 until PaymentAdapter.quote() exists). Implement W4 when WKH-35 merges, OR implement the skeleton now with the stub and complete the debit later.

- [ ] W4.1: Create `src/middleware/a2a-key.ts` -- follow `src/middleware/x402.ts` pattern. Implements `requirePaymentOrA2AKey()` factory per "Middleware Design" section. Import `requirePayment` from x402.ts for fallback path. Debit stub: amount = 0 with `// TODO(WKH-35): use PaymentAdapter.quote() for actual cost`.
- [ ] W4.2: Create `src/middleware/a2a-key.test.ts` -- mock identityService, budgetService, authzService, and x402 requirePayment. Test all 6 scenarios from test plan.
- [ ] W4.3: Modify `src/routes/compose.ts` -- change import from `requirePayment` (x402) to `requirePaymentOrA2AKey` (a2a-key). Change preHandler.
- [ ] W4.4: Modify `src/routes/orchestrate.ts` -- same change as compose.ts.

**Verification W4:**
```bash
npx tsc --noEmit
npx vitest run src/middleware/a2a-key.test.ts
npx vitest run   # full suite: all existing + all new tests pass
```

### Verificacion Incremental

| Wave | Verificacion al completar |
|------|--------------------------|
| W-1 | Environment healthy, tsc + tests pass (baseline) |
| W1 | tsc passes with new types, `supabase db reset` applies migration |
| W2 | tsc + 3 new service test files pass |
| W3 | tsc + route test passes, full suite (119 existing + new) green |
| W4 | tsc + middleware test passes, full suite green |

---

## Anti-Hallucination Checklist

- [ ] Verified migration SQL compiles (use `supabase db reset`)
- [ ] Verified `trigger_set_updated_at()` is NOT redefined (only referenced in trigger)
- [ ] Verified IdentityService key generation uses `crypto.randomBytes(32)` (not `Math.random` or `uuid`)
- [ ] Verified key format is `wasi_a2a_` + 64 hex chars = 73 chars total
- [ ] Verified SHA-256 hash via `crypto.createHash('sha256').update(plaintext).digest('hex')`
- [ ] Verified BudgetService.debit calls Postgres function via `supabase.rpc('increment_a2a_key_spend', ...)` (not inline SQL)
- [ ] Verified BudgetService.registerDeposit uses Supabase JS client read+update (no FOR UPDATE needed for additive ops)
- [ ] Verified AuthzService.checkScoping is a pure synchronous function (no async, no DB)
- [ ] Verified middleware uses `declare module 'fastify'` for request augmentation (`a2aKeyRow`, `a2aKeyId`, `a2aRemainingBudget`)
- [ ] Verified `requirePaymentOrA2AKey()` imports `requirePayment` from x402.ts -- does NOT duplicate x402 logic
- [ ] Verified x402.ts is NOT modified (CD-P-1)
- [ ] Verified all test files are co-located (src/, not test/)
- [ ] Verified no plaintext keys in logs, errors, or DB
- [ ] After each wave: `npx tsc --noEmit` + `npx vitest run`

---

## Out of Scope

- Multi-chain simultaneous deposit/spend (per-chain budget stored but arbitrage is Fase 2)
- ERC-8004 real on-chain binding flow (POST /auth/bind/:chain returns 501)
- Kite Passport adapter
- On-chain deposit verification (PaymentAdapter.verify from WKH-35 -- stub with trust + log warning)
- RateLimitService (hourly caps, per-call throttling)
- PricingService (USD to token conversion)
- Changes to existing x402 middleware file (`src/middleware/x402.ts`)
- Admin endpoints for key management (list all, revoke)
- Files outside the 17-file scope table above
- NO "improving" adjacent code
- NO adding functionality not listed

---

## Escalation Rule

> **Si algo no esta en este Story File, Dev PARA y pregunta a Architect.**
> No inventar. No asumir. No improvisar.

Situaciones de escalation:
- A base file (x402.ts, supabase.ts, event.ts) has changed and no longer matches the exemplar pattern
- An import path does not resolve
- `trigger_set_updated_at()` does not exist in the DB (tasks migration not applied)
- Supabase `.rpc()` call for `increment_a2a_key_spend` behaves unexpectedly
- Any ambiguity in an AC
- The change requires touching files outside the 17-file scope table

---

## Done Definition

- [ ] `npx tsc --noEmit` clean (zero errors)
- [ ] All tests pass: 119 existing + new tests (expected ~135+ total)
- [ ] `supabase db reset` applies migration cleanly (up + down)
- [ ] POST /auth/agent-signup returns `{ key: "wasi_a2a_...", key_id: UUID }` with 201
- [ ] GET /auth/me with valid x-a2a-key returns full status object with 200
- [ ] POST /auth/deposit with valid key and ownership returns `{ balance, chain_id }` with 200
- [ ] POST /auth/bind/:chain returns 501
- [ ] Middleware on /compose accepts x-a2a-key and falls back to x402 when absent
- [ ] No plaintext keys stored in DB or logged
- [ ] All 5 error codes (KEY_INVALID, KEY_INACTIVE, DAILY_LIMIT, INSUFFICIENT_BUDGET, SCOPE_DENIED) tested

---

*Story File generado por NexusAgil -- F2.5*
