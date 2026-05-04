# Report — HU [WKH-88] Bearer Rotation Refinements

## Resumen ejecutivo

**Status: DONE** (2026-05-04, pipeline FAST+AR).

Carry-forward de 9 MNRs WKH-75 completado. Se aplicaron 4 hardening checks al MCP server wasiai-x402:
(1) HTTP method gate (POST-only) en ambos endpoints cron,
(2) KV NX-flagged mutex para prevenir rotaciones concurrentes,
(3) JSDoc completo en `rotateBearer()`,
(4) Extracción de constantes KV duplicadas a `src/kv-keys.mjs`.

**Artefactos clave**: `mcp-servers/wasiai-x402/` (8 files: 3 src + 2 api + 3 tests/mocks).
**Pipeline**: F0 → F1 (HU_APPROVED) → F2 (SPEC_APPROVED) → F3 (7 waves) → AR (APROBADO) → CR (APROBADO) → F4 (APROBADO).

---

## Pipeline ejecutado

| Fase | Entrada | Gate | Salida |
|------|---------|------|--------|
| **F0** | project-context (wasiai-a2a `d00c0c8` base post-WKH-89) | — | grounding completo |
| **F1** | 7 ACs (EARS) + 4 DTs + 7 CDs nuevos | HU_APPROVED (2026-04-28) | `work-item.md` |
| **F2** | Work Item + especificación de mini SDD | SPEC_APPROVED (2026-05-01) | `sdd.md` |
| **F2.5** | Story File — 7 waves, 8 files, test plan | — | `story-file.md` |
| **F3** | Implementation wave-by-wave (W1-W7) | — | 248/248 tests PASS, 0 fail |
| **AR** | Branch `feat/080-wkh-88-bearer-rotation-refinements` @ 45787ba | APROBADO con MENORES | `ar-report.md` |
| **CR** | Code quality + design coherence | APROBADO con MENORES | `cr-report.md` |
| **F4** | Acceptance Criteria verification (7/7 PASS) | **APROBADO PARA DONE** | `qa-report.md` |

**Auto-Blindaje**: 3 entries documentadas y todas aplicadas durante F3.

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (HTTP method gate — rotate) | ✅ PASS | `rotate-bearer.mjs:45-49` gate first; T-MTHD-01 `:269-303` con 405 + Allow:POST + body correcto + sin auth log |
| AC-2 (HTTP method gate — invalidate) | ✅ PASS | `invalidate-prev-bearer.mjs:67-71` gate first; T-MTHD-02 `:266-306` matching assertions |
| AC-3 (KV mutex concurrent) | ✅ PASS | `bearer-rotation.mjs:147-166` NX-flagged `{nx:true, ex:300}`; T-MUTEX-01 `:259-303` verifica mutex skip + vercelFetchCount=0 |
| AC-4 (JSDoc rotateBearer) | ✅ PASS | `bearer-rotation.mjs:66-125` — 5 @param + 2 typedef + @throws never |
| AC-5 (kv-keys.mjs zero dup) | ✅ PASS | `kv-keys.mjs:25` Object.freeze; imports en `bearer-rotation.mjs:25` y `invalidate-prev-bearer.mjs:46` |
| AC-6 (T-CIN-05 NaN guard) | ✅ PASS | `cron-invalidate-prev-bearer.test.mjs:308-351` inyecta `expiresAt:'not-a-date'`; handler retorna `{ok:true, skipped:true}` |
| AC-7 (test baseline) | ✅ PASS | 248/248 PASS (232 WKH-75 baseline + 16 nuevos); 0 regressions |

---

## Hallazgos finales

### BLOQUEANTEs
**Ninguno.** AR y CR ambos aprobaron con 0 BLOCKERs.

### MENOREs (no-blocking, asignables a backlog informal)

**AR Findings** (2 MNRs operacionales):
1. **MNR-AR-1** — Mutex no se libera tras rotación exitosa (`bearer-rotation.mjs:147-166`).
   - Impacto: Operador que dispara manual rotation post-cron mensual recibe mutex skip durante 5 min.
   - Para cron-only flow (mensual) es invisible; para manual ops es obstáculo.
   - Sugerencia: `try { kvClient.del(KV_KEYS.ROTATION_MUTEX) } catch {}` antes del return ok.

