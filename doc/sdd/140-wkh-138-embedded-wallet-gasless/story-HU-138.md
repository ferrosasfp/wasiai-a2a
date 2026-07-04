# Story File — #140: [WKH-138 v1] Gasless en Avalanche/Base (EIP-3009 operator-relayed)

> SDD: `doc/sdd/140-wkh-138-embedded-wallet-gasless/sdd.md` (fuente de verdad; NO re-leer para implementar)
> Fecha: 2026-07-04
> Branch: `feat/140-wkh-138-gasless-avalanche-base`

---

## Goal

Completar los dos stubs gasless que hoy tiran `501` (`src/adapters/avalanche/gasless.ts`,
`src/adapters/base/gasless.ts`) con una implementación real que **firma EIP-3009
`transferWithAuthorization` con el OPERATOR key y la auto-relaya on-chain** (el operator
paga su propio gas AVAX/ETH y paga un payout USDC a `to`). El caller se debita off-chain
contra su Agent Key. Es dinero real → el riesgo #1 es **drenar el operator wallet**, así
que el cap per-call chain-aware (USDC 6 decimales, NO PYUSD) es la línea de defensa.

**Modelo (idéntico a Kite, salvo que Avalanche/Base NO tienen relayer HTTP externo →
el operator submite él mismo vía `writeContract`).** NO hay wallet embebida, NO hay
custodia, NO hay EIP-7702 (todo eso está diferido a WKH-138b y PROHIBIDO acá).

## Acceptance Criteria (EARS)

> Copiados del SDD. QA los verifica en F4.

1. **AC-1**: WHEN un caller autenticado con Agent Key invoca `POST /gasless/transfer`
   seleccionando `avalanche-fuji` / `avalanche-mainnet` / `base-sepolia` / `base-mainnet`
   (vía header `x-payment-chain`), THE system SHALL ejecutar la transferencia sin exigir
   que el caller posea el token nativo de gas de esa chain, con el mismo contrato de
   respuesta `{ txHash }` que Kite.
2. **AC-2**: WHEN una request excede el cap por-call (`GASLESS_DEFAULT_CAP_USD`), THE
   system SHALL rechazarla con `403 PER_CALL_LIMIT` **ANTES** de debitar el budget del key.
3. **AC-3**: WHILE el `funding_state` del adapter de Avalanche/Base no es `'ready'`
   (`unconfigured`/`unfunded`/`disabled`), THE system SHALL responder
   `503 gasless_not_operational` a cualquier transfer en esa chain.
4. **AC-4**: WHEN `GET /gasless/status` se consulta para Avalanche o Base, THE system SHALL
   reportar `funding_state`/`operatorAddress`/`supportedToken` REAL de esa chain (no el
   hardcode `enabled:false, funding_state:'disabled'` de los stubs).
5. **AC-5**: IF el estimador de costo usa una conversión de precio/decimales que no se puede
   calcular con certeza para la chain (decimals inválido, chain no manejada), THEN THE system
   SHALL rechazar la request (**fail-closed** → `+Infinity` → 403), nunca aplicar un cap
   subvaluado. PROHIBIDO reusar `pyusdWeiToUsd` para USDC.
6. **AC-6**: THE system SHALL NOT introducir código de custodia de llaves de usuario,
   derivación desde passkey, ni EIP-7702 en esta HU.

