# SDD — [WKH-138 v1] Gasless en Avalanche/Base (EIP-3009 operator-relayed)

> Fase F2 · SDD_MODE: full · QUICK_FLOW: **QUALITY** (money-path: el operator
> wallet paga gas + fondos reales; cualquier bug de pricing/cap es drain).
> NNN = **140**. Branch: `feat/140-wkh-138-gasless-avalanche-base`.
>
> **Scope ratificado por el humano (NO reabrir):** v1 = gasless en
> Avalanche/Base completando los stubs 501 existentes, extendiendo el patrón
> EIP-3009 del relayer de Kite (operator firma/relaya `transferWithAuthorization`).
> **Diferido a WKH-138b (NO se diseña acá):** wallet embebida, custodia de
> claves, EIP-7702. Los `[NEEDS CLARIFICATION]` de custodia/EIP-7702 del
> work-item pertenecen a esa HU, NO a este documento.

---

## 1. Context Map — archivos leídos y patrón extraído

| Archivo | Por qué | Patrón extraído |
|---|---|---|
| `src/adapters/kite-ozone/gasless.ts` | El relayer gasless que FUNCIONA (a extender) | `signTransferWithAuthorization` (operator=`from`, EIP-3009), `computeFundingState`, `getOperatorTokenBalance`, `status()` con `GASLESS_ENABLED` gate, `_reset*` test-hooks. **Diferencia clave**: Kite delega el submit a un relayer HTTP externo (`gasless.gokite.ai`); Avalanche/Base NO tienen ese relayer → el operator **auto-relaya** on-chain. |
| `src/adapters/avalanche/gasless.ts` · `src/adapters/base/gasless.ts` | Los stubs 501 a reemplazar | Estructura de clase (`name`, `chainId`, `networkTag`), `status()` shape, `documentation` link. Hoy `transfer()` siempre `throw GaslessNotSupportedError`. |
| `src/adapters/avalanche/payment.ts` · `src/adapters/base/payment.ts` | Ya firman EIP-3009 `TransferWithAuthorization` contra USDC en estas chains | `getWalletClient(network)` cacheado por-network con `OPERATOR_PRIVATE_KEY` + `buildRpcTransport`; `getUsdcAddress(network)` (env override + fallback + warn-once + `ADDRESS_RE`); `USDC_DECIMALS=6`; dominio EIP-712 (`name`/`version`/`chainId`/`verifyingContract`), Base varía `name` por network (Sepolia="USDC", Mainnet="USD Coin"); `EIP3009_TYPES`; `_resetWalletClient()`. **Reuso directo de toda esta maquinaria.** |
| `src/routes/gasless.ts` | El endpoint a extender con selección de chain | `gaslessCostEstimatorPreHandler` (Stage A: valida shape → `pyusdWeiToUsd` → cap → inyecta `gaslessEstimatedCostUsd`), `requirePaymentOrA2AKey` (Stage B: auth+debit), handler con gate `funding_state !== 'ready' → 503` y log estructurado. **Fee-on-attempt deliberado** (charge-first). |
| `src/middleware/x402.ts:198-234` | Patrón CANÓNICO de selección de chain ya en prod | `x-payment-chain` header → `resolveChainKey({headerOverride})` → header ausente = default; header presente no-reconocido = `400 CHAIN_NOT_SUPPORTED`; slug reconocido pero no inicializado (`getAdaptersBundle`→undefined) = `400 CHAIN_NOT_SUPPORTED` + lista. Resolución **exactamente una vez**, lee SOLO el header (nunca `body`). |
| `src/adapters/chain-resolver.ts` | El resolver puro | `normalizeChainSlug`/`resolveChainKey` — total, nunca throw, anti-prototype-pollution. Slugs: `avalanche-fuji`, `avalanche-mainnet`, `base-sepolia`, `base-mainnet` ya mapeados. |
| `src/adapters/registry.ts:182-234` | Accessors por chain | `getGaslessAdapter(chainKey?)`, `getAdaptersBundle(chainKey?)` (no-throw), `getInitializedChainKeys()`, `getDefaultChainKey()`. Los adapters gasless de Avalanche/Base YA están cableados en `buildBundle`. |
| `src/lib/price.ts` | El helper de pricing/cap a extender chain-aware | `pyusdWeiToUsd` (PYUSD-específico, `PYUSD_DECIMALS=6`, `PYUSD_USD_RATE`), `getGaslessDefaultCapUsd`, guard/fallback env-backed sin cache, overflow-safe (neg→0, >MAX_SAFE_INTEGER→`+Infinity`). |
| `src/adapters/types.ts` | Interfaz `GaslessAdapter` + tipos | `GaslessAdapter { name; chainId; transfer(); status() }`, `GaslessTransferAdapterRequest { to; value:bigint }`, `GaslessAdapterResult { txHash }`, `GaslessAdapterStatus`. `ChainKey` union. **NO se modifica la interfaz** (work-item DT-1). |
| `src/lib/rpc-transport.ts` | Transport con fallback | `buildRpcTransport({primary, fallbackEnv, chainId})` → viem `fallback([...])`, con public RPC por chainId (Avalanche/Base/Kite ya presentes). |
| `src/adapters/kite-ozone/client.ts` | Patrón de public client | `createPublicClient` + `readContract` para balance. Avalanche/Base **NO tienen** `client.ts` → hay que crear un public client para leer el balance USDC del operator en `status()`. |
| `src/middleware/a2a-key.ts:61-79,281-287` | Augmentation `FastifyRequest` + resolución de costo | `declare module 'fastify'` con `gaslessEstimatedCostUsd?`, `resolvedChainId?`, etc. `resolveEstimatedCostUsd()` usa `gaslessEstimatedCostUsd` para el debit. |
| `src/adapters/errors.ts` | Error tipado gasless | `GaslessNotSupportedError` (501). Se conservará para chains sin gasless; se agrega un error tipado para fallo de submit on-chain. |
| Auto-Blindaje WKH-133/135/136 | Errores recurrentes a prevenir | Ver §CD (CD-7..CD-11). |

