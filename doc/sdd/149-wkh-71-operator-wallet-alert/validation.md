# Validation Report — HU WKH-71 (COMPACT)

**Veredicto**: APROBADO PARA DONE
**Fecha**: 2026-07-05

## Runtime checks (dry-run READ-ONLY contra wallets reales, Fuji 43113)
Script node ejecutado desde `mcp-servers/wasiai-x402/` importando `evaluateSeverity`/`resolveThresholds` reales + `viem.getBalance` contra `https://api.avax-test.network/ext/bc/C/rpc` (sin mockear nada salvo `sendAlert`, no disparado):

```
facilitator-settle (0x9c0638506F8C5fc44F0d8C7b9E9e267eA311BB5c): balance=1.15 AVAX
  | severity(thresholds default 0.5/0.1)=ok
  | severity(thresholds simuladas 10/5, escenario incidente)=critical
gateway-operator  (0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba): balance=1.1404107832538828 AVAX
  | severity(thresholds default 0.5/0.1)=ok
  | severity(thresholds simuladas 10/5, escenario incidente)=critical
```
- Balances reales leídos correctamente (1.15 / 1.14 AVAX, matching lo esperado hoy).
- Con umbrales normales → `ok` (correcto, ambos wallets están sanos).
- Elevando el umbral por encima del balance actual (simulando el estado en que
  `0x9c0638...` estuvo hoy, 0 AVAX) → `critical` en ambos: el monitor SÍ habría
  alertado en el incidente real de hoy. Prueba end-to-end de la lógica pura contra
  RPC real, no solo mocks.
- No se disparó ningún webhook real (solo se llamó `evaluateSeverity`/`resolveThresholds`, `sendAlert` nunca invocado).

## ACs
| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (critical alert) | PASS | `mcp-servers/wasiai-x402/src/gas-monitor.mjs:204-208` (`evaluateSeverity`, critical precedence) + `tests/gas-monitor.test.mjs:142` "critical balance fires severity=critical alert with public body only" PASS. Confirmado además runtime dry-run arriba (balance real → critical con thresholds simulados). |
| AC-2 (warning alert) | PASS | `gas-monitor.mjs:204-208` + `tests/gas-monitor.test.mjs:178` "warning-tier balance fires severity=warning" PASS. |
| AC-3 (`operator-funding-low`) | PASS | Clasificador `src/lib/operator-funding.ts:57-85` (`isOperatorFundingLowError`/`classifyOperatorError`), incluye patrón para `viem.InsufficientFundsError` shortMessage (`exceeds the balance of the account`, línea 44). Tests: `src/lib/operator-funding.test.ts` (11 casos, incl. `new InsufficientFundsError({})` real de viem línea 32-36) PASS. Wiring: `src/services/fee-charge.ts:449-475,565-575,590-610` (`describeChargeError`) + `src/adapters/avalanche/gasless.ts:437-450` + `src/adapters/base/gasless.ts:456-469`. Tests de wiring: `src/services/fee-charge.test.ts:426-489` ("NIT-2: sign() insufficient-funds → relabeled operator-funding-low, still failed" — asserta `result.status === 'failed'` y NO rechazo de promise) + `src/adapters/__tests__/avalanche.test.ts:542-556` + `base.test.ts:659-673` PASS. CD-5 confirmado: `chargeProtocolFee` sigue devolviendo `{status:'failed'}` sin `throw`/`reject` (diff revisado línea por línea, sin nuevas ramas de control). |
| AC-4 (runbook) | PASS | `doc/operations/gas-funding-runbook.md` — tabla de 2 wallets reales con direcciones exactas (línea 24-25, match byte-a-byte con Scope IN del work-item), tabla de umbrales por chain (línea 36-40), faucets/fuentes de fondeo, procedimiento paso a paso (línea 45-61), y sección de la señal `operator-funding-low` (línea 71-78). |
| AC-5 (cron read-only) | PASS | `mcp-servers/wasiai-x402/scripts/setup-cronjob.mjs:116-119` — 5º job `wasiai-x402-gas-balance-check`, schedule `[0,15,30,45]` (array de enteros, 15 min). `api/cron/gas-balance-check.mjs:45-48` — `readNativeBalance` usa solo `client.getBalance` (viem read-only). Test `mcp-servers/wasiai-x402/tests/cron-gas-balance-check.test.mjs:45-59,154` — mock RPC que **lanza** si se invoca cualquier método distinto de `eth_getBalance` ("WRITE METHOD CALLED — monitor must be read-only"); test PASS confirma cero writes. |
| AC-6 (independencia multi-wallet) | PASS | `gas-monitor.mjs:227-324` (`checkGasBalances`) — try/catch per-combo, config resuelta DENTRO del try (fix BLQ-1). Tests: `tests/gas-monitor.test.mjs:222` "AC-6 — each wallet×chain evaluated independently", `:258` "CD-4 fail-open — a read error on one combo never masks others", `:291` "a throwing sendAlert never aborts remaining combos", `:372` "BLQ-1 — a malformed threshold for one combo never aborts the loop" — todos PASS. |

## Drift
- none — `git status --short` (untracked + modified) matches Scope IN 1:1: `gas-monitor.mjs`, `api/cron/gas-balance-check.mjs`, `operator-funding.ts`, wiring en `fee-charge.ts`/`avalanche/base gasless.ts`, `setup-cronjob.mjs`, `alerts.mjs` (solo whitelist +8 líneas, CD-1/CD-2 respetado, sin cliente duplicado), `.env.example`, runbook, `_INDEX.md`. Sin archivos fuera de scope.
- Auto-blindaje documentado en `doc/sdd/149-wkh-71-operator-wallet-alert/auto-blindaje.md` (BLQ-1 fix-pack: validar≠parsear + config-resolution dentro del try — ya verificado arriba en AC-6).

## Gates
- `npx tsc --noEmit` → 0 errores (ejecutado por QA, ya que no había cr-report.md en disco para este pipeline FAST+AR).
- `npm run lint` (biome check src/) → "Checked 302 files, No fixes applied" → 0.
- `npx vitest run` → **2653 passed, 0 failed**.
- `node --test mcp-servers/wasiai-x402/tests/*.test.mjs` → **270 passed, 0 failed**.

## AR/CR follow-up
- No hay `ar-report.md`/`cr-report.md` en disco (pipeline FAST+AR sin reportes formales separados); el historial de auto-corrección vive en `auto-blindaje.md` (1 BLQ fix-pack, resuelto y re-verificado por QA arriba vía tests + lectura de código).
- CD-5 (chargeProtocolFee no rechaza la promise) confirmado por QA de forma independiente, no solo por el dev.

**Listo para DONE.**
