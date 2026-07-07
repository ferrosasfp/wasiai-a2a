# Work Item — [WKH-153] Planner LLM ignora input_schema por-agente (ejemplo `{query}` sesga el output)

## Resumen
El planner LLM de `/orchestrate` (`llmPlan` en `src/services/orchestrate.ts`) selecciona
correctamente los 3 agentes de remesa (`agentshop-corridor-discoverer` / `cashout-matcher` /
`kyc-validator`) pero genera el campo `input` de cada uno como `{ "query": "..." }` en vez del
shape estructurado que exige el `input_schema` publicado por cada agente (`amountUSD`,
`receiverCountry`, `senderName`, etc.). Los agentes devuelven HTTP 400 → step-0 falla →
`compose_step` cae a modo minimal → fee cobrado = \$0 (el bug de "Chaski \$0" sub-caso
`agentCount=3`). Esta HU corrige el prompt del planner para que deje de sesgar hacia `{query}`
y genere el input real por-agente a partir de su `input_schema`.

## Sizing
- SDD_MODE: mini
- Estimación: S
- Branch sugerido: `fix/158-wkh-153-planner-input-schema`

## F0 — Confirmación del mecanismo (leído en código, no re-investigado)

Leído `src/services/orchestrate.ts:152-280` (función `llmPlan`):

1. **`input_schema`/`example_input` SÍ llegan al prompt.** `:166-178` construye `agentList`
   mapeando `a.metadata as Record<string, unknown>` → `input_schema: meta?.input_schema`,
   `example_input: meta?.example_input`. `:202` hace `JSON.stringify(agentList, null, 2)` dentro
   de `userPrompt` — sin ningún filtro que descarte esos campos. Confirmado: si el agente publica
   `input_schema` en `metadata`, el LLM lo recibe tal cual.

2. **La instrucción abstracta existe pero pierde contra el ejemplo concreto.** `:188` dice
   explícitamente *"generate the input object matching its input_schema... Do NOT invent
   fields — only use fields defined in the schema."* Pero el bloque de output esperado en
   `:204-210` da UN solo ejemplo, igual para todos los agentes:
   `{ "slug": "agent-slug", ..., "input": { "query": "specific input" }, ... }`.
   Este es el **causa raíz confirmada**: un ejemplo de formato concreto (few-shot) domina sobre
   una regla en prosa cuando el LLM decide qué shape copiar, especialmente bajo
   `thinking: { type: 'disabled' }` (`:226`, sin razonamiento explícito que reconcilie la
   contradicción).

3. **No hay agentes de bdwv en este repo** (viven en la DB de bdwv, otro proyecto) — no se pudo
   enumerar localmente cuántos usan `input_schema` estructurado vs `{query}` libre. El diseño del
   fix NO depende de ese conteo: en vez de fijar un shape único, el nuevo ejemplo debe señalar
   explícitamente que el `input` se deriva del `input_schema`/`example_input` de CADA agente, y
   que `{query}` es válido únicamente cuando el schema de ESE agente es de forma libre
   (`{query: string}`) o no publica `input_schema`. Esto preserva a los agentes que hoy funcionan
   con `{query}` sin necesitar conocer su lista exacta.

4. **Riesgo de no-determinismo, ya documentado en el brief del orquestador**: el fix es
   prompt-engineering puro — no hay parseo/validación de "input" contra "input_schema" en
   runtime (confirmado: no existe ese chequeo en `llmPlan` ni en `compose.ts` para el path
   LLM-planned). Por lo tanto:
   - El test automatizado de este work item **NO puede aserir el output real de un LLM en CI**
     (no determinístico, requiere red + API key).
   - Lo que SÍ es determinístico y testeable: (a) el **string del prompt** ya no contiene el
     ejemplo sesgado `"input": { "query": "specific input" }` como único ejemplo, y (b) el prompt
     contiene una instrucción reforzada que referencia `input_schema`/`example_input` del propio
     agente. Esto se verifica interceptando el mock de `client.messages.create` (patrón ya usado
     en `src/services/orchestrate.test.ts`, `mockCreate`) y leyendo
     `mockCreate.mock.calls[0][0].messages[0].content` (el `userPrompt` real construido).
   - Un test complementario puede simular la respuesta del LLM mockeada devolviendo un input
     estructurado (`{amountUSD, receiverCountry, ...}`) y afirmar que `llmPlan`/`planOrchestration`
     lo propaga sin mutarlo — esto prueba que el pipeline NO fuerza `{query}` en ningún punto
     posterior (ya se puede confirmar leyendo el código: `validated` en `:254-258` solo valida
     `slug`, no toca `input`). El smoke real end-to-end (LLM real + agentes reales de bdwv) queda
     fuera del pipeline de CI, como manual/staging check post-deploy.

## Acceptance Criteria (EARS)

- AC-1: WHEN el planner LLM construye el `userPrompt` en `llmPlan`, the system SHALL incluir en
  el bloque de ejemplo de salida una referencia explícita a que el campo `input` de cada agente
  debe derivarse del `input_schema`/`example_input` de ESE agente (no un shape fijo `{query}`
  copiado literalmente para todos).
- AC-2: WHERE un agente en `agentList` no publica `input_schema` (o su schema es de forma libre
  `{query: string}`), the system SHALL seguir permitiendo `{ "query": "..." }` como input válido
  para ese agente (no se rompe el camino que hoy funciona).
- AC-3: IF el string del `userPrompt` generado por `llmPlan` es inspeccionado, THEN the system
  SHALL NOT contener el ejemplo genérico `"input": { "query": "specific input" }` como el único
  ejemplo de formato de salida (test determinístico sobre el string del prompt, vía mock de
  `client.messages.create`).
