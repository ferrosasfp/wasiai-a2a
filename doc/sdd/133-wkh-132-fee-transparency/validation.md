# Validation Report — HU WKH-132 (fee transparency) (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-03
**Sizing**: FAST+AR (mini SDD, sin story-file/sdd/cr-report/ar-report formales; AR
fix-pack documentado en `auto-blindaje.md`, ver commit `2afd45a`).
**Branch/HEAD**: `feat/133-wkh-132-fee-transparency` @ `ef3b999`.

## Runtime checks
- `npx vitest run` (suite completa): **2261 passed | 10 skipped, 0 failed**
  (126 test files passed, 4 skipped). Incluye `src/routes/orchestrate.test.ts`
  y `src/services/orchestrate.test.ts` (91 tests) que cubren AC-1/AC-2/CD-3.
- `npx tsc --noEmit -p .` → exit 0, sin errores.
- `biome check` sobre los 5 archivos tocados (src/routes/orchestrate.ts,
  src/routes/orchestrate.test.ts, src/services/orchestrate.ts,
  src/services/orchestrate.test.ts, src/types/index.ts) → "No fixes applied".
- CD-3 (test real, no mock del service): `src/services/orchestrate.test.ts:2157`
  (`MNR-1: mixed real+placeholder pipeline...`) ejercita `planOrchestration()`
  real (solo mockea `discoveryService.discover`/`getAgent` y el LLM, no el
  service bajo prueba) con un pipeline mixto (1 step con precio real 0.04, 1
  con precio 0/placeholder) y asserta `protocolFeeUsdc == round(total × rate)`,
  reconciliación con `feeRatePercent`, y el invariante
  `maxQuotedCostUsdc ≥ total + fee`. Este es el test que el AR marcó BLQ-MED-1
  como faltante (el fixture anterior mockeaba `orchestrateService.planOrchestration`
  completo y no detectaba el bug del residual).
- Money-path NO tocado: los 2 hunks del diff en `src/services/orchestrate.ts`
  (`@@ -787,21 +787,19` y `@@ -814,7 +812,7`) caen dentro de `planOrchestration`
  (construcción del quote, líneas ~787-820), NO en `executeApprovedPlan`
  (línea 880) ni en la llamada a `chargeProtocolFee` (línea 1065-1069, sin
  diff). `git diff main...HEAD -- src/services/fee-charge.ts` → sin cambios
  (CD-1: `getProtocolFeeRate()` reusado tal cual, ningún segundo cálculo).

## ACs
| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 | PASS | Impl: `src/routes/orchestrate.ts:231-234` (`feeRatePercent = getProtocolFeeRate()*100` solo en `ready`). Test: `src/routes/orchestrate.test.ts:475` (`T-ROUTE-PLAN-FEE (AC-1)`, `feeRatePercent === 1`) + `src/services/orchestrate.test.ts:2065` (`AC-1: plan ready → protocolFeeUsdc derives from real pipeline cost`). |
| AC-2 | PASS | Impl: `src/routes/orchestrate.ts:246-249` + status branches con `protocolFeeUsdc: 0` en `src/services/orchestrate.ts:438` (insufficient_funds), `:490` (no_agents), `:651` (budget_exhausted), `:735` (no_relevant_agent). Test: `src/routes/orchestrate.test.ts:537-567` (`it.each` sobre los 4 status, asserta `protocolFeeUsdc===0` y `.not.toHaveProperty('feeRatePercent')`). |
| AC-3 | PASS | `README.md:523-557` (sección "Protocol Fee (transparent)": rate 1% default, base cost-based, `PROTOCOL_FEE_RATE` env sin hardcodear valor efectivo, distingue default doc vs runtime `feeRatePercent`). |
| AC-4 | PASS | `doc/INTEGRATION.md:187-222` (sección "Protocol fee (pricing)": tabla `protocolFeeUsdc`/`feeRatePercent`, consistency guarantee, invariante `maxQuotedCostUsdc`, nota de que `/orchestrate` y `/orchestrate/execute` devuelven `protocolFeeUsdc` pero no `feeRatePercent`). |
| AC-5 | PASS | Impl: `feeRatePercent`/`protocolFeeUsdc` siempre derivan de `getProtocolFeeRate()` (`src/routes/orchestrate.ts:233,248`), que ya clampea+fallback en `src/services/fee-charge.ts:100-118` (sin cambios, `git diff` vacío en ese archivo) — nunca se lee `process.env.PROTOCOL_FEE_RATE` crudo en la ruta. No hay test nuevo específico de env inválido en este diff, pero la garantía se hereda de `fee-charge.ts` (cobertura preexistente) + el hecho de que no hay segundo punto de lectura del env (CD-1 cumplido, confirmado por `git diff` vacío en `fee-charge.ts`). |
| BLQ-MED-1 (AR fix-pack) | PASS | `protocolFeeUsdc` reportado en `/plan` ahora es `totalCostUsdc × getProtocolFeeRate()` cost-based (`src/routes/orchestrate.ts:246-249`, `src/services/orchestrate.ts:802,1055-1057`), reconcilia con `feeRatePercent` incluido el caso placeholder/free (rate=0 con precio 0). Test: `src/routes/orchestrate.test.ts:502` (CD-3, ruta ignora residual cocinado) + `src/services/orchestrate.test.ts:2157` (MNR-1, cálculo real mixto) + `:2225` (BLQ-BAJO-1, agente free price=0 → fee 0). |

## Drift
- Scope: archivos tocados = `src/routes/orchestrate.ts`, `src/services/orchestrate.ts`
  (no listado explícito en Scope IN del work-item, pero es el fix-pack AR
  BLQ-MED-1 documentado en `auto-blindaje.md:14-44`, no scope creep de feature),
  `src/types/index.ts`, `README.md`, `doc/INTEGRATION.md`, tests. `fee-charge.ts`
  intacto (reuse-only, CD-1 OK). Commit `ef3b999` removió proactivamente un doc
  de auditoría no relacionado (`doc/security/audit-delta-2026-07-02.md`, hoy
  untracked en el working tree, fuera de los commits del branch) — buena
  higiene de scope.
- Wave: N/A (sizing FAST+AR no usa waves formales W0/W1/W2). Secuencia de
  commits: feat (`2f0739b`) → fix AR (`2afd45a`) → scope cleanup (`ef3b999`),
  orden correcto.
- Spec drift: naming `feeRatePercent` (DT-1) respetado tal cual. `maxQuotedCostUsdc`
  invariante documentado explícitamente cambia de `==` a `≥` (BLQ-MED-1 fix,
  documentado en código y en `doc/INTEGRATION.md:211-215`) — cambio intencional
  y documentado, no drift silencioso.

## Gates
- No hay `cr-report.md` (sizing FAST+AR no requiere Code Review formal). Gates
  confirmados directamente por QA en este reporte: tsc PASS, vitest full suite
  PASS (2261/2271, 10 skip), biome PASS (ver Runtime checks arriba).

## AR follow-up
- Único BLQ (BLQ-MED-1) resuelto en commit `2afd45a`, documentado con test
  real (MNR-1) y evidencia en `auto-blindaje.md:14-44`. Sin BLQ pendientes.

**Listo para DONE.**
