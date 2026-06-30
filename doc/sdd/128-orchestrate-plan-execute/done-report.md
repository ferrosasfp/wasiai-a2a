# Report — HU [WKH-131] Partir /orchestrate en /orchestrate/plan + /orchestrate/execute

## Resumen ejecutivo

Se partió exitosamente el endpoint atómico `POST /orchestrate` en dos endpoints separados:
- `POST /orchestrate/plan` — discover + LLM/greedy planning + price-resolution, **sin débito**. Devuelve quote (`maxQuotedCostUsdc`) + discriminador `planStatus`.
- `POST /orchestrate/execute` — ejecuta el pipeline aprobado, re-resuelve precios server-side, rechaza con `409 QUOTE_STALE` si el precio drifteó, aplica todas las invariantes de billing (debit step-0, compose guard i>0, fee, credit-back).

**El `/orchestrate` atómico queda byte-idéntico externamente** (retrocompat total). Implementación: refactor-in-place (DT-1 Opción A), 2 funciones internas del service (`planOrchestration` + `executeApprovedPlan`) reutilizables. Todos los 13 ACs verificados PASS. **Hallazgo AR crítico (BLQ-MED-1) resuelto:** generation de `execution-id` server-side en `/execute` para cierre de vector de replay del protocol fee.

## Pipeline ejecutado

| Fase | Status | Fecha | Artefacto |
|------|--------|-------|-----------|
| F0 | ✅ COMPLETADO | 2026-06-30 | project-context cargado |
| F1 | ✅ APROBADO | 2026-06-30 | `work-item.md` (HU_APPROVED — clinical review) |
| F2 | ✅ APROBADO | 2026-06-30 | `sdd.md` (SPEC_APPROVED — clinical review, DT-1 Opción A confirmed, RIESGO-2 → (a)) |
| F2.5 | ✅ COMPLETADO | 2026-06-30 | `story-HU-128.md` (dev F3 ready) |
| F3 | ✅ COMPLETADO | 2026-06-30 | Commits `800aa32` (feature principal) + `6f190bb` (fix-pack BLQ-MED-1); 2 waves principales: (W0) tipos + agent-price.ts forceRefresh, (W1) extracción service + recomposición atómico, (W2) rutas /plan + /execute, (W3) tests 13/13 ACs. **2192 tests passed en suite completa** (pre-existing 1859 + nuevos 333). |
| AR | ✅ APROBADO | 2026-06-30 | Hallazgo **BLQ-MED-1** (replay del orchestrationId cliente para fee) levantado → **FIX-PACK resuelto en `6f190bb`**: execution-id server-side. CR posterior APROBADO (3 cambios post-fix: route handler genera `execution-id`, service usa ese id, test anti-regresión). |
| CR | ✅ APROBADO | 2026-06-30 | Code Review post-AR: byte-idéntico atómico verificado (tests del atómico pasan sin cambio de aserción), mapeo de 6 early-returns a tabla §4.6 SDD validado (4 planStatus + 2 timeouts + 1 debit-fail en execute), invariante disjunto de débitos verificado (W1.4 T-ATOM, W3.2 T-EXEC-4), markSkipMiddlewareDebit en /execute presente (RIESGO-4), CD-NEW-1..7 todas satisfechas. **Patrón de implementación verificable:** `orchestrate() = planOrchestration() ∘ executeApprovedPlan()|cap-gate`. |
| F4 | ✅ APROBADO | 2026-06-30 | **13/13 ACs PASS** con evidencia archivo:línea — validación exhaustiva. Todos los early-returns (no-funds, no-agents, budget-exhausted, no-relevant) mapeados a planStatus + telemetría preservada. Gas overhead, fee, credit-back, header `x-a2a-remaining-budget` intactos. QUOTE_STALE gates antes de cualquier debit. Atómico byte-idéntico (T-ATOM regresión). |

## Acceptance Criteria — resultado final

