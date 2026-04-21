# Code Review (CR) — WKH-SEC-01

**Veredicto:** APROBADO (0 BLOQUEANTES, 3 MENORES)

**Método:** Verificación CD-1..CD-11 con archivo:línea + test quality review sobre los 7 tests nuevos

**Fecha:** 2026-04-20

---

## Veredicto Final

- **Bloqueantes:** 0
- **Menores:** 3 (consolidados con AR)
- **Estado:** APROBADO

---

## Constraint Directives — Verificación

| CD | Descripción | Evidencia (archivo:línea) | Status |
|----|-------------|--------------------------|--------|
| CD-1 | Firma de `requirePaymentOrA2AKey` NO modificada | `src/routes/registries.ts:47-50, 102-105, 129-132` — importado y usado sin cambios | ✅ PASS |
| CD-2 | `GET /registries` y `GET /registries/:id` sin autenticación | `src/routes/registries.ts:14, 26-41` — sin `preHandler` | ✅ PASS |
| CD-3 | CORS origins leídos desde env var, NO hardcodeados | `src/index.ts:36-40` — `CORS_ALLOWED_ORIGINS` env var con `split(',').map(s => s.trim())` | ✅ PASS |
| CD-4 | 276+ tests previos continúan pasando | Test suite: 343 tests previos PASS + 7 nuevos PASS = 350 total | ✅ PASS |
| CD-5 | NO `any` explícito en código nuevo | `src/routes/registries.ts`, `src/middleware/security-headers.ts`, `src/__tests__/cors.test.ts`, `src/routes/registries.test.ts` | ✅ PASS |
| CD-6 | Header HSTS emitido incondicionalmente | `src/middleware/security-headers.ts:12` — `reply.header('strict-transport-security', ...)` sin condicional | ✅ PASS |
| CD-7 | CORS test aislado del resto (intent por CD-7) | `src/__tests__/cors.test.ts` — setup duplicado intencionalmente para aislamiento | ✅ PASS |
| CD-8 | Story File respetado — no hay código adicional al scope | Scope IN: 7 archivos tocados exactamente (POST/DELETE/PATCH de registries, CORS en index, HSTS en security-headers, 3 test files, .env.example) | ✅ PASS |
| CD-9 | Descripción única en cada middleware de x402 | 7 `description` strings — no duplicados | ✅ PASS |
| CD-10 | Rate limiting NO agregado a registries POST/PATCH/DELETE | `src/routes/registries.ts` — solo `preHandler: [...requirePaymentOrA2AKey(...)]`, sin rate limit | ✅ PASS |
| CD-11 | Tests usan fixtures/mocks consistentes | `src/__tests__/cors.test.ts` y `src/routes/registries.test.ts` — mockeos aislados, inyección clara, assertions específicas | ✅ PASS |

---

## Test Quality Review

### 7 Tests Nuevos

| # | Test | Archivo | Tipo | Mocks | Assertions | Status |
|---|------|---------|------|-------|------------|--------|
| 1 | AC-1: POST /registries sin auth → 401 | `src/routes/registries.test.ts` | Unit | identityService = null | `expect(res.status).toBe(401)` | ✅ PASS |
| 2 | AC-2: DELETE /:id sin auth → 403 | `src/routes/registries.test.ts` | Unit | identityService = null | `expect(res.status).toBe(403)` | ✅ PASS |
| 3 | AC-2b: PATCH /:id sin auth → 403 | `src/routes/registries.test.ts` | Unit | identityService = null | `expect(res.status).toBe(403)` | ✅ PASS |
| 4 | AC-3: HSTS header en respuesta | `src/middleware/security-headers.test.ts` (extendido) | Unit | registerSecurityHeaders mock | `expect(response.headers['strict-transport-security']).toBe('...')` | ✅ PASS |
| 5 | AC-4: CORS prod + allowlist → rechaza origin | `src/__tests__/cors.test.ts` | Integration | NODE_ENV=production | `expect(res.headers['access-control-allow-origin']).toBeUndefined()` | ✅ PASS |
| 6 | AC-5: CORS dev → wildcard | `src/__tests__/cors.test.ts` | Integration | NODE_ENV=development | `expect(res.headers['access-control-allow-origin']).toBe('*')` | ✅ PASS |
| 7 | AC-6: CORS prod + no allowlist → bloquea todo | `src/__tests__/cors.test.ts` | Integration | NODE_ENV=production, CORS_ALLOWED_ORIGINS="" | `expect(res.headers['access-control-allow-origin']).toBeFalsy()` | ✅ PASS |

### Mocks & Setup

- ✅ `identityService.lookupByHash()` mockeado en tests de auth
- ✅ `Fastify()` raíz en cada suite para aislamiento
- ✅ Env vars setadas correctamente en `beforeAll`/`afterAll`
- ✅ `app.ready()` antes de `inject()`

### Aislamiento & Independencia

- ✅ Cada test es independiente (no hay orden implícito)
- ✅ Cleanup en `afterAll` (por ej., `await app.close()`)
- ✅ Sin dependencias cross-test

---

## Hallazgos MENORES (Consolidados con AR)

| # | Hallazgo | Decisión |
|---|----------|----------|
| M2 | Nombre de test legacy AC-3 colisiona con nuevo AC-3 | Aceptado — Dev prefijó correctamente con `describe('security-headers', ...)` |
| M3 | `prevPaymentWallet` capturado pero no seteado | Aceptado — no afecta correctitud |
| M4 | CORS test logic duplicada (intencional) | Aceptado — mejora legibilidad y aislamiento |

---

## Conclusión

Todas las CD (1-11) están satisfechas con evidencia concreta (archivo:línea). Los 7 tests nuevos tienen mocks apropiados, aserciones específicas y aislamiento correcto. Los 3 hallazgos MENORES son idénticos a los de AR y no bloquean.

**APROBADO para pasar a F4 (QA/Validation).**

---

*Generado por nexus-adversary (CR) | 2026-04-20*
