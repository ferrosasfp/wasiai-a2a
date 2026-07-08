# Story File — #164: [WKH-163] La remesa insignia se trunca por el backstop léxico de WKH-152 (dropea `cashout-matcher`)

> SDD: `doc/sdd/164-wkh-163-cashout-matcher-relevance-fix/sdd.md`
> Work Item: `doc/sdd/164-wkh-163-cashout-matcher-relevance-fix/work-item.md`
> Fecha: 2026-07-08
> Branch: `fix/164-wkh-163-cashout-matcher-relevance-fix`
> Money-path insignia · QUALITY. **Dev implementa este documento wave por wave, SIN volver a decidir nada.**

---

## Goal

El backstop léxico per-step de WKH-152 (`orchestrate.ts:885-906`) dropea `agentshop-cashout-matcher`
—la pata que ENTREGA el dinero— del plan insignia de Chaski `"Send $400 to my mom in Peru"`, dejando un
plan `ready` de 2 steps que cobra KYC+corridor sin completar la remesa. Causa raíz: `goalTokens` incluye
el token puramente numérico `"400"`; el `input` tailoreado de `kyc`/`corridor` hace echo de `amountUSD:400`
→ comparten `"400"` → sobreviven; `cashout-matcher` no → plan mixto → drop. **El fix (2 partes):**
**(W0)** el filtro LLM usa un set nuevo `llmGoalTokens = goalTokens` menos tokens puramente numéricos
(`/^\d+$/`) → el plan insignia queda all-disjoint → CD-15 conserva los 3. **(W0)** un "terminal delivery
guard" (defense-in-depth) rescata el step terminal si-y-solo-si sería dropeado Y `llmDropped ≥ 2`.

## Acceptance Criteria (EARS) — copiados del SDD/work-item aprobados

- **AC-1**: WHEN el goal es `"Send $400 to my mom in Peru"` y el planner LLM selecciona el plan de 3
  agentes de remesa (`agentshop-kyc-validator`, `agentshop-corridor-discoverer`, `agentshop-cashout-matcher`),
  THE system SHALL devolver un plan `ready` con los 3 steps intactos (ninguno dropeado por el backstop).
- **AC-2**: WHEN el goal es la variante ES `"Enviar 400 dolares a mi mama en Peru"` con el mismo plan de 3
  agentes, THE system SHALL devolver igualmente los 3 steps intactos (mismo resultado, independiente del idioma).
- **AC-3**: WHILE el goal es multilingüe respecto al corpus de agentes (p.ej. `"cotiza el precio del dolar"`
  contra agentes en inglés) Y el plan queda all-disjoint tras el filtro, THE system SHALL seguir devolviendo
  `planStatus:'ready'` sin `no_relevant_agent` (CD-15 heredada, sin regresión).
- **AC-4**: IF el goal es nonsense / sin agente real relevante (todos demo o cero overlap en greedy), THEN
  THE system SHALL seguir devolviendo `planStatus:'no_relevant_agent'` exactamente como hoy
  (`allStepsAreDemos`/`fallbackNoRelevance`, sin cambios).
- **AC-5**: THE system SHALL NUNCA producir un plan con `steps:[]` como resultado del backstop del path LLM
  (invariante MIXED-PLAN-ONLY/CD-15, heredada sin cambios).
- **AC-6**: WHEN el backstop excluye ≥1 step de un plan mixto GENUINO (agente real efectivamente irrelevante
  mezclado con relevantes, ej. T-152-1), THE system SHALL seguir dropeándolo y recomputando
  `plannedCostUsd`/`step0Slug`/`step0Registry` sobre el primer sobreviviente (mecanismo WKH-152 AC-4). El fix
  NO SHALL desactivar el drop del caso genuino.
- **AC-7**: THE system SHALL mantener débito == ejecución: ningún step (incluidos los conservados por esta HU)
  SHALL debitarse/ejecutarse dos veces, y ningún step dropeado SHALL llegar a `budgetService.debit` ni a
  `composeService.compose`.
- **AC-8**: THE system SHALL mantener el guard 100% determinístico, en memoria, sin llamadas adicionales a
  LLM/red (mismo criterio de costo/latencia que el backstop existente).

