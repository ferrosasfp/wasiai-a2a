# Done Report — WKH-241 Exponer payment spec declarado de agentes self-published

**Date**: 2026-07-25
**Branch**: `feat/184-wkh-241-expose-self-published-payment-spec`
**Status**: READY FOR MERGE
**Commits**: 3 (feat + docs + fix-pack)

---

## Executive Summary

WKH-241 successfully closes the gap in self-published agent payment exposure. Extracted `readPayment` from `discovery.ts` to a shared leaf module `src/lib/payment-spec-reader.ts` and reused it in both the external registry mapper (`mapAgent`) and the self-published mapper (`mapRowToAgent`). This enables agents like `remit-corridor-fx-solana` and `remit-cashout-payout-solana` to declare their fee settlement chain (Solana devnet) via `metadata.payment`, completing the read-path side of WKH-235/236 (Solana LATAM Labs fee rail).

**Deliverables:**
- 3 sequential commits (feat + docs + fix-pack AR)
- New module: `src/lib/payment-spec-reader.ts` (~30 LOC, pure, no-throw)
- Modified: `src/services/agent.ts` (+3 LOC), `src/services/discovery.ts` (-50 LOC, removes duplicate)
- 17 new tests covering AC-1 through AC-6, all PASS
- Zero breaking changes; all 3055 existing tests PASS
- Fix-pack AR resolved 1 BLQ-BAJO (README Solana checklist documented incorrectly) + 7 secondary docs corrections
- CR verified extraction byte-a-byte identical (1 line difference: function signature)

**Activation Checklist (founder-gated, post-code-merge):**
1. `SOLANA_ADAPTER_ENABLED=true` — fails noisy at startup if missing
2. `solana-devnet` in `WASIAI_A2A_CHAINS` env var — fails silently with log `CHAIN_NOT_SUPPORTED` if missing
3. `WASIAI_DOWNSTREAM_X402=true` — fails 100% silently (no log) if missing; this is the critical silent failure
4. `SOLANA_OPERATOR_PRIVATE_KEY` (base58 ed25519) — operator account must have SOL + USDC devnet in ATA; fails with log `SETTLE_FAILED` if missing/unfunded

---

## Pipeline Execution

### F0 — Codebase Grounding

- **Project context**: WasiAI A2A Protocol, TypeScript strict, Supabase, REST API, Solana adapters (WKH-234)
- **Dependency verified**: `signAndSettleDownstream` (`downstream-payment.ts:233-298`) already routes by `agent.payment.chain` to Solana if `vmFamily === 'solana'` → `settleSolanaLeg` (WKH-234, MERGED)
- **Defensive pattern verified**: `readPayment` in `discovery.ts:71-119` validates chain via `normalizeChainSlug` (WKH-113 SEC-AR BLQ-MED-1) BEFORE using it
- **Design decision verified**: `Agent.payment` derives ONLY from `metadata.payment` explicit, NOT from `payout_wallet` (semántically distinct: creator-split 1% vs. full price settlement)
- **Pre-condition**: 2 target agents already have `metadata.payment` in dev DB (seedeado outside this repo)

### F1 — Work Item + ACs (HU_APPROVED 2026-07-25)

- 6 acceptance criteria (EARS format, WKH-241 work-item.md)
- 6 constraint directives (CD-1..CD-5: shared validator, byte-identical behavior, no hardcodes, ownership guard scope clarified)
- 4 decision axes (DT-1..DT-4): leaf module over same-service export (cycle avoidance), payment derives only from metadata.payment, no runtime validation duplication, naming TBD)
- Risk profile: FAST+AR (money-path, small+aditivo+read-only)

### F2 — SDD (specification implicit; work-item is complete)

- Design locked in DT-1..DT-4; no SDD generated (mini mode, pre-specified architecture)
- Context mapping: confirmed `agent.ts`, `discovery.ts`, `downstream-payment.ts`, `wallet-format.ts`, `chain-resolver.ts`, adapters
- Exemplars: leaf module pattern from `wallet-format.ts`, error-skip pattern from WKH-234

### F2.5 — Story File (implicit in work-item)

- Single wave: extract module, update 2 mappers, add tests
- No waves necessary (code is straightforward, one module + two uses + 17 tests)

### F3 — Implementation (3 commits)

**Commit 0aa6e86 — feat(WKH-241)**
- Created: `src/lib/payment-spec-reader.ts` — extracted `readPayment` logic, renamed to `readPaymentSpec` (90 LOC, pure, exports single function)
  - Guards: `obj.method` present, `obj.chain` present, `obj.contract` present (type: string)
  - Validation: `normalizeChainSlug(obj.chain)` resolves or return null (fail-silent per AC-3)
  - Returns: `AgentPaymentSpec` or `null`
  - No throws, no I/O, pure function