## Files to Modify/Create

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `src/lib/price.ts` | Modificar | Agregar `USDC_GASLESS_DECIMALS=6`, `getUsdcUsdRate()`, `usdcWeiToUsd(valueWei,decimals)`, `estimateGaslessValueUsd(chainKey,valueWei)`. Type-only import de `ChainKey`. Fail-closed. | El propio `price.ts` (`getPyusdUsdRate`/`pyusdWeiToUsd`) |
| 2 | `src/lib/price.test.ts` | Modificar | Tests W0: rate guard, overflow, decimals inválido→Infinity, dispatcher por chain, T-USDC-6DEC, T-DRAIN-CAP, T-REGR (kite byte-idéntico) | `price.test.ts` existente |
| 3 | `src/adapters/errors.ts` | Modificar | Agregar `GaslessTransferError` (`statusCode=500`, `code='gasless_transfer_failed'`) | `GaslessNotSupportedError` en el mismo archivo |
| 4 | `src/adapters/avalanche/gasless.ts` | Modificar | Reemplazar el stub: `transfer()` real (sign EIP-3009 + `writeContract` + `waitForTransactionReceipt`) + `status()` real + public/wallet client cacheado + cap adapter-level + `_reset*` | `kite-ozone/gasless.ts` + `erc8004-reputation-writer.ts:195-256` + `avalanche/payment.ts` |
| 5 | `src/adapters/base/gasless.ts` | Modificar | Mismo reemplazo para `BaseGaslessAdapter` (ojo: EIP-712 `name` varía por network en Base) | `base/payment.ts:57-71` + archivo #4 |
| 6 | `src/adapters/__tests__/avalanche.test.ts` | Modificar | Tests gasless Avalanche: AC-1/3/4, T-DEC, T-SIGN-INVALID, T-DRAIN-CAP (adapter-level) | `avalanche.test.ts` + `erc8004-reputation-writer.test.ts` (mock viem) |
| 7 | `src/adapters/__tests__/base.test.ts` | Modificar | Mismos tests para Base | archivo #6 |
| 8 | `src/middleware/a2a-key.ts` | Modificar | Augmentation `FastifyRequest`: agregar `gaslessChainKey?: ChainKey;` (junto a `gaslessEstimatedCostUsd`) + `import type { ChainKey }` si falta | `a2a-key.ts:61-73` |
| 9 | `src/routes/gasless.ts` | Modificar | (a) preHandler A resuelve chain (mirror x402) + `estimateGaslessValueUsd` + persiste `gaslessChainKey`; (b) handler usa `getGaslessAdapter(req.gaslessChainKey)`; (c) `GET /status` chain-aware | `x402.ts:198-234` + el propio `gasless.ts` |
| 10 | `src/routes/gasless.test.ts` | Modificar | Tests W2: AC-1..AC-4, T-CHAIN-BAD (400), chain no-init (400), T-REGR (sin header = kite) | `gasless.test.ts` existente |

> **Estrategia de reuso USDC (leer antes de W1).** Los helpers de USDC de `payment.ts`
> (`getUsdcAddress`, `getUsdcEip712Version`, `getUsdcEip712Name`, `USDC_DECIMALS`,
> `EIP3009_TYPES`, `ADDRESS_RE`, `getWalletClient`) son **privados al módulo** (no
> exportados). **CD-SDD: NO modificar `payment.ts`** (es money-path, evitá regresión del
> settle x402). Por eso: **declará dentro de cada `gasless.ts` una copia mínima de esas
> constantes/helpers, mirror EXACTO de `payment.ts`** (mismos nombres de env var, mismo
> `ADDRESS_RE`, mismos defaults, misma lógica warn-once). El guard contra divergencia es el
> **test T-DEC/T-ADDR** (obligatorio): asserta que la address/decimals que usa el gasless
> adapter == los del payment adapter de la MISMA network. Precedente: `base/payment.ts` YA
> es un mirror de `avalanche/payment.ts`, este patrón de duplicación controlada es el
> estándar del repo.

## Exemplars

### Exemplar 1: Sign EIP-3009 + auto-relay on-chain (el corazón de `transfer()`)
**Archivos**: `src/adapters/kite-ozone/gasless.ts:140-183` (firma) + `src/adapters/erc8004-reputation-writer.ts:220-254` (writeContract + waitForTransactionReceipt)
**Usar para**: archivos #4, #5
**Patrón clave** — combinar los dos:
- Firma (de `kite-ozone/gasless.ts`, pero dominio = USDC no PYUSD):
  ```ts
  const EIP3009_TYPES = { TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ] } as const;
  // now = Math.floor(Date.now()/1000); validAfter = 0n; validBefore = BigInt(now + WINDOW)
  // nonce = `0x${randomBytes(32).toString('hex')}`
  const signature = await walletClient.signTypedData({
    account, domain: { name: <USDC eip712 name>, version: <USDC eip712 version>,
      chainId: this.chainId, verifyingContract: getUsdcAddress(network) },
    types: EIP3009_TYPES, primaryType: 'TransferWithAuthorization',
    message: { from: account.address, to, value, validAfter, validBefore, nonce },
  });
  const { r, s, v, yParity } = parseSignature(signature);
  const vNum = v !== undefined ? Number(v) : Number(yParity) + 27;
  ```