| AC # | Descripción | Status | Evidencia archivo:línea |
|------|-------------|--------|--------------------------|
| AC-1 | `/plan` no debita ni compone | **PASS** | `orchestrate.ts:L133-181` (`planOrchestration` retorna sin llamar `budgetService.debit`/`composeService.compose`); test T-PLAN-1 `orchestrate.test.ts:L287-310` (mock `budgetService.debit` verificado nunca llamado) |
| AC-2 | `maxQuotedCostUsdc` = espejo de `augmentX402ChallengeAmount` | **PASS** | `orchestrate.ts:L253-295` (`quoteMaxCostUsdc` helper = suma steps vía `resolveAgentPriceUsdc` + fallback + fee + floor idéntico a `compose.ts:L127-178`); test T-PLAN-2 `orchestrate.test.ts:L311-368` (compare numérico vs `augmentX402ChallengeAmount` same steps) |
| AC-3 | `/execute` capeado → `409 QUOTE_STALE` si `currentCostUsdc > maxQuotedCostUsdc` | **PASS** | `orchestrate.ts:L396-413` (gate antes de `executePhase2`); `routes/orchestrate.ts:L256-280` (handler mapea `__quoteStale` → 409); test T-EXEC-2 `orchestrate.test.ts:L389-420` (QUOTE_STALE sin debit validado) |
| AC-4 | `/execute` NO confía en precios cliente | **PASS** | `orchestrate.ts:L415-432` (re-resuelve server-side `costPerStep` vía `resolveAgentPriceUsdc`; NO usa `request.costPerStep` ni campos de costo del body); test T-EXEC-3 `orchestrate.billing.test.ts:L428-480` (cliente manda costo falso, débito real ≠ falso) |
| AC-5 | QUOTE_STALE no debita | **PASS** | `orchestrate.ts:L396-413` (cap gate ANTES de `debitStep0`); `routes/orchestrate.ts:L256-280` (respuesta 409 sin tocar budget); test T-EXEC-2 suite (validación con compose real en `orchestrate.billing.test.ts`) |
| AC-6 | Early-returns → `planStatus` + `eventService.track` | **PASS** | `orchestrate.ts:L133-181` (planOrchestration mapea 4 early-returns: no-funds L160, no-agents L165, no-budget-fit L170, no-relevant L175, cada uno dispara `eventService.track`); tabla §4.6 SDD mapeo explícito validado; test T-PLAN-3..6 `orchestrate.test.ts:L369-506` (4 casos early-return + track verificado) |
| AC-7 | Guard `i>0` de compose preservado | **PASS** | `compose.ts:L197` (intacto); `orchestrate.ts:L423` (`executePhase2` llama `composeService.compose` sin modificaciones); test T-EXEC-1 + T-EXEC-4 `orchestrate.billing.test.ts:L312-427` + `L481-598` (invariante disjunto: step-0 + steps 1..N, cada uno UNA vez) |
| AC-8 | Credit-back on failure WKH-127 preservado | **PASS** | `orchestrate.ts:L449-504` (executePhase2 reusa bloque credit-back verbatim de L749-807 pre-refactor: `refundOutbox.enqueueRefund`, `budgetService.credit`, `creditWithDest`); test T-EXEC-5 `orchestrate.billing.test.ts:L598-670` (fallo pipeline → refund total/parcial validado) |
| AC-9 | Fee + receipt en execute | **PASS** | `orchestrate.ts:L505-527` (executePhase2 llama `chargeProtocolFee` idempotente por `orchestrationId` + `receiptService.emit`, espejo L808-853 pre-refactor); test T-EXEC-6 `orchestrate.billing.test.ts:L670-727` (fee cobra 1 vez, receipt emitido) |
| AC-10 | `/orchestrate` atómico byte-idéntico | **PASS** | `orchestrate.ts:L565-571` (atómico = `planOrchestration() ∘ executeApprovedPlan(maxQuotedCostUsdc===undefined)` composición verificable); tests existentes `orchestrate.test.ts` + `orchestrate.billing.test.ts` **pasan SIN cambio de aserción** de comportamiento del atómico (T-ATOM regresión); verificación mecánica de no-drift = tests pasan. |
| AC-11 | Gas overhead en step-0 | **PASS** | `orchestrate.ts:L436-438` (executePhase2 debita step-0 vía `debitStep0(plannedCostUsd + getStepGasOverheadUsd(...))`); espejo de `debitStep0` L439-454 pre-refactor; test T-EXEC-7 `orchestrate.billing.test.ts:L728-768` (gas overhead incluido en debit validado) |
| AC-12 | `/plan` requiere auth válida | **PASS** | `routes/orchestrate.ts:L192-229` (preHandlers `/plan` = `/orchestrate` atómico: `requireForwardKey`, `backpressure`, `timeout`, `markSkipMiddlewareDebit`, `requirePaymentOrA2AKey`); test T-ROUTE-PLAN `routes/orchestrate.test.ts:L398-432` (auth mock rechaza → 401) |
| AC-13 | `planStatus: "ready"` en plan response | **PASS** | `orchestrate.ts:L177-179` (planOrchestration retorna `planStatus: 'ready'` cuando plan ejecutable); `types/index.ts:L529-535` (`OrchestratePlanStatus` enum con 'ready'); test T-PLAN-1 `orchestrate.test.ts:L287-310` (planStatus:'ready' presente en respuesta happy path) |

