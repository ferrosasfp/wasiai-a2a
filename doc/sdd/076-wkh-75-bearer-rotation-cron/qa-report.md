# Validation Report — WKH-75 (Bearer Rotation Cron + Dual-Bearer Overlap) — COMPACT

| Field | Value |
|---|---|
| HU | WKH-75 — Headless bearer rotation cron + dual-bearer overlap window |
| Branch | `feat/076-wkh-75-bearer-rotation-cron` |
| HEAD | `72ef435` (W6 final, post-runbook) |
| Date | 2026-05-01 |
| QA pass | nexus-qa F4 |

## Verdict: APPROVED FOR DONE

---

## Runtime Checks

- **DB state**: N/A — no schema changes. All state in Vercel env vars + Upstash KV with explicit TTL. No SQL migrations.
- **Env parity**: `.env.example` has placeholders only for `VERCEL_TOKEN=vercel_xxxxxxxxxx`, `VERCEL_PROJECT_ID=prj_xxxxxxxxxx`, `VERCEL_TEAM_ID=team_xxxxxxxxxx`, `MCP_BEARER_TOKEN_PREV=`. No real secrets committed. CD-3: PASS.
- **Migration applied**: N/A — no DB migrations.

---

## AC Verification (15/15 PASS)

| AC | Text (abbreviated) | Status | Evidence |
|----|-------------------|--------|----------|
| AC-1 | Rotation script headless → generates bearer + updates envs + redeploy + JSON output | PASS | `scripts/rotate-bearer.mjs:10-43` — HEADLESS branch detected by `VERCEL_TOKEN && VERCEL_PROJECT_ID`; `stdout.write(JSON.stringify({ok:true, rotatedAt, expiresAt}))`. T-RB-03 (`bearer-rotation.test.mjs:91`) exercises full flow end-to-end with mocked Vercel API; T-CRO-04 (`cron-rotate-bearer.test.mjs:210`) confirms 200 + JSON output at HTTP layer. |
| AC-2 | Rotation script SIN VERCEL_TOKEN → manual fallback preserved | PASS | `scripts/rotate-bearer.mjs:45-66` — non-HEADLESS branch: TTY check + `stdout.write(bearer)`. T-RB-MANUAL (`bearer-rotation.test.mjs:241-253`): `spawnSync` without `VERCEL_TOKEN` asserts `exit ≠ 0`, `stderr =~ /Refusing/`, `stdout` contains no 64-hex. |
| AC-3 | Vercel API failure → abort without modifying MCP_BEARER_TOKEN + alert + exit 1 | PASS | `bearer-rotation.mjs:73-134` — all failure paths return `{ok:false}` before `updateEnv` is reached; S3 (`createEnv`) has rollback DELETE on S4 failure. T-RB-04 (`bearer-rotation.test.mjs:136`): `listEnvs` 401 → `ok:false`, 0 mutating calls, 1 alert. T-RB-05 (`line:157`): `createEnv` 500 → current env intact. T-RB-06 (`line:178`): `updateEnv` 500 → rollback DELETE PREV issued, current intact, alert dispatched. T-INT-02 (`rotation-integration.test.mjs:271`): full pipeline 500 response, PREV rolled back. |
| AC-4 | Dual-bearer accepts current OR prev (timing-safe both) | PASS | `src/auth.mjs:90-108` — `timingSafeEqual` for current (line 93), `timingSafeEqual` for prev (line 105); both length-pre-checked. AUTH-10 (`auth.test.mjs:130`): prev bearer accepted. AUTH-11 (`line:137`): current accepted with prev configured. AUTH-11b (`line:144`): wrong bearer rejected. T-HTTP-30 (`http.test.mjs:795`): API layer returns 200 with prev bearer. T-HTTP-31 (`line:822`): wrong bearer → 401. |
| AC-5 | Post-24h cron invalidation → DELETE PREV + redeploy | PASS | `api/cron/invalidate-prev-bearer.mjs:166-229` — `expiresMs <= now` branch: `deleteEnv` + `triggerRedeploy` (best-effort). T-CIN-03 (`cron-invalidate-prev-bearer.test.mjs:193`): past `expiresAt` → DELETE PREV issued + redeploy triggered + 200 `{invalidatedAt}`. T-INT-03 (`rotation-integration.test.mjs:352`): end-to-end invalidation, PREV deleted, current intact. |
| AC-6 | Sin MCP_BEARER_TOKEN_PREV → behavior idéntico WKH-65 | PASS | `api/mcp.mjs:214`: `process.env.MCP_BEARER_TOKEN_PREV ?? ''`; `auth.mjs:102`: `prevToken.length === 64` guard — empty string short-circuits before `timingSafeEqual`. T-HTTP-32 (`http.test.mjs`): PREV unset + arbitrary bearer → 401. AUTH-12 (`auth.test.mjs`): `prevToken=''` → only current honored. AUTH-01..AUTH-09 preserved (all 232 pass). |
| AC-7 | Cron registration `wasiai-x402-bearer-rotation` schedule 30d POST with CRON_SECRET | PASS | `scripts/setup-cronjob.mjs:57-62`: job title `wasiai-x402-bearer-rotation`, `requestMethod: 2` (POST), schedule `{minutes:['0'], hours:['9'], mdays:['*/30']}`, Authorization header carries `Bearer ${CRON_SECRET}`. T-SC-05 (`setup-cronjob.test.mjs:169`): asserts `requestMethod===2`, URL, auth header. T-SC-06 (`line:204`): asserts schedule values. |
| AC-8 | POST /api/cron/rotate-bearer with CRON_SECRET → 200 ok rotation success | PASS | `api/cron/rotate-bearer.mjs:40-119`: Auth → config gate → `rotateBearer()` → 200 `{ok:true, rotatedAt, expiresAt}`. T-CRO-04 (`cron-rotate-bearer.test.mjs:210`): auth + happy path → 200, correct JSON body, KV snapshot persisted. T-INT-01 (`rotation-integration.test.mjs:191`): full integration confirmation. |
| AC-9 | 401 sin CRON_SECRET header, 500 sin server config, timing-safe verification | PASS | `src/cron-auth.mjs:47-76`: `expectedSecret` empty → `CronAuthError(500)`; wrong/missing header → `CronAuthError(401)`; comparison via `timingSafeEqual` (line 73). T-CRO-01 (`cron-rotate-bearer.test.mjs:142`): no auth → 401. T-CRO-02 (`line:164`): `CRON_SECRET` unset → 500. T-CIN-04 (`cron-invalidate-prev-bearer.test.mjs:266`): no auth → 401, no Vercel/KV touch. |
| AC-10 | Cron endpoint success → KV snapshot persisted last-bearer-rotation | PASS | `src/bearer-rotation.mjs:143-148`: S6 `kvClient.set('last-bearer-rotation', JSON.stringify({rotatedAt, expiresAt}), {ex: KV_TTL_SECONDS})`. T-CRO-04 (`cron-rotate-bearer.test.mjs:251-256`): `kv._store.get('last-bearer-rotation')` asserted present with correct shape and TTL. T-RB-03 (`bearer-rotation.test.mjs:114-119`): KV entry verified directly. |
| AC-11 | POST /api/cron/invalidate-prev-bearer → KV expiresAt < now → DELETE PREV + redeploy + 200 | PASS | `invalidate-prev-bearer.mjs:166-229`: `expiresMs <= now` → `deleteEnv` → `triggerRedeploy` → 200 `{ok:true, invalidatedAt}`. T-CIN-03 (`cron-invalidate-prev-bearer.test.mjs:193`): PREV env deleted, redeploy triggered, 200 `{invalidatedAt}`. T-INT-03 (`rotation-integration.test.mjs:352`). |
| AC-12 | cron invalidation → KV expiresAt >= now → 200 skipped sin modificar nada | PASS | `invalidate-prev-bearer.mjs:167-172`: `expiresMs > now` → return 200 `{ok:true, skipped:true, reason:'overlap window still active'}`. T-CIN-02 (`cron-invalidate-prev-bearer.test.mjs:149`): future `expiresAt`, `mock.calls.length===0` (zero Vercel calls), 200 skipped. T-INT-04 (`rotation-integration.test.mjs:440`): zero `vercelCalls.length`, PREV env untouched. |
| AC-13 | README runbook con 7 items | PASS | `README.md:362-493` — `## Bearer rotation runbook (WKH-75)`: (a) Cadencia recomendada, (b) Manual rotation, (c) Verificación post-rotation, (d) Rollback, (e) Verificación de overlap window (24h), (f) Last-rotation timestamp (`<!-- LAST_BEARER_ROTATION: YYYY-MM-DD -->` at line 370), (g) Advertencia de seguridad. All 7 items present. |
| AC-14 | Tests: rotation happy + failures + dual-bearer + invalidation | PASS | `tests/bearer-rotation.test.mjs` (T-RB-03..T-RB-MANUAL), `tests/cron-rotate-bearer.test.mjs` (T-CRO-01..05), `tests/cron-invalidate-prev-bearer.test.mjs` (T-CIN-01..04), `tests/rotation-integration.test.mjs` (T-INT-01..04), `tests/auth.test.mjs` (AUTH-10..12b), `tests/http.test.mjs` (T-HTTP-30..33), `tests/audit-stderr.test.mjs` (T-AUD-01..03). Full matrix covered. |
| AC-15 | npm test 100% green sin regresiones | PASS | `cd mcp-servers/wasiai-x402 && node --test 'tests/*.test.mjs'` at HEAD `72ef435`: `# tests 232 / # pass 232 / # fail 0` (executed locally, confirmed). |

