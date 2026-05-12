# WasiAI — Onchain Evidence Kit

**Purpose**: a complete, verifiable record of WasiAI's production state. Every claim in this kit is backed by a public transaction or a runtime endpoint that anyone can check independently.

Last updated: **2026-05-12**

---

## 1. Live production services (HTTP)

All four services were verified HTTP 200 on **2026-05-12**:

| Service | URL | Stack |
|---------|-----|-------|
| **Marketplace UI** | https://app.wasiai.io | Next.js + Vercel |
| **A2A gateway** | https://wasiai-a2a-production.up.railway.app | Fastify + Railway |
| **wasiai-facilitator** | https://wasiai-facilitator-production.up.railway.app | Fastify + Railway |
| **wasiai-x402 MCP** | https://wasiai-x402-mcp.vercel.app | Next.js + Vercel |

Quick health check from any terminal:
```bash
curl https://wasiai-facilitator-production.up.railway.app/health
curl https://wasiai-facilitator-production.up.railway.app/supported
```

---

## 2. Multi-chain operational state

The facilitator's `/supported` endpoint returns these chains live (verified today):

| Chain | CAIP-2 ID | Asset | Status | Breaker |
|-------|-----------|-------|--------|---------|
| Kite Testnet | `eip155:2368` | PYUSD | live | CLOSED ✓ |
| Avalanche Fuji | `eip155:43113` | USDC | live | CLOSED ✓ |
| Avalanche Mainnet | `eip155:43114` | USDC | live | CLOSED ✓ |
| Kite Mainnet | `eip155:2366` | USDC | opt-in (env-gated) | code-ready |

**What "breaker CLOSED" means**: each chain has a circuit breaker. CLOSED = healthy and accepting requests. Verifiable live at any time.

---

## 3. Onchain transaction evidence

### 3.1 Operational sovereignty proof — the strongest signal

Two transactions on Avalanche mainnet (chain 43114). **Same flow, same client wallet, same agent. The only difference is the facilitator.**