## Files to Modify/Create

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `src/services/orchestrate.ts` | Modificar | W0: (a) agregar `llmGoalTokens` junto a `goalTokens` (`:851`); (b) gate `llmFilterApplies` usa `llmGoalTokens.size` (`:885-886`); (c) filtro per-step usa `llmGoalTokens` (`:896`); (d) insertar terminal-delivery-guard entre el filtro (`:897`) y `applyDrop` (`:902`). **Nada más.** | El propio bloque `:851-906` |
| 2 | `src/services/orchestrate.test.ts` | Modificar | W(tests): agregar T-163-1..T-163-4 (ver "Test Expectations"). NO editar ningún test existente. | Fixtures `wkh152Agents` `:2080-2115`; test shape `:2119-2160` |

**NO se toca ningún otro archivo.** No hay archivos a crear.

## Exemplars

### Exemplar 1: bloque del backstop MIXED-PLAN-ONLY (a modificar)
**Archivo**: `src/services/orchestrate.ts:851-906` (verificado en HEAD)
**Usar para**: Archivo #1
**Estado real (HEAD) que Dev va a encontrar** — es la guía, el Dev adapta al estado real si difiere:
```ts
const goalTokens = tokenizeForRelevance(goal);            // :851  ← insertar llmGoalTokens JUSTO DESPUÉS
const fallbackNoRelevance = usedFallback && ( ... );       // :852-867  ← NO TOCAR (greedy)

// :869-884 comentario WKH-152 (dejar o extender, NO borrar la semántica)
const llmFilterApplies =
  !usedFallback && !allStepsAreDemos && goalTokens.size > 0; // :885-886 ← cambiar goalTokens.size → llmGoalTokens.size

let relevantSteps = steps;
if (llmFilterApplies) {
  relevantSteps = steps.filter((s) => {
    const agent = discovered.agents.find(
      (a) => a.slug === s.agent && a.registry === s.registry,
    );
    if (!agent) return true; // no resuelto ⇒ CONSERVAR
    const corpus = `${agent.name} ${agent.description} ${agent.capabilities.join(' ')} ${JSON.stringify(s.input)}`;
    return textOverlapsGoal(corpus, goalTokens);           // :896 ← cambiar goalTokens → llmGoalTokens (corpus INTACTO)
  });
}
// :899-901 comentario CD-15
const applyDrop =
  llmFilterApplies &&
  relevantSteps.length > 0 &&
  relevantSteps.length < steps.length;                     // :902-905  ← NO TOCAR (terminal-guard va ANTES de esto)
const llmDropped = applyDrop ? steps.length - relevantSteps.length : 0; // :906
```
**Patrón clave**:
- `goalTokens` es una `Set<string>` compartida por el greedy y el reasoning `no_relevant_agent`. **NO la mutes.**
- `relevantSteps` es `let`, viene de `steps.filter(...)` → contiene **referencias del MISMO array `steps`**
  → `.includes(step)` / `=== terminal` funcionan por identidad de objeto (determinístico).
- El recompute de billing en `:987-995` (`if (applyDrop) { steps = relevantSteps.map(...); ... }`) **se REUSA
  tal cual** — el terminal-guard solo cambia QUÉ steps quedan en `relevantSteps` ANTES de ese bloque.

### Exemplar 2: recompute de billing (a REUSAR, NO tocar)
**Archivo**: `src/services/orchestrate.ts:987-995` (verificado en HEAD)
```ts
if (applyDrop) {
  steps = relevantSteps.map((s, i) => ({ ...s, passOutput: i > 0 }));
  const step0 = steps[0];                       // CD-8: ComposeStep | undefined
  const step0Price = step0
    ? await resolveAgentPriceUsdc(step0.agent, step0.registry)
    : null;
  plannedCostUsd = step0Price ?? 0;
  reasoning += ` (${llmDropped} off-topic agent(s) dropped by relevance backstop)`;
}
```
**Usar para**: NADA que editar. Es el mecanismo que reindexará `passOutput` y repriceará step-0 por
construcción cuando el terminal-guard reduzca el drop. **Cero cirugía de billing.** Nótese el patrón CD-8
(`step0` en const + chequeo antes de usar) — replicar ese patrón en el terminal-guard.