---

## 2. Decisión de arquitectura — cómo funciona el gasless en Avalanche/Base

### Semántica (idéntica a Kite, explícita para el AR)
`POST /gasless/transfer { to, value }` NO recibe `from` ni firma del usuario. El
`from` es **el operator** (`OPERATOR_PRIVATE_KEY`). Es decir: **el operator paga
un payout de su PROPIO USDC a `to`, absorbiendo el gas nativo**, y el caller se
debita off-chain contra su Agent Key budget (`estimatedCostUsd`). No es
"gasless-para-el-usuario-dueño-de-los-fondos"; es un payout financiado por el
gateway. **Por eso el drain del operator wallet es el riesgo #1** y el cap
per-call + pricing chain-aware es la única línea de defensa (misma clase que
WKH-59/SEC-DRAIN-1).

### Mecanismo (ratificado): operator auto-relaya EIP-3009
Kite: operator firma EIP-3009 → POST a `gasless.gokite.ai` (relayer externo paga
gas). Avalanche/Base **no tienen ese relayer** → el operator **firma Y submite él
mismo** on-chain: llama `USDC.transferWithAuthorization(from, to, value,
validAfter, validBefore, nonce, v, r, s)` vía `writeContract`, pagando su gas
nativo (AVAX/ETH). Como `from == operator == submitter`, la firma EIP-3009 es una
auto-autorización; se usa `transferWithAuthorization` (no `transfer`) para
**parity con el patrón Kite + reuso de la maquinaria de firma ya auditada** en
`*/payment.ts`. Seguridad equivalente a `transfer(to,value)` (el operator controla
firma y submit); ver DT-2 y riesgo R-3 para el AR.

**Diagrama de flujo (route → adapter):**
```
POST /gasless/transfer  (header x-payment-chain: avalanche-fuji | base-sepolia | ...)
  ├─ preHandler A: gaslessCostEstimatorPreHandler
  │     1. resolveChainKey(header)            → chainKey  (400 CHAIN_NOT_SUPPORTED si inválida/no-init)
  │     2. valida body {to,value:wei}         → 400 si shape inválido
  │     3. estimateGaslessValueUsd(chainKey, valueWei)   ← CHAIN-AWARE, fail-closed (Infinity)
  │     4. cap = getGaslessDefaultCapUsd()    → 403 PER_CALL_LIMIT si !finite || > cap
  │     5. inyecta request.gaslessChainKey + request.gaslessEstimatedCostUsd
  ├─ preHandler B: requirePaymentOrA2AKey     → auth + debit(gaslessEstimatedCostUsd)
  └─ handler:
        1. adapter = getGaslessAdapter(request.gaslessChainKey)   ← MISMA chain que el pricing
        2. status = adapter.status(); if funding_state !== 'ready' → 503
        3. adapter.transfer({to, value})  → operator firma + submite transferWithAuthorization on-chain
        4. log estructurado (chainKey, keyId, estimatedCostUsd, value, to, txHash)
        5. return { txHash }
```

