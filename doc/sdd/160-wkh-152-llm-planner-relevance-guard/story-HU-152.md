# Story File — WKH-152: Planner LLM per-step relevance guard (money-path backstop)

| Campo | Valor |
|-------|-------|
| HU | WKH-152 |
| SDD | `doc/sdd/160-wkh-152-llm-planner-relevance-guard/sdd.md` |
| Work-item | `doc/sdd/160-wkh-152-llm-planner-relevance-guard/work-item.md` |
| Branch | `fix/160-wkh-152-llm-relevance-guard` |
| Base | `main` |
| Sizing | M — QUALITY (money-path) |
| Generado | 2026-07-07 — Architect F2.5 NexusAgil |
| Enmendado | 2026-07-07 — **MIXED-PLAN-ONLY** (decisión del humano): el filtro NUNCA vacía un plan. Ver DT-7/CD-15 del SDD. |

> El Dev SOLO lee este archivo. Todo lo necesario está acá. NO reinterpretar el SDD.
> Todos los snippets son **pseudocódigo-guía**, NO código final: el Dev escribe el código real
> respetando el estilo existente de `orchestrate.ts` (2-space indent, `.js` imports, TS strict).
>
> **⚠️ ENMIENDA MIXED-PLAN-ONLY (leer primero):** el filtro **NUNCA vacía un plan**. Solo dropea
> steps irrelevantes cuando **≥1 step relevante sobrevive** (plan mixto). Si el filtro dropearía
> TODOS los steps (todos disjuntos del goal) → **conservar TODOS** (no-op, sin rechazo, sin débito
> extra) — NO ir a `no_relevant_agent`. Motivo: false-negatives multilingües (goal español vs.
> agente inglés) rompían 35 tests money-path y rechazaban trabajo válido. WasiAI es LATAM/multilingüe.

---

## 1. Contexto mínimo (qué es la deuda)

El path del **planner LLM** en `src/services/orchestrate.ts` (función `planOrchestration`) arma
`steps` SIN ningún guard de relevancia. En el branch `if (plan) { ... }` (**:650-719**) el único
filtrado es existencia de slug (`discoveredSlugs.has`, :652-655) + budget (:668-678). El guard
determinístico que YA existe (`fallbackNoRelevance`, **:793-809**) está gateado por `usedFallback`
→ cubre SOLO el path greedy. `allStepsAreDemos` (**:782-784**) solo dispara si TODOS los steps son
demos.

**Consecuencia (el bug):** un plan MIXTO del LLM (1 agente relevante + 1 agente real-irrelevante)
llega a `planStatus: 'ready'` y AMBOS agentes se debitan: el step-0 en `executeApprovedPlan`
(**:1065-1073**, `plannedCostUsd + gasOverhead`) y los steps 1..N dentro de `composeService.compose`
(**:1129**). El caller paga por un agente fuera de tema.

**Fix (MIXED-PLAN-ONLY):** filtro de relevancia **per-step**, **determinístico** (reusa
`tokenizeForRelevance`, :342-350), aplicado SOLO al plan del LLM (`usedFallback === false`),
integrado en el bloque del guard existente (**:771-861**), ANTES de cualquier débito/compose. **El
filtro NUNCA vacía un plan.** Dropea steps CLARAMENTE irrelevantes **SOLO cuando ≥1 step relevante
sobrevive** (`0 < relevantSteps.length < steps.length` = plan mixto = el bug real) → recalcula
`plannedCostUsd`/step-0 y reindexa `passOutput`. Si el filtro dropearía TODOS los steps
(`relevantSteps.length === 0`, todos disjuntos del goal) → **conservar TODOS** (no-op, `steps`
intacto, sin rechazo, billing byte-idéntico a sin-filtro). El early-return `no_relevant_agent`
(:811-861) queda EXCLUSIVAMENTE para all-demos/greedy — el filtro LLM NO lo dispara.

**Números de línea = referencia del snapshot leído en F2. Verificá el ancla por CONTENIDO
(nombre de var/función), no confíes ciegamente en el número si el archivo cambió.**

---

