# SDD #165: [WKH-166] Plan del LLM autoritativo — neutralizar el drop léxico del backstop

> SPEC_APPROVED: no
> Fecha: 2026-07-08
> Tipo: bugfix (reducción de código — money-path)
> SDD_MODE: full (QUALITY — cambio de conducta intencional en billing)
> Branch: fix/165-wkh-166-llm-plan-authoritative
> Artefactos: doc/sdd/165-wkh-166-llm-plan-authoritative/

---

## 1. Resumen

El backstop léxico de relevancia (WKH-152 MIXED-PLAN-ONLY, refinado por WKH-158/159/163)
corre POST-LLM sobre el plan del planner y dropea steps que el LLM seleccionó
correctamente cuando su corpus (name+description+capabilities+input) no comparte
tokens ≥3 chars con el goal. El flujo estrella de remesas se rompe: `send money to
Peru via the best option` dropea `agentshop-kyc-validator` porque "best" del goal
matchea léxicamente la descripción del corridor ("Found the **best** route"), el
backstop ve corridor+cashout relevantes y a KYC "off-topic".

Decisión del founder: **el plan del LLM es AUTORITATIVO**. Los steps se ejecutan tal
como el LLM los produjo, tras pasar los guards que NO son de relevancia léxica
(slug-existe-en-discovery + budget-fit + `allStepsAreDemos`). Se **elimina** todo el
wiring del drop léxico sobre el plan LLM (`llmGoalTokens`, `llmFilterApplies`,
`relevantSteps`, terminal-guard de WKH-163, `applyDrop`/`llmDropped`) y el recompute
de billing post-drop. El drop "inteligente" (semántico por embeddings) vuelve con
**WKH-160** (fila 163), que re-engancha en el mismo hook point.

**Resultado esperado:** un plan MIXTO del LLM (relevante + real-irrelevante) se
ejecuta y cobra completo; el débito sigue siendo el precio del step-0 ORIGINAL del
LLM (`:761`, ya calculado, nunca mutado). Las funciones puras
`tokenizeForRelevance`/`textOverlapsGoal` quedan **INERTES** (sin call-site que dropee
el plan LLM) pero vivas/exportadas — punto de enganche para WKH-160.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 165 (WKH-166) |
| **Tipo** | bugfix / reducción de wiring (money-path) |
| **SDD_MODE** | full |
| **Objetivo** | Neutralizar el drop léxico del backstop sobre el plan del LLM; el plan del LLM se ejecuta tal cual tras slug-check + budget-fit + `allStepsAreDemos`. |
| **Reglas de negocio** | débito == ejecución; nunca vaciar un plan del LLM que pasó budget-fit; greedy/`allStepsAreDemos` byte-idénticos; multilingüe (goal ES vs agente EN) nunca se penaliza. |
| **Scope IN** | `src/services/orchestrate.ts` (remover `:852-859`, `:877-935`, `:1007-1024`); `src/services/orchestrate.test.ts` (reescribir T-152-1/T-152-4/T-163-4; confirmar preservados). |
| **Scope OUT** | `greedyPlan()`, `fallbackNoRelevance`, `allStepsAreDemos`, planner prompt, `discovery.ts`, fee/split, WKH-160 (smart-drop semántico). |
| **Missing Inputs** | Ambos [NEEDS CLARIFICATION] del work-item resueltos por el orquestador: (1) scaffolding léxico queda INERTE (no removido); (2) sizing QUALITY. |

### Acceptance Criteria (EARS)

