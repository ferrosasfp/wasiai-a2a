# CR Report -- #017: Reputation Scoring (WKH-28)

> Adversary + QA Agent | NexusAgil CR Phase
> Date: 2026-04-05
> Branch: `feat/017-reputation-scoring`
> Story File: `doc/sdd/017-reputation-scoring/story-file.md`
> AR Report: `doc/sdd/017-reputation-scoring/ar-report.md`

---

## Files Under Review

| File | Status |
|------|--------|
| `src/services/reputation.ts` | NEW |
| `src/services/reputation.test.ts` | NEW |
| `src/types/index.ts` | MODIFIED |
| `src/services/discovery.ts` | MODIFIED |
| `src/services/event.ts` | MODIFIED |
| `src/routes/discover.ts` | MODIFIED |
| `supabase/migrations/20260405300000_reputation_view.sql` | NEW |

---

## Check 1: Naming Consistency

Variables, functions, files, and identifiers follow project conventions.

### Findings

| ID | Severidad | Archivo | Linea | Hallazgo |
|----|-----------|---------|-------|---------|
| NC-1 | OK | `reputation.ts` | all | Naming is consistent: `reputationService` (camelCase singleton), `computeScore` / `filterByMinReputation` (camelCase functions), `SCORE_SCALE` / `MAX_LATENCY_MS` / `MAX_COST_USDC` / `MIN_INVOCATIONS` / `WEIGHTS` (UPPER_SNAKE_CASE constants). Matches project patterns seen in `eventService`, `discoveryService`. |
| NC-2 | OK | `reputation.ts` | 28-37 | Internal type `ReputationRow` uses PascalCase (consistent with `EventRow` in `event.ts`). Field names use snake_case to mirror SQL columns (`agent_slug`, `avg_latency_ms`) -- correct and intentional. |
| NC-3 | OK | `types/index.ts` | 410-422 | `ReputationScore` interface uses camelCase fields (`agentSlug`, `successRate`, `avgLatencyMs`) consistent with all other domain types in the file. |
| NC-4 | OK | `discovery.ts` | 35-50 | Variable names `slugs`, `scores`, `scoreMap`, `computed` are clear and consistent with naming style in the rest of the method. |
| NC-5 | OK | `event.ts` | 185-195 | Same enrichment pattern: `slugs`, `scores`, `scoreMap` -- mirrors discovery.ts. Intentional duplication with identical naming confirms consistency, not divergence. |
| NC-6 | OK | Migration | filename | `20260405300000_reputation_view.sql` follows the existing `YYYYMMDDNNNNNN_description.sql` pattern (e.g., `20260404200000_...`). VIEW name `v_reputation_scores` uses `v_` prefix, consistent with conventional view naming. |
| NC-7 | MENOR | `reputation.test.ts` | 16 | Import line is extremely long (exceeds 120 chars). Convention in the project is not explicitly enforced, but the line imports `SCORE_SCALE`, `MAX_LATENCY_MS`, `MAX_COST_USDC` on a single line without wrapping. Not a naming issue strictly, but a readability/style minor note. No functional impact. |

### Check 1 Summary: PASS (1 MENOR cosmetic)

---

## Check 2: Import Hygiene

Imports ordered, not duplicated, `.js` extensions for ESM.

### Findings

