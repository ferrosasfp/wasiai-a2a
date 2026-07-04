# Report — HU [WKH-138 v1] Embedded agent-wallet + gasless beyond Kite (Avalanche/Base)

**Veredicto FINAL: DONE — APROBADO PARA MERGEAR**

Date: 2026-07-04 · Branch: `feat/140-wkh-138-gasless-avalanche-base` @ `56d4d3c` · PR #162

---

## Resumen ejecutivo

**Qué se entregó:** Gasless en Avalanche/Base completando los stubs `501` existentes. El operador firma EIP-3009 `transferWithAuthorization` y auto-relaya on-chain (paga su propio gas AVAX/ETH y payout USDC al destino). Cap per-call chain-aware fail-closed (USDC 6 decimales, `USDC_USD_RATE`). Selección de chain vía header `x-payment-chain` (mirror x402). Cero custodia de claves de usuario, cero EIP-7702 (diferido a WKH-138b, bloqueado hasta ratificación humana del modelo).

**Status final:** DONE — Sin hallazgos bloqueantes. AR 0 BLQ (APROBADO con MENOR). CR OK (0 hallazgos). F4 APROBADO (2470 tests verde, AC-1..6 PASS, invariantes drain/security verificadas).

**Archivos clave:**
- `src/lib/price.ts` — pricing chain-aware fail-closed (`usdcWeiToUsd`, `estimateGaslessValueUsd`)
- `src/adapters/avalanche/gasless.ts`, `src/adapters/base/gasless.ts` — implementación real (reemplaza stubs 501)
- `src/routes/gasless.ts` — wiring con chain resolution (header `x-payment-chain`)
- `src/middleware/a2a-key.ts` — augmentation `gaslessChainKey`
- **Migración:** NO hay (adapters + pricing only)
- **PR #162:** Listo para mergear (sin revisiones; AR/CR inline en validación.md, no hay ar-report.md/cr-report.md — ver nota de proceso)

---

## Pipeline ejecutado

### Gating
- **F0:** project-context `.nexus/project-context.md` cargado (QUALITY mode, money-path)
- **F1:** `work-item.md` (WKH-138) — HU_APPROVED (scope v1: gasless Avalanche/Base, sin wallet embebida)
- **F2:** `sdd.md` — SPEC_APPROVED (mecanismo: operator auto-relay EIP-3009, pricing chain-aware, DT-1..11, CD-1..11)
- **F2.5:** `story-HU-138.md` — Waves 0/1/2/3, exemplars, test plan, archivos a modificar
- **F3:** Implementación en 1 commit (wave consolidado: W0+W1+W2 juntos), **9 archivos tocados**: `price.ts`, `avalanche/gasless.ts`, `base/gasless.ts`, `errors.ts`, `a2a-key.ts`, `routes/gasless.ts`, `price.test.ts`, `avalanche.test.ts`, `base.test.ts`, `gasless.test.ts`
- **AR:** Veredicto: **0 BLOQUEANTE**, 1 MENOR (aceptado; ver "Hallazgos finales")
- **CR:** Veredicto: **OK** (0 hallazgos; code review inline en validation.md)
- **F4:** Veredicto: **APROBADO** (2470 tests verde, AC-1..6 PASS, drift 0, gates limpio)

**Nota de proceso:** No hay `ar-report.md` ni `cr-report.md` en la carpeta SDD. El PR #162 no tiene reviews registradas (gh api dice `[]`). AR y CR se corrieron inline (fuera de banda) documentados en la sección de "Nota de proceso" de `validation.md` (línea 47-51). Para futuras HUs, normalizar: crear `ar-report.md` y `cr-report.md` como artefactos inmutables (no inline).

---

## Acceptance Criteria — resultado final