### Exemplar 3: fixtures + shape de test WKH-152
**Archivo**: `src/services/orchestrate.test.ts:2080-2160` (verificado en HEAD)
**Usar para**: Archivo #2 (tests T-163-*)
**Patrón clave**:
- `wkh152Agents: Agent[]` = clon de `{...mockAgents[0]!, ...overrides}` con `id/name/slug/description/
  capabilities/priceUsdc/registry/verified`.
- `wkh152Discovery: DiscoveryResult = { agents, total, registries: ['wasiai'] }`.
- `wkh152GetAgent()` mockea `discoveryService.getAgent` consistente con el discover set (necesario para el
  recompute step-0).
- Helpers en scope: `setLlmResponse(JSON.stringify({ selectedAgents: [...], reasoning }))`, `masterKeyRow()`,
  `vi.mocked(discoveryService.discover/.getAgent)`, `vi.mocked(budgetService.debit)`,
  `vi.mocked(composeService.compose)`, `vi.mocked(chargeProtocolFee)`.
- Assert de plan conservado: `composeCall.steps.map((s) => s.agent)` `.toContain(...)` / `.toEqual([...])`;
  `result.reasoning` `.not.toContain('dropped')` / `.not.toContain('no_relevant_agent')`;
  `vi.mocked(budgetService.debit).mock.calls[0]![2]` = precio step-0 (toBeCloseTo, 6).
- Import del helper puro: `import { orchestrateService, textOverlapsGoal } from './orchestrate.js';` (`:122`).

## Constraint Directives

### OBLIGATORIO
- **CD-1 (débito == ejecución):** el filtro corre en `planOrchestration` ANTES de `budgetService.debit` /
  `composeService.compose`. Ningún step dropeado llega a ninguno de los dos (AC-7). No mover el filtro.
- **CD-5 (determinismo):** `/^\d+$/.test()` y el terminal-guard son puros en memoria, sin LLM/red (AC-8).
- **CD-6 (reconciliación):** los tests T-152-1/2/2b/3/4/5/5b/6/7/8 quedan **verdes SIN editarlos**
  (ver "Reconciliación T-152-*"). Si alguno rompe → PARÁ y escalá; NO lo edites para que pase.
- **CD-8 (Auto-Blindaje WKH-114, `noUncheckedIndexedAccess`):** `steps[steps.length-1]` y `steps[0]`
  devuelven `ComposeStep | undefined`. En el terminal-guard, guardá el terminal en una const y chequeá
  `!== undefined` antes de usarlo. **NUNCA** `steps[len-1]!` ni `steps[0]!`. `tsc` lo exige.
- **CD-9 (Auto-Blindaje WKH-152/159 RECURRENTE — biome inline multilínea):** todo request/objeto literal
  nuevo en los tests va **MULTILÍNEA** (una prop por línea, coma trailing). Antes del gate correr
  `./node_modules/.bin/biome check --write src/` (NO `npx biome` — se rompe bajo el hook RTK).
- **CD-10 (Auto-Blindaje WKH-152 RECURRENTE — never-empty-plan):** NUNCA vaciar un plan LLM por señal léxica
  ausente; dropear SOLO con evidencia POSITIVA (≥1 match en el mismo plan). El fix mantiene CD-15 de WKH-152
  intacta; el terminal-guard solo REDUCE drops, jamás vacía.
- **CD-11:** MANTENER `JSON.stringify(s.input)` en el corpus per-step (`:896`). NO removerlo (sería la
  variante (a), descartada) — preserva DT-1 de WKH-152 y T-152-5.

### PROHIBIDO
- **CD-2:** NO reintroducir el false-negative multilingüe (WKH-159): all-disjoint ⇒ conservar todos, sin
  `no_relevant_agent` (AC-3, AC-5).
- **CD-3:** NO permitir que el backstop LLM produzca `steps:[]` ni dispare `no_relevant_agent` bajo ninguna
  circunstancia del path LLM (invariante MIXED-PLAN-ONLY).
- **CD-4:** NO desactivar el drop del caso mixto GENUINO de WKH-152 (T-152-1). El terminal-guard SOLO rescata
  con `llmDropped ≥ 2`; T-152-1 tiene `llmDropped=1` → sigue dropeando.
