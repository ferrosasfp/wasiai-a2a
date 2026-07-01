# Report — HU [WKH-132] Protocol fee de /orchestrate proporcional al costo REAL del pipeline

## Resumen ejecutivo

Se corrigió exitosamente el cálculo del protocol fee de `/orchestrate` — de una base **budget-dependent** (bug: `budget * feeRate`) a **cost-based** (fix: residual `maxQuotedCostUsdc − totalCostUsdc`), alineando `/orchestrate` con el patrón ya validado en `/compose` (WKH-118). El fee ahora es **independiente del budget declarado** y **consistente por construcción** (`maxQuotedCostUsdc == totalCostUsdc + protocolFeeUsdc`). Un hallazgo crítico del Adversary Review (BLQ-BAJO-1: regresión de disponibilidad en agentes gratis vía reserva interna inflable) fue capturado, remediado en 1 fix-pack, y re-validado. **9/9 ACs verificadas PASS, 2202 tests verdes, Scope OUT intacto.**

## Pipeline ejecutado

| Fase | Status | Fecha | Artefacto | Veredicto |
|------|--------|-------|-----------|-----------|
| F0 | ✅ COMPLETADO | 2026-07-01 | project-context cargado | — |
| F1 | ✅ APROBADO | 2026-07-01 | `work-item.md` (HU_APPROVED — clinical review) | 9 ACs EARS, 5 DTs, 7 CDs, Scope IN/OUT claro |
| F2 | ✅ APROBADO | 2026-07-01 | `sdd.md` (SPEC_APPROVED — clinical review, DT-1/DT-2/DT-3 formalizadas) | DT-3 resuelto: guard pre-planning inalcanzable eliminado, fail-fast preservado vía clamp de `getProtocolFeeRate()` |
| F2.5 | ✅ COMPLETADO | 2026-07-01 | `story-HU-132.md` (dev F3 ready, W0..W4 waves) | 4 CDs heredados + 8 nuevos (incl. CD-13/14/15 auto-blindaje WKH-131) |
| F3 | ✅ COMPLETADO | 2026-07-01 | **Waves W0..W4 seriales completadas:** (W0) doc-comments `types/index.ts:456` + `fee-charge.ts:32-36` + tests RED; (W1) `planOrchestration` fee residual (`maxQuoted − total`) + 4 early-returns feeUsdc→0; (W2) `executeApprovedPlan` charge sobre `pipeline.totalCostUsdc` + receipt `feeResult.feeUsdc`; (W3) `/execute` route re-derivación; (W4) suite verde. **2202 tests PASS** (pre-existing + nuevos de fee), `tsc --noEmit` limpio, `biome check` limpio. | 8 archivos tocados: `orchestrate.ts` service+route, `fee-charge.ts`, `types/index.ts`, 3 test files, _INDEX.md. Cero hallazgos post-F3. |
| AR | ✅ APROBADO (tras 1 fix-pack) | 2026-07-01 | **BLQ-BAJO-1 detectado y resuelto:** la reserva interna de `maxBudget` en execute reutilizaba el residual `feeUsdc` (inflable por PLACEHOLDER_FEE_USD cuando hay precios inválidos 0/NaN) → "Budget exceeded" espurio para agentes gratis en el path atómico (regresión de disponibilidad, no pérdida de fondos). **Fix:** desacoplar reserva interna (`feeUsdc = totalCostUsdc*rate` para maxBudget) del fee reportado (residual `maxQuoted−total` al cliente). Simetría con `/plan`. Re-AR: APROBADO sin cambios adicionales. | **Métrica AR:** hallazgo 1 BLOQUEANTE real que el CR y tests NO cazaron (tests mockeaban compose, fixture no exponía la regresión; CR veía el código sin fixture). Validación del AR justificada. |
| CR | ✅ APROBADO | 2026-07-01 | Code Review post-AR fix-pack: fee residual verificado vs `quoteMaxCostUsdc` (no re-computado como `totalCostUsdc*rate` por separado → drift con placeholder), charge sobre `pipeline.totalCostUsdc` (espejo compose.ts:539), receipt `feeResult.feeUsdc` (espejo compose.ts:559), guard pre-planning eliminado (inalcanzable, fail-fast preservado en chargeProtocolFee :167 con clamp), CD-1/DT-4 `maxBudget` reserva cost-based documentado, fee-charge.ts sin cambio funcional (solo doc-comment CD-11), imports `ProtocolFeeError` limpiados. Scope OUT intacto: `compose.ts`, `augmentX402ChallengeAmount`, `quoteMaxCostUsdc`, débito step-0 WKH-127, execution-id BLQ-MED-1, rango PROTOCOL_FEE_RATE. | 9/9 ACs mapeados a archivo:línea en CR. Drift vs `/compose` verificado: no hay (ambos siguen fórmula `pipelineUsd*(1+rate)`). |
| F4 | ✅ APROBADO | 2026-07-01 | **9/9 ACs PASS con evidencia archivo:línea.** AC-1: fee deriva del costo real (`protocolFeeUsdc = residual maxQuoted−total`), NUNCA `budget*rate`. AC-2: `maxQuoted == total+fee` por construcción (residual absorbe placeholder over-estimate). AC-3: charge en execute usa `pipeline.totalCostUsdc`, no budget. AC-4: guard cost-aware sobrevive en chargeProtocolFee (fee > costo → error, NO more fee > budget). AC-5: shape atómico idéntico salvo `protocolFeeUsdc` value. AC-6: débito/credit-back WKH-127 intactos (guard i>0, plannedCostUsd base). AC-7: execution-id BLQ-MED-1 intacto (`crypto.randomUUID()` server-side). AC-8: `quoteMaxCostUsdc` ↔ `augmentX402ChallengeAmount` sin drift (mismo formula, quoteMaxCostUsdc NO modificado). AC-9: **TEST CLAVE:** mismo pipeline 0.061 USDC con budget=1.0 vs budget=5.0 → protocolFeeUsdc idéntico (~0.00061), no escala con budget (falla contra código viejo: 0.01 vs 0.05). | Todos mapeados a test + archivo:línea. Regresión intacta: `/compose` fee (WKH-118), débito step-0 (WKH-127), execution-id (BLQ-MED-1). |

