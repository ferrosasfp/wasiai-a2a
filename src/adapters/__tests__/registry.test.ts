/**
 * Registry tests — adapter resolution (multi-chain).
 *
 * Covers:
 *   - WASIAI_A2A_CHAIN (legacy single) — backward-compat path (CD-2)
 *   - WASIAI_A2A_CHAINS (CSV) — multi-chain init
 *   - Unsupported chain → throws with full SUPPORTED list
 *   - CD-13 conflict warning when both env vars are set
 *   - New getters: getAdaptersBundle, getInitializedChainKeys, getDefaultChainKey
 *
 * Wave 0 only wires `kite-ozone-testnet`. Avalanche / mainnet branches are
 * exercised in Wave 1 / Wave 5 tests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the kite-ozone factory to avoid real client init.
// Shape matches the new AdaptersBundle interface.
vi.mock('../kite-ozone/index.js', () => ({
  createKiteOzoneAdapters: vi.fn().mockResolvedValue({
    payment: { name: 'kite-ozone', chainId: 2368 },
    attestation: { name: 'kite-ozone', chainId: 2368 },
    gasless: { name: 'kite-ozone', chainId: 2368 },
    identity: null,
    chainConfig: {
      name: 'KiteAI Testnet',
      chainId: 2368,
      explorerUrl: 'https://testnet.kitescan.ai',
    },
  }),
}));

// Mock the avalanche factory — returns a fuji or mainnet bundle stub depending
// on `opts.network`. Real adapters covered by avalanche.test.ts.
vi.mock('../avalanche/index.js', () => ({
  createAvalancheAdapters: vi.fn(
    async (opts?: { network?: 'fuji' | 'mainnet' }) => {
      const network = opts?.network ?? 'fuji';
      const chainId = network === 'mainnet' ? 43114 : 43113;
      const name = network === 'mainnet' ? 'Avalanche' : 'Avalanche Fuji';
      const explorerUrl =
        network === 'mainnet'
          ? 'https://snowtrace.io'
          : 'https://testnet.snowtrace.io';
      return {
        payment: { name: 'avalanche', chainId },
        attestation: { name: 'avalanche', chainId },
        gasless: { name: 'avalanche', chainId },
        identity: null,
        chainConfig: { name, chainId, explorerUrl },
      };
    },
  ),
}));

import {
  _resetRegistry,
  getAdaptersBundle,
  getAttestationAdapter,
  getChainConfig,
  getDefaultChainKey,
  getGaslessAdapter,
  getIdentityBindingAdapter,
  getInitializedChainKeys,
  getPaymentAdapter,
  initAdapters,
} from '../registry.js';

describe('adapter registry', () => {
  beforeEach(() => {
    _resetRegistry();
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.WASIAI_A2A_CHAIN;
    delete process.env.WASIAI_A2A_CHAINS;
  });

  it('default WASIAI_A2A_CHAIN resolves to kite-ozone adapters', async () => {
    await initAdapters();

    const adapter = getPaymentAdapter();
    expect(adapter.name).toBe('kite-ozone');
    expect(adapter.chainId).toBe(2368);
  });

  it('unsupported chain throws error listing supported chains', async () => {
    process.env.WASIAI_A2A_CHAIN = 'ethereum-mainnet';

    await expect(initAdapters()).rejects.toThrow(
      "Unsupported chain 'ethereum-mainnet'. Supported: kite-ozone-testnet, kite-mainnet, avalanche-fuji, avalanche-mainnet",
    );
  });

  it('getChainConfig() returns { name, chainId, explorerUrl }', async () => {
    await initAdapters();

    const config = getChainConfig();
    expect(config).toHaveProperty('name');
    expect(config).toHaveProperty('chainId');
    expect(config).toHaveProperty('explorerUrl');
    expect(config.chainId).toBe(2368);
    expect(config.name).toBe('KiteAI Testnet');
  });

  it('get*Adapter() throws if initAdapters() not called', () => {
    expect(() => getPaymentAdapter()).toThrow('Adapters not initialized');
    expect(() => getAttestationAdapter()).toThrow('Adapters not initialized');
    expect(() => getGaslessAdapter()).toThrow('Adapters not initialized');
    expect(() => getChainConfig()).toThrow('Adapters not initialized');
  });

  it('getIdentityBindingAdapter() throws not implemented for kite-ozone', async () => {
    await initAdapters();

    expect(() => getIdentityBindingAdapter()).toThrow(
      'IdentityBindingAdapter not implemented for kite-ozone-testnet',
    );
  });

  // ─── AC-2: legacy WASIAI_A2A_CHAIN (single) preserves byte-identical behaviour ───
  describe('AC-2 — legacy single-chain backward compatibility', () => {
    it('only WASIAI_A2A_CHAIN=kite-ozone-testnet initializes a single bundle as default', async () => {
      process.env.WASIAI_A2A_CHAIN = 'kite-ozone-testnet';
      await initAdapters();

      expect(getInitializedChainKeys()).toEqual(['kite-ozone-testnet']);
      expect(getDefaultChainKey()).toBe('kite-ozone-testnet');

      const config = getChainConfig();
      expect(config).toEqual({
        name: 'KiteAI Testnet',
        chainId: 2368,
        explorerUrl: 'https://testnet.kitescan.ai',
      });
    });

    it('logs the canonical init message including the chain slug', async () => {
      const logSpy = vi
        .spyOn(console, 'log')
        .mockImplementation(() => {});
      process.env.WASIAI_A2A_CHAIN = 'kite-ozone-testnet';
      await initAdapters();

      expect(logSpy).toHaveBeenCalledWith(
        '[Registry] Adapters initialized: kite-ozone-testnet',
      );
    });
  });

  // ─── AC-1: CSV multi-chain init ───
  describe('AC-1 — multi-chain CSV init', () => {
    it('WASIAI_A2A_CHAINS with a single slug initializes one bundle', async () => {
      process.env.WASIAI_A2A_CHAINS = 'kite-ozone-testnet';
      await initAdapters();

      expect(getInitializedChainKeys()).toEqual(['kite-ozone-testnet']);
      expect(getDefaultChainKey()).toBe('kite-ozone-testnet');
    });

    it('trims and lowercases CSV entries', async () => {
      process.env.WASIAI_A2A_CHAINS = '  KITE-OZONE-TESTNET  ';
      await initAdapters();

      expect(getInitializedChainKeys()).toEqual(['kite-ozone-testnet']);
    });

    it('default chain is the first CSV entry', async () => {
      process.env.WASIAI_A2A_CHAINS = 'kite-ozone-testnet';
      await initAdapters();

      expect(getDefaultChainKey()).toBe('kite-ozone-testnet');
    });

    it('logs the canonical multi-chain init message', async () => {
      const logSpy = vi
        .spyOn(console, 'log')
        .mockImplementation(() => {});
      process.env.WASIAI_A2A_CHAINS = 'kite-ozone-testnet';
      await initAdapters();

      expect(logSpy).toHaveBeenCalledWith(
        '[Registry] Adapters initialized: kite-ozone-testnet',
      );
    });
  });

  // ─── AC-3: unsupported chain in CSV ───
  it('AC-3 — WASIAI_A2A_CHAINS with unsupported slug throws with full list', async () => {
    process.env.WASIAI_A2A_CHAINS = 'ethereum-mainnet';

    await expect(initAdapters()).rejects.toThrow(
      "Unsupported chain 'ethereum-mainnet'. Supported: kite-ozone-testnet, kite-mainnet, avalanche-fuji, avalanche-mainnet",
    );
  });

  // ─── CD-13: conflict warning when both env vars are set ───
  it('CD-13 — when both env vars are set, logs WARNING and uses WASIAI_A2A_CHAINS', async () => {
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {});
    process.env.WASIAI_A2A_CHAINS = 'kite-ozone-testnet';
    process.env.WASIAI_A2A_CHAIN = 'kite-ozone-testnet';

    await initAdapters();

    expect(warnSpy).toHaveBeenCalledWith(
      '[Registry] WARNING: both WASIAI_A2A_CHAINS and WASIAI_A2A_CHAIN are set. Using WASIAI_A2A_CHAINS=kite-ozone-testnet (singular ignored)',
    );
    expect(getDefaultChainKey()).toBe('kite-ozone-testnet');
  });

  // ─── New getters introduced in W0 ───
  describe('new W0 getters', () => {
    it('getAdaptersBundle(default) returns the default bundle', async () => {
      await initAdapters();
      const bundle = getAdaptersBundle();
      expect(bundle).toBeDefined();
      expect(bundle?.chainConfig.chainId).toBe(2368);
    });

    it('getAdaptersBundle(slug) returns the matching bundle', async () => {
      await initAdapters();
      const bundle = getAdaptersBundle('kite-ozone-testnet');
      expect(bundle).toBeDefined();
      expect(bundle?.chainConfig.chainId).toBe(2368);
    });

    it('getAdaptersBundle(unknown) returns undefined (no throw)', async () => {
      await initAdapters();
      const bundle = getAdaptersBundle('avalanche-fuji');
      expect(bundle).toBeUndefined();
    });

    it('getAdaptersBundle() returns undefined before init', () => {
      const bundle = getAdaptersBundle();
      expect(bundle).toBeUndefined();
    });

    it('getInitializedChainKeys() returns slugs in CSV order', async () => {
      process.env.WASIAI_A2A_CHAINS = 'kite-ozone-testnet';
      await initAdapters();
      expect(getInitializedChainKeys()).toEqual(['kite-ozone-testnet']);
    });

    it('getDefaultChainKey() returns null before init', () => {
      expect(getDefaultChainKey()).toBeNull();
    });
  });

  // ─── W1: avalanche-fuji factory wiring ───
  describe('W1 — avalanche-fuji factory dispatch', () => {
    it('WASIAI_A2A_CHAINS=avalanche-fuji → initialized with chainId 43113', async () => {
      process.env.WASIAI_A2A_CHAINS = 'avalanche-fuji';
      await initAdapters();

      expect(getInitializedChainKeys()).toEqual(['avalanche-fuji']);
      expect(getDefaultChainKey()).toBe('avalanche-fuji');

      const config = getChainConfig();
      expect(config).toEqual({
        name: 'Avalanche Fuji',
        chainId: 43113,
        explorerUrl: 'https://testnet.snowtrace.io',
      });
    });

    it('CSV kite-ozone-testnet,avalanche-fuji → both bundles present, default = first', async () => {
      process.env.WASIAI_A2A_CHAINS = 'kite-ozone-testnet,avalanche-fuji';
      await initAdapters();

      expect(getInitializedChainKeys()).toEqual([
        'kite-ozone-testnet',
        'avalanche-fuji',
      ]);
      expect(getDefaultChainKey()).toBe('kite-ozone-testnet');

      const kite = getAdaptersBundle('kite-ozone-testnet');
      expect(kite?.chainConfig.chainId).toBe(2368);

      const fuji = getAdaptersBundle('avalanche-fuji');
      expect(fuji?.chainConfig.chainId).toBe(43113);
      expect(fuji?.chainConfig.name).toBe('Avalanche Fuji');
    });

    it('logs the canonical multi-chain init message with both slugs', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      process.env.WASIAI_A2A_CHAINS = 'kite-ozone-testnet,avalanche-fuji';
      await initAdapters();

      expect(logSpy).toHaveBeenCalledWith(
        '[Registry] Adapters initialized: kite-ozone-testnet, avalanche-fuji',
      );
    });

    it('getPaymentAdapter("avalanche-fuji") returns the avalanche payment adapter', async () => {
      process.env.WASIAI_A2A_CHAINS = 'kite-ozone-testnet,avalanche-fuji';
      await initAdapters();

      const adapter = getPaymentAdapter('avalanche-fuji');
      expect(adapter.name).toBe('avalanche');
      expect(adapter.chainId).toBe(43113);
    });
  });
});
