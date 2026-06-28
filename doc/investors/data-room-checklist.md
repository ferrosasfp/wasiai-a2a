# WasiAI Pre-Seed Data Room Checklist

Last updated: 2026-06-26
Stage: pre-seed (SAFE, target $250k to $750k)
Audience: angels, crypto / agentic-payments pre-seed micro-VCs, ecosystem funds (Avalanche, Base, Kite), accelerators, grant programs.

## How to read the status markers

- **[READY]** Exists today and can be dropped into the data room as-is.
- **[PARTIAL]** Exists but is incomplete, informal, or needs cleanup before it is shareable.
- **[TO BUILD]** Does not exist yet. Needs to be created from scratch.
- **[FOUNDER]** Requires a founder decision, signature, or relationship. Cannot be produced by engineering work.

This is an honest checklist. Several items are gaps. The point is to know exactly what to assemble and what is still missing before sending the room to an investor.

---

## 1. Corporate / Legal

| Item | Status | Notes |
|------|--------|-------|
| Legal entity formed (C-Corp / equivalent holding entity) | [FOUNDER] | Confirm the entity of record for the raise. Two-founder LATAM team: decide jurisdiction (Delaware C-Corp is the default investors expect for a SAFE). |
| Certificate of incorporation / formation docs | [FOUNDER] | Pull from registered agent or formation provider. |
| EIN / tax ID | [FOUNDER] | Needed for SAFE and banking. |
| Founder IP assignment agreements | [TO BUILD] | Every founder and contractor must assign IP to the entity. Investors will ask. |
| Founders' agreement / vesting schedule | [FOUNDER] | Document equity split and vesting between the two founders. |
| Contractor / advisor agreements | [PARTIAL] | Collect any existing informal arrangements into signed docs. |
| Trademark status for "WasiAI" | [TO BUILD] | At minimum confirm no blocking conflict; filing optional at pre-seed. |
| Open-source license posture (SDK on npm) | [PARTIAL] | Confirm the license of the published SDK and that it matches intent. |
| Domain and brand ownership (wasiai.io, app.wasiai.io) | [READY] | Domains controlled by the team; confirm registrar access is consolidated. |

## 2. Product & Technology

| Item | Status | Notes |
|------|--------|-------|
| Product overview / architecture document | [PARTIAL] | Internal docs exist (`.nexus/project-context.md`, migration plan). Needs an external-facing one-pager. |
| Live product (gateway end-to-end on testnet) | [READY] | Runs end-to-end on Kite / Avalanche / Base testnet. |
| Mainnet deployment | [PARTIAL] | app.wasiai.io is mainnet-configured; one real mainnet settlement demonstrated; effectively no mainnet volume. Escrow contracts deployed on testnet only. |
| Test suite | [READY] | ~2,000 passing tests in the gateway, strict TypeScript. |
| CI gating on tests | [TO BUILD] | CI does not currently gate the test suite. Fix before sharing the repo or claiming "tested in CI". |
| Standards conformance (Google A2A, x402 / EIP-3009, ERC-8004, MCP) | [READY] | Implemented and demonstrable. Good differentiation talking point. |
| SDK published on npm | [READY] | Public package; include install + quickstart link. |
| Non-custodial escrow contracts | [PARTIAL] | Implemented and deployed on testnet only. Mainnet deploy pending. |
| ERC-8004 / Passport identity binding | [PARTIAL] | Binding currently disabled. Re-enable or clearly mark as roadmap. |
| Demo environment / scripted walkthrough | [PARTIAL] | Demos exist but 3 cross-chain demo txs are self-transfers; must regenerate with distinct destination wallets before showing. |
| Roadmap (12-18 months) | [TO BUILD] | Investor-facing roadmap tied to mainnet, integrations, and revenue. |
| Architecture diagram | [PARTIAL] | Internal understanding exists; produce a clean single diagram. |

## 3. Traction & Metrics

| Item | Status | Notes |
|------|--------|-------|
| Usage metrics dashboard | [TO BUILD] | No live dashboard for GMV routed, paid invocations, take-rate, active agents. Build before seed conversations. |
| Current usage numbers | [READY] | Honest baseline: ~$1.54 total testnet volume, ~34 paid invocations, 7 agents, 8 creator accounts. All first-party demos. |
| External paying customers | [TO BUILD] | Zero today. This is the single most important gap to close. |
| Real revenue | [TO BUILD] | $0 real revenue today. Fee logic (1% protocol fee; 90/10 marketplace split) is implemented. |
| Pipeline / design-partner list | [FOUNDER] | Build a named list of prospective external agent builders and marketplaces. |
| Letters of intent / design-partner agreements | [FOUNDER] | None yet. A single signed LOI materially de-risks the round. |
| Hackathon result | [READY] | 3rd place ($1,500), Kite AI Hackathon, Jun 2026. Credibility signal, not traction. |

## 4. Financials

