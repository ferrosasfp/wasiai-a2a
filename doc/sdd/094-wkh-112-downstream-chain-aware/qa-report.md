# QA Report — WKH-112 [BASE-07] outbound downstream payment chain-aware

> QA: nexus-qa | F4 | Fecha: 2026-05-27
> Branch: feat/094-wkh-112-downstream-chain-aware (commits bf58251 + fix-pack ccdcd74)
> Input: work-item.md, sdd.md, story-file.md, ar-report.md, cr-report.md
> AR: APROBADO post-fix-pack (0 BLQ tras ccdcd74) | CR: APROBADO (0 BLQ, 1 MNR no bloqueante)

---

## Gates

| Gate | Comando | Resultado |
|------|---------|-----------|
| Typecheck autoritativo | `npx tsc -p tsconfig.build.json --noEmit` | **exit 0 — limpio** |
| Suite completa | `npm test` (vitest run) | **1047 passed / 1047 (71 files) — exit 0** |
| downstream-payment.test.ts | 27 tests (17 skip-codes + 10 chain-aware) | **27/27 PASS** |

Delta vs CR baseline: 1046 → 1047 (+1). El fix-pack ccdcd74 agregó T-AuthWindow (MNR-1 del AR).
Delta vs main: 1048 → 1047 (−1). Explicado íntegramente por el retiro de `.mainnet.test.ts` (7 casos Scope OUT) + consolidación de 2 tests obsoletos + suma neta +6 nuevos. Sin pérdida de cobertura funcional.

---

## EIP-3009 Window 300s (BLQ-MED-1 — fix-pack confirmado)

**Constante**: `downstream-payment.ts:37` — `const DOWNSTREAM_AUTH_WINDOW_SECONDS = 300`
**Uso**: `downstream-payment.ts:283` — `timeoutSeconds: DOWNSTREAM_AUTH_WINDOW_SECONDS`
**Test**: `downstream-payment.test.ts:576-585` — T-AuthWindow: `expect(mockFujiSign.mock.calls[0][0]).toMatchObject({ timeoutSeconds: 300 })` PASS

El fix restauró exactamente la ventana legacy `VALID_BEFORE_SECONDS=300` que el AR BLQ-MED-1 identificó como regresada a 60s. Confirmado verd en npm test 1047.

---

## AC Verification