## 2. Acceptance Criteria (del work-item)

| AC | Descripción |
|----|-------------|
| AC-1 | Plan mixto (relevante + real-irrelevante, **≥1 relevante sobrevive**) → el/los irrelevante(s) se EXCLUYEN antes de `debit`/`compose`; no se ejecutan ni cobran. |
| AC-2 | **(ENMENDADO)** Filtro que dropearía TODOS los steps (todos disjuntos del goal) → **conservar TODOS** (no-op, sin débito extra, sin rechazo); ejecuta y cobra como hoy. El drop solo aplica cuando `0 < relevantSteps.length < steps.length`. **NUNCA** `no_relevant_agent` desde el filtro LLM. |
| AC-3 | Plan 100% relevante → ejecuta/cobra IGUAL que hoy: `plannedCostUsd`, `totalCostUsdc`, `protocolFeeUsdc`, `steps.length`, orden — cero regresión. |
| AC-4 | Si el step dropeado era el step-0 original → recalcular `plannedCostUsd`/step-0 sobre el PRIMER sobreviviente; débito == ejecución. |
| AC-5 | 100% determinístico, en memoria, SIN llamadas LLM/red adicionales. |
| AC-6 | `allStepsAreDemos` sigue dando `no_relevant_agent`; el nuevo filtro NO corre redundante sobre un plan ya vaciado por all-demos. |
| AC-7 | `usedFallback === true` (greedy): `fallbackNoRelevance` intacto; el filtro nuevo NO corre ni cambia el greedy. |

---

## 3. Constraint Directives — CHECKLIST BLOQUEANTE (money-path)

Marcá cada una antes de pedir AR. Cualquier violación = BLOQUEANTE.

| CD | Constraint | Cómo lo cumplís |
|----|-----------|-----------------|
| **CD-1** | NO alterar comportamiento observable de `fallbackNoRelevance` / `allStepsAreDemos`. | T-W4/T-W5/T-W5b/T-W5c/T-W6 quedan VERDES sin tocarlos. |
| **CD-2** | Ningún step filtrado llega a `budgetService.debit` (:1065) ni `composeService.compose` (:1129). | Filtro ocurre en `planOrchestration`, ANTES del return del plan. |
| **CD-3** | NO no-cobrar trabajo válido: la porción relevante se cobra idéntico a hoy. | Bias-to-conserve + recompute byte-idéntico en all-relevante (AC-3). |
| **CD-4** | 100% determinístico, sin LLM/red extra. | Solo `tokenizeForRelevance` + string ops en memoria. |
| **CD-5** | NO romper WKH-127 (débito/refund step-0) ni WKH-132 (fee-on-cost). | El filtro corre ANTES del pricing/debit; solo cambia CUÁLES steps llegan. |
| **CD-6** | Cero-cobro del irrelevante (no "no doble", CERO). | Test verifica que `composeCall.steps` NO contiene el slug irrelevante. |
| **CD-7** | Test regresión explícito all-demos + greedy → siguen `no_relevant_agent` sin debit. | T-152-6 + T-152-7. |
| **CD-8** | `noUncheckedIndexedAccess`: `steps[0]`/`budgetedAgents[0]` son `T | undefined`. Guardar en const + chequear. **NUNCA `steps[0]!`.** | Ver §5 recompute. |
| **CD-9** | Filtro total-función: tolerar `input`/`capabilities` mal-formados a runtime. NO spreadear/iterar sin `Array.isArray`. Un throw NO debe escapar. | `agent.capabilities.join(' ')` ya lo asume; `JSON.stringify(step.input)` es seguro. |
| **CD-10** | Formato: `./node_modules/.bin/biome check --write <archivos>` — **NO `npx biome`** (se rompe bajo el hook RTK). Objetos literales inline (args de test) → multilínea. | Correr en W1.4 y W2. |
| **CD-11** | biome `useOptionalChain`: evitar `x !== null && x.m()` → usar `Boolean(x?.m())`. | Al escribir el predicado. |
| **CD-12** | NO tocar el prompt del planner (`systemPrompt`/`userPrompt` :180-214) ni el contrato `LlmPlanAgent`/`selectedAgents`. | Fix es puramente post-plan determinístico. |
| **CD-13** | Filtro corre SOLO si `usedFallback === false` Y `¬allStepsAreDemos`. | Gate explícito. |
| **CD-14** | `goalTokens.size === 0` (path LLM) ⇒ **conservar TODOS los steps** (skip filtro). NUNCA vaciar un plan LLM por goal sin tokens. | Guard al entrar al filtro. |
| **CD-15** | **(ENMIENDA MIXED-PLAN-ONLY)** El filtro LLM **NUNCA vacía un plan**. Si `relevantSteps.length === 0` ⇒ **conservar TODOS** (no-op). El drop se aplica **si-y-solo-si** `0 < relevantSteps.length < steps.length`. PROHIBIDO que el filtro LLM produzca `steps:[]` o dispare `no_relevant_agent` (:811-861). | `applyDrop = llmFilterApplies && relevantSteps.length > 0 && relevantSteps.length < steps.length`. NO tocar la condición del early-return (:811). |

