# Work Item — [WKH-132] Protocol fee de /orchestrate proporcional al costo REAL del pipeline (no al budget declarado) + consistencia del quote

## Resumen
El protocol fee de `/orchestrate` (y por herencia `/orchestrate/plan` + `/orchestrate/execute`, WKH-131) se calcula hoy sobre el `budget` que el caller declara, no sobre el costo real del pipeline — un pipeline de 0.061 USDC puede facturar un fee de 0.01 a 0.05 USDC (16%–82% efectivo) según el `budget` que el caller haya puesto. Además, el mismo plan expone dos cifras de fee que no cuadran entre sí (`protocolFeeUsdc` vs el fee implícito en `maxQuotedCostUsdc`), lo que produce un QuoteCard aritméticamente imposible en la PWA Yarvis. Esta HU corrige la base del fee (costo real, no budget) y fuerza consistencia interna del quote, preservando intactas las protecciones de money-path existentes (WKH-44, WKH-127, BLQ-MED-1).

## Sizing
- SDD_MODE: full
- Estimación: M
- Branch sugerido: `fix/129-wkh-132-orchestrate-fee-on-cost`
- Modo: QUALITY (money-path, AR obligatorio) — confirmado, NO se baja de QUALITY.

## Hallazgo de grounding (F0) — importante para F2

`/compose` (WKH-118, `src/routes/compose.ts:528-541`) YA cobra el protocol fee sobre el **costo real** del pipeline:

```ts
const feeResult = await chargeProtocolFee({
  orchestrationId: request.id,
  budgetUsdc: result.totalCostUsdc,   // <- costo REAL post-compose, NO un budget declarado
  feeRate: getProtocolFeeRate(),
});
```

`orchestrate.ts` es el ÚNICO call site de `chargeProtocolFee` que todavía pasa el `budget` declarado por el caller (`orchestrate.ts:963: budgetUsdc: budget`). El nombre del parámetro `FeeChargeParams.budgetUsdc` (`fee-charge.ts:34`) es engañoso — en la práctica ya es "la base sobre la que se aplica el rate", y compose demuestra que esa base puede (y debe) ser el costo real. **Esto no es inventar un modelo nuevo: es converger `orchestrate.ts` al patrón que `compose.ts` ya usa desde WKH-118.** Esto reduce significativamente el riesgo de la HU y debe guiar el diseño en F2.

## Acceptance Criteria (EARS)

