# CR Report — [WKH-106] [BASE-02] — a2a manda `Authorization: Bearer` al facilitator en verify/settle Base

> **Code Review — post-AR.**
> Fecha: 2026-05-31
> Reviewer: nexus-adversary (harness mode — veredicto transcrito por nexus-docs)

---

## Veredicto: APROBADO

**BLOQUEANTE: 0 | MENOR: 0**

Todos los ACs mapeados a implementación con evidencia `archivo:línea`. Patrón consistente con el exemplar `src/services/compose.ts:44` ya existente en el codebase.

---

## Mapa AC → Implementación

| AC | Descripción | Implementación (archivo:línea) | Tests (archivo:línea) | Estado |
|----|-------------|--------------------------------|-----------------------|--------|
| AC-1 | `verifyX402` manda `Authorization: Bearer` con key configurada | `src/adapters/base/payment.ts:269-273` — `const apiKey = getFacilitatorApiKey(); if (apiKey) headers.Authorization = \`Bearer ${apiKey}\`` | `base.test.ts:533-556` — T-AC1 | PASS |
| AC-2 | `settleX402` manda `Authorization: Bearer` con key configurada | `src/adapters/base/payment.ts:314-318` — mismo patrón en settle | `base.test.ts:558-582` — T-AC2 | PASS |
| AC-3 | Cadena de fallback `BASE_FACILITATOR_API_KEY` → `FACILITATOR_API_KEY` | `src/adapters/base/payment.ts:173-178` — `getFacilitatorApiKey()`: `BASE_FACILITATOR_API_KEY?.trim() \|\| FACILITATOR_API_KEY?.trim() \|\| undefined` | `base.test.ts:584-627` — T-AC3a + T-AC3b (precedencia) | PASS |
| AC-4 | Sin key → header omitido, fetch completa sin throw | `src/adapters/base/payment.ts:269,314` — `if (apiKey)` guarda la asignación; sin key no existe la clave `Authorization` en el objeto | `base.test.ts:629-665` — T-AC4 + T-AC4-empty (vacío) | PASS |
| AC-5 | Key nunca en body ni en mensajes de error | `src/adapters/base/payment.ts:227-248` — `buildX402CanonicalBody` no tocado; path de error solo serializa `result.error` del facilitator | `base.test.ts:667-700` — T-AC5 | PASS |
| AC-6 | Key solo desde env vars, nunca hardcodeada | `src/adapters/base/payment.ts:173-178` — solo `process.env.*`; `.env.example:534-541` documenta var sin valor real | `base.test.ts:533-627` — todos los tests de AC-1..3 usan literales, ninguno hardcodea key real | PASS |
| AC-7 | Caveat BASE-01 stale eliminado y reescrito | `src/adapters/base/payment.ts:27-35` — caveat ahora documenta que el facilitator settlea Base Sepolia real y exige bearer | `base.test.ts:702-715` — T-AC7: `readFileSync` + `not.toContain('NO soporta Base RPC')` + `not.toContain('DT-11')` | PASS |

---

## Consistencia con el codebase

El patrón implementado es el espejo exacto del exemplar ya existente:

```
src/services/compose.ts:44
  if (registry.auth?.type === 'bearer') {
    headers.Authorization = `Bearer ${registry.auth.value}`;
  }
```

La implementación de WKH-106 en `payment.ts` es idéntica en estructura:

```
src/adapters/base/payment.ts:269-273
  const apiKey = getFacilitatorApiKey();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
```

No se inventó ningún patrón nuevo. El helper `getFacilitatorApiKey()` espeja directamente `getFacilitatorUrl()` (l.163-170) del mismo archivo. DRY y consistente.

---

## Calidad de los tests (bloque BASE-02)

El bloque `describe('Base payment adapter — facilitator bearer auth (BASE-02)')` en `src/adapters/__tests__/base.test.ts:529-716` cubre:

- 8 tests, todos los ACs representados
- `beforeEach` usa `mockFetch.mockReset()` + `delete process.env.*` (CD-8/9 cumplidos)
- `afterEach` limpia las vars de env
- Asserts sobre `init.headers` extraídos de `mockFetch.mock.calls[0]` (patrón base.test.ts:280)
- T-AC7 usa `readFileSync` del source del adapter — técnica válida para verificar limpieza documental

Tests preexistentes (35 tests, bloques `contract`, `gasless`, `attestation`) siguen verdes sin modificación — no-regresión de AC-4 confirmada.

---

## Hallazgos

### BLOQUEANTE
*Ninguno.*

### MENOR
*Ninguno.*

---

## Decisión

**Aprobado para F4 sin condiciones.**
