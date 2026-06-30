# Story File — HU-128 / WKH-131: `/orchestrate/plan` + `/orchestrate/execute`

> **Contrato autocontenido para el Dev (F3).** Este es tu ÚNICO input. Si algo no está acá, no lo hagas.
> SDD: `doc/sdd/128-orchestrate-plan-execute/sdd.md` (SPEC_APPROVED)
> Work Item: `doc/sdd/128-orchestrate-plan-execute/work-item.md` (HU_APPROVED)
> Branch: `feat/128-orchestrate-plan-execute`
> **Decisión del gate (bakeada): RIESGO-2 → Opción (a)** — `forceRefresh?: boolean` aditivo en `resolveAgentPriceUsdc`. La opción (b) `_resetAgentPriceCache()` global queda DESCARTADA. La W0.2 es **OBLIGATORIA**.

---

## 1. Contexto mínimo + Principio rector

Partís el endpoint atómico `POST /orchestrate` en dos endpoints que comparten una sola implementación de planning y una sola de execute:

- `POST /orchestrate/plan` — discover + LLM/greedy planning + price-resolution. **Cero debit, cero compose, cero settle.** Devuelve un quote (`maxQuotedCostUsdc`) + un `planStatus` discriminador.
- `POST /orchestrate/execute` — recibe el plan aprobado + el cap, re-resuelve precios server-side (con cache-bust), rechaza `409 QUOTE_STALE` si el precio drifteó por encima del cap, y si no, ejecuta el pipeline real idéntico al atómico.

### Principio rector (NO violar)

1. **Refactor-in-place (DT-1 Opción A).** Extraés DOS funciones internas del `orchestrate()` actual: `planOrchestration` (región planning, `orchestrate.ts:306-634`) y `executeApprovedPlan` (región execute, `orchestrate.ts:636-902`). El atómico las compone en secuencia. `/plan` llama solo a la primera, `/execute` solo a la segunda. **Un único lugar de verdad para billing y telemetría.**
2. **Atómico byte-idéntico (CD-4).** El cuerpo de cada región se mueve **verbatim**. Los tests existentes del atómico deben pasar **SIN cambiar ninguna aserción de comportamiento**. Eso es la prueba mecánica de no-drift (T-ATOM).
3. **Money-path disjunto (auto-blindaje WKH-127 BLQ-ALTO-1).** El débito de cada capa es disjunto: step-0 lo debita el service (`plannedCostUsd` = precio del step-0 + gas), steps 1..N los debita compose (guard `i>0`), fee lo cobra `chargeProtocolFee`. **PROHIBIDO** que el débito sea "la suma del plan" o que el cap (`maxQuotedCostUsdc`/`currentCostUsdc`) sea base de débito — eso es double-charge. El cap es **solo un techo de validación**.

---

## 2. Scope IN (lista exhaustiva — NO tocar nada fuera)

| Archivo | Acción |
|---------|--------|
| `src/types/index.ts` | Agregar `OrchestratePlanStatus`, `OrchestratePlanResult`, `OrchestrateExecuteRequest` |
| `src/services/agent-price.ts` | **Aditivo**: `forceRefresh?: boolean` en `resolveAgentPriceUsdc` (W0.2 OBLIGATORIA) |
| `src/services/orchestrate.ts` | Extraer `planOrchestration` + `executeApprovedPlan` + `quoteMaxCostUsdc` + recomponer `orchestrate()` + `mapPlanEarlyReturnToOrchestrateResult` + cap gate condicional |
| `src/routes/orchestrate.ts` | Rutas `/plan` + `/execute` (el `/` queda **intacto**) |
| `src/services/orchestrate.test.ts` | T-PLAN-1..7, T-EXEC-2 (mock), T-ATOM |
| `src/services/orchestrate.billing.test.ts` | T-EXEC-1,3,4,5,6,7 (compose real), T-ATOM |
| `src/routes/orchestrate.test.ts` | T-EXEC-8, T-ROUTE-PLAN, T-ROUTE-EXEC |

**Scope OUT (PROHIBIDO tocar):** `POST /orchestrate` route `/` externo (zero-touch), `src/services/compose.ts` (guard `i>0`), `src/routes/compose.ts` / `augmentX402ChallengeAmount` (solo se ESPEJA), `refundOutbox`, `receiptService`, `budgetService`. No persistir plan en DB. No TTL de quote. No `circuit_open`. No tocar deleg/session model.

---

## 3. Anti-Hallucination Checklist (APIs REALES — PROHIBIDO inventar)

Estas funciones/constantes YA EXISTEN. Reusalas tal cual, con su import exacto. **NO inventes APIs ni paths.**