---

## 3. Decisiones Técnicas (DT-N)

- **DT-1 — Reuso de interfaz sin cambios.** `AvalancheGaslessAdapter` y
  `BaseGaslessAdapter` reemplazan SOLO el cuerpo de `transfer()`/`status()`,
  implementando la misma `GaslessAdapter` (`types.ts:100-105`). No se toca la
  interfaz ni `GaslessAdapterResult`/`GaslessTransferAdapterRequest`
  (work-item DT-1). El registry ya los cablea (`registry.ts:71-86`).

- **DT-2 — Auto-relay EIP-3009 vía `writeContract`.** El adapter firma EIP-3009
  reusando el dominio USDC de `*/payment.ts` (mismo `EIP3009_TYPES`, mismo
  `getUsdcAddress(network)`, mismo `getUsdcEip712Version`/`getUsdcEip712Name`,
  `USDC_DECIMALS=6`), luego llama `writeContract` con ABI mínima de
  `transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)`
  sobre el contrato USDC. `validAfter = now-1`, `validBefore = now + window`
  (window corto, p.ej. 60s), nonce = 32 bytes random. Circle USDC (FiatTokenV2)
  implementa EIP-3009 en Fuji/Avalanche C-Chain y Base Sepolia/Mainnet (los
  payment adapters ya firman contra esos contratos).

- **DT-3 — `waitForTransactionReceipt` con manejo de timeout/revert.** Tras el
  submit se espera el receipt. **Auto-Blindaje WKH-133**: en viem el timeout
  **lanza** `WaitForTransactionReceiptTimeoutError` (no retorna). Envolver en
  try/catch; `receipt.status !== 'success'` → revert. Ambos casos → error tipado
  → el handler lo mapea a error de transfer (500 / `gasless_transfer_failed`),
  y el debit ya ocurrido queda (fee-on-attempt deliberado, igual que hoy).

- **DT-4 — Pricing chain-aware en `price.ts` (fail-closed).** Se agregan helpers
  PUROS (sin adapters, coherente con el header del módulo):
  - `getUsdcUsdRate(): number` — lee `USDC_USD_RATE`, default `1.0`, rango
    `[0,100]`, guard/fallback idéntico a `getPyusdUsdRate`.
  - `usdcWeiToUsd(valueWei: bigint, decimals: number): number` — overflow-safe
    (neg→0, >MAX_SAFE_INTEGER→`+Infinity`); **decimals inválido** (no entero, <0,
    o >36) → `+Infinity` (fail-closed AC-5); caso normal
    `(Number(valueWei)/10**decimals) * getUsdcUsdRate()`.
  - `estimateGaslessValueUsd(chainKey: ChainKey, valueWei: bigint): number` —
    dispatcher puro (import type-only de `ChainKey`) que centraliza "qué token/
    decimales por chain": `kite-*` → `pyusdWeiToUsd` (byte-idéntico, backward
    compat); `avalanche-*`/`base-*` → `usdcWeiToUsd(valueWei, USDC_GASLESS_DECIMALS)`;
    **cualquier chainKey no manejado → `+Infinity`** (fail-closed). `PROHIBIDO`
    que la ruta llame `pyusdWeiToUsd` directo para Avalanche/Base (CD-3).

- **DT-5 — `USDC_GASLESS_DECIMALS = 6` anclado a la constante del payment
  adapter.** El pricing y el transfer DEBEN usar el MISMO decimals que el token
  que se mueve on-chain. Circle USDC = 6 decimales (fijo por Circle, no
  configurable; sólo la address es env-override). Un test de consistencia
  (§Test Plan T-DEC) asserta que `USDC_GASLESS_DECIMALS` == el `decimals` que
  reporta `adapter.status().supportedToken`. Si en el futuro una chain settlea un
  token con decimales distintos, hay que extender el dispatcher explícitamente —
  el fallback `+Infinity` para chains no manejadas evita subvaluación silenciosa.

