# Validation Report — #017: Reputation Scoring (WKH-28)

> QA Agent | NexusAgil F4 (Validation Phase)
> Date: 2026-04-05
> Branch: `feat/017-reputation-scoring`
> Story File: `doc/sdd/017-reputation-scoring/story-file.md`
> AR Report: `doc/sdd/017-reputation-scoring/ar-report.md`
> CR Report: `doc/sdd/017-reputation-scoring/cr-report.md`

---

## 1. Quality Gates

| Gate | Command | Result | Detail |
|------|---------|--------|--------|
| Tests PASS | `npx vitest run` | **PASS** | 111/111 tests, 10 test files, 0 failures |
| TypeCheck PASS | `npx tsc --noEmit` | **PASS** | 0 errors, 0 warnings |
| 0 BLOCKERs in AR | — | **PASS** | 4 MENORs only (MNR-1..4), none blocking |
| 0 BLOCKERs in CR | — | **PASS** | 9 MENORs only, none blocking (IH-8, TS-10, TQ-15 self-corrected to OK) |

### Test Run Output (verbatim)

```
 RUN  v1.6.1 /home/ferdev/.openclaw/workspace/wasiai-a2a

 ✓ src/services/agent-card.test.ts  (17 tests)
 ✓ src/services/llm/transform.test.ts  (5 tests)
 ✓ src/services/reputation.test.ts  (8 tests)
 ✓ src/services/compose.test.ts  (9 tests)
 ✓ src/services/orchestrate.test.ts  (10 tests)
 ✓ src/services/task.test.ts  (21 tests)
 ✓ src/services/kite-client.test.ts  (8 tests)
 ✓ src/services/mock-registry.test.ts  (9 tests)
 ✓ src/routes/agent-card.test.ts  (4 tests)
 ✓ src/routes/tasks.test.ts  (20 tests)

 Test Files  10 passed (10)
      Tests  111 passed (111)
   Duration  752ms
```

### TypeCheck Output

```
(no output — zero errors)
```

---

## 2. Acceptance Criteria Verification

### AC-1 (CD-1): Escala 0-5, formula verificada

| Item | Evidence | Status |
|------|----------|--------|
| `SCORE_SCALE = 5` exported constant | `src/services/reputation.ts:15` | OK |
| `reputationScore = Number((rawScore * SCORE_SCALE).toFixed(2))` | `src/services/reputation.ts:51` | OK |
| Weights sum to 1.0: `0.50 + 0.30 + 0.20 = 1.00` | `src/services/reputation.ts:20-24` | OK |
| `latencyScore = 1 - Math.min(avg_latency_ms / 30000, 1)` — clamped [0,1] | `src/services/reputation.ts:43` | OK |
| `costEfficiency = 1 - Math.min(avg_cost_usdc / 0.10, 1)` — clamped [0,1] | `src/services/reputation.ts:44` | OK |
| T2 spot-check: docusynth (9/10 success, 2000ms, $0.03) → 4.35 | `src/services/reputation.test.ts:88-108` | PASS |
| T5: perfect agent = 5.0, worst agent = 0.0 | `src/services/reputation.test.ts:135-155` | PASS |
| T6: clamping beyond max latency/cost — only success_rate contributes (2.50) | `src/services/reputation.test.ts:157-170` | PASS |
| `ReputationScore.reputationScore: number  // 0-5 scale (CD-1)` | `src/types/index.ts:421` | OK |

**Verdict: AC-1 SATISFIED**

---

### AC-2 (CD-2): VIEW filtra compose_step y agent_id IS NOT NULL

| Item | Evidence | Status |
|------|----------|--------|
| `WHERE event_type = 'compose_step'` | `supabase/migrations/20260405300000_reputation_view.sql:21` | OK |
| `AND agent_id IS NOT NULL` | `supabase/migrations/20260405300000_reputation_view.sql:22` | OK |
| No user input interpolated into SQL — `WHERE` clauses are hardcoded | `supabase/migrations/20260405300000_reputation_view.sql:6-23` | OK |
| Supabase `.in('agent_slug', slugs)` used for runtime filtering (parameterized) | `src/services/reputation.ts:85` | OK |