1. **AC-1** — WHEN el goal es `send money to Peru via the best option` y el LLM planea 3 agentes (KYC, corridor, cashout), THE system SHALL ejecutar y cobrar los 3 steps; `agentshop-kyc-validator` SHALL NOT ser dropeado por coincidencia léxica de "best".
2. **AC-2** — WHEN el goal es la remesa insignia `Send $400 to my mom in Peru` (EN) o su equivalente ES, THE system SHALL ejecutar y cobrar los 3 steps, byte-idéntico en `composedSlugs` respecto a WKH-163.
3. **AC-3** — WHILE `usedFallback === false` y el plan del LLM mezcla un agente relevante con uno léxicamente disjunto, THE system SHALL ejecutar el plan EXACTAMENTE como lo devolvió el LLM — sin drop per-step, sin terminal-guard, sin reasoning `'dropped'`/`'off-topic'`.
4. **AC-4** — WHILE el goal es multilingüe (ES vs agentes EN) y el LLM selecciona agentes reales, THE system SHALL devolver `planStatus: 'ready'` con todos los steps del LLM intactos.
5. **AC-5** — THE system SHALL NUNCA devolver `steps: []` para un plan que el LLM produjo y que pasó budget-fit (invariante never-empty, independiente de relevancia léxica).
6. **AC-6** — WHEN un plan del LLM llega a `planStatus: 'ready'`, THE system SHALL debitar exactamente el precio del step-0 ORIGINAL del plan del LLM (`:755-761`), SIN reprecio por drop.
7. **AC-7** — IF el LLM planner falla (`plan === null` tras retry WKH-158) o el circuit breaker está abierto, THEN THE system SHALL caer a `greedyPlan()` exactamente como hoy — `fallbackNoRelevance`/`allStepsAreDemos` byte-idénticos.
8. **AC-8** — WHEN el plan del LLM contiene un agente real pero léxicamente off-topic respecto al goal, THE system SHALL ejecutarlo y cobrarlo junto al resto del plan (conducta NUEVA aceptada por el founder; el smart-drop semántico se implementa en WKH-160).

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Hallazgo / patrón extraído |
|---------|---------|----------------------------|
| `src/services/orchestrate.ts:698-767` | Construcción del plan LLM + cálculo del débito step-0 | `steps` se arma en `:728-738` desde `budgetedAgents` (post budget-fit, `passOutput: index>0`); `plannedCostUsd` = `step0Price` (`:757-761`) vía `resolveAgentPriceUsdc` registry-aware. **Este es el único punto legítimo del débito step-0** (CD-5). |
| `src/services/orchestrate.ts:830-875` | Guards que NO se tocan | `allStepsAreDemos` (`:830-832`, slug-match contra `demoSlugs`, NO léxico) y `fallbackNoRelevance` (`:860-875`, greedy-only, gatilla `usedFallback===true`). Usan `goalTokens` (`:851`) y `tokenizeForRelevance`. **Ambos permanecen.** |
| `src/services/orchestrate.ts:877-935` | **Bloque a eliminar** | `llmFilterApplies` (`:893-894`) + filtro `relevantSteps` (`:896-906`) + terminal-guard WKH-163 (`:907-927`) + `applyDrop`/`llmDropped` (`:928-935`). Todo gatilla `!usedFallback` → NUNCA corre sobre greedy. |
| `src/services/orchestrate.ts:937-1005` | Early-return `no_relevant_agent` | Dispara SOLO con `allStepsAreDemos || fallbackNoRelevance` (`:937`) — greedy/demo path. Usa `goalTokens.size` (`:961`) para afinar el mensaje. **Permanece intacto.** |
| `src/services/orchestrate.ts:1007-1024` | **Recompute de billing post-drop a eliminar** | `if (applyDrop) { steps = relevantSteps...; plannedCostUsd = step0Price... }`. Solo corre si `applyDrop`. Al quitarlo, `steps`/`plannedCostUsd` quedan tal como `:728-761`. |
| `src/services/orchestrate.ts:1040-1059` | Recompute final `costPerStep`/`totalCostUsdc`/`protocolFeeUsdc` | Itera sobre la variable `steps` (no `relevantSteps`). Con `steps` intacto = plan completo del LLM → **hereda el fix por construcción, sin cambios**. |
| `src/services/orchestrate.ts:355-381` | Funciones puras `tokenizeForRelevance`/`textOverlapsGoal` | `textOverlapsGoal` exportada, testeada por T-152-8, consumida (indirecto) por `fallbackNoRelevance` vía el mismo tokenizador. **Quedan INERTES respecto al path LLM, vivas para WKH-160.** |
| `src/services/orchestrate.test.ts:2078-2115` | Fixture WKH-152 | `weather-v1` (0.4), `defi-sentiment-v1` (0.7); `wkh152GetAgent()` mockea `getAgent` consistente con el discover. Necesario para calcular los débitos esperados en las reescrituras. |
| `src/services/orchestrate.test.ts:2121-2529` | Suite T-152-* | T-152-1/4 cambian; 2/2b/3/5/5b/6/8 se preservan. Verificados los asserts exactos (ver §Test Plan). |
| `src/services/orchestrate.test.ts:2616-2808` | Suite T-163-* | T-163-1/2/3 preservados; T-163-4 (terminal-guard, `:2752-2808`) se reescribe. Fixture `wkh163TerminalAgents` (`:2707-2741`): weather 0.4 / defi 0.5 / translator 0.6. |
| `doc/sdd/152-wkh-114-verifiable-step-ac/auto-blindaje.md` | Aprendizaje histórico money-path | Ver Constraint Directives CD-8/CD-9 (heredados: `noUncheckedIndexedAccess` en indexado de arrays; biome `useOptionalChain`/unused). |

