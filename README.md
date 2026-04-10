# WasiAI A2A Protocol

[![Tests](https://github.com/ferrosasfp/wasiai-a2a/actions/workflows/test.yml/badge.svg)](https://github.com/ferrosasfp/wasiai-a2a/actions)
[![Deploy](https://img.shields.io/badge/deploy-Railway-blueviolet)](https://wasiai-a2a-production.up.railway.app)
[![A2A Protocol](https://img.shields.io/badge/protocol-Google%20A2A-blue)](https://google.github.io/A2A/)

Chain-adaptive agent discovery, composition, and orchestration gateway -- built on [Google A2A Protocol](https://google.github.io/A2A/) with pluggable chain adapters, native identity, and x402 payments.

**Live:** https://wasiai-a2a-production.up.railway.app

---

## Architecture

WasiAI A2A is a four-layer agentic economy gateway. Identity, budget, and authorization are owned off-chain (L3). On-chain settlement, attestation, and gasless execution are delegated to pluggable adapters (L2), selected at runtime via `WASIAI_A2A_CHAIN`.

```
+-------------------------------------------------------------+
|  L4 -- Public API (chain-agnostic, stable interface)        |
|  Core A2A: /discover  /compose  /orchestrate                |
|  Agent Cards: /agents/:slug/agent-card  /.well-known/*      |
|  Ops: /dashboard  /tasks                                    |
|  Identity: /auth/agent-signup  /auth/deposit  /auth/me      |
|  Binding: /auth/bind/:chain                                 |
+-----------------------------+-------------------------------+
                              | uses
+-----------------------------v-------------------------------+
|  L3 -- Agentic Economy Primitives (owned, chain-agnostic)   |
|  IdentityService  -- wasi_a2a_xxx keys + bindings           |
|  BudgetService    -- per-key, per-chain, atomic debit       |
|  AuthzService     -- scoping: registries/agents/categories  |
|  RateLimitService -- daily / hourly / per-call caps         |
+-----------------------------+-------------------------------+
                              | uses
+-----------------------------v-------------------------------+
|  L2 -- Chain Adapters (pluggable, runtime-selected)         |
|  +----------+--------------+----------+------------------+  |
|  | Payment  | Attestation  | Gasless  | IdentityBinding  |  |
|  +----------+--------------+----------+------------------+  |
|  Currently implemented: kite-ozone (Kite Ozone testnet)     |
|  Future: evm-generic, base, mock                            |
+-----------------------------+-------------------------------+
                              | talks to
+-----------------------------v-------------------------------+
|  L1 -- Blockchain / Infra                                   |
|  Kite Ozone testnet (2368) -- more chains planned           |
+-------------------------------------------------------------+
```

For the full architecture document, see [`doc/architecture/CHAIN-ADAPTIVE.md`](doc/architecture/CHAIN-ADAPTIVE.md).

---

## Quick Start

### Prerequisites

- Node.js 20+
- Supabase project (PostgreSQL persistence)
- Kite Testnet wallet (for x402 payments)

### Run locally

```bash
git clone https://github.com/ferrosasfp/wasiai-a2a.git
cd wasiai-a2a

npm install

cp .env.example .env
# Edit .env with your credentials (see Environment Variables below)

npm run dev
# Server starts on http://localhost:3001
```

### Build and start

```bash
npm run build
npm start
```

### Run tests

```bash
npm test
```

---

## Environment Variables

All variables from `.env.example` with their defaults:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3001` | Server port |
| `NODE_ENV` | No | -- | `development` enables verbose error details |
| `SUPABASE_URL` | Yes | -- | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Yes | -- | Supabase service_role key (not anon key) |
| `KITE_RPC_URL` | No | `https://rpc-testnet.gokite.ai/` | Kite chain RPC endpoint |
| `KITE_WALLET_ADDRESS` | Yes | -- | Wallet address that receives x402 payments |
| `KITE_FACILITATOR_URL` | No | `https://facilitator.pieverse.io` | Pieverse x402 facilitator |
| `KITE_PAYMENT_AMOUNT` | No | `1000000000000000000` (1 token in wei) | Payment amount override |
| `KITE_MERCHANT_NAME` | No | `WasiAI` | Merchant name shown to paying agents |
| `PAYMENT_WALLET_ADDRESS` | No | Falls back to `KITE_WALLET_ADDRESS` | Chain-agnostic alias for payment wallet |
| `WASIAI_A2A_CHAIN` | No | `kite-ozone-testnet` | Selects the adapter bundle at startup |
| `GASLESS_ENABLED` | No | `false` | Enable gasless EIP-3009 transfers |
| `OPERATOR_PRIVATE_KEY` | Conditional | -- | Operator wallet private key (required when `GASLESS_ENABLED=true` or for x402 signing) |
| `ANTHROPIC_API_KEY` | Yes | -- | Anthropic API key for LLM planning in `/orchestrate` |
| `BASE_URL` | No | Auto-detected from request | Override the base URL for agent card generation |
| `CHAIN_EXPLORER_URL` | No | Falls back to `KITE_EXPLORER_URL`, then `https://testnet.kitescan.ai` | Block explorer URL for dashboard links |
| `KITE_EXPLORER_URL` | No | `https://testnet.kitescan.ai` | Kite-specific explorer URL (legacy alias) |
| `RATE_LIMIT_MAX` | No | `10` | Max requests per IP per time window |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Rate limit time window in ms |
| `BACKPRESSURE_MAX` | No | `20` | Max concurrent in-flight `/orchestrate` requests |
| `TIMEOUT_ORCHESTRATE_MS` | No | `120000` | Request timeout for `/orchestrate` |
| `TIMEOUT_COMPOSE_MS` | No | `60000` | Request timeout for `/compose` |
| `SHUTDOWN_GRACE_MS` | No | `30000` | Graceful shutdown timeout |
| `CB_ANTHROPIC_FAILURES` | No | `5` | Anthropic circuit breaker failure threshold |
| `CB_ANTHROPIC_WINDOW_MS` | No | `60000` | Anthropic circuit breaker window |
| `CB_ANTHROPIC_COOLDOWN_MS` | No | `30000` | Anthropic circuit breaker cooldown |
| `CB_REGISTRY_FAILURES` | No | `5` | Per-registry circuit breaker failure threshold |
| `CB_REGISTRY_WINDOW_MS` | No | `60000` | Per-registry circuit breaker window |
| `CB_REGISTRY_COOLDOWN_MS` | No | `30000` | Per-registry circuit breaker cooldown |

---

## API Endpoints

### Health and Discovery

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | None | Health check -- returns service info and endpoint list |
| `GET` | `/health` | None | Health probe -- returns `{ status, version, uptime, timestamp }` |
| `GET` | `/.well-known/agent.json` | None | Gateway self-describing A2A Agent Card |
| `GET \| POST` | `/discover` | None | Search agents across all registered marketplaces |

#### Proxy Invocation Pattern

Agents returned by `/discover` include an `invokeUrl` field, but this is an **internal reference** used by the gateway. Callers must **not** call agent URLs directly. Instead:

1. **Discover** agents via `GET /discover` or `POST /discover`.
2. **Invoke** discovered agents through `POST /compose` (explicit pipeline) or `POST /orchestrate` (goal-based, LLM-planned).

Each agent object includes an `invocationNote` field that documents this pattern.

### Registries (Marketplace Management)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/registries` | None | List all registered marketplaces |
| `POST` | `/registries` | None | Register a new marketplace |
| `GET` | `/registries/:id` | None | Get a specific registry |
| `PATCH` | `/registries/:id` | None | Update a registry |
| `DELETE` | `/registries/:id` | None | Delete a registry |

### Core A2A (x402 or x-a2a-key required)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/compose` | x402 / x-a2a-key | Execute multi-agent pipelines |
| `POST` | `/orchestrate` | x402 / x-a2a-key | Goal-based orchestration (LLM selects agents) |

### Agent Cards

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/agents/:slug/agent-card` | None | A2A Agent Card for a specific agent |

### Tasks (A2A Protocol)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/tasks` | None | Create a new task |
| `GET` | `/tasks/:id` | None | Get task status |
| `PATCH` | `/tasks/:id` | None | Update task state |

### Identity (Agentic Economy L3)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/auth/agent-signup` | None | Create a new `wasi_a2a_xxx` agent key |
| `POST` | `/auth/deposit` | None | Register a deposit (501 until on-chain verification lands) |
| `GET` | `/auth/me` | x-a2a-key / Bearer | Get key status: budget, scoping, bindings |
| `POST` | `/auth/bind/:chain` | None | On-chain identity binding (501 -- planned for Fase 2) |

### Gasless (EIP-3009)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/gasless/status` | None | Gasless module status and `funding_state` |
| `POST` | `/gasless/transfer` | None | Execute gasless EIP-3009 transfer (503 when not operational) |

### Dashboard (Analytics)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/dashboard` | None | Analytics dashboard (HTML UI) |
| `GET` | `/dashboard/api/stats` | None | Aggregated KPIs (JSON) |
| `GET` | `/dashboard/api/events` | None | Recent events list (JSON) |

### Mock Registry (Development)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/mock-registry/agents` | None | In-memory mock agents for development |

---

## Identity System

WasiAI A2A provides its own identity primitive: `wasi_a2a_xxx` keys stored in the `a2a_agent_keys` table. These are independent from any marketplace auth system.

### Signup

```bash
curl -X POST https://wasiai-a2a-production.up.railway.app/auth/agent-signup \
  -H "Content-Type: application/json" \
  -d '{"owner_ref": "my-app", "display_name": "My Agent"}'

# Response 201:
# { "key": "wasi_a2a_abc123...", "key_id": "uuid-here" }
```

The plaintext key is returned **once** at signup. Store it securely.

### Check Status

Pass your key via the `x-a2a-key` header or the standard `Authorization: Bearer` header:

```bash
# Option 1: x-a2a-key header
curl https://wasiai-a2a-production.up.railway.app/auth/me \
  -H "x-a2a-key: wasi_a2a_abc123..."

# Option 2: Authorization: Bearer header
curl https://wasiai-a2a-production.up.railway.app/auth/me \
  -H "Authorization: Bearer wasi_a2a_abc123..."

# Response 200:
# { "key_id": "...", "budget": {"2368": "10.00"}, "scoping": {...}, ... }
```

When both headers are present, `x-a2a-key` takes priority. The Bearer token must start with `wasi_a2a_` to be recognized; other Bearer schemes are ignored.

### Key Features

- **Per-key budget** by chain: `{"2368": "10.00", "43114": "25.00"}`
- **Daily spending limits** with lazy reset
- **Scoping**: restrict to specific registries, agent slugs, or categories
- **Per-call limit**: cap estimated cost per request
- **On-chain bindings** (optional): ERC-8004, Kite Passport (future), AgentKit wallet

---

## Payment Flow

Two payment paths coexist. Callers choose one per request.

### Path 1: x402 Protocol (one-off consumers)

1. Call `/compose` or `/orchestrate` without payment headers.
2. Receive a `402` response with `accepts` array describing the payment scheme.
3. Obtain a payment token (e.g., via Kite Agent Passport or compatible x402 signer).
4. Resend the request with the `X-Payment` header.

```bash
# Step 1: get payment requirements
curl -X POST https://wasiai-a2a-production.up.railway.app/orchestrate \
  -H "Content-Type: application/json" \
  -d '{"goal": "analyze token safety", "budget": 1}'
# -> 402 with accepts[].scheme, payTo, asset, etc.

# Step 3: call with payment
curl -X POST https://wasiai-a2a-production.up.railway.app/orchestrate \
  -H "Content-Type: application/json" \
  -H "X-Payment: <payment-token>" \
  -d '{"goal": "analyze token safety", "budget": 1}'
```

### Path 2: x-a2a-key / Bearer (heavy users, pre-funded)

1. Sign up via `POST /auth/agent-signup` to get a `wasi_a2a_xxx` key.
2. Fund the key (deposit flow -- pending on-chain verification in WKH-35).
3. Pass the key via `x-a2a-key` header or `Authorization: Bearer wasi_a2a_xxx` on every paid request.

```bash
# Using x-a2a-key header
curl -X POST https://wasiai-a2a-production.up.railway.app/orchestrate \
  -H "Content-Type: application/json" \
  -H "x-a2a-key: wasi_a2a_abc123..." \
  -d '{"goal": "analyze token safety", "budget": 1}'

# Using Authorization: Bearer header (equivalent)
curl -X POST https://wasiai-a2a-production.up.railway.app/orchestrate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer wasi_a2a_abc123..." \
  -d '{"goal": "analyze token safety", "budget": 1}'
```

Priority: `x-a2a-key` > `Authorization: Bearer wasi_a2a_*` > x402. Bearer tokens that do not start with `wasi_a2a_` are ignored.

The middleware hashes the key, validates budget/scoping/limits, performs an optimistic debit, then executes the request. The response includes an `x-a2a-remaining-budget` header.

---

## Adapter Pattern

The gateway decouples chain-specific logic via four adapter interfaces defined in `src/adapters/types.ts`:

| Interface | Responsibility |
|-----------|---------------|
| `PaymentAdapter` | x402 settlement, verification, quoting, signing |
| `AttestationAdapter` | On-chain event attestation |
| `GaslessAdapter` | EIP-3009 gasless transfers |
| `IdentityBindingAdapter` | Bind agent keys to on-chain identities |

### Runtime Selection

The `WASIAI_A2A_CHAIN` environment variable selects which adapter bundle to load at startup. Currently supported: `kite-ozone-testnet`.

```
WASIAI_A2A_CHAIN=kite-ozone-testnet
  -> loads src/adapters/kite-ozone/
  -> PaymentAdapter (x402 + Pieverse + Test USDT / PYUSD)
  -> AttestationAdapter (Kite Ozone native)
  -> GaslessAdapter (Kite AA + EIP-3009)
  -> IdentityBindingAdapter (not yet implemented for Kite)
```

### Adding a New Chain

1. Create `src/adapters/<chain-name>/` with implementations of `PaymentAdapter`, `AttestationAdapter`, `GaslessAdapter`, and optionally `IdentityBindingAdapter`.
2. Export a factory function (e.g., `createMyChainAdapters()`) from the folder's `index.ts`.
3. Add the chain identifier to `SUPPORTED_CHAINS` in `src/adapters/registry.ts` and add the import branch in `initAdapters()`.
4. No changes to L3 services or L4 routes required.

See [`doc/architecture/CHAIN-ADAPTIVE.md`](doc/architecture/CHAIN-ADAPTIVE.md) for the full per-chain deployment matrix.

---

## Hardening

The gateway includes several resilience mechanisms (WKH-18):

### Rate Limiting

Global per-IP rate limiting via `@fastify/rate-limit`. Configurable via `RATE_LIMIT_MAX` (default 10) and `RATE_LIMIT_WINDOW_MS` (default 60s). Individual routes can opt out with `config: { rateLimit: false }`.

Response on limit exceeded:
```json
{ "error": "Too Many Requests", "code": "RATE_LIMIT_EXCEEDED", "retryAfterMs": 45000, "requestId": "..." }
```

### Circuit Breaker

In-memory state machine (`src/lib/circuit-breaker.ts`) with three states: `closed -> open -> half_open -> closed`. Two singleton instances:

- **Anthropic** circuit breaker: protects LLM calls in `/orchestrate`. Configurable via `CB_ANTHROPIC_FAILURES`, `CB_ANTHROPIC_WINDOW_MS`, `CB_ANTHROPIC_COOLDOWN_MS`.
- **Per-registry** circuit breakers: one per registered marketplace. Configurable via `CB_REGISTRY_FAILURES`, `CB_REGISTRY_WINDOW_MS`, `CB_REGISTRY_COOLDOWN_MS`.

When open, returns `503` with code `CIRCUIT_OPEN`.

### Error Boundary

Global error handler (`src/middleware/error-boundary.ts`) normalizes all errors to a consistent shape:

```json
{ "error": "...", "code": "VALIDATION_ERROR | RATE_LIMIT_EXCEEDED | CIRCUIT_OPEN | TIMEOUT | BACKPRESSURE | INTERNAL_ERROR", "requestId": "..." }
```

In `NODE_ENV=development`, stack traces are included.

### Backpressure

In-flight request counter for `/orchestrate` (default max 20 via `BACKPRESSURE_MAX`). Returns `503` with code `BACKPRESSURE` when exceeded.

### Timeouts

Per-route configurable timeouts. Returns `504` with code `TIMEOUT`.

- `/orchestrate`: `TIMEOUT_ORCHESTRATE_MS` (default 120s)
- `/compose`: `TIMEOUT_COMPOSE_MS` (default 60s)

### Graceful Shutdown

On `SIGTERM`/`SIGINT`, the server drains in-flight requests before exiting. Configurable via `SHUTDOWN_GRACE_MS` (default 30s).

---

## Gasless Transfers

The gateway supports gasless EIP-3009 token transfers via the Kite AA relayer (`https://gasless.gokite.ai/`). This allows token transfers without the sender holding native gas.

### Graceful Degradation

The gasless module reports a `funding_state` that reflects its operational readiness:

| `funding_state` | Meaning |
|-----------------|---------|
| `ready` | Fully operational -- transfers will succeed |
| `not_enabled` | `GASLESS_ENABLED` is not `true` |
| `missing_key` | `OPERATOR_PRIVATE_KEY` not configured |
| `invalid_key` | `OPERATOR_PRIVATE_KEY` is not a valid hex private key |
| `no_balance` | Operator wallet has insufficient token balance |

`GET /gasless/status` is always available (even when gasless is disabled) so clients can discover the current state. `POST /gasless/transfer` returns `503` with `gasless_not_operational` when `funding_state` is not `ready`.

### Supported Token (Kite Ozone Testnet)

- **PYUSD**: `0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9` (18 decimals)
- Minimum transfer: `10000000000000000` (0.01 PYUSD)
- EIP-712 domain name: `"PYUSD"`

See [`doc/kite-contracts.md`](doc/kite-contracts.md) for full contract details.

---

## Testing

### Unit and Integration Tests

```bash
npm test
```

Runs all tests via Vitest. The test suite covers middleware (rate limit, timeout, backpressure, error boundary, a2a-key), services (identity, budget, authz, compose, orchestrate, task), adapters (payment, gasless contract tests), and routes.

### Smoke Test

```bash
# Against production
./scripts/smoke-test.sh

# Against local dev server
./scripts/smoke-test.sh http://localhost:3001
```

Requirements: `curl` (required), `jq` (recommended). The script tests the following endpoints in sequence:

| Endpoint | Method | Validates |
|----------|--------|-----------|
| `/` | GET | 200, `name` + `version` fields |
| `/.well-known/agent.json` | GET | 200, `name` + `skills` fields |
| `/gasless/status` | GET | 200, `funding_state` field |
| `/dashboard` | GET | 200, HTML content |
| `/dashboard/api/stats` | GET | 200, `registriesCount` field |
| `/auth/agent-signup` | POST | 201, key starting with `wasi_a2a_` |
| `/auth/me` | GET | 200, key status info |
| `/discover` | GET | 200 |
| `/compose` | POST | SKIP (requires x402 payment) |
| `/orchestrate` | POST | SKIP (requires x402 payment) |

Exit code `0` = all passed, `1` = at least one failure.

---

## Deployment

The service is deployed on [Railway](https://railway.app/) at https://wasiai-a2a-production.up.railway.app.

### Railway Configuration

1. Connect the GitHub repository.
2. Set all required environment variables (see Environment Variables section above).
3. Build command: `npm run build`
4. Start command: `npm start`
5. The service listens on `PORT` (Railway sets this automatically).

### Required Secrets

At minimum, configure in your deployment environment:

- `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`
- `KITE_WALLET_ADDRESS` (or `PAYMENT_WALLET_ADDRESS`)
- `ANTHROPIC_API_KEY`
- `OPERATOR_PRIVATE_KEY` (if gasless is enabled)

---

## Documentation

| Document | Description |
|----------|-------------|
| [`doc/architecture/CHAIN-ADAPTIVE.md`](doc/architecture/CHAIN-ADAPTIVE.md) | Full L1-L4 architecture, adapter interfaces, migration roadmap |
| [`doc/kite-contracts.md`](doc/kite-contracts.md) | Kite contract addresses, token specs, infrastructure endpoints |
| [`doc/sdd/`](doc/sdd/) | NexusAgile methodology artifacts (SDDs, story files, reviews) |

---

## License

[MIT](LICENSE)