| Símbolo | Archivo real | Ya importado en orchestrate.ts? |
|---------|--------------|---------------------------------|
| `resolveAgentPriceUsdc(slug, registry?)` → `Promise<number \| null>` | `src/services/agent-price.ts:40` | NO — agregar import (lo modificás vos en W0.2) |
| `getProtocolFeeRate()` → `number` | `src/services/fee-charge.ts` | SÍ (`orchestrate.ts:28`) |
| `chargeProtocolFee({orchestrationId, budgetUsdc, feeRate})` | `src/services/fee-charge.ts:157` | SÍ (`orchestrate.ts:27`) |
| `ProtocolFeeError` (class) | `src/services/fee-charge.ts:57` | SÍ (`orchestrate.ts:29`) |
| `getStepGasOverheadUsd(chainId)` → `Promise<number>` | `src/lib/gas-overhead.ts:362` | SÍ (`orchestrate.ts:13`) |
| `PLACEHOLDER_FEE_USD = 1.0` | `src/lib/pricing-constants.ts:16` | SÍ (`orchestrate.ts:15`) |
| `markSkipMiddlewareDebitHandler` | `src/routes/orchestrate.ts:31` | (ya está en el route file) |
| `eventService.track({...})` | `src/services/event.js` | SÍ (`orchestrate.ts:25`) |
| `orchestrateRateLimit()` | `src/middleware/rate-limit.ts:52` | (ya está en el route file, `orchestrate.ts:14`) |
| `budgetService.{getBalance,debit,credit}` | `src/services/budget.js` | SÍ (`orchestrate.ts:22`) |
| `composeService.compose({...})` | `src/services/compose.js` | SÍ (`orchestrate.ts:23`) |
| `refundOutbox.enqueueRefund({...})` | `src/services/refund-outbox.js` | SÍ (`orchestrate.ts:32`) |
| `receiptService.emit({...})` | `src/services/receipt.js` | SÍ (`orchestrate.ts:31`) |

**El plugin se registra con `{ prefix: '/orchestrate' }` (`src/index.ts:140`)** → una ruta `/plan` dentro del plugin mapea a `/orchestrate/plan`. NO toques `src/index.ts`.

`crypto.randomUUID()` se genera **en el route handler** (igual que el `/` actual, `orchestrate.ts:75`), no en el service.

---

## 4. Tipos exactos (W0.1) — `src/types/index.ts`

Agregar junto a `OrchestrateResult` (L418). Exemplar de estilo: `OrchestrateResult` (`types/index.ts:418-436`). TypeScript strict, sin `any` (CD-8).

```ts
export type OrchestratePlanStatus =
  | 'ready'
  | 'insufficient_funds'
  | 'no_agents'
  | 'budget_exhausted'
  | 'no_relevant_agent';
// circuit_open: DIFERIDO (DT-3). NO agregar en esta HU.

export interface OrchestratePlanResult {
  orchestrationId: string;
  planStatus: OrchestratePlanStatus;
  /** Steps del plan ejecutable; [] en early-returns. */
  steps: ComposeStep[];
  /** Precio resuelto server-side por step; [] en early-returns. */
  costPerStep: number[];
  /** sum(costPerStep) — informativo, NO base del débito. */
  totalCostUsdc: number;
  /** feeUsdc = budget * rate (espejo del atómico). */
  protocolFeeUsdc: number;
  /** Cap del execute (§4.3.4 SDD); espejo de augmentX402ChallengeAmount. */
  maxQuotedCostUsdc: number;
  reasoning: string;
  consideredAgents: Agent[];
  // Internos que executeApprovedPlan necesita del plan (el route NO los serializa
  // al cliente; el route hace pick de los públicos). Ver §6.
  plannedCostUsd: number;
  feeUsdc: number;
  usedFallback: boolean;
  debitFallback: boolean;
  /** Row billable del path master (undefined si deleg/session/x402). */
  billingKeyRow: A2AAgentKeyRow | undefined;
  /** discovered.agents — necesario para consideredAgents en execute. */
  discoveredAgents: Agent[];
}

export interface OrchestrateExecuteRequest extends OrchestrateRequest {
  /** El plan aprobado por el cliente (steps re-resueltos server-side, AC-4). */
  orchestrationId: string;
  steps: ComposeStep[];
  /** Cap aprobado por el cliente; gate AC-3. */
  maxQuotedCostUsdc: number;
}
```

> `A2AAgentKeyRow`, `Agent`, `ComposeStep` ya están importados/definidos en `types/index.ts`. `OrchestrateRequest` está en `types/index.ts:387`.

---

## 5. Firmas exactas del service (DT-1 §5 SDD)

