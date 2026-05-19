# Work Item — [WKH-104] BASE-01 · Base chain adapter (sepolia + mainnet) — USDC EIP-3009 path

## Resumen

Crea el adapter de Base para que wasiai-a2a pueda enrutar pagos x402 sobre USDC
(EIP-3009 TransferWithAuthorization) en Base Sepolia (chainId 84532) y Base
Mainnet (chainId 8453). Clona el patrón establecido de `src/adapters/avalanche/`
con 6 archivos, extiende `ChainKey`, `chain-resolver.ts` y `registry.ts`, y
agrega la suite de tests correspondiente. Es la primera HU crítica del Epic
WKH-103 (BASE port a wasiai-a2a) — sin este adapter los demás no pueden avanzar.

## Sizing

- **SDD_MODE**: full
- **Pipeline**: QUALITY
- **Estimación**: L (24-30h estimadas por el cliente; cruza chain-resolver
  —módulo cross-cutting que afecta todos los adapters—, 6 archivos nuevos,
  tests contract + chain-resolver + payment, y verificación onchain EIP-712)
- **Branch sugerido**: `feat/wkh-base-port-v1`
  (branch compartida con WKH-105..108 — toda la wave BASE va a esta branch)

### Justificación QUALITY (vs LAUNCH)

La HU toca `chain-resolver.ts` (módulo cross-cutting — un error rompe Kite y
Avalanche en prod), `types.ts` (contrato de union `ChainKey` que deben
respetar todos los adapters), y `registry.ts` (factory principal). Además
requiere verificación onchain del EIP-712 domain name antes de hardcodear
(CD-3), lo que introduce un paso de investigación no omitible. Riesgo de
regresión en producción justifica gates F2 + F3 + AR + CR + F4.

## Skills Router

- **skill-blockchain-evm**: firmas EIP-3009 / EIP-712, viem, chain config,
  USDC on Base, facilitator routing
- **skill-typescript-strict**: TypeScript strict, union extension, adapter
  pattern, vitest contract tests

## Acceptance Criteria (EARS)

- **AC-1**: WHEN `x-payment-chain` header contains `base-sepolia` OR `84532`,
  the system SHALL return `ChainKey = 'base-sepolia'` from `normalizeChainSlug`
  and the registry SHALL resolve the Base Sepolia adapter bundle.

- **AC-2**: WHEN `x-payment-chain` header contains `base-mainnet` OR `8453`,
  the system SHALL return `ChainKey = 'base-mainnet'` from `normalizeChainSlug`
  and the registry SHALL resolve the Base Mainnet adapter bundle.