---

## CD Verification (17/17 PASS)

| CD | Check method | Status |
|----|-------------|--------|
| CD-1 | `git diff main...feat/076-wkh-75-bearer-rotation-cron -- src/handlers.mjs src/sign.mjs src/config.mjs src/log.mjs src/url-validator.mjs` → zero output | PASS |
| CD-2 | `auth.mjs:93,105`: both `timingSafeEqual`; `cron-auth.mjs:73`: timing-safe. No `===` or ad-hoc compare on token bytes. | PASS |
| CD-3 | `.env.example:147,155,163`: values are `vercel_xxxxxxxxxx`, `prj_xxxxxxxxxx`, `team_xxxxxxxxxx`, `MCP_BEARER_TOKEN_PREV=` (empty). No real secrets. | PASS |
| CD-4 | `cron-auth.mjs:50-51`: `expectedSecret.length===0` → `throw CronAuthError(500)`. T-CRO-02 confirms 500 on unset `CRON_SECRET`. | PASS |
| CD-5 | `vercel-env.mjs:31`: `DEFAULT_TIMEOUT_MS = 10_000`; `line 65`: default arg. | PASS |
| CD-6 | `alerts.mjs:54`: `timeoutMs = 5000` default; `line 77`: `AbortSignal.timeout(timeoutMs)`. | PASS |
| CD-7 | All test files use `globalThis.fetch` override + `createKvMock()`. No real HTTP. | PASS |
| CD-8 | AUTH-01..AUTH-09 present in `tests/auth.test.mjs`; all 232 tests pass including baseline suite. AR confirms preserved. | PASS |
| CD-9 | `audit-stderr.test.mjs` (T-AUD-01..03) captures stderr across rotation/invalidation flows and asserts no 64-hex sequences, no `TEST_VERCEL_TOKEN`, `CRON_SECRET`, bearer values in output. T-INT-01/02/03 also assert `hexHits.length === 0`. | PASS |
| CD-10 | `rotate-bearer.mjs:40`: `export default async function rotateBearerHandler(req, res)`; `invalidate-prev-bearer.mjs:63`: same. No `new Response(...)` (Edge pattern). | PASS |
| CD-11 | `alerts.mjs:24-38`: `ALLOWED_BODY_KEYS = new Set([...])` — whitelist deny-by-default. `sanitizeAlertBody:40-46` iterates and filters. | PASS |
| CD-12 | `bearer-rotation.mjs:27-32`: `STAGE_REASONS = Object.freeze({...})`. All `reason` fields are `STAGE_REASONS[stage]`. T-INT-02 line 335: asserts `alert.reason === 'failed to update current env (rolled back)'` (literal from whitelist). | PASS |
| CD-13 | `vercel-env.mjs:72,90,101`: `clearTimeout(t)` in abort listener, catch block, and finally block. Three-way guard. | PASS |
| CD-14 | `invalidate-prev-bearer.mjs:157-163`: `const expiresMs = Date.parse(expiresAtIso); if (!Number.isFinite(expiresMs))` — refuses to act on NaN. | PASS |
| CD-15 | `invalidate-prev-bearer.mjs:56-61`: `_readOwnString` uses `Object.prototype.hasOwnProperty.call(obj, field)` — prototype pollution guard. | PASS |
| CD-16 | All `log.info/warn/error(...)` calls in new files use event name as first argument. The only `event:` key in new code is at `bearer-rotation.mjs:53` inside `sendAlert` body — which is the ALLOWED_BODY_KEYS-whitelisted alert body, not a log fields object. Grep confirms zero `log.*(...event:` pattern. | PASS |
| CD-17 | Test mock checks `u.host !== 'api.vercel.com'` to route to alert/webhook path. `bearer-rotation.test.mjs:111`: `assert.equal(c.host, 'api.vercel.com')`. `vercel-env.test.mjs:81`: `assert.equal(new URL(cap.calls[0].url).host, 'api.vercel.com')`. | PASS |

