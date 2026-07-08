# AR Report — WKH-166 (LLM plan authoritative — backstop léxico removido)

**Fecha:** 2026-07-09 · **Modo:** AR adversarial, READ-ONLY, money-path · **Branch:** `fix/165-wkh-166-llm-plan-authoritative`
**Gate (re-ejecutado por AR):** tsc 0 · biome 0 · vitest 2805 passed / 0 failed · orchestrate.test 106/106.

## Veredicto: APROBADO (0 BLOQUEANTES, 0 MENORES)

La remoción del backstop léxico es quirúrgica: elimina superficie de riesgo, no la introduce.

## Vectores (evidencia archivo:línea)
- **#1 MONEY (débito==ejecución) — OK.** `plannedCostUsd` init 0 (`:650`), seteado UNA vez en las 3 ramas (`:714` all-invalid, `:761` LLM=step0Price, `:774` LLM-failed). El bloque eliminado `if(applyDrop){steps=…;plannedCostUsd=…}` era la única reasignación de `steps` post-`:767` → sin él, `steps` nunca se muta después → `plannedCostUsd` nunca stale. Recompute final (`:950-969`) itera el plan completo. T-152-4 aserta débito 0.7 = step-0 original del LLM (correcto, sin reprice). Sin double/under/over-charge.
- **#2 dead-code/dangling — OK.** grep `llmGoalTokens|llmFilterApplies|relevantSteps|applyDrop|llmDropped` = 0 refs. `textOverlapsGoal` viva+exportada (`:372`, T-152-8), `tokenizeForRelevance` usada por fallbackNoRelevance. tsc0+biome0.
- **#3 greedy/early-return — OK.** El hunk de `greedyPlan` toca solo comentarios; cuerpo byte-idéntico. `allStepsAreDemos`/`fallbackNoRelevance` intactos. nonsense→no_relevant_agent, LLM-falla→greedy igual.
- **#4 never-empty + multilingüe — OK.** Sin drop el plan LLM no se vacía por construcción; early-return exclusivo de greedy/all-demos.
- **#5 3 tests reescritos asertan conducta REAL — OK.** T-152-1 ([weather,defi], 0.4), T-152-4 (0.7 original), T-163-4 (3 steps). Verificado contra precios mockeados, no "ajustados para pasar".
- **#6 preservados verdes por mecanismo — OK.** Todos `not.toContain('dropped')`.

## 11 categorías: 1-8 OK, 9-11 N/A.
## Nota (no bloqueante): el cambio expande la superficie de over-charge (el caller paga el plan LLM completo aunque incluya un agente poco relevante) — decisión intencional de WKH-166; la mitigación (smart-drop semántico) es WKH-160 (embeddings), recomendable no dejarlo sin fecha en el money-path prod.