| ID | Severidad | Archivo | Linea | Hallazgo |
|----|-----------|---------|-------|---------|
| IH-1 | OK | `reputation.ts` | 10-11 | Correct `.js` extensions: `'../types/index.js'` and `'../lib/supabase.js'`. ESM-compliant. |
| IH-2 | OK | `reputation.ts` | 10 | `import type` used correctly for the `ReputationScore` interface (type-only import). Reduces runtime overhead. |
| IH-3 | OK | `reputation.test.ts` | 8, 15-16 | Mock with `vi.mock('../lib/supabase.js', ...)` appears BEFORE the service import on line 16. This is the required hoisting order for Vitest. Correct `.js` extension on mock path and import path. |
| IH-4 | OK | `discovery.ts` | 5-7 | Three imports, alphabetically ordered by relative path depth (`../types`, `./registry`, `./reputation`). No duplicates. All use `.js` extensions. |
| IH-5 | OK | `event.ts` | 6-8 | Three imports in consistent order (types, lib, service). All `.js` extensions. |
| IH-6 | OK | `routes/discover.ts` | 5-6 | Two imports: Fastify types and discovery service. Both use `.js`. No unused imports. |
| IH-7 | OK | `types/index.ts` | all | No imports (type-only declaration file). Not applicable. |
| IH-8 | BLOQUEANTE | `reputation.test.ts` | 16 | **Import order violation with potential mock-hoisting risk**: The import `import { reputationService, computeScore, filterByMinReputation, SCORE_SCALE, MAX_LATENCY_MS, MAX_COST_USDC } from './reputation.js'` is on line 16, after the `vi.mock` on line 8 and the supabase import on line 15. This ORDER is correct (mock before import of the module under test). **HOWEVER**, the test imports `supabase` from the mocked module (`import { supabase } from '../lib/supabase.js'` on line 15) BEFORE importing the service on line 16. This is the correct Vitest pattern and it is confirmed working by AR. **Downgrading to OK** -- the hoisting concern does not apply here since `vi.mock` is hoisted at compile time by Vitest regardless of position. |
| IH-9 | OK | `reputation.test.ts` | 16 | Re-evaluation after IH-8: import order is correct. `vi.mock` is hoisted by Vitest transform, so the declaration order is safe and matches the exemplar pattern documented in the Story File. |

### Check 2 Summary: PASS (no BLOCKERs -- IH-8 self-corrected upon analysis)

---

## Check 3: Error Handling

Appropriate try/catch, no silent swallowing without justification.

### Findings

| ID | Severidad | Archivo | Linea | Hallazgo |
|----|-----------|---------|-------|---------|
| EH-1 | OK | `reputation.ts` | 89-93 | Supabase `error` object (non-exception path) is handled: logs `[Reputation] VIEW query failed: <message>` and returns `[]`. Not silently swallowed. |
| EH-2 | OK | `reputation.ts` | 98-103 | Outer `try/catch` catches unexpected exceptions, logs `[Reputation] getScores failed: <message>` and returns `[]`. The `err instanceof Error ? err.message : err` pattern is defensive and consistent with the rest of the codebase. |
| EH-3 | OK | `discovery.ts` | 46-50 | Reputation enrichment `catch(err)` logs `[Discovery] Reputation enrichment failed, continuing: <message>`. Non-blocking per CD-4. Justification is explicit via comment. |
| EH-4 | MENOR | `event.ts` | 193-195 | `catch {}` (bare catch, no binding, no logging). The swallowing is intentional and justified by comment ("Non-blocking: dashboard continues without reputation scores"), but no `console.error` is emitted. In contrast, the equivalent block in `discovery.ts` (EH-3) DOES log the error. This inconsistency means silent failures in `event.ts` enrichment are invisible in production logs. Not a blocker (AR already flagged it as acceptable) but it is a divergence from the pattern established in the same PR. |
| EH-5 | OK | `event.ts` | 84 | `track()` throws on Supabase error (`throw new Error(...)`) -- correct, as tracking is a primary operation, not supplemental. |
| EH-6 | OK | `event.ts` | 98, 105, 118 | All three `stats()` sub-queries correctly throw on error (primary operations, not enrichment). |
| EH-7 | OK | `discovery.ts` | 25-29 | Registry query errors are caught per-registry via `.catch(err => { console.error(...); return [] })`. Non-blocking at registry level, correct. |

### Check 3 Summary: PASS (1 MENOR -- inconsistent error logging in event.ts enrichment catch)

