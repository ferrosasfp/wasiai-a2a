# WasiAI — One Pager

**The commerce layer for the agentic economy.**

WasiAI is the payment + identity + discovery infrastructure that lets AI agents transact with each other on-chain, across chains, without a human in the loop.

---

## Problem

Today, an AI agent that wants to use another AI agent's service has three blockers:

1. **Identity friction** — every integration asks for API keys, gas funding, manual approvals
2. **Single-chain prison** — most x402 implementations only settle on one chain; real-world agents live across many
3. **Closed marketplaces** — every existing marketplace funnels payments through one operator wallet (banking middleman, not a protocol)

This kills the agentic economy at the rails level.

---

## What we built

Three core layers, all live in production:

| Layer | What it does | Status |
|------|--------------|--------|
| **A2A protocol** | Orchestrates agent-to-agent discovery, composition, and payments | Live (wasiai-a2a) |
| **Marketplace** | Users and agents publish, find, compose, and invoke agents | Live (app.wasiai.io) |
| **Identity + payment rails** | Agent Keys (scoped budgets + on-chain limits) + on-chain wallet identity + Kite Passport integration | Live (wasiai-facilitator) |

We use **x402** (Coinbase's HTTP-native stablecoin payment standard) on **Avalanche** and **Kite**. Payments settle through **our own facilitator** infrastructure on mainnet — we don't rely on third parties for settlement.

---

## Proof points (verifiable on-chain right now)

| Metric | Value |
|--------|-------|
| Chains live in production | **4** (Kite testnet, Kite mainnet, Avalanche Fuji, Avalanche mainnet) |
| Tests across the stack | **1,660+** (orchestrator + marketplace + facilitator) |
| Onchain mainnet evidence | Multiple settlements at `0xf94d4005…` (today, own facilitator), `0x9fa6ff83…`, `0xa22086d0…`, `0xca10320c…` (April sprint) |
| Operational sovereignty | Marketplace settles through our own facilitator — verifiable diff in Snowtrace between pre/post migration tx |
| Production discipline | NexusAgil pipeline (analyst → architect → dev → adversarial review → QA → docs) with sub-agent orchestration |
| Breaking changes | Zero across all major migrations |
| Uptime | All 4 services HTTP 200 right now |

---

## Why now

Three converging shifts make this the right moment:

1. **x402 spec just stabilized** (Coinbase, Cloudflare, Google, Visa joined the Foundation)
2. **Agent economy infrastructure is being built right now** — Kite Passport, Cloudflare Agents, Anthropic MCP all shipped in 2025
3. **Avalanche subnets** unlock vertical-specific agent payment rails (IoT, energy, gaming) — early enough to be a primary settlement substrate

We are positioned at the intersection of all three, with running code.

---

## Team

**Fernando Rosas — CEO / Blockchain · DeFi**
25+ years building technology. Enterprise systems, decentralized protocols, AI products in production. Solidity, distributed architecture, Avalanche-shipped products. Co-founder of Troker (collaborative economy). Community builder in LATAM Web3.

**Elizabeth Palacios — COO / Data · AI**
20+ years leading data and AI transformations at enterprise scale. Built Data & Analytics functions from scratch inside multi-business corporations. Strategic executive translating analytics into business decisions. At WasiAI: performance scoring, reputation signals, and the analytics layer.

**Stage**: 2 co-founders, no full-time hires yet. Capital-efficient build.

---

## Stage + ask

- **Pre-revenue** (still in infrastructure stage)
- **No active investor conversations** at the moment of writing
- **Production-grade code shipped** across 3 services, 4 chains, real onchain settlements
- **Relatively open** to early-stage AI infrastructure / autonomous systems conversations
- **Based in Latin America** (technology and market are global)

---

## What funding unlocks

1. **2-3 engineering hires** (multi-chain expansion, marketplace SDK, audit prep)
2. **External security audit** of the facilitator + smart contract surface
3. **BD + partnerships** (first 3-5 enterprise pilots, integration with Avalanche subnets)
4. **18 months runway** at conservative burn

---

## Links

| Item | URL |
|------|-----|
| Live marketplace | https://app.wasiai.io |
| A2A gateway | https://wasiai-a2a-production.up.railway.app |
| Facilitator | https://wasiai-facilitator-production.up.railway.app |
| Pitch deck | https://wasiai.io/deck/ |
| Onchain evidence kit | https://wasiai.io/evidence/ |
| Repos | github.com/ferrosasfp/wasiai-a2a · wasiai-v2 · wasiai-facilitator |
| Fernando | linkedin.com/in/fernando-rosas |
| Elizabeth | linkedin.com/in/elizabeth-palacios-mendoza-4507962a |
| Email | fernando@wasiai.io |

---

*Last updated: 2026-05-12*
