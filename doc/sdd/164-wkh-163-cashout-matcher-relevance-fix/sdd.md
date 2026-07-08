# SDD — [WKH-163] La remesa insignia se trunca por el backstop léxico de WKH-152 (dropea `cashout-matcher`)

> Fase F2 (QUALITY, money-path insignia). Input: `work-item.md` (este directorio) + `project-context.md` + F0 en código + SDD de WKH-152 (`doc/sdd/160-wkh-152-.../sdd.md`).
> El Architect NO escribe código de producción. Este SDD es el contrato para el Dev (F2.5 → F3).
> Resuelve los 2 `[NEEDS CLARIFICATION]` del work-item (mecanismo exacto de Opción 1 + alcance de Opción 2).

---

## 0. Resumen ejecutivo

El backstop léxico per-step de WKH-152 (`orchestrate.ts:885-906`) dropea `agentshop-cashout-matcher`
—la pata que ENTREGA el dinero— del plan insignia de Chaski `"Send $400 to my mom in Peru"`. El
mecanismo confirmado: `goalTokens = tokenizeForRelevance(goal)` incluye el token **puramente
numérico `"400"`** (≥3 chars). El corpus per-step incluye `JSON.stringify(s.input)` (`:895`), y el
`input` tailoreado del LLM para `kyc-validator`/`corridor-discoverer` hace **echo del `amountUSD:400`**
→ comparten el token `"400"` con el goal → SOBREVIVEN. `cashout-matcher` (input `{receiverCountry,
preference}`, sin números que matcheen) NO comparte token → el plan queda **mixto** (2 relevantes / 1
disjunto) → `applyDrop=true` (`:902-906`) → `cashout-matcher` se dropea ANTES de `debit`/`compose`. El
único factor que decide el resultado es si el monto tiene ≥3 dígitos, no la relevancia real del step
(confirmado por los ejemplos del brief: `"$50"` → all-disjoint → conserva 3; `"$400"` → mixto →
dropea).

**Fix ratificado (1+2, money-safe):**

- **Opción 1 (causa raíz) — exclusión de tokens PURAMENTE NUMÉRICOS del set de relevancia del path
  LLM (variante quirúrgica (b) del work-item).** Se construye `llmGoalTokens = goalTokens \
  {t : /^\d+$/.test(t)}` y el filtro per-step usa `llmGoalTokens` en vez de `goalTokens`. Efecto sobre
  el goal insignia: `"400"` deja de ser token de relevancia → `kyc`/`corridor` YA NO sobreviven por el
  echo numérico → el plan pasa a **all-disjoint** (`relevantSteps.length === 0`) → **CD-15 conserva los
  3** (no-op). Se **mantiene `JSON.stringify(s.input)` en el corpus** → el input-widening de DT-1 de
  WKH-152 sobrevive → **T-152-5 sigue verde** (su relevancia viene de tokens NO numéricos). Blast
  radius mínimo: `tokenizeForRelevance` y el `goalTokens` del greedy quedan **intactos** → greedy
  (T-152-7 / T-W5/5b/5c/6) y el helper (T-152-8) byte-idénticos.

- **Opción 2 (2ª línea de defensa estructural) — "terminal delivery guard" en forma ACOTADA
  compatible con T-152-1.** El backstop NO dropea el step **terminal** del plan LLM **si-y-solo-si**
  ese terminal sería dropeado Y hay **≥2 steps disjuntos** en total (i.e. `llmDropped ≥ 2`). Decisión
  del `[NEEDS CLARIFICATION #2]`: **NO** protección incondicional (rompe T-152-1 y viola CD-4), **NO**
  "≥1 match previo" a secas (también rompe T-152-1). La condición `llmDropped ≥ 2` es exactamente lo
  que preserva T-152-1 (que tiene UN solo step disjunto = terminal spurious) mientras rescata la pata
  de entrega cuando el plan sufre un desajuste de vocabulario en varios legs. El requisito "≥1 match"
  anti-gaming queda **implicado** por `applyDrop` (que exige `relevantSteps.length > 0`).

**Opción 1 SOLA ya satisface los 8 ACs** (el plan insignia se conserva porque queda all-disjunto).
**Opción 2 es defense-in-depth** contra echos léxicos NO numéricos que reactiven el drop de un terminal
legítimo (el residual documentado en WKH-152 `sdd.md:409-417`); es inerte para TODOS los tests
existentes. Se recomienda 1+2; si el AR juzga Opción 2 demasiado "clever", puede diferirse SIN bloquear
el fix de causa raíz (ver DT-2 y §7).

---

## 1. Context Map (archivos leídos + patrón extraído)

