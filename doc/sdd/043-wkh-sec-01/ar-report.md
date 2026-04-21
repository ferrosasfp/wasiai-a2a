# Adversarial Review (AR) — WKH-SEC-01

**Veredicto:** APROBADO (0 BLOQUEANTES, 5 MENORES)

**Método:** Ataque empírico sobre commit 8af2155 con node+fastify.inject sobre los 7 archivos del Scope IN

**Fecha:** 2026-04-20

---

## Veredicto Final

- **Bloqueantes:** 0
- **Menores:** 5
- **Estado:** APROBADO

---

## Hallazgos MENORES

| # | Hallazgo | Ubicación | Severidad | Impacto | Decisión |
|---|----------|-----------|-----------|---------|----------|
| M1 | Mock `update()` faltante en `setup.ts` E2E | `src/__tests__/setup.ts` | MENOR | Tests nuevos no pueden mockear `registriesService.update()` | Fuera de scope — nueva HU |
| M2 | Nombre de test legacy AC-3 colisiona con nuevo AC-3 de WKH-SEC-01 | `src/middleware/security-headers.test.ts` | MENOR | Confusión nominativa, pero Dev prefijó correctamente con `describe('security-headers', ...)` | Aceptado — no hay colisión en ejecución |
| M3 | `prevPaymentWallet` capturado pero no seteado en test de registries | `src/routes/registries.test.ts` | MENOR | Ruido cosmético — variable local sin uso | Aceptado — no afecta correctitud |
| M4 | CORS logic duplicada en test (setup vs inline) | `src/__tests__/cors.test.ts` | MENOR | Intencional por CD-7 (aislar test de CORS del resto) | Aceptado — mejora legibilidad |
| M5 | AC-4 assertion asimétrica vs AC-6 (estilo de validación) | `src/__tests__/cors.test.ts` | MENOR | `expect(response.headers[...]).toBeUndefined()` vs `expect(...).toBeFalsy()` | Aceptado — ambas formas son válidas en vitest |

---

## Verificaciones Empíricas (APROBADAS)

### Casing de Headers
- ✅ Header `strict-transport-security` → toLowerCase normalizado por Fastify
- ✅ Header `access-control-allow-origin` → lowercase en respuesta
- ✅ Preflight `Access-Control-Allow-Methods` → case insensitive per spec

### Authorization Schemes
- ✅ `Authorization: Bearer wasi_a2a_*` → parseado correctamente en `a2a-key.ts`
- ✅ `x-a2a-key: <value>` → scheme alternativo funciona

### CSV Edge Cases (CORS_ALLOWED_ORIGINS)
- ✅ Empty string `""` → falsy, parsed como `[]`
- ✅ Commas only `","` → parsed como `['']`, rejected como invalid origin
- ✅ Whitespace `"https://app.io , https://wasiai.io"` → trimmed correctamente con `split(',').map(s => s.trim())`

### HSTS Header
- ✅ Present en todas las respuestas (4xx, 5xx, 2xx)
- ✅ Valor exacto: `max-age=31536000; includeSubDomains; preload`

### CORS Behavior
- ✅ Production + `CORS_ALLOWED_ORIGINS` set → rechaza origins no listados
- ✅ Production + `CORS_ALLOWED_ORIGINS` vacío → bloquea todos (`Access-Control-Allow-Origin` no asignado)
- ✅ Development (default) → `*` permitido
- ✅ Preflight OPTIONS con disallowed origin → 403 (verificado empíricamente)

### Autenticación en /registries
- ✅ `POST /registries` sin credenciales → 401/403
- ✅ `DELETE /registries/:id` sin credenciales → 401/403
- ✅ `PATCH /registries/:id` sin credenciales → 401/403
- ✅ Con credenciales válidas → request continúa a business logic

### Descripción Única en x402
- ✅ 7 archivos tocados tienen 7 `description` strings distintos (sin duplicados)

---

## Resultados de Test

- **Total Tests:** 350 PASS (7 nuevos + 343 existentes)
- **Lint baseline:** 6 errores pre-existentes, cero nuevos
- **Drift:** 0

---

## Conclusión

Todos los AC 1-7 están satisfechos empíricamente. Los 5 hallazgos MENORES son de baja severidad y no bloquean la HU. Aceptados como deuda técnica menor para housekeeping futuro.

**APROBADO para pasar a Code Review.**

---

*Generado por nexus-adversary (AR) | 2026-04-20*
