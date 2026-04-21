# SDD #024: Agentic Economy Primitives L3

> SPEC_APPROVED: no
> Fecha: 2026-04-06
> Tipo: feature
> SDD_MODE: full
> Case Type: DB-MIGRATION
> Branch: feat/024-agentic-economy-l3
> Artefactos: doc/sdd/024-agentic-economy-l3/

---

## 1. Resumen

Implement wasiai-a2a's own off-chain, chain-agnostic identity/budget/authorization primitives as defined in `doc/architecture/CHAIN-ADAPTIVE.md` L3. This creates the `a2a_agent_keys` table, a Postgres `increment_a2a_key_spend` function, three domain services (IdentityService, BudgetService, AuthzService), four `/auth/*` REST endpoints, and an optional `x-a2a-key` Fastify preHandler middleware that coexists with the existing x402 flow. The goal is to decouple identity from Kite Passport and give agents a pre-paid budget model with daily caps and scoped permissions.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 024 (WKH-34) |
| **Tipo** | feature |
| **SDD_MODE** | full |
| **Case Type** | DB-MIGRATION |
| **Objetivo** | Create L3 agentic economy primitives: identity keys, per-chain budget, scoped authorization, REST endpoints, optional a2a-key middleware |
| **Reglas de negocio** | Key returned once (never stored plaintext). Budget per-chain in JSONB. Daily limit lazy-reset in Postgres. Middleware precedence: a2a-key BEFORE x402. |
| **Scope IN** | 13 new files + 4 modified (see section 4.1) |
| **Scope OUT** | Multi-chain arbitrage, ERC-8004 real binding, Kite Passport adapter, on-chain deposit verification (WKH-35), RateLimitService, PricingService, admin endpoints |
| **Missing Inputs** | Two [TBD] items resolved as stubs (see section 10) |

### Acceptance Criteria (EARS)

Inherited verbatim from work-item.md: AC-1 through AC-19. See `doc/sdd/024-agentic-economy-l3/work-item.md` sections "Data Layer", "IdentityService", "BudgetService", "AuthzService", "L4 Endpoints", "Middleware" for full EARS text.

---

## 3. Context Map (Codebase Grounding)

### Archivos leidos

| Archivo | Por que | Patron extraido |
|---------|---------|-----------------|
| `src/middleware/x402.ts` | Understand existing payment middleware for DT-4 precedence design | `requirePayment()` returns `preHandlerHookHandler[]`; uses `declare module 'fastify'` for request augmentation (`kiteTxHash`, `kitePaymentVerified`); async handler with early-return pattern via `reply.status().send()` |
| `src/types/index.ts` | Understand type organization | Flat file with grouped sections by domain (`// === SECTION ===`); exports interfaces and const arrays; no classes |
| `src/routes/compose.ts` | Understand Fastify route registration | `FastifyPluginAsync` pattern; inline `type Body`; `preHandler` array from middleware; try/catch with `reply.status(N).send({error})` |
| `src/routes/orchestrate.ts` | Understand route + middleware integration | Same plugin pattern; `schema.body` for validation; `requirePayment` in preHandler; `crypto.randomUUID()` usage |
| `src/routes/gasless.ts` | Understand route without payment middleware | Same plugin pattern; no preHandler; defensive error logging with sanitized messages |
| `src/services/event.ts` | Understand service layer | Exported const object with async methods; `supabase` import from `../lib/supabase.js`; internal `Row` interface + `rowToDomain()` mapper |
| `src/lib/supabase.ts` | Understand DB client | Singleton `SupabaseClient` via `createClient`; uses `SUPABASE_SERVICE_KEY` (not anon); validates env on import |
| `src/index.ts` | Understand route registration | `await fastify.register(routes, { prefix })` pattern; imports at top of file |
| `supabase/migrations/20260401000000_kite_registries.sql` | Understand migration naming | `YYYYMMDD_name.sql` format; `CREATE TABLE IF NOT EXISTS`; `CREATE INDEX IF NOT EXISTS` |
| `supabase/migrations/20260403180000_tasks.sql` | Understand trigger + function pattern | `CREATE OR REPLACE FUNCTION trigger_set_updated_at()` already exists (reusable); `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER` pattern |
| `supabase/migrations/20260404200000_events.sql` | Understand index patterns | Separate indexes for each query pattern; `NUMERIC(12,6)` for USD amounts |
| `doc/architecture/CHAIN-ADAPTIVE.md` | L3 schema + L4 endpoints + identity posture | Table schema verbatim; `increment_a2a_key_spend` function signature; middleware behavior spec; decoupling rules |

