/**
 * Kite Ozone factory tests (WKH-MULTICHAIN / 086 W5).
 *
 * Verifies DT-I — `createKiteOzoneAdapters({ network: 'mainnet' })`
 *   * mutates `process.env.KITE_NETWORK = 'mainnet'` during the init,
 *   * picks up the mainnet `chainConfig` (chainId 2366, KiteAI Mainnet),
 *   * restores the previous `KITE_NETWORK` value (or `delete`s it) in `finally`,
 *   * never leaks env state across calls.
 *
 * CD-2 — when called without opts, the factory MUST NOT touch `KITE_NETWORK`
 * (byte-identical to pre-W5 behavior).
 *
 * Submodule imports (`payment.js`, `gasless.js`, `attestation.js`, `client.js`)
 * are mocked so the test exercises only the factory's env-handling and the
 * chainConfig that comes from `getKiteChain()` (real `chain.ts` module).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the client init (no real RPC).
vi.mock('../kite-ozone/client.js', () => ({
  initClient: vi.fn().mockResolvedValue(undefined),
}));

// Mock the payment/gasless/attestation submodule classes — minimal shape.
vi.mock('../kite-ozone/payment.js', () => ({
  KiteOzonePaymentAdapter: class {
    readonly name = 'kite-ozone';
  },
}));
vi.mock('../kite-ozone/gasless.js', () => ({
  KiteOzoneGaslessAdapter: class {
    readonly name = 'kite-ozone';
  },
}));
vi.mock('../kite-ozone/attestation.js', () => ({
  KiteOzoneAttestationAdapter: class {
    readonly name = 'kite-ozone';
  },
}));

import { createKiteOzoneAdapters } from '../kite-ozone/index.js';

describe('createKiteOzoneAdapters — DT-I env handling', () => {
  beforeEach(() => {
    delete process.env.KITE_NETWORK;
  });

  afterEach(() => {
    delete process.env.KITE_NETWORK;
  });

  describe('opts absent (legacy / CD-2 byte-identical path)', () => {
    it('returns testnet bundle when KITE_NETWORK is absent', async () => {
      const bundle = await createKiteOzoneAdapters();
      expect(bundle.chainConfig.chainId).toBe(2368);
      expect(bundle.chainConfig.name).toBe('KiteAI Testnet');
      expect(bundle.chainConfig.explorerUrl).toBe(
        'https://testnet.kitescan.ai',
      );
    });

    it('does NOT touch process.env.KITE_NETWORK when caller had a sentinel value', async () => {
      process.env.KITE_NETWORK = 'sentinel-untouched';
      await createKiteOzoneAdapters();
      expect(process.env.KITE_NETWORK).toBe('sentinel-untouched');
    });

    it('keeps process.env.KITE_NETWORK undefined when caller had no value', async () => {
      delete process.env.KITE_NETWORK;
      await createKiteOzoneAdapters();
      expect(process.env.KITE_NETWORK).toBeUndefined();
    });

    it('respects pre-existing KITE_NETWORK=mainnet (legacy single-chain mainnet)', async () => {
      // Pre-W5, the only way to activate Kite mainnet was setting the env var
      // before init. That path must keep working when opts is absent.
      process.env.KITE_NETWORK = 'mainnet';
      const bundle = await createKiteOzoneAdapters();
      expect(bundle.chainConfig.chainId).toBe(2366);
      expect(bundle.chainConfig.name).toBe('KiteAI Mainnet');
      // And the env var stays untouched.
      expect(process.env.KITE_NETWORK).toBe('mainnet');
    });
  });

  describe('opts.network = "mainnet"', () => {
    it('returns mainnet bundle (chainId 2366)', async () => {
      const bundle = await createKiteOzoneAdapters({ network: 'mainnet' });
      expect(bundle.chainConfig.chainId).toBe(2366);
      expect(bundle.chainConfig.name).toBe('KiteAI Mainnet');
      expect(bundle.chainConfig.explorerUrl).toBe('https://kitescan.ai');
    });

    it('restores process.env.KITE_NETWORK to undefined after init when caller had no prior value', async () => {
      delete process.env.KITE_NETWORK;
      await createKiteOzoneAdapters({ network: 'mainnet' });
      expect(process.env.KITE_NETWORK).toBeUndefined();
    });

    it('restores process.env.KITE_NETWORK to "testnet" when caller had it explicitly set', async () => {
      process.env.KITE_NETWORK = 'testnet';
      await createKiteOzoneAdapters({ network: 'mainnet' });
      expect(process.env.KITE_NETWORK).toBe('testnet');
    });

    it('restores process.env.KITE_NETWORK to a custom prior value (no clobber)', async () => {
      process.env.KITE_NETWORK = 'devnet';
      await createKiteOzoneAdapters({ network: 'mainnet' });
      expect(process.env.KITE_NETWORK).toBe('devnet');
    });

    it('two sequential mainnet calls do not leak env state', async () => {
      delete process.env.KITE_NETWORK;
      await createKiteOzoneAdapters({ network: 'mainnet' });
      expect(process.env.KITE_NETWORK).toBeUndefined();
      await createKiteOzoneAdapters({ network: 'mainnet' });
      expect(process.env.KITE_NETWORK).toBeUndefined();
    });
  });

  describe('opts.network = "testnet"', () => {
    it('returns testnet bundle (chainId 2368)', async () => {
      const bundle = await createKiteOzoneAdapters({ network: 'testnet' });
      expect(bundle.chainConfig.chainId).toBe(2368);
      expect(bundle.chainConfig.name).toBe('KiteAI Testnet');
    });

    it('restores process.env.KITE_NETWORK after explicit testnet activation', async () => {
      process.env.KITE_NETWORK = 'mainnet';
      await createKiteOzoneAdapters({ network: 'testnet' });
      expect(process.env.KITE_NETWORK).toBe('mainnet');
    });
  });
});
