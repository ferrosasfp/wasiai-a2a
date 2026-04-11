# Story File — #037: Migrate x402 from v1 to v2 (Pieverse format)

> SDD: doc/sdd/037-x402-v2/sdd.md
> Fecha: 2026-04-06
> Branch: feat/037-x402-v2

---

## Goal

Pieverse facilitator migrated to x402 v2. Our adapter sends v1 payloads (wrong headers, wrong body structure, wrong network/scheme constants). Every `/v2/verify` call returns 400 "Missing paymentPayload or paymentRequirements". This story migrates all x402 touchpoints -- types, adapter, middleware, compose service, tests, and demo script -- to v2 format so payments work E2E again.

## Acceptance Criteria (EARS)

1. **AC-1**: WHEN the middleware receives a request without payment header, the system SHALL return HTTP 402 with body containing `x402Version: 2`, `scheme: "exact"`, and `network: "eip155:2368"`.
2. **AC-2**: WHEN the middleware reads the incoming payment header, the system SHALL read from the `payment-signature` header (not `x-payment`).
3. **AC-3**: WHEN the adapter calls Pieverse `/v2/verify`, the system SHALL send body `{ paymentPayload: { x402Version: 2, scheme: "exact", network: "eip155:2368", payload: { authorization, signature } }, paymentRequirements: { x402Version: 2, scheme: "exact", network: "eip155:2368", maxAmountRequired, payTo, asset, extra: null } }`.
4. **AC-4**: WHEN the adapter calls Pieverse `/v2/settle`, the system SHALL send body in the same v2 envelope structure as AC-3.
5. **AC-5**: WHEN the adapter signs a client-side payment (sign method), the system SHALL produce a header value encodeable as `PAYMENT-SIGNATURE` using v2 payload format.
6. **AC-6**: WHEN the server returns a successful payment response, the system SHALL use the `payment-response` header (not `x-payment-response`).
7. **AC-7**: WHEN `scripts/demo-x402.ts` runs against a live server with Pieverse facilitator, the system SHALL complete the full flow (402 -> sign -> verify -> settle -> 200) without errors.
8. **AC-8**: WHEN existing tests for compose service and a2a-key middleware run, they SHALL pass with updated mocks reflecting v2 format.

## Files to Modify/Create

| # | Archivo | Accion | Que hacer | Exemplar |
|---|---------|--------|-----------|----------|
| 1 | `src/types/index.ts` | Modificar | Change `X402Response.x402Version` from literal `1` to `2`; restructure `PieverseVerifyRequest`/`PieverseSettleRequest` to v2 envelope types | Current file (lines 250-310) |
| 2 | `src/adapters/kite-ozone/payment.ts` | Modificar | Change constants `KITE_SCHEME` to `'exact'`, `KITE_NETWORK` to `'eip155:2368'`; restructure `verify()`/`settle()` bodies to v2 envelope; update `sign()` network value | Current file |
| 3 | `src/middleware/x402.ts` | Modificar | Change header from `x-payment` to `payment-signature`; change `x402Version` to `2` in `buildX402Response()`; add `payment-response` header on successful payment | Current file |
| 4 | `src/services/compose.ts` | Modificar | Change outbound header from `X-Payment` to `PAYMENT-SIGNATURE` | Current file (line 81) |
| 5 | `src/services/compose.test.ts` | Modificar | Update mock `network` values from `'kite-testnet'` to `'eip155:2368'`; update header assertions from `X-Payment` to `PAYMENT-SIGNATURE` | Current file |
| 6 | `src/middleware/a2a-key.test.ts` | Modificar | Update mock adapter `getNetwork` return to `'eip155:2368'` | Current file (line 37) |
| 7 | `scripts/demo-x402.ts` | Modificar | Change header from `X-Payment` to `PAYMENT-SIGNATURE`; update payload to v2 format; update console text | Current file |

## Exemplars

### Exemplar 1: Current v1 adapter (before/after reference)
**Archivo**: `src/adapters/kite-ozone/payment.ts`
**Usar para**: File #2
**Patron clave**:
- Constants at top: `KITE_SCHEME`, `KITE_NETWORK` (change values, keep pattern)
- `verify()` builds `PieverseVerifyRequest` body, POSTs to `${facilitatorUrl}/v2/verify`
- `settle()` builds `PieverseSettleRequest` body, POSTs to `${facilitatorUrl}/v2/settle`
- `sign()` builds `X402PaymentRequest` with `{ authorization, signature, network }`, base64-encodes for header
- Error handling: try/catch around fetch, throw with descriptive message
- `EIP712_DOMAIN` and `EIP712_TYPES` stay UNTOUCHED

