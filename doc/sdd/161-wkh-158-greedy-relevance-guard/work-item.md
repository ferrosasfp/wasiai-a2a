# Work Item — [WKH-158] LLM planner retry-on-transient-failure (money-safe)

## Resumen
**RE-SCOPE (2026-07-07, decisión del humano):** el fix original de este work-item
(conservar top-1 en el greedy guard) atacaba un SÍNTOMA. La raíz confirmada en
validación en vivo: el goal `"cotiza el precio del dolar"` cayó a `greedyPlan`
porque el LLM planner falló **transitoriamente** en el primer intento — en un
retry manual (nueva request), el LLM funcionó y eligió `wasi-chainlink-price`
correctamente (juicio semántico real, sin el problema de vocabulario ES/EN que
tiene el greedy). El humano decidió **NO tocar el greedy guard** (`greedyPlan` es
ciego al goal por diseño — conservar ahí sigue siendo money-unsafe, ver análisis
F0 preservado más abajo) y en su lugar **atacar la raíz**: reintentar el LLM
planner **1 vez** cuando falla de forma transitoria/retryable, **antes** de caer
a `greedyPlan`. Si el retry produce un plan válido, se usa ese plan (con el
filtro mixed-plan-only de WKH-152 ya aplicado, sin cambios). Si el retry
TAMBIÉN falla, cae a greedy — comportamiento actual, sin cambios. Esto le da a
los goals multilingües un plan LLM propio (juicio semántico real) en vez de
degradar a un guard léxico ciego, sin alterar la política money-safe existente
del greedy.

## Sizing
- SDD_MODE: full
- Estimación: S/M
- Branch sugerido: `fix/161-wkh-158-llm-planner-retry`
- **QUALITY**: el fix decide qué PATH de planning corre (LLM vs greedy) antes
  del débito real (step-0 vía `plannedCostUsd` → `executeApprovedPlan`, mismo
  money-path que WKH-127/132/152). Cambia el control-flow de la función más
  grande y crítica de billing del archivo (`orchestrateGoal`/`planGoal` en
  `src/services/orchestrate.ts`).

## F0 — Confirmación archivo:línea (dónde falla el LLM planner y cae a greedy)

### `llmPlan()` (`src/services/orchestrate.ts:152-283`)
Devuelve `Promise<LlmPlanResponse | null>` — **nunca tira excepción hacia el
caller salvo `CircuitOpenError`** (`:274`, re-lanzada explícitamente; todo lo
demás se captura y colapsa a `return null`). Puntos de fallo dentro de la
función, en orden:

| Línea | Condición | Hoy | Clasificación (F0) |
|---|---|---|---|
| `:159-164` | `!client` (falta `ANTHROPIC_API_KEY`) | `return null` inmediato, sin llamar a la API | **NO transitorio** — config ausente, un retry en el mismo request NO puede cambiar el resultado |
| `:216-217` | Timeout (`AbortController`, `getLlmTimeoutMs()` = 30_000ms default) dispara `controller.abort()` | La llamada SDK tira `AbortError` → cae al `catch` de `:272-279` → `return null` | **Transitorio/retryable** — timeout de red/latencia puntual |
| `:219-235` | `anthropicCircuitBreaker.execute(() => client.messages.create(...))` — error de red, 5xx, rate-limit (429) del SDK Anthropic | Tira excepción → `catch` de `:272-279` → `return null` (o `CircuitOpenError` si el breaker ya estaba abierto, ver abajo) | **Transitorio/retryable** — falla puntual de la API upstream |
| `:237-243` | `JSON.parse(text)` sobre la respuesta del LLM | `SyntaxError` si el LLM devolvió texto no-JSON → `catch` de `:272-279` → `return null` | **Transitorio/retryable** — glitch de formato, un segundo intento tiene chance real de generar JSON válido |
| `:246-250` | `selectedAgents` no es array o `.length === 0` | `return null` explícito (NO pasa por el `catch`, es un `return` dentro del `try`) | **Ambiguo — ver Missing Inputs #1.** Recomendación: **transitorio/retryable**. El system prompt (`:183`, `"Select 1 or more agents (max N)"`) NUNCA le da al LLM un protocolo para decir "ningún agente es relevante" — un array vacío es señal de malformación/generación incompleta, no una decisión semántica legítima de "no hay plan" |
| `:257-266` | `validated.length === 0` (agentes sin `slug` string válido tras el filtro) | `return null` explícito (mismo patrón que arriba) | **Ambiguo — mismo razonamiento que la fila anterior.** Recomendación: transitorio/retryable |
| `:268-271` | Éxito | `return { selectedAgents, reasoning }` | N/A |
| `:272-279` (catch) | Cualquier excepción no capturada arriba, EXCEPTO `CircuitOpenError` (re-lanzada en `:274`) | `log.error` + `return null` | Ver filas de arriba — el catch es el colector común de timeout/red/parse |

