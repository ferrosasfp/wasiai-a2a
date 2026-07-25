/**
 * Tests for src/lib/wallet-format.ts (WKH-143b · single source EVM validator).
 *
 * Módulo leaf puro — sin mocks (mismo estilo que price.test.ts). Garantiza que
 * `isValidWallet` es el criterio EXACTO que comparte el write-path del publish
 * con el money-path de cobro (`resolveRecipients`) — CD-1.
 */

import { describe, expect, it } from 'vitest';
import {
  ADDRESS_RE,
  isValidPayoutWallet,
  isValidSolanaAddress,
  isValidWallet,
} from './wallet-format.js';

describe('isValidWallet (CD-1)', () => {
  it('accepts a valid EVM address (0x + 40 hex, lower/upper/mixed case)', () => {
    expect(isValidWallet('0x1111111111111111111111111111111111111111')).toBe(
      true,
    );
    expect(isValidWallet('0xABCDEF0123456789abcdef0123456789ABCDEF01')).toBe(
      true,
    );
    expect(isValidWallet('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(
      true,
    );
  });

  it('rejects empty string, short/long, non-hex, missing 0x, null, undefined, non-string', () => {
    expect(isValidWallet('')).toBe(false);
    expect(isValidWallet('0xshort')).toBe(false);
    // 39 hex (too short)
    expect(isValidWallet('0x111111111111111111111111111111111111111')).toBe(
      false,
    );
    // 41 hex (too long)
    expect(isValidWallet('0x11111111111111111111111111111111111111111')).toBe(
      false,
    );
    // non-hex char (g)
    expect(isValidWallet('0x111111111111111111111111111111111111111g')).toBe(
      false,
    );
    // missing 0x prefix
    expect(isValidWallet('1111111111111111111111111111111111111111')).toBe(
      false,
    );
    expect(isValidWallet(null)).toBe(false);
    expect(isValidWallet(undefined)).toBe(false);
    expect(isValidWallet(12345 as unknown as string)).toBe(false);
  });

  it('ADDRESS_RE is the exact EVM format regex (no EIP-55 checksum)', () => {
    expect(ADDRESS_RE.source).toBe('^0x[0-9a-fA-F]{40}$');
  });
});

// WKH-234 — validador Solana base58 puro (CD-7) + dispatch namespace-aware.
describe('isValidSolanaAddress (WKH-234, AC-5)', () => {
  it('accepts a valid base58 32-byte pubkey (mint / owner)', () => {
    // USDC-SPL Circle devnet default mint (DT-9).
    expect(
      isValidSolanaAddress('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
    ).toBe(true);
    // wSOL mint + System Program (all-'1') — both canonical 32-byte pubkeys.
    expect(
      isValidSolanaAddress('So11111111111111111111111111111111111111112'),
    ).toBe(true);
    expect(isValidSolanaAddress('11111111111111111111111111111111')).toBe(true);
  });

  it('rejects invalid charset (0/O/I/l, punctuation), an EVM 0x address, and empty', () => {
    expect(isValidSolanaAddress('O0Il')).toBe(false); // base58-excluded chars
    expect(isValidSolanaAddress('notbase58!!!')).toBe(false); // punctuation
    expect(
      isValidSolanaAddress('0x5425890298aed601595a70AB815c96711a31Bc65'),
    ).toBe(false); // EVM address is not valid base58 (contains 0)
    expect(isValidSolanaAddress('')).toBe(false);
  });

  it('rejects a base58 string that decodes to ≠ 32 bytes', () => {
    expect(isValidSolanaAddress('short')).toBe(false); // < 32 bytes
    // 44 'z' chars decode to >32 bytes.
    expect(isValidSolanaAddress('z'.repeat(50))).toBe(false);
  });
});

describe('isValidPayoutWallet dispatch (WKH-234, AC-1/AC-5)', () => {
  const EVM = '0x5425890298aed601595a70AB815c96711a31Bc65';
  const SOL = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

  it("ns 'evm' accepts a 0x address and rejects base58 (byte-identical EVM)", () => {
    expect(isValidPayoutWallet(EVM, 'evm')).toBe(true);
    expect(isValidPayoutWallet(SOL, 'evm')).toBe(false);
  });

  it("ns 'solana' accepts a base58 pubkey and rejects a 0x address", () => {
    expect(isValidPayoutWallet(SOL, 'solana')).toBe(true);
    expect(isValidPayoutWallet(EVM, 'solana')).toBe(false);
  });
});
