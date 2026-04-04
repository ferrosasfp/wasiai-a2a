# WasiAI A2A Protocol — Hackathon Kite 2026

## Project Name
WasiAI A2A Protocol

## Tagline
The missing layer for autonomous agent interoperability — discovery, composition, and orchestration across any marketplace.

## Problem
AI agent marketplaces are siloed. An agent on WasiAI can't discover or work with an agent on Kite or any other platform. There's no standard way for agents to find each other, compose into pipelines, or pay for services autonomously.

## Solution
WasiAI A2A Protocol is a gateway service that implements Google's A2A Protocol standard, enabling:
- **Discovery** — Search agents across multiple registered marketplaces from a single endpoint
- **Composition** — Execute multi-agent pipelines where output of one agent feeds into the next
- **Orchestration** — Give a natural language goal; the system discovers, selects, and chains agents automatically
- **Payments** — x402 HTTP-native micropayments via Kite, with 1% protocol fee

## How It Uses Kite
- **Kite Ozone Testnet** — All settlement happens on-chain (Chain ID 2368)
- **x402 Protocol** — HTTP-native micropayments via Pieverse facilitator
- **Agent Passport** — Delegated authorization for autonomous agent payments (planned)
- **Gasless integration** — Account Abstraction SDK (planned)

## Architecture
```
Autonomous Agents (any framework)
    ↓ A2A Protocol (Google standard)
WasiAI A2A Gateway ← THIS PROJECT
  • POST /registries    → Register marketplaces
  • GET  /discover      → Search agents across all registries
  • POST /compose       → Multi-agent pipelines
  • POST /orchestrate   → Goal-based (LLM decides)
  • GET  /agents/:id/agent-card → A2A Agent Card
  • GET  /.well-known/agent.json → Gateway self-card
    ↓
WasiAI Registry + Kite Registry + Others
    ↓
Kite L1 (x402 + Passport)
```

## What Makes It Different
- **Nobody else is building A2A infrastructure** — competitors build trading bots, scoring tools, individual agents. We build the layer that connects ALL of them.
- **Google A2A Protocol compliant** — standard adopted by 50+ partners (LangChain, PayPal, Atlassian)
- **Multi-marketplace by design** — register any marketplace via config, no code needed
- **Already live in production** — https://wasiai-a2a-production.up.railway.app

## Current Status
- ✅ Fastify service deployed on Railway
- ✅ Registry management (CRUD) with Supabase PostgreSQL
- ✅ Multi-registry discovery with schema mapping
- ✅ Pipeline composition (multi-agent)
- ✅ x402 payment middleware (Pieverse verify + settle)
- ✅ Kite Ozone Testnet connection (viem)
- ✅ Google A2A Agent Cards (just shipped!)
- ✅ Gateway self Agent Card at /.well-known/agent.json
- 🔜 Tasks DB (A2A task lifecycle)
- 🔜 Autonomous Claude agent demo (zero human in the loop)
- 🔜 Analytics dashboard + reputation scoring

## Tech Stack
- **Backend:** Fastify (Node.js), TypeScript strict
- **Database:** Supabase PostgreSQL
- **Blockchain:** Kite Testnet (viem v2)
- **Payments:** x402 via Pieverse
- **LLM:** Claude (orchestration planning)
- **Deploy:** Railway

## Team
- **Fernando Rosas** — Founder & CTO. Full-stack + blockchain. Built WasiAI marketplace (live on Avalanche).
- **Elizabeth Palacios** — Co-founder & COO. 20+ years data/AI. Owns reputation scoring, analytics layer, and performance infrastructure.

## Links
- **Live service:** https://wasiai-a2a-production.up.railway.app
- **GitHub:** https://github.com/ferrosasfp/wasiai-a2a
- **WasiAI Marketplace:** https://app.wasiai.io
- **Agent Card (live):** https://wasiai-a2a-production.up.railway.app/.well-known/agent.json
