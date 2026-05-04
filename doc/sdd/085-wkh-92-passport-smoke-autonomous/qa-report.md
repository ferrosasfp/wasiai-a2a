# QA Report — WKH-92 Autonomous Passport x402 Smoke Runner

**Date**: 2026-05-03
**Branch**: feat/085-wkh-92-passport-smoke-autonomous @ 2c59963

## Veredicto

APROBADO PARA DONE

---

## AC Verification

| AC | Status | Evidencia (archivo:línea) |
|----|--------|--------------------------|
| AC-1 | PASS | `stat scripts/smoke-passport-autonomous.mjs` → `0755/-rwxr-xr-x`; `node scripts/smoke-passport-autonomous.mjs` executes without compilation errors and reaches runtime |
| AC-2 | PASS | `SMOKE_KPASS_MOCK_FILE=/tmp/smoke-no-session.json node scripts/smoke-passport-autonomous.mjs` → exit 1, stdout `{"status":"human_gate_required","reason":"no_active_session","next_step":"Run: kpass agent:session create …"}`. Implemented at script:213-219 |
| AC-3 | PASS | `test/smoke-passport-autonomous.test.mjs:244-262` (T-SMK-03) — `fixtureSuccessWithBalances('0.50','0.49')` → exit 0, `status=success`, `pre_balance_usdc=0.5`, `post_balance_usdc=0.49`, `diff_within_tolerance=true`, `session_id_hash` matches `[0-9a-f]{8}`. All 4 sub-steps: pre-balance (script:229), execute (script:255-266), post-balance (script:287), diff check (script:299-302) |
| AC-4 | PASS | `readEnv()` at script:63-73 reads all 4 required vars with DEFAULTS object at script:54-61. `SMOKE_TARGET_URL` default `https://parallelmpp.dev/api/search`, `SMOKE_TARGET_BODY` default `{"objective":"latest news on crypto"}`, `EXPECTED_COST_USDC` default `0.01`, `MIN_BALANCE_USDC` default `0.05`. Insufficient-balance branch: script:240-249, verified by T-SMK-02 at test:229-242 |
| AC-5 | PASS | All `emit()` calls write to `process.stdout` (script:186-188); all `progress()` calls write to `process.stderr` (script:190-192). No `console.log`. `hashId()` at script:78-81 emits only first-8 of sha256 — `session_id` plaintext never reaches stdout/stderr (verified by T-SMK-01 grep at test:222-226 and T-SMK-02 at test:240-242) |
| AC-6 | PASS | `test/smoke-passport-autonomous.test.mjs` contains exactly 6 tests: T-SMK-01:213, T-SMK-02:229, T-SMK-03:244, T-SMK-04:264, T-SMK-05:275, T-SMK-06:287 — all use `spawnSync` subprocess stub via `SMOKE_KPASS_MOCK_FILE`. All 6 pass: `816 passed (816)` output confirms |
| AC-7 | PASS | `npm test -- --run` output: `Test Files 64 passed (64) / Tests 816 passed (816)`. Baseline was 810; 6 new tests added, zero regressions |
| AC-8 | PASS | `doc/runbooks/passport-smoke-autonomous.md` present (188 lines). Contains: prerequisites (§2), bootstrap steps (§3), all 8 env vars with defaults (§4 table), all 4 exit codes with meanings (§5 table), example invocations (§4, §6.1, §6.2), CI integration (§6.2 GitHub Actions) |

---

## Drift Detection

`git diff main..HEAD --stat` output:
```
doc/runbooks/passport-smoke-autonomous.md   | 188 +
scripts/smoke-passport-autonomous.mjs        | 324 +
test/smoke-passport-autonomous.test.mjs      | 299 +
vitest.config.ts                             |   2 +-
4 files changed, 812 insertions(+), 1 deletion(-)
```

All 4 files are Scope IN. `vitest.config.ts` change is purely additive: one pattern added to `include` array (`test/**/*.test.mjs`) — no existing patterns modified, no breaking change. No `src/`, no `.env*`, no `mcp-servers/` touched.

Drift: none.

---

## Runtime Checks

**Script executable**: `stat` confirms `0755/-rwxr-xr-x` on `scripts/smoke-passport-autonomous.mjs`.

**Standalone execution (no-session mock)**:
```
SMOKE_KPASS_MOCK_FILE=/tmp/smoke-no-session.json node scripts/smoke-passport-autonomous.mjs
→ exit 1
→ stdout: {"status":"human_gate_required","reason":"no_active_session","next_step":"Run: kpass…"}
→ stderr: [smoke] target=… / [smoke] checking active session…
```
Progress to stderr only; structured JSON to stdout only. Correct.

**Full test suite**: `npm test -- --run` → `816 passed (816)` in 2.00s.

No DB state, no env var deployment target, no migration — this HU has zero `src/` impact and no infrastructure changes.

---

## CD Verification

| CD | Status | Evidence |
|----|--------|----------|
| CD-WKH92-1 (kpass-only) | PASS | Script imports only `child_process`, `crypto`, `fs` (lines 50-52). No `fetch`, `axios`, or HTTP client. All Passport ops go through `kpassRun()` → `execFileSync` |
| CD-WKH92-2 (no JWT/token plaintext) | PASS | `jwt` and `agent_token` only appear in comment blocks (lines 43, 45). Line 222 reads `session_id` field to hash it immediately via `hashId()` — value never emitted. T-SMK-01 test asserts `stdout` does not match `/jwt/i` or `/agent_token/i` |
| CD-WKH92-3 (idempotent) | PASS | Script reads env + calls kpass each invocation with no shared mutable state between runs. `__mockFixture` is module-level cache for the mock path only; real path has no cross-run state. Each run produces independent smoke result |
| CD-WKH92-4 (subprocess stub, no real HTTP) | PASS | `SMOKE_KPASS_MOCK_FILE` path short-circuits `execFileSync` entirely (script:127-158). Tests use `spawnSync` to launch the script as subprocess with fixture — no real kpass binary or HTTP required |

---

## Recomendacion

816/816 tests passing, 8/8 ACs verified with file:line evidence, 4/4 CDs respected, zero drift from Scope IN. Listo para DONE.