- Submit + receipt (de `erc8004-reputation-writer.ts`, CD-7/CD-8):
  ```ts
  let txHash: `0x${string}`;
  try {
    txHash = await walletClient.writeContract({
      address: getUsdcAddress(network),
      abi: TRANSFER_WITH_AUTHORIZATION_ABI, // ver Exemplar 2
      functionName: 'transferWithAuthorization',
      args: [account.address, to, value, validAfter, validBefore, nonce, vNum, r, s],
      chain: getAvalancheChain(network) as Chain,   // getBaseChain para base
      account: walletClient.account ?? null,          // CD-7: nunca `!`, siempre `?? null`
    });
  } catch (err) { throw new GaslessTransferError(...); }
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: <ms> });
    if (receipt.status !== 'success') throw new GaslessTransferError('reverted'); // revert
  } catch (err) {
    if (err instanceof WaitForTransactionReceiptTimeoutError) throw new GaslessTransferError('receipt_timeout'); // CD-8: timeout THROWS, no lo refleja el receipt
    throw new GaslessTransferError(...);
  }
  return { txHash };
  ```
- `parseSignature`, `WaitForTransactionReceiptTimeoutError` se importan de `viem`.

### Exemplar 2: Wallet + public client cacheados por-network + USDC helpers
**Archivo**: `src/adapters/avalanche/payment.ts:64-199,425-476` · `src/adapters/base/payment.ts:57-156`
**Usar para**: archivos #4, #5 (declarar copias locales — NO importar de payment.ts)
**Patrón clave**:
- `getWalletClient(network)`: cache module-level por network (`_walletClientFuji`/`_walletClientMainnet` en avax; `_walletClientSepolia`/`_walletClientMainnet` en base), lee `OPERATOR_PRIVATE_KEY`, `createWalletClient({ account, chain: getAvalancheChain(network), transport: buildRpcTransport({ primary: getRpcUrl(network), fallbackEnv: '<...>_RPC_URL_FALLBACK', chainId }) })`.
- `getUsdcAddress(network)`: env override (`AVALANCHE_USDC_ADDRESS`/`FUJI_USDC_ADDRESS` · `BASE_MAINNET_USDC_ADDRESS`/`BASE_SEPOLIA_USDC_ADDRESS`) + fallback default + `ADDRESS_RE` + warn-once. **Copiar tal cual.**
- `USDC_DECIMALS = 6`. Avax: `USDC_EIP712_NAME = 'USD Coin'`, versión `getUsdcEip712Version(network)`. Base: `getUsdcEip712Name(network)` → Sepolia `'USDC'`, Mainnet `'USD Coin'` (`base/payment.ts:67-71`).
- Public client (para `waitForTransactionReceipt` y `balanceOf` en `status()`): `createPublicClient({ chain: getAvalancheChain(network), transport: buildRpcTransport({...}) })`, cacheado por-network igual que el wallet client (DT-8). RPC fail al leer balance → `null` → `funding_state` degrada a `unfunded` → 503 (fail-closed).
- ABI mínima `balanceOf` para `status()`: copiar de `kite-ozone/gasless.ts:225-238`.
- ABI mínima `transferWithAuthorization` (9 args v/r/s):
  ```ts
  const TRANSFER_WITH_AUTHORIZATION_ABI = [{
    name: 'transferWithAuthorization', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' },
    ], outputs: [],
  }] as const;
  ```
  `[VERIFY-AT-IMPL]` Circle USDC (FiatTokenV2) expone esta firma en Fuji/Avalanche C-Chain y Base Sepolia/Mainnet (los payment adapters ya firman EIP-3009 contra estos mismos contratos y el facilitator los submite). Si un contrato de test difiere, ajustá la ABL SOLO en el mock, no en producción.

