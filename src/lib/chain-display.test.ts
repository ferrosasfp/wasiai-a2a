/**
 * chain-display — presentación de redes (WKH-191x).
 *
 * Registry mockeado con DOS bundles reales-por-forma: uno EVM (Avalanche Fuji) y
 * uno Solana devnet con su `caip2ChainId` + el sentinel sintético en
 * `chainConfig.chainId` (DT-8). Cubre el cruce de redes (AC-5) y el armado de
 * URLs de explorer, incluido el caso Solana con query string (H-6).
 */

import { describe, expect, it, vi } from 'vitest';

const SOLANA_CAIP2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

const BUNDLES = vi.hoisted(() => ({
  'avalanche-fuji': {
    chainConfig: {
      name: 'Avalanche Fuji',
      chainId: 43113,
      explorerUrl: 'https://testnet.snowtrace.io',
    },
    payment: { vmFamily: 'evm', chainId: 43113 },
  },
  'solana-devnet': {
    chainConfig: {
      name: 'Solana Devnet',
      chainId: 900001,
      explorerUrl: 'https://explorer.solana.com?cluster=devnet',
    },
    payment: {
      vmFamily: 'solana',
      caip2ChainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    },
  },
}));

vi.mock('../adapters/registry.js', () => ({
  getInitializedChainKeys: () => Object.keys(BUNDLES),
  getAdaptersBundle: (key: string) =>
    (BUNDLES as Record<string, unknown>)[key] ?? undefined,
}));

import {
  buildExplorerTxUrl,
  describeCaip2,
  describeChainId,
  isCrossChainSettle,
} from './chain-display.js';

describe('describeChainId', () => {
  it('resuelve un chainId EVM contra el registry (nombre + explorer, no hardcode)', () => {
    expect(describeChainId(43113)).toEqual({
      key: 'avalanche-fuji',
      label: 'Avalanche Fuji',
      explorerUrl: 'https://testnet.snowtrace.io',
    });
  });

  it('resuelve el sentinel sintético de Solana (misma columna chain_id)', () => {
    expect(describeChainId(900001).key).toBe('solana-devnet');
    expect(describeChainId(900001).label).toBe('Solana Devnet');
  });

  it('chainId no registrado → sin key, label honesto, sin explorer', () => {
    expect(describeChainId(31337)).toEqual({
      key: null,
      label: 'chain 31337',
      explorerUrl: null,
    });
  });

  it('null / NaN → label "red no registrada" (nunca lanza)', () => {
    expect(describeChainId(null).key).toBeNull();
    expect(describeChainId(Number.NaN).label).toBe('red no registrada');
  });
});

describe('describeCaip2', () => {
  it('resuelve el CAIP-2 contra el caip2ChainId del adapter no-EVM', () => {
    expect(describeCaip2(SOLANA_CAIP2)).toEqual({
      key: 'solana-devnet',
      label: 'Solana Devnet',
      explorerUrl: 'https://explorer.solana.com?cluster=devnet',
    });
  });

  it('CAIP-2 desconocido → muestra el identificador crudo, sin link', () => {
    expect(describeCaip2('solana:otro')).toEqual({
      key: null,
      label: 'solana:otro',
      explorerUrl: null,
    });
  });

  it('null → no resuelto', () => {
    expect(describeCaip2(null).key).toBeNull();
  });
});

describe('buildExplorerTxUrl', () => {
  it('EVM: agrega /tx/<hash> al final', () => {
    expect(buildExplorerTxUrl('https://testnet.snowtrace.io', '0xabc')).toBe(
      'https://testnet.snowtrace.io/tx/0xabc',
    );
  });

  it('H-6 Solana: inserta /tx/<sig> ANTES del query string (?cluster=devnet)', () => {
    expect(
      buildExplorerTxUrl(
        'https://explorer.solana.com?cluster=devnet',
        '5Nbi6LDKw3iUdv',
      ),
    ).toBe('https://explorer.solana.com/tx/5Nbi6LDKw3iUdv?cluster=devnet');
  });

  it('tolera una base con slash final (no duplica /)', () => {
    expect(buildExplorerTxUrl('https://testnet.snowtrace.io/', '0xabc')).toBe(
      'https://testnet.snowtrace.io/tx/0xabc',
    );
  });

  it('sin explorer, sin hash o base inválida → null (link roto nunca)', () => {
    expect(buildExplorerTxUrl(null, '0xabc')).toBeNull();
    expect(buildExplorerTxUrl('https://testnet.snowtrace.io', null)).toBeNull();
    expect(buildExplorerTxUrl('no-es-una-url', '0xabc')).toBeNull();
  });
});

describe('isCrossChainSettle (AC-5)', () => {
  it('pagó en Fuji y cobró en Solana → CRUCE', () => {
    expect(isCrossChainSettle(43113, SOLANA_CAIP2)).toBe(true);
  });

  it('pagó en Solana y cobró en Solana → NO es cruce', () => {
    expect(isCrossChainSettle(900001, SOLANA_CAIP2)).toBe(false);
  });

  it('sin settle_caip2 → NO es cruce (no hay segundo rail declarado)', () => {
    expect(isCrossChainSettle(43113, null)).toBe(false);
  });

  it('dos identificadores desconocidos pero idénticos no inventan un cruce', () => {
    expect(isCrossChainSettle(31337, 'chain 31337')).toBe(false);
  });
});