- **AC-3**: WHEN the Base Sepolia payment adapter signs an EIP-3009
  `TransferWithAuthorization` for the USDC Sepolia contract
  (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`), the system SHALL produce a
  signature whose recovered signer equals the `OPERATOR_PRIVATE_KEY` wallet
  address, with `chainId = 84532` in the EIP-712 domain.

- **AC-4**: WHEN `BASE_NETWORK=mainnet` is set in the environment, the system
  SHALL use USDC Mainnet (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) and
  `BASE_MAINNET_RPC_URL` as the RPC endpoint.

- **AC-5**: WHEN `BASE_NETWORK` env var is absent OR set to any value other
  than `mainnet`, the system SHALL default to `testnet` (Base Sepolia,
  chainId 84532) with `BASE_TESTNET_RPC_URL`.

- **AC-6**: IF `WASIAI_A2A_CHAINS` contains `base-sepolia` or `base-mainnet`
  and the slug is unrecognized by the current registry, THEN the system SHALL
  throw at `initAdapters()` startup with a message listing supported chains
  (fail-fast, same guard as existing chains).

- **AC-7**: WHILE running `npm test`, the system SHALL execute all
  pre-existing tests (1660+ passing) PLUS the new Base adapter tests with
  zero regressions and zero failures.

- **AC-8**: WHILE running `npm run build`, the system SHALL complete with
  zero TypeScript strict errors and zero explicit `any` types introduced by
  this HU.

## Scope IN

| Artefacto | Acción |
|-----------|--------|
| `src/adapters/base/chain.ts` | Nuevo — `BaseNetwork` type, `getBaseNetwork()`, `getBaseChain()`, viem `defineChain` para Base Sepolia (Base Mainnet puede estar en `viem/chains`) |
| `src/adapters/base/payment.ts` | Nuevo — `BasePaymentAdapter` implements `PaymentAdapter`, EIP-3009 + x402 canonical, mirrors `AvalanchePaymentAdapter` |
| `src/adapters/base/attestation.ts` | Nuevo — `BaseAttestationAdapter` stub (ERC-8004 out of scope MVP), mirrors `AvalancheAttestationAdapter` |
| `src/adapters/base/gasless.ts` | Nuevo — `BaseGaslessAdapter` stub disabled (CDP facilitator — BASE-02), mirrors `AvalancheGaslessAdapter` |
| `src/adapters/base/identity.ts` | Nuevo — `export const baseIdentity = null` (mirrors `avalanche/identity.ts`) |
| `src/adapters/base/index.ts` | Nuevo — `createBaseAdapters(opts?: { network?: BaseNetwork })` factory, mirrors `avalanche/index.ts` |
| `src/adapters/types.ts` | Extender union `ChainKey` con `'base-sepolia'` y `'base-mainnet'` |
| `src/adapters/chain-resolver.ts` | Agregar aliases: `'8453'`, `'base'`, `'base-mainnet'` → `'base-mainnet'`; `'84532'`, `'base-sepolia'`, `'base-testnet'` → `'base-sepolia'` |
| `src/adapters/registry.ts` | Agregar `'base-sepolia'` y `'base-mainnet'` a `SUPPORTED_CHAINS`; agregar ramas `buildBundle()` que llaman `createBaseAdapters({ network })` |
| `src/adapters/__tests__/base.test.ts` | Nuevo — contract tests: interface shape, EIP-3009 sign, network selection, chain-resolver aliases |
| `src/adapters/__tests__/chain-resolver.test.ts` | Extender (o crear si no existe) — cubrir los 6 nuevos aliases de Base |
| `src/adapters/__tests__/payment.contract.test.ts` | Extender — agregar suite Base adapter (mirrors sección Avalanche existente) |
| `.env.example` | Agregar: `BASE_NETWORK`, `BASE_TESTNET_RPC_URL`, `BASE_MAINNET_RPC_URL`, `CDP_FACILITATOR_URL`, `CDP_API_KEY` |

## Scope OUT

- `src/adapters/avalanche/` — NO modificar (CD-2, regression risk)
- `src/adapters/kite-ozone/` — NO modificar (CD-2)
- `wasiai-facilitator` service (BASE-02 — HU separada)
- Bazaar discovery integration (BASE-03)
- E2E smoke real contra testnet en CI (BASE-04 — HU separada)
- Smart Wallet / OnchainKit (BASE-06/07)
- CDP Paymaster integration real (placeholder env var solo, sin implementación)
- Migración de consumidores prod (app.wasiai.io, Cobraya, WasiAgentShop) a Base

## Decisiones técnicas (DT-N)

- **DT-1 — EIP-712 domain `name` via onchain verification (CD-3)**:
  El `name` del EIP-712 domain de USDC en Base PUEDE diferir de `'USD Coin'`
  (Avalanche) o `'USD Coin'` (Ethereum mainnet). Circle ha usado distintos names
  en diferentes deploys. El Architect DEBE verificar via `cast call
  <USDC_ADDRESS> "DOMAIN_SEPARATOR()(bytes32)"` en Base Sepolia y Base Mainnet
  antes de hardcodear el valor. Si el resultado coincide con `'USD Coin'` /
  version `'2'`, usar esa constante. Si difiere, la constante correcta debe
  estar en la clase antes de cualquier test de firma. El valor NO se asume
  igual a Avalanche. `[NEEDS CLARIFICATION — verificar onchain en F2/F3]`

- **DT-2 — Network selection pattern (mirrors Avalanche DT-I)**:
  La factory `createBaseAdapters(opts?)` recibe `network` explícito desde
  `buildBundle()` en registry.ts (igual que Avalanche). Para uso standalone
  (tests, tools), `getBaseNetwork(opts?)` resuelve: `opts.network` >
  `BASE_NETWORK` env var (`'mainnet'` activa mainnet, cualquier otro valor →
  `'testnet'`). Default conservador: testnet (Base Sepolia). Esto satisface
  AC-4 y AC-5 y replica el patrón ya auditado de Avalanche.

- **DT-3 — Facilitator routing para Base (placeholder en BASE-01)**:
  En BASE-01, el `getFacilitatorUrl()` en `base/payment.ts` usa la misma cadena
  de prioridad que Avalanche: `BASE_FACILITATOR_URL` > `CDP_FACILITATOR_URL` >
  `WASIAI_FACILITATOR_URL` > hardcoded default (el facilitador WasiAI actual).
  El facilitador real de Base (CDP) se wirará en BASE-02. Esta decisión permite
  que los tests de BASE-01 pasen sin levantar un facilitador real, y evita
  bloquear la implementación mientras BASE-02 no está listo.

- **DT-4 — viem chain definition para Base Sepolia**:
  `viem/chains` incluye `base` (mainnet 8453) y `baseSepolia` (84532) desde
  viem v2.x. El Architect DEBE verificar que la versión de viem instalada en el
  proyecto los exponga antes de usar `defineChain()`. Si están disponibles,
  re-exportar directamente (igual que Avalanche re-exporta `avalanche`,
  `avalancheFuji`). Si no están en la versión instalada, usar `defineChain()`
  con los parámetros correctos de Base.
  `[NEEDS CLARIFICATION — verificar en F2 contra package.json/node_modules]`

- **DT-5 — `identity` es `null` en MVP**:
  Al igual que Avalanche MVP, `base/identity.ts` exporta `null`. Base no tiene
  un equivalente de Kite Passport en este epic. El `AdaptersBundle.identity`
  aceptará `null` (tipo ya permite `IdentityBindingAdapter | null`).

- **DT-6 — USDC addresses hardcoded con override via env**:
  Seguir el patrón exacto de `avalanche/payment.ts`: constantes por default
  (`DEFAULT_BASE_SEPOLIA_USDC`, `DEFAULT_BASE_MAINNET_USDC`) + env override
  (`BASE_SEPOLIA_USDC_ADDRESS`, `BASE_MAINNET_USDC_ADDRESS`) con validación
  de formato y console.warn en primer uso. Esto permite testnet overrides sin
  cambiar código.

## Constraint Directives (CD-N)

- **CD-1**: OBLIGATORIO TypeScript strict — cero `any` explícito, cero
  `as unknown` en el código nuevo.
- **CD-2**: PROHIBIDO modificar `src/adapters/avalanche/` y
  `src/adapters/kite-ozone/` — regression risk en prod.
- **CD-3**: OBLIGATORIO verificar EIP-712 domain `name` via
  `cast call DOMAIN_SEPARATOR()` en Base Sepolia y Base Mainnet ANTES de
  hardcodear la constante `USDC_EIP712_NAME` en `base/payment.ts`. No asumir
  `'USD Coin'` sin confirmación onchain.
- **CD-4**: OBLIGATORIO `BASE_NETWORK=testnet` como default conservador. El
  path mainnet requiere opt-in explícito via env var.
- **CD-5**: OBLIGATORIO `npm test` + `npm run build` verdes pre-merge, con
  todos los tests existentes pasando (no regressions).
- **CD-6**: PROHIBIDO secrets/keys hardcodeados — USDC addresses van como
  constantes con env override, RPC URLs desde env, private key desde
  `OPERATOR_PRIVATE_KEY`.
- **CD-7**: PROHIBIDO `ethers.js` — viem en todo el codebase (regla global
  del proyecto).
- **CD-8**: PROHIBIDO push directo a `main` — branch `feat/wkh-base-port-v1`,
  PR con CR aprobado.
- **CD-9**: OBLIGATORIO `WASIAI_A2A_CHAINS` soporta `base-sepolia` y
  `base-mainnet` como slugs válidos post-implementación (registry fail-fast
  guard actualizado).

## Waves sugeridas (QUALITY pipeline)

| Wave | Contenido |
|------|-----------|
| **W0** | Bootstrap: verificar viem chains disponibles, `cast call` EIP-712 domain en Sepolia y Mainnet, documentar hallazgos en SDD |
| **W1** | `types.ts` — extender `ChainKey`; `chain-resolver.ts` — agregar aliases Base; tests chain-resolver nuevos aliases |
| **W2** | `src/adapters/base/` — 6 archivos: `chain.ts`, `attestation.ts`, `gasless.ts`, `identity.ts`, `payment.ts`, `index.ts` |
| **W3** | `registry.ts` — `SUPPORTED_CHAINS` + `buildBundle()` ramas Base; tests contract `base.test.ts` + extensión `payment.contract.test.ts` |
| **W4** | `.env.example` — nuevas vars; smoke local Base Sepolia (sin CI); `npm test` verde; `npm run build` verde |

## Missing Inputs

- **[NEEDS CLARIFICATION — F2/W0]** EIP-712 domain `name` exacto de USDC en
  Base Sepolia y Base Mainnet. Verificar via `cast call
  0x036CbD53842c5426634e7929541eC2318f3dCF7e "name()(string)"` (Sepolia) y
  `cast call 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 "name()(string)"`
  (Mainnet). Hipótesis de trabajo: `'USD Coin'` (igual que Avalanche) — pero
  DEBE confirmarse, no asumirse.
- **[NEEDS CLARIFICATION — F2/W0]** Versión de viem instalada — verificar si
  `baseSepolia` y `base` están disponibles en `viem/chains` sin `defineChain()`.
  Hipótesis: disponibles desde viem v2.7+.
- **[RESUELTO]** USDC addresses: confirmadas en la HU (Sepolia:
  `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, Mainnet:
  `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`).
