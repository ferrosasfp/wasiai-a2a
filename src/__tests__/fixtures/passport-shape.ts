/**
 * Passport-shape signature fixtures (WKH-69)
 *
 * // PASSPORT-MOCK-SHAPE: structural mock — NOT a cryptographic proof.
 * // (a) Keypair derivation assumption: we use a deterministic 32-byte hex
 * //     private key and derive an EVM address via viem's privateKeyToAccount
 * //     (secp256k1). The real Kite Passport session uses base58-encoded
 * //     ed25519-style public_key (see doc/sdd/spike-kite-passport/poc-results.md
 * //     § Critical finding — `delegation` structure (the architectural heart)).
 * //     The exact mapping ed25519 → EVM address inside Passport
 * //     is opaque to us until the post-merge smoke-test (DT-7 of SDD #084).
 * // (b) Test field correspondence:
 * //       authorization.from   ← would map to Passport `delegation.public_key`-derived address
 * //       authorization.to     ← merchant `payTo` (KITE_WALLET_ADDRESS)
 * //       authorization.value  ← amount in wei
 * //       authorization.nonce  ← random 0x bytes
 * //       signature            ← deterministic mock 0x..ab×65
 * // (c) Open question resolved/assumed: this fixture asserts STRUCTURAL
 * //     correctness (decodeXPayment + adapter shape acceptance) only. It
 * //     does NOT validate Passport's internal signing algorithm. Real wire
 * //     shape verification is gated by smoke-test (CD-WKH69-1).
 *
 * CD-WKH69-5 compliance: NO real Passport credentials, JWTs, agent_tokens,
 * user_ids, or public_keys are hardcoded here. The deterministic key is a
 * test-only fabrication (well-known test private key from viem docs).
 */
import { privateKeyToAccount } from 'viem/accounts';
import { X_PASSPORT_SESSION_HEADER } from '../../middleware/x402.js';

// Deterministic test-only secp256k1 private key. NOT a real Passport credential.
// Same key used in src/adapters/__tests__/payment.contract.test.ts.
const TEST_SESSION_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;

const TEST_SESSION_ACCOUNT = privateKeyToAccount(TEST_SESSION_PRIVATE_KEY);

export const PASSPORT_SESSION_ADDRESS = TEST_SESSION_ACCOUNT.address;

export interface PassportShapeOpts {
  from?: string;
  to?: string;
  value?: string;
  nonce?: string;
  network?: string;
}

/**
 * Build a base64-encoded `payment-signature` header value with a Passport-
 * shape authorization (deterministic `from` derived from a test keypair).
 *
 * @returns object with `headers` to spread into app.inject() AND the raw
 *   `paymentRequest` for assertions.
 */
export function buildPassportPaymentHeader(opts: PassportShapeOpts = {}): {
  headers: Record<string, string>;
  paymentRequest: {
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
    signature: string;
    network?: string;
  };
} {
  const paymentRequest = {
    authorization: {
      from: opts.from ?? PASSPORT_SESSION_ADDRESS,
      to: opts.to ?? '0x000000000000000000000000000000000000dEaD',
      value: opts.value ?? '1000000', // 1 USDC (6 decimals)
      validAfter: '0',
      validBefore: String(Math.floor(Date.now() / 1000) + 600), // +10 min
      nonce:
        opts.nonce ??
        '0x0000000000000000000000000000000000000000000000000000000000000001',
    },
    // Deterministic 0x{ab repeated 65 times} — matches mock signTypedData
    // pattern in payment.contract.test.ts.
    signature: `0x${'ab'.repeat(65)}`,
    network: opts.network ?? 'kite-mainnet',
  };
  const base64 = Buffer.from(JSON.stringify(paymentRequest), 'utf8').toString(
    'base64',
  );
  return {
    headers: {
      'payment-signature': base64,
      [X_PASSPORT_SESSION_HEADER]: 'true',
    },
    paymentRequest,
  };
}

/**
 * Same shape but WITHOUT the `x-passport-session` header — simulates a raw
 * EOA path for backward-compat tests (AC-8).
 */
export function buildEoaPaymentHeader(opts: PassportShapeOpts = {}): {
  headers: Record<string, string>;
  paymentRequest: {
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
    signature: string;
    network?: string;
  };
} {
  const result = buildPassportPaymentHeader(opts);
  // Strip the Passport hint header.
  const { [X_PASSPORT_SESSION_HEADER]: _omit, ...rest } = result.headers;
  return { headers: rest, paymentRequest: result.paymentRequest };
}
