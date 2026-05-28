# CR Report — #094 [WKH-112] [BASE-07] outbound downstream payment chain-aware

> Revisor: nexus-adversary (Code Review)
> Fecha: 2026-05-27
> Branch: feat/094-wkh-112-downstream-chain-aware (commit bf58251)
> Input: sdd.md (CD-1..CD-11), story-file.md
> Diff: src/lib/downstream-payment.ts (refactor mayor), src/lib/downstream-payment.test.ts (reescrito), src/lib/downstream-payment.mainnet.test.ts (ELIMINADO)

---

## Gates (corridos de verdad)

| Gate | Comando | Resultado |
|------|---------|-----------|
| Typecheck autoritativo | `npx tsc -p tsconfig.build.json --noEmit` | **exit 0 — limpio** |
| Suite completa | `npm test` (vitest run) | **1046 passed / 1046 (71 files) — exit 0** |
| Test file aislado | `vitest run src/lib/downstream-payment.test.ts` | 26 passed / 26 |

Delta de tests 1048 → 1046 (−2): **deliberado y sin pérdida de cobertura real** (ver C-3).

---

## Tabla de hallazgos

| ID | Severidad | Observación | Evidencia archivo:línea | Sugerencia |
|----|-----------|-------------|-------------------------|------------|
| CR-1 | OK | CD-1 path Avalanche íntegro: `chain:'avalanche'`/`'avalanche-fuji'` resuelve a `avalanche-fuji`, value 6-dec, `eip155:43113`, pre-flight balance check preservado, NEVER-throws. Única desviación declarada (`blockNumber` no se puebla) está justificada en DT-1 opción C y es type/wire-backward-compatible. | downstream-payment.ts:144 (resolución), :208-263 (balance check); test :443-468 (T-AC2a/b); StepResult.downstreamBlockNumber? opcional en types/index.ts:232 | — |
| CR-2 | OK | CD-3 sin hardcodes de chain: address/decimals/network derivan del adapter (`adapter.getToken()`, `adapter.supportedTokens[0].decimals`, `signed.paymentRequest.network`). `RPC_ENV_BY_CHAIN` es mapa de NOMBRES de env var (tolerado por CD-3), no literales de chain. `chainId` del balance check viene de `bundle.chainConfig.chainId`. | downstream-payment.ts:37-44, :193, :224, :234, :288 | — |
| CR-3 | OK | CD-5 TS strict: cero `any`, cero `as unknown`. Los 4 `as` son narrows permitidos (`as 0x...` ×3 + `as bigint` sobre el retorno `unknown` de `readContract`). `ChainKey` tipado correctamente. tsc build exit 0. | downstream-payment.ts:86, :221, :238, :344 | — |
| CR-4 | OK | CD-6 coherencia chain: `chainKey` resuelto UNA vez (:144), reusado para bundle (:145), adapter (:189), decimals (:193) y balance (:208). El `proof` (network incl.) se construye UNA vez y se pasa idéntico a verify (:298) y settle (:321) → mismo network garantizado. T-AC5 lo afirma. | downstream-payment.ts:144,189,289-293,298,321; test :533-554 | — |
| CR-5 | OK | CD-7 NEVER-throws: try/catch en sign (:271-282), verify (:297-305), settle (:320-328), parseUnits (:195-203), balance read (:232-249), + outer defensivo (:268-355). Todos retornan `null` con skip-code. Firma `Promise<DownstreamResult | null>`. | downstream-payment.ts:110-355 | — |
| CR-6 | OK | CD-8 value dimensional: `parseUnits(String(agent.priceUsdc), adapter.supportedTokens[0].decimals)` — NO 6 fijo. T-AC3 afirma Kite value `'500000000000000000'` (18-dec) y `.not.toBe('500000')`. | downstream-payment.ts:193-196; test :470-491 | — |
| CR-7 | OK | CD-9 sin signTypedData inline: grep confirma 0 ocurrencias de `signTypedData`/domain EIP-712/`TRANSFER_WITH_AUTHORIZATION_TYPES`. Firma 100% delegada a `adapter.sign(...)`. | downstream-payment.ts:272-275; grep limpio | — |
| CR-8 | OK | CD-10 usa `normalizeChainSlug` (chain-resolver real en tests, no tabla inline). | downstream-payment.ts:14,144 | — |
| CR-9 | OK | CD-11 NO modificó adapters/registry/chain-resolver/compose: `git diff` confirma solo los 3 archivos del Scope IN tocados. | git diff --name-only (3 files) | — |
| CR-10 | OK | Borrado legacy COMPLETO: grep de getDownstreamNetwork/getUsdcAddress/getUsdcEip712Version/buildClients/buildCanonicalBody/postFacilitator/getFacilitatorUrl/TRANSFER_WITH_AUTHORIZATION_TYPES/constantes-chain/wire-types/createWalletClient/avalancheFuji/randomBytes/WASIAI_DOWNSTREAM_NETWORK → 0 ocurrencias. Sin código muerto. Imports viem reducidos a lo usado por el balance check (createPublicClient/erc20Abi/http/parseUnits + privateKeyToAccount). | downstream-payment.ts:11-19; grep limpio | — |
| CR-11 | OK | Reescritura de tests sin pérdida de cobertura: 26 casos (vs 21 legacy non-mainnet). Asserts CONCRETOS (toEqual con txHash+settledAmount exactos, value exacto). Ejercita Base/Avalanche/Kite + fail-loud (T-AC4a/b) + 18-dec (T-AC3). chain-resolver REAL → alias mapping end-to-end. | downstream-payment.test.ts:218-596 | — |
| CR-12 | OK | Mock-registry completo (lección WKH-111/093): exporta `getPaymentAdapter`+`getAdaptersBundle`+`getInitializedChainKeys`. No rompe otros mocks de registry (compose.test.ts mockea downstream-payment.js entero → no toca registry real; suite verde). | downstream-payment.test.ts:97-105; compose.test.ts:46-48 | — |
| CR-13 | OK | DownstreamResult shape `{txHash, settledAmount: value.toString()}` (blockNumber omitido, DT-1 opción C). `settledAmount` coherente con el value firmado (mismo `value`). DownstreamLogger usa solo warn/info (no .error). | downstream-payment.ts:47-51, :343-346; types/index.ts:339-342 | — |
| CR-14 | OK | Legibilidad: naming claro, comentarios citan CD/DT (CD-6/CD-7/CD-8/CD-9/DT-1/DT-3/TD-WKH-112-01), pasos numerados 1-13 alineados al SDD §4.3. | downstream-payment.ts (comentarios inline) | — |
| CR-MNR-1 | MENOR | La union `DownstreamSkipCode` conserva `'NETWORK_ERROR'` y `'CONFIG_MISSING'` que tras el refactor quedan SIN uso (ningún `return null` los emite). El Story File (`:100`) lo declara explícitamente NO bloqueante ("se PUEDEN conservar"). No afecta runtime ni tipos. | downstream-payment.ts:66-67 | Opcional: limpiar en backlog para evitar drift entre la union y los codes realmente emitidos. NO bloquea DONE. |

