# QA Report — WKH-65 (a2a-forward-key)

**Veredicto:** APROBADO PARA DONE
**Fecha:** 2026-04-28
**Branch:** feat/064-wkh-65-a2a-forward-key (commit dcbb734)
**Pipeline:** FAST+AR

---

## Runtime Checks

- **Env parity:** `WASIAI_V2_FORWARD_KEY` documentada en `.env.example:39` (línea vacía = optional). No deployment target remoto verificable programáticamente en este entorno — marcado NO VERIFICABLE para producción (operador debe confirmar en Railway).
- **Migration:** no aplica — HU no toca DB.
- **New env vars in code:** `process.env.WASIAI_V2_FORWARD_KEY` leída en `forward-key.ts:69` (no typo, match exacto con `.env.example:39`). `TIMEOUT_COMPOSE_MS` leída en `compose.ts:29` (match `.env.example:179`).

---

## ACs validados (8/8)

### AC-1
**Texto:** WHEN `WASIAI_V2_FORWARD_KEY` is not set, the system SHALL NOT mount the middleware and all existing tests SHALL continue to pass.
- **Estado:** PASS
- **Código:** `forward-key.ts:69-79` — factory lee env, si `!expected || expected.length < 16` retorna `[]`; spread en `compose.ts:27` y `orchestrate.ts:49` produce no-op.
- **Test:** `forward-key.test.ts:36-41` — "AC-1: WASIAI_V2_FORWARD_KEY unset → factory returns []" PASS. `forward-key.test.ts:43-48` — "AC-1: empty string → factory returns []" PASS.
- **Evidencia run:** `vitest run forward-key.test.ts` → ambos AC-1 tests PASS (líneas 1-2 del output verbose).

### AC-2
**Texto:** WHEN a request arrives with a valid `x-wasiai-forward-key` matching `WASIAI_V2_FORWARD_KEY` AND valid payment credential, the system SHALL return 200.
- **Estado:** PASS
- **Código:** `forward-key.ts:108-123` — `safeStringEquals` retorna true → handler retorna sin llamar `reply.send` → Fastify continúa a los siguientes preHandlers.
- **Test:** `forward-key.test.ts:172-197` — "AC-2: matching x-wasiai-forward-key → 200 passthrough" → `expect(res.statusCode).toBe(200)` PASS.
- **Evidencia run:** `vitest run forward-key.test.ts` → AC-2 test PASS (línea 7 del output verbose).

### AC-3
**Texto:** WHEN a request arrives with `x-wasiai-forward-key` NOT matching `WASIAI_V2_FORWARD_KEY`, the system SHALL return 401 with error code `INVALID_FORWARD_KEY` using `timingSafeEqual`.
- **Estado:** PASS
- **Código:** `forward-key.ts:110-121` — `if (!ok) { reply.status(401).send({ error: 'Invalid forward key', error_code: 'INVALID_FORWARD_KEY' }) }`.
- **Test:** `forward-key.test.ts:52-77` — "AC-3: invalid x-wasiai-forward-key → 401 INVALID_FORWARD_KEY" → `expect(res.statusCode).toBe(401)` + `expect(res.json().error_code).toBe('INVALID_FORWARD_KEY')` PASS.
- **Evidencia run:** `vitest run forward-key.test.ts` → AC-3 test PASS (línea 3 del output verbose).

### AC-4
**Texto:** WHEN `WASIAI_V2_FORWARD_KEY` is set and a request arrives WITHOUT the header, the system SHALL pass through to the next middleware.
- **Estado:** PASS
- **Código:** `forward-key.ts:102-105` — `if (typeof headerValue !== 'string' || headerValue.length === 0) return;` — retorno sin reply = passthrough.
- **Test:** `forward-key.test.ts:81-106` — "AC-4: env set + x-wasiai-forward-key absent → passthrough" → `expect(res.statusCode).toBe(200)` + `expect(res.json()).toEqual({ ok: true })` PASS.
- **Evidencia run:** `vitest run forward-key.test.ts` → AC-4 test PASS (línea 4 del output verbose).

### AC-5
**Texto:** WHILE performing the comparison, the system SHALL use `timingSafeEqual` with equal-length inputs, safely when lengths differ WITHOUT throwing.
- **Estado:** PASS
- **Código:** `forward-key.ts:43-56` — `safeStringEquals` aplica HMAC-SHA256 a ambos inputs antes de `timingSafeEqual`. Ambos lados producen digest de 32 bytes fijos, eliminando la dependencia de longitud. No hay branch de length-mismatch que pueda lanzar excepción.
- **Test:** `forward-key.test.ts:110-136` — "AC-5: header shorter than expected → 401 without throw" PASS. `forward-key.test.ts:138-168` — "AC-5: header longer than expected → 401 without throw" PASS.
- **Evidencia run:** `vitest run forward-key.test.ts` → ambos AC-5 tests PASS (líneas 5-6 del output verbose).

### AC-6
**Texto:** WHEN `x-wasiai-source` header is present, the system SHALL log its value under `forwardSource` field and SHALL NOT alter routing or response status.
- **Estado:** PASS
- **Código:** `forward-key.ts:88-98` — lee `request.headers[FORWARD_SOURCE_HEADER]`, trunca a 100 chars (`FORWARD_SOURCE_LOG_MAX`), llama `request.log.info({ forwardSource: truncatedSource }, ...)`. El handler continúa sin alterar routing.
- **Test:** `forward-key.test.ts:201-261` — "AC-6: x-wasiai-source logged via pino, no routing effect" → verifica `res.statusCode === 200` + `logs.find(l => l.forwardSource === 'v2-proxy')` definido PASS.
- **Evidencia run:** `vitest run forward-key.test.ts` → AC-6 test PASS (línea 8 del output verbose).

