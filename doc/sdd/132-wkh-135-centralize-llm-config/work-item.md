# Work Item — [WKH-135] Centralizar la config LLM/modelo en un único punto env-driven

## Resumen
Hoy los model IDs de Claude (Haiku 4.5 y Sonnet 5), el timeout de las llamadas
LLM (`30_000` ms) y varios `max_tokens` están hardcodeados y duplicados en 4-5
archivos de `src/services/llm/*` y `src/services/orchestrate.ts`. Cambiar un
modelo requiere editar cada sitio a mano (riesgo de drift). Esta HU extrae
esos valores a un único módulo env-driven (NO base de datos — decisión
explícita del humano), con defaults idénticos a los valores actuales, sin
cambiar el comportamiento del planner ni del schema-transform bridge.

## Sizing
- SDD_MODE: full
- Estimación: M
- Branch sugerido: refactor/135-centralize-llm-config
- Pipeline propuesto: **QUALITY** (F2 SDD + Story File + AR + CR + F4 QA).
  Justificación: aunque es "solo" un refactor de config sin cambio de
  comportamiento, toca (a) `pricing.ts`/`computeCostUsd` — money-path de
  telemetría de costos, con riesgo real de crash si un modelo env-driven no
  está en la tabla de precios; (b) `orchestrate.ts` — el planner que decide
  qué agentes se ejecutan y cuánto se cobra; (c) un type compartido
  (`LLMBridgeStats.model` en `types/index.ts`) cuyo blast radius incluye
  telemetría/dashboards. El orquestador puede subir el sizing pero no
  bajarlo por estas razones.

## Acceptance Criteria (EARS)

- AC-1: WHEN un developer necesita cambiar un model ID de Claude (Haiku o
  Sonnet) usado por el planner, el schema-transform bridge o el input-retry
  helper, the system SHALL requerir editar exactamente un módulo (single
  source of truth), no los 4-5 sitios actuales.

- AC-2: IF un model ID resuelto en runtime (por env override) no existe en la
  tabla de precios `PRICING_USD_PER_M_TOKENS`, THEN the system SHALL
  computar un costo con un precio default seguro y emitir `log.warn`
  estructurado, y SHALL NOT lanzar una excepción (protección del money-path
  de telemetría de costos en `computeCostUsd`).

- AC-3: WHILE ninguna env var de config LLM esté seteada (estado por
  defecto, igual a producción hoy), the system SHALL preservar
  byte-idéntico el comportamiento actual: mismos model IDs por default
  (`claude-haiku-4-5-20251001` / `claude-sonnet-5`), mismo timeout (`30_000`
  ms) en los 3 call-sites, mismos `max_tokens` por call-site (1024 en
  orchestrate.ts:192, 512 en transform.ts:166, 1024 en input-retry.ts:89),
  y mismo comportamiento del selector `selectModel()` (WKH-57) y de
  `thinking: { type: 'disabled' }` (WKH-134).

- AC-4: WHERE una env var de override esté seteada para un knob LLM
  centralizado (model ID / timeout / max_tokens por call-site), the system
  SHALL usar el valor de la env var en lugar del default hardcodeado.

- AC-5: the system SHALL documentar cada env var nueva en `.env.example`
  con su default (= valor hardcodeado actual) y su rango/comportamiento ante
  valor inválido, siguiendo el patrón defensivo existente de
  `getProtocolFeeRate()` (`src/services/fee-charge.ts:100-121`: parseo +
  clamp/validación + fallback + `log.error`/`log.warn` estructurado, nunca
  crash).

- AC-6: IF el refactor cambia el tipo de `LLMBridgeStats.model`
  (`types/index.ts:341`, hoy `'claude-haiku-4-5-20251001' | 'claude-sonnet-5'`)
  para soportar modelos env-driven, THEN the system SHALL documentar
  explícitamente el impacto en cualquier consumer del tipo (dashboard,
  telemetría) como parte del SDD (F2), no como efecto colateral silencioso.

## Scope IN
- `src/services/llm/select-model.ts:14,18,21,32,37` — literales
  `'claude-haiku-4-5-20251001'` / `'claude-sonnet-5'` en `selectModel()`.
- `src/services/llm/input-retry.ts:25` (`MODEL`), `:26` (`TIMEOUT_MS`),
  `:89` (`max_tokens: 1024`).
- `src/services/llm/pricing.ts:13-18` — `PRICING_USD_PER_M_TOKENS`,
  `PricedModel`, `computeCostUsd()`.
- `src/services/orchestrate.ts:34` (`MODEL`), `:35` (`LLM_TIMEOUT_MS`),
  `:192` (`max_tokens: 1024`).
- `src/services/llm/transform.ts:34` (`TIMEOUT_MS`), `:166`
  (`max_tokens: 512`).
- `src/types/index.ts:341` — tipo `LLMBridgeStats.model`.
- `.env.example` — nueva sección documentando las env vars del módulo LLM
  config (siguiendo el bloque `PROTOCOL_FEE_RATE` como precedente de estilo,
  `.env.example:437-448`).
- Módulo nuevo — ubicación y nombre exacto a decidir en F2 (candidatos:
  `src/services/llm/models.ts` o `src/services/llm/config.ts`).

## Scope OUT
- `src/adapters/*/payment.ts` / `gasless.ts` — 13 contract addresses y URLs
  de explorers/facilitator. Son constantes de red definidas en UNA sola
  ubicación cada una (no duplicadas entre archivos) — no es el problema que
  esta HU ataca. NO tocar.