### Exemplar 2: Current v1 middleware (before/after reference)
**Archivo**: `src/middleware/x402.ts`
**Usar para**: File #3
**Patron clave**:
- `buildX402Response()` returns `X402Response` with `x402Version` and `accepts[]` array
- `decodeXPayment()` decodes base64 header -> JSON -> validates fields
- `requirePayment()` returns `preHandlerHookHandler[]`
- Header access: `request.headers['x-payment']` (lowercase, Fastify convention)
- On success: sets `request.paymentTxHash` and `request.paymentVerified = true`

### Exemplar 3: Current compose outbound call
**Archivo**: `src/services/compose.ts`
**Usar para**: File #4
**Patron clave**:
- Line 81: `headers['X-Payment'] = result.xPaymentHeader` -- single line change to `PAYMENT-SIGNATURE`
- Line 90: `settle()` call uses `network: paymentRequest.network ?? ''` -- network value comes from sign() result

## Contrato de Integracion -- BLOQUEANTE

### Middleware -> Client (402 Response)

**Response (HTTP 402):**
```json
{
  "error": "payment-signature header is required",
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:2368",
      "maxAmountRequired": "1000000000000000000",
      "resource": "https://host/orchestrate",
      "description": "...",
      "mimeType": "application/json",
      "payTo": "0x...",
      "maxTimeoutSeconds": 300,
      "asset": "0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63",
      "extra": null,
      "merchantName": "WasiAI"
    }
  ],
  "x402Version": 2
}
```

### Client -> Middleware (Payment Header)

**Header name**: `payment-signature` (read as lowercase)
**Header value**: base64(JSON) of `X402PaymentRequest` (unchanged structure: `{ authorization, signature, network? }`)

### Adapter -> Pieverse /v2/verify

**Request (POST):**
```json
{
  "paymentPayload": {
    "x402Version": 2,
    "scheme": "exact",
    "network": "eip155:2368",
    "payload": {
      "authorization": {
        "from": "0x...",
        "to": "0x...",
        "value": "1000000000000000000",
        "validAfter": "0",
        "validBefore": "9999999999",
        "nonce": "0x..."
      },
      "signature": "0x..."
    }
  },
  "paymentRequirements": {
    "x402Version": 2,
    "scheme": "exact",
    "network": "eip155:2368",
    "maxAmountRequired": "1000000000000000000",
    "payTo": "0x...",
    "asset": "0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63",
    "extra": null
  }
}
```

**Response exitoso (200):**
```json
{ "valid": true }
```

**Errores:**
| HTTP | Cuando |
|------|--------|
| 400 | Missing paymentPayload or paymentRequirements (this is the current v1 failure) |
| 4xx/5xx | Facilitator unavailable or internal error |

### Adapter -> Pieverse /v2/settle

Same v2 envelope as `/v2/verify`.

**Response exitoso (200):**
```json
{ "txHash": "0x...", "success": true }
```

### Middleware -> Client (Success Response Header)

**Header name**: `payment-response` (set on reply after successful settle)
**Header value**: `txHash` string

## Header Migration Map (v1 -> v2)

| Purpose | v1 name | v2 name | Where in code |
|---------|---------|---------|---------------|
| Client -> Server (request) | `x-payment` | `payment-signature` | `src/middleware/x402.ts` line 49, `src/middleware/a2a-key.test.ts` |
| Server -> Agent (outbound compose) | `X-Payment` | `PAYMENT-SIGNATURE` | `src/services/compose.ts` line 81 |
| Server -> Client (response) | (not used) | `payment-response` | `src/middleware/x402.ts` (new, after settle success) |

## Constant Migration Map (v1 -> v2)

| Constant | v1 value | v2 value | File |
|----------|----------|----------|------|
| `KITE_SCHEME` | `'gokite-aa'` | `'exact'` | `src/adapters/kite-ozone/payment.ts` line 8 |
| `KITE_NETWORK` | `'kite-testnet'` | `'eip155:2368'` | `src/adapters/kite-ozone/payment.ts` line 9 |
| `x402Version` | `1` | `2` | `src/types/index.ts` line 253, `src/middleware/x402.ts` line 28 |

## CAIP-2 Network Format

| v1 (free-text) | v2 (CAIP-2) | Meaning |
|----------------|-------------|---------|
| `kite-testnet` | `eip155:2368` | EVM chain namespace `eip155`, chain ID `2368` |

CAIP-2 format: `eip155:{chainId}` per https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md

## Pieverse v2 Body Structure (before/after)

