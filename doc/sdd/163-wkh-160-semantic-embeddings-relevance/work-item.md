# Work Item — [WKH-160] Relevancia semántica por embeddings (reemplazo/aumento del matching léxico)

## Resumen

La cadena WKH-152→158→159 destapó que el matching de relevancia hoy es 100%
**léxico** (overlap de tokens ≥3 chars, `tokenizeForRelevance`/`textOverlapsGoal`),
lo que produce **false-negatives sistemáticos** en un producto multilingüe: un
goal en español no comparte tokens con la descripción en inglés de un agente,
aunque sea semánticamente el agente correcto. Esta HU introduce relevancia
**semántica por embeddings** (cross-idioma + sinónimos) como capa adicional
—NUNCA como reemplazo total— del guard léxico existente, preservando el
money-safety ya validado en WKH-127/132/152/158/159.

## Sizing

- SDD_MODE: full
- Estimación: L (arquitectura + dependencia nueva + money-path + posible migración pgvector)
- **Recomendación de fase (ver `Análisis de fases` abajo): esta HU debería acotarse a Fase 1 (infra + fallback + shadow-mode/telemetría, CERO cambio de comportamiento). Fase 2 (enforcement real del umbral) queda como HU de seguimiento, gateada por calibración con datos reales.**
- Branch sugerido: `feat/163-wkh-160-semantic-embeddings-relevance`

---

## F0 — Grounding confirmado

### Las 3 superficies del matching léxico hoy

**(a) Greedy fallback `fallbackNoRelevance` — `src/services/orchestrate.ts:852-867`**
(comentario de diseño `:834-850`). Dispara SOLO cuando `usedFallback === true`
(el LLM falló 2× tras el retry de WKH-158, `!plannerConfigured()`, o circuit
breaker abierto). Es TODO-O-NADA: si ningún step del plan greedy comparte
≥1 token con el goal → `no_relevant_agent`, sin cobrar (hard-reject, corre
ANTES de cualquier débito — confirmado en WKH-159, `orchestrate.ts:908-958`
precede a `executeApprovedPlan`). Es la superficie que WKH-159 dejó
explícitamente conservadora (rechaza de más, nunca cobra de más) tras
descartar relajarla funcionalmente.

**(b) Backstop MIXED-PLAN-ONLY sobre el plan del LLM — `src/services/orchestrate.ts:869-906`**
(comentario de diseño `:842-850`, `:869-884`). `tokenizeForRelevance` en
`:356-363`, `textOverlapsGoal` (función exportada) en `:372-381`, invocada en
el filtro `:890-897` (línea `:896`). `llmFilterApplies` se computa en
`:885-886` (`!usedFallback && !allStepsAreDemos && goalTokens.size > 0`) y
`applyDrop` en `:902-905` (invariante CD-15: nunca vacía un plan — solo
dropea si `0 < relevantSteps.length < steps.length`). **Esta es la superficie
de MAYOR impacto para el caso multilingüe**: corre en el HAPPY PATH (cada vez
que el LLM planifica exitosamente, no solo en fallback), y puede dropear
silenciosamente un step que el LLM eligió con buen juicio semántico solo
porque no hay overlap léxico (el escenario exacto goal-ES / agente-EN
descrito en el ticket).

**(c) Free-text de `/discover` — `src/services/discovery.ts`**. Dos filtros
locales independientes (NO usan `tokenizeForRelevance`/`textOverlapsGoal`,
son substring matching simple): filtro de `capabilities` en `:358-365`
(`.includes()` sobre nombre/capabilities/description) y filtro de
`query.query` en `:366-374` (`.includes()` sobre name/description/capabilities).
El broaden-retry de WKH-157 (`discovery.ts:276-287`) NO añade semántica —
solo evita reenviar `q` upstream para que el filtro local corra sobre el set
completo. **Confirmado money-path safe**: el planner de `/orchestrate` NUNCA
manda `query.query` (`orchestrate.ts:551-555` solo pasa
`capabilities`/`maxPrice`/`limit`), así que esta superficie NO afecta el
money-path — solo afecta callers humanos/directos de `/discover` con
búsqueda libre.