- AC-1: WHEN `planOrchestration` produce un plan con `planStatus:'ready'`, the system SHALL calcular `protocolFeeUsdc` como función del costo real resuelto del pipeline (`costPerStep`/`totalCostUsdc`, server-side vía `resolveAgentPriceUsdc`), NO del `budget` declarado por el caller.
- AC-2: THE system SHALL garantizar que, para todo plan `'ready'` devuelto por `/orchestrate/plan`, `maxQuotedCostUsdc == totalCostUsdc + protocolFeeUsdc` (tolerancia de redondeo ≤ 1e-6 USDC).
- AC-3: WHEN `executeApprovedPlan` cobra el protocol fee vía `chargeProtocolFee`, the system SHALL cobrar el MISMO valor de `feeUsdc` que fue cotizado en el plan aprobado (o un valor re-derivado pero consistente si el plan se re-resuelve server-side en `/execute`) — NUNCA un valor recalculado a partir de `budget`.
- AC-4: IF el guard de seguridad heredado de WKH-44 (AC-7, `orchestrate.ts:386-390`, hoy `feeUsdc > budget`) se conserva, THEN the system SHALL redefinir su semántica para comparar el fee basado-en-costo contra la referencia correcta (p.ej. costo+fee vs budget), de forma que siga protegiendo contra un `PROTOCOL_FEE_RATE` corrupto sin conflar costo con budget.
- AC-5: WHILE se ejecuta el path atómico `/orchestrate` (sin gate `maxQuotedCostUsdc`), the system SHALL preservar su contrato de respuesta externo (CD-4 de WKH-131) salvo el valor corregido de `protocolFeeUsdc` y su consistencia con el costo real del pipeline.
- AC-6: THE system SHALL preservar intacta la semántica de débito/credit-back step-0-only de WKH-127 (débito = `plannedCostUsd` [+ gas overhead], credit-back en fallo comparando contra `plannedCostUsd`/`debitedUsd`) — el cambio de base del fee NO debe tocar el débito de step-0 ni los débitos per-step de compose (steps 1..N, guard `i>0`).
- AC-7: THE system SHALL preservar sin modificar el mecanismo de idempotencia del fee basado en `execution-id` server-side (`crypto.randomUUID()`) usado en `/execute` (BLQ-MED-1, WKH-131) que cierra el replay del fee.
- AC-8: THE system SHALL mantener `augmentX402ChallengeAmount` (`src/routes/compose.ts:127-178`) y `quoteMaxCostUsdc` (`src/services/orchestrate.ts:757-786`) calculando la MISMA fórmula (`pipelineUsd * (1 + protocolFeeRate)`) — esta HU NO debe introducir drift entre esos dos espejos ya existentes.
- AC-9: WHEN se planifica un pipeline cuyo costo real es 0.061 USDC con `budget=1.0` USDC y, por separado, con `budget=5.0` USDC, the system SHALL reportar el MISMO `protocolFeeUsdc` (~0.00061, 1% de 0.061) en ambos casos — el fee NO debe escalar con el `budget` declarado.

## Scope IN
- `src/services/orchestrate.ts:377-390` — cálculo inicial `feeUsdc = budget * feeRate` + guard AC-7 WKH-44 (semántica a rediseñar).
- `src/services/orchestrate.ts:716-746` — ensamblado de `costPerStep`/`totalCostUsdc`/`maxQuotedCostUsdc`/`protocolFeeUsdc` en el `OrchestratePlanResult` `'ready'`.
- `src/services/orchestrate.ts:757-786` — `quoteMaxCostUsdc` (candidato a única fuente de verdad para derivar el fee).
- `src/services/orchestrate.ts:925-931` — `maxBudget = budget - feeUsdc` pasado a `composeService.compose`.
- `src/services/orchestrate.ts:950-965` — `protocolFeeUsdc = feeUsdc` + call a `chargeProtocolFee({ budgetUsdc: budget, ... })` (debe pasar costo real, no `budget`).
- `src/services/fee-charge.ts:32-36` (`FeeChargeParams`, posible rename `budgetUsdc`→`feeBaseUsdc`) y `:157-171` (cálculo interno `feeUsdc = budgetUsdc * feeRate` + guard espejo).
- Tests: `src/services/orchestrate.test.ts`, `src/services/orchestrate.billing.test.ts`, `src/services/fee-charge.test.ts`, `src/routes/orchestrate.test.ts`, `src/routes/compose.fee.test.ts` (regresión — verificar que el fee de compose, ya cost-based, no se rompe), `src/routes/compose.test.ts` (regresión).

## Scope OUT
- `src/routes/compose.ts:528-541` (llamada a `chargeProtocolFee` de WKH-118) — YA es cost-based; fuera de scope modificar, solo se usa como referencia de patrón y se re-verifica por regresión.
- `src/routes/compose.ts:127-178` (`augmentX402ChallengeAmount`) — la fórmula debe permanecer sin cambios (solo se verifica que sigue sin drift respecto a `quoteMaxCostUsdc`, AC-8).
- PWA Yarvis (`QuoteCard`, repo separado) — se corrige sola una vez que los campos del backend cuadren; no se toca en esta HU.
- Mecanismo de débito/credit-back step-0 de WKH-127 — sin cambios (solo re-verificado, AC-6).
- Mecanismo de idempotencia `execution-id` de BLQ-MED-1/WKH-131 — sin cambios (solo re-verificado, AC-7).
- Rango válido de `PROTOCOL_FEE_RATE` ([0.0, 0.10], `fee-charge.ts:68-69`) — sin cambios.
- Nuevos endpoints o migraciones DB — no se requieren para esta HU (a confirmar en F2; si el diseño elegido necesita persistir algo nuevo, Architect debe escalarlo).

