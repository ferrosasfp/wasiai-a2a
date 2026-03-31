# WasiAI A2A Protocol

> The discovery and orchestration layer for autonomous AI agents

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

## What is this?

WasiAI A2A is an open protocol that enables AI agents to:

- **Discover** other agents by capability (not by name)
- **Compose** multi-agent pipelines dynamically
- **Orchestrate** complex workflows from a single goal
- **Pay** for services autonomously via x402

**Zero human in the loop.**

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Your Application                      │
└─────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────┐
│                   @wasiai/a2a-core                       │
│         Discovery · Compose · Orchestrate                │
└─────────────────────────────────────────────────────────┘
                            ↓
┌───────────────────┐ ┌───────────────────┐ ┌─────────────┐
│ adapter-wasiai    │ │ adapter-kite      │ │ adapter-*   │
│ (WasiAI registry) │ │ (Kite marketplace)│ │ (your own)  │
└───────────────────┘ └───────────────────┘ └─────────────┘
                            ↓
┌─────────────────────────────────────────────────────────┐
│                   Payment Layer                          │
│            x402 · Agent Passport · USDC                  │
└─────────────────────────────────────────────────────────┘
```

## Packages

| Package | Description | Status |
|---------|-------------|--------|
| `@wasiai/a2a-core` | Core interfaces and orchestration logic | 🚧 In development |
| `@wasiai/a2a-adapter-wasiai` | Adapter for WasiAI agent registry | 🚧 In development |
| `@wasiai/a2a-adapter-kite` | Adapter for Kite AI marketplace | 📋 Planned |
| `@wasiai/a2a-payments-kite` | x402 payments via Kite | 📋 Planned |

## Quick Start

```typescript
import { A2A } from '@wasiai/a2a-core'
import { WasiAIAdapter } from '@wasiai/a2a-adapter-wasiai'
import { KitePayments } from '@wasiai/a2a-payments-kite'

const a2a = new A2A({
  registry: new WasiAIAdapter({ apiKey: 'wasi_...' }),
  payments: new KitePayments({ agentPassport: '0x...' })
})

// Discover agents by capability
const agents = await a2a.discover({
  capabilities: ['token-analysis', 'risk-assessment'],
  maxPrice: 0.10
})

// Compose a pipeline
const pipeline = await a2a.compose([
  { agent: 'chainlink-oracle', input: { token: '0xABC' } },
  { agent: 'risk-report', input: '$prev.output' }
])

// Or just orchestrate from a goal
const result = await a2a.orchestrate({
  goal: 'Analyze token 0xABC and tell me if it is safe to buy',
  budget: 0.50
})
```

## Why?

AI agents need to collaborate. Today:

- ❌ Agents can't find each other programmatically
- ❌ No standard for agent composition
- ❌ Payments require human intervention
- ❌ Each marketplace is a silo

WasiAI A2A fixes this with an open protocol that works across any agent registry.

## Built for Kite

This protocol is designed to run on [Kite](https://gokite.ai) infrastructure:

- **Agent Passport** for identity
- **x402** for HTTP-native payments
- **Attestations** for verifiable execution
- **Account Abstraction** for gasless operations

## License

MIT — use it, fork it, build on it.

## Links

- [WasiAI Marketplace](https://app.wasiai.io) — Live implementation
- [Kite AI](https://gokite.ai) — Infrastructure partner
- [Documentation](./docs) — Coming soon

---

**Kite AI Global Hackathon 2026** · Track: Agentic Commerce
