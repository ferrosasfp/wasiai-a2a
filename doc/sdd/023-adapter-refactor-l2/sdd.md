# SDD #023: Adapter Refactor L2 -- Extract Kite Hardcoding to src/adapters/kite-ozone/*

> SPEC_APPROVED: no
> Fecha: 2026-04-06
> Tipo: refactor
> SDD_MODE: full
> Branch: feat/023-adapter-refactor-l2
> Artefactos: doc/sdd/023-adapter-refactor-l2/

---

## 1. Resumen

Extract 187 Kite-hardcoded references across 17 source files into a pluggable adapter layer per `doc/architecture/CHAIN-ADAPTIVE.md` section L2. This is a PURE REFACTOR: zero behavior change, all 119 existing tests must pass, plus new contract tests for the adapter interfaces. The result is a binary that can serve any EVM chain by changing only env vars.

The refactor creates four adapter interfaces (PaymentAdapter, AttestationAdapter, GaslessAdapter, IdentityBindingAdapter), a runtime registry selected by `WASIAI_A2A_CHAIN` env var, and a `kite-ozone` adapter bundle that encapsulates all current Kite-specific logic. Consumers (x402 middleware, compose service, gasless routes, dashboard, index.ts) are updated to call through the registry instead of importing Kite modules directly.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 023 (WKH-35) |
| **Tipo** | refactor |
| **SDD_MODE** | full |
| **Objetivo** | Decouple all Kite-specific logic into pluggable adapters; zero behavior change |
| **Reglas de negocio** | Zero regression. 119/119 tests pass. No new npm deps. |
| **Scope IN** | 4 adapter interfaces, registry, kite-ozone bundle (6 files), 9 consumer refactors, 3 test files, 1 HTML |
| **Scope OUT** | DB table rename (kite_schema_transforms), L3 primitives, evm-generic/base/mock adapters, IdentityBinding impl, new L4 endpoints |
| **Missing Inputs** | None (kite_schema_transforms rename confirmed SCOPE OUT) |

### Acceptance Criteria (EARS)

AC-1 through AC-15 inherited verbatim from work-item.md. See `doc/sdd/023-adapter-refactor-l2/work-item.md` lines 14-56 for full EARS text.

## 3. Context Map (Codebase Grounding)

### Archivos leidos

| Archivo | Por que | Patron extraido |
|---------|---------|-----------------|
| `src/middleware/x402.ts` | Primary payment middleware -- W3 extraction target | Exports 6 KITE_* constants, `buildX402Response`, `decodeXPayment`, `verifyPayment`, `settlePayment`, `requirePayment`. Uses `process.env.KITE_WALLET_ADDRESS`, `KITE_FACILITATOR_URL`. Fastify augmentation: `kiteTxHash`, `kitePaymentVerified`. Pieverse fetch calls on `/v2/verify` and `/v2/settle`. |
| `src/lib/x402-signer.ts` | Client-side EIP-712 signer -- W3 extraction target | Imports `kiteTestnet` from `kite-chain.js` and `KITE_FACILITATOR_ADDRESS`, `KITE_NETWORK` from `middleware/x402.js` (CIRCULAR DEPENDENCY). Lazy singleton wallet client. EIP712_DOMAIN uses `kiteTestnet.id` (2368). |
| `src/services/kite-client.ts` | Chain client singleton -- W2 extraction target | Top-level await: `export const kiteClient = await initKiteClient()`. Exports `kiteClient` (PublicClient or null) and `requireKiteClient()`. |
| `src/lib/kite-chain.ts` | Chain definition -- W2 extraction target | `defineChain()` for Kite Testnet (id: 2368). Hardcoded RPC URL in chain def; actual RPC from env. |
| `src/lib/gasless-signer.ts` | Gasless EIP-3009 module -- W4 extraction target | Imports `kiteTestnet` from `kite-chain.js`, `requireKiteClient`/`kiteClient` from `kite-client.js`. GASLESS_BASE_URL = `gasless.gokite.ai`. FALLBACK_TOKEN with PYUSD address. WKH-38 graceful degradation (`computeFundingState`, `getGaslessStatus`). |
| `src/routes/gasless.ts` | Gasless route consumer -- W4 target | Imports `getGaslessStatus`, `signTransferWithAuthorization`, `submitGaslessTransfer` from `gasless-signer.js`. |
| `src/services/compose.ts` | Pipeline execution -- W3 consumer | Imports `signX402Authorization` from `x402-signer.js`, `settlePayment` from `x402.js`. |
| `src/routes/compose.ts` | Compose route -- W3 consumer | Imports `requirePayment` from `x402.js`. Uses `request.kiteTxHash`. |
| `src/routes/orchestrate.ts` | Orchestrate route -- W6 consumer | Imports `requirePayment` from `x402.js`. Uses `request.kiteTxHash`. |
| `src/routes/dashboard.ts` | Dashboard -- W6 consumer | Reads `process.env.KITE_EXPLORER_URL`. Template replaces `{{KITE_EXPLORER_URL}}`. |
| `src/static/dashboard.html` | Dashboard UI -- W6 target | Footer: "Kite Hackathon 2026". JS variable `EXPLORER_URL = '{{KITE_EXPLORER_URL}}'`. |
| `src/index.ts` | Entrypoint -- W6 target | Imports `kiteClient` from `services/kite-client.js`. Banner: hardcoded "Kite: connected/disabled" line. |
| `src/types/index.ts` | Shared types -- W6 target | `X402PaymentPayload.scheme: 'gokite-aa'`, `.network: 'kite-testnet' | 'kite-mainnet'`. `GaslessStatus.network: 'kite-testnet'`. Pieverse types (PieverseVerifyRequest/Response, PieverseSettleRequest/Result). |
| `src/services/llm/transform.ts` | Transform service | References `kite_schema_transforms` table (SCOPE OUT -- separate DB migration ticket). |
| `src/services/kite-client.test.ts` | Existing test (8 tests) | Uses `vi.resetModules()` to re-evaluate top-level await per test. Mock `viem`. |
| `src/lib/gasless-signer.test.ts` | Existing test (16 tests) | Mocks `kite-chain.js`, `kite-client.js`, fetch. Tests WKH-38 degradation states. |
| `src/services/compose.test.ts` | Existing test | Mocks `x402-signer.js`, `x402.js`. |
| `doc/architecture/CHAIN-ADAPTIVE.md` | Architecture spec | L2 interface signatures (section lines 129-167). Registry env var design (section 4, lines 233-250). File layout (lines 169-192). |

