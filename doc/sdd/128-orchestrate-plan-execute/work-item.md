# Work Item — [WKH-131] Partir /orchestrate en /orchestrate/plan + /orchestrate/execute

> NNN asignado: 128. Título normalizado: orchestrate-plan-execute.
> Fecha: 2026-06-30.

---

## Resumen

Partir el endpoint `POST /orchestrate` atómico en dos endpoints separados:
`POST /orchestrate/plan` (discover + LLM/greedy plan, cero debit) y
`POST /orchestrate/execute` (ejecuta el plan aprobado, capeado al quote).
El objetivo es habilitar el flujo consumer "Yarvis PWA": mostrar un presupuesto
al usuario antes de pedir su aprobación, y sólo entonces cobrar y ejecutar.
El `POST /orchestrate` existente queda byte-idéntico externamente (retrocompat total).

---

## Sizing

- **SDD_MODE:** full
- **Estimación:** L (money-path + refactor de región entrelazada con 6 early-returns + invariantes billing críticas)
- **Clasificación NexusAgil:** QUALITY
- **Branch sugerido:** `feat/128-orchestrate-plan-execute`

---

## Acceptance Criteria (EARS)

### AC-1 — Plan no debita
WHEN `POST /orchestrate/plan` es invocado con `{goal, budget, preferCapabilities?, maxAgents?}`, the system SHALL discover agentes, ejecutar LLM/greedy planning y retornar `{orchestrationId, steps[], costPerStep[], totalCostUsdc, protocolFeeUsdc, maxQuotedCostUsdc, reasoning, consideredAgents, planStatus}` SIN modificar el budget de ninguna agent key (cero debit, cero compose, cero settle on-chain).

### AC-2 — maxQuotedCostUsdc refleja la matemática de augmentX402ChallengeAmount
WHEN `POST /orchestrate/plan` retorna `maxQuotedCostUsdc`, the system SHALL calcular ese valor como `sum(resolvedPricePerStep_i) * (1 + protocolFeeRate)` usando `resolveAgentPriceUsdc` (services/agent-price.ts) — la misma función y lógica de fallback que usa `augmentX402ChallengeAmount` en routes/compose.ts — para que el quote nunca driftee del monto real que se cobraría en execute.

### AC-3 — Execute capeado al quote
WHEN `POST /orchestrate/execute` recibe `{orchestrationId, steps, maxQuotedCostUsdc}`, the system SHALL re-resolver server-side el precio de cada agente vía `resolveAgentPriceUsdc` y rechazar con `409 QUOTE_STALE` + body `{error_code:"QUOTE_STALE", currentCostUsdc, maxQuotedCostUsdc}` si `currentCostUsdc > maxQuotedCostUsdc`, SIN debitar ni settlear nada.

### AC-4 — Execute NO confía en precios del cliente
WHEN `POST /orchestrate/execute` es invocado, the system SHALL determinar el costo real del pipeline exclusivamente desde `resolveAgentPriceUsdc` server-side, ignorando cualquier precio o campo de costo enviado por el cliente en el body de la request.

### AC-5 — QUOTE_STALE no debita
IF el re-precio server-side en `POST /orchestrate/execute` produce `currentCostUsdc > maxQuotedCostUsdc`, THEN the system SHALL retornar `409 QUOTE_STALE` sin haber modificado el budget de ninguna agent key (cero debit).

### AC-6 — Early-returns del planner mapean a planStatus sin perder telemetría
WHEN `POST /orchestrate/plan` encuentra alguna de las condiciones de early-return del orchestrateService actual (no-funds, no-agents, no-budget-fit, no_relevant_agent), the system SHALL retornar `planStatus` con el valor discriminador correspondiente (`insufficient_funds` | `no_agents` | `budget_exhausted` | `no_relevant_agent`) Y disparar `eventService.track` con los mismos campos y condiciones que el orchestrateService dispara hoy para esos early-returns.

### AC-7 — Invariante anti-double-charge preservada
WHILE `POST /orchestrate/execute` delega a `composeService.compose`, the system SHALL mantener el guard `i>0` (compose debita steps 1..N; el debit del step-0 es responsabilidad del route/service de execute — NO de compose) idéntico al comportamiento actual del `POST /orchestrate` atómico.

### AC-8 — Credit-back on failure preservado
WHEN `POST /orchestrate/execute` completa con `pipeline.success === false`, the system SHALL aplicar el mismo mecanismo credit-back (WKH-127) que el `orchestrateService.orchestrate` aplica hoy: refund completo si `totalCostUsdc === 0`, refund parcial `plannedCostUsd - pipeline.totalCostUsdc` si `totalCostUsdc > 0`, encolar en `refundOutbox` si el credit falla.