## Decisiones técnicas (DT-N)

- **DT-1 (converger con WKH-118)**: la llamada a `chargeProtocolFee` en `executeApprovedPlan` (`orchestrate.ts:961-965`) debe pasar el costo real del pipeline (p.ej. `pipeline.totalCostUsdc` post-compose) como base del fee, espejando exactamente `compose.ts:539` (`budgetUsdc: result.totalCostUsdc`). No es un modelo nuevo, es alinear con el patrón ya vigente en `/compose`.
- **DT-2 (consistencia por construcción)**: `protocolFeeUsdc` cotizado en el plan debe derivarse de la MISMA resolución de precios que `maxQuotedCostUsdc` (`quoteMaxCostUsdc`, `forceRefresh=false` en plan), de forma que `maxQuotedCostUsdc == totalCostUsdc + protocolFeeUsdc` se cumpla por construcción (p.ej. `protocolFeeUsdc = maxQuotedCostUsdc - totalCostUsdc`) en vez de mantener dos fórmulas paralelas que puedan driftear. **A confirmar/diseñar formalmente en F2 SDD.**
- **DT-3 (guard AC-7 pre-planning — abierto, para Architect)**: el `feeUsdc = budget * feeRate` de `orchestrate.ts:385` se calcula HOY antes de discovery/LLM (cuando aún no existen steps ni costo). Ese cálculo alimenta (a) el guard AC-7 (`feeUsdc > budget` → 400) y (b) `maxBudget = budget - feeUsdc` pasado a compose (`:931`). Como un fee cost-based no puede conocerse antes de planificar, este HU requiere que F2 decida explícitamente: ¿se elimina/difiere el guard hasta tener costo real (fee único, calculado una sola vez, reusado en plan y execute), o se mantiene un guard previo con semántica distinta (p.ej. cota superior conservadora) que luego es superado por el fee real una vez conocidos los steps? **NO se resuelve en F1 — queda como decisión de diseño obligatoria para F2 SDD.**
- **DT-4 (reserva de headroom en compose)**: `maxBudget = budget - feeUsdc` (`orchestrate.ts:931`) gobierna el techo interno que ve `composeService.compose`. Esta HU NO exige eliminar esa reserva; con un fee cost-based (típicamente mucho menor que `budget*rate` en los escenarios reales del bug: 0.061 real vs 0.01–0.05 hoy), la reserva simplemente será más ajustada/correcta. Architect debe verificar el uso interno de `maxBudget` en `composeService.compose` antes de tocar esta línea.
- **DT-5 (rename cosmético, no bloqueante)**: `FeeChargeParams.budgetUsdc` (`fee-charge.ts:34`) es un nombre engañoso — ya no es "budget" en el call site de compose. Renombrar a `feeBaseUsdc` (o similar) en F2 es higiene recomendada para prevenir que este mismo bug reaparezca en un futuro call site, pero NO es obligatorio para cerrar esta HU.

## Constraint Directives (CD-N)

