# AR Report -- #017: Reputation Scoring (WKH-28)

> Adversary Agent | NexusAgil AR Phase
> Date: 2026-04-05
> Branch: `feat/017-reputation-scoring`

---

## Verification Summary

| Check              | Result |
|--------------------|--------|
| `npx vitest run`   | 10 files, 111 tests, ALL PASSED (8 reputation-specific) |
| `npx tsc --noEmit` | PASS (zero errors) |
| SQL migration syntax | Valid PostgreSQL (`CREATE OR REPLACE VIEW`) |

---

## Category 1: Security

### OK

- **SQL injection in VIEW**: The VIEW uses `CREATE OR REPLACE VIEW` with hardcoded `WHERE` clauses. No user input is interpolated into the SQL. The Supabase client uses parameterized `.in('agent_slug', slugs)` which is safe against injection.
- **Information exposure**: The `ReputationScore` type exposes `successRate`, `latencyScore`, `costEfficiency`, and `reputationScore`. All are computed aggregates -- no PII or sensitive data leaked. The VIEW only reads from `a2a_events` which is already an internal table.
- **Input validation on route**: `minReputation` is parsed via `parseFloat()`. If input is non-numeric (e.g., `"abc"`), `parseFloat` returns `NaN`, which is falsy, so the filter is safely skipped. No injection vector.

---

## Category 2: Error Handling

### OK

- **`getScores()` fails gracefully**: Double layer of error handling -- (1) Supabase error check returns `[]` with `console.error`, (2) outer `try/catch` returns `[]` for unexpected exceptions. Verified by T4.
- **Discovery continues if reputation fails**: `discovery.ts` lines 36-50 wrap enrichment in `try/catch` with `console.error` and continues. Confirmed (CD-4).
- **Event stats continues if reputation fails**: `event.ts` lines 186-195 use bare `catch {}` -- dashboard continues without reputation scores. Non-blocking.

---

## Category 3: Data Integrity

### OK

- **Formula correctness**: Verified manually and via T2.
  - `successRate` = from VIEW `success_rate` (numeric division in SQL)
  - `latencyScore` = `1 - min(avg_latency_ms / 30000, 1)` -- clamped [0,1]
  - `costEfficiency` = `1 - min(avg_cost_usdc / 0.10, 1)` -- clamped [0,1]
  - `rawScore` = `0.50*successRate + 0.30*latencyScore + 0.20*costEfficiency` -- weights sum to 1.0
  - `reputationScore` = `rawScore * 5`, rounded via `toFixed(2)` -- scale [0, 5]
- **0-5 scale consistency**: Verified by T5 (perfect=5.0, worst=0.0) and T6 (clamping beyond boundaries).
- **Floating-point safety**: `toFixed(2)` on the final score prevents precision artifacts. Intermediate values (`latencyScore`, `costEfficiency`) are NOT rounded -- acceptable since they are informational sub-components.
- **VIEW aggregation**: `WHERE event_type = 'compose_step' AND agent_id IS NOT NULL` correctly excludes orchestrate events and null agents (CD-2).

---

## Category 4: Performance

### MENOR -- MNR-1: `getScores([])` fetches ALL VIEW rows unnecessarily

**File**: `src/services/reputation.ts`, line 84
**Issue**: When `discovery.ts` calls `getScores(slugs)` and `allAgents` is empty (no agents found), `slugs` is `[]`. The condition `slugs && slugs.length > 0` is `false`, so the `.in()` filter is NOT applied, causing a `SELECT * FROM v_reputation_scores` that fetches ALL rows.

**Impact**: Wasteful DB query when discovery returns zero agents. For hackathon scale this is negligible (few rows), but in production with many agents it would be a full table scan on the VIEW.

**Suggested fix**: Add early return `if (slugs && slugs.length === 0) return []` before the query.

### MENOR -- MNR-2: VIEW over `a2a_events` without dedicated index for `event_type`

**File**: `supabase/migrations/20260405300000_reputation_view.sql`
**Issue**: The VIEW filters `WHERE event_type = 'compose_step'`. The existing `a2a_events` table (migration `20260404200000`) has indexes on `created_at`, `agent_id`, and `status`, but NOT on `event_type`. For hackathon scale this is fine since the VIEW is a simple sequential scan, but a composite index `(event_type, agent_id)` would help at scale.

**Impact**: Acceptable for hackathon. No action required now.

---

## Category 5: Integration

### OK

- **`discovery.ts` changes backward-compatible**: The reputation enrichment block (lines 35-50) only ADDS data to existing `agent.reputation` field (which already existed in the `Agent` type with `reputation?: number`). The `minReputation` filter (lines 59-62) uses the existing `DiscoveryQuery.minReputation` field. The sort order was already `reputation desc, price asc` pre-WKH-28.
- **`event.ts` changes backward-compatible**: The `AgentSummary` type was updated to add `reputationScore?: number | null` (optional). The enrichment block (lines 185-195) sets it to `null` by default, so existing consumers that don't read `reputationScore` are unaffected.
- **Operation order correct**: `flat -> enrich -> sort -> filter minRep -> limit` (CD-5 verified).
- **All 111 existing tests still pass**: No regressions introduced.

---

## Category 6: Type Safety

### OK

- **`ReputationScore` interface**: All fields properly typed. `agentSlug: string`, `reputationScore: number`. Used consistently.
- **`AgentSummary` updated**: `reputationScore?: number | null` -- correctly optional AND nullable.
- **Null safety in `computeScore`**: `row.agent_name ?? row.agent_slug` and `row.registry ?? 'unknown'` handle null VIEW columns.
- **Null safety in `getScores`**: `(data ?? []) as ReputationRow[]` prevents null data iteration (MNR-5).
- **`tsc --noEmit` passes**: Zero type errors.