```ts
orchestrateService.planOrchestration(
  request: OrchestrateRequest,
  orchestrationId: string,
): Promise<OrchestratePlanResult>

orchestrateService.executeApprovedPlan(
  request: OrchestrateRequest & { maxQuotedCostUsdc?: number },
  plan: OrchestratePlanResult,
  orchestrationId: string,
): Promise<OrchestrateResult | { __quoteStale: true; currentCostUsdc: number; maxQuotedCostUsdc: number }>

orchestrateService.orchestrate(   // SIN CAMBIO DE FIRMA — CD-4
  request: OrchestrateRequest,
  orchestrationId: string,
): Promise<OrchestrateResult>
```

- `maxQuotedCostUsdc === undefined` ⟹ **path atómico** → el cap gate NO corre (CD-NEW-4).
- En `/execute`, los internos del `plan` (`plannedCostUsd`, `feeUsdc`, `usedFallback`, `debitFallback`, `billingKeyRow`, `discoveredAgents`) se **re-derivan server-side** desde los `steps` del cliente — NO se reciben del cliente (AC-4/CD-2/CD-NEW-6).

---

## 6. Waves de implementación

### W0 — Serial Gate (tipos + contratos). Verif: `tsc`.

**W0.1 — `src/types/index.ts`**
Agregar los 3 tipos del §4. Exemplar: `OrchestrateResult` (`types/index.ts:418`).
Verif: `npx tsc --noEmit` (los tipos solos no rompen nada).

**W0.2 — `src/services/agent-price.ts` (OBLIGATORIA, opción (a))**
Cambio **aditivo** de firma — NO rompe callers existentes (default `false`):

```ts
export async function resolveAgentPriceUsdc(
  agentSlug: string,
  registryName?: string,
  forceRefresh = false,   // ← NUEVO, aditivo
): Promise<number | null> {
  const key = cacheKey(agentSlug, registryName);
  const now = Date.now();
  const entry = cache.get(key);

  if (!forceRefresh && entry && entry.expiresAt > now) {
    return entry.price; // cache hit
  }
  // forceRefresh === true → saltea el cache hit y re-fetchea (re-cachea abajo)
  const agent = await discoveryService.getAgent(agentSlug, registryName);
  if (!agent) return null;          // DT-G: no negative caching (intacto)
  const price = agent.priceUsdc;
  cache.set(key, { price, expiresAt: now + CACHE_TTL_MS });   // re-cachea con TTL fresco
  return price;
}
```
- **NO uses `_resetAgentPriceCache()`** (eso era opción (b), descartada). No limpiar el cache global.
- `forceRefresh` solo bypassea la lectura del cache **para ese lookup** + re-cachea. No toca otras entradas (no afecta compose concurrente).
- Verif: `npx tsc --noEmit` + `agent-price.test.ts` pasa SIN cambios (default `false` = comportamiento idéntico). Si querés, agregá 1 test de `forceRefresh=true` re-fetchea (no obligatorio para el AC, sí higiénico).

### W1 — Extracción del service (`src/services/orchestrate.ts`). Depende de W0.

> **REGLA DE ORO W1:** mové cada bloque **verbatim**. No reescribas lógica de billing/telemetría. El único cambio dentro de los bloques es: (1) los early-returns de planning devuelven `OrchestratePlanResult` en vez de `OrchestrateResult`; (2) se agrega el cap gate al inicio de execute. Todo lo demás se copia tal cual, incluyendo cada `eventService.track`, cada comentario WKH-*, cada spread condicional.

**W1.1 — `planOrchestration(request, orchestrationId): Promise<OrchestratePlanResult>`**
Contiene **verbatim** `orchestrate.ts:306-634` (fee-precheck → no-funds getBalance → discover → deprioritize → LLM/greedy → budget filter → no-relevant → timeouts). Diferencias:
- Cada early-return (tabla §7) construye un `OrchestratePlanResult` con su `planStatus` y dispara **el mismo** `eventService.track` (CD-5/CD-NEW-7).
- El fee-precheck `feeUsdc > budget → throw ProtocolFeeError` (`orchestrate.ts:316-322`) vive acá (corre antes de discovery). En el atómico se ejecuta una sola vez en plan → AC-10 preservado.
- El no-funds early-fail hace `budgetService.getBalance` (lectura, NO debit) — **permitido bajo CD-1** (read-only).
- Si llega al final sin early-return: devolvé `planStatus: 'ready'` + el plan completo: `steps`, `costPerStep` (resuelto con `resolveAgentPriceUsdc` por step, server-side), `totalCostUsdc = sum(costPerStep)`, `protocolFeeUsdc = feeUsdc`, `maxQuotedCostUsdc = await quoteMaxCostUsdc(steps, false)`, `reasoning`, `consideredAgents = discovered.agents`, + internos (`plannedCostUsd`, `feeUsdc`, `usedFallback`, `debitFallback: false` al salir de plan, `billingKeyRow`, `discoveredAgents: discovered.agents`).
- Exemplar: el cuerpo actual de `orchestrate()` L306-634.
- Verif: `tsc`.

