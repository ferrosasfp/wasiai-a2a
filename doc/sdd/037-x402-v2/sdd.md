# SDD #037: Migrate x402 from v1 to v2 (Pieverse format)

> SPEC_APPROVED: no
> Fecha: 2026-04-06
> Tipo: improvement
> SDD_MODE: full
> Branch: feat/037-x402-v2
> Artefactos: doc/sdd/037-x402-v2/

---

## 1. Resumen

Pieverse facilitator (https://facilitator.pieverse.io) migrated to x402 v2. Our adapter still sends v1 payloads: wrong headers (`X-Payment` instead of `PAYMENT-SIGNATURE`), wrong body structure (flat `{authorization, signature, network}` instead of `{paymentPayload, paymentRequirements}` envelope), wrong network format (`"kite-testnet"` instead of CAIP-2 `"eip155:2368"`), and wrong scheme (`"gokite-aa"` instead of `"exact"`). Every `/v2/verify` call returns 400 "Missing paymentPayload or paymentRequirements". This SDD specifies the migration of all x402 touchpoints to v2 format.

## 2. Work Item

| Campo | Valor |
|-------|-------|
| **#** | 037 |
| **Tipo** | improvement |
| **SDD_MODE** | full |
| **Objetivo** | Migrate x402 adapter, middleware, types, tests, and demo script to Pieverse v2 format so payments work E2E again |
| **Reglas de negocio** | Header names, body structure, network format, and scheme MUST match Pieverse v2 spec exactly |
| **Scope IN** | `src/adapters/kite-ozone/payment.ts`, `src/middleware/x402.ts`, `src/types/index.ts`, `scripts/demo-x402.ts`, `src/middleware/a2a-key.test.ts`, `src/services/compose.test.ts`, `src/services/compose.ts` |
| **Scope OUT** | Chain-adaptive refactor (WKH-35), new chain support, L3 primitives, gasless flow (WKH-29/38), EIP-712 signing changes |
| **Missing Inputs** | All resolved -- see section 9 |

### Acceptance Criteria (EARS)

1. **AC-1**: WHEN the middleware receives a request without payment header, the system SHALL return HTTP 402 with body containing `x402Version: 2`, `scheme: "exact"`, and `network: "eip155:2368"`.
2. **AC-2**: WHEN the middleware reads the incoming payment header, the system SHALL read from the `payment-signature` header (not `x-payment`).
3. **AC-3**: WHEN the adapter calls Pieverse `/v2/verify`, the system SHALL send body `{ paymentPayload: { x402Version: 2, scheme: "exact", network: "eip155:2368", payload: { authorization, signature } }, paymentRequirements: { x402Version: 2, scheme: "exact", network: "eip155:2368", maxAmountRequired, payTo, asset, extra: null } }`.
4. **AC-4**: WHEN the adapter calls Pieverse `/v2/settle`, the system SHALL send body in the same v2 envelope structure as AC-3.
5. **AC-5**: WHEN the adapter signs a client-side payment (sign method), the system SHALL produce a header value encodeable as `PAYMENT-SIGNATURE` using v2 payload format.
6. **AC-6**: WHEN the server returns a successful payment response, the system SHALL use the `payment-response` header (not `x-payment-response`).
7. **AC-7**: WHEN `scripts/demo-x402.ts` runs against a live server with Pieverse facilitator, the system SHALL complete the full flow (402 -> sign -> verify -> settle -> 200) without errors.
8. **AC-8**: WHEN existing tests for compose service and a2a-key middleware run, they SHALL pass with updated mocks reflecting v2 format.

## 3. Context Map (Codebase Grounding)

### Archivos leidos

| Archivo | Por que | Patron extraido |
|---------|---------|-----------------|
| `src/adapters/kite-ozone/payment.ts` | Current v1 adapter implementation | Constants `KITE_SCHEME='gokite-aa'`, `KITE_NETWORK='kite-testnet'`; flat body `{authorization, signature, network}` sent to `/v2/verify` and `/v2/settle`; `sign()` returns `{xPaymentHeader, paymentRequest}` with flat structure |
| `src/middleware/x402.ts` | Current v1 middleware | Reads `x-payment` header (line 49); builds 402 response with `x402Version: 1` (line 28); `decodeXPayment()` expects flat `{authorization, signature}` |
| `src/types/index.ts` | x402 type definitions | `X402Response.x402Version: 1`; `PieverseVerifyRequest` / `PieverseSettleRequest` are flat `{authorization, signature, network}`; `X402PaymentPayload` has scheme/network fields |
| `src/adapters/types.ts` | PaymentAdapter interface | Interface has `verify(proof)`, `settle(req)`, `sign(opts)`, `getScheme()`, `getNetwork()` -- interface itself does NOT change |
| `src/services/compose.ts` | How X-Payment header is used in outbound calls | Line 81: `headers['X-Payment'] = result.xPaymentHeader` -- must change to `PAYMENT-SIGNATURE` |
| `src/services/compose.test.ts` | Test mocks for x402 | Uses `network: 'kite-testnet'` in mock payloads; asserts `X-Payment` header |
| `src/middleware/a2a-key.test.ts` | Test mocks for middleware | Mock adapter returns `getScheme: () => 'exact'` and `getNetwork: () => 'kite-ozone-testnet'` -- network value needs CAIP-2 |
| `scripts/demo-x402.ts` | E2E demo script | Builds flat `xPaymentPayload`, sends as `X-Payment` header |
| `src/adapters/registry.ts` | Adapter registry | No changes needed -- just initializes adapters |

### Exemplars

| Para crear/modificar | Seguir patron de | Razon |
|---------------------|------------------|-------|
| `src/adapters/kite-ozone/payment.ts` (v2) | `src/adapters/kite-ozone/payment.ts` (current) | Same file, same structure -- only constants and body construction change |
| `src/middleware/x402.ts` (v2) | `src/middleware/x402.ts` (current) | Same file, same flow -- header names and response format change |
| `scripts/demo-x402.ts` (v2) | `scripts/demo-x402.ts` (current) | Same E2E flow structure -- header names and payload format change |

### Componentes reutilizables encontrados

- `PaymentAdapter` interface in `src/adapters/types.ts` -- reuse without modification (CD-3)
- `EIP712_DOMAIN` and `EIP712_TYPES` in `src/adapters/kite-ozone/payment.ts` -- reuse without modification (EIP-712 signing is independent of facilitator API format)
- `getPaymentAdapter()` in `src/adapters/registry.ts` -- reuse without modification

## 4. Diseno Tecnico

### 4.1 Archivos a crear/modificar

| Archivo | Accion | Descripcion | Exemplar |
|---------|--------|-------------|----------|
| `src/types/index.ts` | Modificar | Change `X402Response.x402Version` from `1` to `2`; restructure `PieverseVerifyRequest`/`PieverseSettleRequest` to v2 envelope format with `paymentPayload` + `paymentRequirements`; update `X402PaymentRequest` to wrap in `paymentPayload` for v2 header encoding | Current file |
| `src/adapters/kite-ozone/payment.ts` | Modificar | Change `KITE_SCHEME` to `'exact'`, `KITE_NETWORK` to `'eip155:2368'`; restructure `verify()`/`settle()` bodies to v2 envelope; update `sign()` to produce v2-compatible payload | Current file |
| `src/middleware/x402.ts` | Modificar | Change request header from `x-payment` to `payment-signature`; change `x402Version` from `1` to `2` in 402 response; add `payment-response` header on successful payment | Current file |
| `src/services/compose.ts` | Modificar | Change outbound header from `X-Payment` to `PAYMENT-SIGNATURE` | Current file |
| `scripts/demo-x402.ts` | Modificar | Change header from `X-Payment` to `PAYMENT-SIGNATURE`; update payload construction to v2 format; update console output text | Current file |
| `src/services/compose.test.ts` | Modificar | Update mock payloads: `network: 'eip155:2368'`; update header assertions from `X-Payment` to `PAYMENT-SIGNATURE` | Current file |
| `src/middleware/a2a-key.test.ts` | Modificar | Update mock adapter `getNetwork` return to `'eip155:2368'` | Current file |

### 4.2 Modelo de datos

N/A -- no DB changes.

### 4.3 Componentes / Servicios

**Type changes (v1 -> v2):**

1. `X402Response.x402Version`: literal `1` -> literal `2`
2. `PieverseVerifyRequest` / `PieverseSettleRequest`: flat `{authorization, signature, network}` -> `{ paymentPayload: { x402Version: 2, scheme: "exact", network: "eip155:2368", payload: { authorization, signature } }, paymentRequirements: { x402Version: 2, scheme: "exact", network: "eip155:2368", maxAmountRequired, payTo, asset, extra: null } }`
3. `X402PaymentPayload.scheme`: value changes from `"gokite-aa"` to `"exact"` (runtime, not type)
4. `X402PaymentPayload.network`: value changes from `"kite-testnet"` to `"eip155:2368"` (runtime, not type)

**Header mapping (v1 -> v2):**

| v1 | v2 | Direction |
|----|-----|-----------|
| `x-payment` | `payment-signature` | Client -> Server (request) |
| `X-Payment` | `PAYMENT-SIGNATURE` | Server -> Agent (outbound from compose) |
| (not used) | `payment-response` | Server -> Client (response) |

**Pieverse API body mapping (v1 -> v2):**

v1 body (current -- rejected by Pieverse):
```
{ authorization: {...}, signature: "0x...", network: "kite-testnet" }
```

v2 body (target):
```
{
  paymentPayload: {
    x402Version: 2,
    scheme: "exact",
    network: "eip155:2368",
    payload: {
      authorization: { from, to, value, validAfter, validBefore, nonce },
      signature: "0x..."
    }
  },
  paymentRequirements: {
    x402Version: 2,
    scheme: "exact",
    network: "eip155:2368",
    maxAmountRequired: "...",
    payTo: "0x...",
    asset: "0x...",
    extra: null
  }
}
```

**Resolve: paymentRequirements fields**

The `paymentRequirements` object in v2 mirrors the fields from our `X402PaymentPayload` type (the `accepts[]` array element from the 402 response). The facilitator needs: `x402Version`, `scheme`, `network`, `maxAmountRequired`, `payTo`, `asset`, and `extra`. These are all fields we already have in `buildX402Response()`. The adapter's `verify()`/`settle()` methods need to receive these fields or construct them from adapter constants + the payment proof.

**Resolve: EIP-712 domain/types**

EIP-712 signing is between the client wallet and the on-chain contract. It is independent of the facilitator HTTP API format. The `EIP712_DOMAIN` and `EIP712_TYPES` in `payment.ts` do NOT change. The only change is how the resulting authorization + signature are wrapped for transport to the facilitator API.

### 4.4 Flujo principal (Happy Path)

1. Client calls `POST /compose` or `POST /orchestrate` without payment header
2. Middleware reads `payment-signature` header (v2) -- not found
3. Middleware returns HTTP 402 with `{ error, accepts: [{scheme: "exact", network: "eip155:2368", ...}], x402Version: 2 }`
4. Client signs EIP-712 authorization (unchanged) and constructs v2 payload
5. Client encodes payload as base64, sends in `PAYMENT-SIGNATURE` header
6. Middleware reads `payment-signature` header, base64-decodes, extracts authorization + signature
7. Middleware calls `adapter.verify()` -- adapter wraps in v2 envelope, POSTs to Pieverse `/v2/verify`
8. Pieverse returns `{ valid: true }`
9. Middleware calls `adapter.settle()` -- adapter wraps in v2 envelope, POSTs to Pieverse `/v2/settle`
10. Pieverse returns `{ txHash, success: true }`
11. Middleware sets `request.paymentTxHash` and `request.paymentVerified = true`
12. Server sets `payment-response` header with txHash on successful response
13. Request proceeds to route handler

### 4.5 Flujo de error

1. If Pieverse `/v2/verify` returns `{ valid: false, error: "..." }` -- middleware returns 402 with error detail
2. If Pieverse returns HTTP 4xx/5xx on `/v2/verify` or `/v2/settle` -- middleware returns 402 with "Facilitator unavailable" message
3. If `payment-signature` header is present but malformed (not valid base64 or JSON) -- middleware returns 402 with format error

### 4.6 Adapter verify/settle signature change

The `PaymentAdapter` interface (`src/adapters/types.ts`) defines:
- `verify(proof: X402Proof): Promise<VerifyResult>` where `X402Proof = { authorization, signature, network }`
- `settle(req: SettleRequest): Promise<SettleResult>` where `SettleRequest = { authorization, signature, network }`

These interface signatures stay STABLE (CD-3). The v2 envelope construction happens INSIDE `KiteOzonePaymentAdapter.verify()` and `.settle()`, using the proof fields + adapter constants (`KITE_SCHEME`, `KITE_NETWORK`, `KITE_PAYMENT_TOKEN`, wallet address from env). The adapter already has all the data needed to build `paymentRequirements` from its own constants and the `buildX402Response` parameters.

However, `verify()` and `settle()` need `maxAmountRequired` and `payTo` for the `paymentRequirements` envelope. Currently these are NOT passed to `verify`/`settle`. Two options:

**DT-6: Pass paymentRequirements data to verify/settle via existing fields.**

The adapter can construct `paymentRequirements` from its own constants:
- `x402Version: 2` -- constant
- `scheme: KITE_SCHEME` -- `'exact'`
- `network: KITE_NETWORK` -- `'eip155:2368'`
- `maxAmountRequired` -- from the `authorization.value` field already in the proof (this is the amount the client agreed to pay)
- `payTo` -- from `authorization.to` field already in the proof
- `asset: KITE_PAYMENT_TOKEN` -- adapter constant
- `extra: null` -- constant

All fields are derivable. No interface change needed. The adapter's `verify()` and `settle()` can build the full v2 envelope internally.

## 5. Constraint Directives (Anti-Alucinacion)

### Heredados del Work Item

- **CD-1 (OBLIGATORIO)**: All header names and body structures MUST match Pieverse v2 spec exactly. Source of truth: GET https://facilitator.pieverse.io/ and GET https://facilitator.pieverse.io/v2/supported.
- **CD-2 (PROHIBIDO)**: No backward-compat v1 fallback. Pieverse only speaks v2.
- **CD-3 (PROHIBIDO)**: No changes to adapter interface signatures in `src/adapters/types.ts`. `PaymentAdapter`, `X402Proof`, `SettleRequest`, `SignRequest`, `SignResult` interfaces stay stable.
- **CD-4 (OBLIGATORIO)**: Demo script MUST be validated E2E against live Pieverse facilitator before marking DONE.
- **CD-5 (PROHIBIDO)**: No hardcoded URLs. `KITE_FACILITATOR_URL` env var override must continue working.

### Agregados por SDD

- **CD-6 (PROHIBIDO)**: No changes to `EIP712_DOMAIN` or `EIP712_TYPES`. Signing is independent of facilitator API format.
- **CD-7 (PROHIBIDO)**: No changes to `src/adapters/registry.ts` or `src/adapters/types.ts`.
- **CD-8 (OBLIGATORIO)**: Header names in code MUST be lowercase (`payment-signature`, `payment-response`) per HTTP/2 convention. Outbound headers in `compose.ts` use canonical form `PAYMENT-SIGNATURE`.
- **CD-9 (PROHIBIDO)**: No new dependencies. All changes use existing viem, node:crypto, Fastify.
- **CD-10 (PROHIBIDO)**: No modification of files outside Scope IN.

## 6. Scope

**IN:**
- Constants migration: scheme `"gokite-aa"` -> `"exact"`, network `"kite-testnet"` -> `"eip155:2368"`
- Header rename: `x-payment` -> `payment-signature`, add `payment-response`
- Body restructure: flat -> `{paymentPayload, paymentRequirements}` envelope for Pieverse calls
- 402 response: `x402Version: 1` -> `2`
- Types update for new Pieverse request structures
- Demo script update
- Test mocks update

**OUT:**
- Chain-adaptive adapter refactor (WKH-35)
- New chain support (Base, Avalanche)
- EIP-712 domain/types changes
- L3 primitives (BudgetService, IdentityService)
- Gasless flow (WKH-29/38)
- Changes to `src/adapters/types.ts` (PaymentAdapter interface)

## 7. Riesgos

| Riesgo | Probabilidad | Impacto | Mitigacion |
|--------|-------------|---------|------------|
| Pieverse v2 expects additional fields not in our mapping | B | A | Validate with live `/v2/verify` call in demo script (AC-7). If 400, inspect error message for missing fields. |
| `payment-signature` header stripped by reverse proxy | B | A | Test against Railway deployment. HTTP headers are case-insensitive per spec. |
| Compose outbound header change breaks agents that expect `X-Payment` | M | B | Acceptable -- agents following x402 v2 expect `PAYMENT-SIGNATURE`. v1-only agents were already broken with Pieverse. |
| paymentRequirements fields derived from proof may differ from original 402 response | B | M | `authorization.value` = `maxAmountRequired` and `authorization.to` = `payTo` by x402 design. Safe derivation. |

## 8. Dependencias

- Pieverse facilitator v2 must be live at `https://facilitator.pieverse.io` (confirmed per F1)
- `OPERATOR_PRIVATE_KEY` env var must be set for demo script
- `PAYMENT_WALLET_ADDRESS` or `KITE_WALLET_ADDRESS` env var must be set for middleware

## 9. Missing Inputs

- [x] Exact `paymentRequirements` fields: **RESOLVED** -- derived from adapter constants + authorization proof fields. See DT-6 in section 4.3.
- [x] Whether EIP-712 domain/types need changes: **RESOLVED** -- NO changes. EIP-712 signing is wallet-to-contract, independent of facilitator HTTP API. See CD-6.

## 10. Uncertainty Markers

None. All inputs resolved.

---

## Waves de Implementacion

### Wave 0 (Serial Gate -- types + constants)

- [ ] **W0.1**: Update `src/types/index.ts` -- change `X402Response.x402Version` from `1` to `2`; add `PieverseV2PaymentPayload` and `PieverseV2PaymentRequirements` types; restructure `PieverseVerifyRequest`/`PieverseSettleRequest` to use v2 envelope
- [ ] **W0.2**: Update `src/adapters/kite-ozone/payment.ts` -- change `KITE_SCHEME` to `'exact'`, `KITE_NETWORK` to `'eip155:2368'`; restructure `verify()` and `settle()` bodies to v2 envelope; update `sign()` to return v2-compatible payload (network field updated)

### Wave 1 (Parallelizable -- middleware + compose)

- [ ] **W1.1**: Update `src/middleware/x402.ts` -- change header from `x-payment` to `payment-signature`; change `x402Version` to `2` in `buildX402Response()`; add `payment-response` header setting
- [ ] **W1.2**: Update `src/services/compose.ts` -- change outbound header from `X-Payment` to `PAYMENT-SIGNATURE`

### Wave 2 (Tests -- depends on W0 + W1)

- [ ] **W2.1**: Update `src/services/compose.test.ts` -- change mock `network` to `'eip155:2368'`; change header assertion from `X-Payment` to `PAYMENT-SIGNATURE`
- [ ] **W2.2**: Update `src/middleware/a2a-key.test.ts` -- change mock `getNetwork` return to `'eip155:2368'`

### Wave 3 (Demo + validation)

- [ ] **W3.1**: Update `scripts/demo-x402.ts` -- change header to `PAYMENT-SIGNATURE`; update payload to v2 format; update console output; update assertions
- [ ] **W3.2**: Run `npx vitest run` -- all tests pass
- [ ] **W3.3**: Run `npx tsx scripts/demo-x402.ts` against live Pieverse -- full flow completes (AC-7)

## Dependencias entre waves

| Tarea | Depende de | Razon |
|-------|-----------|-------|
| W1.1, W1.2 | W0.1, W0.2 | Middleware and compose import types from W0 |
| W2.1, W2.2 | W0, W1 | Tests must match new header names and types |
| W3.1 | W0, W1 | Demo uses new headers and payload format |
| W3.2 | W0, W1, W2 | Full test suite |
| W3.3 | W3.1, W3.2 | E2E validation |

## Archivos involucrados

| Archivo | Existe | Accion | Wave | Exemplar |
|---------|--------|--------|------|----------|
| `src/types/index.ts` | Si | Modificar | W0.1 | Current file (x402 type section) |
| `src/adapters/kite-ozone/payment.ts` | Si | Modificar | W0.2 | Current file |
| `src/middleware/x402.ts` | Si | Modificar | W1.1 | Current file |
| `src/services/compose.ts` | Si | Modificar | W1.2 | Current file |
| `src/services/compose.test.ts` | Si | Modificar | W2.1 | Current file |
| `src/middleware/a2a-key.test.ts` | Si | Modificar | W2.2 | Current file |
| `scripts/demo-x402.ts` | Si | Modificar | W3.1 | Current file |

## Test Plan

| Test | AC que cubre | Wave | Framework |
|------|-------------|------|-----------|
| `src/services/compose.test.ts` (T-3 updated) | AC-5 (header name), AC-8 | W2.1 | vitest |
| `src/middleware/a2a-key.test.ts` (AC-2 updated) | AC-1 (402 response format), AC-8 | W2.2 | vitest |
| `scripts/demo-x402.ts` (manual E2E) | AC-1 through AC-7 | W3.3 | Manual (npx tsx) |

## Verificacion Incremental

| Wave | Verificacion al completar |
|------|--------------------------|
| W0 | `npx tsc --noEmit` -- types compile |
| W1 | `npx tsc --noEmit` -- middleware + compose compile |
| W2 | `npx vitest run` -- all tests pass |
| W3 | E2E demo against live Pieverse |

## Estimacion

- Archivos nuevos: 0
- Archivos modificados: 7
- Tests nuevos: 0 (existing tests updated)
- Lineas estimadas: ~120 changed

---

## READINESS CHECK

- [x] Cada AC tiene al menos 1 archivo asociado en tabla 4.1
- [x] Cada archivo en tabla 4.1 tiene un Exemplar valido (verificado con Glob)
- [x] No hay [NEEDS CLARIFICATION] pendientes
- [x] Constraint Directives incluyen al menos 3 PROHIBIDO (CD-2, CD-3, CD-5, CD-6, CD-7, CD-9, CD-10)
- [x] Context Map tiene al menos 2 archivos leidos (9 archivos)
- [x] Scope IN y OUT son explicitos y no ambiguos
- [x] Si hay BD: N/A
- [x] Flujo principal (Happy Path) esta completo
- [x] Flujo de error esta definido (3 cases)

---

*SDD generado por NexusAgil -- FULL*
