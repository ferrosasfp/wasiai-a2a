# Report — HU [WKH-71] Operator Wallet — Auto-Alert Below Threshold + Funding Runbook

## Resumen ejecutivo

**Status:** APROBADO PARA DONE

Implementación de monitor automático de balance de gas para wallets operadores multi-chain (facilitator settle + gateway operador) que alertan por webhook al caer por debajo de umbrales críticos. El incidente de hoy (2026-07-05: settle wallet del facilitator sin fondos en Fuji, Chaski mostró "$0 · done" ~6h sin alerta) es el escenario exacto que este ticket (mayo 2026) predijo. Codebase listo en rama `feat/149-wkh-71-operator-wallet-alert`, sin pendientes de implementación. Documentación de runbook agregada. Nota: el stack de wallets y cadenas actualizados a testnet/multi-chain real (Fuji 43113, Kite 2368, Base Sepolia 84532). HU companion pendiente en `wasiai-facilitator` para implementar AC-3 (error explícito) del lado del facilitator.

## Pipeline ejecutado

- **F0/F1** (analyst): WKH-71 approved `HU_APPROVED` (2026-07-05). Contexto: codebase grounding + EARS ACs + constraint directives para el monitor multi-wallet/multi-chain.
- **F2/F2.5** (architect): Especificación → `SPEC_APPROVED`. Story File no formalmente generado (pipeline FAST+AR omite reports separados para F2/CR).
- **F3** (dev): Implementación en 3 waves:
  - **Wave 0**: Biome formatting (`operator-funding.test.ts` import ordering).
  - **Wave 1**: Descubrimiento de que `src/lib/gasless-signer.ts` no existe; mapeó AC-3 a puntos reales donde el operador gasta gas (`src/adapters/avalanche/gasless.ts`, `src/adapters/base/gasless.ts`, `src/services/fee-charge.ts`).
  - **Wave 2**: `setup-cronjob.test.mjs` hardcodeaba 4 jobs; extendida a 5 al agregar el nuevo cron.
- **AR** (adversary): **1 BLOQUEANTE detectado** (BLQ-1: `resolveThresholds` validaba umbral como número finito pero devolvía string crudo — strings como `"0.5 "`, `"1e-6"`, `"0.1.2"` pasaban la validación pero lanzaban `InvalidDecimalNumberError` en `parseEther`, escapaba del try/catch per-combo → monitor en blackout, violaba AC-6). Fix-pack aplicado: regex parse-safe + config-resolution movida DENTRO del try/catch per-combo.
- **CR** (parallel a AR): **4 NITs** resueltos en el auto-blindaje (import ordering, test contracts, etc.). Veredicto: **APROBADO**.
- **F4** (QA): Validación de 6/6 ACs con evidencia + dry-run runtime contra wallets reales (Fuji RPC público). Veredicto: **APROBADO PARA DONE** (2026-07-05).

## Acceptance Criteria — resultado final

| AC | Status | Evidencia |
|----|--------|-----------|
| **AC-1**: Alert critical cuando balance nativo < umbral CRÍTICO | PASS | `mcp-servers/wasiai-x402/src/gas-monitor.mjs:204-208` (`evaluateSeverity`, critical precedence) + `tests/gas-monitor.test.mjs:142` "critical balance fires severity=critical alert with public body only" PASS. Dry-run runtime: balance facilitator 1.15 AVAX con thresholds simulados 10/5 → `critical`. |
| **AC-2**: Alert warning cuando balance nativo < umbral WARNING | PASS | `gas-monitor.mjs:204-208` + `tests/gas-monitor.test.mjs:178` "warning-tier balance fires severity=warning" PASS. |
| **AC-3**: Error explícito `operator-funding-low` cuando operador no tiene gas | PASS | Clasificador `src/lib/operator-funding.ts:57-85` (`isOperatorFundingLowError`/`classifyOperatorError`), detección de `viem.InsufficientFundsError`. Wiring: `src/services/fee-charge.ts:449-475,565-575,590-610` + `src/adapters/avalanche/gasless.ts:437-450` + `src/adapters/base/gasless.ts:456-469`. Tests: `src/services/fee-charge.test.ts:426-489` + adapter tests PASS. CD-5 confirmado: `chargeProtocolFee` sigue devolviendo `{status:'failed'}` sin throw/reject. |
| **AC-4**: Runbook de funding documentado | PASS | `doc/operations/gas-funding-runbook.md` — tabla de 2 wallets (facilitator settle + gateway operador, direcciones exactas), tabla de umbrales por chain (Fuji/Kite/Base Sepolia), faucets/fuentes, procedimiento paso a paso (línea 45-61). |
| **AC-5**: Cron read-only de 15 min | PASS | `mcp-servers/wasiai-x402/scripts/setup-cronjob.mjs:116-119` — 5º job `wasiai-x402-gas-balance-check`, schedule `[0,15,30,45]` (15 min). `api/cron/gas-balance-check.mjs:45-48` usa solo `getBalance` (viem read-only). Test `mcp-servers/wasiai-x402/tests/cron-gas-balance-check.test.mjs` PASS (0 write methods called). |
| **AC-6**: Independencia multi-wallet/multi-chain | PASS | `gas-monitor.mjs:227-324` (`checkGasBalances`) — try/catch per-combo con config-resolution DENTRO (BLQ-1 fix). Tests: `tests/gas-monitor.test.mjs:222,258,291,372` — todos PASS (independencia validada, fail-open, no blackout). |

