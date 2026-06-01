# CR Report — [WKH-107] [AVAX-BEARER] — Code Review

> **Veredicto: APROBADO**
> Fecha: 2026-06-01
> Revisor: nexus-adversary

---

## Resumen

Code review del cambio de wiring de auth en el Avalanche adapter. 3 archivos revisados. 8 tests nuevos. AC-1..AC-7 mapeados con evidencia archivo:línea. Cero findings.

---

## Findings

**BLOQUEANTE**: 0
**MENOR**: 0

---

## Mapeo AC → Implementación + Tests

| AC | Descripción | Implementación (archivo:línea) | Test (archivo:línea) |
|----|-------------|-------------------------------|----------------------|
| AC-1 | `verifyX402` manda bearer con key configurada | `src/adapters/avalanche/payment.ts:244-248` — `const apiKey = getFacilitatorApiKey(); const headers: Record<string,string> = {'Content-Type':'application/json'}; if (apiKey) headers.Authorization = \`Bearer ${apiKey}\`` | `src/adapters/__tests__/avalanche.test.ts` T-AC1: `init.headers.Authorization === 'Bearer test-facilitator-key'` + url match `/verify$` |
| AC-2 | `settleX402` manda bearer con key configurada | `src/adapters/avalanche/payment.ts:289-293` — idéntica construcción de headers en el fetch a `/settle` | `src/adapters/__tests__/avalanche.test.ts` T-AC2: `init.headers.Authorization === 'Bearer test-facilitator-key'` + url match `/settle$` |
| AC-3 | Fallback `AVALANCHE_FACILITATOR_API_KEY` → `FACILITATOR_API_KEY` | `src/adapters/avalanche/payment.ts:151-157` — `getFacilitatorApiKey()`: `process.env.AVALANCHE_FACILITATOR_API_KEY?.trim() \|\| process.env.FACILITATOR_API_KEY?.trim() \|\| undefined` | T-AC3a: solo `FACILITATOR_API_KEY` seteada → `Bearer shared-key`; T-AC3b: ambas seteadas → gana `AVALANCHE_FACILITATOR_API_KEY` |
| AC-4 | Sin key → header omitido, fetch completa sin throw | `src/adapters/avalanche/payment.ts:244,289` — guard `if (apiKey)` antes de asignar `headers.Authorization`; sin key la clave no existe en el objeto | T-AC4: `expect(init.headers.Authorization).toBeUndefined()` en verify y settle; T-AC4-empty: key = `'   '` (whitespace) → header también ausente |
| AC-5 | Key nunca en body ni en mensajes de error | `buildX402CanonicalBody` (l.203-224) no modificado; path error 5xx no logea apiKey | T-AC5: `JSON.parse(init.body)` no contiene la key; en path 5xx `result.error` no incluye la key |
| AC-6 | Key solo desde env vars, nunca hardcodeada | `src/adapters/avalanche/payment.ts:151-157` — único acceso vía `process.env.*`; grep de literales: 0 hits | T-AC1/T-AC2 usan `process.env.AVALANCHE_FACILITATOR_API_KEY = 'test-facilitator-key'` (key de prueba, no real) |
| AC-7 | `.env.example` documenta `AVALANCHE_FACILITATOR_API_KEY` | `.env.example:188-193` — bloque "Avalanche facilitator API key" con cadena de fallback y nota "NUNCA commitear / NUNCA en logs", espejo del bloque Base (l.534-539) | T-AC7 (documental): `readFileSync('.env.example')` + `expect(src).toContain('AVALANCHE_FACILITATOR_API_KEY')` + `toContain('FACILITATOR_API_KEY')` + `toMatch(/logs/i)` |

---

## Revision de calidad del codigo nuevo

### Helper `getFacilitatorApiKey()` (`src/adapters/avalanche/payment.ts:151-157`)

- Colocado inmediatamente tras `getFacilitatorUrl()` (l.143-149) — posicion consistente con el patron Base.
- Retorna `string | undefined` — tipado correcto, sin `any`.
- Cadena `?.trim() ||` — defensiva contra whitespace. Consistente con WKH-106 (base/payment.ts:173-179). Patron 1:1.
- Sin efectos secundarios. Sin logging.

### Headers condicionales en `verifyX402` y `settleX402`

- `const headers: Record<string, string>` — tipado explícito, sin `any` (CD-8).
- `if (apiKey) headers.Authorization = \`Bearer ${apiKey}\`` — la clave `Authorization` literalmente no existe en el objeto cuando no hay key. Esto es verificable con `toBeUndefined()` en tests (DT-7).
- Patrón 1:1 con `base/payment.ts:269-273` y `base/payment.ts:314-318`.

### Tests (`src/adapters/__tests__/avalanche.test.ts`)

- Bloque `describe` nuevo, independiente — no contamina los tests existentes.
- `beforeEach`: `delete process.env.AVALANCHE_FACILITATOR_API_KEY; delete process.env.FACILITATOR_API_KEY` — CD-10 respetado (no `= undefined`).
- Cada test setea su propio `mockFetch.mockResolvedValueOnce(...)` — CD-9 respetado (no dependencia de cola heredada).
- Keys de prueba literales (`'test-facilitator-key'`, `'shared-key'`) — CD-12 respetado, sin keys reales.
- `afterEach`: limpia ambas env vars de key + URL vars.
- 8 tests cubren los 7 ACs (AC-3 tiene 2 sub-tests: fallback + precedencia).
- 39/39 tests verdes (8 nuevos + 31 existentes sin regresión).

### `.env.example`

- Bloque en l.188-193, sección "Avalanche facilitator override (optional)", inmediatamente tras `AVALANCHE_FACILITATOR_URL=`.
- Formato espejo del bloque Base (l.534-539): comentarios de propósito + cadena de fallback + nota seguridad + var sin valor real.
- CD-1 respetado: `.env.example` lista la var sin valor real.

---

## Checks de calidad

| Check | Resultado |
|-------|-----------|
| `tsc --noEmit` | exit 0 — 0 errores |
| `npm run lint` (biome check) | limpio |
| `npm test` (vitest) | 39/39 PASS |
| Sin `any` explícito en código nuevo | confirmado |
| Sin hardcode de key | confirmado |
| Archivos fuera de scope NO tocados | confirmado (types.ts, base/payment.ts, kite, facilitator repo) |
| DELTA-1 (tipo `'fuji'`) | correcto |
| DELTA-2 (helper sin `network`) | correcto |
| DELTA-3 (header archivo intacto) | confirmado |

---

## Conclusion

Implementación limpia. Los 3 deltas Avalanche respecto a WKH-106 estan correctamente aplicados. Los CD-9/10/11/12 (auto-blindaje historico de WKH-104/102) funcionaron: Dev los siguio al pie de la letra, primer intento verde. Listo para F4.
