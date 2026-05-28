# Story File — #094: [WKH-112] [BASE-07] outbound downstream payment chain-aware

> SDD: doc/sdd/094-wkh-112-downstream-chain-aware/sdd.md
> Work item: doc/sdd/094-wkh-112-downstream-chain-aware/work-item.md
> Fecha: 2026-05-27
> Branch: feat/094-wkh-112-downstream-chain-aware
> SPEC_APPROVED: SI
> Este es el ÚNICO documento que el Dev lee en F3. Si algo no está aquí, el Dev PARA y escala.

---

## Goal

Hacer chain-aware el settle **OUTBOUND** del gateway (`src/lib/downstream-payment.ts`):
el path por el que el gateway PAGA con el OPERATOR wallet a los sub-agentes durante
`/compose` y `/orchestrate`. Hoy reimplementa inline todo el flujo `sign(EIP-3009) →
verify → settle` contra una sola chain (Avalanche) y trae un guard duro
`if (agent.payment.chain !== 'avalanche') return null`. El cambio convierte el módulo en
un **thin orchestrator del adapter**: resuelve el `ChainKey` del agente destino desde
`agent.payment.chain` con `normalizeChainSlug`, valida que esté inicializada en el
registry (fail-loud `CHAIN_NOT_SUPPORTED`), y delega `sign`+`verify`+`settle` a
`getPaymentAdapter(chainKey)`. **NO se reimplementa la firma** (el adapter ya encapsula el
domain EIP-712 correcto por chain, validado onchain en Base/Avax/Kite). **Cero regresión
Avalanche** (CD-1). **NEVER-throws preservado** (CD-7).

---

## Acceptance Criteria (EARS)

> Copiados del SDD aprobado. QA los verifica en F4.

- **AC-1** (settle outbound Base): WHEN `/compose` paga a un sub-agente cuyo
  `agent.payment.chain` resuelve a `base-sepolia`, THEN firmar EIP-3009 con el OPERATOR
  wallet vía el adapter de Base y settlear vía facilitator de Base (`network =
  eip155:84532`), retornando `DownstreamResult` con `txHash` verificable en Basescan y
  `settledAmount` en 6 decimales.
- **AC-2** (CERO regresión Avalanche): WHEN el sub-agente cobra en
  `avalanche-fuji`/`avalanche`, THEN comportarse funcionalmente idéntico (mismo
  facilitator, USDC Fuji, `eip155:43113`, skip-codes, NEVER-throws) y los tests existentes
  permanecen verdes. Cualquier diff observable funcional en el path Avalanche es
  BLOQUEANTE. (Única desviación declarada y acotada: `blockNumber` deja de poblarse —
  DT-1/TD-WKH-112-01; es metadata opcional, `txHash` intacto.)
- **AC-3** (settle outbound Kite, 18-dec): WHEN el sub-agente cobra en
  `kite-ozone-testnet`, THEN firmar+settlear vía adapter de Kite (`network = eip155:2368`,
  PYUSD, 18 decimales), retornando `DownstreamResult` con el `txHash` — sin enviar a
  Avalanche.
- **AC-4** (chain no soportada → fail-loud): IF `agent.payment.chain` resuelve a un
  `ChainKey` NO inicializado en el registry, o no se reconoce (`normalizeChainSlug` →
  undefined), THEN omitir el settle con skip-code `CHAIN_NOT_SUPPORTED` + log estructurado
  listando `getInitializedChainKeys()`; PROHIBIDO caer al default Avalanche o enviar a
  otra chain.
- **AC-5** (coherencia chain): WHILE se procesa el pago a un agente con chain resuelta
  `K`, usar el MISMO `ChainKey K` para resolver el adapter, la firma y el
  facilitator/network del settle. PROHIBIDO mezclar el adapter de una chain con el network
  de otra.
- **AC-6** (sin hardcodes de chain): derivar address/network/chainId/decimales/EIP-712
  domain del ADAPTER seleccionado (`getToken()`/`getNetwork()`/`supportedTokens[].decimals`
  + firma interna del adapter) — PROHIBIDO mantener `DEFAULT_FUJI_USDC`/
  `DEFAULT_AVALANCHE_USDC`/`FUJI_NETWORK`/`AVALANCHE_NETWORK` como fuente de verdad.

---

## Anti-Hallucination Checklist (símbolos EXACTOS verificados en el codebase)

> Todo lo siguiente fue verificado con Read/Grep contra el código real (2026-05-27).
> El Dev NO debe inventar firmas: usar EXACTAMENTE estas. Si una firma no coincide, PARAR
> y escalar.

### Imports nuevos en `downstream-payment.ts` (paths exactos con extensión `.js`)

```ts
import type { ChainKey } from '../adapters/types.js';
import { normalizeChainSlug } from '../adapters/chain-resolver.js';
import {
  getPaymentAdapter,
  getAdaptersBundle,
  getInitializedChainKeys,
} from '../adapters/registry.js';
```

### Firmas exactas (NO inventar — copiadas del código)