| Archivo:línea (HEAD actual) | Por qué se leyó | Qué se extrajo |
|---|---|---|
| `src/services/orchestrate.ts:356-363` | Tokenizador reusado | `tokenizeForRelevance(text): Set<string>` — lowercase, split `/[^a-z0-9]+/`, descarta tokens `<3` chars. **NO se toca** (blast-radius, DT-3). |
| `orchestrate.ts:372-381` | Predicado overlap reusado | `textOverlapsGoal(text, goalTokens): boolean` — `true` si comparte ≥1 token; `goalTokens` vacío ⇒ `false`. Exportado (usado por el test). **NO se toca su firma.** |
| `orchestrate.ts:851` | Construcción de `goalTokens` | `const goalTokens = tokenizeForRelevance(goal);` — **var COMPARTIDA** por greedy (`fallbackNoRelevance` :854/:863) y por el filtro LLM (:896) y por el reasoning de no_relevant_agent (:932). **Se mantiene intacta**; el fix agrega un `llmGoalTokens` derivado (Opción 1). |
| `orchestrate.ts:852-867` | `fallbackNoRelevance` (greedy) | Gateado por `usedFallback`; corpus `name+description+capabilities`; usa `goalTokens`. **NO se toca** → T-152-7/T-W* byte-idénticos (CD-6). |
| `orchestrate.ts:885-886` | Gate del filtro LLM | `llmFilterApplies = !usedFallback && !allStepsAreDemos && goalTokens.size > 0`. **Opción 1 cambia `goalTokens.size` → `llmGoalTokens.size`** (semántica: sin señal léxica NO numérica ⇒ skip). |
| `orchestrate.ts:888-897` | El filtro per-step | `relevantSteps = steps.filter(s => textOverlapsGoal(corpus, goalTokens))`, `corpus = name+desc+caps+JSON.stringify(s.input)`. **Opción 1 cambia `goalTokens` → `llmGoalTokens`.** El corpus (con `input`) se **mantiene** (preserva T-152-5). |
| `orchestrate.ts:902-906` | Regla del drop (CD-15) | `applyDrop = llmFilterApplies && relevantSteps.length > 0 && relevantSteps.length < steps.length`; `llmDropped = applyDrop ? steps.length - relevantSteps.length : 0`. **Opción 2 inserta el terminal-guard ANTES de `applyDrop` re-ajustando `relevantSteps`.** |
| `orchestrate.ts:908-976` | early-return `no_relevant_agent` | `if (allStepsAreDemos || fallbackNoRelevance)` — EXCLUSIVO de all-demos/greedy. El filtro LLM **NUNCA** lo dispara (CD-15). **NO se toca su condición** (CD-3/CD-15). |
| `orchestrate.ts:987-995` | Recompute billing (caso mixto) | `if (applyDrop) { steps = relevantSteps.map((s,i)=>({...s, passOutput:i>0})); step0 recompute vía resolveAgentPriceUsdc; reasoning += ' (N off-topic agent(s) dropped...)' }`. **Se REUSA sin reescribir** (WKH-152 AC-4 / WKH-127/132). Opción 2 solo cambia QUÉ steps quedan en `relevantSteps` antes de este bloque. |
| `orchestrate.ts:1011-1016` | Billing 1..N | `costPerStep`/`totalCostUsdc` se derivan del array `steps` → recalculo por construcción al reasignar `steps` en :988. **No se toca.** |
| `src/services/agent-price.ts` (`resolveAgentPriceUsdc`) | Resolver registry-aware | Ya usado por el recompute step-0 (:991). Sin cambios. |
| `src/services/orchestrate.test.ts:122` | Import del helper | `import { orchestrateService, textOverlapsGoal } from './orchestrate.js';` — el test consume el helper exportado. |
| `orchestrate.test.ts:2080-2115` | Fixtures WKH-152 | `wkh152Agents` (`weather-v1` @0.4 verified:false, `defi-sentiment-v1` @0.7), `wkh152Discovery`, `wkh152GetAgent()`. Plantilla exacta para las fixtures nuevas AC-1/AC-2. |
| `orchestrate.test.ts:2117-2527` | Tests T-152-* | T-152-1..8 — reconciliados uno a uno en §6. |
| `orchestrate.test.ts:1877-1979` | Tests greedy T-W5/5b/5c/6 | = T-152-7 (guardrail del greedy). Byte-idénticos (no se toca greedy). |
| Auto-Blindaje WKH-152/159/114 | Errores recurrentes previos | Ver **CD-9..CD-12**. |

---

## 2. Decisiones técnicas (DT-N) — resolución de los 2 [NEEDS CLARIFICATION]

### DT-1 — [NEEDS CLARIFICATION #1] RESUELTO: Opción 1 = variante quirúrgica (b), exclusión de tokens PURAMENTE NUMÉRICOS, GOAL-SIDE, LLM-filter-scoped

**Decisión:** se implementa la **variante (b)** del work-item (exclusión de tokens puramente numéricos),
**NO** la variante (a) (remoción total de `JSON.stringify(input)` del corpus). Justificación:

- La variante (a) revierte DT-1 de WKH-152 (input-widening deliberado, false-negative-safe) y **rompe
  T-152-5 por diseño** (agente relevante distinguible SOLO por su input tailoreado). Requeriría
  reformular/eliminar T-152-5 con ratificación. **Blast radius innecesariamente grande.**
- La variante (b) ataca la señal exacta que causa el bug (el echo del monto `400`) sin renunciar al
  resto del input-widening. Un monto (`amountUSD`) es un campo casi universal en agentes financieros y
  es una señal de relevancia **mucho más débil** que una palabra compartida — excluirlo es
  semánticamente correcto y **no toca T-152-5** (cuya señal es el token NO numérico `"weather"`/`"lima"`).

