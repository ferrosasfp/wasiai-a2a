# Story File — HU-090 / WKH-090 — Cuarto rail de pago: adapter Tempo / MPP

> **Contrato autocontenido para `nexus-dev` (F3).** No necesitás releer el SDD.
> Todo lo que se referencia acá está verificado con Read contra el código real.
> **Money-path · QUALITY · testnet-only · rail ship OFF por flag.**
> Branch: `feat/146-hu-090-tempo-mpp-rail`. NNN: 146.

---

## 1. Contexto compacto (qué se construye y por qué)

Se agrega un **cuarto rail de pago** (`tempo-testnet`) como adapter **aditivo** en
`src/adapters/tempo/`, siguiendo el patrón de fábrica de **Base**
(`createBaseAdapters`). El path EVM de MPP (Machine Payments Protocol, Stripe +
Paradigm) tiene **"x402 exact compatibility"**, así que el adapter **reusa el
contrato de tipos x402/EIP-3009 existente** (`SettleRequest`/`X402Proof`/
`VerifyResult`/`QuoteResult`) — NO se inventa un tipo de proof paralelo.

Mapeo MPP → contrato existente (**DT-1**):

| Paso MPP | Header HTTP | Mapea a (contrato existente en `types.ts`) |
|----------|-------------|--------------------------------------------|
| **Challenge** | `WWW-Authenticate` (402) | `PaymentAdapter.quote()` + `PaymentAdapter.sign()` |
| **Credential** | `Authorization` | `SettleRequest`/`X402Proof` (`authorization`+`signature`+`network`) → `settle()`/`verify()` |
| **Receipt** | `Payment-Receipt` | `AttestationAdapter.attest()` (stub v1) |

El rail se entrega **detrás de `TEMPO_ADAPTER_ENABLED` default OFF**. Con flag OFF
el comportamiento es **byte-idéntico** al estado actual: el bundle de Tempo no se
construye, ningún módulo de `src/adapters/tempo/` se importa en el hot path, y
forzar `tempo-testnet` devuelve el mismo `CHAIN_NOT_SUPPORTED` que cualquier slug
no inicializado (double-guard existente, sin código nuevo en rutas).

**Gasless v1 = stub deshabilitado** (DT-7). `AdaptersBundle.gasless` es un campo
**no-nullable**, así que Tempo provee una instancia `GaslessAdapter` que devuelve
`enabled:false` en `status()` y lanza `GaslessNotSupportedError` (501) en
`transfer()`. El relay gasless real queda diferido a **WKH-090b**.

---

## 2. Scope IN — archivos exactos a tocar

**NUEVOS (`src/adapters/tempo/`):**
- `src/adapters/tempo/chain.ts`
- `src/adapters/tempo/payment.ts`
- `src/adapters/tempo/attestation.ts`
- `src/adapters/tempo/gasless.ts`
- `src/adapters/tempo/index.ts`

**MODIFICAR (extensión mínima aditiva):**
- `src/adapters/types.ts` — `ChainKey += 'tempo-testnet'` (SOLO type)
- `src/adapters/registry.ts` — flag `isTempoEnabled` + `getSupportedChains()` + branch en `buildBundle`
- `src/adapters/chain-resolver.ts` — aliases de slug de Tempo

**TESTS (nuevos/modificados):**
- NUEVO `src/adapters/__tests__/tempo.payment.contract.test.ts`
- MODIFICAR `src/adapters/__tests__/chain-resolver.test.ts`
- MODIFICAR `src/adapters/__tests__/registry.test.ts`

**PROHIBIDO tocar cualquier otro archivo.** En particular: NO tocar
`src/adapters/base/*`, `src/adapters/avalanche/*`, `src/adapters/kite-ozone/*`,
ninguna ruta en `src/routes/*`, ni `AdaptersBundle` en `types.ts`.

---

## 3. Anti-Hallucination Checklist (específico de esta HU)

Antes de escribir cada símbolo, confirmá contra estos hechos verificados:

- [x] `ChainKey` es una unión cerrada en `types.ts` L124-130 (6 slugs actuales:
  `kite-ozone-testnet`, `kite-mainnet`, `avalanche-fuji`, `avalanche-mainnet`,
  `base-sepolia`, `base-mainnet`). Extender = agregar `| 'tempo-testnet'`.
