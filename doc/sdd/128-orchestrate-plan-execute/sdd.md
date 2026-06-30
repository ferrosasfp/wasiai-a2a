# SDD #128: /orchestrate/plan + /orchestrate/execute — flujo consumer quote-antes-de-aprobar (WKH-131)

> SPEC_APPROVED: no
> Fecha: 2026-06-30
> Tipo: feature (refactor de región money-path + 2 rutas nuevas)
> SDD_MODE: full
> Branch: feat/128-orchestrate-plan-execute
> Artefactos: doc/sdd/128-orchestrate-plan-execute/
> Work Item: doc/sdd/128-orchestrate-plan-execute/work-item.md (HU_APPROVED)

---

## 1. Resumen

Partir el endpoint atómico `POST /orchestrate` en dos endpoints separados que comparten la misma lógica de planning y de execute:

- `POST /orchestrate/plan` — discover + LLM/greedy planning + price-resolution. **Cero debit, cero compose, cero settle.** Devuelve un quote (`maxQuotedCostUsdc`) y un `planStatus` discriminador para que el cliente consumer (Yarvis PWA) muestre un presupuesto antes de pedir aprobación.
- `POST /orchestrate/execute` — recibe el plan aprobado + el cap `maxQuotedCostUsdc`, re-resuelve precios server-side, rechaza con `409 QUOTE_STALE` si el precio drifteó por encima del cap, y si no, ejecuta el pipeline real (debit step-0 + compose + fee + credit-back), idéntico al atómico.

El `POST /orchestrate` atómico queda **byte-idéntico externamente** (CD-4): mismo schema, misma respuesta, mismos headers, mismos status codes. La estrategia central (DT-1) es **refactor-in-place**: se extraen dos funciones internas puras del `orchestrateService.orchestrate` actual (`planOrchestration` y `executeApprovedPlan`); el atómico las compone en secuencia, `/plan` llama solo a la primera, `/execute` llama a la segunda con el plan ya resuelto. Un único lugar de verdad para billing y telemetría ⇒ riesgo de drift mínimo y verificable por el Adversary comparando la composición vs el original.

Resultado esperado: 3 caminos HTTP (`/`, `/plan`, `/execute`) sobre **una sola** implementación de planning y **una sola** de execute.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 128 (WKH-131) |
| **Tipo** | feature / refactor money-path |
| **SDD_MODE** | full |
| **Objetivo** | Habilitar quote-antes-de-aprobar partiendo `/orchestrate` en `/plan` (sin debit) + `/execute` (capeado al quote), sin tocar el atómico ni el guard `i>0` de compose. |
| **Reglas de negocio** | El cobro real NUNCA confía en el cliente (AC-4); el quote refleja la matemática de `augmentX402ChallengeAmount` (AC-2); todos los `eventService.track` de early-returns se preservan (CD-5); invariantes WKH-127/124/61/102 intactas. |
| **Scope IN** | `src/services/orchestrate.ts`, `src/routes/orchestrate.ts`, `src/types/index.ts`, tests nuevos. |
| **Scope OUT** | `POST /orchestrate` atómico (zero-touch externo), `compose.ts` (guard `i>0`), `compose.ts` route, `agent-price.ts`, `refundOutbox`, `receiptService`, `budgetService`. NO persistir plan en DB. NO TTL de quote. NO deleg/session model change. |
| **Missing Inputs** | Resueltos en §10 (DT-2, DT-3, RIESGO-2/4, rate-limit). |

### Acceptance Criteria (EARS)

Los 13 ACs se heredan literales del work-item §"Acceptance Criteria (EARS)". No se reescriben aquí; el mapeo AC→implementación vive en §4.1 y AC→test en §11.

| AC | Resumen | Cubierto por |
|----|---------|--------------|
| AC-1 | `/plan` no debita | `planOrchestration` pura (sin budget/compose) — §4.3.1 |
| AC-2 | `maxQuotedCostUsdc` = espejo de `augmentX402ChallengeAmount` | `quoteMaxCostUsdc` helper — §4.3.4 |
| AC-3 | execute capeado → `409 QUOTE_STALE` | `executeApprovedPlan` re-precio + cap gate — §4.3.5 |
| AC-4 | execute no confía en precios cliente | re-resolución server-side vía `resolveAgentPriceUsdc` — §4.3.5 |
| AC-5 | QUOTE_STALE no debita | gate ANTES de `debitStep0` — §4.4 flujo |
| AC-6 | early-returns → planStatus + track | tabla §4.6 (mapeo 6 early-returns) |
| AC-7 | guard `i>0` preservado | compose intacto (CD-3) — §4.3.5 |
| AC-8 | credit-back on failure | `executeApprovedPlan` reusa bloque WKH-127 — §4.3.5 |
| AC-9 | fee + receipt en execute | `executeApprovedPlan` reusa bloque WKH-44/124 — §4.3.5 |
| AC-10 | atómico byte-idéntico | `orchestrate()` = `plan()` + `execute()` compuestos — §4.3.6 |
| AC-11 | gas overhead en step-0 | `debitStep0` incluye `getStepGasOverheadUsd` — §4.3.5 |
| AC-12 | `/plan` requiere auth | preHandlers idénticos a `/` (DT-4) — §4.7 |
| AC-13 | `planStatus: "ready"` en plan | `OrchestratePlanResult.planStatus` — §4.3.3 |

## 3. Context Map (Codebase Grounding)

### Archivos leídos