**Mecanismo exacto (lo que el Dev implementa):**

1. **Definición de "puramente numérico".** Sobre un token YA tokenizado (`tokenizeForRelevance` ya
   dividió por `/[^a-z0-9]+/`, lowercased, longitud ≥3), un token es puramente numérico si-y-solo-si
   `/^\d+$/.test(token)`. El tokenizador ya elimina `$`, comas y puntos decimales como separadores, así
   que:
   - `"$400"` → `"400"` → puramente numérico → **excluido**.
   - `"4,000"` → `"4"`,`"000"` → `"4"` cae por `<3` chars; `"000"` (3 chars) → puramente numérico → excluido.
   - `"3.14"` → `"3"`,`"14"` → ambos `<3` chars → ya caían.
   - `"usd400"` / `"400usd"` → alfanumérico mixto → **NO** puramente numérico → **se conserva** (sigue
     siendo señal léxica válida).

2. **Lado del filtrado: GOAL-SIDE, scoped al path LLM.** Se construye una variable NUEVA, local, junto
   a `goalTokens` (:851):
   ```ts
   // WKH-163: tokens de relevancia para el backstop LLM SIN los puramente numéricos.
   // Un monto (p.ej. "400") es señal de relevancia casi universal en agentes financieros
   // y su echo en el input tailoreado dropeaba injustamente la pata de entrega (cashout-matcher).
   const llmGoalTokens = new Set(
     [...goalTokens].filter((t) => !/^\d+$/.test(t)),
   );
   ```
   - **Por qué goal-side y NO step-side:** el filtro matchea por intersección `corpus ∩ goalTokens`.
     Un token numérico en el corpus SOLO puede matchear un token numérico del goal. Si el goal ya no
     aporta tokens numéricos, filtrar el corpus sería **redundante** (sin efecto observable). Goal-side
     es el punto único, más simple y suficiente.
   - **Por qué NO tocar `goalTokens` in-place (ni `tokenizeForRelevance`):** `goalTokens` la comparten
     `fallbackNoRelevance` (greedy) y el reasoning de `no_relevant_agent`. Excluir numéricos globalmente
     arrastraría cambio de comportamiento al greedy (fuera de scope, riesgo de regresión en T-W*).
     `llmGoalTokens` **aísla** el cambio al backstop LLM.

3. **Gate y filtro pasan a usar `llmGoalTokens`:**
   - `llmFilterApplies = !usedFallback && !allStepsAreDemos && llmGoalTokens.size > 0` (:885-886).
     Semántica CD-14 preservada y REFINADA: un goal cuyo único token evaluable es numérico
     (p.ej. `"400 500"`) ⇒ `llmGoalTokens` vacío ⇒ skip filtro ⇒ conservar todos (no hay señal léxica
     NO numérica para juzgar). (Aun sin este refinamiento, `relevantSteps.length===0` ⇒ CD-15 conserva
     todos; el cambio hace la intención explícita.)
   - El filtro (:896): `return textOverlapsGoal(corpus, llmGoalTokens);` — **el `corpus` con
     `JSON.stringify(s.input)` se mantiene** (DT-1 de WKH-152 vive).

**Efecto sobre el goal insignia (traza):** `goalTokens = {send, 400, mom, peru}` → `llmGoalTokens =
{send, mom, peru}`. `kyc`/`corridor` (input `{amountUSD:400,...}`, name/desc/caps sin `send`/`mom`/`peru`)
→ 0 overlap con `llmGoalTokens`. `cashout-matcher` → 0 overlap. **`relevantSteps.length === 0` →
`applyDrop=false` → CD-15 conserva los 3.** AC-1 satisfecho. Variante ES `"Enviar 400 dolares a mi mama
en Peru"`: `llmGoalTokens = {enviar, dolares, mama, peru}`, agentes en inglés → all-disjoint →
conserva 3. AC-2 satisfecho.

### DT-2 — [NEEDS CLARIFICATION #2] RESUELTO: Opción 2 = "terminal delivery guard" ACOTADO a `llmDropped ≥ 2` (compatible con T-152-1)

**El conflicto irreducible.** La protección del terminal es **lexicamente indistinguible** entre "pata
de entrega legítima disjunta por vocabulario" (cashout-matcher) y "agente genuinamente off-topic en
posición terminal" (defi-sentiment-v1 en **T-152-1**). CD-4/CD-6/AC-6 exigen que T-152-1 **siga
dropeando** su terminal. Por lo tanto:

- **Protección INCONDICIONAL del terminal ⇒ ROMPE T-152-1** (defi terminal se conservaría) y viola CD-4.
- **Protección "terminal Y ≥1 match previo" (literal del work-item) ⇒ TAMBIÉN ROMPE T-152-1**: T-152-1
  tiene un match previo (weather-v1) → protegería defi terminal. Descartada.

**Decisión (resolución del clarification):** el terminal se rescata del drop **si-y-solo-si**:
```
llmFilterApplies && relevantSteps.length > 0 && relevantSteps.length < steps.length   // = habría drop (applyDrop base)
&& terminalStep ∈ droppedSet                                                            // el terminal sería dropeado
&& (steps.length - relevantSteps.length) >= 2                                           // ≥2 steps disjuntos (llmDropped base ≥ 2)
```
Cuando la condición se cumple, se **re-incluye el terminal** en `relevantSteps` preservando el orden
original (los demás disjuntos siguen dropeados), y recién entonces se computa `applyDrop`/`llmDropped`.

