# Validation Report — WKH-163 (cashout-matcher relevance fix) (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-08
**Branch**: fix/164-wkh-163-cashout-matcher-relevance-fix (working tree, sin commits aún sobre `main`)

## Nota de proceso
No existen `cr-report.md` ni `ar-report.md` en `doc/sdd/164-wkh-163-cashout-matcher-relevance-fix/`
(solo `work-item.md`, `sdd.md`, `story-HU-163.md`). Excepción aplicada: corrí los 4 gates yo mismo
(tsc/lint/build/test) en lugar de leerlos de un CR report inexistente.

## ACs (8/8 PASS)

| AC | Status | Evidencia (test) | Evidencia (código) |
|----|--------|-------------------|---------------------|
| AC-1 (goal EN insignia → 3 steps intactos) | PASS | `orchestrate.test.ts:2616-2644` T-163-1: `composedSlugs` contiene los 3 slugs, `reasoning` sin `dropped`/`no_relevant_agent`, debit=0.5 (kyc, head original) | `orchestrate.ts:857-859` (`llmGoalTokens` excluye `/^\d+$/`), `:893-894` (gate usa `llmGoalTokens.size`), `:904` (filtro usa `llmGoalTokens`) |
| AC-2 (goal ES insignia → 3 steps intactos) | PASS | `orchestrate.test.ts:2648-2676` T-163-2: mismo fixture, goal `"Enviar 400 dolares a mi mama en Peru"`, mismos 3 slugs, debit=0.5 | mismo bloque `:857-904` (goal-side, no depende de idioma del agente) |
| AC-3 (multilingüe all-disjoint → sigue `ready`) | PASS | `orchestrate.test.ts:2230-2309` T-152-2b: goal `"cotiza el clima y el precio del dolar"` vs agentes EN → `reasoning` sin `no_relevant_agent`/`dropped`, debit=0.4 (byte-idéntico) | `orchestrate.ts:928-935` (CD-15: `applyDrop` requiere `relevantSteps.length>0`) — bloque NO tocado por esta HU (DT-3) |
| AC-4 (nonsense/sin agente real → `no_relevant_agent`) | PASS | `orchestrate.test.ts:2473-2517` T-152-6 (all-demo, `pipeline.steps` length 0, sin debit/compose); `orchestrate.test.ts:1882-1914` T-W5 (nonsense `"asdfqwerty12345"` + greedy fallback → `no_relevant_agent`, sin charge) | `orchestrate.ts:908-935` (early-return exclusivo de `allStepsAreDemos`/`fallbackNoRelevance`), byte-idéntico (CD-3/CD-12) |
| AC-5 (nunca `steps:[]` por el backstop) | PASS | `orchestrate.test.ts:2170-2223` T-152-2 (all-disjoint → conserva ambos, no vacía) + T-152-2b arriba | `orchestrate.ts:931-935` (`applyDrop` false si `relevantSteps.length===0`) |
| AC-6 (drop del caso mixto GENUINO sigue vivo) | PASS | `orchestrate.test.ts:2121-2162` T-152-1 (`defi-sentiment-v1` sigue dropeado, `llmDropped=1<2` no rescatado por terminal-guard); `orchestrate.test.ts:2339-2380` T-152-4 (recompute step-0/plannedCostUsd sobre el sobreviviente: debit repriced 0.7→0.4) | `orchestrate.ts:911-927` (terminal-guard exige `droppedCount>=2`, T-152-1 tiene 1 → no aplica); `:1016-1023` (recompute reusado sin cambios) |
| AC-7 (débito == ejecución) | PASS | `orchestrate.test.ts:2616-2644` T-163-1 y `:2752-2808` T-163-4 (debit called exactly once, monto = precio del step-0 final; steps dropeados nunca aparecen en `composeCall.steps`) | `orchestrate.ts:851-935` (filtro corre dentro de `planOrchestration`, `:1154` `const { steps } = plan`) ANTES de `budgetService.debit` (`:1228`) y `composeService.compose` (`:1292`) — funciones distintas, orden de llamada confirmado en el mismo archivo |
| AC-8 (determinístico, sin LLM/red) | PASS | Los 4 tests T-163-* corren con `setLlmResponse` mockeado UNA sola vez por test (ningún mock de red adicional invocado por el guard) | `orchestrate.ts:857-859` (regex puro `/^\d+$/`) y `:907-927` (terminal-guard: solo `Array.filter`/`.includes`, sin `await`) |

## Drift
**SIN DRIFT.** `git diff main -- src/services/orchestrate.ts` = 31 insertions/2 deletions, 100% confinado a
`:849-927` (exactamente el bloque `llmGoalTokens` + gate + filtro + terminal-guard descrito en SDD §2
DT-1/DT-2 y Waves W1/W2). `tokenizeForRelevance`, `textOverlapsGoal`, `goalTokens`, `fallbackNoRelevance`,
la condición del early-return (`:908`) y el recompute de billing (`:1016-1023`) NO tocados — confirmado
por lectura directa y por los 9 tests T-152-* (1,2,2b,3,4,5,5b,6,8) reconciliados en el SDD §6.2, todos
verdes SIN edición (`orchestrate.test.ts:2121-2528`). `doc/sdd/_INDEX.md` solo agrega las filas 163/164
(esperado). Scope IN del work-item = `orchestrate.ts`/`orchestrate.test.ts` — coincide 1:1 con
`git diff main --name-only` (más `_INDEX.md`, documentación de tracking, no código).

## Gates (ejecutados por QA — no había CR report que confirmar)
- `npx tsc --noEmit` → 0 errores
- `npm run lint` (biome check src/) → "Checked 312 files in 107ms. No fixes applied." → 0 issues
- `npm run build` (tsc -p tsconfig.build.json) → exit 0
- `npx vitest run src/services/orchestrate.test.ts` → PASS (106) FAIL (0), incluye T-163-1..4 + los 9 T-152-*
- `npx vitest run src/services/orchestrate.billing.test.ts` → PASS (13) FAIL (0)
- `npx vitest run` (suite full) → PASS (2805) FAIL (0)

## AR/CR follow-up
No hay `ar-report.md`/`cr-report.md` en el directorio de la HU — AR/CR no dejaron artefacto escrito.
QA no puede confirmar hallazgos previos porque no existen; se marca como **hallazgo de proceso** (no de
producto): recomendar a Docs/orquestador registrar en el done-report que las fases AR/CR de este ciclo
no generaron reporte en disco, aunque el código final es consistente con el SDD y todos los gates están
verdes.

**Listo para DONE** (contenido técnico). Escalar la ausencia de ar-report.md/cr-report.md al orquestador
como nota de proceso, no como bloqueante de producto.