### Exemplars

| Para crear/modificar | Seguir patron de | Razon |
|---------------------|------------------|-------|
| `src/middleware/a2a-key.ts` | `src/middleware/x402.ts` | Same `preHandlerHookHandler[]` factory pattern; same `declare module 'fastify'` augmentation |
| `src/routes/auth.ts` | `src/routes/gasless.ts` | Route plugin without payment middleware; multiple endpoints in one plugin |
| `src/services/identity.ts` | `src/services/event.ts` | Same service-as-const-object pattern; same supabase import; same Row-to-Domain mapper |
| `src/services/budget.ts` | `src/services/event.ts` | Same pattern |
| `src/services/authz.ts` | `src/services/event.ts` | Same pattern (pure function, no DB) |
| `src/types/a2a-key.ts` | `src/types/index.ts` | Grouped interfaces with section comments |
| `supabase/migrations/YYYYMMDD_a2a_agent_keys.sql` | `supabase/migrations/20260403180000_tasks.sql` | Reuse `trigger_set_updated_at()` function; same `CREATE TABLE IF NOT EXISTS` + index pattern |
| Test files (`*.test.ts`) | `src/services/compose.test.ts` | Co-located in same directory as source (NOT in `test/` directory); vitest |

### Estado de BD relevante

| Tabla | Existe | Columnas relevantes |
|-------|--------|---------------------|
| `a2a_agent_keys` | No (to create) | See section 4.2 |
| `registries` | Si | Used by AuthzService for scoping validation (read-only) |
| `a2a_events` | Si | Not modified; referenced for event tracking in middleware |

### Componentes reutilizables encontrados

- `trigger_set_updated_at()` in `supabase/migrations/20260403180000_tasks.sql` -- reuse for `a2a_agent_keys.updated_at` trigger (already `CREATE OR REPLACE`)
- `supabase` singleton in `src/lib/supabase.ts` -- reuse for all DB operations
- `crypto` from `node:crypto` -- already used in `src/routes/orchestrate.ts` (`crypto.randomUUID()`)

### CRITICAL: Test file location correction

The work-item lists test files under `test/` directory. The codebase uses **co-located tests** (e.g., `src/services/compose.test.ts`, `src/routes/tasks.test.ts`). The SDD corrects this: all test files go alongside their source files.

---

## 4. Diseno Tecnico

### 4.1 Archivos a crear/modificar

