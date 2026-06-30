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
