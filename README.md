# WasiAI A2A Protocol

> Universal agent discovery, composition, and orchestration gateway — built on [Google A2A Protocol](https://google.github.io/A2A/) standard with native Kite x402 payments.

**🌐 Live:** https://wasiai-a2a-production.up.railway.app

---

## What It Does

WasiAI A2A is the protocol layer that lets AI agents find each other, compose multi-agent pipelines, and pay autonomously — without human intervention.

```
AI Agent
  ↓ POST /discover      → Find agents across registered marketplaces
  ↓ POST /compose       → Execute multi-agent pipelines
  ↓ POST /orchestrate   → Goal-based orchestration (LLM decides agents)
  ↓ x402 payment        → Pay per call via Kite Testnet
```

**Key features:**
- Multi-registry agent discovery
- Multi-agent pipeline composition
- LLM-based goal orchestration
- x402 HTTP-native payments (Kite Testnet)
- Supabase persistent registry storage
- Kite Agent Passport: Service Provider integration

---

## Quick Start

### Prerequisites
- Node.js 20+
- Supabase project (or use the dev instance)
- Kite Testnet wallet

### Run locally

```bash
git clone https://github.com/ferrosasfp/wasiai-a2a.git
cd wasiai-a2a

npm install

cp .env.example .env
# Edit .env with your credentials (see below)

npm run dev
```

### Environment variables

```bash
# Server
PORT=3001
NODE_ENV=development

# Supabase (required)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key

# Kite x402 payments (required for /orchestrate and /compose)
KITE_WALLET_ADDRESS=0xYourWalletAddress
KITE_FACILITATOR_URL=https://facilitator.pieverse.io
KITE_MERCHANT_NAME=YourServiceName

# Kite Chain (optional — enables chain features)
KITE_RPC_URL=https://rpc-testnet.gokite.ai/
```

### Run migrations

```bash
# Apply to your Supabase project via SQL Editor:
# supabase/migrations/20260401000000_kite_registries.sql
```

### Build & start

```bash
npm run build
npm start
```

---

## API Reference

### Health
```
GET /
```
Returns service info and available endpoints.

### Registries
```
GET    /registries          List all registered marketplaces
POST   /registries          Register a new marketplace
GET    /registries/:id      Get a specific registry
PATCH  /registries/:id      Update a registry
DELETE /registries/:id      Delete a registry
```

### Discovery
```
POST /discover
{
  "query": "token analysis",
  "capabilities": ["risk-assessment"],
  "maxPrice": 0.10
}
```

### Compose (x402 protected)
```
POST /compose
X-Payment: <kite-payment-token>

{
  "steps": [
    { "agent": "agent-slug", "registry": "wasiai", "input": {...} },
    { "agent": "another-agent", "input": {...}, "passOutput": true }
  ],
  "maxBudget": 0.50
}
```

### Orchestrate (x402 protected)
```
POST /orchestrate
X-Payment: <kite-payment-token>

{
  "goal": "Analyze token 0xABC and tell me if it's safe to buy",
  "budget": 0.50,
  "preferCapabilities": ["token-analysis"],
  "maxAgents": 3
}
```

---

## x402 Payment Flow

Endpoints `/compose` and `/orchestrate` require payment via [x402 protocol](https://x402.org):

**1. Call without payment → receive 402:**
```bash
curl -X POST https://wasiai-a2a-production.up.railway.app/orchestrate \
  -H "Content-Type: application/json" \
  -d '{"goal":"test","budget":1}'

# Response 402:
{
  "error": "X-PAYMENT header is required",
  "accepts": [{
    "scheme": "gokite-aa",
    "network": "kite-testnet",
    "maxAmountRequired": "1000000000000000000",
    "payTo": "0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba",
    "asset": "0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63",
    ...
  }],
  "x402Version": 1
}
```

**2. Get payment token via [Kite Agent Passport](https://docs.gokite.ai/kite-agent-passport/kite-agent-passport)**

**3. Call with X-Payment header → service executes + returns kiteTxHash**

---

## Architecture

```
wasiai-a2a/
├── src/
│   ├── index.ts              # Fastify server
│   ├── middleware/
│   │   └── x402.ts           # x402 payment preHandler
│   ├── routes/
│   │   ├── registries.ts     # Registry CRUD
│   │   ├── discover.ts       # Multi-registry discovery
│   │   ├── compose.ts        # Pipeline execution (x402)
│   │   └── orchestrate.ts    # Goal-based orchestration (x402)
│   ├── services/
│   │   ├── registry.ts       # Supabase registry service
│   │   ├── discovery.ts      # Discovery logic
│   │   ├── compose.ts        # Pipeline logic
│   │   └── orchestrate.ts    # Orchestration logic
│   └── lib/
│       ├── supabase.ts       # Supabase client singleton
│       └── kite-chain.ts     # Kite chain definition (viem)
├── supabase/
│   └── migrations/           # SQL migrations (prefijo kite_)
└── doc/sdd/                  # NexusAgile methodology artifacts
```

**Stack:** Fastify · Supabase PostgreSQL · TypeScript · viem · x402

---

## Network Info (Kite Testnet)

| Parameter | Value |
|-----------|-------|
| Chain ID | 2368 |
| RPC | https://rpc-testnet.gokite.ai/ |
| Explorer | https://testnet.kitescan.ai/ |
| Payment token | `0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63` |
| Facilitator | https://facilitator.pieverse.io |
| Service wallet | `0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba` |

---

## Built With

This project was built entirely through conversational AI using:
- **Claude Sonnet** (Anthropic) — orchestration LLM + code generation
- **NexusAgile** — AI-native development methodology (F0→F1→F2→F3→AR pipeline)
- **OpenClaw** — AI agent runtime

---

## Smoke Test / Demo

Run the automated smoke test to verify all endpoints are working:

```bash
# Against production (default)
./scripts/smoke-test.sh

# Against a custom URL (e.g., local dev server)
./scripts/smoke-test.sh http://localhost:3001
```

**Requirements:** `curl` (required), `jq` (recommended, falls back to grep if missing).

The script tests the following endpoints in sequence:

| Endpoint | Method | Validates |
|----------|--------|-----------|
| `/` | GET | HTTP 200, `name` + `version` fields |
| `/.well-known/agent.json` | GET | HTTP 200, `name` + `skills` fields |
| `/gasless/status` | GET | HTTP 200, `funding_state` field |
| `/dashboard` | GET | HTTP 200, HTML content |
| `/dashboard/api/stats` | GET | HTTP 200, `registriesCount` field |
| `/auth/agent-signup` | POST | HTTP 201, key starting with `wasi_a2a_` |
| `/auth/me` | GET | HTTP 200, key status info (uses key from signup) |
| `/discover` | POST | HTTP 200, `agents` array |
| `/compose` | POST | SKIP (requires x402 payment) |
| `/orchestrate` | POST | SKIP (requires x402 payment) |

**Exit codes:** `0` = all passed, `1` = at least one failure.

---

## Hackathon

Built for [Kite AI Global Buildathon 2026](https://www.encodeclub.com/programmes/kites-hackathon-ai-agentic-economy) — Agentic Commerce track.

**Goal:** Universal A2A gateway enabling autonomous agent-to-agent commerce with Kite-native x402 payments.
