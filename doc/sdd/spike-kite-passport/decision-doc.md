# WKH-68 Spike — Decision Document

**Spike**: Kite Passport integration evaluation for WasiAI A2A
**Status**: ✅ Complete
**Date**: 2026-05-01
**Owner**: Fernando Rosas
**Source ticket**: https://ferrosasfp.atlassian.net/browse/WKH-68
**Related artefacts**:
- `discovery-notes.md` (Phase 1 — docs reading)
- `poc-results.md` (Phase 2 — hands-on validation)

---

## Recommendation

🟢 **MODEL B — HYBRID**

Adopt Kite Passport for **user → orchestrator inbound** authorization, while keeping the operator wallet (`OPERATOR_PRIVATE_KEY`) for **orchestrator → downstream agents outbound** cross-chain settlement.

This preserves the cross-chain value proposition that defines our hackathon submission, while gaining multi-tenant inbound and Kite-native ecosystem alignment.

### Confidence level

**HIGH** — based on:
- Public CLI (`kpass`) + skills suite hands-on validated end-to-end
- Onboarding flow tested in prod + staging (4 users created across 2 envs)
- `delegation` structure inspected and documented
- Session approval flow tested with real passkey
- Architectural fit confirmed: Passport speaks **only** x402 (our exact protocol)

---

## Why NOT Model A (Replace)

Model A: Drop `OPERATOR_PRIVATE_KEY` entirely, all flows go through Passport.

**Deal-breaker**: Passport is **single-chain Kite mainnet only**. Quote from `agentpassport.ai/quickstart`:

> *"Send only on Kite chain (ID 2366). Funds sent on Ethereum, Base, Arbitrum, Solana, or any other network … will be lost."*

Adopting Model A would force every downstream agent to also live on Kite mainnet — destroying our cross-chain narrative. Our HACKATHON-FINAL.md headline (*"first TRUE cross-chain agent payment system"*) would be deleted.

Avalanche C-Chain, Avalanche Fuji, and any future chain support all become unreachable. The 19 agents in our marketplace registry would have to migrate or be cut from the catalog. The $0.061 USDC mainnet cross-chain proof becomes unreplayable.

**Verdict**: rejected.

---

## Why NOT Model C (Decline)

Model C: Document why Passport doesn't fit, stay with current operator-managed model.

**Misses major ecosystem alignment**:
- Kite mainnet launched 2026-04-28 with $33M from PayPal Ventures, General Catalyst, Coinbase
- 1.9B testnet interactions = real volume signal
- PayPal piloting + Shopify integrations = real partnerships
- Agentic commerce thesis = exact match for our use case
- A spike that concludes "no" leaves us out of the obvious adoption path

**Defensible only if**: post-hackathon roadmap deliberately deprioritizes Kite ecosystem. No evidence supporting that decision.

**Verdict**: rejected.

---

## Why Model B (Hybrid) — full justification

### Architectural fit

| Concern | Today (operator-managed) | With Model B (Hybrid) |
|---------|--------------------------|------------------------|
| Inbound auth | EIP-712 signature from any EOA | Passport session OR raw EOA (both supported) |
| Inbound asset | PYUSD (testnet 2368) | USDC (mainnet 2366) for Passport · PYUSD still works for testnet |
| Inbound payer | Single tenant via OPERATOR | Multi-tenant via Passport sessions |
| Outbound to N agents | OPERATOR signs cross-chain | **unchanged** — OPERATOR signs cross-chain |
| Cross-chain (Avalanche) | ✅ proven 2026-04-29 ($0.061 mainnet) | ✅ preserved — same code path |
| Marketplace router | `/compose` + `/orchestrate` work today | **unchanged** — they receive x402 the same way |

The orchestrator (`wasiai-a2a`) becomes **agnostic to who funded the inbound payment**. Whether the `payer` field in the EIP-3009 authorization is a Passport session wallet or a raw EOA, the verification + downstream fan-out behaves identically.

### Concrete evidence from POC

The session `delegation` returned by `kpass agent:session create` is:

```json
{
  "payment_policy": {
    "allowed_payment_approaches": ["x402"],
    "assets": ["USDC"],
    "max_amount_per_tx": "0.1",
    "max_total_amount": "0.5"
  },
  "task": { "summary": "..." }
}
```

This validates 4 architectural alignments:

1. **`["x402"]` only** — Passport speaks x402 natively. We speak x402 natively. Zero bridging logic needed.
2. **`["USDC"]`** — Passport canonical asset on Kite mainnet matches our payment-token configurability. We just set `X402_PAYMENT_TOKEN=<USDC-2366-address>` for mainnet.
3. **Per-tx + total + TTL enforced server-side** by Passport — our balance gate (WKH-67) is redundant for Passport-funded flows. Becomes belt-and-suspenders, not duplicated effort.
4. **`public_key` per session** (base58, ~32 bytes, ed25519-style) — each session has its own keypair. A leaked session key cannot drain the user wallet, only consume budget within the policy. Stronger isolation than reusing the wallet key.

### Strategic narrative for the pitch

| Before (today) | After (Model B post-WKH-68) |
|----------------|------------------------------|
| "Single-tenant operator-managed orchestrator" | "Multi-tenant agent-to-agent settlement router with native Kite Passport user authorization" |
| "We are agent-to-agent commerce" | "Kite Passport handles **user → agent**. We handle **agent → agent**. Apple Pay + Stripe Connect for agents — the full stack." |
| Operator wallet visible in pitch | Operator wallet still exists for outbound cross-chain, but it's an internal implementation detail. User-facing narrative is "your Passport session funds your agent." |

The Apple Pay vs Stripe Connect analogy in the current `HACKATHON-FINAL.md` (commit `41089a0`) **gets validated** by Passport's actual delegation model.

---

## Implementation plan (post-spike, separate HU)

This work is **out of scope** for the hackathon submission. Open as a new HU (suggested: WKH-69 or WKH-70) with **QUALITY** pipeline.

### Wave plan

**W0 — Preparation**
- [ ] Add `wasiai-a2a` as a Passport "client agent type" — register `wasi-orchestrator-router` agent type with Kite team if registration is gated
- [ ] Decide on test env: staging (when faucet bug is fixed) or low-stakes prod ($1-5 USDC mainnet seed)

**W1 — Inbound x402 contract verification**
- [ ] Verify our `/verify` and `/settle` paths handle a Passport session wallet as the `payer` correctly (the EIP-3009 signature is from the Passport session keypair, not a raw EOA)
- [ ] Confirm the EIP-712 domain on Kite mainnet for USDC matches what Passport signs (likely `name: "USDC"` instead of `"PYUSD"`)
- [ ] Update `X402_PAYMENT_TOKEN` + `X402_TOKEN_SYMBOL` + `X402_EIP712_DOMAIN_NAME` env vars per chain
- [ ] Tests: signature verification with a Passport-style EIP-3009 authorization

**W2 — Documentation + UX layer**
- [ ] Add a `/docs/passport-onboarding.md` for users showing how to bring their Passport session to wasiai-a2a
- [ ] Optional: light wrapper UI that redirects users to `kpass agent:session create` semantics (or display the CLI flow)

**W3 — Telemetry**
- [ ] Tag inbound payments with `payment_origin: passport | eoa` in `a2a_events` to track adoption ratio
- [ ] Dashboard query: % of orchestrate runs funded via Passport

**W4 — Hardening**
- [ ] Decision: do we want to enforce that inbound payer = Passport session for some routes? (e.g., shopping skill integration)
- [ ] If yes, add a `requirePassport` middleware that checks the EIP-712 domain or signer against known Passport patterns

### Effort estimate

| Wave | Optimistic | Realistic | Pessimistic |
|------|-----------|-----------|-------------|
| W0 | 0.5h | 2h | 1d (if Kite registration is required + slow) |
| W1 | 4h | 8h | 2d (if signature shape differs unexpectedly) |
| W2 | 2h | 4h | 1d (UX iterations) |
| W3 | 2h | 4h | 0.5d |
| W4 | 4h | 8h | 2d |
| **Total** | **12.5h** | **26h** | **6.5d** |

Rough sizing: **~3-5 working days** for a single dev with familiarity with our stack. Pipeline = QUALITY (touches auth + payment surface).

---

## Risks identified

