# Story File -- #023: Adapter Refactor L2 -- Extract Kite Hardcoding to src/adapters/kite-ozone/*

> SDD: doc/sdd/023-adapter-refactor-l2/sdd.md
> Fecha: 2026-04-06
> Branch: feat/023-adapter-refactor-l2

---

## Goal

Extract 187 Kite-hardcoded references across 17 source files into a pluggable adapter layer with four interfaces (PaymentAdapter, AttestationAdapter, GaslessAdapter, IdentityBindingAdapter), a runtime registry selected by `WASIAI_A2A_CHAIN` env var, and a `kite-ozone` adapter bundle. This is a PURE REFACTOR: zero behavior change, 119/119 existing tests must pass, plus new contract tests. The result is a binary that can serve any EVM chain by changing only env vars, per `doc/architecture/CHAIN-ADAPTIVE.md` section L2.

## Acceptance Criteria (EARS)

### Interface definition

- AC-1: The system SHALL export `PaymentAdapter`, `AttestationAdapter`, `GaslessAdapter`, and `IdentityBindingAdapter` interfaces from `src/adapters/types.ts` conforming to the signatures defined in `doc/architecture/CHAIN-ADAPTIVE.md` section L2.

- AC-2: Each adapter interface SHALL declare readonly `name` and `chainId` properties plus the method signatures specified in the architecture doc (`settle`/`verify`/`quote` for Payment, `attest`/`verify` for Attestation, `transfer`/`status` for Gasless, `bind`/`verify` for IdentityBinding).

### Kite-Ozone adapter extraction

- AC-3: WHEN the system loads the `kite-ozone` payment adapter, the system SHALL provide the same x402 verify/settle/quote behavior currently in `src/middleware/x402.ts` (Pieverse facilitator calls) and `src/lib/x402-signer.ts` (EIP-712 signing), with zero change in external HTTP behavior.

- AC-4: WHEN the system loads the `kite-ozone` gasless adapter, the system SHALL provide the same EIP-3009 sign/submit/status behavior currently in `src/lib/gasless-signer.ts`, including the WKH-38 graceful degradation (funding_state), with zero change in external HTTP behavior.

- AC-5: WHEN the system loads the `kite-ozone` attestation adapter, the system SHALL provide stub implementations (`attest` returns a placeholder, `verify` returns true) since no attestation logic currently exists in the codebase. The interface SHALL be ready for real Kite Ozone attestation when contracts are available.

- AC-6: `src/adapters/kite-ozone/index.ts` SHALL export a factory function that instantiates all four adapter implementations for the Kite Ozone chain (chainId 2368).

### Registry and runtime selection

- AC-7: `src/adapters/registry.ts` SHALL export `getPaymentAdapter()`, `getAttestationAdapter()`, `getGaslessAdapter()`, and `getIdentityBindingAdapter()` functions that return the adapter selected at runtime based on `WASIAI_A2A_CHAIN` env var (default: `kite-ozone-testnet`).

- AC-8: IF `WASIAI_A2A_CHAIN` env var is set to an unsupported value, THEN the system SHALL throw a descriptive error at adapter resolution time listing supported chains.

### Consumer refactor

- AC-9: `src/middleware/x402.ts` SHALL consume payment operations via `getPaymentAdapter()` from the registry instead of calling Pieverse directly. The middleware's external HTTP behavior (402 responses, X-Payment header decoding, verify/settle flow) SHALL remain identical.

- AC-10: `src/services/compose.ts` SHALL consume x402 signing and settlement via `getPaymentAdapter()` from the registry instead of importing directly from `src/lib/x402-signer.ts` and `src/middleware/x402.ts`.

- AC-11: `src/routes/gasless.ts` SHALL consume gasless operations via `getGaslessAdapter()` from the registry instead of importing directly from `src/lib/gasless-signer.ts`.

- AC-12: `src/services/kite-client.ts` and `src/lib/kite-chain.ts` SHALL be consumed exclusively by the `kite-ozone` adapter internals, not by any file outside `src/adapters/kite-ozone/`.

### Zero regression

- AC-13: WHEN running `npm test`, all 119 existing tests SHALL pass without any modification to test assertions or test logic. Test files may update import paths but SHALL NOT change expected behavior.

- AC-14: The system SHALL include contract tests in `src/adapters/__tests__/` that verify each adapter interface method exists and returns the expected result shape for the `kite-ozone` adapter.

### Cleanup

- AC-15: WHILE the refactor is complete, the system SHALL have zero direct Kite/Ozone/gokite/Pieverse/PYUSD references in any file outside of `src/adapters/kite-ozone/`, `src/adapters/types.ts`, and `src/types/index.ts` (types remain chain-agnostic with Kite-specific values only in the adapter).

## Files to Modify/Create