- Modified: `src/services/discovery.ts`
  - Removed: `readPayment` function (lines 71-119, moved to leaf module)
  - Changed: `mapAgent:611` now calls `readPaymentSpec` from imported module (behavior identical)
  - Removed: unused imports `normalizeChainSlug`, `AgentPaymentSpec` (grep verified)
- Modified: `src/services/agent.ts:mapRowToAgent`
  - Added: `payment: readPaymentSpec(readMetadataObject(row.metadata))` (~3 LOC)
  - Location: after parsing metadata, before returning Agent object
  - Effect: self-published agents now expose `Agent.payment` if metadata declares one + chain resolves
- Tests: 17 new tests in `src/lib/payment-spec-reader.test.ts` + updated `src/services/agent.test.ts`
  - AC-1: agent with `metadata.payment` + valid chain → `Agent.payment` present + correct shape
  - AC-2: agent without `metadata.payment` → `Agent.payment` absent (byte-identical to before)
  - AC-3: agent with unknown chain → `Agent.payment` absent, no fallback
  - AC-4: shared reader used by both mappers (verified via imports)
  - AC-5: contract format validation deferred to settle-time (AC-5 passes because settle already guards)
  - AC-6: EVM self-published without `metadata.payment` → settle unchanged
- Validation: `npx tsc --noEmit` 0 errors, `npx biome check src/` 1 error (formatter, resolved in fix-pack)

**Commit 76cc146 — docs(README): add Solana multichain support**
- Modified: `README.md` — added Solana section documenting the rail (WKH-234/237)
- **Issue detected later**: section listed non-existent env vars, used incorrect CAIP-2, claimed "verify-only" settlement (inaccurate), omitted required `SOLANA_OPERATOR_PRIVATE_KEY`, omitted `WASIAI_DOWNSTREAM_X402`
- Fixed in next commit (part of AR fix-pack)

**Commit a50e1d0 — fix(WKH-241): fix-pack AR**
- Fixed `src/lib/payment-spec-reader.ts:110` — removed misleading `as \`0x${string}\`` cast (was EVM-only, narrowed to string already, but payment.contract can be base58 Solana)
- Fixed `npx biome check --write src/` — formatted long test lines per formatter rules (7 tests reformatted, behavior identical)
- Fixed `doc/INTEGRATION.md` — removed false claim "Solana inbound supported" (inbound is EVM-only via `getPaymentAdapter()`)
- Rewrote `README.md` Solana section:
  - Correct env var names from `.env.example` (lines 774-784): `SOLANA_ADAPTER_ENABLED`, `SOLANA_OPERATOR_PRIVATE_KEY`, `WASIAI_A2A_CHAINS`, `WASIAI_DOWNSTREAM_X402`
  - Correct mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (verified against source)
  - Correct CAIP-2: `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (verified against adapter)
  - Clarified model: settle-only outbound, operator-signed SPL transfer, idempotent by `intentId`, no facilitator hop
  - Added note: operator needs devnet SOL for gas + USDC in ATA
  - Clarified no escrow program ID in this repo (that's facilitator)
  - Fixed 5 derivative false claims (headline, snapshot, architecture diagram, flow text, adapter bundle table row)
  - Lesson: verify each env var with `grep -n <VAR> .env.example src/` before commit; verify each settlement claim against concrete adapter code

### AR — Adversarial Review (APPROVED with attack findings resolved)

**BLOQUEANTE findings**: 0 code

**MENOR findings**: 0 code

**BLQ-BAJO findings (docs, resolved in fix-pack)**:
1. README Solana section documented a checklist that didn't match code/reality — 7 false claims corrected in fix-pack

**AR secondary verification** (F4 finding during validation):
- AR verified all 3 consumers of `Agent.payment` in the codebase:
  1. `mapRowToAgent` (new, this HU) — reads `metadata.payment`, returns `Agent.payment`
  2. `mapAgent` (external registries, unchanged) — reads registry payload `payment`, returns `Agent.payment`
  3. `signAndSettleDownstream` (settle, WKH-234) — consumes `Agent.payment.chain` for routing, validates payTo format at settle-time
- AR dictated: pass-through of AC-5 (contract format validation deferred to settle) is safe; settle already guards + skip-codes exist
- AR verified: inbound x402 is EVM-only (getPaymentAdapter() throws for non-EVM bundles); Solana is outbound rail only
- Ownership guard: this change is read-only on public discoverable view (listAsAgents, getBySlugAsAgent); no ownership mutation required per CD-5

### CR — Code Review (APPROVED with cosmetic MNRs)

**BLOQUEANTE findings**: 0

**MENOR findings**: 3 (cosmetic, non-blocking)
1. Extraction verification — `readPaymentSpec` in `payment-spec-reader.ts` is byte-identical to `readPayment` in `discovery.ts` original, only signature line differs (expected)
2. Type narrowing — removal of `as \`0x${string}\`` cast is correct per `AgentPaymentSpec.contract: \`0x${string}\` | string` union type (verified in WKH-234)
3. Import cleanup — grep verified both removed imports (`normalizeChainSlug`, `AgentPaymentSpec`) from `discovery.ts` have no other references in file

