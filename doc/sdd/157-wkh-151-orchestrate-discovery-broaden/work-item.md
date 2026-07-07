# Work Item — [WKH-151] Orchestrate discovery broaden-retry (fix plan vacío intermitente)

## Resumen
`/orchestrate` devuelve intermitentemente un plan vacío ($0, `planStatus:'no_agents'`, sin agentes) cuando las `preferCapabilities` que manda el caller (Chaski) no matchean el nombre exacto de las capabilities publicadas por los agentes de remesa en bdwv (`remit.corridor-discovery`, `remit.cashout-match`, `remit.kyc-check`). El fix agrega UN retry de discovery sin el filtro de capabilities cuando el primer intento da 0 agentes, para que el LLM planner (que ya hace el matching de relevancia real) tenga candidatos sobre los que decidir en vez de recibir un candidate-set vacío antes de llegar a él.

## Sizing
- SDD_MODE: mini (bugfix acotado, money-path adjacent → requiere AR)
- Estimación: S
- Branch sugerido: `fix/157-wkh-151-orchestrate-discovery-broaden`

## Confirmación F0 (código real, no re-diagnóstico)

- `src/services/orchestrate.ts:429` — `const { goal, budget, preferCapabilities, maxAgents = 5 } = request;`. `preferCapabilities` viene tal cual del caller (Chaski), sin normalización ni derivación del gateway.
- `src/services/orchestrate.ts:505-509` — único call de discovery del path:
  ```ts
  const discovered = await discoveryService.discover({
    capabilities: preferCapabilities,
    maxPrice: budget / maxAgents,
    limit: 50,
  });
  ```
- `src/services/orchestrate.ts:512-546` — si `discovered.agents.length === 0`, early-return inmediato: `planStatus:'no_agents'`, `steps:[]`, `totalCostUsdc:0`, evento `orchestrate_goal {agentCount:0, fallback:false}`. Esto ES la traza confirmada en telemetría bdwv.
- `src/services/discovery.ts:311-318` — el filtro de capabilities es **condicional**: `if (query.capabilities?.length) { ... }`. Si `capabilities` es `undefined` o `[]`, el bloque entero se saltea — no hay ningún otro gate que lo reemplace. Esto confirma que "retry sin caps" = literalmente pasar `capabilities: undefined` en el segundo call; no requiere tocar `discovery.ts`.
- `src/services/discovery.ts:328-331` — `maxPrice` es un filtro **independiente** (`if (query.maxPrice != null) ...`) que no depende de `capabilities`. El retry propuesto preserva `maxPrice: budget / maxAgents` y `limit: 50` sin cambios — solo se omite `capabilities`.
- Los agentes de remesa (`remit.corridor-discovery` $0.05, `remit.cashout-match` $0.01, `remit.kyc-check` $0.001) están `status:active`. Con `maxAgents=5` default y un `budget` típico de Chaski, `$0.05 ≤ budget/5` en cualquier escenario razonable (budget ≥ $0.25) — el filtro de precio NO es la causa; el filtro de capabilities sí lo es cuando el string exacto no matchea.

### Riesgo money-path (lo que el AR va a atacar) — analizado y mitigado

**Pregunta**: ¿ampliar discovery (sin filtro de capabilities) puede hacer que el planner elija agentes echo/demo o irrelevantes que SÍ cobren, cuando hoy — con candidate-set vacío — no se cobra nada?

**Respuesta, con evidencia de código**:

