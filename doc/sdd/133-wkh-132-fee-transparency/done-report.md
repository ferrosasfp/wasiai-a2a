# Report — HU [WKH-132] [fee transparency] Transparencia de fee: publicar el fee del gateway

## Resumen ejecutivo

Se implementó la transparencia del protocol fee de `/orchestrate/plan` agregando un nuevo campo `feeRatePercent` a la respuesta del quote, derivado de la única fuente de verdad `getProtocolFeeRate()` en `src/services/fee-charge.ts`. El fee reportado ahora es cost-based (proporcional al costo real del pipeline ejecutado, no al budget declarado — hereda el fix de WKH-132-antiguo/orchestrate-fee-on-cost, DONE). Se documentó la transparencia en README.md (sección "Protocol Fee (transparent)") y en doc/INTEGRATION.md (sección "Protocol fee (pricing)"), publicando tasa por defecto (1%), base de cálculo y mecanismo de override vía env `PROTOCOL_FEE_RATE`. Pipeline FAST+AR con fix-pack AR (BLQ-MED-1 resuelto), tests completos (2261 passed), sin bloqueantes pendientes. PR #156 listo para mergear (branch `feat/133-wkh-132-fee-transparency`, HEAD `ef3b999`).

## Pipeline ejecutado

- **F0**: project-context cargado (`.nexus/project-context.md`)
- **F1**: work-item.md (WKH-132 "fee transparency" — nota: reutiliza ID de HU histórica DONE, numeración interna NNN=133). ACs EARS, Sizing **FAST+AR** (mini SDD, no story-file/sdd/cr-report formales, AR fix-pack in-band). Gate: HU_APPROVED (no gate formal, sizing permite inicio directo).
- **F2**: SDD embebido en work-item.md (mini scope, no archivo `sdd.md` separado). Constraint Directives CD-1 a CD-4 documentadas (single source of truth en `getProtocolFeeRate()`, sin segundo cálculo, compatibilidad backwards del body, consistencia `protocolFeeUsdc ≈ totalCostUsdc × rate`).
- **F2.5**: N/A (sizing FAST+AR no genera story-file formal).
- **F3**: Implementación wave-0 (commit `2f0739b`). Archivos tocados: `src/routes/orchestrate.ts` (agregar `feeRatePercent` al handler `/plan`, ~línea 231-234), `src/services/orchestrate.ts` (construction del quote, cálculo cost-based del fee), `src/types/index.ts` (tipado del campo), `README.md` (sección fee con env config explícita), `doc/INTEGRATION.md` (documentación pública del contrato).
- **AR**: Adversarial Review (commit `2afd45a`, fix-pack). **Bloqueante BLQ-MED-1** cazado: `protocolFeeUsdc` reportado en `/plan` era el residual del techo (`maxQuotedCostUsdc − totalCostUsdc`), no el fee cost-based; en steps con price 0/placeholder el residual se inflaba (~$1.01) y NO reconciliaba con `feeRatePercent` derivado (`feeRatePercent ≈ 1%` pero monto disparatado). Test CD-3 anterior mockeaba el service y no ejercitaba el cálculo real → no lo detectaba. **Resolución (opción A)**: `protocolFeeUsdc` pasa a ser fee REAL cost-based = `round(totalCostUsdc × getProtocolFeeRate())`, reconcilia con `feeRatePercent` por construcción. Invariante documentado: `maxQuotedCostUsdc ≥ totalCostUsdc + protocolFeeUsdc` (≥ no ==, permite headroom por placeholder). Money-path (`executeApprovedPlan`, `chargeProtocolFee`) intacto. Verificación: residual NO se cobra → `executeApprovedPlan` línea ~1065-1069 usa `chargeProtocolFee(pipeline.totalCostUsdc × rate)` (cost-based real), no el monto del quote.
- **CR**: No hay code review formal (sizing FAST+AR no requiere CR separado). Calidad verificada: `tsc --noEmit -p .` exit 0; `biome check` sin errores (post-format fix-pack); `npx vitest run` 2261 passed | 10 skipped, 0 failed (126 test files).
- **F4 (Validación QA)**: Veredicto **APROBADO PARA DONE**. Tests reales (MNR-1 en `services/orchestrate.test.ts:2157`) ejercitan pipeline mixto (1 step 0.04 real + 1 step placeholder price 0) y verifican reconciliación `protocolFeeUsdc == round(total × rate)`, invariante `maxQuotedCostUsdc ≥ total + fee`. Todos los ACs PASS (ver tabla abajo).

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | PASS | `feeRatePercent` en respuesta de `POST /orchestrate/plan` cuando `planStatus: 'ready'`. Impl: `src/routes/orchestrate.ts:231-234` (`feeRatePercent = getProtocolFeeRate()*100`). Test: `src/routes/orchestrate.test.ts:475` (T-ROUTE-PLAN-FEE, asserta `feeRatePercent === 1`) + `src/services/orchestrate.test.ts:2065` (AC-1 real pipeline cost). |
| AC-2 | PASS | `protocolFeeUsdc: 0` y NO incluir `feeRatePercent` cuando `planStatus ≠ 'ready'` (insufficient_funds, no_agents, budget_exhausted, no_relevant_agent). Impl: `src/routes/orchestrate.ts:246-249` + service early-returns en líneas 438, 490, 651, 735. Test: `src/routes/orchestrate.test.ts:537-567` (it.each sobre los 4 status, asserta `protocolFeeUsdc===0` y `.not.toHaveProperty('feeRatePercent')`). |
| AC-3 | PASS | README.md sección "Protocol Fee (transparent)" (líneas 523-557): tasa default 1%, base cost-based (referencia a WKH-132-antiguo fee-on-cost), `PROTOCOL_FEE_RATE` env sin hardcodear valor efectivo, distingue default documentado vs runtime `feeRatePercent`. |
| AC-4 | PASS | doc/INTEGRATION.md sección "Protocol fee (pricing)" (líneas 187-222): tabla campos `protocolFeeUsdc`/`feeRatePercent`, consistency guarantee, invariante `maxQuotedCostUsdc ≥ totalCostUsdc + protocolFeeUsdc`, nota de que `/orchestrate` y `/orchestrate/execute` devuelven `protocolFeeUsdc` (monto) pero no `feeRatePercent` (decisión del Architect: solo en `/plan`). |
| AC-5 (Unwanted) | PASS | `feeRatePercent`/`protocolFeeUsdc` siempre derivan de `getProtocolFeeRate()` clampeada, nunca del env crudo. Impl: `src/routes/orchestrate.ts:233,248` delegan a `getProtocolFeeRate()` que ya clampea+fallback en `src/services/fee-charge.ts:100-118` (sin cambios, `git diff main...HEAD -- src/services/fee-charge.ts` vacío, **CD-1 cumplido**). No hay segundo punto de lectura del env. |
| CD-3 (Constraint) | PASS | Consistencia matemática: `protocolFeeUsdc ≈ totalCostUsdc × (feeRatePercent / 100)` dentro de tolerancia de redondeo. Test real MNR-1 (`src/services/orchestrate.test.ts:2157`) con pipeline mixto ejercita el cálculo verdadero, reconcilia ambos campos. **BLQ-MED-1 resuelto**: cost-based fee reportado. |

