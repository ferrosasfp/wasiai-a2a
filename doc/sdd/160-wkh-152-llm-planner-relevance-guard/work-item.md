# Work Item — [WKH-152] Planner LLM sin guard de relevancia — agente real irrelevante se ejecuta y se cobra

## Resumen
En el path del **planner LLM** de `/orchestrate` (`planOrchestration` en `src/services/orchestrate.ts`),
si el LLM arma un plan que incluye un agente real pero IRRELEVANTE al goal (mezclado o no con
agentes relevantes), ese agente se ejecuta y se cobra sin ningún guard de relevancia. El guard de
relevancia que existe hoy (`fallbackNoRelevance`, keyword-overlap) SOLO corre en el path **greedy**
(`usedFallback === true`) — el path normal del LLM está explícitamente exento por diseño (comentario
`:791-792`: *"NO aplica al path normal del LLM... que ya juzga relevancia con su propio criterio
semántico y NO debe duplicarse ni endurecerse acá"*). Tras WKH-151 (broaden-retry sin capabilities,
fila 157 del INDEX) el planner ve un pool más amplio de candidatos → más chance de que el LLM elija
algo tangencial → mayor exposición económica medible en la telemetría `orchestrate_goal`
(`agentCount`, `broadenRetryUsed`, `retryAgentCount`).

## Sizing
- SDD_MODE: full
- Estimación: M
- Branch sugerido: `fix/160-wkh-152-llm-relevance-guard`
- Justificación (QUALITY, no FAST+AR): es money-path que además de agregar el guard debe
  **recomputar el step-0 / `plannedCostUsd`** cuando el step filtrado era el primero de la lista
  (afecta directamente la base del débito post-plan de WKH-127 y el fee-on-cost de WKH-132,
  ambos endurecidos con cuidado extremo en HUs previas). Un guard mal calibrado que rompa el
  `step0Slug`/`step0Registry` (`:707-712`) o el orden `passOutput: index > 0` introduciría un bug
  de billing nuevo — amerita el rigor completo de QUALITY (F2 con AR dedicado a este cómputo)
  en vez de FAST+AR.

## F0 — Confirmación del mecanismo (leído en código, no re-investigado)

Leído `src/services/orchestrate.ts` completo (1369 líneas):

1. **El guard de relevancia existe, pero SOLO cubre el fallback greedy.**
   `tokenizeForRelevance` (`:342-350`) es el helper determinístico (lowercase, split
   no-alfanumérico, descarta tokens <3 chars, sin LLM). `fallbackNoRelevance` (`:793-809`) lo usa
   para comparar los tokens del `goal` contra `name + description + capabilities` de cada agente
   seleccionado — pero está gateado por `usedFallback && (...)` en `:795`. El comentario de diseño
   en `:331-340` y `:786-792` confirma que esto es INTENCIONAL, no un olvido: el path del LLM se
   consideró "ya juzga relevancia con su propio criterio semántico" y el guard de keyword-overlap
   se reservó para el fallback (donde no hay ningún juicio semántico, solo presupuesto).

2. **El path del LLM (`if (plan) { ... }`, `:650-719`) NO valida relevancia en ningún punto.**
   Tras `llmPlan()` devolver un plan, el único filtrado es: (a) `discoveredSlugs.has(a.slug)`
   (`:652-655`, slug debe existir en discovery — NO es un chequeo de relevancia, un agente real
   pero fuera de tema pasa este filtro sin problema), y (b) el budget check (`:668-678`, solo
   verifica que `totalCost + cost <= budget`). `steps = budgetedAgents.map(...)` (`:680-690`)
   construye los steps finales sin ningún score/umbral de relevancia. La única defensa restante
   compartida por ambos paths es `allStepsAreDemos` (`:782-784`, `:811`) — pero solo dispara si
   **TODOS** los steps son demos por slug exacto (`base-demo,avax-demo,kite-demo`). Un plan MIXTO
   (1 agente real relevante + 1 agente real irrelevante, o solo agentes reales irrelevantes sin
   ningún demo) no dispara ni `allStepsAreDemos` ni `fallbackNoRelevance` (porque
   `usedFallback === false`) → **pasa a `planStatus: 'ready'` sin filtrar el agente irrelevante**.

