# Auto-Blindaje — WKH-74 Synthetic Monitoring

### [2026-07-06 09:05] Wave 2 — setup-cronjob job-count assertions not fully updated
- **Error**: after adding the 2 new cron jobs to `setup-cronjob.mjs` (6 → 8),
  the companion `tests/setup-cronjob.test.mjs` still failed on `T-SC-07`
  (foreign-jobs test asserted `7` total = 6 ours + 1 foreign). I updated the
  obvious count assertions in T-SC-01/02/03 and `EXPECTED_TITLES` but missed the
  hardcoded `7` inside T-SC-07.
- **Causa raíz**: the job count is duplicated as a magic number across several
  independent test cases; changing `TARGET_JOBS.length` requires a sweep of ALL
  of them, not just the "create all N jobs" test.
- **Fix**: updated T-SC-07's expected total to `9` (8 ours + 1 foreign) and its
  comment. Full `node --test 'tests/*.test.mjs'` now green (340 pass).
- **Aplicar en**: any future HU that adds/removes a cron job MUST grep
  `tests/setup-cronjob.test.mjs` for every numeric count (`.length` assertions
  in T-SC-01, T-SC-02, T-SC-03, T-SC-07) AND update `EXPECTED_TITLES`, not just
  the first test that trips.

### [2026-07-06 09:08] Wave 2 — KV singleton sharing across cache-busted cron imports
- **Note (not an error — a guard verified during impl)**: the capa-D cron test
  loads the handler with a cache-busting query
  (`synthetic-tx-check.mjs?t=<rnd>`). Its transitive `import` of
  `src/kv-client.mjs` uses a bare (query-less) specifier, so it resolves to the
  SAME singleton the test drives via `setKvClientForTesting`. Confirmed the
  override is visible to the freshly-imported handler (T-STC-03/04/05 pass).
- **Aplicar en**: future cron tests that need to inject KV must import
  `setKvClientForTesting` from the query-less `../src/kv-client.mjs` path (never
  a cache-busted copy) or the override will land on a different module instance.

### [2026-07-06 12:20] FIX-PACK — capa D on-chain proof is steps[].txHash, NOT the top-level hash (NIT-1)
- **Error**: docs + config implied capa D's settle proof came from the top-level
  `kiteTxHash`. It does not. Capa D pays via `x-a2a-key` (prepago) and the
  a2a-key middleware NEVER sets the top-level `kiteTxHash` (only the on-chain
  settle path does). So for the agent-key path that field is ALWAYS absent and
  the real proof is the fallback `pipeline.steps[].txHash`.
- **Causa raíz**: the JSDoc/`.env.example` were written as if `/orchestrate`
  always returns a top-level hash. The `extractTxHash` LOGIC was already correct
  (checks both), but the default `MONITOR_TX_GOAL` (`synthetic post-deploy
  money-path check`) would orchestrate without necessarily settling → capa D
  would alert a FALSE POSITIVE on every deploy.
- **Fix**: (1) reworded `extractTxHash` JSDoc to state the agent-key path's
  EXPECTED source is `steps[].txHash`; (2) `.env.example` + runbook now require
  `MONITOR_TX_GOAL` to resolve to a capability that settles ≥1 step (suggested
  the "AVAX price" → wasi-chainlink-price pattern, default changed to `AVAX
  price`); (3) added happy-path tests with the REAL prepago shape (steps-only, NO
  top-level hash) at the core (`T-ST-05b`) and cron (`T-STC-04b`) levels.
- **Aplicar en**: any monitor/probe that asserts an on-chain settle from a
  prepago (agent-key) response must read `pipeline.steps[].txHash`, never assume
  a top-level `kiteTxHash`, and its GOAL must provably settle.

### [2026-07-06 12:20] FIX-PACK — Railway deploy-id SUCCESS filter was dead code (MNR-3)
- **Error**: `_makeGetDeployId` queried `deployments(first: 1)` then `.find(status
  === 'SUCCESS')` with a fallback to `edges[0].node`. With only 1 edge the filter
  was dead code: a latest BUILDING/FAILED deploy fell through to the fallback →
  the real-tx could gate on a broken/in-progress deploy.
- **Causa raíz**: fetching a single edge defeats the SUCCESS filter it was paired
  with.
- **Fix**: query `deployments(first: 5)` and pick the FIRST node with
  `status === 'SUCCESS'`; if none of the 5 is SUCCESS → `throw` →
  `checkSyntheticTx` skips (fail-open, no spend). Added `T-STC-08` (BUILDING on
  top + SUCCESS below → gates on the SUCCESS) and `T-STC-09` (no SUCCESS → skip,
  KV untouched, no spend).
- **Aplicar en**: any paginated "latest X where status=Y" query must fetch enough
  rows for the status filter to be meaningful, and fail closed (skip) when no row
  matches rather than falling back to an unfiltered row.

### [2026-07-06 12:20] FIX-PACK — DEFERRED to backlog (MNR-1, MNR-2) — NOT fixed
- **MNR-1** (double-spend if `kvSet` fails after a passing real-tx): left as-is by
  design. It is BOUNDED (at most 1 extra tx/hour until the KV write lands),
  budget-capped by the dedicated `MONITOR_A2A_KEY`, forced by AC-4's retry
  contract, and a sentinel would collide with that retry. Documented, not fixed.
- **MNR-2** (no consecutive-failure threshold → potential alert fatigue): needs
  persistent failure-count state in KV; deferred to backlog alongside WKH-77
  MNR-3. Not fixed in this pack.