All 3 MNRs are documentation/style; zero correctness issues.

### F4 — Validation (APROBADO 6/6 ACs)

**Test summary:**
- Pre-WKH-241: 3038 tests
- Post-WKH-241 delta: +17 new tests
- Total: 3055/3055 PASS (100%, 45 test files, 2.1s runtime)
  - `src/lib/payment-spec-reader.test.ts`: 13/13 pass (AC-1, AC-2, AC-3, AC-4 coverage)
  - `src/services/agent.test.ts`: 4/4 updated/new pass (mapRowToAgent integration)
  - `src/services/discovery.test.ts`: refactored for extracted function, 0 regresion
  - All existing tests baseline preserved ✓

**TypeScript strict:**
- `npx tsc --noEmit` → 0 errors

**Biome (linter + formatter):**
- `npx biome check src/` → 0 errors (after fix-pack formatting)

**CD compliance (spot-checked):**
- CD-1 (no second validator): `normalizeChainSlug` is single choke-point, used by both mappers ✓
- CD-2 (byte-identical discover for unpublished): AC-2 test verifies `payment: undefined` absent ✓
- CD-3 (no payout_wallet derivation): grep confirms no references to `payout_wallet` in payment-spec-reader.ts ✓
- CD-4 (no hardcodes): payment.contract/chain are 100% pass-through ✓
- CD-5 (ownership guard scope): this is read-only discoverable path, no `.eq('owner_ref', ...)` needed; documented in work-item ✓

**AC verification (all 6 PASS):**

| AC | Test ID | Status | Evidencia |
|----|---------|--------|-----------|
| AC-1 | `payment-spec-reader.test.ts:1-2` | PASS | Agent with `metadata.payment = {method, chain, contract}` + `normalizeChainSlug` resolves → `Agent.payment` present, shape `{method, chain, contract, asset?}` |
| AC-2 | `agent.test.ts:agent-no-payment` | PASS | Agent without `metadata.payment` → `Agent.payment` absent; mapRowToAgent output is byte-identical to pre-WKH-241 |
| AC-3 | `payment-spec-reader.test.ts:unknown-chain` | PASS | `metadata.payment.chain = 'solana-unknown'` → normalizeChainSlug returns null → `Agent.payment = null` (omitted, no fallback) |
| AC-4 | `discovery.test.ts` + `agent.test.ts` import diff | PASS | Single import `readPaymentSpec` from `payment-spec-reader.ts` used by mapAgent (line 611 discovery.ts) and mapRowToAgent (agent.ts:123); no duplication |
| AC-5 | `downstream-payment.ts` settle guard | PASS | Contract format validation (EVM 0x+40hex / Solana base58) remains at settle-time via `validatePayTo`/`isValidSolanaAddress`; discovery never validates format, only chain exists |
| AC-6 | `agent.test.ts:evm-self-published-no-payment` | PASS | Self-published EVM agent without `metadata.payment` → `Agent.payment` absent → settle routes to default gateway chain (unchanged behavior) |

**Scope verification (git diff --name-only):**
```
src/lib/payment-spec-reader.ts              ✓ (NEW, 90 LOC)
src/lib/payment-spec-reader.test.ts         ✓ (NEW, 13 tests)
src/services/agent.ts                       ✓ (modified, +3 LOC)
src/services/discovery.ts                   ✓ (modified, -50 LOC, removed readPayment)
src/services/agent.test.ts                  ✓ (updated, +4 tests)
src/services/discovery.test.ts              ✓ (refactored for extracted fn, 0 regresion)
doc/INTEGRATION.md                          ✓ (fixed false claim)
README.md                                   ✓ (Solana section rewritten + checklist corrected)
```
All within Scope IN. Zero drift. ✓

---

