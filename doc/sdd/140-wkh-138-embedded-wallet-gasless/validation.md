# Validation Report — HU WKH-138 v1 (Gasless Avalanche/Base, EIP-3009 operator-relayed)

**Veredicto**: F4: PASS — APROBADO PARA DONE (con 1 nota de proceso, no bloqueante)
**Fecha**: 2026-07-04 · Branch: `feat/140-wkh-138-gasless-avax-base` @ `56d4d3c` · PR #162

## Runtime checks
- `npx tsc --noEmit` → limpio, exit 0 (re-ejecutado por mí; no había cr-report.md que confirmara).
- `npm test` (suite completa) → **2470 passed / 10 skipped**, 0 failed (re-ejecutado; misma cifra que el PR body).
- Suite acotada a los 4 archivos de esta HU (`gasless.test.ts`, `price.test.ts`, `avalanche.test.ts`, `base.test.ts`) → **171/171 passed** (`npx vitest run --reporter=verbose ...`).
- No hay migración DB en esta HU (adapters + pricing only) → N/A DB state / migration apply.
- Env parity: config nueva 100% vía env (`USDC_USD_RATE`, reuso de `AVALANCHE_USDC_ADDRESS`/`BASE_*_USDC_ADDRESS`/`OPERATOR_PRIVATE_KEY`/`GASLESS_ENABLED`/`GASLESS_DEFAULT_CAP_USD`) — grep confirma cero hardcodes nuevos de key/URL/rate en el diff.

## ACs
| AC | Status | Evidencia |
|----|--------|-----------|
| AC-1 (gasless transfer AVAX/Base, sin gas del caller, `{txHash}`) | PASS | `src/adapters/avalanche/gasless.ts:344-472` (`transfer()`, EIP-3009 auto-relay) + `src/routes/gasless.ts:169-225` (wiring) · test: `src/adapters/__tests__/avalanche.test.ts:497` `T-AC1`, `src/routes/gasless.test.ts:490` `T-AC1-ROUTE` (avalanche-fuji → 200 `{txHash:'0xavax01'}`) |
| AC-2 (cap per-call → 403 ANTES del debit) | PASS | `src/routes/gasless.ts:126-139` (`gaslessCostEstimatorPreHandler`, cap check antes de `requirePaymentOrA2AKey`) · test: `src/routes/gasless.test.ts:512` `T-AC2-ROUTE` (asserta `mockLookupByHash`/`mockDebit`/`mockGaslessTransfer` NO llamados) |
| AC-3 (`funding_state != ready` → 503) | PASS | `src/routes/gasless.ts:183-191` · test: `src/routes/gasless.test.ts:529` `T-AC3-ROUTE` (base-sepolia unfunded → 503 `gasless_not_operational`, transfer no invocado) |
| AC-4 (`GET /status` real, no hardcode) | PASS | `src/adapters/avalanche/gasless.ts:474-526`, `src/adapters/base/gasless.ts:493-545` (`status()` real: enabled/operatorAddress/funding_state/supportedToken) · test: `avalanche.test.ts:613` `T-AC4`, `gasless.test.ts:622` `T-AC4-ROUTE` |
| AC-5 (pricing chain-aware fail-closed) | PASS | `src/lib/price.ts:179-219` (`usdcWeiToUsd`/`estimateGaslessValueUsd`: decimals inválido/chain no manejada → `+Infinity`) · test: `price.test.ts:282-302` (`T-DEC-INVALID`), `:372` (`T-DRAIN-CAP` chain desconocida → Infinity) |
| AC-6 (sin custodia/EIP-7702) | PASS | `git diff main...HEAD -- src/` grepeado por `7702\|custody\|passkey\|privy\|turnkey\|dynamic\|mpc\|seed.?phrase` → 0 matches. `GaslessTransferAdapterRequest` (`src/adapters/types.ts:53-56`) solo tiene `{to, value}` — sin `from` ni firma externa expuesta (interfaz sin cambios, DT-1) |

