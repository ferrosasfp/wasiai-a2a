# OKX.AI vs WasiAI A2A — Competitive Analysis & Improvement Roadmap

Date: 2026-07-03. Grounded in a deep read of OKX's Agent Payments Protocol (APP) whitepaper + Onchain OS + the wasiai-a2a codebase (HEAD `a5b4ca0`).

## Executive read

OKX.AI is **an open payment protocol (APP) wrapped in a closed, OKX-operated marketplace, powered by distribution** (150M exchange users, OKB, StraitsX/USDG, AWS/CertiK/EF partners, a $100k hackathon funnel). Two honest facts shape everything:

1. **We do not out-distribute OKX.** Their moat is reach, not tech. Competing head-to-head as "the horizontal agent economy" loses.
2. **But their protocol is genuinely more expressive on payments, and their marketplace is opaque where we can be transparent.** That is the actionable gap on both sides: adopt their good payment ideas; attack their opacity.

Our defensible ground stays: **true chain-neutrality (no X Layer/OKB gravity), fee transparency, shipped-not-promised, LATAM depth, open + self-hostable.** The improvements below serve that, not a doomed horizontal race.

Two framing corrections from the research (important):
- **"A2MCP" is not a separate protocol.** APP has one wire format with two transports (A2A / A2MCP). We already speak x402 + A2A + MCP + ERC-8004, so we are ~80% APP-aligned already.
- **APP defines four payment intents** (`charge` / `escrow` / `session` / `upto`), a richer vocabulary than our charge (x402) + prepaid-key model. This is the single biggest product gap worth closing.

## Side-by-side

| Dimension | OKX.AI (APP + marketplace) | WasiAI A2A (today) | Read |
|---|---|---|---|
| **Payment intents** | 4: charge, escrow, session (metered), upto (capped dual-signed) | charge (x402) + prepaid Agent-Key budget + quote-then-execute price cap | OKX richer; we have the best anti-overcharge gate |
| **Splits** | First-class atomic bps splits at settlement | Single protocol fee, credit-back on failure | Gap |
| **Transport** | HTTP, XMTP, Telegram, Discord, Email, SMS, **QR/offline** | HTTP only (must host an endpoint) | Big gap, LATAM-relevant |
| **Identity/wallet** | Agentic Wallet: email → EIP-7702, self-custodial, signing≠custody | Agent Key + EIP-712 delegation + sessions + spend-policies; BYO wallet | Ours deeper on delegation; theirs better end-user UX |
| **Gasless** | Broker-sponsored on X Layer | EIP-3009, **Kite-only** | Gap (Avalanche/Base gasless missing) |
| **Reputation** | Portable onchain, opaque algorithm | Off-chain volume×success heuristic + **read-only** ERC-8004 | Both shallow; we never write-back |
| **Disputes** | "Staked evaluators" — **unspecified / pluggable / not shipped** | Automated failure credit-back only, no arbitration | Both weak; theirs is marketing, ours is honest-but-absent |
| **Dev experience** | CLI/Skills (`npx skills add`) + MCP + REST; markdown skills | Raw HTTP; register a *marketplace URL*, not one agent; no shipped SDK | Gap (adoption) |
| **Settlement** | X Layer reference (USDT/USDG), chain-agnostic in principle | 4 chains proven per-request (Kite/Avalanche/Base), real mainnet USDC tx | **We win**: neutral + shipped |
| **Standards** | APP = MPP + x402 + ERC-8004 + XMTP + MCP, MIT, self-hostable Broker | Google A2A + x402 + ERC-8004 + MCP, MIT | Overlapping; they have more surface |
| **Fees** | Broker fee "out of protocol", **rate undisclosed** | Protocol fee, can be published | **We can win on transparency** |
| **Distribution** | 150M users, OKB, partners | Neutral, open, LATAM apps | They win; we niche |

## Improvement roadmap (prioritized)

### P0 — Quick wins (cheap, high leverage)
1. **Publish the fee, transparently.** OKX hides its take rate; lead with "transparent 1% on the orchestrated flow, no hidden broker fee." Positioning + a docs line. Effort: trivial. Reinforces a real advantage.
2. **Close the reputation loop (ERC-8004 write-back).** We already *read* ERC-8004 and have settled `a2a_events`; we never *write*. After settled tasks, write feedback/attestations to the ERC-8004 reputation/validation registry. Turns a read-only heuristic into shipped, portable on-chain reputation, matching OKX's headline claim but real. Effort: medium (reader + events already exist).
3. **Ship the SDK + `publish one agent in <5 min` self-serve.** Today integration is raw curl and you register a *marketplace URL*, so a solo dev cannot list a single agent. Ship the wasiai-sdk (typed client for discover/compose/orchestrate/pay) + a per-agent register flow. Biggest adoption unlock. Effort: medium.

