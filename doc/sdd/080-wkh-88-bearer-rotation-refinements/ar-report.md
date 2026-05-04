# AR Report — WKH-88 Bearer Rotation Refinements

**Reviewer**: nexus-adversary (AR mode) | **Date**: 2026-05-04 | **Branch**: feat/080-wkh-88-bearer-rotation-refinements @ 45787ba

## Veredicto
**APROBADO con MENORES** — 0 BLQs, 2 MNRs operacionales

## Resumen ejecutivo

Implementación sólida sobre security path crítico ya en producción. 11 categorías AR revisadas. 7 ACs cubiertos con evidencia ejecutable independiente. Probes adversariales independientes confirmaron:
1. REAL concurrent rotation (Promise.all) → r1 wins, r2 returns mutex skip, vercelFetchCount=0 para r2
2. Object.freeze enforcement → TypeError en strict mode (real freeze, no lazy)
3. Edge cases req.method (lowercase, undefined, missing) → 405 defensive
4. Edge cases expiresAt (null/undefined/{}/Infinity/array) → snapshot missing or unparseable
5. kvClient ausente/null/{} → mutex skip limpio, fail-open
6. kvClient.set throw → mutex-acquire-failed warn, rotation procede

## Hallazgos BLOQUEANTES

Ninguno.

## Hallazgos MENORES

**MNR-AR-1** — Mutex no se libera tras rotación exitosa
- Path: `src/bearer-rotation.mjs:147-166`
- Operador que dispare manual rotation tras cron mensual recibe mutex skip y debe esperar 5min
- Para cron-only flow (mensual) es invisible; manual operations bloqueado
- Sugerencia: `try { kvClient.del(KV_KEYS.ROTATION_MUTEX) } catch {}` antes del return ok

**MNR-AR-2** — Mutex contention reportada como HTTP 500
- Path: `api/cron/rotate-bearer.mjs:118-128`
- cron-job.org recibe 500 ante mutex skip benigno → puede disparar email/alert policy
- log.error con `failed` event es engañoso (no es failure real)
- Sugerencia: si `result?.stage === 'mutex'`, retornar 200 con `{ok:true, skipped:true}` y log.warn

## Cobertura ACs

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (method gate rotate) | ✅ PASS | `rotate-bearer.mjs:45-49` + T-MTHD-01 `:269-303` |
| AC-2 (method gate invalidate) | ✅ PASS | `invalidate-prev-bearer.mjs:67-71` + T-MTHD-02 `:266-306` |
| AC-3 (KV mutex concurrent) | ✅ PASS | `bearer-rotation.mjs:147-166` + T-MUTEX-01 `:259-303` + REAL probe Promise.all |
| AC-4 (JSDoc) | ✅ PASS | `bearer-rotation.mjs:66-125` (5 @param + 2 typedef + @throws never) |
| AC-5 (kv-keys.mjs zero dup) | ✅ PASS | `kv-keys.mjs:25` + imports en `bearer-rotation.mjs:25` y `invalidate-prev-bearer.mjs:46` |
| AC-6 (T-CIN-05 NaN) | ✅ PASS | `cron-invalidate-prev-bearer.test.mjs:308-351` + handler:166-173 Number.isFinite |
| AC-7 (baseline preserved) | ✅ PASS | npm test → 248/248 PASS, 0 fail |

## Cobertura CDs

| CD | Status |
|----|--------|
| CD-WKH88-1 (gate before auth) | ✅ verificado orden líneas |
| CD-WKH88-2 (NX atomic) | ✅ {nx:true, ex:300} |
| CD-WKH88-3 (Object.freeze) | ✅ TypeError probe |
| CD-WKH88-4 (test inject directly) | ✅ JSON.stringify directo, no Date monkey-patch |
| CD-WKH88-5 (T-MTHD assert no auth log) | ✅ asserts negativos |
| CD-WKH88-6 (TTL ≤ 10 min) | ✅ 5*60 = 300 < 600 |
| CD-WKH88-7 (no new deps) | ✅ package.json sin cambios |
| CD-9 (no log tokens) | ✅ T-CRO-01/04, T-CIN-04 asserts negativos |
| CD-12 (never throw) | ✅ probes con kvClient flakey/null/{} |
| CD-15 (no leak stderr) | ✅ T-CRO-04, T-CIN-04, T-MTHD-01 asserts |

## Auto-Blindaje Review

3 entries documentadas, todas APLICADAS:
1. T-RB-08 regression → arreglado, mock inline reescrito (línea 222-257)
2. kv-mock nx gap → NX honor agregado (`_mocks/kv-mock.mjs:76-80`), probe REAL Promise.all confirma
3. STAGE_REASONS whitelist drift → `'mutex-busy'` agregado a `bearer-rotation.mjs:33`

## Tests independientes corridos

```
npm test → 248/248 passing, 0 fail, 1056ms
+ 6 probes adversariales (concurrent, freeze enforcement, method edge, expiresAt corrupt, kv missing, kv throw)
```

## Recomendación

APROBAR para F4. 0 BLQs. 2 MNRs son refinamientos operacionales no-bloqueantes — pueden tratarse en follow-up o aceptarse.