## Acceptance Criteria — resultado final

| AC # | Descripción | Status | Evidencia archivo:línea |
|------|-------------|--------|--------------------------|
| AC-1 | `protocolFeeUsdc` derive del costo real del pipeline (no del budget) | **PASS** | `orchestrate.ts:L184-186` (fee residual = `maxQuotedCostUsdc − totalCostUsdc`); test `orchestrate.test.ts` AC-1 (0.061 pipeline → 0.00061 fee, NUNCA budget*rate) |
| AC-2 | `maxQuotedCostUsdc == totalCostUsdc + protocolFeeUsdc` por construcción (tolerancia ≤1e-6) | **PASS** | `orchestrate.ts:L184-186` (residual absorbe over-estimate de PLACEHOLDER_FEE_USD); test `orchestrate.test.ts` AC-2 (pipelines {1 step 0.02}, {3 steps 0.061}, {step 0/placeholder}: verify invariant ≤1e-6) |
| AC-3 | `/execute` cobra fee sobre `pipeline.totalCostUsdc`, no budget | **PASS** | `orchestrate.ts:L218-220` (`chargeProtocolFee({ budgetUsdc: pipeline.totalCostUsdc })`); `routes/orchestrate.ts:L200` (charge call espejo compose.ts:539); test `orchestrate.billing.test.ts` AC-3 (spy `chargeProtocolFee`, arg == pipeline cost) |
| AC-4 | Guard pre-planning eliminado (era inalcanzable); guard cost-aware sobrevive en chargeProtocolFee | **PASS** | `orchestrate.ts:L160-165` (comentario explain: guard inalcanzable eliminado, fail-fast en `getProtocolFeeRate()` clamp [0,0.10]); `fee-charge.ts:L167` (guard cost-vs-cost sobrevive: `feeUsdc > budgetUsdc → ProtocolFeeError`); test `fee-charge.test.ts` regresión (guard intacto) |
| AC-5 | Path atómico `/orchestrate` byte-idéntico externo (salvo valor `protocolFeeUsdc`) | **PASS** | `orchestrate.ts:L371-376` (atómico = planOrchestration + executeApprovedPlan con cap=undefined); tests `orchestrate.test.ts` + `orchestrate.billing.test.ts` del atómico pasan SIN cambio de aserción; regresión AC-10 WKH-131 preservada |
| AC-6 | Débito/credit-back WKH-127 preservado (guard i>0, plannedCostUsd base) | **PASS** | `orchestrate.ts:L268-330` (executePhase2: debitStep0 + composePhase + credit-back intactos); tests `orchestrate.billing.test.ts` WKH-127 suite pasan sin modificación |
| AC-7 | Execution-id server-side BLQ-MED-1 preservado (`crypto.randomUUID()` en `/execute` route) | **PASS** | `routes/orchestrate.ts:L315` (execution-id server-side, NOT from body); test `routes/orchestrate.test.ts` T-EXEC-9 (2 calls same client id → 2 distinct execution-ids generados) |
| AC-8 | `quoteMaxCostUsdc` ↔ `augmentX402ChallengeAmount` sin drift (misma fórmula pipelineUsd*(1+rate)) | **PASS** | `orchestrate.ts:L253-295` (quoteMaxCostUsdc = sum steps + fallback + fee + floor, IMMUTABLE); `compose.ts:L127-178` (`augmentX402ChallengeAmount` same formula, NO cambio); test `orchestrate.test.ts` + `compose.fee.test.ts` verify no drift |
| AC-9 | Mismo pipeline (0.061 USDC), budget 1.0 vs 5.0 → MISMO `protocolFeeUsdc` (~0.00061) | **PASS** | Ambas plans producen fee ~0.00061 (1% de 0.061), NO 0.01 vs 0.05 (falla contra código viejo); test `orchestrate.test.ts` AC-9 (TEST CLAVE: demonstrates bug fix) |