### Exemplars

| Para crear/modificar | Seguir patron de | Razon |
|---------------------|------------------|-------|
| `src/adapters/types.ts` | `src/types/index.ts` | Same export-only types module pattern: interfaces + type exports, no runtime code |
| `src/adapters/registry.ts` | `src/services/kite-client.ts` | Lazy singleton pattern with `require*()` accessor throwing on missing config |
| `src/adapters/kite-ozone/payment.ts` | `src/middleware/x402.ts` + `src/lib/x402-signer.ts` | Extract Pieverse calls + EIP-712 signing into adapter class implementing PaymentAdapter |
| `src/adapters/kite-ozone/gasless.ts` | `src/lib/gasless-signer.ts` | Move entire module, adapt exports to GaslessAdapter interface |
| `src/adapters/kite-ozone/client.ts` | `src/services/kite-client.ts` | Same initKiteClient pattern but no top-level await (lazy init) |
| `src/adapters/__tests__/payment.contract.test.ts` | `src/services/kite-client.test.ts` | Same vitest patterns: vi.mock, describe/it/expect |

### Componentes reutilizables encontrados

- `kiteTestnet` chain definition (src/lib/kite-chain.ts) -- reuse as-is inside adapter, not recreate
- `initKiteClient` function (src/services/kite-client.ts) -- reuse logic, change initialization strategy
- All Pieverse types (src/types/index.ts lines 274-306) -- keep in types/index.ts but move Kite-specific literals to adapter
- WKH-38 `computeFundingState` logic (src/lib/gasless-signer.ts lines 297-306) -- reuse inside gasless adapter

## 4. Diseno Tecnico

### 4.1 Archivos a crear/modificar