1. **Guard `allStepsAreDemos` (`orchestrate.ts:713-726`) es post-plan y NO depende de cómo se llamó a discovery.** Si el plan seleccionado (LLM o greedy) está compuesto ENTERAMENTE por slugs en `demoSlugs` (`base-demo`, `avax-demo`, `kite-demo` por default, `orchestrate.ts:66`), el resultado se fuerza a `planStatus:'no_relevant_agent'` con `steps:[]`, `totalCostUsdc:0`, **sin debitar ni ejecutar compose** (`orchestrate.ts:753-779`). Este guard corre exactamente igual hoy con `preferCapabilities` matcheando o no — la ampliación del candidate-set no lo debilita ni lo bypassea. Un plan 100% demo sigue sin cobrar, aun con el fix.
2. **El filtro de precio (`maxPrice`) NO se relaja.** El retry propuesto solo omite `capabilities`; `maxPrice: budget / maxAgents` se mantiene sin cambios en el segundo call. Además, dentro del planner, el loop de presupuesto (`orchestrate.ts:616-626`, `totalCost + cost <= budget`) es una segunda barrera independiente que descarta agentes que excedan el budget aunque hayan pasado el pre-filtro de discovery.
3. **Riesgo residual (pre-existente, NO introducido por este fix): el LLM planner es el único juez de relevancia para agentes reales NO-demo.** El guard `fallbackNoRelevance` (`orchestrate.ts:728-751`, chequeo de overlap de tokens goal↔agente) solo aplica al path `usedFallback === true` (greedy); el path LLM normal confía en las instrucciones del system prompt (`orchestrate.ts:186-191`, incluye explícitamente "Do NOT select trivial echo/demo/test agents... unless the goal is EXPLICITLY a connectivity/echo/settlement test") pero no tiene un guard de código equivalente a `allStepsAreDemos` para "agentes reales pero irrelevantes al goal". **Esto es idéntico al comportamiento actual cuando `preferCapabilities` sí matchea** (el LLM ya recibe candidatos con precio/capacidad heterogénea y decide solo). Ampliar el pool (quitando el filtro de nombre exacto de capability) aumenta la cantidad de candidatos visibles (topeado en `MAX_AGENTS_IN_PROMPT=30`, `orchestrate.ts:51,166`), lo cual incrementa marginalmente la superficie sobre la que el LLM decide, pero NO introduce una vía de cobro nueva sin protección: cualquier plan resultante sigue pasando por (a) el guard demo-only, (b) el guard budget, y (c) — si el plan resultante NO es genuinamente relevante y el LLM se equivoca — no hay forma de que se cobre "gratis": el agente elegido se ejecuta y se debita su precio real, igual que hoy con cualquier selección del LLM. Se documenta como riesgo conocido/preexistente, no como regresión de esta HU. **Fuera de scope de WKH-151** extender `fallbackNoRelevance` (o un guard equivalente) al path LLM — sugerido como follow-up si el AR lo considera bloqueante.
4. **No hay loop.** El fix es UN solo retry condicional (if 0 agentes → retry sin caps una vez → si el retry también da 0 → `no_agents` genuino). No hay reintento del reintento.

## Acceptance Criteria (EARS)

- AC-1: WHEN `discoveryService.discover({ capabilities: preferCapabilities, maxPrice, limit })` devuelve `agents.length === 0` AND `preferCapabilities` no es `undefined`/vacío, the system SHALL reintentar exactamente una vez llamando a `discoveryService.discover({ capabilities: undefined, maxPrice, limit })` (mismos `maxPrice` y `limit` que el primer intento, sin relajar ninguno de los dos).
- AC-2: WHEN el retry sin capabilities devuelve `agents.length > 0`, the system SHALL continuar el flujo normal (candidate set → `deprioritizeDemoAgents` → LLM/greedy planner) usando los agentes del retry, exactamente como si hubiesen venido del primer discovery.
- AC-3: IF el primer discovery YA devuelve `agents.length > 0`, THEN the system SHALL NOT ejecutar el retry (cero llamadas extra a discovery/DB en el happy path — sin regresión de latencia).
- AC-4: IF tanto el primer discovery COMO el retry sin capabilities devuelven `agents.length === 0`, THEN the system SHALL devolver `planStatus:'no_agents'` (comportamiento actual, sin cambios) — el mensaje de `reasoning` puede opcionalmente indicar que se intentó ampliar la búsqueda.
- AC-5: WHILE el retry está activo, the system SHALL preservar sin cambios el guard `allStepsAreDemos` (`orchestrate.ts:713-726`) y el guard `fallbackNoRelevance` (`orchestrate.ts:728-751`) — ningún plan resultante del candidate-set ampliado debe poder saltarse estos guards; un plan 100% demo sigue devolviendo `no_relevant_agent` sin débito.
- AC-6: WHEN se ejecuta el retry, the system SHALL emitir un log estructurado (`log.warn` o equivalente, nivel a definir en F2) indicando `orchestrationId`, que se activó el broaden-retry, y el conteo de agentes encontrados por el retry — para poder correlacionar con la telemetría `orchestrate_goal` existente y confirmar en prod que el fix resuelve el `agentCount:0` intermitente.
- AC-7: IF `preferCapabilities` ya viene `undefined` o `[]` en el request original, THEN the system SHALL NOT ejecutar el retry (ya sería una llamada idéntica a la primera — evita trabajo redundante y logs ruidosos).