**No hay retry hoy.** `llmPlan` hace exactamente 1 intento por invocación.

### Circuit breaker ya-abierto (`CircuitOpenError`, `src/lib/circuit-breaker.ts:47-53`)
Si `anthropicCircuitBreaker` ya está en estado `open` (≥5 fallos en 60s por
default, `:134-139`) y el cooldown (30s default) NO expiró, `execute()` tira
`CircuitOpenError` **sin siquiera invocar `fn()`** (fail-fast, `:47-53`) — cero
llamada de red. `llmPlan` deja propagar esa excepción específica (`:274`,
`if (err instanceof CircuitOpenError) throw err;`) en vez de colapsarla a
`null` como el resto.

### Punto de caída a greedy — caller (`src/services/orchestrate.ts:656-748`)
```
656  let plan: Awaited<ReturnType<typeof llmPlan>>;
657  try {
658    plan = await llmPlan(goal, budget, candidateAgents, maxAgents);
659  } catch (err) {
660    if (err instanceof CircuitOpenError) {
661      log.warn(..., '[Orchestrate] planner circuit open — using greedy fallback');
662      plan = null;                          // ← breaker abierto también colapsa a null acá
665    } else {
667      throw err;                             // no debería ocurrir (llmPlan ya captura todo lo demás)
668    }
669  }
671  if (plan) {
       ... // línea 678-687: fallback SEPARADO (slugs LLM inválidos, plan SÍ existía) — FUERA DE SCOPE, ver abajo
741  } else {
742    // AC7: LLM failed — fallback to greedy   ← ESTE es el punto exacto a modificar
743    const fallback = greedyPlan(goal, candidateAgents, budget, maxAgents);
744    steps = fallback.steps;
745    reasoning = `[FALLBACK] LLM planning failed. ${fallback.reasoning}`;
746    usedFallback = true;
747    plannedCostUsd = fallback.cost;
748  }
```
`plan === null` es el ÚNICO estado que el caller puede observar hoy: tanto un
fallo interno de `llmPlan` (timeout/red/parse/estructura-vacía) COMO un
`CircuitOpenError` capturado (`:660-664`) terminan colapsados al mismo `null`
antes de llegar a la línea 741. **El retry debe insertarse envolviendo AMBOS
caminos** (`:656-669` completo), no solo el `if(plan)`/`else` de `:671-748` —
si se reintenta solo adentro del `else` de `:741`, un `CircuitOpenError`
producido en el intento original nunca llega a ese branch de forma reintentable
sin antes normalizar `plan = null` como ya hace `:662`.

### Fallback NO relacionado (fuera de scope) — slugs LLM inválidos (`:671-687`)
```
671  if (plan) {
674    const validAgents = plan.selectedAgents.filter(a => discoveredSlugs.has(a.slug));
678    if (validAgents.length === 0) {
680      log.error('[Orchestrate] All LLM-selected slugs are invalid — using fallback');
683      const fallback = greedyPlan(...);
686      usedFallback = true;
687      plannedCostUsd = fallback.cost;
688    } else { ... }
```
Esto es un fallback DISTINTO: el LLM SÍ respondió con estructura válida
(`plan !== null`), pero los slugs que eligió no matchean ningún agente
descubierto (alucinación de slug, no fallo de llamada). **Explícitamente FUERA
DE SCOPE** de este fix — no es el escenario reportado por el humano (que es
"el LLM planner falla transitoriamente", i.e. `plan === null`), y agregarle
retry no tiene sentido: reintentar el MISMO prompt con la MISMA lista de
agentes candidatos tiene una probabilidad no mayor de generar slugs válidos
distintos (no es un fallo de red/formato, es una alucinación de contenido).

### `no_relevant_agent` legítimo — por qué NO se confunde con un fallo transitorio (`:824-897`)
El guard `fallbackNoRelevance` (greedy, `:824-840`) y el backstop MIXED-PLAN-
ONLY del LLM de WKH-152 (`:842-879`) corren **DESPUÉS** de que `steps`/`plan`
ya está resuelto (línea 792 en adelante) — son completamente ortogonales a si
`llmPlan()` devolvió `null` o no. Un "no hay agente relevante" legítimo
significa: el LLM (o greedy) SÍ produjo un plan concreto, pero ese plan no
comparte tokens con el goal. Eso NUNCA pasa por el código nuevo de retry (que
solo actúa cuando `plan === null`, es decir, cuando el LLM NO llegó siquiera a
producir un plan evaluable) — por construcción, el retry no puede confundir un
`no_relevant_agent` legítimo con un fallo transitorio, porque son dos ramas de
código completamente distintas y secuenciales (primero se resuelve `plan`/
`steps`, líneas 656-748; recién después, líneas 792+, se evalúa relevancia).

