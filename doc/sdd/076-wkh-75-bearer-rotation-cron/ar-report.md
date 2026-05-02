# Adversarial Review — WKH-75 (Headless bearer rotation + cron + dual-bearer overlap)

| Field | Value |
|---|---|
| HU | WKH-75 — Headless bearer rotation cron + dual-bearer overlap window |
| Branch | `feat/076-wkh-75-bearer-rotation-cron` |
| HEAD | `72ef435` (W6 final, post-runbook) |
| Phase | AR (post W0..W6 completion) |
| Methodology | NexusAgil QUALITY |
| Pipeline tests | **232/232 PASS** (re-run from `mcp-servers/wasiai-x402` at HEAD) |
| Date | 2026-05-02 |
| Reviewer | nexus-adversary |

## Files audited

```
NEW    src/vercel-env.mjs                        (W0 — Vercel REST helper, 227 LOC)
NEW    src/bearer-rotation.mjs                   (W2 — rotation core S0..S8, 154 LOC)
MODIFY src/auth.mjs                              (W1 — dual-bearer overlap)
MODIFY src/alerts.mjs                            (W2 — whitelist event/reason/rotatedAt)
MODIFY api/mcp.mjs                               (W1 — wires MCP_BEARER_TOKEN_PREV)
NEW    api/cron/rotate-bearer.mjs                (W3 — cron endpoint)
NEW    api/cron/invalidate-prev-bearer.mjs       (W3 — daily probe + delete)
MODIFY scripts/rotate-bearer.mjs                 (W2 — headless mode autodetect)
MODIFY scripts/setup-cronjob.mjs                 (W4 — registers 2 new jobs)
NEW/MOD tests/{vercel-env,bearer-rotation,cron-rotate-bearer,
        cron-invalidate-prev-bearer,rotation-integration,
        audit-stderr,auth,http,alerts}.test.mjs   (W0/W2/W3/W5)
MODIFY README.md                                 (W6 — operations runbook)
MODIFY .env.example                              (W3 — VERCEL_TOKEN/PROJECT_ID/TEAM_ID/PREV)
```

---

## Veredicto final

> **APROBADO**

- BLQ-ALTO: 0
- BLQ-MED: 0
- BLQ-BAJO: 0
- MNR: 4 (calibrated; none block the gate)
- Categorías N/A: 0 (every category produced either a finding or a positive observation)
- AUTH-01..AUTH-09 baseline: **PRESERVED** (verified end-to-end via test runner; CD-8 honored)
- AC-2 (no VERCEL_TOKEN ⇒ manual fallback) confirmed by T-RB-MANUAL
- AC-6 (no MCP_BEARER_TOKEN_PREV ⇒ behavior identical to WKH-65) confirmed by AUTH-12 + T-HTTP-30 regression

The implementation is sound. The auth surface, the rotation core and the cron endpoints all hold under the 11 categories of attack. The 4 MNRs are quality/operability deltas — none compromises the security posture, none breaks any AC.

---

## Hallazgos

### BLOQUEANTES — none

(Zero BLQ-ALTO, zero BLQ-MED, zero BLQ-BAJO. The gate passes.)

### MENORES (do NOT block, captured for backlog or fast follow-up)

#### MNR-1 — `api/cron/*.mjs` accept any HTTP method (no method gate)