| # | Archivo | Accion | Wave | Que hacer | Exemplar |
|---|---------|--------|------|-----------|----------|
| 1 | `src/adapters/types.ts` | Crear | W1 | 4 adapter interfaces + all DTO types (see section "Adapter Interface Definitions" below) | `src/types/index.ts` (export-only types, no runtime) |
| 2 | `src/adapters/registry.ts` | Crear | W1 | Registry singleton: `initAdapters()`, 4x `get*Adapter()`, `getChainConfig()`. Reads `WASIAI_A2A_CHAIN` env var. | `src/services/kite-client.ts` (lazy singleton + requireX pattern) |
| 3 | `src/adapters/kite-ozone/chain.ts` | Crear (move) | W2 | Copy `kiteTestnet` defineChain from `src/lib/kite-chain.ts` | `src/lib/kite-chain.ts` (lines 1-33) |
| 4 | `src/adapters/kite-ozone/client.ts` | Crear (move) | W2 | Move kite client init logic. Replace top-level await with lazy init. Export `getKiteClient()` and `requireKiteClient()`. | `src/services/kite-client.ts` (lines 1-55) |
| 5 | `src/adapters/kite-ozone/index.ts` | Crear | W2 | Factory: `createKiteOzoneAdapters()` returning all 4 adapter impls. Chain config (chainId 2368). | New pattern |
| 6 | `src/adapters/kite-ozone/payment.ts` | Crear | W3 | `KiteOzonePaymentAdapter` class. Absorbs: (a) KITE_* constants + verify/settle Pieverse calls from x402.ts, (b) sign/EIP-712 logic from x402-signer.ts | `src/middleware/x402.ts` + `src/lib/x402-signer.ts` |
| 7 | `src/middleware/x402.ts` | Modificar | W3 | Remove KITE_* constants, verifyPayment, settlePayment. Keep `requirePayment`, `buildX402Response`, `decodeXPayment` as thin wrappers over `getPaymentAdapter()`. Rename Fastify augmentation to `paymentTxHash`/`paymentVerified`. | Current self |
| 8 | `src/services/compose.ts` | Modificar | W3 | Replace `signX402Authorization` import (line 16) and `settlePayment` import (line 17) with `getPaymentAdapter()` from registry. | Current self |
| 9 | `src/adapters/kite-ozone/gasless.ts` | Crear | W4 | `KiteOzoneGaslessAdapter` class. Move ALL logic from `src/lib/gasless-signer.ts` (376 lines). Preserve WKH-38 degradation. | `src/lib/gasless-signer.ts` (lines 1-376) |
| 10 | `src/routes/gasless.ts` | Modificar | W4 | Replace imports from `gasless-signer.js` (line 7-11) with `getGaslessAdapter()` from registry. | Current self |
| 11 | `src/adapters/kite-ozone/attestation.ts` | Crear | W5 | `KiteOzoneAttestationAdapter` stub. `attest()` returns `{ txHash: '0x0', proofUrl: '' }` + warning log. `verify()` returns `true`. | New pattern |
| 12 | `src/types/index.ts` | Modificar | W6 | Line 224: `scheme: 'gokite-aa'` -> `scheme: string`. Line 225: `network: 'kite-testnet' \| 'kite-mainnet'` -> `network: string`. Line 435: `network: 'kite-testnet'` -> `network: string`. | Current self |
| 13 | `src/index.ts` | Modificar | W6 | Replace `import { kiteClient }` (line 23) with `import { initAdapters, getChainConfig }`. Call `await initAdapters()` before route registration. Update banner (line 72). | Current self |
| 14 | `src/routes/dashboard.ts` | Modificar | W6 | Replace `KITE_EXPLORER_URL` (line 15) with `CHAIN_EXPLORER_URL` (fallback to `KITE_EXPLORER_URL`, then `getChainConfig().explorerUrl`). Update template var (line 19). | Current self |
| 15 | `src/static/dashboard.html` | Modificar | W6 | Line 133: replace "Kite Hackathon 2026" with "Chain-Adaptive Gateway". Line 137: replace `{{KITE_EXPLORER_URL}}` with `{{CHAIN_EXPLORER_URL}}`. | Current self |
| 16 | `src/routes/compose.ts` | Modificar | W6 | Line 44: rename `request.kiteTxHash` to `request.paymentTxHash`. Line 45: rename `kiteTxHash` in response. | Current self |
| 17 | `src/routes/orchestrate.ts` | Modificar | W6 | Line 60: rename `request.kiteTxHash` to `request.paymentTxHash`. Line 61: rename `kiteTxHash` in response. | Current self |
| 18 | `src/lib/kite-chain.ts` | Eliminar | W6 | Moved to `src/adapters/kite-ozone/chain.ts`. DELETE after all consumers updated. | N/A |
| 19 | `src/services/kite-client.ts` | Eliminar | W6 | Moved to `src/adapters/kite-ozone/client.ts`. DELETE after all consumers updated. | N/A |
| 20 | `src/lib/x402-signer.ts` | Eliminar | W3 | Logic absorbed into `src/adapters/kite-ozone/payment.ts`. DELETE after compose.ts updated. | N/A |
| 21 | `src/lib/gasless-signer.ts` | Eliminar | W4 | Logic absorbed into `src/adapters/kite-ozone/gasless.ts`. DELETE after routes/gasless.ts updated. | N/A |
| 22 | `src/adapters/__tests__/payment.contract.test.ts` | Crear | W7 | Contract tests for PaymentAdapter. | `src/services/kite-client.test.ts` |
| 23 | `src/adapters/__tests__/gasless.contract.test.ts` | Crear | W7 | Contract tests for GaslessAdapter. | `src/lib/gasless-signer.test.ts` |
| 24 | `src/adapters/__tests__/registry.test.ts` | Crear | W7 | Registry resolution tests. | `src/services/kite-client.test.ts` |
| 25 | `src/services/kite-client.test.ts` | Modificar | W7 | Update imports to adapter paths. Keep all 8 assertions unchanged. | Current self |
| 26 | `src/lib/gasless-signer.test.ts` | Modificar | W7 | Update imports to adapter paths. Keep all 16 assertions unchanged. | Current self |
| 27 | `src/services/compose.test.ts` | Modificar | W7 | Update mock paths from `x402-signer.js` and `x402.js` to adapter registry. | Current self |

## Exemplars

### Exemplar 1: Types-only module
**Archivo**: `src/types/index.ts` (lines 215-306)
**Usar para**: File #1 (`src/adapters/types.ts`)
**Patron clave**:
- Pure `export interface` declarations, no runtime code
- JSDoc comments on each interface and field
- `0x${string}` template literal type for addresses (line 437)
- Related types grouped with section header comments

### Exemplar 2: Lazy singleton + requireX pattern
**Archivo**: `src/services/kite-client.ts` (lines 1-55)
**Usar para**: Files #2 (`registry.ts`), #4 (`kite-ozone/client.ts`)
**Patron clave**:
- Module-level `let` variable, initially null: `let _client: PublicClient | null = null` (line 42 top-level await becomes lazy)
- `requireX()` function that throws descriptive error if null (lines 48-55)
- `async function init()` that does the actual work (lines 19-40)
- Console logging on successful connection (line 34)
- Console.warn on missing config (line 23)

### Exemplar 3: Payment middleware pattern
**Archivo**: `src/middleware/x402.ts` (lines 1-277)
**Usar para**: File #6 (`kite-ozone/payment.ts`), File #7 (refactored `x402.ts`)
**Patron clave**:
- Constants grouped with section comment (lines 24-29)
- Pieverse fetch calls with try/catch returning typed results (lines 119-183)
- Error wrapping: `throw new Error(\`description: ${err instanceof Error ? err.message : String(err)}\`)` (lines 139-141)
- Type imports from `../types/index.js` with `.js` extension (line 11-20)

