# Work Item — [WKH-57] LLM Bridge Pro

## Resumen

Mejorar `maybeTransform` en `src/services/llm/transform.ts` para produccion profesional. Los cuatro ejes de mejora son: (1) selector de modelo inteligente que usa Haiku 4.5 para schemas simples y Sonnet 4.6 para schemas complejos, reduciendo costo estimado en ~70%; (2) verification loop con retry-on-fail para que el LLM no pase output invalido al siguiente paso del pipeline; (3) cache key fortalecido con fingerprint del schema target para evitar stale cache cuando el schema cambia en DB; (4) telemetria completa de tokens, latencia, costo y tipo de bridge emitida en el evento `compose_step`.

**Depende de:** WKH-56 mergeado a main (provee `BridgeType` y helper `src/services/a2a-protocol.ts`).

---

## Sizing

- SDD_MODE: full
- Estimacion: L
- Pipeline: QUALITY — toca path critico de orquestacion + integracion con LLM externo + cache Supabase con migration potencial + adversarial review obligatoria
- Branch sugerido: `feat/056-wkh-57-llm-bridge-pro`
- Categoria de riesgo: ALTA

## Smart Sizing — Clasificacion

**QUALITY** — Justificacion:
1. Modifica `maybeTransform`, unico punto de schema bridging en todos los pipelines — cualquier bug rompe toda la composa multi-agente.
2. Introduce retry loop con LLM call extra — riesgo de regresion de latencia y gasto de tokens si el threshold es incorrecto.
3. Cache key migration: invalidar L2 existente puede causar cold-start masivo en produccion; no invalidar puede dejar stale data silenciosa.
4. Costo tracking con pricing constants — si los valores estan mal, el billing dashboard reporta datos incorrectos.
5. Cambio en `TransformResult` (interfaz publica) — breaking si consumers leen `cacheHit` boolean y no el nuevo `bridgeType`.

## Skills Router

- **skill/llm-integration** — Anthropic SDK, model selection, token tracking, retry/fallback patterns
- **skill/pipeline-optimization** — transform cache layer, schema fingerprint, telemetry events, cost attribution

---

## Acceptance Criteria (EARS)

- **AC-1:** WHEN `maybeTransform` is invoked with a `targetSchema` that has fewer than 5 required fields AND has no properties with `type: "object"` as a value AND has no `oneOf`, `anyOf`, or `allOf` keys, THEN the system SHALL invoke the Anthropic API with `model: "claude-haiku-4-5-20251001"` and the returned `llm.model` field SHALL equal `"claude-haiku-4-5-20251001"`. Verifiable by mocking the Anthropic client and asserting the `model` parameter of the `messages.create` call.

- **AC-2:** WHEN `maybeTransform` is invoked with a `targetSchema` that satisfies at least one of: (a) has 5 or more required fields, (b) has at least one property whose value has `type: "object"`, or (c) has a `oneOf`, `anyOf`, or `allOf` key, THEN the system SHALL invoke the Anthropic API with `model: "claude-sonnet-4-6"` and the returned `llm.model` field SHALL equal `"claude-sonnet-4-6"`. Verifiable by mocking the Anthropic client and asserting the `model` parameter.

- **AC-3:** WHEN `applyTransformFn` produces an output that does not satisfy `isCompatible(output, targetSchema)` on the first attempt, THEN the system SHALL retry exactly once, constructing a revised prompt that includes the specific required fields that were missing from the first attempt. IF the second attempt also fails `isCompatible`, THEN the system SHALL throw an error with message matching `/transform validation failed after retry/i` that includes the name of at least one missing required field.

- **AC-4:** WHEN `maybeTransform` is called twice in sequence for the same `sourceAgentId` and `targetAgentId` but with different `targetSchema` objects (simulating a schema change in DB), THEN the system SHALL compute a different cache key for each call, resulting in an L2 miss on the second call, thereby preventing use of a stale cached transform function. Verifiable by asserting that the Supabase `select` query is called with different key values on each invocation.

