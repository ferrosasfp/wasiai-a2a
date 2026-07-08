# CR Report — WKH-163 (cashout-matcher relevance fix)

**Fecha:** 2026-07-09 · **Modo:** CR (calidad), READ-ONLY · **Branch:** `fix/164-wkh-163-cashout-matcher-relevance-fix`
**Archivos:** `src/services/orchestrate.ts` (+31-2), `src/services/orchestrate.test.ts` (+274).
**Verificación:** `tsc --noEmit` = 0 · `biome check` = limpio · `vitest -t "T-163"` = 4/4 · `vitest -t "T-152"` = 9/9 (regresión intacta).

## Veredicto: APROBADO con NITs (0 bloqueantes; los 2 NITs foldeados en fix-pack)

## Por dimensión
1. **Cobertura de tests (4 nuevos):** asserts significativos (slugs reales vía `toContain`/`toEqual`, no solo `length`). T-163-1/2 (insignia EN/ES → all-disjoint → CD-15 conserva 3, `test:2614/2646`); T-163-3 (`'400 500 600'` → llmGoalTokens vacío → gate false, `test:2673`, ejercita `orchestrate.ts:894`); T-163-4 (terminal-rescue con droppedCount=2, `test:2745`). "No rescatar con droppedCount=1" cubierto por T-152-1 (`test:2119`, regression-guard viva del umbral `>=2`). "No vaciar plan" por T-152-2/2b.
2. **`llmGoalTokens` (`orchestrate.ts:857-859`) — OK.** `new Set([...goalTokens].filter((t) => !/^\d+$/.test(t)))` — no muta goalTokens, regex sobre token tokenizado, preserva mixtos tipo `usd400`. Sin `any`.
3. **Terminal-guard (`:911-927`) — OK.** `noUncheckedIndexedAccess`/CD-8 respetado (`terminal: ComposeStep | undefined` + guard `!== undefined`, sin `!`); `droppedCount = steps.length - relevantSteps.length` correcto; applyDrop/llmDropped recomputados después → billing consistente. Nombres claros.
4. **Scope — OK.** Solo orchestrate.ts + su test. goalTokens/tokenizeForRelevance/greedy/recompute-billing intactos. Sin drift.
5. **Consistencia estilo WKH-152/158/159 — OK.** Mismo bloque, tags inline `WKH-163: … (era goalTokens)`, biome inline multilínea (CD-9).

## NITs (foldeados en fix-pack post-CR)
- **NIT-1** (`test` T-163-2): la variante ES no verificaba el monto del débito como su gemelo EN → **agregado** el assert head=0.5 (paridad EN/ES).
- **NIT-2** (`test` T-152-1): faltaba contra-referencia a WKH-163 (que también fija el umbral del terminal-guard) → **agregado** el comentario.

Ambos NITs cosméticos, no bloqueaban el gate.
