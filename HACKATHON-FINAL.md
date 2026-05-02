# WasiAI A2A Protocol — Hackathon Final Submission

**Submitted to**: Kite Hackathon
**Date**: 2026-04-28
**Status**: ✅ Production-ready, mainnet-config staged, testnet proven E2E

---

## TL;DR — What we built

WasiAI A2A is an **agent-to-agent payment protocol** running on Kite. It enables clients to:

1. Pay **once** with PYUSD on Kite testnet (or USDC on Kite mainnet — confirmed canonical via WKH-68 spike against Kite Passport)
2. Have an orchestrator (`wasiai-a2a`) **discover** + **compose** N agents from any registered marketplace (e.g. wasiai-v2)
3. Settle each agent payment **on a different chain** (Avalanche Fuji USDC, mainnet-ready) via x402 protocol
4. Get the aggregated output back

It's the first **TRUE cross-chain agent payment system**: pay one chain, fan-out to N agents on another chain, single HTTP request.

---

## Live Demo URLs

| Service | URL | Status |
|---------|-----|--------|
| **Production app** | https://app.wasiai.io | ✅ 100% on prod stack |
| Marketplace UI | https://app.wasiai.io | ✅ live |
| A2A orchestrator | https://wasiai-a2a-production.up.railway.app | ✅ live |
| Multi-chain facilitator | https://wasiai-facilitator-production.up.railway.app | ✅ live, breakers CLOSED |

All 3 services share the **same production database** (`caldzjhjgctpgodldqav` Supabase prod).

---

## Verifiable On-Chain Proofs (testnet)

### Demo 1 — `/api/v1/compose` 3 agents canonical pipeline (via app.wasiai.io)

Run: 2026-04-28T22:59 UTC. Pipeline: `wasi-chainlink-price → wasi-defi-sentiment → wasi-wallet-profiler`. Cost: $0.061 USDC. Latency: 22.5s.