### Exemplar 4: Gasless module pattern
**Archivo**: `src/lib/gasless-signer.ts` (lines 1-376)
**Usar para**: File #9 (`kite-ozone/gasless.ts`)
**Patron clave**:
- Module-level state: `_walletClient`, `_tokenCache` (lines 53-54)
- `getWalletClient()` lazy init with `OPERATOR_PRIVATE_KEY` (lines 58-74)
- `buildDomain()` with chain-specific config (lines 76-83)
- WKH-38 graceful degradation: `computeFundingState()` returns `GaslessFundingState` enum (lines 297-306)
- `_resetGaslessSigner()` test helper (lines 372-375)
- sanitizeError helper -- NEVER expose PK or internals (lines 95-100)

### Exemplar 5: EIP-712 signer pattern
**Archivo**: `src/lib/x402-signer.ts` (lines 1-128)
**Usar para**: File #6 (`kite-ozone/payment.ts` -- sign method)
**Patron clave**:
- EIP712_DOMAIN constant with chain-specific values (lines 19-24)
- EIP712_TYPES constant (lines 26-35)
- Lazy singleton wallet client (lines 39-57)
- `signTypedData` call with typed domain/types/message (lines 93-106)
- Base64 encode for X-Payment header (lines 114-116)
- `_resetWalletClient()` test helper (lines 125-127)

### Exemplar 6: Vitest patterns
**Archivo**: `src/services/kite-client.test.ts`
**Usar para**: Files #22-24 (all new test files)
**Patron clave**:
- `vi.mock()` at top level
- `vi.resetModules()` for re-evaluation
- `describe/it/expect` structure
- Mock factory returns

## Adapter Interface Definitions

These are the FULL TypeScript interfaces to implement in `src/adapters/types.ts`. Copy them verbatim.

### PaymentAdapter

```typescript
export interface PaymentAdapter {
  readonly name: string          // e.g. "kite-ozone"
  readonly chainId: number       // e.g. 2368
  readonly supportedTokens: TokenSpec[]

  settle(req: SettleRequest): Promise<SettleResult>
  verify(proof: X402Proof): Promise<VerifyResult>
  quote(amountUsd: number): Promise<QuoteResult>
  sign(opts: SignRequest): Promise<SignResult>
}
```

**Design note**: `sign()` is added beyond the architecture doc spec because `src/services/compose.ts` line 230 calls `signX402Authorization` (client-side EIP-712 signing). Without `sign()` on the adapter, compose.ts would still need a direct import to the kite-ozone signer, defeating the purpose.

### AttestationAdapter

```typescript
export interface AttestationAdapter {
  readonly name: string
  readonly chainId: number

  attest(event: AttestEvent): Promise<{ txHash: string; proofUrl: string }>
  verify(ref: AttestRef): Promise<boolean>
}
```

### GaslessAdapter

```typescript
export interface GaslessAdapter {
  readonly name: string
  readonly chainId: number

  transfer(req: GaslessTransferAdapterRequest): Promise<GaslessAdapterResult>
  status(): Promise<GaslessAdapterStatus>
}
```

**Design note**: `GaslessTransferAdapterRequest` is simplified -- the adapter handles signing internally. Consumer just provides `to` and `value`. The adapter's `transfer()` does sign + submit as one atomic operation.

### IdentityBindingAdapter

```typescript
export interface IdentityBindingAdapter {
  readonly name: string
  readonly chainId: number

  bind(keyId: string, chainAddress: string, sig: `0x${string}`): Promise<BindResult>
  verify(keyId: string): Promise<BindVerification>
}
```

### DTO Types

```typescript
export interface TokenSpec {
  symbol: string           // "PYUSD", "USDC"
  address: `0x${string}`
  decimals: number
}

export interface SettleRequest {
  authorization: X402PaymentRequest['authorization']
  signature: string
  network: string
}

export interface SettleResult {
  txHash: string
  success: boolean
  error?: string
}

export interface X402Proof {
  authorization: X402PaymentRequest['authorization']
  signature: string
  network: string
}

export interface VerifyResult {
  valid: boolean
  error?: string
}

export interface QuoteResult {
  amountWei: string
  token: TokenSpec
  facilitatorUrl: string
}

export interface SignRequest {
  to: `0x${string}`
  value: string
  timeoutSeconds?: number
}

export interface SignResult {
  xPaymentHeader: string
  paymentRequest: X402PaymentRequest
}

export interface AttestEvent {
  type: string
  payload: Record<string, unknown>
}

export interface AttestRef {
  txHash: string
}

export interface GaslessTransferAdapterRequest {
  to: `0x${string}`
  value: bigint
}

export interface GaslessAdapterResult {
  txHash: `0x${string}`
}

export interface GaslessAdapterStatus {
  enabled: boolean
  network: string
  supportedToken: GaslessSupportedToken | null
  operatorAddress: `0x${string}` | null
  funding_state: GaslessFundingState
  chain_id?: number
  relayer?: string
  documentation?: string
}

export interface BindResult {
  success: boolean
  txHash?: string
  error?: string
}

export interface BindVerification {
  bound: boolean
  chainAddress?: string
  verifiedAt?: string
}
```

**Note**: `X402PaymentRequest`, `GaslessSupportedToken`, and `GaslessFundingState` are imported from `src/types/index.ts` (they remain there -- shared types, not adapter-specific).

## Circular Dependency Resolution

### Problem

`src/lib/x402-signer.ts` imports FROM `src/middleware/x402.ts`:
```
// x402-signer.ts line 10-13
import { KITE_FACILITATOR_ADDRESS, KITE_NETWORK } from '../middleware/x402.js'
```

This creates a circular conceptual dependency: the signer depends on the middleware for constants, while the middleware defines them. Additionally, `x402-signer.ts` imports `kiteTestnet` from `kite-chain.ts` (line 9).

### Current import chains