- **Por qué `llmDropped ≥ 2` es la línea correcta:**
  - **T-152-1** tiene UN solo step disjunto (defi = terminal) → `llmDropped` base `=1` → **NO se
    protege** → defi se dropea → **T-152-1 verde, CD-4 intacto.** Cuando el terminal es el ÚNICO
    off-topic, es un add-on spurious limpio → se dropea (comportamiento WKH-152).
  - El **residual no numérico** que Opción 2 cubre requiere ≥2 disjuntos (terminal-entrega + ≥1 leg
    intermedio disjunto), señal de **desajuste de vocabulario multi-leg** (no de un único spurious) →
    se protege la pata de entrega. Ejemplo: si un futuro echo NO numérico rescatara `kyc` pero
    `corridor` y `cashout-matcher` quedaran disjuntos, `llmDropped=2`, terminal `cashout-matcher`
    dropeado → **se rescata** (sobreviven `kyc` + `cashout-matcher`; `corridor` dropeado). La pata de
    entrega —el mayor daño de negocio— se preserva.
- **Anti-gaming ("≥1 match previo"):** queda **implicado** por `applyDrop` base (`relevantSteps.length
  > 0`), que exige ≥1 match en el plan; como el terminal es el último, todo match es "previo". Un
  atacante que quisiera forzar la conservación de un agente irrelevante en posición terminal tendría
  que además **sacrificar ≥1 leg intermedio como disjunto** (para llegar a `llmDropped≥2`) — vector
  débil y de daño acotado (igual paga el/los steps que sí matchean). **Trade-off documentado y
  aceptado.**
- **Byte-identidad con billing (WKH-127/132):** la re-inclusión del terminal solo modifica `relevantSteps`
  ANTES del bloque `if (applyDrop)` (:987-995), que reasigna `steps`, reindexa `passOutput` y recomputa
  `plannedCostUsd`/step-0 **por construcción** (mecanismo ya existente). Cero cirugía de billing.

**Opción 2 es INERTE para todos los tests existentes** (ninguno tiene un terminal dropeado con
`llmDropped≥2`; ver §6). Es defense-in-depth pura. **Si el AR juzga la regla demasiado "clever", puede
diferirse a follow-up SIN bloquear la HU**: Opción 1 sola satisface los 8 ACs (el plan insignia se
conserva por all-disjoint, no por el terminal-guard). Recomendación del Architect: **incluir 1+2**
(money-path insignia, la pata de entrega merece la red estructural), con Opción 2 claramente marcada
como opcional-diferible en el Readiness Check.

### DT-3 — Blast radius mínimo: NO tocar `tokenizeForRelevance`, `goalTokens`, `fallbackNoRelevance`, ni la condición del early-return

El fix vive enteramente en el bloque `:851-906` (más el reuso de `:987-995`), introduciendo `llmGoalTokens`
(local) y el terminal-guard. **Explícitamente NO se modifica:**
- `tokenizeForRelevance` (:356-363) — T-152-8 (helper) y toda tokenización byte-idéntica.
- `textOverlapsGoal` (:372-381) — firma/semántica intactas (el test lo importa y prueba directo).
- `goalTokens` (:851) — greedy `fallbackNoRelevance` (:852-867) y reasoning `no_relevant_agent` (:932)
  byte-idénticos → **T-152-7 / T-W5/5b/5c/6 verdes sin tocar** (CD-6).
- La condición `if (allStepsAreDemos || fallbackNoRelevance)` (:908) — el filtro LLM sigue **sin**
  aportar un tercer disyunto (CD-15/CD-3) → **T-152-6 verde**.

### DT-4 — Reuso del recompute de billing de WKH-152/127/132 (sin reescritura)

El caso mixto (post-Opción-1 y post-Opción-2) sigue pasando por el `if (applyDrop)` existente
(:987-995): reasign `steps`, reindex `passOutput` (`.map((s,i)=>({...s, passOutput:i>0}))`), recompute
`plannedCostUsd = resolveAgentPriceUsdc(steps[0].agent, steps[0].registry) ?? 0` (CD-8 guard sobre
`steps[0] : ComposeStep | undefined`), append reasoning con el drop-count. El billing 1..N
(`costPerStep`/`totalCostUsdc`/`protocolFeeUsdc`) se recalcula por construcción (:1011-1016). **Débito ==
ejecución** se mantiene: el filtro corre en `planOrchestration`, ANTES de `budgetService.debit` y
`composeService.compose` (CD-1/AC-7).

---

## 3. Constraint Directives (CD-N)

**Heredadas del work-item (CD-1..CD-7) — vinculantes:**

- **CD-1:** PROHIBIDO alterar el débito relativo a los steps ejecutados — débito == ejecución sin
  excepción (AC-7). El filtro corre pre-`debit`/pre-`compose`.
