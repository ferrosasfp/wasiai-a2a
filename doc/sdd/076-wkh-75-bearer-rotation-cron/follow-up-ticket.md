# Follow-Up Ticket Template — WKH-75 Refinements

**Parent HU**: WKH-75 (DONE)  
**Date Created**: 2026-05-02  
**Estimation**: S (1-2 person-days total)

---

## Jira Issue Summary

**Title**: `[WKH-75 follow-up] Bearer rotation refinements (HTTP method gate + JSDoc + tests)`

**Description**:

Consolidation of 9 minor findings from AR (4 items) and CR (5 items) reviews of WKH-75 bearer rotation cron. All items are backlog-eligible, none block production deployment. Estimated effort: 1-2 person-days.

### MNRs to Address

#### AR Findings (4 items)

1. **MNR-AR-1 — HTTP method gate on cron endpoints**
   - File: `api/cron/rotate-bearer.mjs:40-119`, `api/cron/invalidate-prev-bearer.mjs:63-230`
   - Issue: Endpoints accept any HTTP method (GET, PUT, DELETE, etc.) due to missing `req.method !== 'POST'` validation
   - Suggested fix: Add guard before auth check (mirror `api/mcp.mjs:184-186`): `if (req.method !== 'POST') { _json(res, 405, { error: 'method not allowed' }); return; }`
   - Impact: Defense-in-depth gap; auth still gates, but misconfigured clients (e.g., cron-job.org with GET) would silently rotate on every probe
   - Effort: ~20 LOC

2. **MNR-AR-2 — Concurrent rotation race condition**
   - File: `src/bearer-rotation.mjs:73-149` (S0..S6 sequence non-atomic)
   - Issue: Manual rotation + cron rotation firing within same cold-start window can create duplicate `MCP_BEARER_TOKEN_PREV` records
   - Suggested fix: Either (a) document in runbook "do not run manual + cron within minutes", or (b) implement KV-based mutex: `kv.set('rotation-lock', '1', { ex: 120, nx: true })`
   - Impact: Operationally confusing (duplicate PREV envs in Vercel dashboard); not security-relevant
   - Effort: Runbook doc ~10 LOC, or KV mutex module ~30 LOC

3. **MNR-AR-3 — Cron endpoint CSRF/origin check missing**
   - File: `api/cron/rotate-bearer.mjs:40-55`, `api/cron/invalidate-prev-bearer.mjs:63-78`
   - Issue: No User-Agent, origin, or CSRF allowlist. Bearer is sole gate; if leaked, any host can trigger rotation/invalidation
   - Suggested fix: Post-hackathon hardening; gate on `req.headers['user-agent']?.startsWith('cron-job.org')` or verifying signature
   - Impact: BAJO — bearer IS the gate; defense-in-depth observation only
   - Effort: ~30 LOC (post-hackathon, lower priority)

4. **MNR-AR-4 — Missing test for headless mode precedence**
   - File: `scripts/rotate-bearer.mjs:10-43` + `tests/bearer-rotation.test.mjs`
   - Issue: No test asserting "TTY + VERCEL_TOKEN set ⇒ headless mode wins". Coverage gap for future refactors.
   - Suggested fix: Add T-RB-AUTODETECT test: set `process.stdout.isTTY = true`, `VERCEL_TOKEN` + `VERCEL_PROJECT_ID` env vars, run script, assert headless flow executes
   - Impact: Future-proofing; today no bug
   - Effort: ~15 LOC test

#### CR Findings (5 items)

5. **MNR-CR-1 — Pipeline docs not committed (ACCEPTED GAP)**
   - File: `doc/sdd/076-wkh-75-bearer-rotation-cron/` (missing work-item.md, sdd.md, story-file.md)
   - Issue: Pipeline artefacts not on branch; only final reports (qa-report, ar-report, cr-report, done-report) present
   - Disposition: Accepted gap. Runtime code is complete + tested. Orchestrator to cherry-pick docs from origin session or inline summary.
   - Effort: No fix needed (accepted gap)

6. **MNR-CR-2 — KV key duplication**
   - File: `src/bearer-rotation.mjs:36`, `api/cron/invalidate-prev-bearer.mjs:47`
   - Issue: `const KV_KEY = 'last-bearer-rotation'` defined in two places
   - Suggested fix: Extract to shared constant module: `src/kv-constants.mjs` → export { KV_KEY }
   - Impact: Code duplication; maintainability
   - Effort: ~10 LOC refactor