| Tx | Date | Operator (gas payer) | Verification |
|----|------|---------------------|--------------|
| `0x5fbf570b…` | 2026-05-11 (pre-flip) | `0x46140a86…` (Ultravioleta DAO) | [Snowtrace](https://snowtrace.io/tx/0x5fbf570bbc64d477586bb7aeaa71d5e6a1b4f6c540419172ec5b43f2e77733f2) |
| `0xf94d4005…` | 2026-05-11 (post-flip) | `0xf432baf1…` (**our wasiai-facilitator**) | [Snowtrace](https://snowtrace.io/tx/0xf94d4005e66b65ec6e34aa72b8b88966332f47859bb2038fb3f3d19ca04f614e) |

**The diff between these two transactions**: PR #6 merged + one environment variable flipped (`WASIAI_FACILITATOR_AS_PRIMARY=true`). That is operational sovereignty achieved on production rails. Anyone can verify in Snowtrace right now.

### 3.2 Sprint 4 mainnet evidence — first real money on mainnet

Captured 2026-04-29 during the mainnet hybrid mode activation.

| Tx | Service | Amount | Block |
|----|---------|--------|-------|
| `0x9fa6ff83…` | wasi-chainlink-price | $0.001 USDC | 84159513 [↗](https://snowtrace.io/tx/0x9fa6ff83eb10e51685ce078e69f9c42fcbe3b138b5b8c3f32909c9fee279c6f1) |
| `0xa22086d0…` | wasi-defi-sentiment | $0.010 USDC | confirmed [↗](https://snowtrace.io/tx/0xa22086d048b0222a8e08a5ca08997ae6c359e5ba674e63133a0ffbc463af16f9) |
| `0xca10320c…` | wasi-wallet-profiler | $0.050 USDC | confirmed [↗](https://snowtrace.io/tx/0xca10320c24ff513d773ce65e0bd306d4acce3e4883180c9dca5573da6cf1dfdb) |

Total: **$0.061 USDC mainnet** spent in a single end-to-end orchestration. Real money. Verifiable.

### 3.3 Kite Passport integration — real Passport-funded payment

Captured 2026-05-04 via WKH-69 Passport Hybrid (Model B).

| Field | Value |
|-------|-------|
| User session wallet chain | Kite mainnet (`eip155:2366`) |
| Service settled on | Base mainnet (`eip155:8453`) |
| Amount | $0.01 USDC (-0.01 USDC.e on Kite side) |
| Latency | 36 ms (cache hit) |
| Wire evidence file | `wasiai-a2a/doc/sdd/084-wkh-69-passport-hybrid-inbound/wire-evidence/parallel-200-evidence.json` |

This is **cross-chain transparent** payment — Kite Passport handled the bridge silently. The user only saw one USDC.e debit on Kite mainnet; the service got paid on Base.

### 3.4 Post-WFAC-53 multi-chain smokes — facilitator hardening validated

Captured 2026-05-11 after WFAC-53 (post-review hardening) deployed. Same EIP-3009 flow on each chain.

| Tx | Chain | Asset | Amount | Verification |
|----|-------|-------|--------|--------------|
| `0x93149974…` | Avalanche Fuji | USDC | 0.001 | [Snowtrace](https://testnet.snowtrace.io/tx/0x93149974cf06249109e3994c0e4fb835509c8116dd436aefc43883860329ee2e) |
| `0xb861b69b…` | Kite Testnet | PYUSD | 0.001 | [Kitescan](https://testnet.kitescan.ai/tx/0xb861b69b07def99e7b6e7f613fc3017ec42149f08fef4b15b24bc75d4acfe66c) |
| Avalanche mainnet `/verify` | Avalanche Mainnet | USDC | HTTP 200, settle skipped | (read-only check) |

Each smoke was end-to-end: sign EIP-712 → POST /verify → POST /settle → wait for receipt. All passing.

---

## 4. Operator wallet (gas payer for our facilitator)

| Field | Value |
|-------|-------|
| **Address** | `0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba` |
| **Avalanche mainnet** | [Snowtrace](https://snowtrace.io/address/0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba) |
| **Avalanche Fuji** | [Snowtrace testnet](https://testnet.snowtrace.io/address/0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba) |
| **Unified across services** | Same wallet operates on wasiai-facilitator + wasiai-a2a + wasiai-v2 |

Every successful settlement listed above has this address as the `from` field (gas payer). The client wallet (signer of the EIP-3009 authorization) is different — that is the gasless pattern working as designed.

---

## 5. Quality discipline

| Metric | Value |
|--------|-------|
| Tests across the stack | **1,660+** |
| ├ wasiai-a2a | 644 tests |
| ├ wasiai-v2 (marketplace) | 446 tests |
| └ wasiai-facilitator | 570 tests |
| TypeScript strict | Zero `any` explicit |
| ESLint `--max-warnings 0` | exit 0 on every merge |
| Breaking changes on major migrations | **0** |
| Production methodology | NexusAgil — analyst → architect → dev → adversarial review → QA → docs |
| Recent PRs shipped via AUTO QUALITY pipeline | wasiai-v2 #6 (WAS-V2-2) + wasiai-facilitator #35 (WFAC-53) on 2026-05-11 |

---

## 6. Open source repos

| Repo | Purpose | URL |
|------|---------|-----|
| `wasiai-a2a` | A2A protocol gateway | https://github.com/ferrosasfp/wasiai-a2a |
| `wasiai-v2` | Marketplace (Next.js) | https://github.com/ferrosasfp/wasiai-v2 |
| `wasiai-facilitator` | Self-hosted x402 facilitator | https://github.com/ferrosasfp/wasiai-facilitator |
| `wasiai-landing` | Marketing site (this domain) | https://github.com/ferrosasfp/wasiai-landing |

Public. Auditable end-to-end.

---

## 7. Key code references (for technical due diligence)

If a reviewer wants to verify our claims at the source level:

| Claim | File:line |
|------|-----------|
| Idempotency guard against double-charge | `wasiai-v2/src/lib/contracts/facilitator-router.ts:253-269` |
| ABI sync invariant test | `wasiai-facilitator/src/__tests__/unit/chain-adapter.test.ts:1051-1056` |
| Multi-chain DOMAIN_SEPARATOR boot check | `wasiai-facilitator/src/chains/init-domain-check.ts` |
| WAS-V2-2 router decision tree | `wasiai-v2/src/lib/contracts/facilitator-router.ts:188-284` |
| App-layer ownership guard (WKH-53) | `wasiai-a2a/CLAUDE.md` (Security Conventions section) |
| Threat model | `wasiai-facilitator/doc/architecture/SECURITY.md` |
| Post-merge production logs | `wasiai-v2/doc/sdd/073-was-v2-2-…/production-activation-log.md` |

---

## 8. Verification protocol — what anyone can do right now

1. **Open** [https://wasiai.io](https://wasiai.io) and click around the live marketplace.
2. **Curl** the facilitator health: `curl https://wasiai-facilitator-production.up.railway.app/supported`
3. **Open** [Snowtrace tx 0xf94d4005…](https://snowtrace.io/tx/0xf94d4005e66b65ec6e34aa72b8b88966332f47859bb2038fb3f3d19ca04f614e) — note the `From` field is our operator wallet.
4. **Compare** with [tx 0x5fbf570b…](https://snowtrace.io/tx/0x5fbf570bbc64d477586bb7aeaa71d5e6a1b4f6c540419172ec5b43f2e77733f2) — same flow, different `From`.
5. **Clone** any of the four repos and run `npm test` — every test passes on `main`.

No NDA. No demo gate. No private data room. Everything is public and verifiable.

---

## 9. What we do not yet have (honest disclosure)

| Gap | Status | Plan |
|-----|--------|------|
| Postgres-level RLS for ownership guard | App-layer enforced today | Tracked as WKH-SEC-02 in backlog |
| External security audit | Not done | Planned post-funding |
| Multi-sig operator wallet | Single hot key V1 | V2 priority (see SECURITY.md threat model) |
| Tempo protocol adapter | Not built | Conditional on Kite ecosystem direction |
| Self-service ksearch registration | Kite-controlled, curated | Pending Kite team expansion of allowlist |

These are documented openly because hiding them is worse than acknowledging them.

---

## 10. Contact

**Fernando Rosas** — `fernando@wasiai.io` — [LinkedIn](https://www.linkedin.com/in/fernando-rosas/)

For deeper technical discussion, the public repos are the best starting point. Every PR has an SDD (system design document), an adversarial review, and a QA report — full reasoning is publicly archived in each repo's `doc/sdd/` folder.
