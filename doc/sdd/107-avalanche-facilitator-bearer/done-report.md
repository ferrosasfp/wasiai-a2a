# Report — HU [WKH-107] [AVAX-BEARER] — a2a manda `Authorization: Bearer` al facilitator en verify/settle Avalanche

## Resumen ejecutivo

Cambio quirúrgico de wiring de auth: el Avalanche adapter de `wasiai-a2a` (`src/adapters/avalanche/payment.ts`) ahora manda `Authorization: Bearer <key>` en todos los calls a `/verify` y `/settle` del facilitator, que lo exige (`requireFacilitatorKey`, timing-safe, obligatorio fuera de `NODE_ENV=test`). La key se resuelve por env con degradación segura (`AVALANCHE_FACILITATOR_API_KEY?.trim() || FACILITATOR_API_KEY?.trim() || undefined`). Cierra el **TD-1 de WKH-106** ("Avalanche tiene el mismo gap de bearer faltante"). Status final: **DONE**. Archivos clave: `src/adapters/avalanche/payment.ts`, `src/adapters/__tests__/avalanche.test.ts`, `.env.example`.

---

## Pipeline ejecutado

- **F0**: project-context cargado. WKH-107 identificado como espejo de WKH-106 para cerrar TD-1 (Avalanche bearer gap). Grounding con evidencia de lineas reales verificadas en `src/adapters/avalanche/payment.ts`.
- **F1**: `work-item.md` — HU_APPROVED (clinical review, modo AUTO, 2026-06-01). 7 ACs EARS, 9 CDs, 5 DTs, grounding con evidencia archivo:linea. SDD_MODE: mini (cambio S, categoría ENABLEMENT/WIRING).
- **F2**: `sdd.md` — SPEC_APPROVED (2026-06-01). Confirmó DT-1 (nombre `AVALANCHE_FACILITATOR_API_KEY → FACILITATOR_API_KEY`), resolvió missing input del work-item, agregó DT-6/DT-7/DT-8 (helper + construcción headers + sin caveat stale), CD-9..CD-12 (auto-blindaje histórico WKH-104/102). 3 deltas Avalanche vs WKH-106 documentados y confirmados.
- **F2.5**: `story-WKH-107.md` generado. Waves W0 (audit 3 anclas + confirmación no-caveat), W1 (impl: helper + 2 headers + .env.example), W2 (8 tests).
- **F3**: Implementación — 1 wave, sin desviaciones. 3 archivos tocados. 8 tests nuevos escritos. 39/39 tests verdes. `tsc --noEmit` exit 0. lint limpio. 4 checks pasados al primer intento.
- **AR**: APROBADO — 0 BLOQUEANTE, 0 MENOR. Verificó no-leak de key, degradación segura (`||` vs `??`), header del archivo intacto (DELTA-3), Base adapter/types/buildX402CanonicalBody intactos, Avalanche mainnet excluido.
- **CR**: APROBADO — 0 findings. AC-1..7 mapeados a implementación + test con archivo:línea. Patrón 1:1 con `base/payment.ts:173-179` y `base/payment.ts:269-273`/`314-318`.
- **F4**: APROBADO PARA DONE — 7 ACs PASS con evidencia archivo:línea. Cero drift. CD-1..12 verificados.

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia (archivo:línea) |
|----|--------|---------------------------|
| AC-1: `verifyX402` manda bearer con key configurada | PASS | `src/adapters/avalanche/payment.ts:244-248`; `avalanche.test.ts` T-AC1 |
| AC-2: `settleX402` manda bearer con key configurada | PASS | `src/adapters/avalanche/payment.ts:289-293`; `avalanche.test.ts` T-AC2 |
| AC-3: fallback `AVALANCHE_FACILITATOR_API_KEY` → `FACILITATOR_API_KEY` | PASS | `src/adapters/avalanche/payment.ts:151-157` (`getFacilitatorApiKey()`); `avalanche.test.ts` T-AC3a+3b |
| AC-4: sin key → header omitido, fetch completa sin throw | PASS | guard `if (apiKey)` en l.244 y l.289; `avalanche.test.ts` T-AC4 + T-AC4-empty |
| AC-5: key nunca en body ni en mensajes de error | PASS | `buildX402CanonicalBody` no tocado; `avalanche.test.ts` T-AC5 |
| AC-6: key solo desde env vars, nunca hardcodeada | PASS | solo `process.env.*` en l.151-157; `.env.example:188-193` sin valor real |
| AC-7: `.env.example` documenta `AVALANCHE_FACILITATOR_API_KEY` | PASS | `.env.example:188-193` con cadena de fallback y nota "NUNCA en logs"; `avalanche.test.ts` T-AC7 (assert documental) |