```
src/lib/x402-signer.ts
  -> src/lib/kite-chain.ts       (kiteTestnet chain def)
  -> src/middleware/x402.ts       (KITE_FACILITATOR_ADDRESS, KITE_NETWORK)

src/middleware/x402.ts
  -> (no imports from x402-signer or kite-chain)

src/services/compose.ts
  -> src/lib/x402-signer.ts      (signX402Authorization)
  -> src/middleware/x402.ts       (settlePayment)
```

### Solution

Move ALL Kite-specific constants into `src/adapters/kite-ozone/payment.ts` as PRIVATE constants:
- `KITE_SCHEME`, `KITE_NETWORK`, `KITE_PAYMENT_TOKEN`, `KITE_FACILITATOR_ADDRESS`, `KITE_FACILITATOR_DEFAULT_URL`, `KITE_MAX_TIMEOUT_SECONDS`

The refactored `x402.ts` has ZERO imports from any kite-specific module. It only imports from `src/adapters/registry.ts`:

### After-refactor import chains

```
src/middleware/x402.ts
  -> src/adapters/registry.ts     (getPaymentAdapter)
  -> src/types/index.ts           (type-only imports)

src/services/compose.ts
  -> src/adapters/registry.ts     (getPaymentAdapter)

src/adapters/kite-ozone/payment.ts
  -> src/adapters/kite-ozone/chain.ts   (kiteTestnet)
  -> src/adapters/kite-ozone/client.ts  (requireKiteClient -- only for sign)
  -> src/types/index.ts                 (PieverseVerifyRequest, etc.)

src/adapters/registry.ts
  -> src/adapters/kite-ozone/index.ts   (createKiteOzoneAdapters)
  -> src/adapters/types.ts              (interface types)
```

No circular dependencies. No cross-layer imports.

## Top-Level Await Replacement

### Problem

`src/services/kite-client.ts` line 42:
```typescript
export const kiteClient: PublicClient | null = await initKiteClient()
```

Top-level await runs at import time. For the adapter pattern, initialization must be explicit.

### Solution

In `src/adapters/kite-ozone/client.ts`, replace with lazy singleton:

```
let _client: PublicClient | null = null
let _initialized = false

async function initClient(rpcUrl?: string): Promise<void> {
  // same logic as current initKiteClient() (kite-client.ts lines 19-40)
  _initialized = true
}

function getClient(): PublicClient | null { return _client }

function requireClient(): PublicClient {
  if (!_client) throw new Error('Kite client not initialized. Call initAdapters() first.')
  return _client
}
```

Initialization sequence in `src/index.ts`:
```
await initAdapters()  // replaces "import { kiteClient }"
  -> createKiteOzoneAdapters()
    -> await initClient()
```

## Registry Design

```
// src/adapters/registry.ts

Env var: WASIAI_A2A_CHAIN (default: "kite-ozone-testnet")
Optional overrides: PAYMENT_ADAPTER, ATTESTATION_ADAPTER, GASLESS_ADAPTER, IDENTITY_BINDING_ADAPTER

Supported chain bundles (phase 1):
  "kite-ozone-testnet" -> kite-ozone adapters (chainId 2368)

Unsupported chain -> throw Error("Unsupported chain '${chain}'. Supported: kite-ozone-testnet")

Functions:
  initAdapters(): Promise<void>       -- called once at startup
  getPaymentAdapter(): PaymentAdapter
  getAttestationAdapter(): AttestationAdapter
  getGaslessAdapter(): GaslessAdapter
  getIdentityBindingAdapter(): IdentityBindingAdapter   -- throws "not implemented" for kite-ozone
  getChainConfig(): { name: string, chainId: number, explorerUrl: string }
```

Each `get*Adapter()` throws if `initAdapters()` not called yet (same as `requireKiteClient()` pattern).

`getChainConfig()` returns chain-agnostic metadata for display consumers (dashboard.ts, index.ts banner).

## Constraint Directives

### OBLIGATORIO

- CD-1: Zero regression. All 119 tests MUST pass unchanged. Only import path updates allowed in test files.
- CD-4: TypeScript strict. No `any`. No `as unknown` escapes.
- CD-6: Adapter interfaces MUST match CHAIN-ADAPTIVE.md section L2 signatures, plus `sign()` on PaymentAdapter.
- CD-8: OPERATOR_PRIVATE_KEY, signatures, nonces SHALL NEVER be logged (inherited from WKH-29).
- CD-9: AR fuerte obligatorio. Regression risk HIGH.
- CD-10: `initAdapters()` must be called in `src/index.ts` BEFORE any route registration. Failure to init must prevent server startup.
- CD-11: No file outside `src/adapters/kite-ozone/` may import from `src/adapters/kite-ozone/chain.ts`, `client.ts`, `payment.ts`, `gasless.ts`, or `attestation.ts` directly. All access through registry.
- CD-12: `WASIAI_A2A_CHAIN` defaults to `"kite-ozone-testnet"` if not set. Current behavior preserved without env var change.
- CD-14: Deleted files MUST be deleted AFTER all consumers are updated and tests pass. Not before.

### PROHIBIDO

- CD-2: No new npm dependencies. Adapter pattern uses only viem and fastify (existing).
- CD-3: No ethers.js. viem only.
- CD-5: No Kite/Ozone/gokite/Pieverse references outside `src/adapters/kite-ozone/` and `src/adapters/types.ts` after refactor. Exceptions: (a) `src/types/index.ts` retains Pieverse types with deprecation comment, (b) `src/services/llm/transform.ts` retains `kite_schema_transforms` table name.
- CD-7: No behavior changes. Every HTTP endpoint returns identical responses for identical inputs.
- CD-13: Do NOT rename `kite_schema_transforms` table or its references in `src/services/llm/transform.ts`. Separate migration ticket.
- NO modificar archivos fuera de la tabla "Files to Modify/Create"
- NO crear patrones diferentes a los existentes
- NO hardcodear valores configurables que no esten ya hardcodeados en la fuente original

## Test Expectations