| Archivo | Accion | Descripcion | Wave | Exemplar |
|---------|--------|-------------|------|----------|
| `src/adapters/types.ts` | Crear | 4 adapter interfaces + DTO types (SettleRequest, SettleResult, VerifyResult, QuoteResult, GaslessTransferRequest, GaslessResult, GaslessAdapterStatus, AttestEvent, AttestRef, BindResult, BindVerification, TokenSpec) | W1 | `src/types/index.ts` |
| `src/adapters/registry.ts` | Crear | Registry singleton: `getPaymentAdapter()`, `getAttestationAdapter()`, `getGaslessAdapter()`, `getIdentityBindingAdapter()`. Reads `WASIAI_A2A_CHAIN` env var, lazy init, error on unsupported chain. Also exports `initAdapters()` for startup. | W1 | `src/services/kite-client.ts` |
| `src/adapters/kite-ozone/chain.ts` | Crear (move) | Move `kiteTestnet` defineChain from `src/lib/kite-chain.ts` | W2 | `src/lib/kite-chain.ts` |
| `src/adapters/kite-ozone/client.ts` | Crear (move) | Move kite client init logic. Replace top-level await with lazy init (see DT-LAZY). Export `getKiteClient()` and `requireKiteClient()`. | W2 | `src/services/kite-client.ts` |
| `src/adapters/kite-ozone/index.ts` | Crear | Factory: `createKiteOzoneAdapters()` returning all 4 adapter impls. Chain config (chainId 2368). Absorbs chain.ts and client.ts. | W2 | N/A (new pattern) |
| `src/adapters/kite-ozone/payment.ts` | Crear | KiteOzonePaymentAdapter class implementing PaymentAdapter. Absorbs: (a) verify/settle from x402.ts Pieverse calls, (b) quote/sign from x402-signer.ts EIP-712 signing. | W3 | `src/middleware/x402.ts` + `src/lib/x402-signer.ts` |
| `src/middleware/x402.ts` | Modificar | Remove KITE_* constants, Pieverse fetch calls, verifyPayment, settlePayment exports. Keep: `requirePayment`, `buildX402Response`, `decodeXPayment` as thin wrappers over `getPaymentAdapter()`. | W3 | Current self |
| `src/services/compose.ts` | Modificar | Replace `import { signX402Authorization }` from x402-signer and `import { settlePayment }` from x402 with `getPaymentAdapter()` from registry. | W3 | Current self |
| `src/lib/x402-signer.ts` | Eliminar | Logic absorbed into `kite-ozone/payment.ts`. All consumers now use registry. | W3 | N/A |
| `src/adapters/kite-ozone/gasless.ts` | Crear | KiteOzoneGaslessAdapter class implementing GaslessAdapter. Absorbs all logic from `src/lib/gasless-signer.ts`. Preserves WKH-38 graceful degradation. | W4 | `src/lib/gasless-signer.ts` |
| `src/routes/gasless.ts` | Modificar | Replace imports from `gasless-signer.js` with `getGaslessAdapter()` from registry. | W4 | Current self |
| `src/lib/gasless-signer.ts` | Eliminar | Logic absorbed into `kite-ozone/gasless.ts`. | W4 | N/A |
| `src/adapters/kite-ozone/attestation.ts` | Crear | KiteOzoneAttestationAdapter stub. `attest()` returns placeholder, `verify()` returns true. Logs warning. | W5 | N/A |
| `src/types/index.ts` | Modificar | Generalize: `X402PaymentPayload.scheme: string` (was `'gokite-aa'`), `.network: string` (was `'kite-testnet' | 'kite-mainnet'`), `GaslessStatus.network: string` (was `'kite-testnet'`). Keep Pieverse types (adapter-internal consumers still need them). | W6 | Current self |
| `src/index.ts` | Modificar | Replace `import { kiteClient }` with `import { initAdapters, getPaymentAdapter }` from registry. Call `await initAdapters()` at startup. Update banner to show chain name dynamically. | W6 | Current self |
| `src/routes/dashboard.ts` | Modificar | Replace `KITE_EXPLORER_URL` env var with `CHAIN_EXPLORER_URL`. Update template var name. | W6 | Current self |
| `src/static/dashboard.html` | Modificar | Replace `{{KITE_EXPLORER_URL}}` with `{{CHAIN_EXPLORER_URL}}`. Replace footer "Kite Hackathon 2026" with "Chain-Adaptive Gateway". | W6 | Current self |
| `src/routes/compose.ts` | Modificar | Rename `request.kiteTxHash` to `request.paymentTxHash` (or keep for backwards compat -- see DT-AUGMENTATION). | W6 | Current self |
| `src/routes/orchestrate.ts` | Modificar | Same as compose.ts: rename kiteTxHash reference. | W6 | Current self |
| `src/lib/kite-chain.ts` | Eliminar | Moved to `src/adapters/kite-ozone/chain.ts`. | W6 | N/A |
| `src/services/kite-client.ts` | Eliminar | Moved to `src/adapters/kite-ozone/client.ts`. | W6 | N/A |
| `src/adapters/__tests__/payment.contract.test.ts` | Crear | Contract tests: PaymentAdapter interface shape, settle/verify/quote return types. | W7 | `src/services/kite-client.test.ts` |
| `src/adapters/__tests__/gasless.contract.test.ts` | Crear | Contract tests: GaslessAdapter interface shape, transfer/status return types. | W7 | `src/lib/gasless-signer.test.ts` |
| `src/adapters/__tests__/registry.test.ts` | Crear | Registry tests: default chain selection, unsupported chain error, individual adapter overrides. | W7 | `src/services/kite-client.test.ts` |
| `src/services/kite-client.test.ts` | Modificar | Update imports to `src/adapters/kite-ozone/client.ts`. Keep all 8 test assertions unchanged. | W7 | Current self |
| `src/lib/gasless-signer.test.ts` | Modificar | Update imports to `src/adapters/kite-ozone/gasless.ts`. Keep all 16 test assertions unchanged. | W7 | Current self |
| `src/services/compose.test.ts` | Modificar | Update mock paths from `x402-signer.js` and `x402.js` to adapter registry paths. | W7 | Current self |

### 4.2 Adapter Interface Definitions

Derived from `doc/architecture/CHAIN-ADAPTIVE.md` section L2 (lines 132-167) and current codebase types.

#### PaymentAdapter

```
interface PaymentAdapter {
  readonly name: string          // e.g. "kite-ozone"
  readonly chainId: number       // e.g. 2368
  readonly supportedTokens: TokenSpec[]

  settle(req: SettleRequest): Promise<SettleResult>
  verify(proof: X402Proof): Promise<VerifyResult>
  quote(amountUsd: number): Promise<QuoteResult>
  sign(opts: SignRequest): Promise<SignResult>
}
```

**Design note**: `sign()` is added beyond the architecture doc's spec because `compose.ts` currently calls `signX402Authorization` (client-side EIP-712 signing). Without `sign()` on the adapter, compose.ts would still need a direct import to the kite-ozone signer, defeating the purpose. The architecture doc lists `settle`/`verify`/`quote`; we add `sign` as a Kite-specific extension that other adapters can implement differently.

#### DTO Types (derived from current Pieverse types)

```
interface TokenSpec {
  symbol: string           // "PYUSD", "USDC"
  address: `0x${string}`
  decimals: number
}

interface SettleRequest {
  authorization: X402PaymentRequest['authorization']
  signature: string
  network: string
}

interface SettleResult {
  txHash: string
  success: boolean
  error?: string
}

interface X402Proof {
  authorization: X402PaymentRequest['authorization']
  signature: string
  network: string
}

interface VerifyResult {
  valid: boolean
  error?: string
}

interface QuoteResult {
  amountWei: string
  token: TokenSpec
  facilitatorUrl: string
}

interface SignRequest {
  to: `0x${string}`
  value: string
  timeoutSeconds?: number
}

interface SignResult {
  xPaymentHeader: string
  paymentRequest: X402PaymentRequest
}
```

**Derivation**:
- `SettleRequest` / `SettleResult` map 1:1 to current `PieverseSettleRequest` / `PieverseSettleResult` (src/types/index.ts lines 292-306)
- `X402Proof` / `VerifyResult` map to `PieverseVerifyRequest` / `PieverseVerifyResponse` (lines 274-288)
- `SignRequest` / `SignResult` map to `SignX402Options` / return type of `signX402Authorization` (src/lib/x402-signer.ts lines 61-68, 75-77)
- `QuoteResult` is new (no current quote logic exists). Kite-ozone impl returns static values from constants.