- **AC-5:** WHEN `maybeTransform` returns with `bridgeType === 'LLM'`, THEN the result SHALL include a non-null `llm` object with fields: `model` (string), `tokensIn` (positive integer), `tokensOut` (positive integer), `retries` (0 if first attempt succeeded, 1 if retry was needed), and `costUsd` (positive number computed from centralized pricing constants). WHEN `bridgeType` is `'CACHE_L1'`, `'CACHE_L2'`, `'SKIPPED'`, or `'A2A_PASSTHROUGH'`, THEN `llm` SHALL be `undefined`.

- **AC-6:** WHEN a `compose_step` event is tracked after a bridge operation, THEN the event `metadata` SHALL include the following fields: `bridge_type` (one of `'LLM' | 'CACHE_L1' | 'CACHE_L2' | 'SKIPPED' | 'A2A_PASSTHROUGH'`), `bridge_latency_ms` (number), `llm_tokens_in` (number or null), `llm_tokens_out` (number or null), `bridge_cost_usd` (number or null), `llm_model` (string or null). Fields SHALL be null when `bridge_type` is not `'LLM'`. The existing `compose_step` fields (`agentId`, `agentName`, `registry`, `status`, `latencyMs`, `costUsdc`, `txHash`) SHALL remain unchanged (zero breaking change for existing consumers).

- **AC-7:** WHILE `maybeTransform` returns without error after LLM path, the system SHALL always log `console.error` for any retry attempt (retries > 0), including the missing field names and the retry count, regardless of whether the second attempt succeeds or fails.

- **AC-8:** WHEN the test suite runs after WKH-57 changes are applied, THEN all pre-existing tests in `src/services/llm/transform.test.ts` (T-1 through T-5) SHALL pass without modification (zero regression). AND the new test file `src/services/llm/__tests__/transform-verification.test.ts` SHALL cover: model selector for simple schema (AC-1), model selector for complex schema (AC-2), retry succeeds on second attempt (AC-3 happy path), retry fails on second attempt (AC-3 sad path, throws), schema fingerprint cache key divergence (AC-4), `llm` field present for LLM bridge and absent for non-LLM bridge (AC-5). AND line coverage for `src/services/llm/transform.ts` SHALL be >= 90%.

---

## Scope IN

| Archivo | Tipo | Operacion |
|---------|------|-----------|
| `src/services/llm/transform.ts` | service | Modificar: model selector, verification loop con retry, cache key con schema fingerprint, `TransformResult` extendido con telemetria |
| `src/services/compose.ts` | service | Modificar: pasar campos de telemetria bridge al `.track()` call en `eventService` |
| `src/types/index.ts` | types | Extender `TransformResult` con `bridgeType: BridgeType` y campo `llm?: LLMBridgeStats`; importar `BridgeType` desde WKH-56 |
| `src/services/event.ts` | service | Extender el `input` del metodo `track()` con los campos nuevos de bridge; propagar a `metadata` en el insert |
| `src/services/llm/transform.test.ts` | test | Modificar: ajustar assertions de `cacheHit` para el nuevo shape de `TransformResult`; cubrir nuevos branches de model selector |
| `src/services/llm/__tests__/transform-verification.test.ts` | test (NUEVO) | Crear: test suite especifica del retry loop + model selector + schema fingerprint |

---

## Scope OUT

- `src/lib/downstream-payment.ts` — WKH-55 DONE, NO tocar
- `src/services/orchestrate.ts` — scope JSON-RPC distinto, no involucrado
- `src/services/a2a-protocol.ts` — creado por WKH-56; solo importar `BridgeType` si es necesario, NO modificar
- `supabase/migrations/` — NO crear nueva tabla; si se necesita agregar columna `schema_hash` a `kite_schema_transforms`, Architect decide si usa ALTER en migration existente o inline en F3 (preferir migration SQL minima)
- `src/routes/*` — ningun endpoint nuevo; cambios son internos al service layer
- `src/services/registry.ts` / `src/services/discovery.ts` — sin cambios
- `doc/sdd/054-*` / `doc/sdd/055-*` — ya cerrados, NO reabrir