7. **MNR-CR-3 — JSDoc on rotateBearer function**
   - File: `src/bearer-rotation.mjs:1-10` (function signature)
   - Issue: Missing JSDoc documenting params, return type, error conditions
   - Suggested fix: Add JSDoc block (example):
     ```javascript
     /**
      * Rotate the current MCP bearer token and publish to Vercel env vars.
      * @param {Object} config - { vercelToken, projectId, teamId, currentBearer }
      * @param {Object} vercelClient - Vercel REST API wrapper
      * @param {Object} kvClient - Upstash Redis KV client
      * @returns {Promise<{ok: boolean, rotatedAt?: string, expiresAt?: string}>}
      * @throws {RotationError} if any stage fails
      */
     ```
   - Impact: IDE hints, maintainability
   - Effort: ~15 LOC doc

8. **MNR-CR-4 — No test for NaN guard (CD-14)**
   - File: `api/cron/invalidate-prev-bearer.mjs:157-163` + `tests/`
   - Issue: `_readOwnString` function's NaN guard (`Number.isFinite(Date.parse(...))`) has no dedicated unit test
   - Suggested fix: Add unit test in `tests/cron-invalidate-prev-bearer.test.mjs`:
     ```javascript
     test('_readOwnString rejects NaN from bad ISO string', (t) => {
       const result = _readOwnString({ expiresAt: 'not-iso' });
       assert.equal(result, null);
     });
     ```
   - Impact: Test coverage gap for defensive pattern
   - Effort: ~20 LOC test

9. **MNR-CR-5 — KV_TTL comment clarity**
   - File: `src/bearer-rotation.mjs:35` (constant definition)
   - Issue: Comment says `KV_TTL = 25h` vs overlap window `24h`; intentional but could confuse future readers
   - Suggested fix: Add clarifying comment:
     ```javascript
     // TTL (25h) > overlap window (24h) ensures snapshot survives for its own invalidation cron
     ```
   - Impact: Documentation clarity
   - Effort: ~5 LOC comment

---

## Acceptance Criteria

- [ ] MNR-AR-1: HTTP method gate implemented + tested on both cron endpoints
- [ ] MNR-AR-2: Runbook doc OR KV mutex implemented
- [ ] MNR-AR-3: Issue logged for post-hackathon hardening (lower priority)
- [ ] MNR-AR-4: T-RB-AUTODETECT test added, all 232+ tests still pass
- [ ] MNR-CR-2: `KV_KEY` extracted to `src/kv-constants.mjs`, both files updated
- [ ] MNR-CR-3: JSDoc added to `rotateBearer()` function
- [ ] MNR-CR-4: Unit test for `_readOwnString` NaN path added
- [ ] MNR-CR-5: KV_TTL comment clarified
- [ ] All tests pass: `npm test` → 240+/240+ (added 8 tests from 1-4, 6-8)

---

## Definition of Done

- New branch: `feat/wkh-75-follow-up-refinements`
- All 9 items closed OR accepted as design (MNR-CR-1 is no-fix)
- Tests: 240+ pass (192 baseline + 42 original + 8 new refinement tests)
- CR: Code review checklist repeated + zero new MNRs introduced
- Merge to main
- Link this follow-up ticket to WKH-75 DONE report

---

## Estimation

| Item | Effort | Notes |
|------|--------|-------|
| MNR-AR-1 (method gate) | 20 min | Simple guard + 2 unit tests |
| MNR-AR-2 (concurrent race) | 30 min | Runbook OR KV mutex module |
| MNR-AR-3 (CSRF check) | Backlog | Lower priority, post-hackathon |
| MNR-AR-4 (test coverage) | 15 min | Simple test case |
| MNR-CR-2 (KV constant) | 10 min | Extract + refactor |
| MNR-CR-3 (JSDoc) | 15 min | Documentation |
| MNR-CR-4 (NaN test) | 20 min | Unit test + integration |
| MNR-CR-5 (comment) | 5 min | Documentation |
| MNR-CR-1 (docs gap) | 0 min | No fix (accepted gap) |
| **Total** | **~2 person-hours** | **S estimation** |

---

**For Jira**: Copy the above into a new ticket, link parent WKH-75, set status to BACKLOG, estimation to S.