| Test | ACs que cubre | Framework | Tipo |
|------|--------------|-----------|------|
| `src/adapters/__tests__/payment.contract.test.ts` | AC-1, AC-2, AC-3, AC-9, AC-10 | vitest | contract |
| `src/adapters/__tests__/gasless.contract.test.ts` | AC-1, AC-2, AC-4, AC-11 | vitest | contract |
| `src/adapters/__tests__/registry.test.ts` | AC-7, AC-8, AC-12 | vitest | unit |
| `src/services/kite-client.test.ts` (updated) | AC-12, AC-13 | vitest | unit (import path update only) |
| `src/lib/gasless-signer.test.ts` (updated) | AC-4, AC-13 | vitest | unit (import path update only) |
| `src/services/compose.test.ts` (updated) | AC-10, AC-13 | vitest | unit (mock path update only) |
| All 119 existing tests (unchanged assertions) | AC-13 | vitest | regression |
| W7.7 grep audit | AC-15 | bash | validation |

### Criterio Test-First

| Tipo de cambio | Test-first? |
|----------------|-------------|
| Adapter interfaces (types) | No (pure types, no runtime) |
| Registry (logic) | No (consumers tested in W7) |
| Payment adapter extraction | No (existing 119 tests serve as regression) |
| Gasless adapter extraction | No (existing 16 gasless tests serve as regression) |
| Contract tests (W7) | Yes -- write contract tests, then verify they pass |

### Contract test specifications

**payment.contract.test.ts** must verify:
- `KiteOzonePaymentAdapter` implements `PaymentAdapter` interface
- `adapter.name` equals `"kite-ozone"`
- `adapter.chainId` equals `2368`
- `adapter.settle()` returns `SettleResult` shape (mock Pieverse fetch)
- `adapter.verify()` returns `VerifyResult` shape (mock Pieverse fetch)
- `adapter.quote()` returns `QuoteResult` shape
- `adapter.sign()` returns `SignResult` shape (mock wallet client)

**gasless.contract.test.ts** must verify:
- `KiteOzoneGaslessAdapter` implements `GaslessAdapter` interface
- `adapter.name` equals `"kite-ozone"`
- `adapter.transfer()` returns `GaslessAdapterResult` shape (mock fetch + wallet)
- `adapter.status()` returns `GaslessAdapterStatus` shape
- `adapter.status()` returns all 4 WKH-38 degradation states (`disabled`, `unconfigured`, `unfunded`, `ready`)

**registry.test.ts** must verify:
- Default `WASIAI_A2A_CHAIN` resolves to kite-ozone adapters
- Unsupported chain throws error listing supported chains
- `getChainConfig()` returns `{ name, chainId, explorerUrl }`
- `get*Adapter()` throws if `initAdapters()` not called

## Waves

### Wave -1: Environment Gate (OBLIGATORIO -- verificar antes de tocar codigo)

```bash
# Verify dependencies installed
npm install 2>/dev/null || echo "Sin package.json"

# Verify all 119 tests pass BEFORE starting
npm test

# Verify key source files exist
ls src/middleware/x402.ts src/lib/x402-signer.ts src/services/kite-client.ts src/lib/kite-chain.ts src/lib/gasless-signer.ts src/routes/gasless.ts src/services/compose.ts src/index.ts src/routes/dashboard.ts src/static/dashboard.html src/routes/compose.ts src/routes/orchestrate.ts src/types/index.ts 2>/dev/null || echo "FALTA archivo base"

# Verify target directories do NOT exist yet
ls src/adapters/ 2>/dev/null && echo "WARNING: src/adapters/ already exists" || echo "OK: src/adapters/ does not exist yet"
```

**Si algo falla en Wave -1:** PARAR y reportar al orquestador antes de continuar.

### Wave 0 (Serial Gate -- crear estructura)

- [ ] W0.1: Verify all 119 tests pass: `npm test`
- [ ] W0.2: Create directory structure: `mkdir -p src/adapters/kite-ozone src/adapters/__tests__`

**Verificacion**: `ls src/adapters/kite-ozone src/adapters/__tests__` succeeds.

### Wave 1 (Additive only -- zero regression risk)

- [ ] W1.1: Create `src/adapters/types.ts` -- all 4 adapter interfaces + all DTO types from "Adapter Interface Definitions" section above. Pure type declarations only. Import `X402PaymentRequest`, `GaslessSupportedToken`, `GaslessFundingState` from `../types/index.js`.
- [ ] W1.2: Create `src/adapters/registry.ts` -- registry skeleton. `initAdapters()` initially just logs. All `get*Adapter()` throw "adapters not initialized". `getChainConfig()` throws same.

**Verificacion**: `npx tsc --noEmit` passes. No runtime test needed.

### Wave 2 (Chain infrastructure -- low risk)

- [ ] W2.1: Create `src/adapters/kite-ozone/chain.ts` -- Copy `kiteTestnet` defineChain verbatim from `src/lib/kite-chain.ts` (lines 1-33). Keep old file temporarily.
- [ ] W2.2: Create `src/adapters/kite-ozone/client.ts` -- Move init logic from `src/services/kite-client.ts` (lines 19-40). Replace top-level await with lazy `initClient()` + `getClient()` + `requireClient()`. Keep old file as thin re-export temporarily: `export { getClient as kiteClient, requireClient as requireKiteClient } from '../adapters/kite-ozone/client.js'`. NOTE: the re-export must match old API shape (`kiteClient` was a `PublicClient | null`, now it needs to be a function call or getter -- handle via property accessor or convert old file to delegate).
- [ ] W2.3: Create `src/adapters/kite-ozone/index.ts` -- Factory `createKiteOzoneAdapters()`. Wire up chain.ts and client.ts. Return adapter stubs for now (payment/gasless/attestation can be placeholder classes that throw "not yet wired").
- [ ] W2.4: Wire registry -- Update `src/adapters/registry.ts` to import `createKiteOzoneAdapters` from `./kite-ozone/index.js`. `initAdapters()` calls `await createKiteOzoneAdapters()` and caches results.

**Verificacion**: `npx tsc --noEmit` passes. `npm test` -- all 119 pass (old files still exist).

### Wave 3 (Payment critical path -- HIGH RISK)