- [x] `AdaptersBundle` (types.ts L137-147): `payment`/`attestation`/`gasless` son
  **no-nullable**; `identity: IdentityBindingAdapter | null`; `chainConfig`
  = `{ name, chainId, explorerUrl }`. **NO modificar esta interface.**
- [x] `PaymentAdapter` (types.ts L80-93): `readonly name`, `readonly chainId`,
  `readonly supportedTokens: TokenSpec[]`, `settle`, `verify`, `quote`, `sign`,
  `getScheme`, `getNetwork`, `getToken`, `getMaxTimeoutSeconds`, `getMerchantName`.
- [x] `AttestationAdapter` (types.ts L94-99): `name`, `chainId`, `attest(event):
  Promise<{txHash, proofUrl}>`, `verify(ref): Promise<boolean>`.
- [x] `GaslessAdapter` (types.ts L100-105): `name`, `chainId`, `transfer(req):
  Promise<GaslessAdapterResult>`, `status(): Promise<GaslessAdapterStatus>`.
- [x] `GaslessAdapterStatus` (types.ts L60-69): `enabled`, `network`,
  `supportedToken: GaslessSupportedToken | null`, `operatorAddress: 0x... | null`,
  `funding_state: GaslessFundingState`, opcionales `chain_id`/`relayer`/`documentation`.
- [x] `GaslessFundingState` (src/types/index.ts L1013): `'disabled' | 'unconfigured'
  | 'unfunded' | 'ready'`. El stub usa `'disabled'`.
- [x] `GaslessNotSupportedError` existe en `src/adapters/errors.ts`: constructor
  `(chain: string, message: string)`, `statusCode=501`, `code='gasless_not_supported_on_chain'`.
- [x] `defineChain` se importa de `'viem'` (ver `kite-ozone/chain.ts` L1).
- [x] `parseUnits` se importa de `'viem'`; `privateKeyToAccount` de `'viem/accounts'`.
- [x] `buildRpcTransport` existe en `src/lib/rpc-transport.js` (ver base/payment.ts L5).
- [x] `getLogger` en `src/lib/logger.js`.
- [x] `X402PaymentRequest` en `src/types/index.js` (usado por base/payment.ts L6).
- [x] `registry.ts`: `SUPPORTED_CHAINS` const (L28-35), `isSupportedChain` (L41),
  `buildBundle` (L45-90), `initAdapters` (L92), `getAdaptersBundle` no-throw (L213),
  `getInitializedChainKeys` (L226).
- [x] `chain-resolver.ts`: `SLUG_ALIASES` con `Object.create(null)` (L20-53),
  `normalizeChainSlug` (L61), `resolveChainKey` (L77). **Es puro — NO lee env.**
- [x] Double-guard de `CHAIN_NOT_SUPPORTED`: (1) resolver → `undefined`; (2)
  `getAdaptersBundle(chainKey)` → `undefined` (no inicializado). Con flag OFF,
  Tempo cae en el guard (2) **sin código nuevo en rutas**.

**Si un símbolo no está en esta lista → Grep/Read antes de usarlo. NUNCA inventes.**

---

## 4. Waves (orden serial entre waves; paralelizable dentro de W1)

> Cada wave deja el repo compilando (`npm run build` / `tsc --noEmit`) y con flag
> OFF byte-idéntico. Los tests van en W3.

### W0 — Tipos y chain (serial, contratos)

**W0.1 — `src/adapters/types.ts`**: extender SOLO la unión `ChainKey`:

```ts
export type ChainKey =
  | 'kite-ozone-testnet'
  | 'kite-mainnet'
  | 'avalanche-fuji'
  | 'avalanche-mainnet'
  | 'base-sepolia'
  | 'base-mainnet'
  | 'tempo-testnet';   // WKH-090 — cuarto rail (testnet-only, CD-2 → sin mainnet)
```

NO tocar `AdaptersBundle` ni ningún otro tipo. NO agregar `'tempo-mainnet'` (**CD-2**).

**W0.2 — `src/adapters/tempo/chain.ts`** (mirror de `kite-ozone/chain.ts` para el
`defineChain` custom + mirror de `base/chain.ts` para el `getTempoNetwork`
warn-once). Tempo NO está en `viem/chains`, se define custom:

