# Report — HU [WKH-106] [BASE-02] — a2a manda `Authorization: Bearer` al facilitator en verify/settle Base

## Resumen ejecutivo

Cambio quirúrgico de wiring de auth: el Base adapter de `wasiai-a2a` (`src/adapters/base/payment.ts`) ahora manda `Authorization: Bearer <key>` en todos los calls a `/verify` y `/settle` del facilitator, que lo exige (`requireFacilitatorKey`, timing-safe). La key se resuelve por env con degradación segura (`BASE_FACILITATOR_API_KEY?.trim() || FACILITATOR_API_KEY?.trim() || undefined`). El facilitator ya settlea Base Sepolia real (tx verificado on-chain). Status final: **DONE**. Archivos clave: `src/adapters/base/payment.ts`, `src/adapters/__tests__/base.test.ts`, `.env.example`.

**Re-scope documentado**: el work-item original del analyst asumía un "scaffold vacío" en `wasiai-facilitator` — incorrecto. El facilitator estaba completo, auditado A+ (616/616 tests), deployado y settleando. El único gap real era el bearer faltante en el cliente. El work-item fue reescrito con ese contexto antes de F2.

---

## Pipeline ejecutado

- **F0**: project-context cargado. Re-scope descubierto y documentado antes de F1 (facilitator completo, no scaffold).
- **F1**: `work-item.md` — HU_APPROVED (clinical review, modo AUTO, 2026-05-31). 7 ACs EARS, 7 CDs, 5 DTs, grounding con evidencia de líneas reales. SDD_MODE: mini (cambio S).
- **F2**: `sdd.md` — SPEC_APPROVED (2026-05-31). Confirmó DT-1 (nombre `BASE_FACILITATOR_API_KEY → FACILITATOR_API_KEY`), resolvió missing input Avalanche (→ TD-1), agregó DT-6/DT-7 (helper + construcción headers), CD-8..CD-11 (anti-blindaje histórico WKH-104/102).
- **F2.5**: `story-WKH-106.md` generado. Waves W0 (audit 4 anclas), W1 (impl 3 zonas + doc), W2 (8 tests).
- **F3**: Implementación — 1 wave, sin desviaciones. 3 archivos tocados. 8 tests nuevos escritos. 43/43 tests verdes. `tsc --noEmit` exit 0. lint limpio.
- **AR**: APROBADO — 0 BLOQUEANTE, 0 MENOR. Destacó que `?.trim() ||` es más defensivo que `??` (colapsa whitespace + vacío).
- **CR**: APROBADO — 0 findings. AC-1..7 mapeados con `archivo:línea`. Patrón consistente con exemplar `compose.ts:44`.
- **F4**: APROBADO PARA DONE — 7 ACs PASS con evidencia `archivo:línea`. Cero drift. CD-1/2/4/5/6/7 verificados.

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia (archivo:línea) |
|----|--------|---------------------------|
| AC-1: `verifyX402` manda bearer con key configurada | PASS | `src/adapters/base/payment.ts:269-273`; `base.test.ts:533-556` (T-AC1) |
| AC-2: `settleX402` manda bearer con key configurada | PASS | `src/adapters/base/payment.ts:314-318`; `base.test.ts:558-582` (T-AC2) |
| AC-3: fallback `BASE_FACILITATOR_API_KEY` → `FACILITATOR_API_KEY` | PASS | `src/adapters/base/payment.ts:173-178` (`getFacilitatorApiKey()`); `base.test.ts:584-627` (T-AC3a+3b) |
| AC-4: sin key → header omitido, fetch completa sin throw | PASS | `src/adapters/base/payment.ts:269,314` (guard `if (apiKey)`); `base.test.ts:629-665` (T-AC4+AC4-empty) |
| AC-5: key nunca en body ni en mensajes de error | PASS | `buildX402CanonicalBody` no tocado; `base.test.ts:667-700` (T-AC5) |
| AC-6: key solo desde env vars, nunca hardcodeada | PASS | solo `process.env.*`; `.env.example:534-541` sin valor real |
| AC-7: caveat BASE-01 stale eliminado y reescrito | PASS | `src/adapters/base/payment.ts:27-35` (caveat nuevo); `base.test.ts:702-715` (T-AC7 readFileSync) |

---

## Hallazgos finales

- **BLOCKEANTEs**: 0 detectados, 0 pendientes.
- **MENORs**: 0 detectados.
- **Observación positiva (AR)**: la implementación usa `?.trim() ||` en lugar de `??` — más defensivo para secrets desde env (colapsa `''` y whitespace a `undefined`, evita `Bearer ` vacío).

---

## Auto-Blindaje consolidado

Esta HU no generó nuevos anti-patrones en F3 (Dev pasó los 4 checks al primer intento). Los CDs CD-8..CD-11 del SDD incorporaron preventivamente 3 anti-patrones históricos de HUs anteriores:

| # | Anti-patrón | Origen | CDs que lo previenen | ¿Se disparó en WKH-106? |
|---|-------------|--------|----------------------|-------------------------|
| 1 | `process.env.X = undefined` coacciona a string `"undefined"` truthy | WKH-104 auto-blindaje#1 | CD-9: usar `delete process.env.X` | NO — Dev usó `delete` correctamente |
| 2 | `vi.clearAllMocks()` NO limpia la cola de `mockResolvedValueOnce` | WKH-104 auto-blindaje#2 | CD-8: `mockFetch.mockReset()` al inicio de cada test | NO — Dev usó `mockReset()` |
| 3 | Biome modifica archivos que luego lint rechaza sin `--write` previo | WKH-102 auto-blindaje#2 | CD-10: `biome check --write` antes de `npm run lint` | NO — Dev siguió el orden |
| 4 | `?.trim() \|\|` vs `??` para secrets — whitespace/vacío bypassa `??` | Este SDD (DT-6) | CD-4: degradación segura garantizada | NO (preventivo) — implementado correctamente |

