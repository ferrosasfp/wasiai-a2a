/**
 * Tests for src/adapters/chain-resolver.ts — Solana slug resolution (WKH-234).
 *
 * Pure module (no registry / no flag read — CD-7/CD-8). Verifies the resolver
 * recognizes the Solana devnet slugs statically and rejects unknown / mainnet
 * inputs (AC-6). EVM aliases are covered by the existing multichain suite.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyDestinationEnvironment,
  classifyEvmChainId,
  classifySolanaCaip2,
  findChainEnvironmentDrift,
  getCanonicalChainId,
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

  // ── Fix-pack it2 BLQ-ALTO-1: mainnet-ness por el DESTINO REAL ────────────
  describe('clasificación por destino real (it2 BLQ-ALTO-1)', () => {
    it('T-it2-CR1: cada ChainKey tiene un chainId canónico declarado, y su clasificación COINCIDE con lo que el slug declara (invariante WKH-150)', () => {
      for (const key of ALL_KEYS) {
        const canonical = getCanonicalChainId(key);
        expect(canonical, `key=${key}`).toBeDefined();
        if (canonical === 'non-evm') {
          // Solana: el chainId del bundle es un sentinel sintético (DT-8), el id
          // autoritativo es el CAIP-2 → no se clasifica por número.
          expect(getChainVmFamily(key)).toBe('solana');
          continue;
        }
        expect(getChainVmFamily(key)).toBe('evm');
        expect(
          classifyEvmChainId(canonical) === 'mainnet',
          `key=${key} chainId=${canonical}`,
        ).toBe(isMainnetChainKey(key));
      }
    });

    it('T-it2-CR2: classifyEvmChainId clasifica los chainIds conocidos y FALLA CERRADO ante uno desconocido', () => {
      expect(classifyEvmChainId(2368)).toBe('testnet');
      expect(classifyEvmChainId(43113)).toBe('testnet');
      expect(classifyEvmChainId(84532)).toBe('testnet');
      expect(classifyEvmChainId(42429)).toBe('testnet');
      expect(classifyEvmChainId(2366)).toBe('mainnet');
      expect(classifyEvmChainId(43114)).toBe('mainnet');
      expect(classifyEvmChainId(8453)).toBe('mainnet');
      // Desconocido ⇒ dinero real hasta que alguien lo clasifique (fail-closed).
      for (const unknown of [1, 137, 999_999, 0, -1]) {
        expect(classifyEvmChainId(unknown), `chainId=${unknown}`).toBe(
          'mainnet',
        );
      }
    });

    it('T-it2-CR3: classifySolanaCaip2 marca mainnet-beta y deja pasar devnet (denylist)', () => {
      expect(
        classifySolanaCaip2('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'),
      ).toBe('testnet');
      expect(classifySolanaCaip2('solana:testcluster')).toBe('testnet');
      expect(
        classifySolanaCaip2('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'),
      ).toBe('mainnet');
      expect(
        classifySolanaCaip2(
          'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
        ),
      ).toBe('mainnet');
      expect(classifySolanaCaip2('solana:mainnet-beta')).toBe('mainnet');
    });

    it('T-it2-CR4: findChainEnvironmentDrift caza el caso KITE_NETWORK=mainnet (slug testnet → chainId 2366) y NO reporta drift cuando el bundle es coherente', () => {
      // El bug real: bundle del slug `kite-ozone-testnet` apuntando a Kite mainnet.
      expect(
        findChainEnvironmentDrift({
          chainKey: 'kite-ozone-testnet',
          destination: { vmFamily: 'evm', chainId: 2366 },
        }),
      ).toEqual({ declared: 'testnet', actual: 'mainnet' });
      // Coherentes → undefined.
      expect(
        findChainEnvironmentDrift({
          chainKey: 'kite-ozone-testnet',
          destination: { vmFamily: 'evm', chainId: 2368 },
        }),
      ).toBeUndefined();
      expect(
        findChainEnvironmentDrift({
          chainKey: 'avalanche-mainnet',
          destination: { vmFamily: 'evm', chainId: 43114 },
        }),
      ).toBeUndefined();
      expect(
        findChainEnvironmentDrift({
          chainKey: 'solana-devnet',
          destination: {
            vmFamily: 'solana',
            caip2ChainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
          },
        }),
      ).toBeUndefined();
      // Y el drift inverso (slug mainnet apuntando a testnet) también se reporta.
      expect(
        findChainEnvironmentDrift({
          chainKey: 'base-mainnet',
          destination: { vmFamily: 'evm', chainId: 84532 },
        }),
      ).toEqual({ declared: 'mainnet', actual: 'testnet' });
    });

    it('T-it2-CR5: classifyDestinationEnvironment despacha por familia (el sentinel sintético de Solana NUNCA se clasifica como chainId EVM)', () => {
      // 900001 es el sentinel de Solana (DT-8): como chainId EVM caería en
      // "desconocido → mainnet"; por CAIP-2 es devnet.
      expect(classifyEvmChainId(900_001)).toBe('mainnet');
      expect(
        classifyDestinationEnvironment({
          vmFamily: 'solana',
          caip2ChainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
        }),
      ).toBe('testnet');
      expect(
        classifyDestinationEnvironment({ vmFamily: 'evm', chainId: 43113 }),
      ).toBe('testnet');
    });
  });
});