## Hallazgos finales

### BLOQUEANTEs
- **BLQ-MED-1** (AR, commit `2afd45a`): `protocolFeeUsdc` reportado era el residual del techo, no el fee cost-based → no reconciliaba con `feeRatePercent`. **RESUELTO**: opción A aceptada (cost-based fee en quote), test real MNR-1 agregado, invariante documentado (`maxQuotedCostUsdc ≥ total + fee`).

### MENORs
Ninguno pendiente. Biome format fix (auto-blindaje entry 1, 2026-07-03 13:38) fue preventivo, no un fallo detectado en validación.

## Auto-Blindaje consolidado

### [2026-07-03 13:38] F3 — Biome format en `it.each(...)` multilínea
- **Error**: bloque de test parametrizado (`it.each([...] as const)(...)` para AC-2) quedó con salto de línea entre `)` del array y argumentos; `biome check` marcó 2 errores.
- **Causa raíz**: escribí el `it.each` sin correr el formatter antes de dar por cerrado.
- **Fix**: `biome check --write` sobre archivos tocados; re-corrida de tests confirma sem­ántica intacta.
- **Lección**: correr `./node_modules/.bin/biome check` sobre archivos tocados antes del commit — `npm test`/`tsc` no cubre formato.

### [2026-07-03] FIX-PACK AR — protocolFeeUsdc reportaba RESIDUAL del techo (BLQ-MED-1)
- **Error**: en `POST /orchestrate/plan` el `protocolFeeUsdc` reportado era residual (`maxQuotedCostUsdc − totalCostUsdc`). Steps con price 0/placeholder sumaban `PLACEHOLDER_FEE_USD` (~$1) → residual inflado (~1.01) y NO reconciliaba con `feeRatePercent` (invariante `protocolFeeUsdc ≈ total × rate` fallaba).
- **Causa raíz**: se reusó el residual como si fuera el fee, confundiendo techo de seguridad (con headroom placeholder) vs fee real cost-based. Invariante asumido falso: `maxQuoted == total + fee` cuando hay steps sin precio.
- **Fix (opción A)**: `protocolFeeUsdc` reportado = fee REAL cost-based = `round(totalCostUsdc × getProtocolFeeRate())`, reconcilia con `feeRatePercent` por construcción. Invariante nuevo documentado: `maxQuotedCostUsdc ≥ totalCostUsdc + protocolFeeUsdc`. Money-path (`executeApprovedPlan`, `chargeProtocolFee`) intacto; residual NO se cobra (verificado: ejecuta con costo real).
- **Test real (MNR-1)**: agregado en `services/orchestrate.test.ts:2157` (pipeline mixto real+placeholder, sin mock del service). CD-3 reescrito para verificar que ruta ignora `protocolFeeUsdc` inconsistente (residual) del service mock y lo deriva cost-based.
- **Lección**: cualquier valor "reportado" derivado de un cap/techo — no confundir techo de seguridad (puede incluir headroom) con la magnitud económica real. Si un test mockea el service que produce el valor bajo prueba, no ejercita el cálculo real: mockear dependencias (discovery/LLM) y correr el service de verdad.