### Exemplar 3: `status()` + `computeFundingState` + `_reset*`
**Archivo**: `src/adapters/kite-ozone/gasless.ts:218-331`
**Usar para**: archivos #4, #5
**Patrón clave**:
- `computeFundingState({ enabled, operatorAddress, balance })`: `disabled` si !enabled, `unconfigured` si sin operator, `unfunded` si balance `null`/`0n`, `ready` si `>0`. **Copiar la función tal cual.**
- `status()`: `enabled = process.env.GASLESS_ENABLED === 'true'`; operatorAddress vía `privateKeyToAccount(pk).address` (try/catch → null); balance vía public client `readContract balanceOf`; `supportedToken` = objeto USDC real (ver abajo). **CD-9 (`exactOptionalPropertyTypes`)**: construir el objeto de retorno con spread de `baseFields` + asignaciones explícitas como hace Kite — NUNCA `campo: cond ? v : undefined`.
- `supportedToken` para USDC (tipo `GaslessSupportedToken`, ver `src/types/index.ts:824-832`):
  ```ts
  { network: network === 'mainnet' ? 'mainnet' : 'testnet', symbol: 'USDC',
    address: getUsdcAddress(network), decimals: USDC_DECIMALS, // = 6
    eip712Name: <USDC name>, eip712Version: <USDC version>,
    minimumTransferAmount: USDC_MINIMUM_TRANSFER_WEI }
  ```
  `USDC_MINIMUM_TRANSFER_WEI`: const string, default `'1'` (guard mínimo; el cap es el guard real). `[VERIFY-AT-IMPL]` si querés env override, usá `GASLESS_MIN_TRANSFER_USDC_WEI` — no bloqueante.
- `_reset*()` test hook: limpiar wallet+public clients cacheados y flags warn-once (mirror `avalanche/payment.ts:483-488`).

### Exemplar 4: Selección de chain (mirror EXACTO de x402)
**Archivo**: `src/middleware/x402.ts:198-234`
**Usar para**: archivo #9 (preHandler A + `GET /status`)
**Patrón clave**:
```ts
const headerRaw = request.headers['x-payment-chain'];
const headerOverride = typeof headerRaw === 'string' ? headerRaw : undefined;
let chainKey = resolveChainKey({ headerOverride });          // chain-resolver.ts, puro, no-throw
if (!chainKey) {
  if (headerOverride !== undefined)                          // header presente no-reconocido
    return reply.status(400).send({ error_code: 'CHAIN_NOT_SUPPORTED', error: `Chain '${headerOverride}' ...` });
  chainKey = getDefaultChainKey() ?? undefined;              // header ausente → default
  if (!chainKey) return reply.status(500).send({ error_code: 'REGISTRY_NOT_INITIALIZED', ... });
}
if (!getAdaptersBundle(chainKey))                            // slug válido pero no inicializado
  return reply.status(400).send({ error_code: 'CHAIN_NOT_SUPPORTED',
    error: `Chain '${chainKey}' is not initialized. Initialized: ${getInitializedChainKeys().join(', ')}` });
```
- **Resolver UNA sola vez** en el preHandler A; persistir `request.gaslessChainKey = chainKey`. El handler y `GET /status` usan esa misma chainKey (anti-TOCTOU, CD-3). Lee SOLO el header, NUNCA `request.body`.
- Imports desde `../adapters/chain-resolver.js` (`resolveChainKey`) y `../adapters/registry.js` (`getDefaultChainKey`, `getAdaptersBundle`, `getInitializedChainKeys`, `getGaslessAdapter`).

### Exemplar 5: Helper de pricing puro (patrón de `price.ts`)
**Archivo**: `src/lib/price.ts:59-102,139-159`
**Usar para**: archivo #1
**Patrón clave**:
- `getUsdcUsdRate()`: mirror EXACTO de `getPyusdUsdRate` pero lee `USDC_USD_RATE`, default `1.0`, rango `[0,100]`, `log.warn` en fallback. **CD-10: NO acoplar al `PYUSD_USD_RATE`.**
- `usdcWeiToUsd(valueWei: bigint, decimals: number): number`:
  ```ts
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return Number.POSITIVE_INFINITY; // AC-5 fail-closed
  if (valueWei < 0n) return 0;
  if (valueWei > BigInt(Number.MAX_SAFE_INTEGER)) return Number.POSITIVE_INFINITY;
  return (Number(valueWei) / 10 ** decimals) * getUsdcUsdRate();
  ```