**Verdict: AC-2 SATISFIED**

---

### AC-3 (CD-3): JOIN por slug consistente

| Item | Evidence | Status |
|------|----------|--------|
| VIEW aliases `agent_id` as `agent_slug` (SQL column stores slug) | `supabase/migrations/20260405300000_reputation_view.sql:8` |  OK |
| `ReputationRow.agent_slug` matches VIEW alias | `src/services/reputation.ts:29` | OK |
| `computeScore` maps `row.agent_slug` to `ReputationScore.agentSlug` | `src/services/reputation.ts:54` | OK |
| `discovery.ts`: JOIN via `scoreMap.get(agent.slug)` — uses agent.slug | `src/services/discovery.ts:41` | OK |
| `event.ts`: JOIN via `scoreMap.get(agent.agentId)` — uses agentId which stores slug (CD-3 comment present) | `src/services/event.ts:187,191` | OK |
| `reputationService.getScores(slugs)` filters VIEW by `agent_slug` | `src/services/reputation.ts:85` | OK |

**Verdict: AC-3 SATISFIED**

---

### AC-4 (CD-4): Errores NUNCA rompen discovery ni dashboard

| Item | Evidence | Status |
|------|----------|--------|
| `getScores()` inner Supabase error path: returns `[]` + `console.error` | `src/services/reputation.ts:90-93` | OK |
| `getScores()` outer `try/catch`: returns `[]` on any unexpected exception | `src/services/reputation.ts:98-104` | OK |
| `discovery.ts` wraps enrichment in `try/catch` with explicit CD-4 comment | `src/services/discovery.ts:36-50` | OK |
| `event.ts` wraps enrichment in `try/catch` — dashboard continues | `src/services/event.ts:186-195` | OK |
| T4: Supabase error returns `[]` and logs `[Reputation] VIEW query failed:` | `src/services/reputation.test.ts:121-132` | PASS |

**Verdict: AC-4 SATISFIED**

---

### AC-5 (CD-5): Orden de operaciones correcto en discovery

| Item | Evidence (line in discovery.ts) | Status |
|------|---------|--------|
| Step 1: `results.flat()` — merge all registry results | `src/services/discovery.ts:33` | OK |
| Step 2: reputation enrichment (try/catch block) | `src/services/discovery.ts:35-50` | OK |
| Step 3: `allAgents.sort(...)` — sort by reputation desc, price asc | `src/services/discovery.ts:52-57` | OK |
| Step 4: `minReputation` filter applied AFTER sort | `src/services/discovery.ts:59-62` | OK |
| Step 5: `limit` applied AFTER minReputation filter | `src/services/discovery.ts:64-65` | OK |
| `total: filtered.length` — total reflects post-filter count | `src/services/discovery.ts:69` | OK |
| Prescribed order (Story File Anti-Hallucination): `flat -> enrich -> sort -> filter minRep -> limit` | matches steps 1-5 above | OK |

**Verdict: AC-5 SATISFIED**

---

## 3. AC Summary Table

| AC | Definition | Files | Evidence | Status |
|----|-----------|-------|----------|--------|
| AC-1 (CD-1) | 0-5 scale, formula verified | `reputation.ts:15,43-51` | T2 (4.35), T5 (0.0–5.0), T6 (clamping) | **PASS** |
| AC-2 (CD-2) | VIEW filters `compose_step` + `agent_id IS NOT NULL` | `20260405300000_reputation_view.sql:21-22` | SQL literals, no user input interpolated | **PASS** |
| AC-3 (CD-3) | JOIN by slug consistent | `reputation.ts:29,54` `discovery.ts:41` `event.ts:187,191` | VIEW alias `agent_slug`, scoreMap keyed by slug | **PASS** |
| AC-4 (CD-4) | Errors never break discovery or dashboard | `reputation.ts:90-104` `discovery.ts:36-50` `event.ts:186-195` | T4 (error → []), try/catch in both services | **PASS** |
| AC-5 (CD-5) | Correct operation order in discovery | `discovery.ts:33-65` | flat→enrich→sort→filter→limit | **PASS** |

