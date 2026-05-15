# WasiAI A2A Protocol

[![Tests](https://github.com/ferrosasfp/wasiai-a2a/actions/workflows/test.yml/badge.svg)](https://github.com/ferrosasfp/wasiai-a2a/actions)
[![Deploy](https://img.shields.io/badge/deploy-Railway-blueviolet)](https://wasiai-a2a-production.up.railway.app)
[![A2A Protocol](https://img.shields.io/badge/protocol-Google%20A2A-blue)](https://google.github.io/A2A/)

Cross-chain agent-to-agent payment protocol — built on [Google A2A Protocol](https://google.github.io/A2A/) with pluggable chain adapters, native identity, and x402 settlement.

**Pay once on Kite. Fan-out to N agents on Avalanche. Single HTTP request.**

- **Live A2A gateway**: https://wasiai-a2a-production.up.railway.app
- **Production app**: https://app.wasiai.io
- **Pitch deck**: https://wasiai.io/pitch-v6
- **Kite Hackathon 2026 submission**: see the [block below](#-kite-hackathon-2026-submission)
- **Prior submission archive**: [`HACKATHON-FINAL.md`](HACKATHON-FINAL.md) *(historical)*

---

## 🏆 Kite Hackathon 2026 submission

**Project name**: WasiAI A2A Gateway for the Agentic Economy

For this hackathon we built **WasiAI A2A** (this repo) — the commerce layer for the agentic economy. AI agents discover, invoke, and pay each other autonomously through x402 micropayments. Humans and agents use the same HTTP protocol, the same agent cards, the same payment rails.

To prove the stack works end-to-end (gateway + marketplace + self-hosted facilitator wired together), we built **[WasiAgentShop](https://github.com/ferrosasfp/wasiai-agentshop)** as a real use case on top: cross-border LATAM remittances, settled in PYUSD on Kite Ozone. Three autonomous agents shop the marketplace, score corridors with live FX, and reserve the last-mile partner. Total agent fee: $0.061. End-to-end: under 30 seconds.

| Resource | Link |
|---|---|
| 🌐 **Live demo** | https://wasiai-agentshop.vercel.app/ |
| 🔗 **Sample on-chain tx** | [`0xf3eaa00a…0f1d674`](https://testnet.kitescan.ai/tx/0xf3eaa00a7e83c41b2b9d8247e39d32f564b36cd8745f91e3c080ff23f0f1d674) on KiteScan |
| 📦 **Use case repo (WasiAgentShop)** | https://github.com/ferrosasfp/wasiai-agentshop |
| 📋 **Judge walkthrough (5-min pass)** | [SUBMISSION.md](https://github.com/ferrosasfp/wasiai-agentshop/blob/main/SUBMISSION.md) |
| ⚙️ **Self-hosted x402 facilitator** | https://github.com/ferrosasfp/wasiai-facilitator |
| 🎤 **Pitch deck** | https://wasiai.io/pitch-v6/ |
| 🎬 **Demo video** | https://www.youtube.com/watch?v=Ydh_sEJXgt4 |

**Built by Fernando Rosas and Elizabeth Palacios.** We are WasiAI · [wasiai.io](https://wasiai.io)

---

## Production Status

| Component | URL | Status |
|-----------|-----|--------|
| Marketplace UI + thin-proxy | https://app.wasiai.io | live (Vercel) |
| A2A orchestrator (this repo) | https://wasiai-a2a-production.up.railway.app | live (Railway) |
| Multi-chain x402 facilitator | https://wasiai-facilitator-production.up.railway.app | live (Railway) |
| WasiAgentShop demo (use case) | https://wasiai-agentshop.vercel.app | live (Vercel) |

Quality snapshot:

- TypeScript strict, zero `any` — `tsc --noEmit` clean
- 1,660+ tests green across the a2a + marketplace + facilitator stack
- Adversarial review, code review, and QA gates green on every shipped feature
- Multi-chain live on 4 chains simultaneously: Kite Ozone testnet, Kite mainnet, Avalanche Fuji, Avalanche mainnet
- Mainnet hybrid mode active: Kite testnet PYUSD inbound + Avalanche C-Chain mainnet USDC outbound, real-money smoke verified

Mainnet proof — real cross-chain agent payments on production money:

| Tx | Chain | Type | Explorer |
|----|-------|------|----------|
| `0x9fa6ff83…` | Avalanche C-Chain mainnet | USDC outbound (wasi-chainlink-price, $0.001) | [snowtrace](https://snowtrace.io/tx/0x9fa6ff83eb10e51685ce078e69f9c42fcbe3b138b5b8c3f32909c9fee279c6f1) |
| `0xa22086d0…` | Avalanche C-Chain mainnet | USDC outbound (wasi-defi-sentiment, $0.010) | [snowtrace](https://snowtrace.io/tx/0xa22086d048b0222a8e08a5ca08997ae6c359e5ba674e63133a0ffbc463af16f9) |
| `0xca10320c…` | Avalanche C-Chain mainnet | USDC outbound (wasi-wallet-profiler, $0.050) | [snowtrace](https://snowtrace.io/tx/0xca10320c24ff513d773ce65e0bd306d4acce3e4883180c9dca5573da6cf1dfdb) |
| `0x6f406c08…` | Kite testnet | PYUSD inbound (1.0 PYUSD) | [kitescan](https://testnet.kitescan.ai/tx/0x6f406c08f6e59e3c5029f57ec3a84bb4596b94bb02568055ec4f9572981a1bf9) |
| `0xf3eaa00a…` | Kite Ozone testnet | PYUSD settle from WasiAgentShop demo | [kitescan](https://testnet.kitescan.ai/tx/0xf3eaa00a7e83c41b2b9d8247e39d32f564b36cd8745f91e3c080ff23f0f1d674) |

---

## Architecture

### Production deployment topology

During the Kite Hackathon, we cut over `compose`, `orchestrate`, and `capabilities` from the pre-hackathon v2-coupled stack to this chain-adaptive a2a gateway, and added a self-hosted multi-chain facilitator alongside. Today three services share one Supabase production DB:

```
+-------------------------------------------------------------+
|  app.wasiai.io  (Vercel — thin-proxy + marketplace UI)      |
|  /api/v1/{compose, orchestrate, capabilities, mcp}          |
+--------------------------+----------------------------------+
                           | x-wasiai-forward-key (HMAC compare)
                           v
+-------------------------------------------------------------+
|  wasiai-a2a  (Railway — Fastify, this repo)                 |
|  /compose, /orchestrate, /discover, /tasks, /mcp            |
|  Kite testnet PYUSD inbound  /  USDC outbound (mainnet)     |
+--------------------------+----------------------------------+
                           | x402 /verify, /settle (spec-literal)
                           v
+-------------------------------------------------------------+
|  wasiai-facilitator  (Railway — Fastify, multi-chain)       |
|  Kite testnet (2368)  -- PYUSD                              |
|  Kite mainnet (2366)  -- USDC.e        [staged, env-gated]  |
|  Avalanche Fuji (43113) -- USDC                             |
|  Avalanche C-Chain (43114) -- USDC      [active, mainnet]   |
+--------------------------+----------------------------------+
                           | EIP-3009 TransferWithAuthorization
                           v
                  +------------------+
                  | On-chain Kite +  |
                  | Avalanche L1s    |
                  +------------------+
```

Cross-chain flow: **Kite testnet PYUSD inbound** (or USDC on mainnet) → orchestrator fan-out → **Avalanche C-Chain USDC outbound** to N agents (mainnet hybrid mode).

### Logical layers

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
+-----------------------------+-------------------------------+
                              | talks to
+-----------------------------v-------------------------------+
|  L1 -- Blockchain / Infra                                   |
|  Kite (testnet 2368, mainnet 2366) + Avalanche (Fuji 43113, |
|  C-Chain 43114)                                             |
+-------------------------------------------------------------+
```

For the full architecture document, see [`doc/architecture/CHAIN-ADAPTIVE.md`](doc/architecture/CHAIN-ADAPTIVE.md).

### Adapter bundles

The `WASIAI_A2A_CHAIN` env var selects which adapter bundle loads at startup. Mainnet bundles are env-gated and default OFF; flipping flags routes the same code to mainnet without redeploys.

| Bundle | Status | Inbound asset | Outbound asset | Notes |
|--------|--------|---------------|----------------|-------|
| `kite-ozone-testnet` | active | PYUSD on Kite testnet (2368) | -- | Default `WASIAI_A2A_CHAIN`. Used in all hackathon demos. |
| `kite-mainnet` | staged (env-gated) | USDC.e on Kite mainnet (2366) | -- | Flip via `KITE_NETWORK=mainnet` + `KITE_MAINNET_RPC_URL`. |
| `avalanche-fuji` | active | -- | USDC testnet on Fuji (43113) | Default downstream when `WASIAI_DOWNSTREAM_X402=true`. |
| `avalanche-mainnet` | active (mainnet hybrid) | -- | USDC mainnet on Avalanche C-Chain (43114) | Live since 2026-04-29 via `WASIAI_DOWNSTREAM_NETWORK=avalanche-mainnet`. |

### Multi-chain support

Since WKH-MULTICHAIN (086), `wasiai-a2a` runs all four bundles simultaneously within a single process. Chain selection per request is driven by the `x-payment-chain` header (accepts slug or chainId numeric — e.g. `avalanche-fuji` or `43113`) with fallback to the first entry of `WASIAI_A2A_CHAINS`. The legacy single-chain `WASIAI_A2A_CHAIN=<slug>` env var is preserved for backward-compat. See [`doc/architecture/MULTI-CHAIN.md`](doc/architecture/MULTI-CHAIN.md) for the full model, alias table, and post-merge activation procedures.

Adding a new chain: see the **Adapter Pattern** section below.

---

## Quick Start

### Prerequisites

- Node.js 20 or newer (the dev setup; Railway/Vercel pin Node 22)
- Supabase project (PostgreSQL persistence)
- Kite testnet wallet with some native KITE for gas (for x402 demos)

### Run locally

```bash
git clone https://github.com/ferrosasfp/wasiai-a2a.git
cd wasiai-a2a

npm install

cp .env.example .env
# Edit .env with your Supabase URL + service-role key, Anthropic API key,
# Kite wallet address, and (optionally) operator private key for x402/gasless

npm run dev
# Server starts on http://localhost:3001

npm test
# Runs the full Vitest suite (644+ tests in this repo; 1,660+ across the a2a + marketplace + facilitator stack)
```

### Build and start

```bash
npm run build
npm start
```

### Hackathon E2E (PYUSD settlement on Kite testnet)

Reproducible proof of the full x402 + Kite PYUSD path against the live production endpoints — discovery, canonical x402 `/verify`, on-chain `/settle`, and receipt verification. Auto-mints PYUSD via the permissionless `claim()` on the token contract if the wallet is empty.

```bash
# requires OPERATOR_PRIVATE_KEY in .env (any wallet with some native KITE for gas)
node scripts/hackathon-e2e.mjs
```

Overrides (optional):

| Env var | Default | Purpose |
|---------|---------|---------|
| `A2A_URL` | `https://wasiai-a2a-production.up.railway.app` | A2A gateway to hit |
| `WASIAI_FACILITATOR_URL` | `https://wasiai-facilitator-production.up.railway.app` | Canonical multi-chain x402 facilitator |
| `X402_PAYMENT_TOKEN` | `0x8E04D099…2ec9` | PYUSD contract address on Kite testnet |
| `KITE_TESTNET_RPC_URL` | `https://rpc-testnet.gokite.ai/` | Kite RPC endpoint |

The script prints a tx hash + explorer URL on success.

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
| `KITE_FACILITATOR_URL` | No | `https://wasiai-facilitator-production.up.railway.app` | Canonical multi-chain x402 facilitator (set to `https://facilitator.pieverse.io` to use Pieverse legacy) |
| `KITE_FACILITATOR_MODE` | No | `pieverse` | `pieverse` or `x402` (canonical spec via WasiAI facilitator) |
| `KITE_PAYMENT_AMOUNT` | No | `1000000000000000000` (1 token in wei) | Payment amount override |
| `KITE_MERCHANT_NAME` | No | `WasiAI` | Merchant name shown to paying agents |
| `PAYMENT_WALLET_ADDRESS` | No | Falls back to `KITE_WALLET_ADDRESS` | Chain-agnostic alias for payment wallet |
| `WASIAI_A2A_CHAIN` | No | `kite-ozone-testnet` | Selects the adapter bundle at startup |
| `KITE_NETWORK` | No | `testnet` | `testnet` (chain 2368) or `mainnet` (chain 2366) |
| `KITE_MAINNET_RPC_URL` | Conditional | -- | Required when `KITE_NETWORK=mainnet` |
| `WASIAI_DOWNSTREAM_X402` | No | -- | Set to `true` to enable downstream USDC payouts to wasiai-v2 agents |
| `WASIAI_DOWNSTREAM_NETWORK` | No | `fuji` | `fuji` (43113) or `avalanche-mainnet` (43114) |
| `AVALANCHE_RPC_URL` | Conditional | -- | Required when `WASIAI_DOWNSTREAM_NETWORK=avalanche-mainnet` |
| `FUJI_RPC_URL` | No | `https://api.avax-test.network/ext/bc/C/rpc` | Avalanche Fuji RPC |
| `GASLESS_ENABLED` | No | `false` | Enable gasless EIP-3009 transfers |
| `OPERATOR_PRIVATE_KEY` | Conditional | -- | Operator wallet private key (required when `GASLESS_ENABLED=true`, downstream x402, or x402 signing) |
| `WASIAI_V2_FORWARD_KEY` | No | -- | HMAC shared secret for thin-proxy auth (defense in depth) |
| `ANTHROPIC_API_KEY` | Yes | -- | Anthropic API key for LLM planning in `/orchestrate` |
| `BASE_URL` | No | Auto-detected from request | Override the base URL for agent card generation |
| `CHAIN_EXPLORER_URL` | No | Falls back to `KITE_EXPLORER_URL`, then `https://testnet.kitescan.ai` | Block explorer URL for dashboard links |
| `KITE_EXPLORER_URL` | No | `https://testnet.kitescan.ai` | Kite-specific explorer URL (legacy alias) |
| `RATE_LIMIT_MAX` | No | `60` | Global per-IP rate limit |
| `RATE_LIMIT_ORCHESTRATE_MAX` | No | `10` | Heavy-route per-IP limit (`/orchestrate`, `/compose`) |
| `RATE_LIMIT_SIGNUP_MAX` | No | `5` | Limit for `/auth/agent-signup` |
| `RATE_LIMIT_WINDOW_MS` | No | `60000` | Rate limit window in ms |
| `BACKPRESSURE_MAX` | No | `20` | Max concurrent in-flight `/orchestrate` requests |
| `TIMEOUT_ORCHESTRATE_MS` | No | `120000` | Request timeout for `/orchestrate` |
| `TIMEOUT_COMPOSE_MS` | No | `180000` | Request timeout for `/compose` (raised in WKH-65 to absorb the Vercel → Railway hop) |
| `SHUTDOWN_GRACE_MS` | No | `30000` | Graceful shutdown timeout |
| `CB_ANTHROPIC_FAILURES` | No | `5` | Anthropic circuit breaker failure threshold |
| `CB_ANTHROPIC_WINDOW_MS` | No | `60000` | Anthropic circuit breaker window |
| `CB_ANTHROPIC_COOLDOWN_MS` | No | `30000` | Anthropic circuit breaker cooldown |
| `CB_REGISTRY_FAILURES` | No | `5` | Per-registry circuit breaker failure threshold |
| `CB_REGISTRY_WINDOW_MS` | No | `60000` | Per-registry circuit breaker window |
| `CB_REGISTRY_COOLDOWN_MS` | No | `30000` | Per-registry circuit breaker cooldown |

See `.env.example` for the complete reference (MCP server, schema-transform HMAC, gasless pricing, protocol fee, SSRF allowlists, etc.).

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

The `WASIAI_A2A_CHAIN` environment variable selects which adapter bundle to load at startup. See the **Adapter bundles** table above for the four current bundles (`kite-ozone-testnet`, `kite-mainnet`, `avalanche-fuji`, `avalanche-mainnet`).

```
WASIAI_A2A_CHAIN=kite-ozone-testnet
  -> loads src/adapters/kite-ozone/
  -> PaymentAdapter (x402 + Pieverse + PYUSD)
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

The gateway includes several resilience mechanisms (WKH-18, hardened in WKH-66):

### Rate Limiting

Tiered per-IP rate limiting via `@fastify/rate-limit`. Default `RATE_LIMIT_MAX=60` for general routes, `RATE_LIMIT_ORCHESTRATE_MAX=10` for heavy paid routes (`/orchestrate`, `/compose`), `RATE_LIMIT_SIGNUP_MAX=5` for `/auth/agent-signup`. Health, discovery, and well-known endpoints are exempt.

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
- `/compose`: `TIMEOUT_COMPOSE_MS` (default 180s — raised in WKH-65 to absorb Vercel → Railway thin-proxy hop)

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

Runs all tests via Vitest. The suite covers middleware (rate limit, timeout, backpressure, error boundary, a2a-key, forward-key), services (identity, budget, authz, compose, orchestrate, task), adapters (payment, gasless contract tests), and routes. 644 tests passing as of hackathon submission.

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
- `OPERATOR_PRIVATE_KEY` (if gasless or downstream x402 are enabled)
- `WASIAI_V2_FORWARD_KEY` (if accepting traffic from the Vercel thin-proxy)

---

## Documentation

| Document | Description |
|----------|-------------|
| [`HACKATHON-FINAL.md`](HACKATHON-FINAL.md) | Hackathon submission — live URLs, mainnet activation, on-chain proofs, Kite Passport positioning |
| [`doc/INTEGRATION.md`](doc/INTEGRATION.md) | Marketplace integration guide — auth, onboarding, x402, end-to-end examples |
| [`doc/architecture/CHAIN-ADAPTIVE.md`](doc/architecture/CHAIN-ADAPTIVE.md) | Full L1-L4 architecture, adapter interfaces, migration roadmap |
| [`doc/architecture/MULTI-CHAIN.md`](doc/architecture/MULTI-CHAIN.md) | Multi-chain registry (WKH-MULTICHAIN / 086) — chain selection priority, alias table, deposit procedure, mainnet activation |
| [`doc/kite-contracts.md`](doc/kite-contracts.md) | Kite contract addresses, token specs, infrastructure endpoints |
| [`doc/sdd/_INDEX.md`](doc/sdd/_INDEX.md) | NexusAgile methodology artifacts — every SDD, story file, AR/CR/QA report |

---

## For Marketplace Developers

Integrating a third-party marketplace or agent with WasiAI A2A? Start with [`doc/INTEGRATION.md`](doc/INTEGRATION.md) — it covers server-to-server auth (the B2B default), the x402 payment flow, the full endpoint reference, error-code playbook, and copy-pasteable curl + fetch examples against the production gateway.

---

## Contributing

WasiAI A2A is built using **NexusAgil**, a methodology with hard gates between roles (Analyst, Architect, Dev, Adversary, QA, Docs). Every change in this repo follows the pipeline:

```
F0 Codebase grounding   ->  F1 Work item + ACs (EARS)
                            |
                            v
                       HU_APPROVED  (human gate)
                            |
                            v
                  F2 SDD + Constraint Directives
                            |
                            v
                       SPEC_APPROVED (human gate)
                            |
                            v
                  F2.5 Story file (per HU)
                            |
                            v
                  F3 Implementation (waves)
                            |
                            v
                  AR  ->  CR  ->  F4 QA (drift detection)
                            |
                            v
                       DONE + _INDEX.md update
```

Every artifact lives in `doc/sdd/NNN-titulo/`. Methodology details, role prompts, and inviolable rules are in [`CLAUDE.md`](CLAUDE.md). Browse past HUs (work items, SDDs, AR/CR/QA reports, done reports) via [`doc/sdd/_INDEX.md`](doc/sdd/_INDEX.md).

When opening a PR:

- Branch from `main` using `feat/NNN-wkh-XX-short-title` or `fix/NNN-wkh-XX-short-title`.
- Reference the Jira HU (e.g. `WKH-79`) in the commit message.
- Include `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` if Claude Code drafted the change.
- Do not skip gates — Adversary Review and Code Review must run on every code-touching PR before F4 QA signs off.

---

## License

[MIT](LICENSE)
