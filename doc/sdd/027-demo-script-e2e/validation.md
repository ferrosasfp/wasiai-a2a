# Validation Report — WKH-30 Demo Script E2E

Date: 2026-04-06
Branch: feat/025-a2a-key-middleware (commit 2517024)
Validator: nexus-qa

---

## 1. Drift Detection

**Scope: PASS**
- `scripts/smoke-test.sh` — new file, Scope IN
- `README.md` — "Smoke Test / Demo" section added at line 227, Scope IN
- `src/` — git status at session start shows only `M CLAUDE.md` and `?? supabase/.temp/` — no production code touched by this WKH
- No files outside Scope IN were modified

**Wave order: PASS**
- Single-wave delivery (S sizing): script + README, no phases to order

**Spec adherence: PASS (one minor drift noted)**
- DT-1 (bash + curl): scripts/smoke-test.sh:1 has `#!/usr/bin/env bash` — PASS
- DT-2 (jq fallback): scripts/smoke-test.sh:21-25 grep-based fallback implemented — PASS
- CD-1 (no hardcoded URLs except default): scripts/smoke-test.sh:11 BASE_URL uses production as default only — PASS
- CD-2 (no secrets): only ephemeral owner_ref generated at runtime — PASS
- CD-3 (chmod+x + shebang): `-rwxr-xr-x` confirmed, shebang at line 1 — PASS
- CD-4 (per-endpoint PASS/FAIL): report() called once per endpoint block — PASS
- MINOR drift: AC-13 text says POST /discover but src/routes/discover.ts:10 defines GET /discover. Script uses GET (correct per actual API). Work-item AC-13 and README table have a typo. Behavior is correct.

---

## 2. AC Verification

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | PASS | scripts/smoke-test.sh:11 — BASE_URL defaults to production URL |
| AC-2 | PASS | scripts/smoke-test.sh:11 — positional $1 used as BASE_URL override |
| AC-3 | PASS | scripts/smoke-test.sh:58-76 — report() prints PASS/FAIL + HTTP code per endpoint |
| AC-4 | PASS | scripts/smoke-test.sh:208-212 — exit 0 when FAIL_COUNT=0 |
| AC-5 | PASS | scripts/smoke-test.sh:207-209 — exit 1 when FAIL_COUNT > 0, after all checks |
| AC-6 | PASS | curl / -> HTTP 200, body: {"name":"WasiAI A2A Protocol","version":"0.1.0",...} |
| AC-7 | PASS | curl /.well-known/agent.json -> HTTP 200, body: {"name":"WasiAI A2A Gateway",...,"skills":[...]} |
| AC-8 | PASS | curl /gasless/status -> HTTP 200, body: {...,"funding_state":"unconfigured"} |
| AC-9 | PASS | curl -o /dev/null -w "%{http_code}" /dashboard -> HTTP 200 |
| AC-10 | PASS | curl /dashboard/api/stats -> HTTP 200, body: {"registriesCount":1,...} |
| AC-11 | PASS | curl -X POST /auth/agent-signup -> HTTP 201, key: wasi_a2a_7ddec8313d208b86a9dc3bb9a4e3749bb5d30c24b1a4e756b43002c624614ed9 (starts with wasi_a2a_) |
| AC-12 | PASS | curl GET /auth/me with key -> HTTP 200, body has key_id, display_name, is_active:true |
| AC-13 | PASS | curl GET /discover -> HTTP 200, body: {"agents":[...],"total":17,"registries":["WasiAI"]} — agents array present. AC text says POST (typo); route is GET per src/routes/discover.ts:10; script uses GET correctly |
| AC-14 | PASS | scripts/smoke-test.sh:198-199 — POST /compose and POST /orchestrate emitted as SKIP label, not FAIL |

**Result: 14/14 PASS (0 FAIL)**

---

## 3. Quality Gates

This HU has no TypeScript source changes. No build/typecheck/lint/migration gates apply. Gates evaluated for bash script:

| Gate | Result | Evidence |
|------|--------|---------|
| Script exists | PASS | scripts/smoke-test.sh present |
| Script executable | PASS | -rwxr-xr-x confirmed |
| Shebang present | PASS | #!/usr/bin/env bash at line 1 |
| jq fallback | PASS | scripts/smoke-test.sh:21-44 |
| E2E run against production | PASS | 8 PASS / 0 FAIL / 2 SKIP |

Manual E2E evidence (target: https://wasiai-a2a-production.up.railway.app):

```
  PASS [200] GET /
  PASS [200] GET /.well-known/agent.json
  PASS [200] GET /gasless/status
  PASS [200] GET /dashboard
  PASS [200] GET /dashboard/api/stats
  PASS [201] POST /auth/agent-signup
  PASS [200] GET /auth/me
  PASS [200] GET /discover
  SKIP [---] POST /compose — requires x402 payment token
  SKIP [---] POST /orchestrate — requires x402 payment token

  Results: 8 PASS / 0 FAIL / 2 SKIP (of 10)
```

---

## 4. AR / CR follow-up

No AR or CR reports for this HU. FAST mode, S sizing — adversarial review not required per methodology.

---

## 5. Veredicto Final

**APROBADO PARA DONE**

All 14 ACs PASS with concrete evidence from live production calls. Zero production code changes (Scope OUT respected). Script is executable, correct shebang, jq fallback, BASE_URL override, x402 endpoints handled as SKIP. E2E run: 8 PASS / 0 FAIL / 2 SKIP.

Minor documentation note: AC-13 and README table say POST /discover (typo in work-item). Actual route and script both use GET /discover — behavior is correct.