- **DT-6 — Selección de chain vía `x-payment-chain` (mirror x402).** Se reusa
  EXACTAMENTE el patrón de `x402.ts:198-234`:
  header ausente → `getDefaultChainKey()` (backward-compat: hoy Kite es el
  default, comportamiento intacto); header presente no-reconocido → `400
  CHAIN_NOT_SUPPORTED`; slug reconocido pero no inicializado
  (`getAdaptersBundle(chainKey)`→undefined) → `400 CHAIN_NOT_SUPPORTED` + lista
  de `getInitializedChainKeys()`. **Resolución exactamente una vez** en el
  preHandler A; se persiste en `request.gaslessChainKey` para que el handler use
  la MISMA chain (evita TOCTOU / re-resolución divergente entre pricing y
  transfer). Lee SOLO el header, nunca `request.body` (CD del middleware).

- **DT-7 — `GET /gasless/status` chain-aware.** Reusa la misma resolución de
  chain (header `x-payment-chain`, default si ausente) y devuelve
  `getGaslessAdapter(chainKey).status()`. Reemplaza la respuesta hardcodeada de
  los stubs (AC-4). `rateLimit:false` se conserva.

- **DT-8 — Public client por-network para el balance del operator.** Avalanche/
  Base no tienen `client.ts`. `status()` necesita leer el balance USDC del
  operator para computar `funding_state` (`unfunded` vs `ready`). Se crea un
  public client con `createPublicClient({ chain: getAvalancheChain(network) |
  getBaseChain(network), transport: buildRpcTransport({...}) })` cacheado
  por-network (mismo patrón lazy que `getWalletClient`), con `_reset*` para
  tests. `readContract(balanceOf)` con la ABI mínima ya usada en
  `kite-ozone/gasless.ts:225-238`. Fallo de RPC → balance `null` →
  `funding_state` degrada a `unfunded` (no `ready`) → 503 (fail-closed, nunca
  transfer sin certeza de fondeo).

- **DT-9 — Gate de habilitación.** `status().enabled = process.env.GASLESS_ENABLED
  === 'true'` (parity con Kite, master global). `funding_state = computeFundingState({enabled,
  operatorAddress, balance})` (helper mirror de Kite: `disabled` si !enabled,
  `unconfigured` si sin operator, `unfunded` si balance null/0, `ready` si >0).
  Habilitar gasless en Avalanche/Base en prod requiere `GASLESS_ENABLED=true` +
  operator con USDC + operator con gas nativo (ver DT-10).

- **DT-10 — Gas nativo del operator NO se refleja en `funding_state`.** `funding_state`
  sólo mide balance USDC (mirror Kite). El operator también necesita AVAX/ETH
  para pagar gas del submit; si se agota, `transfer()` revierte/throws → 500
  `gasless_transfer_failed` (el debit ya ocurrió, fee-on-attempt). Esto es una
  **contabilidad de gas cruzada** con el settle x402 (mismo `OPERATOR_PRIVATE_KEY`,
  ver memoria `kite-relayer-gas-drain.md`). Para v1: documentado en la doc
  operativa (§Scope, doc de fondeo) + alerta de balance nativo recomendada. NO se
  separa wallet por chain en v1 (work-item DT-3 lo deja como decisión operativa,
  no de build). Se marca como **riesgo R-4** para el AR.

- **DT-11 — Config nueva 100% env, cero hardcodes.** `USDC_USD_RATE` (rate),
  reuso de `AVALANCHE_USDC_ADDRESS`/`FUJI_USDC_ADDRESS`/`BASE_*_USDC_ADDRESS`,
  `AVALANCHE_RPC_URL`/`FUJI_RPC_URL`/`BASE_RPC_URL` (+ `*_FALLBACK`),
  `OPERATOR_PRIVATE_KEY`, `GASLESS_ENABLED`, `GASLESS_DEFAULT_CAP_USD` (todos ya
  existen salvo `USDC_USD_RATE`). PROHIBIDO hardcodear key/RPC/rate (CD-4 del
  work-item). Ninguna nueva URL de relayer/paymaster externo (no hay tercero).

---

## 4. Constraint Directives (CD-N)