| Archivo | Por qué | Patrón / hallazgo extraído |
|---------|---------|----------------------------|
| `src/services/orchestrate.ts:302-904` | Es TODO el cuerpo a refactorizar | `orchestrate()` es una única función larga. Región planning: L306-634 (fee-precheck, no-funds, discover, no-agents, LLM/greedy, no-budget, no-relevant, timeouts). Región execute: L636-902 (price-fallback $1, debit step-0 + gas, debit-fail, compose, fee+receipt, credit-back, remaining, track final). 6 early-returns con `eventService.track` propio. |
| `src/services/orchestrate.ts:329-332` | Gate del path billable | `billingKeyRow` = `undefined` si hay deleg/session; sino `scopingKeyRow`. Solo el path master billable debita/refunda en el service. x402/deleg/session se saltan TODO el billing del service. |
| `src/services/orchestrate.ts:316-322` | Fee math + safety guard | `feeRate = getProtocolFeeRate()`, `feeUsdc = budget*rate`; si `feeUsdc>budget` → `ProtocolFeeError` (→ 400). Esto corre ANTES de discovery (parte de planning). |
| `src/services/orchestrate.ts:443-538` | Selección step-0 cost | `plannedCostUsd` = precio del **step-0** (NO suma del plan) — auto-blindaje WKH-127 BLQ-ALTO-1 (double-charge). Greedy: `selected[0]?.priceUsdc`. LLM: `discovered.agents.find(slug===budgetedAgents[0])?.priceUsdc`. |
| `src/routes/orchestrate.ts:18-141` | PreHandlers + headers + status | Schema body, cadena `requireForwardKey → backpressure → timeout → markSkipMiddlewareDebitHandler → requirePaymentOrA2AKey`. Headers `x-debit-fallback` (de `result.debitFallback`), `x-a2a-remaining-budget` (de `result.remainingBudgetUsd`). Status `SCOPE_DENIED→403`, else 200. `orchestrationId = crypto.randomUUID()` en el route. |
| `src/routes/orchestrate.ts:31-35` | skip middleware debit | `markSkipMiddlewareDebitHandler` setea `request.skipMiddlewareDebit=true` ANTES de `requirePaymentOrA2AKey`. Imprescindible para que el middleware NO debite el placeholder $1 (el service debita el step-0 real). |
| `src/routes/compose.ts:127-178` | Matemática del quote (espejo AC-2) | `augmentX402ChallengeAmount`: `pipelineUsd = step0Usd + Σ_{i≥1} resolveAgentPriceUsdc(step) con fallback PLACEHOLDER_FEE_USD`; `total = (pipelineUsd * (1+getProtocolFeeRate())).toFixed(6)`; floor a `1e-6` si redondea a 0 con `pipelineUsd>0`. Step malformado → suma `PLACEHOLDER_FEE_USD` (over-estimate, never undercharge). |
| `src/services/agent-price.ts:40-63` | Fuente canónica de precio | `resolveAgentPriceUsdc(slug, registry?)` con cache Map TTL 60s; miss/expirado → `discoveryService.getAgent` + cachea; agente no existe → `null` SIN cachear. `_resetAgentPriceCache()` test-only L99. |
| `src/services/compose.ts:150-218` | Guard `i>0` + maxBudget | `if (i > 0 && scopingKeyRow && chainId !== undefined)` debita steps 1..N (CD-3, intocable). `maxBudget` chequeado per-step con gas overhead (L158-161). Compose es la única capa que cobra 1..N. |
| `src/types/index.ts:387-436` | Tipos existentes | `OrchestrateRequest` (L387-416, ya tiene goal/budget/preferCapabilities/maxAgents/a2aKey/scopingKeyRow/delegationContext/keySessionContext/chainId). `OrchestrateResult` (L418-436). Nuevos tipos van acá. |
| `src/lib/pricing-constants.ts:16` | Placeholder fee | `PLACEHOLDER_FEE_USD = 1.0`. Usado en el espejo del quote y en el fallback del step-0. |
| `src/middleware/rate-limit.ts:52-58` | Rate limit | `orchestrateRateLimit()` lee `RATE_LIMIT_ORCHESTRATE_MAX` (default 10) / `RATE_LIMIT_WINDOW_MS`. |
| `src/index.ts` (registro) | Prefijo de rutas | `orchestrateRoutes` se registra con `{ prefix: '/orchestrate' }`. Una ruta `/plan` dentro del plugin mapea a `/orchestrate/plan`. |
| `src/routes/orchestrate.test.ts:1-180` | Harness route | Mockea `a2a-key` (pass-through `a2aKeyRow`), `timeout`/`rate-limit`/`backpressure` (no-ops), `orchestrateService` (controlado). `app.register(orchestrateRoutes, { prefix: '/orchestrate' })`. Inyecta header `x-a2a-key`. |
| `src/services/orchestrate.billing.test.ts:1-80` | Harness billing (compose REAL) | Mockea capa de borde (budget.debit/credit/getBalance, discovery, event, fee-charge, registry, downstream) pero ejecuta **compose real** para contar débitos exactos. **Patrón clave del invariante total** (auto-blindaje WKH-127). |
| `doc/sdd/125-wkh-127-orchestrate-billing/auto-blindaje.md` | Lecciones billing | (1) Mover un débito entre capas rompe tests de conteo NO listados en Scope. (2) "débito = suma del plan" es double-charge: el débito de cada capa debe ser **disjunto**; testear el invariante total con compose REAL. |
| `doc/sdd/127-wkh-130-adaptive-input-retry/auto-blindaje.md` | Lecciones test infra | `vi.mock` factory con clases/const top-level → usar `vi.hoisted`. Correr `biome check --write` por wave. |

### Exemplars

| Para crear/modificar | Seguir patrón de | Razón |
|----------------------|------------------|-------|
| `OrchestratePlanResult` / `OrchestrateExecuteRequest` en `types/index.ts` | `OrchestrateResult` (`types/index.ts:418-436`) | Mismo estilo de interface tipada, campos opcionales con `?`, JSDoc por campo. |
| Rutas `/plan` y `/execute` en `routes/orchestrate.ts` | Ruta `/` en el mismo archivo (`routes/orchestrate.ts:38-141`) | Mismo plugin, misma cadena de preHandlers, mismo manejo de headers/status, mismo `crypto.randomUUID()`. |
| `quoteMaxCostUsdc` helper | `augmentX402ChallengeAmount` (`routes/compose.ts:127-178`) | Espejo EXACTO de la matemática del quote (AC-2). MISMA función `resolveAgentPriceUsdc`, MISMO fallback, MISMO `(1+rate)` + `.toFixed(6)`. |
| Funciones extraídas `planOrchestration`/`executeApprovedPlan` | El cuerpo actual de `orchestrate()` partido en L634/L636 | El refactor es un split por la línea natural entre planning y execute; conserva cada bloque verbatim. |
| Test de `/plan` y `/execute` (route) | `routes/orchestrate.test.ts` | Mismo harness Fastify + mocks de middleware/service. |
| Test de billing de `/execute` (compose real) | `services/orchestrate.billing.test.ts` | Único patrón que valida el invariante total de débitos sin mock de compose. |

### Estado de BD relevante

| Tabla | Existe | Relevancia |
|-------|--------|------------|
| (ninguna) | — | **No hay cambios de BD.** El plan NO se persiste (DT-2). `a2a_agent_keys` se lee/debita vía `budgetService` ya existente. |

### Componentes reutilizables encontrados

- `resolveAgentPriceUsdc` (`agent-price.ts:40`) — reusar tal cual en plan y execute (price resolution canónica).
- `getProtocolFeeRate` / `chargeProtocolFee` / `ProtocolFeeError` (`fee-charge.ts`) — reusar; no inventar fee math.
- `getStepGasOverheadUsd` (`lib/gas-overhead.js`) — reusar para gas en step-0.
- `PLACEHOLDER_FEE_USD` (`pricing-constants.ts`) — reusar para fallback step-0 y over-estimate del quote.
- `markSkipMiddlewareDebitHandler` (`routes/orchestrate.ts:31`) — reusar en `/plan` (skip debit, pero sin debit real luego) y en `/execute` (skip placeholder, debit real en service).
- `eventService.track` — reusar; cada track se preserva (CD-5).

## 4. Diseño Técnico

### 4.1 Archivos a crear/modificar

| Archivo | Acción | Qué hace | AC cubiertos | Exemplar |
|---------|--------|----------|--------------|----------|
| `src/types/index.ts` | Modificar | Agregar `OrchestratePlanResult`, `OrchestrateExecuteRequest`. Reusar `OrchestrateResult` para execute. | AC-1, AC-13, CD-8 | `OrchestrateResult` L418 |
| `src/services/orchestrate.ts` | Modificar | Extraer `planOrchestration()` y `executeApprovedPlan()`; recomponer `orchestrate()`; agregar `quoteMaxCostUsdc()`. | AC-1..AC-11 | cuerpo actual de `orchestrate()` |
| `src/routes/orchestrate.ts` | Modificar | Agregar rutas `/plan` y `/execute` (el `/` queda intacto). | AC-3, AC-5, AC-10, AC-12, RIESGO-4 | ruta `/` L38 |
| `src/services/orchestrate.test.ts` | Modificar | Tests `/plan` + `/execute` con compose mockeado (early-returns, planStatus, no-debit, QUOTE_STALE). | AC-1,2,3,4,5,6,13 | archivo existente |
| `src/services/orchestrate.billing.test.ts` | Modificar | Tests de `/execute` con **compose real** (invariante total de débitos, fee, refund, gas). | AC-7,8,9,11 | archivo existente |
| `src/routes/orchestrate.test.ts` | Modificar | Tests de route `/plan` (auth, no-debit headers) y `/execute` (status, headers). | AC-10, AC-12 | archivo existente |

### 4.2 Modelo de datos