3. **Punto donde se decide ejecutar + cobrar cada step (confirmado, es la exposición real):**
   - Step-0 se debita en `executeApprovedPlan` vía `budgetService.debit(...)` en `:1065-1073`
     (`step0DebitUsd = plannedCostUsd + step0GasOverhead`), ANTES de cualquier ejecución de
     compose. `plannedCostUsd` viene de `plan.plannedCostUsd`, resuelto en `planOrchestration`
     (`:707-713`) con `resolveAgentPriceUsdc(step0Slug, step0Registry)` sobre el **primer** step
     del array `steps` — si ese primer step es el agente irrelevante, se le cobra su precio
     completo sin ejecutar nada de valor para el goal.
   - Steps 1..N se debitan dentro de `composeService.compose(...)` (invocado en `:1129`, guard
     `i>0` documentado en el comentario `:1141-1146`) — fuera de este archivo, pero confirmado
     por el comentario que ese es el mecanismo (compose.ts, fuera de scope de esta HU).
   - Conclusión: **cualquier agente presente en `steps` al llegar a `executeApprovedPlan` se
     ejecuta y se cobra, sin excepción** — el único punto de corte pre-débito es
     `allStepsAreDemos || fallbackNoRelevance` en `:811`, que no cubre el caso mixto del LLM.

4. **Exposición ampliada por WKH-151 (fila 157, DONE):** el broaden-retry (`:539-555`) repuebla
   `discovered.agents` sin filtro de `preferCapabilities` cuando el primer discovery da 0
   resultados — más candidatos visibles para el LLM (hasta `MAX_AGENTS_IN_PROMPT = 30`, `:51`)
   incrementa la probabilidad de que el LLM incluya un agente tangencial en el plan. La
   telemetría `orchestrate_goal` ya registra `broadenRetryUsed`/`retryAgentCount` (`:589-591`,
   `:761-762`, `:1344-1345`) — permite correlacionar en bdwv si los planes post-retry tienen mayor
   tasa de agentes irrelevantes (medible, no bloqueante para esta HU).

## Fix propuesto (para ratificar/ajustar en F2)

**Opción recomendada — guard post-plan determinístico, reusando `tokenizeForRelevance` (menos
invasiva, money-safe):**

Extender el MISMO criterio de relevancia que ya usa `fallbackNoRelevance` (keyword-overlap entre
goal tokens y `name+description+capabilities` del agente, 100% determinístico, sin LLM extra) para
que corra también sobre el plan producido por el LLM, con dos diferencias de diseño respecto al
guard actual:

1. **Filtrado per-step, no rechazo del plan completo.** El guard actual (`fallbackNoRelevance`) es
   todo-o-nada: si NINGÚN step del fallback comparte token con el goal, rechaza el plan entero.
   Para el path del LLM eso sería demasiado agresivo en el caso mixto (rechazar un plan que SÍ
   tiene 1 agente genuinamente relevante solo porque también trae 1 irrelevante castigaría al
   caller sin necesidad). Fix propuesto: evaluar cada step del plan LLM individualmente contra el
   goal; los steps SIN overlap de tokens se DESCARTAN del array `steps` antes del débito/compose;
   los steps CON overlap se conservan y se ejecutan/cobran exactamente como hoy.
2. **Si el filtrado deja el array vacío**, el plan cae al mismo camino que `allStepsAreDemos`/
   `fallbackNoRelevance` hoy: `planStatus: 'no_relevant_agent'`, cero debit, cero compose (reusa
   el early-return existente `:811-861`, sin bifurcar lógica nueva de respuesta).
3. **Si el filtrado deja el array parcial**, `plannedCostUsd`/`step0Slug`/`step0Registry`
   (`:707-713`) deben recalcularse sobre el array YA FILTRADO (no sobre `budgetedAgents` original)
   para que el step-0 facturado sea siempre el primer agente que realmente se ejecuta —
   `passOutput: index > 0` también debe reindexarse tras el filtro.