| AC | Texto (EARS) | Status | Evidencia archivo:línea |
|----|-------------|--------|------------------------|
| AC-1 | WHEN pago a agente `chain:base-sepolia` THEN firmar EIP-3009 vía adapter Base + settlear vía facilitator Base (`eip155:84532`), retornar `DownstreamResult` con `txHash` + `settledAmount` 6-dec | **PASS** unit + **PENDING-RUNTIME** tx-hash live | Test T-AC1 `downstream-payment.test.ts:426` PASS — `result = {txHash:'0xBASE', settledAmount:'500000'}`, `mockGetPaymentAdapter` invocado con `'base-sepolia'`, `mockBaseSign` recibió `{to:PAYTO_ADDR, value:'500000'}`. Prod (live tx): ver nota post-merge abajo. |
| AC-2 | WHEN agente `chain:avalanche`/`avalanche-fuji` THEN comportamiento funcionalmente idéntico (facilitator, USDC Fuji, `eip155:43113`, skip-codes, NEVER-throws). 1048 tests verdes (±delta declarado). Única desviación aceptada: `blockNumber`. | **PASS** | Tests T-AC2a `downstream-payment.test.ts:443` + T-AC2b `:453` PASS. T-AuthWindow `:576` afirma `timeoutSeconds:300` (ventana legacy preservada). npm test 1047/1047 verde — cero regresión Avalanche. `chainKey` resuelto una sola vez en `:151`, bundle en `:152`, adapter en `:196`. |
| AC-3 | WHEN agente `chain:kite-ozone-testnet` THEN firmar+settlear vía adapter Kite (`eip155:2368`, PYUSD, 18-dec), retornar `DownstreamResult` — sin enviar a Avalanche | **PASS** unit + **PENDING-RUNTIME** tx-hash live | Test T-AC3 `downstream-payment.test.ts:470` PASS — `result = {txHash:'0xKITE', settledAmount:'500000000000000000'}`, `mockGetPaymentAdapter('kite-ozone-testnet')`, `mockKiteSign` recibió `{value:'500000000000000000'}` (NOT `'500000'`) — guard dimensional 18-dec afirmado `:489-490`. Prod (live tx): ver nota post-merge abajo. |
| AC-4 | IF chain no reconocida o no inicializada THEN skip `CHAIN_NOT_SUPPORTED` + log con `getInitializedChainKeys()`, PROHIBIDO fallback Avalanche | **PASS** | Tests T-AC4a `downstream-payment.test.ts:493` (slug `'solana'` → `normalizeChainSlug→undefined`) + T-AC4b `:509` (slug reconocido, `bundle→undefined`) PASS. Ambos afirman `code:'CHAIN_NOT_SUPPORTED'`, `mockGetPaymentAdapter` NO llamado, `mockFujiSign` NO llamado. T-AC4b afirma `initialized: ['avalanche-fuji','base-sepolia','kite-ozone-testnet']`. Prod: `downstream-payment.ts:151-163` — `normalizeChainSlug` + `getAdaptersBundle` guard + `getInitializedChainKeys()` en el log. |
| AC-5 | WHILE pago a agente chain `K` THEN usar el MISMO `ChainKey K` para adapter, firma y facilitator/network. PROHIBIDO mezclar chains. | **PASS** | Test T-AC5 `downstream-payment.test.ts:533` PASS — `mockGetPaymentAdapter.mock.calls.every(c => c[0] === 'base-sepolia')`, `mockBaseVerify` + `mockBaseSettle` llamados con `{network:'eip155:84532'}` (red de `signed.paymentRequest`). Prod: `downstream-payment.ts:151` resolve once → `:196` adapter → `:297` `network = signed.paymentRequest.network ?? adapter.getNetwork()` → `:298-302` proof único reutilizado en verify (`:307`) y settle (`:330`). |
| AC-6 | address/network/chainId/decimales/EIP-712 derivan del ADAPTER. PROHIBIDO literales `DEFAULT_FUJI_USDC`/`DEFAULT_AVALANCHE_USDC`/`FUJI_NETWORK`/`AVALANCHE_NETWORK`. | **PASS** | Test T-AC6 `downstream-payment.test.ts:556` PASS — `signArg.to === PAYTO_ADDR`, `signArg.value === '500000'`, `mockBaseSettle` invocado con `network:'eip155:84532'`. Grep `DEFAULT_FUJI_USDC\|FUJI_NETWORK\|DEFAULT_AVALANCHE\|WASIAI_DOWNSTREAM_NETWORK\|TRANSFER_WITH_AUTHORIZATION\|signTypedData\|avalancheFuji` → **0 matches** en `downstream-payment.ts`. Prod: `downstream-payment.ts:200` `adapter.supportedTokens[0].decimals`, `:203` `parseUnits(String(agent.priceUsdc), decimals)`, `:196` `getPaymentAdapter(chainKey)`. |

---

## TD aceptado — TD-WKH-112-01 (blockNumber omitido)

`DownstreamResult.blockNumber` es opcional (`types/index.ts:232`, campo `?: number`).
`downstream-payment.ts:352-355` devuelve `{txHash, settledAmount}` sin blockNumber — `SettleResult` del adapter no lo expone.
`compose.ts:195-199` usa spread condicional `...(downstream && {...})` — si `downstream.blockNumber === undefined`, el campo no aparece en el JSON de `StepResult`. Backward-compatible.
Esta es la ÚNICA desviación declarada del path Avalanche (DT-1 opción C, AR adjudicación ACEPTABLE, Story File `:41`). No es FAIL.

