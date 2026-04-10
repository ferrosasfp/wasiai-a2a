# Report -- WKH-38 Gasless graceful degradation

Date: 2026-04-06
Branch: feat/022-gasless-degradation
Mode: FAST+AR
Closer: nexus-docs

---

## Resumen ejecutivo

Implementacion completa del manejo de estados degradados en el modulo gasless (WKH-38). `/gasless/status` siempre retorna 200 con `funding_state` enum (`disabled` / `unconfigured` / `unfunded` / `ready`); `/gasless/transfer` retorna 503 cuando el modulo no esta operacional. 9/9 ACs PASS, 119/119 tests, tsc clean. AR: APROBADO (0 BLQ, 5 MENOR). CR: APROBADO (0 BLQ, 6 MENOR). Status final: DONE.

---

## Pipeline ejecutado

| Fase | Veredicto | Fecha |
|------|-----------|-------|
| F0 | project-context cargado | 2026-04-06 |
| F1 | work-item.md -- 9 ACs EARS | 2026-04-06 |
| F2/F2.5 | SDD mini inline (FAST+AR -- no SDD separado) | 2026-04-06 |
| F3 | Implementacion -- 5 archivos, 1 wave, +7 tests | 2026-04-06 |
| AR | APROBADO -- 0 BLQ, 5 MENOR (compact inline) | 2026-04-06 |
| CR | APROBADO -- 0 BLQ, 6 MENOR (compact inline) | 2026-04-06 |
| F4 | 9/9 ACs PASS -- validation.md APROBADO PARA DONE | 2026-04-06 |

Nota: En modo FAST+AR compact, AR y CR se documentaron inline en el auto-blindaje y validation.md. No se generaron ar-report.md / cr-report.md como artefactos separados.

---

## Acceptance Criteria -- resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | PASS | `gasless-signer.test.ts:291` -- "AC-1: should return funding_state 'unconfigured' when PK is absent" |
| AC-2 | PASS | `gasless-signer.test.ts:308` -- "AC-2: should return funding_state 'unconfigured' when PK is malformed" |
| AC-3 | PASS | `gasless-signer.test.ts:325` -- "AC-3: should return funding_state 'unfunded' when PK valid but balance is 0" |
| AC-4 | PASS | `gasless-signer.test.ts:340` -- "AC-4: should return funding_state 'ready' when PK valid and balance > 0" |
| AC-5 | PASS | `routes/gasless.ts:36-44` -- POST /gasless/transfer guard: `funding_state !== 'ready'` returns 503 |
| AC-6 | PASS | `gasless-signer.test.ts:273` + `index.ts:61` -- rutas siempre registradas, estado 'disabled' cuando GASLESS_ENABLED es falsy |
| AC-7 | PASS | `gasless-signer.test.ts:388` -- never throws; `gasless-signer.ts:312` -- todos los error paths capturados |
| AC-8 | PASS | `gasless-signer.test.ts:357` -- private key ausente de responses; CD-1 en `gasless.ts:24` y `:62` |
| AC-9 | PASS | `npm test` -- 119/119 PASS, 10/10 archivos, zero regressions |

---

## Hallazgos finales

- BLOQUEANTEs: 0 (ninguno en AR ni CR)
- MENORs AR (5 -- diferidos al backlog como deuda tecnica aceptada):
  1. Sin integration test para POST /gasless/transfer en servidor levantado
  2. `getOperatorTokenBalance()` sin timeout configurable (falla silenciosa si RPC cuelga)
  3. `FALLBACK_TOKEN` hardcodeado en gasless-signer -- deberia venir de config
  4. `computeFundingState()` no distingue balance insuficiente de balance cero
  5. Ausencia de circuit-breaker / retry para el balance check
- MENORs CR (6 -- diferidos al backlog como deuda tecnica aceptada):
  1. `getGaslessStatus()` supera 30 lineas -- candidato a split en funcion helper
  2. `documentation` URL en respuesta 503 apunta a placeholder string, no URL real
  3. Sin telemetria/log estructurado cuando degradacion ocurre
  4. POST /gasless/transfer no tiene rate limiting
  5. `GaslessFundingState` podria exportarse como `const enum` para tree-shaking
  6. Comentario inline en gasless.ts:36 desactualizado respecto al guard actual

---

## Auto-Blindaje consolidado

| Fecha | Contexto | Error | Causa raiz | Fix | Aplicar en |
|-------|----------|-------|------------|-----|------------|
| 2026-04-06 | Wave 3 -- vi.mock factory hoisting con kiteClient named export | `ReferenceError: Cannot access 'mockReadContract' before initialization` | `vi.mock` factory se iza antes de la declaracion `const mockReadContract = vi.fn()` cuando se usa como propiedad directa del objeto (no funcion lazy) | `vi.hoisted()` para declarar `mockGetBlock` y `mockReadContract` antes del factory | Cualquier test que agregue named exports (no function-wrapped) a un `vi.mock` factory existente debe usar `vi.hoisted()` |

---

## Archivos modificados

| Dominio | Archivo | Cambio |
|---------|---------|--------|
| lib | `src/lib/gasless-signer.ts` | Extendio `getGaslessStatus()`: agrego `getOperatorTokenBalance()`, `computeFundingState()`, manejo de PK malformada sin throw |
| routes | `src/routes/gasless.ts` | Agrego POST /gasless/transfer con guard 503; enriquecio respuesta /status con `funding_state`, `chain_id`, `relayer`, `documentation` |
| bootstrap | `src/index.ts` | Removio gate `if (GASLESS_ENABLED)` -- rutas siempre registradas (DT-1) |
| types | `src/types/index.ts` | Agrego `GaslessFundingState` type y campos de enriquecimiento en `GaslessStatus` (additive, backward compat) |
| tests | `src/lib/gasless-signer.test.ts` | +7 tests para ACs 1-8; `vi.hoisted()` fix para mock factory |

Tests: 119 total (112 existentes + 7 nuevos). Delta: +7.

---

## Decisiones diferidas a backlog

- Ninguna HU de spinoff creada. Los 11 MENORs (5 AR + 6 CR) quedan como deuda tecnica documentada arriba. Si alguno se prioriza, crear WKH nuevo referenciando este reporte.

---

## Lecciones para proximas HUs

1. **vi.hoisted() es obligatorio para named exports en vi.mock factories**: cualquier test nuevo que agregue propiedades directas (no funciones lazy) a un mock factory existente debe declarar los vi.fn() con vi.hoisted(). Documentado en auto-blindaje.
2. **FAST+AR compact es efectivo para HUs S con 2 categorias de riesgo**: el flujo produjo 9/9 PASS sin artefactos intermedios innecesarios. El ahorro de overhead fue significativo para una HU de alcance delimitado (5 archivos).
3. **Siempre registrar rutas incondicionalmente para endpoints de estado**: el patron DT-1 (always-register gasless routes) evita que clientes pierdan visibilidad del estado del modulo cuando este esta deshabilitado. Aplicar en cualquier modulo feature-flaggeable con endpoint /status.
4. **Balance check via readContract requiere mock explicito en tests**: `publicClient.readContract()` no se puede omitir en tests unitarios -- sin mock se hace llamada real al RPC. Patrones de mock deben documentarse en el story-file de HUs que usen viem.
