# SDD #088 — WKH-104 / BASE-01: Base chain adapter (sepolia + mainnet) — USDC EIP-3009 path

> SPEC_APPROVED: YES (2026-05-19 by Claude AUTO, delegated by Fernando)
> Fecha: 2026-05-19
> Tipo: feature (chain adapter; payment path; cross-cutting registry + chain-resolver)
> SDD_MODE: full
> Sizing: QUALITY (payment path, cross-cutting `chain-resolver` + `types.ts` + `registry.ts`, no downgrade)
> Branch sugerido: `feat/wkh-base-port-v1` (compartida con WKH-105..108)
> Work item: [`work-item.md`](work-item.md)
> Pipeline: QUALITY (F0 → F1 → F2 → F2.5 → F3 → AR → CR → F4 → DONE)
> Estimación: L (24-30 h)

---

## 1. Resumen ejecutivo

Esta HU agrega soporte de **Base** (mainnet 8453 + sepolia 84532) al gateway wasiai-a2a. El objetivo es que `/compose` y `/orchestrate` puedan rutear inbound x402 USDC (EIP-3009 `TransferWithAuthorization`) sobre Base con la misma maquinaria multi-chain ya validada para Avalanche en WKH-MULTICHAIN (SDD #086). El refactor consta de **un adapter nuevo** (`src/adapters/base/`, 6 archivos), **extensión de tres archivos cross-cutting** (`types.ts`, `chain-resolver.ts`, `registry.ts`), y **dos suites de tests** (contract + chain-resolver). El patrón es 1:1 con Avalanche — el riesgo está concentrado en (a) confirmar EIP-712 domain name de USDC en Base via verificación onchain (CD-3) y (b) zero regressions en `chain-resolver` (afecta Kite + Avalanche en prod).

**Resultado esperado**: con `WASIAI_A2A_CHAINS=kite-ozone-testnet,base-sepolia` (ejemplo), `initAdapters()` inicializa ambos bundles, el header `x-payment-chain: base-sepolia` (o `84532`) resuelve al bundle Base Sepolia, el middleware `a2a-key` debita budget contra chainId `84532`, el `PaymentAdapter` Base firma EIP-3009 contra USDC Sepolia con `chainId: 84532` en el dominio EIP-712, y los 1660+ tests pre-existentes siguen pasando.

---

## 2. Work item (resumen)

| Campo | Valor |
|-------|-------|
| **#** | 088 |
| **Tipo** | feature (chain adapter; payment path) |
| **SDD_MODE** | full |
| **Objetivo** | Adapter Base (sepolia 84532 + mainnet 8453) usando USDC + EIP-3009 + facilitator placeholder. Habilita inbound x402 sobre Base en wasiai-a2a. |
| **Scope IN** | 13 artefactos (ver work-item §Scope IN): 6 archivos nuevos en `src/adapters/base/`, 3 modificados (`types.ts`, `chain-resolver.ts`, `registry.ts`), 3 tests (1 nuevo + 2 extendidos), `.env.example`. |
| **Scope OUT** | `src/adapters/avalanche/*` (CD-2), `src/adapters/kite-ozone/*` (CD-2), `wasiai-facilitator` (WKH-105), Bazaar discovery (WKH-106), smoke real en CI (WKH-107), Smart Wallet / OnchainKit (WKH-108). |
| **Acceptance Criteria** | 8 ACs EARS (ver work-item §Acceptance Criteria, referenciados en §9 Test Plan por identificador AC-1..AC-8). |
| **Branch** | `feat/wkh-base-port-v1` — compartida con WKH-105..108. NO push directo a `main` (CD-8). |

---

## 3. Context Map (Codebase Grounding)

### 3.1 Archivos leídos durante F2 (verificados con Read/Glob)

| Archivo | Existe | Por qué se leyó | Patrón / hallazgo extraído |
|---------|--------|-----------------|----------------------------|
| `src/adapters/avalanche/index.ts` | ✅ | Exemplar exacto de la factory `createBaseAdapters`. | `createAvalancheAdapters(opts?: { network?: AvalancheNetwork }): Promise<AdaptersBundle>`. Dynamic imports lazy de payment/attestation/gasless. Construye `chainConfig` con `name`, `chainId`, `explorerUrl` derivados del network. Devuelve `identity: null`. **El nuevo adapter Base replica byte-a-byte esta firma**, sustituyendo `Avalanche*` por `Base*` y los explorers. |
| `src/adapters/avalanche/payment.ts` | ✅ | Exemplar de `BasePaymentAdapter`. Define el patrón de constants, lazy walletClient cache, EIP-3009 sign, fetch a facilitator, env-overrides. | (a) Constants per-network: `DEFAULT_FUJI_USDC`, `DEFAULT_AVALANCHE_USDC`, `FUJI_CHAIN_ID = 43113`, `AVALANCHE_CHAIN_ID = 43114`, `FUJI_NETWORK_TAG = 'eip155:43113'`. (b) `USDC_EIP712_NAME = 'USD Coin'`, `USDC_EIP712_VERSION_DEFAULT = '2'`, `USDC_DECIMALS = 6`. (c) Lazy walletClient cache **per-network** (`_walletClientFuji`, `_walletClientMainnet`) — Base hace lo mismo con `_walletClientSepolia`, `_walletClientMainnet`. (d) Warn-once flags `_warnedDefaultTokenFuji`, `_warnedDefaultTokenMainnet`. (e) Facilitator URL fallback chain: `AVALANCHE_FACILITATOR_URL > WASIAI_FACILITATOR_URL > hardcoded default`. Base extiende con `BASE_FACILITATOR_URL` + `CDP_FACILITATOR_URL` (DT-3 placeholder). (f) `_resetWalletClient()` export TEST-ONLY (CD-17). (g) `EIP3009_TYPES` const local — Base re-usa idéntico. (h) `sign()` construye `authorization` + `signature` + `xPaymentHeader = base64(JSON.stringify(paymentRequest))`. |
| `src/adapters/avalanche/chain.ts` | ✅ | Exemplar de re-export viem chains + `getXNetwork()` + `getXChain()`. | `import { avalanche, avalancheFuji } from 'viem/chains'; export { avalanche, avalancheFuji };`. Type `AvalancheNetwork = 'fuji' \| 'mainnet'`. `getAvalancheNetwork(opts?)` con prioridad `opts.network > AVALANCHE_NETWORK env > 'fuji'`. `getAvalancheChain(network)` switch a `avalanche` o `avalancheFuji`. **Base replica idéntico** — el type es `BaseNetwork = 'testnet' \| 'mainnet'` (testnet = baseSepolia 84532, mainnet = base 8453). |
| `src/adapters/avalanche/gasless.ts` | ✅ | Stub para `BaseGaslessAdapter` (CDP paymaster diferido a WKH-105). | Class `AvalancheGaslessAdapter implements GaslessAdapter`. `status()` retorna `{ enabled: false, network: 'avalanche-fuji', chain_id, supportedToken: null, operatorAddress: null, funding_state: 'disabled', documentation: <url> }`. `transfer()` throw `'Avalanche gasless not implemented (stub)'`. **Base replica idéntico**, mensaje "Base gasless not implemented — pending CDP paymaster (WKH-105)". |
| `src/adapters/avalanche/attestation.ts` | ✅ | Stub para `BaseAttestationAdapter`. | 31 LOC. `attest()` retorna `{ txHash: '0x0', proofUrl: '' }` con `console.warn`. `verify()` retorna `true`. **Base replica idéntico**, `console.warn` mensaje "[base] attestation stub — ERC-8004 not implemented". |
| `src/adapters/avalanche/identity.ts` | ✅ | Identity placeholder. | 3 LOC. `export const avalancheIdentity = null;`. **Base replica idéntico**, `export const baseIdentity = null;`. |
| `src/adapters/types.ts` | ✅ | Define `ChainKey` union + `AdaptersBundle`. | `type ChainKey = 'kite-ozone-testnet' \| 'kite-mainnet' \| 'avalanche-fuji' \| 'avalanche-mainnet'`. **Extender** con `'base-sepolia' \| 'base-mainnet'` → 6 variantes total. La extensión de la union **NO rompe** los consumers (todos usan `chainKey?: ChainKey` opcional + factory dispatch en `registry.ts`). No hay switch exhaustivos en el codebase (verificado con grep — sólo `if (chainKey === ...)` en `registry.ts:buildBundle()`). |
| `src/adapters/chain-resolver.ts` | ✅ | Pure module — mapeo alias → ChainKey. | `SLUG_ALIASES` con `Object.create(null) as Record<string, ChainKey>` (CD-19 anti-prototype-pollution). Acepta numeric chainIds + slugs canónicos + aliases. **Extender** con 6 aliases nuevos: `'8453'`, `'base'`, `'base-mainnet'` → `'base-mainnet'`; `'84532'`, `'base-sepolia'`, `'base-testnet'` → `'base-sepolia'`. `normalizeChainSlug()` ya hace `trim().toLowerCase()` + `Object.hasOwn()` — sin cambios de lógica. |
| `src/adapters/registry.ts` | ✅ | Factory dispatcher. | `SUPPORTED_CHAINS = ['kite-ozone-testnet', 'kite-mainnet', 'avalanche-fuji', 'avalanche-mainnet'] as const satisfies readonly ChainKey[]`. `buildBundle(chainKey)` con `if (chainKey === '...') {...}` branches. **Extender** ambos: agregar `'base-sepolia'` y `'base-mainnet'` al array, agregar 2 ramas `buildBundle()` que llaman `createBaseAdapters({ network: 'testnet' \| 'mainnet' })`. Mantener fail-fast guard (`Unsupported chain '${chainKey}'. Supported: ${SUPPORTED_CHAINS.join(', ')}`). |
| `src/adapters/__tests__/avalanche.test.ts` | ✅ | Exemplar de test contract — 427 LOC. Mock `viem` partial (sólo `createWalletClient`), mock global `fetch`. Cubre factory shape (fuji default + mainnet), payment adapter contract (chainId, scheme, network tag, USDC, decimals, EIP-712 domain via env override, facilitator URL fallback), gasless stub disabled, attestation stub. **Base replica idéntica estructura** en `base.test.ts` con valores ajustados. |
| `src/adapters/__tests__/chain-resolver.test.ts` | ✅ | Cobertura de aliases existentes (Kite + Avalanche). 125 LOC. **Extender** con bloque "maps base aliases" para los 6 nuevos slugs, manteniendo intactos los tests existentes. |
| `src/adapters/__tests__/payment.contract.test.ts` | ✅ | Cubre solamente `KiteOzonePaymentAdapter` (228 LOC). NO incluye Avalanche (Avalanche tiene su propio `avalanche.test.ts` exhaustivo). **Decisión**: el work-item menciona "extender — agregar suite Base adapter (mirrors sección Avalanche existente)", pero el código actual NO tiene sección Avalanche en `payment.contract.test.ts` (Avalanche vive en `avalanche.test.ts`). **Seguimos el patrón real, no el work-item**: Base testing exhaustivo va en `base.test.ts`. El work-item §Scope IN sobre `payment.contract.test.ts` se reinterpreta como "agregar un smoke test mínimo Base si aporta valor — opcional". Ver §10 Test Plan / decisión DT-7. |
| `src/adapters/__tests__/registry.test.ts` | ✅ | Mock factories de Kite y Avalanche, cubre `WASIAI_A2A_CHAIN` + `WASIAI_A2A_CHAINS`, unsupported throws con lista actualizada, CD-13 conflict warn. **Extender** mock Base + 2-3 tests que confirmen `base-sepolia` y `base-mainnet` se resuelven y `SUPPORTED_CHAINS` incluye los 6. AC-6 (work-item) cubierto por el guard existente. |
| `src/middleware/a2a-key.ts` (líneas 180-235) | ✅ (lectura) | Confirmar que la lógica de chain resolution NO requiere cambios. | El middleware lee `x-payment-chain`, llama `resolveChainKey({ headerOverride })`, retorna 400 si chain no reconocida (CD-14), 400 si reconocida pero no inicializada (DT-C). **Sin cambios** — el adapter Base se enchufa via `registry.buildBundle()` y todo lo demás funciona automáticamente. Esto valida la arquitectura W2 de WKH-MULTICHAIN. |
| `node_modules/viem/chains/definitions/base.ts` | ✅ | Confirmar disponibilidad de `base` chain. | `export const base = defineChain({ ...chainConfig, id: 8453, name: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://mainnet.base.org'] } }, blockExplorers: { default: { name: 'Basescan', url: 'https://basescan.org' } }, ... })`. **DT-4 RESUELTO**: viem v2.47.6 (`package.json:viem ^2.47.6`) expone `base` y `baseSepolia` directamente — NO necesitamos `defineChain()` propio. |
| `node_modules/viem/chains/definitions/baseSepolia.ts` | ✅ | Confirmar disponibilidad de `baseSepolia` chain. | `id: 84532, network: 'base-sepolia', name: 'Base Sepolia', testnet: true, rpcUrls.default.http: ['https://sepolia.base.org'], blockExplorers.default.url: 'https://sepolia.basescan.org'`. |
| `node_modules/viem/chains/index.ts` | ✅ | Confirmar exports. | `export { base, basePreconf } from './definitions/base.js'` + `export { baseSepolia, baseSepoliaPreconf } from './definitions/baseSepolia.js'`. Re-export simple desde `viem/chains` funciona. |
| `.env.example` | ✅ | Inventario de env vars + patrón de bloques comentados. | Estructura por sección (Avalanche §"Downstream x402 — Avalanche" desde línea 351). El bloque Base se inserta después de la sección Avalanche, replicando el formato (header `# ─── Section ────`, descripción de activación, vars con defaults). |
| `doc/sdd/086-wkh-multichain-a2a/sdd.md` | ✅ (lectura selectiva §3) | Contexto del refactor WKH-MULTICHAIN — fuente del patrón Avalanche actual. | Documenta cómo Avalanche se integró al registry; **es la guía de oro** para Base. Sin sorpresas — el adapter Base es el segundo "second-class" cumpliendo el contrato definido por WKH-MULTICHAIN. |
| `doc/sdd/087-wkh-59-real-agent-price-debit/auto-blindaje.md` | ✅ | Auto-Blindaje histórico — patrones de error previos. | Dos lecciones: (a) tests de `compose` que asumen `priceUsdc > 0` necesitan `a2aKey` para evitar entrar al branch x402 sign. **NO aplica directamente a esta HU** (Base sólo agrega adapter; no toca `compose` lógica). (b) Defensa-en-profundidad por step — fallback honesto cuando upstream config falla. **Aplica a Base**: si `BASE_NETWORK` env tiene valor inválido (e.g. `'devnet'`), defaultear a `'testnet'` SILENCIOSAMENTE NO es aceptable cuando es ambiguo — debe loggear `console.warn` (ver DT-2 abajo). |
| `doc/sdd/084-wkh-69-passport-hybrid-inbound/auto-blindaje.md` | ✅ | Lección cross-rootDir imports. | TS6059 cuando `src/` importa de `test/`. **NO aplica a esta HU**: todos los tests Base viven en `src/adapters/__tests__/` (dentro de rootDir). |

### 3.2 Auto-Blindaje aplicable (lecciones aprendidas → CDs de esta HU)

| HU previa | Lección | Aplicación a WKH-104 |
|-----------|---------|----------------------|
| WKH-69 (084) | Cross-rootDir imports rompen `tsc --noEmit` | Mantener todos los tests Base dentro de `src/adapters/__tests__/`. Ver CD-10. |
| WKH-59 (087) | Defensa-en-profundidad por step; no confiar en config upstream | `getBaseNetwork()` debe loggear `console.warn` si `BASE_NETWORK` tiene valor distinto de `'mainnet'`/`'testnet'`/vacío. Ver DT-2 ampliado + CD-11. |
| WKH-MULTICHAIN (086) | `chainId` de debit y `getBalance` deben venir del MISMO bundle | El adapter Base expone `chainId` consistente entre `chainConfig.chainId`, `payment.chainId`, `gasless.chain_id`. Ya garantizado por el factory pattern Avalanche — replicar idéntico. |
| WKH-MULTICHAIN (086) | `SUPPORTED_CHAINS` debe declararse `as const satisfies readonly ChainKey[]` para que TypeScript detecte chains faltantes | Mantener el satisfies clause cuando se extiende el array. |

---

## 4. Architecture — Cómo se integra el adapter Base

```
┌────────────────────────────────────────────────────────────────────────┐
│  HTTP Request                                                          │
│  POST /compose                                                         │
│  Headers:                                                              │
│    x-a2a-key: wasi_a2a_...                                             │
│    x-payment-chain: base-sepolia    ← NEW (or "84532")                 │
└────────────────────────────┬───────────────────────────────────────────┘
                             ▼
┌────────────────────────────────────────────────────────────────────────┐
│  src/middleware/a2a-key.ts:188-225  (NO CHANGES — already multi-chain) │
│  - resolveChainKey({ headerOverride: 'base-sepolia' })                 │
│       → chain-resolver.ts SLUG_ALIASES lookup                          │
│       → 'base-sepolia'                                                 │
│  - getAdaptersBundle('base-sepolia')                                   │
│       → registry._bundles.get('base-sepolia')                          │
│       → AdaptersBundle { payment: BasePaymentAdapter, ... }            │
│  - chainId = bundle.chainConfig.chainId = 84532                        │
│  - budgetService.debit(keyId, 84532, costUsd)                          │
│  - request.resolvedChainId = 84532                                     │
└────────────────────────────┬───────────────────────────────────────────┘
                             ▼
┌────────────────────────────────────────────────────────────────────────┐
│  Route Handler — uses bundle.payment for sign/verify/settle            │
│                                                                        │
│  bundle.payment.sign({ to, value }):                                   │
│    - getWalletClient('testnet') → cached viem WalletClient             │
│    - signTypedData({                                                   │
│        domain: { name: 'USD Coin', version: '2',                       │
│                  chainId: 84532,                                       │
│                  verifyingContract:                                    │
│                    '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },     │
│        types: EIP3009_TYPES,                                           │
│        primaryType: 'TransferWithAuthorization',                       │
│        message: { from, to, value, validAfter, validBefore, nonce }    │
│      })                                                                │
│    - xPaymentHeader = base64(JSON.stringify({ signature, ... }))       │
│                                                                        │
│  bundle.payment.verify(proof) / settle(req):                           │
│    - POST <facilitatorUrl>/verify | /settle                            │
│    - facilitatorUrl chain: BASE_FACILITATOR_URL > CDP_FACILITATOR_URL  │
│      > WASIAI_FACILITATOR_URL > default                                │
│      (BASE-02 wirea el facilitator real)                               │
└────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Bootstrap (initAdapters)

```ts
// .env
WASIAI_A2A_CHAINS=kite-ozone-testnet,avalanche-fuji,base-sepolia
BASE_NETWORK=testnet
BASE_TESTNET_RPC_URL=https://sepolia.base.org
// (BASE_MAINNET_RPC_URL omitido para testnet-only deploy)

// startup → src/adapters/registry.ts:initAdapters()
// → buildBundle('kite-ozone-testnet')  → KiteOzonePaymentAdapter
// → buildBundle('avalanche-fuji')      → AvalanchePaymentAdapter('fuji')
// → buildBundle('base-sepolia')        → BasePaymentAdapter({ network: 'testnet' })
// → _defaultChainKey = 'kite-ozone-testnet'  (primer entry del CSV)
```

### 4.2 Modules nuevos / modificados

| Archivo | Acción | LOC estimadas |
|---------|--------|---------------|
| `src/adapters/base/chain.ts` | NUEVO | ~35 |
| `src/adapters/base/payment.ts` | NUEVO | ~430 (mirror exacto avalanche) |
| `src/adapters/base/attestation.ts` | NUEVO | ~32 |
| `src/adapters/base/gasless.ts` | NUEVO | ~46 |
| `src/adapters/base/identity.ts` | NUEVO | ~3 |
| `src/adapters/base/index.ts` | NUEVO | ~50 |
| `src/adapters/types.ts` | MODIFY (3 líneas) | +2 |
| `src/adapters/chain-resolver.ts` | MODIFY (6 líneas) | +6 |
| `src/adapters/registry.ts` | MODIFY (10 líneas) | +12 |
| `src/adapters/__tests__/base.test.ts` | NUEVO | ~430 |
| `src/adapters/__tests__/chain-resolver.test.ts` | EXTEND | +25 |
| `src/adapters/__tests__/registry.test.ts` | EXTEND | +50 (mock Base + tests AC-6) |
| `.env.example` | EXTEND | +35 (nueva sección Base) |

**Total**: ~1200 LOC nuevas, 0 LOC eliminadas.

---

## 5. Waves de implementación

### Wave 0 — Pre-flight verification (Dev W0, serial, no parallel)

Verificaciones **antes** de escribir código. Output: `doc/sdd/088-wkh-104-base-adapter/w0-audit.md`.

| Step | Acción | Comando / Verificación | Output esperado |
|------|--------|------------------------|-----------------|
| W0.1 | Confirmar viem `base` + `baseSepolia` disponibles | `grep "base\\|baseSepolia" node_modules/viem/chains/index.ts` | 2 exports presentes |
| W0.2 | Confirmar `viem ^2.47.6` instalado | `npm ls viem` | `viem@2.47.x` |
| W0.3 | Verificar baseline tests pasan en branch limpia | `npm test` (en `feat/wkh-base-port-v1` antes de cambios) | 1660+/0 |
| W0.4 | EIP-712 domain `name` en USDC Base Sepolia (CD-3) | `cast call 0x036CbD53842c5426634e7929541eC2318f3dCF7e "name()(string)" --rpc-url https://sepolia.base.org` | Hipótesis: `"USD Coin"`. Si difiere, documentar el valor real y usarlo como `USDC_EIP712_NAME` en `base/payment.ts`. |
| W0.5 | EIP-712 domain `version` en USDC Base Sepolia (CD-3) | `cast call 0x036CbD53842c5426634e7929541eC2318f3dCF7e "version()(string)" --rpc-url https://sepolia.base.org` (si el contrato lo expone; sino derivarlo del `DOMAIN_SEPARATOR` y comparar contra `keccak256(USD Coin, 2)`) | Hipótesis: `"2"`. Si difiere → constante por-network. |
| W0.6 | EIP-712 domain `name` + `version` en USDC Base Mainnet (CD-3) | `cast call 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "name()(string)" --rpc-url https://mainnet.base.org` y `version()` | Hipótesis: `"USD Coin"` / `"2"`. **Si testnet y mainnet difieren, agregar override `BASE_SEPOLIA_USDC_EIP712_NAME` + `BASE_MAINNET_USDC_EIP712_NAME` (per-network) — sigue el patrón Avalanche `FUJI_USDC_EIP712_VERSION` + `AVALANCHE_USDC_EIP712_VERSION`.** |
| W0.7 | Identificar callers de `ChainKey` exhaustivos | `grep -rn "switch.*ChainKey\\|: ChainKey)" src --include="*.ts"` | Confirmar que no hay switch exhaustivos no manejados. Resultado verificado en F2: **sólo `registry.ts:buildBundle()` hace dispatch — se extiende como parte de W3.** |
| W0.8 | Documentar hallazgos en w0-audit.md | Crear archivo en folder SDD con outputs literales de las llamadas `cast` | Documento checklist con cada step ✅/❌ + el `name`/`version` literal hallado |

**Output de W0 obligatorio**: `w0-audit.md` con outputs verbatim de `cast call`. Si W0.4–W0.6 retornan algo distinto a `"USD Coin"` / `"2"`, **no avanzar a W1** — actualizar constants y re-validar con Architect. Esto cumple CD-3 estrictamente.

### Wave 1 — Cross-cutting types + chain-resolver (paralelizable internamente)

Toca módulos que afectan a todos los adapters. Hacer primero porque sin esto los archivos del adapter Base no compilarán.

| Step | Archivo | Acción |
|------|---------|--------|
| W1.1 | `src/adapters/types.ts` | Extender union `ChainKey` con `'base-sepolia' \| 'base-mainnet'`. Solo agregar 2 líneas al type alias. **No tocar interfaces** (`PaymentAdapter`, etc) — son chain-agnostic. |
| W1.2 | `src/adapters/chain-resolver.ts` | Agregar 6 aliases en `SLUG_ALIASES` (ver §6 Patrón de código). Después de la sección kite-mainnet. |
| W1.3 | `src/adapters/__tests__/chain-resolver.test.ts` | Agregar bloque `describe('base aliases', ...)` con 6 tests (uno por slug) + asegurar que tests CD-19 anti-prototype-pollution siguen pasando. |
| W1.4 | `npm run lint && npm test src/adapters/__tests__/chain-resolver.test.ts` | Tests verdes. |

**Tests requeridos en W1**: AC-1 y AC-2 (header → ChainKey) parcialmente cubiertos por chain-resolver tests; la parte registry se cubre en W3.

### Wave 2 — Adapter Base (6 archivos en `src/adapters/base/`)

| Step | Archivo | Acción | Patrón |
|------|---------|--------|--------|
| W2.1 | `src/adapters/base/chain.ts` | Re-export `base` y `baseSepolia` de viem. `type BaseNetwork = 'testnet' \| 'mainnet'`. `getBaseNetwork(opts?)` con prioridad `opts.network > BASE_NETWORK env > 'testnet'`. `getBaseChain(network)`. Ver §6.1. | Mirror exacto de `avalanche/chain.ts` (Read en §3) |
| W2.2 | `src/adapters/base/identity.ts` | 3 LOC: `export const baseIdentity = null;`. | Mirror `avalanche/identity.ts` |
| W2.3 | `src/adapters/base/attestation.ts` | Class `BaseAttestationAdapter implements AttestationAdapter`. Stub idéntico Avalanche. | Mirror `avalanche/attestation.ts` |
| W2.4 | `src/adapters/base/gasless.ts` | Class `BaseGaslessAdapter implements GaslessAdapter`. Network tag `'base-sepolia' \| 'base-mainnet'`. `status()` retorna disabled. `transfer()` throw "Base gasless not implemented — pending CDP paymaster (WKH-105)". | Mirror `avalanche/gasless.ts` |
| W2.5 | `src/adapters/base/payment.ts` | Class `BasePaymentAdapter implements PaymentAdapter`. **Mirror exacto** de `avalanche/payment.ts` con ajustes: (a) chainIds 84532/8453, (b) USDC addresses Base, (c) facilitator chain `BASE_FACILITATOR_URL > CDP_FACILITATOR_URL > WASIAI_FACILITATOR_URL > default`, (d) constants USDC name/version derivadas de W0, (e) network tags `eip155:84532` / `eip155:8453`, (f) walletClient caches `_walletClientSepolia` + `_walletClientMainnet`. Export `_resetWalletClient()` TEST-ONLY. | Mirror `avalanche/payment.ts` (Read en §3) |
| W2.6 | `src/adapters/base/index.ts` | `createBaseAdapters(opts?: { network?: BaseNetwork }): Promise<AdaptersBundle>`. Dynamic imports lazy. Devuelve bundle con `identity: null`. ChainConfig con name `'Base'` / `'Base Sepolia'`, explorerUrl `https://basescan.org` / `https://sepolia.basescan.org`. | Mirror `avalanche/index.ts` (Read en §3) |
| W2.7 | `npm run lint` | Cero errores Biome. |

**No tests aún en W2** — el adapter está listo pero no wired. Tests vienen en W3 cuando el registry lo dispatchea.

### Wave 3 — Registry wiring + test suite

| Step | Archivo | Acción |
|------|---------|--------|
| W3.1 | `src/adapters/registry.ts` | Agregar `'base-sepolia'` y `'base-mainnet'` al array `SUPPORTED_CHAINS`. Agregar 2 ramas `buildBundle()`: `if (chainKey === 'base-sepolia') { return createBaseAdapters({ network: 'testnet' }); }` y mainnet equivalente. Mantener el throw fallback al final. |
| W3.2 | `src/adapters/__tests__/base.test.ts` | Crear suite. Estructura idéntica a `avalanche.test.ts`: factory shape (testnet default + mainnet wiring + identity null + BASE_NETWORK env), payment contract (name, chainId, scheme, network tag, supportedTokens, env overrides, sign/verify/settle, facilitator URL chain), gasless stub disabled, attestation stub. Total ~25 tests. |
| W3.3 | `src/adapters/__tests__/registry.test.ts` | (a) Agregar `vi.mock('../base/index.js', ...)` con mock factory que retorna bundle stub. (b) Actualizar el test `unsupported chain throws` para incluir `base-sepolia, base-mainnet` en el listado esperado. (c) Agregar 2 tests: `WASIAI_A2A_CHAINS=base-sepolia` inicializa el bundle Base Sepolia + chainId 84532; `WASIAI_A2A_CHAINS=base-mainnet` idem mainnet. |
| W3.4 | `src/adapters/__tests__/chain-resolver.test.ts` | (Ya extendido en W1.3 — confirmar verde aquí post-registry wire) |
| W3.5 | `npm test` | TODA la suite verde: 1660+ previos + ~30 nuevos. |

### Wave 4 — Env example + smoke local + build verde

| Step | Archivo | Acción |
|------|---------|--------|
| W4.1 | `.env.example` | Agregar sección Base (ver §7) después de la sección Avalanche (línea 393). Vars: `BASE_NETWORK`, `BASE_TESTNET_RPC_URL`, `BASE_MAINNET_RPC_URL`, `BASE_SEPOLIA_USDC_ADDRESS`, `BASE_MAINNET_USDC_ADDRESS`, `BASE_SEPOLIA_USDC_EIP712_VERSION` (sólo si W0 detectó divergencia), `BASE_MAINNET_USDC_EIP712_VERSION` (idem), `BASE_FACILITATOR_URL`, `CDP_FACILITATOR_URL`, `CDP_API_KEY`. |
| W4.2 | `npm run build` | `tsc -p tsconfig.build.json` verde, 0 errores strict. |
| W4.3 | Smoke local Base Sepolia (CD-12 verification) | Setear `WASIAI_A2A_CHAINS=base-sepolia` + `OPERATOR_PRIVATE_KEY` + `BASE_NETWORK=testnet`. `npm run dev`. Llamar `curl http://localhost:3001/.well-known/agent.json` para confirmar startup OK. Llamar `curl -H "x-payment-chain: base-sepolia" ...` con una request mínima → debe responder con `payment_required` (no 500). Documentar en `w0-audit.md` el smoke result. |
| W4.4 | `npm test` final | 1690+/0. Verde. |
| W4.5 | Commit + push a `feat/wkh-base-port-v1` | PR queda en draft hasta que WKH-105 (BASE-02 facilitator) + WKH-107 (smoke E2E real) den verde. **NO merge a main en BASE-01** (CD-8). |

---

## 6. Patrones de código (referenciados desde Story File F2.5)

### 6.1 `src/adapters/base/chain.ts` (W2.1) — patrón verificado

```ts
import { base, baseSepolia } from 'viem/chains';

/**
 * Base chain registration (WKH-104 / BASE-01).
 *
 * Re-export the viem-defined chains directly — Base (8453) and Base Sepolia
 * (84532) are first-class viem entries since viem ^2.47.6, no defineChain()
 * needed (DT-4 RESUELTO en F2 W0).
 */
export { base, baseSepolia };

export type BaseNetwork = 'testnet' | 'mainnet';

/**
 * Resolve the active Base network for call-sites outside the registry
 * factory. Priority:
 *   1. Explicit `opts.network` argument.
 *   2. `BASE_NETWORK` env var ('mainnet' activates mainnet, anything else → testnet).
 *   3. Fallback to 'testnet' (Base Sepolia) — conservador (CD-4).
 *
 * If BASE_NETWORK is set to a value other than 'mainnet'/'testnet', emit
 * console.warn ONCE per process (CD-11). Avoids silent miscofig.
 */
let _warnedBaseNetwork = false;
export function getBaseNetwork(opts?: { network?: BaseNetwork }): BaseNetwork {
  if (opts?.network) return opts.network;
  const env = process.env.BASE_NETWORK;
  if (env === 'mainnet') return 'mainnet';
  if (env !== undefined && env !== '' && env !== 'testnet' && !_warnedBaseNetwork) {
    _warnedBaseNetwork = true;
    console.warn(
      `[base] BASE_NETWORK="${env}" is not 'mainnet' or 'testnet' — defaulting to 'testnet'`,
    );
  }
  return 'testnet';
}

export function getBaseChain(network: BaseNetwork) {
  return network === 'mainnet' ? base : baseSepolia;
}

/** TEST-ONLY — reset warn-once flag (CD-17). */
export function _resetBaseChain(): void {
  _warnedBaseNetwork = false;
}
```

### 6.2 `src/adapters/chain-resolver.ts` — aliases a agregar (W1.2)

```ts
// Después de la sección kite-mainnet:

    // base-mainnet aliases
    '8453': 'base-mainnet',
    'base-mainnet': 'base-mainnet',
    base: 'base-mainnet',

    // base-sepolia aliases
    '84532': 'base-sepolia',
    'base-sepolia': 'base-sepolia',
    'base-testnet': 'base-sepolia',
```

> **Decisión DT-7**: `'base'` alone → `'base-mainnet'` (consistente con `'avalanche'` → fuji? NO, Avalanche tiene `'avalanche'` → `'avalanche-fuji'`). **Para Base hacemos lo contrario**: `'base'` → `'base-mainnet'` porque la convención de la comunidad Base es referirse a "Base" como la mainnet (Base testnet siempre se llama "Base Sepolia"). En Avalanche la convención histórica fue distinta porque `avalanche` se usaba como sinónimo de testnet/desarrollo en docs early. **Documentado en CD nuevo: CD-12**. (Si Adversary objeta, fallback es `'base'` → undefined que obliga al caller a usar el slug completo — ver §13 Decisión final.)

### 6.3 `src/adapters/base/index.ts` (W2.6)

```ts
import type { AdaptersBundle } from '../types.js';
import {
  type BaseNetwork,
  getBaseChain,
  getBaseNetwork,
} from './chain.js';

/**
 * Base adapter factory (WKH-104 / BASE-01).
 *
 * Returns an AdaptersBundle ready to be inserted into the multi-chain
 * registry Map<ChainKey, AdaptersBundle>. Network is determined by
 * opts.network (preferred) or BASE_NETWORK env (legacy / standalone).
 *
 * The registry dispatcher (buildBundle() in registry.ts) always passes
 * network explicitly — 'testnet' for 'base-sepolia', 'mainnet' for
 * 'base-mainnet'.
 */
export async function createBaseAdapters(opts?: {
  network?: BaseNetwork;
}): Promise<AdaptersBundle> {
  const network = getBaseNetwork(opts);
  const { BasePaymentAdapter } = await import('./payment.js');
  const { BaseAttestationAdapter } = await import('./attestation.js');
  const { BaseGaslessAdapter } = await import('./gasless.js');

  const chain = getBaseChain(network);
  const chainId = chain.id;
  const explorerUrl =
    network === 'mainnet'
      ? 'https://basescan.org'
      : 'https://sepolia.basescan.org';
  const name = network === 'mainnet' ? 'Base' : 'Base Sepolia';

  return {
    payment: new BasePaymentAdapter({ network }),
    attestation: new BaseAttestationAdapter(chainId),
    gasless: new BaseGaslessAdapter(chainId),
    identity: null,
    chainConfig: { name, chainId, explorerUrl },
  };
}
```

### 6.4 `src/adapters/base/payment.ts` — constants críticas (W2.5)

```ts
const BASE_SCHEME = 'exact' as const;
const BASE_SEPOLIA_CHAIN_ID = 84532 as const;
const BASE_MAINNET_CHAIN_ID = 8453 as const;
const BASE_SEPOLIA_NETWORK_TAG = 'eip155:84532' as const;
const BASE_MAINNET_NETWORK_TAG = 'eip155:8453' as const;
type BaseNetworkTag =
  | typeof BASE_SEPOLIA_NETWORK_TAG
  | typeof BASE_MAINNET_NETWORK_TAG;

const BASE_MAX_TIMEOUT_SECONDS = 60 as const;

// USDC contract addresses canonical Circle on Base (verified via Circle docs
// + W0 cast call onchain verification — see w0-audit.md):
const DEFAULT_BASE_SEPOLIA_USDC =
  '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`;
const DEFAULT_BASE_MAINNET_USDC =
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`;

// USDC EIP-712 domain — HIPÓTESIS DEL ARCHITECT (CD-3):
//   name = 'USD Coin', version = '2' (idéntico Ethereum mainnet + Avalanche).
// Dev DEBE re-verificar onchain en W0 antes de hardcodear. Si W0 detecta
// divergencia, agregar override por-network (BASE_SEPOLIA_USDC_EIP712_VERSION
// + BASE_MAINNET_USDC_EIP712_VERSION) replicando el patrón Avalanche y
// actualizar la constante.
const USDC_DECIMALS = 6 as const;
const USDC_EIP712_NAME = 'USD Coin' as const;
const USDC_EIP712_VERSION_DEFAULT = '2' as const;
const USDC_SYMBOL = 'USDC' as const;

// Facilitator URL fallback chain (DT-3):
//   BASE_FACILITATOR_URL > CDP_FACILITATOR_URL > WASIAI_FACILITATOR_URL >
//   hardcoded default.
// CDP_FACILITATOR_URL es un placeholder en BASE-01; el real lo wira BASE-02.
const WASIAI_FACILITATOR_DEFAULT_URL =
  'https://wasiai-facilitator-production.up.railway.app';

function getFacilitatorUrl(): string {
  return (
    process.env.BASE_FACILITATOR_URL ??
    process.env.CDP_FACILITATOR_URL ??
    process.env.WASIAI_FACILITATOR_URL ??
    WASIAI_FACILITATOR_DEFAULT_URL
  );
}
```

(El resto de la clase es **mirror exacto** de `avalanche/payment.ts` con substituciones — el Story File F2.5 listará las substituciones explícitamente.)

### 6.5 `src/adapters/registry.ts` — extensión (W3.1)

```ts
// SUPPORTED_CHAINS:
const SUPPORTED_CHAINS = [
  'kite-ozone-testnet',
  'kite-mainnet',
  'avalanche-fuji',
  'avalanche-mainnet',
  'base-sepolia',          // NEW
  'base-mainnet',          // NEW
] as const satisfies readonly ChainKey[];

// buildBundle (después de las 4 ramas existentes, antes del throw):
  if (chainKey === 'base-sepolia') {
    const { createBaseAdapters } = await import('./base/index.js');
    return createBaseAdapters({ network: 'testnet' });
  }
  if (chainKey === 'base-mainnet') {
    const { createBaseAdapters } = await import('./base/index.js');
    return createBaseAdapters({ network: 'mainnet' });
  }
```

---

## 7. `.env.example` — sección nueva (W4.1)

```env
# ============================================================
# Base — inbound x402 path (WKH-104 / BASE-01)
# ============================================================
# Habilita el adapter Base (chainId 8453 mainnet, 84532 sepolia testnet)
# para inbound x402 USDC EIP-3009 sobre wasiai-a2a. Para activarlo, agregar
# 'base-sepolia' o 'base-mainnet' al CSV WASIAI_A2A_CHAINS arriba.
# Default conservador (CD-4): testnet.

# Selecciona la red Base activa para el adapter (standalone/factory).
# Valores: 'mainnet' | 'testnet' (default 'testnet'). Cualquier otro valor
# es ignorado con console.warn y defaultea a 'testnet'.
BASE_NETWORK=testnet

# RPC público Base Sepolia (chainId 84532) — testnet, default
# https://sepolia.base.org. Override si usás un provider dedicado (Alchemy,
# Infura, QuickNode).
BASE_TESTNET_RPC_URL=https://sepolia.base.org

# RPC público Base Mainnet (chainId 8453) — sólo se lee cuando
# BASE_NETWORK=mainnet. Default https://mainnet.base.org.
BASE_MAINNET_RPC_URL=https://mainnet.base.org

# Dirección USDC en Base Sepolia (default canonical Circle USDC test).
# Si ausente, usa 0x036CbD53842c5426634e7929541eC2318f3dCF7e con warn-once.
BASE_SEPOLIA_USDC_ADDRESS=

# Dirección USDC en Base Mainnet (default canonical Circle USDC).
# Si ausente, usa 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 con warn-once.
BASE_MAINNET_USDC_ADDRESS=

# EIP-712 version override para USDC en Base. Default '2'. Sólo setear si
# W0 verification detectó valor distinto. Per-network porque la deployment
# puede diferir (CD-3 escape hatch).
BASE_SEPOLIA_USDC_EIP712_VERSION=
BASE_MAINNET_USDC_EIP712_VERSION=

# Facilitator URL override para Base (verify/settle). Resolución:
#   1. BASE_FACILITATOR_URL (esta var)
#   2. CDP_FACILITATOR_URL (placeholder BASE-01, real en BASE-02)
#   3. WASIAI_FACILITATOR_URL (compartido con Avalanche)
#   4. hardcoded https://wasiai-facilitator-production.up.railway.app
BASE_FACILITATOR_URL=

# Placeholder CDP facilitator URL (BASE-02 lo cablea a la URL real cuando
# wasiai-facilitator soporte Base RPC). Dejar vacío en BASE-01.
CDP_FACILITATOR_URL=

# Placeholder CDP API key — sin uso real en BASE-01, reservado para
# integraciones futuras (Paymaster, OnchainKit). NO ponerlo en logs.
CDP_API_KEY=
```

---

## 8. Decisiones técnicas (DT-N)

> Los DT-1..DT-6 son heredados del work-item. DT-7..DT-12 son nuevos en F2.

- **DT-1 (heredado) — EIP-712 domain `name` via onchain verification (CD-3)**:
  El `name` del EIP-712 domain de USDC en Base PUEDE diferir de `'USD Coin'`. Hipótesis del Architect: `'USD Coin'` / version `'2'` — basada en (a) la documentación pública Circle FiatTokenV2.2 (deployments oficiales en Base son canonical USDC, no bridged USDbC), (b) consistencia con Ethereum mainnet y Avalanche C-Chain donde USDC usa el mismo domain. **Verificación obligatoria en W0 vía `cast call name()` y `version()`** sobre ambos contratos antes de hardcodear. Si W0 detecta divergencia, agregar overrides per-network (`BASE_SEPOLIA_USDC_EIP712_VERSION` / `BASE_MAINNET_USDC_EIP712_VERSION`) — env vars **ya documentadas** en `.env.example` arriba como escape hatch sin necesidad de cambio de código. El default constant queda con el valor confirmado en W0.

- **DT-2 (heredado, ampliado) — Network selection pattern (mirrors Avalanche)**:
  Factory `createBaseAdapters(opts?)` recibe `network` explícito desde `buildBundle()` (igual que Avalanche). Para uso standalone, `getBaseNetwork(opts?)` resuelve: `opts.network > BASE_NETWORK env > 'testnet'`. **Ampliación F2**: si `BASE_NETWORK` tiene un valor que no es `'mainnet'`, `'testnet'`, vacío o undefined (e.g. `'devnet'`, `'staging'`), emitir `console.warn` ONCE por proceso explicando el fallback a testnet. Esto previene silent misconfig (Auto-Blindaje WKH-59 lesson). Ver §6.1 código.

- **DT-3 (heredado, ampliado) — Facilitator routing para Base (placeholder en BASE-01)**:
  Cadena de prioridad: `BASE_FACILITATOR_URL > CDP_FACILITATOR_URL > WASIAI_FACILITATOR_URL > hardcoded default`. **Por qué CDP entre BASE y WASIAI**: `BASE_FACILITATOR_URL` permite override absoluto (testing/debug), `CDP_FACILITATOR_URL` es el placeholder reservado para BASE-02 (cuando `wasiai-facilitator` soporte Base RPC); `WASIAI_FACILITATOR_URL` es el shared con Avalanche; default es nuestro facilitator actual. En BASE-01 los tests mockean `fetch` — ningún test real golpea el facilitator. **Importante**: el facilitator actual NO soporta Base (BASE-02 lo agrega) → el smoke de W4 puede recibir 4xx del `/verify`, lo cual es esperado y no debe fallar el build. Documentar este caveat en `base/gasless.ts` JSDoc y en `w0-audit.md`.

- **DT-4 RESUELTO** — viem v2.47.6 instalado expone `base` (8453) y `baseSepolia` (84532) directamente desde `viem/chains`. Verificado en F2 con `Read` de `node_modules/viem/chains/index.ts` y de los archivos `definitions/base.ts` + `definitions/baseSepolia.ts`. NO se necesita `defineChain()` propio. Re-exportar via `export { base, baseSepolia } from 'viem/chains'`.

- **DT-5 (heredado) — identity es null en MVP**:
  `export const baseIdentity = null;`. Sin equivalente de Kite Passport en Base. Replicado en factory return `identity: null`.

- **DT-6 (heredado) — USDC addresses hardcoded con override via env**:
  Constantes `DEFAULT_BASE_SEPOLIA_USDC` + `DEFAULT_BASE_MAINNET_USDC` con env overrides `BASE_SEPOLIA_USDC_ADDRESS` + `BASE_MAINNET_USDC_ADDRESS`. Validación de formato (`/^0x[0-9a-fA-F]{40}$/`) + warn-once por network (mirror exacto Avalanche). Ver §6.4 constants.

- **DT-7 (nuevo) — Alias `'base'` → `'base-mainnet'`**:
  En `chain-resolver.ts`, `'base'` alone resuelve a `'base-mainnet'` (no a `'base-sepolia'`). Razón: la convención de la comunidad Base usa "Base" como sinónimo de mainnet (Base Sepolia siempre se nombra explícitamente como testnet). **Trade-off**: difiere de la convención Avalanche (`'avalanche'` → `'avalanche-fuji'` testnet). Justificación de la diferencia: Avalanche tiene esa convención por razones históricas de adopción early. En cambio, en el ecosistema Base/Coinbase la nomenclatura es estable post-mainnet launch. **Si Adversary objeta**: el fallback aceptable es que `'base'` NO sea alias (callers deben usar `'base-sepolia'` o `'base-mainnet'` explícitamente). Documentado para revisión en CR.

- **DT-8 (nuevo) — Test isolation: per-network walletClient cache**:
  El adapter Base, igual que Avalanche, cachea `_walletClientSepolia` + `_walletClientMainnet` **a nivel de módulo** (no de instancia). Esto reduce overhead en producción pero requiere `_resetWalletClient()` TEST-ONLY exportado para que cada test pueda re-init con env vars distintos. Cumple CD-17. Patrón validado en `avalanche.test.ts:39-42` (`_resetWalletClient()` en `beforeEach`).

- **DT-9 (nuevo) — Test mock strategy: partial viem mock**:
  Los tests usan `vi.mock('viem', async (importOriginal) => { const actual = await importOriginal<typeof import('viem')>(); return { ...actual, createWalletClient: vi.fn(() => ({ account: {...}, signTypedData: vi.fn().mockResolvedValue(...) })) }; });`. Esto reemplaza solo `createWalletClient` preservando `http`, `parseUnits`, etc. Idéntico patrón Avalanche. Garantiza que los tests de `sign()` no requieran RPC real (CI seguro).

- **DT-10 (nuevo) — Registry test mock**:
  En `registry.test.ts`, agregar `vi.mock('../base/index.js', () => ({ createBaseAdapters: vi.fn(async (opts) => ({ payment: {name: 'base', chainId: opts.network === 'mainnet' ? 8453 : 84532}, ... })) }));` siguiendo el patrón existente para `kite-ozone` y `avalanche`. Los tests del registry NO ejercitan los adapters reales — eso es responsabilidad de `base.test.ts`.

- **DT-11 (nuevo) — Facilitator caveat en BASE-01**:
  En BASE-01, el facilitator real (CDP o `wasiai-facilitator`) no soporta Base. Los tests mockean `fetch`. El smoke de W4.3 NO debe validar `verify` exitoso; solo confirma `startup OK` + `payment_required` response. **BASE-02 (WKH-105) wirea el facilitator real** y BASE-04 (WKH-107) hace smoke E2E con tx hash real. Documentar este caveat explícitamente en `base/payment.ts` JSDoc top-of-file y en `w0-audit.md`.

- **DT-12 (nuevo) — Build target: tsc strict + biome**:
  El nuevo código debe pasar `tsc -p tsconfig.build.json` (CD-1, zero `any`, zero `as unknown`). Biome check verde. Las únicas anotaciones `as` permitidas son `as const` para literal narrowing y `as \`0x\${string}\`` para hex string narrowing — patrones ya en uso en `avalanche/payment.ts`.

---

## 9. Constraint Directives (CD-N)

> CD-1..CD-9 heredados del work-item. CD-10..CD-12 nuevos en F2.

- **CD-1 (heredado)**: OBLIGATORIO TypeScript strict — cero `any` explícito, cero `as unknown` en código nuevo. Sólo se permite `as const`, `as \`0x\${string}\`` y `as Readonly<...>` patrones ya en exemplars.
- **CD-2 (heredado)**: PROHIBIDO modificar `src/adapters/avalanche/` y `src/adapters/kite-ozone/`. Cualquier cambio en estos directorios = BLOQUEANTE en AR.
- **CD-3 (heredado)**: OBLIGATORIO verificar EIP-712 domain `name` + `version` via `cast call name()` y `cast call version()` (o `DOMAIN_SEPARATOR()` hash compare) en Base Sepolia (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) y Base Mainnet (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) ANTES de hardcodear las constants `USDC_EIP712_NAME` + `USDC_EIP712_VERSION_DEFAULT`. Outputs literales del `cast call` deben quedar registrados en `w0-audit.md`. Si los valores difieren entre testnet y mainnet, los overrides per-network en `.env.example` (`BASE_SEPOLIA_USDC_EIP712_VERSION` / `BASE_MAINNET_USDC_EIP712_VERSION`) son el escape hatch sin cambio de código.
- **CD-4 (heredado)**: OBLIGATORIO `BASE_NETWORK=testnet` como default conservador. El path mainnet requiere opt-in explícito.
- **CD-5 (heredado)**: OBLIGATORIO `npm test` + `npm run build` verdes pre-merge. Todos los 1660+ tests existentes pasando — zero regressions.
- **CD-6 (heredado)**: PROHIBIDO secrets/keys hardcodeados. USDC addresses van como constants con env override, RPC URLs desde env, private key desde `OPERATOR_PRIVATE_KEY`.
- **CD-7 (heredado)**: PROHIBIDO `ethers.js` — viem en todo el codebase (regla global).
- **CD-8 (heredado)**: PROHIBIDO push directo a `main`. Branch `feat/wkh-base-port-v1`, PR con CR aprobado, merge a `main` sólo después de BASE-02..04 completos y staging validado (estrategia BASE port Fase 1).
- **CD-9 (heredado)**: OBLIGATORIO `WASIAI_A2A_CHAINS` soporta `base-sepolia` y `base-mainnet` como slugs válidos post-implementación. Tests AC-6 cubren el fail-fast del registry.
- **CD-10 (nuevo, Auto-Blindaje WKH-69)**: OBLIGATORIO mantener todos los archivos de test bajo `src/adapters/__tests__/` (dentro de `rootDir` del `tsconfig.json`). PROHIBIDO importar fixtures desde `test/` u otros directorios fuera de `src/` desde tests en `src/`. Si se necesita una fixture, vive en `src/adapters/__tests__/fixtures/`.
- **CD-11 (nuevo, Auto-Blindaje WKH-59 / defense-in-depth)**: PROHIBIDO silencioso fallback en `getBaseNetwork()` cuando `BASE_NETWORK` tiene un valor desconocido (no `'mainnet'` / `'testnet'` / vacío). DEBE emitir `console.warn` ONCE por proceso indicando el fallback a `'testnet'`. Patrón documentado en §6.1.
- **CD-12 (nuevo, Auto-Blindaje WKH-MULTICHAIN)**: OBLIGATORIO que el `chainId` reportado por `bundle.payment.chainId`, `bundle.attestation.chainId`, `bundle.gasless.chain_id` y `bundle.chainConfig.chainId` sea **el mismo** para una instancia dada de bundle. El test `base.test.ts` debe afirmar la consistencia (mirror del check en `avalanche.test.ts:62-77`).

---

## 10. Test Plan (mapping AC → test file → test name)

> Notación: T-N — Test N. Cada test debe afirmar la condición exacta del AC y nada más.

| AC | Condición | Test file | Test name (vitest `it()` clause) | Wave |
|----|-----------|-----------|-----------------------------------|------|
| **AC-1** | header `base-sepolia` o `84532` → `ChainKey='base-sepolia'` + registry resuelve bundle Base Sepolia | `chain-resolver.test.ts` | `T-1a: normalizeChainSlug('base-sepolia') returns 'base-sepolia'` | W1 |
| AC-1 | (idem) | `chain-resolver.test.ts` | `T-1b: normalizeChainSlug('84532') returns 'base-sepolia'` | W1 |
| AC-1 | (idem — registry side) | `registry.test.ts` | `T-1c: WASIAI_A2A_CHAINS='base-sepolia' initializes Base Sepolia bundle (chainId 84532)` | W3 |
| **AC-2** | header `base-mainnet` o `8453` → `'base-mainnet'` + registry resuelve bundle Base Mainnet | `chain-resolver.test.ts` | `T-2a: normalizeChainSlug('base-mainnet') returns 'base-mainnet'` | W1 |
| AC-2 | (idem) | `chain-resolver.test.ts` | `T-2b: normalizeChainSlug('8453') returns 'base-mainnet'` | W1 |
| AC-2 | (idem — registry side) | `registry.test.ts` | `T-2c: WASIAI_A2A_CHAINS='base-mainnet' initializes Base Mainnet bundle (chainId 8453)` | W3 |
| **AC-3** | `sign()` EIP-3009 sobre USDC Sepolia (`0x036C...`) → signature válida con `chainId=84532` en domain | `base.test.ts` | `T-3: sign() uses chainId 84532 in EIP-712 domain and verifyingContract = USDC Sepolia default` | W3 |
| **AC-4** | `BASE_NETWORK=mainnet` → USDC mainnet (`0x8335...`) + `BASE_MAINNET_RPC_URL` | `base.test.ts` | `T-4: BASE_NETWORK=mainnet picks mainnet bundle (chainId 8453, USDC 0x8335...)` | W3 |
| **AC-5** | `BASE_NETWORK` absent o distinto a `'mainnet'` → testnet (84532 + `BASE_TESTNET_RPC_URL`) | `base.test.ts` | `T-5a: BASE_NETWORK absent → testnet bundle (chainId 84532)` | W3 |
| AC-5 | (idem — valor inválido también defaultea + warns) | `base.test.ts` | `T-5b: BASE_NETWORK='devnet' → testnet (chainId 84532) + console.warn called once` | W3 |
| **AC-6** | `WASIAI_A2A_CHAINS` con slug Base inválido → throw en `initAdapters()` listando supported chains | `registry.test.ts` | `T-6a: WASIAI_A2A_CHAINS='base-typo' throws "Unsupported chain 'base-typo'. Supported: ... base-sepolia, base-mainnet"` | W3 |
| AC-6 | (idem — slugs Base válidos están en lista supported) | `registry.test.ts` | `T-6b: error message includes 'base-sepolia' and 'base-mainnet' in supported list` | W3 |
| **AC-7** | `npm test` ejecuta TODA la suite incluyendo Base sin regresiones | (manual W4.4 + CI) | `T-7: full suite ≥1690 passing / 0 failing` | W4 |
| **AC-8** | `npm run build` con zero TS strict errors + zero new `any` | (manual W4.2) | `T-8: tsc -p tsconfig.build.json + grep -r ': any' src/adapters/base/ → 0` | W4 |

### Tests adicionales (no atados a AC, pero requeridos por CDs)

| CD | Test file | Test name | Wave |
|----|-----------|-----------|------|
| CD-1 | `base.test.ts` | `T-CD1: BasePaymentAdapter compiles strict (validated by tsc; no runtime assertion needed)` | W3 (verificación manual) |
| CD-3 | `w0-audit.md` (no test runtime) | EIP-712 name + version verbatim dumps from `cast call` | W0 |
| CD-10 | (no test) | Verificar que ninguna fixture base vive fuera de `src/adapters/__tests__/` | W2 (file layout) |
| CD-11 | `base.test.ts` | T-5b ya cubre el warn-once (re-uso) | W3 |
| CD-12 | `base.test.ts` | `T-CD12: bundle.payment.chainId === bundle.gasless.chain_id === bundle.chainConfig.chainId === 84532 (testnet)` | W3 |
| DT-7 | `chain-resolver.test.ts` | `T-DT7: normalizeChainSlug('base') returns 'base-mainnet'` | W1 |

### Tests pre-existentes que deben seguir pasando (regression guard, AC-7)

- `chain-resolver.test.ts` — 16 tests existentes (Kite + Avalanche aliases, CD-19 anti-prototype-pollution)
- `registry.test.ts` — 18+ tests existentes (legacy single, multi-chain CSV, CD-13 conflict warn, unsupported throw)
- `avalanche.test.ts` — 44 tests existentes (factory + payment + gasless + attestation)
- Resto suite ≥1660 tests no relacionados — verificar 0 regressions.

### Smoke local (W4.3, no en CI)

`scripts/smoke-base-sepolia-local.sh` (opcional, no comiteado o gitignored): arrancar `npm run dev` con `WASIAI_A2A_CHAINS=base-sepolia`, golpear `/.well-known/agent.json` (expectativa: HTTP 200) y un `/compose` mock (expectativa: 402 con headers x402 v2). NO valida el facilitator (offline en BASE-01). El smoke E2E real es BASE-04.

---

## 11. Análisis de paralelismo

| HU | ¿Paralelo con WKH-104? | Razón |
|----|------------------------|-------|
| **WKH-105 (BASE-02 — facilitator)** | SÍ | Repo distinto (`wasiai-facilitator`). Sin dependencia de código compartido. Coordinación: ambos PRs apuntan a `feat/wkh-base-port-v1` (rama compartida) — coordinar merges con orquestador. |
| **WKH-106 (BASE-03 — Bazaar discovery)** | NO | Necesita adapter Base inicializado para que `/api/v1/capabilities` exponga Base agents. Bloqueada por WKH-104. |
| **WKH-107 (BASE-04 — smoke E2E)** | NO | Necesita adapter + facilitator (WKH-104 + WKH-105). |
| **WKH-108 (BASE-05 — docs)** | NO | Necesita feature completo para documentar. |

### Dentro de WKH-104

- **W0 → W1 → W2 → W3 → W4** son **seriales**. No hay oportunidades de paralelismo intra-HU realistas (los tests dependen del adapter, el registry depende de los types, etc).
- **W2.1..W2.6** (los 6 archivos del adapter) podrían paralelizarse internamente si W1 está listo, pero dado que `payment.ts` (W2.5) importa de `chain.ts` (W2.1), el orden W2.1 → W2.2..W2.6 es el natural.

---

## 12. Riesgos identificados (heredados + nuevos)

| Riesgo | Severidad | Mitigación |
|--------|-----------|------------|
| EIP-712 domain `name`/`version` incorrecto en Base USDC | **ALTA** — firmas inválidas (BASE-04 smoke E2E falla) | CD-3 W0 verification obligatoria + escape hatch env override per-network ya documentado en `.env.example`. |
| Regression en Avalanche/Kite por cambio en `chain-resolver.ts` | ALTA | CD-2 prohibido tocar adapters existentes. Tests pre-existentes ≥1660 deben pasar (AC-7). Architect verificó en F2 que `chain-resolver.ts` solo agrega entries al `SLUG_ALIASES` sin modificar la lógica de `normalizeChainSlug()` ni `resolveChainKey()`. |
| `ChainKey` union extension rompe switch exhaustivos | BAJA — verificada en F2 | `grep -rn "switch.*ChainKey\\|: ChainKey)" src --include="*.ts"` retornó solo `registry.ts:buildBundle()` que es chain de `if/else if`. La extensión NO rompe nada porque las nuevas variants se manejan explícitamente en W3.1. |
| viem chain `baseSepolia` no disponible | RESUELTO en F2 | DT-4 verificado con Read de node_modules — disponible en viem ^2.47.6. |
| Facilitator no soporta Base en BASE-01 | BAJA — esperado | DT-11 documenta el caveat. Los tests mockean fetch. Smoke W4.3 no valida `verify` exitoso (cualquier 4xx del facilitator real es aceptable y NO falla el build). |
| Test mock collision entre `kite-ozone`, `avalanche`, `base` factories | BAJA | Patrón establecido en `registry.test.ts`: `vi.mock('../<adapter>/index.js', ...)`. El test de Base agrega el suyo sin interferir. |
| Smoke local W4.3 sin facilitator → confusión sobre éxito | BAJA | Documentar en `w0-audit.md` que un 4xx del facilitator es OK en BASE-01; sólo se valida startup + handler routing. |
| Coordinación de merges en branch compartida `feat/wkh-base-port-v1` con WKH-105 (otro repo) | BAJA | Solo coordinación humana (orquestador); ambas HUs son ortogonales en archivos. |
| `BASE_NETWORK=devnet` accidental silenciado | BAJA | CD-11 + DT-2 ampliado: warn-once. |

---

## 13. Decisión final de sizing + readiness

**Sizing**: **QUALITY** confirmado (sin downgrade vs work-item). Justificación:
1. Cross-cutting (`chain-resolver.ts`, `types.ts`, `registry.ts`) — un alias mal puesto silencia pagos en Kite/Avalanche prod.
2. Verificación onchain EIP-712 NO es trabajo de LAUNCH.
3. Producción live (3 consumidores) — cero tolerancia a regressions.

**Alternativas evaluadas**:
- ¿Reducir a `LAUNCH`? **No** — el work-item ya razona que `chain-resolver.ts` toca prod path.
- ¿Combinar con WKH-105 (BASE-02)? **No** — repos distintos, mayor blast radius, harder review.
- ¿`'base'` alias → undefined en vez de `'base-mainnet'`? **Mantener `'base-mainnet'`** (DT-7) por convención de la comunidad Base; documentado para revisión en CR si Adversary objeta.

---

## 14. Readiness Check — listo para F2.5 + F3

Marcar todos como ✅ antes de SPEC_APPROVED:

- [x] Work item leído íntegro y resumido en §2
- [x] Stack confirmado (viem ^2.47.6, vitest ^4.1, TypeScript ^5.4 strict, Fastify ^5.8)
- [x] ≥6 exemplars verificados con Read (todos existen en disco): `avalanche/index.ts`, `avalanche/payment.ts`, `avalanche/chain.ts`, `avalanche/gasless.ts`, `avalanche/attestation.ts`, `avalanche/identity.ts`, `chain-resolver.ts`, `registry.ts`, `types.ts`, `avalanche.test.ts`, `chain-resolver.test.ts`, `payment.contract.test.ts`, `registry.test.ts`, `node_modules/viem/chains/definitions/base.ts`, `node_modules/viem/chains/definitions/baseSepolia.ts`
- [x] Auto-Blindaje histórico revisado (`084-wkh-69`, `087-wkh-59`, `086-wkh-multichain`) — lecciones aplicadas en CD-10/11/12
- [x] DT-4 RESUELTO en F2 (viem expone `base` + `baseSepolia` directamente)
- [x] DT-1 con hipótesis + plan de verificación W0 (CD-3) — `[NEEDS CLARIFICATION]` convertido en **acción de W0 con escape hatch documentado** (`.env.example` ya tiene `BASE_SEPOLIA_USDC_EIP712_VERSION` override)
- [x] DT-7 (alias `'base'` → mainnet) documentado con trade-off + fallback aceptable
- [x] 9 ACs (work-item AC-1..AC-8) mapeados a tests específicos con `it()` clauses y archivo
- [x] CDs heredados (CD-1..CD-9) preservados + 3 nuevos (CD-10..CD-12) derivados de Auto-Blindaje
- [x] Waves W0..W4 con archivos y comandos exactos
- [x] `.env.example` patch listo (§7)
- [x] Patrones de código en §6 referenciables desde Story File
- [x] Riesgos identificados con severidad + mitigación
- [x] Análisis de paralelismo con otras HUs BASE (105..108)

### ⚠️ Pendientes que NO bloquean SPEC_APPROVED (van a Dev en F3 W0)

1. **W0.4–W0.6 — VERIFIED 2026-05-19 por orquestador AUTO via WKH-105 sibling Dev**:
   El Dev de WKH-105 (BASE-02 facilitator) ya ejecutó `cast call` durante su F3 en paralelo
   y confirmó **divergencia entre Sepolia y Mainnet** (hipótesis original del SDD era incorrecta para Sepolia):

   | Network | USDC address | `name()` literal | `version` | Status vs hipótesis SDD |
   |---------|--------------|-----------------|-----------|------------------------|
   | Base Sepolia (84532) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | **`"USDC"`** | `"2"` | ⚠️ DIFIERE de `'USD Coin'` |
   | Base Mainnet (8453) | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | **`"USD Coin"`** | `"2"` | ✅ Match hipótesis |

   **Acción para Dev WKH-104 W0**: NO re-verificar via `cast call` (ya hecho por sibling).
   Implementar `base/payment.ts` con constants per-network:
   ```ts
   const USDC_EIP712_NAME_SEPOLIA = 'USDC';      // Base Sepolia (verified onchain 2026-05-19)
   const USDC_EIP712_NAME_MAINNET = 'USD Coin';  // Base Mainnet (verified onchain 2026-05-19)
   const USDC_EIP712_VERSION = '2';              // Both networks
   ```
   Documentar en W0 audit la fuente del valor (sibling WKH-105 verification, no auto-verification).

   El Dev DEBE igualmente ejecutar `cast call` como sanity check (no como descubrimiento)
   y registrar el output verbatim en `w0-audit.md` — esto cumple CD-3 estricto y deja paper trail.

   Referencia: ver `/home/ferdev/.openclaw/workspace/wasiai-facilitator/` branch `feat/base-support`
   commit `7d86b37` para la implementación de WKH-105 con las constants verificadas.
2. **W0.7**: re-validar `grep ChainKey` en F3 W0 (smoke de la verificación F2). Architect confirmó en F2 que solo `registry.ts:buildBundle()` es callsite — F3 lo re-confirma post-W1.1 para detectar nuevos callers introducidos entre F2 y F3.
3. **W4.3 smoke**: requiere `OPERATOR_PRIVATE_KEY` válido (test wallet — no producción). Dev usa la wallet test del .env.local. Output documentado en `w0-audit.md` o appendix.

Ningún pendiente es bloqueante de SPEC_APPROVED — todos están cubiertos por procedimiento + escape hatch.

---

## 15. Próximos pasos

1. **Humano**: revisar SDD + gate SPEC_APPROVED ("apruebo SDD" / "SPEC_APPROVED").
2. **Architect F2.5**: generar `story-file.md` con el contrato detallado para Dev (archivos exactos, snippets verbatim, anti-hallucination checklist específico).
3. **Dev F3**: ejecutar W0 → W1 → W2 → W3 → W4 wave por wave, documentando hallazgos en `w0-audit.md` y `auto-blindaje.md` si surgen errores.
4. **Adversary F3 AR**: review post-implementación (foco en CD-2, CD-3, CD-12, paths de regression Avalanche/Kite).
5. **Adversary F3 CR**: code review con archivo:línea.
6. **QA F4**: validación AC con evidencia.
7. **Docs F5**: DONE report + actualizar `_INDEX.md` (088 in progress → DONE).
8. **Merge**: SOLO después de WKH-105 + WKH-107 verdes (estrategia BASE port Fase 1 → Fase 2 staging).

---

## 16. Apéndice — Verificaciones literales de F2

### 16.1 viem chains exports (cmd: `grep "^export.*\\bbase\\b\\|^export.*baseSepolia" node_modules/viem/chains/index.ts`)

```
export { base, basePreconf } from './definitions/base.js'
export { baseSepolia, baseSepoliaPreconf } from './definitions/baseSepolia.js'
```

### 16.2 viem `base` chain definition (extracto)

```ts
export const base = defineChain({
  id: 8453,
  name: 'Base',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://mainnet.base.org'] } },
  blockExplorers: { default: { name: 'Basescan', url: 'https://basescan.org' } },
  // ...
})
```

### 16.3 viem `baseSepolia` chain definition (extracto)

```ts
export const baseSepolia = defineChain({
  id: 84532,
  network: 'base-sepolia',
  name: 'Base Sepolia',
  testnet: true,
  rpcUrls: { default: { http: ['https://sepolia.base.org'] } },
  blockExplorers: { default: { name: 'Basescan', url: 'https://sepolia.basescan.org' } },
  // ...
})
```

### 16.4 ChainKey callsite grep (cmd: `grep -rn "switch.*ChainKey\\|: ChainKey)" src --include="*.ts"`)

```
src/adapters/registry.ts:40:async function buildBundle(chainKey: ChainKey): Promise<AdaptersBundle> {
src/adapters/registry.ts:149:function resolveBundleOrThrow(chainKey?: ChainKey): AdaptersBundle {
src/adapters/registry.ts:162:export function getPaymentAdapter(chainKey?: ChainKey): PaymentAdapter {
src/adapters/registry.ts:172:export function getGaslessAdapter(chainKey?: ChainKey): GaslessAdapter {
src/adapters/registry.ts:187:export function getChainConfig(chainKey?: ChainKey): {
```

Único callsite con dispatch por valor: `registry.ts:40 buildBundle()`. Los demás reciben `chainKey` como parámetro opaco. **Confirma que extender la union NO rompe nada que no esté en W3.1.**

### 16.5 Package.json relevant deps (cmd: `grep -E '"(viem|vitest|typescript|fastify)"' package.json`)

```
"fastify": "^5.8.4",
"viem": "^2.47.6"
"typescript": "^5.4.0",
"vitest": "^4.1.4"
```

Confirma stack del `project-context.md`.

### 16.6 Avalanche test baseline (cmd: `wc -l src/adapters/__tests__/avalanche.test.ts`)

`avalanche.test.ts` ≈ 427 LOC, ~44 tests. Es el target structural para `base.test.ts`.

---

**Fin SDD #088.**