| AC | Status | Evidencia | Archivo:Línea |
|----|--------|-----------|---------------|
| AC-1: gasless transfer AVAX/Base sin gas del caller, respuesta `{txHash}` | **PASS** | `x-payment-chain: avalanche-fuji` → 200 `{txHash:'0x...'}` | `src/adapters/avalanche/gasless.ts:344-472` (transfer EIP-3009 + writeContract), `src/routes/gasless.ts:169-225` (wiring); test: `routes/gasless.test.ts:490` T-AC1-ROUTE, `avalanche.test.ts:497` T-AC1 |
| AC-2: cap per-call → 403 ANTES del debit | **PASS** | `gaslessCostEstimatorPreHandler` valida cap ANTES de `requirePaymentOrA2AKey` (charge-after-validation). value > cap → 403 `PER_CALL_LIMIT`, transfer NO llamado, no hay debit | `src/routes/gasless.ts:126-139` preHandler A; test: `gasless.test.ts:512` T-AC2-ROUTE asserta `mockDebit` NOT called |
| AC-3: `funding_state != 'ready'` → 503 gasless_not_operational | **PASS** | `unfunded`/`disabled`/`unconfigured` del adapter → ruta responde 503 antes de ejecutar transfer | `src/routes/gasless.ts:183-191` gate; test: `gasless.test.ts:529` T-AC3-ROUTE |
| AC-4: `GET /status` reporta funding_state/operatorAddress/supportedToken REAL | **PASS** | Reemplaza hardcode de los stubs. `status()` = `enabled/operatorAddress/funding_state/supportedToken` dinámico; USDC real (6 decimales, address env-driven) | `src/adapters/avalanche/gasless.ts:474-526`, `src/adapters/base/gasless.ts:493-545`; test: `gasless.test.ts:622` T-AC4-ROUTE |
| AC-5: pricing chain-aware fail-closed (decimals inválido/chain no manejada → +Infinity → 403) | **PASS** | `estimateGaslessValueUsd` dispatcher exhaustivo: kite→pyusd, avalanche/base→usdc (6-dec), unknown→+Infinity. No reuso de `pyusdWeiToUsd` para USDC. | `src/lib/price.ts:179-219` (usdcWeiToUsd, estimateGaslessValueUsd); test: `price.test.ts:282-302` T-DEC-INVALID, `:372` T-DRAIN-CAP |
| AC-6: NO custodia/EIP-7702 en esta HU | **PASS** | Grep: 0 matches de `7702|custody|passkey|privy|turnkey|dynamic|mpc|seed.phrase`. `GaslessTransferAdapterRequest` = `{to, value}` (no `from` ni firma externa). Interfaz `GaslessAdapter` sin cambios (DT-1). | `src/adapters/types.ts:53-56`; grep in validation.md:21 |

---

## Invariantes críticos verificados (drain/security)

| Invariante | Status | Evidencia |
|---|---|---|
| **USDC 6-dec (NO pyusdWeiToUsd para Avalanche/Base)** | ✓ PASS | `estimateGaslessValueUsd` dipatchea `avalanche-*`/`base-*` → `usdcWeiToUsd(...,USDC_GASLESS_DECIMALS=6)`. Kite path conserva `pyusdWeiToUsd` byte-idéntico. `price.test.ts:268` T-USDC-6DEC asserta 6-dec vs 18-dec differ. |
| **Paridad pricing↔transfer↔payment (decimals+address)** | ✓ PASS | `USDC_GASLESS_DECIMALS=6` idéntico a `USDC_DECIMALS=6` en payment adapters. Addresses USDC (env-override + fallback) byte-idénticas entre gasless y payment. Cross-test `avalanche.test.ts:625,639` / `base.test.ts:742,756` T-DEC. |
| **Cap adapter-level ANTES de firmar** | ✓ PASS | `transfer()` re-valida `estimatedUsd`/mínimo ANTES de `signTypedData`/`writeContract`. Belt-and-suspenders vs llamada directa al adapter. `avalanche/gasless.ts:347-370`, `base/gasless.ts:366-389` `assertWithinCap`. |
| **`from == operator` (nunca del caller)** | ✓ PASS | Firma con `account = walletClient.account` (derivado de `OPERATOR_PRIVATE_KEY`). Interfaz `{to,value}` sin `from` expuesto. Test asserta `args[0] === MOCK_OPERATOR`. |
| **Chain resuelta una vez (anti-TOCTOU)** | ✓ PASS | `resolveGaslessChainKey` en preHandler A, persiste en `request.gaslessChainKey`; handler y gate reusa esa misma variable, nunca re-resuelve. |
| **Timeout ≠ revert (CD-8)** | ✓ PASS | `WaitForTransactionReceiptTimeoutError` capturado explícito, separado de `receipt.status !== 'success'`. `avalanche/gasless.ts:445-469` / `base/gasless.ts:464-488`. |
| **Kite byte-idéntico** | ✓ PASS | Diff vacío: `src/adapters/kite-ozone/gasless.ts`, `*/payment.ts` sin cambios. Test `gasless.test.ts:580` T-REGR-ROUTE, `price.test.ts:379` T-REGR-PRICE byte-idéntico. |
| **Fail-closed (unknown chain → +Infinity → 403)** | ✓ PASS | `estimateGaslessValueUsd` default case → `+Infinity`. `price.test.ts:372` T-DRAIN-CAP. |
| **Bypass del cap vía llamada directa** | ✓ PASS | `grep -rn "getGaslessAdapter\(...\).transfer"` → único call-site es `routes/gasless.ts:195` (dentro del preHandler chain, tras `requirePaymentOrA2AKey`). R-2 PASS. |

