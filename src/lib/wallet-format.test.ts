/**
 * Tests for src/lib/wallet-format.ts (WKH-143b · single source EVM validator).
 *
 * Módulo leaf puro — sin mocks (mismo estilo que price.test.ts). Garantiza que
 * `isValidWallet` es el criterio EXACTO que comparte el write-path del publish
 * con el money-path de cobro (`resolveRecipients`) — CD-1.
 */

import { describe, expect, it } from 'vitest';
import { ADDRESS_RE, isValidWallet } from './wallet-format.js';

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