---

## Drift Detection

All modified files are in `mcp-servers/wasiai-x402/` + `doc/sdd/076-wkh-75-bearer-rotation-cron/auto-blindaje.md` + `doc/sdd/_INDEX.md` + `doc/sdd/075-wkh-78-migration-preflight/done-report.md` (WKH-78 done-report, already merged/committed as part of this branch's history from pipeline — not scope drift, it's a docs commit from a prior overlapping pipeline run).

No `doc/sdd/076-wkh-75-bearer-rotation-cron/work-item.md` or `sdd.md` committed (inputs were provided inline; no scope violation). Files within `mcp-servers/wasiai-x402/` are limited to: `src/`, `api/cron/`, `scripts/`, `tests/`, `.env.example`, `README.md` — all within Scope IN.

Drift: **NONE** (within mcp-servers/wasiai-x402 scope).

---

## Gates (confirmed from AR report + test run)

| Gate | Status |
|------|--------|
| npm test (232 tests) | PASS — verified directly at HEAD `72ef435`: `# pass 232 / # fail 0` |
| lint/tsc | No TypeScript in this project (pure `.mjs`). No lint config checked by pipeline. N/A. |
| AUTH-01..AUTH-09 baseline | PASS — confirmed by AR report ("AUTH-01..AUTH-09 baseline: PRESERVED") and 232/232 test run |
| T-RB-MANUAL | PASS — confirmed by AR report + test suite pass |
| T-AUD-01..03 zero leaks | PASS — confirmed by test suite pass + AR coverage matrix vector 2 |