- **Categoría**: Integration / Security (defense-in-depth)
- **Archivo:línea**: `api/cron/rotate-bearer.mjs:40-119`, `api/cron/invalidate-prev-bearer.mjs:63-230`
- **Descripción**: Neither cron handler validates `req.method`. `setup-cronjob.mjs:60` registers them as POST (`requestMethod: 2`), but if anyone with a valid `CRON_SECRET` ever invokes them via `GET https://…/api/cron/rotate-bearer` they will rotate and, in the case of `invalidate-prev`, also DELETE `MCP_BEARER_TOKEN_PREV`. This is not exploitable today (auth + secret are the gate), but a defense-in-depth gap: a side-channel that only POST should run is currently silently equivalent to "any method works". Compare with `api/mcp.mjs:184-186` which explicitly returns 405 on non-POST.
- **Reproducción**: `curl -X GET -H "Authorization: Bearer $CRON_SECRET" https://wasiai-x402-mcp.vercel.app/api/cron/rotate-bearer` → 200 + rotation executed. Expected: 405.
- **Impacto**: BAJO — auth still gates, but a misconfigured client (e.g. cron-job.org with the wrong method) would silently rotate on every probe instead of failing visibly. Also a small audit-trail confusion (cron-job.org logs would not match what Vercel sees).
- **Sugerencia (NO implementar aquí)**: add `if (req.method !== 'POST') { _json(res, 405, { error: 'method not allowed' }); return; }` before the auth check, mirroring `api/mcp.mjs:184-186`.

#### MNR-2 — Concurrent rotation races could leave duplicate `MCP_BEARER_TOKEN_PREV` records

- **Categoría**: Data Integrity / Race conditions
- **Archivo:línea**: `src/bearer-rotation.mjs:73-149` (full S1..S6 sequence is non-atomic)
- **Descripción**: If a manual rotation (`scripts/rotate-bearer.mjs` headless mode) and the cron rotation (`api/cron/rotate-bearer.mjs`) fire within the same Vercel cold-start window (~ a few hundred ms), both can pass S1 (listEnvs returns identical state) and both attempt S3 (`createEnv MCP_BEARER_TOKEN_PREV`). Vercel's REST API allows duplicate-keyed env vars on the same target (`production`); we did NOT find a unique-constraint guard. Outcome: two `MCP_BEARER_TOKEN_PREV` records, both with the same value (the *original* current at the start of the race), but the runtime only reads one (`process.env.MCP_BEARER_TOKEN_PREV` = whichever Vercel picks last). Both rotations then race S4 (`updateEnv` current) — last writer wins; the loser's `newBearer` is permanently lost.
- **Reproducción** (deterministic via mocks): drive `rotateBearer()` twice in parallel against the same `makeVercelMock` state, with no locking between them. The mock will accept both `createEnv` POSTs and you will end with `state.envs.filter(e => e.key === 'MCP_BEARER_TOKEN_PREV').length === 2`. Today no test does this — adding it would surface the gap, not because it is wrong but because it is undocumented.
- **Impacto**: BAJO — not security-relevant (both PREV values are equal), but operationally messy: ops would see two PREV envs in the Vercel dashboard and not know which one is canonical. The next rotation's S2 only deletes the *first* PREV it finds (`envs.find()` is single-match), so the duplicate would persist for at least one full overlap cycle.
- **Sugerencia**: either (a) document explicitly in the runbook that manual + cron must NOT be run within minutes of each other, or (b) in W3 cron handler, attempt a KV-based mutex (e.g. `kv.set('rotation-lock', '1', { ex: 120, nx: true })`) before calling `rotateBearer`. Not a today-fix; backlog.

#### MNR-3 — Cron endpoints lack origin/CSRF check (relies solely on bearer)

- **Categoría**: Security (defense-in-depth)
- **Archivo:línea**: `api/cron/rotate-bearer.mjs:40-55`, `api/cron/invalidate-prev-bearer.mjs:63-78`
- **Descripción**: Cron endpoints are reachable from any origin once the bearer is known. There is no `User-Agent`, `X-Cron-Source`, or origin allowlist. `validateCronSecret` is correctly timing-safe (`src/cron-auth.mjs:67-75`), so brute force is not feasible, but if `CRON_SECRET` ever leaks (e.g. via the cron-job.org dashboard), an attacker can trigger rotation/invalidation from anywhere with no further gate. Mitigation: `CRON_SECRET` is rotated by ops manually; this is acceptable for hackathon scope and is documented in the runbook.
- **Reproducción**: any `curl` from any host with the right `Authorization` header works. There is no allowlist on `req.headers['x-forwarded-for']` or similar.
- **Impacto**: BAJO — the bearer IS the gate; this is a defense-in-depth observation. Not exploitable on its own.
- **Sugerencia**: post-hackathon, gate the cron endpoints on `req.headers['user-agent']?.startsWith('cron-job.org')` or a verifying signature. Backlog item, NOT today.

