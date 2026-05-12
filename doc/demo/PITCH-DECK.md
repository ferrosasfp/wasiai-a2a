# WasiAI A2A — Pitch Deck (Kite Hackathon)

**Format**: 14 slides + speaker notes
**Duration target**: 5-7 minutes
**Audience**: hackathon judges, Kite team, Web3 builders

---

## Slide 1 — Title

```
┌────────────────────────────────────────┐
│                                        │
│            WASIAI A2A                  │
│                                        │
│    The first cross-chain agent         │
│    payment protocol — natively         │
│    integrated with Kite Passport       │
│                                        │
│    Fernando Rosas | Kite Hackathon 2026│
│                                        │
└────────────────────────────────────────┘
```

**Speaker (15s)**:
> "Hi, I'm Fernando. I built WasiAI A2A — the first agent-to-agent payment protocol that natively integrates Kite Passport for multi-tenant cross-chain settlement. In 7 minutes I'll show you what we shipped, with real onchain evidence."

---

## Slide 2 — The problem

```
TODAY'S AGENTIC COMMERCE STACK IS BROKEN

┌─────────────────────────────────────────────┐
│ ❌ Single-chain prison                       │
│    Most x402 demos = one chain only          │
│                                              │
│ ❌ Identity friction                         │
│    Every agent asks: keys, gas, approvals    │
│    → adoption stops at 0.1% conversion       │
│                                              │
│ ❌ Marketplace banking middleman              │
│    All payments via ONE operator wallet      │
│    → not a protocol, just a closed gateway   │
└─────────────────────────────────────────────┘
```

**Speaker (30s)**:
> "Three problems. First, x402 demos are single-chain — but real agents live everywhere: Base, Avalanche, Kite, Solana. Users shouldn't bridge manually. Second, identity friction kills adoption — every integration asks for keys and gas. Third, marketplaces today funnel ALL payments through one operator wallet. That's a banking middleman pretending to be a protocol."

---

## Slide 3 — What WasiAI A2A does

```
ONE HTTP CALL → MULTI-CHAIN AGENTIC PAYMENT

User signs ONE x402 (Passport-funded USDC on Kite)
        ↓
WasiAI orchestrator picks N agents (LLM-driven)
        ↓
Each agent settles on its own chain (Base / Avalanche / etc.)
        ↓
Aggregated response back to user

ZERO bridges. ZERO approvals. ZERO gas in user UX.
```

**Speaker (30s)**:
> "WasiAI A2A: user pays once with Passport, our orchestrator fans out to N agents on N different chains, returns the aggregated result. Zero bridges. Zero approvals. Zero gas in the UX. One HTTP call."

---

## Slide 4 — Architecture (Model B Hybrid)

```
                     INBOUND (user → us)        OUTBOUND (us → agents)
                     Passport handles            Operator wallet handles
                     cross-chain                 cross-chain
   ┌──────┐   x402   ┌──────────────┐    x402    ┌─────────────┐
   │ User │─────────▶│  wasiai-a2a  │───────────▶│  N Agents   │
   │      │  USDC    │  orchestrator│   USDC     │  (any chain)│
   └──────┘          └──────────────┘            └─────────────┘
                            ↑
                     LLM picks agents from goal
                     Cache + transforms + auth
```

**Speaker (40s)**:
> "Model B Hybrid — decided after a structured spike (WKH-68). Passport handles INBOUND cross-chain transparently. Our operator wallet handles OUTBOUND with chain-of-best-fit logic. The user never sees a bridge. The LLM picks agents from a natural-language goal. We support full Google A2A spec, x402, and Kite Passport — all production-deployed."

---

## Slide 5 — Live evidence: mainnet hybrid

```
DEMO 1 — mainnet hybrid spend (2026-04-29)

  Inbound (Kite testnet):  1.0 PYUSD
  Outbound (Avalanche):    $0.061 USDC mainnet
  Total onchain txs:       4
  Latency:                 23s

  ✅ Snowtrace links in HACKATHON-FINAL.md
  ✅ Reproducible from app.wasiai.io
```

**Speaker (30s)**:
> "Real onchain evidence #1: in late April, we ran the first mainnet hybrid spend — Kite testnet inbound, Avalanche mainnet outbound. $0.061 USDC real money, 4 onchain transactions, Snowtrace verifiable. This was BEFORE the Passport integration."

---

## Slide 6 — Live evidence: Passport flow