## Scope IN
- `src/services/orchestrate.ts` — únicamente la región `planOrchestration` (líneas ~497-546 de discovery + early-return `no_agents`). Ningún otro método del servicio.
- `src/services/orchestrate.test.ts` y/o `src/services/orchestrate.billing.test.ts` — tests nuevos: (a) retry se activa con 0 agentes + caps presentes, (b) retry NO se activa si ya hay agentes, (c) retry NO se activa si caps ya viene vacío/undefined, (d) `no_agents` genuino si ambos intentos dan 0, (e) `allStepsAreDemos`/`fallbackNoRelevance` siguen bloqueando billing con el candidate-set ampliado.
- Este `work-item.md` + entrada en `_INDEX.md`.

## Scope OUT
- `src/services/discovery.ts` — NO se modifica el filtro de capabilities ni ningún otro comportamiento de `discover()`. El fix es 100% en el caller (`orchestrate.ts`).
- El LLM planner (`llmPlan`, system/user prompt) y el greedy fallback (`greedyPlan`) — sin cambios de lógica de selección.
- Relajar `maxPrice` en el retry — explícitamente prohibido (ver CD-2).
- Cambios en Chaski/yarvis (el caller) — el fix es server-side, no requiere que el frontend mande capabilities distintas.
- Extender `fallbackNoRelevance` (o un guard equivalente) al path LLM normal para cubrir "agente real pero irrelevante" — riesgo documentado como preexistente (ver sección de riesgo arriba), candidato a HU separada si el AR lo escala.
- `/orchestrate/plan` + `/orchestrate/execute` (WKH-131) como endpoints separados — si comparten la misma función `planOrchestration` el fix los cubre a ambos automáticamente (a confirmar en F2), pero no se tocan rutas ni contratos HTTP.
- Cambiar el límite `50` de discovery o `MAX_AGENTS_IN_PROMPT=30`.

## Decisiones técnicas (DT-N)
- DT-1: El retry se implementa dentro de `planOrchestration`, envolviendo el call existente de discovery en una función auxiliar o un `if` inline — NO se crea un wrapper genérico de "retry" reutilizable fuera de este método (mantener el blast radius mínimo, additive-only).
- DT-2: El retry usa `capabilities: undefined` (no `[]`) para que el guard `query.capabilities?.length` de `discovery.ts:311` lo trate exactamente igual que "sin filtro" — es el mismo camino de código que un caller que nunca mandó `preferCapabilities`.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO tocar `src/services/discovery.ts` — el fix es exclusivamente en el caller.
- CD-2: PROHIBIDO relajar `maxPrice` en el retry — debe ser idéntico (`budget / maxAgents`) al primer intento. Relajar precio SÍ sería un cambio de política de money-path y requiere su propia HU/aprobación.
- CD-3: PROHIBIDO que el retry se ejecute más de una vez (sin loops, sin retry-del-retry).
- CD-4: PROHIBIDO que el candidate-set ampliado bypasee `allStepsAreDemos` o `fallbackNoRelevance` — estos guards deben seguir corriendo sobre el plan resultante sin excepción, y el AR debe verificar explícitamente (archivo:línea) que ningún cambio los esquiva.
- CD-5: OBLIGATORIO que el happy path (primer discovery con agentes > 0) tenga cero llamadas extra a discovery/DB — el retry es estrictamente additive al camino que hoy da `no_agents`.
- CD-6: OBLIGATORIO loguear cuándo se activa el retry (AC-6) para poder validar en prod (telemetría bdwv) que el `agentCount:0` intermitente baja.

## Missing Inputs
- [resuelto en F2, no bloqueante] Nivel exacto del log del retry (`warn` vs `info`) y si vale la pena un campo nuevo en el evento `orchestrate_goal` (p.ej. `broadenRetryUsed: boolean`) para medir el impacto del fix en telemetría — default sugerido: sí, agregar el campo (additive al shape del evento, no rompe consumidores existentes).
- [resuelto en F2, no bloqueante] Si `/orchestrate/plan` (WKH-131) y `/orchestrate` comparten literalmente `planOrchestration` — confirmar en F2 leyendo las rutas; si comparten función, el fix cubre ambos sin cambio adicional (asunción de este work-item).

## Análisis de paralelismo
- No bloquea ni es bloqueada por ninguna HU abierta (no hay HUs en curso sobre `orchestrate.ts` o `discovery.ts` en este momento según `_INDEX.md`).
- Puede ir en paralelo con cualquier HU que no toque `src/services/orchestrate.ts` (blast radius acotado a un método).
- Es un fix independiente de WKH-128 (deprioritize demos) y WKH-114 (AC verificables) — los reusa sin modificarlos.
