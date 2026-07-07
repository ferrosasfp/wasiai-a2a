# SDD — [WKH-152] Planner LLM sin guard de relevancia (per-step relevance backstop)

> Fase F2 (QUALITY, money-path). Input: `work-item.md` (este directorio) + `project-context.md` + F0 en código.
> El Architect NO escribe código de producción. Este SDD es el contrato para el Dev (F2.5 → F3).

---

## 0. Resumen ejecutivo

El path del planner LLM (`planOrchestration`, `orchestrate.ts:650-719`) construye `steps`
sin ningún guard de relevancia: el único filtrado es existencia de slug (`discoveredSlugs.has`,
:652-655) + budget (:668-678). El guard determinístico que ya existe (`fallbackNoRelevance`,
:793-809) está gateado por `usedFallback` → cubre SOLO el greedy. `allStepsAreDemos` (:782-784)
solo dispara si TODOS los steps son demos. Un plan MIXTO del LLM (relevante + real-irrelevante)
llega a `planStatus:'ready'` y AMBOS agentes se debitan (step-0 en `executeApprovedPlan` :1065-1073,
steps 1..N en `composeService.compose` :1129).

**Fix (ratificado — MIXED-PLAN-ONLY, enmienda 2026-07-07):** filtro de relevancia **per-step**,
**determinístico** (reusa `tokenizeForRelevance` :342-350), aplicado al plan del LLM
(`usedFallback === false`), integrado en el bloque del guard existente (:771-861). **El filtro NUNCA
vacía un plan.** Dropea steps CLARAMENTE irrelevantes ANTES de cualquier débito/compose **SOLO
cuando ≥1 step léxicamente-relevante SOBREVIVE** (el caso plan-mixto = el bug real: relevante +
irrelevante → dropea el irrelevante, cobra el relevante). Si el filtro dropearía TODOS los steps
(todos léxicamente disjuntos del goal) → **CONSERVAR TODOS** (no-op, revertir a los steps
originales, sin débito extra, sin rechazo) — confiar en el juicio semántico del LLM. Si sobrevive
un set parcial → recalcula `plannedCostUsd`/step-0 y reindexa `passOutput` desde los sobrevivientes
(invariantes WKH-127/WKH-132 intactos).

**Por qué se abandonó el early-return `no_relevant_agent` para el caso todo-irrelevante (enmienda):**
el filtro léxico da **false-negatives en goals multilingües** — goal en español (`"cotiza el
clima"`) vs. agente descripto en inglés (`"weather forecast"`) → 0 tokens en común → dropearía un
step VÁLIDO que el LLM eligió bien. WasiAI es LATAM/multilingüe → es el caso común. Vaciar el plan
por señal léxica insuficiente es un false-negative catastrófico (rechaza trabajo bueno). Ver **DT-7**.

**Riesgo #1 (false-negative) — resuelto por diseño conservador**, ver **DT-1**, **DT-2** y **DT-7**.

---

## 1. Context Map (archivos leídos + patrón extraído)

