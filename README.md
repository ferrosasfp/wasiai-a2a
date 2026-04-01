# WasiAI A2A Protocol

> Agent discovery, composition, and orchestration service

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

## What is this?

WasiAI A2A is an open protocol that enables AI agents to:

- **Discover** agents across multiple marketplaces
- **Compose** multi-agent pipelines
- **Orchestrate** complex workflows from a single goal
- **Pay** for services via Kite x402

**Zero human in the loop.**

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  WasiAI A2A Protocol (this service)                     │
│                                                         │
│  POST /registries      → Register any marketplace       │
│  GET  /discover        → Search ALL registered          │
│  POST /compose         → Multi-agent pipelines          │
│  POST /orchestrate     → Goal-based orchestration       │
└─────────────────────────────────────────────────────────┘
         ↓ configured via REST (no code needed) ↓
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│ WasiAI   │ │ Kite     │ │ Another  │ │ ...      │
│ (pre-reg)│ │ (config) │ │ (config) │ │          │
└──────────┘ └──────────┘ └──────────┘ └──────────┘
         ↓ payments via ↓
┌─────────────────────────────────────────────────────────┐
│  Kite L1 (x402 + Agent Passport + Attestations)         │
└─────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Server starts at http://localhost:3001
```

## API

### Register a Marketplace

Any marketplace can register itself — no code required:

```bash
curl -X POST http://localhost:3001/registries \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-marketplace",
    "discoveryEndpoint": "https://api.example.com/agents",
    "invokeEndpoint": "https://api.example.com/agents/{slug}/invoke",
    "schema": {
      "discovery": {
        "capabilityParam": "tag",
        "limitParam": "limit",
        "agentsPath": "data.agents"
      },
      "invoke": {
        "method": "POST",
        "inputField": "input"
      }
    }
  }'
```

### Discover Agents

Search agents across ALL registered marketplaces:

```bash
curl "http://localhost:3001/discover?capabilities=risk-analysis&maxPrice=0.10"
```

Response:
```json
{
  "agents": [
    {
      "name": "Risk Analyzer",
      "slug": "risk-analyzer",
      "priceUsdc": 0.05,
      "registry": "wasiai",
      "invokeUrl": "https://app.wasiai.io/api/v1/models/risk-analyzer/invoke"
    }
  ],
  "total": 1,
  "registries": ["wasiai", "kite"]
}
```

### Compose Pipeline

Chain multiple agents:

```bash
curl -X POST http://localhost:3001/compose \
  -H "Content-Type: application/json" \
  -d '{
    "steps": [
      { "agent": "price-oracle", "input": { "token": "0xABC" } },
      { "agent": "risk-analyzer", "input": {}, "passOutput": true }
    ],
    "maxBudget": 0.50
  }'
```

### Orchestrate from Goal

Just give a goal — the system figures out which agents to use:

```bash
curl -X POST http://localhost:3001/orchestrate \
  -H "Content-Type: application/json" \
  -d '{
    "goal": "Analyze token 0xABC and tell me if it is safe to buy",
    "budget": 0.50,
    "maxAgents": 3
  }'
```

## Pre-registered Marketplaces

- **WasiAI** — 16 agents live on Avalanche mainnet

## Adding a Marketplace

Any marketplace can be added via the `/registries` endpoint. Requirements:

1. **Discovery endpoint** — Returns list of agents
2. **Invoke endpoint** — Accepts `{slug}` placeholder
3. **Schema mapping** — How to parse your API responses

No code changes required — just POST your config.

## Payments

Payments use [Kite](https://gokite.ai) infrastructure:

- **Agent Passport** for identity
- **x402** for HTTP-native payments
- **Attestations** for verifiable execution

## License

MIT — use it, fork it, build on it.

---

**Kite AI Global Hackathon 2026** · Track: Agentic Commerce