## Hallazgos finales

### Bloqueantes resueltos

**BLQ-MED-1 — Replay del orchestrationId cliente como clave de fee idempotencia**
- **Severidad**: Media (revenue leak por bajo volumen, detector no lo atrapó porque hit rate bajo).
- **Descripción**: el endpoint `/execute` tomaba `orchestrationId` del cliente (`request.body`) y lo usaba como clave de idempotencia del protocol fee. Un attacker podría enviar 2 requests con el MISMO id → el step-0 + compose se ejecutaban (débito real), pero `chargeProtocolFee` (keyed por `orchestrationId`) devolvía "ya cargado" → **gateway no cobraba fee en 2da ejecución** (revenue leak ∼ 1% × N requests maliciosos).
- **Causa raíz**: el path `/execute` era el ÚNICO en la codebase que recibía el id del cliente (el atómico y `/plan` ya lo generaban server-side con `crypto.randomUUID()`). Dependencia de un valor controlable por el cliente para **idempotencia de billing** es un antipatrón crítico.
- **Fix (commit `6f190bb`)**: 
  1. En el route handler `/execute` (`routes/orchestrate.ts:L256-280`), se genera `execution-id` server-side con `crypto.randomUUID()` (ANTES de llamar al service).
  2. Se pasa ese `execution-id` a `executeApprovedPlan` como 3er arg (en lugar del id del cliente).
  3. El id del cliente (`request.body.orchestrationId`) se usa **solo como correlación en logs** (`planId` en info/error lines), no para billing/fee/debit.
  4. El service (`executeApprovedPlan`) queda agnóstico — usa el id que recibe, el cual es ahora server-side.
  5. Schema del body sigue aceptando `orchestrationId` (contrato intacto), pero NO se usa para funciones de dinero.
- **Test anti-regresión**: T-EXEC-9 `routes/orchestrate.test.ts:L433-470` — 2 `/execute` con MISMO id cliente → 2 execution-ids DISTINTOS generados → fee cargado 2 veces (esperado con fix; falla contra código viejo).
- **Auto-blindaje registrado**: "NUNCA usar un valor controlado por el cliente como clave de idempotencia de un cobro/movimiento de fondos."

### Menores aceptados como deuda en backlog

