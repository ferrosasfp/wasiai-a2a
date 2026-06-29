/**
 * Mainnet support tests for KiteOzonePaymentAdapter (068).
 *
 * Verifica que `KITE_NETWORK=mainnet` cambia chainId, network tag, USDC.e
 * defaults, EIP-712 domain (USDC en lugar de PYUSD), y que el default
 * `testnet` (sin env-var) preserva el comportamiento histórico.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Structured logger mock ─────────────────────────────────
// kite-ozone/payment.ts logs the token env fallback via getLogger('kite-ozone').
// Mock it so tests assert log emission (object-first / message-second) instead
// of spying on console. hoisted so the factory can reference it.
const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../../lib/logger.js', () => ({
  getLogger: () => logSpy,
}));

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createWalletClient: vi.fn(() => ({
      account: { address: '0x1234567890123456789012345678901234567890' },
      signTypedData: vi.fn().mockResolvedValue(`0x${'ab'.repeat(65)}`),
    })),
  };
});

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  _resetWalletClient,
  KiteOzonePaymentAdapter,
} from '../../adapters/kite-ozone/payment.js';

const PYUSD_TESTNET = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9';
const USDC_E_MAINNET = '0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e';

describe('KiteOzonePaymentAdapter — KITE_NETWORK selection', () => {
  let adapter: KiteOzonePaymentAdapter;

  beforeEach(() => {
    adapter = new KiteOzonePaymentAdapter();
    _resetWalletClient();
    vi.clearAllMocks();
    process.env.OPERATOR_PRIVATE_KEY =
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    delete process.env.KITE_NETWORK;
    delete process.env.X402_PAYMENT_TOKEN;
    delete process.env.X402_EIP712_DOMAIN_NAME;
    delete process.env.X402_TOKEN_SYMBOL;
  });

  afterEach(() => {
    delete process.env.KITE_NETWORK;
    delete process.env.X402_PAYMENT_TOKEN;
    delete process.env.X402_EIP712_DOMAIN_NAME;
    delete process.env.X402_TOKEN_SYMBOL;
  });

  describe('default (KITE_NETWORK absent)', () => {
    it('chainId=2368 (testnet)', () => {
      expect(adapter.chainId).toBe(2368);
    });

    it('network tag = eip155:2368', () => {
      expect(adapter.getNetwork()).toBe('eip155:2368');
    });

    it('default token = PYUSD testnet', () => {
      const warnSpy = logSpy.warn;
      warnSpy.mockClear();
      expect(adapter.getToken()).toBe(PYUSD_TESTNET);
    });

    it('default symbol = PYUSD', () => {
      const warnSpy = logSpy.warn;
      warnSpy.mockClear();
      expect(adapter.supportedTokens[0]!.symbol).toBe('PYUSD');
    });
  });

  describe('KITE_NETWORK=testnet (explicit)', () => {
    beforeEach(() => {
      process.env.KITE_NETWORK = 'testnet';
    });

    it('chainId=2368', () => {
      expect(adapter.chainId).toBe(2368);
    });

    it('default token = PYUSD testnet', () => {
      const warnSpy = logSpy.warn;
      warnSpy.mockClear();
      expect(adapter.getToken()).toBe(PYUSD_TESTNET);
    });
  });

  describe('KITE_NETWORK=mainnet', () => {
    beforeEach(() => {
      process.env.KITE_NETWORK = 'mainnet';
      _resetWalletClient(); // re-initialize wallet client with new chain
    });

    it('chainId=2366', () => {
      expect(adapter.chainId).toBe(2366);
    });

    it('network tag = eip155:2366', () => {
      expect(adapter.getNetwork()).toBe('eip155:2366');
    });

    it('default token = USDC.e mainnet', () => {
      const warnSpy = logSpy.warn;
      warnSpy.mockClear();
      expect(adapter.getToken()).toBe(USDC_E_MAINNET);
    });

    it('default symbol = USDC.e', () => {
      const warnSpy = logSpy.warn;
      warnSpy.mockClear();
      expect(adapter.supportedTokens[0]!.symbol).toBe('USDC.e');
    });

    it('warn message refers to USDC.e fallback when env-var absent', () => {
      const warnSpy = logSpy.warn;
      warnSpy.mockClear();
      adapter.getToken();
      // object-first / message-second: the default symbol (USDC.e) lives in the
      // structured context now, not interpolated into the message string.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ symbol: 'USDC.e' }),
        expect.stringContaining('X402_PAYMENT_TOKEN not set'),
      );
    });

    it('respects X402_PAYMENT_TOKEN override on mainnet', () => {
      const customMainnet = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
      process.env.X402_PAYMENT_TOKEN = customMainnet;
      expect(adapter.getToken()).toBe(customMainnet);
    });

    it('sign() in x402 mode uses chainId=2366 and USDC domain by default', async () => {
      process.env.KITE_FACILITATOR_MODE = 'x402';
      const { createWalletClient } = await import('viem');
      const mockCreateWallet = createWalletClient as ReturnType<typeof vi.fn>;

      _resetWalletClient();
      await adapter.sign({
        to: '0x000000000000000000000000000000000000dEaD' as `0x${string}`,
        value: '1000000',
      });

      const lastCallIndex = mockCreateWallet.mock.results.length - 1;
      const walletClientMock =
        mockCreateWallet.mock.results[lastCallIndex]!.value;
      const signTypedDataMock = walletClientMock.signTypedData as ReturnType<
        typeof vi.fn
      >;

      expect(signTypedDataMock).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: expect.objectContaining({
            name: 'USDC',
            chainId: 2366,
          }),
          primaryType: 'TransferWithAuthorization',
        }),
      );
      delete process.env.KITE_FACILITATOR_MODE;
    });
  });

  describe('KITE_NETWORK invalid value (fail-safe → testnet)', () => {
    it('falls back to testnet on unknown value', () => {
      process.env.KITE_NETWORK = 'devnet';
      expect(adapter.chainId).toBe(2368);
      expect(adapter.getNetwork()).toBe('eip155:2368');
    });
  });
});