---

## Drift

| Check | Resultado |
|-------|-----------|
| Scope drift | `git diff --name-only main..feat/094-wkh-112-downstream-chain-aware` = **4 archivos**: `doc/sdd/094-wkh-112-downstream-chain-aware/auto-blindaje.md` (artifact de fix-pack, docs), `src/lib/downstream-payment.mainnet.test.ts` (BORRADO — Scope IN), `src/lib/downstream-payment.test.ts` (modificado — Scope IN), `src/lib/downstream-payment.ts` (modificado — Scope IN). **Cero drift fuera de scope**. |
| Wave drift | W1 (resolución chain + fail-loud) → W2 (delegación sign/verify/settle + borrado legacy) en commits bf58251 + fix-pack ccdcd74 — orden correcto. |
| Spec drift | `signAndSettleDownstream` firma preservada `(agent, logger)` — DT-2. compose.ts NO modificado — CD-11. Grep `signTypedData\|createWalletClient\|TRANSFER_WITH_AUTHORIZATION` = 0 — CD-9. |
| Test drift | 27 tests en downstream-payment.test.ts. Todos los tests del Story File §"Tests legacy → nueva estrategia" presentes: T-SkipFlagOff, T-SkipNoPayment, T-SkipMethod, T-SkipPayToFormat, T-SkipZeroPayTo, T-SkipInvalidPrice (×5), T-Balance-Insufficient, T-Balance-ReadFail, T-SkipSigningFailed, T-SkipVerifyFailed-false, T-SkipVerifyFailed-throw, T-SkipSettleFailed-false, T-SkipSettleFailed-throw, T-AC1..T-AC6, T-AuthWindow, T-Balance-NoRpc. |
| CR/AR findings | BLQ-MED-1 cerrado en fix-pack ccdcd74 (timeoutSeconds:300 + T-AuthWindow). MNR-2/CR-MNR-1 (skip-codes muertos) resueltos en ccdcd74 (grep 0 matches para NETWORK_ERROR/CONFIG_MISSING). CR-MNR-1 ya no aplica. |

---

## AC-1 / AC-3 Live (PENDING-RUNTIME — validación post-merge)

AC-1 (Base) y AC-3 (Kite) están PASS a nivel unit/código. El tx-hash live outbound requiere:

1. Branch mergeada a main y deployada en Railway (gateway up con `WASIAI_A2A_CHAINS` incluyendo `base-sepolia` y `kite-ozone-testnet`).
2. Operator wallet funded en USDC (Base Sepolia) y PYUSD (Kite Ozone) — ya confirmado en validación `2026-05-27-multichain-deep-validation.md` Capa E/F (H15).
3. Un sub-agente registrado que cobre en Base Sepolia (`payment.chain:'base-sepolia'`) y uno en Kite (`'kite-ozone-testnet'`).
4. Llamar `/compose` con esos agentes. El facilitator multi-chain ya responde `/supported = 4 networks` — infra ready.
5. Capturar `downstreamTxHash` en la respuesta y verificar en Basescan (sepolia.basescan.org) / Kite explorer.

Esto corresponde a **Wave 3 (W3.1)** del Story File — la corre el humano/operador post-merge. NO es un FAIL de esta HU.

---

## Veredicto

**APROBADO PARA DONE**

- ACs: 4/6 PASS pleno (AC-2, AC-4, AC-5, AC-6) + 2/6 PASS unit + PENDING-RUNTIME live tx (AC-1, AC-3).
- Gates: tsc exit 0, npm test 1047/1047.
- BLQ-MED-1 resuelto y afirmado por T-AuthWindow.
- TD-WKH-112-01 (blockNumber) declarado y backward-compatible.
- Drift: cero scope creep en src/.
- PENDING-RUNTIME AC-1/AC-3 live no bloquea DONE (es Wave 3, post-merge, documentado).