**Invariante money mental:** `débito == ejecución`. Lo que sobrevive al filtro es EXACTAMENTE lo
que se ejecuta y lo que se cobra. El step-0 facturado es SIEMPRE el primer sobreviviente.
**Corolario MIXED-PLAN-ONLY:** en el caso todo-disjunto NO se dropea nada → los steps ejecutados y
cobrados son EXACTAMENTE el plan original (igual que hoy, cero cambio de billing).

---

## 4. Archivos afectados (Scope IN — exhaustivo)

| Archivo | Acción | Wave |
|---------|--------|------|
| `src/services/orchestrate.ts` | MODIFICAR — helper `textOverlapsGoal` (module-level) + filtro per-step en guard block + recompute + update comentario :786-792 | W0, W1 |
| `src/services/orchestrate.test.ts` | MODIFICAR — agregar T-152-1..T-152-8 (junto a T-W4..T-W6) | W0, W2 |

**PROHIBIDO tocar cualquier otro archivo.** En particular NO tocar: `discovery.ts`, `compose.ts`,
`agent-price.ts`, `src/types/index.ts`, el prompt, `greedyPlan`, `fallbackNoRelevance` (salvo el
refactor opcional behavior-preserving de W0.2).

---

## 5. EL CRITERIO EXACTO DEL FILTRO (no reinventar)

**Un step del plan LLM se DROPEA si-y-solo-si su corpus comparte CERO tokens con `goalTokens`.**

```
goalTokens = tokenizeForRelevance(goal)          // YA existe en :793, reusar esa var del scope

// Predicado por step (agent = discovered.agents.find(a => a.slug===s.agent && a.registry===s.registry)):
corpus(step, agent) = agent.name + ' ' +
                      agent.description + ' ' +
                      agent.capabilities.join(' ') + ' ' +
                      JSON.stringify(step.input)          // ← ampliación vs. el corpus del greedy

relevante(step) = textOverlapsGoal(corpus(step, agent), goalTokens)   // ≥1 token común ≥3 chars
drop(step)      = ¬ relevante(step)
```

Reglas duras:
- **Mismo tokenizador y mismo umbral (overlap ≥1) que `fallbackNoRelevance`** (:802-808). La ÚNICA
  diferencia: (a) per-step en vez de todo-o-nada, (b) corpus incluye `JSON.stringify(step.input)`.
- **Agregar `input` es estrictamente conservador (false-negative-safe):** más tokens → más chance de
  overlap → solo CONSERVA más steps, nunca dropea más. En greedy `input` es siempre `{goal}` (:306),
  así que el mismo predicado ahí sería no-op — cero divergencia (y el greedy ni corre este filtro).
- **Bias-to-conserve (mandato del gate HU "ante la duda, CONSERVAR"):** si el agente NO comparte
  ningún token con el goal ni en name/desc/caps NI en el input tailoreado → DROP (irrelevancia
  CLARA). Cualquier señal léxica → conservar.
