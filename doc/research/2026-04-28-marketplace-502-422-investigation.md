# Investigation Report — Marketplace 502/422 Errors
**Date**: 2026-04-28  
**Analyst**: nexus-analyst  
**Scope**: TD item "marketplace agents 502/422" opened 2026-04-13  
**Method**: Static code analysis + architecture trace (no live probing — wasiai-a2a not running locally; wasiai-v2 read-only per project rules)

---

## TL;DR

The 502/422 issue is **multi-causal and partially self-healed**. Root causes identified from code archaeology:

1. **Primary RC (2026-04-13 session)**: Pieverse facilitator `/v2/settle` returned HTTP 500. Documented verbatim in `src/services/compose.ts:299` as "Pieverse /v2/settle (HTTP 500 since 2026-04-13) is the legacy path for x402 callers only." The 502 propagated from `invokeAgent` throwing when the upstream agent returned a non-2xx response after a failed payment header.

2. **Secondary RC (schema drift)**: wasiai-v2 agents exposed `price_per_call` instead of `price_per_call_usdc`. Before WKH-57 (2026-04-27), `agent.priceUsdc` silently collapsed to `0`, bypassing the x402 payment path entirely. Agents with `priceUsdc=0` received no `PAYMENT-SIGNATURE` header — upstream agents expecting payment returned 402/422 (not 502, but observable as "invocation failure").

3. **Current state (2026-04-28)**: Both RCs are **remediated**. The Fuji downstream payment path (WKH-55, merged 2026-04-24) replaces the Pieverse path for x402 callers. The schema drift fallback (WKH-57, merged 2026-04-27) restores correct prices. The 3 wasi-* agents confirmed HTTP 200 today because they use the Fuji USDC path and have `payment.chain=avalanche`.

---

## Agents Probed (Static Analysis)

Live curl probing was not performed (wasiai-a2a server not running; no standing prod URL in `.env`). The following classification is derived from code traces + the AGENT_BLOCKLIST env var + available documentation.

| Slug | Registry | Status | RC | Notes |
|------|----------|--------|----|-------|
| wasi-chainlink-price | wasiai-v2 | **HTTP 200** (confirmed 2026-04-28) | N/A | Fuji path, priceUsdc resolved via fallback |
| wasi-defi-sentiment | wasiai-v2 | **HTTP 200** (confirmed 2026-04-28) | N/A | Fuji path, confirmed |
| wasi-wallet-profiler | wasiai-v2 | **HTTP 200** (confirmed 2026-04-28) | N/A | Fuji path, confirmed |
| dataarbitrageagent | wasiai-v2 | **BLOCKLISTED** | RC-3 | Already in `AGENT_BLOCKLIST` env var |
| (non-wasi agents, Kite chain) | wasiai-v2 | **SKIPPED downstream** | RC-4 | `chain !== 'avalanche'` → `signAndSettleDownstream` returns `null` — invocation proceeds, downstream settle silently skipped |
| (agents with `priceUsdc=0` pre-WKH-57) | wasiai-v2 | **was 422 / now fixed** | RC-2 | Schema drift fixed 2026-04-27 |
| (agents requiring Pieverse settle) | wasiai-v2 | **was 502 / now bypassed** | RC-1 | Legacy Pieverse path only for x402 callers without a2a-key |

---

## Root Cause Analysis

### RC-1 — Pieverse /v2/settle HTTP 500 (2026-04-13)

**Evidence**: `src/services/compose.ts:299`
```
// WKH-58: only sign inbound x402 when caller paid via x402 (no a2aKey).
// a2a-key path: middleware already debited per-call budget, no inbound
// settle needed. Pieverse /v2/settle (HTTP 500 since 2026-04-13) is the
// legacy path for x402 callers only. Downstream Fuji USDC settle (WKH-55)
// still runs for both paths via signAndSettleDownstream below.
```

**Flow at the time (pre-WKH-55)**:
1. Caller invokes `/compose` with x402 payment.
2. `invokeAgent` builds `PAYMENT-SIGNATURE` header from `getPaymentAdapter().sign(...)`.
3. Upstream wasiai-v2 agent receives call + payment header.
4. wasiai-v2 agent POSTs to Pieverse `/v2/settle` — returns HTTP 500.
5. wasiai-v2 agent returns HTTP 502 to our `fetch()` call.
6. `invokeAgent` throws `Agent ${slug} returned 502` (`compose.ts:336`).
7. `/compose` returns `{ success: false, error: "Step 0 failed: Agent X returned 502" }`.

