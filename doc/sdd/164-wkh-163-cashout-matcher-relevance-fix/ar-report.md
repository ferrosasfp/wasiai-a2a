# AR Report — WKH-163 (cashout-matcher relevance fix)

**Fecha:** 2026-07-09 · **Modo:** AR adversarial, READ-ONLY · **Branch:** `fix/164-wkh-163-cashout-matcher-relevance-fix`
**Gate:** `tsc --noEmit` → 0 errores · `vitest run` → 2805 passed / 0 failed.

## Veredicto: APROBADO (1 MENOR no bloqueante)

Money-path invariant (débito == ejecución) se mantiene post-fix; el fix restaura la remesa insignia (EN + ES → 3 steps incl. cashout-matcher) sin neutralizar el drop genuino de WKH-152 ni introducir regresión de plan-vacío/multilingüe.

## Vectores de ataque (evidencia archivo:línea)

- **#1 [MONEY] débito == ejecución — OK.** El recompute de billing (`orchestrate.ts:1040-1059`) itera el array `steps` FINAL asignado en `:1017` desde el `relevantSteps` post-guard. `plannedCostUsd` (base del débito step-0) se recomputa en `:1019-1022` desde el head sobreviviente. El terminal-guard (`:911-927`) muta `relevantSteps` ANTES de `applyDrop` (`:931`) y `llmDropped` (`:935`) → todo el billing downstream ve el set rescatado. `passOutput` se reindexa por posición en `:1017`. Sin over/under-charge relativo a los steps ejecutados. T-163-4 confirma débito 0.4.
- **#2 [never-empty / all-numeric] — OK.** Goal `400 500 600` → `llmGoalTokens` vacío → `llmFilterApplies=false` (`:894`) → filtro salteado → conserva todo (T-163-3). El guard solo AGREGA steps → nunca vacía un plan. CD-15 intacto.
- **#3 [multilingüe] — OK.** Goal ES → `llmGoalTokens` no vacío → all-disjoint vs agentes EN → CD-15 conserva 3 (T-163-2). El swap `goalTokens→llmGoalTokens` solo remueve numéricos puros, nunca palabras reales → el lock multilingüe (T-152-2b) intacto.
- **#4 [no-neutralizar el drop genuino] — OK.** T-152-1 (mixto 2-step, defi terminal + único disjunto) sigue dropeando defi: `droppedCount=1 < 2` → terminal-guard NO rescata (`:920`). El filtro NO es no-op.
- **#5 [terminal-guard gaming] — OK (sin exploit económico).** El rescate solo AGREGA el terminal a un plan ya cobrado/ya-parcialmente-relevante, y el step rescatado se cobra al budget del PROPIO caller (charge == payout). Forzar un terminal off-topic es self-harm, no leak cross-tenant ni fund drain. No bypassa el early-return `no_relevant_agent` (`:937`) ni corre en el greedy path.
- **#6 [numeric exclusion correcto] — OK.** `/^\d+$/` sobre tokens ya tokenizados: `400usd`/`usdc`/`peru2` → alfanumérico, NO excluido (semántica preservada); `$400.50` → `400` (excluido) + `50` (ya descartado por len<2). `eth`/`web3`/`erc20` sobreviven.
- **#7 [T-152-* intactos] — OK.** `git diff` = 0 deletions en el test file (274 insertions) → los 10 T-152 byte-idénticos, pasando por su mecanismo original.

## 11 categorías: 1-8 OK, 9-11 N/A (sin SQL/RPC/cache).

## Hallazgo
- **MNR-1 (Data Integrity / trade-off documentado, NO bloqueante):** el terminal-guard (`:920-925`) rescata el terminal aun si es genuinamente off-topic, mientras `droppedCount>=2` (el caller paga 1 step extra de su propio budget, sin impacto cross-tenant). Es la decisión de diseño explícita CD-4 (rescatar la pata de entrega para no re-truncar una remesa multi-leg), el mal menor vs el bug insignia. Solo transparencia — sin acción requerida.

Basis: `src/services/orchestrate.ts:851-935,1016-1059` + `src/services/orchestrate.test.ts:2529-2801`.