**W1.2 — `executeApprovedPlan(request, plan, orchestrationId)`**
Contiene **verbatim** `orchestrate.ts:636-902` (price-fallback $1, debit step-0 + gas, debit-fail early-return, compose, fee + receipt, credit-back WKH-127, remaining, track final). Recibe del `plan`: `steps`, `plannedCostUsd`, `feeUsdc`, `usedFallback`, `debitFallback`, `billingKeyRow`, `discoveredAgents` (para `consideredAgents`), `reasoning`.

**Cap gate (AC-3/AC-4/AC-5) — al ENTRAR, ANTES del price-fallback y de cualquier `budgetService.debit` o `composeService.compose`:**
```ts
if (request.maxQuotedCostUsdc !== undefined) {        // CD-NEW-4: solo /execute, NO atómico
  const currentCostUsdc = await this.quoteMaxCostUsdc(plan.steps, /* forceRefresh */ true);
  if (currentCostUsdc > request.maxQuotedCostUsdc) {  // CD-NEW-3: antes de cualquier débito
    return { __quoteStale: true, currentCostUsdc, maxQuotedCostUsdc: request.maxQuotedCostUsdc };
  }
}
// ...resto verbatim de la región execute (price-fallback $1, debit step-0, compose, fee, refund)...
```
- En el atómico (`maxQuotedCostUsdc === undefined`) el gate NO corre → byte-idéntico (CD-NEW-4/AC-10).
- El debit step-0 con `getStepGasOverheadUsd` (AC-11), guard `i>0` de compose (AC-7), credit-back WKH-127 (AC-8), fee + receipt (AC-9), headers → **todo verbatim, sin cambios** (CD-6).
- Exemplar: cuerpo actual L636-902.
- Verif: `tsc`.

**W1.3 — `quoteMaxCostUsdc(steps, forceRefresh): Promise<number>` (espejo de AC-2)**
Réplica **línea-a-línea verificable** de `augmentX402ChallengeAmount` (`compose.ts:135-177`), pero sumando **TODOS** los steps (no `step0Usd + 1..N`, porque acá no hay step-0 ya resuelto). CD-NEW-1.
```ts
async quoteMaxCostUsdc(steps: ComposeStep[], forceRefresh: boolean): Promise<number> {
  let pipelineUsd = 0;
  for (const step of steps) {
    if (!step || typeof step.agent !== 'string') {   // step malformado → over-estimate
      pipelineUsd += PLACEHOLDER_FEE_USD;
      continue;
    }
    const price = await resolveAgentPriceUsdc(step.agent, step.registry, forceRefresh);
    const stepUsd =
      typeof price === 'number' && price > 0 && !Number.isNaN(price)
        ? price
        : PLACEHOLDER_FEE_USD;                         // not-found / 0 / null / NaN
    pipelineUsd += stepUsd;
  }
  if (pipelineUsd <= 0) return 0;
  const total = Number((pipelineUsd * (1 + getProtocolFeeRate())).toFixed(6));
  if (total <= 0) {
    if (pipelineUsd > 0) return 0.000001;              // floor never-undercharge
    return 0;
  }
  return total;
}
```
- **NO inventes fee math.** Es el mismo `resolveAgentPriceUsdc`, mismo fallback `PLACEHOLDER_FEE_USD`, mismo `(1+rate).toFixed(6)`, mismo floor `1e-6`. El Adversary lo compara contra `compose.ts:135-177`.
- En `planOrchestration`: `quoteMaxCostUsdc(steps, false)` (cache fresco, recién resuelto). En `executeApprovedPlan`/`/execute`: `quoteMaxCostUsdc(steps, true)` (cache-bust, RIESGO-2).
- `ComposeStep.registry` puede ser `undefined` → `resolveAgentPriceUsdc(step.agent, step.registry, ...)` lo tolera (3er param posicional).