---

## Decisiones tecnicas (DT-N)

- **DT-A (OPEN):** Thresholds exactos para Sonnet vs Haiku — el work-item propone: `required.length >= 5` OR `properties[key].type === 'object'` OR `oneOf|anyOf|allOf` presentes. Architect debe validar contra benchmarks reales de complejidad de schema y documentar en SDD con razonamiento. Si los thresholds son incorrectos el selector puede usar Sonnet para schemas triviales (sobrecosto) o Haiku para schemas complejos (calidad baja).

- **DT-B (OPEN):** Algoritmo de fingerprint para cache key — opciones: (a) `JSON.stringify(schema)` naive (no-deterministic: property order puede diferir); (b) `JSON.stringify` con sort recursivo de keys antes de serializar; (c) biblioteca canonical-json (`json-canonicalize`). Architect decide el algoritmo que garantice CD-7 (determinismo independiente de insertion order). Impacta: si dos schemas logicamente identicos producen keys distintas, habra false misses en cache.

- **DT-C (OPEN):** Estrategia de fallback cuando Haiku falla dos veces — opciones: (a) escalar automaticamente a Sonnet (mas caro pero mas robusto); (b) fail fast con error explicito (falla el step, rollback al caller); (c) fallback a passthrough con error log (segun CD-5). Architect decide el trade-off: fallback a Sonnet oculta errores sistematicos de Haiku; fail fast es mas predecible pero puede romper pipelines en produccion.

- **DT-D (OPEN):** Backward-compat con cache L2 existente — opciones: (a) invalidar full L2 al deploy (cold-start masivo, impacto en produccion); (b) agregar columna `schema_hash` a `kite_schema_transforms` con migration y aceptar miss en el primer hit post-deploy; (c) usar columna existente combinando source+target+hash como composite key sin nueva columna (require cambio en upsert conflict clause). Architect debe evaluar impacto en produccion y documentar migration strategy en SDD.

- **DT-E (OPEN):** Comportamiento ante Anthropic API timeout o 5xx — CD-5 dice "fallback al passthrough con error log". Architect debe precisar: (a) fallback retorna el output original sin transformar (puede causar schema mismatch en el siguiente step); (b) fallback re-lanza el error y el compose step falla limpiamente; (c) fallback usa cached fn si existe en L1/L2, y solo si hay miss total hace fallback a passthrough. La opcion (a) es silenciosa y peligrosa; la opcion (b) es conservadora y preferida. Architect decide y documenta en SDD.

- **DT-F (RESUELTO):** Pricing constants segun CD-6 deben vivir en un modulo centralizado, no inline en `transform.ts`. Propuesta: `src/lib/llm-pricing.ts` con objeto exportado `LLM_PRICING` conteniendo precios por modelo. Architect confirma ubicacion en SDD.

---

## Constraint Directives (CD-N)

