# WasiAI A2A — Kite Hackathon Submission Writeup

**Project**: WasiAI A2A Protocol
**Tracks**: Kite Passport Integration + Cross-Chain Agent Payments
**Submission date**: 2026-05-04
**Repo**: https://github.com/ferrosasfp/wasiai-a2a
**Production**: https://wasiai-a2a-production.up.railway.app

---

## TL;DR (60 seconds)

WasiAI A2A is the **first cross-chain agent-to-agent payment protocol** that natively integrates **Kite Passport** as a multi-tenant funding layer. A user pays once with USDC (Kite mainnet via Passport), our orchestrator fans out to N agents, each settles on its preferred chain (Avalanche, Base, etc.), and the user gets one aggregated response — all in a single HTTP call.

We shipped the **complete Model B Hybrid integration** during the hackathon, including 16 dedicated tests, an autonomous E2E smoke runner, and **real onchain evidence** ($0.01 USDC live transaction via Passport).

---

## The problem we solve

Agentic commerce protocols today have three painful UX gaps:

1. **Single-chain prison**: most x402 implementations only settle on one chain. Real-world agents live on Base, Avalanche, Solana, Kite. Users shouldn't bridge manually.
2. **Identity friction**: every agent integration asks for keys, gas, approvals. Adoption stops at 0.1% conversion.
3. **No multi-tenant primitive**: marketplaces today funnel ALL payments through one operator wallet. That's a banking middleman, not a protocol.

WasiAI A2A solves all three.

---

## What we built

### Architecture (Model B Hybrid)

```
┌──────────────┐    USDC via Passport     ┌──────────────────┐    USDC cross-chain     ┌──────────────┐
│  End User    │ ────────────────────────▶│   wasiai-a2a     │ ───────────────────────▶│ N Downstream │
│  (Passport   │   (chain-agnostic, x402) │  (orchestrator)  │  (Base, Avalanche, etc.)│   Agents     │
│   session)   │                          │                  │                         │              │
└──────────────┘                          └──────────────────┘                         └──────────────┘
                                                  │
                                                  ├── Multi-tenant: each user funds their own budget
                                                  ├── LLM-driven planning (Claude Haiku 4.5)
                                                  ├── Cross-chain settlement transparent to caller
                                                  └── Full A2A protocol (Google A2A spec) compliance
```

**Key insight**: Passport handles inbound (user→us) cross-chain UX transparently. Our operator wallet handles outbound (us→agents) with chain-of-best-fit logic. The user never sees a bridge.

### Hackathon deliverables (verified live)