#### AttestationAdapter

```
interface AttestationAdapter {
  readonly name: string
  readonly chainId: number

  attest(event: AttestEvent): Promise<{ txHash: string; proofUrl: string }>
  verify(ref: AttestRef): Promise<boolean>
}

interface AttestEvent {
  type: string
  payload: Record<string, unknown>
}

interface AttestRef {
  txHash: string
}
```

#### GaslessAdapter

```
interface GaslessAdapter {
  readonly name: string
  readonly chainId: number

  transfer(req: GaslessTransferAdapterRequest): Promise<GaslessAdapterResult>
  status(): Promise<GaslessAdapterStatus>
}

interface GaslessTransferAdapterRequest {
  to: `0x${string}`
  value: bigint
}

interface GaslessAdapterResult {
  txHash: `0x${string}`
}

interface GaslessAdapterStatus {
  enabled: boolean
  network: string
  supportedToken: GaslessSupportedToken | null
  operatorAddress: `0x${string}` | null
  funding_state: GaslessFundingState
  chain_id?: number
  relayer?: string
  documentation?: string
}
```

**Design note**: `GaslessTransferAdapterRequest` is simplified from `GaslessTransferRequest` (which includes signed fields like v/r/s). The adapter handles signing internally -- the consumer only provides `to` and `value`. The adapter's `transfer()` does sign + submit as one atomic operation.

#### IdentityBindingAdapter

```
interface IdentityBindingAdapter {
  readonly name: string
  readonly chainId: number

  bind(keyId: string, chainAddress: string, sig: `0x${string}`): Promise<BindResult>
  verify(keyId: string): Promise<BindVerification>
}

interface BindResult {
  success: boolean
  txHash?: string
  error?: string
}

interface BindVerification {
  bound: boolean
  chainAddress?: string
  verifiedAt?: string
}
```

### 4.3 Registry Design

```
// src/adapters/registry.ts

Singleton module with lazy initialization.

Env var: WASIAI_A2A_CHAIN (default: "kite-ozone-testnet")
Optional overrides: PAYMENT_ADAPTER, ATTESTATION_ADAPTER, GASLESS_ADAPTER, IDENTITY_BINDING_ADAPTER

Supported chain bundles (phase 1):
  "kite-ozone-testnet" -> kite-ozone adapters (chainId 2368)

Unsupported chain -> throw Error listing supported chains.

Functions:
  initAdapters(): Promise<void>   -- called once at startup (replaces kiteClient import)
  getPaymentAdapter(): PaymentAdapter
  getAttestationAdapter(): AttestationAdapter
  getGaslessAdapter(): GaslessAdapter
  getIdentityBindingAdapter(): IdentityBindingAdapter
  getChainConfig(): { name: string, chainId: number, explorerUrl: string }
```

`initAdapters()` replaces the current top-level await in `kite-client.ts`. It calls `createKiteOzoneAdapters()` which internally does the async chain connection. The registry caches the adapter instances as module-level variables (lazy singleton, same pattern as current `kiteClient`).

Each `get*Adapter()` function throws if adapters are not initialized yet (same pattern as `requireKiteClient()`).

`getChainConfig()` provides chain-agnostic metadata (name, chainId, explorerUrl) for consumers like dashboard.ts that need display info without knowing the specific chain.

### 4.4 Flujo principal (Happy Path -- x402 payment after refactor)

1. Client sends `POST /compose` with `X-Payment` header
2. `requirePayment` preHandler (still in `src/middleware/x402.ts`) calls `getPaymentAdapter().verify(proof)` instead of `verifyPayment()` directly
3. On success, calls `getPaymentAdapter().settle(req)` instead of `settlePayment()` directly
4. Sets `request.paymentTxHash` and `request.paymentVerified` (renamed from kite-prefixed)
5. Handler runs compose pipeline; compose.ts calls `getPaymentAdapter().sign(opts)` instead of `signX402Authorization()` for agent-to-agent payments
6. Response includes `paymentTxHash` (renamed from `kiteTxHash`)

**Identical external behavior**: same HTTP status codes, same response shapes, same headers. The only visible change is the JSON field rename `kiteTxHash` -> `paymentTxHash` (or keep both for backwards compat -- see DT-AUGMENTATION).

### 4.5 Flujo de error

1. If `WASIAI_A2A_CHAIN` is set to unsupported value: `initAdapters()` throws at startup with message listing supported chains. Server does not start. (AC-8)
2. If adapter not initialized and `get*Adapter()` called: throws descriptive error (same as current `requireKiteClient()` pattern).
3. If Pieverse facilitator unreachable: same error handling as current x402.ts (lines 138-149), wrapped through adapter.

## 5. Design Decisions

### DT-1: Move vs. re-export (inherited from work-item)

Files `kite-chain.ts` and `kite-client.ts` MOVE into `src/adapters/kite-ozone/`. Old paths deleted. No re-exports. Forces all consumers through the adapter registry.

### DT-2: Adapter singleton pattern (inherited)

Each adapter created once at startup via `initAdapters()`, cached in registry module-scope variables. No per-request instantiation.

### DT-3: PaymentAdapter expanded scope

PaymentAdapter covers both server-side (verify, settle) AND client-side (sign, quote). Added `sign()` method beyond architecture doc spec because `compose.ts` needs client-side EIP-712 signing. Without it, compose would bypass the adapter.