---

## Check 4: Code Duplication

No duplicated logic between files.

### Findings

| ID | Severidad | Archivo | Linea | Hallazgo |
|----|-----------|---------|-------|---------|
| CD-1 | MENOR | `discovery.ts` + `event.ts` | 35-50, 185-195 | The reputation enrichment pattern (get slugs -> getScores -> build Map -> iterate agents -> assign score) is duplicated in both files. The logic is ~8 lines each and is structurally identical except for the field name (`agent.reputation` vs `agent.reputationScore`) and the catch behavior. For hackathon scope this is acceptable. In production, this could be extracted into a shared utility `enrichWithReputation(agents, slugField)`. Story File does NOT prescribe extraction, so this is not a deviation. |
| CD-2 | OK | `reputation.ts` | 110-115 | `filterByMinReputation` is defined ONCE in `reputation.ts` and exported. `discovery.ts` does NOT use it (it applies the filter inline via `allAgents.filter(a => ...)`), but this is intentional: the inline filter in discovery operates on `Agent.reputation` (number | undefined) while `filterByMinReputation` expects `{ reputationScore: number }`. Different types, different contexts. No duplication of logic. |
| CD-3 | OK | Formula | `reputation.ts:41-66` | Score computation logic exists only in `computeScore()`. Neither `discovery.ts` nor `event.ts` recompute scores -- they consume the results from `reputationService.getScores()`. No duplication of the formula. |
| CD-4 | OK | `Map` pattern | `discovery.ts:39`, `event.ts:189` | `new Map(scores.map(s => [s.agentSlug, s.reputationScore]))` is duplicated but is a trivial one-liner data structure construction, not complex logic. Acceptable. |

### Check 4 Summary: PASS (1 MENOR -- enrichment block structural duplication, acceptable for scope)

---

## Check 5: Type Safety

Correct types, no excessive `as any`, minimal unsafe assertions.

### Findings