### v1 (current -- rejected by Pieverse):
```typescript
const body: PieverseVerifyRequest = {
  authorization: proof.authorization,
  signature: proof.signature,
  network: KITE_NETWORK
}
```

### v2 (target -- accepted by Pieverse):
```typescript
const body = {
  paymentPayload: {
    x402Version: 2,
    scheme: KITE_SCHEME,           // 'exact'
    network: KITE_NETWORK,         // 'eip155:2368'
    payload: {
      authorization: proof.authorization,
      signature: proof.signature
    }
  },
  paymentRequirements: {
    x402Version: 2,
    scheme: KITE_SCHEME,           // 'exact'
    network: KITE_NETWORK,         // 'eip155:2368'
    maxAmountRequired: proof.authorization.value,  // derived from proof
    payTo: proof.authorization.to,                 // derived from proof
    asset: KITE_PAYMENT_TOKEN,                     // adapter constant
    extra: null
  }
}
```

The `paymentRequirements` fields are ALL derivable from existing data:
- `maxAmountRequired` = `proof.authorization.value` (the amount the client agreed to pay)
- `payTo` = `proof.authorization.to` (the recipient wallet)
- `asset` = `KITE_PAYMENT_TOKEN` (adapter constant `0x0fF5393387ad2f9f691FD6Fd28e07E3969e27e63`)
- `extra` = `null` (constant)

No interface change to `PaymentAdapter`, `X402Proof`, or `SettleRequest` needed.

## Constraint Directives

### OBLIGATORIO
- All header names and body structures MUST match Pieverse v2 spec exactly (CD-1)
- Demo script MUST be validated E2E against live Pieverse facilitator before marking DONE (CD-4)
- Header names in code MUST be lowercase (`payment-signature`, `payment-response`) per HTTP/2 convention. Outbound headers in `compose.ts` use canonical form `PAYMENT-SIGNATURE` (CD-8)
- Follow existing patterns in each file -- imports, error handling, naming

### PROHIBIDO
- NO backward-compat v1 fallback. Pieverse only speaks v2 (CD-2)
- NO changes to adapter interface signatures in `src/adapters/types.ts` (CD-3)
- NO hardcoded URLs. `KITE_FACILITATOR_URL` env var override must continue working (CD-5)
- NO changes to `EIP712_DOMAIN` or `EIP712_TYPES` (CD-6)
- NO changes to `src/adapters/registry.ts` or `src/adapters/types.ts` (CD-7)
- NO new dependencies (CD-9)
- NO modification of files outside the 7 files listed in this story (CD-10)
- NO changes to `src/adapters/kite-ozone/chain.js` or any other file not in scope

## Test Expectations

| Test | ACs que cubre | Framework | Tipo |
|------|--------------|-----------|------|
| `src/services/compose.test.ts` (T-3 update) | AC-5, AC-8 | vitest | unit |
| `src/middleware/a2a-key.test.ts` (mock update) | AC-1, AC-2, AC-8 | vitest | integration |
| `scripts/demo-x402.ts` (manual E2E) | AC-1 through AC-7 | Manual (npx tsx) | e2e |

### Criterio Test-First

| Tipo de cambio | Test-first? |
|----------------|-------------|
| Type changes (W0.1) | No -- type changes, verified by tsc |
| Adapter body restructure (W0.2) | No -- validated by E2E demo |
| Middleware header rename (W1.1) | No -- tested by existing integration tests after mock update |
| Compose header rename (W1.2) | No -- tested by existing unit test T-3 |
| Test mock updates (W2) | N/A -- these ARE the tests |
| Demo script (W3) | No -- E2E validation script |

## Waves

### Wave -1: Environment Gate (OBLIGATORIO -- verificar antes de tocar codigo)

```bash
# Verificar dependencias instaladas
cd /home/ferdev/.openclaw/workspace/wasiai-a2a && npm install 2>/dev/null

# Verificar que los 7 archivos del Scope IN existen
ls src/types/index.ts \
   src/adapters/kite-ozone/payment.ts \
   src/middleware/x402.ts \
   src/services/compose.ts \
   src/services/compose.test.ts \
   src/middleware/a2a-key.test.ts \
   scripts/demo-x402.ts

# Verificar env vars para E2E demo (Wave 3 only)
echo "OPERATOR_PRIVATE_KEY set: ${OPERATOR_PRIVATE_KEY:+yes}" 2>/dev/null || true

# Verificar typecheck passes before changes
npx tsc --noEmit
```

**Si algo falla en Wave -1:** PARAR y reportar al orquestador antes de continuar.

### Wave 0 (Serial Gate -- types + constants)