**Heredados del work-item (vigentes, verificar en AR/CR):**
- **CD-WI-1 (=CD-1 WI):** PROHIBIDO cualquier custodia de claves de usuario/MPC/
  passkey/seed en esta HU. **No aplica** — v1 no toca custodia. AR debe verificar
  que NO se introdujo.
- **CD-WI-2 (=CD-2 WI):** OBLIGATORIO reusar la defensa-en-profundidad de Kite:
  (a) cap per-call ANTES del debit, (b) `requirePaymentOrA2AKey`, (c) gate
  `funding_state !== 'ready' → 503`, (d) log estructurado. PROHIBIDO endpoint
  gasless que bypasee `requirePaymentOrA2AKey`.
- **CD-WI-5 (=CD-5 WI):** PROHIBIDO EIP-7702 en esta HU.
- **CD-WI-6 (=CD-6 WI):** AR verifica (archivo:línea) que ningún endpoint/campo/
  flag permite al caller controlar la wallet que paga o su destino sin pasar por
  cap+debit.

**Nuevos del SDD (específicos):**
- **CD-1 — Chain-aware pricing obligatorio, fail-closed.** El cap per-call de
  Avalanche/Base DEBE usar `estimateGaslessValueUsd(chainKey, valueWei)` con
  decimals/rate del token REAL de esa chain (USDC 6-dec, `USDC_USD_RATE`).
  **PROHIBIDO** llamar `pyusdWeiToUsd` para Avalanche/Base. Si el pricing no se
  puede calcular con certeza (chain no manejada, decimals inválido) → `+Infinity`
  → 403, nunca un cap subvaluado (AC-5, previene drain WKH-59/SEC-DRAIN-1).
- **CD-2 — Consistencia pricing↔transfer.** Los decimales usados para el cap
  DEBEN ser idénticos a los del token que `transfer()` mueve on-chain. Test
  T-DEC obligatorio. Un mismatch (`D_price < D_token`) es un vector de drain.
- **CD-3 — Chain resolution una sola vez, persistida.** La chain se resuelve en
  el preHandler A y se persiste en `request.gaslessChainKey`; el handler y el
  gate `funding_state` DEBEN usar esa misma chainKey (nunca re-resolver ni caer
  al default). Lee SOLO el header, nunca `request.body`. (Auto-Blindaje WKH-135
  MNR-1: validar la chain explícitamente en el write-boundary money-path).
- **CD-4 — Backward-compat Kite byte-idéntico.** Sin header `x-payment-chain`, el
  flujo Kite (default chain) debe ser byte-idéntico a hoy: mismo `pyusdWeiToUsd`,
  mismo cap, mismo status. Un test T-REGR lo asserta.
- **CD-5 — Defensa-en-profundidad adapter-level.** `transfer()` de Avalanche/Base
  DEBE re-validar el cap (chain-aware) ANTES de firmar/submitear, aunque la ruta
  ya lo hizo — belt-and-suspenders para que una llamada directa al adapter (fuera
  de la ruta) no pueda drenar. Rechaza value cuyo USD estimado es `!finite` o
  `> cap`, y value `<` mínimo. (CD-WI-6, CD-6 del work-item).
- **CD-6 — Sin custodia, sin `from` del caller.** `transfer()` firma con el
  OPERATOR key exclusivamente. PROHIBIDO aceptar/usar un `from` provisto por el
  caller o una firma externa (no está en la interfaz y no se agrega). El destino
  `to` viene del body pero el cap+debit lo gobiernan.
- **CD-7 — `walletClient.account ?? null`.** Al pasar `.account` a
  `writeContract`/`sendTransaction`, coalesce a `null` (Auto-Blindaje WKH-133 W1:
  `ReturnType<typeof createWalletClient>.account` incluye `undefined`; biome
  prohíbe non-null assertion).
- **CD-8 — `waitForTransactionReceipt` en try/catch.** Separar timeout (throw
  `WaitForTransactionReceiptTimeoutError`) de revert (`receipt.status !==
  'success'`). Nunca asumir que el timeout se refleja en el receipt (Auto-Blindaje
  WKH-133 W3).
- **CD-9 — `exactOptionalPropertyTypes`.** PROHIBIDO `x: cond ? v : undefined` en
  objetos tipados (`GaslessAdapterStatus`, `supportedToken`). Usar asignación
  condicional o valores no-undefined. (Auto-Blindaje WKH-133/134/136 recurrente).