| Símbolo | Firma EXACTA | Archivo:línea verificado |
|---------|--------------|--------------------------|
| `normalizeChainSlug` | `normalizeChainSlug(raw: string): ChainKey \| undefined` — total, nunca throw. **OJO: el parámetro es `string`, NO `string \| undefined`.** `agent.payment.chain` es `string` (no opcional), así que se puede pasar directo. | `src/adapters/chain-resolver.ts:61` |
| `getPaymentAdapter` | `getPaymentAdapter(chainKey?: ChainKey): PaymentAdapter` — **PUEDE LANZAR** si el registry no está inicializado o la chain no existe (`resolveBundleOrThrow`). En el camino feliz no lanza porque el paso previo ya validó `getAdaptersBundle(chainKey) !== undefined`. | `src/adapters/registry.ts:172` |
| `getAdaptersBundle` | `getAdaptersBundle(chainKey?: ChainKey): AdaptersBundle \| undefined` — NO lanza; devuelve `undefined` si la chain no está inicializada. **Este es el guard fail-loud.** | `src/adapters/registry.ts:213` |
| `getInitializedChainKeys` | `getInitializedChainKeys(): ChainKey[]` — lista de chains inicializadas. | `src/adapters/registry.ts:226` |
| `ChainKey` | `type ChainKey = 'kite-ozone-testnet' \| 'kite-mainnet' \| 'avalanche-fuji' \| 'avalanche-mainnet' \| 'base-sepolia' \| 'base-mainnet'` | `src/adapters/types.ts:122-128` |
| `PaymentAdapter.sign` | `sign(opts: SignRequest): Promise<SignResult>` donde `SignRequest = {to: \`0x${string}\`, value: string, timeoutSeconds?: number}` y `SignResult = {xPaymentHeader: string, paymentRequest: X402PaymentRequest}`. **`value` es `string` (no bigint).** | `src/adapters/types.ts:35-43,85` |
| `PaymentAdapter.verify` | `verify(proof: X402Proof): Promise<VerifyResult>` donde `X402Proof = {authorization, signature: string, network: string}` y `VerifyResult = {valid: boolean, error?: string}`. **PUEDE LANZAR** (Kite pieverse mode lanza en network error — `kite-ozone/payment.ts:269-272`). | `src/adapters/types.ts:21-29,83` |
| `PaymentAdapter.settle` | `settle(req: SettleRequest): Promise<SettleResult>` donde `SettleRequest = {authorization, signature: string, network: string}` y `SettleResult = {txHash: string, success: boolean, error?: string}`. **`SettleResult` NO trae `blockNumber` ni `amount`.** | `src/adapters/types.ts:11-20,82` |
| `PaymentAdapter.supportedTokens` | `readonly supportedTokens: TokenSpec[]` donde `TokenSpec = {symbol: string, address: \`0x${string}\`, decimals: number}`. Acceder `adapter.supportedTokens[0].decimals`. Base/Avax = 6, **Kite = 18**. | `src/adapters/types.ts:6-10,81`; Base `payment.ts:354`; Kite `payment.ts:216` |
| `PaymentAdapter.getToken` | `getToken(): \`0x${string}\`` — address del token de pago de la chain. | `src/adapters/types.ts:88` |
| `PaymentAdapter.getNetwork` | `getNetwork(): string` — tag `eip155:<chainId>`. (No es necesario para el settle; el `network` viene de `signed.paymentRequest.network`.) | `src/adapters/types.ts:87` |
| `X402PaymentRequest` (shape de `signed.paymentRequest`) | `{authorization: {from, to, value, validAfter, validBefore, nonce} (todos string), signature: string, network?: string}`. **`network` es OPCIONAL en el tipo**, pero los 3 adapters SIEMPRE lo pueblan en `sign()` (`base/payment.ts:446`, etc.). | `src/types/index.ts:397-408` |
| `getAdaptersBundle(k).chainConfig.chainId` | `AdaptersBundle.chainConfig = {name: string, chainId: number, explorerUrl: string}`. Usar `bundle.chainConfig.chainId` para el public client efímero de la balance check. | `src/adapters/types.ts:135-145`; avalanche `index.ts:40-44` |
| `DownstreamLogger` | **`{warn: (obj: unknown, msg?: string) => void; info: (obj: unknown, msg?: string) => void}`. SOLO `warn` + `info`. NO TIENE `.error`.** → DT-4 usa `logger.warn` (NUNCA `logger.error`). | `src/types/index.ts:339-342` |
| `DownstreamResult` (actual, a modificar) | `{txHash: \`0x${string}\`; blockNumber: number; settledAmount: string}` → pasa a `blockNumber?: number` (opcional). | `src/lib/downstream-payment.ts:76-80` |
| `DownstreamSkipCode` (actual — NO cambia) | `'FLAG_OFF' \| 'NO_PAYMENT_FIELD' \| 'METHOD_NOT_SUPPORTED' \| 'CHAIN_NOT_SUPPORTED' \| 'INVALID_PAY_TO_FORMAT' \| 'ZERO_PAY_TO' \| 'INVALID_PRICE' \| 'INSUFFICIENT_BALANCE' \| 'BALANCE_READ_FAILED' \| 'SIGNING_FAILED' \| 'VERIFY_FAILED' \| 'SETTLE_FAILED' \| 'NETWORK_ERROR' \| 'CONFIG_MISSING'`. **`CHAIN_NOT_SUPPORTED` YA EXISTE** — no agregar nada. (`NETWORK_ERROR`/`CONFIG_MISSING` quedan sin uso tras el refactor; se PUEDEN conservar en la union — no es bloqueante.) | `src/lib/downstream-payment.ts:82-96` |
| `parseUnits` (viem) | `parseUnits(value: string, decimals: number): bigint`. **El value DEBE ser dimensional por chain: `parseUnits(String(agent.priceUsdc), adapter.supportedTokens[0].decimals)`.** NUNCA `parseUnits(x, 6)` fijo. | `viem` (ya importado en `downstream-payment.ts:15`) |
| `validatePayTo` (conservar tal cual) | `validatePayTo(contract: string): {ok: true; addr: \`0x${string}\`} \| {ok: false; code: 'INVALID_PAY_TO_FORMAT' \| 'ZERO_PAY_TO'}` | `src/lib/downstream-payment.ts:198-210` |

### Confirmaciones críticas de comportamiento

1. **`DownstreamLogger` NO tiene `.error`** → DT-4: el fail-loud usa
   `logger.warn(obj, msg)` con el objeto estructurado que incluye `code:
   'CHAIN_NOT_SUPPORTED'`. Llamar `logger.error(...)` rompería en runtime (TypeError).
2. **`SettleResult` NO expone `blockNumber`** → DT-1 opción C: `blockNumber` pasa a
   opcional y se OMITE cuando el adapter no lo provee. `settledAmount = value.toString()`.
3. **`adapter.verify` PUEDE lanzar** (Kite pieverse mode) → try/catch obligatorio
   alrededor del verify, mapeado a `VERIFY_FAILED`.
4. **`getPaymentAdapter` PUEDE lanzar** si la chain no está inicializada → por eso el guard
   `getAdaptersBundle(chainKey) !== undefined` va ANTES, y aun así el bloque
   sign/verify/settle va en try/catch externo defensivo (CD-7).
5. **El módulo NO lee ni fuerza `KITE_FACILITATOR_MODE`** (DT-5): confía en el adapter. El
   modo lo determina el env del proceso (requisito operacional, §Requisitos abajo).

---

## Reglas NEVER (de los Constraint Directives — INVIOLABLES)