**Por qué esta opción y no las alternativas:**
- *Alternativa descartada — flag de relevancia emitido por el propio LLM por step*: requiere
  cambiar el prompt (contrato de salida `LlmPlanAgent`) y confiar en que el LLM autoevalúe su
  propia elección — el mismo LLM que ya erró al seleccionarlo. Menos confiable, más invasiva
  (toca el contrato JSON + el prompt), sin ganancia de determinismo.
- *Alternativa descartada — score de relevancia con umbral configurable*: agrega superficie
  (nueva env var, nueva lógica de scoring) sin evidencia de que el binario overlap/no-overlap sea
  insuficiente; el guard existente ya usa ese mismo criterio binario para el fallback y funciona.
- *Alternativa descartada — rechazar el plan COMPLETO si algún step es irrelevante (en vez de
  filtrar per-step)*: money-safe en el sentido de "rechazar > cobrar de más", pero penaliza al
  caller de un plan legítimo con 1 agente marginal — no cobra de más, pero tampoco cobra trabajo
  válido que sí se podría ejecutar. Filtrado per-step es estrictamente mejor: nunca cobra el
  irrelevante y SÍ ejecuta/cobra el resto si algo relevante sobrevive.

La decisión final de diseño (per-step filter vs. rechazo total, umbral exacto de overlap) queda
para el Architect en F2 — este work item fija el objetivo (AC-1..AC-7) y el criterio de
determinismo (CD-4), no la implementación línea a línea.

## Acceptance Criteria (EARS)

- AC-1: WHEN el planner LLM selecciona un plan que mezcla al menos un agente real relevante y al
  menos un agente real irrelevante al goal (agente real = no está en `getDemoSlugs()`, irrelevante
  = cero overlap de tokens entre el goal y `name+description+capabilities` del agente, mismo
  criterio que `tokenizeForRelevance`), the system SHALL excluir el/los step(s) irrelevante(s) del
  plan ANTES de cualquier débito (`budgetService.debit`) o ejecución de compose
  (`composeService.compose`), de forma que ese agente NO se ejecute ni se cobre.
- AC-2: WHEN el filtrado de relevancia del plan LLM deja el array de steps vacío (todos los
  agentes seleccionados por el LLM resultan irrelevantes al goal), the system SHALL devolver
  `planStatus: 'no_relevant_agent'` con cero debit y cero compose — mismo contrato de respuesta
  que el caso `allStepsAreDemos`/`fallbackNoRelevance` de hoy (reutiliza el early-return
  `:811-861`, sin nuevo `planStatus`).
- AC-3: WHEN el planner LLM selecciona un plan donde TODOS los agentes son relevantes al goal, the
  system SHALL ejecutar y cobrar el plan exactamente igual que hoy — sin cambios en
  `plannedCostUsd`, `totalCostUsdc`, `protocolFeeUsdc`, `steps.length` ni el orden de ejecución
  (cero regresión para el caso feliz, que es la mayoría del tráfico real).
- AC-4: WHEN un step es excluido del plan LLM por irrelevancia y ese step era el step-0 original
  (`budgetedAgents[0]`), the system SHALL recalcular `plannedCostUsd`/`step0Slug`/`step0Registry`
  sobre el PRIMER step SOBREVIVIENTE post-filtro, de forma que el monto debitado en
  `executeApprovedPlan` (`:1065-1073`) siempre corresponda al agente que efectivamente se ejecuta
  (sin mismatch billing↔ejecución).
- AC-5: the system SHALL implementar el guard de relevancia del plan LLM de forma 100%
  determinística, en memoria, SIN llamadas adicionales a Anthropic ni a ningún servicio externo
  (mismo criterio de costo/latencia que `fallbackNoRelevance`, que ya es determinístico).
- AC-6: IF el plan ya es rechazado hoy por `allStepsAreDemos` (todos los steps son demos por
  slug exacto), THEN the system SHALL seguir devolviendo `no_relevant_agent` exactamente como hoy,
  y el nuevo guard de relevancia del path LLM NO SHALL ejecutarse redundantemente sobre un plan
  que ya fue vaciado por ese chequeo previo (evita doble evaluación, mantiene el mensaje de
  reasoning existente para el caso 100%-demo).