- **CD-14 — goal sin tokens:** `if (goalTokens.size === 0)` ⇒ **saltar el filtro, conservar TODO.**
  El LLM ya juzgó semánticamente; sin señal léxica del goal, dropear sería false-negative catastrófico.
- **`textOverlapsGoal` con `goalTokens` vacío devuelve `false`** (semántica del helper). Por eso el
  caller (path LLM) DEBE cortocircuitar ANTES con el guard CD-14 — NO delegar el caso vacío al helper.
- **CD-15 — MIXED-PLAN-ONLY (el filtro NUNCA vacía un plan):** el drop se aplica **si-y-solo-si
  `0 < relevantSteps.length < steps.length`** (plan mixto = ≥1 relevante sobrevive Y ≥1 se dropea).
  - `relevantSteps.length === 0` (TODOS disjuntos) ⇒ **conservar TODOS** (no-op, `steps` intacto,
    sin recompute, sin `no_relevant_agent`). Se confía en el juicio semántico del LLM — un plan donde
    NINGÚN step matchea léxicamente es señal de multilingüismo/vocabulario distinto, no de
    irrelevancia. **NO extender la condición del early-return (:811).**
  - `relevantSteps.length === steps.length` (TODOS relevantes) ⇒ no-op (byte-identidad, AC-3).
  - Solo el caso mixto reasigna `steps` + recompute (§7).

  **Regla mental:** el filtro solo confía en su señal léxica cuando esa señal se **corrobora** con
  ≥1 match dentro del mismo plan. Sin ningún match → conservar todo.

### Si agent es `undefined` (defensivo, CD-9)
`discovered.agents.find(...)` puede no encontrar match (edge). Decisión conservadora: **si no se
resuelve el agent → CONSERVAR el step** (no dropear por falta de datos). No hacer throw.

---

## 6. Waves con pasos atómicos verificables

### W0 — Baseline verde + helper puro (SERIAL)

- **W0.1** Baseline de regresión (CD-1/CD-7). Correr y confirmar VERDE ANTES de tocar nada:
  ```
  npx vitest run src/services/orchestrate.test.ts src/services/orchestrate.billing.test.ts
  ```
  Anotar el nº de tests que pasan (será el piso).

- **W0.2** Extraer helper module-level, cerca de `tokenizeForRelevance` (:342-350):
  ```ts
  /** True si `text` comparte ≥1 token evaluable (≥3 chars) con goalTokens.
   *  goalTokens vacío ⇒ false (el caller decide la semántica del caso vacío). */
  function textOverlapsGoal(text: string, goalTokens: Set<string>): boolean {
    const textTokens = tokenizeForRelevance(text);
    for (const token of goalTokens) {
      if (textTokens.has(token)) return true;
    }
    return false;
  }
  ```
  **Opcional (recomendado):** refactorizar el cuerpo de `fallbackNoRelevance` (:797-808) para llamar
  a `textOverlapsGoal` — **behavior-preserving**. Guardrail: T-W5/T-W5b/T-W5c/T-W6 verdes SIN cambios.
  Si dudás, dejá `fallbackNoRelevance` intacto (el helper nuevo se usa solo en W1).

- **W0.3** Checkpoint: `npx tsc --noEmit` limpio. (Aún sin cambio de comportamiento.)

### W1 — Filtro per-step + recompute (SERIAL, depende de W0)

Ubicación: dentro del bloque del guard (**:771-861**), DESPUÉS de calcular `allStepsAreDemos`
(:782-784) y `goalTokens` (:793), y ANTES del `if (allStepsAreDemos || fallbackNoRelevance)` (:811).

