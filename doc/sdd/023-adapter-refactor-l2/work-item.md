# Work Item — [WKH-35] Adapter Refactor L2 — Extract Kite Hardcoding to src/adapters/kite-ozone/*

## Resumen

Extract 185 Kite-hardcoded references across 16 source files into a clean adapter pattern per `doc/architecture/CHAIN-ADAPTIVE.md` section L2. This is a PURE REFACTOR: zero behavior change, 100% of existing 119 tests must pass unchanged, plus new contract tests for the adapter interfaces. The result is a pluggable adapter layer where the same binary can run on any EVM chain by changing only env vars.

## Sizing

- SDD_MODE: full
- Estimation: L (16 source files + 4 test files touched, 4 new adapter interfaces, registry factory, ~10 new files created)
- Branch: `feat/023-adapter-refactor-l2`
- Skills: `blockchain-adapter-patterns`, `refactoring-large-codebase`

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

## Scope IN

### New files to create
- `src/adapters/types.ts` -- shared interfaces + DTOs (PaymentAdapter, AttestationAdapter, GaslessAdapter, IdentityBindingAdapter, supporting types)
- `src/adapters/registry.ts` -- factory + runtime selection from WASIAI_A2A_CHAIN env var
- `src/adapters/kite-ozone/payment.ts` -- extracted from src/middleware/x402.ts + src/lib/x402-signer.ts
- `src/adapters/kite-ozone/attestation.ts` -- stub implementation (no logic exists yet)
- `src/adapters/kite-ozone/gasless.ts` -- extracted from src/lib/gasless-signer.ts
- `src/adapters/kite-ozone/index.ts` -- factory + chain config (absorbs src/lib/kite-chain.ts + src/services/kite-client.ts)
- `src/adapters/__tests__/payment.contract.test.ts` -- contract tests for PaymentAdapter
- `src/adapters/__tests__/gasless.contract.test.ts` -- contract tests for GaslessAdapter
- `src/adapters/__tests__/registry.test.ts` -- registry resolution tests

### Files to modify (consumer refactor)
- `src/middleware/x402.ts` -- thin wrapper over PaymentAdapter.verify()/settle(); remove Pieverse direct calls, remove KITE_* constants (move to adapter)
- `src/services/compose.ts` -- import from registry instead of x402-signer.ts and x402.ts
- `src/routes/compose.ts` -- import requirePayment from refactored x402 middleware (path unchanged)
- `src/routes/orchestrate.ts` -- import requirePayment from refactored x402 middleware (path unchanged), rename kiteTxHash to txHash
- `src/routes/gasless.ts` -- import from registry instead of gasless-signer.ts
- `src/routes/dashboard.ts` -- replace KITE_EXPLORER_URL with chain-agnostic CHAIN_EXPLORER_URL (from adapter or env)
- `src/index.ts` -- import adapter initialization instead of kite-client directly; update banner
- `src/types/index.ts` -- make X402PaymentPayload.scheme and .network chain-agnostic (string instead of literal 'gokite-aa'/'kite-testnet'); make GaslessStatus.network string instead of literal 'kite-testnet'
- `src/static/dashboard.html` -- replace "Kite Hackathon 2026" with chain-agnostic label; keep {{KITE_EXPLORER_URL}} template var renamed to {{CHAIN_EXPLORER_URL}}

### Files to relocate (become adapter-internal)
- `src/lib/kite-chain.ts` -- moves to `src/adapters/kite-ozone/chain.ts` (or inlined in index.ts)
- `src/services/kite-client.ts` -- moves to `src/adapters/kite-ozone/client.ts` (or inlined in index.ts)
- `src/lib/x402-signer.ts` -- logic absorbed into `src/adapters/kite-ozone/payment.ts`
- `src/lib/gasless-signer.ts` -- logic absorbed into `src/adapters/kite-ozone/gasless.ts`