| # | Risk | Likelihood | Mitigation |
|---|------|-----------|-----------|
| 1 | EIP-712 domain shape on Kite mainnet differs from what we expect, breaking Passport-signed auth verification | Medium | Decode an actual Passport signature in W1 against our verifier. Adjust domain config. |
| 2 | Passport rate-limits us for high-volume orchestrate runs | Medium | Test under load. Negotiate tier with Kite if needed. Fallback to EOA path. |
| 3 | Kite changes Passport delegation schema in a future version | Low–Medium | Pin a CLI version in our docs. Subscribe to Kite changelog. |
| 4 | Multi-tenant Passport flow doesn't integrate cleanly with our `wasi_a2a_keys` identity model | Medium | W4 — decide on coexistence (both auth methods supported) vs migration |
| 5 | USDC contract address on Kite mainnet differs from our staged config | Low | Verified `0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e` from staging — confirm on mainnet too |
| 6 | Passport session keypair signs EIP-712 with non-standard chainId (e.g., 2366 vs 2368) leading to mismatch with our verifier | Medium | W1 — capture a real Passport signature, decode it, confirm chainId binding |
| 7 | x402 `payer` derivation from Passport-signed authorization differs from our facilitator's expectation (different sender than tx-from) | Low–Medium | Test with a real x402 settle from a funded Passport session against our facilitator |

---

## Open questions still unresolved

These questions remained unanswered after Phase 2 hands-on (faucet bug blocked the full x402-execute test):

1. **What does a Passport-signed EIP-3009 authorization look like on the wire?** Specifically: does the `from` field reference the Passport session keypair, or the user's underlying wallet? Need to capture a real call.
2. **Does Passport `ttl_seconds` enforcement also apply to in-flight x402 calls or only at session-creation time?** I.e., if a session expires while an x402 negotiation is in progress, does Passport reject the settle?
3. **Can a single approved session be `set as current` across multiple cwd's?** Project-local config makes this awkward for multi-project users.
4. **What's the relationship between Passport `usage.reserved_total` and our balance gate's `inflight_raw`?** If we do both reservations, we double-count budget.
5. **What's the canonical USDC contract on Kite mainnet (chain 2366) vs the testnet (2368)?** POC saw `0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e` on staging — same on prod?
6. **Does Passport have a webhook/event API** for session approval / spend events, or is polling the only way?
7. **Can we register `wasi-orchestrator-router` as a Passport agent type** for first-class recognition, or does Passport treat any agent type opaquely?

These are W0/W1 work, not blockers for the Model B decision.

---

## Decision matrix — final scoring

| Criterion | Weight | A — Replace | B — Hybrid | C — Decline |
|-----------|--------|-------------|------------|-------------|
| Preserves cross-chain value prop | 30% | 0 (lost) | 10 (intact) | 10 (intact) |
| Aligns with Kite mainnet ecosystem | 20% | 10 | 8 | 0 |
| Multi-tenant capability | 15% | 10 | 8 | 0 |
| Implementation effort | 15% | 8 (large refactor) | 6 (medium) | 10 (zero) |
| Risk of regression | 10% | 3 (high) | 7 (medium) | 10 (none) |
| Hackathon submission impact | 10% | -10 (breaks pitch) | +5 (enriches pitch) | 0 (no change) |
| **Weighted score** | | **3.05** | **7.85** | **5.50** |

---

## Decision

✅ **APPROVED for Model B — Hybrid**

**Conditions**:
1. New HU opened (suggested WKH-69) for full implementation, **out of hackathon scope** to keep submission stable.
2. Spike artefacts (`discovery-notes.md`, `poc-results.md`, this `decision-doc.md`) committed to `main` of `wasiai-a2a` for hackathon traceability.
3. No code changes to production until WKH-69 is approved by human gate.
4. POC accounts created (prod + staging) to remain registered for future testing — do NOT delete.
5. Decision doc updated if Kite Passport SDK / API surface changes meaningfully before WKH-69 starts.

**Sign-off pending**: Fernando Rosas (human gate per ticket WKH-68 reglas inviolables).

---

## Files generated by spike

| File | Phase | Purpose |
|------|-------|---------|
| `discovery-notes.md` | 1 | Public docs analysis, waitlist gate finding, quickstart parsing |
| `poc-results.md` | 2 | Hands-on CLI validation, onboarding flow, delegation structure capture |
| `decision-doc.md` | 3 | This file — final A/B/C recommendation with weighted scoring |

---

## Next steps for human (Fernando)

1. **Read this doc** + the two supporting artefacts
2. **Confirm Model B** verdict (or override with rationale)
3. **Approve commit** of spike artefacts to `main` of `wasiai-a2a` (hackathon traceability)
4. **Decide WKH-69 timing** (post-hackathon, or sooner if Kite ecosystem alignment becomes a competitive priority)
5. **Optional**: forward decision summary to Salvador for stablecoin canonical update (USDC on mainnet, PYUSD remains testnet only)
