# Investigation: /compose 404 placeholder-fee drain (preHandler abort)

Branch: `fix/compose-404-budget-drain` (from `main`). Money-path. Not deployed.

## Reported bug
`POST /compose` with a non-existent agent returns `404 AGENT_NOT_FOUND` but was
reported to STILL debit `PLACEHOLDER_FEE_USD = 1.0` from the prepaid agent-key
budget (never credited back) → drain vector. Hypothesised root cause: the price
preHandler at `compose.ts` did `reply.status(404).send(...); return;` (bare
`return`), which — under the hypothesis — failed to abort the Fastify 5
preHandler lifecycle, letting the next preHandler (`requirePaymentOrA2AKey`) run
and debit the placeholder.

## What I changed (scope-disciplined)
1. `src/routes/compose.ts` 404 `AGENT_NOT_FOUND` path: `reply.status(404).send()`
   → `return reply.status(404).send()`.
2. `src/routes/compose.ts` 503 `REGISTRY_UNAVAILABLE` path: same `return reply`.
3. `src/routes/gasless.ts` `gaslessCostEstimatorPreHandler` (the ONE sibling with
   the identical bare-return-before-debit shape): 3 abort paths (400 missing
   fields, 400 invalid bigint, 403 `PER_CALL_LIMIT`) → `return reply...`.

No change to debit logic, the placeholder fee, refund logic, or any unrelated
code. The comment at `compose.ts:207` ("NO debit / middleware short-circuited")
now matches the code idiom.

## Sibling-route audit (what I checked)
Grepped every `reply.status().send()` in `src/routes/`. The dangerous shape is
"a preHandler that sends a reply with a bare `return`, scheduled BEFORE
`requirePaymentOrA2AKey` in the same route's `preHandler` array".
- `compose.ts` — `resolveComposePriceHandler` runs before the debit middleware.
  FIXED (404 + 503).
- `gasless.ts` — `gaslessCostEstimatorPreHandler` runs before the debit
  middleware. FIXED (3 paths).
- `orchestrate.ts` — its only custom pre-debit preHandler is
  `markSkipMiddlewareDebitHandler`, which sets a flag and NEVER sends a reply.
  NOT affected.
- All other `reply.status().send()` occurrences in `src/routes/auth/*`,
  `tasks.ts`, `metrics.ts`, and the gasless/compose ROUTE HANDLERS are inside
  route handlers (post-middleware) or in routes with no debit middleware — not
  the dangerous pattern.

## Empirical finding (important — read before trusting the "fail-on-old" claim)
I built a regression test that exercises the REAL `requirePaymentOrA2AKey`
middleware (the existing `compose.test.ts` mocks it out, which is why it never
caught a drain) and observes the budget side-effect:
`src/routes/compose.no-debit-on-abort.test.ts`. It mocks only the data layer
(`identityService.lookupByHash` → funded master key, `budgetService.debit` →
in-memory balance) + chain registry helpers, and asserts that a 404/503 leaves
the prepaid budget UNCHANGED, with a CONTROL test proving the harness DOES
observe a real debit when the agent resolves.

Result: the test PASSES on BOTH the old (bare `return`) and the new
(`return reply`) code (verified by stashing the source fixes and re-running:
3/3 pass on old, 3/3 pass on new). Two isolated Fastify-5 repros confirmed the
same: a preHandler that calls `reply.send()` then bare-`return`s DOES abort the
chain — Fastify checks `reply.sent` between preHandlers, so the debit middleware
never runs.

Conclusion: **the bare-`return` → `return reply` change does NOT alter debit
behaviour in this codebase**; I could NOT reproduce the placeholder drain via
this mechanism at the integration level. The change is still applied as a
correctness/hardening fix (canonical Fastify 5 idiom, aligns code with the
existing comment, zero behavioural/regression risk) and the regression test is
kept as a guard. If the live drain is genuine, its real cause is elsewhere
(candidates NOT investigated here: a different/older deployed revision; the
discovery layer returning `priceUsdc === 0` instead of `null` for the bogus
agent → the `price === 0` fallback path INTENTIONALLY continues to the debit
middleware with `PLACEHOLDER_FEE_USD` and is later refunded by the route's
AUDIT-A1 refund block; or a caller path other than master). These are flagged
for follow-up, not fixed here (out of scope).

## Gates
- `tsc --noEmit`: clean (exit 0).
- `biome check src/`: clean (253 files, no errors).
- `vitest run`: 527 suites pass, 2168 tests pass, 0 fail (incl. the new suite).

Not pushed. Not merged. Not deployed.

---

## RESOLUTION (2026-06-30, follow-up commit) — REAL root cause fixed