- **W1.1** Computar los sobrevivientes + el flag `applyDrop` (gate CD-13 + CD-14 + CD-15):
  ```ts
  // demoSlugs ya está en scope (const demoSlugs = getDemoSlugs(), :606).
  // discovered.agents ya está en scope.
  const llmFilterApplies =
    !usedFallback && !allStepsAreDemos && goalTokens.size > 0;   // CD-13 + CD-14

  let relevantSteps = steps;
  if (llmFilterApplies) {
    relevantSteps = steps.filter((s) => {
      const agent = discovered.agents.find(
        (a) => a.slug === s.agent && a.registry === s.registry,
      );
      if (!agent) return true;                      // no resuelto ⇒ CONSERVAR (§5 defensivo)
      const corpus =
        `${agent.name} ${agent.description} ${agent.capabilities.join(' ')} ${JSON.stringify(s.input)}`;
      return textOverlapsGoal(corpus, goalTokens);  // overlap ≥1 ⇒ conservar
    });
  }
  // CD-15 (MIXED-PLAN-ONLY): dropear SOLO si ≥1 relevante sobrevive Y ≥1 se dropea.
  // relevantSteps.length === 0  (todos disjuntos) ⇒ applyDrop=false ⇒ conservar todos.
  // relevantSteps.length === steps.length (todos relevantes) ⇒ applyDrop=false ⇒ no-op.
  const applyDrop =
    llmFilterApplies &&
    relevantSteps.length > 0 &&
    relevantSteps.length < steps.length;
  const llmDropped = applyDrop ? steps.length - relevantSteps.length : 0;
  ```
  **Checkpoint:** `npx tsc --noEmit` limpio (ojo `noUncheckedIndexedAccess`).

- **W1.2** Caso todo-disjunto (`relevantSteps.length === 0`) → **CONSERVAR TODOS (no-op)**, NO
  `no_relevant_agent`. **NO tocar la condición del early-return `no_relevant_agent` (:811)** — el
  `if (allStepsAreDemos || fallbackNoRelevance)` queda **exactamente como está** (el filtro LLM no
  aporta un tercer disyunto). Al no dropear, `steps` sigue intacto → billing byte-idéntico a
  sin-filtro. **NO existe `llmFilterEmptied`; NO existe rama de `reasoning` LLM en el early-return.**
  (Este es el corazón de la enmienda: revertir la implementación previa que ruteaba el caso
  todo-disjunto a `no_relevant_agent` y rompía 35 tests money-path.)

- **W1.3** Caso MIXTO (`applyDrop === true`, i.e. `0 < relevantSteps.length < steps.length`) →
  reasignar + recompute. Colocar DESPUÉS del early-return (:861) y ANTES del cómputo de `costPerStep`
  (:877):
  ```ts
  if (applyDrop) {
    // REINDEX passOutput por construcción — cero cirugía de off-by-one.
    steps = relevantSteps.map((s, i) => ({ ...s, passOutput: i > 0 }));

    // RECOMPUTE plannedCostUsd/step-0 — espejo EXACTO de :707-713 (registry-aware).
    const step0 = steps[0];                          // CD-8: ComposeStep | undefined
    plannedCostUsd = step0
      ? (await resolveAgentPriceUsdc(step0.agent, step0.registry)) ?? 0
      : 0;

    reasoning += ` (${llmDropped} irrelevant agent(s) dropped)`;   // espejo del note :717
  }
  // Si !applyDrop (todo-relevante O todo-disjunto) → NO reasignar (byte-identidad, AC-2/AC-3).
  // costPerStep/totalCostUsdc/protocolFeeUsdc (:877-896) se derivan de `steps` → se recalculan
  // por construcción con el array (intacto en el no-op, filtrado en el mixto).
  ```
  **Notas obligatorias:**
  - `steps` es `let` (reasignable) en el scope de `planOrchestration` — verificar; si fuera `const`,
    NO cambiar la declaración a la ligera, revisar el flujo (hoy se asigna en :663/:680, así que es `let`).
  - `plannedCostUsd` también es `let` mutable en el scope (se asigna en :666/:713).
  - `resolveAgentPriceUsdc` ya está importado (:24) y ya se usa en :711 — mismo resolver, registry-aware.
  - **Checkpoint:** `npx tsc --noEmit` limpio.

- **W1.4** Actualizar el comentario de diseño **:786-792** (DT-6): reflejar que el path LLM ahora
  tiene un backstop determinístico per-step conservador (ref WKH-152 + evidencia auditoría 2026-07-06/07),
  PRESERVANDO la explicación del greedy. Luego:
  ```
  npx tsc --noEmit
  ./node_modules/.bin/biome check --write src/services/orchestrate.ts
  ```