---

## 4. Drift Detection

Comparison of implemented files vs Story File prescriptions (wave by wave).

### W0.1 — Migration File

| Story File Prescription | Implemented | Drift |
|------------------------|-------------|-------|
| `CREATE OR REPLACE VIEW v_reputation_scores AS` | `supabase/migrations/20260405300000_reputation_view.sql:6` | NONE |
| `agent_id AS agent_slug` | `sql:8` | NONE |
| `WHERE event_type = 'compose_step' AND agent_id IS NOT NULL` | `sql:21-22` | NONE |
| `GROUP BY agent_id` | `sql:23` | NONE |
| All SELECT columns match spec | `sql:8-19` | NONE |

### W0.2 — Types Update

| Story File Prescription | Implemented | Drift |
|------------------------|-------------|-------|
| `ReputationScore` interface with all specified fields | `src/types/index.ts:410-422` | NONE |
| `reputationScore: number  // 0-5 scale (CD-1)` | `types/index.ts:421` | NONE |
| `AgentSummary.reputationScore?: number \| null  // WKH-28` | `types/index.ts:393` | NONE |

### W1.1 — Test File

| Story File Prescription | Implemented | Drift |
|------------------------|-------------|-------|
| `vi.mock('../lib/supabase.js', ...)` before service import | `reputation.test.ts:8-12` | NONE |
| All 8 tests (T1-T8) present with prescribed assertions | `reputation.test.ts:66-216` | NONE |
| `mockChain` builder with thenable chain | `reputation.test.ts:49-62` | NONE |
| `beforeEach(() => vi.clearAllMocks())` + console.error spy | `reputation.test.ts:67-70` | NONE |

### W1.2 — Service File

| Story File Prescription | Implemented | Drift |
|------------------------|-------------|-------|
| `SCORE_SCALE = 5`, `MAX_LATENCY_MS = 30_000`, `MAX_COST_USDC = 0.10`, `MIN_INVOCATIONS = 1` | `reputation.ts:15-18` | NONE |
| `WEIGHTS = { SUCCESS: 0.50, LATENCY: 0.30, COST: 0.20 }` | `reputation.ts:20-24` | NONE |
| `computeScore(row: ReputationRow): ReputationScore` — exported pure function | `reputation.ts:41-66` | NONE |
| `reputationService.getScores(slugs?: string[]): Promise<ReputationScore[]>` | `reputation.ts:78-105` | NONE |
| `export const reputationService` (no default export) | `reputation.ts:70` | NONE |
| `filterByMinReputation<T>` exported | `reputation.ts:110-115` | NONE |
| Null safety: `((data ?? []) as ReputationRow[])` | `reputation.ts:95` | NONE |

### W2.1 — Discovery Service

| Story File Prescription | Implemented | Drift |
|------------------------|-------------|-------|
| Import `reputationService` from `'./reputation.js'` | `discovery.ts:7` | NONE |
| Enrichment block between `results.flat()` and sort | `discovery.ts:33-57` | NONE |
| `minReputation` filter using `filtered` variable | `discovery.ts:59-62` | NONE |
| `limited = query.limit ? filtered.slice(0, query.limit) : filtered` | `discovery.ts:65` | NONE |
| `total: filtered.length` | `discovery.ts:69` | NONE |

### W2.2 — Event Service

| Story File Prescription | Implemented | Drift |
|------------------------|-------------|-------|
| Import `reputationService` from `'./reputation.js'` | `event.ts:8` | NONE |
| `reputationScore: null as number \| null` in agents array | `event.ts:181` | NONE |
| Enrichment block using `agentId` as slug key (CD-3 comment) | `event.ts:185-195` | NONE |

### W2.3 — Route Comment Fix

| Story File Prescription | Implemented | Drift |
|------------------------|-------------|-------|
| `- minReputation: minimum reputation score (0-5)` (changed from 0-1) | `discover.ts:17` | NONE |

### Drift Summary

**No drift detected.** All 7 files implement exactly what the Story File prescribes. The Anti-Hallucination Checklist items are all satisfied:

| Checklist Item | Result |
|----------------|--------|
| `.js` extension in all imports | OK |
| `vi.mock` before service import | OK |
| VIEW query: `from('v_reputation_scores').select('*').in('agent_slug', slugs)` | OK |
| Scale 0-5: `rawScore * SCORE_SCALE` where `SCORE_SCALE = 5` | OK |
| JOIN on slug: `scoreMap.get(agent.slug)` in discovery, `scoreMap.get(agent.agentId)` in event | OK |
| `try/catch` in `getScores()` AND in `discover()` | OK |
| Operation order: flat -> enrich -> sort -> filter -> limit | OK |
| `ReputationScore` type with `agentSlug` (not `agentId`) | OK |
| `AgentSummary` with `reputationScore?: number \| null` | OK |
| No default exports: `export const reputationService` | OK |
| `filterByMinReputation` exported | OK |
| Null safety: `((data ?? []) as ReputationRow[])` | OK |
| VIEW SQL with correct WHERE clause | OK |
| Comment fix `(0-1)` → `(0-5)` in discover.ts | OK |

---

## 5. Open Findings from AR + CR (for traceability)

All findings are MENOR — none blocking. Listed here for record.

| ID | Severity | Source | Description |
|----|----------|--------|-------------|
| MNR-1 | MENOR | AR | `getScores([])` with empty slugs fetches all VIEW rows (no early return) |
| MNR-2 | MENOR | AR | No `event_type` index on `a2a_events` for VIEW optimization |
| MNR-3 | MENOR | AR | Pre-existing `Number(undefined)` → NaN in `mapAgent` (not introduced by WKH-28) |
| MNR-4 | MENOR | AR | No integration tests for discovery/event enrichment paths |
| NC-7 | MENOR | CR | Import line in `reputation.test.ts:16` exceeds 120 chars (cosmetic) |
| EH-4 | MENOR | CR | `catch {}` in `event.ts:193-195` silently swallows enrichment errors (no `console.error`); inconsistent with `discovery.ts` which does log |
| CD-1 | MENOR | CR | Enrichment pattern duplicated in discovery + event; acceptable for hackathon scope |
| TS-4/5 | MENOR | CR | Redundant `Number()` casts on fields already typed as `number` in `ReputationRow` |
| TS-12 | MENOR | CR | Pre-existing NaN issue in `mapAgent` (not introduced by WKH-28) |
| TQ-9 | MENOR | CR | No test for `getScores(undefined)` — no `.in()` path |
| TQ-10 | MENOR | CR | No test for `MIN_INVOCATIONS` filter (agent with 0 invocations) |
| TQ-13 | MENOR | CR | No test for `filterByMinReputation([])` — empty input edge case |

**Total BLOCKERs: 0**

---

## 6. Final Verdict

### APPROVED — READY TO MERGE

| Quality Gate | Result |
|-------------|--------|
| `npx vitest run` | **111/111 PASS** |
| `npx tsc --noEmit` | **0 errors** |
| All 5 ACs verified with file:line evidence | **PASS** |
| Drift vs Story File | **NONE** |
| BLOCKERs in AR Report | **0** |
| BLOCKERs in CR Report | **0** |

The implementation of WKH-28 (Reputation Scoring) is complete and correct. All Acceptance Criteria are satisfied with direct evidence from the implemented files. Tests pass without regression (111 total, 8 new for reputation). TypeScript compiles cleanly. No drift from the Story File contract was detected across all 7 files. The 12 MENOR findings across AR and CR are acceptable for hackathon scope and do not block merge.

**Recommended follow-up (non-blocking):**
1. Add early return `if (slugs && slugs.length === 0) return []` in `reputation.ts` to fix MNR-1.
2. Add `console.error` in `event.ts:193-195` bare catch to homogenize error logging (EH-4).
3. Add composite index `(event_type, agent_id)` on `a2a_events` before production load (MNR-2).

---

*Validation Report generated by NexusAgil QA Agent (F4)*
*Date: 2026-04-05*
*Model: claude-sonnet-4-6*