## Análisis F0 preservado (por qué el greedy NO se toca)
La asimetría de origen del work-item sigue vigente y es la razón por la que el
humano descartó tocar el greedy: en el path LLM, la selección en sí misma es
un juicio semántico (aunque no haya overlap léxico, el LLM entendió el goal).
En `greedyPlan()` (`:287-329`) **no existe ningún juicio semántico** — la
selección es 100% precio/orden de `candidateAgents`, ciega al contenido del
goal (`:296-301`, itera y agrega el primero que entra en budget). Conservar
ahí (como hacía la Opción (a) del work-item original) seguiría siendo
money-unsafe por diseño. Atacar la raíz (por qué el LLM cayó a greedy en
primer lugar) es estrictamente mejor: si el retry tiene éxito, el goal recibe
el juicio semántico real del LLM en vez de necesitar NINGÚN guard de
conservación en el greedy.

## Acceptance Criteria (EARS)

- AC-1: WHEN `llmPlan()` falla por una causa clasificada como **transitoria**
  (timeout `:216-217`, error de red/5xx/rate-limit de la API Anthropic
  `:219-235`, `JSON.parse` inválido `:237-243`, o estructura vacía/sin slugs
  válidos `:246-250`/`:257-266` — ver Missing Inputs #1 para el criterio final
  de estas dos últimas), the system SHALL reintentar `llmPlan()` EXACTAMENTE 1
  vez con el mismo goal/budget/candidateAgents/maxAgents antes de caer a
  `greedyPlan()`.
- AC-2: WHEN el reintento (AC-1) produce un plan válido (`plan !== null`),
  the system SHALL usar ese plan LLM (`usedFallback === false`, sujeto al
  backstop mixed-plan-only de WKH-152 sin cambios, `:842-879`) — NO cae a
  `greedyPlan()`.
- AC-3: WHEN el reintento (AC-1) TAMBIÉN falla, the system SHALL caer a
  `greedyPlan()` (`usedFallback === true`) — comportamiento IDÉNTICO al actual
  (`:741-748`), sin cambios adicionales.
- AC-4: WHEN un goal multilingüe (p.ej. `"cotiza el precio del dolar"`) dispara
  un fallo transitorio del LLM en el primer intento pero el reintento tiene
  éxito, the system SHALL producir el plan LLM (juicio semántico real, p.ej.
  seleccionar `wasi-chainlink-price`) en vez de degradar a `greedyPlan()` +
  el guard léxico `fallbackNoRelevance` (`:824-840`, que NO se modifica).
- AC-5: WHILE se evalúa si reintentar, the system SHALL NOT reintentar más de
  1 vez bajo ninguna circunstancia (bounded, no loop) — máximo 2 invocaciones
  totales de `llmPlan()` por request de `/orchestrate` (intento original +
  1 reintento).
- AC-6: WHILE el retry corre, the system SHALL mantener la latencia adicional
  acotada a, como máximo, 1 llamada extra al LLM (`getLlmTimeoutMs()`,
  30_000ms default) — el retry SOLO se ejecuta en el path de fallo (AC-1); un
  `llmPlan()` exitoso en el primer intento SHALL NOT incurrir en ninguna
  llamada adicional ni latencia extra.
- AC-7: IF `llmPlan()` falla por una causa clasificada como **NO transitoria**
  (config ausente — `!client`, `:159-164` — sin `ANTHROPIC_API_KEY`), THEN the
  system SHALL NOT reintentar y SHALL caer directo a `greedyPlan()`
  (comportamiento actual, un retry sin API key no puede tener éxito distinto).
- AC-8: WHILE el guard `fallbackNoRelevance` (greedy, `:824-840`) y el backstop
  mixed-plan-only de WKH-152 (`:842-879`) evalúan relevancia de un plan YA
  producido, the system SHALL NOT tratar un `no_relevant_agent` legítimo
  (plan concreto sin overlap léxico con el goal) como si fuera un fallo
  transitorio de `llmPlan()` — el retry de este fix SOLO se activa cuando
  `llmPlan()` devuelve `null`/tira excepción (líneas 656-748), nunca en la
  evaluación de relevancia downstream (líneas 792+), que corre en un momento
  posterior y sobre datos distintos.