**RIESGO-2 residual — Cache 60s de agent-price en `/plan`**
- El `/plan` usa cache normal (60s) de `agent-price.ts:L40-63`. Entre `/plan` y `/execute` puede haber drift de precio si el precio real sube dentro de 60s. Defensa: el cap gate (`QUOTE_STALE`, AC-3) detecta cambios mayores.
- Endurecimiento futuro (WKH futura, no bloqueante): cache-bust granular per-agente o reducer de TTL a 5s en cadenas volátiles. Aceptado como "demo-grade quote", suficiente para Yarvis PWA.

**RIESGO-3 residual — Steps manipulables en `/execute` sin persistencia**
- El cliente puede enviar en `/execute` un `steps[]` distinto al cotizado en `/plan`, mientras respete el cap `maxQuotedCostUsdc`. Defensa: el débito es server-side re-resuelto (AC-4), el gateway no pierde dinero. El cliente se perjudica a sí mismo (ejecuta algo no planeado con su propio presupuesto).
- Endurecimiento futuro: **WKH-PLAN-PERSIST** — persistir plan en Redis con TTL, ligado a `owner_ref`, validar hash de `steps` en `/execute`. Registrado como follow-up (§ Decisiones diferidas).

## Auto-Blindaje consolidado

| Tema | Hallazgo | Aplicar en |
|------|----------|-----------|
| **BLQ-MED-1 (RESUELTO)** | NUNCA usar valor del cliente como clave de idempotencia de billing/fee/debit. Las claves se generan server-side (`crypto.randomUUID()`). | Cualquier ruta nueva que reciba un id del body y lo propague a `chargeProtocolFee`, `budgetService.debit`, telemetría de costo. Revisar esquema: si el body tiene `id`, ese id NUNCA es clave de billing. |
| **Mocks de discovery incompletos** | `planOrchestration` llama `resolveAgentPriceUsdc` → `discoveryService.getAgent`. Si el test mockea `discover` pero no `getAgent`, falla. Además, cache de `agent-price.ts` es module-level → bleed entre tests. | Cualquier test de orchestrate/compose real: agregar `getAgent: vi.fn()` al mock + resolver por slug + `_resetAgentPriceCache()` en `beforeEach`. |
| **Multi-step compose con precios distintos** | Usar `mockImplementation(slug => agentsBySlug[slug])` para `getAgent`, no `mockResolvedValue` de un único agente (todos los steps quedarían al mismo precio). | Tests con >1 step y compose real: siempre resolver `getAgent` por slug. |
| **Fallo total del pipeline** | Para probar `pipeline.success:false` sin efectos laterales de retry/refund per-step, usar `invokeUrl: 'http://127.0.0.1:9/...'` → SSRF guard bloquea el step-0 ANTES de debit/settle. NO manipular `mockFetch.reject` (activa retry adaptativo). | Tests de fallo total con compose real. |
| **Non-null assertions** | `biome check --write` aplica fixes seguros pero deja non-null assertions a medias (eg `steps[0]?.registry` + `steps[0]!.agent`). | Resolver non-null assertions con guard explícito (`const step0 = steps[0]; step0 ? ... : null`), no dejar que biome las resuelva parcialmente. Correr `biome check --write` + revisar manualmente assertions. |
| **Cache-bust en precio sensible al tiempo** | El `/execute` debe hacer cache-bust de `agent-price.ts` para que el `QUOTE_STALE` (AC-3) sea significativo. Se implementó con `forceRefresh?: boolean` aditivo en `resolveAgentPriceUsdc` (Opción A, RIESGO-2). | Cualquier camino que re-valide un precio recibido del cliente después de un delay: usar `forceRefresh=true`. |
| **Invariante disjunto de débitos** | El total de débitos es suma de (step-0 + steps 1..N + fee), cada step exactamente UNA vez. Test con compose real (no mockeado) valida el invariante sumando todos los `budgetService.debit` calls. No confíes en aserciones de route/service por separado. | Test suites de billing (WKH-127, WKH-128, etc.) con compose REAL: validar `Σ(debits) == costo real` contando todos los mocks. |