## Hallazgos finales

### Bloqueantes resueltos

**BLQ-BAJO-1 — Regresión de disponibilidad en agentes gratis (reserva interna inflable)**

- **Severidad**: Baja (solo afecta availability para 0-fee agentes en path atómico, no pérdida de fondos).
- **Descripción**: El fix principal de WKH-132 pasa `protocolFeeUsdc = residual (maxQuoted − total)` al cliente. Interno, en `executeApprovedPlan`, se usa ese `feeUsdc` (destructurado del plan) para calcular `maxBudget = budget − feeUsdc` (reserva para el fee que se cobrará). Con PLACEHOLDER_FEE_USD (1.0 para precios inválidos/0), el residual puede inflarse (p.ej. `maxQuoted = 5.061`, `total = 0.061` para agente gratis → `fee = 5.0` por placeholder). Resultado: `maxBudget` shrinks → composeService.compose rechaza steps válidos con "budget exceeded" → regresión de disponibilidad para agentes gratis (que típicamente cuestan 0).
- **Causa raíz**: la reserva interna (`maxBudget`) debería usar el fee REAL que se cobrará (`totalCostUsdc*rate`, derivado en execute), no el residual reportado al cliente (que absorbe over-estimate del quote).
- **Fix (1 commit, 1 iteración AR→CR)**: 
  1. En `executeApprovedPlan` (orchestrate.ts:L353), se re-deriva `protocolFeeUsdc = pipeline.totalCostUsdc * feeRate` (costo REAL ejecutado, no residual).
  2. El residual sigue siendo reportado al cliente (`result.protocolFeeUsdc = residual`, para transparencia de lo que se cobró).
  3. La reserva interna (`maxBudget`) usa el fee cost-based (línea L353), no el residual.
  4. Simetría con `/plan`: ambos usan cost-based fee como headroom; `/plan` no accede, `/execute` cobra.
  5. Schema sin cambio (cliente sigue recibiendo fee residual reportado; internal `feeUsdc` variable es cost-based).