- `estimateGaslessValueUsd(chainKey: ChainKey, valueWei: bigint): number` — dispatcher con `switch` exhaustivo:
  ```ts
  switch (chainKey) {
    case 'kite-ozone-testnet':
    case 'kite-mainnet': return pyusdWeiToUsd(valueWei);        // CD-4 byte-idéntico
    case 'avalanche-fuji': case 'avalanche-mainnet':
    case 'base-sepolia': case 'base-mainnet':
      return usdcWeiToUsd(valueWei, USDC_GASLESS_DECIMALS);     // = 6
    default: return Number.POSITIVE_INFINITY;                   // AC-5 fail-closed
  }
  ```
- `import type { ChainKey } from '../adapters/types.js';` (type-only — mantiene `price.ts` puro, sin runtime import de adapters).

## Contrato de Integración ⚠️ BLOQUEANTE

> Esta HU tiene comunicación caller(HTTP) → route → adapter → chain. Contrato externo:

### Caller → `POST /gasless/transfer`

**Headers:**
- `x-payment-chain: avalanche-fuji | avalanche-mainnet | base-sepolia | base-mainnet` (opcional; ausente = chain default del registry, hoy Kite).
- Auth de Agent Key (via `requirePaymentOrA2AKey`, sin cambios).

**Request body:**
```json
{ "to": "0x… (address destino)", "value": "string (wei USDC, entero)" }
```

**Response 200:**
```json
{ "txHash": "0x…" }
```

**Errores:**
| HTTP | Cuándo |
|---|---|
| 400 | body sin `to`/`value` string, o `value` no-bigint |
| 400 `CHAIN_NOT_SUPPORTED` | `x-payment-chain` presente no-reconocido, o slug válido pero chain no inicializada |
| 403 `PER_CALL_LIMIT` | `estimateGaslessValueUsd(chainKey,value)` `!finite` o `> cap` — ANTES del debit |
| 503 `gasless_not_operational` | `funding_state !== 'ready'` de esa chain |
| 500 `gasless transfer failed` | firma/submit/revert/timeout on-chain (debit ya ocurrido — fee-on-attempt deliberado) |

### `GET /gasless/status`
- Header `x-payment-chain` (opcional). Devuelve `getGaslessAdapter(chainKey).status()` de esa chain. `rateLimit:false` se conserva.

## Constraint Directives

### OBLIGATORIO
- **CD-1**: cap de Avalanche/Base usa `estimateGaslessValueUsd(chainKey, valueWei)` chain-aware (USDC 6-dec, `USDC_USD_RATE`). Fail-closed → `+Infinity` → 403.
- **CD-2**: los decimales del cap == los del token que `transfer()` mueve on-chain. Test T-DEC obligatorio.
- **CD-3**: chain se resuelve UNA vez en preHandler A y se persiste en `request.gaslessChainKey`; handler, gate `funding_state` y `GET /status` usan ESA chainKey. Leer SOLO el header, nunca `request.body`.
- **CD-4**: sin header, el flujo Kite (default) es byte-idéntico a hoy (mismo `pyusdWeiToUsd`, mismo cap). Test T-REGR.
- **CD-5**: `transfer()` de Avalanche/Base **re-valida el cap adapter-level** (chain-aware) ANTES de firmar/submitear — rechaza value `!finite`, `> cap`, o `< minimumTransferAmount`. Belt-and-suspenders vs llamada directa al adapter.
- **CD-6**: `transfer()` firma SOLO con el OPERATOR key. `from == operator.address`. El caller NO controla `from` ni provee firma.
- **CD-7**: al pasar `.account` a `writeContract`, usar `walletClient.account ?? null` (NUNCA `!`).
- **CD-8**: `waitForTransactionReceipt` en try/catch: `WaitForTransactionReceiptTimeoutError` (throw) separado de `receipt.status !== 'success'` (revert). Nunca asumir que el timeout se refleja en el receipt.
- **CD-9**: `exactOptionalPropertyTypes` — NO `campo: cond ? v : undefined` en `GaslessAdapterStatus`/`supportedToken`. Construir con spread + asignaciones explícitas (mirror Kite).
- **CD-10**: `USDC_USD_RATE` env, sin cache, rango `[0,100]`, fallback `1.0` con `log.warn`. No acoplar a `PYUSD_USD_RATE`.
- **CD-11**: `tsc --noEmit` + `biome check src/` + tests verdes al cerrar cada wave. `_reset*` hooks para tests deterministas. Sin imports "por si acaso", sin supresiones amplias.