### MENOR -- MNR-3: Pre-existing `Number(... ?? undefined)` produces NaN in `mapAgent`

**File**: `src/services/discovery.ts`, line 146
**Code**: `reputation: Number(getNestedValue(raw, mapping.reputation ?? 'reputation') ?? undefined)`
**Issue**: `Number(undefined)` yields `NaN`. This sets `agent.reputation = NaN` for agents without a `reputation` field in their registry API response.

**Impact**: This is a PRE-EXISTING issue, NOT introduced by WKH-28. The WKH-28 enrichment block (lines 41-44) overwrites `agent.reputation` with the computed value, effectively masking this `NaN`. For agents NOT found in the VIEW, the original `NaN` from `mapAgent` persists, but the sort uses `(b.reputation ?? 0)` which does NOT catch `NaN` (`NaN ?? 0` === `NaN`, `NaN - NaN` === `NaN`). However, `Array.sort` with NaN comparisons pushes those elements to unpredictable positions -- still, this is pre-existing behavior unchanged by WKH-28.

**Recommendation**: Out of scope for this PR, but worth logging as tech debt.

---

## Category 7: Test Coverage

### OK

- **T1**: Happy path -- getScores returns scores in 0-5 range, queries correct VIEW name.
- **T2**: Formula spot-check -- exact expected values for docusynth example.
- **T3**: Empty VIEW -- returns empty array.
- **T4**: Supabase error -- returns empty array, logs error.
- **T5**: Scale boundaries -- perfect agent = 5.0, worst agent = 0.0.
- **T6**: Clamping -- latency > 30s and cost > $0.10 clamp to 0.
- **T7**: Slug filtering -- `.in()` called with correct args, multi-agent ordering.
- **T8**: `filterByMinReputation` -- threshold filtering logic.

### MENOR -- MNR-4: No integration tests for discovery/event enrichment paths

**Issue**: Tests T1-T8 cover the reputation service in isolation, but there are no tests for:
- `discovery.ts` reputation enrichment (the `try/catch` block at lines 36-50)
- `event.ts` reputation enrichment (the `try/catch` block at lines 186-195)
- The `minReputation` filter in `discovery.ts` (lines 60-62)

**Impact**: For hackathon scope, the unit tests for `reputation.ts` are sufficient. The integration paths are simple (fetch scores, build map, enrich) and wrapped in try/catch. The Story File did not specify integration tests for these paths.

---

## Category 8: Scope Drift

### OK

- **Files modified match Story File**: Exactly 7 files as listed:
  - `src/services/reputation.ts` (NEW) -- matches W1.2
  - `src/services/reputation.test.ts` (NEW) -- matches W1.1
  - `src/types/index.ts` (MODIFIED) -- matches W0.2
  - `src/services/discovery.ts` (MODIFIED) -- matches W2.1
  - `src/services/event.ts` (MODIFIED) -- matches W2.2
  - `src/routes/discover.ts` (MODIFIED) -- matches W2.3
  - `supabase/migrations/20260405300000_reputation_view.sql` (NEW) -- matches W0.1
- **No extra files created**: No unexpected additions.
- **No changes beyond scope**: Each modification matches the Story File instructions precisely. The comment fix `(0-1)` to `(0-5)` in `discover.ts` is applied.
- **Anti-hallucination checklist items verified**:
  - Import paths use `.js` extension: YES
  - Mock pattern matches exemplar: YES
  - VIEW query via Supabase `from().select().in()`: YES
  - Scale is 0-5: YES
  - JOIN on slug: YES (`scoreMap.get(agent.slug)` in discovery, `scoreMap.get(agent.agentId)` in event)
  - try/catch wrapping: YES (both service and integration points)
  - Operation order: flat -> enrich -> sort -> filter -> limit: YES
  - No default exports: YES (`export const reputationService`)
  - `filterByMinReputation` exported: YES
  - Null safety `(data ?? [])`: YES
  - VIEW SQL filters: YES
  - Comment fix: YES

---

## Findings Summary

| ID    | Severity   | Category    | Description |
|-------|------------|-------------|-------------|
| MNR-1 | MENOR     | Performance | `getScores([])` fetches ALL VIEW rows when slugs array is empty |
| MNR-2 | MENOR     | Performance | No `event_type` index on `a2a_events` for VIEW optimization |
| MNR-3 | MENOR     | Type Safety | Pre-existing `Number(undefined)` -> NaN in `mapAgent` (NOT introduced by WKH-28) |
| MNR-4 | MENOR     | Test Coverage | No integration tests for discovery/event enrichment paths |

---

## Veredicto Final

### APROBADO con MENORs

La implementacion de WKH-28 cumple con todos los Acceptance Criteria del Story File:
- **AC-1 (CD-1)**: Escala 0-5 correcta, formula verificada.
- **AC-2 (CD-2)**: VIEW filtra `compose_step` y `agent_id IS NOT NULL`.
- **AC-3 (CD-3)**: JOIN por slug consistente.
- **AC-4 (CD-4)**: Errores de reputation NUNCA rompen discovery ni dashboard.
- **AC-5 (CD-5)**: Orden de operaciones correcto en discovery.

Los 4 hallazgos MENORs son aceptables para hackathon y no bloquean el merge. Ningun hallazgo BLOQUEANTE encontrado.

**Tests**: 111/111 PASS (8 nuevos para reputation).
**TypeCheck**: PASS (0 errores).
**SQL**: Sintaxis valida.

---

*AR Report generated by NexusAgil Adversary Agent*
*Date: 2026-04-05*