- **CD-7:** NO tocar el prompt del planner LLM (`systemPrompt`/`userPrompt`) ni el contrato
  `LlmPlanAgent`/`selectedAgents`.
- **CD-12:** NO tocar `tokenizeForRelevance` (`:356-363`), `textOverlapsGoal` (`:372-381`), `goalTokens`
  (`:851`), `fallbackNoRelevance` (`:852-867`), ni la condición `if (allStepsAreDemos || fallbackNoRelevance)`
  (`:908`). Cambios acotados a `llmGoalTokens` + gate + filtro + terminal-guard.
- NO agregar dependencias nuevas (ninguna).
- NO modificar archivos fuera de la tabla (`discovery.ts`, routes, embeddings, fee/split → Scope OUT).
- NO "mejorar" código adyacente ni refactorizar.

## Snippets exactos (copy-paste-ready — guía, adaptar al estado real del archivo)

> Los números de línea son del HEAD verificado. Si el archivo se movió, ubicá el bloque por su contenido,
> no por el número. Los comentarios `// WKH-163` son parte del entregable.

### Snippet A — `llmGoalTokens` (insertar JUSTO DESPUÉS de `const goalTokens = ...` en `:851`)
```ts
// WKH-163: tokens de relevancia para el backstop LLM SIN los puramente numéricos.
// Un monto (p.ej. "400") es señal de relevancia casi universal en agentes financieros
// y su echo en el input tailoreado dropeaba injustamente la pata de entrega
// (agentshop-cashout-matcher) del plan insignia de remesas. goalTokens (greedy +
// reasoning no_relevant_agent) queda INTACTO; el cambio se aísla al path LLM.
const llmGoalTokens = new Set(
  [...goalTokens].filter((t) => !/^\d+$/.test(t)),
);
```
Definición de "puramente numérico" (ya post-`tokenizeForRelevance`, lowercased, ≥3 chars):
`"$400"`→`"400"`→excluido; `"4,000"`→`"4"`(cae <3),`"000"`→excluido; `"usd400"`/`"400usd"`→**conservado**
(alfanumérico mixto = señal válida).

### Snippet B — gate `llmFilterApplies` (`:885-886`)
```ts
const llmFilterApplies =
  !usedFallback && !allStepsAreDemos && llmGoalTokens.size > 0; // WKH-163: llmGoalTokens (era goalTokens)
```

### Snippet C — filtro per-step (`:896`, dentro del `steps.filter`)
```ts
const corpus = `${agent.name} ${agent.description} ${agent.capabilities.join(' ')} ${JSON.stringify(s.input)}`;
return textOverlapsGoal(corpus, llmGoalTokens); // WKH-163: llmGoalTokens (era goalTokens); corpus INTACTO (CD-11)
```

### Snippet D — terminal delivery guard (insertar ENTRE el `}` del `if (llmFilterApplies)` en `:898` y el `const applyDrop` en `:902`)
```ts
// WKH-163 (terminal delivery guard, defense-in-depth): si el backstop dropearía el
// step TERMINAL (la pata de entrega) Y ≥2 steps quedan disjuntos (señal de desajuste
// de vocabulario multi-leg, no de un único add-on spurious), se RESCATA el terminal.
// Con UN solo disjunto (T-152-1) NO se protege → el drop del mixto genuino queda intacto (CD-4).
if (
  llmFilterApplies &&
  relevantSteps.length > 0 &&
  relevantSteps.length < steps.length
) {
  const droppedCount = steps.length - relevantSteps.length;
  const terminal = steps[steps.length - 1]; // CD-8: ComposeStep | undefined
  const terminalDropped =
    terminal !== undefined && !relevantSteps.includes(terminal);
  if (droppedCount >= 2 && terminalDropped) {
    // Re-incluir el terminal preservando el orden original (los demás disjuntos
    // siguen dropeados). relevantSteps referencia objetos del MISMO array steps.
    relevantSteps = steps.filter(
      (s) => relevantSteps.includes(s) || s === terminal,
    );
  }
}
```
Nota: `applyDrop` / `llmDropped` (`:902-906`) se computan **DESPUÉS**, sin cambios — el rescate solo redujo
el drop. El bloque `if (applyDrop)` (`:987-995`) reindexa `passOutput` y repricea step-0 por construcción.