- AC-7: WHILE `usedFallback === true` (path greedy), the system SHALL mantener
  `fallbackNoRelevance` operando exactamente igual que hoy — el guard nuevo del path LLM NO SHALL
  duplicarse ni modificar el comportamiento del fallback greedy existente.

## Scope IN
- `src/services/orchestrate.ts` — función `planOrchestration`, específicamente:
  - El bloque `if (plan) { ... }` (`:650-719`) donde se construyen los `steps` del path LLM.
  - El bloque del guard de relevancia (`:771-861`), para integrar el nuevo filtrado ANTES o junto
    a `allStepsAreDemos`/`fallbackNoRelevance` sin duplicar el early-return `no_relevant_agent`.
  - El helper `tokenizeForRelevance` (`:342-350`) — se REUSA, no se reescribe.
  - El cómputo de `step0Slug`/`step0Registry`/`plannedCostUsd` (`:707-713`), si el diseño elegido
    en F2 requiere recomputarlo post-filtro (AC-4).
- `src/services/orchestrate.test.ts` (o test dedicado) — casos: plan mixto (relevante + irrelevante)
  → solo se cobra/ejecuta el relevante; plan 100% irrelevante (sin ser demos) → `no_relevant_agent`
  sin debit; plan 100% relevante → byte-idéntico a hoy; plan all-demos → sigue dando
  `no_relevant_agent` sin debit (regresión AC-6).

## Scope OUT
- `src/services/discovery.ts` y el broaden-retry de WKH-151 (`:539-555`) — NO se tocan, solo se
  documenta que amplían la exposición (F0 punto 4).
- `src/services/compose.ts` — el settle real por step (steps 1..N) queda intacto; esta HU solo
  decide QUÉ steps llegan a `composeService.compose`, no cómo se ejecutan/cobran ahí dentro.
- El fallback greedy (`greedyPlan`, `:287-329`) y su guard `fallbackNoRelevance` (`:793-809`) —
  ya cubierto, no se modifica (AC-7).
- El prompt del planner LLM (`systemPrompt`/`userPrompt`, `:180-214`) — el fix propuesto es
  puramente un guard post-plan determinístico, NO requiere cambiar el prompt (a diferencia de
  WKH-153, fila 158, que sí tocó el prompt para otro bug). Si el AR de F2 decide que además hace
  falta reforzar el prompt para reducir la tasa de falsos positivos del LLM, es un cambio
  adicional a ratificar explícitamente, no asumido acá.
- Cualquier cambio al `input_schema`-awareness del planner (WKH-153, fila 158, ya DONE) — HU
  distinta, sin overlap de código.
- Nuevo umbral/score de relevancia configurable por env — se reusa el criterio binario existente
  (overlap de tokens ≥1), ver "Fix propuesto" para la justificación.

## Decisiones técnicas (DT-N)
- DT-1: El guard de relevancia del path LLM se implementa como **filtrado per-step** (no rechazo
  del plan completo), a diferencia de `fallbackNoRelevance` que es todo-o-nada. Justificación: el
  path LLM es el camino de mayor tráfico real y penalizar un plan mixto legítimo (1 irrelevante +
  N relevantes) con un rechazo total sería sobre-conservador y rompería planes que hoy funcionan
  parcialmente bien. Ver "Fix propuesto" para el detalle.
- DT-2: Se reusa `tokenizeForRelevance` (mismo criterio, mismo helper) en vez de introducir un
  criterio de relevancia distinto para el path LLM — evita divergencia de semántica entre los dos
  guards y minimiza blast radius (cero código nuevo de tokenización).
- DT-3: El recálculo de `plannedCostUsd`/step-0 tras el filtrado (AC-4) es la parte de mayor riesgo
  de esta HU — motivo principal del sizing QUALITY (ver justificación en Sizing). El F2 debe
  documentar explícitamente el nuevo flujo de índices (`budgetedAgents` → `filteredSteps` →
  `step0`) para que el AR pueda verificar que no hay off-by-one ni mismatch billing↔ejecución.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO relajar, remover o modificar el comportamiento observable de
  `fallbackNoRelevance` (`usedFallback === true`) o de `allStepsAreDemos` — ambos deben seguir
  cubriendo sus casos exactamente igual que hoy (AC-6, AC-7).
