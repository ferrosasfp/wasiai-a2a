# SDD — [WKH-090 / HU-090] Segundo rail de pago — adapter Tempo / MPP

> **Fase**: F2 (SDD). **Mode**: QUALITY (money-path). **NNN**: 146.
> **Branch**: `feat/146-hu-090-tempo-mpp-rail`.
> **Input**: `work-item.md` (F1, HU_APPROVED) + `.nexus/project-context.md`.
> **Estado**: listo para gate `SPEC_APPROVED`. Cero `[NEEDS CLARIFICATION]`
> abiertos (la política de auto-routing es Scope OUT documentado — HU-091).

---

## 0. Resumen ejecutivo del diseño

Se agrega un **cuarto rail de pago** (`tempo-testnet`) como un adapter aditivo
en `src/adapters/tempo/`, siguiendo el patrón de fábrica de Base
(`createBaseAdapters`). Dado que el path EVM de MPP tiene **"x402 exact
compatibility"** (verificado por el orquestador vía web), el adapter **reusa la
maquinaria x402/EIP-3009 existente** (`SettleRequest`/`X402Proof`/`VerifyResult`/
`QuoteResult` de `types.ts`) sin inventar un contrato de tipos paralelo. El
mapeo MPP → contrato existente es:

| Paso MPP | Header HTTP | Mapea a (contrato existente) |
|----------|-------------|------------------------------|
| **Challenge** | `WWW-Authenticate` (402) | `PaymentAdapter.quote()` + `PaymentAdapter.sign()` (x402 challenge/quote) |
| **Credential** | `Authorization` | `SettleRequest`/`X402Proof` (`authorization` + `signature` + `network`) → `settle()`/`verify()` |
| **Receipt** | `Payment-Receipt` | `AttestationAdapter.attest()` (stub v1, mirror Base) |

El rail se entrega **detrás de un feature-flag `TEMPO_ADAPTER_ENABLED` default
OFF**. Con flag OFF el comportamiento es **byte-idéntico** al estado actual: el
bundle de Tempo no se construye, ningún módulo de `src/adapters/tempo/` se
importa en el hot path, y forzar `tempo-testnet` por header/manifest devuelve el
mismo `CHAIN_NOT_SUPPORTED` que cualquier slug no inicializado.

**Gasless v1**: se ship un **stub deshabilitado** (graceful degradation, patrón
pre-WKH-138) — NO se construye el relay EIP-3009 real. `AdaptersBundle.gasless`
es un campo **no-nullable**, por lo que Tempo debe proveer una instancia
`GaslessAdapter`; la instancia v1 es un stub que devuelve `enabled:false` en
`status()` y lanza `GaslessNotSupportedError` (501) en `transfer()`. El relay
gasless real queda diferido a una HU follow-up (ver §6 / DT-7).

---

## 1. Context Map — archivos leídos y patrón extraído