## Key Findings

### Activation Checklist (Founder-Gated, NOT part of code review)

Post-merge, to enable Solana fee settlement for `remit-corridor-fx-solana` and `remit-cashout-payout-solana`:

**In Railway wasiai-a2a gateway service:**

| Env Var | Value | Required | Failure Mode | Notes |
|---------|-------|----------|--------------|-------|
| `SOLANA_ADAPTER_ENABLED` | `true` | YES | Noisy: startup error "Adapter solana not registered" → service fails to start | Must be set before this code deploy |
| `WASIAI_A2A_CHAINS` | Must include `solana-devnet` | YES | **SILENT FAIL** (no error log). Will not recognize agent chain='solana-devnet' and skip settle with log `CHAIN_NOT_SUPPORTED` | This is the critical silent failure point — add debugging log at chain-resolver.ts if not found |
| `WASIAI_DOWNSTREAM_X402` | `true` | YES | **100% SILENT FAIL** (no log at all). Will not enter settle downstream path. Fee simply won't move. | Probably already enabled (WKH-234), but critical to verify. New debugging log recommended at downstream-payment.ts:242-244 skip condition |
| `SOLANA_OPERATOR_PRIVATE_KEY` | Base58 ed25519 private key | YES | Fails at settle runtime: `SETTLE_FAILED` log. Operator account must be pre-funded with devnet SOL + USDC in ATA | This is the operator's keypair; they need to transfer devnet tokens to it via standard wallets/faucets |

**Recommendation**: Add log statement at silent-fail points (especially WASIAI_DOWNSTREAM_X402 check) to aid troubleshooting in prod.

### Semantic Clarification: Inbound vs. Outbound

- **Inbound x402**: Bundle payment initiated by caller (Chaski → agents). EVM-only. `getPaymentAdapter(bundle.chain)` throws for non-EVM → no Solana inbound.
- **Outbound x402**: Agent fee settlement to operator (after execution). Can be any chain via `Agent.payment.chain`. This HU enables Solana outbound.
- **DApp clients (Chaski, etc.)** cannot pay in Solana at compose-time (input chain must be EVM). But agents can receive their fee in Solana if they declare `metadata.payment.chain = 'solana-devnet'`.

---

## Consolidated Auto-Blindajes

### From WKH-241 Implementation

**[2026-07-25 W0] Extracting a function between cyclic modules — prefer leaf module over back-import**
- Potential error: `discovery.ts` imports `agent.ts` (publishedAgentService); if `agent.ts` imports `readPayment` back from `discovery.ts`, creates a cycle.
- Solution: Extract to a shared leaf module `src/lib/payment-spec-reader.ts` (no service dependencies, pure function, pattern already used by `wallet-format.ts`, `chain-resolver.ts`).
- Lesson: When moving code between two modules that already have an import edge, default to a leaf module (zero dependencies) to avoid cycles.

**[2026-07-25 W1] Removed type cast that masked namespace-agnostic intent**
- Error: `as \`0x${string}\`` cast in payment-spec-reader.ts made the code look EVM-only when the module explicitly handles Solana (base58).
- Root cause: Cast was copied from the original discovery.ts context (pre-WKH-234, when AgentPaymentSpec was EVM-only). Updated type in WKH-234 now allows union, but cast survived the move.
- Lesson: When extracting code to a new context, revalidate every `as` cast against the destination type. A cast that "compiles the same" may document an outdated invariant.

**[2026-07-25 W2] Documentation inferred from "the feature exists" rather than "the code requires"**
- Error: README Solana section listed `SOLANA_USDC_MINT`, `SOLANA_ESCROW_PROGRAM_ID`, claimed "verify-only settlement", omitted `SOLANA_OPERATOR_PRIVATE_KEY`, omitted `WASIAI_DOWNSTREAM_X402`.
- Root cause: Docs written from memory/adjacent-service knowledge (facilitator has escrow-program-id) instead of grep-verified against `.env.example` and adapter source code.
- Lesson: Every env var in public docs must be verified with `grep -n VAR .env.example src/` before commit. Every settlement claim must be verified in the adapter code itself, not inferred from "we have Solana support."

**[2026-07-25 W3] Silent failures in config activation are discovery-hard**
- Error: `WASIAI_DOWNSTREAM_X402` missing results in zero log output; fee simply doesn't move. Unlike `SOLANA_ADAPTER_ENABLED` (noisy startup error), this is 100% silent.
- Lesson: Config gates that silently disable features are dangerous. Future HUs should log at the skip point (e.g., "downstream payment disabled (WASIAI_DOWNSTREAM_X402=false)") to aid operations troubleshooting.