- **CD-2:** PROHIBIDO reintroducir el false-negative multilingüe (WKH-159): all-disjunto ⇒ conservar
  todos, sin `no_relevant_agent` (AC-3, AC-5). `goalTokens` del greedy y la condición del early-return
  NO se tocan.
- **CD-3:** PROHIBIDO que el backstop LLM produzca `steps:[]` o dispare el early-return
  `no_relevant_agent` bajo cualquier circunstancia (invariante MIXED-PLAN-ONLY / CD-15 de WKH-152).
- **CD-4:** PROHIBIDO desactivar el drop del caso mixto GENUINO de WKH-152 (un agente real
  efectivamente irrelevante mezclado con relevantes, ej. T-152-1) — debe seguir dropeándose (AC-6). La
  condición `llmDropped ≥ 2` de Opción 2 preserva esto (T-152-1 tiene `llmDropped=1`).
- **CD-5:** OBLIGATORIO 100% determinístico, en memoria, SIN llamadas LLM/red adicionales (AC-8).
  `/^\d+$/.test()` y el terminal-guard son puros en memoria.
- **CD-6:** OBLIGATORIO citar y reconciliar en este SDD los tests que el cambio pudiera romper por
  diseño (T-152-1, T-152-2, T-152-2b, T-152-5, T-152-6, T-152-7). Ver §6: cada uno nombrado con por qué
  sigue probando lo suyo. **Ninguno se reformula ni edita** (la variante (b) fue elegida precisamente
  para no romper T-152-5).
- **CD-7:** PROHIBIDO tocar el prompt del planner LLM (`systemPrompt`/`userPrompt`) ni el contrato
  `LlmPlanAgent`/`selectedAgents`. El fix es puramente post-plan determinístico.

**Agregadas por el SDD (F2):**

- **CD-8 (Auto-Blindaje WKH-114):** `noUncheckedIndexedAccess` activo — `steps[steps.length-1]` y
  `steps[0]` devuelven `ComposeStep | undefined`. Guardar en const + chequear antes de usar como
  no-undefined. NUNCA `steps[0]!` ni `steps[len-1]!`. El terminal-guard debe tolerar `terminal ===
  undefined` (plan vacío no llega acá, pero tsc lo exige).
- **CD-9 (Auto-Blindaje WKH-152/159 — RECURRENTE, ≥2 HUs):** formato biome en objetos literales inline
  de test. WKH-152 (auto-blindaje 10:30/11:12) y WKH-159 (auto-blindaje Wave-1) rompieron ambos el gate
  por líneas inline que exceden el ancho. **Todo request nuevo a `orchestrate`/`planOrchestration` en
  los tests va MULTILÍNEA** (una prop por línea, coma trailing). Correr
  `./node_modules/.bin/biome check --write src/` (NO `npx biome`, se rompe bajo el hook RTK) ANTES del
  gate, no solo `tsc`. Ref: WKH-152 auto-blindaje / WKH-159 auto-blindaje#1.
- **CD-10 (Auto-Blindaje WKH-152 — RECURRENTE money-path):** NUNCA vaciar un plan LLM por señal léxica
  ausente; dropear SOLO con evidencia POSITIVA corroborada (≥1 match en el mismo plan). El fix mantiene
  esta invariante (CD-15 de WKH-152 intacta); Opción 1 la refuerza (menos falsos drops por echo
  numérico), Opción 2 la refuerza (rescata la entrega ante desajuste multi-leg). Ref: WKH-152
  auto-blindaje#2.
- **CD-11:** OBLIGATORIO mantener `JSON.stringify(s.input)` en el corpus per-step (NO removerlo — sería
  la variante (a), descartada) — preserva DT-1 de WKH-152 y T-152-5.
- **CD-12:** el fix NO toca `goalTokens`, `tokenizeForRelevance`, `textOverlapsGoal`,
  `fallbackNoRelevance`, ni la condición del early-return `no_relevant_agent` (DT-3). Cambios acotados a
  `llmGoalTokens` + gate/filtro + terminal-guard.

---

## 4. Waves de implementación

### W0 — Baseline (serial, obligatorio antes de tocar nada)
- **W0.1** Confirmar branch base: verificar que WKH-158/159 (filas 161/162) están mergeadas en `main`
  (el work-item nota que el comentario WKH-159 en `:914-929` ya está en código → confirmado leído en
  HEAD). Ramificar `fix/164-wkh-163-cashout-matcher-relevance-fix` desde `main`.
- **W0.2** Correr `npm test src/services/orchestrate.test.ts` + `orchestrate.billing.test.ts` →
  confirmar VERDE (baseline de regresión, CD-6). Registrar el conteo (esperado ~103 tests del área).

### W1 — Opción 1: exclusión de tokens puramente numéricos (serial)
- **W1.1** Junto a `const goalTokens = tokenizeForRelevance(goal);` (:851), agregar `const llmGoalTokens
  = new Set([...goalTokens].filter((t) => !/^\d+$/.test(t)));` (DT-1). Comentario WKH-163 explicando el
  echo numérico.
- **W1.2** Cambiar el gate `llmFilterApplies` (:885-886) para usar `llmGoalTokens.size > 0` en vez de
  `goalTokens.size > 0`. **NO** cambiar el `goalTokens.size` del reasoning `no_relevant_agent` (:932,
  greedy) ni el de `fallbackNoRelevance`.