### W2 — Test matrix (tras W1)

Agregar los tests en `src/services/orchestrate.test.ts` junto a T-W4..T-W6 (misma región,
mismos helpers). Ver §7. Checkpoint final:
```
npx tsc --noEmit
./node_modules/.bin/biome check --write src/services/orchestrate.test.ts
npx vitest run src/services/orchestrate.test.ts src/services/orchestrate.billing.test.ts
```

---

## 7. Recompute de billing — PASO A PASO (la parte de mayor riesgo)

Flujo de índices que el AR verificará (DT-3):

```
budgetedAgents (LLM) ─map(:680-690)→ steps (passOutput: index>0, step-0 pricing :707-713)
      │
      ▼  [guard block :771-861, usedFallback===false, ¬allStepsAreDemos, goalTokens.size>0]
  relevantSteps = steps.filter(relevante)          // §5 predicado
  applyDrop = (relevantSteps.length > 0 && relevantSteps.length < steps.length)   // CD-15
      │
      ├─ CASO TODO-DISJUNTO (relevantSteps.length === 0)  →  applyDrop = FALSE:
      │     → CONSERVAR TODOS — no-op. steps intacto (plan original completo).
      │     → NO reasignar, NO recompute, NO tocar el early-return, NO no_relevant_agent.
      │     → billing byte-idéntico a sin-filtro; ejecuta y cobra como hoy.
      │     → (AC-2 enmendado, DT-7/CD-15). Cubre el caso multilingüe (T-152-2b).
      │
      ├─ CASO MIXTO (0 < relevantSteps.length < steps.length)  →  applyDrop = TRUE:
      │     → steps = relevantSteps.map((s,i) => ({ ...s, passOutput: i>0 }))   // REINDEX
      │           · el primer sobreviviente pasa a passOutput:false → usa su propio input
      │     → const step0 = steps[0]; plannedCostUsd = step0 ? (await resolveAgentPriceUsdc(
      │           step0.agent, step0.registry)) ?? 0 : 0                        // RECOMPUTE step-0
      │     → reasoning += ` (${llmDropped} irrelevant agent(s) dropped)`
      │     → costPerStep/totalCostUsdc/maxQuotedCostUsdc/protocolFeeUsdc (:877-896)
      │           se recalculan de `steps` reasignado POR CONSTRUCCIÓN (no tocar esa capa)
      │     → executeApprovedPlan (:1065) debita plannedCostUsd(sobreviviente)+gasOverhead   // AC-4
      │
      └─ CASO TODO-RELEVANTE (relevantSteps.length === steps.length)  →  applyDrop = FALSE:
            → NO reasignar, NO recompute → byte-identidad con hoy (AC-3, cero regresión)
```

**Por qué el reindex de `passOutput` es seguro (DT-4):** al dropear un step del medio, el nuevo head
usa su propio `input` (`passOutput:false`). Un agente irrelevante es improbable que fuera un eslabón
de datos genuino; romper la cadena es preferible a ejecutar/cobrar fuera de tema. Documentado en
`reasoning`. No se escala a rechazo-total.

---

## 8. Tests exactos a escribir (§6 SDD)

Reusar helpers existentes: `setLlmResponse` (:182), `setLlmError` (:188), `makeDemoAgents`,
`mockAgents` (:127), `masterKeyRow` (:940), `vi.mocked(discoveryService.discover / getAgent /
budgetService.debit / composeService.compose / chargeProtocolFee)`. Para que el recompute step-0
resuelva precio, mockear `discoveryService.getAgent` consistente con el `discover` del test (patrón
ya usado en T-AC-DOUBLE, :955/:987/…). Objetos literales inline → multilínea (CD-10).