#### MNR-4 — `scripts/rotate-bearer.mjs` headless mode does NOT verify TTY-blocking when both modes are active

- **Categoría**: Test Coverage / Scope Drift safeguards
- **Archivo:línea**: `scripts/rotate-bearer.mjs:10-43`
- **Descripción**: The `HEADLESS` flag is `Boolean(VERCEL_TOKEN && VERCEL_PROJECT_ID)`. If an operator runs the script from an interactive terminal with both env vars set (e.g. they exported VERCEL_TOKEN for a debug session), the script will silently take the headless branch — which is the desired behavior (CD-9: never print the bearer to a TTY) — but there is NO test asserting that "TTY + VERCEL_TOKEN ⇒ headless wins". `T-RB-MANUAL` only covers "no VERCEL_TOKEN ⇒ manual mode preserved". Add a positive test "TTY present + headless env vars set ⇒ headless mode runs and never prints the bearer to stdout".
- **Reproducción**: `VERCEL_TOKEN=… VERCEL_PROJECT_ID=… node scripts/rotate-bearer.mjs` from an interactive shell. Today: silently runs headless, prints `{ok:true,…}` JSON. Tested manually. No assertion in the test suite that this branch was *intentional*.
- **Impacto**: BAJO — no behavior bug today, only a coverage gap for a future refactor that might flip the precedence. If someone changes `HEADLESS` to `Boolean(...) && !process.stdout.isTTY` (an "obvious" simplification), they would silently break headless rotation when run from a TTY for debugging. A regression test would catch that.
- **Sugerencia**: add T-RB-AUTODETECT in `tests/bearer-rotation.test.mjs` covering "isTTY + env vars set ⇒ headless flow exercised". Trivial, ~15 LOC, NOT urgent.

---

## Coverage matrix — 11 vectors of attack