N/A — no hay cambios de BD. El `orchestrationId` del plan NO se persiste (DT-2). El cliente lo recibe en la respuesta del plan y lo reenvía en execute, donde se usa **solo** para idempotencia del fee y telemetría — NO para autenticar integridad del plan.

### 4.3 Componentes / Servicios

El refactor produce, dentro de `orchestrateService`, dos funciones internas + un helper:

#### 4.3.1 `planOrchestration(request, orchestrationId): Promise<OrchestratePlanResult>`

Contiene **verbatim** la región de planning del `orchestrate()` actual (`orchestrate.ts:306-634`), terminando justo después del segundo timeout pre-compose (L634), con dos diferencias:

1. Donde hoy un early-return devuelve un `OrchestrateResult`, ahora devuelve un `OrchestratePlanResult` con el `planStatus` discriminador correspondiente (tabla §4.6) y **dispara el mismo `eventService.track`** (CD-5). NO debita, NO compone, NO settlea (CD-1).
2. Cuando el plan es ejecutable (llega al final de la región sin early-return), devuelve `planStatus: "ready"` (AC-13) más los campos del plan (`steps`, `costPerStep`, `totalCostUsdc`, `maxQuotedCostUsdc`, `reasoning`, `consideredAgents`, `protocolFeeUsdc`) calculados como en §4.3.3-4.3.4.

> **Decisión sobre fee-precheck (orchestrate.ts:316-322):** el guard `feeUsdc > budget → ProtocolFeeError` vive en `planOrchestration` (es parte de planning, corre antes de discovery). En `/plan` propaga el throw → la error-boundary del route lo mapea a 400, igual que hoy en el atómico. En execute NO se re-chequea (ya pasó en plan); pero el atómico, al componer plan→execute, lo ejecuta una sola vez en plan (AC-10 preservado: mismo punto de fallo).

> **Importante (no-debit en plan):** el bloque no-funds early-fail (`orchestrate.ts:336-378`) hace `budgetService.getBalance` (lectura, NO debit). Esto se preserva en `planOrchestration` — getBalance es read-only y no viola CD-1. El `/plan` SÍ lee balance para el discriminador `insufficient_funds` (AC-6), pero NUNCA escribe.

#### 4.3.2 `executeApprovedPlan(request, plan, orchestrationId): Promise<OrchestrateResult>`

Contiene **verbatim** la región de execute del `orchestrate()` actual (`orchestrate.ts:636-902`): price-fallback $1, debit step-0 + gas (`debitStep0`), debit-fail early-return, `composeService.compose`, fee + receipt, credit-back (WKH-127), remaining budget, track final. Recibe el `plan` (los `steps`, `plannedCostUsd`, `billingKeyRow`-equivalente, `feeUsdc`, `usedFallback`, `reasoning`, `consideredAgents`, `debitFallback`) que produjo `planOrchestration`.

**Adición específica de esta HU (AC-3/AC-4/AC-5) — re-precio + cap gate, ANTES de cualquier débito:**

Al entrar a `executeApprovedPlan` por la vía `/execute` (no por el atómico), antes del price-fallback y del `debitStep0`:

```
currentCostUsdc = quoteMaxCostUsdc(plan.steps, /* forceRefresh */ true)
if (currentCostUsdc > request.maxQuotedCostUsdc) {
  return { __quoteStale: true, currentCostUsdc, maxQuotedCostUsdc }  // no debit, no compose
}
```

El route mapea `__quoteStale` a `409 QUOTE_STALE` (§4.7). En el path atómico (`orchestrate()`), el cap gate **NO corre** (no hay `maxQuotedCostUsdc` del cliente) → comportamiento byte-idéntico (AC-10).

> **CD-4 (byte-idéntico):** `executeApprovedPlan` recibe un flag/ausencia que distingue "vine del atómico" vs "vine de /execute". En el atómico, NO se aplica el cap gate ni se re-resuelve precio (el plan ya trae los precios resueltos en el mismo request); en `/execute`, sí. La firma exacta usa `request.maxQuotedCostUsdc?: number | undefined` — `undefined` ⟹ path atómico, salta el gate.

#### 4.3.3 `OrchestratePlanResult` (tipo nuevo)

```ts
export type OrchestratePlanStatus =
  | 'ready'
  | 'insufficient_funds'
  | 'no_agents'
  | 'budget_exhausted'
  | 'no_relevant_agent';
// circuit_open: DIFERIDO (DT-3). Ver §10.

export interface OrchestratePlanResult {
  orchestrationId: string;
  planStatus: OrchestratePlanStatus;
  steps: ComposeStep[];           // [] en early-returns
  costPerStep: number[];          // precio resuelto por step (server-side); [] en early-returns
  totalCostUsdc: number;          // sum(costPerStep) — informativo, NO base del débito
  protocolFeeUsdc: number;        // feeUsdc = budget * rate (espejo del atómico)
  maxQuotedCostUsdc: number;      // §4.3.4 (cap del execute)
  reasoning: string;
  consideredAgents: Agent[];
  // Campos internos que executeApprovedPlan necesita del plan (NO se serializan
  // al cliente; el route hace pick de los públicos). Ver §4.3.7.
}
```

> El `costPerStep[]` se calcula con `resolveAgentPriceUsdc` por step (server-side, AC-2). En early-returns (sin plan ejecutable) es `[]`.

#### 4.3.4 `quoteMaxCostUsdc(steps, forceRefresh): Promise<number>` (helper — espejo de AC-2)

Réplica EXACTA de la matemática de `augmentX402ChallengeAmount` (`routes/compose.ts:127-178`), pero sumando **todos** los steps (no step0Usd + 1..N, porque acá no hay un step-0 ya resuelto por el middleware):

```
pipelineUsd = 0
for step in steps:
  if step malformado: pipelineUsd += PLACEHOLDER_FEE_USD; continue
  price = resolveAgentPriceUsdc(step.agent, step.registry)   // forceRefresh → ver RIESGO-2
  pipelineUsd += (price > 0 && !NaN) ? price : PLACEHOLDER_FEE_USD
total = Number((pipelineUsd * (1 + getProtocolFeeRate())).toFixed(6))
if (total <= 0 && pipelineUsd > 0) return 0.000001   // floor never-undercharge
return total
```

> **CD-NEW-1:** este helper NO debe duplicar la lógica de `augmentX402ChallengeAmount` con drift. Debe ser un espejo verificable línea-a-línea de `compose.ts:135-177` (fallback, fee, floor). El Adversary compara ambos. Si `agent-price.ts` no expone un `forceRefresh`, ver RIESGO-2 / §10.

> **maxQuotedCostUsdc del plan (AC-2):** en `planOrchestration`, `maxQuotedCostUsdc = await quoteMaxCostUsdc(steps, /* forceRefresh */ false)` (en plan el precio recién se resolvió, cache fresco). Es el valor que el cliente recibe y reenvía como cap.

> **Relación quote vs débito real (invariante crítico, auto-blindaje WKH-127):** `maxQuotedCostUsdc` (sum de TODOS los steps + fee) es el **techo** que el cliente aprueba. El **débito real** sigue siendo disjunto: step-0 lo debita el service (`plannedCostUsd` = precio del step-0 + gas), steps 1..N los debita compose (guard `i>0`), fee lo cobra `chargeProtocolFee`. El quote NO cambia la mecánica de cobro — solo es un cap. CD-NEW-2 lo blinda.

#### 4.3.5 Invariantes de execute preservadas (CD-6)