## Hallazgos finales

### BLOQUEANTEs
- **BLQ-1: Validar ≠ Parsear** (resuelto en fix-pack)
  - Error: `_resolveNative` validaba `Number.isFinite(parsed) && parsed >= 0` pero devolvía el STRING crudo.
  - Impacto: Strings como `"0.5 "` (espacio), `"1e-6"` (científica), `"0.1.2"` (doble punto) pasan el guard pero lanzan `InvalidDecimalNumberError` en `parseEther`.
  - Consecuencia: `resolveThresholds` corría FUERA del try/catch del loop → throw escapaba → monitor en blackout, cero alertas (justo el modo de falla que AC-6 existe para matar).
  - Fix: Regex `^\d+(\.\d+)?$` + fallback a default de chain + resolución DENTRO try/catch per-combo.
  - Lección: Confundir "es un número finito" con "es parse-safe para parseEther" es un error de categoría. Validar con el MISMO criterio que el parser, o directamente probar el parse dentro de try.

### MENORs / NITs
- **NIT-1**: `operator-funding.test.ts` import ordering (biome).
- **NIT-2**: `setup-cronjob.test.mjs` hardcodeaba counts de jobs (actualizado a 5).
- **NIT-3**: `operator-funding.test.ts` expect wrapping.
- **NIT-4**: Verificación empírica de parse-safe en tests.

Todos NITs resueltos en el auto-blindaje. **Sin pendientes de implementación.**

## Auto-Blindaje consolidado

| Wave | Categoría | Problema | Causa raíz | Fix | Aplicar en |
|------|-----------|----------|-----------|-----|-----------|
| 1 | Biome | `operator-funding.test.ts` import ordering + wrapping | Escribí imports en orden semántico, no alfabético | `biome check --write` | Futuras HUs: TS nuevo → biome --write antes de gate |
| 1 | Discovery | `src/lib/gasless-signer.ts` no existe (AC-3 lo nombraba) | Nombre conceptual vs path real; gas del operador vive en adapters | Implementé AC-3 en `avalanche/gasless.ts`, `base/gasless.ts`, `fee-charge.ts` | Verificar existencia de archivos en F0 con grep |
| 2 | Contrato | `setup-cronjob.test.mjs` hardcodeaba 4 jobs, roto al agregar 5º | Test es un guardrail por cantidad exacta de jobs | Actualizar `EXPECTED_TITLES` + counts + INT test del nuevo job | Al extender TARGET_JOBS en setup-cronjob.mjs: actualizar test contrato en el mismo commit |
| FIX-PACK | Design | `resolveThresholds` validaba pero no parseaba; throw escapaba del try/catch per-combo | Confundir "número finito" con "parse-safe"; resolver config FUERA del aislamiento per-combo | Regex `^\d+(\.\d+)?$` + fallback + resolver DENTRO try/catch per-combo | Guard ante un parser estricto: validar con el MISMO criterio o probar parse en try |

**Lecciones clave para próximas HUs:**
1. **Validación ≠ Parseo**: Un guard `Number.isFinite()` NO garantiza que `parseEther` no lance. Usar la misma semántica de parseo en el guard, o mover el parse adentro del try/catch.
2. **Aislamiento en loops**: Si un loop promete "aislamiento per-item" (AC-6), la resolución de config para ese item DEBE vivir dentro del try/catch del item, no antes. Caso contrario, errores de config abortan TODO el loop.
3. **Nombres conceptuales vs paths reales**: Work-items que nombran archivos deben ser verificados en F0 con grep; mapear a dónde ocurre de verdad el invariante (aquí: gasto de gas del operador en adapters, no en un "gasless-signer.ts" conceptual).
4. **Contracts de cantidad en tests**: Los tests de contrato (`expected job count`) son guardrails; actualizar al mismo tiempo que el código.

## Archivos modificados (Scope IN verificado)

- **Nuevo monitor de gas**:
  - `mcp-servers/wasiai-x402/src/gas-monitor.mjs` (292 líneas)
  - `api/cron/gas-balance-check.mjs` (168 líneas)
  