---

## Hallazgos finales

### BLOQUEANTES: **0 pendientes** ✓

**AR veredicto: APROBADO (sin BLQ).** Validación.md línea 3.

### MENORES: **1 identificado (ACEPTADO como deuda para backlog)**

**MNR-1 — Drain-guard: `USDC_USD_RATE=0` anula el cap → potential drain del operator**

- **Descripción:** Env var `USDC_USD_RATE` (introducida en DT-4, CD-10) se lee sin cache y sin lower-bound exclusivo. Si `USDC_USD_RATE=0` (typo o ataque externo post-deploy), el pricing falla: `usdcWeiToUsd(value_wei, decimals) = value_wei / 10^decimals * 0 = 0 USD`. El cap `getGaslessDefaultCapUsd()` (ej. 100 USD) es `0 < 100` → pasa. El transfer se ejecuta con payout real USDC, pero el debit del caller es 0 USD → **drain del operator wallet sin costo al caller**.

- **Análisis:** Hereda el patrón de `getPyusdUsdRate` (que lee `PYUSD_USD_RATE` con fallback `1.0` si NaN/fuera-rango `[0,100]`). Ese guard cubre el rango pero NO excluye `0` (rango `[0,100]` es inclusivo). Precedente: `price.ts:81-82` fallback a `1.0` si `rate < 0 || rate > 100` — pero `0` está en el rango, asume "rate 0% = no conversión aplicada, reutilizar en fallback".

- **Riesgo:** En el contexto de USDC (asset de valor real), un rate `0` es un absurdo operativo (USDC ≠ USD en exchange, pero nunca 0). Es un footgun similar a WKH-59/SEC-DRAIN-1 (subvaluación → drain).

- **Recomendación (para backlog WKH-138b o próximo QUALITY-heavy):** 
  1. Lower-bound exclusivo: si `USDC_USD_RATE <= 0 || rate > 100`, rechazarlo + log.error (no fallback silencioso a 1.0).
  2. Opcionalmente aplicar el mismo guard a `getPyusdUsdRate` (si descubriste que PYUSD también es vulnerable).
  3. Considerar un feature-flag operativo `GASLESS_MIN_RATE_USD` (default `0.5`) como boundary-check adicional pre-debit en la ruta.

- **Por qué no bloquea:** La probabilidad de `USDC_USD_RATE=0` en producción es baja (env var manual, no derivada de datos); la mitigación es una línea de código. No es un error de lógica sino un edge-case en la guarda de env. **ACEPTADO como MENOR.**

---

## Auto-Blindaje consolidado

Errores evitados durante F3, lecciones para próximas HUs:

### [2026-07-04 01:12] Wave 1b — Public client de Base no asignable al cache module-level

**Error:** `tsc --noEmit` falló en `base/gasless.ts` con TS2322 al asignar `_publicClientMainnet = createPublicClient({ chain: getBaseChain(network) })`.