- AC-9: WHILE `usedFallback === false` (path LLM exitoso, con o sin retry) o
  `usedFallback === true` (greedy, sin cambios), the system SHALL mantener
  byte-idéntico el guard `fallbackNoRelevance` (`:824-840`), `greedyPlan()`
  (`:287-329`), `allStepsAreDemos` (`:803-805`) y el backstop mixed-plan-only
  de WKH-152 (`:842-879`) — ninguno de estos se modifica.

## Scope IN
- `src/services/orchestrate.ts` — SOLO la lógica de fallo/fallback del LLM
  planner: `llmPlan()` (`:152-283`, posible refactor para exponer una razón de
  fallo transitorio/no-transitoria en vez de colapsar todo a `null`) y el
  bloque `:656-748` (try/catch de `CircuitOpenError` + el `if(plan){}else{}`
  que hoy decide caer a greedy) — envolver ambos en la lógica de 1 retry.
- Tests nuevos/actualizados: (a) 1er intento falla transitorio (mock
  timeout/500/rate-limit/JSON inválido) + 2do intento produce plan válido →
  se usa el plan LLM, `usedFallback === false`; (b) ambos intentos fallan →
  cae a greedy, `usedFallback === true`, comportamiento idéntico al actual;
  (c) fallo NO transitorio (`!client`) → NO reintenta, cae directo a greedy;
  (d) repro multilingüe del reporte en vivo (`"cotiza el precio del dolar"`,
  1er intento mock-fail, 2do intento mock-success con `wasi-chainlink-price`).

## Scope OUT
- `greedyPlan()` (`:287-329`) — el humano descartó explícitamente tocarlo.
  Sigue siendo ciego al goal, sin juicio semántico, sin cambios.
- `fallbackNoRelevance` (guard greedy léxico, `:824-840`) — NO se toca. La
  Opción (a) (top-1 conservador) del work-item original QUEDA DESCARTADA por
  el humano, no se implementa.
- El backstop mixed-plan-only de WKH-152 (`:842-879`) — ya DONE, cero cambios.
- `allStepsAreDemos` (`:803-805`) — guard independiente, no se toca.
- El fallback de "slugs LLM inválidos" (`:678-687`, `plan !== null` pero
  `validAgents.length === 0`) — escenario DISTINTO (alucinación de contenido,
  no fallo de llamada), fuera de scope de este fix, ver F0.
- `compose.ts` / settlement / débito de steps 1..N — mecanismo de débito
  existente (WKH-127/132), no se modifica.
- `discovery.ts` / el broaden-retry de WKH-151 — no se toca.

## Decisiones técnicas (DT-N)
- DT-1: El fix se acota EXCLUSIVAMENTE a la lógica de fallo/retry alrededor de
  `llmPlan()` — no se toca ninguna lógica downstream (relevance guards,
  billing, compose).
- DT-2: El retry reutiliza EXACTAMENTE la misma función `llmPlan()` con los
  mismos argumentos (goal, budget, candidateAgents, maxAgents) — no hay un
  segundo prompt/modelo/lógica de retry "más simple". Esto es deliberado:
  money-safe (mismo path ya auditado) y consistente con el repro en vivo
  (mismo prompt, 2do intento tuvo éxito sin cambiar nada).
- DT-3: El retry debe envolver el bloque `:656-669` COMPLETO (try/catch de
  `CircuitOpenError` incluido), no solo el `else` de `:741` — de lo contrario
  un `CircuitOpenError` del primer intento nunca sería reintentable de forma
  uniforme con los demás fallos transitorios (ver F0, tabla de clasificación).
- DT-4: `CircuitOpenError` es un caso límite dentro de "transitorio": si el
  breaker YA estaba abierto antes del primer intento, un reintento inmediato
  (mismo request, milisegundos después) casi seguro vuelve a tirar
  `CircuitOpenError` (fail-fast SIN llamada de red — el cooldown de 30s
  default no habrá expirado). El costo de incluirlo en el set retryable es
  ~0 (no hay round-trip de red), pero el valor esperado también es ~0. F2
  decide si excluirlo explícitamente (recomendación Analyst) o incluirlo por
  uniformidad de código — de cualquier forma AC-5/AC-6 (bounded, latencia
  acotada) quedan satisfechos.