### AC-9 — Fee preservado en execute
WHEN `POST /orchestrate/execute` ejecuta exitosamente (`pipeline.success === true`), the system SHALL cobrar el 1% protocol fee mediante `chargeProtocolFee` con idempotencia por `orchestrationId`, emitir receipt via `receiptService.emit` y setear `protocolFeeUsdc` en la respuesta — idéntico al comportamiento actual del orchestrate atómico.

### AC-10 — POST /orchestrate atómico byte-idéntico
WHILE `POST /orchestrate/plan` y `POST /orchestrate/execute` coexisten, the system SHALL mantener `POST /orchestrate` con comportamiento externamente idéntico al actual: mismo schema de request, misma estructura de response, mismos headers (`x-debit-fallback`, `x-a2a-remaining-budget`), mismos HTTP status codes.

### AC-11 — Gas overhead preservado en execute
WHEN `POST /orchestrate/execute` debita el step-0, the system SHALL incluir el gas overhead via `getStepGasOverheadUsd(chainId)` en el monto debitado del step-0, igual que `orchestrateService.orchestrate` lo hace hoy (audit 2026-06-25).

### AC-12 — Plan requiere auth válida
WHEN `POST /orchestrate/plan` es invocado sin credenciales válidas (sin `x-a2a-key` o Bearer o x402), the system SHALL retornar `401` o `402` según el path de auth, idéntico al comportamiento del `POST /orchestrate` actual — el plan no es un endpoint público sin auth.

### AC-13 — planStatus en plan response
WHEN `POST /orchestrate/plan` retorna con un plan ejecutable, the system SHALL incluir `planStatus: "ready"` en la respuesta para que el cliente consumer pueda distinguir el caso "listo para ejecutar" de los early-return cases (AC-6).

---

## Scope IN

| Archivo / Módulo | Qué se toca |
|---|---|
| `src/routes/orchestrate.ts` | Agregar rutas `/plan` y `/execute`; mantener `/` intacto |
| `src/services/orchestrate.ts` | Extraer la fase de planning (discover + llmPlan/greedyPlan + early-returns) como función/método reutilizable; la fase de execute (debit-step0 + compose + fee + refund) también extraíble para `/execute` y el atómico |
| `src/types/index.ts` | Nuevos tipos: `OrchestratePlanRequest`, `OrchestratePlanResult` (incluye `planStatus`, `steps[]`, `costPerStep[]`, `totalCostUsdc`, `protocolFeeUsdc`, `maxQuotedCostUsdc`, `reasoning`, `consideredAgents`), `OrchestrateExecuteRequest`, `OrchestrateExecuteResult` |
| `src/services/agent-price.ts` | Solo lectura — reusar `resolveAgentPriceUsdc` tal cual en el plan (price-per-step) |
| `test/` | Tests nuevos para `/orchestrate/plan` (happy path + cada early-return + no-debit) y `/orchestrate/execute` (happy path + QUOTE_STALE + fee + refund) |

## Scope OUT

- NO modificar `POST /orchestrate` (atómico) — zero-touch, retrocompat total
- NO modificar `src/services/compose.ts` — el guard `i>0` queda intacto
- NO modificar `src/routes/compose.ts` ni `augmentX402ChallengeAmount`
- NO modificar `src/services/agent-price.ts`
- NO modificar la lógica de `refundOutbox`, `receiptService`, `budgetService`
- NO exponer endpoint público sin auth para el plan
- NO persistir el plan en DB en esta HU (el `orchestrationId` del plan se opaquea en el response y el execute lo recibe; si se necesita validación server-side del orchestrationId contra un plan guardado → WKH futura, marcar [NEEDS CLARIFICATION] en F2)
- NO implementar expiración de quotes en esta HU (TTL del quote → WKH futura)
- NO cambiar el modelo de cobranza de deleg/session keys — el scope es el path master Agent Key + x402

---

## Decisiones Técnicas Iniciales (DT-N)

**DT-1 — Refactor-in-place vs. camino nuevo liviano**
Decisión PENDIENTE para el Architect (F2). Dos opciones:

- *Opción A — Refactor-in-place*: extraer `planPhase(...)` y `executePhase(...)` del `orchestrateService.orchestrate` actual como funciones internas reutilizables; el atómico las llama en secuencia; `/plan` llama solo `planPhase`; `/execute` llama solo `executePhase`. Ventaja: un único lugar de verdad para la lógica de billing/telemetría; mínimo riesgo de drift. Riesgo: el entrelazado de los 6 early-returns hace la extracción no-trivial (ver Riesgos).