| Regla | Origen | Detalle |
|-------|--------|---------|
| **NEVER reimplementar la firma EIP-3009 / domain inline** | CD-9 (lección WKH-105/089) | PROHIBIDO reintroducir `signTypedData` o un `domain: {name, version, chainId, verifyingContract}` construido en el módulo. La firma se delega 100% a `adapter.sign(...)`. Un domain inline mono-chain produce `INVALID_SIGNATURE` silencioso en Base Sepolia (`name="USDC"` vs `"USD Coin"`). |
| **NEVER hardcodear chain** | CD-3 / AC-6 | PROHIBIDO usar `DEFAULT_FUJI_USDC`/`DEFAULT_AVALANCHE_USDC`/`FUJI_NETWORK`/`AVALANCHE_NETWORK`/`FUJI_CHAIN_ID`/`AVALANCHE_CHAIN_ID` ni literal de address/chainId/network como fuente de verdad. Todo deriva del adapter + chain-resolver + `chainConfig.chainId`. (RPC URL por chain desde env es tolerado, NO es literal de chain.) |
| **NEVER usar decimales = 6 fijo** | CD-8 (lección WKH-67/072) | El `value` atómico se computa con `parseUnits(String(priceUsdc), adapter.supportedTokens[0].decimals)`. PROHIBIDO `USDC_DECIMALS = 6` en el cómputo del value. **Kite/PYUSD es 18-dec** — usar 6 firmaría un value 10^12× errado. |
| **NEVER modificar adapters/registry/chain-resolver/compose** | CD-11 | PROHIBIDO tocar `src/adapters/*`, `src/adapters/registry.ts`, `src/adapters/chain-resolver.ts`, `src/services/compose.ts`, `src/services/compose.test.ts`. Si el Dev cree que necesita extender `SettleResult` (blockNumber) → STOP y escalar (TD-WKH-112-01). |
| **NEVER romper NEVER-throws** | CD-7 (H13) | `signAndSettleDownstream` DEBE seguir devolviendo `DownstreamResult \| null`, nunca lanzar. Cada paso async que puede throw va en try/catch que retorna `null` con su skip-code. El caller (compose) NO se rompe por chain no soportada ni por adapter que lance. |
| **NEVER usar `any` / `as unknown`** | CD-5 (TS strict) | El `ChainKey` resuelto se tipa `ChainKey` (de `../adapters/types.js`), NO `string`. |
| **NEVER romper el path Avalanche** | CD-1 / AC-2 | El path `chain === 'avalanche'`/`'avalanche-fuji'` debe quedar funcionalmente idéntico (facilitator, USDC Fuji, `eip155:43113`, skip-codes, NEVER-throws). La pre-flight balance check del path Avalanche se conserva byte-equivalente (DT-3). Única desviación aceptada: `blockNumber` deja de poblarse. |
| **NEVER caer al default ni cross-chain** | CD-4 | Chain no soportada/no inicializada → skip `CHAIN_NOT_SUPPORTED` + log con `getInitializedChainKeys()`. PROHIBIDO fallback a Avalanche. |
| **NEVER resolver la chain más de una vez con fuentes distintas** | CD-6 | El `chainKey` se resuelve UNA vez (paso 4) y se reusa para adapter, sign, verify, settle. |
| **NEVER agregar dependencias nuevas ni ethers.js** | CD-2 | Solo viem v2 (vía adapter o public client efímero). |

---

## Files to Modify/Create

| # | Archivo | Acción | Qué hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `src/lib/downstream-payment.ts` | Modificar (refactor mayor, neto NEGATIVO en líneas) | Convertir en thin orchestrator del adapter (ver Waves W1-W2). Borrar helpers legacy inline. Resolver `ChainKey`, delegar sign/verify/settle al adapter, conservar validaciones + balance check chain-aware + NEVER-throws. | `src/middleware/x402.ts` (WKH-111) + adapters base/kite/avalanche |
| 2 | `src/lib/downstream-payment.test.ts` | Reescribir estrategia de mock | Pasar de mock-viem-directo a **mock-registry**. Tests de selección Base/Avalanche/Kite, regresión Avalanche, fail-loud `CHAIN_NOT_SUPPORTED`, guard dimensional Kite-18. Conservar todos los skip-codes legacy. | `src/middleware/x402.chain-aware.test.ts:25-92` (mock-registry per-chain) + `src/services/compose.test.ts:24-28` |
| 3 | `src/lib/downstream-payment.mainnet.test.ts` | **BORRAR (retirar)** | El concepto `WASIAI_DOWNSTREAM_NETWORK=avalanche-mainnet` deja de existir (se borra `getDownstreamNetwork`). Mainnet es Scope OUT. Eliminar el archivo. | — |
| 4 | `src/services/compose.ts` | **NO modificar** | DT-2: la firma `signAndSettleDownstream(agent, logger)` se mantiene; la resolución de chain es interna. El mapeo `downstream.{txHash,blockNumber,settledAmount}` (`:195-199`) se preserva. | — |

---

## Exemplars (fragmentos reales del codebase)

### Exemplar 1: Resolución de ChainKey + fail-loud (WKH-111 inbound)
**Archivo**: `src/middleware/x402.ts` (patrón aprobado) + el mock test `src/middleware/x402.chain-aware.test.ts`
**Usar para**: Archivo #1 (paso 4 de resolución), Archivo #2 (tests fail-loud)
**Patrón clave** (verificado en `x402.chain-aware.test.ts:80-92`):
- `normalizeChainSlug(raw)` → `ChainKey | undefined`. Si `undefined` → CHAIN_NOT_SUPPORTED.
- `getAdaptersBundle(chainKey)` → `undefined` si no inicializada → CHAIN_NOT_SUPPORTED + log con `getInitializedChainKeys()`.
- El error code es exactamente `CHAIN_NOT_SUPPORTED` (string literal).

### Exemplar 2: Delegación sign+verify+settle al adapter
**Archivo**: `src/adapters/base/payment.ts:401-452` (sign), `:379-385` (verify/settle)
**Usar para**: Archivo #1 (pasos 9-11)
**Patrón clave**:
- `const signed = await adapter.sign({ to: payToCheck.addr, value: value.toString(), timeoutSeconds })` → `signed.paymentRequest = {authorization, signature, network}`.
- `const verifyRes = await adapter.verify({ authorization: signed.paymentRequest.authorization, signature: signed.paymentRequest.signature, network: signed.paymentRequest.network ?? adapter.getNetwork() })` → `{valid, error?}`.
- `const settleRes = await adapter.settle({ authorization: signed.paymentRequest.authorization, signature: signed.paymentRequest.signature, network: signed.paymentRequest.network ?? adapter.getNetwork() })` → `{txHash, success, error?}`.
- **El `network` del verify/settle viene del propio `signed.paymentRequest.network`** (coherencia chain, CD-6/AC-5). Como `network` es `string | undefined` en el tipo, usar `?? adapter.getNetwork()` para satisfacer TS strict (`SettleRequest.network` es `string` no opcional). Ambos resuelven a la MISMA chain.