| ID | AC/CD | Escenario | Assert clave |
|----|-------|-----------|--------------|
| **T-152-1 (mixto)** | AC-1, CD-2/CD-6 | discover=[relevante, irrelevante-real (no-demo)]; LLM selecciona AMBOS; input tailoreado disjunto para el irrelevante; **el relevante SÍ matchea léxicamente** | `composeCall.steps` NO contiene el slug irrelevante; el relevante SÍ está; `budgetService.debit` llamado; `result.reasoning` contiene `dropped`. |
| **T-152-2 (todo-disjunto ⇒ conservar todos)** | AC-2, DT-7/CD-15 | LLM selecciona SOLO agentes reales todos disjuntos del goal (no-demos, input disjunto) → filtro dropearía todos | **NO** `no_relevant_agent`; `compose` ejecuta con `steps` = plan original completo (length N, orden original); `debit`/`compose`/`chargeProtocolFee` SÍ llamados; billing **byte-idéntico** a sin-filtro; `reasoning` sin `dropped` y sin `no_relevant_agent`. |
| **T-152-2b (multilingüe ⇒ conservar todos)** | AC-2, DT-7/CD-15 | `goal: 'cotiza el clima y el precio del dolar'` (español) + agentes RELEVANTES en inglés (`name/description: 'weather forecast'`, `'fx rate quote'`), input tailoreado en inglés → 0 overlap léxico en TODO el plan | filtro dropearía todos → **conserva todos**; `compose` ejecuta con `steps` original completo; billing byte-idéntico; `reasoning` sin `dropped` ni `no_relevant_agent`. **Prueba directa del false-negative multilingüe que motivó la enmienda MIXED-PLAN-ONLY.** |
| **T-152-3 (todo-relevante / cero regresión)** | AC-3, CD-3 | LLM selecciona 2 agentes relevantes | `composeService.compose` llamado 1×; `reasoning` NO contiene `dropped` ni `no_relevant_agent`; `composeCall.steps.length === 2` en orden original. |
| **T-152-4 (recompute step-0)** | AC-4, CD-5/CD-8 | step-0 original = irrelevante; 2º step relevante con **precio distinto** sobrevive | `budgetService.debit` recibe `precio(sobreviviente)+gasOverhead` (NO el del dropeado); `composeCall.steps[0]` = slug sobreviviente con `passOutput === false`. |
| **T-152-5 (FALSE-NEGATIVE — crítico)** | Riesgo #1, DT-1 | agente RELEVANTE con `name`/`description` disjunto del goal pero cuyo `input` tailoreado (o `capabilities`) comparte ≥1 token con el goal | el step **NO se dropea**; `compose` ejecuta; `reasoning` NO contiene `dropped`. |
| **T-152-5b (goal sin tokens)** | CD-14 | `goal: 'a b c'` (todos <3 chars) + plan LLM válido de agentes reales | filtro NO corre; TODOS los steps conservados; `planStatus`/reasoning NO `no_relevant_agent`; `compose` ejecuta. |
| **T-152-6 (regresión all-demos)** | AC-6, CD-7 | plan 100% demos vía path LLM (LLM selecciona solo `base-demo`, como T-W4) | sigue `no_relevant_agent` sin debit; el filtro nuevo NO corre redundante (rama `allStepsAreDemos`). |
| **T-152-7 (regresión greedy)** | AC-7, CD-1/CD-7 | T-W5/T-W5b/T-W5c/T-W6 EXISTENTES | quedan VERDES sin modificarlos (guardrail del refactor W0.2). No se escriben nuevos; se verifica que pasan. |
| **T-152-8 (helper unitario)** | DT-2 | `textOverlapsGoal` puro | overlap ⇒ true; sin-overlap ⇒ false; `goalTokens` vacío ⇒ false; case-insensitive; tokens <3 chars ignorados. |

Mínimo: 1 test por AC + T-152-2b (multilingüe) + T-152-5 (false-negative) + T-152-4 (recompute
step-0) + T-152-6/7 (regresión all-demos/greedy). Total nuevo: 8 tests (+ verificación de los 4
greedy existentes).