---

## Hallazgos finales

- **BLOQUEANTEs**: 0 detectados, 0 pendientes.
- **MENORs**: 0 detectados.
- **Observación positiva (AR/CR)**: la implementación usa `?.trim() ||` en lugar de `??` — mas defensivo para secrets desde env (colapsa `''` y whitespace a `undefined`, evita `Bearer ` vacío). Patron idéntico al WKH-106.

---

## 3 Deltas Avalanche vs WKH-106 — verificacion final

| Delta | Descripción | Verificado |
|-------|-------------|------------|
| DELTA-1 | Tipo de red `'fuji' \| 'mainnet'` (NO `'testnet'`) — usado correctamente en tests (`{ network: 'fuji' }`) | PASS |
| DELTA-2 | `getFacilitatorApiKey()` NO toma `network` — helper module-level sin parametros, igual que `getFacilitatorUrl()` | PASS |
| DELTA-3 | Header del archivo (l.18-29) NO tocado — no habia caveat stale, no se reescribio nada | PASS |

---

## Auto-Blindaje consolidado

Esta HU no generó nuevos anti-patrones en F3 (Dev pasó los 4 checks al primer intento, igual que WKH-106). Los CDs CD-9..CD-12 del SDD incorporaron preventivamente los anti-patrones históricos de WKH-104/102, que funcionaron de nuevo:

| # | Anti-patrón | Origen | CDs que lo previenen | Disparado en WKH-107 |
|---|-------------|--------|----------------------|----------------------|
| 1 | `process.env.X = undefined` coacciona a string `"undefined"` truthy | WKH-104 auto-blindaje#1 | CD-10: usar `delete process.env.X` | NO — Dev usó `delete` correctamente |
| 2 | `vi.clearAllMocks()` NO limpia la cola de `mockResolvedValueOnce` | WKH-104 auto-blindaje#2 | CD-9: cada test setea su propio `mockResolvedValueOnce` | NO — Dev siguió el patrón |
| 3 | Biome modifica archivos que luego lint rechaza sin `--write` previo | WKH-102 auto-blindaje#2 | CD-11: `biome check --write` antes de `npm run lint` | NO — Dev siguió el orden |
| 4 | Key literal de prueba en tests — CD-12 | Nuevo en SDD WKH-107 (espejo WKH-106) | CD-12: usar key literal conocida (`'test-facilitator-key'`), nunca key real | NO (preventivo) — implementado correctamente |

**Nota**: los CDs 9/10/11 preventivos (auto-blindaje heredado de WKH-104/102, ya aplicados en WKH-106) funcionaron consecutivamente por segunda vez. El patrón de incorporarlos al SDD antes de F3 es claramente rentable.

---

## Archivos modificados

### `wasiai-a2a` (3 archivos)

**Payment path (`src/adapters/avalanche/`):**
- `src/adapters/avalanche/payment.ts` — `getFacilitatorApiKey()` helper (l.151-157) + headers condicionales en `verifyX402` (l.244-248) y `settleX402` (l.289-293). Header del archivo (l.18-29) intacto (DELTA-3).