### Exemplars (verificados con Glob/Grep)

| Para modificar | Seguir patrón de | Razón |
|----------------|------------------|-------|
| Reescritura T-152-1 | `orchestrate.test.ts:2170-2223` (**T-152-2**, conserve-all) | Ya asevera "plan conservado entero + débito step-0 original + no 'dropped'". T-152-1 pasa a esa misma forma. |
| Reescritura T-152-4 | `orchestrate.test.ts:2313-2335` (**T-152-3**) + assert de débito de T-152-2 (`:2217-2221`) | Head sin drop + `budgetService.debit.mock.calls[0][2]` == precio step-0 original. |
| Reescritura T-163-4 | `orchestrate.test.ts:2616-2644` (**T-163-1**, 3 steps intactos) | Plan multi-leg de 3 steps conservado completo, sin 'dropped'. |
| Remoción del bloque | `orchestrate.ts:834-875` (patrón `fallbackNoRelevance` que permanece) | Confirma qué queda vivo vs qué se va (frontera exacta del diff). |

### Estado de BD relevante

| Tabla | Cambios | Nota |
|-------|---------|------|
| — | Ninguno | Cambio 100% en la capa de servicio; no toca esquema, migraciones ni queries a `a2a_*`. |

### Componentes reutilizables encontrados

- `resolveAgentPriceUsdc(slug, registry)` (resolver registry-aware ya usado en `:759` y `:1042`) — permanece como fuente canónica del precio; no se agrega nada.
- `tokenizeForRelevance`/`textOverlapsGoal` — se conservan como scaffolding INERTE para que WKH-160 las reemplace por un scorer semántico sin re-crearlas.

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Descripción | Exemplar |
|---------|--------|-------------|----------|
| `src/services/orchestrate.ts` | Modificar (remover) | Eliminar `:852-859` (`llmGoalTokens`), `:877-935` (backstop LLM completo) y `:1007-1024` (recompute post-drop). Ajustar comentarios stale. | patrón `fallbackNoRelevance` `:834-875` |
| `src/services/orchestrate.test.ts` | Modificar | Reescribir T-152-1 (`:2121`), T-152-4 (`:2339`), T-163-4 (`:2752`) a la conducta NUEVA (conserve-all). | T-152-2 / T-152-3 / T-163-1 |

### 4.2 Modelo de datos

N/A — sin cambios de BD.

### 4.3 Mecanismo de neutralización (decisión resuelta)

**Decisión: ELIMINAR el wiring, no dejar `applyDrop=false` hard.** Dejar el bloque
con `applyDrop=false` fijo dejaría código muerto (dead branches) que confunde al AR/CR
y a WKH-160. Se remueve por completo el wiring específico del backstop LLM; las
funciones puras quedan como scaffolding inerte. Frontera exacta del diff:

**SE ELIMINA (3 bloques contiguos):**

1. **`:852-859`** — el bloque `llmGoalTokens` (comentario WKH-163 + `const llmGoalTokens = new Set([...goalTokens].filter(...))`). Único consumidor era `llmFilterApplies`/`relevantSteps`. **`goalTokens` (`:851`) NO se toca** — lo consume `fallbackNoRelevance` (`:862,:871`) y el reasoning (`:961`).
2. **`:877-935`** — comentario de diseño WKH-152 MIXED-PLAN-ONLY + `llmFilterApplies` + `let relevantSteps` + filtro per-step + terminal-guard WKH-163 + `const applyDrop` + `const llmDropped`. Bloque completo.
3. **`:1007-1024`** — comentario WKH-152 + `if (applyDrop) { steps = relevantSteps.map(...); plannedCostUsd = step0Price...; reasoning += ' (... dropped ...)' }`.

