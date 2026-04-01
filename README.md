# WasiAI A2A Protocol

> The universal A2A Gateway for agent discovery, composition, and orchestration — built on Google A2A Protocol standard

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Google A2A](https://img.shields.io/badge/Protocol-Google%20A2A-4285f4.svg)](https://a2a-protocol.org)
[![Kite AI Hackathon](https://img.shields.io/badge/Hackathon-Kite%20AI%202026-6366f1.svg)](https://gokite.ai)

## What is this?

WasiAI A2A is an open protocol that enables AI agents from **any marketplace** to:

- **Discover** agents across multiple registries (WasiAI, Kite, others)
- **Compose** multi-agent pipelines with automatic schema transformation
- **Orchestrate** complex workflows from a single goal (LLM selects agents)
- **Pay** for services via Kite x402

**Zero human in the loop. Standards-based. Universal translator.**

## Why Google A2A Protocol?

We implement the [Google Agent2Agent (A2A) Protocol](https://a2a-protocol.org) — an open standard with 50+ partners including LangChain, PayPal, Atlassian, and MongoDB.

- **Agent Cards** — Standardized metadata for capability discovery
- **Tasks** — Lifecycle management for long-running pipelines
- **Streaming** — Real-time updates via SSE
- **JSON-RPC 2.0** — Industry-standard transport

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    AUTONOMOUS AGENTS                        │
│            (any framework, any location)                    │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼ Google A2A Protocol (JSON-RPC 2.0)
┌─────────────────────────────────────────────────────────────┐
│                  WasiAI A2A Gateway                         │
│                                                             │
│  REST Endpoints:                                            │
│  ├── POST /registries      → Register any marketplace       │
│  ├── POST /discover        → Multi-registry search          │
│  ├── POST /compose         → Pipeline execution             │
│  ├── POST /orchestrate     → Goal-based (LLM decides)       │
│  └── GET  /agents/:id/agent-card → A2A Agent Card           │
│                                                             │
│  JSON-RPC Endpoint (POST /a2a):                             │
│  ├── message/send          → Send message to agent          │
│  ├── message/stream        → Streaming response (SSE)       │
│  ├── task/get              → Get task status                │
│  ├── task/list             → List tasks                     │
│  └── task/cancel           → Cancel task                    │
│                                                             │
│  Features:                                                  │
│  ├── Agent Cards (auto-generated)                           │
│  ├── Schema Transform (LLM-powered, cached)                 │
│  └── Tasks + Streaming (A2A standard)                       │
└─────────────────────────────────────────────────────────────┘
        │                                           │
        ▼ Multi-Registry Discovery                  ▼ Payments
┌───────────────┐ ┌───────────────┐         ┌───────────────┐
│ WasiAI        │ │ Kite          │         │ Kite L1       │
│ (A2A native)  │ │ (LLM infer)   │         │ x402 + ERC8004│
└───────────────┘ └───────────────┘         └───────────────┘
```

## Technical Stack

| Component | Technology |
|-----------|------------|
| **Framework** | Fastify |
| **Database** | Supabase PostgreSQL |
| **Queue** | Redis + BullMQ |
| **Cache** | Redis |
| **LLM** | Claude Sonnet (transform + orchestrate) |
| **Protocol** | Google A2A (JSON-RPC 2.0) |
| **Identity** | Kite Passport (ERC-8004) |
| **Payments** | Kite x402 |
| **Blockchain** | viem v2 |

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Run development server
npm run dev

# Server starts at http://localhost:3001
```

## Environment Variables

```bash
# Server
PORT=3001
NODE_ENV=development

# Database (Supabase)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-key
DATABASE_URL=postgresql://...

# Redis
REDIS_URL=redis://localhost:6379

# LLM (Claude Sonnet)
ANTHROPIC_API_KEY=your-key

# Kite (blockchain)
KITE_RPC_URL=https://rpc-testnet.gokite.ai/
KITE_CHAIN_ID=2368
OPERATOR_PRIVATE_KEY=0x...

# WasiAI Registry (pre-registered)
WASIAI_API_URL=https://app.wasiai.io/api/v1
WASIAI_API_KEY=wasi_...
```

## API Reference

### REST Endpoints

#### Register a Marketplace

Any marketplace can register itself — no code required:

```bash
curl -X POST http://localhost:3001/registries \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-marketplace",
    "discoveryEndpoint": "https://api.example.com/agents",
    "invokeEndpoint": "https://api.example.com/agents/{slug}/invoke",
    "a2aSupport": "none",
    "inferSchemas": true
  }'
```

#### Discover Agents (Multi-Registry)

Search agents across ALL registered marketplaces:

```bash
curl -X POST http://localhost:3001/discover \
  -H "Content-Type: application/json" \
  -d '{
    "capabilities": ["risk-analysis"],
    "maxPrice": 0.10
  }'
```

Response:
```json
{
  "agents": [
    {
      "id": "risk-analyzer",
      "name": "Risk Analyzer",
      "priceUsdc": 0.05,
      "registry": "wasiai",
      "agentCard": "https://a2a.wasiai.io/agents/risk-analyzer/agent-card"
    }
  ],
  "total": 1,
  "registries": ["wasiai", "kite"]
}
```

#### Get Agent Card (A2A Standard)

```bash
curl http://localhost:3001/agents/risk-analyzer/agent-card
```

Response:
```json
{
  "name": "Risk Analyzer",
  "description": "Analyzes token risk factors",
  "url": "https://a2a.wasiai.io/agents/risk-analyzer",
  "capabilities": {
    "streaming": true,
    "pushNotifications": true
  },
  "skills": [
    { "id": "token-risk", "name": "Token Risk Analysis" }
  ],
  "inputModes": ["text", "data"],
  "outputModes": ["text", "data"],
  "defaultInputSchema": { "type": "object", "properties": { "token": { "type": "string" } } },
  "defaultOutputSchema": { "type": "object", "properties": { "risk_score": { "type": "number" } } }
}
```

#### Compose Pipeline

Chain multiple agents with automatic schema transformation:

```bash
curl -X POST http://localhost:3001/compose \
  -H "Content-Type: application/json" \
  -d '{
    "steps": [
      { "agent": "price-oracle", "input": { "token": "0xABC" } },
      { "agent": "risk-analyzer", "passOutput": true },
      { "agent": "report-generator", "passOutput": true }
    ],
    "maxBudget": 0.50
  }'
```

#### Orchestrate from Goal

Just give a goal — Claude Sonnet selects the right agents:

```bash
curl -X POST http://localhost:3001/orchestrate \
  -H "Content-Type: application/json" \
  -d '{
    "goal": "Analyze token 0xABC and tell me if it is safe to buy",
    "budget": 0.50,
    "maxAgents": 3
  }'
```

### JSON-RPC Endpoint (A2A Protocol)

All A2A methods available at `POST /a2a`:

```bash
# Send message to agent
curl -X POST http://localhost:3001/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "message/send",
    "params": {
      "agentId": "risk-analyzer",
      "message": {
        "role": "user",
        "parts": [{ "kind": "text", "text": "Analyze 0xABC" }]
      }
    },
    "id": "1"
  }'

# Get task status
curl -X POST http://localhost:3001/a2a \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "task/get",
    "params": { "id": "task-uuid" },
    "id": "2"
  }'
```

## Interoperability Strategy

Not every marketplace implements Google A2A. WasiAI handles both:

| Marketplace | A2A Support | Strategy |
|-------------|-------------|----------|
| **WasiAI** | ✅ Full | Native Agent Cards, zero transform cost |
| **Kite** | ❌ None (today) | LLM schema inference + caching |
| **New with A2A** | ✅ Full | Automatic interoperability |
| **New without A2A** | ❌ None | Manual config or LLM inference |

### Schema Transform Flow

When Agent A's output doesn't match Agent B's input:

1. Read `outputSchema` from Agent A's Agent Card
2. Read `inputSchema` from Agent B's Agent Card
3. If incompatible → Claude Sonnet transforms
4. Cache the transform → zero cost on subsequent calls
5. Agent B receives properly formatted input

## Database Schema

Tables use `a2a_` prefix (shared Supabase with wasiai-v2 dev):

```sql
-- Registered marketplaces
a2a_registries (
  id, name, discovery_endpoint, invoke_endpoint,
  a2a_support, default_input_schema, default_output_schema,
  infer_schemas, created_at
)

-- A2A Tasks
a2a_tasks (
  id, context_id, status, messages, artifacts,
  created_at, updated_at
)

-- Transform cache
a2a_transform_cache (
  id, source_schema_hash, target_schema_hash,
  transform_template, hit_count, created_at
)
```

## Business Model

| Revenue | How |
|---------|-----|
| **1% Protocol Fee** | Per compose/orchestrate call |
| **Discovery Premium** | Advanced features (reputation, matching) |
| **B2B Licensing** | Other marketplaces license the A2A Gateway |

## Related Projects

- **[wasiai-v2](https://github.com/ferrosasfp/wasiai-v2)** — The WasiAI Marketplace (consumes this service)
- **[@wasiai/sdk](https://www.npmjs.com/package/@wasiai/sdk)** — TypeScript SDK for developers

## License

MIT — use it, fork it, build on it.

---

**Kite AI Global Hackathon 2026** · Track: Agentic Commerce

[Live Demo](https://app.wasiai.io) · [Pitch](https://wasiai.io/pitch-v6/) · [Google A2A Protocol](https://a2a-protocol.org)