### Exemplar 3: Mock-registry para el test reescrito
**Archivo**: `src/middleware/x402.chain-aware.test.ts:25-92`
**Usar para**: Archivo #2 (reescritura completa)
**Patrón clave** (este es el modelo a clonar para `downstream-payment.test.ts`):
```ts
// Mock por-chain del adapter (sign/verify/settle/supportedTokens/getToken/getNetwork)
const mockBaseSign = vi.fn();
const mockBaseVerify = vi.fn().mockResolvedValue({ valid: true });
const mockBaseSettle = vi.fn().mockResolvedValue({ txHash: '0xBASE', success: true });
const baseAdapter = {
  sign: (...a: unknown[]) => mockBaseSign(...a),
  verify: (...a: unknown[]) => mockBaseVerify(...a),
  settle: (...a: unknown[]) => mockBaseSettle(...a),
  supportedTokens: [{ symbol: 'USDC', address: '0x...', decimals: 6 }],
  getToken: vi.fn().mockReturnValue('0x036CbD53842c5426634e7929541eC2318f3dCF7e'),
  getNetwork: vi.fn().mockReturnValue('eip155:84532'),
};
// El mock-registry DEBE exportar getPaymentAdapter + getAdaptersBundle + getInitializedChainKeys
vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: (chainKey?: string) => mockGetPaymentAdapter(chainKey),
  getAdaptersBundle: (chainKey?: string) => { /* devuelve {chainConfig:{chainId}} o undefined */ },
  getInitializedChainKeys: () => ['avalanche-fuji', 'base-sepolia', 'kite-ozone-testnet'],
}));
// chain-resolver se deja REAL (es puro) para ejercitar el alias mapping end-to-end.
```
- El flag `WASIAI_DOWNSTREAM_X402` se lee at module-load → mantener `vi.resetModules()` + import dinámico (patrón legacy `downstream-payment.test.ts:69-76`).
- **CRÍTICO (lección WKH-111/093)**: el mock del registry DEBE exportar las 3 funciones (`getPaymentAdapter`, `getAdaptersBundle`, `getInitializedChainKeys`). Un mock incompleto devuelve `undefined` silencioso y rompe el build/los tests.

---

## Constraint Directives

### OBLIGATORIO
- Seguir el patrón mock-registry de `x402.chain-aware.test.ts` para el test reescrito.
- Imports: solo módulos que EXISTEN (ver Anti-Hallucination Checklist — paths exactos con `.js`).
- El `ChainKey` se tipa `ChainKey` (no `string`).
- El `value` se computa con `parseUnits(String(agent.priceUsdc), adapter.supportedTokens[0].decimals)`.
- El log fail-loud usa `logger.warn({ agentSlug, chain, code: 'CHAIN_NOT_SUPPORTED', initialized: getInitializedChainKeys() }, '...')`.
- Conservar el contrato NEVER-throws: cada paso async en try/catch → `null` + skip-code.

### PROHIBIDO
- NO agregar dependencias nuevas (solo viem, ya instalado).
- NO modificar `src/adapters/*`, `src/adapters/registry.ts`, `src/adapters/chain-resolver.ts`, `src/services/compose.ts`, `src/services/compose.test.ts`.
- NO reintroducir el flujo inline (`buildClients`/`signTypedData`/`postFacilitator`/`buildCanonicalBody`).
- NO hardcodear chainIds/addresses/decimales/network tags.
- NO usar `any` / `as unknown`.
- NO llamar `logger.error` (NO existe en `DownstreamLogger`).
- NO romper NEVER-throws.

---

## Mapas de referencia (cerrar sub-decisiones del SDD)

### Mapa `ChainKey → RPC env var` (DT-3, para la pre-flight balance check)

| ChainKey | RPC env var | Verificado |
|----------|-------------|------------|
| `avalanche-fuji` | `FUJI_RPC_URL` | `.env.example:375`; avalanche `payment.ts:140` |
| `avalanche-mainnet` | `AVALANCHE_RPC_URL` | `.env.example:379`; avalanche `payment.ts:139` |
| `base-sepolia` | `BASE_TESTNET_RPC_URL` | `.env.example:411`; base `payment.ts:160` |
| `base-mainnet` | `BASE_MAINNET_RPC_URL` | `.env.example:415`; base `payment.ts:159` |
| `kite-ozone-testnet` | `KITE_RPC_URL` | `.env.example:108`; kite `payment.ts:167` |
| `kite-mainnet` | `KITE_MAINNET_RPC_URL` | `.env.example:125`; kite `payment.ts:165` |

Implementación del mapa (literal local de env-var-NAMES por ChainKey — esto NO es un
hardcode de chain, son nombres de env vars; CD-3 lo tolera explícitamente):
```ts
const RPC_ENV_BY_CHAIN: Record<ChainKey, string> = {
  'avalanche-fuji': 'FUJI_RPC_URL',
  'avalanche-mainnet': 'AVALANCHE_RPC_URL',
  'base-sepolia': 'BASE_TESTNET_RPC_URL',
  'base-mainnet': 'BASE_MAINNET_RPC_URL',
  'kite-ozone-testnet': 'KITE_RPC_URL',
  'kite-mainnet': 'KITE_MAINNET_RPC_URL',
};
```
Solo las 3 testnets se usan en esta HU (mainnet es Scope OUT), pero el `Record<ChainKey,
string>` debe cubrir las 6 keys para satisfacer TS strict.

### Balance check chain-aware (DT-3) — forma concreta
- `const chainId = getAdaptersBundle(chainKey)!.chainConfig.chainId;` (el `!` es seguro:
  el paso 4 ya validó `!== undefined`). Para evitar el `!` y TS strict, reusar la variable
  `bundle` capturada en el paso 4.