- [ ] W3.1: Create `src/adapters/kite-ozone/payment.ts` -- `KiteOzonePaymentAdapter` implementing `PaymentAdapter`. Move into this file:
  - From `src/middleware/x402.ts` lines 24-29: all 6 KITE_* constants (become private)
  - From `src/middleware/x402.ts` lines 119-183: `verifyPayment()` and `settlePayment()` Pieverse fetch logic (become `verify()` and `settle()` methods)
  - From `src/lib/x402-signer.ts` lines 19-35: EIP712_DOMAIN and EIP712_TYPES (become private)
  - From `src/lib/x402-signer.ts` lines 39-57: wallet client lazy singleton (become private)
  - From `src/lib/x402-signer.ts` lines 75-119: `signX402Authorization()` (becomes `sign()` method)
  - `quote()` returns static values from constants: `{ amountWei: "1000000000000000000", token: { symbol: "PYUSD", address: KITE_PAYMENT_TOKEN, decimals: 18 }, facilitatorUrl }`
  - Expose `_resetWalletClient()` for tests (same pattern as x402-signer.ts line 125)
  - Also expose via getters: `getScheme()`, `getNetwork()`, `getToken()`, `getMaxTimeoutSeconds()`, `getMerchantName()` -- needed by `buildX402Response` in x402.ts

- [ ] W3.2: Refactor `src/middleware/x402.ts`:
  - DELETE: lines 24-29 (6 KITE_* constants) -- now in adapter
  - DELETE: lines 119-183 (verifyPayment, settlePayment functions) -- now in adapter
  - ADD: `import { getPaymentAdapter } from '../adapters/registry.js'`
  - CHANGE: `buildX402Response` (lines 54-83) to get scheme/network/token/maxTimeout from `getPaymentAdapter()` accessors instead of constants
  - CHANGE: `requirePayment` handler (lines 194-277):
    - Line 202: `KITE_WALLET_ADDRESS` -> `process.env.PAYMENT_WALLET_ADDRESS || process.env.KITE_WALLET_ADDRESS` (backwards compat)
    - Lines 229-247: replace `verifyPayment(paymentPayload)` with `getPaymentAdapter().verify({ authorization: paymentPayload.authorization, signature: paymentPayload.signature, network: paymentPayload.network ?? '' })`
    - Lines 249-268: replace `settlePayment(paymentPayload)` with `getPaymentAdapter().settle({ authorization: paymentPayload.authorization, signature: paymentPayload.signature, network: paymentPayload.network ?? '' })`
  - CHANGE: Fastify augmentation (lines 33-38): `kiteTxHash` -> `paymentTxHash`, `kitePaymentVerified` -> `paymentVerified`
  - CHANGE: Line 271: `request.kiteTxHash` -> `request.paymentTxHash`
  - CHANGE: Line 272: `request.kitePaymentVerified` -> `request.paymentVerified`

- [ ] W3.3: Refactor `src/services/compose.ts`:
  - DELETE: line 16 `import { signX402Authorization } from '../lib/x402-signer.js'`
  - DELETE: line 17 `import { settlePayment } from '../middleware/x402.js'`
  - ADD: `import { getPaymentAdapter } from '../adapters/registry.js'`
  - Line 230: `signX402Authorization({...})` -> `getPaymentAdapter().sign({...})`
  - Line 255: `settlePayment(paymentRequest)` -> `getPaymentAdapter().settle({ authorization: paymentRequest.authorization, signature: paymentRequest.signature, network: paymentRequest.network ?? '' })`

- [ ] W3.4: DELETE `src/lib/x402-signer.ts` -- all logic now in adapter. No consumers remain.

- [ ] W3.5: Wire registry -- update `src/adapters/kite-ozone/index.ts` to instantiate `KiteOzonePaymentAdapter` and return it.

**Verificacion**: `npx tsc --noEmit` clean. `npm test` -- all 119 pass. This is the highest-risk wave. Run tests after EACH sub-task if possible.

### Wave 4 (Gasless path -- MEDIUM RISK)

- [ ] W4.1: Create `src/adapters/kite-ozone/gasless.ts` -- `KiteOzoneGaslessAdapter` implementing `GaslessAdapter`. Move ALL logic from `src/lib/gasless-signer.ts` (376 lines):
  - Constants: `GASLESS_BASE_URL`, `GASLESS_SUBMIT_URL`, `GASLESS_TOKENS_URL`, `VALIDITY_WINDOW_SECONDS`, `FALLBACK_TOKEN`, `EIP3009_TYPES` (lines 25-49)
  - Module state: `_walletClient`, `_tokenCache` (lines 53-54)
  - Private helpers: `getWalletClient()`, `buildDomain()`, `generateNonce()`, `assertMinimumValue()`, `sanitizeError()`, `parseTestnetToken()` (lines 58-135)
  - Public methods become adapter methods:
    - `getSupportedToken()` -> internal helper (called by transfer/status)
    - `signTransferWithAuthorization()` + `submitGaslessTransfer()` -> `transfer(req)` (atomic: sign + submit)
    - `getGaslessStatus()` -> `status()`
    - `getOperatorTokenBalance()` + `computeFundingState()` -> internal helpers for `status()`
  - `_resetGaslessSigner()` -> `_reset()` method for tests
  - Import `kiteTestnet` from `./chain.js` (not `../../lib/kite-chain.js`)
  - Import `requireKiteClient` from `./client.js` via factory injection (not `../../services/kite-client.js`)

- [ ] W4.2: Refactor `src/routes/gasless.ts`:
  - DELETE: lines 7-11 (imports from `gasless-signer.js`)
  - ADD: `import { getGaslessAdapter } from '../adapters/registry.js'`
  - Line 19: `getGaslessStatus()` -> `getGaslessAdapter().status()`
  - Lines 38-39: `getGaslessStatus()` -> `getGaslessAdapter().status()`
  - Lines 54-58: `signTransferWithAuthorization({...}) + submitGaslessTransfer(...)` -> `getGaslessAdapter().transfer({ to, value: BigInt(body.value) })`

- [ ] W4.3: DELETE `src/lib/gasless-signer.ts` -- all logic now in adapter.

- [ ] W4.4: Wire registry -- update `src/adapters/kite-ozone/index.ts` to instantiate `KiteOzoneGaslessAdapter`.

**Verificacion**: `npx tsc --noEmit` clean. `npm test` -- all 119 pass.

### Wave 5 (Stubs -- zero risk)