## Archivos modificados

**Modificados** (en orden de dependencia lógica):
- `src/types/index.ts` — tipado (union type para `feeRatePercent: number | undefined`)
- `src/services/fee-charge.ts` — **sin cambios** (reuse-only, `getProtocolFeeRate()` ya existe, **CD-1 OK**)
- `src/services/orchestrate.ts` — cálculo del quote cost-based, líneas ~787-820 (planOrchestration, fix-pack BLQ-MED-1); money-path intacto
- `src/routes/orchestrate.ts` — agregar `feeRatePercent` a respuesta `/plan`, líneas ~231-234, 246-249
- `src/routes/orchestrate.test.ts` — test AC-1/AC-2 (T-ROUTE-PLAN-FEE, AC-2 it.each), CD-3 reescrito con mock coherente
- `src/services/orchestrate.test.ts` — test AC-1 real + test MNR-1 (BLQ-MED-1, pipeline mixto real+placeholder)
- `README.md` — sección "Protocol Fee (transparent)" (523-557)
- `doc/INTEGRATION.md` — sección "Protocol fee (pricing)" (187-222)

**NO tocados** (intactos, fuera de scope):
- `src/services/fee-charge.ts` (reuse-only)
- `POST /orchestrate` endpoint (no agregó `feeRatePercent`, decisión de Architect; solo `/plan` la publica por ahora)
- `POST /orchestrate/execute` endpoint (devuelve `protocolFeeUsdc` ya existente; no cambio)
- `/compose` (tiene su propio fee desde WKH-118)
- Money-path de cobro (`executeApprovedPlan`, `chargeProtocolFee`)

Scope cleanup (commit `ef3b999`): removió proactivamente `doc/security/audit-delta-2026-07-02.md` (doc de auditoría no relacionada, untracked).

## Decisiones diferidas a backlog

Ninguna. El scope de "transparencia de fee en `/plan`" se cierra. Spinoffs futuros posibles (no en esta HU):
- Agregar `feeRatePercent` también a `/orchestrate` (endpoint atómico) y `/orchestrate/execute` por consistencia — marcado TBD en work-item.md pero decidido NO en F2 (solo en quote `/plan` por ahora).
- Implementar RLS Postgres-level sobre configuración de fee (`PROTOCOL_FEE_RATE` per-operator) — fuera de scope, requeriría validación nueva.

## Lecciones para próximas HUs

1. **Cálculos reportados vs caps de seguridad**: no confundir el techo de presupuesto/seguridad (que puede incluir headroom para placeholder o riesgo) con la magnitud económica real que se cobra o se reporta públicamente. Si un techo suma `PLACEHOLDER_FEE_USD` por steps sin precio, el residual derivado del techo es una estimación del riesgo, no el fee real ejecutado. Documentar el invariante matemático explícitamente (hoy: `maxQuotedCostUsdc ≥ totalCostUsdc + protocolFeeUsdc`, la diferencia es headroom, no fee).

2. **Mocks en tests de values económicos**: si escribís un test de "consistencia del fee" que mockea el service que calcula el fee bajo prueba, NO estás ejercitando el cálculo real. Mockea las dependencias externas (discovery, LLM, network calls) y corre el service de verdad, o el test no detectará bugs en la fórmula misma (como el BLQ-MED-1, que el CD-3 anterior no cazó porque mockeaba `planOrchestration()` completo).

3. **Formatter como parte del gate de tests**: `npm test` + `tsc --noEmit` no cogen formato Biome. Agregar `biome check` como step pre-commit o en CI, especialmente en test files donde los saltos de línea y la indentación generan errores si se pasa una sola línea (iter alli `it.each(...)` y custom test data).

4. **Documentación de valores en tiempo de ejecución**: cuando documentas un valor configurable (ej. `PROTOCOL_FEE_RATE`), remite siempre a la respuesta en vivo (ej. `feeRatePercent` en el quote) como fuente de verdad, no al env var — evita que la doc quede stale si un operador cambia el config. El env var define el *default*, no el *valor efectivo* visto por el cliente.

---

**Status final**: DONE. PR #156 (`feat/133-wkh-132-fee-transparency`, HEAD `ef3b999`) lista para mergear. Sin bloqueantes pendientes. Pipeline FAST+AR ejecutado, validation.md APROBADO.