`executeApprovedPlan` mantiene, sin cambios respecto al atómico:
- debit step-0 con gas overhead (`getStepGasOverheadUsd`) — AC-11 (`orchestrate.ts:652-668`).
- guard `i>0` de compose intacto — AC-7 (compose.ts:197, CD-3).
- credit-back on failure WKH-127 — AC-8 (`orchestrate.ts:806-865`): refund total si `totalCostUsdc===0`, parcial `max(0, plannedCostUsd - pipeline.totalCostUsdc)` si `>0`, `refundOutbox.enqueueRefund` si credit falla.
- fee + receipt post-compose exitoso — AC-9 (`orchestrate.ts:746-801`): `chargeProtocolFee` idempotente por `orchestrationId`, `receiptService.emit`.
- headers: `x-debit-fallback` si `debitFallback`, `x-a2a-remaining-budget` con `remainingBudgetUsd` — CD-6 (route).

#### 4.3.6 `orchestrate()` recompuesto (AC-10, CD-4)

```ts
async orchestrate(request, orchestrationId): Promise<OrchestrateResult> {
  const plan = await this.planOrchestration(request, orchestrationId);
  if (plan.planStatus !== 'ready') {
    return mapPlanEarlyReturnToOrchestrateResult(plan);  // mismos OrchestrateResult que hoy
  }
  // request.maxQuotedCostUsdc === undefined → cap gate NO corre (path atómico)
  return this.executeApprovedPlan(request, plan, orchestrationId);
}
```

`mapPlanEarlyReturnToOrchestrateResult` reconstruye el `OrchestrateResult` exacto que cada early-return devolvía (mismos campos: `answer:null`, `reasoning`, `pipeline{success,...}`, `consideredAgents`, `protocolFeeUsdc:0`, etc.). **El `eventService.track` del early-return ya se disparó dentro de `planOrchestration` (no se duplica acá).** Ver §4.6 columna "track".

> **Verificación CD-4:** el Adversary debe confirmar que para cada uno de los 6 early-returns, el `OrchestrateResult` que el atómico devuelve post-refactor es estructuralmente idéntico al pre-refactor (mismos campos, mismo `pipeline.success`, mismo `reasoning`), y que el track se dispara exactamente una vez. Los tests existentes de `orchestrate.test.ts`/`orchestrate.billing.test.ts` deben pasar **sin cambios de aserción de comportamiento del atómico** (solo se AGREGAN tests de plan/execute).

#### 4.3.7 `OrchestrateExecuteRequest` (tipo nuevo)

```ts
export interface OrchestrateExecuteRequest extends OrchestrateRequest {
  /** El plan aprobado por el cliente (steps re-resueltos server-side, AC-4). */
  orchestrationId: string;
  steps: ComposeStep[];
  /** Cap aprobado por el cliente; gate AC-3. */
  maxQuotedCostUsdc: number;
}
```

> El service de `/execute` re-construye internamente el `plan` (re-resuelve precio, re-deriva `plannedCostUsd` del step-0, `feeUsdc`, `consideredAgents`) — NO confía en `costPerStep` ni en ningún costo del cliente (AC-4/CD-2). Los `steps` del cliente SÍ se usan como la lista de agentes a ejecutar (RIESGO-3, ver §10), pero su **precio** se ignora.

### 4.4 Flujo principal (Happy Path)

**`/plan`:**
1. Cliente: `POST /orchestrate/plan {goal, budget, preferCapabilities?, maxAgents?}` con auth.
2. PreHandlers (DT-4): forward-key → backpressure → timeout → markSkipMiddlewareDebit → requirePaymentOrA2AKey.
3. Route genera `orchestrationId`, llama `orchestrateService.planOrchestration(request, orchestrationId)`.
4. Service: fee-precheck → (getBalance read-only para no-funds) → discover → deprioritize demos → LLM/greedy plan → budget filter → calcula `costPerStep`, `totalCostUsdc`, `maxQuotedCostUsdc`, `protocolFeeUsdc`.
5. Respuesta 200: `{orchestrationId, planStatus:"ready", steps, costPerStep, totalCostUsdc, protocolFeeUsdc, maxQuotedCostUsdc, reasoning, consideredAgents}`. **Cero debit.**

**`/execute`:**
1. Cliente: `POST /orchestrate/execute {orchestrationId, steps, maxQuotedCostUsdc, budget, ...}` con auth.
2. PreHandlers (DT-4): incluye `markSkipMiddlewareDebit` (RIESGO-4 — evita double-charge del placeholder $1).
3. Route llama `orchestrateService.executeApprovedPlan(request, /*reconstruido*/, orchestrationId)`.
4. Service: re-resuelve precio server-side (forceRefresh) → `currentCostUsdc = quoteMaxCostUsdc(steps, true)`.
5. **Gate AC-3:** si `currentCostUsdc > maxQuotedCostUsdc` → `409 QUOTE_STALE {error_code, currentCostUsdc, maxQuotedCostUsdc}`, **sin débito** (AC-5).
6. Si pasa: price-fallback $1 → debit step-0 + gas → compose (steps 1..N, guard `i>0`) → fee + receipt → credit-back si falla.
7. Respuesta 200 (o 403 SCOPE_DENIED) con headers `x-debit-fallback`/`x-a2a-remaining-budget`.

### 4.5 Flujo de error

| Condición | Respuesta | Debit? |
|-----------|-----------|--------|
| `/plan` o `/execute` sin auth | 401/402 (según path) — AC-12 | No |
| `/plan` fee corrupto (`feeUsdc>budget`) | 400 `ProtocolFeeError` (error-boundary) | No |
| `/plan` no-funds / no-agents / no-budget / no-relevant | 200 con `planStatus` discriminador (AC-6) | No |
| `/execute` `currentCostUsdc > maxQuotedCostUsdc` | 409 `QUOTE_STALE` (AC-3/AC-5) | No |
| `/execute` debit step-0 falla | 200 `pipeline.success:false`, `reasoning:"Insufficient budget..."` (igual al atómico) | El debit ya falló, no aplicó |
| `/execute` compose falla | 200 `pipeline.success:false` + credit-back (AC-8) | Refund aplicado |
| `/execute` SCOPE_DENIED en step-0 | 403 (igual al atómico, route L115) | per-step de compose |

### 4.6 Mapeo de los 6 early-returns (RIESGO-1 / CD-5) — TABLA EXPLÍCITA

Cada early-return del `orchestrate()` actual se MUEVE a `planOrchestration`. Ninguno corre en `executeApprovedPlan`. El `eventService.track` se dispara dentro de `planOrchestration` exactamente como hoy (CD-5).

| # | Early-return (línea actual) | Trigger | `planStatus` en plan | `eventService.track` que dispara (preservado) | En `executeApprovedPlan`? |
|---|------------------------------|---------|----------------------|------------------------------------------------|----------------------------|
| 1 | no-funds `orchestrate.ts:336-378` | `billingKeyRow` + balance `NaN/≤0` | `insufficient_funds` | `status:'failed', costUsdc:0, metadata{agentCount:0, fallback:false}` (L363-374) | No |
| 2 | no-agents `orchestrate.ts:395-426` | `discovered.agents.length===0` | `no_agents` | `status:'success', costUsdc:0, metadata{agentCount:0, fallback:false}` (L412-423) | No |
| 3 | no-budget-fit `orchestrate.ts:540-571` | `steps.length===0` post-plan | `budget_exhausted` | `status:'success', costUsdc:0, metadata{agentCount:0, fallback:usedFallback}` (L557-568) | No |
| 4 | no-relevant `orchestrate.ts:587-626` | `allStepsAreDemos` | `no_relevant_agent` | `status:'failed', costUsdc:0, metadata{agentCount:0, fallback, reason:'no_relevant_agent', hasRealCandidate}` (L606-623) | No |
| 5 | pre-compose timeout #1 `orchestrate.ts:451-455` | `elapsedMs > 90s` | (throw) → error-boundary | NO track (throw); igual al atómico | No |
| 6 | pre-compose timeout #2 `orchestrate.ts:630-634` | `preComposeElapsed > 90s` | (throw) → error-boundary | NO track (throw); igual al atómico | No |

