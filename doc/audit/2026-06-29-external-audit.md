# External Security Audit — WasiAI Ecosystem

**Date:** 2026-06-29
**Type:** Simulated external audit (Trail of Bits / OpenZeppelin / Consensys Diligence + OWASP methodology)
**Method:** 5 specialized auditors (read-only) + 3 adversarial verifiers on HIGH findings + 2 adversarial reviews (AR) on the remediation.
**Standards:** OWASP API Top 10 (2023), OWASP Smart Contract Top 10 (2025), SWC, OWASP SCSVS.
**Tooling executed:** Slither 0.11.5, Foundry (285 contract tests), `npm audit`, manual line-by-line review, threat modeling.

---

## Scope

| Project | Depth | Role |
|---------|-------|------|
| wasiai-a2a | Full | Neutral A2A gateway (x402, agent-key auth, discovery/compose/orchestrate) |
| wasiai-facilitator | Full | x402 settlement relayer (EIP-3009, on-chain broadcast) |
| wasiai-v2 | Full | Marketplace (Next.js), consumes a2a, charges x402 |
| Solidity contracts | Full | Escrow (a2a), Marketplace + Escrow (v2), Lendable |
| wasiai-sdk | Full | Public `@wasiai/sdk` npm package |
| 9 peripheral projects | Sweep | Demos, CLI, landing, hackathon variants (secrets + supply-chain) |

---

## Executive verdict

**Posture: SOLID for a pre-seed / MVP stage. Zero Critical findings across the entire ecosystem.**

The smart contracts (where funds are custodied) are clean: Slither reports no high-severity detectors, 285 Foundry tests pass, and solvency invariants are fuzzed (escrow: 12,800 calls/invariant; "operator cannot move funds without a valid signature" property holds). The money-path core (atomic `FOR UPDATE` debits, x402 recipient+amount binding, nonce anti-replay, refund-on-failure, app-layer + DB-level ownership guards) is well-defended and was independently verified.

The confirmed HIGH findings were all the **same class** (SSRF via unvalidated redirect) with **~1-line fixes**, all remediated and adversarially re-reviewed (APROBADO).

### Severity counts (post-verification)

| Project | Critical | High | Medium | Low |
|---------|:--------:|:----:|:------:|:---:|
| a2a gateway | 0 | 1 | 3 | 4 |
| facilitator | 0 | 0 | 0 | 2 |
| v2 marketplace | 0 | 1 (+1 founder) | 7 | 5 |
| contracts | 0 | 0 | 1 | 6 |
| sdk + peripheral | 0 | 0 | 2 | 3 |

---

## Confirmed HIGH findings (adversarially verified) — ALL REMEDIATED

### H-1 · a2a · SSRF via redirect with credential exfiltration — **CONFIRMED (PoC)** → FIXED (PR #139)
`src/lib/ssrf-dispatcher.ts` + `services/compose.ts:830`. The connect-time `lookup` guard never fires for literal-IP hosts, and `ssrfFetch` used `redirect:'follow'` without re-validating `Location`. A 302 → `http://169.254.169.254/` was followed, re-sending `x-a2a-key` + `payment-signature` to the internal host (reproduced end-to-end).
**Fix:** `redirect:'manual'` + bounded per-hop loop running `assertUrlAllowed` (literal-IP guard + `validateOutboundUrl`) before each hop; credential-header stripping on cross-origin redirects (same-host http→https upgrade retains). AR: every encoding/rebind/credential-retention vector attacked and defeated.

### H-2 · v2 · Anonymous SSRF on free-trial invoke — **CONFIRMED** → FIXED (PR #23, awaiting mainnet merge)
`src/app/api/v1/agents/[slug]/trial/route.ts:218`. Validate-then-plain-`fetch` (TOCTOU). Anonymous (IP-rate-limited only), the server made an authenticated POST to an attacker-chosen internal IP. The bearer was a self-owned secret; the real harm is the SSRF reach into the internal network.
**Fix:** route through `fetchPinned` (IP-pinned, no redirect-follow) — parity with the primary invoke path.