**Justification**: Reading `src/services/compose.ts` lines 230-234 shows that `signX402Authorization` is called to generate the X-Payment header for agent invocation. This signing is chain-specific (uses EIP-712 domain with kite chainId). It must be in the adapter.

### DT-CIRCULAR: Breaking x402-signer <-> x402.ts circular import

**Current state**: `x402-signer.ts` imports `KITE_FACILITATOR_ADDRESS` and `KITE_NETWORK` from `middleware/x402.ts`. This creates a circular conceptual dependency (signer depends on middleware constants, middleware defines them).

**Resolution**: Move all Kite-specific constants (KITE_SCHEME, KITE_NETWORK, KITE_PAYMENT_TOKEN, KITE_FACILITATOR_ADDRESS, KITE_FACILITATOR_DEFAULT_URL, KITE_MAX_TIMEOUT_SECONDS) into `src/adapters/kite-ozone/payment.ts` as private constants. Neither `x402.ts` middleware nor any other file outside the adapter references them. The adapter provides these values through its interface methods (e.g., `quote()` returns the facilitator URL, `settle()` uses the network internally).

After refactor: `x402.ts` has zero imports from any kite-specific module. It only imports from `src/adapters/registry.ts`.

### DT-LAZY: Replacing kite-client.ts top-level await

**Current state**: `src/services/kite-client.ts` line 42: `export const kiteClient = await initKiteClient()` -- top-level await that runs at module import time.

**Problem**: Top-level await means the module cannot be imported without triggering async initialization. This works today because `src/index.ts` imports it eagerly. But for the adapter pattern, initialization must be explicit and controllable.

**Resolution**: `src/adapters/kite-ozone/client.ts` replaces top-level await with a lazy singleton:

```
let _client: PublicClient | null = null
let _initialized = false

async function initClient(): Promise<void> {
  // same logic as current initKiteClient()
  _initialized = true
}

function getClient(): PublicClient | null {
  return _client
}

function requireClient(): PublicClient {
  if (!_client) throw new Error('...')
  return _client
}
```

`initClient()` is called by `createKiteOzoneAdapters()` which is called by `initAdapters()` in `src/index.ts`. Sequence:

```
src/index.ts
  -> await initAdapters()
    -> createKiteOzoneAdapters()
      -> await initClient()  // replaces top-level await
```

**Test impact**: `kite-client.test.ts` currently uses `vi.resetModules()` to re-evaluate the top-level await. With lazy init, tests can call `initClient()` directly with controlled params -- simpler, no module reset needed. However, to minimize test changes (CD-1), we keep the same test structure and update only import paths.

### DT-GASLESS: Extracting gasless-signer.ts

**Current state**: `src/lib/gasless-signer.ts` is a 376-line module with 8 exported functions, 6 private functions, module-level state (`_walletClient`, `_tokenCache`), and hardcoded Kite URLs.

**Resolution**: Create `src/adapters/kite-ozone/gasless.ts` as a class `KiteOzoneGaslessAdapter` implementing `GaslessAdapter`:
- `transfer(req)` encapsulates: `getSupportedToken()` -> `signTransferWithAuthorization()` -> `submitGaslessTransfer()`. Consumer just calls `adapter.transfer({ to, value })`.
- `status()` encapsulates `getGaslessStatus()`. Returns `GaslessAdapterStatus`.
- All Kite-specific constants (GASLESS_BASE_URL, FALLBACK_TOKEN, etc.) become private to the adapter.
- `_resetGaslessSigner()` test helper preserved as `_reset()` on the adapter class.

**WKH-38 preservation**: The graceful degradation logic (`computeFundingState`, `getOperatorTokenBalance`) moves entirely into the adapter. The route handler in `gasless.ts` checks `status().funding_state` before calling `transfer()` -- same flow as today.

### DT-DASHBOARD: Generalizing dashboard Kite labels

**Current state**:
- `src/routes/dashboard.ts` line 15: `KITE_EXPLORER_URL` env var
- `src/static/dashboard.html` line 133: footer "Kite Hackathon 2026"
- `src/static/dashboard.html` line 137: JS var `EXPLORER_URL = '{{KITE_EXPLORER_URL}}'`

**Resolution**:
- New env var: `CHAIN_EXPLORER_URL` (falls back to `KITE_EXPLORER_URL` for backwards compat during transition, then to `https://testnet.kitescan.ai`).
- `dashboard.ts` reads `process.env.CHAIN_EXPLORER_URL || process.env.KITE_EXPLORER_URL || getChainConfig().explorerUrl`.
- Template var renamed to `{{CHAIN_EXPLORER_URL}}`.
- Footer text: "WasiAI A2A Protocol v0.1.0 | Chain-Adaptive Gateway | Auto-refresh: 5s".
- `getChainConfig()` from registry provides the explorerUrl so it is always correct per chain.

### DT-AUGMENTATION: Fastify request augmentation rename

**Current state**: `declare module 'fastify' { interface FastifyRequest { kiteTxHash?: string; kitePaymentVerified?: boolean } }` in x402.ts (line 33-38).

**Resolution**: Rename to `paymentTxHash` and `paymentVerified`. Update all consumers (`compose.ts`, `orchestrate.ts` routes). The response JSON field changes from `kiteTxHash` to `paymentTxHash`. Since this is a field name in the response body and this is still pre-production (hackathon), the rename is safe. No external clients depend on `kiteTxHash` as a stable API.