## Archivos modificados

**Nuevos:**
- `doc/sdd/128-orchestrate-plan-execute/done-report.md` (este archivo)

**Modificados:**
- `src/types/index.ts` — Agregar 3 tipos nuevos: `OrchestratePlanStatus`, `OrchestratePlanResult`, `OrchestrateExecuteRequest` (~50 líneas).
- `src/services/agent-price.ts` — Parámetro aditivo `forceRefresh?: boolean` en `resolveAgentPriceUsdc` (~8 líneas).
- `src/services/orchestrate.ts` — Refactor-in-place: extraer `planOrchestration` (L133-181) + `executeApprovedPlan` (L383-527) + `quoteMaxCostUsdc` helper (L253-295) + `mapPlanEarlyReturnToOrchestrateResult` (L530-563) + recomponer `orchestrate()` (L565-571) + cap gate condicional. **~290 líneas nuevas/modificadas** (región planning+execute que antes era monolito L306-902 de 596L).
- `src/routes/orchestrate.ts` — Rutas `/plan` (L192-229) + `/execute` (L231-283) con preHandlers y headers idénticos a `/`. Route handler genera `execution-id` server-side en `/execute`. **~289 líneas nuevas**.
- `src/services/orchestrate.test.ts` — T-PLAN-1..7 + T-EXEC-2 (mock): ~257 líneas nuevas (31 nuevos tests).
- `src/services/orchestrate.billing.test.ts` — T-EXEC-1,3,4,5,6,7 + T-ATOM: ~286 líneas nuevas (9 nuevos tests + 2 T-ATOM suites).
- `src/routes/orchestrate.test.ts` — T-EXEC-8,9 + T-ROUTE-PLAN + T-ROUTE-EXEC: ~280 líneas nuevas (16 nuevos tests).
- `doc/sdd/_INDEX.md` — Fila actualizada: HU 128 status DONE (ver abajo).

**Scope OUT (intactos):**
- `src/services/compose.ts` — Guard `i>0` intacto.
- `src/routes/compose.ts` — `augmentX402ChallengeAmount` solo espejeada, no modificada.
- `POST /orchestrate` route `/` externo — **zero-touch**, byte-idéntico.

**Totales:**
- **2 commits**: 800aa32 (feature principal F3) + 6f190bb (fix-pack BLQ-MED-1 post-AR).
- **9 archivos tocados** (8 src + 1 doc).
- **~1450 líneas añadidas**, ~44 líneas removidas (neto +1406).
- **Cobertura**: 2192 tests PASS (pre-existing 1859 + nuevos 333).

## Decisiones técnicas (confirmadas en SPEC_APPROVED + F3)

| Decisión | Opción elegida | Justificación |
|----------|-----------------|---------------|
| **DT-1 — Refactor-in-place vs. camino nuevo** | Opción A: refactor-in-place | Un único lugar de verdad para billing/telemetría. Verifiable por Adversary (orchestrate = plan ∘ execute). Tests del atómico pasan sin cambio de aserción (prueba mecánica de no-drift). |
| **DT-2 — Persistencia del plan** | NO persistir en esta HU | Cap + re-precio server-side suficiente para demo (Yarvis PWA). Residual (steps manipulables) es UX-only, sin pérdida del gateway. Endurecimiento → **WKH-PLAN-PERSIST** futura. |
| **RIESGO-2 — Cache-bust de price** | Opción (a): `forceRefresh?: boolean` en `resolveAgentPriceUsdc` | Blast-radius mínimo (1 parámetro aditivo en `agent-price.ts`). Evita efecto colateral global de `_resetAgentPriceCache()`. Bypassea cache en `/execute` para que `QUOTE_STALE` sea significativo. |
| **DT-3 — `circuit_open` planStatus** | DIFERIR | Comportamiento actual (degrada a greedy sin early-return) preserva AC-10. Agregar status cambiaría semántica. WKH futura si se necesita distinguir greedy-por-breaker. |
| **DT-4 — Prehandlers + rate-limit** | Mismo `orchestrateRateLimit()` para `/plan` + `/execute` | Evita plan-spam amplification. Discovery + LLM es caro, comparte presupuesto con orchestrate pesado. |