### Infra existente

- **Sin cliente de embeddings/vector en el repo**: `Glob` de `*embedding*` y
  `*vector*` en todo el repo → 0 resultados.
- **Sin columna de embedding en `a2a_agents`**: la migración
  `supabase/migrations/20260703000000_wkh134_a2a_agents.sql` (tabla de
  agentes self-published, WKH-134) no tiene columna vector; ninguna otra
  migración la agrega.
- **pgvector NO habilitado**: ningún archivo en `supabase/migrations/` hace
  `CREATE EXTENSION vector` ni similar (grep exhaustivo de la carpeta de
  migraciones, 60+ archivos revisados por nombre — ninguno menciona
  pgvector/embedding).
- **Config LLM env-driven**: `src/services/llm/models.ts` (WKH-135, DONE
  2026-07-01) centraliza 8 getters env-driven (`LLM_PLANNER_MODEL`,
  `LLM_TIMEOUT_MS`, etc.) con patrón defensivo parse→rango→fallback→`log.warn`
  (nunca throw). **Este es el patrón a espejar** para la config del proveedor
  de embeddings (nuevo módulo, mismo patrón defensivo, mismo lugar
  conceptual). Hoy el único proveedor LLM configurado es Anthropic
  (Sonnet 5 / Haiku 4.5) — un proveedor de embeddings puede ser Anthropic-compatible
  (Voyage, partner recomendado) o un vendor nuevo (OpenAI), lo cual es una
  decisión de infra/producto (ver Missing Inputs #1).

### Frecuencia / impacto

- **Superficie (a)** (greedy `fallbackNoRelevance`): rara — solo tras fallo
  total del LLM (2 intentos, WKH-158) o breaker abierto. Post-WKH-158 el
  retry ya reduce la frecuencia de llegar acá. Es un backstop de emergencia,
  no el happy path.
- **Superficie (b)** (MIXED-PLAN-ONLY): **corre en el happy path**, cada vez
  que el LLM planifica exitosamente con `goalTokens.size > 0` y no todos los
  steps son demos. Es la superficie con más volumen y más riesgo de
  false-negative multilingüe silencioso (el LLM sí razonó bien, el backstop
  léxico lo tira igual).
- **Superficie (c)** (`/discover` free-text): afecta solo callers humanos con
  `query.query`; confirmado fuera del money-path del planner.

---

## Acceptance Criteria (EARS)

- **AC-1**: WHEN un goal en español matchea semánticamente la descripción en
  inglés de un agente (sin overlap léxico), the system SHALL retener ese step
  en el backstop MIXED-PLAN-ONLY (superficie b) usando el score semántico como
  condición OR adicional al overlap léxico existente — nunca como reemplazo.
- **AC-2**: IF el proveedor de embeddings configurado no está disponible,
  falla, o excede su timeout, THEN the system SHALL caer al matching léxico
  actual (`tokenizeForRelevance`/`textOverlapsGoal`) sin cambio de
  comportamiento respecto a WKH-152/158/159 (fallback obligatorio, CD-1).
- **AC-3**: WHILE el score semántico esté en modo shadow/telemetría (Fase 1,
  ver Missing Inputs #3), the system SHALL loggear el cosine similarity y la
  decisión léxica actual lado a lado, SIN alterar `planStatus` ni ningún
  campo de billing.
- **AC-4**: the system SHALL calcular el embedding del goal per-request y
  (según Missing Inputs #2) precomputar/cachear los embeddings de agentes a
  partir de contenido estático (name+description+capabilities).
- **AC-5**: IF la Fase 2 (enforcement real) se ratifica, THEN the system
  SHALL preservar el invariante CD-15 de WKH-152 (el filtro MIXED-PLAN-ONLY
  nunca vacía un plan: `0 < relevantSteps.length < steps.length` para
  aplicar el drop).
- **AC-6**: the system SHALL preservar byte-idéntico el guard greedy
  `fallbackNoRelevance` (superficie a) — el score semántico NO habilita
  auto-ejecución adicional en el path money-unsafe sin ratificación humana
  explícita (ver Missing Inputs #4; mismo patrón de rechazo ya dado en
  WKH-158/159 a relajar ese guard).

---

## Scope IN (Fase 1 — recomendado como alcance de ESTA HU)

- Módulo cliente de embeddings, env-driven, mismo patrón defensivo que
  `src/services/llm/models.ts` (parse→rango→fallback→`log.warn`, nunca throw).
- Migración: habilitar `pgvector` + tabla/columna de cache de embeddings
  (diseño exacto depende de Missing Inputs #2).
- Wiring de telemetría (shadow-mode) sobre la superficie (b) MIXED-PLAN-ONLY:
  loggear cosine score junto a la decisión léxica actual, sin enforcement.
- Fallback obligatorio a matching léxico si el proveedor falla/no configurado.
- Timeout propio para la llamada de embeddings, respetando el gate
  `PRE_COMPOSE_TIMEOUT_MS` existente (`orchestrate.ts` ~654-658).

## Scope OUT

- **Enforcement real del umbral** (usar el score para efectivamente retener/
  dropear steps) — Fase 2, HU de seguimiento, gateada por calibración con
  datos de telemetría reales de Fase 1.
- Habilitar el score semántico en la superficie (a) greedy
  `fallbackNoRelevance` para auto-ejecución — bloqueado sin ratificación
  humana explícita (Missing Inputs #4).
- Semántica en `/discover` free-text (superficie c) — no money-path,
  prioridad menor, diferido.
- Cualquier LLM-judge nuevo (esto es embeddings/similaridad vectorial, no
  razonamiento LLM — el árbitro WKH-139 es un patrón distinto).
- Self-host de un modelo local (bge-m3) salvo que el humano lo elija
  explícitamente en Missing Inputs #1 (implica infra nueva fuera del stack
  Node/TS actual).

---

## Decisiones técnicas (DT-N) — tentativas, pendientes de ratificación (ver Missing Inputs)

- **DT-1**: Cliente de embeddings vive en un módulo nuevo espejo de
  `src/services/llm/models.ts` (WKH-135) — env-driven, mismo patrón
  defensivo, mismo lugar conceptual en `src/services/llm/`.
- **DT-2**: Cache de embeddings de agentes en tabla nueva (p.ej.
  `a2a_agent_embeddings`, keyed por `registry_id` + `slug` + `content_hash`)
  en vez de columna directa en `a2a_agents` — porque la mayoría de agentes
  vienen de registries EXTERNOS (no filas propias), el patrón de
  cache-por-hash espeja `kite_schema_transforms` (invalidación por
  content-hash, ya usado en el codebase).
- **DT-3**: El goal se embebe SIEMPRE online, per-request (no cacheable, es
  texto libre del caller).
- **DT-4**: Fase 1 = shadow-mode puro (telemetría, cero cambio de
  `planStatus`/billing). Fase 2 = enforcement, HU separada.
- **DT-5**: Umbral de cosine similarity NO se hardcodea en esta HU — se
  calibra empíricamente con los datos de telemetría de Fase 1 antes de
  decidir Fase 2.

---

## Constraint Directives (CD-N)

- **CD-1 (OBLIGATORIO)**: fallback a matching léxico byte-idéntico
  (WKH-152/158/159) si el proveedor de embeddings está no-configurado, falla,
  o timeoutea. Sin excepciones.
- **CD-2 (PROHIBIDO)**: usar el score semántico para habilitar auto-ejecución
  adicional en el greedy fallback (`usedFallback === true`, superficie a) sin
  ratificación humana explícita — mismo patrón de rechazo ya dado por el
  humano en WKH-158/159.
- **CD-3 (OBLIGATORIO)**: preservar el invariante CD-15 de WKH-152
  (MIXED-PLAN-ONLY nunca vacía un plan) en cualquier enforcement futuro.
- **CD-4 (OBLIGATORIO)**: telemetría de scores en shadow-mode ANTES de
  aplicar el umbral como hard-cutoff — no calibrar a ciegas en producción.
- **CD-5 (PROHIBIDO)**: introducir latencia no acotada en el money-path —
  toda llamada al proveedor de embeddings lleva timeout propio, respetando
  `PRE_COMPOSE_TIMEOUT_MS`.
- **CD-6 (PROHIBIDO)**: hardcodear API keys del proveedor de embeddings —
  env-driven, mismo patrón que `src/services/llm/models.ts`.
- **CD-7 (OBLIGATORIO)**: no romper WKH-152/158/159 — todos los tests
  existentes de esas HUs deben seguir en verde sin modificación de
  comportamiento fuera del shadow-mode aditivo.

---

## Missing Inputs — decisiones que el humano debe ratificar (F2 bloqueado sin esto)

1. **[NEEDS CLARIFICATION — bloqueante F2] Proveedor de embeddings.**
   - **Voyage AI** (recomendado): partner de Anthropic, modelos multilingües
     nativos (voyage-3 / voyage-multilingual-2), diseñado para retrieval.
     Requiere API key nueva (vendor nuevo, hoy el repo solo depende de
     Anthropic). Costo bajo (~$0.02-0.06/1M tokens), latencia de red
     ~100-200ms por call.
   - **OpenAI `text-embedding-3-small`**: barato ($0.02/1M tokens), calidad
     multilingüe decente pero no especializada. También vendor nuevo.
   - **Local bge-m3 (self-host)**: sin costo por-call, sin dependencia de red
     externa, pero requiere infra nueva fuera del stack Node/TS actual
     (runtime de inferencia, GPU/CPU dedicado, ops burden) — mayor lift.
   - **Recomendación del Analyst**: Voyage AI — mejor calidad multilingüe,
     evita levantar infra nueva, y el precompute+cache (DT-2) hace que el
     costo por-request sea trivial (solo el goal se embebe online).

2. **[NEEDS CLARIFICATION — bloqueante F2] Precompute+cache vs online puro.**
   - Precompute+cache (pgvector, tabla nueva `a2a_agent_embeddings` keyed por
     content-hash, DT-2): mantiene los embeddings de agentes fuera del
     critical-path de latencia; requiere migración + habilitar pgvector en
     bdwv (hoy NO habilitado, confirmado en F0) + job de backfill/refresh.
   - Online puro (embeber el corpus de TODOS los candidatos en cada request):
     cero migración/infra, pero agrega latencia real proporcional al tamaño
     del candidate-set (hasta 50 agentes, `discovery.ts` `limit: 50`) al
     money-path, con riesgo de golpear `PRE_COMPOSE_TIMEOUT_MS`.
   - **Recomendación del Analyst**: precompute+cache — el gate de timeout
     existente hace que online-puro sea riesgoso para el money-path.

3. **[NEEDS CLARIFICATION — bloqueante Fase 2, NO bloquea Fase 1]
   Umbral de cosine similarity.**
   No se puede fijar responsablemente sin datos reales. Fase 1 (shadow-mode,
   CD-4) genera la telemetría necesaria para calibrar con pares goal/agente
   reales (incluyendo el corpus de remesas ES/EN visto en el incidente
   WKH-151/152) antes de comprometer un umbral de enforcement.

4. **[NEEDS CLARIFICATION — bloqueante si se quisiera tocar superficie (a)]
   Money-safety en el greedy.** ¿El score semántico puede algún día habilitar
   auto-ejecución en el path greedy money-unsafe (superficie a), con un
   umbral MUY conservador? El humano ya rechazó (WKH-158/159) relajar ese
   guard funcionalmente por el riesgo de over-charge en el atómico (débito
   inmediato post-`planStatus:'ready'`, sin paso de confirmación,
   `orchestrate.ts:1181-1189`). **Recomendación del Analyst: NO** — dejar la
   superficie (a) fuera de scope de esta HU (CD-2), consistente con el
   patrón de decisión ya establecido.

5. **[NEEDS CLARIFICATION — informativo, no bloqueante] Prioridad de la
   superficie (c) `/discover` free-text.** Confirmado fuera del money-path;
   ¿vale la pena una Fase 3 separada para mejorar recall semántico de
   `/discover` directo (no vía `/orchestrate`)? Sugerido como HU de
   seguimiento post-Fase 2, no bloqueante para esta HU.

---

## Análisis de fases (recomendación explícita del Analyst)

Dado el riesgo money-path y la falta de infra de embeddings/pgvector hoy, se
recomienda partir la ejecución en:

- **Fase 1 (ESTA HU, WKH-160)**: infra de embeddings (cliente env-driven +
  cache pgvector) + fallback obligatorio a léxico + shadow-mode/telemetría
  sobre superficie (b). CERO cambio de comportamiento observable
  (`planStatus`/billing byte-idénticos). Sizing L pero riesgo money-path
  bajo porque es puramente aditivo/observacional.
- **Fase 2 (HU de seguimiento, post-calibración)**: enforcement real del
  umbral sobre superficie (b) MIXED-PLAN-ONLY (usar el score como OR junto al
  overlap léxico). Requiere datos de telemetría de Fase 1 + ratificación
  humana del umbral (Missing Inputs #3).
- **Fase 3 (opcional, HU separada)**: superficie (c) `/discover` free-text
  semántico. No money-path, prioridad baja.

La superficie (a) greedy `fallbackNoRelevance` queda **fuera de todas las
fases** de esta HU salvo ratificación humana explícita (Missing Inputs #4,
CD-2) — replica la decisión ya tomada en WKH-158/159.

---

## Análisis de paralelismo

- **No bloquea** otras HUs no relacionadas con `orchestrate.ts`/`discovery.ts`.
- **Conflicto potencial de merge**: filas 161 (WKH-158, `fix/161-wkh-158-llm-planner-retry`)
  y 162 (WKH-159, `fix/162-wkh-159-greedy-multilingual-guard`) del `_INDEX.md`
  están marcadas `in progress` y tocan las MISMAS líneas de `orchestrate.ts`
  (el bloque `:650-976` de planning/relevance guards). **Recomendación**:
  esperar a que 161/162 mergeen (o coordinar explícitamente) antes de F2 de
  esta HU para evitar reescribir sobre líneas en movimiento.
- **Depende de**: WKH-135 (`src/services/llm/models.ts`, DONE) como patrón de
  referencia para el módulo de config del proveedor de embeddings.
- Puede correr en paralelo con HUs de dominios distintos (billing splits,
  ops/observability, docs).

---

## Referencias de código (archivo:línea, confirmadas F0)

| Superficie | Archivo | Líneas |
|---|---|---|
| (a) greedy `fallbackNoRelevance` | `src/services/orchestrate.ts` | 834-867 |
| `tokenizeForRelevance` | `src/services/orchestrate.ts` | 356-363 |
| `textOverlapsGoal` (exportada) | `src/services/orchestrate.ts` | 372-381 |
| (b) MIXED-PLAN-ONLY backstop | `src/services/orchestrate.ts` | 842-850, 869-906 |
| `llmFilterApplies` | `src/services/orchestrate.ts` | 885-886 |
| `applyDrop` (invariante CD-15) | `src/services/orchestrate.ts` | 899-906 |
| planner discovery call (sin `query.query`) | `src/services/orchestrate.ts` | 551-555 |
| gate de timeout pre-compose | `src/services/orchestrate.ts` | ~654-658 |
| débito inmediato post-`ready` (atómico) | `src/services/orchestrate.ts` | ~1181-1189 |
| (c) `/discover` filtro capabilities | `src/services/discovery.ts` | 358-365 |
| (c) `/discover` filtro free-text `query.query` | `src/services/discovery.ts` | 366-374 |
| broaden-retry WKH-157 | `src/services/discovery.ts` | 276-287 |
| config LLM env-driven (patrón a espejar) | `src/services/llm/models.ts` | (módulo completo, WKH-135) |
| tabla `a2a_agents` (sin columna embedding) | `supabase/migrations/20260703000000_wkh134_a2a_agents.sql` | 20-31 |