> **Nota sobre "6 early-returns":** el work-item RIESGO-1 lista también el **debit-fail** (`orchestrate.ts:669-714`) como early-return. Ese pertenece a la región de **execute** (corre después del débito), por lo que vive en `executeApprovedPlan`, NO en `planOrchestration`. Su track (`status:'failed', metadata{agentCount:steps.length, fallback}`, L697-712) se preserva en execute. Total: 4 early-returns de plan con planStatus + 2 timeouts (throw) en plan + 1 debit-fail en execute.

> **CD-5 verificación:** el Adversary debe `grep -c "eventService.track" orchestrate.ts` antes y después: el conteo total de call-sites de `track` debe ser **idéntico** (los mismos N; ninguno se borra, ninguno se duplica), repartidos entre `planOrchestration` (early-returns 1-4 + ninguno en timeouts) y `executeApprovedPlan` (debit-fail + track final exitoso L870-886).

### 4.7 Rutas y preHandlers (DT-4 / RIESGO-4)

Ambas rutas viven en `src/routes/orchestrate.ts` dentro del plugin (prefijo `/orchestrate`).

**`POST /plan`:**
- Schema body: idéntico al `/` (`goal` required, `budget` required, `maxAgents`, `preferCapabilities`).
- preHandlers (idénticos a `/`, AC-12/CD-7): `...requireForwardKey(), createBackpressureHandler(), createTimeoutHandler(...), markSkipMiddlewareDebitHandler, ...requirePaymentOrA2AKey({...})`.
  - `markSkipMiddlewareDebitHandler` se incluye para garantizar que el middleware NO debite el placeholder $1 en plan (defensa: aunque el service no debita, el flag evita cualquier débito accidental del middleware). **AC-1 reforzado.**
- rate limit: **mismo `orchestrateRateLimit()`** (DT-4 resuelto, ver §10 — evita plan-spam amplification).
- handler: `orchestrationId = crypto.randomUUID()`; `planOrchestration(...)`; 200 con los campos públicos del `OrchestratePlanResult`. NO setea `x-a2a-remaining-budget` (no hubo débito).

**`POST /execute`:**
- Schema body: `orchestrationId` (string, uuid), `steps` (array, minItems 1), `maxQuotedCostUsdc` (number, ≥0), `budget` (number), `preferCapabilities?`, `maxAgents?`.
- preHandlers (idénticos a `/` + **OBLIGATORIO** `markSkipMiddlewareDebitHandler`, RIESGO-4): el middleware NO debe debitar el placeholder $1; el step-0 real lo debita el service.
- rate limit: **mismo `orchestrateRateLimit()`**.
- handler: `executeApprovedPlan(...)`; si el resultado es `__quoteStale` → `409 {error_code:'QUOTE_STALE', currentCostUsdc, maxQuotedCostUsdc}`; sino mapea status (`SCOPE_DENIED→403` else 200) + headers `x-debit-fallback`/`x-a2a-remaining-budget` (idéntico a `/`).

## 5. Decisiones Técnicas Resueltas

### DT-1 — Refactor-in-place (Opción A). **RESUELTO: Opción A.**

**Decisión:** Opción A (refactor-in-place: extraer `planOrchestration` + `executeApprovedPlan` del `orchestrate()` actual; el atómico las compone).

**Justificación (riesgo de billing-drift + verificabilidad por el Adversary):**
- **Un único lugar de verdad.** La lógica de billing/telemetría (debit step-0, guard `i>0` disjunto, credit-back, fee, los N `eventService.track`) existe en UNA implementación. La Opción B (camino nuevo liviano para `/plan` + thin wrapper para `/execute`) **duplicaría** la resolución de precio y el cálculo del `plannedCostUsd` del step-0 → exactamente el vector de double-charge que el auto-blindaje WKH-127 (BLQ-ALTO-1) documenta como el bug más caro de esta región. Drift entre dos resoluciones de precio = el riesgo #1 a evitar.
- **Verificable.** El Adversary verifica AC-10 (byte-idéntico) demostrando que `orchestrate() === planOrchestration() ∘ executeApprovedPlan()` y que el cap gate solo corre con `maxQuotedCostUsdc` presente. Con Opción B tendría que comparar dos cuerpos divergentes → no verificable mecánicamente.
- **Tests existentes como red.** `orchestrate.billing.test.ts` (compose real) y `orchestrate.test.ts` cubren el atómico; tras el refactor deben pasar **sin cambiar aserciones de comportamiento del atómico** — esa es la prueba mecánica de no-drift. Opción B no ofrece esta garantía.

**Firmas exactas:**
```ts
orchestrateService.planOrchestration(
  request: OrchestrateRequest,
  orchestrationId: string,
): Promise<OrchestratePlanResult>

orchestrateService.executeApprovedPlan(
  request: OrchestrateRequest & { maxQuotedCostUsdc?: number },
  plan: OrchestratePlanResult & { /* internos: plannedCostUsd, feeUsdc, usedFallback, debitFallback, billingKeyRow-equiv */ },
  orchestrationId: string,
): Promise<OrchestrateResult | { __quoteStale: true; currentCostUsdc: number; maxQuotedCostUsdc: number }>

orchestrateService.orchestrate(  // SIN CAMBIO DE FIRMA — CD-4
  request: OrchestrateRequest,
  orchestrationId: string,
): Promise<OrchestrateResult>  // = planOrchestration ∘ executeApprovedPlan (cap gate inactivo)
```

> El `plan` que `executeApprovedPlan` recibe lleva campos internos (`plannedCostUsd`, `feeUsdc`, `usedFallback`, `debitFallback`) que el route NO serializa al cliente. En el path `/execute`, esos internos se **re-derivan server-side** desde los `steps` del cliente (re-resolución de precio), NO se reciben del cliente (AC-4/CD-2).

### DT-2 / RIESGO-3 — Persistencia del plan. **RESUELTO: NO persistir en esta HU. Cap + re-precio server-side es defensa suficiente para el scope demo. Endurecimiento → WKH futura.**

**Decisión:** NO persistir el plan (sin Redis/DB/TTL). El `orchestrationId` es opaco; el `/execute` re-resuelve precio server-side (AC-4) y aplica el cap (AC-3). NO se autentica el `orchestrationId` contra su owner ni se valida que los `steps` coincidan con un plan guardado.

**Justificación (por qué cap + re-precio basta para el scope demo, y qué queda como WKH futura):**
- **Lo que el cliente NO puede hacer:** sobre-cobrar al gateway por debajo del valor real (el precio se re-resuelve server-side, AC-4; el cliente nunca dicta cuánto se debita) ni exceder su propio cap aprobado (AC-3 corta antes del débito). El budget propio del caller (`budgetService`) sigue siendo el techo duro: un caller no puede ejecutar más allá de su saldo.
- **Lo que el cliente SÍ puede hacer (residual aceptado):** enviar en `/execute` un `steps[]` distinto al cotizado en `/plan` (otros agentes, distinta cantidad) **mientras** el `currentCostUsdc` re-resuelto no exceda el `maxQuotedCostUsdc`. Es decir, puede ejecutar un pipeline diferente al que vio en el quote, dentro del cap. **Esto NO es un vector de robo de fondos** (paga con su propio budget, a precio real server-side; el gateway no pierde dinero), sino un mismatch de UX/intención: el cliente aprobó un presupuesto, no una lista inmutable de agentes.
- **Por qué es aceptable en el scope demo (Yarvis PWA):** el caller es el dueño de su propio Agent Key y su propio budget. Manipular sus propios `steps` solo se perjudica a sí mismo (ejecuta algo que no quería, con su propia plata, dentro de su propio cap). No hay cross-tenant ni pérdida del gateway. El valor del flujo (mostrar presupuesto antes de aprobar) se cumple con el cap.
- **WKH futura explícita (endurecimiento):** persistir el plan en Redis con TTL keyado por `orchestrationId`, ligado al `owner_ref` del caller, y validar en `/execute` que (a) el `orchestrationId` fue emitido para ese owner y (b) el hash de `steps` coincide con el plan guardado → integridad del plan + autenticación del orchestrationId. Trackear como **WKH-PLAN-PERSIST** (TTL del quote, ver DT abajo, va en la misma HU). NO es bloqueante para WKH-131.