```ts
import { defineChain } from 'viem';
import { getLogger } from '../../lib/logger.js';

const log = getLogger('tempo');

// [VERIFY-AT-IMPL en F3] V1 chainId, V2 RPC URL, V5 explorer.
// Placeholders documentados — el rail ship OFF; sustituir con los valores
// oficiales de tempo.xyz/developers + SDK que pase el orquestador.
const TEMPO_TESTNET_CHAIN_ID = 0 /* [VERIFY-AT-IMPL en F3: V1] */;
const TEMPO_TESTNET_RPC = 'https://rpc.testnet.tempo.xyz' /* [VERIFY-AT-IMPL en F3: V2] */;
const TEMPO_TESTNET_EXPLORER = 'https://explorer.testnet.tempo.xyz' /* [VERIFY-AT-IMPL en F3: V5] */;

export const tempoTestnet = defineChain({
  id: TEMPO_TESTNET_CHAIN_ID,
  name: 'Tempo Testnet',
  nativeCurrency: { decimals: 18, name: 'Tempo', symbol: 'TEMPO' /* [VERIFY-AT-IMPL] confirmar símbolo nativo */ },
  rpcUrls: {
    default: { http: [TEMPO_TESTNET_RPC] },
    public: { http: [TEMPO_TESTNET_RPC] },
  },
  blockExplorers: {
    default: { name: 'Tempo Explorer', url: TEMPO_TESTNET_EXPLORER },
  },
  testnet: true,
});

// tempo-mainnet reservado (CD-2) — NO definir en v1.

export type TempoNetwork = 'testnet';

let _warnedTempoNetwork = false;
export function getTempoNetwork(opts?: { network?: TempoNetwork }): TempoNetwork {
  if (opts?.network) return opts.network;
  const env = process.env.TEMPO_NETWORK;
  if (env !== undefined && env !== '' && env !== 'testnet' && !_warnedTempoNetwork) {
    _warnedTempoNetwork = true;
    log.warn({ env }, "TEMPO_NETWORK is not 'testnet' — defaulting to 'testnet'");
  }
  return 'testnet';
}

export function getTempoChain(_network: TempoNetwork) {
  return tempoTestnet;
}

/** TEST-ONLY — reset warn-once flag. */
export function _resetTempoChain(): void {
  _warnedTempoNetwork = false;
}
```

*Invariante W0*: nada importa `src/adapters/tempo/*` todavía → byte-idéntico.
El chainId placeholder `0` compila; el rail ship OFF, no se instancia.

### W1 — Módulos del adapter (paralelizable dentro de la wave)

**W1.1 — `src/adapters/tempo/payment.ts`** (**mirror restringido de
`base/payment.ts`**). Reglas exactas:
- `class TempoPaymentAdapter implements PaymentAdapter`, `readonly name = 'tempo'`.
- Firma EIP-3009 `TransferWithAuthorization` contra `pathUSD` (mismo bloque
  `EIP3009_TYPES` que base/payment.ts L85-94).
- `quote(amountUsd)`: usar `parseUnits(amountUsd.toFixed(decimals), decimals)`
  (**money-path MNR-1** — NO hardcodear `'1000000'`; honrar el USD real).
- POST canónico x402 v2 al facilitator (`buildX402CanonicalBody` mirror de
  base/payment.ts L254-276): `{ x402Version: 2, resource, accepted:{ scheme:'exact',
  network:'eip155:<chainId>', amount, asset, payTo, maxTimeoutSeconds, extra:{
  assetTransferMethod:'eip3009' } }, payload:{ signature, authorization } }`.
- `settle()` → POST `/settle`; `verify()` → POST `/verify`. Header
  `Authorization: Bearer <key>` SOLO si hay `FACILITATOR_API_KEY` (degradación
  segura sin key — igual que base). Timeout `AbortSignal.timeout(10_000)`.
- `getNetwork()` → `'eip155:<tempoChainId>'`. `getScheme()` → `'exact'`.
- Constantes `pathUSD` (address / decimales / EIP-712 `name` / `version`), RPC y
  chainId = **[VERIFY-AT-IMPL en F3]** con env override + fallback + warn-once
  (mirror `getUsdcAddress` de base/payment.ts L109-156). Placeholders:

```ts
const TEMPO_SCHEME = 'exact' as const;
const TEMPO_CHAIN_ID = 0 /* [VERIFY-AT-IMPL en F3: V1] */;
const TEMPO_NETWORK_TAG = `eip155:${TEMPO_CHAIN_ID}` as const;
const TEMPO_MAX_TIMEOUT_SECONDS = 60 as const;

// [VERIFY-AT-IMPL en F3: V3] dirección + decimales de pathUSD (probable 6, mirror USDC).
const DEFAULT_PATHUSD_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`;
const PATHUSD_DECIMALS = 6 as const;              // [VERIFY-AT-IMPL en F3: V3]
// [VERIFY-AT-IMPL en F3: V4] EIP-712 domain name/version del contrato pathUSD.
const PATHUSD_EIP712_NAME = 'pathUSD' as const;   // [VERIFY-AT-IMPL en F3: V4]
const PATHUSD_EIP712_VERSION = '1' as const;      // [VERIFY-AT-IMPL en F3: V4]
const PATHUSD_SYMBOL = 'pathUSD' as const;
```

- Env override para la address: `process.env.TEMPO_PATHUSD_ADDRESS` con
  `ADDRESS_RE` (`/^0x[0-9a-fA-F]{40}$/`) + warn-once vía `getLogger('tempo')`.
- RPC: `process.env.TEMPO_TESTNET_RPC_URL` + `buildRpcTransport({ primary,
  fallbackEnv:'TEMPO_TESTNET_RPC_URL_FALLBACK', chainId })`.
- Facilitator URL: reusar el fallback chain de base
  (`TEMPO_FACILITATOR_URL ?? WASIAI_FACILITATOR_URL ?? WASIAI_FACILITATOR_DEFAULT_URL`).
- **CD-8 (viem type-safety)**: al firmar, si usás `client.account`, pasá `?? null`
  donde el tipo lo exija (nunca `!`, prohibido por biome). El wallet client
  module-level cachéalo como `ReturnType<typeof createWalletClient> | null`; si
  cachearas un `PublicClient` de Tempo en variable genérica, castear la chain
  `as Chain`. (En el mirror de sign() de base esto se resuelve con
  `if (!client.account) throw ...` — replicá ese guard.)
- Comentarios de mapeo (DT-1): `// Challenge → quote()/sign()`,
  `// Credential → settle()/verify() (X402Proof.authorization+signature+network)`.
- Exportá `_resetWalletClient()` TEST-ONLY (mirror base/payment.ts L511).

**W1.2 — `src/adapters/tempo/attestation.ts`** (mirror exacto de
`base/attestation.ts`):

```ts
import { getLogger } from '../../lib/logger.js';
import type { AttestationAdapter, AttestEvent, AttestRef } from '../types.js';

const log = getLogger('tempo');

/** Tempo attestation stub — registra el "Receipt" de MPP (mapping DT-1).
 *  Impl real (ERC-8004 / EAS) fuera de v1. */
export class TempoAttestationAdapter implements AttestationAdapter {
  readonly name = 'tempo';
  readonly chainId: number;
  constructor(chainId: number) { this.chainId = chainId; }

  async attest(_event: AttestEvent): Promise<{ txHash: string; proofUrl: string }> {
    log.warn('attestation stub — MPP Receipt not persisted on-chain in v1');
    return { txHash: '0x0', proofUrl: '' };
  }
  async verify(_ref: AttestRef): Promise<boolean> { return true; }
}
```

**W1.3 — `src/adapters/tempo/gasless.ts`** (**stub deshabilitado**, DT-7 — NO
relay real). Debe implementar `GaslessAdapter` completo:

```ts
import type {
  GaslessAdapter,
  GaslessAdapterResult,
  GaslessAdapterStatus,
  GaslessTransferAdapterRequest,
} from '../types.js';
import { GaslessNotSupportedError } from '../errors.js';

/** Tempo gasless v1 = STUB deshabilitado (DT-7). El relay EIP-3009 real
 *  (transferWithAuthorization de TIP-20/pathUSD) queda diferido a WKH-090b:
 *  el soporte gasless de TIP-20 NO está confirmado on-chain [VERIFY-AT-IMPL V8]. */
export class TempoGaslessAdapter implements GaslessAdapter {
  readonly name = 'tempo';
  readonly chainId: number;
  constructor(chainId: number) { this.chainId = chainId; }

  async transfer(_req: GaslessTransferAdapterRequest): Promise<GaslessAdapterResult> {
    throw new GaslessNotSupportedError(
      'tempo-testnet',
      'Gasless relay not supported on Tempo testnet in v1 (deferred to WKH-090b)',
    );
  }

  async status(): Promise<GaslessAdapterStatus> {
    return {
      enabled: false,
      network: 'tempo-testnet',
      supportedToken: null,
      operatorAddress: null,
      funding_state: 'disabled',
      chain_id: this.chainId,
    };
  }
}
```