| Archivo (verificado con Read) | Por qué | Patrón extraído |
|---|---|---|
| `src/adapters/types.ts` | Contrato compartido | `ChainKey` es unión cerrada (L124-130); `AdaptersBundle` (L137-147) con `payment`/`attestation`/`gasless` **no-nullable** + `identity` nullable + `chainConfig`; `PaymentAdapter`/`SettleRequest`/`X402Proof`/`VerifyResult`/`QuoteResult` (L11-105) son el vocabulario x402/EIP-3009 a reusar (CD-3) |
| `src/adapters/base/index.ts` | **Factory de referencia (DT-2)** | `createBaseAdapters(opts?: { network })` → `Promise<AdaptersBundle>`, `network` explícito, imports dinámicos de payment/attestation/gasless, **SIN mutación de `process.env`** |
| `src/adapters/base/chain.ts` | Resolución de network | `getBaseNetwork(opts?)` prioridad `opts` > env > fallback conservador + `getBaseChain(network)`; warn-once ante env inválido (defensa-en-profundidad) |
| `src/adapters/base/payment.ts` | **Mirror del adapter x402** | `BasePaymentAdapter implements PaymentAdapter`: firma EIP-3009 `TransferWithAuthorization` contra USDC, POST canónico x402 v2 a facilitator con `Authorization: Bearer` opcional; `quote()` honra el USD real vía `parseUnits(usd.toFixed(dec), dec)` (money-path fix MNR-1); network tag `eip155:<chainId>` |
| `src/adapters/base/attestation.ts` | Stub de attestation | `BaseAttestationAdapter implements AttestationAdapter`: `attest()` devuelve `{ txHash:'0x0', proofUrl:'' }` (ERC-8004 out of scope MVP) |
| `src/adapters/base/gasless.ts` | Referencia de gasless real (NO se copia en v1) | Relay EIP-3009 operator-firmado; cap chain-aware; `waitForTransactionReceipt` con timeout; cast `as Chain` para OP-stack. **Diferido** para Tempo v1 |
| `src/adapters/base/identity.ts` | Identity null | `export const baseIdentity = null` — Tempo también `identity: null` |
| `src/adapters/kite-ozone/index.ts` | **Anti-patrón a NO copiar (DT-2)** | Muta temporalmente `process.env.KITE_NETWORK` (DT-I, deuda `TD-NEW-KITE-PARAMS`). Tempo NO hace esto |
| `src/adapters/kite-ozone/chain.ts` | **Exemplar de chain custom** | `defineChain({ id, name, nativeCurrency, rpcUrls, blockExplorers, testnet })` — Tempo NO está en `viem/chains`, se define igual con `defineChain` |
| `src/adapters/registry.ts` | Dispatcher + init | `SUPPORTED_CHAINS` const + `isSupportedChain` + `buildBundle(chainKey)` (dispatch por slug) + `initAdapters()` (CSV `WASIAI_A2A_CHAINS` > legacy > default, fail-fast por slug inválido) + `getAdaptersBundle` (no-throw, retorna `undefined` en miss) |
| `src/adapters/chain-resolver.ts` | Resolución de rail | `SLUG_ALIASES` (proto-null, CD-19) + `normalizeChainSlug` + `resolveChainKey` (header > manifest > undefined). Es puro, NO lee env |
| `src/adapters/errors.ts` | Errores tipados | `GaslessNotSupportedError` (501, `gasless_not_supported_on_chain`) — el stub de gasless v1 lo usa; `GaslessTransferError` (500) |
| `src/adapters/__tests__/payment.contract.test.ts` | **Patrón de test de contrato** | mock de `getLogger`, mock de `viem.createWalletClient`, `vi.stubGlobal('fetch')`, asserts de shape de `settle`/`verify`/`quote`/`sign` |
| `src/adapters/__tests__/chain-resolver.test.ts` | Patrón de test de resolver | asserts de aliases, prioridad header>manifest, CD-19 proto-pollution |
| `src/routes/gasless.ts`, `src/routes/auth/deposit.ts`, `src/routes/capabilities.ts` | Consumers | **Double-guard** de `CHAIN_NOT_SUPPORTED`: (1) `resolveChainKey/normalizeChainSlug` → si `undefined` → `CHAIN_NOT_SUPPORTED`; (2) `getAdaptersBundle(chainKey)` → si `undefined` (no inicializado) → `CHAIN_NOT_SUPPORTED`. Esto es lo que hace que el flag OFF de Tempo caiga naturalmente en `CHAIN_NOT_SUPPORTED` (guard 2) |

### Auto-Blindaje histórico consultado (últimas HUs DONE)

- **WKH-133** (`134-.../auto-blindaje.md`) y **WKH-138** (`140-.../auto-blindaje.md`)
  documentan **el mismo patrón recurrente de fricción de tipos con viem** (≥2 HUs):
  (a) `walletClient.account` es `Account | undefined` en el tipo genérico
  `ReturnType<typeof createWalletClient>` → hay que coalescer `?? null` al pasarlo
  a `writeContract`/`sendTransaction`; (b) el `PublicClient` de una chain OP-stack
  no es asignable al cache module-level genérico → castear la chain `as Chain`. Se
  heredan como **CD-8** para prevenir su repetición en el adapter Tempo.
- **WKH-133** auto#3: `waitForTransactionReceipt` en timeout **THROWS** (no retorna).
  Relevante solo si se implementa gasless real; en v1 el gasless es un stub, así que
  se documenta para la HU follow-up (DT-7), no aplica al código de esta HU.
- **WKH-141** auto: validar strings de ejemplo del Story File contra las CDs antes
  de copiarlos literal — nota de proceso para F2.5 (no aplica a código de adapter).

---

## 2. Decisiones técnicas (DT-N)