- [ ] W5.1: Create `src/adapters/kite-ozone/attestation.ts` -- `KiteOzoneAttestationAdapter` stub:
  - `name: 'kite-ozone'`, `chainId: 2368`
  - `attest()`: logs warning `"Attestation not yet implemented for kite-ozone"`, returns `{ txHash: '0x0', proofUrl: '' }`
  - `verify()`: returns `true`

- [ ] W5.2: Verify `IdentityBindingAdapter` interface is in `src/adapters/types.ts` (created in W1.1). No kite-ozone implementation in this HU.

- [ ] W5.3: Wire registry -- `getIdentityBindingAdapter()` throws `"IdentityBindingAdapter not implemented for kite-ozone-testnet"`. Register attestation adapter in `createKiteOzoneAdapters()`.

**Verificacion**: `npx tsc --noEmit` passes.

### Wave 6 (Consumer cleanup + delete old files -- MEDIUM RISK)

- [ ] W6.1: Modify `src/types/index.ts`:
  - Line 224: `scheme: 'gokite-aa'` -> `scheme: string`
  - Line 225: `network: 'kite-testnet' | 'kite-mainnet'` -> `network: string`
  - Line 435: `network: 'kite-testnet'` -> `network: string`
  - Add comment above Pieverse types (line 273): `// NOTE: Pieverse types used by kite-ozone adapter only. Will move to adapters/kite-ozone/types.ts post-hackathon.`

- [ ] W6.2: Modify `src/index.ts`:
  - DELETE: line 23 `import { kiteClient } from './services/kite-client.js'`
  - ADD: `import { initAdapters, getChainConfig } from './adapters/registry.js'`
  - ADD BEFORE route registration (before line 29): `await initAdapters()`
  - CHANGE banner (line 72): Replace `Kite: ${kiteClient ? 'connected (chainId: 2368)     ' : 'disabled (KITE_RPC_URL not set)'}` with dynamic text using `getChainConfig()` (try/catch: show chain name + chainId on success, "no chain configured" on failure)

- [ ] W6.3: Modify `src/routes/dashboard.ts`:
  - Line 15: `const KITE_EXPLORER_URL = process.env.KITE_EXPLORER_URL || 'https://testnet.kitescan.ai'` -> `const CHAIN_EXPLORER_URL = process.env.CHAIN_EXPLORER_URL || process.env.KITE_EXPLORER_URL || 'https://testnet.kitescan.ai'`
  - Line 19: `.replace('{{KITE_EXPLORER_URL}}', KITE_EXPLORER_URL)` -> `.replace('{{CHAIN_EXPLORER_URL}}', CHAIN_EXPLORER_URL)`

- [ ] W6.4: Modify `src/static/dashboard.html`:
  - Line 133: "Kite Hackathon 2026" -> "WasiAI A2A Protocol v0.1.0 | Chain-Adaptive Gateway | Auto-refresh: 5s"
  - Line 137: `{{KITE_EXPLORER_URL}}` -> `{{CHAIN_EXPLORER_URL}}`

- [ ] W6.5: Modify `src/routes/compose.ts`:
  - Line 44: `request.kiteTxHash` -> `request.paymentTxHash`
  - Line 45: `{ kiteTxHash, ...result }` -> `{ paymentTxHash, ...result }` (variable renamed to match)

- [ ] W6.6: Modify `src/routes/orchestrate.ts`:
  - Line 60: `request.kiteTxHash` -> `request.paymentTxHash`
  - Line 61: `{ kiteTxHash, ...result }` -> `{ paymentTxHash, ...result }`

- [ ] W6.7: DELETE old files (ONLY after all above tasks verified):
  - `src/lib/kite-chain.ts`
  - `src/services/kite-client.ts`

  NOTE: `x402-signer.ts` was already deleted in W3.4, `gasless-signer.ts` in W4.3.

**Verificacion**: `npm test` -- all 119 pass. Then run:
```bash
grep -rn "KITE\|gokite\|Pieverse\|kite-chain\|kite-client\|x402-signer\|gasless-signer" src/ --include="*.ts" --include="*.html" | grep -v "adapters/kite-ozone" | grep -v "node_modules"
```
Expected results (ONLY these are acceptable):
- `src/types/index.ts` -- Pieverse types with deprecation comment (DT-PIEVERSE-TYPES)
- `src/services/llm/transform.ts` -- `kite_schema_transforms` table name (SCOPE OUT per CD-13)

### Wave 7 (Tests + final audit)

- [ ] W7.1: Create `src/adapters/__tests__/payment.contract.test.ts` -- see "Contract test specifications" above. Mock Pieverse fetch calls and wallet client.
- [ ] W7.2: Create `src/adapters/__tests__/gasless.contract.test.ts` -- see "Contract test specifications" above. Mock fetch and wallet. Test all 4 WKH-38 degradation states.
- [ ] W7.3: Create `src/adapters/__tests__/registry.test.ts` -- see "Contract test specifications" above. Use `vi.stubEnv()` for WASIAI_A2A_CHAIN.
- [ ] W7.4: Modify `src/services/kite-client.test.ts` -- update imports ONLY. All 8 assertions unchanged. Import from `../adapters/kite-ozone/client.js` instead of `./kite-client.js`.
- [ ] W7.5: Modify `src/lib/gasless-signer.test.ts` -- update imports ONLY. All 16 assertions unchanged. Import from `../adapters/kite-ozone/gasless.js` instead of `./gasless-signer.js`. Update mock paths.
- [ ] W7.6: Modify `src/services/compose.test.ts` -- update mock paths from `../lib/x402-signer.js` and `../middleware/x402.js` to `../adapters/registry.js`.
- [ ] W7.7: Final audit:
  ```bash
  # All tests pass (119 existing + new contract tests)
  npm test

  # Zero Kite refs outside adapters (except allowed)
  grep -rn "kite\|gokite\|ozone\|pieverse\|pyusd" src/ --include="*.ts" -i | grep -v "src/adapters/" | grep -v "src/types/index.ts" | grep -v "kite_schema_transforms"

  # All deleted files are gone
  ls src/lib/kite-chain.ts src/services/kite-client.ts src/lib/x402-signer.ts src/lib/gasless-signer.ts 2>&1

  # All new adapter files exist
  ls src/adapters/types.ts src/adapters/registry.ts src/adapters/kite-ozone/chain.ts src/adapters/kite-ozone/client.ts src/adapters/kite-ozone/index.ts src/adapters/kite-ozone/payment.ts src/adapters/kite-ozone/gasless.ts src/adapters/kite-ozone/attestation.ts
  ```

