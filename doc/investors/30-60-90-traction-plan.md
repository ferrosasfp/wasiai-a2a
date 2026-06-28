# WasiAI 30 / 60 / 90 Traction Plan

Last updated: 2026-06-26
Goal of this plan: move WasiAI from "fundable as a prototype" to "fundable as a seed."

## North Star (90 days)

Three things must be true at the end of this plan:

1. **One external paying customer.** At least one third-party agent or marketplace paying the 1% protocol fee, not a first-party demo.
2. **Real mainnet third-party volume.** Genuine USDC settlements on mainnet from someone other than us, however small.
3. **An honest deck and metrics one-pager.** Numbers are real and modest; claims match what the audit and the dashboard can prove.

Owner hints: **Founder** (relationships, decisions, GTM), **Eng** (build / deploy / instrument), **External** (third parties: auditors, partners, regulated providers).

---

## Days 0-30: De-risk + honesty

The job this month is to stop overclaiming, remove the embarrassing gaps, and start the long-lead external work.

| # | Task | Owner | Success metric |
|---|------|-------|----------------|
| 1 | Kick off the external smart-contract audit. Get quotes, sign the engagement, hand over scope and code. | Founder + External | Audit engagement signed and started; kickoff date booked. |
| 2 | Deploy non-custodial escrow contracts to mainnet. | Eng | Contracts live on mainnet; addresses recorded. |
| 3 | Secure the operator wallet. Move to a multisig (ideally) before it touches real funds. | Eng + Founder | Operator funds held in multisig; signers documented. |
| 4 | Set gas-overhead env vars for mainnet economics (STEP_GAS_OVERHEAD_USD and related). | Eng | Mainnet flows account for gas; 1% fee does not run at a loss on a real settle. |
| 5 | Smoke a real low-value USDC settlement on mainnet end-to-end. | Eng | One clean mainnet settle with a tx hash; no self-transfer. |
| 6 | Regenerate the 3 cross-chain demo txs with distinct destination wallets. | Eng | Demo txs show real distinct sender / receiver; no self-transfers. |
| 7 | Add a CI gate that fails the build on test failures. | Eng | CI red-on-fail; ~2,000 tests gate merges. |
| 8 | Tighten the deck to be testnet-honest. | Founder | Deck states one mainnet settle, testnet baseline, $0 revenue, first-party-only demos. |
| 9 | Begin outreach to first external agent builders and marketplaces. | Founder | 10+ qualified conversations opened; a named prospect list exists. |
| 10 | Re-enable or clearly roadmap ERC-8004 / Passport binding. | Eng | Binding works, or deck marks it explicitly as roadmap. |

**End-of-30 state:** mainnet is real (one third-party-grade settle done by us), demos are honest, audit clock is running, and outreach has started.

---

## Days 31-60: First real volume

The job this month is to convert one conversation into one paying integration and to make the numbers measurable.

| # | Task | Owner | Success metric |
|---|------|-------|----------------|
| 1 | Land 1 design partner / external agent paying the 1% fee. | Founder + Eng | Signed design partner; first non-first-party paid invocation on mainnet. |
| 2 | Generate the first real dollars of revenue. | Founder | Revenue > $0 from an external party (small is fine). |
| 3 | Instrument a metrics dashboard: GMV routed, paid invocations, take-rate, active agents. | Eng | Live dashboard with the four core metrics, updating from real data. |
| 4 | Write the compliance-path memo. Either open a regulated BaaS / EMI partner conversation, or document the "infrastructure, not the money transmitter" legal position. | Founder + External | Written memo; if partner route, at least one provider conversation logged. |
| 5 | Pick a lower-regulatory wedge for investor conversations: agent API micropayments / data services over remittances. | Founder | Deck and pitch lead with the low-reg wedge; remittances reframed as vision. |
| 6 | Onboarding / integration docs for external agents. | Eng | A third party can integrate from public docs without hand-holding. |

**End-of-60 state:** at least one external party is paying, the take-rate is visible on a dashboard, and the regulatory story is written down rather than hand-waved.

---

## Days 61-90: Seed-ready

The job this month is to turn one data point into a small pattern and package it for a seed conversation.

| # | Task | Owner | Success metric |
|---|------|-------|----------------|
| 1 | Integrate 2-3 external agents / marketplaces. | Founder + Eng | 2-3 external integrations live and transacting on mainnet. |
| 2 | Publish the audit report. | External + Eng | Audit report received and published; findings remediated or tracked. |
| 3 | Produce a metrics one-pager with real (small but real) numbers. | Founder | One-pager: GMV routed, paid invocations, take-rate, active external agents. |
| 4 | Make one technical hire or present a credible hiring plan. | Founder | Hire signed, or a funded plan with named pipeline and option pool reserved. |
| 5 | Retitle and re-cut the deck for a seed conversation. | Founder | Seed deck framed around real traction, audit, and an integration pattern. |
| 6 | Assemble the full data room from the checklist. | Founder | Data-room checklist top-7 items all closed. |

**End-of-90 state:** multiple external parties transacting, a published audit, honest real numbers, and a deck that supports a seed conversation rather than a prototype demo.

---

## Milestone to investor-readiness map

| Milestone | Unlocks | Makes us ready for |
|-----------|---------|--------------------|
| Mainnet escrow deployed + real low-value settle (multisig operator) | Credible "it works with real money" claim | Ecosystem funds (Avalanche / Base / Kite), grant programs |
| Honest deck + regenerated demos + CI gate | A clean, no-overclaim story | Angels, accelerators |
| First external paying design partner (1% fee, real revenue) | Proof someone other than us will pay | Crypto / agentic-payments pre-seed micro-VCs |
| Metrics dashboard with real take-rate and active agents | Quantified, verifiable traction | Pre-seed micro-VCs leading a SAFE |
| Compliance-path memo + low-reg wedge positioning | Removes the regulatory red flag | Risk-aware angels and micro-VCs |
| Published external audit report | Security credibility for on-chain payments | Seed-stage diligence |
| 2-3 external integrations + technical hire / plan | A repeatable pattern, not a one-off | A seed conversation with institutional funds |