- **CD-10 — `USDC_USD_RATE` env, sin hardcode, con guard.** Rate leído por
  request sin cache, rango `[0,100]`, fallback `1.0` con `log.warn` (mirror
  `getPyusdUsdRate`). PROHIBIDO acoplar el pricing USDC al `PYUSD_USD_RATE`.
- **CD-11 — biome/tsc limpio + tests verdes antes de cerrar wave.** `tsc
  --noEmit`, `biome check src/`, sin imports "por si acaso", sin supresiones
  amplias (Auto-Blindaje WKH-135/136). `_reset*` hooks para tests deterministas.

---

## 5. Waves de implementación

### W0 — Serial · Contratos + helpers puros (sin red, sin adapters)
Archivos:
- `src/lib/price.ts` — agregar `getUsdcUsdRate()`, `usdcWeiToUsd(valueWei,
  decimals)`, `estimateGaslessValueUsd(chainKey, valueWei)` (+ constante
  `USDC_GASLESS_DECIMALS = 6`, import type-only `ChainKey`). Fail-closed.
- `src/lib/price.test.ts` — extender: rate guard, overflow, decimals inválido→
  Infinity, dispatcher por chain (kite→pyusd, avalanche/base→usdc, unknown→
  Infinity), byte-identidad Kite (T-REGR-PRICE).
- `src/adapters/errors.ts` — agregar `GaslessTransferError` tipado (statusCode
  500, `code: 'gasless_transfer_failed'`) para submit/timeout/revert. **[VERIFY-AT-IMPL:
  confirmar que el error-boundary mapea `statusCode`/`code`; si no, el handler ya
  captura y hace 500 — en ese caso el error tipado es opcional].**

**Gate W0:** `tsc` + `biome` + `price.test.ts` verdes. Es el contrato de pricing
que W1/W2 consumen.

### W1 — Paralelizable · Adapters por chain (mirror uno del otro)
- **W1a** `src/adapters/avalanche/gasless.ts` — reemplazar stub:
  `transfer()` (sign EIP-3009 USDC + `writeContract transferWithAuthorization` +
  `waitForTransactionReceipt` con try/catch), `status()` (enabled + operator +
  balance USDC → `computeFundingState`), public client cacheado por-network
  (DT-8), `assertWithinCap` adapter-level (CD-5), `_reset*` hooks. Reusa
  `getUsdcAddress`/dominio de `avalanche/payment.ts` (extraer a un helper
  compartido intra-carpeta si evita duplicar, sin cambiar payment.ts).
- **W1b** `src/adapters/base/gasless.ts` — mismo reemplazo para `BaseGaslessAdapter`
  (ojo: EIP-712 `name` varía por network en Base, ya resuelto en
  `base/payment.ts:67-71`).
- Tests: `src/adapters/__tests__/avalanche.test.ts` y `.../base.test.ts` —
  extender (ahí viven los tests de estos adapters). Mockear `fetch`/viem clients
  como en los tests de payment.

**Gate W1:** cada adapter compila + sus tests verdes. No dependen entre sí.

### W2 — Serial · Wiring de la ruta (depende de W0 + W1)
- `src/middleware/a2a-key.ts` — augmentation `FastifyRequest`: agregar
  `gaslessChainKey?: ChainKey` (junto a `gaslessEstimatedCostUsd`).
- `src/routes/gasless.ts` — (1) `gaslessCostEstimatorPreHandler`: resolver
  chainKey (mirror x402: header→`resolveChainKey`, 400 CHAIN_NOT_SUPPORTED,
  `getAdaptersBundle` check), usar `estimateGaslessValueUsd(chainKey, valueWei)`,
  persistir `request.gaslessChainKey`. (2) Handler `POST /transfer`: usar
  `getGaslessAdapter(request.gaslessChainKey)` para status-gate + transfer; log
  incluye `chainKey`. (3) `GET /status`: resolución de chain (header, default si
  ausente) → `getGaslessAdapter(chainKey).status()`.
- `src/routes/gasless.test.ts` — extender: AC-1..AC-4, chain inválida→400, chain
  no-init→400, backward-compat Kite (T-REGR).