> **CD crítica**: `gasless` NO puede ser `null` — el bundle lo exige no-nullable.
> Devolvé SIEMPRE una instancia `TempoGaslessAdapter`.

**W1.4 — `src/adapters/tempo/index.ts`** (mirror de `base/index.ts`, **patrón
Base — SIN mutación de `process.env`**, DT-2):

```ts
import type { AdaptersBundle } from '../types.js';
import { getTempoChain, getTempoNetwork, type TempoNetwork } from './chain.js';

export async function createTempoAdapters(opts?: {
  network?: TempoNetwork;
}): Promise<AdaptersBundle> {
  const network = getTempoNetwork(opts);
  const { TempoPaymentAdapter } = await import('./payment.js');
  const { TempoAttestationAdapter } = await import('./attestation.js');
  const { TempoGaslessAdapter } = await import('./gasless.js');

  const chain = getTempoChain(network);
  const chainId = chain.id;
  const explorerUrl =
    chain.blockExplorers?.default.url ??
    'https://explorer.testnet.tempo.xyz'; // [VERIFY-AT-IMPL en F3: V5]

  return {
    payment: new TempoPaymentAdapter({ network }),
    attestation: new TempoAttestationAdapter(chainId),
    gasless: new TempoGaslessAdapter(chainId),
    identity: null,
    chainConfig: { name: 'Tempo Testnet', chainId, explorerUrl },
  };
}
```

> **PROHIBIDO** copiar el anti-patrón de `kite-ozone/index.ts` (muta
> `process.env.KITE_NETWORK`, deuda `TD-NEW-KITE-PARAMS`). Tempo pasa `network`
> explícito por `opts` — patrón Base.

### W2 — Wiring registry + resolver (serial, gate del flag en UN choke-point)

**W2.1 — `src/adapters/registry.ts`**:

1. Agregar helper del flag (default OFF, convención `=== 'true'`):
   ```ts
   function isTempoEnabled(): boolean {
     return process.env.TEMPO_ADAPTER_ENABLED === 'true';
   }
   ```
2. Reemplazar el uso directo de `SUPPORTED_CHAINS` por un set **flag-aware**.
   Mantené la const `SUPPORTED_CHAINS` con los 6 slugs actuales; agregá:
   ```ts
   function getSupportedChains(): readonly ChainKey[] {
     return isTempoEnabled()
       ? [...SUPPORTED_CHAINS, 'tempo-testnet']
       : SUPPORTED_CHAINS;
   }
   ```
   `isSupportedChain` pasa a usar `getSupportedChains()`:
   ```ts
   function isSupportedChain(slug: string): slug is ChainKey {
     return (getSupportedChains() as readonly string[]).includes(slug);
   }
   ```
   Y los mensajes de error de `initAdapters` que hoy hacen
   `SUPPORTED_CHAINS.join(', ')` pasan a `getSupportedChains().join(', ')`.
3. Branch en `buildBundle` (mirror de los branches base):
   ```ts
   if (chainKey === 'tempo-testnet') {
     const { createTempoAdapters } = await import('./tempo/index.js');
     return createTempoAdapters({ network: 'testnet' });
   }
   ```

> **CD-6 (byte-idéntico OFF)**: con `TEMPO_ADAPTER_ENABLED` ausente/`!= 'true'`,
> `getSupportedChains()` retorna **exactamente los 6 slugs actuales**. Si el CSV
> incluye `tempo-testnet` con flag OFF → `initAdapters()` **falla-rápido en boot**
> ("Unsupported chain 'tempo-testnet'"), consistente con el trato de slugs no
> soportados. NO toques `initAdapters` más allá del swap `SUPPORTED_CHAINS` →
> `getSupportedChains()`.
> **CD-7 (choke-point único)**: el gate del flag vive SOLO acá. PROHIBIDO leer
> `TEMPO_ADAPTER_ENABLED` en el resolver, en las rutas, o en el adapter.

