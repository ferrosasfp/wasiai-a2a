/**
 * Tests for src/adapters/chain-resolver.ts — Solana slug resolution (WKH-234).
 *
 * Pure module (no registry / no flag read — CD-7/CD-8). Verifies the resolver
 * recognizes the Solana devnet slugs statically and rejects unknown / mainnet
 * inputs (AC-6). EVM aliases are covered by the existing multichain suite.
 */

import { describe, expect, it } from 'vitest';
import {
  getChainNamespace,
  getChainVmFamily,
  isMainnetChainKey,
  normalizeChainSlug,
} from './chain-resolver.js';
import { isMainnetChainKey as isMainnetFromSettleVerifier } from './settle-verifier.js';
import type { ChainKey } from './types.js';

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

// ─── Proyecciones puras del ChainKey (fix-pack AR-profundo) ───────────────
describe('chain-resolver — proyecciones puras del ChainKey (fix-pack AR-profundo)', () => {
  const ALL_KEYS: ChainKey[] = [
    'kite-ozone-testnet',
    'kite-mainnet',
    'avalanche-fuji',
    'avalanche-mainnet',
    'base-sepolia',
    'base-mainnet',
    'tempo-testnet',
    'solana-devnet',
  ];

  it('FIX 4: getChainVmFamily clasifica solana-devnet como no-EVM y el resto como EVM', () => {
    expect(getChainVmFamily('solana-devnet')).toBe('solana');
    for (const key of ALL_KEYS.filter((k) => k !== 'solana-devnet')) {
      expect(getChainVmFamily(key), `key=${key}`).toBe('evm');
    }
  });

  it('FIX 1a: getChainNamespace agrupa testnet+mainnet de la MISMA red', () => {
    expect(getChainNamespace('avalanche-fuji')).toBe('avalanche');
    expect(getChainNamespace('avalanche-mainnet')).toBe('avalanche');
    expect(getChainNamespace('kite-ozone-testnet')).toBe('kite');
    expect(getChainNamespace('kite-mainnet')).toBe('kite');
    expect(getChainNamespace('base-sepolia')).toBe('base');
    expect(getChainNamespace('base-mainnet')).toBe('base');
    expect(getChainNamespace('tempo-testnet')).toBe('tempo');
    expect(getChainNamespace('solana-devnet')).toBe('solana');
    // Todo alias del namespace avalanche (literal o numérico) cae en el MISMO
    // namespace → ninguno puede escapar el colapso legacy del payment-spec-reader.
    for (const alias of [
      'avalanche',
      'avalanche-testnet',
      'avalanche-fuji',
      'fuji',
      '43113',
      'avalanche-mainnet',
      '43114',
    ]) {
      const key = normalizeChainSlug(alias);
      expect(key, `alias=${alias}`).toBeDefined();
      expect(getChainNamespace(key as ChainKey), `alias=${alias}`).toBe(
        'avalanche',
      );
    }
  });

  it('FIX 1b: isMainnetChainKey = las 3 mainnet, y es la MISMA función que expone settle-verifier (sin duplicar el clasificador)', () => {
    for (const key of ALL_KEYS) {
      const expected = key.endsWith('-mainnet');
      expect(isMainnetChainKey(key), `key=${key}`).toBe(expected);
      // Invariante WKH-144: un solo clasificador para el gate del settle
      // re-verify y para el gate de opt-in del leg downstream.
      expect(isMainnetFromSettleVerifier(key)).toBe(isMainnetChainKey(key));
    }
    expect(ALL_KEYS.filter(isMainnetChainKey)).toEqual([
      'kite-mainnet',
      'avalanche-mainnet',
      'base-mainnet',
    ]);
  });
});
