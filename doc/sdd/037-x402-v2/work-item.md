# Work Item -- [WKH-X402-V2] Migrate x402 from v1 to v2 (Pieverse format)

## Resumen

Pieverse facilitator has migrated to x402 v2 format. Our adapter still sends v1 payloads (wrong headers, wrong body structure, wrong network/scheme identifiers). Result: 400 "Missing paymentPayload or paymentRequirements" on every /v2/verify call. This work item migrates all x402 touchpoints to v2 format so payments work again E2E.

## Sizing

- SDD_MODE: full
- Estimation: M (5+ files, critical path, but well-scoped protocol migration with clear before/after spec)
- Branch: feat/037-x402-v2
- Skills: [blockchain-payments, protocol-migration]

## Acceptance Criteria (EARS)

- AC-1: WHEN the middleware receives a request without payment header, the system SHALL return HTTP 402 with body containing `x402Version: 2`, `scheme: "exact"`, and `network` in CAIP-2 format (`"eip155:2368"`).
- AC-2: WHEN the middleware reads the incoming payment header, the system SHALL read from the `PAYMENT-SIGNATURE` header (not `X-PAYMENT`).
- AC-3: WHEN the adapter calls Pieverse `/v2/verify`, the system SHALL send body `{ paymentPayload: { x402Version: 2, scheme: "exact", network: "eip155:2368", authorization, signature }, paymentRequirements: { x402Version: 2, scheme: "exact", network: "eip155:2368", maxAmountRequired, payTo, asset, ... } }`.
- AC-4: WHEN the adapter calls Pieverse `/v2/settle`, the system SHALL send body in the same v2 structure as AC-3.
- AC-5: WHEN the adapter signs a client-side payment (sign method), the system SHALL produce a header value encodeable as `PAYMENT-SIGNATURE` using v2 payload format.
- AC-6: WHEN the server returns a successful payment response, the system SHALL use the `PAYMENT-RESPONSE` header (not `X-PAYMENT-RESPONSE`).
- AC-7: WHEN `scripts/demo-x402.ts` runs against a live server with Pieverse facilitator, the system SHALL complete the full flow (402 -> sign -> verify -> settle -> 200) without errors.
- AC-8: WHEN existing tests for compose service and a2a-key middleware run, they SHALL pass with updated mocks reflecting v2 format.

## Scope IN

- `src/adapters/kite-ozone/payment.ts` -- constants (KITE_SCHEME, KITE_NETWORK), verify() body, settle() body, sign() output format
- `src/middleware/x402.ts` -- header names (`x-payment` -> `payment-signature`, response header), `buildX402Response()` format (`x402Version: 2`, CAIP-2 network, `scheme: "exact"`), `decodeXPayment()` header source
- `src/types/index.ts` -- `X402Response.x402Version` type (1 -> 2), `PieverseVerifyRequest` / `PieverseSettleRequest` body structure (wrap in paymentPayload + paymentRequirements), `X402PaymentPayload.scheme` / `.network` values
- `scripts/demo-x402.ts` -- header name, EIP-712 domain/types if needed, v2 payload construction, verification assertion
- `src/middleware/a2a-key.test.ts` -- update header references in mocks
- `src/services/compose.test.ts` -- update mock payloads to v2 format (network: "eip155:2368", scheme: "exact")

## Scope OUT

- Chain-adaptive adapter refactor (WKH-35) -- this HU only touches kite-ozone adapter internals
- New chain support (Base, Avalanche, etc.)
- EIP-712 domain/types changes (only if Pieverse v2 requires different signing -- needs validation in F2)
- Changes to L3 primitives (BudgetService, IdentityService)
- Changes to gasless flow (WKH-29/38)

## Decisiones tecnicas (DT-N)

- DT-1: Header names follow x402 v2 spec literally: request = `PAYMENT-SIGNATURE`, response = `PAYMENT-RESPONSE`. Case-insensitive per HTTP spec but we store lowercase in code (`payment-signature`).
- DT-2: Network format changes from free-text (`"kite-testnet"`) to CAIP-2 (`"eip155:2368"`). The adapter constants change; callers that pass network from outside must also use CAIP-2.
- DT-3: Scheme changes from `"gokite-aa"` to `"exact"` per Pieverse v2. This is a Pieverse-dictated value, not our choice.
- DT-4: Verify/settle body wraps existing fields into `{ paymentPayload, paymentRequirements }` envelope. Source of truth: Pieverse `/v2/supported` endpoint and https://docs.x402.org/guides/migration-v1-to-v2.
- DT-5: `X402Response.x402Version` type changes from literal `1` to literal `2`. This is a breaking change for any external consumer parsing 402 responses -- acceptable because v1 was already broken with Pieverse.

## Constraint Directives (CD-N)

- CD-1: OBLIGATORIO -- all header names and body structures MUST match Pieverse v2 spec exactly. Source of truth: GET https://facilitator.pieverse.io/ and GET https://facilitator.pieverse.io/v2/supported.
- CD-2: PROHIBIDO -- no backward-compat v1 fallback. Pieverse only speaks v2; maintaining v1 code paths adds complexity with zero benefit.
- CD-3: PROHIBIDO -- no changes to adapter interface signatures in `src/adapters/types.ts`. The PaymentAdapter interface (verify, settle, quote, sign) stays stable; only internal implementations change.
- CD-4: OBLIGATORIO -- demo script MUST be validated E2E against live Pieverse facilitator before marking DONE.
- CD-5: PROHIBIDO -- no hardcoded URLs. `KITE_FACILITATOR_URL` env var override must continue working.

## Missing Inputs

- [resuelto en F2] Exact `paymentRequirements` fields expected by Pieverse v2 -- need to confirm full field list from /v2/supported response or migration docs. The HU provides the known fields; Architect validates in F2.
- [resuelto en F2] Whether EIP-712 domain/types need changes for v2 signing -- Pieverse may accept same EIP-712 structure with new envelope. Architect validates.

## Analisis de paralelismo

- This HU BLOCKS: WKH-029 (E2E test suite) -- any x402 E2E tests will fail until v2 migration lands.
- This HU BLOCKS: any demo that exercises payment flow.
- Can run in PARALLEL with: WKH-026 (hardening), WKH-028 (README), WKH-025 (a2a-key middleware -- different auth path).
- No dependency on WKH-035 (adapter refactor) -- this HU changes kite-ozone internals without restructuring the adapter layer.