**SE CONSERVA (verificado que sigue funcionando sin los bloques anteriores):**

- `:851` `const goalTokens = tokenizeForRelevance(goal)` — consumido por `fallbackNoRelevance`.
- `:860-875` `fallbackNoRelevance` (greedy path) — intacto, byte-idéntico.
- `:937-1005` early-return `no_relevant_agent` (`allStepsAreDemos || fallbackNoRelevance`) — intacto.
- `:1040-1059` recompute `costPerStep`/`totalCostUsdc`/`maxQuotedCostUsdc`/`protocolFeeUsdc` sobre la variable `steps` — intacto, ahora itera el plan completo del LLM.
- `src/services/orchestrate.ts:355-381` `tokenizeForRelevance`/`textOverlapsGoal` — inertes respecto al plan LLM, exportadas, testeadas por T-152-8.

**Comment hygiene (parte del cambio, no cosmética-opcional):** los comentarios
`:842-853` (dentro del bloque explicativo de `fallbackNoRelevance`, describen "abajo se
agrega un backstop determinístico PER-STEP…"), `:819-829` (nota de `allStepsAreDemos`
que referencia el backstop) y el JSDoc de `textOverlapsGoal` (`:349-353`) describen
comportamiento **que deja de existir**. Deben recortarse/ajustarse para no mentir sobre
el código (dejar comentarios que describen un backstop inexistente confunde al próximo
lector y a WKH-160). Cambio de comentarios únicamente, cero cambio de lógica.

### 4.4 Billing — verificación de corrección sin el recompute post-drop

Cadena del débito, confirmada línea por línea:

1. `plannedCostUsd` se setea UNA vez en `:761` = `step0Price ?? 0`, donde `step0Price =
   resolveAgentPriceUsdc(budgetedAgents[0].slug, budgetedAgents[0].registry)` — el
   precio del primer agente del plan del LLM que pasó budget-fit. **Al remover
   `:1016-1022`, ya nada muta `plannedCostUsd` después de `:761`.** ⇒ AC-6: débito ==
   step-0 original del LLM.
2. `steps` se arma UNA vez en `:728-738` con `passOutput: index > 0` correcto para el
   plan completo (step-0 → `false`, resto → `true`). **Al remover `:1017`
   (`steps = relevantSteps.map(...)`), no hay reasignación ni re-derivación de
   `passOutput`** → sin cirugía off-by-one → `steps` = plan completo del LLM.
3. `:1040-1059` itera `for (const step of steps)` (la variable, no `relevantSteps`) →
   `costPerStep`/`totalCostUsdc`/`protocolFeeUsdc` se computan sobre el plan completo.
   **Hereda el fix por construcción; NO requiere cambios.**
4. `debitFallback: false`, `feeUsdc: protocolFeeUsdc`, `usedFallback` — sin cambios.

**Invariante money-safe (para AR/CR):** `plannedCostUsd` (débito, `:761`) es el precio
del agente en `steps[0]` (`:728`), que es el que compose ejecuta primero. Los steps
`1..N` los debita compose (guard `i>0`, WKH-127). Con `steps` == plan completo del LLM
sin filtrar, **el conjunto debitado == el conjunto ejecutado** trivialmente (no hay
subconjunto que diverja). Quitar el recompute post-drop **no** deja `plannedCostUsd`
mal seteado: su único setter válido (`:761`) ya corrió antes.

### 4.5 Never-empty y greedy (confirmación)

- **Never-empty (AC-5):** trivial sin drop. Un plan del LLM llega a `:1040` con
  `steps.length > 0` por construcción (el early-return `budget_exhausted` en `:777`
  ya cubre `steps.length === 0`, y no depende de este cambio). El early-return
  `no_relevant_agent` (`:937`) es EXCLUSIVO de `allStepsAreDemos || fallbackNoRelevance`
  (greedy/demo) — **no se toca**, sigue devolviendo `steps: []` solo en esos casos, no
  para un plan LLM real.