**Tests (`src/adapters/__tests__/`):**
- `src/adapters/__tests__/avalanche.test.ts` — bloque nuevo `describe('Avalanche payment adapter — facilitator bearer auth (AVAX-BEARER)')` con 8 tests. Suite total: 39/39 PASS.

**Documentación:**
- `.env.example` — sección Avalanche facilitator: documenta `AVALANCHE_FACILITATOR_API_KEY` (l.188-193) con cadena de fallback y nota "NUNCA commitear / NUNCA en logs".

**Archivos NOT tocados (scope OUT confirmado):**
- `src/adapters/types.ts` — interfaces inmutables (CD-7)
- `src/adapters/base/payment.ts` — referencia de patrón, no scope (CD-6)
- `buildX402CanonicalBody` — intacto, transport-level (CD-7)
- Repo `wasiai-facilitator` — no se toca (CD-5)
- `src/adapters/kite-ozone/payment.ts` — Pieverse mode, no aplica (TD-1 SDD)

---

## Decisiones diferidas a backlog

- **TD-2 [smoke E2E real Avalanche]**: el valor real de la key en prod (Railway) + un smoke `/verify`+`/settle` real contra el facilitator deployado en Fuji es **ops del operador humano**. No bloquea el merge ni los unit tests (que mockean fetch). Equivalente al BASE-04 de la linea Base (WKH-107 del INDEX, ya DONE). Una vez que el operador setee `AVALANCHE_FACILITATOR_API_KEY` en Railway (wasiai-a2a), el path estará listo para el smoke.

---

## Pasos ops pendientes (NO son deuda — son config de despliegue)

Estos pasos los ejecuta el operador humano en Railway. No bloquean el merge.

1. **Setear `AVALANCHE_FACILITATOR_API_KEY` en Railway (wasiai-a2a)**: el valor real de la API key del facilitator deployado. Sin esta var, el adapter opera en modo degradado (sin bearer → el facilitator de prod dara 401 en verify/settle reales). El mismo facilitator ya tiene la key configurada server-side como `FACILITATOR_API_KEY` — el cliente puede reusar ese valor o sobreescribirlo con `AVALANCHE_FACILITATOR_API_KEY`.

2. **Smoke E2E real Avalanche Fuji**: una vez que (1) esté activo, correr un verify/settle real contra el facilitator deployado en `eip155:43113` para confirmar que el bearer cierra el 401. El patrón identico ya se probo on-chain en WKH-106 (Base Sepolia, tx `0xb9b156e...ca35521d`).

---

## Lecciones para proximas HUs

1. **El patrón espejo funciona para wiring de auth entre chains**: WKH-107 fue un espejo 1:1 de WKH-106 con 3 deltas documentados. Dev no tuvo que inferir nada; los 3 deltas estaban explicitados en el story file. Este enfoque (espejo + deltas explícitos) es reutilizable para cualquier adapter nuevo que necesite auth al facilitator.

2. **Auto-blindaje acumulado da rendimiento creciente**: los CD-9/10/11 (de WKH-104/102) se aplicaron preventivamente en WKH-106 y funcionaron. Se re-aplicaron en WKH-107 y volvieron a funcionar. Dev paso los 4 checks al primer intento en ambas HUs. La inversion en documentar anti-patrones en el SDD se amortiza exponencialmente.

3. **`?.trim() ||` para secrets desde env es el patron canonico de este proyecto**: confirmado en WKH-106 y replicado en WKH-107. Cualquier helper que resuelva una API key desde env debe usar esta cadena, no `??`.

4. **Wiring de auth es QUALITY aunque el delta sea minimo**: el payment path (verify/settle) tiene riesgo de regresion silenciosa — un `Bearer ` vacío pasaria tests sin la combinacion `?.trim() || + guard if(apiKey)`. La metodologia QUALITY con AR/CR previno ese edge case en el SDD antes de que llegara a código, por segunda vez consecutiva.