## Test Expectations

> Requests inline **MULTILÍNEA** (CD-9). Reusar helpers del Exemplar 3. NO editar tests existentes.

| Test | ACs que cubre | Framework | Tipo |
|------|--------------|-----------|------|
| T-163-1 (badge EN) | AC-1, AC-7 | vitest | unit |
| T-163-2 (badge ES) | AC-2 | vitest | unit |
| T-163-3 (goal numérico-only ⇒ skip) | AC-1, CD-14 refinado | vitest | unit |
| T-163-4 (terminal delivery guard) | terminal-guard / defense-in-depth | vitest | unit |

### T-163-1 (badge EN) — AC-1
- **Fixture:** 3 agentes de remesa reales (non-demo, `verified:false`), name/desc/caps **en inglés SIN**
  `send`/`mom`/`peru`: `agentshop-kyc-validator`, `agentshop-corridor-discoverer`, `agentshop-cashout-matcher`
  (slugs/registry consistentes con `discover` + `getAgent`).
- **Plan LLM (`setLlmResponse`)** selecciona los 3 con inputs tailoreados:
  kyc `{ amountUSD: 400 }`, corridor `{ amountUSD: 400, receiverCountry: 'PE' }`,
  cashout `{ receiverCountry: 'PE', preference: 'bank deposit' }`.
- **Goal:** `'Send $400 to my mom in Peru'`.
- **Assertions:** `composeCall.steps.map(s=>s.agent)` contiene los 3 slugs (incl. `agentshop-cashout-matcher`);
  `result.reasoning` `.not.toContain('dropped')` y `.not.toContain('no_relevant_agent')`;
  `budgetService.debit` llamado 1 vez con el precio del step-0 original (toBeCloseTo, 6). **Sin Snippet A/B/C
  este test dropearía cashout.**

### T-163-2 (badge ES) — AC-2
- Misma fixture que T-163-1. **Goal:** `'Enviar 400 dolares a mi mama en Peru'`.
- **Assertions:** idéntico a T-163-1 — 3 steps intactos, sin `dropped`/`no_relevant_agent`. Prueba
  independencia de idioma (`llmGoalTokens = {enviar, dolares, mama, peru}` vs agentes en inglés → all-disjoint).

### T-163-3 (goal numérico-only ⇒ skip) — AC-1 / CD-14 refinado
- Cualquier fixture de agentes reales + plan LLM válido. **Goal:** `'400 500 600'` (solo tokens numéricos ≥3).
- **Assertions:** `llmGoalTokens` vacío ⇒ filtro skip ⇒ TODOS los steps conservados; `planStatus:'ready'`;
  `result.reasoning` `.not.toContain('dropped')`.

### T-163-4 (terminal delivery guard) — Snippet D
- **Fixture:** 3 agentes reales: A comparte 1 token **NO numérico** con el goal (match); B y C disjuntos;
  C = terminal (último del plan, la pata de entrega). Plan LLM selecciona `[A, B, C]`.
- **Setup:** con `llmGoalTokens`, `relevantSteps` base = `[A]` → `llmDropped` base = 2; terminal C dropeado.
- **Assertions:** C (terminal) se **RESCATA**: `composeCall.steps.map(s=>s.agent)` `.toEqual(['A-slug','C-slug'])`
  (B dropeado); `result.reasoning` contiene `dropped` con count `1`; `budgetService.debit` = precio de A
  (head, `passOutput:false`). Verifica que la pata de entrega sobrevive un echo NO numérico multi-leg.

### Criterio Test-First
Lógica de negocio money-path → **Test-first SÍ**. Escribí T-163-1..4, corré (rojo esperado pre-fix), luego
aplicá Snippets A-D, corré (verde).

## Waves

### Wave -1: Environment Gate (verificar ANTES de tocar código)
```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a
git checkout main && git pull
git checkout -b fix/164-wkh-163-cashout-matcher-relevance-fix
npm install 2>/dev/null || echo "revisar package.json"
ls src/services/orchestrate.ts src/services/orchestrate.test.ts src/services/agent-price.ts
# Baseline de regresión (CD-6): DEBE estar VERDE antes de tocar nada
npm test -- src/services/orchestrate.test.ts
```
**Si algo falla en Wave -1:** PARAR y reportar al orquestador. No implementar sobre baseline rojo.
Confirmá que el comentario WKH-159 vive en `:914-929` (WKH-158/159 mergeados) y que `:851-906` matchea
el Exemplar 1.