### Test files to update (import paths only)
- `src/services/kite-client.test.ts` -- update imports to adapter paths
- `src/lib/gasless-signer.test.ts` -- update imports to adapter paths
- `src/services/compose.test.ts` -- update imports to adapter paths
- `src/services/llm/transform.ts` -- rename `kite_schema_transforms` table reference [NEEDS CLARIFICATION: is this a DB table rename or just a code-level rename? Table rename would be a migration outside this HU's scope]
- `src/services/llm/transform.test.ts` -- update if transform.ts references change

## Scope OUT

- L3 primitives (IdentityService, BudgetService, AuthzService) -- that is WKH-34
- `evm-generic/`, `base/`, `mock/` adapter implementations -- Fase 2 post-hackathon
- IdentityBindingAdapter implementation (interface only, no impl)
- DB table renames (`kite_schema_transforms` -> `a2a_schema_transforms`) -- separate migration ticket
- New env vars documentation / .env.example updates -- handled by docs at DONE
- Real attestation logic (contracts not available yet)
- Any L4 public API changes (no new endpoints in this HU)

## Decisiones tecnicas (DT-N)

- DT-1: **Move vs. re-export**: `kite-chain.ts` and `kite-client.ts` will be MOVED into `src/adapters/kite-ozone/` (not re-exported). Old paths will be deleted. This forces all consumers to go through the adapter registry, preventing bypass.

- DT-2: **Adapter singleton pattern**: Each adapter instance is created once at startup (lazy singleton) and cached in the registry. No per-request instantiation. This preserves the current behavior of `kiteClient` (top-level await singleton) and wallet client singletons.

- DT-3: **PaymentAdapter scope**: The PaymentAdapter interface covers both server-side (verify, settle -- what x402 middleware does) and client-side (quote/sign -- what x402-signer does for compose). The kite-ozone impl wraps both Pieverse facilitator calls and EIP-712 signing.

- DT-4: **x402 middleware remains at same path**: `src/middleware/x402.ts` stays as the Fastify preHandler. It becomes a thin wrapper that delegates to `getPaymentAdapter()`. This preserves all existing import paths in routes (`requirePayment` import unchanged).

- DT-5: **Chain definition ownership**: The `defineChain()` call for Kite Testnet (chain ID 2368) moves into the adapter. Other adapters will own their own chain definitions. No shared chain registry needed at L2.

- DT-6: **Env var mapping**: `WASIAI_A2A_CHAIN=kite-ozone-testnet` maps to the kite-ozone adapter bundle. Individual adapter overrides (`PAYMENT_ADAPTER`, `GASLESS_ADAPTER`, etc.) per CHAIN-ADAPTIVE.md section 4 are supported but optional.

- DT-7: **Type generalization**: `X402PaymentPayload.scheme` changes from literal `'gokite-aa'` to `string`, and `.network` from `'kite-testnet' | 'kite-mainnet'` to `string`. The kite-ozone adapter provides the Kite-specific values. This is the minimal type change needed.

- DT-8: **Attestation stub**: Since no attestation logic exists in the codebase (only `attestationTxHash?: string` in OrchestrateResult type), the kite-ozone AttestationAdapter will be a stub that logs a warning. The interface is defined for future use.

## Constraint Directives (CD-N)

- CD-1: OBLIGATORIO -- Zero regression. All 119 tests MUST pass unchanged. If a test needs import path updates, those are the ONLY changes allowed in test files.
- CD-2: PROHIBIDO -- No new npm dependencies. The adapter pattern uses only existing deps (viem, fastify).
- CD-3: PROHIBIDO -- No ethers.js. viem only (already enforced by project-context).
- CD-4: OBLIGATORIO -- TypeScript strict. No `any`. No `as unknown` escapes.
- CD-5: PROHIBIDO -- No Kite/Ozone/gokite/Pieverse references outside `src/adapters/kite-ozone/` and `src/adapters/types.ts` after refactor is complete (AC-15).
- CD-6: OBLIGATORIO -- Adapter interfaces MUST match the signatures in CHAIN-ADAPTIVE.md section L2 exactly.
- CD-7: PROHIBIDO -- No behavior changes. Every HTTP endpoint must return identical responses for identical inputs before and after the refactor.
- CD-8: OBLIGATORIO -- OPERATOR_PRIVATE_KEY, signatures, and nonces SHALL NEVER be logged (preserve existing CD-1 from WKH-29).
- CD-9: OBLIGATORIO -- AR fuerte obligatorio. Regression risk is HIGH due to touching payment/gasless critical paths.

## Missing Inputs

- [NEEDS CLARIFICATION] `kite_schema_transforms` table name: should it be renamed to `a2a_schema_transforms` as part of this HU, or is that a separate DB migration ticket? Current recommendation: Scope OUT (separate ticket) since it requires a Supabase migration and the table name in the transform service is not technically a "Kite adapter" concern -- it is L3 caching.
- [resuelto en F2] Exact DTO types for adapter methods (SettleRequest, SettleResult, VerifyResult, QuoteResult, etc.) -- Architect will define these in the SDD based on the current Pieverse types.
- [resuelto en F2] Whether `src/lib/kite-chain.ts` and `src/services/kite-client.ts` old files should be kept as re-exports for backwards compat or deleted entirely. DT-1 says delete, but Architect confirms in F2.

## Analisis de paralelismo

- **Blocked by**: WKH-38 (gasless graceful degradation) -- DONE (merged, SDD 022)
- **Blocks**: WKH-34 F3 (L3 primitives need adapters to exist for the auth middleware to delegate payment verification). WKH-34 F0/F1/F2 can proceed in parallel.
- **Internal parallelism**: The extraction can be done in waves:
  - Wave 1: Create `src/adapters/types.ts` + `src/adapters/registry.ts` (no consumers yet, no regression risk)
  - Wave 2: Extract `kite-chain.ts` + `kite-client.ts` into `src/adapters/kite-ozone/` + create `kite-ozone/index.ts`
  - Wave 3: Extract payment adapter (`kite-ozone/payment.ts`) + refactor `x402.ts` middleware + refactor `compose.ts` service + refactor `x402-signer.ts` (highest risk wave -- payment critical path)
  - Wave 4: Extract gasless adapter (`kite-ozone/gasless.ts`) + refactor `gasless-signer.ts` + refactor `gasless.ts` routes
  - Wave 5: Create attestation stub + IdentityBinding interface-only
  - Wave 6: Consumer cleanup (`index.ts`, `dashboard.ts`, `types/index.ts`, `dashboard.html`) + delete old files
  - Wave 7: Contract tests + final validation (npm test = 119/119)

## Wave suggestion for F3

| Wave | Files | Risk | Run tests after? |
|------|-------|------|-----------------|
| W1 | adapters/types.ts, adapters/registry.ts | None (additive only) | Yes |
| W2 | adapters/kite-ozone/chain.ts, client.ts, index.ts | Low (move + re-export temporarily) | Yes |
| W3 | adapters/kite-ozone/payment.ts, refactor x402.ts + compose.ts + x402-signer.ts | HIGH (payment path) | Yes -- full suite |
| W4 | adapters/kite-ozone/gasless.ts, refactor gasless-signer.ts + gasless.ts | Medium (gasless path) | Yes -- full suite |
| W5 | adapters/kite-ozone/attestation.ts + IdentityBinding interface | None (stubs) | Yes |
| W6 | index.ts, dashboard.ts, types/index.ts, dashboard.html, delete old files | Medium (cleanup) | Yes -- full suite |
| W7 | Contract tests + final grep audit for Kite refs outside adapters | None (tests only) | Yes -- full suite + grep |

## Dependency graph (current state)

```
src/index.ts
  └── imports kiteClient from services/kite-client.ts

src/services/kite-client.ts
  └── imports kiteTestnet from lib/kite-chain.ts

src/lib/x402-signer.ts
  ├── imports kiteTestnet from lib/kite-chain.ts
  └── imports KITE_FACILITATOR_ADDRESS, KITE_NETWORK from middleware/x402.ts

src/middleware/x402.ts
  └── exports KITE_* constants + verifyPayment + settlePayment + requirePayment
      └── called by Pieverse facilitator (external HTTP)

src/lib/gasless-signer.ts
  ├── imports kiteTestnet from lib/kite-chain.ts
  └── imports requireKiteClient, kiteClient from services/kite-client.ts

src/services/compose.ts
  ├── imports signX402Authorization from lib/x402-signer.ts
  └── imports settlePayment from middleware/x402.ts

src/routes/compose.ts
  └── imports requirePayment from middleware/x402.ts

src/routes/orchestrate.ts
  └── imports requirePayment from middleware/x402.ts

src/routes/gasless.ts
  └── imports from lib/gasless-signer.ts

src/routes/dashboard.ts
  └── reads KITE_EXPLORER_URL env var

src/services/llm/transform.ts
  └── references kite_schema_transforms table (Supabase)

src/types/index.ts
  └── defines Kite-specific type literals ('gokite-aa', 'kite-testnet')
```