- AC-4: WHEN `llmPlan` recibe una respuesta LLM (real o mockeada) con un `input` estructurado
  distinto de `{query}` para un agente cuyo `input_schema` así lo define, the system SHALL
  propagar ese `input` sin mutarlo ni forzarlo a `{query}` en ningún punto del pipeline
  (`llmPlan` → `planOrchestration` → `ComposeStep`).
- AC-5: WHEN se ejecuta la suite de tests existente de `src/services/orchestrate.test.ts`, the
  system SHALL seguir pasando sin regresiones (T-1..T-10 y los tests de billing/fee asociados).

## Scope IN
- `src/services/orchestrate.ts` — función `llmPlan`, específicamente el bloque `systemPrompt`
  (`:180-194`, reforzar `:188` si hace falta) y `userPrompt` (`:196-211`, reemplazar/enriquecer
  el ejemplo de `:207`).
- `src/services/orchestrate.test.ts` (o un test nuevo dedicado) — test(s) que verifiquen AC-1,
  AC-3 (string del prompt) y AC-4 (propagación del input mockeado).

## Scope OUT
- Los agentes de agentshop (`agentshop-corridor-discoverer`, `cashout-matcher`,
  `kyc-validator`) y su `input_schema`/`example_input` publicado — viven en bdwv, otro repo/DB.
- Cualquier validación runtime de "input generado vs input_schema" (p.ej. rechazar el plan si
  el LLM no respeta el schema) — eso sería una feature nueva de robustez, no el fix de este bug.
  Si se quiere ese guardarraíl determinístico, es candidato a HU separada (follow-up sugerido).
- El shape de la respuesta real de un LLM en producción — no es determinístico y no se testea
  en CI (ver F0 punto 4).
- `discovery.ts`, `compose.ts` u otros servicios — el bug vive 100% en la construcción del
  prompt dentro de `llmPlan`.
- El adaptive input-retry existente de WKH-130 (aprende del error 400 y reintenta una vez) —
  sigue funcionando igual, no se toca; este fix ataca la causa raíz para que el retry ni
  siquiera sea necesario en el caso feliz.

## Decisiones técnicas (DT-N)
- DT-1: El fix es exclusivamente de **prompt/ejemplo**, no de código de validación. Se prefiere
  esto sobre agregar un parser/validador de schema en runtime porque (a) es el cambio mínimo que
  ataca la causa raíz identificada, (b) un validador runtime es un scope más grande (definir qué
  hacer si el LLM sigue sin matchear: ¿rechazar el plan? ¿reintentar?) que ya está parcialmente
  cubierto por WKH-130 (adaptive retry), y (c) mantiene el blast radius mínimo para un fix FAST+AR.
- DT-2: El nuevo ejemplo del prompt NO fija un shape único de reemplazo (p.ej. no hardcodea
  `{amountUSD, receiverCountry}` como "el" ejemplo correcto) — usa un placeholder/instrucción
  genérica que apunta al `input_schema` de cada agente, para no crear un sesgo nuevo hacia un
  dominio (remesas) en detrimento de otros dominios de agentes.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO tocar `discovery.ts`, `compose.ts` o cualquier servicio fuera de la función
  `llmPlan` en `orchestrate.ts`.
- CD-2: PROHIBIDO agregar validación runtime que rechace/bloquee un plan por mismatch de schema
  — el fix es solo el texto del prompt (ver DT-1).
- CD-3: PROHIBIDO romper el camino de agentes que hoy esperan `{query}` — todo test debe incluir
  un caso que confirme que `{query}` sigue siendo válido para agentes sin `input_schema`
  estructurado (AC-2).
- CD-4: OBLIGATORIO que el/los test(s) nuevos validen el **string del prompt** o la
  **propagación del input mockeado**, NUNCA una llamada real al LLM de Anthropic en CI
  (determinismo — ver F0 punto 4).
- CD-5: PROHIBIDO inventar el `input_schema` real de los agentes de agentshop — el work item no
  asume campos específicos más allá de los ya citados por el orquestador en el brief
  (`amountUSD`, `receiverCountry`, `senderName`) a modo ilustrativo únicamente.

## Missing Inputs
- [NEEDS CLARIFICATION — no bloqueante, default aplicado] ¿Se quiere además un guardarraíl
  runtime (validar el `input` generado contra `input_schema` antes de invocar al agente, y
  reintentar/fallar limpio si no matchea)? Default asumido: NO en esta HU (queda como follow-up
  sugerido, ver DT-1) — el scope se mantiene acotado al prompt para no expandir un fix FAST+AR
  en una feature de validación runtime.
- [resuelto en F0] Conteo exacto de agentes bdwv `input_schema` vs `{query}` — no bloqueante,
  el diseño del fix (DT-2) no depende de ese conteo.

## Análisis de paralelismo
- No bloquea otras HUs activas. Puede ir en paralelo con cualquier otra HU que no toque
  `orchestrate.ts:152-280` (la función `llmPlan`).
- Depende conceptualmente del contexto de WKH-130 (adaptive input-retry, fila 127 del INDEX) y
  WKH-151 (discovery broaden-retry, fila 157) — ambos ya DONE, no requieren cambios, pero
  comparten el mismo síntoma raíz ("Chaski \$0"). Esta HU es la pieza que ataca la causa raíz
  del sub-caso `agentCount=3`, mientras WKH-130 es la red de seguridad reactiva (retry post-400)
  que sigue vigente sin cambios.