**Gate W2:** suite gasless + money-path verdes, `tsc`/`biome` limpios.

---

## 6. Exemplars verificados (paths confirmados con Read/Glob)

| Qué copiar | Exemplar (verificado) |
|---|---|
| Firma EIP-3009 USDC + dominio + `EIP3009_TYPES` | `src/adapters/avalanche/payment.ts:68-77,425-476` · `src/adapters/base/payment.ts:85-94` |
| `getWalletClient(network)` cacheado + `buildRpcTransport` | `src/adapters/avalanche/payment.ts:167-199` |
| `getUsdcAddress(network)` (env+fallback+warn+`ADDRESS_RE`) | `src/adapters/avalanche/payment.ts:86-137` · `base/payment.ts:103-...` |
| `computeFundingState` + `getOperatorTokenBalance` + `status()` shape | `src/adapters/kite-ozone/gasless.ts:218-321` |
| Public client (`createPublicClient` + `readContract balanceOf`) | `src/adapters/kite-ozone/client.ts:19-31` + `kite-ozone/gasless.ts:218-243` |
| Selección de chain (`x-payment-chain` → 400 CHAIN_NOT_SUPPORTED) | `src/middleware/x402.ts:198-234` |
| Resolver puro | `src/adapters/chain-resolver.ts:61-88` |
| Pricing env-backed + guard + overflow-safe | `src/lib/price.ts:59-102,139-159` |
| Augmentation `FastifyRequest` | `src/middleware/a2a-key.ts:61-79` |
| preHandler cap→debit + gate 503 + log | `src/routes/gasless.ts:31-152` |
| Registry accessors por chain | `src/adapters/registry.ts:182-234` |
| `_reset*` test hooks | `kite-ozone/gasless.ts:328-331` · `avalanche/payment.ts:483-488` |

---

## 7. Plan de tests (≥1 por AC + casos gasless-security)

| Test | Cubre | Archivo |
|---|---|---|
| T-AC1-AVAX / T-AC1-BASE | `x-payment-chain` avalanche/base → transfer ejecuta sin gas del caller, respuesta `{txHash}` | `routes/gasless.test.ts`, `__tests__/{avalanche,base}.test.ts` |
| T-AC2-CAP | value > cap → `403 PER_CALL_LIMIT` ANTES del debit (no llama transfer, no debita) | `routes/gasless.test.ts` |
| T-AC3-NOTREADY | `funding_state != 'ready'` (unfunded/disabled) → `503 gasless_not_operational` | `routes/gasless.test.ts`, adapters |
| T-AC4-STATUS | `GET /gasless/status?chain=avalanche/base` → funding_state/operatorAddress/supportedToken REAL (no hardcode) | `routes/gasless.test.ts`, adapters |
| T-AC5-DECIMALS (fail-closed) | pricing con decimals inválido / chain no manejada → `+Infinity` → 403, nunca cap subvaluado | `lib/price.test.ts` |
| T-AC6-NOCUSTODY | assert estático/estructural: `transfer` no acepta `from` del caller, no hay código de custodia/EIP-7702 | AR (grep) + comentario en test |
| T-DEC (consistencia) | `USDC_GASLESS_DECIMALS` == `status().supportedToken.decimals` (CD-2) | `__tests__/{avalanche,base}.test.ts` |
| T-SIGN-INVALID | firma/submit falla (facilitator/RPC error, revert) → error propagado, txHash no fabricado; receipt timeout (throw) manejado (CD-8) | adapters |
| T-CHAIN-BAD | `x-payment-chain: solana` → 400 CHAIN_NOT_SUPPORTED; slug válido no-init → 400 + lista | `routes/gasless.test.ts` |
| T-DRAIN-CAP | value enorme (>MAX_SAFE_INTEGER) → Infinity → 403; adapter-level `assertWithinCap` rechaza value directo (CD-5) | `lib/price.test.ts`, adapters |
| T-USDC-6DEC | `usdcWeiToUsd(5_000_000n, 6)` == 5·rate; distingue de la escala PYUSD | `lib/price.test.ts` |
| T-REGR (Kite) | sin header → flujo Kite byte-idéntico (pricing/cap/status) (CD-4) | `routes/gasless.test.ts`, `lib/price.test.ts` |

---

## 8. Riesgos para el AR (foco: drain del operator + decimales)