- **CD-1:** PROHIBIDO usar `any` explicito en TypeScript — strict mode en todos los archivos nuevos/modificados.
- **CD-2:** PROHIBIDO introducir regresion funcional — el compose flow actual (non-LLM bridge, SKIPPED, CACHE_L1, CACHE_L2) debe seguir funcionando exactamente igual.
- **CD-3:** PROHIBIDO agregar nuevas env vars — `ANTHROPIC_API_KEY` ya existe; no introducir `ANTHROPIC_MODEL` ni variables de configuracion de modelo como env vars. El model selector es logica interna del servicio.
- **CD-4:** PROHIBIDO crear endpoints nuevos — WKH-57 es un cambio interno al service layer.
- **CD-5:** OBLIGATORIO que ante fallo de Anthropic API (timeout/5xx) el pipeline no se rompa silenciosamente — el comportamiento exacto lo define Architect en DT-E, pero la decision final debe estar documentada en el SDD antes de F3.
- **CD-6:** OBLIGATORIO que el cost tracking use pricing CONSTANTS centralizadas en un modulo separado (propuesta: `src/lib/llm-pricing.ts`) — ningun precio hardcodeado inline en `transform.ts`.
- **CD-7:** OBLIGATORIO que el schema fingerprint sea deterministico — mismo schema logico (independientemente del orden de insercion de properties) DEBE producir el mismo hash.
- **CD-8:** PROHIBIDO usar `eval()` — el helper `applyTransformFn` ya usa `new Function('output', body)`; mantener ese patron. NO cambiar a `eval`.
- **CD-9:** OBLIGATORIO que los nuevos campos en el evento `compose_step` sean OPCIONALES (nullable/undefined) — no puede ser un campo required que rompa consumers existentes que leen el schema del evento.
- **CD-10:** OBLIGATORIO que el retry prompt al LLM incluya el nombre especifico del campo faltante — no mensajes genericos como "fix the transform"; debe decir "missed required field: X".

---

## Missing Inputs

- **[OPEN] DT-A:** Thresholds exactos Sonnet vs Haiku — resolver en F2 (Architect benchmarks).
- **[OPEN] DT-B:** Algoritmo de canonicalizacion del fingerprint — resolver en F2.
- **[OPEN] DT-C:** Estrategia de fallback Haiku-fail → Sonnet vs error — resolver en F2.
- **[OPEN] DT-D:** Migration strategy para cache L2 existente — resolver en F2 con impacto en produccion.
- **[OPEN] DT-E:** Comportamiento exacto ante Anthropic API timeout/5xx — resolver en F2.
- **[NEEDS CLARIFICATION]** Pricing exacto de Haiku 4.5 y Sonnet 4.6 — el work-item cita $0.80/$4 y $3/$15 por M tokens respectivamente; Architect debe verificar contra documentacion oficial de Anthropic antes de hardcodear en `llm-pricing.ts`.
- **[NEEDS CLARIFICATION]** Nombre del modelo Haiku 4.5 — el work-item cita `claude-haiku-4-5-20251001`; verificar string exacto en Anthropic API antes de F3.
- **[RESUELTO en F2]** Ruta del nuevo test file — `src/services/llm/__tests__/transform-verification.test.ts` (propuesta del analista; Architect puede ajustar si la convencion del proyecto difiere).

---

## Analisis de paralelismo

- **WKH-57 esta BLOQUEADA por WKH-56 hasta merge a main.** WKH-57 importa `BridgeType` de tipos generados por WKH-56. Sin el merge, la dependencia de tipos hace que la rama WKH-57 no compile. F3 de WKH-57 NO puede comenzar hasta que `feat/055-wkh-56-a2a-fast-path` este en `main`.
- **WKH-57 NO puede ir en paralelo con WKH-56** — misma razon: `src/services/llm/transform.ts` es modificado por ambas HUs (WKH-56 agrega `bridgeType` al return de `maybeTransform`; WKH-57 extiende ese return). Merge conflict inevitable si se branching en paralelo.
- **Overlap con WKH-26 (Hardening):** bajo riesgo — WKH-26 toca `compose.ts` en la capa de rate-limiting y circuit-breaker, no en el bridge loop. Si WKH-26 esta en progreso, verificar antes de branching para detectar conflictos en `compose.ts`.
- **Overlap con WKH-34/25 (A2A Key Middleware):** ninguno — WKH-57 es service-layer puro, no toca middleware.
- **No bloquea otras HUs conocidas a la fecha** — WKH-57 es una mejora interna de `maybeTransform`; no agrega contratos externos ni cambia endpoints.