**Los ~35 tests money-path pre-existentes deben volver a VERDE por construcción (no editarlos):**
sus goals placeholder son léxicamente all-disjunto de los corpus de agentes mock → bajo
MIXED-PLAN-ONLY `relevantSteps.length === 0` ⇒ **conservar todos (no-op)** ⇒ `steps` intacto ⇒
billing byte-idéntico. La implementación previa (all-disjunto ⇒ `no_relevant_agent`) los rompía;
la enmienda los deja intactos SIN tocar sus fixtures. **Si algún test pre-existente sigue rojo tras
W1, es señal de que el caso todo-disjunto NO está cayendo en el no-op — revisar `applyDrop`.**

---

## 9. Definition of Done

- [ ] `npx tsc --noEmit` — cero errores (incl. `noUncheckedIndexedAccess` en `steps[0]`).
- [ ] `./node_modules/.bin/biome check --write` sobre `orchestrate.ts` + `orchestrate.test.ts` — limpio.
- [ ] `npx vitest run src/services/orchestrate.test.ts src/services/orchestrate.billing.test.ts` — todos verdes, **incluidos los ~35 money-path pre-existentes SIN editarlos** (vuelven a verde por construcción, MIXED-PLAN-ONLY).
- [ ] T-152-1..T-152-8 + T-152-2b escritos y pasan (T-152-7 = los 4 greedy existentes intactos y verdes).
- [ ] AC-1..AC-7 cubiertos con evidencia de test (archivo:línea en el done-report del Dev). AC-2 = **conservar-todos** (T-152-2/2b), NO `no_relevant_agent`.
- [ ] CD-1..CD-15 respetados (checklist §3 tildado). CD-15: el filtro LLM nunca vacía un plan.
- [ ] **El early-return `no_relevant_agent` (:811) NO fue extendido** con un disyunto del filtro LLM (`git diff` sobre esa condición = vacío salvo comentarios).
- [ ] Comentario :786-792 actualizado (DT-6) preservando la explicación del greedy.
- [ ] Scope IN respetado: SOLO `orchestrate.ts` + `orchestrate.test.ts` modificados (`git diff --name-only`).
- [ ] NO se tocó: prompt, contrato `LlmPlanAgent`, `greedyPlan`, `compose.ts`, `discovery.ts`, `agent-price.ts`, `types/index.ts`.
- [ ] `git diff` muestra que `steps` filtrado se reasigna ANTES de `:877` (billing 1..N auto) y `plannedCostUsd` recomputado en el caso parcial.

---

## 10. Anti-Hallucination Checklist (verificado por el Architect)

- [x] `tokenizeForRelevance` existe en `orchestrate.ts:342-350` (Read confirmado).
- [x] `fallbackNoRelevance` en :793-809, gateado por `usedFallback` (Read confirmado).
- [x] early-return `no_relevant_agent` en :811-861 con `steps:[]`/`plannedCostUsd:0`/`feeUsdc:0` (Read confirmado). **Bajo MIXED-PLAN-ONLY su condición NO se toca — queda solo para all-demos/greedy.**
- [x] step-0 pricing `budgetedAgents[0]?.slug` + `resolveAgentPriceUsdc(slug, registry)` en :707-713 (Read confirmado).
- [x] `resolveAgentPriceUsdc` importado en :24 desde `./agent-price.js` (grep confirmado).
- [x] `demoSlugs = getDemoSlugs()` en scope de la función (:606) (grep confirmado).
- [x] billing post-guard (`costPerStep`/`totalCostUsdc`/`protocolFeeUsdc`) derivado de `steps` en :877-896 (Read confirmado).
- [x] `steps` y `plannedCostUsd` son `let` mutables en el scope de `planOrchestration` (:663/:666/:680/:713).
- [x] Helpers de test `setLlmResponse`(:182)/`setLlmError`(:188)/`masterKeyRow`(:940)/`mockAgents`(:127) existen (grep confirmado).
- [x] Exemplars de test T-W4(:1825)/T-W5(:1882)/T-W5b(:1915)/T-W5c(:1945)/T-W6(:1965) existen (Read confirmado).
- [x] Cero paths/APIs inventados.

---

*Story File generado por Architect — F2.5 NexusAgil | 2026-07-07 | WKH-152*
*Enmendado (MIXED-PLAN-ONLY, decisión del humano) — Architect | 2026-07-07 | ver SDD DT-7/CD-15*