### H-3 · v2 · `.env` points to bdwv (wrong DB) — **FOUNDER ACTION REQUIRED**
`.env.prod.tmp:25`. Local files target `bdwv` instead of prod `caldz`. Not verifiable read-only (reading the mainnet Vercel project's config is out of audit scope). **Action:** confirm `NEXT_PUBLIC_SUPABASE_URL` in the Vercel `wasiai-prod` project = caldz.

### Refuted by verification (false positive)
**V-02 · v2 · "any user reads all creator financials"** — REFUTED. The route queries as the `authenticated` role; migration `067` REVOKEs the view from `authenticated` (grants only `service_role`), so a non-admin gets `[]`. Downgraded to LOW (defense-in-depth: add an explicit admin check, which was done in PR #23).

---

## Medium findings (remediated unless noted)

- **a2a F-02** — MCP tools (`pay-x402`, `get-payment-quote`) bypassed the SSRF dispatcher → routed through `ssrfFetch`. FIXED (#139).
- **a2a F-04** — cold-path debit self-derived `owner_ref` (tautological guard) → threads the authenticated caller's `owner_ref`. FIXED (#139).
- **v2 V-03** — float fee math in admin settlement (off-chain ledger drift; on-chain exact) → atomic `feeSplit`. FIXED (#23).
- **v2 V-06** — webhook delivery had no SSRF guard → `fetchPinned` + validate-at-delivery. FIXED (#23).
- **v2 V-07** — non-constant-time cron secret compares → `safeBearerEqual`. FIXED (#23).
- **v2 V-08/V-09** — `/api/admin/status` + `/api/admin/upload` weak auth → EIP-712 gate + bucket allow-list. FIXED (#23).
- **v2 V-10/V-11** — async endpoint validator + viem ^2.49.4 (clears `ws` HIGH). FIXED (#23).
- **contracts M-1** — `WasiAIMarketplace.claimEarnings` not subject to the daily cap → cap added (mirrors `settleKeyBatch`), CEI preserved, solvency invariant holds over 128k fuzz calls. CODE+TEST done (#23); **redeploy is a founder action**.
- **sdk/agentshop** — demo `/api/settle` unauthenticated (amount-capped, testnet).

---

## Positive observations (verified controls)

- **Contracts:** CEI + ReentrancyGuard, EIP-712 domain binding, UUPS with timelock, solvency accounting (`totalKeyBalances`/`totalEarnings`), trustless exits (emergency withdraw after 30d), fuzzed invariants. Slither clean.
- **Facilitator:** recipient + amount enforced **twice** (`verify.ts` + `base-adapter.ts` pre-write), signature malleability (high-s) closed, fail-modes documented with a regression test pinning the 2026-06-29 incident, signer key never logged (pino redact).
- **a2a:** atomic `FOR UPDATE` debit RPCs, `SECURITY DEFINER` with `OWNERSHIP_MISMATCH` guard + `REVOKE` from anon/authenticated, x402 binding in integer math (no float), deposit verify-on-chain with anti-front-run, prompt-injection-resistant planner.
- **Supply chain:** a2a `npm audit` 0 vulns; `.npmrc ignore-scripts` everywhere; SDK OIDC publish + Sigstore; **zero real secrets committed** across all 14 projects.

---

## Remediation status

| Repo | PR | State |
|------|-----|-------|
| a2a | #139 | ✅ merged + deployed + money-path verified (10 real testnet tx) |
| facilitator | #45 | ✅ merged + deployed |
| sdk | #12 | ✅ merged |
| v2 | #23 | 🟡 PR open — **founder merges (app.wasiai.io MAINNET)** |

**Both ARs on the remediation: APROBADO** (a2a + v2). Gates: a2a 2122 tests · facilitator 738 · v2 627 + 226 forge · sdk 11.

### Founder-gated items (not auto-fixable without touching mainnet)
1. Merge v2 #23 + deploy to app.wasiai.io.
2. Redeploy the M-1 contract fix (on-chain).
3. Confirm the Vercel `wasiai-prod` DB ref (H-3).
4. Promote `creator_profiles` migration (.SKIP → real, idempotent) in caldz (V-05).
5. Admin single-EOA → Safe 2-of-3 multisig (V-14).