- [ ] **W0.1**: `src/types/index.ts`
  - Change `X402Response.x402Version` from literal `1` to literal `2` (line 253)
  - Replace `PieverseVerifyRequest` type (lines 280-284): change from flat `{ authorization, signature, network }` to v2 envelope `{ paymentPayload: { x402Version: 2, scheme: string, network: string, payload: { authorization, signature } }, paymentRequirements: { x402Version: 2, scheme: string, network: string, maxAmountRequired: string, payTo: string, asset: string, extra: null | Record<string, unknown> } }`
  - Replace `PieverseSettleRequest` type (lines 297-301): same v2 envelope structure as `PieverseVerifyRequest`
  - Do NOT touch `X402PaymentRequest` (lines 262-273) -- the decoded header payload structure stays the same
  - Do NOT touch `X402PaymentPayload` (lines 225-245) -- the 402 response payload structure stays the same
  - Verify: `npx tsc --noEmit` (will fail until W0.2 updates adapter)

- [ ] **W0.2**: `src/adapters/kite-ozone/payment.ts`
  - Change `KITE_SCHEME` from `'gokite-aa'` to `'exact'` (line 8)
  - Change `KITE_NETWORK` from `'kite-testnet'` to `'eip155:2368'` (line 9)
  - In `verify()` (line 45): replace flat body with v2 envelope. Use `proof.authorization.value` for `maxAmountRequired`, `proof.authorization.to` for `payTo`, `KITE_PAYMENT_TOKEN` for `asset`
  - In `settle()` (line 56): same v2 envelope restructure using `req.authorization.value`, `req.authorization.to`, `KITE_PAYMENT_TOKEN`
  - In `sign()` (line 79): `paymentRequest.network` will automatically use updated `KITE_NETWORK` value. No structural change needed here.
  - Do NOT touch `EIP712_DOMAIN` or `EIP712_TYPES` (lines 15-19)
  - Verify: `npx tsc --noEmit` passes

### Wave 1 (Parallelizable -- middleware + compose)

- [ ] **W1.1**: `src/middleware/x402.ts`
  - Line 28: change `x402Version: 1` to `x402Version: 2` in `buildX402Response()`
  - Line 49: change `request.headers['x-payment']` to `request.headers['payment-signature']`
  - Update `decodeXPayment()` error messages: `'X-Payment'` -> `'payment-signature'` in user-facing strings (lines 34, 36, 38)
  - After line 69 (`request.paymentVerified = true`): add `reply.header('payment-response', settleResult.txHash)` for AC-6
  - Do NOT change the `X402PaymentRequest` decode logic -- the client-side payload structure (`{ authorization, signature }`) is unchanged

- [ ] **W1.2**: `src/services/compose.ts`
  - Line 81: change `headers['X-Payment']` to `headers['PAYMENT-SIGNATURE']`
  - No other changes needed

### Wave 2 (Tests -- depends on W0 + W1)

- [ ] **W2.1**: `src/services/compose.test.ts`
  - T-1 (line 36): change assertion from `callHeaders['X-Payment']` to `callHeaders['PAYMENT-SIGNATURE']` (expect undefined for free agents)
  - T-3 (line 50): change mock `network: 'kite-testnet'` to `network: 'eip155:2368'` in `mockPR`
  - T-3 (line 56): change assertion from `callHeaders['X-Payment']` to `callHeaders['PAYMENT-SIGNATURE']`
  - T-4 (line 62): change mock `network: 'kite-testnet'` to `network: 'eip155:2368'`
  - T-5 (line 70): change mock `network: 'kite-testnet'` to `network: 'eip155:2368'`
  - T-7 (line 89): change mock `network: 'kite-testnet'` to `network: 'eip155:2368'`
  - T-9 (line 105): change mock `network: 'kite-testnet'` to `network: 'eip155:2368'`
  - Summary: all `'kite-testnet'` -> `'eip155:2368'`, all `'X-Payment'` -> `'PAYMENT-SIGNATURE'`

- [ ] **W2.2**: `src/middleware/a2a-key.test.ts`
  - Line 37: change `getNetwork: () => 'kite-ozone-testnet'` to `getNetwork: () => 'eip155:2368'`
  - Line 46: change `getChainConfig` mock `name: 'kite-ozone-testnet'` to `name: 'eip155:2368'` (if this test uses it for network comparison)
  - Verify: `npx vitest run` passes

### Wave 3 (Demo + validation)