| Archivo | Accion | Descripcion | Wave | Exemplar |
|---------|--------|-------------|------|----------|
| `src/types/a2a-key.ts` | Crear | Types for agent keys, budget, scoping, API request/response shapes | W1 | `src/types/index.ts` |
| `src/types/index.ts` | Modificar | Add `export * from './a2a-key.js'` re-export | W1 | Existing re-export pattern (N/A -- first re-export, but follows TS barrel pattern) |
| `supabase/migrations/20260406000000_a2a_agent_keys.sql` | Crear | Up migration: table + function + indexes + trigger | W1 | `supabase/migrations/20260403180000_tasks.sql` |
| `supabase/migrations/20260406000000_a2a_agent_keys_down.sql` | Crear | Down migration: drop trigger, function, table | W1 | N/A (convention from work-item CD-1) |
| `src/services/identity.ts` | Crear | IdentityService: createKey, lookupByHash, deactivate | W2 | `src/services/event.ts` |
| `src/services/budget.ts` | Crear | BudgetService: getBalance, debit, registerDeposit | W2 | `src/services/event.ts` |
| `src/services/authz.ts` | Crear | AuthzService: checkScoping (pure function, no DB) | W2 | `src/services/event.ts` |
| `src/services/identity.test.ts` | Crear | Unit tests for IdentityService | W2 | `src/services/compose.test.ts` |
| `src/services/budget.test.ts` | Crear | Unit tests for BudgetService | W2 | `src/services/compose.test.ts` |
| `src/services/authz.test.ts` | Crear | Unit tests for AuthzService | W2 | `src/services/compose.test.ts` |
| `src/routes/auth.ts` | Crear | /auth/* endpoints: agent-signup, deposit, me, bind/:chain | W3 | `src/routes/gasless.ts` |
| `src/routes/auth.test.ts` | Crear | Route tests for /auth/* | W3 | `src/routes/tasks.test.ts` |
| `src/index.ts` | Modificar | Register auth routes with `{ prefix: '/auth' }` | W3 | Existing route registration pattern |
| `src/middleware/a2a-key.ts` | Crear | x-a2a-key preHandler middleware | W4 | `src/middleware/x402.ts` |
| `src/middleware/a2a-key.test.ts` | Crear | Middleware tests | W4 | `src/lib/gasless-signer.test.ts` |
| `src/routes/compose.ts` | Modificar | Add a2a-key preHandler before x402 | W4 | Current `preHandler: requirePayment(...)` pattern |
| `src/routes/orchestrate.ts` | Modificar | Add a2a-key preHandler before x402 | W4 | Current `preHandler: requirePayment(...)` pattern |

**Total: 13 new files + 4 modified = 17 files**

### 4.2 Modelo de datos

#### Up Migration: `supabase/migrations/20260406000000_a2a_agent_keys.sql`

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

#### Down Migration: `supabase/migrations/20260406000000_a2a_agent_keys_down.sql`

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

### 4.3 Type Definitions (`src/types/a2a-key.ts`)

```typescript
// ============================================================
// A2A AGENT KEY TYPES (WKH-34 — Agentic Economy L3)
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

### 4.4 Service Interfaces

#### IdentityService (`src/services/identity.ts`)

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

#### BudgetService (`src/services/budget.ts`)

```
budgetService = {
  getBalance(key_id: string, chain_id: number): Promise<string>
    1. SELECT budget FROM a2a_agent_keys WHERE id = $1
    2. Return budget[chain_id.toString()] or "0"

  debit(key_id: string, chain_id: number, amount_usd: number): Promise<{ success: boolean; error?: string }>
    1. Call Postgres function: SELECT increment_a2a_key_spend($1, $2, $3)
    2. Catch RAISE EXCEPTION and parse error code from message prefix
    3. Return { success: true } or { success: false, error: "DAILY_LIMIT: ..." }

  registerDeposit(key_id: string, chain_id: number, amount_usd: string): Promise<string>
    1. SELECT budget FROM a2a_agent_keys WHERE id = $1 FOR UPDATE
    2. Parse current balance for chain_id (default "0")
    3. Add amount_usd to current balance
    4. UPDATE a2a_agent_keys SET budget = jsonb_set(budget, ...) WHERE id = $1
    5. Return new balance as string
}
```

**Note on `registerDeposit`**: Uses Supabase client `.rpc()` for the select-for-update + jsonb_set update pattern. Alternative: create a small Postgres function `register_a2a_deposit(p_key_id UUID, p_chain_id INT, p_amount NUMERIC)`. Decision: use raw SQL via `supabase.rpc('increment_a2a_key_budget', ...)` -- BUT since Supabase JS client does not support raw SQL easily with FOR UPDATE, the Dev should implement this as either:
- (a) A second Postgres function in the migration, OR
- (b) A single `.from('a2a_agent_keys').select().eq('id', key_id).single()` followed by `.update()` (without explicit FOR UPDATE -- acceptable for deposit since worst case is a slight over-credit, not a double-spend)

Decision: **(b)** -- no FOR UPDATE needed for deposits. Budget increases are additive and idempotent-safe. The Dev uses Supabase JS client read + update. `increment_a2a_key_spend` (debits) is the one that needs atomicity, and it already has it via `FOR UPDATE` in the Postgres function.

#### AuthzService (`src/services/authz.ts`)

```
authzService = {
  checkScoping(key_row: A2AAgentKeyRow, target: AuthzTarget): AuthzResult
    -- Pure function, no async, no DB
    1. If key_row.allowed_registries is non-null and non-empty:
       check target.registry is in the array. If not: return {allowed: false, reason: "SCOPE_DENIED: registry not in allowed list"}
    2. If key_row.allowed_agent_slugs is non-null and non-empty:
       check target.agent_slug is in the array. If not: return {allowed: false, reason: "SCOPE_DENIED: agent not in allowed list"}
    3. If key_row.allowed_categories is non-null and non-empty:
       check target.category is in the array. If not: return {allowed: false, reason: "SCOPE_DENIED: category not in allowed list"}
    4. If key_row.max_spend_per_call_usd is not null AND target.estimated_cost_usd is defined:
       check target.estimated_cost_usd <= parseFloat(key_row.max_spend_per_call_usd). If not: return {allowed: false, reason: "SCOPE_DENIED: estimated cost exceeds per-call limit"}
    5. Return {allowed: true}
}
```

### 4.5 Route Handlers (`src/routes/auth.ts`)

```
FastifyPluginAsync registered at prefix '/auth'

POST /agent-signup
  Body: { owner_ref: string, display_name?: string, daily_limit_usd?: number, allowed_registries?: string[], allowed_agent_slugs?: string[], allowed_categories?: string[], max_spend_per_call_usd?: number }
  Response 201: AgentSignupResponse { key, key_id }
  Errors: 400 (missing owner_ref)

POST /deposit
  Headers: x-a2a-key required (self-auth)
  Body: DepositInput { key_id, chain_id, token, amount, tx_hash }
  Validation: caller's key must own key_id (compare key_row.id === body.key_id)
  Response 200: DepositResponse { balance, chain_id }
  Errors: 400 (missing fields), 403 (invalid key / not owner), 501 ([TBD] on-chain verification stub)

GET /me
  Headers: x-a2a-key required
  Response 200: AgentMeResponse
  Errors: 403 (invalid/inactive key)

POST /bind/:chain
  Response 501: { status: "not_implemented", message: "On-chain identity binding is planned for Fase 2. See doc/architecture/CHAIN-ADAPTIVE.md" }
```

**Auth pattern for /deposit and /me**: These endpoints need to resolve the a2a-key inline (hash header, look up). This is NOT the same as the compose/orchestrate middleware (which also does budget check + scoping). The auth routes use a lightweight helper: hash the header, call `identityService.lookupByHash()`, check `is_active`. This helper can be a local function in `auth.ts` or extracted as a shared util. Decision: local function in `auth.ts` named `resolveCallerKey(request)` that returns `A2AAgentKeyRow | null`.

### 4.6 Middleware Design (`src/middleware/a2a-key.ts`)

```
Pattern: follows src/middleware/x402.ts exactly

declare module 'fastify' {
  interface FastifyRequest {
    a2aKeyRow?: A2AAgentKeyRow
    a2aKeyId?: string
    a2aRemainingBudget?: string
  }
}

export function requireA2AKeyOrFallthrough(): preHandlerHookHandler[]
  Returns array with one async handler:
  1. Check request.headers['x-a2a-key']
  2. If absent: return (no-op, falls through to next preHandler = x402)
  3. If present:
     a. Hash with SHA-256
     b. lookupByHash() via identityService
     c. If not found: reply 403 { error, code: 'KEY_INVALID' }
     d. If not active: reply 403 { error, code: 'KEY_INACTIVE' }
     e. Check daily limit (parse daily_spent_usd + estimated cost vs daily_limit_usd)
        If exceeded: reply 403 { error, code: 'DAILY_LIMIT' }
     f. Check scoping via authzService.checkScoping(row, target)
        target extracted from request body (registry, agent_slug, etc.)
        If denied: reply 403 { error, code: 'SCOPE_DENIED' }
     g. Augment request: request.a2aKeyRow = row, request.a2aKeyId = row.id
     h. Return (continue to route handler)
  4. AFTER route handler completes (via onResponse hook or reply.then):
     Debit via budgetService.debit(key_id, chain_id, actual_cost)
     Set reply header 'x-a2a-remaining-budget'
     -- [TBD] actual_cost estimation: until WKH-35 lands PaymentAdapter.quote(),
        use a fixed placeholder of 0 (debit skipped) or configurable per-endpoint default.
        The middleware skeleton is ready; debit amount is the only stub.
```

**Middleware precedence in compose/orchestrate routes**:

Current pattern:
```
preHandler: requirePayment({ description: '...' })
```

New pattern:
```
preHandler: [...requireA2AKeyOrFallthrough(), ...requirePayment({ description: '...' })]
```

When `x-a2a-key` is present, `requireA2AKeyOrFallthrough()` handles auth and sets `request.a2aKeyRow`. The route handler checks `request.a2aKeyRow` to decide whether x402 was used or a2a-key. When `x-a2a-key` is absent, the handler returns without setting anything, and `requirePayment` runs next (existing x402 flow).

**Key design: skip x402 when a2a-key is present**. The a2a-key handler, upon successful validation, sets `request.kitePaymentVerified = true` to signal to x402 that payment is already handled. This way x402's handler sees the flag and skips (add a guard at the top of x402 handler). ALTERNATIVELY: the a2a-key handler can call `reply.hijack()` or simply NOT add x402 to the chain. Decision: **simplest approach** -- a2a-key middleware, when key is valid, sets `request.kitePaymentVerified = true`. The existing x402 handler already checks for `xPaymentHeader` presence; adding a check for `request.kitePaymentVerified` is a one-line guard. This minimizes changes to x402.ts.

Wait -- re-reading x402.ts: it checks `if (!xPaymentHeader)` and returns 402. It does NOT check `kitePaymentVerified`. So the approach needs to be: either (a) modify x402 to skip when `kitePaymentVerified` is already true, or (b) structure the preHandler array so x402 is conditionally included.

Decision: **(a)** -- Add a single guard line at the top of the x402 handler: `if (request.kitePaymentVerified) return` (already paid via a2a-key). This is a 1-line change to x402.ts. BUT -- the work-item Scope IN does NOT include `src/middleware/x402.ts` in modified files. However, the alternative (conditional array) would require the route files to import both middlewares and build a conditional array, which is more complex. 

Revised decision: The preHandler array in compose/orchestrate routes is:
```
preHandler: [...requireA2AKeyOrFallthrough(), ...requirePayment({...})]
```
The a2a-key handler, when it successfully validates a key, short-circuits by NOT returning (it augments the request and continues). But x402 will then ALSO run and see no X-Payment header, returning 402. This is the problem.

**Final decision (DT-MIDDLEWARE)**: The a2a-key middleware factory accepts the x402 options and wraps both paths internally. Export a single factory:

```
export function requirePaymentOrA2AKey(x402Opts: PaymentMiddlewareOptions): preHandlerHookHandler[]
```

This returns a single handler that:
1. If `x-a2a-key` header present: validate a2a-key path (hash, lookup, scoping, etc.)
2. If absent: delegate to existing x402 logic (call the x402 handler directly)

This way compose/orchestrate routes change their preHandler from `requirePayment(opts)` to `requirePaymentOrA2AKey(opts)` -- a single import change per route. No modification to x402.ts needed. The a2a-key middleware internally imports `requirePayment` from x402.

### 4.7 Flujo principal (Happy Path)

#### Agent Signup
1. External developer calls `POST /auth/agent-signup` with `{ owner_ref: "dev@example.com" }`
2. IdentityService generates key `wasi_a2a_<64hex>`, hashes it, inserts row
3. Response 201: `{ key: "wasi_a2a_abc123...", key_id: "uuid-here" }`
4. Developer stores the key securely (never shown again)

#### Deposit
1. Developer calls `POST /auth/deposit` with `x-a2a-key: wasi_a2a_abc123...` and body `{ key_id: "uuid", chain_id: 2368, token: "PYUSD", amount: "10.00", tx_hash: "0x..." }`
2. Route resolves caller key, verifies ownership (caller's key_id matches body.key_id)
3. BudgetService.registerDeposit increments `budget.2368` by "10.00"
4. Response 200: `{ balance: "10.00", chain_id: 2368 }`

#### Compose with a2a-key
1. Agent calls `POST /compose` with `x-a2a-key: wasi_a2a_abc123...` and compose body
2. Middleware hashes key, looks up row, validates active + daily limit + scoping
3. Request proceeds to compose handler (x402 skipped)
4. After execution, middleware debits budget [TBD: amount from WKH-35]
5. Response includes `x-a2a-remaining-budget` header

#### Compose without a2a-key (existing flow)
1. Agent calls `POST /compose` without `x-a2a-key`
2. Middleware sees no header, delegates to x402 flow
3. x402 processes payment as before (zero behavioral change per AC-18)

### 4.8 Flujo de error (AC-19)

| Condition | HTTP | Response body |
|-----------|------|---------------|
| `x-a2a-key` present but not found in DB | 403 | `{ error: "API key not found", code: "KEY_INVALID" }` |
| Key found but `is_active = false` | 403 | `{ error: "API key is deactivated", code: "KEY_INACTIVE" }` |
| Daily limit would be exceeded | 403 | `{ error: "Daily spending limit exceeded", code: "DAILY_LIMIT" }` |
| Chain budget insufficient | 403 | `{ error: "Insufficient budget for chain {id}", code: "INSUFFICIENT_BUDGET" }` |
| Scoping check fails | 403 | `{ error: "{reason from AuthzService}", code: "SCOPE_DENIED" }` |

---

## 5. Constraint Directives (Anti-Alucinacion)

### OBLIGATORIO seguir (inherited from work-item + new)

- **CD-1**: Down migration must be idempotent and drop all objects (table, function, indexes, trigger) created by the up migration.
- **CD-2**: `increment_a2a_key_spend` must be atomic (single transaction, `FOR UPDATE` row lock). Use `SECURITY DEFINER` to bypass RLS.
- **CD-4**: Plaintext key returned ONLY in POST /auth/agent-signup response. Never stored in DB. Never logged. Never returned again.
- **CD-6**: TypeScript strict. No `any`. All new types in `src/types/a2a-key.ts`.
- **CD-7**: Every new endpoint and service method must have at least 1 test.
- **CD-9**: Fastify request augmentation for `a2aKeyRow` must use `declare module 'fastify'` pattern (same as x402.ts does for `kiteTxHash`).
- **CD-NEW-1**: Test files MUST be co-located with source files (e.g., `src/services/identity.test.ts`), NOT in a `test/` directory. Follow existing codebase pattern.
- **CD-NEW-2**: Services use the `export const xxxService = { ... }` pattern (not classes). Follow `src/services/event.ts`.
- **CD-NEW-3**: Route files use `FastifyPluginAsync` and `export default`. Follow `src/routes/gasless.ts`.
- **CD-NEW-4**: All Supabase operations use the singleton from `src/lib/supabase.ts`. No new DB client creation.
- **CD-NEW-5**: The `trigger_set_updated_at()` function is NOT redefined in the new migration -- it already exists from `20260403180000_tasks.sql`. Just create the trigger that uses it.
- **CD-NEW-6**: The middleware factory `requirePaymentOrA2AKey()` must import and delegate to `requirePayment()` from x402.ts for the fallback path. Do NOT duplicate x402 logic.

### PROHIBIDO (inherited from work-item + new)

- **CD-3**: No shared tables with wasiai-v2. No FK to `auth.users`.
- **CD-5**: No `ethers.js`. All crypto via Node.js `crypto` module.
- **CD-8**: No hardcoded chain IDs, RPC URLs, or token addresses in services.
- **CD-P-1**: Do NOT modify `src/middleware/x402.ts`. The a2a-key middleware wraps x402 internally.
- **CD-P-2**: Do NOT create a `test/` directory. Tests are co-located.
- **CD-P-3**: Do NOT add new npm dependencies. `crypto` is built-in Node.js. Supabase client already exists.
- **CD-P-4**: Do NOT log plaintext keys. Not in request logs, not in error messages, not in console output.
- **CD-P-5**: Do NOT create RateLimitService or PricingService (Scope OUT).

---

## 6. Scope

**IN:**
- `a2a_agent_keys` table + `increment_a2a_key_spend` function + indexes + trigger
- Down migration
- IdentityService (createKey, lookupByHash, deactivate)
- BudgetService (getBalance, debit, registerDeposit)
- AuthzService (checkScoping)
- POST /auth/agent-signup, POST /auth/deposit, GET /auth/me, POST /auth/bind/:chain
- a2a-key middleware with x402 fallback
- Integration in compose + orchestrate routes
- Types in src/types/a2a-key.ts
- Tests for all new code

**OUT:**
- Multi-chain simultaneous deposit/spend arbitrage
- ERC-8004 real on-chain binding (POST /auth/bind/:chain returns 501)
- Kite Passport adapter
- On-chain deposit verification (PaymentAdapter.verify from WKH-35) -- stub
- RateLimitService, PricingService
- Admin endpoints (list/revoke keys)
- Changes to existing x402 middleware file

---

## 7. Riesgos

| Riesgo | Probabilidad | Impacto | Mitigacion |
|--------|-------------|---------|------------|
| Cost estimation in middleware depends on WKH-35 | Alta | Media | Stub: debit amount = 0 until PaymentAdapter.quote() exists. Middleware skeleton ready. |
| Deposit without on-chain verification is trust-based | Media | Alta | Acceptable for testnet. Production requires WKH-35 PaymentAdapter.verify(). Documented as [TBD]. |
| Daily reset loop in Postgres function for keys unused for weeks | Baja | Baja | WHILE loop advances 24h at a time; even 365 iterations is negligible for Postgres. |
| Supabase JS client does not support raw SQL with FOR UPDATE | Media | Media | Use Postgres function (`increment_a2a_key_spend`) for debits. Deposits use simple read+update (no atomicity needed for additive operations). |
| `trigger_set_updated_at()` might not exist if tasks migration hasn't run | Baja | Alta | Migration ordering ensures tasks (20260403) runs before agent_keys (20260406). Supabase applies in filename order. |

---

## 8. Dependencias

- `supabase/migrations/20260403180000_tasks.sql` must be applied first (provides `trigger_set_updated_at()`)
- `src/lib/supabase.ts` must exist (singleton DB client)
- `src/middleware/x402.ts` must exist (imported by a2a-key middleware for fallback)
- No new npm packages required

---

## 9. Missing Inputs

- [TBD -- resolved as stub] **AC-14 on-chain deposit verification**: POST /auth/deposit trusts tx_hash. When WKH-35 lands `PaymentAdapter.verify()`, add verification before crediting. For now, add a comment `// TODO(WKH-35): verify tx_hash on-chain via PaymentAdapter.verify()` and a log warning.
- [TBD -- resolved as stub] **AC-17 cost estimation**: Middleware cannot estimate USD cost before execution without `PaymentAdapter.quote()`. Stub strategy: debit amount = 0 (effectively free during testnet). Add comment `// TODO(WKH-35): use PaymentAdapter.quote() for actual cost`. The middleware still validates key, daily limit (against spent so far), and scoping -- only the post-execution debit is stubbed.
- [NEEDS CLARIFICATION -- resolved] **POST /auth/deposit self-auth**: Confirmed -- requires x-a2a-key header and caller must own the key_id. Self-deposit only.

---

## 10. Uncertainty Markers

| Marker | Seccion | Descripcion | Bloqueante? |
|--------|---------|-------------|-------------|
| [TBD] | 4.5 (POST /deposit) | On-chain tx_hash verification deferred to WKH-35 | No -- stub with trust + log warning |
| [TBD] | 4.6 (Middleware) | Cost estimation / debit amount deferred to WKH-35 | No -- stub with amount=0 + TODO comment |

> Gate: No [NEEDS CLARIFICATION] pending. Both [TBD] items have defined stub strategies.

---

## 11. Waves de Implementacion

### Wave 1 — Types + DB Migration (Serial gate)

| Task | Archivo | Accion |
|------|---------|--------|
| W1.1 | `src/types/a2a-key.ts` | Create all type definitions |
| W1.2 | `src/types/index.ts` | Add `export * from './a2a-key.js'` |
| W1.3 | `supabase/migrations/20260406000000_a2a_agent_keys.sql` | Up migration |
| W1.4 | `supabase/migrations/20260406000000_a2a_agent_keys_down.sql` | Down migration |

**Verification**: `npx tsc --noEmit` passes. Migration applies cleanly with `supabase db reset`.

### Wave 2 — Services + Unit Tests (Parallelizable within wave)

| Task | Archivo | Depends on |
|------|---------|------------|
| W2.1 | `src/services/identity.ts` + `src/services/identity.test.ts` | W1 |
| W2.2 | `src/services/budget.ts` + `src/services/budget.test.ts` | W1 |
| W2.3 | `src/services/authz.ts` + `src/services/authz.test.ts` | W1 |

**Verification**: `npx tsc --noEmit` + `npx vitest run src/services/identity.test.ts src/services/budget.test.ts src/services/authz.test.ts`

### Wave 3 — Endpoints + Route Tests

| Task | Archivo | Depends on |
|------|---------|------------|
| W3.1 | `src/routes/auth.ts` + `src/routes/auth.test.ts` | W1, W2 |
| W3.2 | `src/index.ts` (modify) | W3.1 |

**Verification**: `npx tsc --noEmit` + `npx vitest run src/routes/auth.test.ts`

### Wave 4 — Middleware + Integration

| Task | Archivo | Depends on |
|------|---------|------------|
| W4.1 | `src/middleware/a2a-key.ts` + `src/middleware/a2a-key.test.ts` | W1, W2 |
| W4.2 | `src/routes/compose.ts` (modify preHandler) | W4.1 |
| W4.3 | `src/routes/orchestrate.ts` (modify preHandler) | W4.1 |

**Verification**: `npx tsc --noEmit` + `npx vitest run src/middleware/a2a-key.test.ts` + full test suite `npx vitest run`

---

## 12. Test Plan

| Test file | ACs covered | Wave | What it tests |
|-----------|-------------|------|---------------|
| `src/services/identity.test.ts` | AC-5, AC-6, AC-7 | W2 | Key generation format (wasi_a2a_ + 64 hex), SHA-256 hashing, lookup by hash, deactivation |
| `src/services/budget.test.ts` | AC-8, AC-9, AC-10, AC-11 | W2 | getBalance returns "0" for missing chain, debit success/failure, registerDeposit increments, daily reset behavior |
| `src/services/authz.test.ts` | AC-12 | W2 | Scoping checks: empty arrays (allow all), non-empty arrays (filter), max_spend_per_call check, combined checks |
| `src/routes/auth.test.ts` | AC-13, AC-14, AC-15, AC-16 | W3 | agent-signup returns key+id with 201, deposit requires auth + ownership, /me returns full status, bind/:chain returns 501 |
| `src/middleware/a2a-key.test.ts` | AC-17, AC-18, AC-19 | W4 | Valid key passes through, absent key falls to x402, invalid/inactive/over-limit/scoped-denied returns 403 with correct error code |

---

## 13. DB-MIGRATION Case Type Checklist

- [x] Up migration is idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, `CREATE INDEX IF NOT EXISTS`)
- [x] Down migration exists (`20260406000000_a2a_agent_keys_down.sql`)
- [x] Down migration is idempotent (`DROP TABLE IF EXISTS`, `DROP FUNCTION IF EXISTS`, `DROP TRIGGER IF EXISTS`)
- [x] No data-loss operations in up (new table, N/A)
- [x] Indexes created for query patterns: `key_hash` via UNIQUE constraint, `is_active` partial index
- [x] `SECURITY DEFINER` on `increment_a2a_key_spend` (bypasses RLS)
- [x] Migration filename follows convention: `20260406000000_a2a_agent_keys.sql`
- [ ] Tested with `supabase db reset` (verify in F3)

---

## Implementation Readiness Check

- [x] Each AC has at least 1 archivo asociado in section 4.1
- [x] Each archivo in section 4.1 has a valid Exemplar (verified with Glob)
- [x] No [NEEDS CLARIFICATION] pending
- [x] Constraint Directives include at least 3 PROHIBIDO (5 PROHIBIDO defined)
- [x] Context Map has at least 2 archivos leidos (12 archivos leidos)
- [x] Scope IN and OUT are explicit and unambiguous
- [x] BD: table schema fully defined with exact SQL
- [x] Happy Path complete (4 flows documented)
- [x] Error flow defined (AC-19: 5 error codes with HTTP 403)
- [x] [TBD] items have defined stub strategies (not blocking)
- [x] DB-MIGRATION case type checklist completed
- [x] Test file locations corrected to co-located pattern

---

*SDD generado por NexusAgil -- FULL*