**Conteo: 14 OK, 1 MENOR, 0 BLOQUEANTES.**

---

## Análisis del delta de tests (−2: 1048 → 1046)

Inventario verificado:
- **Legacy (main)** en los 2 archivos downstream: `downstream-payment.test.ts` = 16 `it()` + 1 `it.each`×5 = **21 casos expandidos**; `downstream-payment.mainnet.test.ts` = **7 casos**. Total **28**.
- **Branch**: `downstream-payment.test.ts` = **26 casos**; `mainnet.test.ts` = **0 (eliminado)**. Total **26**.
- Delta = 28 − 26 = **−2** → coincide exacto con 1048 → 1046.

Descomposición:
- **−7**: mainnet.test.ts eliminado — DELIBERADO (DT-1: el concepto `WASIAI_DOWNSTREAM_NETWORK=avalanche-mainnet` desaparece; mainnet es Scope OUT). Aprobado en SDD.
- **+5 netos** en la suite no-mainnet: se retiran 2 tests OBSOLETOS (legacy #12 `facilitatorErrorBody` y #13 `facilitatorBody settled=false` — el body raw del facilitator ahora es responsabilidad del adapter; reemplazados por T-SkipSettleFailed-false que asserta `settleRes.error`); se AGREGAN T-AC3 (Kite 18-dec), T-AC4b, T-AC5, T-AC6, T-Balance-NoRpc, T-SkipVerifyFailed-throw, T-SkipSettleFailed-throw.

**Conclusión: el −2 es 100% atribuible al retiro deliberado de mainnet (Scope OUT) + consolidación de 2 tests obsoletos en cobertura equivalente vía adapter-error. NO hay pérdida de cobertura funcional real.** Todos los ~17 skip-codes legacy tienen equivalente 1-a-1 en la nueva suite (mapeo del Story File §"Tests legacy → nueva estrategia" cumplido).

---

## Veredicto

**APROBADO** (con 1 observación MENOR no bloqueante).

- BLOQUEANTES: **0**
- MENOR: 1 (CR-MNR-1 — skip-codes huérfanos en la union; explícitamente declarado NO bloqueante por el Story File).
- Gates: tsc build exit 0, npm test 1046/1046 verde.

El gate NO se bloquea. CR-MNR-1 se documenta para backlog; no exige fix-pack.

---

## Resumen al orquestador

CR de WKH-112 (BASE-07) APROBADO, 0 bloqueantes, 1 menor no bloqueante. El refactor de `downstream-payment.ts` a thin orchestrator del adapter cumple las 11 CDs verificadas con evidencia archivo:línea: cero hardcodes de chain (CD-3), value dimensional via `adapter.supportedTokens[0].decimals` con guard Kite-18 afirmado en T-AC3 (CD-8), firma 100% delegada al adapter sin `signTypedData` residual (CD-9), coherencia de chain con `chainKey` resuelto una vez y `proof` único compartido por verify/settle (CD-6), NEVER-throws con try/catch en cada paso async (CD-7), y CD-11 respetado (solo los 3 archivos del Scope IN tocados; compose/adapters/registry intactos). El borrado legacy es completo (grep limpio, sin código muerto, imports viem reducidos). La reescritura de tests no pierde cobertura: el delta −2 (1048→1046) se explica íntegro por el retiro deliberado de `.mainnet.test.ts` (7 casos, Scope OUT por DT-1) más la consolidación de 2 tests obsoletos de facilitator-body en cobertura equivalente; la nueva suite suma cobertura nueva (Kite 18-dec, fail-loud no-inicializado, coherencia network, fail-soft sin RPC, verify/settle-throw). Mock-registry completo con las 3 funciones (lección WKH-111/093). Gates en verde: tsc -p tsconfig.build.json --noEmit exit 0, npm test 1046/1046. El único menor (CR-MNR-1) es la conservación de `NETWORK_ERROR`/`CONFIG_MISSING` en la union de skip-codes sin uso post-refactor, explícitamente declarado no bloqueante por el Story File. Apto para avanzar a F4 (QA).