| # | Vector | Result | Evidence |
|---|--------|--------|----------|
| 1 | **Auth bypass via dual-bearer** | OK | `src/auth.mjs:90-108` — both compares are `timingSafeEqual`, length-pre-checked. AUTH-10/11/11b/12/12b in `tests/auth.test.mjs:128-180`. The `prev=''` empty-string case is handled at line 102 via `prevToken.length === 64` — empty Authorization header rejected at line 73-75 BEFORE prev compare. The `prevToken === currentToken` race is handled by short-circuit at line 95 (current matches first). `Bearer ` scheme is exact-match (case-sensitive), `bearer ` lowercase rejected by AUTH-03. |
| 2 | **Rotation flow vulnerabilities (partial state, races, audit leaks)** | OK | `src/bearer-rotation.mjs:73-149` — S5 (redeploy) and S6 (KV) are best-effort and never bring the rotation back to "failed"; partial state (S5 ok + S6 fail) leaves the next invalidate-cron to skip with "no rotation snapshot", PREV gets cleaned by the next rotation's S2. Audit assertions in `tests/audit-stderr.test.mjs:148-477` (T-AUD-01..03) confirm no token/bearer leaks across success+failure paths. CD-12 reason whitelist enforced at `src/bearer-rotation.mjs:28-32`. Concurrent rotation race captured as MNR-2 (data integrity, not security). `validateCronSecret` is timing-safe (`src/cron-auth.mjs:73`). |
| 3 | **KV poisoning** | OK | `api/cron/invalidate-prev-bearer.mjs:55-61` (`_readOwnString`) explicitly uses `Object.prototype.hasOwnProperty.call` against prototype pollution. Lines 156-164 use `Number.isFinite(Date.parse(...))` to guard NaN. Missing KV blob → 200 skipped (line 117-123). `expiresAt` as object instead of string → returns null in `_readOwnString` ⇒ skip. CD-14 + CD-15 are correctly applied. |
| 4 | **Vercel API edge cases** | OK | `src/vercel-env.mjs:128-137` — listEnvs filters on caller side: `bearer-rotation.mjs:82-83` and `94-95` use `e.key === 'MCP_BEARER_TOKEN' && Array.isArray(e.target) && e.target.includes('production')`, so a duplicate legacy entry with target=['preview'] would be ignored. teamId scoping is via querystring (`_withTeamScope`), not path; missing teamId is benign — Vercel scopes to the token's primary team. `redirect: 'error'` (line 85) prevents rate-limit redirects to other hosts. The `_request` helper does NOT retry — a 429 surfaces as `VercelEnvError(status=429)` to the caller, which fails the rotation cleanly with stage='list-envs'/'create-prev'/'update-current' as appropriate. |
| 5 | **Cron endpoint security** | OK / MNR | Empty `CRON_SECRET` ⇒ 500 via `cron-auth.mjs:50-52` (CD-4 enforced). Path traversal: handlers receive `req` from Vercel runtime; the `req.url` is not parsed by these handlers (they read only `req.headers.authorization`). No file system or relative path operations. CSRF observation captured as **MNR-3**. Method gate captured as **MNR-1**. |
| 6 | **Backward compatibility** | OK | AUTH-01..AUTH-09 preserved (test runner output: `# pass 232`). T-HTTP-30 (regression) confirms `MCP_BEARER_TOKEN_PREV` unset ⇒ identical behavior to WKH-65. AC-2 (no VERCEL_TOKEN ⇒ manual fallback) confirmed by T-RB-MANUAL (`tests/bearer-rotation.test.mjs:241-253`). The W4 setup-cronjob is additive: WKH-66 jobs (warmup, balance-check) untouched (`scripts/setup-cronjob.mjs:39-53`). |
| 7 | **Concurrent rotation** | MNR-2 | See finding above. The auth surface itself is concurrency-safe (read-only env var lookup); the data-integrity gap is in the rotation flow choreography across two callers, not in any individual function. Acceptable because today's setup is a single 30-day cron + manual ops; the race window is theoretical. |
| 8 | **Test mock honesty** | OK | All mocks reject unhandled paths with 500 (`tests/bearer-rotation.test.mjs:73-74`, etc.). Real network is never hit (`globalThis.fetch` is restored in afterEach). Vercel API responses match documented shape: `{ envs: [...] }` (listEnvs), `{ id, created }` (createEnv). The `vercel-env.mjs:134-136` normalizer correctly handles both `{ envs }` and bare-array shapes — covered by T-VE-01. T-VE-08 confirms guardrails fire BEFORE fetch when projectId/token are missing. |
| 9 | **Auto-blindaje patterns applied** | OK | CD-13 orphan-timer guard: `src/vercel-env.mjs:71-103` — `clearTimeout(t)` runs in (a) success path before parsing body, (b) catch block before re-throw, (c) finally block as a defensive double-call. Verified end-to-end by T-VE-03. CD-14 NaN guard: `api/cron/invalidate-prev-bearer.mjs:158` uses `Number.isFinite(Date.parse(...))` — not naive `parseFloat`. CD-15 prototype pollution: `api/cron/invalidate-prev-bearer.mjs:55-61` `_readOwnString` correctly uses `Object.prototype.hasOwnProperty.call`. CD-16 (no `event:` in fields object): I grep'd every `log.warn(...)` / `log.info(...)` / `log.error(...)` call across the new files — zero violations. |
| 10 | **Destructive Migrations** | N/A | No SQL, no schema changes, no data migrations. All state lives in (a) Vercel env vars (managed by Vercel), (b) Upstash Redis (KV) with explicit TTL (`KV_TTL_SECONDS = 25 * 60 * 60` in `src/bearer-rotation.mjs:35`). KV writes are scoped to a single key (`last-bearer-rotation`) and overwrite-only — no DROP/TRUNCATE/ALTER equivalent. |
| 11 | **Cache Invalidation Logic** | OK | The 24h overlap window IS a deliberate cache (the prev token is the cache). Invalidation trigger: KV.expiresAt < now (`api/cron/invalidate-prev-bearer.mjs:166-173`). KV TTL (25h, `bearer-rotation.mjs:35`) is correctly longer than the overlap window (24h, `OVERLAP_WINDOW_MS`) so the snapshot survives long enough to drive its own invalidation. Cache key (`'last-bearer-rotation'`) is global, NOT user-scoped — but this is single-tenant infrastructure (one operator per deploy), so user-scoping is irrelevant. The fail-closed semantics on KV read failure (line 113) is correct: refuse to invalidate when we can't verify the window expired. |