- DT-5: Considerar exponer desde `llmPlan()` un resultado discriminado (p.ej.
  `{ ok: true, plan } | { ok: false, transient: boolean }`) en vez de colapsar
  todo a `null`, para que el caller (`:656-748`) pueda decidir "reintentar
  sí/no" sin re-inferir la causa por fuera. Alternativa más simple: mantener
  la firma `Promise<LlmPlanResponse | null>` y decidir "es transitorio" por
  tipo de excepción ANTES de que `llmPlan()` la colapse a `null` (requiere que
  `llmPlan()` deje de capturar TODO internamente, o que exponga un flag
  adicional). F2 decide la forma concreta; ambas cumplen los ACs.

## Constraint Directives (CD-N)
- CD-1: OBLIGATORIO máximo 1 retry — bounded, sin loop. Nunca más de 2
  invocaciones totales de `llmPlan()` por request (AC-5).
- CD-2: PROHIBIDO reintentar fallos NO transitorios (`!client`/config ausente,
  `:159-164`) — cae directo a greedy sin retry (AC-7).
- CD-3: PROHIBIDO modificar `greedyPlan()` (`:287-329`), `fallbackNoRelevance`
  (`:824-840`), `allStepsAreDemos` (`:803-805`) o el backstop mixed-plan-only
  de WKH-152 (`:842-879`) — byte-idénticos (AC-9).
- CD-4: OBLIGATORIO money-safe: el retry reutiliza el MISMO `llmPlan()` (mismo
  prompt/modelo/candidateAgents) — no introduce un path de cobro nuevo ni
  altera cómo se resuelve `plannedCostUsd`/`resolveAgentPriceUsdc` (DT-2).
- CD-5: OBLIGATORIO que la latencia adicional esté acotada a máximo 1 llamada
  extra al LLM, y SOLO en el path de fallo — cero latencia extra si el primer
  intento tiene éxito (AC-6).
- CD-6: OBLIGATORIO un test que reproduzca el repro exacto (goal
  `"cotiza el precio del dolar"`, 1er intento mock-fail transitorio, 2do
  intento mock-success con `wasi-chainlink-price`) verificando
  `usedFallback === false` y el plan LLM usado.
- CD-7: OBLIGATORIO un test que verifique que 2 fallos consecutivos (ambos
  transitorios) caen a greedy exactamente igual que hoy — `usedFallback ===
  true`, mismo `plannedCostUsd`/`reasoning` shape.

## Missing Inputs
- [NO bloqueante — para definir en F2, no requiere gate humano] Clasificación
  exacta de `selectedAgents` vacío/sin slugs válidos (`:246-250`, `:257-266`)
  como transitorio-retryable vs legítimo-no-retry. Recomendación del Analyst:
  **transitorio/retryable** — el system prompt (`:183`) nunca le da al LLM un
  protocolo para decir "ningún agente es relevante" (siempre debe seleccionar
  ≥1), así que un array vacío es señal de malformación de la respuesta, no una
  decisión semántica legítima. Esto NO es una decisión de money-safety con
  trade-offs (a diferencia del work-item original, Opción a/b/c/d) — es un
  detalle mecánico de clasificación de errores que el Architect puede resolver
  directamente en el SDD sin ratificación humana previa, ya que en cualquier
  caso el resultado final (si el retry falla, cae a greedy — comportamiento
  actual) es idéntico; la única diferencia es si se "gasta" el retry en este
  caso específico o no.
- [NO bloqueante — para definir en F2] Si `CircuitOpenError` (breaker ya
  abierto) entra en el set retryable (ver DT-4). Cualquiera de las dos
  opciones satisface los ACs; es una preferencia de limpieza de código, no de
  comportamiento observable (el retry en ese caso específico casi con
  certeza no tiene efecto, pero tampoco tiene costo de red).

## Análisis de paralelismo
- No bloquea ninguna HU en curso. Independiente de WKH-157 (discover
  free-text, in progress) y de WKH-152 (mixed-plan-only, ya DONE en el código
  leído — CERO cambios en este fix).
- Puede correr en paralelo con cualquier HU que no toque
  `src/services/orchestrate.ts` en las líneas 152-283 (`llmPlan`) o 656-748
  (punto de decisión LLM→greedy) — el resto del archivo (p.ej.
  `executeApprovedPlan`, `quoteMaxCostUsdc`, los guards de relevancia
  `:792-930`) es zona de riesgo de conflicto de merge si otra HU está activa
  ahí simultáneamente; verificar antes de F3.
- Reemplaza completamente el análisis de paralelismo del work-item original
  (Opción a/b/c/d de conservación greedy) — esa vía queda descartada, no hay
  trabajo residual de esa rama pendiente.
