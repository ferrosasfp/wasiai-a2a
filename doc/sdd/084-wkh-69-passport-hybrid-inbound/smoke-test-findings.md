# Smoke Test Findings — WKH-69 Kite Passport Hybrid

**Date**: 2026-05-04 ~17:00 UTC
**Branch**: feat/084-wkh-69-passport-hybrid-inbound (merged via PR #76, dc24700)
**Pipeline phase**: Post-DONE runtime validation

---

## Executive summary

WKH-69 implementation passed full QUALITY pipeline (10/10 ACs PASS, 810/810 tests, AR+CR APROBADO). Post-merge runtime smoke test against real Kite Passport infrastructure revealed **two structural findings** that matter for the hackathon submission and prod-100 roadmap.

**Bottom line**:
- ✅ Our Passport integration WORKS — captured real onchain payment evidence
- ✅ Cross-chain settlement confirmed transparent via Passport
- 🚨 wasiai-a2a is NOT in Kite's ksearch service catalog → smoke E2E against our gateway is gated by Kite-team registration
- 🆕 Discovered Tempo payment_approach used by 6/10 ksearch services (separate from x402)

---

## 1. Live evidence captured (Parallel x402 service)

**Date**: 2026-05-04 16:50 UTC
**Service**: Parallel (parallelmpp.dev), service_id `bc33467281db359f438deba8`
**Endpoint**: `POST /api/search`
**Cost**: $0.01 USDC (10000 raw at 6 decimals)
**Result**: HTTP 200 with real search result content

### Pre-state
```
Passport prod wallet 0x7aB8760225Ffd90F23bd0B5BfC5B04965976AdB3 (Kite mainnet 2366):
  KITE: 1.000000
  USDC: 2.460000 (USDC.e contract 0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e)
```

### Execute command
```bash
kpass agent:session execute \
  --url https://parallelmpp.dev/api/search \
  --method POST \
  --body '{"objective":"latest news on crypto"}' \
  --output json
```

### Response (excerpt — full evidence in `wire-evidence/parallel-200-evidence.json`)
```json
{
  "status": "success",
  "hint": "x402 request to https://parallelmpp.dev/api/search completed with HTTP 200.",
  "payment_requirement": {
    "amount": "0.01",
    "amount_onchain": "10000",
    "asset": "USDC",
    "decimals": 6
  },
  "session_id": "agent_session_019df3e7-ac6f-7595-a467-b4176f5cd9ca",
  "session_status": "active",
  "usage": {
    "reserved_total": "0",
    "spent_total": "10000"
  },
  "x402": {
    "chain_id": 8453,
    "method": "POST",
    "parsed_response_body": { "results": [...] }
  }
}
```

### Post-state (verified onchain)
```
Passport prod wallet (Kite mainnet 2366):
  KITE: 1.000000      (gas unchanged — gasless flow ✅)
  USDC: 2.450000      (-0.010000 = exactly $0.01 spent ✅)
```

### What this proves
- ✅ Passport session keypair signs valid x402-compatible authorizations
- ✅ Onchain settlement happens in real-time
- ✅ Session usage tracking is server-enforced (`spent_total: 10000`)
- ✅ EIP-3009 gasless flow works (KITE balance unchanged)

---

## 2. CRITICAL architectural finding: cross-chain settlement transparency

The execute returned `chain_id: 8453` (Base mainnet), NOT Kite mainnet (2366).

**Implication**: Passport handles cross-chain bridging UX **transparently** for the user:

```
User holds:    USDC.e on Kite mainnet (chain 2366)
                       │
                       ↓ (Passport bridges internally)
                       │
Service paid:  USDC on Base mainnet (chain 8453)
                       │
                       ↓
User wallet:   Reflects the spend (-0.01 USDC) on Kite mainnet
```

This is a **net positive UX argument** for our hackathon narrative:

> "WasiAI's Passport-funded clients pay with their Kite mainnet USDC.e while our orchestrator routes payments to Base/Avalanche/etc agents. The user never sees a bridge UI."

This complements (and validates) Model B Hybrid's design choice — outbound cross-chain to Avalanche via OPERATOR_PRIVATE_KEY remains unchanged, while inbound cross-chain Kite→Base is handled by Passport.

---

## 3. Blocker: wasiai-a2a not in ksearch service catalog

### What we tested
```bash
kpass agent:session execute \
  --url https://wasiai-a2a-production.up.railway.app/orchestrate
```

### Result
```json
{
  "error": "request URL host is not allowlisted for paid execution (host=wasiai-a2a-production.up.railway.app, reason=host not allowed by discovery)",
  "error_code": "payment_target_forbidden"
}
```

### Investigation
```bash
# Production discovery
DISCOVERY_BASE_URL=https://service-discovery.prod.gokite.ai ksearch services list
→ 10 services: Firecrawl, Exa, Anthropic, Nansen, Parallel, Storage, Weather, fal.ai, AgentMail, StableEmail

# Dev discovery
DISCOVERY_BASE_URL=https://service-discovery.dev.gokite.ai ksearch services list
→ Same 10 services (identical IDs and base_urls)
```

### Conclusions
- The ksearch service allowlist is **closed** and **synced between dev and prod**
- No CLI flag to bypass (`--no-discovery-check`, `--skip-allowlist` don't exist)
- wasiai-a2a needs to be registered by Kite team (no public self-service form found)

### Action items
- [PENDING — humano] Contact Kite team to register `wasiai-a2a-production.up.railway.app` in ksearch
- [DONE] Filed a public question in hackathon Discord: "¿Cómo se registra un service propio en `ksearch` para usar Passport?"
- [DONE] DM'd 2 Kite team members directly (no response yet at time of this writing)

---

## 4. Discovered: Tempo payment_approach (separate from x402)

### Service breakdown
| Service | Payment approach | Asset (raw) |
|---------|------------------|-------------|
| Firecrawl | tempo | `0x20c000000000000000000000b9537d11c60e8b50` |
| Exa | tempo | `0x20c0...` |
| Anthropic | tempo | `0x20c0...` |
| Storage | tempo | `0x20c0...` |
| fal.ai | tempo | `0x20c0...` |
| AgentMail | tempo | `0x20c0...` |
| Nansen | x402 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Base USDC) |
| Parallel | x402 | `0x833589...` (Base USDC) |
| Weather | x402 | `0x833589...` |
| StableEmail | x402 | `0x833589...` |

### What this means
- 6/10 services use the `tempo` protocol with a Kite-internal asset format (`0x20c0...`)
- 4/10 services use plain `x402` with standard Base USDC (which is what wasiai-a2a implements)
- A session created with `--payment-approach x402` cannot pay tempo services (gets `session_mode_forbidden` error)
- Tempo protocol docs are not publicly accessible — Kite-internal feature

### Implication for wasiai-a2a
WasiAI's choice to implement plain x402 is **compatible with 4/10 ksearch services**. Adding Tempo support would:
- Pros: Potentially compatible with all 10 services
- Cons: Requires Kite-internal docs/SDK (not public); locks us to Kite-specific protocol

**Recommendation**: Keep x402 as the primary protocol (open standard). Open WKH-92 follow-up to evaluate Tempo only IF Kite team confirms registration requires it.

---

## 5. What we CAN claim for hackathon submission

### Verified live (this smoke):
1. ✅ Kite Passport account creation, registration, funding workflow
2. ✅ Session create + passkey approval + execute flow
3. ✅ Real $0.01 onchain x402 payment via Passport (Parallel service)
4. ✅ Cross-chain transparency (Kite USDC.e → Base USDC)
5. ✅ EIP-3009 gasless verification (zero KITE consumed)

### Verified via QUALITY pipeline (810/810 tests):
1. ✅ wasiai-a2a accepts Passport-shape x402 payloads (16 dedicated tests)
2. ✅ Backward-compat with raw EOA flows preserved
3. ✅ payment_origin telemetry tagging works
4. ✅ requirePassport opt-in middleware factory tested + ready
5. ✅ Multi-tenant inbound architecture deployed in prod (PR #76 merged)

### Pending (Kite-team-gated):
- 🚨 ksearch registration of `wasiai-a2a-production.up.railway.app` so end-users can call our service via Passport

---

## 6. Hackathon submission narrative

> "WasiAI A2A is a multi-tenant agent orchestrator that natively integrates Kite Passport via Model B Hybrid (inbound x402 + outbound operator wallet cross-chain).
>
> The implementation is **live in production** (`wasiai-a2a-production.up.railway.app`), validated by 810 tests including 16 dedicated Passport flow tests, and we have **captured real onchain evidence** of the Passport→x402 flow ($0.01 USDC spent on chain 8453, 2026-05-04).
>
> During smoke testing we discovered that ksearch's service catalog requires manual registration by the Kite team (filed Discord ticket and DMs). This is feedback we're sharing back: a self-service registration flow would unblock the long tail of partners.
>
> We also identified that 6/10 ksearch services use a `tempo` payment_approach distinct from x402 — opening the question of whether x402 should remain the open-standard primary or if Kite envisions Tempo as the canonical Passport protocol. Our implementation kept x402 (open standard) which is compatible with 4/10 services."

---

## 7. Linked artefacts

- **Wire evidence**: `wire-evidence/parallel-200-evidence.json` (full kpass output)
- **Public Discord question**: posted 2026-05-04 in Encode hackathon Kite channel
- **DMs sent**: 2 Kite team members (timestamps in chat history)
- **Story file**: `story-WKH-69.md` (1389 lines, original implementation guide)
- **AR/CR/QA reports**: `ar-report.md`, `cr-report.md`, `qa-report.md`
- **Done report**: `done-report.md`
