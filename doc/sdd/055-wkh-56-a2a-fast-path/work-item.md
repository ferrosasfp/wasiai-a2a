# Work Item — [WKH-56] A2A Fast-Path en compose

## Resumen

Cuando dos agentes consecutivos en un pipeline `/compose` son A2A-compliant (Google A2A Protocol), el gateway actualmente paga un bridge LLM innecesario: ~3 s + ~1087 tokens por paso. Este work item introduce un fast-path que detecta si ambos agentes hablan A2A nativo y hace passthrough estructurado del `Message{role,parts}` sin invocar a Claude, llevando la latencia del bridge a <5 ms y el costo de tokens a 0 en ese tramo.

## Sizing

- SDD_MODE: full
- Estimacion: L
- Estimacion detalle: nuevo helper service + cambio en Agent Card schema + modificacion de path critico de compose + suite de tests, requiere adversarial review obligatoria
- Branch sugerido: feat/055-wkh-56-a2a-fast-path
- Pipeline: QUALITY

## Smart Sizing — Clasificacion

**QUALITY** — Justificacion:
1. Toca `src/services/compose.ts` que es el path critico de facturacion (x402) y telemetria.
2. Introduce cambio de schema en Agent Card (`a2a_compliant` boolean) que es un contrato externo.
3. Nuevo helper service con logica de deteccion de protocolo.
4. Cambio en el enum de `cacheHit` en `StepResult` — breaking si consumers leen ese campo como booleano.
5. Requiere validar contra Google A2A v1 spec (a2a.dev) — DT pendiente de Architect.

## Skills Router

- **skill/protocol-integration** — Google A2A Protocol, Agent Card schema, Message/Part structure
- **skill/pipeline-optimization** — compose bridge logic, LLM bypass, latency/token reduction

---

## Acceptance Criteria (EARS)

- **AC-1:** WHEN a bridge between step N and step N+1 is evaluated AND `isA2AMessage(output)` returns `true` AND `nextAgent.metadata.a2aCompliant` is `true`, THEN the system SHALL bypass `maybeTransform`, set `bridge_type` to `'A2A_PASSTHROUGH'`, and pass the `Message` object unmodified as input to step N+1, with `transformLatencyMs` < 5.

- **AC-2:** WHEN a bridge between step N and step N+1 is evaluated AND `isA2AMessage(output)` returns `false`, THEN the system SHALL invoke `maybeTransform` with the existing flow (SKIPPED / CACHE_L1 / CACHE_L2 / LLM), producing no regression in behavior.

- **AC-3:** WHEN a bridge between step N and step N+1 is evaluated AND `isA2AMessage(output)` returns `true` AND `nextAgent.metadata.a2aCompliant` is `false` or absent, THEN the system SHALL pass `parts[0]` unwrapped (not the full `Message` wrapper) to `maybeTransform`.

- **AC-4:** WHEN a bridge between step N and step N+1 is evaluated AND `isA2AMessage(output)` returns `false` AND `nextAgent.metadata.a2aCompliant` is `true`, THEN the system SHALL invoke `maybeTransform` normally and the generated transform SHALL produce output where `isA2AMessage(result)` returns `true` (i.e., a `Message{role, parts}` structure). [NEEDS CLARIFICATION: Architect to decide if LLM prompt must be updated to enforce A2A output shape, or if this AC is deferred to a follow-up HU. Mark as TBD in SDD if not confirmed by SPEC_APPROVED.]

- **AC-5:** WHEN `isA2AMessage(value)` is called, THEN the system SHALL return `true` if and only if: `value` is a non-null object, has a `role` field equal to `"agent"`, `"user"`, or `"tool"`, has a `parts` field that is a non-empty array, and every element of `parts` has a `kind` field equal to `"text"`, `"data"`, or `"file"`. The system SHALL return `false` for objects missing `role`, missing `parts`, `parts` being a non-array, `parts` being an empty array, or `kind` values outside the allowed set.

- **AC-6:** WHEN a `compose_step` event is tracked, THEN the system SHALL include a `bridge_type` field in the event `metadata` with one of the following string values: `A2A_PASSTHROUGH`, `SKIPPED`, `CACHE_L1`, `CACHE_L2`, `LLM`. The field SHALL be `null` or absent only for the last step of a pipeline (no bridge after final step).