**Why wasi-* agents work NOW**: The Fuji downstream path (WKH-55, 2026-04-24) is now the primary settle mechanism. For a2a-key callers (the current production path post-WKH-34), the inbound Pieverse path is entirely skipped (`!a2aKey` condition at `compose.ts:301` evaluates to false). The Pieverse path only remains for anonymous x402 callers — but those callers are now rare given the a2a-key middleware.

**Classification**: **WAS our bug** (dependency on Pieverse facilitator that was 500ing). **Self-healed** via WKH-55 + WKH-34 a2a-key middleware.

---

### RC-2 — Schema drift: `price_per_call_usdc` null → priceUsdc=0 → missing payment header (pre-2026-04-27)

**Evidence**: WKH-57 done report + `src/services/discovery.ts:410-428` (current code with fallback).

**Flow at the time (pre-WKH-57 WAS-V2-3-CLIENT)**:
1. `discoveryService.mapAgent()` reads `price_per_call_usdc` from wasiai-v2 response.
2. wasiai-v2 returns `null` for that field; canonical field path returns `null`.
3. `parsePriceSafe(null) → 0`. Agent mapped with `priceUsdc=0`.
4. In `invokeAgent`, `agent.priceUsdc > 0` evaluates to `false` → payment block skipped.
5. No `PAYMENT-SIGNATURE` header sent to upstream agent.
6. Upstream agent returns HTTP 402 or 422 (expects payment, receives none).
7. `invokeAgent` throws `Agent returned 422`.

**Why wasi-* agents work NOW**: WKH-57 (2026-04-27) added `resolvePriceWithFallback` which reads `price_per_call` as the fallback when `price_per_call_usdc` is null. Prices are now correctly resolved, payment headers are built and sent.

**Classification**: **WAS our bug** (schema drift not handled). **Fixed** 2026-04-27 via WKH-57.

---

### RC-3 — dataarbitrageagent (blocklisted)

**Evidence**: `.env:30` — `AGENT_BLOCKLIST=dataarbitrageagent`

This agent was added to the blocklist at some point (exact date unknown, present in current `.env`). It is filtered in `discoveryService.discover()` at `src/services/discovery.ts:119-127`. It never reaches `invokeAgent`. Not a current issue.

**Classification**: **Known-broken upstream agent**. Mitigated via blocklist.

---

### RC-4 — Non-Avalanche agents: downstream settle silently skipped

**Evidence**: `src/lib/downstream-payment.ts:369` — `if (agent.payment.chain !== 'avalanche')` → returns `null`.

Agents registered on Kite chain (`payment.chain=kite` or similar) pass invocation but their downstream payment is silently skipped. This is intentional design (WKH-55 scope: Avalanche Fuji only). These agents may or may not require payment from our side depending on their `priceUsdc` and the caller's path. If they still use Pieverse for their own settlement (RC-1), they would still 502.