The follow-up candidate flagged above (line "the discovery layer returning
`priceUsdc === 0` instead of `null` for the bogus agent") IS the real root
cause. Confirmed reproduced live on the current deploy (budget 5.0 → 4.0 on a
404). The prior bare-`return` → `return reply` change was harmless hardening, as
this doc already concluded.

### Confirmed root cause
In `resolveComposePriceHandler` (`src/routes/compose.ts`):
- `resolveAgentPriceUsdc(slug)` returns **0 (NOT null)** for a NON-EXISTENT
  agent: the lenient `discoveryService.getAgent` lookup yields a ghost row whose
  `priceUsdc` parses to 0 (`parsePriceSafe(null) → 0`), so the agent looks like
  it "exists with price 0".
- The `price === null → 404 (no debit)` guard is therefore BYPASSED.
- The `price === 0` registry-miss placeholder branch (CD-4) set
  `composeEstimatedCostUsd = PLACEHOLDER_FEE_USD` and CONTINUED → the debit
  middleware debited $1 → the HANDLER (`composeService.resolveAgent`, which uses
  the AUTHORITATIVE `getAgent → getAgent → discover().find()` chain) then found
  the agent bogus and 404'd — and the route's AUDIT-A1 refund block did NOT fire
  for the step-0 case in the observed deploy (self-overcharge for a 404).

The `price === 0` fallback is INTENDED only for an agent that EXISTS but has a
misconfigured price 0 — NOT for a non-existent agent.

### Fix chosen (and why)
**Route-level existence gate** (`src/routes/compose.ts`, in
`resolveComposePriceHandler`): the handler already computes
`resolved = await resolveAgentDestination(firstStep.agent, firstStep.registry)`
just before the `price === 0` branch. `resolveAgentDestination` mirrors the SAME
`getAgent(slug,registry) → getAgent(slug)` resolution chain the pipeline uses, so
`resolved === null` ⟺ the pipeline would 404. Added a guard:

```
if (price === 0 && resolved === null) {
  return reply.status(404).send({ error: `Agent not found: ...`,
                                  error_code: 'AGENT_NOT_FOUND' }); // NO debit
}
```

The existing placeholder fallback is preserved ONLY for
`price === 0 && resolved !== null` (a genuine EXISTING agent with a misconfigured
price 0 — CD-4 registry-miss honest fallback). `return reply...` aborts the
preHandler chain before `requirePaymentOrA2AKey` → no debit.

**Why NOT the "root fix" in `resolveAgentPriceUsdc`** (return null for missing):
that function returns `agent.priceUsdc` for a truthy `getAgent` result, and 0 is
INDISTINGUISHABLE there from a legitimately-free existing agent. Forcing
`null` for 0-price would break the legit CD-4 fallback (T-PRICE-6 + the dest-cap
callers depend on the 0-for-existing semantics). The route already has the
authoritative `resolved` signal, so gating there is the clean, scoped, correct
fix that touches ONE place and breaks no existing semantics.

### Orchestrate path — checked, NOT vulnerable
`src/services/orchestrate.ts:644` uses the same `plannedCostUsd === 0 →
PLACEHOLDER_FEE_USD` shape, BUT it is NOT exposed to this bug: orchestrate plans
`steps` exclusively from `discovered.agents` (the authoritative `discover()`
result — `greedyPlan`, orchestrate.ts:251-289), and the caller supplies a
free-text `goal`, never an agent slug. A ghost agent can never enter the plan;
`plannedCostUsd === 0` only fires for agents that demonstrably exist (selected
from the discover list). The `allStepsAreDemos` / no-relevant-agent guards
(orchestrate.ts:584) already cut BEFORE debit for the "nothing real to run"
case. No fix needed; no change made to orchestrate.

### Regression test
`src/routes/compose.no-debit-on-abort.test.ts` (wires the REAL
`requirePaymentOrA2AKey` middleware):
- `T-NO-DEBIT-GHOST-PRICE0`: mocks the LIVE scenario
  (`resolveAgentPriceUsdc → 0` AND `resolveAgentDestination → null`) and asserts
  the debit NEVER runs + budget UNCHANGED + 404 AGENT_NOT_FOUND. **FAILS on old
  code** (debit called once, budget drained — verified by stashing the fix:
  "expected vi.fn() to not be called at all, but actually been called 1 times")
  and **PASSES on the fix**.
- `T-DEBIT-EXISTING-PRICE0`: guardrail — an EXISTING agent (`resolveAgentDestination
  !== null`) with a misconfigured price 0 STILL takes the placeholder fallback
  (debit runs, pipeline executes, 200). Proves the legit CD-4 fallback is intact.

### Gates (this commit)
- `tsc --noEmit`: clean (exit 0).
- `biome check src/`: clean (253 files, no errors).
- `vitest run`: 2170 tests pass, 0 fail (incl. the 2 new regression tests).

Not pushed. Not merged. Not deployed.

---

## Auto-Blindaje

### [2026-06-30 09:25] Money-path — `price === 0` for a non-existent agent bypassed the no-debit 404 guard
- **Error**: `/compose` debited `PLACEHOLDER_FEE_USD` ($1) from the prepaid key
  for a NON-EXISTENT agent and returned 404 without refund. The `price === null
  → 404 (no debit)` guard was bypassed because `resolveAgentPriceUsdc` returns 0
  (not null) when the lenient `getAgent` lookup yields a ghost row.
- **Causa raíz**: TWO existence checks of differing authority in the same
  request path — the preHandler's lenient `resolveAgentPriceUsdc`/`getAgent`
  ("found with price 0") vs the pipeline's authoritative
  `getAgent → discover().find()` ("not found → 404"). The "price 0" placeholder
  fallback (meant for an existing config-miss agent) was reused for the
  not-found case, draining budget before the authoritative 404.
- **Fix**: gate the `price === 0` placeholder branch on `resolved !== null`
  (`resolveAgentDestination`, which mirrors the pipeline's resolution chain). If
  `price === 0 && resolved === null` → 404 AGENT_NOT_FOUND before the debit
  middleware. The legit fallback stays for `price === 0 && resolved !== null`.
- **Aplicar en**: any pre-debit preHandler that derives a chargeable amount from
  a LENIENT resolver while the downstream handler rejects via a STRICTER
  resolver. The two existence checks MUST agree before money moves. Audited
  `orchestrate.ts` (same PLACEHOLDER shape) — not vulnerable: it plans only from
  the authoritative `discover()` result, so no ghost can enter the priced path.