- `const rpc = process.env[RPC_ENV_BY_CHAIN[chainKey]];`
- Si `!rpc` → **fail-soft**: NO skip; `logger.info({ agentSlug, chain: chainKey, code:
  'BALANCE_PRECHECK_SKIPPED' }, '[Downstream] balance pre-check skipped (no RPC for
  <chain>)')` y continuar al sign (se delega al facilitator). El path Avalanche SIEMPRE
  tiene `FUJI_RPC_URL` en CI/prod, así que conserva su check (CD-1).
  > NOTA: `BALANCE_PRECHECK_SKIPPED` no es un `DownstreamSkipCode` (no retorna null); es
  > solo un `code` en el log info. NO agregarlo a la union de skip-codes.
- Si `rpc` presente: construir public client efímero viem con `defineChain`/objeto chain
  mínimo o `createPublicClient({ chain: { id: chainId, ... }, transport: http(rpc) })`,
  leer `balanceOf(operator)` del token `adapter.getToken()`. **NO usar `viem/chains`
  `avalanche`/`avalancheFuji` importados (eso es mono-chain hardcode)** — el chain object
  se deriva del `chainId` del bundle. La address del operator se obtiene de
  `OPERATOR_PRIVATE_KEY` vía `privateKeyToAccount` (ya importado).
  - `balance < value` → skip `INSUFFICIENT_BALANCE`.
  - lectura RPC lanza → skip `BALANCE_READ_FAILED`.
- viem helpers necesarios (todos ya importados o disponibles en viem): `createPublicClient`,
  `http`, `erc20Abi`, `parseUnits`, `privateKeyToAccount` (`viem/accounts`). **`defineChain`
  de viem** puede importarse si se necesita el chain object; alternativamente
  `createPublicClient({ chain: undefined, transport: http(rpc) })` funciona para
  `readContract` (viem permite chain undefined en read-only). El Dev elige; lo crítico es
  NO reintroducir `avalanche`/`avalancheFuji` de `viem/chains`.

### Shape EXACTO del nuevo `DownstreamResult` (DT-1 opción C)
```ts
export interface DownstreamResult {
  txHash: `0x${string}`;
  blockNumber?: number; // opcional — el adapter SettleResult no lo expone (TD-WKH-112-01)
  settledAmount: string; // atomic units; = value.toString()
}
```
Construcción en el éxito (paso 12):
```ts
return {
  txHash: settleRes.txHash as `0x${string}`,
  settledAmount: value.toString(),
  // blockNumber se OMITE: SettleResult no lo provee. Spread condicional defensivo
  // por si una versión futura del adapter lo expone:
  ...(typeof (settleRes as { blockNumber?: number }).blockNumber === 'number'
    ? { blockNumber: (settleRes as { blockNumber?: number }).blockNumber }
    : {}),
};
```
> NOTA: `settleRes` es `SettleResult` que NO tiene `blockNumber` en el tipo. El spread
> condicional con el narrow `as { blockNumber?: number }` está PERMITIDO solo aquí (no es
> `as unknown`; es un narrow de campo opcional para forward-compat). Si el Dev prefiere,
> puede simplemente devolver `{ txHash, settledAmount }` sin el spread — es equivalente
> hoy (el adapter nunca trae blockNumber). **La forma más simple y CD-5-limpia: omitir
> blockNumber del return.** El spread es opcional.

---

## Helpers legacy a BORRAR de `downstream-payment.ts` (W2.5 — listado EXACTO)

> El Dev BORRA estos símbolos completos (función + tipo + constantes asociadas). Tras el
> borrado, limpiar los imports de viem/viem-chains que queden sin uso.

| # | Símbolo a borrar | Línea actual | Por qué |
|---|------------------|--------------|---------|
| 1 | `type DownstreamNetwork` + `getDownstreamNetwork()` | `:38-44` | La chain ya no se selecciona por env `WASIAI_DOWNSTREAM_NETWORK`. Esto retira `.mainnet.test.ts`. |
| 2 | `getUsdcAddress()` | `:145-172` | La address viene de `adapter.getToken()`. |
| 3 | `getUsdcEip712Version()` | `:174-185` | El domain lo encapsula el adapter. |
| 4 | `buildClients()` | `:255-305` | La firma la hace el adapter. La balance check usa public client efímero chain-aware (DT-3). |
| 5 | `buildCanonicalBody()` | `:311-331` | El adapter construye el body canónico. |
| 6 | `postFacilitator()` + `FacilitatorOk`/`FacilitatorErr`/`FacilitatorResponse` + `FACILITATOR_TIMEOUT_MS` | `:343-390` | verify/settle los hace el adapter. |
| 7 | `getFacilitatorUrl()` | `:187-192` | El adapter gestiona el facilitator URL. |
| 8 | `TRANSFER_WITH_AUTHORIZATION_TYPES` | `:393-402` | El adapter tiene su `EIP3009_TYPES`. |
| 9 | `readOperatorBalance()` (firma actual mono-chain) | `:237-249` | Se reescribe inline dentro del nuevo balance check chain-aware (o se conserva pero recibiendo el public client efímero — a criterio del Dev; lo que NO sobrevive es `buildClients`). |
| 10 | `computeAtomicValue()` con `USDC_DECIMALS` | `:216-218` | Se ADAPTA: pasa a recibir `decimals` del adapter, o se inlinea `parseUnits(String(priceUsdc), adapter.supportedTokens[0].decimals)`. |

**Constantes de chain a borrar** (`:49-67`): `DEFAULT_FUJI_USDC`, `DEFAULT_AVALANCHE_USDC`,
`FUJI_CHAIN_ID`, `AVALANCHE_CHAIN_ID`, `FUJI_NETWORK`, `AVALANCHE_NETWORK`, `USDC_DECIMALS`,
`USDC_EIP712_NAME`, `USDC_EIP712_VERSION_DEFAULT`, `VALID_BEFORE_SECONDS`, `X402_SCHEME`,
`MAX_TIMEOUT_SECONDS`, `warnedDefaultUsdc`.

**Wire-types a borrar** (`:98-132`): `X402Authorization`, `X402CanonicalBody`,
`X402VerifyResponse`, `X402SettleResponse`. (El adapter define sus propios shapes.)