### PROHIBIDO
- **NO** dependencias nuevas. Todo se hace con `viem` (ya instalado) + módulos del repo.
- **NO** custodia de llaves de usuario, MPC, derivación desde passkey, seed phrases (AC-6, CD-WI-1).
- **NO** EIP-7702 / authorization / smart-account upgrade (AC-6, CD-WI-5).
- **NO** aceptar/usar un `from` provisto por el caller ni una firma externa (CD-6).
- **NO** reusar `pyusdWeiToUsd` para Avalanche/Base (CD-1).
- **NO** hardcodear private key, RPC, USDC address, ni rate — todo por env (CD-WI-4).
- **NO** modificar `src/adapters/avalanche/payment.ts` ni `base/payment.ts` (money-path; duplicar helpers localmente).
- **NO** cambiar la interfaz `GaslessAdapter`/`GaslessAdapterResult`/`GaslessTransferAdapterRequest` (`types.ts:53-105`).
- **NO** modificar archivos fuera de la tabla "Files to Modify/Create".
- **NO** endpoint gasless que bypasee `requirePaymentOrA2AKey` (CD-WI-2).

## Test Expectations

| Test | ACs / CD que cubre | Framework | Tipo | Archivo |
|------|--------------------|-----------|------|---------|
| T-USDC-6DEC | `usdcWeiToUsd(5_000_000n, 6)` == 5·rate; distinto de escala PYUSD | vitest | unit | `lib/price.test.ts` |
| T-DEC-INVALID | decimals no-entero/`<0`/`>36` → `+Infinity` (AC-5) | vitest | unit | `lib/price.test.ts` |
| T-DRAIN-CAP (pricing) | `value > MAX_SAFE_INTEGER` → `+Infinity`; chain no manejada → `+Infinity` (AC-5) | vitest | unit | `lib/price.test.ts` |
| T-DISPATCH | `estimateGaslessValueUsd`: kite→pyusd, avalanche/base→usdc, unknown→Infinity | vitest | unit | `lib/price.test.ts` |
| T-RATE-GUARD | `USDC_USD_RATE` fuera de `[0,100]`/NaN → fallback `1.0` (CD-10) | vitest | unit | `lib/price.test.ts` |
| T-REGR-PRICE | kite chainKey → resultado byte-idéntico a `pyusdWeiToUsd` (CD-4) | vitest | unit | `lib/price.test.ts` |
| T-AC1 | transfer avalanche/base → `writeContract` llamado, retorna `{txHash}` (mock viem) | vitest | unit | `__tests__/{avalanche,base}.test.ts` |
| T-AC3 | `status()` → `unfunded`/`disabled`/`unconfigured` según enabled/pk/balance | vitest | unit | `__tests__/{avalanche,base}.test.ts` |
| T-AC4 | `status()` reporta `supportedToken` USDC real (address==payment adapter, decimals 6) | vitest | unit | `__tests__/{avalanche,base}.test.ts` |
| T-DEC (consistencia) | address/decimals del gasless adapter == payment adapter, misma network (CD-2) | vitest | unit | `__tests__/{avalanche,base}.test.ts` |
| T-SIGN-INVALID | `writeContract` rechaza / receipt revert / receipt timeout → `GaslessTransferError`, txHash NO fabricado (CD-8) | vitest | unit | `__tests__/{avalanche,base}.test.ts` |
| T-DRAIN-CAP (adapter) | `transfer()` con value enorme → throw ANTES de `writeContract` (CD-5) | vitest | unit | `__tests__/{avalanche,base}.test.ts` |
| T-AC1-ROUTE | `POST /gasless/transfer` + `x-payment-chain: avalanche-fuji` → 200 `{txHash}` | vitest | integration | `routes/gasless.test.ts` |
| T-AC2-ROUTE | value > cap → 403 `PER_CALL_LIMIT`, sin llamar transfer, sin debit | vitest | integration | `routes/gasless.test.ts` |
| T-AC3-ROUTE | `funding_state != ready` → 503 `gasless_not_operational` | vitest | integration | `routes/gasless.test.ts` |
| T-AC4-ROUTE | `GET /gasless/status` con header avalanche/base → status real de esa chain | vitest | integration | `routes/gasless.test.ts` |
| T-CHAIN-BAD | `x-payment-chain: solana` → 400 `CHAIN_NOT_SUPPORTED`; slug válido no-init → 400 + lista | vitest | integration | `routes/gasless.test.ts` |
| T-REGR-ROUTE | sin header → flujo Kite (default) byte-idéntico (CD-4) | vitest | integration | `routes/gasless.test.ts` |