```
DEMO 2 — Passport→x402 onchain (2026-05-04)

  User session wallet (Kite mainnet 2366):
    PRE:  2.46 USDC.e
                ↓
        kpass agent:session execute --url ...parallelmpp.dev/api/search
        Result: HTTP 200, content returned
                ↓
    POST: 2.45 USDC.e   (-$0.01 = exact match)

  Onchain settlement: chain 8453 (Base mainnet)
  ✅ Cross-chain transparent: USDC.e on Kite → USDC on Base
  ✅ Wire evidence: wire-evidence/parallel-200-evidence.json
```

**Speaker (45s)**:
> "Real onchain evidence #2 — captured today, May 4. We ran a real Passport-funded x402 payment. Pre-balance 2.46 USDC.e on Kite. After the call: 2.45 USDC.e — exactly $0.01 spent. The settlement happened on Base mainnet — chain 8453. Notice: the user's wallet was on Kite, but the service got paid on Base. **Passport handles the bridge silently.** This is the cross-chain transparency that wins UX. Wire evidence is committed in the repo."

---

## Slide 6.5 — Live evidence: operational sovereignty (the strongest proof)

```
DEMO 3 — Same flow, same client wallet, different facilitator (2026-05-11)

  BEFORE WAS-V2-2 flip (third-party Ultravioleta DAO):
    Tx:     0x5fbf570b...
    Signer: 0x46140a86... (Ultravioleta DAO operator)
    https://snowtrace.io/tx/0x5fbf570bbc64d477586bb7aeaa71d5e6a1b4f6c540419172ec5b43f2e77733f2

  AFTER WAS-V2-2 flip (our own infrastructure):
    Tx:     0xf94d4005...
    Signer: 0xf432baf1... (our wasiai-facilitator on Railway)
    https://snowtrace.io/tx/0xf94d4005e66b65ec6e34aa72b8b88966332f47859bb2038fb3f3d19ca04f614e

  Diff between the two:
    1 PR merged (WAS-V2-2 PR #6) + 1 env var flipped
    Same Avalanche mainnet (43114). Same demo client. Same agent.
    Different facilitator = different gas payer = different operator wallet.
```

**Speaker (40s)**:
> "Real onchain evidence #3 — same day, after we shipped WAS-V2-2 to production. Two transactions on Avalanche mainnet. Same flow, same user, same agent. Different facilitator. The only difference is one PR merged plus one environment variable flip. Before: gas paid by Ultravioleta DAO. After: gas paid by **our own facilitator wallet**. This is what operational sovereignty looks like — verifiable on snowtrace.io. We don't just consume x402 infrastructure, we operate it."

---

## Slide 7 — Hackathon shipping velocity

```
24+ PRs MERGED ACROSS 3 REPOS (2026-04-28 → 2026-05-12)

wasiai-a2a:
  PR #59: 🔴 Mainnet hybrid mode activated
  PR #60-#75: MCP server + sprint hardening + 5-HU production sprint
  PR #76: 🎯 KITE PASSPORT HYBRID (hackathon proof)
  PR #78: 🎯 SMOKE EVIDENCE (real onchain $0.01 captured)
  PR #79: 🎯 AUTONOMOUS RUNNER (CI-ready)
  PR #77: Passport CLI docs warning

wasiai-v2 (marketplace):
  PR #6:  🎯 WAS-V2-2 router primary=wasiai-facilitator (mainnet live)

wasiai-facilitator:
  PR #34: Kite mainnet + Avalanche mainnet adapters
  PR #35: 🎯 WFAC-53 multi-chain hardening (DOMAIN_SEPARATOR + CORS + fail-mode)
  PR #10, #1, #2: Dependabot actions bumps merged

1,660+ tests across 3 services. Zero regressions.
2 PRs shipped TODAY (2026-05-11) via NexusAgil AUTO QUALITY pipeline:
  marketplace router migration + facilitator hardening, both onchain-validated.
```

**Speaker (30s)**:
> "We didn't just ship code — we shipped through a structured 8-phase pipeline (analyst → architect → dev → adversary → QA → docs), all sub-agent orchestrated. 24+ PRs across 3 repos, 1,660+ tests across the stack. Two production-grade PRs in a single day yesterday via NexusAgil AUTO QUALITY pipeline. This is production discipline on hackathon timeline."

---

## Slide 8 — Differentiator: cross-chain UX

```
TYPICAL x402 demo            WASIAI A2A
─────────────────            ─────────────────
User on Base                 User on Kite via Passport
Pay USDC                     Pay USDC.e
Get response                 Settlement bridges to Base/Avalanche
                             Get aggregated multi-agent response

Single chain.                Cross-chain transparent.
Single agent.                N-agent fan-out.
```

