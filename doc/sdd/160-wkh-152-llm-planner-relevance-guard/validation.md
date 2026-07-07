# Validation Report — WKH-152 (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-07

## Runtime checks
- No DB/migration/env-var involved (CD-4/CD-5: filtro 100% determinístico, en memoria, sin
  llamadas externas). N/A por diseño — confirmado por lectura de código (sin `supabase.from`,
  sin nuevas env vars en el diff).
- Money-path invariante (débito==ejecución) verificado por CÓDIGO, no solo por test:
  `orchestrate.ts:1080` (`const { steps, ... } = plan`) y `:1218-1219` (`composeService.compose({ steps, ... })`)
  consumen el MISMO `plan.steps` que `planOrchestration` reasigna en `:942-950` (`applyDrop`) —
  single source of truth. `plannedCostUsd` recomputado en `:944-948` (`resolveAgentPriceUsdc(step0.agent, step0.registry)`
  sobre `steps[0]` YA filtrado) fluye a `executeApprovedPlan` vía `plan.plannedCostUsd` (`:1082`) →
  `step0DebitUsd` (`:1145`) → `budgetService.debit` (`:1154`). El step dropeado no puede llegar a
  ninguno de los dos lados (ni debit ni compose) porque ambos leen del mismo array ya recortado.
- Caso conservar-todos (`applyDrop===false`): `steps`/`plannedCostUsd` quedan intactos (sin
  reasignar, `:942` `if (applyDrop)` no entra) → billing byte-idéntico a sin-filtro.

## ACs (WKH-152, MIXED-PLAN-ONLY)
| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (mixto → dropea irrelevante) | PASS | `orchestrate.test.ts:2024-2065` T-152-1: `composedSlugs` contiene `weather-v1`, NO contiene `defi-sentiment-v1`; `debit` 1×; `reasoning` contiene `'dropped'`. |
| AC-2 (mixed-plan-only, conserva todos) | PASS | `orchestrate.test.ts:2073-2126` T-152-2 (monolingüe, all-disjoint) + `:2133-2212` T-152-2b (español vs. agentes en inglés, 0 overlap): `reasoning` sin `no_relevant_agent`/`dropped`; `compose.steps` = plan original completo en orden; `debit` == precio del head original (0.4, `toBeCloseTo`); `chargeProtocolFee` llamado. |
| AC-3 (all-relevante, cero regresión) | PASS | `orchestrate.test.ts:2216-2238` T-152-3: `compose.steps` = `['summarizer-v1','translator-v1']` orden original; sin `dropped`/`no_relevant_agent`. |
| AC-4 (recompute step-0, CRÍTICO money) | PASS | `orchestrate.test.ts:2242-2283` T-152-4: step-0 original irrelevante (precio 0.7) dropeado; `debit` repriced a 0.4 (survivor `weather-v1`); `compose.steps[0].agent==='weather-v1'`, `passOutput===false`. Código: `orchestrate.ts:942-950` (recompute) + `:1082/1145/1154` (debit) + `:1218-1219` (compose) — mismo `steps` filtrado alimenta ambos. |
| AC-5 (false-negative, tokens no-obvios / goal sin tokens) | PASS | `orchestrate.test.ts:2288-2338` T-152-5 (relevancia solo por `input`, agente NO dropeado) + `:2343-2372` T-152-5b (goal `'a b c'` <3 chars, CD-14, filtro se salta, step conservado). |
| AC-6 (all-demos intacto) | PASS | `orchestrate.test.ts:2376-2420` T-152-6: `no_relevant_agent` presente, sin `'dropped'`, `pipeline.steps.length===0`, `debit`/`compose` NO llamados. |
| AC-7 (greedy intacto) | PASS | T-W5/T-W5b/T-W5c/T-W6 (pre-existentes) verdes sin modificar — corrida dirigida: 4/4 pass (`vitest -t "T-W5|T-W6"`). |
| Helper puro (DT-2) | PASS | `orchestrate.test.ts:2424-2432` T-152-8 `textOverlapsGoal`: overlap⇒true, sin-overlap⇒false, `goalTokens` vacío⇒false, case-insensitive, tokens<3 chars ignorados. |

## Números de la suite
- `npx vitest run src/services/orchestrate.test.ts src/services/orchestrate.billing.test.ts` → **103/103 PASS, 0 FAIL** (9 tests con `-t "152"` = T-152-1..8 + 2b; 4 greedy T-W5/6 verificados aparte; ~90 pre-existentes recuperados sin editar fixtures).
- `npx vitest run` (full suite) → **2788 passed | 10 skipped (2798), 0 failed**, 156 test files pass | 4 skipped. Sin regresión.
- `npx tsc --noEmit` → **0 errores** (incl. `noUncheckedIndexedAccess` en `steps[0]`).
- `./node_modules/.bin/biome check src/` → **0 issues** (312 files checked).

## Drift
`git diff --name-only`: `doc/sdd/_INDEX.md`, `src/services/orchestrate.test.ts`, `src/services/orchestrate.ts`
(+ untracked `doc/sdd/160-wkh-152-llm-planner-relevance-guard/` — docs). Scope IN 100% respetado
(work-item.md §Scope IN: solo `orchestrate.ts` + `orchestrate.test.ts`). Confirmado por `git diff`
que el prompt del LLM (`systemPrompt`/`userPrompt`), `greedyPlan` y `composeService.compose(...)`
call-sites NO tienen líneas `+`/`-` (grep dirigido, 0 matches) — CD-12 respetado. El early-return
`no_relevant_agent` (`if (allStepsAreDemos || fallbackNoRelevance)`) tampoco tiene líneas
modificadas (grep dirigido, 0 matches) — CD-15 respetado, no se le agregó un tercer disyunto.
**drift: none.**

## Gates
- typecheck/tests/build/lint: PASS (re-ejecutados directamente por QA — no se encontró
  `cr-report.md`/`ar-report.md` como archivo separado en la carpeta SDD; la revisión AR/CR quedó
  documentada inline en `sdd.md` DT-7/CD-15 y en `auto-blindaje.md` [2026-07-07 11:12] re-F3 delta,
  que registra la enmienda MIXED-PLAN-ONLY ratificada por el humano. Gates corridos por QA de forma
  independiente arriba: todos verdes, consistentes con "AR APROBADO + CR APROBADO" reportado por el
  orquestador).

## Nota de proceso (no bloqueante)
No se encontró `ar-report.md`/`cr-report.md` como archivo dedicado en
`doc/sdd/160-wkh-152-llm-planner-relevance-guard/` — el rastro de AR/CR vive embebido en
`sdd.md` (DT-7/CD-15) y `auto-blindaje.md`. No bloquea el veredicto: QA verificó código +
tests + gates de forma independiente y el resultado es 100% consistente con lo reportado.

**Listo para DONE.**