2. **MNR-AR-2** — Mutex contention reportada como HTTP 500 al cron-job.org (`api/cron/rotate-bearer.mjs:118-128`).
   - Impacto: cron-job.org recibe 500 ante mutex skip benigno → puede disparar email/alert policy falsa.
   - log.error con `failed` event es semánticamente engañoso.
   - Sugerencia: Si `result?.stage === 'mutex'`, retornar 200 con `{ok:true, skipped:true}` y log.warn.

**CR Findings** (5 MNRs cosmetic/observability):
1. **MNR-CR-1** — `invalidate-prev-bearer.mjs:5,13` comments referencian string literal `'last-bearer-rotation'` aunque código importa `KV_KEYS`.
   - Sugerencia: Reemplazar por backticks `KV_KEYS.LAST_ROTATION`.

2. **MNR-CR-2** — Branch fallback `acquired='OK'` cuando KV throw (`bearer-rotation.mjs:159-161`).
   - Si KV flapping → 2 workers podrían avanzar como si tuvieran mutex.
   - Sugerencia: log.warn distinguible o alerta agregada (>N veces/hora). Trackear como observability TODO.

3. **MNR-CR-3** — Mutex key `'bearer-rotation-mutex'`. MUTEX_TTL_SECONDS=5min comentado pero no remite explícitamente a SDD DT-2 (`kv-keys.mjs:42`).
   - Sugerencia: Comment `// SDD WKH-88 DT-2: 5 min (CD-WKH88-6 caps at 10 min)`.

4. **MNR-CR-4** — T-MUTEX-01 valida `ex <= 10*60` (upper) pero NO lower bound (`bearer-rotation.test.mjs:300`).
   - Sugerencia: Agregar `assert.ok(ex >= 60, 'TTL ≥ 60s')` o equality exacta a constante exportada.

5. **MNR-CR-5** — T-MTHD-01/02 inline `{headers, method:'GET'}` en lugar de helper `makeReq()`.
   - Sugerencia: Considerar `makeReq({method:'GET', auth})` con param nuevo.

---

## Constraint Directives — verificación

| CD | Status | Evidencia |
|----|--------|-----------|
| CD-WKH88-1 (method gate antes auth) | ✅ | `rotate-bearer.mjs:45-49`, `invalidate-prev-bearer.mjs:67-71` primeras líneas ejecutables |
| CD-WKH88-2 (KV NX atomic) | ✅ | `bearer-rotation.mjs:151-153` con `{nx:true, ex:300}` |
| CD-WKH88-3 (Object.freeze) | ✅ | `kv-keys.mjs:25` exports frozen object; TypeError probe en AR validó |
| CD-WKH88-4 (test inject directo) | ✅ | `cron-invalidate-prev-bearer.test.mjs:308-351` inyecta JSON directo, no monkey-patch |
| CD-WKH88-5 (T-MTHD assert sin auth) | ✅ | T-MTHD-01/02 asserts negativos sobre `validateCronSecret` calls |
| CD-WKH88-6 (TTL ≤ 10 min) | ✅ | 5*60 = 300 < 600 seconds |
| CD-WKH88-7 (no new deps) | ✅ | package.json sin cambios |
| CD-9 (no log tokens) | ✅ | T-CRO-01/04, T-CIN-04 asserts negativos |
| CD-12 (never throw) | ✅ | Probes con kvClient flakey/null/{} confirman fail-open |
| CD-15 (no leak stderr) | ✅ | T-MTHD-01/02, T-CIN-04 asserts |

---

## Auto-Blindaje consolidado

Errores cometidos durante F3 y cómo se corrigieron. Referencia para futuras HUs en `mcp-servers/wasiai-x402/`.

### [2026-05-03 W1] T-RB-08 regression tras introducir S0-pre mutex

**Error**: After adding NX-flagged mutex como first operation en `rotateBearer()`, test pre-existente T-RB-08 (`KV write failure S6 → ok:true`) comenzó a fallar.
- **Causa**: `makeKvMock({failNext:1})` es order-sensitive; nuevo `set()` por mutex consume el slot de failure.
- **Fix aplicado**: Reemplazar mock local por inline mock que distingue explícitamente los dos `set()` calls. Agregar asserts sobre `setCalls[0].opts.nx === true` y `setCalls[1].opts.nx === undefined`.
- **Aplicar en futuras HUs**: Cuando añadas KV touch ANTES de S6, auditar `tests/bearer-rotation.test.mjs` y `tests/audit-stderr.test.mjs` por `failNext` assumptions. Preferir per-call-shape asserts (e.g., `expect(setCalls[N].opts.nx)`) sobre raw `_store.size`.