**Verificacion**: All tests pass. Grep audit returns zero results. Old files gone. New files exist.

### Verificacion Incremental

| Wave | Verificacion al completar |
|------|--------------------------|
| W-1 | 119 tests pass, all source files exist |
| W0 | Directories created |
| W1 | `npx tsc --noEmit` clean |
| W2 | `npx tsc --noEmit` clean, `npm test` 119/119 |
| W3 | `npx tsc --noEmit` clean, `npm test` 119/119 (RUN AFTER EACH SUB-TASK) |
| W4 | `npx tsc --noEmit` clean, `npm test` 119/119 |
| W5 | `npx tsc --noEmit` clean |
| W6 | `npm test` 119/119, grep audit clean |
| W7 | `npm test` 119+ (existing + contract), grep audit clean, old files gone |

## Out of Scope

> Lo que Dev NO debe tocar bajo ninguna circunstancia.

- DB table rename (`kite_schema_transforms` in `src/services/llm/transform.ts`) -- separate migration ticket
- L3 primitives (IdentityService, BudgetService, AuthzService) -- WKH-34
- `evm-generic/`, `base/`, `mock/` adapter implementations -- post-hackathon
- IdentityBindingAdapter implementation (interface only, no kite-ozone impl)
- New endpoints or L4 API changes
- Real attestation logic (contracts not available)
- `.env.example` updates -- handled by docs at DONE
- NO "mejorar" codigo adyacente
- NO agregar funcionalidad no listada
- NO refactors no solicitados

## Anti-Hallucination Checklist

Before writing code, Dev MUST verify each item with Read/Glob:

- [ ] `src/middleware/x402.ts` exists and exports the 6 KITE_* constants (lines 24-29) + `buildX402Response` + `decodeXPayment` + `verifyPayment` + `settlePayment` + `requirePayment`
- [ ] `src/lib/x402-signer.ts` exists and imports `KITE_FACILITATOR_ADDRESS`, `KITE_NETWORK` from `../middleware/x402.js` (line 10-13) -- this is the circular dependency to resolve
- [ ] `src/services/kite-client.ts` exists with top-level await on line 42: `export const kiteClient = await initKiteClient()`
- [ ] `src/lib/gasless-signer.ts` exists (376 lines) and imports from `kite-chain.js` (line 13) and `kite-client.js` (line 14)
- [ ] `src/lib/kite-chain.ts` exists and exports `kiteTestnet` with chainId 2368
- [ ] `src/types/index.ts` line 224: `scheme: 'gokite-aa'` and line 225: `network: 'kite-testnet' | 'kite-mainnet'` and line 435: `network: 'kite-testnet'`
- [ ] `src/routes/gasless.ts` imports from `../lib/gasless-signer.js` (lines 7-11)
- [ ] `src/services/compose.ts` line 16 imports `signX402Authorization` from `../lib/x402-signer.js` and line 17 imports `settlePayment` from `../middleware/x402.js`
- [ ] `src/index.ts` line 23 imports `kiteClient` from `./services/kite-client.js`
- [ ] `src/routes/dashboard.ts` line 15 reads `KITE_EXPLORER_URL` env var
- [ ] `src/static/dashboard.html` has `{{KITE_EXPLORER_URL}}` on line 137 and "Kite Hackathon 2026" on line 133
- [ ] `src/routes/compose.ts` line 44 uses `request.kiteTxHash`
- [ ] `src/routes/orchestrate.ts` line 60 uses `request.kiteTxHash`
- [ ] All import paths use `.js` extension (ESM requirement)
- [ ] After EACH wave: `npx tsc --noEmit` clean + `npm test` = 119/119

## Done Definition

All of the following MUST be true:

1. `npx tsc --noEmit` clean -- zero type errors
2. `npm test` passes -- all 119 existing tests + new contract tests
3. Zero Kite refs outside adapters:
   ```bash
   grep -rn "kite\|gokite\|ozone\|pieverse\|pyusd" src/ --include="*.ts" -i | grep -v "src/adapters/" | grep -v "src/types/index.ts" | grep -v "kite_schema_transforms"
   ```
   Returns ZERO results.
4. All deleted files are gone:
   - `src/lib/kite-chain.ts` -- deleted
   - `src/services/kite-client.ts` -- deleted
   - `src/lib/x402-signer.ts` -- deleted
   - `src/lib/gasless-signer.ts` -- deleted
5. All new adapter files exist:
   - `src/adapters/types.ts`
   - `src/adapters/registry.ts`
   - `src/adapters/kite-ozone/chain.ts`
   - `src/adapters/kite-ozone/client.ts`
   - `src/adapters/kite-ozone/index.ts`
   - `src/adapters/kite-ozone/payment.ts`
   - `src/adapters/kite-ozone/gasless.ts`
   - `src/adapters/kite-ozone/attestation.ts`
   - `src/adapters/__tests__/payment.contract.test.ts`
   - `src/adapters/__tests__/gasless.contract.test.ts`
   - `src/adapters/__tests__/registry.test.ts`
6. No file outside `src/adapters/kite-ozone/` imports directly from `src/adapters/kite-ozone/*.ts` submodules (only through registry)

## Escalation Rule

> **Si algo no esta en este Story File, Dev PARA y pregunta a Architect.**
> No inventar. No asumir. No improvisar.
> Architect resuelve y actualiza el Story File antes de que Dev continue.

Situaciones de escalation:
- A source file listed here has changed since the SDD was written (different line numbers, new exports, etc.)
- An import path does not resolve after the move
- A test fails for a reason not related to import path changes
- The `GaslessTransferAdapterRequest` simplified interface cannot handle a consumer use case
- `buildX402Response` needs data that the adapter does not expose
- Any ambiguity in how to wire the registry to a specific consumer

---

*Story File generado por NexusAgil -- F2.5*