- **W1.3** En el filtro (:896), cambiar `textOverlapsGoal(corpus, goalTokens)` →
  `textOverlapsGoal(corpus, llmGoalTokens)`. **Mantener** `corpus` con `JSON.stringify(s.input)` (CD-11).
- **W1.4** `tsc --noEmit` + `./node_modules/.bin/biome check --write src/services/orchestrate.ts`.

### W2 — Opción 2: terminal delivery guard (serial, depende de W1)
- **W2.1** Entre el filtro (:897) y el `applyDrop` (:902), insertar el terminal-guard (DT-2). Forma
  recomendada (índice, tolera CD-8):
  ```ts
  // WKH-163 Opción 2 (terminal delivery guard, defense-in-depth): si el backstop
  // dropearía el step TERMINAL (la pata de entrega) Y ≥2 steps quedan disjuntos
  // (señal de desajuste de vocabulario multi-leg, no de un único add-on spurious),
  // se rescata el terminal. Con UN solo disjunto (T-152-1) NO se protege → CD-4 intacto.
  if (
    llmFilterApplies &&
    relevantSteps.length > 0 &&
    relevantSteps.length < steps.length
  ) {
    const droppedCount = steps.length - relevantSteps.length;
    const terminal = steps[steps.length - 1]; // ComposeStep | undefined (CD-8)
    const terminalDropped =
      terminal !== undefined && !relevantSteps.includes(terminal);
    if (droppedCount >= 2 && terminalDropped) {
      // Re-incluir el terminal preservando el orden original.
      relevantSteps = steps.filter(
        (s) => relevantSteps.includes(s) || s === terminal,
      );
    }
  }
  ```
  Nota: `relevantSteps` contiene referencias del MISMO array `steps` (viene de `steps.filter`), así que
  `.includes`/`=== terminal` por identidad de objeto es determinístico y seguro. `applyDrop`/`llmDropped`
  se computan DESPUÉS, sin cambios (:902-906) — el rescate solo redujo el drop.
- **W2.2** `tsc --noEmit` + biome (CD-9). Confirmar que Opción 2 NO altera ningún T-152-* existente
  (todos tienen `llmDropped ≤ 1` en su drop o no dropean).

### W3 — Test matrix (paralelizable tras W2)
Tests nuevos en `orchestrate.test.ts` (ver §6): AC-1 (badge EN), AC-2 (badge ES), AC-2b (numeric-only
goal skip), Opción-2 (3-step terminal rescue). Regresión explícita de T-152-1/2/2b/5/6/7 (ya presentes,
solo re-correr y citar). `npm test` full suite verde.

---

## 5. Exemplars verificados (paths confirmados vía Read/Grep)

| Exemplar | Path:línea (verificado) | Uso en esta HU |
|---|---|---|
| `tokenizeForRelevance` | `src/services/orchestrate.ts:356-363` | Reuso sin tocar (DT-3). |
| `textOverlapsGoal` | `orchestrate.ts:372-381` | Reuso sin tocar; recibe `llmGoalTokens`. |
| `goalTokens` (compartida) | `orchestrate.ts:851` | Punto de inserción de `llmGoalTokens`. |
| `fallbackNoRelevance` (greedy) | `orchestrate.ts:852-867` | NO se toca (guardrail T-152-7). |
| Gate `llmFilterApplies` | `orchestrate.ts:885-886` | `goalTokens.size` → `llmGoalTokens.size`. |
| Filtro per-step | `orchestrate.ts:888-897` | `goalTokens` → `llmGoalTokens`; corpus con `input` intacto. |
| Regla `applyDrop` (CD-15) | `orchestrate.ts:902-906` | Opción 2 inserta antes; `applyDrop` sin cambio. |
| early-return `no_relevant_agent` | `orchestrate.ts:908-976` | NO se toca (CD-3/CD-12). |
| Recompute billing mixto | `orchestrate.ts:987-995` | Reuso (WKH-152 AC-4 / WKH-127/132). |
| Billing 1..N | `orchestrate.ts:1011-1016` | Recalcula por construcción. |
| `resolveAgentPriceUsdc` | `src/services/agent-price.ts` | Resolver registry-aware del recompute step-0. |
| Import helper (test) | `orchestrate.test.ts:122` | `textOverlapsGoal` exportado y testeado. |
| Fixtures WKH-152 | `orchestrate.test.ts:2080-2115` | `wkh152Agents`/`wkh152Discovery`/`wkh152GetAgent` — plantilla para AC-1/AC-2. |
| Tests T-152-1..8 | `orchestrate.test.ts:2117-2527` | Reconciliados §6. |
| Tests greedy T-W5/5b/5c/6 (=T-152-7) | `orchestrate.test.ts:1877-1979` | Byte-idénticos (greedy intacto). |

---

## 6. Plan de tests (≥1 por AC) — reconciliación explícita de T-152-* (CD-6)

Reusar helpers: `setLlmResponse`, `wkh152Agents`/`wkh152Discovery`/`wkh152GetAgent`, `makeDemoAgents`,
`masterKeyRow`, `vi.mocked(discoveryService.discover / .getAgent / budgetService.debit /
composeService.compose / chargeProtocolFee)`. Requests inline **multilínea** (CD-9).