- *Opción B — Camino nuevo liviano*: implementar `/plan` como una versión lightweight de orchestrate que sólo hace discover + LLM/greedy + price-resolution (sin tocar el orchestrateService actual), y `/execute` como un thin wrapper que valida el cap y llama `orchestrateService.orchestrate` con los steps pre-resueltos. Ventaja: zero-touch al orquestador actual. Riesgo: drift de precio entre plan y execute si no se comparte la resolución de precio.

El Architect debe recomendar cuál minimiza el riesgo de billing drift y es verificable por el Adversary. **Esta HU no pre-selecciona.**

**DT-2 — Persistencia del orchestrationId del plan**
La HU no persiste el plan en DB. El execute recibe el plan (steps + maxQuotedCostUsdc) del cliente y re-resuelve server-side los precios (AC-3/AC-4). El orchestrationId del plan es opaco para el servidor en execute — se usa para telemetría y fee idempotency, no para validar que el plan no fue alterado. Si el Architect considera que la ausencia de persistencia crea un vector de manipulación del `steps[]` (el cliente puede enviar pasos distintos en execute), debe elevar a [NEEDS CLARIFICATION] y proponer guardar el plan en Redis/DB con TTL. Esta HU asume: la defensa es la re-resolución de precios server-side (AC-4) + el cap (AC-3), no la autenticación del plan.

**DT-3 — planStatus discriminators**
Los 6 early-returns del orchestrateService actual se mapean a `planStatus`:
`insufficient_funds` | `no_agents` | `budget_exhausted` | `no_relevant_agent` | `ready`.
El Architect debe confirmar si agregar `circuit_open` (cuando el LLM circuit breaker está abierto y el greedy también falla) es necesario en esta HU o puede diferirse.

**DT-4 — Auth en /plan**
`/plan` usa los mismos preHandlers que `/orchestrate`: `requireForwardKey`, backpressure, timeout, `markSkipMiddlewareDebitHandler`, `requirePaymentOrA2AKey`. El rate limit puede ser el mismo `orchestrateRateLimit()` o uno separado. El Architect decide en F2.

---

## Constraint Directives (CD-N)

**CD-1 — PROHIBIDO debitar o settlear en /plan**
`POST /orchestrate/plan` NUNCA debe llamar `budgetService.debit`, `composeService.compose`, ni ninguna función que mueva fondos on-chain o en ledger.

**CD-2 — PROHIBIDO confiar en precios del cliente en /execute**
`POST /orchestrate/execute` NUNCA usa los precios del campo `costPerStep` del body del cliente como base del cobro real. Solo `resolveAgentPriceUsdc` server-side.

**CD-3 — PROHIBIDO modificar el guard i>0 de compose**
El guard anti-double-charge `i>0` en `composeService.compose` es intocable. El debit del step-0 en execute se hace en el route/service de execute, igual que hoy en orchestrateService.

**CD-4 — OBLIGATORIO mantener POST /orchestrate byte-idéntico externamente**
Ninguna modificación al route `/` ni al resultado de `orchestrateService.orchestrate` para las llamadas que ya existen. Tests de regresión deben pasar sin cambios.

**CD-5 — OBLIGATORIO preservar todos los eventService.track de early-returns**
Cada early-return del plan (AC-6) que hoy dispara `eventService.track` en el orchestrateService atómico DEBE seguir disparándolo en el path `/plan`. Ningún evento de telemetría debe perderse.

**CD-6 — OBLIGATORIO preservar debit/refund/fee invariantes de execute**
El path `/execute` debe respetar: debit step-0 + gas overhead antes de compose; credit-back on failure (WKH-127); fee post-compose exitoso (WKH-124); encolar en refundOutbox si credit falla; header `x-debit-fallback` si plannedCost===0; header `x-a2a-remaining-budget` post-execute.

**CD-7 — PROHIBIDO exponer /plan sin auth**
`POST /orchestrate/plan` requiere la misma auth que `POST /orchestrate`. No existe versión pública sin credenciales.

**CD-8 — TypeScript strict**
Sin `any` explícito. Los nuevos tipos `OrchestratePlanResult` y `OrchestrateExecuteRequest` deben ser interfaces tipadas en `src/types/index.ts`.

---

## Missing Inputs

| Ítem | Estado |
|---|---|
| ¿El execute debe validar que el `orchestrationId` del plan fue emitido por el mismo owner? Si no se guarda en DB, un cliente puede enviar un orchestrationId inventado. | [NEEDS CLARIFICATION — resolver en F2; la defensa actual es re-resolución de precios server-side, AC-4] |
| ¿TTL del quote? ¿Debe el execute rechazar con `QUOTE_EXPIRED` si el quote tiene más de N minutos? | [NEEDS CLARIFICATION — resolver en F2; esta HU no define TTL; puede ser WKH futura] |
| ¿El rate limit de /plan es el mismo `orchestrateRateLimit()` o separado? | [Resolver en F2 — inclinación: mismo rate limit para evitar amplificación vía plan-spam] |
| `planStatus: "circuit_open"` — ¿es necesario en esta HU o diferible? | [Resolver en F2] |