### [2026-05-03 W1] kv-mock missing `nx` flag honour

**Error**: `tests/_mocks/kv-mock.mjs` no implementaba Upstash `{nx:true}` semantics — siempre retornaba 'OK'.
- **Causa**: WKH-75 solo necesitaba `{ex:<seconds>}`, así que `nx` nunca se implementó. Mock surface quedó rezagada.
- **Fix aplicado**: Agregar `nx` honour a `createKvMock().set()`. Cuando `opts.nx === true` y key existe, retornar `null`. Matches `@upstash/redis` documented behaviour.
- **Aplicar en futuras HUs**: Cada nueva Upstash semantic que el mock soporte (e.g., `{xx:true}`, `{px:<ms>}`), documentar en call site del mock con referencia a production caller.

### [2026-05-03 W2] STAGE_REASONS literal whitelist updated

**Error**: Inicialmente retornada `{stage:'mutex', reason:'rotation already in progress'}` como literal string, bypasseando `STAGE_REASONS` whitelist.
- **Causa**: Nueva error path sin auditar CD-12 invariant.
- **Fix aplicado**: Agregar `'mutex-busy': 'rotation already in progress'` a `STAGE_REASONS` frozen registry. Cambiar early-return a `reason: STAGE_REASONS['mutex-busy']`.
- **Aplicar en futuras HUs**: Toda nueva stage en `rotateBearer()` DEBE agregar entry a `STAGE_REASONS` Y entrada a JSDoc `@typedef RotateBearerFailure`.

---

## Archivos modificados (8 total)

### Src (3 archivos modificados)
- `mcp-servers/wasiai-x402/src/bearer-rotation.mjs` — JSDoc + KV mutex NX + STAGE_REASONS + kv-keys import
- `mcp-servers/wasiai-x402/src/kv-keys.mjs` — **NEW** — frozen object export con `LAST_ROTATION`, `ROTATION_MUTEX`
- `mcp-servers/wasiai-x402/api/cron/rotate-bearer.mjs` — HTTP method gate + HTTP 405 first check

### API (2 archivos modificados)
- `mcp-servers/wasiai-x402/api/cron/invalidate-prev-bearer.mjs` — HTTP method gate + kv-keys import

### Tests (3 archivos modificados)
- `mcp-servers/wasiai-x402/tests/bearer-rotation.test.mjs` — T-MUTEX-01 + T-RB-08 reescrito post-regression
- `mcp-servers/wasiai-x402/tests/cron-rotate-bearer.test.mjs` — T-MTHD-01
- `mcp-servers/wasiai-x402/tests/cron-invalidate-prev-bearer.test.mjs` — T-MTHD-02 + T-CIN-05

### Mocks (1 archivo modificado)
- `mcp-servers/wasiai-x402/tests/_mocks/kv-mock.mjs` — Agregar `nx` honour

---

## Test Results

```
npm test
248/248 passing, 0 fail, 1392ms

Baseline (WKH-75):  232 tests
WKH-88 nuevos:      16 tests
Total:              248 tests

Coverage: 100% (bearer-rotation.mjs, cron endpoints, kv-mock)
```

**Todos los tests PASS**. Zero regressions post-WKH-89 baseline.

---

## Próximos pasos

1. **Merge a main** (orquestador decides).
2. **Auto-deploy via git-link** — Railway observa `main` y redeploy automático en ~3-5 min.
3. **Post-deploy validation** — Verificar cron-job.org ejecuta sin error en próximo run mensual.
4. **MNRs as follow-up** — 7 MNRs (2 AR + 5 CR) pueden quedar como TD/backlog informal; ninguno es bloqueante.

---

## Status final

| Item | Resultado |
|------|-----------|
| **ACs** | 7/7 PASS |
| **CDs** | 10/10 verificados |
| **AR** | APROBADO con 2 MNRs (no-blocking) |
| **CR** | APROBADO con 5 MNRs (cosmetic) |
| **F4 QA** | APROBADO PARA DONE |
| **Tests** | 248/248 PASS, 0 regressions |
| **Auto-Blindaje** | 3/3 entries aplicadas |
| **Scope drift** | Ninguno |
| **Secrets leakage** | No detectado |

**VEREDICTO FINAL: DONE** ✅