### 6.1 Tests NUEVOS (esta HU)

| ID | AC | Escenario | Assertions clave |
|---|---|---|---|
| **T-163-1 (badge EN)** | AC-1 | discover = 3 agentes de remesa (kyc/corridor/cashout), name/desc/caps en inglés SIN `send`/`mom`/`peru`; LLM selecciona los 3; inputs tailoreados: kyc `{amountUSD:400}`, corridor `{amountUSD:400, receiverCountry:"PE"}`, cashout `{receiverCountry:"PE", preference:"bank deposit"}`; goal `"Send $400 to my mom in Peru"` | **Los 3 steps se conservan**; `composeCall.steps` contiene los 3 slugs (incl. `cashout-matcher`); `reasoning` SIN `dropped` y SIN `no_relevant_agent`; `debit` = precio del step-0 original. Sin Opción 1 este test dropearía cashout. |
| **T-163-2 (badge ES)** | AC-2 | Igual fixture; goal `"Enviar 400 dolares a mi mama en Peru"` | Idéntico a T-163-1: 3 steps intactos, sin `dropped`/`no_relevant_agent`. Prueba independencia de idioma. |
| **T-163-3 (goal numérico-only ⇒ skip)** | AC-1, CD-14 refinado | goal `"400 500 600"` (solo tokens numéricos ≥3 chars) + plan LLM válido de agentes reales | `llmGoalTokens` vacío ⇒ filtro skip ⇒ TODOS los steps conservados; plan `ready`; sin `dropped`. |
| **T-163-4 (Opción 2 terminal rescue)** | Opción 2 / DT-2 | 3 agentes: A comparte 1 token NO numérico con el goal (match), B y C disjuntos; C = terminal (pata de entrega); LLM selecciona [A,B,C]; `llmDropped` base = 2, terminal C dropeado | **C (terminal) se RESCATA**; `composeCall.steps` = `[A, C]` (B dropeado); `reasoning` con `dropped (1 ...)`; `debit` = precio de A (head, `passOutput:false`). Verifica que la pata de entrega sobrevive un echo NO numérico. |

### 6.2 Reconciliación de T-152-* existentes (CD-6) — POR QUÉ CADA UNO SIGUE VERDE

| Test | Goal / forma | Efecto de Opción 1 (`llmGoalTokens`) | Efecto de Opción 2 (`llmDropped≥2`) | Veredicto |
|---|---|---|---|---|
| **T-152-1** (`:2119`) mixto → dropea | `"What is the weather forecast today"` — SIN tokens numéricos | `llmGoalTokens == goalTokens` (nada que excluir); weather-v1 matchea, defi disjunto → `relevantSteps=[weather]`, `llmDropped=1` | terminal defi dropeado pero `llmDropped=1 < 2` → **NO se protege** → defi se dropea | **VERDE.** Sigue dropeando el mixto genuino (CD-4). |
| **T-152-2** (`:2168`) all-disjoint → conserva | `"translate this document into french"` — sin numéricos | sin cambio; ambos disjuntos → `relevantSteps.length=0` | `applyDrop=false` → guard inerte | **VERDE.** Conserva los 2, billing byte-idéntico. |
| **T-152-2b** (`:2228`) multilingüe → conserva | `"cotiza el clima y el precio del dolar"` — sin numéricos | sin cambio; agentes inglés → all-disjoint | inerte (`applyDrop=false`) | **VERDE.** False-negative multilingüe sigue lockeado (CD-2). |
| **T-152-3** (`:2311`) all-relevant → no drop | `"summarize and translate this text"` — sin numéricos | sin cambio; ambos matchean | inerte (`relevantSteps.length==steps.length`) | **VERDE.** Cero regresión. |
| **T-152-4** (`:2337`) step-0 dropeado → reprice | `"What is the weather forecast today"`; plan `[defi(disjunto,head), weather(match,terminal)]` | sin cambio; `relevantSteps=[weather]`, dropea defi (head) | terminal = weather (MATCHEA, no dropeado) → `terminalDropped=false` → guard inerte; `llmDropped=1` | **VERDE.** weather pasa a head `passOutput:false`, debit repriced 0.4. |
| **T-152-5** (`:2383`) input-widening | `"weather forecast lima"`; agente name/desc disjunto, input `{query:"weather in lima"}` | señal viene de tokens NO numéricos (`weather`/`lima`) en el corpus → sigue matcheando; `llmGoalTokens` no los excluye | no dropea nada → inerte | **VERDE.** DT-1 de WKH-152 preservado (variante (b) elegida por esto, CD-11). |
| **T-152-5b** (`:2438`) goal sin tokens | `"a b c"` (todos <3 chars) | `goalTokens` vacío ⇒ `llmGoalTokens` vacío ⇒ skip | inerte | **VERDE.** Conserva el step. |
| **T-152-6** (`:2471`) all-demo | `"Analyze DeFi sentiment"`; plan 100% demo | `allStepsAreDemos` ⇒ `llmFilterApplies=false` (gate previo) → filtro no corre | inerte | **VERDE.** `no_relevant_agent` sin cambios (CD-4/AC-6). |
| **T-152-7** (= T-W5/5b/5c/6, `:1877-1979`) greedy | goals varios (`"asdfqwerty12345"` es token alfanumérico mixto, NO puramente numérico) | greedy usa `goalTokens` (NO tocada) → byte-idéntico | Opción 2 solo corre en path LLM (`usedFallback===false`) → inerte en greedy | **VERDE.** Greedy sin cambios (DT-3/CD-12). |
| **T-152-8** (`:2519`) helper puro | sets manuales `{weather,forecast}`, sin numéricos | `tokenizeForRelevance`/`textOverlapsGoal` sin tocar | N/A | **VERDE.** Semántica del helper intacta. |