### DT-PIEVERSE-TYPES: Keeping Pieverse types in types/index.ts

**Current state**: `PieverseVerifyRequest`, `PieverseVerifyResponse`, `PieverseSettleRequest`, `PieverseSettleResult` are in `src/types/index.ts`.

**Resolution**: These types are only used by the kite-ozone payment adapter internally. However, moving them would require changing the types file which other modules import. To minimize churn, keep them in `src/types/index.ts` but add a comment marking them as "Used by kite-ozone adapter only". The adapter DTOs (SettleRequest, VerifyResult, etc.) are the chain-agnostic wrappers; Pieverse types are the chain-specific implementation detail.

In future (post-hackathon), Pieverse types can be moved to `src/adapters/kite-ozone/types.ts`.

## 6. Constraint Directives (Anti-Alucinacion)

### Inherited from work-item (CD-1 through CD-9)

- CD-1: OBLIGATORIO -- Zero regression. All 119 tests MUST pass unchanged. Only import path updates allowed in test files.
- CD-2: PROHIBIDO -- No new npm dependencies. Adapter pattern uses only viem and fastify (existing).
- CD-3: PROHIBIDO -- No ethers.js. viem only.
- CD-4: OBLIGATORIO -- TypeScript strict. No `any`. No `as unknown` escapes.
- CD-5: PROHIBIDO -- No Kite/Ozone/gokite/Pieverse references outside `src/adapters/kite-ozone/` and `src/adapters/types.ts` after refactor is complete (AC-15). Exception: `src/types/index.ts` retains Pieverse types with deprecation comment (DT-PIEVERSE-TYPES). Exception: `src/services/llm/transform.ts` retains `kite_schema_transforms` table name (SCOPE OUT).
- CD-6: OBLIGATORIO -- Adapter interfaces MUST match CHAIN-ADAPTIVE.md section L2 signatures, plus `sign()` extension on PaymentAdapter (DT-3).
- CD-7: PROHIBIDO -- No behavior changes. Every HTTP endpoint returns identical responses for identical inputs.
- CD-8: OBLIGATORIO -- OPERATOR_PRIVATE_KEY, signatures, nonces SHALL NEVER be logged.
- CD-9: OBLIGATORIO -- AR fuerte obligatorio. Regression risk HIGH.

### New from SDD

- CD-10: OBLIGATORIO -- `initAdapters()` must be called in `src/index.ts` before any route registration. Failure to init must prevent server startup.
- CD-11: PROHIBIDO -- No file outside `src/adapters/kite-ozone/` may import from `src/adapters/kite-ozone/chain.ts`, `client.ts`, `payment.ts`, `gasless.ts`, or `attestation.ts` directly. All access through registry.
- CD-12: OBLIGATORIO -- The `WASIAI_A2A_CHAIN` env var defaults to `"kite-ozone-testnet"` if not set, preserving current behavior without any env var change required.
- CD-13: PROHIBIDO -- Do NOT rename `kite_schema_transforms` table or its references in `src/services/llm/transform.ts`. That is a separate migration ticket.
- CD-14: OBLIGATORIO -- Deleted files (`kite-chain.ts`, `kite-client.ts`, `x402-signer.ts`, `gasless-signer.ts`) must be deleted AFTER all consumers are updated and tests pass. Not before.

## 7. Scope

**IN:**
- 4 adapter interfaces + DTO types (`src/adapters/types.ts`)
- Registry factory (`src/adapters/registry.ts`)
- kite-ozone bundle: payment, gasless, attestation stub, client, chain, index (6 files in `src/adapters/kite-ozone/`)
- Consumer refactor: x402.ts, compose.ts (service), gasless.ts (routes), index.ts, dashboard.ts, dashboard.html, types/index.ts, compose.ts (routes), orchestrate.ts (routes)
- 3 new test files, 3 existing test files updated (import paths only)
- 4 old files deleted (kite-chain.ts, kite-client.ts, x402-signer.ts, gasless-signer.ts)

**OUT:**
- DB table rename (`kite_schema_transforms`) -- separate ticket
- L3 primitives (IdentityService, BudgetService, AuthzService) -- WKH-34
- evm-generic, base, mock adapter implementations -- Fase 2
- IdentityBindingAdapter implementation (interface only)
- New endpoints or L4 API changes
- Real attestation logic
- .env.example updates -- handled by docs at DONE

## 8. Wave Plan

### Wave 0 (Serial Gate -- Prerequisites)

- W0.1: Verify all 119 tests pass on clean branch before starting.
- W0.2: Create directory structure: `src/adapters/`, `src/adapters/kite-ozone/`, `src/adapters/__tests__/`.

### Wave 1 (Additive only -- zero regression risk)

| Task | Files | Description |
|------|-------|-------------|
| W1.1 | `src/adapters/types.ts` | Create all 4 adapter interfaces + all DTO types. Pure type declarations, no runtime code. |
| W1.2 | `src/adapters/registry.ts` | Create registry skeleton with `initAdapters()`, all 4 `get*Adapter()` functions, `getChainConfig()`. Initially throws "not initialized" for everything. |

**Verification**: `npx tsc --noEmit` passes. No runtime test needed (no consumers yet).

### Wave 2 (Chain infrastructure -- low risk)

