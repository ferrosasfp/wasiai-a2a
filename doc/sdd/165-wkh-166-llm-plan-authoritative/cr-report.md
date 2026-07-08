# CR Report — WKH-166 (LLM plan authoritative)

**Fecha:** 2026-07-09 · **Modo:** CR (calidad), READ-ONLY · **Branch:** `fix/165-wkh-166-llm-plan-authoritative`
**Verificación:** tsc 0 · biome 0 · orchestrate.test 106/106.

## Veredicto: APROBADO con NITs (0 bloqueantes; el NIT foldeado en fix-pack)

## Por dimensión (evidencia archivo:línea)
1. **Remoción limpia — OK.** grep de identificadores muertos (llmGoalTokens/relevantSteps/applyDrop/llmDropped/llmFilterApplies) en orchestrate.ts = 0 hits. `goalTokens` vivo, consumido por fallbackNoRelevance (`:848,:860`). Comentarios de diseño actualizados (`:349-353` plan LLM autoritativo; `:842-847` fallbackNoRelevance único guard greedy-only).
2. **Helpers inertes — OK.** `textOverlapsGoal` con JSDoc claro (`:369-370`, "INERTE desde WKH-166, hook para WKH-160"), sigue export (`:372`) + T-152-8. Un mantenedor no la borra.
3. **3 tests reescritos — OK.** T-152-1 (`[weather,defi]`, 0.4, not dropped), T-152-4 (0.7 sin reprice, passOutput false), T-163-4 (3 steps conservados). Títulos+asserts coherentes con la conducta nueva, no vacuos.
4. **Billing — OK.** `plannedCostUsd` un solo setter por rama (`:714`/`:761`/`:774`); el recompute post-drop removido limpio, sin doble-setter ni reindex.
5. **Scope — OK.** Solo orchestrate.ts + su test + _INDEX.

## NIT (foldeado post-CR en fix-pack)
Comentarios/títulos stale en tests PRESERVADOS (T-152-2/5/5b/6, T-163-2/3) que referenciaban el filtro removido → "mentían sobre el código". El story-file mandó no tocar los preservados, pero como WKH-160 está parkeado, se refrescaron los comentarios (comment-only, 0 cambios en asserts — verificado byte-idéntico, 106/106). grep de refs stale post-fix-pack = 0 hits.