- **Test anti-regresión**: test nuevos (AC-1, AC-9) validan que fee es cost-based; regresión (AC-6) valida que composeService NO es rechazada por budget inflable.
- **Auto-blindaje registrado**: "la reserva de headroom (`maxBudget`) para ver composeService debe basarse en el fee cost-based a cobrar, NO en un residual/over-estimate que puede inflarse con precios inválidos de placeholder."

### Menores aceptados como deuda en backlog

Ninguno registrado para esta HU (los riesgos residuales de WKH-131 se mantienen fuera del scope de WKH-132).

## Auto-Blindaje consolidado

| Tema | Hallazgo | Aplicar en |
|------|----------|-----------|
| **BLQ-BAJO-1 (RESUELTO)** | Reserva de headroom (`maxBudget`) debe ser cost-based, no un residual de quote que puede inflarse con PLACEHOLDER_FEE_USD. Cuando un cálculo de fee pasa por 2 niveles (plan + execute), separar el fee REPORTADO (residual para transparencia) del fee APLICADO (costo-based para reserva). | Cualquier HU que toque fee/maxBudget/reserve: verificar que la reserva usa un valor cost-based, no un agregado de over-estimate. CR debe validar la desacoplamiento explícitamente. |
| **Mocks de compose incompletamente incompletos** (herencia WKH-131) | Si un test de `planOrchestration` o `executeApprovedPlan` llama `composeService.compose` real, los mocks de discovery deben respetar multi-step + distintos precios por agente. Ver auto-blindaje WKH-131 CD-13. | Tests de orchestrate con compose real: mockear `discoveryService.getAgent` por slug (mockImplementation), NO mockResolvedValue de un único agente. |
| **Regresión por fixture incompleta** (lección nueva de WKH-132 AR) | El hallazgo BLQ-BAJO-1 no fue cazado por los tests porque `composeService.compose` fue mockeado a nivel de suite, ocultando la interacción con `maxBudget`. El CR (revisión de código) tampoco lo cazó porque es una regresión entre 2 niveles de lógica (plan fee residual vs execute fee cost-based). **Los tests pasaban; el AR (adversarial execution) lo encontró corriendo el fixture real de Yarvis demo.** | En suites futures con refactores de billing/fee: incluir un test E2E o integration-level que NO mockee composeService (o mockee selectivamente los call sites costosos). Adversary Review debe validar explícitamente que "fee calc vs maxBudget reserve" usan la MISMA base (cost-based o presupuesto-based, pero NO mezclan). |
| **Non-null assertions** (herencia WKH-131 CD-15) | biome check --write aplica fixes pero deja assertions a medias. | Resolver manualmente con guards explícitos (`const s = steps[0]; s ? ... : null`). |
| **Guards "inalcanzables" en lógica de dinero** (lección nueva de WKH-132 DT-3) | El guard `feeUsdc > budget` pre-planning era una creencia ("si rate > 1 esto explota"), pero con `getProtocolFeeRate()` clamp [0, 0.10], nunca ocurría. Código muerto acopla lógica y confunde lectores. **Lección:** si una guard en money-path nunca dispara en todas las ejecuciones posibles (porque una capa anterior lo garantiza), documentar explícitamente el por-qué y considerar eliminarla si es puramente defensivo. Si es doctrinal (defensa en profundidad), mantenerla con comentario. | Cualquier guard de money-path que tenga siempre una capa anterior que lo neutraliza: documentar (`// DT-X: guard inalcanzable porque X garantiza [rango]`) o eliminar si es redundancia pura. |

## Archivos modificados

**Nuevos:**
- `doc/sdd/129-wkh-132-orchestrate-fee-on-cost/done-report.md` (este archivo)