- **[RESUELTO]** ChainIds: Sepolia 84532, Mainnet 8453.
- **[RESUELTO]** RPC defaults: `https://sepolia.base.org` (testnet),
  `https://mainnet.base.org` (mainnet).
- **[RESUELTO]** Facilitator en BASE-01: placeholder → WasiAI facilitador
  actual. CDP real en BASE-02.

## Riesgos identificados

| Riesgo | Severidad | Mitigación |
|--------|-----------|------------|
| EIP-712 domain `name` incorrecto en Base USDC | ALTA — firmas inválidas en prod | CD-3: verificación onchain obligatoria en W0 antes de codear |
| Regression en Avalanche/Kite por cambio en `chain-resolver.ts` | ALTA | CD-2: prohibido tocar adapters existentes; tests chain-resolver deben cubrir aliases Kite + Avalanche pre-existentes además de Base |
| `ChainKey` union extension rompe switch exhaustivos en consumidores | MEDIA | Buscar `switch` sobre `ChainKey` en el codebase en W1 y actualizar; TypeScript strict lo detecta |
| viem chain `baseSepolia` no disponible en versión instalada | MEDIA | DT-4: verificar en W0; fallback `defineChain()` ya documentado |
| Facilitador WasiAI actual no soporta Base (respuesta 4xx en verify/settle) | BAJA en BASE-01 | Los tests mockean fetch; la integración real es BASE-02. Documentar en gasless.ts |