- [ ] **W3.1**: `scripts/demo-x402.ts`
  - Line 153-161: rename `xPaymentPayload` variable to `paymentPayload` (cosmetic) and keep same structure `{ authorization, signature, network }`
  - Line 159: rename `xPaymentHeader` to `paymentHeader` (cosmetic)
  - Line 161: change console text from `'X-Payment header'` to `'PAYMENT-SIGNATURE header'`
  - Line 171-177: change header from `'X-Payment': xPaymentHeader` to `'PAYMENT-SIGNATURE': paymentHeader`
  - Line 167: update console text referencing the header name
  - Update all console.log strings that mention `X-Payment` to say `PAYMENT-SIGNATURE`

- [ ] **W3.2**: Run `npx vitest run` -- all tests pass
- [ ] **W3.3**: Run `npx tsx scripts/demo-x402.ts` against live Pieverse -- full flow completes (AC-7)

### Verificacion Incremental

| Wave | Verificacion al completar |
|------|--------------------------|
| W-1 | All 7 files exist, tsc passes, deps installed |
| W0 | `npx tsc --noEmit` -- types + adapter compile |
| W1 | `npx tsc --noEmit` -- middleware + compose compile |
| W2 | `npx vitest run` -- all tests pass |
| W3 | E2E demo against live Pieverse (`npx tsx scripts/demo-x402.ts`) |

## Out of Scope

- `src/adapters/types.ts` -- DO NOT TOUCH (CD-3, CD-7)
- `src/adapters/registry.ts` -- DO NOT TOUCH (CD-7)
- `src/adapters/kite-ozone/chain.js` -- DO NOT TOUCH
- `EIP712_DOMAIN` / `EIP712_TYPES` in payment.ts -- DO NOT TOUCH (CD-6)
- Chain-adaptive adapter refactor (WKH-35)
- New chain support (Base, Avalanche)
- L3 primitives (BudgetService, IdentityService)
- Gasless flow (WKH-29/38)
- Any file not in the 7-file scope list
- NO "improve" adjacent code
- NO add functionality not listed

## Anti-Hallucination Checklist

- [x] `src/types/index.ts` verified exists (Read confirmed)
- [x] `src/adapters/kite-ozone/payment.ts` verified exists (Read confirmed)
- [x] `src/middleware/x402.ts` verified exists (Read confirmed)
- [x] `src/services/compose.ts` verified exists (Read confirmed)
- [x] `src/services/compose.test.ts` verified exists (Read confirmed)
- [x] `src/middleware/a2a-key.test.ts` verified exists (Read confirmed)
- [x] `scripts/demo-x402.ts` verified exists (Read confirmed)
- [x] `src/adapters/types.ts` verified exists -- confirms `PaymentAdapter`, `X402Proof`, `SettleRequest` interfaces (NOT to be modified)
- [x] `KITE_SCHEME` currently `'gokite-aa'` at `src/adapters/kite-ozone/payment.ts` line 8
- [x] `KITE_NETWORK` currently `'kite-testnet'` at `src/adapters/kite-ozone/payment.ts` line 9
- [x] `x402Version: 1` at `src/types/index.ts` line 253
- [x] `x402Version: 1` at `src/middleware/x402.ts` line 28 (inside `buildX402Response`)
- [x] `request.headers['x-payment']` at `src/middleware/x402.ts` line 49
- [x] `headers['X-Payment']` at `src/services/compose.ts` line 81
- [x] `network: 'kite-testnet'` in compose.test.ts mocks (lines 50, 62, 70, 89, 105)
- [x] `getNetwork: () => 'kite-ozone-testnet'` in a2a-key.test.ts line 37
- [x] `'X-Payment': xPaymentHeader` in demo-x402.ts line 175
- [x] `PieverseVerifyRequest` is flat `{ authorization, signature, network }` at types/index.ts lines 280-284
- [x] `PieverseSettleRequest` is flat `{ authorization, signature, network }` at types/index.ts lines 297-301
- [x] v2 target values confirmed: scheme `"exact"`, network `"eip155:2368"`, header `payment-signature` (from Pieverse /v2/supported, documented in SDD)
- [x] No new dependencies needed (viem, node:crypto, Fastify all already present)

## Escalation Rule

> **Si algo no esta en este Story File, Dev PARA y pregunta a Architect.**
> No inventar. No asumir. No improvisar.

Situaciones de escalation:
- Pieverse `/v2/verify` returns unexpected error beyond "Missing paymentPayload or paymentRequirements"
- `paymentRequirements` needs fields not listed in the v2 envelope (the SDD resolved all known fields, but Pieverse may have undocumented ones)
- Any file outside the 7-file scope needs changes
- `tsc --noEmit` fails on type errors not caused by the v1->v2 migration
- Demo E2E fails with errors unrelated to the migration (e.g., wallet balance, RPC issues)

---

*Story File generado por NexusAgil -- F2.5*