**W1.4 — Recomponer `orchestrate()` + `mapPlanEarlyReturnToOrchestrateResult`**
```ts
async orchestrate(request, orchestrationId): Promise<OrchestrateResult> {
  const plan = await this.planOrchestration(request, orchestrationId);
  if (plan.planStatus !== 'ready') {
    return mapPlanEarlyReturnToOrchestrateResult(plan);   // mismos OrchestrateResult que hoy
  }
  // request.maxQuotedCostUsdc === undefined → cap gate inactivo (path atómico)
  const res = await this.executeApprovedPlan(request, plan, orchestrationId);
  // El atómico nunca devuelve __quoteStale (gate inactivo). Narrowing defensivo:
  if ('__quoteStale' in res) {
    throw new Error('unreachable: cap gate inactive on atomic path');
  }
  return res;
}
```
- `mapPlanEarlyReturnToOrchestrateResult(plan)` reconstruye el `OrchestrateResult` **exacto** que cada early-return devolvía hoy (mismos campos: `answer:null`, `reasoning`, `pipeline{success,...}`, `consideredAgents`, `protocolFeeUsdc:0`, `remainingBudgetUsd` donde aplica). **El `eventService.track` ya se disparó dentro de `planOrchestration` — NO se re-dispara acá** (CD-NEW-7: no duplicar telemetría).
- Mapeo de `pipeline.success` por early-return: ver tabla §7 (columna `pipeline.success`). no-funds → `false`; no-agents → `true`; budget_exhausted → `true`; no_relevant → `false`.
- Verif: `tsc` + **suite orchestrate existente verde SIN cambio de aserción** (prueba mecánica de AC-10/CD-4). Si un test del atómico falla, NO cambies su aserción — arreglá la composición.

### W2 — Rutas (`src/routes/orchestrate.ts`). Depende de W1. El `/` queda intacto.

**W2.1 — `POST /plan`** (exemplar: ruta `/`, `orchestrate.ts:38-141`)
- Schema body idéntico al `/` (`goal` required, `budget` required `exclusiveMinimum:0 maximum:100000`, `maxAgents` int 1-20, `preferCapabilities` array). 
- preHandlers **idénticos a `/`** (CD-7/AC-12): `...requireForwardKey(), createBackpressureHandler(), createTimeoutHandler(...), markSkipMiddlewareDebitHandler, ...requirePaymentOrA2AKey({...})`.
- rate limit: **mismo `orchestrateRateLimit()`** (DT-4).
- handler: `orchestrationId = crypto.randomUUID()`; arma el `request` igual que `/` (goal.trim(), budget, preferCapabilities, maxAgents, scopingKeyRow: `request.a2aKeyRow`, delegationContext, keySessionContext, chainId: `request.resolvedChainId`); `const plan = await orchestrateService.planOrchestration(req, orchestrationId)`; responde 200 con **solo los campos públicos** del `OrchestratePlanResult`: `{orchestrationId, planStatus, steps, costPerStep, totalCostUsdc, protocolFeeUsdc, maxQuotedCostUsdc, reasoning, consideredAgents}`. **NO** serialices los internos (`plannedCostUsd`, `billingKeyRow`, etc.). **NO** setees `x-a2a-remaining-budget` (no hubo débito).
- Mismo error-boundary `try/catch` que `/` (envuelve el throw con `orchestrationId` → el `ProtocolFeeError` lo mapea a 400).

**W2.2 — `POST /execute`** (exemplar: ruta `/`)
- Schema body: `orchestrationId` (string), `steps` (array minItems 1), `maxQuotedCostUsdc` (number `minimum:0`), `budget` (number `exclusiveMinimum:0 maximum:100000`), `preferCapabilities?`, `maxAgents?`.
- preHandlers idénticos a `/` **+ `markSkipMiddlewareDebitHandler` OBLIGATORIO** (CD-NEW-5/RIESGO-4 — sin él, double-charge del placeholder $1). rate limit: **mismo `orchestrateRateLimit()`**.
- handler: `orchestrationId = body.orchestrationId` (lo reenvía el cliente; NO generes uno nuevo). Re-construí el `plan` server-side: re-resolvé `costPerStep` con `resolveAgentPriceUsdc` desde `body.steps`, re-derivá `plannedCostUsd` desde `steps[0]` (NO de `costPerStep` del cliente — CD-NEW-6), `feeUsdc = budget*getProtocolFeeRate()`, etc. Pasá `maxQuotedCostUsdc: body.maxQuotedCostUsdc` en el `request`. Llamá `orchestrateService.executeApprovedPlan(req, plan, orchestrationId)`.
  - Si el resultado tiene `__quoteStale` → `reply.status(409).send({ error_code: 'QUOTE_STALE', currentCostUsdc, maxQuotedCostUsdc })`.
  - Sino: mismo mapeo de status que `/` (`pipeline.errorCode === 'SCOPE_DENIED' ? 403 : 200`) + mismos headers `x-debit-fallback` (de `result.debitFallback`) y `x-a2a-remaining-budget` (de `result.remainingBudgetUsd`).

> **Re-derivación del plan en /execute (DT-1/CD-NEW-6):** lo más limpio es que `executeApprovedPlan`, cuando viene de `/execute`, re-resuelva los precios internamente desde `plan.steps`. Una opción válida: el route arma un `OrchestratePlanResult` "parcial" con los `steps` del cliente y `executeApprovedPlan` re-deriva `plannedCostUsd`/`feeUsdc`/`debitFallback` server-side antes del debit. Lo importante (CD-NEW-6): **el `plannedCostUsd` base del débito step-0 NUNCA viene de `costPerStep` del cliente** — siempre `resolveAgentPriceUsdc(steps[0])` server-side. Documentá en el código de dónde sale cada valor.

