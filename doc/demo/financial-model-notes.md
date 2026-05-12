# WasiAI — Financial Model Notes

**Purpose**: companion to `financial-model.csv`. Explains what each section is, what the assumptions mean, and where the numbers come from.

**Important**: This is an **illustrative forward-looking model**, not a commitment or guarantee. It is intended for early investor conversations and should be treated as a directional artifact, not an audited projection.

---

## How to read this CSV

Open `financial-model.csv` in **Google Sheets** (`File → Import → Upload`) or **Excel** (`File → Open`). It is organized in 6 sections separated by `=====` lines.

| Section | What it shows |
|---------|--------------|
| 1. Current burn | What we spend monthly today (founders deferred salary). |
| 2. Revenue model | Three streams across 3 years, with bear / base / bull year-3 scenarios. |
| 3. Post-funding burn | Target monthly burn after a seed round closes. |
| 4. Use of funds | How $1.5M (illustrative) would be deployed over 18 months. |
| 5. Key assumptions | The numbers we feed into Sections 2 + 3 — challenge these first. |
| 6. Sensitivity | Bear / base / bull outcomes plus zero-revenue worst-case. |

---

## Why our current burn is so low

Two founders, zero salaries. We have run WasiAI on **~$128/month** of hosted infrastructure since launch:

- Vercel (3 projects)
- Railway (3 services)
- Supabase (Pro tier shared)
- Anthropic API for the NexusAgil sub-agent pipeline (Claude usage)

This is intentional: we wanted the technical stack production-grade **before** taking outside capital, so the conversation with investors is about scaling adoption, not getting to a viable build.

---

## Revenue model — three streams

| Stream | Rationale |
|--------|-----------|
| **1% protocol fee on settlement** | Mirrors Stripe Connect's revenue model at marketplace baseline. Captured on every on-chain settlement routed through our facilitator. |
| **Premium discovery dashboards** | Marketplace operators using our gateway pay for advanced reputation scoring, agent analytics, and live monitoring (we already have the data — it's the cheapest revenue stream to monetize). |
| **B2B white-label licensing** | Other marketplaces (wasiai-v2 is one; others can be plugged in) embed the gateway and pay licensing for white-label deployment. This is the highest-leverage stream long-term. |

---

## Year-3 scenario logic

| Scenario | Revenue | What it requires |
|----------|---------|------------------|
| **Bear** ($180K) | Slow adoption | ~200 active agents + zero B2B licensees. The protocol works; growth is slow. |
| **Base** ($580K) | Standard curve | 1,000+ agents + 3-5 B2B licensees. Aligned with x402 ecosystem growth trajectory. |
| **Bull** ($1.36M) | Accelerated | Avalanche subnet partnerships + first ecosystem fund participation + multi-chain expansion. |

We default to **base** in our headline numbers. Bear is achievable without additional funding rounds. Bull requires partnership tailwinds we cannot control alone.

---

## Why a $1.5M seed (and not more or less)

| Bucket | Why this amount |
|--------|----------------|
| **Engineering (43%)** | Three senior engineers at LATAM market rate ($12K/mo) for 18 months. Lets us ship multi-chain expansion, marketplace SDK, audit prep, and enterprise integrations in parallel. |
| **BD (10%)** | One full-time partnerships person, LATAM-focused. Cheaper than US-based BD, with the network advantage. |
| **Founder salaries (14%)** | Modest comp at $6K/mo for both founders. Below market by design — extends runway. |
| **Security audit (5%)** | External firm review of the facilitator + EIP-3009 surface. Necessary before scaling mainnet TVL. |
| **Reserve (23%)** | Optionality buffer for opportunistic hires, conference travel, or extending runway if needed. |
| **Other (5%)** | Infra scaling, legal, accounting, tooling. |

**At $75K/month target burn, $1.5M = 20 months runway.** A smaller round forces compromises (fewer hires or no audit); a larger round risks dilution we do not yet need.

---

## Capital efficiency proof

The current state of the product (3 services live, 4 chains, 1,660+ tests, real onchain settlements) was built on **<$500 of capital deployed** to date (excluding founder time). This is not a slide — it's the receipts:

- ~$128/month × ~5 months = ~$640 hosting
- All other tooling: free tiers or sponsored (Anthropic credits)

A seed round funds the next phase of growth, not catching up to viable product.

---

## What can break this model

| Risk | Mitigation |
|------|-----------|
| x402 ecosystem stalls | We are chain-agnostic; can pivot to other agent-payment protocols if x402 loses traction. |
| Kite Passport closes | Our identity stack works without Passport (Agent Key + on-chain wallet). Passport is an enhancement, not a dependency. |
| Marketplace cold start | Sales-led B2B licensing path does not require user-side cold start. |
| Burn overrun | Founder salary tier is configurable; engineering hires can stagger. |

---

## Contact

For deeper conversations about the model:
- **Fernando Rosas** — fernando@wasiai.io
- All numbers are open to challenge; pushback welcome.

---

*Disclaimer: forward-looking statements are subject to change. This document is for informational purposes only and does not constitute an offer to sell or solicitation to buy any securities.*