**Speaker (20s)**:
> "Our differentiator: while other x402 demos are single-chain single-agent toy demos, we shipped multi-tenant, multi-chain, multi-agent — production-deployed."

---

## Slide 9 — Catalog dialogue with Kite team

```
WE ENGAGED THE KITE TEAM DIRECTLY DURING THE BUILD:

🔎 Discovery (smoke testing):
   → ksearch catalog has 10 allowlisted services
   → dev + prod share identical list
   → no public self-service registration

💬 Filed: Discord public Q + 2 DMs

✅ Kite team confirmed (2026-05-06):
   "no self-service flow right now as they're keeping
    a close eye on catalog quality. That said, we're
    expanding ksearch and it's something we could look
    into down the line!"

OUR TAKE:
   ➡️ Curation = quality. Respected design choice.
   ➡️ As ksearch expands, we're a natural candidate:
      hardened, tested, deployed.

CONSTRUCTIVE PROPOSALS (for the expansion phase):
   1. Vetted-builder tier (verified, hackathon graduates)
   2. Staging endpoint with broader access for E2E loops
   3. Public Tempo protocol docs
      (6/10 services use 'tempo', distinct from x402)
```

**Speaker (60s)**:
> "We engaged the Kite team directly while building. Discovered ksearch is curated — 10 services, no self-service. Filed a public Q on Discord plus DMs. The team responded officially: curation is intentional, for catalog quality, and they're expanding ksearch over time. **We respect that completely** — curation is what makes Passport-funded execution safe by default. Our service is hardened and ready for the expansion phase. As constructive input: a vetted-builder tier and public Tempo docs would help builders like us close the loop end-to-end."

---

## Slide 10 — Quality discipline (NexusAgil sub-agents)

```
EVERY PR through 8-phase pipeline:

  F0 Context grounding    → analyst sub-agent
  F1 Work item EARS ACs   → analyst sub-agent
  F2 SDD spec             → architect sub-agent
  F2.5 Story file         → architect sub-agent
  F3 Implementation       → dev sub-agent
  AR Adversarial review   → adversary sub-agent
  CR Code review          → adversary sub-agent
  F4 QA validation        → qa sub-agent
  DONE Pipeline closure   → docs sub-agent

  → No "vibe coded" PRs
  → Every BLQ found before prod
  → Auto-Blindaje captures process errors as lessons
```

**Speaker (30s)**:
> "Behind every PR: 8 specialized sub-agents. Analyst writes acceptance criteria in EARS format. Adversary attacks the implementation. QA verifies with file:line evidence. We caught 16+ real blockers across the sprint — including the cron schedule format bug that would have silently broken bearer rotation in prod. This is the methodology I built and refined during the hackathon."

---

## Slide 11 — Autonomous E2E smoke

```
PROBLEM: How do you test Passport flow in CI?
         Each session needs passkey approval.

SOLUTION: scripts/smoke-passport-autonomous.mjs

  Bootstrap (1× per 24h, requires passkey):
    kpass agent:session create --ttl 24h ...

  Autonomous run (no human, fits CI/cron):
    node scripts/smoke-passport-autonomous.mjs

  Output: structured JSON
    {
      "status": "success",
      "pre_balance_usdc":  2.46,
      "post_balance_usdc": 2.45,
      "balance_diff_usdc": 0.01,
      "diff_within_tolerance": true,
      "session_id_hash": "a1b2c3d4"  ← never plaintext
    }
```

**Speaker (30s)**:
> "I asked: 'can the E2E smoke be fully autonomous?' Yes — with a 24h pre-approved session, you can run unattended in CI. We shipped this as a reusable Node script. Six tests, structured JSON output, never logs the actual session ID — only its hash. CI-ready today."

---

## Slide 12 — Production state

```
LIVE IN PRODUCTION (verified runtime):

  ✅ wasiai-a2a-production.up.railway.app   /health 200
  ✅ wasiai-x402-mcp.vercel.app              /api/mcp 405 (POST-only)
  ✅ Discord alerting                        Embed renders 3 severities
  ✅ Bearer rotation cron                    Next: 2026-06-01 09:00 UTC
  ✅ Migration preflight                     Statement-aware, idempotent
  ✅ 4 cron jobs scheduled                   warmup, balance-check, rotate, invalidate

  Stack: Fastify + Postgres + Vercel + Railway + Supabase
  Tests: 816/816 passing, zero TS errors in production build
  Security: HSTS + CORS prod-restricted + RLS-staged + ownership guard
```