- **AC-7:** WHEN the test suite runs, THEN `src/services/a2a-protocol.ts` SHALL have line coverage >= 85% AND all new branches introduced in `src/services/compose.ts` (fast-path condition, AC-1 through AC-4) SHALL be covered by at least one test each.

- **AC-8:** WHEN the test suite runs after WKH-56 changes are applied, THEN all pre-existing tests in `src/services/compose.test.ts` (or equivalent test file) SHALL pass without modification (0 regression).

---

## Scope IN

| Archivo | Tipo | Operacion |
|---------|------|-----------|
| `src/services/compose.ts` | service | Modificar: integrar fast-path antes de `maybeTransform` en el bridge loop (lineas ~111-135) |
| `src/services/llm/transform.ts` | service | Modificar: exportar `isCompatible` o exponer hook para A2A bypass; refactorizar para recibir `bridgeType` en resultado |
| `src/services/agent-card.ts` | service | Modificar/extender: detectar y propagar `a2aCompliant` desde Agent Card al tipo `Agent` |
| `src/types/index.ts` | types | Agregar: `A2AMessage`, `A2APart`, `BridgeType` enum/literal, extender `StepResult.cacheHit` o agregar `bridgeType` field |
| `src/services/a2a-protocol.ts` | service (NUEVO) | Crear: helpers `isA2AMessage`, `extractA2APayload`, `buildA2APayload` |
| `src/services/__tests__/a2a-protocol.test.ts` | test (NUEVO) | Crear: cobertura de todos los casos de `isA2AMessage` y helpers |
| `src/services/__tests__/compose.test.ts` (o ruta equivalente) | test | Modificar: agregar casos AC-1, AC-2, AC-3 |

## Scope OUT

- `src/lib/downstream-payment.ts` — WKH-55 entregado, NO tocar
- `src/services/orchestrate.ts` — orchestrate usa JSON-RPC, scope distinto
- `src/routes/*` — fast-path es interno al compose service; ningun endpoint nuevo
- wasiai-v2 marketplace — cambios en Agent Card de este servicio no implican cambios en v2
- `doc/sdd/054-*` (WKH-55) — ya en DONE, NO reabrir
- Tablas DB — no se agregan/modifican tablas Supabase en esta HU; `a2aCompliant` es un campo en la representacion en memoria del Agent (metadata), no en schema de DB [NEEDS CLARIFICATION: si Architect decide persistir `a2aCompliant` en `a2a_registries`, abrir HU separada o sub-task]

---

## Decisiones tecnicas

- **DT-1 (OPEN):** Google A2A v1 spec — la forma canonica de `Message` tiene `role` + `parts`; cada `Part` tiene `kind: "text"|"data"|"file"`. Architect debe validar contra https://a2a.dev/specification en F2 antes de codificar `isA2AMessage`. Si la spec cambio, los literales de `kind` y `role` en AC-5 se ajustan en el SDD.

- **DT-2 (OPEN):** Ubicacion del flag `a2aCompliant` en Agent Card — opciones: (a) campo top-level `"a2aCompliant": true`, (b) dentro de `capabilities.a2aCompliant: true`, (c) dentro de `extensions.protocol: "google-a2a-v1"`. Architect decide en F2. Impacta `agent-card.ts`, `types/index.ts` (AgentCard) y la logica de deteccion en `compose.ts`.

- **DT-3 (OPEN):** Backward-compat del campo `cacheHit` en `StepResult` — actualmente es `boolean | 'SKIPPED'`. Agregar `bridge_type` como campo separado en `StepResult` es menos breaking que expandir `cacheHit`. Architect decide si deprecar `cacheHit` o mantener ambos. En el SDD indicar la estrategia de migracion.

- **DT-4 (RESUELTO):** Agentes sin Agent Card o sin flag `a2aCompliant` → asumir `false` (non-A2A). Backward-compat garantizado: cualquier agente existente no registrado como A2A-compliant sigue usando el bridge LLM.

- **DT-5 (OPEN):** AC-4 — cuando el output es non-A2A pero el target es A2A-compliant, el LLM prompt de `generateTransformFn` en `transform.ts` deberia producir un `Message{role,parts}`. Architect debe decidir si: (a) se agrega instruccion al prompt cuando `targetIsA2A=true`, (b) se agrega un post-processor que wrappea el output del LLM en un `Message`, o (c) AC-4 se difiere a WKH-57. [NEEDS CLARIFICATION]