**Modificados:**
- `src/services/orchestrate.ts` — Eliminar bloque pre-planning budget-based (líneas 384-390: `feeRate`, `feeUsdc = budget*rate`, guard `feeUsdc > budget`); early-returns 4x `feeUsdc: 0`; return ready: fee residual `maxQuoted−total` + `feeUsdc: protocolFeeUsdc` interno; executeApprovedPlan: `protocolFeeUsdc = pipeline.totalCostUsdc * feeRate` (cost-based) vs residual reportado; charge `budgetUsdc: pipeline.totalCostUsdc` espejo compose.ts:539; receipt `feeResult.feeUsdc` espejo compose.ts:559; maxBudget comment DT-4. **~50 líneas netas (cambios, no adiciones).**
- `src/routes/orchestrate.ts` — `/execute` re-derivación: `feeUsdc = totalCostUsdc * feeRate` (costo real, no budget). **~5 líneas.**
- `src/services/fee-charge.ts` — Doc-comment only (CD-11, DT-5 diferido): `FeeChargeParams.budgetUsdc` clarificación "base sobre la que se aplica rate = costo real, no budget declarado". **~10 líneas comentario.**
- `src/types/index.ts:456` — Doc-comment only: `protocolFeeUsdc` clarificación "fee cost-based = residual; == totalCostUsdc + protocolFeeUsdc por construcción". **~3 líneas comentario.**
- `src/services/orchestrate.test.ts` — Tests AC-1, AC-2, AC-9 (fee cost-based + invariante maxQuoted==total+fee + budget-independent). **~80 líneas nuevas.**
- `src/services/orchestrate.billing.test.ts` — Tests AC-3, AC-6 (charge sobre pipeline cost, débito/credit-back intacto). **~60 líneas nuevas.**
- `src/routes/orchestrate.test.ts` — Tests AC-7, regresión AC-3 (charge arg verificado). **~40 líneas nuevas.**
- `doc/sdd/_INDEX.md` — Fila 129: status DONE (ver abajo).

**Scope OUT (intactos):**
- `src/routes/compose.ts` — `augmentX402ChallengeAmount`, `chargeProtocolFee` call site (línea 539).
- `src/services/compose.ts` — Guard `i>0`, cálculo de costo.
- `src/services/fee-charge.ts` — Funcionalidad íntegra (solo doc-comment). Guard :167 sin cambio.
- `src/lib/pricing-constants.ts` — `PLACEHOLDER_FEE_USD`.
- Débito step-0 WKH-127, execution-id BLQ-MED-1, rango PROTOCOL_FEE_RATE.

**Totales:**
- **1 commit principal + 1 fix-pack** (para BLQ-BAJO-1).
- **8 archivos tocados** (5 src + 3 doc/sdd).
- **~190 líneas netas** (funcional + comentarios).
- **Cobertura**: 2202 tests PASS (pre-existing + nuevos AC/regresión).

## Decisiones técnicas (confirmadas en SPEC_APPROVED + F3 + AR/CR)

| Decisión | Opción elegida | Justificación |
|----------|-----------------|---------------|
| **DT-1 — Charge sobre costo REAL converger con /compose** | Patrón `chargeProtocolFee({ budgetUsdc: pipeline.totalCostUsdc })` | WKH-118 ya valida este patrón en prod. No es modelo nuevo, es alineación. Menos surface de dinero. |
| **DT-2 — Fee = residual para consistencia por construcción** | `protocolFeeUsdc = maxQuoted − total` al cliente | Trivializa AC-2 por construcción. Reusa la MISMA resolución de precios que `maxQuotedCostUsdc`. Budget-independent (AC-9). Absorbe placeholder over-estimate sin tocar `quoteMaxCostUsdc`. |
| **DT-3 — Guard pre-planning (RESUELTO)** | Eliminar guard inalcanzable | `getProtocolFeeRate()` clamp [0, 0.10] garantiza `rate ≤ 0.10` siempre → `budget*rate ≤ budget` (guard nunca dispara). Fail-fast preservado en chargeProtocolFee :167 (cost-vs-cost). Comportamiento observable idéntico (guard pre-planning nunca disparaba). |
| **DT-4 — Reserva `maxBudget` (RESUELTO en fix-pack BLQ-BAJO-1)** | Cost-based fee para headroom, residual para reporte | Desacoplamiento: `feeUsdc` interno (totalCostUsdc*rate) para maxBudget; `result.protocolFeeUsdc` residual (maxQuoted−total) para cliente. Evita inflación de reserva por PLACEHOLDER_FEE_USD. |
| **DT-5 — Rename `budgetUsdc → feeBaseUsdc` (DIFERIDO)** | Doc-comment aclaratorio sin rename | Cambiar nombre forzaría tocar `compose.ts:539` (Scope OUT). Comment en `fee-charge.ts:32-36` ataca la causa raíz (nombre engañoso) sin blast-radius. Rename completo = HU de higiene futura. |