| Task | Files | Description |
|------|-------|-------------|
| W2.1 | `src/adapters/kite-ozone/chain.ts` | Copy `kiteTestnet` defineChain from `src/lib/kite-chain.ts`. Keep old file temporarily. |
| W2.2 | `src/adapters/kite-ozone/client.ts` | Move `initKiteClient` logic from `src/services/kite-client.ts`. Replace top-level await with lazy init. Keep old file as thin re-export temporarily. |
| W2.3 | `src/adapters/kite-ozone/index.ts` | Create factory `createKiteOzoneAdapters()`. Wire up chain.ts and client.ts. Instantiate adapter stubs for now. |

**Verification**: `npm test` -- all 119 pass (old files still exist as re-exports).

### Wave 3 (Payment critical path -- HIGH RISK)

| Task | Files | Description |
|------|-------|-------------|
| W3.1 | `src/adapters/kite-ozone/payment.ts` | Create `KiteOzonePaymentAdapter` implementing PaymentAdapter. Move: (a) KITE_* constants from x402.ts, (b) verifyPayment/settlePayment Pieverse calls from x402.ts, (c) signX402Authorization/EIP-712 logic from x402-signer.ts. Adapter uses kite-ozone/client.ts and kite-ozone/chain.ts internally. |
| W3.2 | `src/middleware/x402.ts` | Remove KITE_* constants, verifyPayment, settlePayment. Import `getPaymentAdapter()` from registry. `requirePayment` calls `adapter.verify()` and `adapter.settle()`. `buildX402Response` gets scheme/network/token from adapter via `adapter.quote()`. Rename Fastify augmentation to `paymentTxHash`/`paymentVerified`. |
| W3.3 | `src/services/compose.ts` | Replace `signX402Authorization` import with `getPaymentAdapter().sign()`. Replace `settlePayment` import with `getPaymentAdapter().settle()`. |
| W3.4 | Wire registry | Update `src/adapters/registry.ts` to import and instantiate kite-ozone payment adapter. Update `initAdapters()`. |

**Verification**: `npm test` -- all 119 pass. Manual smoke: verify x402 middleware still returns 402 with correct payload shape.

### Wave 4 (Gasless path -- MEDIUM RISK)

| Task | Files | Description |
|------|-------|-------------|
| W4.1 | `src/adapters/kite-ozone/gasless.ts` | Create `KiteOzoneGaslessAdapter` implementing GaslessAdapter. Move all logic from `src/lib/gasless-signer.ts`. Adapter owns GASLESS_BASE_URL, FALLBACK_TOKEN, EIP3009_TYPES, WKH-38 degradation logic. |
| W4.2 | `src/routes/gasless.ts` | Replace imports from `gasless-signer.js` with `getGaslessAdapter()` from registry. `status` route calls `adapter.status()`. `transfer` route calls `adapter.transfer({ to, value })`. |
| W4.3 | Wire registry | Update registry to instantiate kite-ozone gasless adapter. |

**Verification**: `npm test` -- all 119 pass.

### Wave 5 (Stubs -- zero risk)

| Task | Files | Description |
|------|-------|-------------|
| W5.1 | `src/adapters/kite-ozone/attestation.ts` | Create `KiteOzoneAttestationAdapter` stub. `attest()` returns `{ txHash: '0x0', proofUrl: '' }` with warning log. `verify()` returns `true`. |
| W5.2 | `src/adapters/types.ts` (update) | Add `IdentityBindingAdapter` to exported interfaces (interface only, no kite-ozone impl in this HU). |
| W5.3 | Wire registry | Register attestation adapter. `getIdentityBindingAdapter()` throws "not implemented for kite-ozone-testnet" (acceptable -- interface-only per scope). |

**Verification**: `npx tsc --noEmit` passes.

### Wave 6 (Consumer cleanup + delete old files -- MEDIUM RISK)

| Task | Files | Description |
|------|-------|-------------|
| W6.1 | `src/types/index.ts` | Generalize `X402PaymentPayload.scheme` to `string`, `.network` to `string`, `GaslessStatus.network` to `string`. |
| W6.2 | `src/index.ts` | Replace `import { kiteClient }` with `import { initAdapters, getChainConfig }`. Call `await initAdapters()` before route registration. Update banner to use `getChainConfig()`. |
| W6.3 | `src/routes/dashboard.ts` | Read `CHAIN_EXPLORER_URL` (fallback to `KITE_EXPLORER_URL`, then `getChainConfig().explorerUrl`). Update template var. |
| W6.4 | `src/static/dashboard.html` | Replace `{{KITE_EXPLORER_URL}}` with `{{CHAIN_EXPLORER_URL}}`. Update footer text. |
| W6.5 | `src/routes/compose.ts` | Rename `request.kiteTxHash` to `request.paymentTxHash`. |
| W6.6 | `src/routes/orchestrate.ts` | Rename `request.kiteTxHash` to `request.paymentTxHash`. |
| W6.7 | Delete old files | Delete `src/lib/kite-chain.ts`, `src/services/kite-client.ts`, `src/lib/x402-signer.ts`, `src/lib/gasless-signer.ts`. |

**Verification**: `npm test` -- all 119 pass. `grep -r "KITE\|gokite\|Pieverse\|kite-chain\|kite-client\|x402-signer\|gasless-signer" src/ --include="*.ts" --include="*.html" | grep -v "adapters/kite-ozone" | grep -v "node_modules"` returns ONLY:
- `src/types/index.ts` (Pieverse types with deprecation comment -- acceptable per DT-PIEVERSE-TYPES)
- `src/services/llm/transform.ts` (`kite_schema_transforms` -- SCOPE OUT per CD-13)

### Wave 7 (Tests + final audit)