### Criterio Test-First
Lógica de negocio (pricing, adapter transfer) y ruta HTTP → **test-first SÍ**. Los helpers de `price.ts` (W0) escribí el test junto con la implementación en la misma wave.

### Cómo mockear viem (para T-AC1/T-SIGN-INVALID)
Seguí `src/adapters/erc8004-reputation-writer.test.ts:23-26` — `vi.mock('viem', ...)` con `createWalletClient` (retorna `{ writeContract, signTypedData, account }`), `createPublicClient` (retorna `{ waitForTransactionReceipt, readContract, getChainId }`), `privateKeyToAccount`. Para T-SIGN-INVALID hacé que `writeContract` reject / `waitForTransactionReceipt` reject con `WaitForTransactionReceiptTimeoutError` o resuelva `{status:'reverted'}`.

## Waves

### Wave -1: Environment Gate (verificar ANTES de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a
npm install 2>/dev/null || echo "revisar package.json"
# Archivos base del Scope IN existen:
ls src/lib/price.ts src/adapters/errors.ts \
   src/adapters/avalanche/gasless.ts src/adapters/base/gasless.ts \
   src/adapters/avalanche/payment.ts src/adapters/base/payment.ts \
   src/middleware/a2a-key.ts src/routes/gasless.ts \
   src/adapters/__tests__/avalanche.test.ts src/adapters/__tests__/base.test.ts \
   src/routes/gasless.test.ts src/lib/price.test.ts 2>/dev/null || echo "FALTA archivo base"
