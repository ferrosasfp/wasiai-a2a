/**
 * Contract tests for KiteOzonePaymentAdapter
 *
 * Verifies the adapter implements PaymentAdapter interface
 * with correct shape and behavior.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('KiteOzonePaymentAdapter', () => {
  let adapter: PaymentAdapter;

  beforeEach(() => {
    adapter = new KiteOzonePaymentAdapter();
    _resetWalletClient();
    vi.clearAllMocks();
    process.env.OPERATOR_PRIVATE_KEY =
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
  });

  it('implements PaymentAdapter with name "kite-ozone"', () => {
    expect(adapter.name).toBe('kite-ozone');
  });

  it('has chainId 2368', () => {
    expect(adapter.chainId).toBe(2368);
  });

  it('has supportedTokens with PYUSD', () => {
    expect(adapter.supportedTokens).toHaveLength(1);
    expect(adapter.supportedTokens[0].symbol).toBe('PYUSD');
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

  it('quote() returns QuoteResult shape', async () => {
    const result = await adapter.quote(1.0);

    expect(result).toHaveProperty('amountWei');
    expect(result).toHaveProperty('token');
    expect(result).toHaveProperty('facilitatorUrl');
    expect(result.token.symbol).toBe('PYUSD');
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
});