- **DT-1 — Reuso del contrato x402 (hereda CD-3)**: el adapter Tempo implementa
  `PaymentAdapter` reusando `SettleRequest`/`X402Proof`/`VerifyResult`/
  `QuoteResult` tal cual. El "Credential" de MPP puebla `authorization`+
  `signature`+`network`; el "Receipt" se registra vía `AttestationAdapter.attest()`.
  NO se crea un tipo de proof paralelo. Justificación: "x402 exact compatibility"
  confirmada en el path EVM de MPP; el vocabulario coincide byte-a-byte.

- **DT-2 — Factory patrón Base (NO patrón Kite)**: `createTempoAdapters(opts?:
  { network?: TempoNetwork })` recibe `network` explícito y hace imports
  dinámicos, **SIN mutar `process.env`**. Prohibido replicar el DT-I de
  `createKiteOzoneAdapters` (deuda `TD-NEW-KITE-PARAMS`).

- **DT-3 — `ChainKey` sólo `'tempo-testnet'` en v1**: se extiende la unión con
  `'tempo-testnet'`. `'tempo-mainnet'` **NO se agrega** (CD-2, política
  testnet-only, mismo criterio que kite/avalanche/base mainnet).

- **DT-4 — Feature-flag `TEMPO_ADAPTER_ENABLED`, default OFF**: env-driven,
  `=== 'true'` para activar (convención existente `GASLESS_ENABLED === 'true'`).
  Gatea la **inicialización del rail en `initAdapters()`** vía un set de chains
  soportadas flag-aware (`getSupportedChains()`), NO vía exclusión estática. Con
  flag OFF, `tempo-testnet` no pertenece al set soportado → si aparece en el CSV,
  `initAdapters()` falla-rápido en boot (consistente con el trato actual de slugs
  no soportados); si un caller lo fuerza en runtime, el double-guard devuelve
  `CHAIN_NOT_SUPPORTED`. Mismo criterio aditivo/apagado/byte-idéntico de WKH-141
  (APP bridge) y WKH-133 (reputation write-back).

- **DT-5 — Chain custom vía `defineChain`**: Tempo testnet NO está en
  `viem/chains`; se define con `defineChain({ id, name, nativeCurrency, rpcUrls,
  blockExplorers, testnet:true })` igual que `kite-ozone/chain.ts`. El `id`
  (chainId), la RPC URL y la dirección/decimales de `pathUSD` son
  **[VERIFY-AT-IMPL en F3]** (se obtienen de `tempo.xyz/developers` + SDK). El
  esqueleto compila con placeholders documentados; el Dev los sustituye en F3
  con los valores oficiales que le pase el orquestador.