| Archivo:línea | Por qué se leyó | Qué se extrajo |
|---|---|---|
| `src/services/orchestrate.ts:342-350` | Helper de relevancia a reusar | `tokenizeForRelevance(text): Set<string>` — lowercase, split `/[^a-z0-9]+/`, descarta tokens `<3` chars. 100% determinístico, sin LLM. **Se reusa tal cual (CD-4/DT-2).** |
| `orchestrate.ts:650-719` | Branch LLM que arma `steps` | `discoveredSlugs.has` (existencia) → `validAgents`; budget → `budgetedAgents`; `steps = budgetedAgents.map((a,index)=>({..., passOutput: index>0}))` (:680-690); step-0 pricing `step0Slug/step0Registry/plannedCostUsd` vía `resolveAgentPriceUsdc(step0Slug, step0Registry)` (:707-713). **Ningún chequeo de relevancia.** |
| `orchestrate.ts:771-861` | Bloque del guard (home natural del filtro) | `allStepsAreDemos` (:782-784, ALL demos); `fallbackNoRelevance` (:793-809, gateado por `usedFallback`, corpus = `name+description+capabilities.join(' ')`, overlap ≥1 token, empty-goal ⇒ reject); early-return `no_relevant_agent` (:811-861, `steps:[]`, `plannedCostUsd:0`, `feeUsdc:0`, track `reason:'no_relevant_agent'`). |
| `orchestrate.ts:877-917` | Cómputo de billing post-guard | `costPerStep`/`totalCostUsdc`/`maxQuotedCostUsdc`/`protocolFeeUsdc` se derivan de `steps` (el array). **Si reasignamos `steps` ANTES de este bloque, todo el billing 1..N se recalcula por construcción.** `plannedCostUsd` (step-0) NO se re-deriva acá → hay que recomputarlo manualmente (AC-4). |
| `orchestrate.ts:729-769` | `budget_exhausted` early-return | Dispara cuando `steps.length === 0` por budget. **El filtro NO debe re-rutear acá el caso "vaciado por relevancia"** → por eso el filtro va DESPUÉS de :769 (en el guard block), no en el branch LLM. |
| `orchestrate.ts:1045-1124` | Step-0 debit | `step0DebitUsd = plannedCostUsd + step0GasOverhead`; `budgetService.debit(...)`. `plannedCostUsd` viaja intacto desde `planOrchestration`. **Debe corresponder al primer step sobreviviente (AC-4).** |
| `orchestrate.ts:1129-1148` | Steps 1..N debit/exec | `composeService.compose({ steps, ... })` — recibe el array `steps` final. Si el irrelevante ya no está en `steps`, no se ejecuta ni cobra (CD-2/CD-6). |
| `orchestrate.ts:303-311` (greedyPlan) | Confirmar corpus/input del greedy | greedy arma steps con `input: { goal }` SIEMPRE (:306). Relevante para DT-1 (widen-corpus con `input` es no-op en greedy). |
| `src/services/agent-price.ts:44` | Firma del resolver de precio | `resolveAgentPriceUsdc(slug, registry?) → Promise<number|null>` (registry-aware). Mismo resolver que step-0 pricing (:711) y el quote. |
| `src/types/index.ts:310-321` | Tipo `ComposeStep` | `{ agent:string; registry?:string; input:Record<string,unknown>; passOutput?:boolean; acceptanceCriteria?:string[] }`. `input` es JSON-origin (parseado del LLM) → `JSON.stringify(step.input)` es seguro. |
| `src/services/orchestrate.test.ts:1742-1979` | Exemplars de tests de relevancia | Helpers: `setLlmResponse`/`setLlmError`, `makeDemoAgents`, `mockAgents`, `masterKeyRow`, `vi.mocked(discoveryService.discover / budgetService.debit / composeService.compose / chargeProtocolFee)`. Tests T-W4/T-W5/T-W5b/T-W5c/T-W6 = plantilla exacta para los nuevos. |
| Auto-Blindaje WKH-114/151/142 | Errores recurrentes previos | Ver **CD-8..CD-11** (heredados). |

---

## 2. Decisiones técnicas (DT-N)

### DT-1 — Criterio del filtro: overlap binario ≥1 token, corpus ampliado con el `input` del step (conservador, false-negative-safe)

**Criterio de DROP de un step (solo path LLM, `usedFallback === false`):**
un step se **descarta** si-y-solo-si su corpus comparte **CERO** tokens evaluables (≥3 chars) con
`goalTokens`, donde:

```
corpus(step, agent) = tokenizeForRelevance(
   agent.name + ' ' + agent.description + ' ' +
   agent.capabilities.join(' ') + ' ' +
   JSON.stringify(step.input)     // ← ampliación vs. el corpus del greedy
)
relevante(step) = ∃ token ∈ goalTokens : token ∈ corpus(step, agent)
drop(step)      = ¬ relevante(step)
```

- **Mismo criterio, no un 2º estándar (CD-4/DT-2):** el tokenizador (`tokenizeForRelevance`) y el
  umbral (overlap ≥1) son EXACTAMENTE los de `fallbackNoRelevance` (:802-808). La única diferencia
  es (a) que se aplica **per-step** en vez de todo-o-nada, y (b) que el corpus **agrega
  `JSON.stringify(step.input)`**.
- **Por qué agregar `input` es estrictamente más conservador (false-negative-safe):** agregar
  tokens a un corpus solo puede AUMENTAR la probabilidad de overlap → solo puede CONSERVAR más
  steps, nunca dropear más. El `input` del path LLM es autoría del propio LLM (su puente semántico
  goal→agente: p.ej. `{amountUSD, receiverCountry}`), y es señal de relevancia legítima. En el
  greedy el `input` es SIEMPRE `{goal}` (verificado `orchestrate.ts:306`), así que el mismo
  predicado sobre el greedy sería un no-op respecto del corpus name+desc+caps → **no introduce
  divergencia observable en el path greedy** (que además ni corre este filtro, ver DT-3).