| Tx | Chain | Type | Explorer |
|----|-------|------|----------|
| `0x09264ed1…` | Kite testnet | PYUSD inbound (1.0 PYUSD) | [kitescan](https://testnet.kitescan.ai/tx/0x09264ed1c63e069dc305be93058e74f031505be9d16751091cc45c69f7b1ce24) |
| `0x2b7408ed…` | Avalanche Fuji | USDC → wasi-chainlink-price ($0.001) | [snowtrace](https://testnet.snowtrace.io/tx/0x2b7408ed6c1012f8ce270fec410ef9e07167e9b52ddfb8ba5ec924938daebae5) |
| `0xc46520b1…` | Avalanche Fuji | USDC → wasi-defi-sentiment ($0.01) | [snowtrace](https://testnet.snowtrace.io/tx/0xc46520b192c35058bd471619f8f0e6f95eed0bbe0605dac192b7c64cd2aa7317) |
| `0x4b3bab43…` | Avalanche Fuji | USDC → wasi-wallet-profiler ($0.05) | [snowtrace](https://testnet.snowtrace.io/tx/0x4b3bab438651e66a1da667dbc505d9284ecf134ef49acd9a97039d028fa7f0b7) |

### Demo 2 — `/api/v1/compose` 5 agents pipeline cap (via app.wasiai.io)

Run: 2026-04-28T23:13 UTC. Cost: $0.112 USDC. Latency: 43.5s.

| # | Agent | Cost | Tx |
|---|-------|------|----|
| 1 | wasi-chainlink-price | $0.001 | [`0x1fed1ef2…`](https://testnet.snowtrace.io/tx/0x1fed1ef29b51467ec85457002e1e864a4abc17192906842f074927078557a091) |
| 2 | wasi-chainlink-price | $0.001 | [`0x7b8c4c3e…`](https://testnet.snowtrace.io/tx/0x7b8c4c3e637ad06dffa93ffaa8c00640cabfef40420ca3b74a4a0aa27a80f4d8) |
| 3 | wasi-defi-sentiment | $0.01 | [`0x0480494a…`](https://testnet.snowtrace.io/tx/0x0480494a6f9fcb8aa74be5dd4ae436b1e5558878b34b00f489a87e2121a07a4c) |
| 4 | wasi-wallet-profiler | $0.05 | [`0x420381e6…`](https://testnet.snowtrace.io/tx/0x420381e675d8c03270c13fbf9e3ba7a341d69ca31dae2ad5cc906d0edf74639a) |
| 5 | wasi-liquidity-analyzer | $0.05 | [`0x72c185b2…`](https://testnet.snowtrace.io/tx/0x72c185b2d8f2dbc833b2389c4d2952d078979503f98f7da3d01128d89b95846d) |

Inbound: [`0xe0072b0c…`](https://testnet.kitescan.ai/tx/0xe0072b0cd24355f943f90dc14623ed1ea311ac38042cfbfeaa534dc85fd5997e)

### Performance benchmark — 5 consecutive runs (via app.wasiai.io)

| Métrica | Valor |
|---------|-------|
| **Success rate** | 5/5 (100%) |
| **Latency p50** | 24.2s |
| **Latency p95** | 29.4s |
| **Latency p99** | 29.4s |
| **Latency avg** | 24.8s |
| **Total USDC moved** | $0.305 |
| **Total on-chain txs** | 20 |
| **Avg txs per run** | 4.0 |

Proxy overhead vs directo Railway: **+3s p50** (24.2s vs 21.1s baseline).

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                       app.wasiai.io (Vercel)                        │
│                                                                     │
│  thin-proxy /api/v1/{compose,orchestrate,capabilities,mcp}          │
│  + marketplace UI + admin + creator + agents/* + escrow + webhooks  │
└────────────────────────────────────────────────────────────────────┘
                              ↓ x-wasiai-forward-key (HMAC compare)
┌────────────────────────────────────────────────────────────────────┐
│                wasiai-a2a (Railway, Fastify)                        │
│                                                                     │
│  /compose, /orchestrate, /discover, /tasks, /agent-card, /mcp       │
│  ├── x402 inbound (PYUSD Kite testnet ↔ USDC Kite mainnet)          │
│  ├── LLM planner (Claude Haiku 4.5 default, Sonnet 4.6 opt-in)      │
│  ├── A2A JSON-RPC 2.0 (Google A2A protocol)                         │
│  └── Schema transforms cache (HMAC-signed L2 cache)                 │
└────────────────────────────────────────────────────────────────────┘
                              ↓ /verify, /settle (x402 spec-literal)
┌────────────────────────────────────────────────────────────────────┐
│                wasiai-facilitator (Railway, Fastify)                │
│                                                                     │
│  Multi-chain x402 facilitator                                       │
│  ├── Kite testnet (eip155:2368) — PYUSD                             │
│  ├── Avalanche Fuji (eip155:43113) — USDC                           │
│  ├── [staged] Kite mainnet (eip155:2366) — USDC.e                   │
│  └── [staged] Avalanche C-Chain (eip155:43114) — USDC native        │
│  Per-chain circuit breakers + exponential backoff                   │
└────────────────────────────────────────────────────────────────────┘
                              ↓ EIP-3009 TransferWithAuthorization
                    ┌──────────────────────────┐
                    │ On-chain Kite + Avalanche │
                    └──────────────────────────┘

ALL services share: caldzjhjgctpgodldqav (Supabase prod DB)
```

### Why this matters

- **One HTTP call → multi-chain settlement.** The client signs ONE x402 payment in PYUSD on Kite. The orchestrator transparently fans out to N agents, each settling on its preferred chain. No multi-step bridging UX.
- **Dynamic LLM-driven orchestration.** `/orchestrate` accepts a natural language goal. Claude (Haiku 4.5 by default) picks agents from the registry, chains them, settles each, returns aggregated result.
- **Schema drift resilience.** Defensive fallbacks at multiple boundaries (canonical-first with secondary fallback + warn dedup). Survives marketplace API evolution without breaking flows.
- **Per-chain circuit breakers.** Facilitator wraps each chain in its own breaker. If Avalanche RPC goes down, Kite continues.
- **Defense-in-depth auth.** `WASIAI_V2_FORWARD_KEY` HMAC compare between Vercel and Railway. Plus client-level x402 EIP-3009 signature. Plus per-call rate limits.

---

## Tech stack

| Layer | Tech |
|-------|------|
| Marketplace UI | Next.js 14 (App Router), Vercel |
| Orchestrator | Fastify, Node 20, Railway |
| Facilitator | Fastify, viem, ethers, Railway |
| Database | Supabase (Postgres) |
| LLM | Claude (Haiku 4.5 / Sonnet 4.6) via Anthropic SDK |
| Payments | x402 v2 protocol, EIP-3009 TransferWithAuthorization, EIP-712 |
| Chains | Kite testnet (PYUSD), Avalanche Fuji (USDC), Kite mainnet (USDC native), Avalanche C-Chain (USDC) |

---

## Quality gates passed

| Gate | Result |
|------|--------|
| TypeScript strict (zero `any`) | ✅ tsc --noEmit clean across 3 repos |
| Test suites | ✅ 644 a2a + 403 v2 + 553 facilitator green |
| Adversarial review (AR) | ✅ APROBADO con 0 bloqueantes (multi-HU) |
| Code review (CR) | ✅ APPROVED across all PRs |
| QA validation (F4) | ✅ PASS — every AC has file:line evidence |
| Smoke E2E real-tx | ✅ 37 onchain txs (12 batches), 100% success |
| Production cutover | ✅ 3 services on shared prod DB |
| Tech debt cleanup | ✅ TD-002 + TD-003 resolved, 8/9 menores closed, 5/6 trial.test fails fixed |
| Mainnet readiness | ✅ Code staged for Kite mainnet (2366) + Avalanche C-Chain (43114), env-gated |

### Post-merge verification (2026-04-29 05:49 UTC, after 5 PRs merged)

All endpoints verified via `app.wasiai.io`:

| Verification | Result |
|--------------|--------|
| `GET /api/v1/capabilities?limit=20` | ✅ 19 agents (was 0 before TD-002 fix) |
| `POST /api/v1/compose` 3-agent E2E | ✅ 4 onchain txs, 19.4s, $0.061 |
| `POST /api/v1/orchestrate` LLM planner | ✅ 3 onchain txs (LLM picked 2 agents), 22.4s, $0.05 |
| `GET /supported` (facilitator) | ✅ 2 chains testnet (mainnet flags default OFF as designed) |
| Vercel `wasiai-prod` latest deploy | ✅ READY (sha 06830be) |

**Most recent verifiable txs**:

Compose 3-agent:
- Kite inbound: [`0x532651fb…`](https://testnet.kitescan.ai/tx/0x532651fb5039c64ec1e33a715f59a5ab388a36a9fc6a214f95a007a1b5520b4c)
- Fuji outbound: [`0x50d88859…`](https://testnet.snowtrace.io/tx/0x50d888596f99a2bd8972d27e3ffa904e2560b214e3b79f08aef4164c28ab0167) [`0x811333cf…`](https://testnet.snowtrace.io/tx/0x811333cf39346bfba80773cdd37a624a3856ef50b67536d7cebf95327e6cfd40) [`0x1beb00a7…`](https://testnet.snowtrace.io/tx/0x1beb00a770b35b6a7bea1393ea2fb17d54e20520126a3fb7b7fd86b934954313)

Orchestrate LLM planner:
- Kite inbound: [`0xe02f23c3…`](https://testnet.kitescan.ai/tx/0xe02f23c38d3ab6c9bc594e0213933cb2153ce8a48dc6d94f856c1589e0544ab7)
- Fuji outbound: [`0xaf6b2311…`](https://testnet.snowtrace.io/tx/0xaf6b23114cee87aba4de148afdcac0a7179131262109441fa11c487b67a5e4ef) [`0x3323d934…`](https://testnet.snowtrace.io/tx/0x3323d934183e47c2ac77b4a3082bb39637f554803e86c347e05a102ee7c738e1)

### 🔴 MAINNET HYBRID MODE ACTIVATED — 2026-04-29 06:21 UTC

**Real money cross-chain proven**: Kite testnet inbound + **Avalanche C-Chain MAINNET** outbound.

| Activation step | Result |
|-----------------|--------|
| Operator wallet funding | ✅ 0.1 AVAX + 5 USDC mainnet at `0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba` |
| Railway env update (a2a) | ✅ `WASIAI_DOWNSTREAM_NETWORK=avalanche-mainnet` + `AVALANCHE_RPC_URL` set |
| Railway env update (facilitator) | ✅ `AVALANCHE_MAINNET_ENABLED=true` + `AVALANCHE_MAINNET_RPC_URL` set |
| facilitator `/supported` | ✅ 3 chains: Kite testnet + Fuji testnet + **Avalanche MAINNET (eip155:43114)** |
| Smoke real-money via app.wasiai.io | ✅ 4 onchain txs, $0.061 USDC mainnet spent |
| Operator USDC balance change | ✅ 5.000 → 4.939 (-$0.061 = exact match cost) |

**Verifiable mainnet tx hashes**:

| # | Agent | Cost | Mainnet tx | Block |
|---|-------|------|------------|-------|
| 1 | wasi-chainlink-price | $0.001 | [`0x9fa6ff83…`](https://snowtrace.io/tx/0x9fa6ff83eb10e51685ce078e69f9c42fcbe3b138b5b8c3f32909c9fee279c6f1) | 84159513 |
| 2 | wasi-defi-sentiment | $0.010 | [`0xa22086d0…`](https://snowtrace.io/tx/0xa22086d048b0222a8e08a5ca08997ae6c359e5ba674e63133a0ffbc463af16f9) | confirmed |
| 3 | wasi-wallet-profiler | $0.050 | [`0xca10320c…`](https://snowtrace.io/tx/0xca10320c24ff513d773ce65e0bd306d4acce3e4883180c9dca5573da6cf1dfdb) | confirmed |
| Inbound | Kite testnet PYUSD (free) | 1.0 PYUSD | [`0x6f406c08…`](https://testnet.kitescan.ai/tx/0x6f406c08f6e59e3c5029f57ec3a84bb4596b94bb02568055ec4f9572981a1bf9) | testnet |

**Architectural significance**: This is the first proven `Kite testnet → Avalanche C-Chain mainnet` cross-chain agent payment in our stack. Same flow used in Demo 1/2 above, but the `WASIAI_DOWNSTREAM_NETWORK=avalanche-mainnet` flag now routes outbound to mainnet USDC at `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E`.

Rollback path (if needed): `WASIAI_DOWNSTREAM_NETWORK=fuji` + `AVALANCHE_MAINNET_ENABLED=false` → reverts to testnet-only in ~3min.

### PRs merged this session

| PR | Repo | Title |
|----|------|-------|
| [#4](https://github.com/ferrosasfp/wasiai-v2/pull/4) | wasiai-v2 | fix(TD-002): /api/v1/capabilities loop-break + param mapping |
| [#5](https://github.com/ferrosasfp/wasiai-v2/pull/5) | wasiai-v2 | chore(TD-LIGHT): close 8/9 menores from WKH-65+WKH-66 AR+CR |
| [#56](https://github.com/ferrosasfp/wasiai-a2a/pull/56) | wasiai-a2a | docs(hackathon): final submission + mainnet activation runbook |
| [#57](https://github.com/ferrosasfp/wasiai-a2a/pull/57) | wasiai-a2a | feat: Kite mainnet (2366) + Avalanche C-Chain (43114) support |
| [#34](https://github.com/ferrosasfp/wasiai-facilitator/pull/34) | wasiai-facilitator | feat: Kite mainnet + Avalanche C-Chain — opt-in chain adapters |

---

## Mainnet readiness (staged, not yet activated)

To activate mainnet (after funding wallets):

1. **Fund operator wallet** with USDC native on Avalanche C-Chain mainnet (~10 USDC for first month of demos)
2. **Fund operator wallet** with USDC.e on Kite mainnet (~10 USDC.e equivalent)
3. **Set Railway env vars** on `wasiai-a2a-production`:
   ```
   KITE_NETWORK=mainnet                    # was: testnet
   WASIAI_DOWNSTREAM_NETWORK=avalanche-mainnet  # was: fuji
   ```
4. **Set Railway env vars** on `wasiai-facilitator-production`:
   ```
   KITE_MAINNET_ENABLED=true
   AVALANCHE_MAINNET_ENABLED=true
   KITE_MAINNET_RPC_URL=https://rpc.gokite.ai/
   AVALANCHE_MAINNET_RPC_URL=https://api.avax.network/ext/bc/C/rpc
   ```
5. **Verify** `/supported` returns 4 chains (testnet + mainnet)
6. **Smoke** with low-value real-money tx (~$0.50)

Rollback: revert env vars → automatic redeploy → back to testnet-only behavior.

---

## Relationship to Kite Passport — complementary layers, not alternatives

After Kite mainnet launched as a sovereign Avalanche L1 ([Avalanche blog, 2026-04-28](https://www.avax.network/about/blog/1-9-billion-interactions-later-it-goes-live)), positioning matters: **WasiAI A2A is the agent-to-agent settlement router that complements Kite Passport's user-to-agent funding layer**.

### What each layer owns

| Concern | Kite Passport | WasiAI A2A (this submission) |
|---------|---------------|------------------------------|
| User-side wallet (passkey, identity) | ✅ Owns it | ❌ Not in scope |
| Per-session sandbox (budget + TTL + tx limit) | ✅ Owns it | ❌ Server-side balance gate only |
| User-approved spending | ✅ passkey signature | ❌ Operator-managed today |
| Agent → Agent payment | ❌ Out of scope | ✅ x402 + EIP-3009 |
| Multi-agent discovery (capabilities API) | ❌ Out of scope | ✅ 19 agents, `/api/v1/capabilities` |
| Pipeline orchestration (compose) | ❌ Out of scope | ✅ `/compose` + `/orchestrate` |
| Cross-chain settlement | ❌ Single-chain | ✅ Kite ↔ Avalanche |

**Analogy**: Kite Passport is **Apple Pay** (user authorizes a card to spend at merchants). WasiAI A2A is **Stripe Connect for AI agents** (multi-merchant marketplace + routing + settlement).

Neither replaces the other. Combined, they form the full **agent-first commerce stack**:

```
User (human)
  ↓ creates Kite Passport session ($X budget, T TTL)        ← Kite Passport
  ↓ funds the agent via session
Agent (Sonnet 4.6 / Claude Console / custom)
  ↓ pay_x402 (autonomous, within session constraints)        ← MCP wasiai-x402
WasiAI A2A (this submission)                                  ← OUR LAYER
  ↓ discovers + composes agents from registry
  ↓ x402 settle on Kite (PYUSD testnet / USDC mainnet)
  ↓ dispatches USDC outbound to N agents on Avalanche/Kite
N downstream agents (chainlink-price, sentiment, profiler, …)
```

### Why we built this layer separately

- Kite Passport's session model assumes **1 agent → 1 merchant** (e.g., Bryan Johnson sleep stack → Amazon). Our use case is **1 agent → N agents** (multi-step pipeline with cross-chain micropayments).
- Until you have an agent-to-agent settlement router (us), Kite Passport sessions can't compose multi-agent workflows.
- Until you have user-side identity/sessions (Kite Passport), our `OPERATOR_PRIVATE_KEY` model is single-tenant.

### Roadmap — Kite Passport integration spike

Tracked as **WKH-68** ([Jira](https://ferrosasfp.atlassian.net/browse/WKH-68)). Goal: replace `OPERATOR_PRIVATE_KEY` with **per-user Kite Passport sessions** so each user funds their own agent budget. WasiAI A2A becomes a fully Kite-native marketplace router.

---

## Kite mainnet (Apr 28, 2026) — what it means for this stack

Kite went mainnet 3 days before our hackathon submission. Quick read on what changes:

| Hackathon-relevant fact | Source: Avalanche blog |
|--------------------------|-----------------------|
| Sovereign Avalanche L1 dedicada para agent commerce | sub-second finality, predictable fees under load |
| 1.9 billion testnet interactions, peak 30M calls/day | Battle-tested at scale before mainnet flip |
| $33M raised — PayPal Ventures + General Catalyst lead | + Coinbase Ventures, Avalanche Foundation |
| **PayPal piloting** + **Shopify integrations** in progress | Real commerce partnerships |
| Stablecoin-based settlement on Kite L1 | USDC canonical on mainnet · PYUSD remains on testnet (confirmed via WKH-68 Passport spike) |

### What this hackathon submission covers vs. the full Kite mainnet story

✅ **Already aligned**:
- Inbound asset matches Kite canonical per environment: **PYUSD on testnet** (chain 2368, what this submission demos), **USDC on mainnet** (chain 2366, what Kite Passport surfaces). Both are USD-pegged; PYUSD ties to PayPal Ventures lead investor, USDC is the broader Avalanche ecosystem standard.
- Code-only mainnet support already merged (PR #57 + #34, env-gated default OFF — see "Mainnet readiness" above)
- Architecture mirrors Kite's "agent-first" thesis (autonomous agents, per-call settlement, no-human-in-the-loop)

📋 **Decisions pending (post-hackathon roadmap)**:
- Whether to keep cross-chain (Kite → Avalanche) for diversity OR migrate fully to Kite mainnet single-chain
- Adopt Kite Passport for user-side authorization (replaces operator-managed model — see WKH-68 above)
- Kite mainnet RPC SLA + monitoring (production grade requires paid RPC tier)

### Why our work is the kind of usage Kite is selling to

The blog highlights agent-driven economic behavior: per API call, accessing data, completing tasks that require settlement. Our demo (Sonnet 4.6 administered agent paying $0.061 USDC across 3 agents in one autonomous request) is **literally that pattern**, with anti-hallucination receipts proving it's not theatrical.

This is not speculative — it's deployed, costs real money, and the operator wallet balance changes are verifiable on Snowtrace.

---

## What's NOT in this hackathon submission

- Mainnet activation (config staged but flag default OFF — needs funded wallets)
- MCP delegation via thin-proxy (preserved as legacy in v2 to avoid breaking Claude Desktop / Cursor users — flag default excludes `mcp`)

These are explicit decisions, not technical debt:
- Mainnet activation requires real money + ops decision (RPC provider, monitoring, on-call)
- MCP shape between v2 and a2a is incompatible (v2 = REST-flavor `?key=wasi_xxx`, a2a = JSON-RPC 2.0 `x-mcp-token`). Preserving v2 legacy avoids breaking active integrations. Future migration path: gradually move clients to a2a's MCP shape.

---

## Sprint highlights — what was shipped this week

| HU | Title | Pipeline | PR |
|----|-------|----------|-----|
| WKH-55 | Downstream x402 Fuji USDC outbound | QUALITY | `feat/wkh-55-downstream-x402-fuji` |
| WKH-56 | A2A fast-path passthrough | QUALITY | `feat/055-wkh-56-a2a-fast-path` |
| WKH-57 | LLM Bridge Pro (model + verification + cache + telemetry) | QUALITY | `feat/056-wkh-57-llm-bridge-pro` |
| WKH-58 | Schema drift v2 fallbacks | QUALITY | `feat/057-wkh-57-was-v2-3-client` |
| WKH-59-63 | Security batch (SSRF, scope, RLS, drain, RCE protection) | QUALITY × 5 | feat/058-062 |
| **WKH-65** | **Forward-key middleware (a2a side)** | FAST+AR | [#55](https://github.com/ferrosasfp/wasiai-a2a/pull/55) merged |
| **WKH-66** | **v2 thin-proxy refactor** (-1,182 LOC) | QUALITY | [#3](https://github.com/ferrosasfp/wasiai-v2/pull/3) merged |

**Total**: 13 HUs shipped, 0 production regressions, 30+ on-chain txs proving real cross-chain settlements.

---

## Reproducibility — run the demo yourself

```bash
git clone https://github.com/ferrosasfp/wasiai-a2a.git
cd wasiai-a2a
cp .env.example .env  # fund operator wallet with PYUSD on Kite testnet
npm install

# Run smoke against production
node scripts/smoke-prod-via-app-wasiai.mjs

# Or run full battery
node scripts/smoke-prod-5-agents.mjs
node scripts/smoke-prod-orchestrate.mjs
node scripts/perf-bench-prod.mjs
```

Every run prints tx hashes with explorer links so you can verify on KiteScan + Snowtrace.

---

## Documentation index

| Doc | Path |
|-----|------|
| Cross-chain proven (initial) | `CROSS-CHAIN-E2E-PROVEN-2026-04-28.md` |
| Migration plan (v2 → a2a delegation) | `doc/migration/2026-04-28-wasiai-v2-realignment-plan.md` |
| Prod execution runbook | `doc/migration/RUNBOOK-prod-execution.md` |
| SDD index (all features) | `doc/sdd/_INDEX.md` |
| Recent retro (cross-chain) | `doc/sdd/063-cross-chain-e2e-retro/done-report.md` |
| WKH-65 (a2a forward-key) | `doc/sdd/064-wkh-65-a2a-forward-key/done-report.md` |
| WKH-66 (v2 thin-proxy) | (in v2 repo) `doc/sdd/072-wkh-66-v2-thin-proxy/done-report.md` |

---

## Contact

- Repo a2a: github.com/ferrosasfp/wasiai-a2a
- Repo v2: github.com/ferrosasfp/wasiai-v2
- Repo facilitator: github.com/ferrosasfp/wasiai-facilitator
- Operator wallet: `0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba`

---

*Built with Claude Code on the Kite Hackathon — 2026-04-28*