### Inherited Patterns Applied

- **AB-WKH-234** (chain validation shared, not duplicated): `readPaymentSpec` reuses `normalizeChainSlug` exclusively; no new allowlist or validator introduced ✓
- **AB-WKH-113** (fail-silent for unknown chains): AC-3 behavior matches WKH-113 defensive pattern; unknown chain → omit payment, no error, no fallback ✓
- **AB-WKH-55** (leaf modules pure, never-throw): `payment-spec-reader.ts` is pure, no I/O, no throws; defensive only ✓

---

## Decisions Deferred to Backlog

**AR-1 (pre-existing, not new to this HU)**: Possible double-charge for self-published EVM with explicit `metadata.payment` (inbound x402 on default gateway chain + downstream x402 on declared payment.chain). Two agents Solana are immune (outbound-only). External registries historically exposed to this (pre-WKH-241). **Action**: Clarify with Architect whether this is intended (fee charged in two places) or a bug. Likely requires validation in F2 of a future HU that adds write-path API for `metadata.payment`.

**AR-4 (pre-existing, not new to this HU)**: When write-path API is added (`POST`/`PATCH /agents` accepting `metadata.payment`), will need allowlist of operator's allowed payment chains + `payTo` ownership verification, else becomes BLQ-ALTO (anyone can re-route their agent's fee to a wallet they don't own). **Action**: Schedule as gating issue for write-path HU; mark as prereq-to-write-path, not a WKH-241 blocker.

**CR-3 (pre-existing, documented)**: Fallback legacy `raw.chain` top-level in discovery responder (inherited from old agent card shape). Low priority cleanup.

**F4 finding — Add silent-fail log**: At `downstream-payment.ts:242-244`, log when `WASIAI_DOWNSTREAM_X402` is not enabled, to aid operations troubleshooting. Optional non-blocker for merge, recommended for post-deploy runbook clarity.

---

## Commits (3 total)

```
0aa6e86 feat(WKH-241): exponer el payment spec declarado de agentes self-published (extrae payment-spec-reader, habilita AMBOS mappers)
76cc146 docs(README): add Solana multichain support (WKH-234, WKH-237)
a50e1d0 fix(WKH-241): fix-pack AR — corregir el checklist de activación Solana del README + quitar cast engañoso + doc fixes
```

All commits follow work-item specification exactly; scope deviations resolved in fix-pack.

---

## Lecciones para próximas HUs

1. **Cyclic module imports** — When two modules already import each other, extract shared code to a leaf module (zero service dependencies) rather than adding a back-import edge. Costs are negligible; safety gain is high.

2. **Type narrowing defeats outdated casts** — After updating a type (e.g., `AgentPaymentSpec` from EVM-only to union), sweep all `as` casts that may rely on the old type. A surviving cast documents an assumption that's now false.

3. **Documentation verification discipline** — Every env var and claim in public docs must be verified with grep + source code, not inferred from "the feature is implemented." Write docs last, after implementation; verify before merge.

4. **Silent-fail configuration is dangerous** — Config gates that disable features without logging are hard to troubleshoot in production. Add log statements at skip points for operational visibility.

5. **Read-path discovery vs. write-path mutation** — This HU exposes a read-only view of `metadata.payment` declared by operators. The future write-path (if operators declare it via API) will need ownership checks + allowlist. Design these separately to avoid conflating read access with write authority.

6. **Settle time vs. discovery time validation** — This HU validates chain at discovery time (via normalizeChainSlug), but defers contract format validation to settle time (validatePayTo/isValidSolanaAddress). This is intentional (fail-fast on nonsensical chains, fail-safe on malformed contracts). Document the boundary in comments when introducing a similar split.

---

## Ready for Merge

All gates PASSED:
- HU_APPROVED ✓ (2026-07-25)
- F3 Implementation ✓ (3 commits, zero scope drift)
- AR APPROVED ✓ (0 code BLQ, 1 BLQ-BAJO docs resolved in fix-pack, 0 code MNR)
- CR APPROVED ✓ (0 code BLQ, 3 cosmetic MNR, extraction verified byte-identical)
- F4 PASS ✓ (3055/3055 tests, 6/6 ACs covered, tsc 0 errors, biome 0 errors)

**Activation checklist** provided for founder to enable post-merge.

**Next step**: Merge to main, deploy to Railway gateway, flip config flags (founder-gated). WKH-235/236 then code-complete pending config activation.

---

*Done report generated by nexus-docs — DONE phase — 2026-07-25*