---

## Archivos modificados

### `wasiai-a2a` (3 archivos)

**Payment path (`src/adapters/base/`):**
- `src/adapters/base/payment.ts` — `getFacilitatorApiKey()` helper (l.173-178) + headers condicionales en `verifyX402` (l.269-273) y `settleX402` (l.314-318) + caveat BASE-01 reescrito (l.27-35)

**Tests (`src/adapters/__tests__/`):**
- `src/adapters/__tests__/base.test.ts` — bloque nuevo `describe('Base payment adapter — facilitator bearer auth (BASE-02)')` con 8 tests (l.529-716)

**Documentación:**
- `.env.example` — sección Base: documenta `BASE_FACILITATOR_API_KEY` con cadena de fallback y nota "NUNCA en logs" (l.534-541)

**Archivos NOT tocados (scope OUT confirmado):**
- `src/adapters/types.ts` — interfaces inmutables (CD-6)
- `src/adapters/avalanche/payment.ts` — TD-1 (ver abajo), fuera de scope
- `buildX402CanonicalBody` — intacto (CD-6)
- Repo `wasiai-facilitator` — no se toca (CD-5)

---

## Tech Debt detectado — pendiente backlog

### TD-1: Avalanche tiene el MISMO gap de bearer faltante

**Detectado en**: F2 (SDD §8) al verificar el missing input #2 del work-item.

**Descripción**: `src/adapters/avalanche/payment.ts` manda solo `'Content-Type': 'application/json'` en:
- `verifyX402` (l.238-243)
- `settleX402` (l.278-283)

Su `getFacilitatorUrl()` (l.144-148) usa `AVALANCHE_FACILITATOR_URL ?? WASIAI_FACILITATOR_URL ?? default`. Si el facilitator de Avalanche exige bearer auth (igual que el de Base), un settle real daría HTTP 401.

**Recomendación**: abrir HU `AVAX-BEARER` espejando este SDD con var `AVALANCHE_FACILITATOR_API_KEY → FACILITATOR_API_KEY`. Scope idéntico: 1 helper + 2 fetch headers + .env.example.

**Scope OUT confirmado**: no se tocó en WKH-106 (work-item §Scope OUT).

### TD-2: Kite no aplica

`kite-ozone/payment.ts` usa modo Pieverse / firma on-chain distinta. No comparte el patrón fetch-a-facilitator. Descartado.

---

## Pasos ops pendientes (NO son deuda — son config de despliegue)

Estos pasos los ejecuta el operador humano en Railway. No bloquean el merge del código.

1. **Setear `BASE_FACILITATOR_API_KEY` en Railway (wasiai-a2a)**: el valor real de la API key del facilitator deployado. Sin esta var, el adapter opera en modo degradado (sin bearer → el facilitator de prod dará 401 en verify/settle reales).

2. **Activar `WASIAI_DOWNSTREAM_X402=true` en Railway (wasiai-a2a)** (si no está activo): habilita el path de settle downstream que usa el adapter. Precondición para el smoke E2E real.

3. **Smoke E2E real (BASE-04)**: una vez que (1) y (2) estén activos, correr el smoke contra el facilitator deployado para confirmar que el bearer cierra el 401. Este smoke vive en la HU BASE-04 / ops.

---

## Evidencia on-chain de referencia

El facilitator ya settlea Base Sepolia real (previo a esta HU):
- **Tx**: `0xb9b156e684f85379311167ec20afb01900194a6436a93df7a660f222ca35521d`
- **Block**: 42260832 (Base Sepolia)
- **Status**: 0x1 (success)
- **Logs**: 2 eventos Transfer EIP-3009

Esta HU habilita que `wasiai-a2a` participe en ese flujo (antes: 401; después: settle real posible).

---

## Lecciones para próximas HUs

1. **Grounding antes de F1 evita re-scope costoso**: el analyst asumió "scaffold vacío" en el facilitator. La lectura directa del repo antes de redactar el work-item habría revelado el estado real (completo, auditado, deployado). Tomarse 5 minutos de `ls`/`grep` sobre el repo externo antes de escribir el resumen ahorra reescrituras del work-item.

2. **`?.trim() ||` es el patrón correcto para secrets desde env**: `??` solo descarta `null`/`undefined`; una variable vacía (`KEY=''`) o con whitespace (`KEY='  '`) bypassa `??` y genera un header inválido. Para cualquier secret leído desde env que controle presencia/ausencia de un header, usar `?.trim() ||`.

3. **Los anti-blindajes históricos funcionan**: CD-8/9/10 del SDD (extraídos de WKH-104/102) evitaron que el Dev caiga en los 3 bugs recurrentes. El Dev pasó los 4 checks al primer intento. Incorporar auto-blindaje previo al Story File antes de F3 es una inversión rentable.

4. **Wiring de auth es QUALITY aunque el cambio sea S**: el payment path (verify/settle) tiene riesgo de regresión alto — un `Bearer undefined` silencioso habría pasado tests sin `?.trim() ||`. La metodología QUALITY con AR/CR detectó (y previno) ese edge case en el SDD, antes de que llegara a código.