| Item | Status | Notes |
|------|--------|-------|
| Historical financials | [READY] | Bootstrapped, minimal spend; a short summary of money in / money out is sufficient at pre-seed. |
| Current burn and runway | [FOUNDER] | State monthly burn (likely near zero) and personal runway honestly. |
| Use-of-funds plan for the raise | [TO BUILD] | Map the SAFE proceeds to audit, mainnet, first hires, and runway months. |
| Financial model / projections (18-24 months) | [TO BUILD] | Lightweight, assumption-driven. Tie revenue to take-rate x GMV routed, not top-down TAM. |
| Cap-table-aware spend plan | [FOUNDER] | What the team pays itself, if anything, during the raise period. |
| Bank account / treasury setup | [FOUNDER] | Confirm a business account exists for receiving SAFE funds. |

## 5. Security & Compliance

| Item | Status | Notes |
|------|--------|-------|
| Internal security review process | [READY] | Internal adversarial reviews + "NexusAudit" tooling + ownership guards + RLS. Document the process. |
| External smart-contract audit | [TO BUILD] | None today. This is an external dependency with lead time. Start the engagement immediately. |
| Audit report (published) | [TO BUILD] | Output of the above. Required to be seed-credible for an on-chain payments product. |
| Ownership guards / RLS documentation | [READY] | App-layer ownership filters + Postgres RLS implemented; document for reviewers. |
| Key management / operator wallet security | [PARTIAL] | Operator wallet should move to a multisig before handling real mainnet funds. |
| Regulatory / money-transmission analysis | [TO BUILD] | Flagship remittances demo implies money-transmission exposure. Need a legal memo: "infrastructure, not the money transmitter," or a regulated BaaS / EMI partner. |
| Compliance partner | [FOUNDER] | None engaged. Decide path: licensed partner vs. infra-only positioning. |
| Data privacy posture | [PARTIAL] | Document what user data is stored and where. |
| Incident / disclosure policy | [TO BUILD] | Lightweight security disclosure contact and process. |

## 6. Team

| Item | Status | Notes |
|------|--------|-------|
| Founder bios | [FOUNDER] | Two-founder LATAM team. Short bios emphasizing engineering depth and shipping velocity. |
| Founder roles and split | [FOUNDER] | Clarify who owns product, eng, GTM. |
| Org chart / hiring plan | [TO BUILD] | One technical hire or a credible plan to make one is a seed-readiness signal. |
| Advisors | [FOUNDER] | List advisors if any; formalize with agreements. |
| References | [FOUNDER] | Prepare 2-3 people who can vouch for the founders. |

## 7. Cap Table & Fundraise

| Item | Status | Notes |
|------|--------|-------|
| Current cap table | [FOUNDER] | Clean two-founder cap table; document it explicitly. |
| SAFE template and terms | [FOUNDER] | Decide cap / discount; use a standard post-money SAFE. |
| Prior financings / outstanding instruments | [READY] | None (bootstrapped, no grants taken to date). State this clearly; it is a strength. |
| Option pool plan | [TO BUILD] | Reserve a pool for the first hire(s). |
| Pitch deck (testnet-honest) | [PARTIAL] | Tighten to reflect testnet reality and the single mainnet settlement. No overclaiming. |
| Investor one-pager / metrics one-pager | [TO BUILD] | Short summary doc for the top of the data room. |
| Target investor list | [FOUNDER] | Angels, crypto / agentic-payments micro-VCs, ecosystem funds, accelerators, grants. |
| Grant applications status | [PARTIAL] | Ecosystem grants (Avalanche / Base / Kite) are credible non-dilutive sources; track applications. |

---

## Top 7 items to close before sending the data room

1. **Start the external smart-contract audit now.** [TO BUILD] It is the longest-lead external dependency and the biggest credibility gap for an on-chain payments product. Kick off the engagement before anything else.
2. **Regenerate the cross-chain demo txs with distinct destination wallets.** [TO BUILD] Three current demo txs are self-transfers. Showing self-transfers as "cross-chain payments" reads as misleading and will be caught. Fix before any demo.
3. **Confirm the legal entity, SAFE template, and clean cap table.** [FOUNDER] Investors cannot wire without an entity and an instrument. This blocks the close, not just the pitch.
4. **Make the deck testnet-honest.** [PARTIAL] One mainnet settlement, ~$1.54 testnet volume, all first-party demos, $0 revenue. Frame as a strong prototype with real engineering, not as commercial traction.
5. **Write the regulatory positioning memo.** [TO BUILD] Pick the lower-regulatory wedge (agent API micropayments / data services) for investor conversations and document the "infrastructure, not money transmitter" stance. Remittances stays as vision, not as the headline.
6. **Add the CI test gate.** [TO BUILD] ~2,000 tests that do not gate CI undercut the "engineering-strong" story. One config change converts a claim into a verifiable fact.
7. **Stand up a minimal metrics dashboard and one-pager.** [TO BUILD] Even small honest numbers (GMV routed, paid invocations, take-rate, active agents) presented cleanly beat narrative. This is what turns horizon-2 traction into a shareable artifact.