**Nota sobre los ~35 tests money-path preexistentes:** siguen verdes por el mismo mecanismo de WKH-152
(goals all-disjunto ⇒ CD-15 conserva todos ⇒ billing byte-idéntico). Opción 1 solo puede REDUCIR
matches (excluir numéricos) → nunca convierte un all-disjunto en mixto → no puede introducir un drop
donde antes no lo había. Opción 2 solo REDUCE drops → no puede romper un test que hoy no dropea.

---

## 7. Readiness Check

- [x] Work-item leído completo (8 ACs, CD-1..CD-7, DT-1..DT-3, los 2 [NEEDS CLARIFICATION], Scope IN/OUT).
- [x] SDD de WKH-152 leído (DT-1 input-widening `:60-101`; residual conocido `:409-417`; MIXED-PLAN-ONLY/CD-15).
- [x] Código confirmado en HEAD con archivo:línea (`:356-363` tokenize, `:372-381` overlap, `:851` goalTokens, `:885-906` gate/filtro/applyDrop, `:987-995` recompute).
- [x] **[NEEDS CLARIFICATION #1] RESUELTO (DT-1):** Opción 1 = exclusión de tokens puramente numéricos (`/^\d+$/`), GOAL-SIDE, scoped a `llmGoalTokens` del path LLM; corpus con `input` mantenido; `tokenizeForRelevance`/greedy intactos.
- [x] **[NEEDS CLARIFICATION #2] RESUELTO (DT-2):** Opción 2 = terminal delivery guard ACOTADO a `llmDropped ≥ 2` (compatible con T-152-1); anti-gaming "≥1 match previo" implicado por `applyDrop`; trade-off documentado; **diferible por AR sin bloquear** (Opción 1 sola cubre los 8 ACs).
- [x] CD-15 (nunca vaciar un plan) preservada — el filtro LLM sigue sin disparar `no_relevant_agent`.
- [x] False-negative multilingüe (WKH-159) NO reintroducido — greedy `goalTokens` y condición del early-return sin tocar (CD-2/CD-12); T-152-2b verde.
- [x] Débito == ejecución airtight — filtro pre-`debit`/pre-`compose`; recompute reusa WKH-127/132 (CD-1/AC-7).
- [x] Drop del mixto GENUINO de WKH-152 NO desactivado — T-152-1 sigue dropeando (`llmDropped=1<2`, CD-4/AC-6).
- [x] Determinístico, sin LLM/red (`/^\d+$/`, terminal-guard en memoria) (CD-5/AC-8).
- [x] CD-6 cumplida: T-152-1/2/2b/3/4/5/5b/6/7/8 reconciliados uno a uno (§6.2), **ninguno reformulado/editado**.
- [x] Exemplars verificados con Read/Grep (§5) — cero paths inventados.
- [x] Auto-Blindaje histórico incorporado: **biome inline multilínea (RECURRENTE WKH-152/159 → CD-9)**, never-empty-plan (WKH-152 → CD-10), noUncheckedIndexedAccess (WKH-114 → CD-8).
- [x] Test plan ≥1 por AC + badge EN/ES + numeric-only skip + Opción-2 rescue + regresiones T-152-* (§6).
- [x] Waves definidas (W0 baseline → W1 Opción-1 → W2 Opción-2 → W3 tests).

**TBDs / [NEEDS CLARIFICATION]:** ninguno bloqueante.

- **[OPCIONAL — no bloqueante]** Opción 2 (terminal-guard) puede diferirse a follow-up si el AR la juzga
  demasiado específica; Opción 1 sola satisface AC-1..AC-8. Recomendación: incluirla (money-path insignia).
- **[LIMITACIÓN CONOCIDA — heredada de WKH-152, informativa]** el overlap léxico binario no captura
  relevancia semántica cross-vocabulario. Opción 1 elimina la clase numérica del residual; Opción 2
  protege la pata de entrega ante la clase NO numérica multi-leg. El residual estrictamente restante
  (echo NO numérico single-leg que dropea un terminal legítimo con `llmDropped=1`) es el fix de fondo
  de **WKH-160 (embeddings)** — fuera de scope, no bloquea (Scope OUT del work-item).

**Veredicto:** SDD **listo para SPEC_APPROVED**. Los 2 [NEEDS CLARIFICATION] resueltos con mecanismo
exacto; cero TBD bloqueante; los 8 ACs cubiertos por Opción 1 (causa raíz) + Opción 2 (red estructural);
T-152-* reconciliados sin edición.