## Análisis de paralelismo

- **WKH-105 (BASE-02 — facilitator)**: puede correr en paralelo con WKH-104.
  Son repos distintos (`wasiai-facilitator` vs `wasiai-a2a`). La única
  dependencia es que BASE-02 define la URL final que `BASE_FACILITATOR_URL`
  apuntará — pero en BASE-01 usamos placeholder, por lo que no hay bloqueo real.
  Ambas HUs comparten branch `feat/wkh-base-port-v1` — coordinar merges.
- **WKH-106 (BASE-03 — Bazaar discovery)**: bloqueada por WKH-104 (necesita
  el adapter Base inicializado). No paralelo.
- **WKH-107 / WKH-108**: igualmente bloqueadas por WKH-104. No paralelo.

## Decisión final de sizing

**QUALITY** — confirmado. Argumentos:
1. `chain-resolver.ts` es cross-cutting: un alias mal puesto silencia pagos
   en Kite/Avalanche en prod.
2. `types.ts` union extension rompe silenciosamente si hay switch exhaustivos.
3. EIP-712 domain mismatch es un riesgo de firma inválida que requiere
   verificación onchain antes de codear (no es trabajo de LAUNCH).
4. Producción live con 3 consumidores (app.wasiai.io, Cobraya, WasiAgentShop)
   — cero tolerancia a regressions.