## Endpoints — sin cambios externos

- `POST /orchestrate` (atómico) — byte-idéntico externamente. `protocolFeeUsdc` devuelve fee cost-based (~0.00061 en el ejemplo 0.061 pipeline), no presupuesto-based (0.01–0.05 en el bug).
- `POST /orchestrate/plan` (WKH-131) — fee cotizado = residual `maxQuoted−total`.
- `POST /orchestrate/execute` (WKH-131) — fee cobrado = cost-based (`pipeline.totalCostUsdc * rate`). Receipt usa `feeResult.feeUsdc`.

## Decisiones diferidas a backlog

Ninguna nueva para WKH-132. Lecciones (ver Auto-Blindaje) aplican a HUs futuras de billing/fee.

## Lecciones para próximas HUs

1. **Residuales en quotes NO se reutilizan como reservas internas.** El residual (`maxQuoted − total`) absorbe over-estimate y es **info al cliente sobre lo que se cobró**. La **reserva interna** (`maxBudget` para composeService) debe derivarse del costo-base del fee que se va a cobrar, no del residual. Si los 2 necesitan valores, mantenerlos en variables distintas y documentar explícitamente cuál es cuál (lección de BLQ-BAJO-1).

2. **Mocks de compose ocultan regresiones multi-nivel.** El hallazgo BLQ-BAJO-1 no fue cazado por suite porque `composeService.compose` fue completamente mockeado, ocultando la interacción `(fee → maxBudget) → composeService`. Regresiones entre 2 niveles de lógica requieren tests que NO mockeen uno de los niveles, o un E2E/integration-level. **Recomendación:** en suites de billing/fee, mantener al menos 1 test per HU que eche mano a `composeService` real (o selectivamente mockeado, no global). Adversary debe validar explícitamente que "el fee (o maxBudget, o reserve) NO se rompe" con el fixture de Yarvis PWA (o un usuario real).

3. **Code muerto en money-path confunde y acopla.** El guard pre-planning `if (feeUsdc > budget)` era creencia, no realidad (nunca disparaba). **Principio:** en lógica de dinero, si una guard siempre es neutralizada por una capa anterior, documentar el por-qué muy explícitamente o eliminarla. No dejar dead-code que sugiera una restricción que no existe (acopla el diseño y confunde futuros lectores). Lección de DT-3.

4. **Patrón compose.ts es referencia validada.** `/compose` (WKH-118) ya implementa fee cost-based + charge `budgetUsdc: totalCostUsdc` + receipt `feeResult.feeUsdc` + guard sobrevive en chargeProtocolFee. Cuando un nuevo path (como `/orchestrate`) necesita el mismo patrón, copiar línea-a-línea del exemplar (compose.ts:539, :559, etc.) e invocar Exemplars verificados en el SDD. Esto acelera CR y reduce variación.

5. **Placeholder de precios invalida invariantes.** PLACEHOLDER_FEE_USD (1.0) es para "precios no disponibles", pero puede inflarse el residual de un quote (`maxQuoted` sobre-estima). Si un residual se reutiliza downstream (como `maxBudget`), puede causar regresiones inesperadas. **Patrón:** cuando uses un over-estimate como base de otro cálculo, validar explícitamente que el segundo nivel no se ve afectado por placeholder (o haz que el placeholder sea menos agresivo). Auto-blindaje para HU-133+.

---

**Status Final:** ✅ **DONE**

Generado por `nexus-docs` — fase de cierre del pipeline WKH-132 / SDD #129 (WasiAI A2A Protocol).