## Invariantes drain/security
| Invariante | Status | Evidencia |
|---|---|---|
| Conversión USDC-6dec (NO `pyusdWeiToUsd`) | PASS | `estimateGaslessValueUsd` (`price.ts:203-219`) dispatchea `avalanche-*`/`base-*` → `usdcWeiToUsd(...,USDC_GASLESS_DECIMALS)`; kite conserva `pyusdWeiToUsd` byte-idéntico. `price.test.ts:268` (`T-USDC-6DEC`: 6-dec vs 18-dec difieren) |
| Paridad pricing↔transfer↔payment (decimals+address) | PASS | `USDC_GASLESS_DECIMALS=6` importado en ambos adapters gasless (`avalanche/gasless.ts:59`, `base/gasless.ts:62`); addresses default byte-idénticas a `payment.ts` (verificado con grep: `0x5425890298aed601595a70AB815c96711a31Bc65` / `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` / `0x036CbD53842c5426634e7929541eC2318f3dCF7e` / `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` idénticas en `payment.ts` y `gasless.ts` de ambas chains). Test cruzado real contra la instancia del payment adapter: `avalanche.test.ts:625,639` y `base.test.ts:742,756` (`T-DEC`) |
| Cap adapter-level ANTES de firmar (T-DRAIN-CAP) | PASS | `avalanche/gasless.ts:347-370`, `base/gasless.ts:366-389` (`transfer()` valida `estimatedUsd`/mínimo ANTES de `signTypedData`/`writeContract`) · test: `avalanche.test.ts:517,527`, `base.test.ts:634,644` (asserta `mockWriteContract`/`mockSignTypedData` NO llamados) |
| `from` == operator (nunca del caller) | PASS | `transfer()` firma con `account = walletClient.account` (derivado de `OPERATOR_PRIVATE_KEY`), nunca de `req` · test asserta `args[0] === MOCK_OPERATOR` (`avalanche.test.ts:508`, `base.test.ts:608`) |
| Chain resuelta una vez (anti-TOCTOU) | PASS | `resolveGaslessChainKey` se llama 1 vez en `gaslessCostEstimatorPreHandler` (`gasless.ts:102-104`), persiste en `request.gaslessChainKey`; el handler reusa esa misma variable (`gasless.ts:182-183`), nunca re-resuelve ni cae al default | 
| Timeout ≠ revert | PASS | `avalanche/gasless.ts:445-469` / `base/gasless.ts:464-488`: `WaitForTransactionReceiptTimeoutError` capturado explícito, separado de `receipt.status !== 'success'` · test: `T-SIGN-INVALID` x3 en ambos adapters |
| Kite byte-idéntico (diff vacío) | PASS | `git diff --name-only main...HEAD -- src/adapters/kite-ozone/ src/adapters/avalanche/payment.ts src/adapters/base/payment.ts` → vacío (cero cambios) · test: `gasless.test.ts:580` `T-REGR-ROUTE`, `price.test.ts:379` `T-REGR-PRICE` |
| Fail-closed (chain no manejada → +Infinity → 403) | PASS | `estimateGaslessValueUsd` default case → `Number.POSITIVE_INFINITY` (`price.ts:216-217`) · test: `price.test.ts:372` `T-DRAIN-CAP` |
| Bypass del cap vía llamada directa al adapter (R-2) | PASS | `grep -rn "GaslessAdapter(.*)\.transfer" src/` → único call-site es `src/routes/gasless.ts:195` (dentro del preHandler chain con `requirePaymentOrA2AKey`) |

## Drift
- Archivos modificados = exactamente Scope IN del Story File (`price.ts`, `avalanche/base gasless.ts`, `routes/gasless.ts`, `a2a-key.ts` augmentation, `errors.ts`, tests, auto-blindaje.md). Sin drift de scope.
- `kite-ozone/gasless.ts` y `*/payment.ts` (money-path existente) — cero cambios, confirmado por diff vacío.
- No hay wave violations relevantes (1 solo commit; W0/W1/W2 conviven en el mismo commit pero el orden interno de dependencias del SDD se respeta: price.ts sin adapters, adapters sin route, route consume ambos).
- MNR de auto-blindaje (public client Base cast a `Chain` por tipo OP-stack) documentado en `auto-blindaje.md:8-23`, no es un footgun de seguridad — es un fix de tipos.

## Gates
- `tsc --noEmit`: PASS (re-ejecutado por mí, no había `cr-report.md` para confirmar — ver nota de proceso abajo).
- `npm test`: PASS 2470/2470 (10 skipped, no relacionados a esta HU) — re-ejecutado por mí, coincide con la cifra reportada en el PR body por el Dev.
- `biome check`: no re-ejecutado (el PR body del Dev reporta "limpio, 279 files"); no hay CR independiente que lo confirme — ver nota de proceso.

## Nota de proceso (no bloqueante para F4, sí para higiene del pipeline)
No existen `ar-report.md` ni `cr-report.md` en `doc/sdd/140-wkh-138-embedded-wallet-gasless/`, y el PR #162 no tiene reviews registradas (`gh pr view 162 --json reviews` → `[]`). La única "verificación" documentada es un self-report del Dev en el cuerpo del PR. Esto es una desviación del flujo QUALITY (AR → CR → F4) descrito en `CLAUDE.md`. Dado que:
(a) re-hice yo mismo los gates (tsc + test suite completa) con resultado verde,
(b) verifiqué manualmente cada invariante crítico de drain/security con evidencia archivo:línea + test,
no bloqueo F4 — pero recomiendo al orquestador confirmar con el humano si AR/CR se corrieron fuera de banda (sin artefacto) antes de cerrar a DONE, o lanzarlos retroactivamente para dejar el rastro documental completo.

**Listo para DONE** (con la nota de proceso arriba, a discreción del orquestador/humano).