- **Greedy (AC-7):** el bloque eliminado gatillaba `!usedFallback` (`:894`). El greedy
  corre con `usedFallback === true`, así que **nunca** entraba al backstop.
  `greedyPlan()`, `fallbackNoRelevance` y `allStepsAreDemos` quedan byte-idénticos
  (verificar con `git diff` que ninguna de esas líneas cambió).

### 4.6 Hook point para WKH-160 (smart-drop semántico)

El punto donde vivía el backstop léxico (entre el early-return `no_relevant_agent`
`:1005` y el check de timeout `:1026`) es el **hook de re-enganche** para WKH-160.
WKH-160 insertará ahí un scorer semántico (embeddings/cosine) que reemplace el juicio
léxico de `textOverlapsGoal`, reusando la firma `(corpus, goalSignal) => boolean|score`
y recomputando `plannedCostUsd`/`passOutput` con el MISMO patrón que tenía `:1016-1022`
(que este SDD documenta como referencia histórica en el git log). `tokenizeForRelevance`/
`textOverlapsGoal` quedan disponibles como fallback léxico obligatorio de WKH-160
(shadow-mode Fase 1).

## 5. Constraint Directives (Anti-Alucinación)

### OBLIGATORIO seguir
- **CD-1:** El plan del LLM se ejecuta tal cual tras slug-check (`:701-703`) + budget-fit (`:719-726`) + `allStepsAreDemos` (`:830-832`). Ningún guard de relevancia per-step corre sobre él.
- **CD-4:** Preservar el invariante never-empty: `steps.length > 0` cuando el LLM produjo plan y pasó budget-fit. No introducir ningún path que vacíe el plan LLM.
- **CD-5 (money-safe):** `plannedCostUsd`/débito step-0 proviene EXCLUSIVAMENTE del cálculo en `:755-761`. Ningún recompute posterior debe alterarlo. Débito == ejecución.
- **CD-6:** Actualizar T-152-1/T-152-4/T-163-4 de forma DELIBERADA — documentar en el commit/PR que la conducta vieja (drop) ya no aplica; no borrarlos en silencio ni romperlos sin constancia.
- **CD-Multilingüe:** Un goal ES vs agentes EN (0 overlap léxico) SHALL conservarse completo — antes era el caso especial "all-disjoint ⇒ conserve"; ahora es el comportamiento universal.
- **CD-8 (heredado — auto-blindaje WKH-114):** Con `noUncheckedIndexedAccess` activo, todo `ARRAY[i]` es `T | undefined`. Al remover el bloque no quedan accesos nuevos, pero verificar que ninguna referencia colgante a `steps[...]`/`relevantSteps[...]` sobreviva a la remoción.
- **CD-9 (heredado — auto-blindaje WKH-114):** Correr `biome check` tras la remoción: eliminar wiring puede dejar imports/variables sin usar (`noUnusedVariables`). Confirmar que `goalTokens` sigue usada (por `fallbackNoRelevance`) y que `tokenizeForRelevance`/`textOverlapsGoal` (exportadas) no disparan warning.

### PROHIBIDO
- **CD-2:** PROHIBIDO modificar `fallbackNoRelevance` (`:860-875`) / `greedyPlan()` — byte-idénticos (verificar con diff, no solo tests verdes).
- **CD-3:** PROHIBIDO modificar `allStepsAreDemos` (`:830-832`).
- **CD-7:** PROHIBIDO tocar planner prompt (`llmPlan`), `discovery.ts`, fee/split (`chargeProtocolFee`/`getProtocolFeeRate`).
- **CD-10:** PROHIBIDO remover/renombrar/cambiar la firma de `tokenizeForRelevance`/`textOverlapsGoal` — quedan INERTES pero vivas y exportadas (hook WKH-160, T-152-8).
- **CD-11:** PROHIBIDO agregar el smart-drop semántico en esta HU — es WKH-160.
- **CD-12:** PROHIBIDO expandir el diff más allá de los 3 bloques de `:852-859`/`:877-935`/`:1007-1024` + comment hygiene + 3 tests. Sin refactors adyacentes.

## 6. Scope

**IN:**
- `src/services/orchestrate.ts`: remover `:852-859`, `:877-935`, `:1007-1024` + ajustar comentarios stale (`:819-829`, `:842-853`, JSDoc `textOverlapsGoal`).
- `src/services/orchestrate.test.ts`: reescribir T-152-1, T-152-4, T-163-4.