**Speaker (30s)**:
> "Everything is live, not staged. Railway prod, Vercel deploys, Discord alerts firing, cron jobs scheduled, 816 tests green. This is what production-grade looks like in 6 days of hackathon work."

---

## Slide 13 — What's next

```
WHEN KSEARCH EXPANDS (per Kite team):
  □ Submit wasiai-a2a-production for vetted listing
  □ Tempo adapter (if required for ecosystem coverage)
  → Until then: smoke runs Passport against catalog services
                (Parallel et al.) — sufficient proof of integration

PRODUCTION-100 ROADMAP:
  □ RLS hardening (Postgres-level row security)
  □ Rollback drill (DR readiness)
  □ On-call alerting wiring (PagerDuty / Opsgenie)
  □ Pricing tiers decision (current: 1% flat fee)

  ➡️ All 5 remaining tickets are non-coding (operations + business)
```

**Speaker (15s)**:
> "What's left is mostly operations, not coding. We're production-100 on the engineering side, and ready when ksearch opens up."

---

## Slide 14 — Closing

```
WASIAI A2A

The first cross-chain agent payment protocol with
native Kite Passport + operational sovereignty.

  ✅ 24+ PRs shipped across 3 repos
  ✅ 1,660+ tests across the stack — production-grade
  ✅ $0.061 mainnet + $0.01 Passport + marketplace user tx — onchain proof
  ✅ Cross-chain transparent (Kite → Base, captured live)
  ✅ Operational sovereignty: same flow, own facilitator (verifiable diff)
  ✅ 4 chains hardened: boot-time domain separator + CORS + fail-mode
  ✅ Autonomous CI-ready smoke runner
  ✅ Direct dialogue with Kite team on ksearch expansion

Repo: github.com/ferrosasfp/wasiai-a2a
Live: wasiai-a2a-production.up.railway.app

Thank you.
```

**Speaker (15s)**:
> "WasiAI A2A. Production-grade cross-chain agent payment with native Kite Passport, operational sovereignty over our own facilitator infrastructure, and four chains hardened at the protocol layer. Code, tests, onchain proof, live deployments — all verifiable in the repo. Thank you."

---

## Q&A prep — anticipated questions

| Q | A |
|---|---|
| "Why Model B Hybrid not pure Passport?" | Outbound cross-chain to Avalanche needs operator key. Passport doesn't address multi-party fan-out yet. |
| "How does Passport handle Kite→Base bridge?" | Passport's relayer infrastructure. Captured live in our wire evidence — chain_id 8453 returned despite our wallet on Kite mainnet 2366. |
| "What if Kite says 'use Tempo not x402'?" | We'd add a parallel Tempo adapter (~3-5 days). Won't drop x402 — it's the open standard. |
| "Does the Passport flow work today against your gateway?" | Architecturally yes, runtime gated by ksearch curation (Kite team confirmed catalog is intentionally curated, expanding over time). We have onchain evidence Passport works against allowed services + 16 tests proving our verifier accepts the Passport shape. We're queued for the expansion. |
| "What did Kite say when you asked about ksearch?" | They confirmed curation is by design — catalog quality. They said ksearch is expanding "down the line". We respect that — we're hardened and ready when it opens. |
| "Why 24+ PRs in 2 weeks isn't tech debt?" | Each went through 8-phase NexusAgil pipeline with adversarial review. AR found 16+ real bugs caught pre-merge. AUTO QUALITY pipeline ran 2 production-grade PRs in a single day yesterday. |
| "What's the moat?" | Multi-marketplace consumer pattern (wasiai-v2, others) + Model B Hybrid + operational sovereignty (own facilitator on 4 chains) + production discipline. Code is open source — moat is execution velocity + ecosystem position + infra control. |
| "What's operational sovereignty?" | The marketplace settles user payments through our own facilitator (`wasiai-facilitator` on Railway) instead of a third-party. Tx `0x5fbf570b` (pre-flip, via Ultravioleta DAO) vs tx `0xf94d4005` (post-flip, our infra) on snowtrace.io — same flow, different gas payer, verifiable by anyone. |

---

## Visual recommendations for actual deck

When converting to Keynote/Figma:
- **Theme**: dark background, neon green/cyan accent (web3/dev vibe)
- **Code blocks**: monospace font, syntax highlighting where relevant
- **Onchain evidence slides** (5, 6): include actual Snowtrace screenshots cropped to show tx hash
- **Architecture (slide 4)**: replace ASCII with proper diagram (Excalidraw or Figma)
- **Closing (slide 14)**: include QR code to repo
