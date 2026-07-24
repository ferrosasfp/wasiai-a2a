/**
 * Tests for src/adapters/chain-resolver.ts — Solana slug resolution (WKH-234).
 *
 * Pure module (no registry / no flag read — CD-7/CD-8). Verifies the resolver
 * recognizes the Solana devnet slugs statically and rejects unknown / mainnet
 * inputs (AC-6). EVM aliases are covered by the existing multichain suite.
 */

import { describe, expect, it } from 'vitest';
import { normalizeChainSlug } from './chain-resolver.js';

describe('normalizeChainSlug — Solana (WKH-234)', () => {
  it("maps 'solana-devnet' and 'solana' → 'solana-devnet'", () => {
    expect(normalizeChainSlug('solana-devnet')).toBe('solana-devnet');
    expect(normalizeChainSlug('solana')).toBe('solana-devnet');
  });

  it('is case/space-insensitive on the Solana slug', () => {
    expect(normalizeChainSlug('  SOLANA-DEVNET ')).toBe('solana-devnet');
    expect(normalizeChainSlug('Solana')).toBe('solana-devnet');
  });

  it("returns undefined for 'solana-mainnet' (devnet-only, CD-4) and garbage (AC-6)", () => {
    expect(normalizeChainSlug('solana-mainnet')).toBeUndefined();
    expect(normalizeChainSlug('solana-testnet')).toBeUndefined();
    expect(normalizeChainSlug('not-a-chain')).toBeUndefined();
    expect(normalizeChainSlug('')).toBeUndefined();
  });

  it('still resolves EVM slugs (no regression)', () => {
    expect(normalizeChainSlug('avalanche-fuji')).toBe('avalanche-fuji');
    expect(normalizeChainSlug('base-sepolia')).toBe('base-sepolia');
  });
});