**OUT:**
- `greedyPlan()`, `fallbackNoRelevance`, `allStepsAreDemos`.
- Planner prompt / `llmPlan()`, `discovery.ts`, fee/split.
- WKH-160 (smart-drop semántico por embeddings).
- Toda la demás suite de tests (preservada sin cambios).

## 7. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|--------|-------|---------|------------|
| Débito repreciado mal al quitar el recompute post-drop | B | A (money) | §4.4: `plannedCostUsd` tiene un único setter (`:761`) que corre antes del bloque removido; AC-6 + T-152-4 reescrito lo pinnean. AR/CR confirman débito==ejecución. |
| Referencia colgante a `relevantSteps`/`llmDropped`/`llmGoalTokens` tras la remoción | B | M (compila-break) | Grep confirmó que TODOS los usos de esas 3 vars están dentro de los bloques a remover. `tsc --noEmit` + `biome check` en W0. |
| `goalTokens` quede sin usar al remover `llmGoalTokens` | MB | B | Confirmado: `goalTokens` la consume `fallbackNoRelevance` (`:862,:871`) y el reasoning (`:961`) — sigue viva. |
| Conflicto de merge con WKH-160 (mismo bloque `:851-935`) | A | M | **WKH-166 mergea PRIMERO** (ver §8). WKH-160 rebasa sobre el estado ya reducido y re-engancha en el hook point de §4.6. |
| Terminal-guard queda como dead-code si se deja `applyDrop=false` en vez de remover | — | — | Mitigado por decisión de §4.3: se ELIMINA el bloque, no se deja inerte. |

## 8. Dependencias y orden de merge

- **WKH-160 (fila 163, `in progress`, `feat/163-wkh-160-semantic-embeddings-relevance`)** toca el MISMO bloque de `orchestrate.ts` (`:851-935`). **WKH-166 debe mergearse ANTES de que WKH-160 avance a F2/F3.** Conflicto de merge garantizado (mismas líneas); resolución: WKH-160 rebasa sobre el bloque ya removido y agrega su scorer semántico en el hook point (§4.6).
- Independiente de WKH-159 (fila 162, greedy-only) y WKH-157 (fila 159, `discovery.ts`) — no tocan `:851-935` ni `:1007-1024`; posible conflicto de líneas cercanas (no de lógica).
- Sin dependencias de infra/BD/env nuevas.

## 9. Missing Inputs

- [x] Scaffolding léxico → INERTE (resuelto: se conserva `tokenizeForRelevance`/`textOverlapsGoal`).
- [x] Sizing → QUALITY (resuelto por el orquestador).

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| — | — | Ninguno. Los 2 [NEEDS CLARIFICATION] del work-item fueron resueltos antes de F2. | No |

---

# Plan — SDD #165: WKH-166

> PLAN_APPROVED: no
> SDD: doc/sdd/165-wkh-166-llm-plan-authoritative/sdd.md
> Fecha: 2026-07-08

## TBD Resueltos

| TBD | Sección | Resolución |
|-----|---------|-----------|
| Scaffolding léxico inerte vs removido | §4.3, CD-10 | INERTE — se conserva, hook para WKH-160. |
| Neutralización: `applyDrop=false` vs eliminar | §4.3 | ELIMINAR los 3 bloques (evita dead-code). |
| Terminal-guard (T-163-4): eliminar test o reescribir | Wtests | REESCRIBIR (conserva cobertura del plan multi-leg de 3 steps). |

## Waves de Implementación

### Wave 0 (Serial Gate — neutralización + billing)
- [ ] **W0.1** Remover `orchestrate.ts:852-859` (`llmGoalTokens` + su comentario). Preservar `goalTokens` `:851`.
- [ ] **W0.2** Remover `orchestrate.ts:877-935` (comentario MIXED-PLAN-ONLY + `llmFilterApplies` + `relevantSteps` + terminal-guard + `applyDrop` + `llmDropped`).
- [ ] **W0.3** Remover `orchestrate.ts:1007-1024` (comentario + `if (applyDrop) {…}`).
- [ ] **W0.4** Comment hygiene: ajustar `:819-829`, `:842-853` y JSDoc de `textOverlapsGoal` (`:349-353`) para no describir un backstop inexistente. Sin cambio de lógica.
- [ ] **W0.5** Verificar: `tsc --noEmit` 0 errores + `biome check` 0 warnings (CD-8/CD-9). Confirmar por grep que no quedan referencias colgantes a `relevantSteps`/`llmDropped`/`llmGoalTokens`/`applyDrop`/`llmFilterApplies`.