### W3 — Tests. Depende de W1+W2.

Ver §8. Al final:
**W3.4** — `npx @biomejs/biome check --write` sobre los 5 archivos tocados + `npx tsc --noEmit` + suite completa verde (auto-blindaje WKH-130: biome por wave).

### Verificación incremental

| Wave | Verif |
|------|-------|
| W0 | `tsc` + `agent-price.test.ts` verde |
| W1 | `tsc` + **suite orchestrate existente verde SIN cambio de aserción** (no-drift) |
| W2 | `tsc` |
| W3 | suite completa + `biome check --write` + `tsc` |

---

## 7. Mapeo de los 6 early-returns (CD-5/CD-NEW-7) — SEGUIR LITERAL

Cada early-return se MUEVE a `planOrchestration`. Ninguno corre en `executeApprovedPlan` (salvo el debit-fail, que **pertenece a execute**). El `eventService.track` se dispara dentro de `planOrchestration` **exactamente como hoy**, una sola vez.

| # | Early-return (línea actual) | Trigger | `planStatus` | `pipeline.success` en el OrchestrateResult mapeado | `eventService.track` (preservado verbatim) | Dónde vive |
|---|------------------------------|---------|--------------|----------------------------------------------------|---------------------------------------------|-----------|
| 1 | no-funds `orchestrate.ts:336-378` | `billingKeyRow` + balance `NaN/≤0` | `insufficient_funds` | `false` (+ `remainingBudgetUsd: bal`) | `status:'failed', costUsdc:0, metadata{orchestrationId, agentCount:0, fallback:false}` (L363-374) | planOrchestration |
| 2 | no-agents `orchestrate.ts:395-426` | `discovered.agents.length===0` | `no_agents` | `true` | `status:'success', costUsdc:0, metadata{orchestrationId, agentCount:0, fallback:false}` (L412-423) | planOrchestration |
| 3 | no-budget-fit `orchestrate.ts:540-571` | `steps.length===0` post-plan | `budget_exhausted` | `true` (+ `consideredAgents: discovered.agents`) | `status:'success', costUsdc:0, metadata{orchestrationId, agentCount:0, fallback:usedFallback}` (L557-568) | planOrchestration |
| 4 | no-relevant `orchestrate.ts:587-626` | `allStepsAreDemos` | `no_relevant_agent` | `false` (+ `consideredAgents: discovered.agents`) | `status:'failed', costUsdc:0, metadata{orchestrationId, agentCount:0, fallback:usedFallback, reason:'no_relevant_agent', hasRealCandidate}` (L606-623) | planOrchestration |
| 5 | pre-compose timeout #1 `orchestrate.ts:451-455` | `elapsedMs > PRE_COMPOSE_TIMEOUT_MS` | (throw → error-boundary) | N/A — throw | **NO track** (igual al atómico) | planOrchestration |
| 6 | pre-compose timeout #2 `orchestrate.ts:630-634` | `preComposeElapsed > ...` | (throw → error-boundary) | N/A — throw | **NO track** | planOrchestration |
| — | **debit-fail** `orchestrate.ts:669-714` | `!debitRes.success` | (NO es de plan) | `false` | `status:'failed', costUsdc:0, metadata{orchestrationId, agentCount:steps.length, fallback:usedFallback}` (L697-712) | **executeApprovedPlan** |
| — | track final exitoso `orchestrate.ts:870-886` | post-compose | — | (resultado real) | `status:pipeline.success?'success':'failed', costUsdc:pipeline.totalCostUsdc, metadata{orchestrationId, agentCount:steps.length, fallback:usedFallback, protocolFeeUsdc}` | executeApprovedPlan |

> **Conteo de `track` (CD-5/CD-NEW-7) — INVARIANTE MECÁNICO:** `grep -c "eventService.track" src/services/orchestrate.ts` debe dar el **mismo número** pre y post refactor. Ninguno se borra, ninguno se duplica. Distribución: 4 en `planOrchestration` (early-returns 1-4) + 2 en `executeApprovedPlan` (debit-fail + track final). Los 2 timeouts NO tienen track (son throws). `mapPlanEarlyReturnToOrchestrateResult` **NO contiene ningún `eventService.track`** (la telemetría ya corrió en plan).

---

## 8. Test Plan (los 18 tests, ≥1 por AC)