| Task | Files | Description |
|------|-------|-------------|
| W7.1 | `src/adapters/__tests__/payment.contract.test.ts` | Contract tests: verify KiteOzonePaymentAdapter implements PaymentAdapter. Test settle/verify/quote/sign return correct shapes with mocked Pieverse. |
| W7.2 | `src/adapters/__tests__/gasless.contract.test.ts` | Contract tests: verify KiteOzoneGaslessAdapter implements GaslessAdapter. Test transfer/status return shapes. Test WKH-38 degradation states. |
| W7.3 | `src/adapters/__tests__/registry.test.ts` | Test: default chain, unsupported chain error message, getChainConfig(). |
| W7.4 | `src/services/kite-client.test.ts` | Update imports only. All 8 assertions unchanged. |
| W7.5 | `src/lib/gasless-signer.test.ts` | Update imports only. All 16 assertions unchanged. NOTE: this file will be at its current path but import from the new adapter path. Or move the test to `src/adapters/__tests__/` -- Architect recommends keeping at old path to minimize git diff, updating only the import paths. |
| W7.6 | `src/services/compose.test.ts` | Update mock paths for x402-signer and x402 to point to adapter registry. |
| W7.7 | Final audit | Run full `npm test` (expect 119 + new contract tests). Run Kite-reference grep (see W6 verification). |

**Verification**: All tests pass. Grep audit clean.

## 9. Risks

| Riesgo | Probabilidad | Impacto | Mitigacion |
|--------|-------------|---------|------------|
| Wave 3 regression (payment path) | Media | Alto | Run full test suite after each sub-task in W3. Keep old exports until all consumers updated. |
| Top-level await removal breaks test mocking strategy | Baja | Medio | kite-client.test.ts already uses `vi.resetModules()`. Lazy init is MORE mockable, not less. |
| Circular import not fully resolved | Baja | Medio | x402.ts will import ONLY from registry.ts. Payment adapter has zero imports from x402.ts. Verified by import analysis. |
| Gasless WKH-38 degradation broken | Media | Alto | 16 existing tests in gasless-signer.test.ts cover all degradation states. Run after W4. |
| Compose.test.ts mock paths break | Media | Medio | Update mock paths carefully. Verify each mock intercepts correctly. |
| kite_schema_transforms reference leaks into adapter scope | Baja | Bajo | CD-13 explicitly prohibits touching it. Grep audit in W7 catches any slip. |
| Dashboard HTML template var rename breaks rendering | Baja | Bajo | Simple find/replace. Visual check. |

## 10. Dependencies

- WKH-38 (gasless graceful degradation) -- DONE (merged)
- No other blockers.

## 11. Test Plan

| Test File | ACs Covered | Wave | What it tests |
|-----------|-------------|------|---------------|
| `src/adapters/__tests__/payment.contract.test.ts` | AC-1, AC-2, AC-3, AC-9, AC-10 | W7 | PaymentAdapter interface compliance. settle/verify/quote/sign return shapes. Mocked Pieverse calls. |
| `src/adapters/__tests__/gasless.contract.test.ts` | AC-1, AC-2, AC-4, AC-11 | W7 | GaslessAdapter interface compliance. transfer/status return shapes. WKH-38 degradation states. |
| `src/adapters/__tests__/registry.test.ts` | AC-7, AC-8, AC-12 | W7 | Default WASIAI_A2A_CHAIN selection. Unsupported chain error. Individual adapter override env vars. |
| `src/services/kite-client.test.ts` (updated) | AC-12 | W7 | Same 8 tests, updated imports. Verifies client init logic preserved. |
| `src/lib/gasless-signer.test.ts` (updated) | AC-4, AC-13 | W7 | Same 16 tests, updated imports. Zero assertion changes. |
| `src/services/compose.test.ts` (updated) | AC-10, AC-13 | W7 | Updated mock paths. Verifies compose still calls adapter methods correctly. |
| All other existing tests (unchanged) | AC-13 | W7 | Pass without modification. Proves zero behavior change. |
| W7.7 grep audit | AC-15 | W7 | No Kite/gokite/Pieverse refs outside allowed paths. |

## 12. Readiness Check

- [x] Each AC has at least 1 file associated in section 4.1
- [x] Each file in section 4.1 has an exemplar (verified with Glob/Read)
- [x] No [NEEDS CLARIFICATION] pending (kite_schema_transforms confirmed SCOPE OUT)
- [x] Constraint Directives include 6+ PROHIBIDO (CD-2, CD-3, CD-5, CD-7, CD-11, CD-13, CD-14)
- [x] Context Map has 17 files read
- [x] Scope IN and OUT are explicit and unambiguous
- [x] No DB changes in this HU
- [x] Happy path (section 4.4) is complete
- [x] Error flow (section 4.5) is defined (3 cases)
- [x] All exemplar paths verified: `src/types/index.ts` exists, `src/services/kite-client.ts` exists, `src/middleware/x402.ts` exists, `src/lib/x402-signer.ts` exists, `src/lib/gasless-signer.ts` exists, `src/lib/kite-chain.ts` exists, `src/routes/gasless.ts` exists, `src/services/compose.ts` exists, `src/index.ts` exists, `src/static/dashboard.html` exists, `src/routes/dashboard.ts` exists, `src/routes/compose.ts` exists, `src/routes/orchestrate.ts` exists
- [x] Architecture doc interface signatures match: CHAIN-ADAPTIVE.md L2 lines 132-167
- [x] 119 existing tests confirmed (vitest run verified)
- [x] 7 waves with clear dependencies and verification gates

---

*SDD generado por NexusAgil -- FULL*