### Wtests (Serial — reescritura de los 3 + verificación de preservados)
- [ ] **Wt.1** Reescribir **T-152-1** (`:2121-2162`) → conserve-all (ver Test Plan).
- [ ] **Wt.2** Reescribir **T-152-4** (`:2339-2380`) → débito == step-0 original.
- [ ] **Wt.3** Reescribir **T-163-4** (`:2752-2808`) → plan multi-leg de 3 steps conservado.
- [ ] **Wt.4** Correr la suite completa: los 3 reescritos VERDES + los preservados VERDES sin tocar (`vitest run orchestrate.test.ts`).

## Archivos involucrados

| Archivo | Existe | Acción | Wave | Exemplar |
|---------|--------|--------|------|----------|
| `src/services/orchestrate.ts` | Sí | Modificar (remover) | W0.1–W0.4 | `:834-875` (fallbackNoRelevance) |
| `src/services/orchestrate.test.ts` | Sí | Modificar (3 tests) | Wt.1–Wt.3 | T-152-2 / T-152-3 / T-163-1 |

## Test Plan

> Framework: vitest. Cambio de conducta **INTENCIONAL** en T-152-1/T-152-4/T-163-4
> (no son tests rotos — aseveraban la conducta vieja de drop, que deja de existir).

### Tests que CAMBIAN (reescritura exacta)

| Test | AC | Antes aseveraba | Ahora asevera |
|------|----|-----------------|---------------|
| **T-152-1** (`:2121`) | AC-1, AC-3, AC-8 | `composedSlugs).not.toContain('defi-sentiment-v1')` + `reasoning).toContain('dropped')` (defi dropeado) | `composedSlugs).toEqual(['weather-v1','defi-sentiment-v1'])` (plan completo, orden original) + `reasoning).not.toContain('dropped')` + `debit` 1× con `mock.calls[0][2]` ≈ `0.4` (step-0 = weather original). Renombrar a "mixed plan is conserved in full — LLM plan is authoritative (WKH-166)". |
| **T-152-4** (`:2339`) | AC-6 | `debitAmount).toBeCloseTo(0.4)` (repriced al survivor) + `steps[0].agent).toBe('weather-v1')` | `debitAmount).toBeCloseTo(0.7)` (step-0 ORIGINAL = defi-sentiment-v1, sin reprice) + `composeCall.steps[0].agent).toBe('defi-sentiment-v1')` + `steps[0].passOutput).toBe(false)` + `steps.map(s=>s.agent)).toEqual(['defi-sentiment-v1','weather-v1'])`. Renombrar a "step-0 debit == original LLM head price regardless of lexical relevance". |
| **T-163-4** (`:2752`) | AC-3, AC-8 | `composeCall.steps).toEqual(['wkh163-weather','wkh163-translator'])` (defi dropeado, terminal rescatado) + `reasoning).toContain('dropped')`/`'1 off-topic'` + `debit` 0.4 | `composeCall.steps.map(s=>s.agent)).toEqual(['wkh163-weather','wkh163-defi','wkh163-translator'])` (los 3 conservados, orden original) + `reasoning).not.toContain('dropped')` + `debit` 1× ≈ `0.4` (step-0 = weather). Renombrar a "multi-leg LLM plan conserved in full (terminal-guard removed — WKH-166)". **Decisión: reescribir (no eliminar)** — el fixture de 3 steps multi-leg pinnea AC-3/AC-8 en la forma ≥3-step que T-152-1 (2 steps) no cubre. |

### Tests que se PRESERVAN (deben seguir VERDES sin tocar)