**W2.2 — `src/adapters/chain-resolver.ts`**: agregar a `SLUG_ALIASES`
(**estático** — el resolver es puro, NO lee el flag, **CD-7**):

```ts
    // tempo-testnet aliases (WKH-090)
    'tempo-testnet': 'tempo-testnet',
    tempo: 'tempo-testnet',
    // [VERIFY-AT-IMPL en F3: V1] alias del chainId numérico de Tempo:
    // '<tempoChainId>': 'tempo-testnet',  // agregar cuando se confirme V1
```

> Que el resolver conozca el slug NO expone el rail con flag OFF: el bundle no
> existe → `getAdaptersBundle('tempo-testnet')` es `undefined` → guard (2)
> devuelve `CHAIN_NOT_SUPPORTED`. Esto satisface AC-4 ("sin lógica especial
> hardcodeada") y AC-5 sin código nuevo en rutas.

### W3 — Tests (obligatorio, CD-5, ≥1 por AC + no-regresión)

**Todos los tests mockean `fetch`** (`vi.stubGlobal('fetch', mockFetch)`) y
`viem.createWalletClient` + `getLogger` — NO dependen de valores reales de Tempo.

**W3.1 — NUEVO `src/adapters/__tests__/tempo.payment.contract.test.ts`** (mirror
de `payment.contract.test.ts`). Setear `process.env.OPERATOR_PRIVATE_KEY` con la
misma key de test del exemplar. Cubre:
- **AC-3 (Credential→settle)**: `settle({authorization,signature,network})` con
  `mockFetch` OK → shape `{ txHash, success:true }`. Confirma que el "Credential"
  puebla `SettleRequest` sin tipo paralelo.
- **AC-3 (verify)**: `verify(proof)` → `{ valid:true }`.
- **AC-3 (Challenge→quote/sign)**: `quote(1)` honra el USD (con `PATHUSD_DECIMALS`
  placeholder — assert que `amountWei` refleja el arg, NO un hardcode);
  `quote(0.001)` ≠ `quote(1)`; `sign()` → `{ xPaymentHeader, paymentRequest }` con
  `paymentRequest.authorization`+`signature`.
- **AC-3 (Receipt→attest)**: `new TempoAttestationAdapter(chainId).attest(...)` →
  `{ txHash, proofUrl }`.
- **Gasless stub (DT-7)**: `new TempoGaslessAdapter(chainId).transfer(...)` rechaza
  con `GaslessNotSupportedError`; `.status()` → `enabled:false` /
  `funding_state:'disabled'` / `supportedToken:null` / `operatorAddress:null`.

**W3.2 — MODIFICAR `src/adapters/__tests__/chain-resolver.test.ts`**:
- **AC-4**: `normalizeChainSlug('tempo-testnet')` → `'tempo-testnet'`;
  `normalizeChainSlug('tempo')` → `'tempo-testnet'`; trim/lowercase
  (`'  TEMPO  '`) → `'tempo-testnet'`. `resolveChainKey({headerOverride:
  'tempo-testnet'})` → `'tempo-testnet'`; prioridad header>manifest.
- **CD-19**: keys de prototype (`'__proto__'`, `'constructor'`) siguen `undefined`.
- **AC-6**: assert de que el resolver NO tiene branch por costo/latencia/geografía
  (sólo traduce el slug explícito) — cubierto por la ausencia de auto-routing.

**W3.3 — MODIFICAR `src/adapters/__tests__/registry.test.ts`** (agregá un
`vi.mock('../tempo/index.js', ...)` mirror del mock de kite/base para no instanciar
el adapter real). Cubre:
- **AC-1**: con `TEMPO_ADAPTER_ENABLED='true'` y `WASIAI_A2A_CHAINS` que incluye
  `tempo-testnet` → `getInitializedChainKeys()` incluye `'tempo-testnet'`;
  `getAdaptersBundle('tempo-testnet')` retorna bundle completo
  (`payment`/`attestation`/`gasless`/`chainConfig`); los bundles kite/avalanche/
  base quedan intactos.
- **AC-2 (no-op, byte-idéntico)**: sin `TEMPO_ADAPTER_ENABLED` (default OFF), con
  el CSV de los 6 rails → `getInitializedChainKeys()` idéntico al baseline;
  `getAdaptersBundle('tempo-testnet')` → `undefined`. (Delete
  `process.env.TEMPO_ADAPTER_ENABLED` en `beforeEach`.)
- **AC-5 (flag OFF fuerza CHAIN_NOT_SUPPORTED)**: flag OFF + `tempo-testnet` en el
  CSV → `initAdapters()` lanza `/Unsupported chain 'tempo-testnet'/` (fail-fast
  boot). Y sin el slug en CSV, `getAdaptersBundle('tempo-testnet')` → `undefined`
  (choke-point del double-guard).

**W3.4 — NO-REGRESIÓN (CD-6)**: correr sin modificar `avalanche.test.ts`,
`base.test.ts`, `payment.contract.test.ts`, `payment.mainnet.test.ts`,
`kite-factory.test.ts`, `gasless.contract.test.ts` → todos verdes. `tsc --noEmit`
+ `biome` limpios.

- **AC-7**: no testeable por código — se cubre documentalmente con los marcadores
  `[VERIFY-AT-IMPL en F3]` en `chain.ts`/`payment.ts`/`chain-resolver.ts`.

---

## 5. Patrones a seguir (exemplars verificados — paths reales)

| Rol | Path (verificado con Read) | Qué copiar |
|-----|----------------------------|------------|
| Factory (patrón a copiar) | `src/adapters/base/index.ts` | `createBaseAdapters` — imports dinámicos, network explícito, sin env mutation |
| Chain custom `defineChain` | `src/adapters/kite-ozone/chain.ts` | estructura `defineChain({id,name,nativeCurrency,rpcUrls,blockExplorers,testnet})` |
| Network resolver + warn-once | `src/adapters/base/chain.ts` | `getBaseNetwork` → `getTempoNetwork` (prioridad opts>env>fallback) |
| Adapter x402 a mirrorar | `src/adapters/base/payment.ts` | `BasePaymentAdapter` — EIP-3009, `buildX402CanonicalBody`, `settleX402`/`verifyX402`, `quote` con `parseUnits(toFixed)` |
| Attestation stub | `src/adapters/base/attestation.ts` | mirror exacto |
| Gasless stub error tipado | `src/adapters/errors.ts` | `GaslessNotSupportedError(chain, msg)` |
| Anti-patrón (NO copiar) | `src/adapters/kite-ozone/index.ts` | env mutation — PROHIBIDO |
| Dispatcher + init a extender | `src/adapters/registry.ts` | branch en `buildBundle`, `getSupportedChains()` |
| Resolver a extender | `src/adapters/chain-resolver.ts` | `SLUG_ALIASES` estático |
| Contrato compartido (NO tocar salvo `ChainKey`) | `src/adapters/types.ts` | `PaymentAdapter`/`AttestationAdapter`/`GaslessAdapter`/`AdaptersBundle` |
| Test contrato patrón | `src/adapters/__tests__/payment.contract.test.ts` | mock viem+fetch+logger, asserts de shape |
| Test resolver patrón | `src/adapters/__tests__/chain-resolver.test.ts` | aliases, prioridad, CD-19 |
| Test registry patrón | `src/adapters/__tests__/registry.test.ts` | `vi.mock('../tempo/index.js', ...)`, init CSV |

---

## 6. `[VERIFY-AT-IMPL en F3]` — 8 datos diferidos (ninguno bloquea el DONE)

El orquestador te pasa los valores reales de Tempo testnet si los tiene; si no,
dejá el **placeholder + el marcador `[VERIFY-AT-IMPL en F3: VN]`** en el comentario.
El rail ship **OFF** y los tests **mockean `fetch`**, así que ninguno bloquea.

| # | Dato | Dónde | Placeholder actual |
|---|------|-------|--------------------|
| V1 | chainId numérico de Tempo testnet | `chain.ts` (`defineChain.id`), `payment.ts` (network tag), alias numérico en `chain-resolver.ts` | `0` |
| V2 | RPC URL testnet | `chain.ts` (`rpcUrls`) | `https://rpc.testnet.tempo.xyz` |
| V3 | address + decimales de `pathUSD` (probable 6) | `payment.ts` (token/EIP-3009) | `0x000...0` / `6` |
| V4 | EIP-712 domain `name`/`version` de `pathUSD` | `payment.ts` (`signTypedData.domain`) | `'pathUSD'` / `'1'` |
| V5 | Explorer URL | `index.ts` (`chainConfig.explorerUrl`) | `https://explorer.testnet.tempo.xyz` |
| V6 | Detalle headers MPP `WWW-Authenticate`/`Authorization`/`Payment-Receipt` | comentarios de mapeo en `payment.ts` | mapeo x402 asumido sin campos extra |
| V7 | Soporte del `wasiai-facilitator` para el network tag de Tempo | operativo (activación post-DONE) | N/A — tests mockean fetch |
| V8 | Soporte gasless (`transferWithAuthorization`) de TIP-20/pathUSD | diferido a WKH-090b | stub deshabilitado |

**Regla F3 (WKH-141 auto-blindaje)**: validá cada string de placeholder contra las
CDs antes de dejarlo — no rompas el formato `0x${string}` ni el network tag
`eip155:<id>`.

---

## 7. Constraint Directives (heredadas — INVIOLABLES)

- **CD-1**: `TEMPO_ADAPTER_ENABLED` default OFF en todo ambiente.
- **CD-2**: PROHIBIDO agregar `'tempo-mainnet'` a `ChainKey`/`SUPPORTED_CHAINS`/`SLUG_ALIASES`.
- **CD-3**: reusar `SettleRequest`/`X402Proof`/`VerifyResult`/`QuoteResult`.
  PROHIBIDO tipo de proof paralelo para Tempo.
- **CD-4**: Ownership Guard (`owner_ref`) — N/A (esta HU no toca DB). Si en F3
  aparece cualquier query, aplicá el guard sin excepción.
- **CD-5**: tests de contrato equivalentes a kite/avalanche/base ANTES de activar el flag.
- **CD-6 (byte-idéntico OFF)**: PROHIBIDO alterar el comportamiento de los rails
  existentes. Con flag OFF: `getSupportedChains()` = 6 slugs; ningún módulo de
  `tempo/` en el hot path; `getInitializedChainKeys()` sin `tempo-testnet`.
- **CD-7 (choke-point único)**: el gate del flag vive SOLO en `registry.ts`.
  Resolver y adapter NO leen `TEMPO_ADAPTER_ENABLED`.
- **CD-8 (viem type-safety, WKH-133/138)**: `walletClient.account` → `?? null`
  (nunca `!`). `PublicClient` module-level → castear chain `as Chain`. Aplica al
  gasless real diferido; el stub v1 no firma, así que queda latente.
- **CD-9 (sin auto-routing)**: PROHIBIDO selección de rail por costo/latencia/
  geografía (HU-091, Scope OUT). Sólo header > manifest > default del CSV.

---

## 8. Done Definition (F3 termina cuando)

- [ ] 5 archivos nuevos en `src/adapters/tempo/` creados y compilando.
- [ ] `ChainKey` extendido con `'tempo-testnet'` (SOLO type). `AdaptersBundle` intacto.
- [ ] `registry.ts`: `isTempoEnabled` + `getSupportedChains()` flag-aware + branch
  `tempo-testnet` en `buildBundle`. Sin tocar `initAdapters` salvo el swap.
- [ ] `chain-resolver.ts`: aliases `tempo-testnet`/`tempo` estáticos + TODO del alias numérico.
- [ ] `gasless` es una instancia `TempoGaslessAdapter` (NUNCA null); `transfer()`
  lanza `GaslessNotSupportedError`; `status()` → `enabled:false`.
- [ ] `createTempoAdapters` SIN mutación de `process.env` (patrón Base).
- [ ] Tests: `tempo.payment.contract.test.ts` (nuevo) + `chain-resolver.test.ts`
  + `registry.test.ts` modificados. ≥1 test por AC. Todos mockean `fetch`.
- [ ] Flag OFF byte-idéntico verificado por test de no-op (AC-2).
- [ ] `CHAIN_NOT_SUPPORTED` con flag OFF verificado (AC-5) vía double-guard, sin
  código nuevo en rutas.
- [ ] No-regresión: toda la suite existente verde. `tsc --noEmit` + `biome` limpios.
- [ ] Los 8 `[VERIFY-AT-IMPL en F3]` resueltos con valor real (si el orquestador
  lo pasó) o placeholder + marcador documentado.

---

*Architect F2.5 — HU-090 / WKH-090. NNN 146. Branch feat/146-hu-090-tempo-mpp-rail.
Contrato autocontenido para nexus-dev. Exemplars verificados con Read contra el
código real (2026-07-04).*