---

## Análisis de Paralelismo

- **Esta HU NO bloquea** otras HUs activas (el `POST /orchestrate` atómico queda intacto).
- **Esta HU es aditiva**: agrega rutas nuevas bajo `/orchestrate/plan` y `/orchestrate/execute`; el atómico sigue siendo el camino del SDK.
- **Riesgo de conflicto**: si otra HU modifica `src/services/orchestrate.ts` (billing, fallback, telemetría) mientras esta está en F3, habrá conflicto de merge. Coordinación necesaria.
- **Dependencia upstream**: esta HU es prerequisito del flujo consumer "Yarvis PWA" (WKH futura). No bloquea a nadie actual.
- **Puede ir en paralelo con**: HUs de docs, UI, o cualquier HU que no toque `src/services/orchestrate.ts` ni `src/routes/orchestrate.ts`.

---

## Riesgos Capturados (para el Architect en F2)

**RIESGO-1 — Entrelazado de 6 early-returns en orchestrateService**
La región `src/services/orchestrate.ts:302-634` tiene 6 early-returns (no-funds ~L337-378, no-agents ~L395-426, no-budget-fit ~L540-571, no_relevant_agent ~L587-626, debit-fail ~L669-714, pre-compose timeout ~L450-455 y ~L629-634) cada uno construyendo un `OrchestrateResult` Y disparando `eventService.track`. No se extraen "limpio" sin riesgo de perder side-effects. El Architect debe mapear explícitamente qué hace cada early-return en el plan vs. en el execute.

**RIESGO-2 — Price drift entre plan y execute**
Si el plan resuelve precios en T=0 y el execute re-resuelve en T=N, puede haber drift. El cap `maxQuotedCostUsdc` + el `QUOTE_STALE` (AC-3/AC-5) son la defensa. Pero si el TTL del cache de agent-price (60s en agent-price.ts) hace que el execute use un precio cacheado del plan, el re-precio no detectará el cambio real. El Architect debe evaluar si es aceptable o si se debe forzar cache-bust en execute.

**RIESGO-3 — Steps manipulables por el cliente en execute**
Sin persistencia del plan en DB, el cliente puede enviar `steps[]` distintos en execute (agentes distintos, distinta cantidad). La defensa es AC-4 (re-precio server-side) + AC-3 (cap). Pero el cliente podría enviar un step de agente más barato y ejecutar algo no planificado. Si se requiere integridad del plan, se necesita persistencia (Redis + TTL). El Architect debe decidir si esta HU lo requiere o si queda como WKH futura.

**RIESGO-4 — skipMiddlewareDebit en /execute**
El `POST /orchestrate` actual usa `markSkipMiddlewareDebitHandler` para que el middleware no debite el placeholder $1 (WKH-127). El path `/execute` necesita el mismo mecanismo para el debit real del step-0. Si se olvida el `markSkipMiddlewareDebit`, el middleware debita $1 adicional (double-charge). El Architect debe asegurarse que el preHandler de `/execute` incluya este handler.

---

## Referencias de código (líneas actuales, para el Architect)

| Región | Archivo | Rango aproximado | Qué es |
|---|---|---|---|
| early-return no-funds | `src/services/orchestrate.ts` | L337-378 | Balance insuficiente; track + return noFundsResult |
| early-return no-agents | `src/services/orchestrate.ts` | L395-426 | Discovery vacío; track + return emptyResult |
| early-return no-budget-fit (steps.length===0) | `src/services/orchestrate.ts` | L540-571 | Todos los agentes superan budget; track + return noBudgetResult |
| early-return no_relevant_agent | `src/services/orchestrate.ts` | L587-626 | Plan sólo con demos; track + return noRelevantResult |
| debit + debit-fail | `src/services/orchestrate.ts` | L639-717 | Debit step-0 (planCostUsd + gasOverhead); fallo → return debitFailResult |
| compose call + fee + refund | `src/services/orchestrate.ts` | L719-903 | Execute real; fee + credit-back + track final |
| augmentX402ChallengeAmount | `src/routes/compose.ts` | L127-178 | Suma precios steps con fee → challenge amount (espejo para maxQuotedCostUsdc) |
| resolveAgentPriceUsdc | `src/services/agent-price.ts` | L40-63 | Cache 60s + re-fetch; fuente canónica de precios |
| markSkipMiddlewareDebitHandler | `src/routes/orchestrate.ts` | L31-35 | Flag para skipear el debit del middleware |
| OrchestrateResult | `src/types/index.ts` | L418-436 | Tipo de respuesta actual del orchestrate atómico |
