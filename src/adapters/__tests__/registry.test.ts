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
// W5: accepts `opts?: { network?: 'testnet' | 'mainnet' }` to mirror the real
// factory signature. When `network === 'mainnet'`, returns the Kite mainnet
// bundle (chainId 2366) so the registry dispatch test can verify wiring.
vi.mock('../kite-ozone/index.js', () => ({
  createKiteOzoneAdapters: vi.fn(
    async (opts?: { network?: 'testnet' | 'mainnet' }) => {
      const network = opts?.network ?? 'testnet';
      const chainId = network === 'mainnet' ? 2366 : 2368;
      const name = network === 'mainnet' ? 'KiteAI Mainnet' : 'KiteAI Testnet';
      const explorerUrl =
        network === 'mainnet'
          ? 'https://kitescan.ai'
          : 'https://testnet.kitescan.ai';
      return {
        payment: { name: 'kite-ozone', chainId },
        attestation: { name: 'kite-ozone', chainId },
        gasless: { name: 'kite-ozone', chainId },
        identity: null,
        chainConfig: { name, chainId, explorerUrl },
      };
    },
  ),
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

// Mock the base factory — returns a testnet or mainnet bundle stub depending
// on `opts.network`. Real adapters covered by base.test.ts.
vi.mock('../base/index.js', () => ({
  createBaseAdapters: vi.fn(
    async (opts?: { network?: 'testnet' | 'mainnet' }) => {
      const network = opts?.network ?? 'testnet';
      const chainId = network === 'mainnet' ? 8453 : 84532;
      const name = network === 'mainnet' ? 'Base' : 'Base Sepolia';
      const explorerUrl =
        network === 'mainnet'
          ? 'https://basescan.org'
          : 'https://sepolia.basescan.org';
      return {
        payment: { name: 'base', chainId },
        attestation: { name: 'base', chainId },
        gasless: { name: 'base', chainId },
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
      "Unsupported chain 'ethereum-mainnet'. Supported: kite-ozone-testnet, kite-mainnet, avalanche-fuji, avalanche-mainnet, base-sepolia, base-mainnet",
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
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
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
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
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
      "Unsupported chain 'ethereum-mainnet'. Supported: kite-ozone-testnet, kite-mainnet, avalanche-fuji, avalanche-mainnet, base-sepolia, base-mainnet",
    );
  });

  // ─── CD-13: conflict warning when both env vars are set ───
  it('CD-13 — when both env vars are set, logs WARNING and uses WASIAI_A2A_CHAINS', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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

  // ─── W5: mainnet wiring (kite-mainnet + avalanche-mainnet) ───
  describe('W5 — mainnet wiring (kite-mainnet + avalanche-mainnet)', () => {
    it('WASIAI_A2A_CHAINS=kite-mainnet → initialized with chainId 2366', async () => {
      process.env.WASIAI_A2A_CHAINS = 'kite-mainnet';
      await initAdapters();

      expect(getInitializedChainKeys()).toEqual(['kite-mainnet']);
      expect(getDefaultChainKey()).toBe('kite-mainnet');

      const config = getChainConfig();
      expect(config).toEqual({
        name: 'KiteAI Mainnet',
        chainId: 2366,
        explorerUrl: 'https://kitescan.ai',
      });
    });

    it('CSV kite-mainnet,avalanche-mainnet → both bundles present, default = kite-mainnet', async () => {
      process.env.WASIAI_A2A_CHAINS = 'kite-mainnet,avalanche-mainnet';
      await initAdapters();

      expect(getInitializedChainKeys()).toEqual([
        'kite-mainnet',
        'avalanche-mainnet',
      ]);
      expect(getDefaultChainKey()).toBe('kite-mainnet');

      const kite = getAdaptersBundle('kite-mainnet');
      expect(kite?.chainConfig.chainId).toBe(2366);
      expect(kite?.chainConfig.name).toBe('KiteAI Mainnet');

      const avax = getAdaptersBundle('avalanche-mainnet');
      expect(avax?.chainConfig.chainId).toBe(43114);
      expect(avax?.chainConfig.name).toBe('Avalanche');
    });

    it('logs the canonical multi-chain init message with mainnet slugs', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      process.env.WASIAI_A2A_CHAINS = 'kite-mainnet,avalanche-mainnet';
      await initAdapters();

      expect(logSpy).toHaveBeenCalledWith(
        '[Registry] Adapters initialized: kite-mainnet, avalanche-mainnet',
      );
    });

    it('getPaymentAdapter("kite-mainnet") returns chainId 2366', async () => {
      process.env.WASIAI_A2A_CHAINS = 'kite-mainnet';
      await initAdapters();

      const adapter = getPaymentAdapter('kite-mainnet');
      expect(adapter.name).toBe('kite-ozone');
      expect(adapter.chainId).toBe(2366);
    });

    it('registry passes opts.network=mainnet to createKiteOzoneAdapters factory', async () => {
      const factoryModule = await import('../kite-ozone/index.js');
      const factorySpy = factoryModule.createKiteOzoneAdapters as ReturnType<
        typeof vi.fn
      >;
      factorySpy.mockClear();

      process.env.WASIAI_A2A_CHAINS = 'kite-mainnet';
      await initAdapters();

      expect(factorySpy).toHaveBeenCalledTimes(1);
      expect(factorySpy).toHaveBeenCalledWith({ network: 'mainnet' });
    });

    it('registry calls createKiteOzoneAdapters without opts for legacy testnet (CD-2)', async () => {
      const factoryModule = await import('../kite-ozone/index.js');
      const factorySpy = factoryModule.createKiteOzoneAdapters as ReturnType<
        typeof vi.fn
      >;
      factorySpy.mockClear();

      process.env.WASIAI_A2A_CHAINS = 'kite-ozone-testnet';
      await initAdapters();

      expect(factorySpy).toHaveBeenCalledTimes(1);
      // The legacy testnet path MUST invoke the factory with no arguments,
      // preserving the pre-W5 byte-identical contract.
      expect(factorySpy).toHaveBeenCalledWith();
    });
  });

  // ─── WKH-104 / BASE-01: base-sepolia + base-mainnet factory dispatch ───
  describe('WKH-104 — Base factory dispatch', () => {
    it('AC-1 — WASIAI_A2A_CHAINS=base-sepolia → initialized with chainId 84532', async () => {
      process.env.WASIAI_A2A_CHAINS = 'base-sepolia';
      await initAdapters();

      expect(getInitializedChainKeys()).toEqual(['base-sepolia']);
      expect(getDefaultChainKey()).toBe('base-sepolia');

      const config = getChainConfig();
      expect(config).toEqual({
        name: 'Base Sepolia',
        chainId: 84532,
        explorerUrl: 'https://sepolia.basescan.org',
      });
    });

    it('AC-2 — WASIAI_A2A_CHAINS=base-mainnet → initialized with chainId 8453', async () => {
      process.env.WASIAI_A2A_CHAINS = 'base-mainnet';
      await initAdapters();

      expect(getInitializedChainKeys()).toEqual(['base-mainnet']);
      expect(getDefaultChainKey()).toBe('base-mainnet');

      const config = getChainConfig();
      expect(config).toEqual({
        name: 'Base',
        chainId: 8453,
        explorerUrl: 'https://basescan.org',
      });
    });

    it('registry passes opts.network=testnet to createBaseAdapters for base-sepolia', async () => {
      const factoryModule = await import('../base/index.js');
      const factorySpy = factoryModule.createBaseAdapters as ReturnType<
        typeof vi.fn
      >;
      factorySpy.mockClear();

      process.env.WASIAI_A2A_CHAINS = 'base-sepolia';
      await initAdapters();

      expect(factorySpy).toHaveBeenCalledTimes(1);
      expect(factorySpy).toHaveBeenCalledWith({ network: 'testnet' });
    });

    it('registry passes opts.network=mainnet to createBaseAdapters for base-mainnet', async () => {
      const factoryModule = await import('../base/index.js');
      const factorySpy = factoryModule.createBaseAdapters as ReturnType<
        typeof vi.fn
      >;
      factorySpy.mockClear();

      process.env.WASIAI_A2A_CHAINS = 'base-mainnet';
      await initAdapters();

      expect(factorySpy).toHaveBeenCalledTimes(1);
      expect(factorySpy).toHaveBeenCalledWith({ network: 'mainnet' });
    });

    it('CSV multi-chain con base-sepolia coexiste con kite + avalanche', async () => {
      process.env.WASIAI_A2A_CHAINS =
        'kite-ozone-testnet,avalanche-fuji,base-sepolia';
      await initAdapters();

      expect(getInitializedChainKeys()).toEqual([
        'kite-ozone-testnet',
        'avalanche-fuji',
        'base-sepolia',
      ]);
      expect(getDefaultChainKey()).toBe('kite-ozone-testnet');

      const base = getAdaptersBundle('base-sepolia');
      expect(base?.chainConfig.chainId).toBe(84532);
    });

    it('AC-6 — unsupported slug "base-typo" throws with Base in supported list', async () => {
      process.env.WASIAI_A2A_CHAINS = 'base-typo';
      await expect(initAdapters()).rejects.toThrow(
        /Supported:.*base-sepolia, base-mainnet/,
      );
    });
  });
});