### AC-7
**Texto:** WHEN `TIMEOUT_COMPOSE_MS` is not set, the system SHALL use a default timeout of 180000ms, and the unit test SHALL verify this new default.
- **Estado:** PASS
- **Código:** `compose.ts:29` — `parseInt(process.env.TIMEOUT_COMPOSE_MS ?? '180000', 10)`. Bump de 120000 → 180000 confirmado.
- **Test:** `timeout.test.ts:80-85` — "WKH-65 AC-7: compose timeout uses 180s by default" → `expect(timeoutMs).toBe(180000)` PASS.
- **Evidencia run:** `vitest run timeout.test.ts` → AC-7 test PASS (línea 13 del output verbose).

### AC-8
**Texto:** WHEN the full test suite is executed, the system SHALL pass all 612 baseline tests PLUS a minimum of 4 new tests covering AC-1, AC-3, AC-4, and AC-5.
- **Estado:** PASS
- **Código:** 9 nuevos tests en `forward-key.test.ts` + 1 en `timeout.test.ts` = 10 nuevos. Los 4 obligatorios (AC-1, AC-3, AC-4, AC-5) cubiertos. Suite total: 621 tests.
- **Test:** full suite run → `Test Files 58 passed (58) / Tests 621 passed (621)`.
- **Evidencia run:** `npx vitest run` → 621/621 PASS (exit 0). Baseline 612 + 9 nuevos (forward-key) + verificado el nuevo AC-7 en timeout.test.ts.

---

## Gates operacionales

| Gate | Estado | Evidencia |
|------|--------|-----------|
| G1 — 621/621 tests | PASS | `npx vitest run` → `Tests 621 passed (621)` (58 test files) |
| G2 — TypeScript strict | PASS | `npx tsc --noEmit` → exit 0, output vacío |
| G3 — Lint archivos WKH-65 | PASS | `npx biome check src/middleware/forward-key.ts src/routes/compose.ts` → "Checked 2 files in 3ms. No fixes applied." |
| G4 — Backward compat (env unset) | PASS | `forward-key.test.ts:36-48` — 2 tests AC-1 confirman que `requireForwardKey()` retorna `[]` cuando env unset o empty. `...[]` en compose/orchestrate es no-op. 621 tests pasan sin var seteada. |
| G5 — Drift detection | PASS (pre-existing nit) | Ver sección abajo |

**Nota G3:** `npx biome check src/routes/orchestrate.ts` reporta 1 formatter error en líneas 90-91 (`const status =` ternario en 2 líneas vs 1). Esta condición existe identicamente en `main` antes de WKH-65 (verificado con `git stash`). WKH-65 no introdujo ni modifica ese bloque — el diff de la rama solo agrega el import y el preHandler spread. Es deuda técnica pre-existente de WKH-61, fuera del scope de esta HU.

---

## Drift detection (G5)

**Archivos modificados por la rama** (`git diff --name-only main...HEAD`):

| Archivo | Scope IN | Justificación |
|---------|----------|---------------|
| `src/middleware/forward-key.ts` | SI (NEW) | Core del work-item |
| `src/middleware/forward-key.test.ts` | SI (NEW) | Tests obligatorios |
| `src/routes/compose.ts` | SI (UPDATE) | Wiring forward-key + timeout bump |
| `src/routes/orchestrate.ts` | SI (UPDATE) | Wiring forward-key |
| `src/middleware/timeout.test.ts` | SI (UPDATE) | AC-7 requiere test en timeout.test.ts |
| `.env.example` | SI (UPDATE) | Documentar WASIAI_V2_FORWARD_KEY + TIMEOUT_COMPOSE_MS |
| `doc/sdd/064-wkh-65-a2a-forward-key/auto-blindaje.md` | NO — doc | Fix-pack doc: auto-blindaje registra MNR-2 y CR-NIT-2 resolutions. No es código fuente. Justificado. |

**Scope OUT respetado:** no se tocaron `src/services/gasless*`, `src/services/facilitator*`, ni se modificó lógica de `requirePaymentOrA2AKey`. Sin rate-limit nuevo. Sin replay protection.

**Drift: 0 archivos no justificados.**

---

## Gates confirmados desde CR report

CR report (`cr-report.md`) documenta:
- `tsc --noEmit` exit 0 ✓
- `vitest run forward-key.test.ts timeout.test.ts` → 13/13 PASS ✓
- 8/8 ACs cubiertos en código + test ✓
- 7/7 CDs cumplidos ✓

F4 re-ejecutó gates para confirmar baseline completa (621 tests) y G3 lint — sin re-ejecutar selectivamente lo ya validado por CR.

---

## Resumen

- ACs PASS: 8/8
- Gates PASS: 5/5
- Drift: 0 archivos no justificados
- Issues residuales: 0 bloqueantes. 1 formatter nit pre-existente en orchestrate.ts (TD de WKH-61, fuera de scope WKH-65).
- AR menores: todos cerrados en fix-pack dcbb734 (HMAC compare, env hardening MNR-2, log capping, test guards CR-NIT-2).

**Ready for DONE: YES**