### Wave 0 — Fix de código (SERIAL, orden estricto)
- [ ] **W0.1** Insertar Snippet A (`llmGoalTokens`) justo después de `:851`. NO tocar `goalTokens`.
- [ ] **W0.2** Aplicar Snippet B: gate `llmFilterApplies` usa `llmGoalTokens.size` (`:885-886`). NO cambiar el
      `goalTokens.size` del reasoning `no_relevant_agent` (`:932`) ni el de `fallbackNoRelevance`.
- [ ] **W0.3** Aplicar Snippet C: filtro per-step usa `llmGoalTokens` (`:896`). MANTENER corpus con
      `JSON.stringify(s.input)` (CD-11).
- [ ] **W0.4** Insertar Snippet D (terminal delivery guard) entre `:898` y `:902`. Respetar CD-8 (const +
      `!== undefined`).
- [ ] **W0.5** `npx tsc --noEmit` (0 errores) + `./node_modules/.bin/biome check --write src/services/orchestrate.ts`.

### Wave (tests) — Test matrix (depende de W0)
- [ ] **Wt.1** Agregar T-163-1 (badge EN, AC-1).
- [ ] **Wt.2** Agregar T-163-2 (badge ES, AC-2).
- [ ] **Wt.3** Agregar T-163-3 (goal numérico-only ⇒ skip).
- [ ] **Wt.4** Agregar T-163-4 (terminal delivery guard).
- [ ] **Wt.5** `./node_modules/.bin/biome check --write src/services/orchestrate.test.ts` (CD-9 multilínea).
- [ ] **Wt.6** Correr suite completa del área + baseline (ver "Gate de cierre").

### Verificación Incremental
| Wave | Verificación al completar |
|------|--------------------------|
| W-1  | baseline `orchestrate.test.ts` VERDE |
| W0   | `tsc --noEmit` 0 + biome limpio |
| Wt   | `tsc` + `npm test` (baseline + T-163-1..4) VERDE |

## Reconciliación T-152-* (CD-6) — cada uno sigue VERDE, NO se edita

| Test | Por qué sigue verde |
|------|---------------------|
| **T-152-1** (`:2119`) mixto→dropea | Goal `"What is the weather forecast today"` sin numéricos ⇒ `llmGoalTokens == goalTokens`; weather matchea, defi disjunto ⇒ `relevantSteps=[weather]`, `llmDropped=1`. Terminal defi dropeado pero `llmDropped=1 < 2` ⇒ guard NO protege ⇒ defi se dropea. **CD-4 intacto.** |
| **T-152-2** (`:2168`) all-disjoint→conserva | Goal `"translate this document into french"` sin numéricos; ambos disjuntos ⇒ `relevantSteps.length=0` ⇒ `applyDrop=false` ⇒ guard inerte. Conserva 2, billing byte-idéntico. |
| **T-152-2b** (`:2228`) multilingüe→conserva | ES vs agentes EN, sin numéricos ⇒ all-disjoint ⇒ inerte. False-negative multilingüe sigue lockeado (CD-2). |
| **T-152-3** (`:2311`) all-relevant→no drop | Sin numéricos; ambos matchean ⇒ `relevantSteps.length==steps.length` ⇒ `applyDrop=false` ⇒ guard inerte. Cero regresión. |
| **T-152-4** (`:2337`) step-0 dropeado→reprice | `[defi(disjunto,head), weather(match,terminal)]`; `relevantSteps=[weather]`, dropea defi (head). Terminal=weather MATCHEA ⇒ `terminalDropped=false` ⇒ guard inerte; `llmDropped=1`. weather pasa a head `passOutput:false`, debit repriced 0.4. |
| **T-152-5** (`:2383`) input-widening | Señal viene de tokens NO numéricos (`weather`/`lima`) en el corpus ⇒ sigue matcheando; `llmGoalTokens` NO los excluye. DT-1 de WKH-152 preservado (CD-11 — por esto se eligió la variante (b)). |
| **T-152-5b** (`:2438`) goal sin tokens | `"a b c"` todos <3 chars ⇒ `goalTokens` vacío ⇒ `llmGoalTokens` vacío ⇒ skip ⇒ inerte. Conserva el step. |
| **T-152-6** (`:2471`) all-demo | `allStepsAreDemos` ⇒ `llmFilterApplies=false` (gate previo) ⇒ filtro no corre ⇒ inerte. `no_relevant_agent` sin cambios (CD-4/AC-6). |
| **T-152-7** (=T-W5/5b/5c/6, `:1877-1979`) greedy | Greedy usa `goalTokens` (NO tocada) ⇒ byte-idéntico. Guard solo corre en path LLM (`usedFallback===false`) ⇒ inerte en greedy. (`"asdfqwerty12345"` es alfanumérico mixto, NO puramente numérico ⇒ no lo toca `llmGoalTokens`.) |
| **T-152-8** (`:2519`) helper puro | `tokenizeForRelevance`/`textOverlapsGoal` sin tocar ⇒ semántica intacta. |