| ID | Severidad | Archivo | Linea | Hallazgo |
|----|-----------|---------|-------|---------|
| TS-1 | OK | `types/index.ts` | 386-394 | `AgentSummary` correctly updated: `reputationScore?: number | null`. Optional (`?`) AND nullable (`| null`) -- mirrors Story File specification exactly. |
| TS-2 | OK | `types/index.ts` | 410-422 | `ReputationScore` interface: all fields properly typed. `reputationScore: number` (not nullable here -- it's always computed). Consistent with Story File. |
| TS-3 | OK | `reputation.ts` | 95 | `((data ?? []) as ReputationRow[])` -- the `as` assertion is justified: Supabase returns `unknown[]` from `.select('*')` on a view, and the type has been defined by `ReputationRow`. The `data ?? []` null-guards first. Pattern matches the checklist item MNR-5 from Story File. |
| TS-4 | MENOR | `reputation.ts` | 42 | `Number(row.success_rate)` -- `success_rate` is already typed as `number` in `ReputationRow`. The `Number()` cast is redundant. Supabase may return numeric columns as strings at runtime for some PostgreSQL numeric types, so the defensive cast is understandable, but the `ReputationRow` type declaration says it's `number`. This creates a minor type inconsistency: the type says `number` but the code treats it as possibly string. Either the type should be `number | string` or the cast should be removed. Does not cause a runtime error. |
| TS-5 | MENOR | `reputation.ts` | 57-58 | Same pattern: `Number(row.total_invocations)` and `Number(row.success_count)` -- both typed as `number` in `ReputationRow`. Same reasoning as TS-4. |
| TS-6 | OK | `reputation.ts` | 60-61 | `Number(row.avg_latency_ms)` and `Number(row.avg_cost_usdc)` -- these fields come from SQL `COALESCE(AVG(...)::integer, 0)` and `COALESCE(AVG(...), 0)` which Supabase may return as string for `numeric` PostgreSQL type. Defensive cast here is more justified than for `COUNT(*)` fields. |
| TS-7 | OK | `event.ts` | 181 | `reputationScore: null as number | null` -- explicit type assertion needed here because TypeScript would otherwise infer `null` narrowly without the annotation. This is the correct pattern to initialize a mutable field that will be overwritten. |
| TS-8 | OK | `discovery.ts` | 61 | `query.minReputation!` -- non-null assertion is safe here because the ternary condition on line 60 already checks `query.minReputation` is truthy. TypeScript cannot narrow it automatically in the filter callback, so `!` is the correct approach. |
| TS-9 | OK | `reputation.test.ts` | 76, 113, 123, 179 | `chain as never` -- used to satisfy `mockFrom.mockReturnValue()` type. This is a standard Vitest mocking pattern where the mock chain type does not match the Supabase builder type. Acceptable for test code. |
| TS-10 | BLOQUEANTE | `reputation.test.ts` | 49 | `mockChain` function signature: `result: { data: unknown[] | null; error: { message: string } | null }`. When `error` is `null`, the type is correct. But the actual Supabase error type has more fields beyond `message`. This is fine for test mocking purposes -- the service only accesses `error.message`, so the narrower mock type is sufficient. **Downgrading to OK** -- not a production type, test-only. |
| TS-11 | OK | `types/index.ts` | all | `tsc --noEmit` passes per AR report. No type errors in the compiled output. |
| TS-12 | MENOR | `discovery.ts` | 146 | Pre-existing issue (also flagged as MNR-3 in AR): `Number(getNestedValue(raw, mapping.reputation ?? 'reputation') ?? undefined)` produces `NaN` when the field is absent. This is NOT introduced by WKH-28 but the new sort code at line 54 uses `b.reputation ?? 0` which does NOT handle NaN correctly (`NaN ?? 0 === NaN`). The enrichment block in WKH-28 mitigates this for agents found in the VIEW, but agents NOT in the VIEW retain the pre-existing NaN issue. Out of scope for this PR. |

### Check 5 Summary: PASS (3 MENOR -- redundant Number() casts for typed fields; pre-existing NaN issue in discovery.ts)

---

## Check 6: Test Quality

Tests cover happy path, edge cases, errors; mocks are correct.

### Findings

| ID | Severidad | Archivo | Linea | Hallazgo |
|----|-----------|---------|-------|---------|
| TQ-1 | OK | `reputation.test.ts` | 73-85 | T1 (happy path): verifies correct VIEW name, result count, slug, score in 0-5 range. Sufficient coverage of the main flow. |
| TQ-2 | OK | `reputation.test.ts` | 88-108 | T2 (formula): spot-check with exact expected values. Comments show manual arithmetic for each sub-component. This is an excellent precision test. `toBeCloseTo(0.9333, 3)` is appropriate for floating-point comparison. |
| TQ-3 | OK | `reputation.test.ts` | 111-118 | T3 (empty data): returns `[]` when VIEW has no rows. |
| TQ-4 | OK | `reputation.test.ts` | 121-132 | T4 (Supabase error): verifies graceful degradation AND that `console.error` is called with the correct prefix string. Tests the error message content, not just the return value. |
| TQ-5 | OK | `reputation.test.ts` | 135-155 | T5 (scale boundaries): perfect agent = 5.0, worst agent = 0.0. Tests the mathematical extremes. |
| TQ-6 | OK | `reputation.test.ts` | 158-170 | T6 (clamping): verifies `latencyScore = 0` and `costEfficiency = 0` for extreme inputs, and that the final score correctly reflects only the success component. |
| TQ-7 | OK | `reputation.test.ts` | 173-198 | T7 (slug filtering): verifies `.in()` is called with correct arguments, verifies relative ordering of scores for two agents, verifies 0-5 range. |
| TQ-8 | OK | `reputation.test.ts` | 201-215 | T8 (`filterByMinReputation`): verifies inclusive threshold (3.0 includes score=3.0), excludes below-threshold, uses pure function with no mocks needed. |
| TQ-9 | MENOR | `reputation.test.ts` | all | No test for `getScores()` called with `slugs = undefined` (no filter). The service handles this case (line 84: `if (slugs && slugs.length > 0)` skips `.in()`), but there is no test verifying the query is called WITHOUT `.in()` when slugs is undefined. Low risk but a gap. |
| TQ-10 | MENOR | `reputation.test.ts` | all | No test for the `MIN_INVOCATIONS` filter (line 96: `.filter(row => row.total_invocations >= MIN_INVOCATIONS)`). An agent with `total_invocations: 0` should be excluded, but there is no test case for this. Edge case is simple but untested. |
| TQ-11 | OK | `reputation.test.ts` | 49-62 | `mockChain` builder correctly makes the chain thenable by using `Object.defineProperty` for `then`. This pattern correctly simulates the Supabase fluent API which is promise-like. The chain's `select` and `in` methods return `chain` itself (simulating the fluent builder). Technically correct. |
| TQ-12 | OK | `reputation.test.ts` | 67-70 | `beforeEach` correctly clears all mocks AND spies on `console.error`. This prevents test bleed-through between tests. |
| TQ-13 | MENOR | `reputation.test.ts` | all | No test for `filterByMinReputation` with an empty agents array. Trivially safe (filter on `[]` returns `[]`) but the function is exported and untested for this case. Very low risk. |
| TQ-14 | OK | `reputation.test.ts` | all | All 8 tests are independent (no shared mutable state). Each test sets up its own mock chain via `beforeEach` + `mockFrom.mockReturnValue`. Clean isolation. |
| TQ-15 | BLOQUEANTE | `reputation.test.ts` | 104 | **T2 precision assertion risk**: `expect(result.reputationScore).toBe(4.35)`. The formula computes `rawScore = 0.5 * 0.9 + 0.3 * (1 - 2000/30000) + 0.2 * (1 - 0.03/0.10)`. Let's verify: `1 - 2000/30000 = 1 - 0.06666... = 0.93333...`, `1 - 0.3 = 0.7`, `rawScore = 0.45 + 0.3 * 0.93333... + 0.14 = 0.45 + 0.28 + 0.14 = 0.87`. `0.87 * 5 = 4.35`. `toFixed(2)` on `4.35` = `"4.35"`. `Number("4.35") = 4.35`. `toBe(4.35)` should pass. **The arithmetic is correct**. **Downgrading to OK** -- the test assertion is valid. |

### Check 6 Summary: PASS (3 MENOR gaps; no BLOCKERs)

---

## Consolidated Findings Table

| ID | Severidad | Check | Archivo | Descripcion |
|----|-----------|-------|---------|-------------|
| NC-7 | MENOR | Naming | `reputation.test.ts:16` | Import line extremely long (cosmetic, no functional impact) |
| EH-4 | MENOR | Error Handling | `event.ts:193-195` | `catch {}` silently swallows enrichment errors with no log; inconsistent with `discovery.ts` EH-3 which does log |
| CD-1 | MENOR | Duplication | `discovery.ts` + `event.ts` | Enrichment pattern (slugs->getScores->Map->assign) duplicated in both files; acceptable for hackathon scope |
| TS-4 | MENOR | Type Safety | `reputation.ts:42` | `Number(row.success_rate)` redundant cast -- `ReputationRow` types it as `number` already |
| TS-5 | MENOR | Type Safety | `reputation.ts:57-58` | Same: `Number(row.total_invocations)` and `Number(row.success_count)` redundant casts |
| TS-12 | MENOR | Type Safety | `discovery.ts:146` | Pre-existing NaN issue in `mapAgent`; not introduced by WKH-28, sort does not handle NaN safely |
| TQ-9 | MENOR | Test Quality | `reputation.test.ts` | No test for `getScores(undefined)` -- no `.in()` applied path |
| TQ-10 | MENOR | Test Quality | `reputation.test.ts` | No test for `MIN_INVOCATIONS` filter -- agent with 0 invocations should be excluded |
| TQ-13 | MENOR | Test Quality | `reputation.test.ts` | No test for `filterByMinReputation([])` -- empty input edge case |

**BLOCKERs encontrados: 0**

---

## Análisis por Checklist del Story File (Anti-Hallucination)

| Item | Verificado | Resultado |
|------|-----------|-----------|
| Import paths use `.js` extension (ESM) | SI | OK |
| Mock pattern: `vi.mock('../lib/supabase.js', ...)` BEFORE import | SI | OK |
| VIEW query: `from('v_reputation_scores').select('*').in('agent_slug', slugs)` | SI | OK |
| Scale is 0-5: `rawScore * SCORE_SCALE` where `SCORE_SCALE = 5` | SI | OK |
| JOIN on slug: `scoreMap.get(agent.slug)` in discovery, `scoreMap.get(agent.agentId)` in event.ts | SI | OK |
| try/catch wrapping in getScores AND in discover() | SI | OK |
| Operation order: flat -> enrich -> sort -> filter minRep -> limit | SI | OK (`discovery.ts` lines 33→36-50→53-57→60-62→65) |
| `ReputationScore` type added with `agentSlug` (not `agentId`) | SI | OK |
| `AgentSummary` updated with `reputationScore?: number \| null` | SI | OK |
| No default exports: `export const reputationService = {...}` | SI | OK |
| `filterByMinReputation` exported | SI | OK |
| Null safety: `((data ?? []) as ReputationRow[])` | SI | OK |
| VIEW SQL: `WHERE event_type = 'compose_step' AND agent_id IS NOT NULL` | SI | OK |
| Comment fix: `(0-1)` changed to `(0-5)` in `src/routes/discover.ts` | SI | OK (line 17) |

---

## Criterios de Aceptación (Story File ACs)

| AC | Definicion | Cumplido |
|----|-----------|---------|
| AC-1 (CD-1) | Escala 0-5 correcta, formula verificada | SI |
| AC-2 (CD-2) | VIEW filtra `compose_step` y `agent_id IS NOT NULL` | SI |
| AC-3 (CD-3) | JOIN por slug consistente en ambos servicios | SI |
| AC-4 (CD-4) | Errores de reputation NUNCA rompen discovery ni dashboard | SI |
| AC-5 (CD-5) | Orden de operaciones correcto en discovery | SI |

---

## Veredicto Final

### APROBADO con MENORs

La implementacion de WKH-28 supera el Code Review sin hallazgos BLOQUEANTES.

**Resumen de hallazgos**:
- 0 BLOQUEANTES
- 9 MENORs (ninguno bloquea merge para hackathon)

**Observacion destacada** (EH-4): El `catch {}` silente en `event.ts:193-195` es la unica divergencia de patron dentro de este mismo PR -- `discovery.ts` usa `catch (err) { console.error(...) }` para el bloque equivalente. Se recomienda homogeneizar en un PR de follow-up, pero no bloquea este merge.

**Observacion de deuda tecnica** (CD-1): El patron de enriquecimiento esta duplicado. Si se agrega un tercer punto de integracion en el futuro, debe extraerse a un helper compartido.

**Tests**: 8/8 nuevos tests cubren correctamente happy path, formula exacta, edge cases, errores y filtros. 3 casos de borde menores sin cubrir (TQ-9, TQ-10, TQ-13) son de baja prioridad.

**TypeCheck**: PASS. Todos los tipos son correctos segun `tsc --noEmit`.

**SQL**: Sintaxis valida. VIEW correctamente definida.

---

*CR Report generado por NexusAgil Adversary + QA Agent*
*Date: 2026-04-05*