- **R-1 (CRÍTICO) — Subvaluación del cap → drain de USDC del operator.** Si el
  pricing usa decimales/rate equivocados (p.ej. reuso de `pyusdWeiToUsd` o
  `USDC_USD_RATE` mal configurado), un caller con budget mínimo podría hacer que
  el operator pague un payout USDC muy superior al debitado. Mitigación: CD-1/CD-2
  + fail-closed (Infinity→403) + T-AC5/T-DEC/T-DRAIN-CAP. AR debe verificar
  archivo:línea que el cap de Avalanche/Base usa `estimateGaslessValueUsd` y que
  decimals(pricing)==decimals(transfer).
- **R-2 — Bypass de cap/debit vía llamada directa al adapter.** Si algún path
  invoca `adapter.transfer()` sin pasar por la ruta, se saltea el cap. Mitigación:
  CD-5 (re-validación adapter-level) + CD-WI-2 (ningún endpoint gasless nuevo sin
  `requirePaymentOrA2AKey`). AR: grep de call-sites de `getGaslessAdapter().transfer`.
- **R-3 — `transferWithAuthorization` con operator=from.** Semántica de
  auto-autorización; AR debe confirmar que no expone un vector donde el caller
  controle `from`/firma (no lo hace: interfaz `{to,value}`). Equivalente seguro a
  `transfer(to,value)`.
- **R-4 — Contabilidad de gas cruzada (operator compartido con settle x402).**
  El mismo `OPERATOR_PRIVATE_KEY` paga gas de gasless Y de settle x402; batería
  larga de gasless puede drenar el gas nativo y romper settle (memoria
  `kite-relayer-gas-drain.md`). No es fund-loss del caller, pero sí operacional.
  v1: documentado + alerta recomendada; no se separa wallet (DT-10). AR: marcar
  como observación operativa, no bloqueante para v1.
- **R-5 — `funding_state` no cubre gas nativo.** `ready` sólo mide USDC; el
  operator puede estar "ready" pero sin AVAX/ETH → transfer revierte tras el
  debit (fee-on-attempt). Aceptado v1 (documentado). AR: confirmar que el fallo
  post-debit no deja estado inconsistente (no lo hace: no hay tx on-chain si
  revierte antes; si revierte después, el debit queda, igual que Kite hoy).

---

## 9. Readiness Check

- [x] Scope IN mapeado a Waves (price.ts, avalanche/base gasless.ts, routes/gasless.ts, a2a-key augmentation, errors.ts, doc operativa).
- [x] Mecanismo ratificado (EIP-3009 operator auto-relay) — NO paymaster, NO tercero, NO custodia, NO EIP-7702.
- [x] Todos los exemplars verificados con Read (paths reales, líneas citadas §6).
- [x] Chain selection resuelta: `x-payment-chain` mirror x402 (patrón en prod), 400 CHAIN_NOT_SUPPORTED — cierra el `[NEEDS CLARIFICATION]` de selección de chain del work-item (no bloqueante para F2, ahora decidido).
- [x] Pricing chain-aware fail-closed diseñado (CD-1/CD-2, AC-5) — NO reuso de `pyusdWeiToUsd` para USDC.
- [x] Defensa-en-profundidad heredada de Kite + anti-drain adapter-level (CD-5).
- [x] Auto-Blindaje aplicado como CD-7..CD-11 (WKH-133 account/receipt, WKH-135 chain-validation, WKH-136 exactOptional/biome).
- [x] Test plan: ≥1 por AC (AC-1..AC-6) + firma inválida + chain equivocada + drain/cap + decimales USDC + backward-compat Kite.
- [x] Cero hardcodes nuevos (config vía env; sólo `USDC_USD_RATE` es nuevo).
- [x] `[NEEDS CLARIFICATION]` de custodia/EIP-7702 → **fuera de scope (WKH-138b)**, NO abiertos en este SDD.
- [ ] `[VERIFY-AT-IMPL]` único abierto (no bloqueante): confirmar que el
  error-boundary mapea un `GaslessTransferError` tipado; si no, el handler ya hace
  500 en su catch → error tipado opcional. No afecta la seguridad ni el contrato.

**Veredicto:** SDD LISTO para SPEC_APPROVED. Sin `[NEEDS CLARIFICATION]`
bloqueantes abiertos.