> **NO es [NEEDS CLARIFICATION]:** la pregunta del work-item Missing-Input #1 ("¿validar orchestrationId por owner?") queda RESUELTA como "no en esta HU, defensa = cap+re-precio, endurecimiento = WKH-PLAN-PERSIST". No requiere dominio humano adicional: no hay pérdida de fondos del gateway ni cross-tenant; el residual es UX-only y lo asume el dueño del key.

### RIESGO-2 — Price-drift por cache 60s de agent-price. **RESUELTO: forzar cache-bust en `/execute`; cache aceptable en `/plan`.**

**Decisión:** el re-precio del `/execute` (`quoteMaxCostUsdc(steps, forceRefresh=true)`) debe **bypassear el cache** de `agent-price.ts` para que el `QUOTE_STALE` detecte cambios reales de precio entre plan y execute. En `/plan`, el cache normal (60s) es aceptable.

**Justificación:**
- El propósito del `QUOTE_STALE` (AC-3/AC-5) es proteger contra que el precio real suba entre el quote y la ejecución. Si el `/execute` lee del mismo cache de 60s que pobló el `/plan`, un cambio de precio dentro de la ventana de 60s **no se detecta** → el gateway ejecutaría a un precio viejo (under/over-charge silencioso). Forzar refresh hace que el cap sea significativo.
- En `/plan` el cache es aceptable: el quote es una estimación que el cliente aprueba; un precio cacheado de hasta 60s es un error de estimación menor que el cap absorbe.

**Implicación de implementación (RIESGO-2 → cambio de Scope OUT):** `agent-price.ts` está en Scope OUT del work-item ("solo lectura, reusar tal cual"). Pero forzar cache-bust requiere o bien (a) agregar un parámetro `forceRefresh?: boolean` a `resolveAgentPriceUsdc`, o (b) llamar `_resetAgentPriceCache()` antes del re-precio en execute. 
- **Opción (b) elegida** (NO toca la firma pública ni el Scope OUT de `agent-price.ts`): `executeApprovedPlan`, en el path `/execute`, llama `_resetAgentPriceCache()` (test-only export ya existente, `agent-price.ts:99`) **antes** del `quoteMaxCostUsdc(steps, true)`. 
  - **Riesgo de (b):** `_resetAgentPriceCache` limpia TODO el cache (no per-key) → invalida el cache de compose concurrente. Impacto: un re-fetch extra de discovery por execute. Aceptable (execute es low-frequency, gated por aprobación humana). 
  - **[NEEDS CLARIFICATION — MENOR, no bloqueante]:** si el Adversary considera que limpiar el cache global desde un path de producción es inaceptable (efecto colateral sobre compose concurrente), la alternativa es **(a)**: agregar `forceRefresh?: boolean` a `resolveAgentPriceUsdc` (cambio mínimo, aditivo, no rompe callers). Esto MODIFICA `agent-price.ts` → requiere mover ese archivo de Scope OUT a Scope IN. **Recomendación del Architect: opción (a)** (más limpia, sin efecto colateral global), aceptando ampliar Scope IN con un cambio aditivo de 3 líneas en `agent-price.ts`. El humano confirma en SPEC_APPROVED cuál prefiere. Si no se decide, el Dev usa (a) por ser la de menor blast-radius en producción.

### DT-3 — `planStatus: circuit_open`. **RESUELTO: DIFERIR (no en esta HU).**

**Decisión:** NO agregar `circuit_open` al enum `OrchestratePlanStatus` en esta HU.

**Justificación:** el código actual (`orchestrate.ts:457-476`) ya maneja el circuit-breaker abierto **degradando a greedy fallback** (`plan = null` → greedyPlan), NO devolviendo un early-return. Es decir, un breaker abierto produce un plan ejecutable (greedy) con `planStatus:"ready"`, no un estado discriminado. Agregar `circuit_open` cambiaría ese comportamiento (de "degrada y sigue" a "corta con status"), lo cual es un cambio de semántica fuera del scope de partir el endpoint. Mantener el comportamiento actual (degrada a greedy) preserva AC-10 (byte-idéntico) y evita scope-creep. Si el consumer necesita distinguir "plan vino de greedy por breaker abierto", se agrega en una WKH futura como metadato no-bloqueante.

### DT-4 / RIESGO-4 — preHandlers + rate-limit. **RESUELTO.**

