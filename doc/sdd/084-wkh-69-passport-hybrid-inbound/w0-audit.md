# Wave 0 Audit — WKH-69 (read-only)

Date: 2026-05-03
Branch: feat/084-wkh-69-passport-hybrid-inbound
Baseline tests: 794 passing, 0 failing (vitest 4.1.5, Test Files 61)

| Check | Expected | Actual | Status |
|-------|----------|--------|--------|
| `DEFAULT_PAYMENT_TOKEN_MAINNET` | `0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e` | `0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e` (payment.ts:90-91) | OK |
| `DEFAULT_EIP712_DOMAIN_NAME_MAINNET` | `'USDC'` | `'USDC'` (payment.ts:93) | OK |
| `DEFAULT_TOKEN_SYMBOL_MAINNET` | `'USDC.e'` | `'USDC.e'` (payment.ts:96) | OK |
| `DEFAULT_PAYMENT_TOKEN_TESTNET` | `0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9` | `0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9` (payment.ts:88-89) | OK |
| `DEFAULT_EIP712_DOMAIN_NAME_TESTNET` | `'PYUSD'` | `'PYUSD'` (payment.ts:92) | OK |
| `DEFAULT_TOKEN_SYMBOL_TESTNET` | `'PYUSD'` | `'PYUSD'` (payment.ts:95) | OK |
| `chain.ts` mainnet chainId | `2366` | `2366` (chain.ts:25) | OK |
| `chain.ts` testnet chainId | `2368` | `2368` (chain.ts:4) | OK |
| `.gitignore` includes `.kite-passport/` | present | line 44 | OK |
| `.env.example` has `KITE_NETWORK=` block | present | line 98 (`KITE_NETWORK=testnet`) | OK |
| `requireForwardKey` exemplar at line 66 | `66:export function requireForwardKey(): preHandlerAsyncHookHandler[] {` | matches | OK |
| `event-tracking.ts` metadata fields | `endpoint:` line 68, `requestId:` line 73 | matches | OK |
| `X402PaymentRequest` interface | line 381 | matches | OK |

Conclusion: all defaults correct, no drift. Proceed to W1.