| Deliverable | Status | Evidence |
|-------------|--------|----------|
| **Multi-chain x402 settlement** (Kite testnet PYUSD inbound + Avalanche USDC outbound) | ✅ Live | 5 consecutive runs, p50 24.2s, $0.305 USDC moved, 20 onchain txs |
| **Mainnet hybrid mode** (Kite testnet inbound + Avalanche **mainnet** USDC outbound) | ✅ Live | $0.061 USDC mainnet spent, 4 onchain txs |
| **Kite Passport integration (Model B Hybrid)** | ✅ Live | PR #76 merged, 16 dedicated tests passing |
| **Real Passport onchain payment** | ✅ Captured | $0.01 USDC via Passport→Parallel service, chain 8453 (PR #78 wire evidence) |
| **Autonomous E2E smoke runner** | ✅ Live | `scripts/smoke-passport-autonomous.mjs` — no human at runtime (PR #79) |
| **Production-grade quality** | ✅ Live | 816 tests passing, AR/CR pipelines, sub-agent orchestration |

---

## Technical highlights

### 1. NexusAgil sub-agent orchestration (own methodology)

Every PR went through an 8-phase pipeline (F0+F1 → F2 → F2.5 → F3 → AR+CR → F4 → DONE) with specialized sub-agents (analyst, architect, dev, adversary, qa, docs). 6 of the 16 PRs found **0 BLQs in adversarial review** — production discipline.

### 2. Cross-chain transparency (the demo "wow")

```
User session wallet:    USDC.e on Kite mainnet (chain 2366)
                                  ↓
                        Passport bridges silently
                                  ↓
Service settled on:     USDC on Base mainnet (chain 8453)
                                  ↓
User wallet reflects:   -$0.01 USDC on Kite mainnet
```

Captured live on 2026-05-04 against the Parallel x402 service — see `wire-evidence/parallel-200-evidence.json` in the repo.

### 3. Autonomous smoke E2E

After one passkey-approved 24h session, our `scripts/smoke-passport-autonomous.mjs` runs unattended in CI / cron — captures pre/post balance, executes against any x402 target, verifies onchain settlement, exits with structured JSON. Suitable for monitoring.

### 4. Constructive feedback for Kite

During smoke testing, we discovered:
- ksearch service catalog is centrally controlled (10 services in dev + prod, identical allowlists)
- 6/10 services use a `tempo` payment_approach distinct from `x402`

We've filed a public Discord question + 2 DMs to the Kite team requesting:
- A self-service service registration flow (would unlock the long-tail of partners)
- Public Tempo protocol docs (or clarification on x402 vs Tempo positioning)

This is the kind of feedback Kite Passport needs at scale. Our submission documents this transparently as part of the hackathon deliverable.

---

## Differentiators

| | WasiAI A2A | Typical x402 demo |
|---|---|---|
| Cross-chain | ✅ Kite + Base + Avalanche | ❌ Single chain |
| Multi-tenant | ✅ Each user funds via Passport | ❌ One operator wallet |
| LLM orchestration | ✅ Claude picks agents from goal | ❌ Hardcoded routes |
| Production quality | ✅ 816 tests, sub-agent CR pipeline | ❌ Demo-grade |
| Real onchain evidence | ✅ $0.061 mainnet + $0.01 Passport | ⚠️ Often testnet-only |
| Autonomous smoke | ✅ One bootstrap, 24h headless | ❌ Manual every time |

---

## What's next

- **Pending Kite team coordination**: registration of `wasiai-a2a-production.up.railway.app` in ksearch for full Passport-funded smoke against our gateway
- **Production-100 backlog**: RLS hardening, rollback drill, on-call alerting, pricing decision (5 tickets remaining)
- **Tempo adapter** (conditional): if Kite confirms `tempo` is required for ecosystem, we'll add a parallel adapter (~3-5 days)

---

## Repo structure (what to look at first)

```
HACKATHON-FINAL.md                                       # historical hackathon submission baseline
doc/demo/                                                # ← THIS DIRECTORY
  HACKATHON-WRITEUP.md                                   # this file
  PITCH-DECK.md                                          # 14 slides + speaker notes
  DEMO-VIDEO-SCRIPT.md                                   # 3-min storyboard
doc/passport-onboarding.md                               # user guide: kpass install → fund → use
doc/runbooks/passport-smoke-autonomous.md                # CI integration
doc/sdd/084-wkh-69-passport-hybrid-inbound/              # full pipeline trace for WKH-69
  smoke-test-findings.md                                 # ← critical findings doc
  wire-evidence/parallel-200-evidence.json               # raw onchain proof
src/middleware/passport.ts                               # opt-in requirePassport factory
src/middleware/x402.ts                                   # paymentOrigin detection
src/middleware/event-tracking.ts                         # payment_origin telemetry
test/fixtures/passport-shape.ts                          # PASSPORT-MOCK-SHAPE block
scripts/smoke-passport-autonomous.mjs                    # CI-ready E2E runner
```

---

## Contact

**Builder**: Fernando Rosas (ferrosasfp@gmail.com)
**Discord**: see Encode Club Kite hackathon channel

We welcome collaboration with Kite team on ksearch registration + Tempo protocol clarification.