| Test | Línea | Por qué sigue verde |
|------|-------|---------------------|
| T-152-2 | `:2170` | Ya asevera conserve-all; ahora universal. |
| T-152-2b | `:2230` | Multilingüe conserve-all; ahora universal (era el caso all-disjoint). |
| T-152-3 | `:2313` | All-relevant → sin drop; siempre pasó. |
| T-152-5 | `:2385` | "not dropped"; sigue cierto (nunca se evalúa drop). |
| T-152-5b | `:2440` | Zero-token goal → conservado; sigue cierto. |
| T-152-6 | `:2473` | `no_relevant_agent` por `allStepsAreDemos` (no el bloque removido). |
| T-152-8 | `:2521` | `textOverlapsGoal` pura — función conservada INERTE. |
| T-163-1 | `:2616` | Remesa insignia EN, 3 steps intactos. |
| T-163-2 | `:2648` | Remesa insignia ES, 3 steps intactos. |
| T-163-3 | `:2680` | Numeric-only goal → 3 steps conservados (razón ahora vacua, aserción sigue verdadera). |
| WKH-158 (`T-158-*`) | `:3690` | Retry greedy path — fuera de scope. |
| WKH-159 (`T-W159*`) | `:1989` | Greedy — fuera de scope. |
| T-W5a/b/c, T-W6 | — | Fallback relevance guard genuino (greedy). |
| T-WKH151-* | — | Discovery broaden-retry — sin cambios. |
| Suites WKH-114 / WKH-132 / WKH-131 | — | No dependen del drop. |

### Cobertura por AC

| AC | Test que lo cubre |
|----|-------------------|
| AC-1 (KYC no dropeado por "best") | T-152-1 reescrito (mixed plan conserve-all) + repro manual del founder |
| AC-2 (remesa insignia EN/ES byte-idéntica) | T-163-1, T-163-2 (preservados) |
| AC-3 (plan mixto ejecutado tal cual) | T-152-1, T-163-4 reescritos |
| AC-4 (multilingüe conserve-all) | T-152-2b (preservado) |
| AC-5 (never-empty) | T-152-2, T-152-2b, T-152-3 (todos → compose con plan completo) |
| AC-6 (débito == step-0 original) | T-152-4 reescrito (0.7, no reprice) + T-152-1 (0.4) |
| AC-7 (greedy byte-idéntico) | T-158-*, T-W159*, T-W5/6 (preservados) + `git diff` de `fallbackNoRelevance`/`greedyPlan` |
| AC-8 (off-topic real ejecutado y cobrado) | T-152-1, T-163-4 reescritos |

## Verificación Incremental

| Wave | Verificación |
|------|--------------|
| W0 | `tsc --noEmit` 0 + `biome check` 0 + grep sin referencias colgantes |
| Wtests | `vitest run orchestrate.test.ts` — 3 reescritos verdes + preservados verdes |
| Final | suite completa verde + `git diff` confirma greedy/`fallbackNoRelevance`/`allStepsAreDemos` byte-idénticos |

## Estimación

- Archivos nuevos: 0
- Archivos modificados: 2 (`orchestrate.ts`, `orchestrate.test.ts`)
- Tests nuevos: 0 (3 reescritos)
- Líneas: ~-60 producción (remoción neta) + ~±40 tests

---

## Readiness Check

```
READINESS CHECK:
[x] Cada AC tiene ≥1 test asociado (tabla Cobertura por AC)
[x] Cada archivo en 4.1 tiene Exemplar válido (verificado con Glob/Read)
[x] No hay [NEEDS CLARIFICATION] pendientes (2 resueltos pre-F2)
[x] Constraint Directives incluyen ≥3 PROHIBIDO (CD-2/3/7/10/11/12)
[x] Context Map tiene ≥2 archivos leídos (10 entradas verificadas)
[x] Scope IN/OUT explícitos y no ambiguos
[x] BD: N/A confirmado (sin cambios de esquema)
[x] Happy Path completo (§4.4 cadena del débito)
[x] Flujo de error/guardas: never-empty (§4.5) + greedy intacto (§4.5) definidos
[x] Mecanismo de neutralización resuelto: 3 bloques exactos a remover (§4.3)
[x] Billing sin recompute post-drop verificado correcto por construcción (§4.4)
[x] Conflicto de merge WKH-160 documentado + orden (WKH-166 primero) (§8)
[x] Hook point para WKH-160 documentado (§4.6)
```

Todos los checks PASS → SDD listo para GATE `SPEC_APPROVED`.

---

*SDD generado por NexusAgil — F2 (Architect) — WKH-166 — QUALITY*