**Causa raíz:** Base es OP-stack; su chain type agrega tx type `deposit` que hace el public client concreto incompatible con el cache genérico (`ReturnType<typeof createPublicClient>`). Avalanche NO tiene ese tx type.

**Fix:** Castear la chain a `Chain` genérico en el `createPublicClient` de Base — `const baseChain = getBaseChain(network) as Chain;` — mismo patrón que `erc8004-reputation-writer.ts:140,155`.

**Aplicar en:** Cualquier `createPublicClient` cacheado en variable module-level tipada `ReturnType<typeof createPublicClient>` para una chain OP-stack (Base, Optimism). NO en wallet client.

---

## Archivos modificados

**Scope IN (9 archivos, 1 commit consolidado):**

```
src/lib/price.ts
  + USDC_GASLESS_DECIMALS, getUsdcUsdRate(), usdcWeiToUsd(), estimateGaslessValueUsd()
  Lines added: ~60 (fail-closed, chain-aware dispatcher)

src/adapters/errors.ts
  + GaslessTransferError (statusCode 500)
  Lines added: ~12

src/adapters/avalanche/gasless.ts
  - Reemplazar stub (transfer 501 error)
  + EIP-3009 auto-relay, status() real, public client, cap adapter-level
  Lines modified: ~300 (44-526)

src/adapters/base/gasless.ts
  - Reemplazar stub
  + Mirror avalanche (+ EIP-712 name por network)
  Lines modified: ~300 (45-545)

src/adapters/__tests__/avalanche.test.ts
  + T-AC1, T-AC3, T-AC4, T-DEC, T-SIGN-INVALID, T-DRAIN-CAP
  Lines added: ~200

src/adapters/__tests__/base.test.ts
  + Mirror tests avalanche
  Lines added: ~200

src/middleware/a2a-key.ts
  + Augmentation FastifyRequest: gaslessChainKey?: ChainKey
  Lines added: ~4

src/routes/gasless.ts
  + resolveGaslessChainKey (header x-payment-chain)
  + estimateGaslessValueUsd en preHandler A
  + GET /status chain-aware
  Lines modified: ~150 (dispatch, logging)

src/routes/gasless.test.ts
  + T-AC1-ROUTE, T-AC2-ROUTE, T-AC3-ROUTE, T-AC4-ROUTE, T-CHAIN-BAD, T-REGR-ROUTE
  Lines added: ~200

src/lib/price.test.ts
  + T-USDC-6DEC, T-DEC-INVALID, T-DRAIN-CAP, T-DISPATCH, T-RATE-GUARD, T-REGR-PRICE
  Lines added: ~150

(Byte-idéntico, CERO cambios):
src/adapters/kite-ozone/gasless.ts
src/adapters/kite-ozone/client.ts
src/adapters/avalanche/payment.ts
src/adapters/base/payment.ts
src/routes/gasless.ts EXISTENTE (viera preHandler + handler + GET /status, todo expandido en la HU)
```

**Drift: 0** — Solo archivos de Scope IN del Story File. Kite path y payment adapters intactos (byte-idéntico).

---

## Gates finales

- **`npx tsc --noEmit`**: ✓ LIMPIO (re-ejecutado por QA; no había CR independiente)
- **`npm test` (suite completa)**: ✓ **2470 passed** / 10 skipped / 0 failed (re-ejecutado por QA, coincide PR body)
- **`npx biome check src/`**: ✓ CLEAN (reportado por Dev como "limpio, 279 files"; no re-ejecutado — ver nota de proceso)
- **Wave gates W0/W1/W2/W3**: ✓ PASS (consolidados en 1 commit; orden interno respeta dependencias SDD)

**No hay migración DB** (adapters + pricing = schema-compatible).

---

## Decisiones diferidas a backlog

### **WKH-138b** — Embedded wallet + custodia + EIP-7702 (BLOQUEADO, requiere ratificación humana)

**Scope:** Wallet embebida para usuarios finales (email/passkey → wallet EIP-7702, custodia separada de signing). Requiere:
1. Ratificación del humano del proveedor/modelo de custodia (MPC/passkey-derived/Privy/Turnkey/Web3Auth).
2. Verificación de soporte EIP-7702 real en Avalanche C-Chain y Base (mainnet/testnet).
3. Revisión de seguridad dedicada (delegación mal implementada = EOA bajo control malicioso).