| Test | AC / CD | Archivo | Compose |
|------|---------|---------|---------|
| T-PLAN-1: `/plan` happy → `planStatus:'ready'` + campos completos, **cero `budgetService.debit`** | AC-1, AC-13 | `orchestrate.test.ts` | mock |
| T-PLAN-2: `maxQuotedCostUsdc == sum(resolveAgentPriceUsdc)*(1+rate)` (mismo número que `augmentX402ChallengeAmount` para los mismos steps) | AC-2 | `orchestrate.test.ts` | mock |
| T-PLAN-3: no-funds → `planStatus:'insufficient_funds'` + track disparado | AC-6 | `orchestrate.test.ts` | mock |
| T-PLAN-4: no-agents → `planStatus:'no_agents'` + track | AC-6 | `orchestrate.test.ts` | mock |
| T-PLAN-5: no-budget-fit → `planStatus:'budget_exhausted'` + track | AC-6 | `orchestrate.test.ts` | mock |
| T-PLAN-6: all-demos → `planStatus:'no_relevant_agent'` + track (metadata `reason`, `hasRealCandidate`) | AC-6 | `orchestrate.test.ts` | mock |
| T-PLAN-7: conteo total de `eventService.track` call-sites == atómico (ninguno perdido/duplicado) | CD-5 | `orchestrate.test.ts` | mock |
| T-EXEC-1: `/execute` happy → debit step-0 + compose, 200 | AC-3(pass), AC-7 | `orchestrate.billing.test.ts` | **real** |
| T-EXEC-2: `currentCostUsdc > maxQuotedCostUsdc` → `409 QUOTE_STALE` body `{error_code,currentCostUsdc,maxQuotedCostUsdc}`, **cero debit** | AC-3, AC-5 | `orchestrate.test.ts` + `orchestrate.billing.test.ts` | mock + **real** |
| T-EXEC-3: precios del cliente IGNORADOS — cobro = `resolveAgentPriceUsdc` server-side (cliente manda costo falso, débito real ≠ falso) | AC-4 | `orchestrate.billing.test.ts` | **real** |
| T-EXEC-4: invariante total — `Σ(service step-0 + compose steps 1..N) == costo real`, cada step UNA vez | AC-7, CD-NEW-2 | `orchestrate.billing.test.ts` | **real** |
| T-EXEC-5: `pipeline.success===false` → credit-back (total si `totalCostUsdc===0`, parcial si `>0`, `refundOutbox` si credit falla) | AC-8 | `orchestrate.billing.test.ts` | **real** |
| T-EXEC-6: `pipeline.success===true` → `chargeProtocolFee` idempotente por `orchestrationId` + `receiptService.emit` + `protocolFeeUsdc` seteado | AC-9 | `orchestrate.billing.test.ts` | **real** |
| T-EXEC-7: debit step-0 incluye `getStepGasOverheadUsd(chainId)` | AC-11 | `orchestrate.billing.test.ts` | **real** |
| T-EXEC-8: `markSkipMiddlewareDebit` presente en preHandlers `/execute` → middleware NO debita placeholder $1 | RIESGO-4, CD-NEW-5 | `routes/orchestrate.test.ts` | mock |
| T-ATOM-1..N: tests existentes del `/` atómico pasan **SIN cambio de aserción** | AC-10, CD-4 | `orchestrate.test.ts` + `orchestrate.billing.test.ts` | mock + **real** |
| T-ROUTE-PLAN: `/plan` sin auth → 401/402 (mock middleware rechaza) | AC-12, CD-7 | `routes/orchestrate.test.ts` | mock |
| T-ROUTE-EXEC: `/execute` status (SCOPE_DENIED→403, else 200) + headers `x-debit-fallback`/`x-a2a-remaining-budget` | AC-10, CD-6 | `routes/orchestrate.test.ts` | mock |

**Cobertura AC:** AC-1(T-PLAN-1), AC-2(T-PLAN-2), AC-3(T-EXEC-2), AC-4(T-EXEC-3), AC-5(T-EXEC-2), AC-6(T-PLAN-3..6), AC-7(T-EXEC-1,4), AC-8(T-EXEC-5), AC-9(T-EXEC-6), AC-10(T-ATOM,T-ROUTE-EXEC), AC-11(T-EXEC-7), AC-12(T-ROUTE-PLAN), AC-13(T-PLAN-1). **13/13.**

### Cuáles van con compose REAL vs mock
- **Compose REAL** (`orchestrate.billing.test.ts`): T-EXEC-1, 3, 4, 5, 6, 7. Es el único harness que valida el invariante total de débitos sin mock de compose (auto-blindaje WKH-127). Mockea capa de borde (budget.debit/credit/getBalance, discovery, event, fee-charge, registry, downstream) pero ejecuta **compose real**.
- **Mock** (`orchestrate.test.ts`, `routes/orchestrate.test.ts`): T-PLAN-1..7, T-EXEC-2 (mock side), T-EXEC-8, T-ROUTE-PLAN, T-ROUTE-EXEC.