# Símbolos a reusar existen:
grep -q "buildRpcTransport" src/lib/rpc-transport.ts && echo "rpc-transport OK"
grep -q "resolveChainKey" src/adapters/chain-resolver.ts && echo "chain-resolver OK"
grep -q "getDefaultChainKey\|getAdaptersBundle\|getInitializedChainKeys" src/adapters/registry.ts && echo "registry OK"
grep -q "getAvalancheChain" src/adapters/avalanche/chain.ts && grep -q "getBaseChain" src/adapters/base/chain.ts && echo "chain helpers OK"
# viem exporta WaitForTransactionReceiptTimeoutError + parseSignature (probado en erc8004-reputation-writer.ts:28 y kite-ozone/gasless.ts:2):
grep -q "WaitForTransactionReceiptTimeoutError" src/adapters/erc8004-reputation-writer.ts && echo "viem timeout error import OK"
npx tsc --noEmit && echo "baseline tsc limpio"
```

**Si algo falla en Wave -1: PARAR y escalar al orquestador.**

### Wave 0 (Serial Gate — pricing; completar antes de W1/W2)
- [ ] W0.1: `src/lib/price.ts` — agregar `USDC_GASLESS_DECIMALS`, `getUsdcUsdRate`, `usdcWeiToUsd`, `estimateGaslessValueUsd` (Exemplar 5). → Archivo #1
- [ ] W0.2: `src/lib/price.test.ts` — T-USDC-6DEC, T-DEC-INVALID, T-DRAIN-CAP, T-DISPATCH, T-RATE-GUARD, T-REGR-PRICE. → Archivo #2
- [ ] W0.3: `src/adapters/errors.ts` — `GaslessTransferError`. → Archivo #3
- **Gate W0**: `tsc --noEmit` + `biome check src/lib/price.ts src/adapters/errors.ts` + `price.test.ts` verdes.

### Wave 1 (Paralelizable — adapters; W1a y W1b son independientes entre sí)
- [ ] W1a.1: `src/adapters/avalanche/gasless.ts` — reemplazar stub (Exemplars 1,2,3). → Archivo #4
- [ ] W1a.2: `src/adapters/__tests__/avalanche.test.ts` — T-AC1/3/4, T-DEC, T-SIGN-INVALID, T-DRAIN-CAP. → Archivo #6
- [ ] W1b.1: `src/adapters/base/gasless.ts` — mismo reemplazo, `name` EIP-712 por network. → Archivo #5
- [ ] W1b.2: `src/adapters/__tests__/base.test.ts` — mismos tests. → Archivo #7
- **Gate W1**: cada adapter compila + sus tests verdes. No dependen entre sí.

### Wave 2 (Serial — wiring de la ruta; depende de W0 + W1)
- [ ] W2.1: `src/middleware/a2a-key.ts` — augmentation `gaslessChainKey?: ChainKey`. → Archivo #8
- [ ] W2.2: `src/routes/gasless.ts` — preHandler A resuelve chain (Exemplar 4) + `estimateGaslessValueUsd` + persiste `gaslessChainKey`; handler y `GET /status` usan `getGaslessAdapter(req.gaslessChainKey)`; log incluye `chainKey`. → Archivo #9
- [ ] W2.3: `src/routes/gasless.test.ts` — T-AC1/2/3/4-ROUTE, T-CHAIN-BAD, T-REGR-ROUTE. → Archivo #10
- **Gate W2**: suite gasless + money-path verdes, `tsc`/`biome` limpios.

### Wave 3 (Final — verificación)
- [ ] W3.1: `npx tsc --noEmit` limpio en todo `src/`.
- [ ] W3.2: `npx biome check src/` limpio.
- [ ] W3.3: suite completa verde (`npm test` o el runner del repo).
- [ ] W3.4: grep de auto-verificación: `getGaslessAdapter(...).transfer` solo se llama desde `routes/gasless.ts` (R-2 anti-bypass); ningún `from` del caller ni EIP-7702 en el código nuevo (AC-6).

### Verificación Incremental
| Wave | Verificación |
|------|--------------|
| W0 | tsc + `price.test.ts` verde |
| W1 | tsc + `{avalanche,base}.test.ts` verde |
| W2 | tsc + `gasless.test.ts` + money-path verde |
| W3 | tsc + biome + full suite |

## Out of Scope
- Wallet embebida / custodia / MPC / passkey-derived keys → WKH-138b (PROHIBIDO acá).
- EIP-7702 / smart-account upgrade → PROHIBIDO acá.
- `src/adapters/avalanche/payment.ts`, `src/adapters/base/payment.ts` (NO tocar — duplicar helpers localmente).
- Separar wallet operator por-chain / alertas de gas nativo (decisión operativa, DT-10 del SDD — solo documentar si escribís la doc de fondeo, no es build).
- `kite-ozone/gasless.ts` (NO tocar — el path Kite queda byte-idéntico).
- Session keys / delegation / spend-policies (`services/delegation.ts`).
- NO "mejorar" código adyacente, NO refactors no solicitados.

## Escalation Rule

> **Si algo no está en este Story File, PARÁ y escalá al Architect. No inventes.**

Situaciones de escalation:
- La ABI `transferWithAuthorization` (9 args v/r/s) no matchea el contrato USDC real de la chain (ver `[VERIFY-AT-IMPL]` Exemplar 2) → escalá antes de cambiar producción.
- El error-boundary NO mapea `GaslessTransferError.statusCode`/`code` como esperabas → el handler de `routes/gasless.ts` ya captura y hace 500 en su `catch`, así que `GaslessTransferError` es principalmente para logging/tests; NO agregues código al error-boundary sin escalar. (`[VERIFY-AT-IMPL]`)
- `payment.ts` no exporta un helper que necesitás y duplicarlo es demasiado → escalá (NO modifiques payment.ts sin ratificación).
- Ambigüedad en un AC o un símbolo que no existe → PARÁ.

---

*Story File generado por NexusAgil — F2.5 — WKH-138 v1*