- **CD-1 (WKH-44)**: el mecanismo por el cual `maxBudget` que ve `composeService.compose` se deduce de una reserva para el fee DEBE seguir existiendo en alguna forma; si su fórmula cambia, el nuevo invariante debe quedar documentado explícitamente en el SDD de F2.
- **CD-2 (WKH-44 AC-7)**: el guard de seguridad que aborta la orquestación cuando el fee efectivo es inconsistente respecto a los fondos disponibles DEBE preservarse en alguna forma — aunque su fórmula exacta cambie de `feeUsdc > budget` a un equivalente cost-aware (ver DT-3).
- **CD-3 (WKH-127)**: el débito/credit-back step-0-only (`orchestrate.ts:843-924` débito con `plannedCostUsd` [+ gas overhead]; `:1010-1072` credit-back comparando contra `plannedCostUsd`/`debitedUsd`) es COMPLETAMENTE INDEPENDIENTE del cobro del protocol fee (`chargeProtocolFee`, `:961`) y NO debe tocarse — el fix de esta HU afecta SOLO el cálculo/cobro del fee, nunca el débito de step-0 ni los débitos per-step de compose (steps 1..N, guard `i>0`).
- **CD-4 (BLQ-MED-1 / WKH-131)**: la `execution-id` server-side (`crypto.randomUUID()`) usada como idempotency key de `chargeProtocolFee` en `/execute` (cierra el replay del fee) NO debe alterarse por esta HU.
- **CD-5 (WKH-131 CD-4)**: el path atómico `/orchestrate` (sin gate `maxQuotedCostUsdc`) debe seguir siendo byte-idéntico externamente EXCEPTO por el valor corregido de `protocolFeeUsdc` — el shape de la respuesta y el resto de los campos no cambian.
- **CD-6 (nueva, esta HU)**: el fee cobrado en `/execute` DEBE ser igual al fee cotizado en el `/plan` correspondiente (sin drift por re-derivación) salvo que el cap gate (`maxQuotedCostUsdc` stale check, `orchestrate.ts:827-841`) ya haya rechazado el execute con `409` (`__quoteStale`) — si el quote se honra, el fee cobrado debe ser el número exacto que el caller vio en el quote.
- **CD-7 (espejo compose.ts)**: `augmentX402ChallengeAmount` (`routes/compose.ts:127-178`) y `quoteMaxCostUsdc` (`orchestrate.ts:757-786`) deben seguir calculando exactamente la misma fórmula `pipelineUsd * (1 + rate)` — esta HU no debe introducir drift entre esos dos espejos existentes (consistente con Scope OUT).

## Missing Inputs

- `[NEEDS CLARIFICATION / para F2 SDD]` DT-3: si el guard AC-7 (WKH-44) pasa a evaluarse DESPUÉS de conocer el costo real del pipeline (post-discovery/LLM), el fail-fast ante un `PROTOCOL_FEE_RATE` corrupto deja de ser "gratis" (antes de gastar tiempo en discovery) y pasa a costar una ronda de discovery+planning. Es un escenario ops-only (rate corrupto), de bajo riesgo, pero el tradeoff de latencia/costo-de-falla debe quedar explícito en el SDD — no hay preferencia declarada por el humano.
- `[resuelto en F2]` DT-5: si se renombra `FeeChargeParams.budgetUsdc` — decisión de higiene, no bloqueante.
- `[resuelto en F2]` Mecanismo exacto para garantizar `maxQuotedCostUsdc == totalCostUsdc + protocolFeeUsdc` por construcción (DT-2) — Architect debe formalizarlo en el SDD con pseudocódigo/diff concreto.

## Análisis de paralelismo

- Esta HU toca exclusivamente `src/services/orchestrate.ts` y `src/services/fee-charge.ts` (+ tests asociados). Según `doc/sdd/_INDEX.md`, la última HU (#128, WKH-131) que tocó `orchestrate.ts` ya está DONE y mergeada — no hay work-item en curso conocido sobre estos archivos.
- No bloquea otras HUs (es un bugfix de money-path aislado).
- NO debe correr en paralelo con ninguna otra HU que también toque `planOrchestration`/`executeApprovedPlan` en `orchestrate.ts` (alto riesgo de conflicto de merge en superficie de dinero) — verificar con el orquestador antes de paralelizar.
- Puede correr en paralelo con trabajo en la PWA Yarvis (repo separado) o con HUs que no toquen `orchestrate.ts`/`fee-charge.ts`/`compose.ts`.
