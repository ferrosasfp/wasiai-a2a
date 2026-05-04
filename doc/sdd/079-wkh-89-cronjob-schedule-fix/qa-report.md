# QA Report — WKH-89 (cronjob schedule fix)

**Reviewer**: nexus-qa (F4) | **Date**: 2026-05-03 | **Branch**: feat/079-wkh-89-cronjob-schedule-fix @ ed1a848

## Veredicto

**APROBADO PARA DONE**

7/7 ACs PASS con evidencia concreta. Zero drift. Tests 244/244. Schedules verificados byte-a-byte contra la API live de cron-job.org.

---

## Runtime checks

### Cron-job.org API — live schedule verification (AC-5)

`curl -H "Authorization: Bearer $CRON_JON_APIKEY" https://api.cron-job.org/jobs` — HTTP 200, 8 jobs retornados.

Los 4 jobs del scope:

| jobId | title | schedule (API live) | Matches code |
|-------|-------|---------------------|--------------|
| 7547879 | wasiai-x402-warmup | minutes=[0,4,8,12,16,20,24,28,32,36,40,44,48,52,56], hours=[-1], mdays=[-1], months=[-1], wdays=[-1] | MATCH |
| 7547880 | wasiai-x402-balance-check | minutes=[0,15,30,45], hours=[-1], mdays=[-1], months=[-1], wdays=[-1] | MATCH |
| 7558205 | wasiai-x402-bearer-rotation | minutes=[0], hours=[9], mdays=[1], months=[-1], wdays=[-1] | MATCH |
| 7558208 | wasiai-x402-invalidate-prev-bearer | minutes=[0], hours=[10], mdays=[-1], months=[-1], wdays=[-1] | MATCH |

Zero drift entre el workaround manual 2026-05-04 y los valores definidos en el código. Si `setup-cronjob.mjs` se re-ejecuta hoy, produce PATCH requests con exactamente los mismos valores que ya están vivos.

### node --test run

```
cd mcp-servers/wasiai-x402 && npm test
# tests 244 / pass 244 / fail 0 / duration 1010ms
```

Todos los 11 tests del setup-cronjob suite (T-SC-01..06 + T-CRJ-INT-01..05) pasaron.

---

## AC verification

| AC | Texto | Status | Evidencia |
|----|-------|--------|-----------|
| AC-1 | warmup schedule `minutes: [0,4,8,12,16,20,24,28,32,36,40,44,48,52,56]`, hours/mdays/months/wdays `[-1]` | PASS | `scripts/setup-cronjob.mjs:52-57` (15 valores); T-CRJ-INT-01 `tests/setup-cronjob.test.mjs:267-271` deepEqual pass; API live jobId 7547879 confirma byte-by-byte |
| AC-2 | balance-check schedule `minutes: [0,15,30,45]`, resto `[-1]` | PASS | `scripts/setup-cronjob.mjs:66-71`; T-CRJ-INT-02 `tests/setup-cronjob.test.mjs:293-296` deepEqual pass; API live jobId 7547880 confirma |
| AC-3 | bearer-rotation `minutes:[0], hours:[9], mdays:[1]`, resto `[-1]` | PASS | `scripts/setup-cronjob.mjs:84-89`; T-CRJ-INT-03 `tests/setup-cronjob.test.mjs:317-321` deepEqual pass; API live jobId 7558205 confirma |
| AC-4 | invalidate-prev-bearer `minutes:[0], hours:[10], mdays:[-1]`, resto `[-1]` | PASS | `scripts/setup-cronjob.mjs:101-106`; T-CRJ-INT-04 `tests/setup-cronjob.test.mjs:338-342` deepEqual pass; API live jobId 7558208 confirma |
| AC-5 | zero schedule drift vs workaround 2026-05-04 | PASS | `curl https://api.cron-job.org/jobs` → HTTP 200; comparación python3 byte-by-byte: warmup_match=True, balance-check_match=True, bearer-rotation_match=True, invalidate_match=True |
| AC-6 | 244+ tests passing (239 baseline + 5 nuevos) | PASS | `npm test` en `mcp-servers/wasiai-x402/`: `# tests 244 / # pass 244 / # fail 0 / duration_ms 1010` |
| AC-7 | regression guard T-CRJ-INT-05 falla si cualquier schedule field contiene strings | PASS | `tests/setup-cronjob.test.mjs:354-391` — triple guard: `Array.isArray` + `typeof !== 'string'` + `Number.isInteger`; mensaje de error incluye `title.field`; test pasó (ok 11) |

---

## Drift detection

- **Files outside Scope IN**: none. `git diff main..HEAD --stat` muestra exactamente 2 archivos:
  - `mcp-servers/wasiai-x402/scripts/setup-cronjob.mjs` (Scope IN)
  - `mcp-servers/wasiai-x402/tests/setup-cronjob.test.mjs` (Scope IN)
- **Wave drift**: commit único `ed1a848 fix(WKH-89)` — HU S-size, single wave, sin violaciones de orden.
- **Spec drift**: CD-2 (no helper expansion) verificado — arrays definidos inline en `TARGET_JOBS`. CD-3 (no cambios a main/createJob/updateJob/listJobs) verificado — diff solo toca líneas 45-109 (literales `schedule`).
- **Comment drift**: CD-7 satisfecho — `scripts/setup-cronjob.mjs:8` y `:82` dicen "1st of month at 09:00 UTC", no "every 30 days".

---

## Gates (confirmed from CR/AR reports)

Gates NO re-ejecutados (ya validados por CR @ ed1a848):

- `node --test tests/setup-cronjob.test.mjs` → 11 pass / 0 fail / 479ms (CR report)
- `npm test` → 244 pass / 0 fail / 1298ms (AR report)

Confirmados en esta sesión: `npm test` (cd mcp-servers/wasiai-x402) → 244/244 PASS. Sin regresiones.

---

## Inconsistencias detectadas

**MNR-1 (doc-only, heredado de AR)**: work-item.md línea 56 dice "14 valores" para el array warmup, pero el array tiene 15 elementos `[0,4,...,56]`. El código es correcto (15 = multiples de 4 de 0 a 56 inclusive). Solo el doc está mal. No afecta comportamiento.

Sin inconsistencias entre claims AR/CR y la realidad runtime.

---

## Recomendacion

**APROBADO para DONE**

7/7 ACs PASS con evidencia archivo:linea + API live. Cero drift. 244 tests green. El fix es correcto, los regression guards son rigurosos (triple-layered en T-CRJ-INT-05), y el estado actual de cron-job.org ya tiene los valores correctos del workaround — la proxima ejecucion de `setup-cronjob.mjs` sera idempotente.