- **Consecuencia deliberada (bias-to-conserve):** cuando el LLM no especificó input y se usó el
  default `input: a.input ?? { goal }` (`:683`) → el corpus contiene el goal completo → overlap
  garantizado → el step **se conserva siempre**. El filtro entonces SOLO dropea cuando el LLM
  **tailoreó un input** Y ni ese input ni la descripción entera del agente comparten un solo token
  ≥3 chars con el goal — señal fuerte de irrelevancia CLARA. Esto cumple el mandato del gate HU:
  *"ante la duda, CONSERVAR el step"* — el false-negative (dropear trabajo válido) se prioriza como
  peor que el over-charge (Riesgo #1).

**Exemplar de calibración (por qué es conservador con datos reales):** un plan mixto
`goal:"Analyze DeFi sentiment"` con `[wasi-defi-sentiment (relevante), corridor-discoverer
(irrelevante)]`: `corridor-discoverer` (name/desc "remittance corridor…", input tailoreado
`{amountUSD, receiverCountry}`) NO comparte `{analyze, defi, sentiment}` → DROP correcto; el
relevante se conserva. Inversamente, `goal:"send money to Peru"` + un agente de remesa cuyo
name/desc no dice "money" pero cuyo `input` tailoreado o `capabilities` sí traen un token del goal →
se conserva (evita el false-negative de vocabulario).

### DT-2 — Reusar `tokenizeForRelevance`, single-source-of-truth del criterio

Se reusa el helper existente (`:342-350`). Para no duplicar la semántica del overlap, el Dev
extrae un helper puro module-level:

```ts
/** True si el texto comparte ≥1 token evaluable (≥3 chars) con goalTokens.
 *  goalTokens vacío ⇒ false (el caller decide la semántica del caso vacío). */
function textOverlapsGoal(text: string, goalTokens: Set<string>): boolean
```

- `fallbackNoRelevance` (:793-809) PUEDE refactorizarse para llamar a `textOverlapsGoal` (refactor
  behavior-preserving), o dejarse intacto. **Guardrail (CD-1/CD-7):** los tests T-W5/T-W5b/T-W5c/T-W6
  del greedy DEBEN quedar verdes sin cambios — son la prueba de que el greedy no cambió de
  comportamiento. Si el Dev extrae el helper compartido, esos tests son el gate de equivalencia.
- La semántica del **goal vacío difiere por path** y se resuelve en el CALLER, no en el helper:
  - greedy (`fallbackNoRelevance`): `goalTokens.size === 0` ⇒ reject (sin cambios).
  - LLM (nuevo filtro): `goalTokens.size === 0` ⇒ **saltar el filtro por completo, conservar TODOS
    los steps** (ver DT-1 y AC/false-negative). El LLM ya juzgó semánticamente; sin señal léxica
    del goal no hay base para override → dropear sería puro false-negative. **Esta asimetría es la
    justificación central de override del comentario de diseño :791-792** (ver DT-6).

### DT-3 — Ubicación del filtro: en el bloque del guard (:771-861), operando sobre `steps`

Se integra el filtro en el **mismo bloque** que `allStepsAreDemos`/`fallbackNoRelevance`, DESPUÉS
del early-return `budget_exhausted` (:729-769). Razones:

1. **Co-localiza toda la lógica de relevancia** en un único lugar → AR revisa un solo diff (AC-6:
   evitar doble evaluación).
2. **El caso todo-irrelevante NO usa el early-return `no_relevant_agent`** (enmienda MIXED-PLAN-ONLY,
   DT-7): si el filtro dropearía TODOS los steps → no-op (conservar todos). El early-return
   `no_relevant_agent` (:811-861) queda EXCLUSIVAMENTE para `allStepsAreDemos` y
   `fallbackNoRelevance` (greedy) — **el filtro LLM nuevo NUNCA lo dispara**.
3. **No re-rutea a `budget_exhausted`:** al correr DESPUÉS de :729, `steps.length===0` por budget ya
   se manejó; el filtro LLM nunca produce `steps.length===0` (conserva todos si vaciaría).
4. **El billing 1..N se recalcula por construcción:** `costPerStep`/`totalCostUsdc`/
   `maxQuotedCostUsdc`/`protocolFeeUsdc` (:877-896) se derivan del array `steps`; al reasignar
   `steps` al set filtrado ANTES de :877 (solo en el caso mixto), se recomputan sin tocar la capa de
   pricing (CD-5).

**Flujo de índices (lo que el AR debe verificar — DT-3 del work-item, enmendado):**

```
budgetedAgents (LLM) ─map→ steps (con passOutput: index>0, step-0 pricing en :707-713)
        │
        ▼  [guard block, usedFallback===false, ¬allStepsAreDemos, goalTokens.size>0]
   relevantSteps = steps.filter(s => stepRelevant(s, goalTokens, discovered.agents))
        │
        ├─ relevantSteps.length === 0  → CONSERVAR TODOS (no-op): steps intacto, sin drop, sin
        │                                 rechazo, billing byte-idéntico a sin-filtro (DT-7, AC-2)
        │
        ├─ relevantSteps.length === steps.length → no-op (nada que dropear), byte-identidad (AC-3)
        │
        └─ 0 < relevantSteps.length < steps.length →   [ÚNICO caso que dropea = plan mixto]
              steps = relevantSteps.map((s, i) => ({ ...s, passOutput: i > 0 }))   // REINDEX passOutput (AC-4)
              plannedCostUsd = await resolveAgentPriceUsdc(steps[0].agent, steps[0].registry) ?? 0   // RECOMPUTE step-0 (AC-4, WKH-127/132)
              reasoning += ` (${dropped} irrelevant agent(s) dropped)`   // transparencia, espejo del note de :717
              // ↓ costPerStep/totalCostUsdc/protocolFeeUsdc (:877-896) se recalculan de `steps` reasignado
```

**Regla única del drop (invariante MIXED-PLAN-ONLY):** el drop se aplica **si-y-solo-si**
`0 < relevantSteps.length < steps.length`. Equivalentemente: `applyDrop = llmFilterApplies &&
relevantSteps.length > 0 && relevantSteps.length < steps.length`. Los otros dos casos
(todo-relevante y todo-irrelevante) son ambos no-ops → conservan `steps` intacto.

- **REINDEX de `passOutput`:** al dropear un step, el primer sobreviviente debe tener
  `passOutput:false` (no tiene predecesor cuyo output consumir → usa su propio `input`). El
  `.map((s,i)=>({...s, passOutput: i>0}))` lo garantiza por construcción — **cero cirugía manual de
  off-by-one** (mitiga el riesgo de DT-3 del work-item). Un step que sobrevive como nuevo head usa
  su propio `input` (ya presente en el objeto).
- **RECOMPUTE de `plannedCostUsd`/step-0:** espejo exacto de :707-713 (`resolveAgentPriceUsdc(slug,
  registry)`, registry-aware). `noUncheckedIndexedAccess`: `steps[0]` es `ComposeStep | undefined`
  → guardar en const y chequear antes de indexar (ver CD-8). Como el caso parcial garantiza
  `steps.length>0`, el guard es defensivo pero obligatorio para tsc.
- **Caso todo-relevante (AC-3):** `relevantSteps.length === steps.length` → `steps` reasignado es
  idéntico en contenido y orden; `passOutput` reindex es no-op (mismos índices); `plannedCostUsd`
  recomputado da el MISMO valor (mismo step-0). **Cero regresión.** *(Optimización opcional: si
  `dropped === 0`, saltar reasignación/recompute para garantizar byte-identidad — recomendado.)*

### DT-4 — Dependencia de datos entre steps al dropear del MEDIO (edge case documentado)

Si el LLM encadenó `stepB.passOutput=true` para consumir el output de `stepA` y se dropea `stepA`
(irrelevante), `stepB` pasa a ser head → `passOutput:false` → usa su propio `input`. Es el
comportamiento conservador correcto: un agente **irrelevante** es improbable que sea un eslabón de
datos genuino que el LLM necesitara; y romper la cadena es preferible a ejecutar/cobrar un agente
fuera de tema. Se documenta en el `reasoning` (nota de drop) para trazabilidad. **No se escala a
rechazo-total** (DT-1 del work-item queda ratificado: per-step). Si QA/telemetría evidencia
cadenas legítimas rotas, es follow-up separado (no bloqueante).

### DT-5 — Todo el guard corre ANTES de cualquier débito/compose (CD-2/CD-5/CD-6)

El bloque del guard (:771-861) y el filtro nuevo están enteramente en `planOrchestration`, que NO
debita ni ejecuta compose (esos ocurren en `executeApprovedPlan`, :1045+). El array `steps` que sale
de `planOrchestration` (`planStatus:'ready'`) ya está filtrado → el irrelevante nunca llega a
`budgetService.debit` (:1065) ni a `composeService.compose` (:1129). Invariante verificable en test
(CD-6): el `steps` del `plan` retornado y el `composeCall.steps` NO contienen el slug irrelevante.

### DT-6 — Override del comentario de diseño (:786-792): por qué AHORA sí se agrega el backstop

El comentario :786-792 afirma que el path LLM *"ya juzga relevancia con su propio criterio semántico
y NO debe duplicarse ni endurecerse acá"*. **Se agrega el backstop pese a ese comentario** porque:

1. **Evidencia empírica (auditoría 2026-07-06/07):** el LLM DEMOSTRADAMENTE incluye agentes
   real-pero-irrelevantes en planes mixtos (Chaski $0 v2, MEMORY). La premisa "el LLM ya juzga
   relevancia" es falsable y fue falsada.
2. **Exposición ampliada por WKH-151 (fila 157 DONE):** el broaden-retry sin `capabilities` agranda
   el pool de candidatos (hasta 30, `MAX_AGENTS_IN_PROMPT`) → más chance de elección tangencial.
3. **El backstop NO "endurece" el criterio del LLM, lo ACOTA conservadoramente:** por DT-1 solo
   dropea lo CLARAMENTE irrelevante (LLM tailoreó input + cero overlap en todo el corpus), y ante
   duda conserva. No re-juzga la elección del LLM; solo caza el caso patológico medido.

El Dev **actualiza el comentario :786-792** para reflejar que el path LLM ahora tiene un backstop
determinístico per-step conservador (con la referencia a WKH-152 y la evidencia), preservando la
explicación del greedy.

### DT-7 — MIXED-PLAN-ONLY: el filtro NUNCA vacía un plan (enmienda 2026-07-07, decisión del humano)

**Contexto de la enmienda.** El F3 dev implementó el AC-2 original ("si el filtro léxico vacía el
plan → `no_relevant_agent`") y **rompió 35 tests money-path**: el filtro léxico da **false-negatives
en goals multilingües**. Un goal en español (`"cotiza el clima"`) contra un agente descripto en
inglés (`"weather forecast"`) comparte 0 tokens → el filtro dropea un step VÁLIDO que el LLM eligió
correctamente. Para agentes reales el LLM además **tailorea el `input`** (`{amountUSD,
receiverCountry}`) que NO contiene los tokens del goal → el corpus ampliado (DT-1) no rescata el
caso cross-idioma. WasiAI es LATAM/multilingüe → **es el caso común, no el borde.** El SDD original
asumió que un plan todo-disjunto ⇒ todo-irrelevante; esa premisa es falsa bajo multilingüismo.

**Decisión (ratificada por el humano) — el filtro NUNCA vacía un plan:**

1. **Caso plan-mixto (relevante + irrelevante, `0 < relevantSteps.length < steps.length`):** dropea
   los steps irrelevantes, cobra solo los relevantes. **Este es el bug real y el ÚNICO caso donde el
   filtro actúa.** El over-charge del step irrelevante se elimina.
2. **Caso todo-disjunto (`relevantSteps.length === 0`):** **CONSERVAR TODOS** — revertir a los steps
   originales, sin filtrar, sin débito extra, sin rechazo. **NO ir a `no_relevant_agent`.** Se
   confía en el juicio semántico del LLM (mismo espíritu que CD-14: ante señal léxica insuficiente,
   conservar). Ejecuta y cobra como hoy.
3. **Caso todo-relevante (`relevantSteps.length === steps.length`):** no-op (AC-3), byte-identidad.

**Por qué esta asimetría es correcta.** Cuando **≥1 step matchea léxicamente**, tenemos evidencia
positiva de que el goal SÍ comparte vocabulario con el corpus de agentes → un step disjunto en ese
mismo plan es señal razonable de irrelevancia (el LLM añadió algo fuera de tema). Cuando **NINGÚN
step matchea**, la explicación más probable NO es "todos los agentes son irrelevantes" sino "el goal
está en otro idioma / vocabulario que el corpus" → dropear sería puro false-negative. El filtro solo
confía en su señal léxica cuando esa señal se **corrobora** con al menos un match dentro del mismo
plan.

**Trade-off resuelto:** esto arregla el over-charge del plan mixto (Riesgo original de la HU) Y
elimina el false-negative catastrófico all-disjoint (multilingüe). Se prioriza el false-negative
como peor que el over-charge (mandato del gate HU).

**Residual conocido (limitación documentada — el AR debe evaluarlo):** dentro de un plan mixto
multilingüe, un step VÁLIDO pero léxicamente disjunto del goal PODRÍA dropearse si OTRO step del
mismo plan sí matchea (el match de un step "habilita" el drop de los otros disjuntos). Es un
sub-conjunto acotado del problema (requiere: plan mixto + ≥1 match + ≥1 válido-pero-disjunto en el
mismo plan), estrictamente menor que el false-negative all-disjunto que la enmienda elimina. Se
acepta como limitación conocida; si telemetría/QA evidencia casos reales → HU de refinamiento
separada (embeddings violarían CD-4). **No bloquea esta HU.**

---

## 3. Constraint Directives (CD-N)

**Heredadas del work-item (CD-1..CD-7) — vinculantes:**

- **CD-1:** PROHIBIDO alterar el comportamiento observable de `fallbackNoRelevance`
  (`usedFallback===true`) o `allStepsAreDemos`. Guardrail: T-W4/T-W5/T-W5b/T-W5c/T-W6 verdes sin cambios.
- **CD-2:** PROHIBIDO que un step filtrado por irrelevancia llegue a `budgetService.debit` (:1065) o
  `composeService.compose` (:1129). El filtro ocurre ANTES de ambos (en `planOrchestration`).
- **CD-3:** PROHIBIDO no-cobrar trabajo válido: plan 100% relevante (o la porción relevante de un
  mixto) se ejecuta/cobra idéntico a hoy (AC-3).
- **CD-4:** OBLIGATORIO 100% determinístico, en memoria, SIN llamadas LLM/red adicionales (AC-5).
- **CD-5:** PROHIBIDO romper WKH-127 (débito/refund step-0) ni WKH-132 (fee-on-cost). El guard corre
  ESTRICTAMENTE antes del pricing/debit; su único efecto es CUÁLES steps llegan, nunca CÓMO se
  debitan/refunden.
- **CD-6:** PROHIBIDO double-cobro / cobro-alguno del irrelevante: tests verifican que el `steps` que
  llega a compose NO contiene el slug irrelevante (no basta "no doble", debe ser CERO veces).
- **CD-7:** OBLIGATORIO test de regresión explícito para all-demos y greedy-fallback → siguen dando
  `no_relevant_agent` sin débito.

**Agregadas por el SDD (F2):**

- **CD-8 (Auto-Blindaje WKH-114):** `noUncheckedIndexedAccess` activo — `steps[0]`/`budgetedAgents[0]`
  devuelven `T | undefined`. Guardar en const + chequear antes de usar como no-undefined. NUNCA
  `steps[0]!`.
- **CD-9 (Auto-Blindaje WKH-114):** el filtro DEBE tolerar `input`/`capabilities` no-array/mal-formados
  a runtime (validate ≠ parse). `agent.capabilities.join(' ')` ya lo asume en el código actual;
  `JSON.stringify(step.input)` es seguro (`input:Record<string,unknown>` JSON-origin), pero NO
  spreadear/iterar valores no validados sin `Array.isArray`. Un throw en el filtro NO debe escapar
  (correría dentro de `planOrchestration`, pre-débito → no hay refund indebido, pero sí rompería el
  request). Mantener el filtro total-función.
- **CD-10 (Auto-Blindaje WKH-151):** formato biome — correr `./node_modules/.bin/biome check --write`
  sobre los archivos tocados antes del gate (NO `npx biome`, se rompe bajo el hook RTK). Objetos
  literales inline (args de test) deben ir multilínea.
- **CD-11 (Auto-Blindaje WKH-114):** biome `useOptionalChain` — evitar `x !== null && x.m()`; usar
  `Boolean(x?.m())` cuando aplique.
- **CD-12:** PROHIBIDO tocar el prompt del planner LLM (`systemPrompt`/`userPrompt` :180-214) ni el
  contrato `LlmPlanAgent`/`selectedAgents`. El fix es puramente post-plan determinístico (Scope OUT
  del work-item).
- **CD-13:** el filtro corre SOLO si `usedFallback === false` Y `¬allStepsAreDemos` (AC-6: no doble
  evaluación sobre un plan ya vaciado por all-demos; AC-7: no toca el greedy).
- **CD-14:** `goalTokens.size === 0` en el path LLM ⇒ conservar TODOS los steps (skip filtro). NUNCA
  vaciar un plan LLM por goal sin tokens evaluables (false-negative catastrófico).
- **CD-15 (enmienda MIXED-PLAN-ONLY, DT-7):** el filtro LLM **NUNCA vacía un plan**. Si
  `relevantSteps.length === 0` (todos los steps léxicamente disjuntos del goal) ⇒ **CONSERVAR TODOS**
  (no-op, `steps` intacto, sin drop, sin recompute, sin `no_relevant_agent`). El drop se aplica
  **si-y-solo-si** `0 < relevantSteps.length < steps.length` (plan mixto). PROHIBIDO que el filtro
  LLM produzca `steps:[]` o dispare el early-return `no_relevant_agent` (:811-861) — ese early-return
  queda SOLO para `allStepsAreDemos`/`fallbackNoRelevance` (greedy).

---

## 4. Waves de implementación

### W0 — Baseline + helper puro (serial)
- **W0.1** Correr `npm test src/services/orchestrate.test.ts` + `orchestrate.billing.test.ts` →
  confirmar verde ANTES de tocar nada (baseline de regresión CD-1/CD-7).
- **W0.2** Extraer helper module-level `textOverlapsGoal(text, goalTokens): boolean` (DT-2) que
  reusa `tokenizeForRelevance`. Opcional: refactorizar `fallbackNoRelevance` para llamarlo
  (behavior-preserving; validado por T-W5/T-W6 verdes). Sin cambio de comportamiento aún.
- **W0.3** Tests unitarios puros del helper: overlap básico, sin-overlap, goal vacío ⇒ false,
  case-insensitive, tokens <3 chars ignorados.

### W1 — Filtro per-step + recompute (serial, depende de W0)
- **W1.1** Implementar el filtro en el bloque del guard (:771-861), gate `usedFallback===false &&
  ¬allStepsAreDemos` (CD-13). Predicado por step = corpus name+desc+caps+`JSON.stringify(input)`,
  overlap ≥1 (DT-1). `goalTokens.size===0` ⇒ skip (CD-14). Computar `relevantSteps` y
  `applyDrop = llmFilterApplies && relevantSteps.length > 0 && relevantSteps.length < steps.length`.
- **W1.2** Caso todo-disjunto (`relevantSteps.length === 0`): **CONSERVAR TODOS — no-op**
  (DT-7/CD-15). NO extender la condición del early-return `no_relevant_agent`; el `if (allStepsAreDemos
  || fallbackNoRelevance)` (:811) queda **SIN cambios** (el filtro LLM no aporta un tercer disyunto).
  Al no dropear, `steps` sigue intacto → billing byte-idéntico a sin-filtro.
- **W1.3** Caso mixto (`applyDrop === true`, i.e. `0 < relevantSteps.length < steps.length`):
  `steps = relevantSteps.map((s,i)=>({...s, passOutput: i>0}))`; recompute
  `plannedCostUsd = await resolveAgentPriceUsdc(steps[0].agent, steps[0].registry) ?? 0` (CD-8 guard);
  append `reasoning` con el drop-count. Caso todo-relevante (`llmDropped===0`) → no-op → byte-identidad
  AC-3.
- **W1.4** Actualizar el comentario de diseño :786-792 (DT-6). Correr `tsc --noEmit` +
  `./node_modules/.bin/biome check --write` (CD-10).

### W2 — Test matrix (paralelizable tras W1)
Tests en `orchestrate.test.ts` (mecánica de plan) + assertions de billing donde aplique. Ver §6.

---

## 5. Exemplars verificados (paths confirmados vía Glob/Read/Grep)

| Exemplar | Path:línea | Uso en esta HU |
|---|---|---|
| `tokenizeForRelevance` | `src/services/orchestrate.ts:342-350` | Reuso directo (DT-2). |
| `fallbackNoRelevance` (predicado overlap) | `orchestrate.ts:793-809` | Plantilla del criterio + guardrail de no-regresión. |
| early-return `no_relevant_agent` | `orchestrate.ts:811-861` | Queda SOLO para all-demos/greedy; el filtro LLM NO lo dispara (DT-7/CD-15). NO se toca su condición. |
| step-0 pricing | `orchestrate.ts:707-713` | Espejo para el recompute (AC-4). |
| `resolveAgentPriceUsdc` | `src/services/agent-price.ts:44` | Resolver registry-aware para el recompute. |
| billing post-guard | `orchestrate.ts:877-896` | Se recalcula por construcción al reasignar `steps`. |
| step-0 debit | `orchestrate.ts:1065-1073` | Punto que consume `plannedCostUsd` recomputado. |
| `composeService.compose` | `orchestrate.ts:1129` | Consume el `steps` filtrado. |
| greedy `input:{goal}` | `orchestrate.ts:306` | Justifica que widen-corpus con `input` es no-op en greedy (DT-1). |
| `ComposeStep` | `src/types/index.ts:310-321` | `input:Record<string,unknown>` → stringify seguro. |
| Tests de relevancia | `orchestrate.test.ts:1742-1979` (T-W4/W5/W5b/W5c/W6) | Plantilla exacta (helpers, mocks) para los nuevos tests. |
| Test file billing | `src/services/orchestrate.billing.test.ts` | Assertions de débito/step-0 si se requiere. |

---

## 6. Plan de tests (≥1 por AC)

Reusar helpers de `orchestrate.test.ts`: `setLlmResponse`, `makeDemoAgents`, `mockAgents`,
`masterKeyRow`, `vi.mocked(discoveryService.discover / budgetService.debit / composeService.compose /
chargeProtocolFee)`.

**Los ~35 tests money-path pre-existentes vuelven a verde POR CONSTRUCCIÓN (enmienda MIXED-PLAN-ONLY):**
sus goals placeholder son léxicamente all-disjunto respecto de los corpus de agentes mock → bajo la
nueva regla `relevantSteps.length === 0` ⇒ **conservar todos (no-op)** → `steps` intacto → billing
byte-idéntico a como corría antes del filtro. La versión original (all-disjunto ⇒ `no_relevant_agent`
⇒ `steps:[]`) los rompía; MIXED-PLAN-ONLY los deja intactos sin editarlos.

| ID | AC | Escenario | Assertions clave |
|---|---|---|---|
| **T-152-1 (mixto)** | AC-1, CD-2/CD-6 | discover=[relevante, irrelevante-real]; LLM selecciona ambos, input tailoreado disjunto para el irrelevante; **≥1 step matchea** | `plan.steps` NO contiene el slug irrelevante; `composeCall.steps` tampoco; el relevante SÍ se ejecuta/cobra; `debit` llamado con el precio del relevante. |
| **T-152-2 (todo-disjunto ⇒ conservar todos)** | AC-2, DT-7/CD-15 | LLM selecciona agentes reales todos léxicamente disjuntos del goal (input tailoreado disjunto, no-demos) | **NO** `no_relevant_agent`; `steps` = plan original completo; `compose` ejecuta N steps; billing **byte-idéntico** a sin-filtro (`plannedCostUsd`/`totalCostUsdc`/`protocolFeeUsdc` iguales); `reasoning` sin `dropped`. |
| **T-152-2b (multilingüe ⇒ conservar todos)** | AC-2, DT-7/CD-15 | `goal:"cotiza el clima y el precio del dólar"` (español) + agentes RELEVANTES descriptos en inglés (`"weather forecast"`, `"fx rate quote"`), input tailoreado en inglés → 0 overlap léxico en TODO el plan | filtro dropearía todos → **conserva todos**; `steps` intacto; `compose` ejecuta; billing byte-idéntico; `reasoning` sin `dropped` y sin `no_relevant_agent`. **Prueba directa del false-negative multilingüe que motivó la enmienda.** |
| **T-152-3 (todo-relevante / cero regresión)** | AC-3, CD-3 | LLM selecciona 2 agentes relevantes | `plan` byte-idéntico a hoy: mismos `steps`/orden, `plannedCostUsd`/`totalCostUsdc`/`protocolFeeUsdc` iguales; compose ejecuta N steps. |
| **T-152-4 (recompute step-0)** | AC-4, CD-5 | step-0 original es el irrelevante; el segundo (relevante, precio ≠) sobrevive | `plannedCostUsd` == precio del sobreviviente (no del dropeado); `budgetService.debit` recibe `plannedCostUsd(sobreviviente)+gasOverhead`; `steps[0].passOutput===false`. |
| **T-152-5 (FALSE-NEGATIVE — crítico)** | Riesgo #1, DT-1 | agente RELEVANTE con name disjunto del goal pero cuyo `input` tailoreado (o capabilities) comparte ≥1 token con el goal | el step **NO se dropea**; plan ejecuta/cobra; `reasoning` sin "dropped". |
| **T-152-5b (goal sin tokens)** | CD-14 | `goal:"a b c"` (todos <3 chars) + plan LLM válido de agentes reales | filtro NO corre; TODOS los steps conservados; plan 'ready'. |
| **T-152-6 (regresión all-demos)** | AC-6, CD-7 | plan 100% demos (path LLM) | sigue `no_relevant_agent` sin débito; el filtro nuevo NO corre redundante. |
| **T-152-7 (regresión greedy)** | AC-7, CD-1/CD-7 | T-W5/T-W5b/T-W6 existentes | quedan verdes SIN modificación (guardrail del refactor W0.2). |
| **T-152-8 (helper unitario)** | DT-2 | `textOverlapsGoal` puro | overlap/no-overlap/goal-vacío/case-insensitive/tokens<3. |

---

## 7. Readiness Check

- [x] Work-item leído completo (Scope IN/OUT, AC-1..AC-7, CD-1..CD-7, DT-1..DT-3, Missing Inputs).
- [x] `project-context.md` leído (stack Fastify/TS strict/vitest/biome; money-path rules).
- [x] Deuda confirmada en código con archivo:línea (LLM branch :650-719 sin guard; guard :771-861 gateado por `usedFallback`/all-demos).
- [x] Todos los exemplars verificados con Read/Grep (§5) — cero paths inventados.
- [x] Riesgo #1 (false-negative) resuelto por diseño: **MIXED-PLAN-ONLY** (el filtro nunca vacía un plan, DT-7/CD-15) + corpus ampliado + bias-to-conserve + `goalTokens.size===0`⇒skip (DT-1/DT-2/CD-14) + tests T-152-2/2b/5.
- [x] Recompute de billing especificado (AC-4): **solo caso mixto** `0<relevantSteps.length<steps.length` → reasign `steps` antes de :877 (billing 1..N auto) + recompute `plannedCostUsd`/step-0 + reindex `passOutput` (DT-3). Todo-disjunto y todo-relevante = no-op.
- [x] ~35 tests money-path pre-existentes vuelven a verde por construcción (goals all-disjunto ⇒ conservar todos ⇒ billing byte-idéntico) — §6.
- [x] Preservados INTACTOS: WKH-127 (credit-back — filtro pre-débito), WKH-132 (fee-on-cost auto-recalculado de `steps`), `allStepsAreDemos`, `fallbackNoRelevance`, CD-14, recompute parcial (CD-1/CD-5/CD-13).
- [x] Override del comentario :786-792 justificado con evidencia (DT-6).
- [x] Auto-Blindaje histórico incorporado (CD-8..CD-11: `noUncheckedIndexedAccess`, biome/RTK, useOptionalChain, validate≠parse).
- [x] Test plan ≥1 por AC + false-negative + step-0 recompute + regresiones greedy/all-demos (§6).
- [x] Waves definidas (W0 baseline/helper → W1 filtro/recompute → W2 tests).

**TBDs / [NEEDS CLARIFICATION]:**

- **[LIMITACIÓN CONOCIDA — no bloqueante, resuelta por diseño MIXED-PLAN-ONLY]** El overlap léxico
  binario no captura relevancia semántica cross-vocabulario (multilingüe / sinónimos). La enmienda
  DT-7/CD-15 elimina el false-negative **catastrófico** (all-disjunto ⇒ NUNCA vaciar el plan ⇒
  conservar todos). Queda un **residual acotado**: dentro de un plan mixto multilingüe, un step
  válido-pero-disjunto podría dropearse si OTRO step del mismo plan matchea léxicamente (el match
  "habilita" el drop de los disjuntos). Es estrictamente menor que el problema que se elimina y
  requiere una conjunción de condiciones (plan mixto + ≥1 match + ≥1 válido-disjunto co-presente).
  **El AR debe evaluarlo explícitamente.** Un matcher semántico (embeddings) violaría CD-4/AC-5; si
  telemetría/QA evidencia casos reales → HU de refinamiento separada. **No bloquea F2.**

**Veredicto:** SDD **enmendado (MIXED-PLAN-ONLY, 2026-07-07), listo para re-SPEC_APPROVED**. Cero TBD
bloqueante.
