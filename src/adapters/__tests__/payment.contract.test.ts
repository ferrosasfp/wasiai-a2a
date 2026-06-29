/**
 * Contract tests for KiteOzonePaymentAdapter
 *
 * Verifies the adapter implements PaymentAdapter interface
 * with correct shape and behavior, using env-var-driven token config.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Structured logger mock ─────────────────────────────────
// kite-ozone/payment.ts logs the token/facilitator env fallbacks via
// getLogger('kite-ozone'). Mock it so tests assert log emission (object-first /
// message-second) instead of spying on console. hoisted so the factory can
// reference it.
const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../../lib/logger.js', () => ({
  getLogger: () => logSpy,
}));

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

const PYUSD_DEFAULT = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9';

describe('KiteOzonePaymentAdapter', () => {
  let adapter: PaymentAdapter;

  beforeEach(() => {
    adapter = new KiteOzonePaymentAdapter();
    _resetWalletClient();
    vi.clearAllMocks();
    process.env.OPERATOR_PRIVATE_KEY =
      '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
    // Set token env var to suppress console.warn in tests
    process.env.X402_PAYMENT_TOKEN = PYUSD_DEFAULT;
  });

  afterEach(() => {
    delete process.env.X402_PAYMENT_TOKEN;
    delete process.env.X402_EIP712_DOMAIN_NAME;
    delete process.env.X402_EIP712_DOMAIN_VERSION;
    delete process.env.X402_TOKEN_SYMBOL;
    delete process.env.KITE_FACILITATOR_MODE;
  });

  it('implements PaymentAdapter with name "kite-ozone"', () => {
    expect(adapter.name).toBe('kite-ozone');
  });

  it('has chainId 2368', () => {
    expect(adapter.chainId).toBe(2368);
  });

  it('has supportedTokens with PYUSD by default', () => {
    expect(adapter.supportedTokens).toHaveLength(1);
    expect(adapter.supportedTokens[0]!.symbol).toBe('PYUSD');
    expect(adapter.supportedTokens[0]!.address).toBe(PYUSD_DEFAULT);
  });

  it('reads token address from X402_PAYMENT_TOKEN env var', () => {
    const customToken = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    process.env.X402_PAYMENT_TOKEN = customToken;
    expect(adapter.getToken()).toBe(customToken);
    expect(adapter.supportedTokens[0]!.address).toBe(customToken);
  });

  it('respects env override even with legacy KXUSD address (backward-compat AC-5)', () => {
    const KXUSD_LEGACY = '0x1b7425d288ea676FCBc65c29711fccF0B6D5c293';
    process.env.X402_PAYMENT_TOKEN = KXUSD_LEGACY;
    expect(adapter.getToken()).toBe(KXUSD_LEGACY);
    expect(adapter.supportedTokens[0]!.address).toBe(KXUSD_LEGACY);
  });

  it('defaults to PYUSD when X402_PAYMENT_TOKEN is not set (warns once)', () => {
    delete process.env.X402_PAYMENT_TOKEN;
    const warnSpy = logSpy.warn;
    warnSpy.mockClear();
    expect(adapter.getToken()).toBe(PYUSD_DEFAULT);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // object-first / message-second: the human message is the second arg.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('X402_PAYMENT_TOKEN not set'),
    );
    // Second call should NOT warn again
    adapter.getToken();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to default when X402_PAYMENT_TOKEN has invalid format', () => {
    process.env.X402_PAYMENT_TOKEN = 'not-an-address';
    const warnSpy = logSpy.warn;
    warnSpy.mockClear();
    expect(adapter.getToken()).toBe(PYUSD_DEFAULT);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('invalid format'),
    );
  });

  it('reads token symbol from X402_TOKEN_SYMBOL env var', () => {
    process.env.X402_TOKEN_SYMBOL = 'CUSTOM';
    expect(adapter.supportedTokens[0]!.symbol).toBe('CUSTOM');
  });

  it('defaults token symbol to PYUSD', () => {
    delete process.env.X402_TOKEN_SYMBOL;
    expect(adapter.supportedTokens[0]!.symbol).toBe('PYUSD');
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

  it('quote() returns QuoteResult with PYUSD token', async () => {
    const result = await adapter.quote(1.0);

    expect(result).toHaveProperty('amountWei');
    expect(result).toHaveProperty('token');
    expect(result).toHaveProperty('facilitatorUrl');
    expect(result.token.symbol).toBe('PYUSD');
    expect(result.token.address).toBe(PYUSD_DEFAULT);
  });

  // WKH money-path fix: quote() must HONOR its argument (18-dec PYUSD), not the
  // old flat '1000000000000000000' hardcode.
  it('quote(1) → 1e18 atomic (1 PYUSD, 18 decimals)', async () => {
    expect((await adapter.quote(1)).amountWei).toBe('1000000000000000000');
  });

  it('quote(0.001) → 1e15 atomic, NOT the old 1e18 hardcode', async () => {
    const result = await adapter.quote(0.001);
    expect(result.amountWei).toBe('1000000000000000');
    expect(result.amountWei).not.toBe('1000000000000000000');
  });

  // MNR-1 fix: a tiny amount in scientific notation (String(1e-7) === '1e-7')
  // used to throw inside parseUnits. toFixed(18) normalizes it to a plain
  // decimal string first, so quote() never throws. With 18 decimals 1e-7 is
  // well within the grid → 1e11 atomic (no crash, no 0).
  it('quote(1e-7) does NOT throw and is >=1 atomic (was scientific-notation crash)', async () => {
    let result: Awaited<ReturnType<typeof adapter.quote>> | undefined;
    await expect(
      (async () => {
        result = await adapter.quote(1e-7);
      })(),
    ).resolves.not.toThrow();
    // 1e-7 PYUSD = 1e11 atomic at 18 decimals.
    expect(result?.amountWei).toBe('100000000000');
    expect(BigInt(result?.amountWei ?? '0') >= 1n).toBe(true);
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
    const walletClientMock =
      mockCreateWallet.mock.results[lastCallIndex]!.value;
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

  it('AC-4 Pieverse: verify() body uses server paymentRequirements, not caller', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ valid: true }),
    });
    await adapter.verify({
      authorization: {
        from: '0x1111111111111111111111111111111111111111',
        to: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        value: '1',
        validAfter: '0',
        validBefore: '99',
        nonce: `0x${'a'.repeat(64)}`,
      },
      signature: '0xSIG',
      network: 'kite-testnet',
      paymentRequirements: {
        payTo: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        maxAmountRequired: '1000000000000000000',
      },
    });
    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse((init as { body: string }).body);
    expect(body.paymentRequirements.payTo).toBe(
      '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    );
    expect(body.paymentRequirements.maxAmountRequired).toBe(
      '1000000000000000000',
    );
  });

  it('AC-4 x402: verify() body uses server paymentRequirements, not caller', async () => {
    process.env.KITE_FACILITATOR_MODE = 'x402';
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ verified: true }),
    });
    await adapter.verify({
      authorization: {
        from: '0x1111111111111111111111111111111111111111',
        to: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        value: '1',
        validAfter: '0',
        validBefore: '99',
        nonce: `0x${'a'.repeat(64)}`,
      },
      signature: '0xSIG',
      network: 'kite-testnet',
      paymentRequirements: {
        payTo: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        maxAmountRequired: '1000000000000000000',
      },
    });
    const [, init] = mockFetch.mock.calls[0]!;
    const body = JSON.parse((init as { body: string }).body);
    expect(body.accepted.payTo).toBe(
      '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    );
    expect(body.accepted.amount).toBe('1000000000000000000');
    delete process.env.KITE_FACILITATOR_MODE;
  });

  it('does not throw when env vars are absent (AC-6)', () => {
    delete process.env.X402_PAYMENT_TOKEN;
    delete process.env.X402_EIP712_DOMAIN_NAME;
    delete process.env.X402_EIP712_DOMAIN_VERSION;
    logSpy.warn.mockClear();
    expect(() => adapter.getToken()).not.toThrow();
    expect(() => adapter.supportedTokens).not.toThrow();
  });

  // ── Audit 2026-06-24 (P2-9): facilitator HTTP error propagation ──
  // settle()/verify() in Pieverse mode must surface a typed Error (with the
  // upstream status code) instead of silently returning a malformed result.

  const SETTLE_REQ = {
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
  } as const;

  it('P2-9: settle() throws with the HTTP status when facilitator returns 401', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'unauthorized',
    });

    await expect(adapter.settle({ ...SETTLE_REQ })).rejects.toThrow(
      /Facilitator returned HTTP 401 on \/settle/,
    );
  });

  it('P2-9: settle() throws with the HTTP status when facilitator returns 500', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'internal error',
    });

    await expect(adapter.settle({ ...SETTLE_REQ })).rejects.toThrow(
      /Facilitator returned HTTP 500 on \/settle/,
    );
  });

  it('P2-9: settle() wraps a network-level fetch failure into a typed error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(adapter.settle({ ...SETTLE_REQ })).rejects.toThrow(
      /Facilitator network error on settle: ECONNREFUSED/,
    );
  });

  it('P2-9: verify() throws with the HTTP status when facilitator returns 500', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    await expect(adapter.verify({ ...SETTLE_REQ })).rejects.toThrow(
      /Facilitator returned HTTP 500 on \/verify/,
    );
  });
});
