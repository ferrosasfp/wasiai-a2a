# CR Report — WKH-88

**Reviewer**: nexus-adversary (CR mode) | **Date**: 2026-05-04 | **Branch**: feat/080-wkh-88-bearer-rotation-refinements @ 45787ba

## Veredicto
**APROBADO con MENORES** — 0 BLQs, 5 MNRs cosmetic/optional

## Resumen ejecutivo

Carry-forward de 9 MNRs WKH-75 ejecutado con disciplina. Code clean, tests sólidos, JSDoc supera calidad media del proyecto, paridad de estilo con `vercel-env.mjs`/`rate-limit.mjs` mantenida. Auto-blindaje resolvió las 3 entries documentadas. 248/248 tests pass.

## BLOQUEANTES
Ninguno.

## MENORES

| # | archivo:línea | Issue | Sugerencia |
|---|---|---|---|
| MNR-CR-1 | `api/cron/invalidate-prev-bearer.mjs:5,13` | Comments header referencian string literal `'last-bearer-rotation'` aunque código importa KV_KEYS | Reemplazar por backticks `KV_KEYS.LAST_ROTATION` o agregar nota |
| MNR-CR-2 | `src/bearer-rotation.mjs:159-161` | Branch fallback `acquired='OK'` cuando KV throw — decisión enterrada en comentario inline. KV flapping → 2 workers podrían avanzar como si tuvieran mutex | Considerar log.warn distinguible o alerta agregada (>N veces/hora). Trackear como observability TODO |
| MNR-CR-3 | `src/kv-keys.mjs:42` | Mutex key `'bearer-rotation-mutex'`. MUTEX_TTL_SECONDS=5min comentado pero no remite explícitamente a SDD DT-2 | Comment `// SDD WKH-88 DT-2: 5 min (CD-WKH88-6 caps at 10 min)` |
| MNR-CR-4 | `tests/bearer-rotation.test.mjs:300` | T-MUTEX-01 valida `ex <= 10*60` (upper) pero NO lower bound | Agregar `assert.ok(ex >= 60, 'TTL ≥ 60s')` o equality exacta a constante exportada |
| MNR-CR-5 | `tests/cron-rotate-bearer.test.mjs`, `tests/cron-invalidate-prev-bearer.test.mjs` | T-MTHD-01/02 inline `{headers, method:'GET'}` en lugar de helper `makeReq()` | Considerar `makeReq({method:'GET', auth})` con param nuevo |

## Quality scorecard

- **Naming: 5/5** — `KV_KEYS.*`, `MUTEX_TTL_SECONDS`, `STAGE_REASONS['mutex-busy']`, `T-MTHD-01/02`, `T-MUTEX-01`, `T-CIN-05` consistentes con convención repo
- **Comments: 5/5** — cada decision design comentada, JSDoc explica WHY (CD-12)
- **Test quality: 5/5** — T-MTHD-01/02 con 5 asserciones cada uno (status + Allow + body + sin auth-log + sin Vercel call). T-MUTEX-01 branch determinístico + bound TTL + zero fetch. T-CIN-05 inyecta corrupto directly. T-RB-08 reescrito post-regression con per-call-shape asserts
- **Paridad codebase: 5/5** — JSDoc style matches `vercel-env.mjs` y `rate-limit.mjs`. Object.freeze pattern matches `STAGE_REASONS`. Method gate Express-style consistente con `mcp.mjs:355`
- **Auto-Blindaje resolution: 5/5** — 3 entries con remediación aplicada y verificable

## Verificación cruzada AR

Overlaps anticipados:
- MNR-CR-2 toca el `acquired='OK'` fallback path. AR puede flagear como "mutex bypass on KV failure" (also AR finding posible)
- AR finding "method gate sin auth log" cubierto por T-MTHD-01/02 (asserts negativos)
- AR finding "JSDoc @throws never" cubierto por probes Pierre

## Files reviewed

10 archivos: 3 docs/sdd + 5 código (3 modificados + 1 nuevo + 1 mock test extension) + 1 mock + 1 tests file

**CR verdict: APROBADO con MENORES.**