- **DT-6 — Resolver: aliases estáticos de slug, alias numérico diferido**: se
  agregan a `SLUG_ALIASES` de `chain-resolver.ts` los aliases de slug de Tempo
  (`'tempo-testnet'` → `'tempo-testnet'`, `'tempo'` → `'tempo-testnet'`) de forma
  **estática** (el resolver es puro y no lee el flag — igual que todos los demás
  rails). El alias del **chainId numérico** de Tempo es **[VERIFY-AT-IMPL en
  F3]** (requiere el chainId real). El gateo del flag vive SOLO en el registry;
  el resolver conocer el slug NO expone el rail (el bundle no existe con flag OFF
  → guard 2 devuelve `CHAIN_NOT_SUPPORTED`). Esto satisface AC-4 ("sin lógica
  especial hardcodeada").

- **DT-7 — Gasless v1 = stub deshabilitado (real diferido)**: `AdaptersBundle.
  gasless` es no-nullable, por lo que Tempo provee una instancia. La v1 es un
  **stub** (`TempoGaslessAdapter`) que en `status()` devuelve `enabled:false` /
  `funding_state:'disabled'` y en `transfer()` lanza `GaslessNotSupportedError`
  (501). NO se implementa el relay EIP-3009 real (mirror de `base/gasless.ts`)
  porque el soporte gasless de TIP-20/pathUSD **no está confirmado on-chain** y
  requeriría funding de gas del operator en Tempo. Resolución del Missing Input
  "TIP-20 gasless": **v1 = stub; real diferido a HU follow-up** (sugerida
  `WKH-090b`) una vez que se confirme el path `transferWithAuthorization` de
  pathUSD en Tempo testnet. Cuando se implemente, aplicar las lecciones de
  WKH-138 (CD-8 + timeout-throws de `waitForTransactionReceipt`).

- **DT-8 — Facilitator para Tempo es [VERIFY-AT-IMPL], NO bloquea DONE**: el
  `settle()`/`verify()` de Tempo POSTea al facilitator x402 igual que Base, con
  el network tag `eip155:<tempoChainId>`. Que el `wasiai-facilitator` settlee
  realmente la red de Tempo es una dependencia operativa **[VERIFY-AT-IMPL en
  F3]**; NO bloquea el DONE de esta HU porque el rail ship **OFF** y los tests
  de contrato **mockean `fetch`** (mismo enfoque que `base.test.ts`). La
  activación real (flag ON + facilitator live) es decisión operativa post-DONE.

---

## 3. Constraint Directives (CD-N)

Heredados del work-item (CD-1..CD-5) + específicos de F2 (CD-6..CD-9):

- **CD-1 (hereda)**: OBLIGATORIO `TEMPO_ADAPTER_ENABLED` default OFF en todo
  ambiente — ningún despliegue activa el rail automáticamente.
- **CD-2 (hereda)**: PROHIBIDO agregar `'tempo-mainnet'` a `ChainKey`/
  `SUPPORTED_CHAINS`/`SLUG_ALIASES` en esta HU.
- **CD-3 (hereda)**: OBLIGATORIO reusar `SettleRequest`/`X402Proof`/
  `VerifyResult`/`QuoteResult`. PROHIBIDO un tipo de proof paralelo para Tempo.
- **CD-4 (hereda)**: Ownership Guard (`owner_ref`) en cualquier tabla/query nueva.
  **Esta HU NO introduce tablas ni queries** (es puro wiring de adapter) → CD-4
  se satisface vacuamente. Si en F3 aparece cualquier acceso a DB, aplicar el
  guard sin excepción.
- **CD-5 (hereda)**: OBLIGATORIO tests de contrato equivalentes a los de
  Kite/Avalanche/Base ANTES de que el flag pueda activarse.
- **CD-6 (byte-idéntico OFF)**: PROHIBIDO alterar el comportamiento de los rails
  existentes (Kite/Avalanche/Base) o el path de settle de cualquiera de ellos.
  Con `TEMPO_ADAPTER_ENABLED` ausente/`!= 'true'`: (a) `getInitializedChainKeys()`
  NO incluye `tempo-testnet`; (b) ningún módulo de `src/adapters/tempo/` se
  importa en el hot path; (c) `getSupportedChains()` retorna exactamente los 6
  slugs actuales. Verificado por test de no-op (AC-2).
- **CD-7 (choke-point del gate)**: el gateo del flag vive ÚNICAMENTE en
  `registry.ts` (`getSupportedChains()`/`buildBundle`). PROHIBIDO dispersar
  checks del flag en `chain-resolver.ts`, rutas, o el adapter mismo. El resolver
  y el adapter NO leen `TEMPO_ADAPTER_ENABLED`.
- **CD-8 (viem type-safety — hereda de WKH-133/138)**: al pasar
  `walletClient.account` a `writeContract`/`sendTransaction` usar `?? null`
  (nunca `!`, prohibido por biome). Si se cachea un `PublicClient` de una chain
  OP-stack en variable module-level genérica, castear la chain `as Chain`.
  Aplica al gasless real diferido (DT-7); si el stub v1 no firma nada, esta CD
  queda latente para el follow-up.
- **CD-9 (sin auto-routing)**: PROHIBIDO construir selección de rail por
  costo/latencia/geografía (HU-091, Scope OUT). El v1 resuelve el rail SOLO por
  el mecanismo explícito existente (header `x-payment-chain` > manifest > default
  del CSV).

---

## 4. Waves de implementación

> Orden serial entre waves; paralelismo posible dentro de W1. Cada wave deja el
> repo compilando (`tsc --noEmit`) y con flag OFF byte-idéntico.

### W0 — Tipos y chain (serial, contratos)
1. **`src/adapters/types.ts`** — extender la unión `ChainKey` con
   `'tempo-testnet'` (SOLO type; cero efecto runtime). NO tocar `AdaptersBundle`
   ni los shared types. NO agregar `'tempo-mainnet'` (CD-2).
2. **`src/adapters/tempo/chain.ts`** — `defineChain` para Tempo testnet
   (`id`/`rpcUrls` = **[VERIFY-AT-IMPL en F3]**, placeholder documentado);
   `type TempoNetwork = 'testnet'`; `getTempoNetwork(opts?)` (prioridad `opts` >
   `TEMPO_NETWORK` env > `'testnet'`, warn-once ante valor inválido, mirror
   `base/chain.ts`); `getTempoChain(network)`. Reservar `tempo-mainnet` como
   comentario, sin definir.

   *Invariante W0*: nada importa `src/adapters/tempo/*` todavía → byte-idéntico.

### W1 — Módulos del adapter Tempo (paralelizable)
3. **`src/adapters/tempo/payment.ts`** — `TempoPaymentAdapter implements
   PaymentAdapter`, **mirror restringido de `base/payment.ts`**: firma EIP-3009
   `TransferWithAuthorization` contra `pathUSD`, POST canónico x402 v2 al
   facilitator con `Authorization: Bearer` opcional; `quote()` con
   `parseUnits(usd.toFixed(decimals), decimals)` (money-path MNR-1); network tag
   `eip155:<tempoChainId>`. Constantes `pathUSD` (address/decimales/EIP-712
   name/version), RPC y chainId = **[VERIFY-AT-IMPL en F3]** con env override +
   fallback + warn-once (mirror `getUsdcAddress`). Comentarios que mapean
   Challenge→`quote`/`sign`, Credential→`settle`/`verify` (DT-1).
4. **`src/adapters/tempo/attestation.ts`** — `TempoAttestationAdapter implements
   AttestationAdapter`, stub mirror de `base/attestation.ts`: `attest()` devuelve
   `{ txHash:'0x0', proofUrl:'' }` (registra el "Receipt" de MPP — mapping DT-1,
   impl real fuera de v1). `verify()` → `true`.
5. **`src/adapters/tempo/gasless.ts`** — `TempoGaslessAdapter implements
   GaslessAdapter` **stub deshabilitado** (DT-7): `transfer()` lanza
   `GaslessNotSupportedError('tempo-testnet', ...)`; `status()` devuelve
   `{ enabled:false, network:'tempo-testnet', supportedToken:null,
   operatorAddress:null, funding_state:'disabled', ... }`. NO relay real.
6. **`src/adapters/tempo/index.ts`** — `createTempoAdapters(opts?: { network?:
   TempoNetwork }): Promise<AdaptersBundle>` patrón Base (DT-2): imports
   dinámicos, `identity: null`, `chainConfig` con `name`/`chainId`/`explorerUrl`
   (explorerUrl = **[VERIFY-AT-IMPL en F3]**). SIN mutación de `process.env`.

### W2 — Wiring registry + resolver (serial, gate del flag)
7. **`src/adapters/registry.ts`** —
   - `isTempoEnabled(): boolean` → `process.env.TEMPO_ADAPTER_ENABLED === 'true'`.
   - `getSupportedChains(): readonly ChainKey[]` → base 6 + `'tempo-testnet'`
     SOLO si `isTempoEnabled()`. `isSupportedChain` usa `getSupportedChains()`.
   - branch en `buildBundle`: `if (chainKey === 'tempo-testnet') { const
     { createTempoAdapters } = await import('./tempo/index.js'); return
     createTempoAdapters({ network: 'testnet' }); }`.
   - CD-6: con flag OFF, `getSupportedChains()` retorna los 6 slugs actuales →
     byte-idéntico. NO tocar `initAdapters` salvo el swap `SUPPORTED_CHAINS` →
     `getSupportedChains()` en `isSupportedChain` y en los mensajes de error.
8. **`src/adapters/chain-resolver.ts`** — agregar a `SLUG_ALIASES` (estático):
   `'tempo-testnet': 'tempo-testnet'`, `'tempo': 'tempo-testnet'`. El alias del
   chainId numérico = **[VERIFY-AT-IMPL en F3]** (comentario TODO). NO leer el
   flag (CD-7).

### W3 — Tests (obligatorio, CD-5)
9. Ver §6 (plan de tests). Un test ≥ por AC + no-regresión.

---

## 5. Exemplars verificados (paths confirmados con Read)

| Rol | Path (existe, confirmado) |
|---|---|
| Factory a copiar | `src/adapters/base/index.ts` |
| Chain custom (`defineChain`) | `src/adapters/kite-ozone/chain.ts` |
| Resolución de network + warn-once | `src/adapters/base/chain.ts` |
| Adapter x402 a mirrorar | `src/adapters/base/payment.ts` |
| Attestation stub | `src/adapters/base/attestation.ts` |
| Gasless stub error tipado | `src/adapters/errors.ts` (`GaslessNotSupportedError`) |
| Anti-patrón (NO copiar) | `src/adapters/kite-ozone/index.ts` (DT-I env mutation) |
| Dispatcher + init a extender | `src/adapters/registry.ts` |
| Resolver a extender | `src/adapters/chain-resolver.ts` |
| Contrato compartido | `src/adapters/types.ts` |
| Test de contrato patrón | `src/adapters/__tests__/payment.contract.test.ts` |
| Test de resolver patrón | `src/adapters/__tests__/chain-resolver.test.ts` |
| Consumers double-guard | `src/routes/gasless.ts`, `src/routes/auth/deposit.ts` |

---

## 6. Plan de tests (≥1 por AC + no-regresión)

Archivos de test nuevos/modificados:

- **NUEVO `src/adapters/__tests__/tempo.payment.contract.test.ts`** (mirror de
  `payment.contract.test.ts`):
  - **AC-3**: `settle()` mapea el "Credential" → `SettleRequest`
    (`authorization`+`signature`+`network`) y devuelve shape `SettleResult`
    (mock `fetch` OK → `{ txHash, success:true }`); `verify()` devuelve
    `VerifyResult`; `quote(1)`/`quote(0.001)` honran el USD (no hardcode);
    `sign()` devuelve `{ xPaymentHeader, paymentRequest }`. Confirma reuso de
    tipos compartidos (compile-time) + shapes runtime. Mock `viem.
    createWalletClient` + `getLogger` + `fetch` como el exemplar.
  - **AC-3 (Receipt)**: `TempoAttestationAdapter.attest()` devuelve
    `{ txHash, proofUrl }` (mapping del "Receipt").
  - **Gasless stub (DT-7)**: `TempoGaslessAdapter.transfer()` lanza
    `GaslessNotSupportedError`; `status()` → `enabled:false`/`funding_state:
    'disabled'`.

- **MODIFICAR `src/adapters/__tests__/chain-resolver.test.ts`**:
  - **AC-4**: `normalizeChainSlug('tempo-testnet')` → `'tempo-testnet'`;
    `normalizeChainSlug('tempo')` → `'tempo-testnet'`; trim/lowercase; el alias
    numérico se agrega junto al `[VERIFY-AT-IMPL]` en F3. `resolveChainKey`
    header>manifest con `tempo-testnet`. CD-19: proto keys siguen `undefined`.
  - **AC-6**: assert de que NO existe lógica de auto-routing (el resolver sólo
    traduce el slug explícito; no hay branch por costo/latencia).

- **MODIFICAR `src/adapters/__tests__/registry.test.ts`**:
  - **AC-1**: con `TEMPO_ADAPTER_ENABLED='true'` y `WASIAI_A2A_CHAINS` que
    incluye `tempo-testnet` → `getInitializedChainKeys()` incluye
    `tempo-testnet`; `getAdaptersBundle('tempo-testnet')` retorna un bundle
    completo (`payment`/`attestation`/`gasless`/`chainConfig`); los bundles
    existentes (kite/avalanche/base) quedan intactos.
  - **AC-2 (no-op, byte-idéntico)**: sin `TEMPO_ADAPTER_ENABLED` (default OFF),
    con el mismo CSV de los 6 rails → `getInitializedChainKeys()` idéntico al
    baseline; `getSupportedChains()` retorna exactamente los 6 slugs;
    `getAdaptersBundle('tempo-testnet')` → `undefined` (no importado).
  - **AC-5**: flag OFF + intento de forzar `tempo-testnet` →
    `getAdaptersBundle('tempo-testnet')` es `undefined` (choke-point del
    double-guard) → los consumers responden `CHAIN_NOT_SUPPORTED`. (Opcional: un
    test de ruta en `gasless.ts`/`deposit.ts` que confirme el 4xx
    `CHAIN_NOT_SUPPORTED` end-to-end.)
  - Flag OFF + `tempo-testnet` en el CSV → `initAdapters()` lanza "Unsupported
    chain 'tempo-testnet'" (fail-fast en boot, DT-4).

- **NO-REGRESIÓN (CD-6)**: correr sin cambios `avalanche.test.ts`, `base.test.ts`,
  `payment.contract.test.ts`, `payment.mainnet.test.ts`, `kite-factory.test.ts`,
  `gasless.contract.test.ts` y el resto de la suite → todos verdes (los rails
  existentes byte-idénticos). `tsc --noEmit` + `biome` limpios.

- **AC-7**: no es testeable por código — se cubre documentalmente: chainId/RPC/
  `pathUSD`/headers marcados `[VERIFY-AT-IMPL en F3]` en `chain.ts`/`payment.ts`/
  `chain-resolver.ts`.

---

## 7. `[VERIFY-AT-IMPL en F3]` — resoluciones diferidas (grounded desde `tempo.xyz/developers` + SDK)

| # | Dato | Dónde se usa | Fuente |
|---|------|--------------|--------|
| V1 | chainId numérico de Tempo testnet | `tempo/chain.ts` (`defineChain.id`), `tempo/payment.ts` (network tag `eip155:<id>`), alias numérico en `chain-resolver.ts` | faucet/SDK docs |
| V2 | RPC URL de Tempo testnet | `tempo/chain.ts` (`rpcUrls`) | docs |
| V3 | Dirección + decimales de `pathUSD` (probable 6, mirror USDC) | `tempo/payment.ts` (token/EIP-3009) | SDK/faucet |
| V4 | EIP-712 domain `name`/`version` de `pathUSD` | `tempo/payment.ts` (`signTypedData.domain`) | contrato pathUSD on-chain |
| V5 | Explorer URL | `tempo/index.ts` (`chainConfig.explorerUrl`) | docs |
| V6 | Detalle exacto de headers MPP `WWW-Authenticate`/`Authorization`/`Payment-Receipt` (confirmar que el mapeo x402 aplica sin campos extra) | comentarios de mapeo en `payment.ts` | spec MPP |
| V7 | Soporte del `wasiai-facilitator` para el network tag de Tempo | operativo (activación post-DONE) | facilitator ops |
| V8 | Confirmación de soporte gasless (`transferWithAuthorization`) de TIP-20/pathUSD | HU follow-up `WKH-090b` (gasless real) | SDK/contrato |

Ninguno bloquea el DONE de esta HU: el rail ship **OFF**, los tests **mockean
`fetch`**, y los placeholders compilan con env override + fallback documentado.

---

## 8. Readiness Check

- [x] Work-item leído íntegro (Scope IN/OUT, ACs EARS, DT/CD, Missing Inputs).
- [x] `project-context.md` leído (stack Fastify/viem/vitest/biome; sin `any`).
- [x] Todos los exemplars verificados con Read (paths reales — §5).
- [x] Auto-Blindaje histórico consultado (WKH-133/138/141) → patrón recurrente
      viem heredado como **CD-8**.
- [x] Reuso x402 diseñado sin tipo paralelo (CD-3 / DT-1).
- [x] Feature-flag `TEMPO_ADAPTER_ENABLED` default OFF, gate en un solo
      choke-point (CD-7), byte-idéntico OFF (CD-6 / AC-2) diseñado.
- [x] `CHAIN_NOT_SUPPORTED` con flag OFF resuelto vía el double-guard existente
      (AC-5) — no requiere código nuevo en las rutas.
- [x] Sin auto-routing (CD-9 / AC-6 / Scope OUT HU-091).
- [x] Gasless v1 resuelto (stub deshabilitado, DT-7) — sin `[NEEDS CLARIFICATION]`.
- [x] Nombre del flag resuelto (`TEMPO_ADAPTER_ENABLED`).
- [x] Datos on-chain de Tempo marcados `[VERIFY-AT-IMPL en F3]` (§7), no bloquean.
- [x] Plan de tests ≥1/AC + no-regresión (§6).
- [x] CD-4 (Ownership Guard) evaluado: N/A — esta HU no toca DB.
- [x] **Cero `[NEEDS CLARIFICATION]` abiertos.**

**Veredicto**: SDD listo para gate `SPEC_APPROVED`.

---

*Architect F2 — 2026-07-04 — HU-090 / WKH-090. NNN 146. Branch:
feat/146-hu-090-tempo-mpp-rail.*