**Imports viem a limpiar** (`:8-19`): tras el borrado, quedan SIN uso (revisar y eliminar):
`createWalletClient`, `WalletClient`, `Hex`, `avalanche`, `avalancheFuji` (de
`viem/chains`). **CONSERVAR** lo que la balance check chain-aware sí usa:
`createPublicClient`, `PublicClient`, `http`, `erc20Abi`, `parseUnits` (de `viem`) y
`privateKeyToAccount` (de `viem/accounts`). `randomBytes` de `node:crypto` ya NO se usa (la
nonce la genera el adapter) → BORRAR.

**Conservar** (responsabilidad del orquestador):
- `signAndSettleDownstream` export + firma `(agent, logger)` (DT-2).
- `DownstreamResult` (modificado: blockNumber opcional) + `DownstreamSkipCode`.
- `validatePayTo()` (`:198-210`) — sin cambio.
- `priceUsdc` guard (`:497-507`) — sin cambio.
- contrato NEVER-throws + skip-codes + logging estructurado.
- `DOWNSTREAM_FLAG` (read-once at module load, `:70`).
- `export type { DownstreamLogger }` re-export (compat con compose).
- balance check (reescrita chain-aware, DT-3).

---

## Tests legacy → nueva estrategia (mapeo 1-a-1, para NO perder cobertura)

> El archivo `downstream-payment.test.ts` se REESCRIBE entero a mock-registry. Cada test
> legacy DEBE tener un equivalente. `downstream-payment.mainnet.test.ts` se BORRA.