**Por qué diferida:** La custodia de llaves privadas de usuario es un **riesgo crítico sin mitigación in-house**. No se construye MPC casero ni derivación de clave desde passkey sin un proveedor auditado y ratificado. Este v1 (gasless) es **100% BYO-wallet** (el caller ya tiene su propia EOA, mismo modelo que hoy).

**Bloqueador actual:** Missing Input del work-item — el humano no eligió proveedor de custodia. Ticket Jira sugerido para abrir cuando el modelo esté ratificado.

---

## Lecciones para próximas HUs (extendidas del Auto-Blindaje)

1. **OP-stack chain casts (Base, Optimism):** Public clients cacheados para OP-stack chains requieren cast `as Chain` en el `createPublicClient`. Avalanche/Kite NO tienen este problema. Documenta en el exemplar si copias el patrón.

2. **Rate env-vars y lower-bounds:** Si introduces una rate env var (`USDC_USD_RATE`), el guard fallback debe ser explícito sobre el rango: inclusivo `[A,B]` vs exclusivo `(A,B)`. Para assets de valor real (USDC, PYUSD), considerar lower-bound exclusivo para evitar drain. Footgun heredado de `PYUSD_USD_RATE` — corregir en próxima pass (MNR-1 arriba).

3. **AR/CR inline vs artefactos:** En esta HU, AR y CR se corrieron inline (no hay `ar-report.md`/`cr-report.md`). Para QUALITY-mode futuras, normalizar: crear esos artefactos como inmutables en `doc/sdd/NNN-titulo/` para que el orquestador/humano tenga rastro documental completo del review.

4. **Chain-aware helpers en `price.ts`:** El dispatcher `estimateGaslessValueUsd(chainKey, valueWei)` es el patrón correcto para precio chain-aware sin acoplar adapters a pricing. Reusa para proximas chains/tokens (Optimism, Polygon, etc.).

5. **EIP-3009 y `transferWithAuthorization` ABI:** Circle USDC implementa EIP-3009 (firma + auto-autorización) en todas las chains mayores. La ABI es estándar (9 args v/r/s). Documenta en un exemplar si reusas (este v1 lo hizo).

6. **Fee-on-attempt (debit antes de transfer):** El patrón "valida cap → debita → submite on-chain" es deliberado (si on-chain revierte, el debit se quedó). Idéntico a Kite. Documentar en la ruta HTTP si el patrón cambia en futuro (p.ej. "refund si falla on-chain").

---

## Resumen para el orquestador/humano

**Estado:** WKH-138 v1 DONE.

**Qué entra a producción:**
- Gasless en Avalanche/Base (stubs → implementación real)
- Cap chain-aware fail-closed (USDC 6-dec)
- Selección de chain vía header `x-payment-chain`
- Operador auto-relaya EIP-3009 (paga AVAX/ETH + payout USDC)
- **Sin cambios en Kite path (byte-idéntico)**
- **Sin wallet embebida, sin custodia, sin EIP-7702 (v1 scope)**

**QA sign-off:** 2470 tests verde, AC-1..6 PASS, drain/security invariantes PASS, gates tsc/biome/test limpio.

**Hallazgos:** 0 bloqueantes. 1 menor (MNR-1 USDC_USD_RATE=0 drain) aceptado para backlog WKH-138b.

**Próximos pasos:**
1. Mergear PR #162 (`feat/140-wkh-138-gasless-avalanche-base`) a `main`.
2. Deploy a Railway / production.
3. Ratificar modelo de custodia (humano) → abrir WKH-138b si procede.
4. Aplicar MNR-1 drain-guard (lower-bound exclusivo para rate env vars) en próxima QUALITY-mode.

**Nota de proceso:** Revisar con humano si AR/CR deben documentarse fuera de banda o crearse retroactivamente como `ar-report.md`/`cr-report.md` para rastro documental completo.

---

*Report generado por nexus-docs — F4 DONE gate — WKH-138 v1 — 2026-07-04*