**~35 tests money-path preexistentes:** verdes por el mismo mecanismo — `llmGoalTokens` solo REDUCE matches
(nunca convierte all-disjoint en mixto → no introduce drops nuevos); el guard solo REDUCE drops (no rompe un
test que hoy no dropea).

## Gate de cierre de F3 (correr TODO, con números reales)

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a
npx tsc --noEmit                                   # DEBE: 0 errores
./node_modules/.bin/biome check --write src/       # DEBE: sin diagnostics pendientes (NO npx biome)
npm test -- src/services/orchestrate.test.ts       # DEBE: baseline T-152-*/WKH-158/159 verde + T-163-1..4 verde
npm test                                            # DEBE: suite full verde (0 fallos)
```
Registrá los **números reales** en el reporte de F3: total tests corridos, pasados, y confirmación explícita
de que los 4 nuevos (T-163-1..4) pasan y que ningún T-152-* se editó.

## Definition of Done (la HU está lista cuando)

- [ ] Los 8 ACs (AC-1..AC-8) satisfechos y verificables por QA con archivo:línea.
- [ ] Snippets A-D aplicados en `src/services/orchestrate.ts`; `goalTokens`/`tokenizeForRelevance`/
      `textOverlapsGoal`/`fallbackNoRelevance` NO tocados (CD-12).
- [ ] T-163-1..4 agregados y verdes; T-152-1..8 verdes sin edición (CD-6).
- [ ] `npx tsc --noEmit` 0 errores + biome limpio + `npm test` full verde con números reales.
- [ ] Débito == ejecución airtight (CD-1/AC-7); CD-15 never-empty preservada (CD-3/AC-5); drop del mixto
      genuino intacto (CD-4/AC-6); determinismo (CD-5/AC-8).

## Out of Scope
- `src/services/discovery.ts`, broaden-retry WKH-151.
- Relevancia semántica por embeddings (WKH-160) — fix de fondo, fuera de esta HU.
- Prompt del planner LLM (`systemPrompt`/`userPrompt`), contrato `LlmPlanAgent`/`selectedAgents`.
- fee/split (`protocolFeeUsdc`, splits creator/referral) — WKH-132/143.
- Greedy `fallbackNoRelevance` / `allStepsAreDemos` — WKH-152/159.
- NO "mejorar" código adyacente. NO refactors no solicitados.

## Escalation Rule
> **Si algo no está en este Story File, Dev PARA y escala a Architect.** No inventar, no asumir, no improvisar.

Situaciones de escalation:
- El bloque `:851-906` no matchea el Exemplar 1 (WKH-158/159/160 movieron el código o cambiaron la lógica del backstop).
- El baseline de Wave -1 arranca ROJO.
- Un T-152-* rompe tras el fix (NO editarlo para pasar — escalá).
- `tsc` exige un `!` (non-null assertion) en el terminal-guard (violaría CD-8 — resolvé con const + guard, o escalá).

---

*Story File generado por NexusAgil — F2.5 · WKH-163 · money-path insignia (QUALITY)*