### P1 — Payment expressiveness (adopt OKX's good ideas, stay APP-compatible)
4. **Add `session` and `upto` billing intents.** `session` = metered/streaming (deposit + off-chain vouchers, settle at close, refund residual) for per-token LLM billing; `upto` = Buyer caps, Seller reports usage, settle `min(cap, usage)`. Naming them APP-compatibly enables interop (see #10). Effort: medium-high. Closes the single biggest product gap.
5. **First-class atomic splits.** Generalize the protocol fee into bps splits (platform / creator / referral / royalty) routed at settlement. Effort: medium.

### P1/P2 — UX + reach (LATAM leverage)
6. **IM-native + QR payments (WhatsApp/Telegram first).** Remove the "must host HTTP" barrier: let an agent be invoked and paid over WhatsApp/Telegram or a QR/link. For LATAM (WhatsApp-first) + remittances (Chaski), this is a killer differentiator OKX gestures at but we can own in our vertical. Effort: high, highest LATAM payoff.
7. **Embedded agent-wallet + gasless beyond Kite.** OKX: email → Agentic Wallet (EIP-7702), gasless on X Layer. Ship an embedded wallet (email/passkey → EIP-7702 wallet) + gasless on Avalanche/Base, so end users never touch seed phrases or gas. Effort: high.

### P2 — Bigger bets
8. **Ship a real dispute/escrow-release path (leapfrog their promise).** OKX markets "staked evaluators" but the protocol leaves disputes *unspecified/pluggable* — it is not a shipped mechanism. We can leapfrog with something small but real: escrow intent + dispute window (release / dispute / timeout-self-release), starting with a designated resolver, later decentralized. Shipped beats promised. Effort: medium-high (escrow contract already staged).
9. **Task marketplace (demand side).** OKX has agents posting work; we have discovery + invocation only. This likely belongs in wasiai-v2 (the marketplace app), not the neutral gateway. Lower priority for the gateway.

### Strategic — Interoperability (the clever move)
10. **Implement an APP-compatible Broker / bridge.** APP is open (MPP + x402 + ERC-8004 + XMTP + MCP) and we are already ~80% aligned. Being able to speak APP makes our neutrality *concrete*: agents built for OKX's protocol can transact through our neutral gateway, and we defuse OKX's standards-alignment advantage. Positioning: **"the neutral layer that speaks everyone's protocol, including OKX's APP, without the X Layer lock-in."** This turns the competitor's own standard into our reach.

## Double down (our defensible advantages)
- **True chain-neutrality** vs X Layer/OKB gravity (their TVL is ~$6.5M; gasless + wallet live only on X Layer). Avalanche-home, settle on each agent's chain.
- **Fee transparency** (they hide it).
- **Shipped-not-promised**: real Avalanche mainnet USDC tx, live LATAM apps, vs their beta (~50 providers) and unspecified disputes.
- **LATAM vertical depth** + IM-native remittances.
- **Open + self-hostable + MIT** without a closed, approval-gated marketplace.

## Attack surface (OKX weaknesses to exploit in positioning)
1. Economic lock-in to X Layer / OKB despite "chain-agnostic" claims.
2. Fees undisclosed.
3. "Staked evaluator" disputes are marketing, not a shipped/documented mechanism (protocol leaves it open).
4. Reputation + matching are black boxes, portability unproven off-OKX.
5. Marketplace is closed with a manual listing-approval gate.
6. Custodial/exchange Broker "may hold funds across days and be licensed" — regulatory/counterparty surface a neutral protocol positions against.

## Recommendation
Do NOT enter their hackathon as the main play (building on their rails feeds the competitor). Instead run this as product strategy: **P0 now (fee transparency, reputation write-back, ship the SDK), P1 next (session/upto intents + splits), then the LATAM UX bets (IM/QR, embedded wallet) and the interop bridge.** Every item either closes a credibility gap OR sharpens neutral/LATAM/shipped. The hackathon, if used at all, is a time-boxed spike to learn Onchain OS from the inside, not a product bet.