- **DT-6 (RESUELTO):** `BridgeType` sera un string literal union: `'A2A_PASSTHROUGH' | 'SKIPPED' | 'CACHE_L1' | 'CACHE_L2' | 'LLM'`. El campo `cacheHit` existente en `TransformResult` actualmente retorna `boolean | 'SKIPPED'`; el campo nuevo `bridgeType` se agrega a `TransformResult` y a `StepResult` para mayor expresividad, sin eliminar `cacheHit` en esta HU (no-breaking).

---

## Constraint Directives

- **CD-1:** PROHIBIDO usar `any` explicito en TypeScript — strict mode en todos los archivos nuevos/modificados.
- **CD-2:** PROHIBIDO introducir regresion funcional — `compose` actual (non-A2A agents) debe seguir funcionando exactamente igual.
- **CD-3:** PROHIBIDO modificar `src/lib/downstream-payment.ts` — WKH-55 es DONE.
- **CD-4:** PROHIBIDO modificar `src/services/orchestrate.ts` — scope distinto.
- **CD-5:** OBLIGATORIO que `bridge_type` sea un campo opcional en el schema del evento `compose_step` — no puede ser un campo required que rompa consumers existentes del evento.
- **CD-6:** OBLIGATORIO validar el spec real de Google A2A en F2 antes de hardcodear literales de `kind`/`role` — no inventar valores sin referencia.
- **CD-7:** PROHIBIDO hacer LLM call en el fast-path A2A — si `isA2AMessage` y `a2aCompliant` ambos son true, `transformLatencyMs` debe ser <5 ms (no hay red call).
- **CD-8:** OBLIGATORIO que `src/services/a2a-protocol.ts` sea importable de forma tree-shakeable — no side effects al importar el modulo.

---

## Riesgo

| Categoria | Nivel | Detalle |
|-----------|-------|---------|
| Regresion funcional | ALTO | `compose.ts` es el path critico de facturacion + telemetria; cualquier bug en el condicional fast-path puede romper todos los pipelines |
| Schema drift | MEDIO | `a2aCompliant` es campo nuevo en Agent Card — si Architect elige ubicacion incorrecta puede romper parsers de consumers |
| Spec divergencia | MEDIO | Los literales `kind`/`role` de A2A v1 pueden diferir de lo asumido — DT-1 bloquea hasta que Architect valide |
| Coverage gap | BAJO | Si `isA2AMessage` queda sin tests exhaustivos, edge cases (role vacio, parts=[]) pueden pasar en produccion |

**Categoria global: ALTA — Adversarial Review obligatoria post-F3.**

---

## Missing Inputs

- [OPEN] DT-1: spec real Google A2A v1 — resolver en F2 (Architect lee a2a.dev/specification)
- [OPEN] DT-2: ubicacion exacta de `a2aCompliant` en Agent Card — resolver en F2
- [OPEN] DT-5 / AC-4: LLM prompt update para target A2A-compliant — resolver en F2 o diferir a WKH-57
- [OPEN] Ruta exacta de los tests existentes de compose — en el codebase actual no se encontro `src/services/__tests__/compose.test.ts`; Architect debe localizar en F2 (puede estar en `test/` o bajo otro path)

---

## Analisis de paralelismo

- **WKH-56 bloquea WKH-57?** Probablemente si, si WKH-57 consume el nuevo `BridgeType` enum o el helper `isA2AMessage`. Confirmar con el backlog antes de lanzar WKH-57.
- **Puede ir en paralelo con WKH-55?** No aplica — WKH-55 esta DONE.
- **Overlap con WKH-53 (RLS)?** Ninguno — WKH-56 no toca tablas DB ni ownership.
- **Overlap con WKH-26 (Hardening)?** Bajo riesgo — ambos tocan `compose.ts`. Si WKH-26 esta en progreso y no merged, puede haber conflicto de merge en ese archivo. Verificar estado de rama `feat/026-hardening` antes de branching.
- **Overlap con WKH-25 (A2A Key Middleware)?** Bajo — WKH-25 toca middleware layer, no el bridge loop interno de compose.