---

## AR/CR Closure

**AR**: 0 BLQ, 4 MNR (non-blocking) — all carry-forward to backlog.

**CR**: No cr-report.md file committed. Per task brief, CR APPROVED with 13/13 checklist OK and 5 MNR-CR carry-forward. No cr-report.md artifact on disk — this is a documentation gap (no blocking impact; tests pass and AR is approved).

### MNR consolidated tracking (9 total, all carry-forward)

| ID | Source | Description | Disposition |
|----|--------|-------------|-------------|
| MNR-AR-1 | AR | `api/cron/*.mjs` accept any HTTP method (no 405 gate) | Backlog — `if (req.method !== 'POST') 405`. Auth still gates. |
| MNR-AR-2 | AR | Concurrent manual+cron rotation → possible duplicate `MCP_BEARER_TOKEN_PREV` | Backlog — KV mutex or runbook doc "don't run concurrently". |
| MNR-AR-3 | AR | Cron endpoints rely solely on `CRON_SECRET`, no origin/UA allowlist | Backlog — post-hackathon hardening. |
| MNR-AR-4 | AR | No test asserting TTY + `VERCEL_TOKEN` set → headless wins (autodetect branch) | Backlog — T-RB-AUTODETECT ~15 LOC. |
| MNR-CR-1 | CR | Pipeline artefacts (work-item.md, sdd.md) not committed | Accepted — docs gap, not a runtime issue. |
| MNR-CR-2 | CR | `KV_KEY = 'last-bearer-rotation'` duplicated in `bearer-rotation.mjs:36` and `invalidate-prev-bearer.mjs:47` | Backlog — extract to shared constant module. |
| MNR-CR-3 | CR | JSDoc missing on `rotateBearer` function signature | Backlog — add JSDoc. |
| MNR-CR-4 | CR | No dedicated test for CD-14 NaN guard in isolation | Backlog — unit test for `_readOwnString` NaN path. |
| MNR-CR-5 | CR | Comment `KV_TTL = 25h` vs overlap `24h` could confuse future readers | Accepted — intentional (TTL > overlap); add comment clarification in backlog. |

None of the above block DONE.

---

## Smoke Checklist (for operator, post-merge)

1. Deploy to Vercel staging with `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, `CRON_SECRET` set.
2. `POST /api/cron/rotate-bearer` with `Authorization: Bearer $CRON_SECRET` → expect 200 `{ok:true, rotatedAt, expiresAt}`.
3. Verify `MCP_BEARER_TOKEN_PREV` appears in Vercel Project → Settings → Environment Variables.
4. Connect with old bearer (MCP_BEARER_TOKEN_PREV value) → expect 200 from `/api/mcp`.
5. Connect with new bearer (MCP_BEARER_TOKEN value) → expect 200.
6. `POST /api/cron/invalidate-prev-bearer` immediately → expect 200 `{ok:true, skipped:true, reason:'overlap window still active'}`.
7. Manually set KV `last-bearer-rotation` with past `expiresAt`, re-POST invalidate → expect 200 `{ok:true, invalidatedAt}`.
8. Old bearer should now 401. New bearer still 200.
9. Run `node scripts/setup-cronjob.mjs` → verify 4 cron jobs registered including `wasiai-x402-bearer-rotation` and `wasiai-x402-invalidate-prev-bearer`.

---

**APPROVED FOR DONE.**