---

## Top 3 hallazgos

1. **MNR-1** — `api/cron/*.mjs` lack an explicit `req.method !== 'POST' → 405` gate; defense-in-depth gap, mirrored from `api/mcp.mjs:184-186` would close it (15-line fix, not blocking).
2. **MNR-2** — concurrent rotations (manual + cron firing within the same minute) can leave duplicate `MCP_BEARER_TOKEN_PREV` records; auth still works correctly, but operationally confusing. KV-based `nx` lock would close it; backlog.
3. **MNR-3** — cron endpoints rely solely on `CRON_SECRET` for access control; no User-Agent/origin/CSRF gate. Acceptable for hackathon scope; flag for post-hackathon hardening.

---

## Notas adicionales (no findings, observaciones positivas)

- **`STAGE_REASONS` is a frozen literal whitelist** (`src/bearer-rotation.mjs:27-32`) — `Object.freeze(...)` is applied. CD-12 not bypassable by mutation.
- **Alert body whitelist correctly extended** (`src/alerts.mjs:24-38`) — `event`, `reason`, `rotatedAt` were added; `bearer`, `vercelToken`, `MCP_BEARER_TOKEN`, `value` are NOT in the whitelist (T-AL-05 confirms they are silently dropped).
- **`api/mcp.mjs:214` reads `process.env.MCP_BEARER_TOKEN_PREV ?? ''`** — the nullish coalesce protects against the env var being unset (legacy WKH-65 behavior). The `''` then short-circuits the prev compare at `auth.mjs:102` (length !== 64) — correct fall-through to the legacy single-bearer flow.
- **`vercel-env.mjs:_request` reads response body only on 2xx** (line 105-122) — CD-9 explicitly avoids reading `res.text()` on error to prevent Vercel from echoing back the env value we sent.
- **`scripts/setup-cronjob.mjs:131-141` is genuinely idempotent** — match-by-title then PATCH, so re-running setup-cronjob does not create duplicates (CD-20 honored).
- **Test isolation discipline is strong** — every cron-* test uses `?t=${Date.now()}_${Math.random()}` cache-busting on the dynamic `import()` of the handler so no module state leaks across tests.

---

## Final gate

| Gate criterion | Status |
|---|---|
| Zero BLQ-ALTO | YES |
| Max 2 BLQ-MED | YES (0/2) |
| AUTH-01..AUTH-09 baseline preserved | YES (T-AUTH-01..09 PASS in 232/232) |
| AC-2 manual fallback preserved | YES (T-RB-MANUAL PASS) |
| AC-6 single-bearer regression preserved | YES (T-HTTP-30 + AUTH-12) |
| 11/11 attack categories assessed | YES |
| All findings have repro + impact + suggestion | YES |
| Destructive migration risks | N/A (no SQL) |

**Result: APROBADO. Pipeline may advance to CR (P6).**
