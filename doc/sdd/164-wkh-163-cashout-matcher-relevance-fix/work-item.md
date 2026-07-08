# Work Item — [WKH-163] La remesa insignia se trunca por el backstop léxico de WKH-152 (dropea `cashout-matcher`)

## Resumen
Regresión money-path introducida por WKH-152 (MIXED-PLAN-ONLY backstop, fila 160 del INDEX): el
goal exacto de Chaski **"Send $400 to my mom in Peru"** produce un plan LLM de 3 steps
(`agentshop-kyc-validator`, `agentshop-corridor-discoverer`, `agentshop-cashout-matcher`) pero el
backstop léxico dropea `agentshop-cashout-matcher` — la pata que ENTREGA el dinero — dejando un
plan `ready` de 2 steps que cobraría KYC+corridor sin nunca completar la remesa. `/orchestrate`
atómico ejecutaría y cobraría ese plan incompleto.

## Sizing
- SDD_MODE: full
- Estimación: S
- Branch sugerido: `fix/164-wkh-163-cashout-matcher-relevance-fix`
- Justificación (QUALITY, no FAST+AR): toca el MISMO backstop money-path de WKH-152/158/159 (billing
  post-plan, recompute de step-0 si el filtrado toca el head) sobre el flujo insignia del producto
  (remesas). Aunque el cambio de código esperado es acotado (condición del filtro/applyDrop), un
  ajuste mal calibrado puede reintroducir el over-charge original de WKH-152 (des-proteger el drop)
  o el false-negative multilingüe de WKH-159 (sobre-proteger y dejar de dropear nunca) — amerita F2
  con AR dedicado, igual que sus 3 HUs hermanas (filas 160/161/162, todas QUALITY).

## F0 — Confirmación del mecanismo (leído en código, línea actual de `main`)

Leído `src/services/orchestrate.ts` completo en el HEAD actual:

1. **Helpers de tokenización (reusados, sin tocar):**
   - `tokenizeForRelevance` (`:356-363`): lowercase, split `/[^a-z0-9]+/`, descarta tokens `<3`
     chars. Para el goal `"Send $400 to my mom in Peru"` produce `goalTokens = {send, 400, mom,
     peru}` (`to`/`my`/`in` caen por `<3` chars).
   - `textOverlapsGoal` (`:372-381`): `true` si el texto comparte ≥1 token con `goalTokens`.

2. **El corpus per-step del backstop LLM incluye el `input` del step, no solo
   name+description+capabilities** (`:890-897`):
   ```
   const corpus = `${agent.name} ${agent.description} ${agent.capabilities.join(' ')} ${JSON.stringify(s.input)}`;
   return textOverlapsGoal(corpus, goalTokens);
   ```
   Esto es **DELIBERADO por diseño** (SDD de WKH-152, DT-1, `doc/sdd/160-wkh-152-.../sdd.md:60-101`):
   ampliar el corpus con el `input` tailoreado del LLM es "estrictamente más conservador" porque
   solo puede AUMENTAR el overlap → solo puede CONSERVAR más steps, nunca dropear de más. El
   exemplar de calibración de WKH-152 usaba justamente `{amountUSD, receiverCountry}` como señal
   legítima de relevancia. **No es un olvido ni una desviación del work-item original — es DT-1
   ratificado**, y el propio SDD de WKH-152 (`sdd.md:409-417`) ya documentó el **residual conocido**:
   *"dentro de un plan mixto multilingüe, un step VÁLIDO pero léxicamente disjunto del goal PODRÍA
   dropearse si OTRO step del mismo plan sí matchea léxicamente (el match de un step 'habilita' el
   drop de los otros disjuntos)"* — marcado no-bloqueante, "si telemetría/QA evidencia casos reales
   → HU de refinamiento separada". **WKH-163 es exactamente ese caso real, en el flujo insignia.**

