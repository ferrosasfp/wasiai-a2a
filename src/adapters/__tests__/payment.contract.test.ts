/**
 * Contract tests for KiteOzonePaymentAdapter
 *
 * Verifies the adapter implements PaymentAdapter interface
 * with correct shape and behavior, using env-var-driven token config.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock viem for wallet client
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

// Mock fetch for Pieverse calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  _resetWalletClient,
  KiteOzonePaymentAdapter,
} from '../../adapters/kite-ozone/payment.js';
import type { PaymentAdapter } from '../../adapters/types.js';

const KXUSD_DEFAULT = '0x1b7425d288ea676FCBc65c29711fccF0B6D5c293';

describe('KiteOzonePaymentAdapter', () => {
  let adapter: PaymentAdapter;

  beforeEach(() => {
    adapter = new KiteOzonePaymentAdapter();
    _resetWalletClient();
    vi.clearAllMocks();
    process.env.OPERATOR_PRIVATE_KEY =
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    // Set token env var to suppress console.warn in tests
    process.env.X402_PAYMENT_TOKEN = KXUSD_DEFAULT;
  });

  afterEach(() => {
    delete process.env.X402_PAYMENT_TOKEN;
    delete process.env.X402_EIP712_DOMAIN_NAME;
    delete process.env.X402_EIP712_DOMAIN_VERSION;
    delete process.env.X402_TOKEN_SYMBOL;
  });

  it('implements PaymentAdapter with name "kite-ozone"', () => {
    expect(adapter.name).toBe('kite-ozone');
  });

  it('has chainId 2368', () => {
    expect(adapter.chainId).toBe(2368);
  });

  it('has supportedTokens with KXUSD by default', () => {
    expect(adapter.supportedTokens).toHaveLength(1);
    expect(adapter.supportedTokens[0].symbol).toBe('KXUSD');
    expect(adapter.supportedTokens[0].address).toBe(KXUSD_DEFAULT);
  });

  it('reads token address from X402_PAYMENT_TOKEN env var', () => {
    const customToken = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    process.env.X402_PAYMENT_TOKEN = customToken;
    expect(adapter.getToken()).toBe(customToken);
    expect(adapter.supportedTokens[0].address).toBe(customToken);
  });

  it('defaults to KXUSD when X402_PAYMENT_TOKEN is not set (warns once)', () => {
    delete process.env.X402_PAYMENT_TOKEN;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(adapter.getToken()).toBe(KXUSD_DEFAULT);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('X402_PAYMENT_TOKEN not set'),
    );
    // Second call should NOT warn again
    adapter.getToken();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('falls back to default when X402_PAYMENT_TOKEN has invalid format', () => {
    process.env.X402_PAYMENT_TOKEN = 'not-an-address';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(adapter.getToken()).toBe(KXUSD_DEFAULT);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid format'),
    );
    warnSpy.mockRestore();
  });

  it('reads token symbol from X402_TOKEN_SYMBOL env var', () => {
    process.env.X402_TOKEN_SYMBOL = 'CUSTOM';
    expect(adapter.supportedTokens[0].symbol).toBe('CUSTOM');
  });

  it('defaults token symbol to KXUSD', () => {
    delete process.env.X402_TOKEN_SYMBOL;
    expect(adapter.supportedTokens[0].symbol).toBe('KXUSD');
  });

  it('settle() returns SettleResult shape', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ txHash: '0xABC', success: true }),
    });

    const result = await adapter.settle({
      authorization: {
        from: '0x1',
        to: '0x2',
        value: '1',
        validAfter: '0',
        validBefore: '99',
        nonce: '0x3',
      },
      signature: '0xSIG',
      network: 'kite-testnet',
    });

    expect(result).toHaveProperty('txHash');
    expect(result).toHaveProperty('success');
    expect(result.txHash).toBe('0xABC');
    expect(result.success).toBe(true);
  });

  it('verify() returns VerifyResult shape', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ valid: true }),
    });

    const result = await adapter.verify({
      authorization: {
        from: '0x1',
        to: '0x2',
        value: '1',
        validAfter: '0',
        validBefore: '99',
        nonce: '0x3',
      },
      signature: '0xSIG',
      network: 'kite-testnet',
    });

    expect(result).toHaveProperty('valid');
    expect(result.valid).toBe(true);
  });

  it('quote() returns QuoteResult with KXUSD token', async () => {
    const result = await adapter.quote(1.0);

    expect(result).toHaveProperty('amountWei');
    expect(result).toHaveProperty('token');
    expect(result).toHaveProperty('facilitatorUrl');
    expect(result.token.symbol).toBe('KXUSD');
    expect(result.token.address).toBe(KXUSD_DEFAULT);
  });

  it('sign() returns SignResult shape', async () => {
    const result = await adapter.sign({
      to: '0x000000000000000000000000000000000000dEaD' as `0x${string}`,
      value: '1000000000000000000',
    });

    expect(result).toHaveProperty('xPaymentHeader');
    expect(result).toHaveProperty('paymentRequest');
    expect(typeof result.xPaymentHeader).toBe('string');
    expect(result.paymentRequest).toHaveProperty('authorization');
    expect(result.paymentRequest).toHaveProperty('signature');
  });

  it('sign() uses custom EIP-712 domain from env vars (AC-3)', async () => {
    process.env.X402_EIP712_DOMAIN_NAME = 'CustomDomain';
    process.env.X402_EIP712_DOMAIN_VERSION = '2';

    // Reset wallet client so next sign() call creates a fresh mock
    _resetWalletClient();

    const { createWalletClient } = await import('viem');
    const mockCreateWallet = createWalletClient as ReturnType<typeof vi.fn>;

    await adapter.sign({
      to: '0x000000000000000000000000000000000000dEaD' as `0x${string}`,
      value: '1000000000000000000',
    });

    // createWalletClient was called; get the returned mock client
    const lastCallIndex = mockCreateWallet.mock.results.length - 1;
    const walletClientMock = mockCreateWallet.mock.results[lastCallIndex].value;
    const signTypedDataMock = walletClientMock.signTypedData as ReturnType<
      typeof vi.fn
    >;

    expect(signTypedDataMock).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: expect.objectContaining({
          name: 'CustomDomain',
          version: '2',
        }),
      }),
    );
  });

  it('does not throw when env vars are absent (AC-6)', () => {
    delete process.env.X402_PAYMENT_TOKEN;
    delete process.env.X402_EIP712_DOMAIN_NAME;
    delete process.env.X402_EIP712_DOMAIN_VERSION;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => adapter.getToken()).not.toThrow();
    expect(() => adapter.supportedTokens).not.toThrow();
    warnSpy.mockRestore();
  });
});