- **`/plan`:** misma cadena que `/` (`requireForwardKey → backpressure → timeout → markSkipMiddlewareDebitHandler → requirePaymentOrA2AKey`). Incluye `markSkipMiddlewareDebitHandler` (defensa anti-debit, AC-1/CD-1).
- **`/execute`:** misma cadena que `/`, con `markSkipMiddlewareDebitHandler` **OBLIGATORIO** (RIESGO-4): sin él, el middleware debita el placeholder $1 además del step-0 real del service → double-charge. Es el mismo mecanismo que protege al `/` atómico hoy.
- **Rate limit:** **mismo `orchestrateRateLimit()`** para ambas rutas (DT-4 resuelto). Razón (work-item Missing-Input #3): evitar amplificación vía plan-spam — `/plan` ejecuta discovery + LLM (caro), así que comparte el mismo presupuesto de rate que el orchestrate pesado. NO se crea un rate limit separado.

## 6. Scope

**IN:**
- `src/types/index.ts`: `OrchestratePlanResult`, `OrchestratePlanStatus`, `OrchestrateExecuteRequest`.
- `src/services/orchestrate.ts`: extraer `planOrchestration` + `executeApprovedPlan` + `quoteMaxCostUsdc`; recomponer `orchestrate`; cap gate en `/execute` path.
- `src/routes/orchestrate.ts`: rutas `/plan` + `/execute`.
- `src/services/agent-price.ts`: **CONDICIONAL** (RIESGO-2 opción a) — agregar `forceRefresh?: boolean` a `resolveAgentPriceUsdc` (aditivo). Solo si el humano elige opción (a). Si elige (b), Scope OUT.
- Tests: `orchestrate.test.ts`, `orchestrate.billing.test.ts`, `routes/orchestrate.test.ts`.

**OUT:**
- `POST /orchestrate` atómico (zero-touch externo — CD-4).
- `src/services/compose.ts` (guard `i>0` — CD-3).
- `src/routes/compose.ts`, `augmentX402ChallengeAmount` (solo se ESPEJA, no se toca).
- `refundOutbox`, `receiptService`, `budgetService`.
- Persistencia del plan (DT-2 → WKH-PLAN-PERSIST futura).
- TTL del quote (→ WKH-PLAN-PERSIST futura).
- `circuit_open` planStatus (DT-3 → WKH futura).
- Modelo de cobranza deleg/session.

## 7. Constraint Directives

### Heredados del work-item (CD-1..CD-8) — VIGENTES

- **CD-1** — PROHIBIDO debitar/settlear en `/plan` (`planOrchestration` no llama debit/compose/settle). `getBalance` read-only permitido.
- **CD-2** — PROHIBIDO confiar en precios del cliente en `/execute` (solo `resolveAgentPriceUsdc` server-side).
- **CD-3** — PROHIBIDO modificar el guard `i>0` de `compose.ts:197`.
- **CD-4** — OBLIGATORIO `POST /orchestrate` byte-idéntico externamente; tests del atómico pasan sin cambio de aserción.
- **CD-5** — OBLIGATORIO preservar todos los `eventService.track` de early-returns (conteo total de call-sites idéntico pre/post refactor).
- **CD-6** — OBLIGATORIO preservar debit/refund/fee/headers de execute (WKH-127/44/124).
- **CD-7** — PROHIBIDO exponer `/plan` sin auth (mismos preHandlers que `/`).
- **CD-8** — TypeScript strict, sin `any`; nuevos tipos como interfaces en `types/index.ts`.

### Nuevos de este SDD

- **CD-NEW-1** — OBLIGATORIO que `quoteMaxCostUsdc` sea un espejo verificable línea-a-línea de `augmentX402ChallengeAmount` (`compose.ts:135-177`): mismo `resolveAgentPriceUsdc`, mismo fallback `PLACEHOLDER_FEE_USD` para precio inválido/step malformado, mismo `(pipelineUsd * (1+getProtocolFeeRate())).toFixed(6)`, mismo floor `1e-6` cuando redondea a 0 con `pipelineUsd>0`. PROHIBIDO inventar fee math nueva (AC-2).
- **CD-NEW-2** — PROHIBIDO usar `maxQuotedCostUsdc` o `currentCostUsdc` como base del DÉBITO. El cap es solo un techo de validación (AC-3). El débito real permanece disjunto: step-0 (service, `plannedCostUsd` = precio step-0 + gas) + steps 1..N (compose, guard `i>0`) + fee. Invariante: `Σ(débitos) == costo real del plan`, cada step UNA vez (auto-blindaje WKH-127 BLQ-ALTO-1).
- **CD-NEW-3** — OBLIGATORIO que el cap gate (`currentCostUsdc > maxQuotedCostUsdc → 409`) corra ANTES de cualquier `budgetService.debit` o `composeService.compose` en `/execute` (AC-5: QUOTE_STALE no debita).
- **CD-NEW-4** — OBLIGATORIO que `executeApprovedPlan` NO aplique el cap gate cuando `request.maxQuotedCostUsdc === undefined` (path atómico) — garantiza AC-10.
- **CD-NEW-5** — OBLIGATORIO `markSkipMiddlewareDebitHandler` en los preHandlers de `/execute` (RIESGO-4: sin él, double-charge del placeholder $1).
- **CD-NEW-6** — PROHIBIDO que `/execute` re-derive el `plannedCostUsd` (base del débito step-0) desde `costPerStep` o cualquier campo de costo del body del cliente. Debe re-resolverlo server-side desde `steps[0]` vía `resolveAgentPriceUsdc` (AC-4/CD-2).
- **CD-NEW-7** — OBLIGATORIO que cada early-return mapeado (tabla §4.6) dispare su `eventService.track` exactamente una vez, dentro de `planOrchestration`, y que `mapPlanEarlyReturnToOrchestrateResult` (en el atómico) NO lo re-dispare (no duplicar telemetría).

### PROHIBIDO general
- NO agregar dependencias nuevas.
- NO crear patrones distintos a los existentes (rutas siguen el patrón de `/`).
- NO modificar archivos fuera de Scope IN.
- NO hardcodear (rate limit, fee rate, gas — todo desde env/funciones existentes).

## 8. Riesgos

| Riesgo | Prob | Impacto | Mitigación |
|--------|------|---------|------------|
| RIESGO-1: perder un `eventService.track` al partir la región | M | A (telemetría/billing audit) | CD-5/CD-NEW-7 + tabla §4.6 + test que asevera conteo de track por path + grep pre/post. |
| RIESGO-2: price-drift por cache 60s | M | M (cap inútil) | Cache-bust en execute (§DT RIESGO-2). |
| RIESGO-3: steps manipulables sin persistencia | B | B (UX-only, sin pérdida gateway) | Cap + re-precio server-side; endurecimiento → WKH-PLAN-PERSIST. |
| RIESGO-4: double-charge del placeholder $1 en execute | M | A (money-path) | CD-NEW-5: `markSkipMiddlewareDebit` obligatorio + test de conteo de débitos con compose real. |
| Double-charge steps 1..N (auto-blindaje WKH-127) | M | A (money-path) | CD-NEW-2 + test del invariante total con compose real (no mockeado). |
| Drift atómico (AC-10) por refactor | M | A (retrocompat) | Tests existentes del atómico pasan sin cambio de aserción; Adversary compara composición vs original. |
| `vi.mock` factory con tipos top-level (auto-blindaje WKH-130) | B | B (test infra) | Usar `vi.hoisted` para clases/const en factories. |

## 9. Dependencias

- Ninguna externa. Toda la infra (budget, compose, fee, discovery, agent-price, eventService, gas-overhead, rate-limit) ya existe y está en producción.
- Coordinación: si otra HU toca `src/services/orchestrate.ts` o `src/routes/orchestrate.ts` durante F3 → conflicto de merge (work-item §Paralelismo). Esta HU debe ir sola sobre esos archivos.

## 10. Uncertainty Markers

| Marker | Sección | Descripción | Bloqueante? |
|--------|---------|-------------|-------------|
| Decisión (a) vs (b) cache-bust | §5 RIESGO-2 | (a) `forceRefresh` param en `agent-price.ts` (amplía Scope IN, blast-radius mínimo) vs (b) `_resetAgentPriceCache()` global (no toca firma, efecto colateral sobre compose concurrente). Recomendación: (a). | **No** (default: (a); el humano confirma en SPEC_APPROVED) |

> Todos los demás Missing-Inputs del work-item están RESUELTOS:
> - Owner-validation del orchestrationId → DT-2 (no en esta HU; cap+re-precio; WKH-PLAN-PERSIST futura). **Sin [NEEDS CLARIFICATION].**
> - TTL del quote → diferido a WKH-PLAN-PERSIST. **Sin [NEEDS CLARIFICATION].**
> - Rate limit /plan → mismo `orchestrateRateLimit()` (DT-4).
> - `circuit_open` → diferido (DT-3).

## 11. Test Plan (≥1 test por AC — los 13)

| Test | AC | Archivo | Framework | Compose |
|------|----|---------|-----------|---------|
| T-PLAN-1: `/plan` happy → `planStatus:"ready"` + campos completos, **cero `budgetService.debit`** | AC-1, AC-13 | `orchestrate.test.ts` | vitest | mock |
| T-PLAN-2: `maxQuotedCostUsdc == sum(resolveAgentPriceUsdc)*(1+rate)` (mismo número que `augmentX402ChallengeAmount` para los mismos steps) | AC-2 | `orchestrate.test.ts` | vitest | mock |
| T-PLAN-3: no-funds → `planStatus:'insufficient_funds'` + track disparado | AC-6 | `orchestrate.test.ts` | vitest | mock |
| T-PLAN-4: no-agents → `planStatus:'no_agents'` + track | AC-6 | `orchestrate.test.ts` | vitest | mock |
| T-PLAN-5: no-budget-fit → `planStatus:'budget_exhausted'` + track | AC-6 | `orchestrate.test.ts` | vitest | mock |
| T-PLAN-6: all-demos → `planStatus:'no_relevant_agent'` + track (metadata `reason`, `hasRealCandidate`) | AC-6 | `orchestrate.test.ts` | vitest | mock |
| T-PLAN-7: conteo total de `eventService.track` call-sites == atómico (ningún track perdido/duplicado) | CD-5 | `orchestrate.test.ts` | vitest | mock |
| T-EXEC-1: `/execute` happy → ejecuta, debit step-0 + compose, 200 | AC-3(pass), AC-7 | `orchestrate.billing.test.ts` | vitest | **real** |
| T-EXEC-2: `currentCostUsdc > maxQuotedCostUsdc` → `409 QUOTE_STALE` body `{error_code,currentCostUsdc,maxQuotedCostUsdc}`, **cero debit** | AC-3, AC-5 | `orchestrate.test.ts` + `orchestrate.billing.test.ts` | vitest | mock + real |
| T-EXEC-3: precios del cliente en body IGNORADOS — cobro = `resolveAgentPriceUsdc` server-side (cliente manda costo falso, débito real ≠ falso) | AC-4 | `orchestrate.billing.test.ts` | vitest | **real** |
| T-EXEC-4: invariante total — `Σ(service step-0 + compose steps 1..N) == costo real`, cada step UNA vez | AC-7, CD-NEW-2 | `orchestrate.billing.test.ts` | vitest | **real** |
| T-EXEC-5: `pipeline.success===false` → credit-back (total si `totalCostUsdc===0`, parcial si `>0`, `refundOutbox` si credit falla) | AC-8 | `orchestrate.billing.test.ts` | vitest | **real** |
| T-EXEC-6: `pipeline.success===true` → `chargeProtocolFee` idempotente por `orchestrationId` + `receiptService.emit` + `protocolFeeUsdc` seteado | AC-9 | `orchestrate.billing.test.ts` | vitest | **real** |
| T-EXEC-7: debit step-0 incluye `getStepGasOverheadUsd(chainId)` | AC-11 | `orchestrate.billing.test.ts` | vitest | **real** |
| T-EXEC-8: `markSkipMiddlewareDebit` presente en preHandlers `/execute` → middleware NO debita placeholder $1 (no double-charge) | RIESGO-4, CD-NEW-5 | `routes/orchestrate.test.ts` | vitest | mock |
| T-ATOM-1..N: tests existentes del `/` atómico pasan SIN cambio de aserción de comportamiento | AC-10, CD-4 | `orchestrate.test.ts` + `orchestrate.billing.test.ts` | vitest | mock + real |
| T-ROUTE-PLAN: `/plan` sin auth → 401/402 (mock middleware rechaza) | AC-12, CD-7 | `routes/orchestrate.test.ts` | vitest | mock |
| T-ROUTE-EXEC: `/execute` status (SCOPE_DENIED→403, else 200) + headers `x-debit-fallback`/`x-a2a-remaining-budget` | AC-10, CD-6 | `routes/orchestrate.test.ts` | vitest | mock |

> **Cobertura AC:** AC-1(T-PLAN-1), AC-2(T-PLAN-2), AC-3(T-EXEC-2), AC-4(T-EXEC-3), AC-5(T-EXEC-2), AC-6(T-PLAN-3..6), AC-7(T-EXEC-1,4), AC-8(T-EXEC-5), AC-9(T-EXEC-6), AC-10(T-ATOM,T-ROUTE-EXEC), AC-11(T-EXEC-7), AC-12(T-ROUTE-PLAN), AC-13(T-PLAN-1). **13/13.**

## 12. Waves de Implementación

### Wave 0 (Serial Gate — tipos + contratos)
- W0.1: `src/types/index.ts` — `OrchestratePlanStatus`, `OrchestratePlanResult`, `OrchestrateExecuteRequest`. Verif: `tsc`.
- W0.2 (condicional, solo opción (a)): `src/services/agent-price.ts` — `forceRefresh?: boolean` aditivo. Verif: `tsc` + `agent-price.test.ts` pasa.

### Wave 1 (Depende de W0 — extracción del service)
- W1.1: `orchestrate.ts` — extraer `planOrchestration` (región planning verbatim + planStatus + early-returns mapeados §4.6). Exemplar: cuerpo actual L306-634.
- W1.2: `orchestrate.ts` — extraer `executeApprovedPlan` (región execute verbatim) + cap gate condicional (`maxQuotedCostUsdc !== undefined`). Exemplar: cuerpo actual L636-902.
- W1.3: `orchestrate.ts` — `quoteMaxCostUsdc` helper (espejo de `compose.ts:135-177`). Exemplar: `augmentX402ChallengeAmount`.
- W1.4: `orchestrate.ts` — recomponer `orchestrate()` = `planOrchestration ∘ executeApprovedPlan` + `mapPlanEarlyReturnToOrchestrateResult`. Verif: `tsc` + tests existentes del atómico verdes SIN cambio de aserción (prueba mecánica de AC-10/CD-4).

### Wave 2 (Depende de W1 — rutas)
- W2.1: `routes/orchestrate.ts` — ruta `/plan` (preHandlers idénticos a `/`, sin debit). Exemplar: ruta `/`.
- W2.2: `routes/orchestrate.ts` — ruta `/execute` (preHandlers + `markSkipMiddlewareDebit` + cap gate → 409 + headers). Exemplar: ruta `/`.

### Wave 3 (Tests)
- W3.1: `orchestrate.test.ts` — T-PLAN-1..7, T-EXEC-2 (mock).
- W3.2: `orchestrate.billing.test.ts` — T-EXEC-1,3,4,5,6,7 (compose real) + T-ATOM regresión.
- W3.3: `routes/orchestrate.test.ts` — T-EXEC-8, T-ROUTE-PLAN, T-ROUTE-EXEC.
- W3.4: `biome check --write` sobre los 5 archivos + `tsc` + suite completa verde (auto-blindaje WKH-130).

### Verificación incremental
| Wave | Verificación |
|------|--------------|
| W0 | `tsc` |
| W1 | `tsc` + suite orchestrate existente verde (no-drift) |
| W2 | `tsc` |
| W3 | suite completa + biome + tsc |

## 13. Readiness Check

```
READINESS CHECK — SDD #128:
[x] Cada AC (13) tiene ≥1 archivo en tabla 4.1 y ≥1 test en §11 (13/13)
[x] Cada archivo en 4.1 tiene Exemplar verificado con Read/Glob (paths reales: orchestrate.ts:306/636, compose.ts:127, agent-price.ts:40, types:418, orchestrate.test.ts, orchestrate.billing.test.ts)
[x] DT-1 RESUELTO: Opción A (refactor-in-place) — justificada por billing-drift + verificabilidad
[x] DT-2/RIESGO-3 RESUELTO: no persistir; cap+re-precio suficiente para demo; WKH-PLAN-PERSIST futura
[x] RIESGO-2 RESUELTO: cache-bust en execute (default opción (a))
[x] DT-3 RESUELTO: circuit_open diferido
[x] DT-4/RIESGO-4 RESUELTO: preHandlers + markSkipMiddlewareDebit + mismo rate limit
[x] Mapeo de 6 early-returns → tabla explícita §4.6 (4 planStatus + 2 timeouts + 1 debit-fail en execute)
[x] Constraint Directives: 8 heredados + 7 nuevos (≥3 PROHIBIDO) 
[x] Context Map: 14 archivos leídos (≥2)
[x] Scope IN/OUT explícitos
[x] Sin cambios de BD (verificado)
[x] Happy Path completo (/plan + /execute) §4.4
[x] Flujo de error §4.5 (7 casos)
[~] 1 [NEEDS CLARIFICATION] MENOR no bloqueante: cache-bust (a) vs (b) — default (a), humano confirma en SPEC_APPROVED
```

**Estado:** READY para SPEC_APPROVED. El único marker es MENOR (cache-bust (a)/(b)) con default seguro definido; no bloquea la implementación.

---

*SDD generado por NexusAgil — FULL — Architect F2 (WKH-131 / SDD #128)*