| # | Test legacy (`downstream-payment.test.ts`) | Línea | Equivalente nuevo (mock-registry) | skip-code/AC |
|---|--------------------------------------------|-------|-----------------------------------|--------------|
| 1 | flag off → null sin tocar nada | `:92-107` | **T-SkipFlagOff**: flag off → null, `getPaymentAdapter` NO llamado | FLAG_OFF / CD-7 |
| 2 | `agent.payment` undefined → null | `:112-122` | **T-SkipNoPayment**: payment undefined → null + `NO_PAYMENT_FIELD`, adapter NO llamado | NO_PAYMENT_FIELD |
| 3 | method ≠ x402 → null | `:124-136` | **T-SkipMethod**: method `'blockchain-direct'` → null + `METHOD_NOT_SUPPORTED` | METHOD_NOT_SUPPORTED |
| 4 | chain ≠ avalanche → null | `:138-146` | **REEMPLAZADO por T-AC4a/T-AC4b**: ahora chain ≠ soportada/inicializada → `CHAIN_NOT_SUPPORTED`. (El comportamiento "chain distinta" cambió: ahora Base/Kite SÍ settlean.) | CHAIN_NOT_SUPPORTED / AC-4 |
| 5 | payTo formato inválido → null | `:148-164` | **T-SkipPayToFormat**: contract `'0xZZZ'` → null + `INVALID_PAY_TO_FORMAT` | INVALID_PAY_TO_FORMAT |
| 6 | payTo zero-address → null | `:166-182` | **T-SkipZeroPayTo**: contract zero → null + `ZERO_PAY_TO` | ZERO_PAY_TO |
| 7 | balance < value → null | `:184-195` | **T-Balance-Insufficient**: mock RPC balance 0 → null + `INSUFFICIENT_BALANCE`, sign NO llamado | INSUFFICIENT_BALANCE / CD-1 |
| 8 | balance read RPC falla → null | `:197-207` | **T-Balance-ReadFail**: mock RPC throw → null + `BALANCE_READ_FAILED` | BALANCE_READ_FAILED / CD-1 |
| 9 | signTypedData throws → null | `:209-220` | **T-SkipSigningFailed**: mock `adapter.sign` reject → null + `SIGNING_FAILED` | SIGNING_FAILED / CD-7 |
| 10 | /verify verified=false → null | `:222-236` | **T-SkipVerifyFailed-false**: mock `adapter.verify` → `{valid:false}` → null + `VERIFY_FAILED` (con `verifyRes.error` en log) | VERIFY_FAILED / CD-7 |
| 10b | (nuevo) verify throws → null | — | **T-SkipVerifyFailed-throw**: mock `adapter.verify` reject (Kite pieverse puede throw) → null + `VERIFY_FAILED` | VERIFY_FAILED / CD-7 |
| 11 | /settle 500 → null | `:238-254` | **T-SkipSettleFailed-false**: mock `adapter.settle` → `{success:false, error}` → null + `SETTLE_FAILED` (con `settleRes.error` en log) | SETTLE_FAILED / CD-7 |
| 11b | (nuevo) settle throws → null | — | **T-SkipSettleFailed-throw**: mock `adapter.settle` reject → null + `SETTLE_FAILED` | SETTLE_FAILED / CD-7 |
| 12 | facilitatorErrorBody en 5xx | `:257-278` | **OBSOLETO**: el body raw del facilitator ahora lo gestiona el adapter. Equivalente reducido: el log de `SETTLE_FAILED` incluye `settleRes.error` (string del adapter). No se exige `facilitatorStatus`/`facilitatorErrorBody`. | (cobertura vía T-SkipSettleFailed-false) |
| 13 | facilitatorBody en settled=false | `:282-308` | **OBSOLETO** (mismo motivo que #12). | (cubierto por #11) |
| 14 | happy path → DownstreamResult `{txHash:'0xTX', blockNumber:12345, settledAmount:'500000'}` | `:310-335` | **T-AC1** (Base) y **T-AC2a** (Avalanche): afirma `result.txHash`, `result.settledAmount==='500000'`. **NO afirmar `blockNumber`** (ahora opcional/ausente — DT-1). | AC-1, AC-2 |
| 15 | EIP-712 domain USDC Fuji (`name:'USD Coin', chainId:43113, ...`) | `:337-374` | **OBSOLETO**: la firma se delega al adapter; el módulo ya NO arma el domain. **Reemplazado por T-AC5/T-AC6**: afirma que `getPaymentAdapter` se invocó con el chainKey correcto y que el `to`/`value` pasados a `adapter.sign` provienen del input/adapter (no de literales). | AC-5, AC-6, CD-9 |
| 16 | priceUsdc inválido (NaN/Inf/-Inf/0/-1) → INVALID_PRICE | `:377-395` | **T-SkipInvalidPrice** (`it.each` conservado): mismos 5 casos → null + `INVALID_PRICE`, adapter NO llamado | INVALID_PRICE |
| 17 | value 6-dec (500000n, no 18-dec) | `:397-423` | **T-AC2a** (Avax 6-dec) verifica `adapter.sign` recibió `value:'500000'`. **+ T-AC3 (NUEVO, Kite 18-dec)**: verifica `value:'500000000000000000'` (parseUnits('0.5',18)) — **guard dimensional WKH-67/072** | AC-2, **AC-3/CD-8** |

### Tests NUEVOS adicionales (sin equivalente legacy directo)

| Test | AC | Qué prueba |
|------|----|-----------| 
| **T-AC1** | AC-1 | Agent `chain:'base-sepolia'`. Mock adapter Base (`decimals:6`, `sign→{paymentRequest:{...,network:'eip155:84532'}}`, `settle→{txHash:'0xBASE',success:true}`). Afirma `result.txHash==='0xBASE'`, `settledAmount==='500000'`, `getPaymentAdapter` invocado con `'base-sepolia'`. |
| **T-AC2a** | AC-2/CD-1 | Agent `chain:'avalanche'` → resuelve `'avalanche-fuji'`. Mock adapter Fuji `decimals:6`. Afirma `adapter.sign` recibió `value:'500000'`, txHash preservado, NO throw. |
| **T-AC2b** | AC-2/CD-1 | Agent `chain:'avalanche-fuji'`. Mismo adapter Fuji. Comportamiento idéntico a T-AC2a. |
| **T-AC3** | AC-3/CD-8 | Agent `chain:'kite-ozone-testnet'`. Mock adapter Kite `supportedTokens:[{decimals:18}]`, `sign→{paymentRequest:{...,network:'eip155:2368'}}`. **Afirma `adapter.sign` recibió `value:'500000000000000000'` (NO `'500000'`)** + txHash `'0xKITE'`. **Guard dimensional Kite-18.** |
| **T-AC4a** | AC-4/CD-4 | Agent `chain:'solana'`. `normalizeChainSlug→undefined`. Afirma null + `logger.warn` con `code:'CHAIN_NOT_SUPPORTED'`, `adapter.sign` NO llamado. |
| **T-AC4b** | AC-4/CD-4 | Agent `chain:'base-sepolia'` con mock `getAdaptersBundle→undefined`. Afirma null + `code:'CHAIN_NOT_SUPPORTED'` + log con `initialized: [...]` (de `getInitializedChainKeys()`). NO fallback Avalanche. |
| **T-AC5** | AC-5/CD-6 | Agent `chain:'base-sepolia'`. Afirma que `getPaymentAdapter` se invocó SIEMPRE con `'base-sepolia'` (nunca con default ni otra chain) y que el `network` del settle == el de `signed.paymentRequest`. |
| **T-AC6** | AC-6/CD-3 | Afirma que el `to`/`value` del `sign` y el `network` del settle provienen del adapter/input mockeado, no de literales `FUJI_NETWORK`/`DEFAULT_FUJI_USDC` (que ya no existen). |
| **T-Balance-NoRpc** | DT-3/CD-1 | Chain resuelta sin RPC env → fail-soft: NO skip, continúa al sign, log info `BALANCE_PRECHECK_SKIPPED`. |

---

## Waves

### Wave -1: Environment Gate (verificar ANTES de tocar código)

```bash
cd /home/ferdev/.openclaw/workspace/wasiai-a2a
# Dependencias
npm install 2>/dev/null || echo "Sin package.json"
# Archivos base del Scope IN existen
ls src/lib/downstream-payment.ts src/lib/downstream-payment.test.ts \
   src/lib/downstream-payment.mainnet.test.ts \
   src/adapters/registry.ts src/adapters/chain-resolver.ts src/adapters/types.ts \
   2>/dev/null || echo "FALTA archivo base"
# Símbolos clave existen
grep -q "export function normalizeChainSlug" src/adapters/chain-resolver.ts && echo "OK normalizeChainSlug"
grep -q "export function getAdaptersBundle" src/adapters/registry.ts && echo "OK getAdaptersBundle"
grep -q "export function getInitializedChainKeys" src/adapters/registry.ts && echo "OK getInitializedChainKeys"
grep -q "warn:" src/types/index.ts && echo "OK DownstreamLogger (warn/info)"
```
**Si algo falla → PARAR y reportar al orquestador.**

### Wave 0 (Serial Gate — baseline ANTES de tocar nada)
- [ ] **W0.1**: `npm test` baseline — registrar el número exacto de tests verdes (CD-1 línea base, esperado ~1048).
- [ ] **W0.2**: `/home/ferdev/.nvm/versions/node/v22.22.0/bin/npx tsc -p tsconfig.build.json --noEmit` baseline limpio (typecheck autoritativo — **NO** el `tsc` pelado; lección WKH-111/093).
- [ ] **W0.3**: Confirmar que las 3 testnets resuelven y exponen el primitivo (manualmente o vía test existente): `getPaymentAdapter('base-sepolia').supportedTokens[0].decimals === 6` y `getPaymentAdapter('kite-ozone-testnet').supportedTokens[0].decimals === 18`. (Si no hay forma rápida sin entorno completo, basta confirmar con Read que las firmas existen — ya verificado en este Story File.)

### Wave 1 (Resolución de chain + fail-loud)
- [ ] **W1.1**: En `downstream-payment.ts`, agregar los imports nuevos (ver Anti-Hallucination Checklist). → Archivo #1.
- [ ] **W1.2**: Reemplazar el guard `if (agent.payment.chain !== 'avalanche')` (`:457-467`) por:
  ```ts
  const chainKey = normalizeChainSlug(agent.payment.chain);
  if (!chainKey || !getAdaptersBundle(chainKey)) {
    logger.warn(
      { agentSlug: agent.slug, chain: agent.payment.chain, code: 'CHAIN_NOT_SUPPORTED', initialized: getInitializedChainKeys() },
      `[Downstream] chain=${agent.payment.chain} not supported/initialized — skipped`,
    );
    return null;
  }
  ```
  Capturar `const bundle = getAdaptersBundle(chainKey)` UNA vez (reusar en balance check). → Archivo #1, Exemplar 1.
- [ ] **W1.3**: Tests fail-loud T-AC4a (chain no reconocida) + T-AC4b (no inicializada) en `downstream-payment.test.ts`. → Archivo #2, Exemplar 3.

### Wave 2 (Delegación sign+verify+settle al adapter + borrado legacy)
- [ ] **W2.1**: `const adapter = getPaymentAdapter(chainKey)` (CD-6). `const decimals = adapter.supportedTokens[0].decimals`; `const value = parseUnits(String(agent.priceUsdc), decimals)` (CD-8). → Archivo #1.
- [ ] **W2.2**: Pre-flight balance check chain-aware (DT-3) — ver "Balance check chain-aware" arriba. Public client efímero desde `bundle.chainConfig.chainId` + RPC env del mapa; fail-soft si no hay RPC. Conservar `INSUFFICIENT_BALANCE`/`BALANCE_READ_FAILED`. → Archivo #1.
- [ ] **W2.3**: Delegar (Exemplar 2):
  - `const signed = await adapter.sign({ to: payToCheck.addr, value: value.toString(), timeoutSeconds })` en try/catch → `SIGNING_FAILED`.
  - `const verifyRes = await adapter.verify({ authorization: signed.paymentRequest.authorization, signature: signed.paymentRequest.signature, network: signed.paymentRequest.network ?? adapter.getNetwork() })` en try/catch; si `!verifyRes.valid` → `VERIFY_FAILED`.
  - `const settleRes = await adapter.settle({ ...mismo network... })` en try/catch; si `!settleRes.success` → `SETTLE_FAILED`.
  - Todo el bloque sign/verify/settle dentro de un try/catch externo defensivo (CD-7). → Archivo #1.
- [ ] **W2.4**: Construir `DownstreamResult` (DT-1 opción C): `{ txHash: settleRes.txHash as \`0x${string}\`, settledAmount: value.toString() }` (omitir blockNumber). → Archivo #1.
- [ ] **W2.5**: BORRAR helpers legacy (ver tabla "Helpers legacy a BORRAR") + constantes de chain + wire-types + limpiar imports viem no usados (`createWalletClient`, `WalletClient`, `Hex`, `avalanche`, `avalancheFuji`, `randomBytes`). Modificar `DownstreamResult` (`blockNumber?` opcional). → Archivo #1.
- [ ] **W2.6**: Reescribir `downstream-payment.test.ts` completo a mock-registry (todos los tests del mapeo 1-a-1 + nuevos). **BORRAR `downstream-payment.mainnet.test.ts`**. → Archivos #2 y #3, Exemplar 3.
- [ ] **W2.7 (verif)**: `/home/ferdev/.nvm/versions/node/v22.22.0/bin/npx tsc -p tsconfig.build.json --noEmit` + `npm test` suite completa verde (CD-1). Luego:
  ```bash
  grep -rn "vi.mock('.*adapters/registry" src/
  ```
  Verificar que TODOS los mocks de registry exporten `getPaymentAdapter` + `getAdaptersBundle` + `getInitializedChainKeys` (lección WKH-111/093; un mock incompleto devuelve undefined silencioso). El de `compose.test.ts` (`:26-28`) NO se modifica — ya es signature-agnóstico.

### Wave 3 (Validación E2E — la corre el humano, NO el Dev)
- [ ] **W3.1**: Smoke outbound real o evidencia onchain fresh Base/Kite/Avalanche vía `/compose` (gateway con 3 testnets + facilitator + operator funded). tx hash por chain.
- [ ] **W3.2**: Confirmar tests verdes, cero regresión Avalanche (AC-2).

### Verificación Incremental

| Wave | Verificación al completar | Comando exacto |
|------|---------------------------|----------------|
| W0 | baseline verde + typecheck limpio | `npm test` + `/home/ferdev/.nvm/versions/node/v22.22.0/bin/npx tsc -p tsconfig.build.json --noEmit` |
| W1 | tests fail-loud verdes + sin regresión | `npm test` |
| W2 | typecheck + suite completa verde + grep mocks | `/home/ferdev/.nvm/versions/node/v22.22.0/bin/npx tsc -p tsconfig.build.json --noEmit && npm test` + `grep -rn "vi.mock('.*adapters/registry" src/` |
| W3 | smoke E2E (humano) | — |

> **Typecheck autoritativo**: SIEMPRE `/home/ferdev/.nvm/versions/node/v22.22.0/bin/npx tsc -p tsconfig.build.json --noEmit`. El `tsc --noEmit` pelado reporta TS6059 preexistente (falso positivo) — NO usarlo.

---

## Requisitos operacionales (documentados — NO bloquean unit tests; los mocks los simulan)

- `WASIAI_A2A_CHAINS` debe incluir las chains a las que se settlea outbound (ej. `kite-ozone-testnet,base-sepolia,avalanche-fuji`). Si no, `getAdaptersBundle` → undefined → `CHAIN_NOT_SUPPORTED`.
- `KITE_FACILITATOR_MODE=x402` para que el outbound a Kite settlee onchain válido (DT-5). El módulo NO lee este env (lo gestiona el adapter).
- `OPERATOR_PRIVATE_KEY` funded en USDC/PYUSD por chain destino.
- RPC env por chain (ver mapa) para la balance check. Si falta, fail-soft.

---

## Out of Scope (NO tocar bajo ninguna circunstancia)

- `src/adapters/*` (incluido `registry.ts`, `chain-resolver.ts`, `types.ts`, todos los `payment.ts`).
- `src/services/compose.ts` y `src/services/compose.test.ts` (DT-2 — la firma del export NO cambia).
- Inbound (`x402.ts`, `a2a-key.ts`) — WKH-111 DONE.
- Mainnet de cualquier chain (avalanche-mainnet, base-mainnet, kite-mainnet).
- Modelo a2a-key/budget/debit, schema/agent-card, split payments.
- NO extender `SettleResult` con `blockNumber` (TD-WKH-112-01 — escalar si parece necesario).
- NO "mejorar" código adyacente ni agregar funcionalidad no listada.

---

## Escalation Rule

> Si algo no está en este Story File, el Dev PARA y escala al Architect. No inventar, no asumir, no improvisar.

Situaciones de escalation:
- Una firma de adapter/registry/resolver no coincide con la del Anti-Hallucination Checklist.
- El Dev cree que necesita modificar `adapters/types.ts` (`SettleResult.blockNumber`) → STOP, es TD-WKH-112-01.
- Algún test legacy no tiene equivalente claro en el mapeo 1-a-1.
- `DownstreamLogger` resulta tener `.error` (no debería — verificado que NO).
- El cambio requiere tocar un archivo fuera de la tabla "Files to Modify/Create".

---

*Story File generado por NexusAgil — F2.5 — WKH-112 (BASE-07)*