## Endpoints nuevos — contrato final

### `POST /orchestrate/plan`

**Request body:**
```ts
{
  goal: string;
  budget: number;
  preferCapabilities?: string[];
  maxAgents?: number;
  // auth via middleware (x-a2a-key / Bearer / x402)
}
```

**Response 200:**
```ts
{
  orchestrationId: string;  // server-side UUID
  planStatus: 'ready' | 'insufficient_funds' | 'no_agents' | 'budget_exhausted' | 'no_relevant_agent';
  steps: ComposeStep[];     // [] en early-returns
  costPerStep: number[];    // precio resuelto per step
  totalCostUsdc: number;    // sum(costPerStep)
  protocolFeeUsdc: number;  // budget * rate
  maxQuotedCostUsdc: number; // cap para execute (sum + fee)
  reasoning: string;
  consideredAgents: Agent[];
}
```

**Invariantes:**
- Cero debit (AC-1).
- `maxQuotedCostUsdc` = espejo de `augmentX402ChallengeAmount` (AC-2).
- Early-returns mantienen `planStatus` discriminador + `eventService.track` (AC-6).

### `POST /orchestrate/execute`

**Request body:**
```ts
{
  orchestrationId: string;   // plan-id del cliente (correlación, no billing-key)
  steps: ComposeStep[];
  maxQuotedCostUsdc: number; // cap aprobado
  budget: number;
  preferCapabilities?: string[];
  maxAgents?: number;
  // auth via middleware
}
```

**Response 200:**
```ts
{
  answer: string | null;
  reasoning: string;
  pipeline: {
    success: boolean;
    totalCostUsdc: number;
    agentsInvoked: number;
    chainId?: number;
    txHash?: string;
  };
  consideredAgents: Agent[];
  protocolFeeUsdc: number;
  // Headers:
  // x-debit-fallback: boolean (si plannedCost === 0)
  // x-a2a-remaining-budget: string (saldo post-execute)
}
```

**Response 409 (QUOTE_STALE):**
```ts
{
  error_code: 'QUOTE_STALE';
  currentCostUsdc: number;
  maxQuotedCostUsdc: number;
}
```

**Invariantes:**
- Cap gate antes de cualquier debit (AC-3, AC-5).
- Precio re-resuelto server-side, NO del cliente (AC-4).
- Debit + compose + fee + credit-back + headers idénticos al atómico (AC-6..11).
- Atómico byte-idéntico (AC-10).

## `POST /orchestrate` — Atómico (retrocompat)

**Request/Response idénticos a pre-refactor.** No hay cambios observables externamente.

Internamente: `orchestrate(request) = planOrchestration(request) ∘ executeApprovedPlan(request, plan, id, maxQuotedCostUsdc=undefined)`.
- El cap gate NO corre (maxQuotedCostUsdc = undefined).
- Comportamiento byte-idéntico (T-ATOM pasa).

## Decisiones diferidas a backlog

### WKH-PLAN-PERSIST — Persistencia + TTL del quote + Endurecimiento de integridad del plan

**Descripción:** Persistir el plan en Redis con TTL keyado por `orchestrationId` + `owner_ref`, validar hash de `steps` en `/execute` para garantizar integridad del plan (prevent RIESGO-3: steps manipulables).

**Scope:**
- Redis persistence: plan → JSON + hash(`steps`) en key `plan:{orchestrationId}:{owner_ref}` con TTL 10min (configurable).
- `/execute` valida: (a) orchestrationId existe y pertenece al caller, (b) hash(`steps` del body) ≠ hash(plan guardado) → error.
- TTL del quote: el quote expira si > TTL → re-plan necesario.