- CD-2: PROHIBIDO que cualquier step filtrado por irrelevancia llegue a
  `budgetService.debit(...)` o `composeService.compose(...)` — el filtrado debe ocurrir ANTES de
  ambos puntos (`:1065-1073` y `:1129` respectivamente).
- CD-3: PROHIBIDO no-cobrar trabajo válido — un plan 100% relevante (o la porción relevante de un
  plan mixto) debe seguir ejecutándose y cobrándose exactamente igual que si el guard no existiera
  (AC-3).
- CD-4: OBLIGATORIO que el guard sea 100% determinístico y sin llamadas LLM/red adicionales
  (AC-5) — cero costo/latencia extra por request.
- CD-5: PROHIBIDO romper WKH-127 (billing/refund del step-0, fila 125 del INDEX) ni WKH-132
  (fee-on-cost, fila 129 del INDEX) — el guard corre estrictamente ANTES del pricing/debit
  existente; su único efecto sobre esas capas es CUÁLES steps les llegan, nunca CÓMO se
  debitan/refunden (DT-3, AC-4).
- CD-6: PROHIBIDO doble-cobro: si un step se filtra, no debe aparecer ni en el step-0 debit
  (`executeApprovedPlan`) ni en el loop de compose (steps 1..N) — verificar explícitamente en
  tests que el array `steps` que llega a `executeApprovedPlan`/`composeService.compose` ya NO
  contiene el agente irrelevante (no basta con "no cobrarlo doble", no debe cobrarse NINGUNA vez).
- CD-7: OBLIGATORIO test de regresión explícito para el caso all-demos (`allStepsAreDemos`) y para
  el caso greedy-fallback (`fallbackNoRelevance`) — confirmar que ambos siguen dando
  `no_relevant_agent` sin debit tras el cambio (CD-1).

## Missing Inputs
- [resuelto en F0/F1 — default money-safe aplicado] El humano no especificó si el filtrado debe
  ser per-step o rechazo-total-del-plan. Default aplicado (DT-1): filtrado per-step, porque
  maximiza "no cobra de más" SIN caer en "no cobra trabajo válido" (ambos prohibidos explícitamente
  en el brief del orquestador). Si el Architect en F2 encuentra un riesgo no contemplado con el
  filtrado per-step (p.ej. reindexar `passOutput` rompe una dependencia de datos entre steps que
  el LLM sí quiso conectar), puede escalar el rechazo-total como alternativa — debe documentarlo
  como cambio de DT-1, no asumirlo silenciosamente.
- [NEEDS CLARIFICATION — no bloqueante] El umbral exacto de "irrelevante" (hoy: cero overlap de
  tokens ≥3 chars) es el MISMO que usa `fallbackNoRelevance` — no se propone endurecerlo ni
  relajarlo en esta HU. Si el AR/QA de F2-F4 detecta una tasa alta de falsos positivos (agentes
  genuinamente relevantes descartados por vocabulario distinto al del goal) o falsos negativos
  (agentes irrelevantes que comparten 1 token común irrelevante, p.ej. "usd" o "agent"), es
  candidato a HU de refinamiento separada — no bloquea esta HU, que fija el guard binario existente
  como baseline.

## Análisis de paralelismo
- No bloquea otras HUs activas del INDEX (fila 159, WKH-157, discover free-text, es un archivo
  distinto — `discovery.ts` — y no toca `orchestrate.ts`).
- Depende conceptualmente de WKH-151 (fila 157, DONE) como motivador de la exposición ampliada,
  pero NO requiere cambios a esa HU ni la bloquea — son cambios independientes en el mismo archivo
  (`orchestrate.ts`) en regiones de código distintas (discovery retry vs. plan-relevance guard).
  Recomendado NO paralelizar con otra HU que también toque `planOrchestration`
  (`orchestrate.ts:427-918`) para evitar conflictos de merge en la misma función.
- Puede ir en paralelo con cualquier HU que no toque `src/services/orchestrate.ts`.