- **AC-3: Clasificador de error de operador**:
  - `src/lib/operator-funding.ts` (nuevo, 85 líneas)
  - `src/lib/operator-funding.test.ts` (nuevo, 113 líneas)
  
- **Wiring AC-3**:
  - `src/services/fee-charge.ts` (modificado: describer del error + 2 sitios de wiring)
  - `src/adapters/avalanche/gasless.ts` (modificado: catch de submit, clasificación)
  - `src/adapters/base/gasless.ts` (modificado: catch de submit, clasificación)
  - Tests: `src/services/fee-charge.test.ts`, `src/adapters/__tests__/avalanche.test.ts`, `base.test.ts`
  
- **Cron setup**:
  - `mcp-servers/wasiai-x402/scripts/setup-cronjob.mjs` (modificado: 5º job `wasiai-x402-gas-balance-check`)
  - `mcp-servers/wasiai-x402/tests/setup-cronjob.test.mjs` (actualizado: EXPECTED_TITLES + counts + INT test)
  - `mcp-servers/wasiai-x402/tests/cron-gas-balance-check.test.mjs` (test del nuevo cron)
  
- **Alerts (reuso, no duplicación)**:
  - `mcp-servers/wasiai-x402/src/alerts.mjs` (modificado: whitelist +8 líneas para gas-monitor, CD-1/CD-2 respetado)
  
- **Configuración**:
  - `.env.example` (agregada: `GAS_ALERT_TARGETS`, umbrales por chain)
  
- **Documentación**:
  - `doc/operations/gas-funding-runbook.md` (nuevo, 78 líneas)

**Sin drift**: git status verifica scope IN 1:1. Sin archivos fuera de scope.

## Decisiones diferidas a backlog

1. **HU Companion en `wasiai-facilitator`**: AC-3 (error explícito "operator funding low") se implementó solo en `wasiai-a2a` (operador del gateway, `OPERATOR_PRIVATE_KEY`). El wallet del facilitator (`0x9c0638...`) que se secó hoy vive en `wasiai-facilitator` (repo distinto, fuera de este workspace). Si se quiere el mismo error explícito del lado del facilitator (donde ocurrió el incidente real), requiere una HU companion en ese repo — documentado como `[bloqueante potencial, NO bloquea este work-item]` en el work-item original.

2. **Auto-replenish / auto-funding**: Fuera de scope desde el inicio. Decisión de tesorería explícitamente diferida.

3. **Oracle de precio USD**: Umbrales en gas nativo directo (AVAX/ETH/KITE), sin conversión a USD. Agregar un price-feed sería scope creep para una HU de alerta operacional.

## Variables de entorno a setear al deploy

El monitor lee configuración de wallets + umbrales vía env. **Sin valores = defaults seguros (umbrales altos, cero alertas falso-positivo).**

```bash
# Wallets a monitorear (JSON array, cada entrada: {label, address, chainIds[]})
GAS_ALERT_TARGETS='[
  {"label":"facilitator-settle","address":"0x9c0638506F8C5fc44F0d8C7b9E9e267eA311BB5c","chainIds":[43113,2368,84532]},
  {"label":"gateway-operator","address":"0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba","chainIds":[43113,2368,84532]}
]'

# Umbrales por chain (en unidades nativas: AVAX/ETH/KITE)
# Fuji Avalanche (43113)
WALLET_ALERT_THRESHOLD_43113_WARNING=0.5
WALLET_ALERT_THRESHOLD_43113_CRITICAL=0.1

# Kite testnet (2368)
WALLET_ALERT_THRESHOLD_2368_WARNING=0.5
WALLET_ALERT_THRESHOLD_2368_CRITICAL=0.1

# Base Sepolia (84532)
WALLET_ALERT_THRESHOLD_84532_WARNING=0.5
WALLET_ALERT_THRESHOLD_84532_CRITICAL=0.1

# Webhooks ya configurados (reutilizados desde WKH-90/91)
# SLACK_WEBHOOK_URL, DISCORD_WEBHOOK_URL (opcional, auto-detectado)
```

## Validación final

**Gates:**
- `npx tsc --noEmit` → 0 errores
- `npm run lint` → 0 fixes
- `npx vitest run` → 2653 passed, 0 failed
- `node --test mcp-servers/wasiai-x402/tests/*.test.mjs` → 270 passed, 0 failed

**Drift: 0.** Código en rama, listo para merge.

---

**Listo para DONE. Branch `feat/149-wkh-71-operator-wallet-alert` contiene todas las ACs implementadas y validadas. Requiere deploy con env vars configuradas (GAS_ALERT_TARGETS + umbrales).**