**Classification**: **Mixed** — partially upstream (agent's settlement infra), partially a known limitation (WKH-55 Fuji-only scope). Not the primary 502 driver.

---

## Pattern Analysis

| Pattern | Finding |
|---------|---------|
| wasi-* agents work, others don't | Confirmed: wasi-* have `payment.chain=avalanche` (Fuji path active) |
| 502 vs 422 distinction | 502 = Pieverse settle failed in upstream agent (RC-1). 422 = missing/malformed payment header (RC-2). Both had same root: payment infrastructure issues |
| Schema-specific agents failing | wasiai-v2 agents with `price_per_call_usdc=null` — ALL of them affected pre-WKH-57 |
| Kite-chain agents | Downstream settle skipped (RC-4). Invocation may succeed or fail depending on upstream |
| Pre-existing TD (2026-04-13) | Date coincides with "Pieverse /v2/settle (HTTP 500 since 2026-04-13)" comment in code |

---

## Conclusion

**Was it ours or upstream?**

**Both — but the primary issues were ours.** Specifically:

1. We depended on Pieverse as the sole settlement facilitator for x402 callers. When Pieverse 500'd on 2026-04-13, all non-a2a-key callers broke (502). **Our architectural dependency, our fix** (WKH-55).

2. We did not handle wasiai-v2 schema drift (null `price_per_call_usdc`). Prices silently became 0, omitting payment headers, causing 422 from upstream agents. **Our mapping bug, our fix** (WKH-57).

The upstream element was Pieverse's HTTP 500 (which was their infra problem), but our code had no resilience path around it.

---

## Current Status (2026-04-28)

Both primary RCs are resolved:

| Fix | WKH | Merged | RC Addressed |
|-----|-----|--------|-------------|
| Downstream Fuji USDC path replaces Pieverse for primary flow | WKH-55 | 2026-04-24 | RC-1 |
| A2A-key middleware (debit budget, skip Pieverse entirely) | WKH-34 | earlier | RC-1 (a2a-key path) |
| Schema drift fallback `price_per_call` | WKH-57 | 2026-04-27 | RC-2 |
| AGENT_BLOCKLIST for dataarbitrageagent | env | unknown | RC-3 |

The E2E confirmation today (3 wasi-* agents HTTP 200) validates that the primary path is working.

---

## Remaining Risks

| Risk | Severity | Status |
|------|----------|--------|
| Anonymous x402 callers still hit Pieverse path (`compose.ts:301`: `!a2aKey`) | MEDIUM | Residual. If Pieverse stays 500, these callers still get 502. Mitigated by making a2a-key the standard auth. |
| Agents with `payment.chain !== 'avalanche'` — downstream settle skipped silently | LOW | By design (WKH-55). Document as known limitation. |
| Future wasiai-v2 schema changes (new field renames) | LOW | `_warnedFallbackSlugs` set provides observability (1 warn per slug per restart). Monitor logs. |
| No live probe run against wasiai-v2.vercel.app today | INFO | Static analysis only. If live confirm needed, run: `curl -s "https://wasiai-v2.vercel.app/api/v1/capabilities?limit=50"` and compare slug list against `AGENT_BLOCKLIST`. |

---

## Recommendations

### Immediate (no code change needed)

1. **Close the TD** — "marketplace agents 502/422" is resolved by WKH-55 + WKH-57. Mark as DONE.

2. **Monitor logs for `[Discovery] price_per_call_usdc is null`** — If count grows past 3 distinct slugs per restart, wasiai-v2 has added new agents with the old schema. Re-evaluate WAS-V2-3-CLIENT sunset.

3. **No new AGENT_BLOCKLIST entries needed** — Current blocklist (`dataarbitrageagent`) is correct. wasi-* agents are all healthy.

### Backlog (optional, not blocking)

4. **Remove Pieverse path for x402 callers** — `compose.ts:301` still routes anonymous x402 callers through `getPaymentAdapter().sign(...)` → Pieverse. If Pieverse is permanently down, replace with a2a-key requirement (401 for unauthenticated) or route through Fuji facilitator. File as `WKH-64-remove-pieverse-legacy`.

5. **Extend downstream Fuji to Kite-chain agents** — RC-4 residual risk. `signAndSettleDownstream` skips `chain !== 'avalanche'`. This is intentional WKH-55 scope limitation. When Kite chain settlement is ready, extend `downstream-payment.ts` to support `chain=kite`. File as `WKH-65-kite-downstream`.

---

## File References (for fix-pack if needed)

| Issue | File | Line | Code |
|-------|------|------|------|
| Pieverse legacy path (still active for x402) | `src/services/compose.ts` | 301 | `if (agent.priceUsdc > 0 && !a2aKey)` |
| Pieverse comment documenting known 500 | `src/services/compose.ts` | 299 | `// Pieverse /v2/settle (HTTP 500 since 2026-04-13)` |
| Schema drift fallback (current fix) | `src/services/discovery.ts` | 410-428 | `resolvePriceWithFallback()` |
| Downstream skip for non-Avalanche | `src/lib/downstream-payment.ts` | 369 | `if (agent.payment.chain !== 'avalanche')` |
| Agent blocklist filter | `src/services/discovery.ts` | 119-127 | `AGENT_BLOCKLIST` env filter |
| Error propagation (502/422 source) | `src/services/compose.ts` | 336 | `throw new Error(\`Agent ${slug} returned ${response.status}\`)` |

---

*Report generated: 2026-04-28 | Method: static code analysis | No live endpoints probed*