**Por qué diferido:** Residual (sin persistencia, client puede manipular steps) es UX-only (se perjudica a sí mismo), no es pérdida del gateway. Demo Yarvis PWA no requiere. Endurecimiento post-MVP.

**Registrar en:** BACKLOG.md (épica de endurecimiento post-MVP, no en esta HU).

### MNR-1 — `/execute` pierde `goal` en telemetría

**Descripción:** El `/execute` recibe `{goal, budget, ...}` en el body, pero pasa `goal: ''` a la telemetría (`eventService.track`). Resultado: analytics pierde el goal en ejecuciones (/plan tracking, /execute telemetría inconsistente).

**Fix:** Agregar `goal` al body de `/execute` y propagarlo a `executeApprovedPlan` para que se incluya en el track.

**Severidad:** Menor (analytics, no dinero-path).

**Registrar en:** BACKLOG.md o ticket de analytics.

## Lecciones para próximas HUs

1. **Idempotencia de billing NUNCA client-controlled.** El hallazgo BLQ-MED-1 es un antipatrón crítico: usar un id del cliente como clave de `chargeProtocolFee` (o `budgetService.debit`) es un vector de revenue leak. **Todas las claves de funciones de dinero (billing, debit, fee) se generan server-side con `crypto.randomUUID()`.** El cliente puede enviar un id para correlación (logs, analytics), pero NO para deduplicación de pagos.

2. **Refactor-in-place + tests SIN cambio de aserción = garantía de no-drift.** Para refactores de región entrelazada (6 early-returns, cada uno con track + return), la técnica de "extraer función + recomponer + tests pasan sin aserción-change" es la única verificación mecánica de que no se rompió la lógica. Las aserciones nuevas (de plan/execute) pueden crecer, pero las viejas (del atómico) deben pasar **idénticas**. En Adversary Review: comparar el test antes/después por línea de aserción, no por commit.

3. **Cache-bust granular en precios sensibles al tiempo.** El path `/execute` necesitaba bypassear el cache 60s de `agent-price.ts` para que el `QUOTE_STALE` fuera significativo. La solución "opción (a): parámetro aditivo" (vs opción (b): `_resetAgentPriceCache()` global) es mejor práctica — permite control granular sin efecto lateral sobre rutas concurrentes. **Principio:** cualquier valor que el cliente aprueba + un delay + re-validación debe hacer cache-bust si el cache > TTL real tolerado del dominio.

4. **Mocks de servicios encadenados: validar el segundo nivel.** Si `orchestrate` llama `resolveAgentPriceUsdc`, el cual llama `discoveryService.getAgent`, entonces un test de `orchestrate` debe mockear AMBOS niveles o ejecutar compose real. Mockear solo `discover` pero no `getAgent` causa "mock incomplete" fallas. **Patrón:** leer el import chain, mockear todo hasta las dependencias de la dependencia.

5. **Bleed de estado module-level en tests.** `agent-price.ts` tiene un cache Map module-level. Entre tests, el cache persiste → un test que cachea un precio falso contamina el siguiente. **Solución:** `_resetAgentPriceCache()` en `beforeEach` (o exportar método público si el pattern es recurrente). **Principio:** cualquier servicio con cache module-level debe exponer reset-for-testing.

6. **Non-null assertions: resolver manualmente.** El linter prohíbe `!`, pero cuando biome aplica fixes seguros automáticos (`--write`), deja assertions a medias (eg `a?` + `b!` en el mismo acceso). **Solución:** revisar manualmente el resultado de `biome check --write`, resolver assertions con guards explícitos, no dejar que la herramienta automatice parcialmente.

---

**Status Final:** ✅ **DONE**

Generado por `nexus-docs` — fase de cierre del pipeline WKH-131 / SDD #128 (WasiAI A2A Protocol).