### Auto-blindaje crítico de tests
- **T-ATOM debe pasar SIN cambio de aserción del atómico.** Es la prueba mecánica de no-drift (AC-10/CD-4). Si tenés que cambiar una aserción de comportamiento del atómico para que pase, **algo en la composición está mal** — NO toques la aserción, arreglá `orchestrate()`/`mapPlanEarlyReturnToOrchestrateResult`.
- **`vi.hoisted` (WKH-130):** en `vi.mock` factories que referencian clases/const top-level, usá `vi.hoisted` (ya es el patrón en `orchestrate.test.ts:13,38`). Si agregás factories nuevas para tipos top-level, mismo patrón.
- **biome por wave (WKH-130):** corré `biome check --write` por archivo modificado.

---

## 9. Constraint Directives — Checklist NO violable (15 = 8 heredados + 7 nuevos)

**Heredados (work-item):**
- [ ] **CD-1** — `/plan` NUNCA debita/settlea (no `budgetService.debit`/`composeService.compose`/settle). `getBalance` read-only OK.
- [ ] **CD-2** — `/execute` NUNCA usa precios del cliente como base de cobro. Solo `resolveAgentPriceUsdc` server-side.
- [ ] **CD-3** — NO modificar el guard `i>0` de `compose.ts` (zero-touch).
- [ ] **CD-4** — `POST /orchestrate` byte-idéntico externamente; tests del atómico pasan sin cambio de aserción.
- [ ] **CD-5** — preservar TODOS los `eventService.track`; conteo de call-sites idéntico pre/post.
- [ ] **CD-6** — preservar debit/refund/fee/headers de execute (WKH-127/44/124).
- [ ] **CD-7** — NO exponer `/plan` sin auth (mismos preHandlers que `/`).
- [ ] **CD-8** — TypeScript strict, sin `any`; nuevos tipos como interfaces en `types/index.ts`.

**Nuevos (SDD):**
- [ ] **CD-NEW-1** — `quoteMaxCostUsdc` espejo línea-a-línea de `augmentX402ChallengeAmount` (`compose.ts:135-177`). NO inventar fee math.
- [ ] **CD-NEW-2** — NUNCA usar `maxQuotedCostUsdc`/`currentCostUsdc` como base del débito. Débito disjunto: step-0 (service) + 1..N (compose) + fee. Cada step UNA vez.
- [ ] **CD-NEW-3** — cap gate corre ANTES de cualquier `debit`/`compose` en `/execute` (QUOTE_STALE no debita).
- [ ] **CD-NEW-4** — `executeApprovedPlan` NO aplica cap gate cuando `maxQuotedCostUsdc === undefined` (path atómico → AC-10).
- [ ] **CD-NEW-5** — `markSkipMiddlewareDebitHandler` OBLIGATORIO en preHandlers de `/execute` (anti double-charge $1).
- [ ] **CD-NEW-6** — `/execute` NO re-deriva `plannedCostUsd` desde `costPerStep`/costo del cliente; siempre `resolveAgentPriceUsdc(steps[0])` server-side.
- [ ] **CD-NEW-7** — cada early-return mapeado dispara su `track` exactamente una vez en `planOrchestration`; `mapPlanEarlyReturnToOrchestrateResult` NO lo re-dispara.

**PROHIBIDO general:** NO dependencias nuevas. NO patrones distintos a los existentes. NO modificar archivos fuera de Scope IN. NO hardcodear (rate/fee/gas → funciones/env existentes). NO escribir en `src/index.ts`.

---

## 10. Done Definition

- [ ] W0.1 + W0.2 hechos; `tsc` verde; `agent-price.test.ts` verde (default `false` = sin cambio).
- [ ] `planOrchestration` + `executeApprovedPlan` + `quoteMaxCostUsdc` extraídos verbatim; `orchestrate()` recompuesto + `mapPlanEarlyReturnToOrchestrateResult`.
- [ ] Cap gate condicional implementado (`maxQuotedCostUsdc !== undefined`), ANTES de cualquier débito, devuelve `__quoteStale`.
- [ ] Rutas `/plan` (sin debit) + `/execute` (con `markSkipMiddlewareDebitHandler` + 409 QUOTE_STALE + headers). `/` intacto.
- [ ] `grep -c "eventService.track" src/services/orchestrate.ts` == valor pre-refactor (conteo idéntico).
- [ ] Los 18 tests escritos y verdes; T-ATOM SIN cambio de aserción del atómico.
- [ ] `biome check --write` + `tsc --noEmit` + suite completa verde.
- [ ] Los 15 CD respetados (checklist §9 completo).
- [ ] Cero cambios fuera de Scope IN.

---

*Story File generado por NexusAgil — Architect F2.5 (WKH-131 / SDD #128). Listo para F3.*