3. **Mecanismo exacto del bug confirmado:**
   - `kyc-validator` y `corridor-discoverer` sobreviven porque su `input` tailoreado hace echo del
     número `400` (p.ej. `{amountUSD: 400, ...}`) — comparten el token `400` con `goalTokens`.
   - `cashout-matcher` (`input: {receiverCountry:"PE", preference:"bank deposit"}`) NO comparte
     ningún token — ni su name/description/capabilities ni su input mencionan `send`/`400`/`mom`/
     `peru`.
   - `llmFilterApplies` (`:885-886`) = `true` (no fallback, no all-demos, `goalTokens.size>0`).
   - `relevantSteps` = `[kyc-validator, corridor-discoverer]` (2 de 3) → `relevantSteps.length===2`,
     `steps.length===3` → **`0 < relevantSteps.length < steps.length`** → `applyDrop = true`
     (`:902-906`, regla CD-15/MIXED-PLAN-ONLY: dropea si-y-solo-si el plan es MIXTO).
   - `cashout-matcher` se excluye ANTES de `budgetService.debit`/`composeService.compose` → el plan
     `ready` final tiene 2 steps, con reasoning `"(1 off-topic agent dropped by relevance backstop)"`.
   - La supervivencia de kyc/corridor depende de un **echo numérico incidental** (`400` es un campo
     `amountUSD` presente en CASI cualquier agente de remesa, no una señal semántica de "cuál
     sub-tarea es relevante") — es justo el patrón de "match habilita drop de otro disjunto"
     documentado como residual en WKH-152.
   - Confirmado por los propios ejemplos del brief: `"Send money..."` (sin número) → all-disjoint →
     CD-15 conserva los 3; `"$50"` (2 chars, filtrado por `tokenizeForRelevance`) → all-disjoint →
     conserva los 3; `"$400"` (≥3 chars) → mixto → dropea `cashout-matcher`. El único factor que
     cambia el resultado es si el monto tiene ≥3 dígitos, no la relevancia real del step.

## Qué protege HOY y NO se puede romper (heredado de WKH-152/159, confirmado en `sdd.md`/código)
- **CD-15 / MIXED-PLAN-ONLY (nunca vaciar un plan):** si `relevantSteps.length === 0` (todos
  disjuntos) ⇒ CONSERVAR TODOS, no-op, sin `no_relevant_agent`, sin debit extra (`:878-884`,
  `:899-901`). Esto es lo que evita el false-negative multilingüe (goal ES / agente EN) — **debe
  seguir así**.
- **`fallbackNoRelevance`/`allStepsAreDemos`** (path greedy y plan 100%-demo) siguen dando
  `no_relevant_agent` sin cobrar — **no se tocan** (fuera del blast radius de esta HU).
- **Débito == ejecución (billing airtight):** el filtro corre en `planOrchestration`, ANTES de
  `budgetService.debit` (`:1065-1073` aprox.) y `composeService.compose` (`:1129` aprox.) — un step
  filtrado NUNCA llega a ninguno de los dos. El recompute de `plannedCostUsd`/`step0Slug`/
  `step0Registry` sobre el primer step sobreviviente (mecanismo ya implementado por WKH-152) sigue
  siendo el contrato correcto si el fix de esta HU deja el plan resultante con >1 posibles "primeros"
  steps distintos al original.

## Fix a escopear — evaluado, recomendación para F2

**Opción 1 — sacar `JSON.stringify(s.input)` del corpus de relevancia:**
Para el goal insignia, esto probablemente hace que `kyc-validator`/`corridor-discoverer` YA NO
matcheen por el número `400` → el plan queda all-disjoint → CD-15 conserva los 3. **Pero** esto
revierte DT-1 de WKH-152 (ampliación deliberada del corpus, "false-negative-safe") y **rompe por
diseño el test existente T-152-5** (`orchestrate.test.ts`, caso: agente relevante con name/desc
disjunto del goal pero cuyo `input` tailoreado SÍ comparte token → hoy se conserva gracias al
input-widening). Quitar `input` del corpus por completo es más simple pero reintroduce ese
false-negative en sentido inverso (agentes genéricamente nombrados, distinguibles solo por su input
tailoreado, dejarían de rescatarse). **No es gratis** — el Architect en F2 debe decidir si:
(a) elimina `input` del corpus por completo (acepta perder la protección de T-152-5, requiere
reformular/eliminar ese test con ratificación explícita), o
(b) una versión más quirúrgica: excluir del corpus/goalTokens los tokens **puramente numéricos**
(`/^\d+$/`), preservando el resto del input-widening de DT-1 — un monto (`amountUSD`) es un campo
casi universal en agentes financieros y es una señal de relevancia mucho más débil que una palabra
compartida; esto resolvería el caso insignia SIN tocar T-152-5 (que usa tokens no-numéricos en su
exemplar). **Esta variante (b) no estaba en el brief original del orquestador — se documenta acá
como candidato de diseño para que el Architect la evalúe en F2, no se asume como decisión tomada.**

**Opción 2 — nunca dropear el step terminal del pipeline (última pata, `index === steps.length-1`
del plan pre-filtro):**
Ataca directamente el daño de negocio ("cobra por un resultado parcial inservible"): el step
terminal es típicamente el que entrega el resultado/valor final de un pipeline compuesto
(`passOutput` chain). Protegerlo estructuralmente es robusto independientemente de la vocabulary
trap léxica. Riesgo a evaluar en F2: si el LLM alguna vez arma un plan donde el step terminal SÍ es
el irrelevante genuino (el bug original de WKH-152), esta regla lo conservaría igual — haría
falta confirmar con los tests de regresión de WKH-152 (T-152-1) que ese caso no vuelve a filtrarse
por acá, o acotar la protección a "terminal Y ≥1 step previo ya matcheó" (equivalente a la condición
mixta existente, solo invirtiendo cuál extremo se protege).

**Recomendación del Analyst: 1+2**, tal como sugiere el brief:
- Opción 1 (idealmente la variante quirúrgica (b), exclusión de tokens puramente numéricos, a
  ratificar por el Architect) reduce la frecuencia del "echo trap" sin renunciar por completo al
  input-widening de DT-1.
- Opción 2 agrega una segunda línea de defensa estructural: incluso si algún otro patrón de echo
  léxico (no necesariamente numérico) vuelve a habilitar un drop indebido, el step terminal —el de
  mayor daño de negocio si se pierde— queda protegido.
- Ninguna de las dos, sola, cierra el 100% de la clase de problema (el residual documentado en
  WKH-152 sigue siendo estructuralmente posible con vocabulario no-numérico); la combinación es la
  opción money-safe más razonable sin escalar a embeddings.
- **[NEEDS CLARIFICATION — no bloqueante]**: si el AR de F2 concluye que el drop léxico per-step ya
  no aporta valor neto frente a su tasa de falsos-positivos residual (incluso con 1+2), el fix de
  fondo es WKH-160 (fila 163 del INDEX, embeddings de relevancia semántica, hoy `in progress`,
  scope Fase 1 = infra/shadow-mode sin cambiar `planStatus`/billing). No se asume esa conclusión acá
  — se deja escalada para F2/QA.

## Acceptance Criteria (EARS)

- AC-1: WHEN el goal es `"Send $400 to my mom in Peru"` y el planner LLM selecciona el plan de 3
  agentes de remesa (`agentshop-kyc-validator`, `agentshop-corridor-discoverer`,
  `agentshop-cashout-matcher`), the system SHALL devolver un plan `ready` con los 3 steps intactos
  (ninguno dropeado por el backstop de relevancia).
- AC-2: WHEN el goal es la variante en español `"Enviar 400 dolares a mi mama en Peru"` con el mismo
  plan de 3 agentes, the system SHALL devolver igualmente los 3 steps intactos (mismo resultado
  independiente del idioma del goal).
- AC-3: WHILE el goal es multilingüe respecto al corpus de agentes (p.ej. `"cotiza el precio del
  dolar"` contra agentes descriptos en inglés) Y el plan resultante queda all-disjoint tras el
  filtro, the system SHALL seguir devolviendo `planStatus:'ready'` sin `no_relevant_agent` (CD-15
  heredada de WKH-152/159, sin regresión).
- AC-4: IF el goal es nonsense / sin ningún agente real relevante disponible (todos demo o cero
  overlap en el path greedy), THEN the system SHALL seguir devolviendo `planStatus:'no_relevant_agent'`
  exactamente como hoy (`allStepsAreDemos`/`fallbackNoRelevance`, sin cambios).
- AC-5: the system SHALL NUNCA producir un plan con `steps:[]` como resultado del backstop de
  relevancia del path LLM (invariante MIXED-PLAN-ONLY/CD-15, heredado sin cambios).
- AC-6: WHEN el backstop de relevancia excluye uno o más steps de un plan mixto genuino (caso
  distinto al AC-1/AC-2 — un agente real efectivamente irrelevante mezclado con relevantes, ej.
  T-152-1 de WKH-152), the system SHALL seguir dropeando ese/esos step(s) y recomputando
  `plannedCostUsd`/`step0Slug`/`step0Registry` sobre el primer step sobreviviente (mecanismo de
  WKH-152 AC-4, sin regresión) — el fix de esta HU NO SHALL desactivar el drop para el caso genuino
  que WKH-152 vino a resolver.
- AC-7: the system SHALL mantener débito == ejecución: ningún step (incluidos los conservados por
  esta HU) SHALL debitarse o ejecutarse dos veces, y ningún step dropeado SHALL llegar a
  `budgetService.debit` ni a `composeService.compose`.
- AC-8: the system SHALL mantener el guard 100% determinístico, en memoria, sin llamadas
  adicionales a LLM/red (mismo criterio de costo/latencia que el backstop existente).

## Scope IN
- `src/services/orchestrate.ts` — el bloque del backstop MIXED-PLAN-ONLY (`:869-906` en el HEAD
  actual: `llmFilterApplies`, el corpus per-step `:890-897`, `applyDrop` `:902-906`) y, si el diseño
  elegido en F2 toca el recompute de step-0, el bloque `:707-713` (mismo mecanismo ya usado por
  WKH-152, sin reescribirlo).
- `src/services/orchestrate.test.ts` — casos nuevos: goal insignia EN/ES → 3 steps intactos (AC-1,
  AC-2); regresión explícita del caso mixto genuino de WKH-152 (T-152-1, AC-6); regresión explícita
  del caso all-disjoint multilingüe de WKH-159 (AC-3); reconciliación explícita de T-152-5 (input-
  widening) con el diseño elegido en F2 — si Opción 1 se implementa como remoción total de `input`
  del corpus, T-152-5 debe reformularse/eliminarse con justificación explícita en el SDD, no en
  silencio.

## Scope OUT
- `src/services/discovery.ts` y el broaden-retry de WKH-151 — no se tocan.
- Relevancia semántica por embeddings (WKH-160, fila 163 del INDEX, `in progress`) — fix de fondo
  fuera de esta HU; ver "Fix a escopear" para la nota de escalación no-bloqueante.
- El prompt del planner LLM (`systemPrompt`/`userPrompt`) — el fix es puramente sobre el backstop
  post-plan determinístico, no sobre cómo el LLM arma el plan.
- El fee/split (`protocolFeeUsdc`, splits creator/referral) — esta HU solo decide QUÉ steps
  sobreviven al backstop; el cómputo de fee/split sobre los steps sobrevivientes queda intacto
  (WKH-132/143/143c).
- El fallback greedy (`greedyPlan`/`fallbackNoRelevance`) y `allStepsAreDemos` — ya cubiertos por
  WKH-152/159, no se modifican (AC-3, AC-4).

## Decisiones técnicas (DT-N)
- DT-1: El corpus per-step (`name+description+capabilities+JSON.stringify(input)`) fue confirmado
  como DELIBERADO por WKH-152 (DT-1 de su SDD), no un descuido — el fix de esta HU debe modificarlo
  con ratificación explícita del Architect en F2, no removerlo silenciosamente asumiendo que era un
  bug de implementación.
- DT-2: El "residual conocido" de WKH-152 (`sdd.md:409-417`, "un step válido-pero-disjunto podría
  dropearse si otro step del mismo plan matchea") es la causa raíz exacta de esta HU, ahora
  manifestada en el flujo insignia — F2 debe citar esa sección como precedente y decidir si la
  mitigación 1+2 propuesta acá cierra el caso concreto o si requiere ir más allá (numeric-token
  exclusion u otra variante quirúrgica).
- DT-3: Se prioriza NO tocar el mecanismo de recompute de billing (`plannedCostUsd`/step-0 tras
  filtro parcial) ya implementado por WKH-152 — este fix solo cambia CUÁNDO/QUÉ se dropea, reusando
  el mismo camino de recompute existente si el resultado sigue siendo un plan parcial en algún caso.

## Constraint Directives (CD-N)
- CD-1: PROHIBIDO modificar el débito relativo a los steps efectivamente ejecutados — débito ==
  ejecución se mantiene sin excepción (AC-7).
- CD-2: PROHIBIDO reintroducir el false-negative multilingüe cerrado por WKH-159 — el caso
  all-disjoint SIGUE conservando todos los steps (AC-3, AC-5).
- CD-3: PROHIBIDO que el backstop produzca `steps:[]` bajo cualquier circunstancia del path LLM
  (invariante MIXED-PLAN-ONLY, heredado de WKH-152 CD-15).
- CD-4: PROHIBIDO desactivar el drop para el caso mixto genuino que motivó WKH-152 (un agente real
  efectivamente irrelevante mezclado con relevantes) — el fix debe seguir dropeándolo (AC-6).
- CD-5: OBLIGATORIO que cualquier cambio al corpus/condición del filtro sea 100% determinístico, sin
  llamadas LLM/red adicionales (AC-8).
- CD-6: OBLIGATORIO citar y reconciliar explícitamente en el SDD de F2 los tests existentes que el
  cambio pudiera romper por diseño (T-152-1, T-152-2, T-152-2b, T-152-5, T-152-6, T-152-7 en
  `orchestrate.test.ts`) — no alcanza con "los tests pasan", el AR debe verificar que cada uno sigue
  probando lo que decía probar o fue reformulado con justificación.
- CD-7: PROHIBIDO tocar el prompt del planner LLM o el contrato `LlmPlanAgent`/`selectedAgents`.

## Missing Inputs
- [NEEDS CLARIFICATION — no bloqueante, para F2] Mecanismo exacto de la Opción 1: remoción total de
  `JSON.stringify(input)` del corpus (más simple, rompe T-152-5 por diseño y requiere
  reformularlo/eliminarlo con ratificación) vs. exclusión quirúrgica de tokens puramente numéricos
  (`/^\d+$/`, preserva T-152-5 y el resto del input-widening de DT-1 de WKH-152). El Analyst
  recomienda la variante quirúrgica por menor blast radius, pero la decisión final de diseño queda
  para el Architect en F2 (ver DT-1/DT-2, "Fix a escopear").
- [NEEDS CLARIFICATION — no bloqueante, para F2] Alcance exacto de la Opción 2 ("nunca dropear el
  step terminal"): ¿aplica siempre, o solo cuando además ≥1 step previo del plan matcheó
  léxicamente (para no crear un hueco donde el LLM podría "esconder" un agente irrelevante en la
  posición terminal a salvo del backstop)? El Architect debe verificar contra T-152-1 (caso mixto
  genuino de WKH-152) que la protección del terminal no reintroduce ese over-charge.
- [NEEDS CLARIFICATION — no bloqueante, informativo] Si tras 1+2 el AR/QA de F2-F4 concluye que el
  drop léxico per-step ya no aporta valor neto (tasa de falsos-positivos residual sigue siendo alta
  en producción), el fix de fondo es WKH-160 (embeddings, fila 163 del INDEX). No bloquea esta HU.

## Análisis de paralelismo
- Toca el MISMO archivo y bloque de código (`orchestrate.ts`, backstop MIXED-PLAN-ONLY `:869-906`)
  que WKH-158 (fila 161, retry-on-transient-failure, región distinta: `:656-748` aprox.) y WKH-159
  (fila 162, greedy multilingual guard, región distinta: el bloque de `fallbackNoRelevance`
  `:834-867` aprox.) — riesgo de conflicto de merge BAJO si esas HUs ya mergearon (la evidencia en
  código actual del comentario WKH-159 en `:914-929` sugiere que sí, aunque `_INDEX.md` las marca
  `in progress` — el Architect de F2 debe confirmar el estado real de esas branches antes de
  ramificar esta HU, para partir de un baseline correcto).
- Conflicto de merge MEDIO con WKH-160 (fila 163, embeddings, `in progress`) si su F2 decide tocar
  el mismo bloque `:869-906` — su propio work-item ya advierte "conflicto de merge potencial con
  filas 161/162... recomendado esperar su merge antes de F2". Recomendado: esta HU (bugfix del flujo
  insignia, mayor severidad de negocio) debe priorizarse y mergearse ANTES de que WKH-160 toque ese
  bloque; si WKH-160 sigue acotada a su Fase 1 (infra/shadow-mode, sin tocar `planStatus`/lógica de
  drop), no hay conflicto real.
- No bloquea ninguna otra HU del INDEX fuera de `orchestrate.ts`.