- Comportamiento del planner (`llmPlan()` en orchestrate.ts) y del schema
  transform (`generateTransformFn()` en transform.ts), incluyendo
  `thinking: { type: 'disabled' }` de WKH-134 — esta HU es refactor de
  config, no de lógica. Cero cambio de comportamiento (AC-3).
- `MAX_AGENTS_IN_PROMPT` (`orchestrate.ts:41`) y `PRE_COMPOSE_TIMEOUT_MS`
  (`orchestrate.ts:94`) — aparecen UNA sola vez cada uno (no están
  duplicados en múltiples archivos), así que no encajan en el problema
  original ("cambiar el modelo requiere tocar varios lados"). Quedan OUT de
  esta HU salvo que Architect (F2) decida incluirlos por consistencia del
  módulo único (ver Missing Inputs).
- Persistencia en base de datos de esta config — el humano decidió
  explícitamente ENV VAR, no DB (CD-4).
- Cualquier knob LLM nuevo no existente hoy (ej. `temperature`) — no fue
  pedido, no se inventa (regla "no inventes ACs").

## Decisiones técnicas (DT-N)
- DT-1 (Módulo único): F2 decide la ubicación exacta y el contrato de
  exports del módulo — debe cubrir como mínimo: model ID del planner
  (Sonnet, orchestrate.ts), model IDs de trivial/complex (`selectModel`,
  Haiku/Sonnet), model ID del input-retry (Haiku), el timeout LLM
  (`30_000`), y los `max_tokens` por call-site (1024/512/1024).
  Env-overridable con default = valor actual.
- DT-2 (Pricing robusto): `PRICING_USD_PER_M_TOKENS` es hoy una tabla
  literal y `PricedModel = keyof typeof`. Si el model ID pasa a ser
  env-driven, un modelo fuera de la tabla rompería `computeCostUsd`
  (money-path de telemetría). F2 debe diseñar un fallback seguro (precio
  default + `log.warn`, sin crash, AC-2) y decidir si el módulo de config
  declara el precio junto al model ID o si sigue siendo una tabla separada.
- DT-3 (Type change): `LLMBridgeStats.model` (`types/index.ts:341`) es hoy
  un union literal. Con modelos env-driven probablemente pase a `string` (o
  un tipo derivado del módulo de config). F2 debe documentar el impacto en
  telemetría/tipado consumidores de `LLMBridgeStats` (AC-6).
- DT-4 (Naming env vars): propuesta de partida para F2 (ej.
  `LLM_PLANNER_MODEL`, `LLM_COMPLEX_MODEL`, `LLM_TRIVIAL_MODEL`,
  `LLM_INPUT_RETRY_MODEL`, `LLM_TIMEOUT_MS`, `LLM_PLANNER_MAX_TOKENS`,
  `LLM_TRANSFORM_MAX_TOKENS`, `LLM_INPUT_RETRY_MAX_TOKENS`) — a confirmar/
  ajustar en F2 y documentar en `.env.example` (AC-5).
- DT-5 (MAX_AGENTS_IN_PROMPT / PRE_COMPOSE_TIMEOUT_MS): quedan fuera de
  scope por default (no están duplicados — ver Scope OUT). F2 puede
  reconsiderar incluirlos en el mismo módulo por consistencia si el costo
  incremental es bajo, pero no es un requisito de esta HU.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO cambiar el comportamiento del planner o del schema
  transform de WKH-134 (`thinking: { type: 'disabled' }`, selección de
  modelo por schema en `selectModel()`) — este refactor es de config, no de
  lógica (AC-3).
- CD-2: PROHIBIDO que un modelo desconocido/env-driven rompa
  `computeCostUsd` o cualquier consumer de telemetría de costos — SIEMPRE
  degradar con precio default + `log.warn`, NUNCA throw (AC-2, money-path).
- CD-3: PROHIBIDO tocar `src/adapters/*/payment.ts` / `gasless.ts`
  (contract addresses, explorer URLs) — fuera de scope (Scope OUT).
- CD-4: PROHIBIDO usar base de datos para esta config — ENV VAR únicamente
  (decisión explícita del humano, no negociable en F2).
- CD-5: OBLIGATORIO que todos los defaults env-driven sean idénticos a los
  valores hardcodeados actuales — cero cambio de comportamiento sin
  overrides (AC-3).
- CD-6: OBLIGATORIO seguir el patrón defensivo de `getProtocolFeeRate()`
  (`src/services/fee-charge.ts:100-121`) para leer y validar cada env var
  nueva: parseo, rango/validación, fallback seguro, log estructurado ante
  valor inválido (nunca crash del proceso).

## Missing Inputs
- [resuelto en F2] Nombre y ubicación exacta del módulo de config (DT-1).
- [resuelto en F2] Naming final de las env vars (DT-4).
- [resuelto en F2] Tipo final de `LLMBridgeStats.model` y su impacto en
  consumers (DT-3, AC-6).
- [resuelto en F2] Si `MAX_AGENTS_IN_PROMPT` / `PRE_COMPOSE_TIMEOUT_MS`
  entran al mismo módulo por consistencia (DT-5) — no bloqueante, decisión
  de Architect.

## Análisis de paralelismo
- No bloquea otras HUs — es un refactor aislado a `src/services/llm/*` +
  `src/services/orchestrate.ts` + `src/types/index.ts` + `.env.example`.
- Riesgo de conflicto de merge con cualquier HU en curso que edite
  simultáneamente `orchestrate.ts`, `transform.ts`, `input-retry.ts`,
  `select-model.ts` o `pricing.ts` — verificar WIP en esos archivos antes
  de lanzar F3.
- No depende de WKH-131/132 (ya DONE, `orchestrate.ts` ya estabilizado
  post-`plan`/`execute` split) más allá de usarlos como base de lectura.
