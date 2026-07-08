# Work Item — [WKH-166] Plan del LLM autoritativo — neutralizar el drop léxico del backstop

## Resumen
El backstop léxico de relevancia (WKH-152 MIXED-PLAN-ONLY, refinado por WKH-158/159/163)
sigue rompiendo el flujo estrella de remesas: `send money to Peru via the best option`
dropea la pata de KYC/compliance (`agentshop-kyc-validator`) porque la palabra "best"
del goal matchea léxicamente la descripción del agente de corridor ("Found the **best**
route"), y el backstop ve corridor+cashout relevantes y a KYC "off-topic". El LLM
planeó los 3 agentes correctamente — es el backstop POST-LLM el que rompe el plan.
Decisión del founder: el plan del LLM es AUTORITATIVO. Se neutraliza el drop léxico
sobre el plan del LLM (`applyDrop` + terminal-guard de WKH-163); el smart-drop
semántico vuelve con WKH-160 (embeddings).

## Sizing
- SDD_MODE: full
- Estimación: S/M (elimina wiring existente, no agrega superficie nueva; el riesgo
  está en el recompute de billing y en 3 tests que cambian deliberadamente)
- **Recomendación del Analyst: QUALITY.** Mismo patrón que la cadena hermana
  WKH-152/158/159/163 (filas 160-164 de `_INDEX.md`), todas QUALITY por tocar el
  mismo bloque money-path (recompute de `plannedCostUsd`/débito step-0 en
  `orchestrate.ts`). Aunque el cambio es una REDUCCIÓN de código (se remueve
  wiring, no se agrega), el punto de recompute de billing (`:1016-1024`) es
  sensible y el AR/CR debe confirmar `débito == ejecución` explícitamente sobre
  el plan SIN filtrar. FAST+AR es insuficiente dado que 3 tests cambian de
  conducta esperada (no solo se agregan tests nuevos) — QUALITY fuerza AR+CR+F4
  con evidencia archivo:línea, apropiado para un cambio de conducta intencional
  en billing.
- Branch sugerido: `fix/165-wkh-166-llm-plan-authoritative`

## F0 — Grounding (archivo:línea)

### Bloque a neutralizar (`src/services/orchestrate.ts`)
- `:851-859` — `goalTokens`/`llmGoalTokens` (tokenización del goal, WKH-163 excluye
  tokens puramente numéricos).
- `:877-894` — `llmFilterApplies` (gate: `!usedFallback && !allStepsAreDemos &&
  llmGoalTokens.size > 0`).
- `:896-906` — `relevantSteps` (filtro per-step vía `textOverlapsGoal` sobre
  name+description+capabilities+input del agente).
- `:907-927` — terminal delivery guard (WKH-163): rescata el step terminal si
  `droppedCount >= 2 && terminalDropped`.
- `:928-935` — `applyDrop` (CD-15 MIXED-PLAN-ONLY: dropea sólo si `0 <
  relevantSteps.length < steps.length`) + `llmDropped`.
- `:1007-1024` — el bloque `if (applyDrop) { steps = relevantSteps...;
  plannedCostUsd = step0Price...; reasoning += ... }` — reasigna `steps` y
  RECOMPUTA `plannedCostUsd`/step-0 para que débito == ejecución sobre el plan
  YA FILTRADO. Este bloque debe volverse no-op (o eliminarse) para que
  `plannedCostUsd` quede tal como se calculó en `:755-761` (precio del step-0
  ORIGINAL del LLM, sin filtrar).
- `:1040-1059` — recompute de `costPerStep`/`totalCostUsdc`/`maxQuotedCostUsdc`/
  `protocolFeeUsdc` — este bloque itera sobre `steps` (la variable, no
  `relevantSteps`); con `applyDrop` neutralizado, `steps` queda intacto =
  el plan tal cual lo devolvió el LLM (validado sólo por slugs-existen-en-discovery
  y budget-fit, `:698-726`), así que este bloque NO requiere cambios — hereda
  el fix por construcción.

### NO tocar (confirmado en F0)
- **`fallbackNoRelevance`** (`:834-875`) — guard TODO-O-NADA del path GREEDY.
  Gatilla `usedFallback === true` exclusivamente. Sigue intacto.
- **`allStepsAreDemos`** (`:830-832`) — detección de plan 100%-demo (no es
  relevancia léxica contra el goal, es slug-matching contra `demoSlugs`). Sigue
  intacto, corre ANTES del bloque a neutralizar y no depende de él.
- **`greedyPlan()`** (definido `~:280-338`) — construye el plan por PRESUPUESTO
  cuando el LLM falla/circuit-breaker abierto/`!client`. Es una función
  INDEPENDIENTE que arma `steps` desde cero por budget-fit, NO filtra/dropea un
  plan preexistente del LLM. Confirmado: `llmFilterApplies` (`:893-894`)
  requiere `!usedFallback`, así que el bloque a neutralizar NUNCA corre sobre
  el resultado de `greedyPlan()`. El greedy queda 100% fuera de este cambio.
- **`tokenizeForRelevance`/`textOverlapsGoal`** (`:355-381`) — funciones puras
  exportadas. `textOverlapsGoal` también la usa `fallbackNoRelevance` de forma
  indirecta vía el mismo tokenizador y T-152-8 la testea directamente. Ver
  Missing Inputs #1 para la recomendación de qué hacer con ellas.
- **Planner prompt (`llmPlan`)**, **`discovery.ts`**, **fee/split
  (`chargeProtocolFee`/`getProtocolFeeRate`)** — sin cambios.

### Tests que CAMBIAN (conducta vieja se elimina — actualización deliberada)
`src/services/orchestrate.test.ts`:
1. **T-152-1** (`:2121-2162`) — "mixed plan drops the irrelevant agent, charges
   only the relevant". Asserta explícitamente `composedSlugs).not.toContain(
   'defi-sentiment-v1')` y `result.reasoning).toContain('dropped')`. Con el fix,
   AMBOS agentes se ejecutan y se cobran — el test debe reescribirse para
   assertar que el plan completo (weather + defi-sentiment) se ejecuta sin
   'dropped' en el reasoning, o renombrarse/documentarse como test de la
   conducta NUEVA (plan mixto se ejecuta completo).
2. **T-152-4** (`:2339-2380`) — "dropped step-0 → debit repriced to the
   surviving head". Asserta que el débito se repriza al 2º step (0.4) cuando el
   1er step es "irrelevante". Con el fix, el débito SIGUE siendo el precio del
   step-0 ORIGINAL del LLM (defi-sentiment-v1, 0.7) — no hay reprice porque no
   hay drop. El test debe reescribirse para assertar `débito == step-0 original`
   sin importar relevancia léxica.
3. **T-163-4** (`:2752-2808`) — "terminal delivery guard rescues the dropped
   terminal step". Asserta `composeCall.steps).toEqual(['wkh163-weather',
   'wkh163-translator'])` (defi dropeado, terminal rescatado) y
   `reasoning).toContain('dropped')`/`'1 off-topic'`. Con el fix, los 3 steps
   (weather, defi, translator) se ejecutan sin drop — el test del terminal-guard
   ya no tiene comportamiento que verificar (el terminal-guard es dead code tras
   este fix) y debe eliminarse o reescribirse para assertar conservación total.

### Tests que se PRESERVAN (siguen verdes, la conducta que aseveran ya era/sigue
siendo "conservar", ahora universal en vez de condicional)
- **T-152-2** (`:2170-2223`), **T-152-2b** (`:2230-2309`) — "all-disjoint/
  multilingual plan → conserve ALL". Ya aseveraban conservar-todo; con el fix es
  el comportamiento universal, no solo el caso all-disjoint. PASS sin cambios.
- **T-152-3** (`:2313-2335`) — "all-relevant plan → zero regression, no drop".
  PASS sin cambios (nunca hubo drop que aplicar).
- **T-152-5** (`:2385-2435`) — "relevance from input tokens alone → step NOT
  dropped". PASS sin cambios (la aserción "not dropped" sigue siendo cierta,
  ahora por razón distinta — nunca se evalúa el drop).
- **T-152-5b** (`:2440-2469`) — "zero-token goal → filter skipped, step
  conserved". PASS sin cambios.
- **T-152-6** (`:2473-2517`) — "all-demo LLM plan → no_relevant_agent
  (unchanged)". Depende de `allStepsAreDemos`, NO del bloque a neutralizar. PASS
  sin cambios.
- **T-152-8** (`:2521-2529`) — `textOverlapsGoal` pure semantics. Depende de si
  la función se preserva (ver Missing Inputs #1) — si se preserva INERTE, PASS
  sin cambios; si se remueve, este test se remueve junto con ella.
- **T-163-1** (`:2616-2644`), **T-163-2** (`:2648-2676`), **T-163-3**
  (`:2680-2703`) — remesa insignia EN/ES/numeric-only, 3 steps intactos. PASS
  sin cambios (ya aseveraban conservar los 3 steps).
- Toda la suite **WKH-158** (`T-158-1..8b`, `:3690-3961`, retry-on-transient-
  failure) y **WKH-159** (`T-W159a/b/c`, `:1989-2074`) — greedy path y retry,
  fuera de scope. PASS sin cambios.
- **T-W5a/b/c, T-W6** (fallback relevance guard genuino, greedy) — PASS sin
  cambios.
- **T-WKH151-1..5** (broaden-retry de discovery) — PASS sin cambios (discovery
  no se toca).
- Toda la suite WKH-114 (AC verificables por step), WKH-132 (fee cost-based),
  WKH-131 (`/plan`+`/execute`) — PASS sin cambios (no dependen del drop).

## Acceptance Criteria (EARS)
- AC-1: WHEN el goal es "send money to Peru via the best option" y el LLM
  planner selecciona el plan de 3 agentes (KYC, corridor, cashout), the system
  SHALL ejecutar y cobrar los 3 steps — `agentshop-kyc-validator` SHALL NOT ser
  dropeado por coincidencia léxica de "best" con la descripción del corridor.
- AC-2: WHEN el goal es la remesa insignia "Send $400 to my mom in Peru" (EN) o
  su equivalente ES, the system SHALL ejecutar y cobrar los 3 steps, sin
  regresión respecto a WKH-163 (byte-idéntico en `composedSlugs`).
- AC-3: WHILE `usedFallback === false` (path del LLM) Y el plan del LLM mezcla
  un agente relevante con uno léxicamente disjunto del goal, the system SHALL
  ejecutar el plan EXACTAMENTE como lo devolvió el LLM — sin drop per-step, sin
  terminal-guard, sin reasoning `'dropped'`/`'off-topic agent(s) dropped'`.
- AC-4: WHILE el goal es multilingüe (ES vs agentes descritos en EN) y el LLM
  selecciona agentes relevantes reales, the system SHALL devolver `planStatus:
  'ready'` con todos los steps del LLM intactos (comportamiento ya correcto bajo
  MIXED-PLAN-ONLY, se preserva).
- AC-5: the system SHALL NUNCA devolver `steps: []` para un plan que el LLM
  produjo y que pasó el budget-fit (`steps.length > 0` invariante never-empty,
  independiente de relevancia léxica).
- AC-6: WHEN un plan del LLM llega a `planStatus: 'ready'`, the system SHALL
  debitar exactamente el precio del step-0 ORIGINAL del plan del LLM (el primer
  agente que el LLM seleccionó y que pasó el budget-fit, `:755-761`) — SIN
  reprecio por drop (débito == ejecución sobre los steps del LLM, sin filtrar).
- AC-7: IF el LLM planner falla (`plan === null` tras el retry de WKH-158) o el
  circuit breaker está abierto, THEN the system SHALL caer al `greedyPlan()`
  exactamente como hoy — el greedy fallback, `fallbackNoRelevance` y
  `allStepsAreDemos` quedan byte-idénticos, sin cambios.
- AC-8: WHEN el plan del LLM contiene un agente real pero léxicamente off-topic
  respecto al goal, the system SHALL ejecutarlo y cobrarlo junto al resto del
  plan (conducta NUEVA, aceptada explícitamente por el founder — el smart-drop
  semántico se implementa en WKH-160, no en esta HU).

## Scope IN
- `src/services/orchestrate.ts` — neutralizar `llmFilterApplies`/
  `relevantSteps`/terminal-guard/`applyDrop`/`llmDropped` (`:877-935`) y el
  bloque de recompute de billing post-drop (`:1007-1024`).
- `src/services/orchestrate.test.ts` — actualizar deliberadamente T-152-1
  (`:2121`), T-152-4 (`:2339`), T-163-4 (`:2752`); confirmar que el resto de la
  suite (listada en F0) sigue verde sin tocar.

## Scope OUT
- `greedyPlan()` y `fallbackNoRelevance` (path greedy completo, `usedFallback
  === true`).
- `allStepsAreDemos` guard (detección de plan 100%-demo).
- Planner prompt / `llmPlan()` (WKH-158 retry-on-transient-failure).
- `discovery.ts` (WKH-151 broaden-retry, WKH-157 free-text recall).
- Fee/split (`chargeProtocolFee`, `getProtocolFeeRate`, splits WKH-136/143).
- WKH-160 (relevancia semántica por embeddings, fila 163 `_INDEX.md`,
  `in progress`) — el smart-drop reemplazante es una HU separada.

## Decisiones técnicas (DT-N)
- DT-1: El plan del LLM se considera AUTORITATIVO tras pasar únicamente los
  guards YA existentes que no son de relevancia léxica: slug-existe-en-discovery
  (`:701-703`), budget-fit (`:719-726`), y `allStepsAreDemos` (`:830-832`, 100%
  demo). Ningún guard adicional de relevancia per-step corre sobre el plan LLM.
- DT-2: El recompute de billing en `:1007-1024` se vuelve no-op por construcción
  al neutralizar `applyDrop` (queda siempre `false`) — no requiere un `if`
  nuevo, el código existente ya es condicional a `applyDrop`.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO dropear steps del plan del LLM por relevancia léxica — el
  plan se ejecuta tal cual tras slug-check + budget-fit + `allStepsAreDemos`.
- CD-2: PROHIBIDO modificar `fallbackNoRelevance`/`greedyPlan()` — deben quedar
  byte-idénticos (verificar con diff, no solo tests verdes).
- CD-3: PROHIBIDO modificar `allStepsAreDemos` guard (`:830-832`).
- CD-4: OBLIGATORIO preservar el invariante never-empty: `steps.length > 0`
  cuando el LLM produjo un plan y pasó budget-fit.
- CD-5: OBLIGATORIO que `plannedCostUsd`/débito step-0 provenga EXCLUSIVAMENTE
  del cálculo en `:755-761` (precio del step-0 original del LLM) — money-safe,
  ningún recompute posterior debe alterarlo.
- CD-6: OBLIGATORIO actualizar T-152-1/T-152-4/T-163-4 de forma deliberada (no
  romperlos en silencio, no borrarlos sin dejar constancia en el commit/PR de
  por qué la conducta que aseveraban ya no aplica).
- CD-7: PROHIBIDO tocar planner prompt, `discovery.ts`, fee/split — fuera de
  scope.

## Missing Inputs
1. [NEEDS CLARIFICATION — no bloqueante, resolver en F2] ¿Dejar
   `tokenizeForRelevance`/`textOverlapsGoal`/`llmGoalTokens` (scaffolding léxico)
   INERTE (sin wiring que las invoque sobre el plan LLM, pero exportadas/vivas
   para que WKH-160 las reutilice o reemplace) o removerlas por completo y que
   WKH-160 las reconstruya desde cero? **Recomendación del Analyst:** dejar
   `tokenizeForRelevance`/`textOverlapsGoal` (funciones puras, ya exportadas,
   testeadas por T-152-8, también consumidas indirectamente por
   `fallbackNoRelevance` del greedy) INTACTAS, y remover SOLO el wiring
   específico del backstop LLM (`llmGoalTokens`, `llmFilterApplies`,
   `relevantSteps`, terminal-guard, `applyDrop`, `llmDropped`). Minimiza el
   diff, preserva T-152-8 sin cambios, y le da a WKH-160 un punto de enganche
   limpio (reemplazar el tokenizador léxico por un scorer semántico sin tocar
   el resto del flujo).
2. [NEEDS CLARIFICATION — no bloqueante] Sizing QUALITY vs FAST+AR — ver
   sección Sizing arriba; recomendación es QUALITY, a ratificar por el
   orquestador/humano en el gate `HU_APPROVED`.

## Análisis de paralelismo
- **Bloquea/es bloqueada por WKH-160** (fila 163 de `_INDEX.md`, `feat/163-wkh-
  160-semantic-embeddings-relevance`, `in progress`): ambas tocan el MISMO
  bloque de `orchestrate.ts` (`:851-935`). WKH-166 debe mergearse ANTES de que
  WKH-160 continúe a F2/F3 — el work-item de WKH-160 ya recomendaba esperar el
  merge de las filas 161/162 antes de F2; esta HU (166) se suma a esa cola de
  dependencias secuenciales sobre el mismo bloque. NO paralelizable con WKH-160.
- **Independiente** de WKH-159 (fila 162, `in progress`, greedy-only) y WKH-157
  (fila 159, `in progress`, `discovery.ts` free-text) — no tocan el bloque de
  `:851-935` ni el recompute de billing de `:1007-1024`; pueden avanzar en
  paralelo sin conflicto de merge, aunque comparten el mismo archivo
  `orchestrate.ts` (conflicto de líneas cercanas posible, no de lógica).
