/**
 * Unit tests for signAndSettleDownstream — chain-aware (WKH-112 / BASE-07).
 *
 * Strategy: mock the adapter REGISTRY (NOT viem). Per-chain mock adapters
 * (Base 6-dec, Avalanche-Fuji 6-dec, Kite 18-dec). `chain-resolver` is left
 * REAL (pure) so the alias mapping (`avalanche` → `avalanche-fuji`) is
 * exercised end-to-end. The pre-flight balance check uses an ephemeral viem
 * public client, so viem's `createPublicClient.readContract` is mocked for the
 * balance scenarios.
 *
 * The `WASIAI_DOWNSTREAM_X402` flag is read at module load → vi.resetModules()
 * + dynamic import per scenario (legacy pattern preserved).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types/index.js';

const PAYTO_ADDR = '0x000000000000000000000000000000000000aBcD' as const;
const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
const FUJI_USDC = '0x5425890298aed601595a70AB815c96711a31Bc65' as const;
const KITE_PYUSD = '0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e' as const;

// ─── Per-chain adapter mocks ─────────────────────────────────────────

const mockBaseSign = vi.fn();
const mockBaseVerify = vi.fn();
const mockBaseSettle = vi.fn();
const mockFujiSign = vi.fn();
const mockFujiVerify = vi.fn();
const mockFujiSettle = vi.fn();
const mockKiteSign = vi.fn();
const mockKiteVerify = vi.fn();
const mockKiteSettle = vi.fn();

const baseAdapter = {
  sign: (...a: unknown[]) => mockBaseSign(...a),
  verify: (...a: unknown[]) => mockBaseVerify(...a),
  settle: (...a: unknown[]) => mockBaseSettle(...a),
  supportedTokens: [{ symbol: 'USDC', address: BASE_USDC, decimals: 6 }],
  getToken: vi.fn().mockReturnValue(BASE_USDC),
  getNetwork: vi.fn().mockReturnValue('eip155:84532'),
};

const fujiAdapter = {
  sign: (...a: unknown[]) => mockFujiSign(...a),
  verify: (...a: unknown[]) => mockFujiVerify(...a),
  settle: (...a: unknown[]) => mockFujiSettle(...a),
  supportedTokens: [{ symbol: 'USDC', address: FUJI_USDC, decimals: 6 }],
  getToken: vi.fn().mockReturnValue(FUJI_USDC),
  getNetwork: vi.fn().mockReturnValue('eip155:43113'),
};

const kiteAdapter = {
  sign: (...a: unknown[]) => mockKiteSign(...a),
  verify: (...a: unknown[]) => mockKiteVerify(...a),
  settle: (...a: unknown[]) => mockKiteSettle(...a),
  supportedTokens: [{ symbol: 'PYUSD', address: KITE_PYUSD, decimals: 18 }],
  getToken: vi.fn().mockReturnValue(KITE_PYUSD),
  getNetwork: vi.fn().mockReturnValue('eip155:2368'),
};

// chainId per bundle (used by the ephemeral public client in the balance check)
const CHAIN_IDS: Record<string, number> = {
  'base-sepolia': 84532,
  'avalanche-fuji': 43113,
  'kite-ozone-testnet': 2368,
};
const CHAIN_NAMES: Record<string, string> = {
  'base-sepolia': 'Base Sepolia',
  'avalanche-fuji': 'Avalanche Fuji',
  'kite-ozone-testnet': 'Kite Ozone Testnet',
};

const mockGetPaymentAdapter = vi.fn((chainKey?: string) => {
  if (chainKey === 'base-sepolia') return baseAdapter;
  if (chainKey === 'kite-ozone-testnet') return kiteAdapter;
  return fujiAdapter; // avalanche-fuji (and any default)
});

// Toggle to simulate "recognized but NOT initialized" (T-AC4b).
let bundleOverride: ((chainKey?: string) => unknown) | null = null;

const mockGetAdaptersBundle = vi.fn((chainKey?: string) => {
  if (bundleOverride) return bundleOverride(chainKey);
  if (chainKey && CHAIN_IDS[chainKey] !== undefined) {
    return {
      chainConfig: {
        name: CHAIN_NAMES[chainKey],
        chainId: CHAIN_IDS[chainKey],
        explorerUrl: 'https://example/explorer',
      },
    };
  }
  return undefined;
});

vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: (chainKey?: string) => mockGetPaymentAdapter(chainKey),
  getAdaptersBundle: (chainKey?: string) => mockGetAdaptersBundle(chainKey),
  getInitializedChainKeys: () => [
    'avalanche-fuji',
    'base-sepolia',
    'kite-ozone-testnet',
  ],
}));

// Mock viem's readContract (used by the ephemeral balance-check public client).
const mockReadContract = vi.fn();
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({ readContract: mockReadContract })),
  };
});

vi.mock('viem/accounts', () => ({
  privateKeyToAccount: vi.fn(() => ({
    address: '0xf432baf09e7ba99ab44ff1d68c83f1234567Ba00',
  })),
}));

// ─── Fixtures ────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'a1',
    slug: 'agent-1',
    name: 'Agent 1',
    description: '',
    capabilities: ['x'],
    priceUsdc: 0.5,
    registry: 'wasiai-v2',
    invokeUrl: 'https://wasiai-v2.example/api/agents/agent-1/invoke',
    invocationNote: '',
    verified: true,
    status: 'active',
    payment: {
      method: 'x402',
      asset: 'USDC',
      chain: 'avalanche',
      contract: PAYTO_ADDR,
    },
    ...overrides,
  };
}

function makeLogger() {
  return { warn: vi.fn(), info: vi.fn() };
}

// Default-happy adapter responses (per chain). Re-applied each beforeEach.
function setHappyDefaults() {
  mockBaseSign.mockResolvedValue({
    paymentRequest: {
      authorization: { from: '0xOP', to: PAYTO_ADDR, value: '500000' },
      signature: '0xSIGB',
      network: 'eip155:84532',
    },
  });
  mockBaseVerify.mockResolvedValue({ valid: true });
  mockBaseSettle.mockResolvedValue({ txHash: '0xBASE', success: true });

  mockFujiSign.mockResolvedValue({
    paymentRequest: {
      authorization: { from: '0xOP', to: PAYTO_ADDR, value: '500000' },
      signature: '0xSIGF',
      network: 'eip155:43113',
    },
  });
  mockFujiVerify.mockResolvedValue({ valid: true });
  mockFujiSettle.mockResolvedValue({ txHash: '0xFUJI', success: true });

  mockKiteSign.mockResolvedValue({
    paymentRequest: {
      authorization: {
        from: '0xOP',
        to: PAYTO_ADDR,
        value: '500000000000000000',
      },
      signature: '0xSIGK',
      network: 'eip155:2368',
    },
  });
  mockKiteVerify.mockResolvedValue({ valid: true });
  mockKiteSettle.mockResolvedValue({ txHash: '0xKITE', success: true });
}

// Import the module under test with the flag set (read at module load).
async function importWithFlag(flagOn: boolean) {
  process.env.WASIAI_DOWNSTREAM_X402 = flagOn ? 'true' : '';
  process.env.OPERATOR_PRIVATE_KEY = `0x${'a'.repeat(64)}`;
  process.env.FUJI_RPC_URL = 'https://api.avax-test.network/ext/bc/C/rpc';
  process.env.BASE_TESTNET_RPC_URL = 'https://sepolia.base.org';
  process.env.KITE_RPC_URL = 'https://rpc-testnet.gokite.ai';
  vi.resetModules();
  return await import('./downstream-payment.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  bundleOverride = null;
  setHappyDefaults();
  // Default balance: plenty for any value computed in these tests.
  mockReadContract.mockResolvedValue(10n ** 24n);
});

afterEach(() => {
  delete process.env.WASIAI_DOWNSTREAM_X402;
  delete process.env.OPERATOR_PRIVATE_KEY;
  delete process.env.FUJI_RPC_URL;
  delete process.env.BASE_TESTNET_RPC_URL;
  delete process.env.KITE_RPC_URL;
});

// ─── Skip-code tests (legacy 1-a-1 mapping) ──────────────────────────

describe('signAndSettleDownstream — skip codes', () => {
  it('T-SkipFlagOff: flag off → null, adapter never resolved (FLAG_OFF / CD-7)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(false);
    const result = await signAndSettleDownstream(makeAgent(), makeLogger());
    expect(result).toBeNull();
    expect(mockGetPaymentAdapter).not.toHaveBeenCalled();
  });

  it('T-SkipNoPayment: payment undefined → null + NO_PAYMENT_FIELD', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const logger = makeLogger();
    const result = await signAndSettleDownstream(
      makeAgent({ payment: undefined }),
      logger,
    );
    expect(result).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'NO_PAYMENT_FIELD' }),
      expect.any(String),
    );
    expect(mockGetPaymentAdapter).not.toHaveBeenCalled();
  });

  it('T-SkipMethod: method !== x402 → null + METHOD_NOT_SUPPORTED', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const logger = makeLogger();
    const agent = makeAgent({
      payment: {
        method: 'blockchain-direct',
        chain: 'avalanche',
        contract: PAYTO_ADDR,
      },
    });
    const result = await signAndSettleDownstream(agent, logger);
    expect(result).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'METHOD_NOT_SUPPORTED' }),
      expect.any(String),
    );
    expect(mockGetPaymentAdapter).not.toHaveBeenCalled();
  });

  it('T-SkipPayToFormat: invalid contract format → null + INVALID_PAY_TO_FORMAT', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const logger = makeLogger();
    const agent = makeAgent({
      payment: {
        method: 'x402',
        chain: 'avalanche',
        contract: '0xZZZ' as `0x${string}`,
      },
    });
    const result = await signAndSettleDownstream(agent, logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INVALID_PAY_TO_FORMAT' }),
      expect.any(String),
    );
    expect(mockFujiSign).not.toHaveBeenCalled();
  });

  it('T-SkipZeroPayTo: zero-address → null + ZERO_PAY_TO', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const logger = makeLogger();
    const agent = makeAgent({
      payment: {
        method: 'x402',
        chain: 'avalanche',
        contract: '0x0000000000000000000000000000000000000000',
      },
    });
    const result = await signAndSettleDownstream(agent, logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ZERO_PAY_TO' }),
      expect.any(String),
    );
    expect(mockFujiSign).not.toHaveBeenCalled();
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['zero', 0],
    ['negative', -1],
  ])('T-SkipInvalidPrice: priceUsdc=%s → null + INVALID_PRICE, sign NOT called', async (_label, badPrice) => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const logger = makeLogger();
    const agent = makeAgent({ priceUsdc: badPrice });
    const result = await signAndSettleDownstream(agent, logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INVALID_PRICE' }),
      expect.any(String),
    );
    expect(mockFujiSign).not.toHaveBeenCalled();
  });

  it('T-Balance-Insufficient: RPC balance 0 → null + INSUFFICIENT_BALANCE, sign NOT called (CD-1)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockReadContract.mockResolvedValueOnce(0n);
    const logger = makeLogger();
    const result = await signAndSettleDownstream(makeAgent(), logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INSUFFICIENT_BALANCE' }),
      expect.any(String),
    );
    expect(mockFujiSign).not.toHaveBeenCalled();
  });

  it('T-Balance-ReadFail: RPC read throws → null + BALANCE_READ_FAILED (CD-1)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockReadContract.mockRejectedValueOnce(new Error('RPC down'));
    const logger = makeLogger();
    const result = await signAndSettleDownstream(makeAgent(), logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'BALANCE_READ_FAILED' }),
      expect.any(String),
    );
    expect(mockFujiSign).not.toHaveBeenCalled();
  });

  it('T-SkipSigningFailed: adapter.sign rejects → null + SIGNING_FAILED (CD-7)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockFujiSign.mockRejectedValueOnce(new Error('keystore error'));
    const logger = makeLogger();
    const result = await signAndSettleDownstream(makeAgent(), logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SIGNING_FAILED' }),
      expect.any(String),
    );
  });

  it('T-SkipVerifyFailed-false: adapter.verify → {valid:false} → null + VERIFY_FAILED (CD-7)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockFujiVerify.mockResolvedValueOnce({ valid: false, error: 'bad-sig' });
    const logger = makeLogger();
    const result = await signAndSettleDownstream(makeAgent(), logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'VERIFY_FAILED', error: 'bad-sig' }),
      expect.any(String),
    );
    expect(mockFujiSettle).not.toHaveBeenCalled();
  });

  it('T-SkipVerifyFailed-throw: adapter.verify rejects (Kite pieverse) → null + VERIFY_FAILED (CD-7)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const agent = makeAgent({
      payment: {
        method: 'x402',
        chain: 'kite-ozone-testnet',
        contract: PAYTO_ADDR,
      },
    });
    mockKiteVerify.mockRejectedValueOnce(new Error('pieverse network error'));
    const logger = makeLogger();
    const result = await signAndSettleDownstream(agent, logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'VERIFY_FAILED' }),
      expect.any(String),
    );
    expect(mockKiteSettle).not.toHaveBeenCalled();
  });

  it('T-SkipSettleFailed-false: adapter.settle → {success:false} → null + SETTLE_FAILED (CD-7)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockFujiSettle.mockResolvedValueOnce({
      txHash: '',
      success: false,
      error: 'nonce already used',
    });
    const logger = makeLogger();
    const result = await signAndSettleDownstream(makeAgent(), logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'SETTLE_FAILED',
        error: 'nonce already used',
      }),
      expect.any(String),
    );
  });

  it('T-SkipSettleFailed-throw: adapter.settle rejects → null + SETTLE_FAILED (CD-7)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockFujiSettle.mockRejectedValueOnce(new Error('facilitator 500'));
    const logger = makeLogger();
    const result = await signAndSettleDownstream(makeAgent(), logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SETTLE_FAILED' }),
      expect.any(String),
    );
  });
});

// ─── AC tests (chain selection + delegation) ─────────────────────────

describe('signAndSettleDownstream — chain-aware delegation', () => {
  it('T-AC1: chain=base-sepolia → settle on Base, txHash + 6-dec amount (AC-1)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const agent = makeAgent({
      payment: {
        method: 'x402',
        chain: 'base-sepolia',
        contract: PAYTO_ADDR,
      },
    });
    const result = await signAndSettleDownstream(agent, makeLogger());
    expect(result).toEqual({ txHash: '0xBASE', settledAmount: '500000' });
    expect(mockGetPaymentAdapter).toHaveBeenCalledWith('base-sepolia');
    expect(mockBaseSign).toHaveBeenCalledWith(
      expect.objectContaining({ to: PAYTO_ADDR, value: '500000' }),
    );
  });

  it('T-AC2a: chain=avalanche → resolves avalanche-fuji, sign value=500000 (6-dec), NO throw (AC-2/CD-1)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const result = await signAndSettleDownstream(makeAgent(), makeLogger());
    expect(result).toEqual({ txHash: '0xFUJI', settledAmount: '500000' });
    expect(mockGetPaymentAdapter).toHaveBeenCalledWith('avalanche-fuji');
    expect(mockFujiSign).toHaveBeenCalledWith(
      expect.objectContaining({ value: '500000' }),
    );
  });

  it('T-AC2b: chain=avalanche-fuji → identical behavior to T-AC2a (AC-2/CD-1)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const agent = makeAgent({
      payment: {
        method: 'x402',
        chain: 'avalanche-fuji',
        contract: PAYTO_ADDR,
      },
    });
    const result = await signAndSettleDownstream(agent, makeLogger());
    expect(result).toEqual({ txHash: '0xFUJI', settledAmount: '500000' });
    expect(mockGetPaymentAdapter).toHaveBeenCalledWith('avalanche-fuji');
    expect(mockFujiSign).toHaveBeenCalledWith(
      expect.objectContaining({ value: '500000' }),
    );
  });

  it('T-AC3: chain=kite-ozone-testnet → sign value=500000000000000000 (18-dec), txHash 0xKITE (AC-3/CD-8)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const agent = makeAgent({
      payment: {
        method: 'x402',
        chain: 'kite-ozone-testnet',
        contract: PAYTO_ADDR,
      },
    });
    const result = await signAndSettleDownstream(agent, makeLogger());
    expect(result).toEqual({
      txHash: '0xKITE',
      settledAmount: '500000000000000000',
    });
    expect(mockGetPaymentAdapter).toHaveBeenCalledWith('kite-ozone-testnet');
    // Guard dimensional Kite-18: 0.5 * 10^18, NOT 0.5 * 10^6.
    expect(mockKiteSign).toHaveBeenCalledWith(
      expect.objectContaining({ value: '500000000000000000' }),
    );
    const signedValue = mockKiteSign.mock.calls[0][0].value as string;
    expect(signedValue).not.toBe('500000');
  });

  it('T-AC4a: chain=solana (normalizeChainSlug→undefined) → null + CHAIN_NOT_SUPPORTED, sign NOT called (AC-4/CD-4)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const agent = makeAgent({
      payment: { method: 'x402', chain: 'solana', contract: PAYTO_ADDR },
    });
    const logger = makeLogger();
    const result = await signAndSettleDownstream(agent, logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'CHAIN_NOT_SUPPORTED' }),
      expect.any(String),
    );
    expect(mockGetPaymentAdapter).not.toHaveBeenCalled();
    expect(mockFujiSign).not.toHaveBeenCalled();
  });

  it('T-AC4b: chain recognised but bundle undefined → null + CHAIN_NOT_SUPPORTED + initialized list, no Avalanche fallback (AC-4/CD-4)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    bundleOverride = () => undefined; // recognised slug, not initialized
    const agent = makeAgent({
      payment: {
        method: 'x402',
        chain: 'base-sepolia',
        contract: PAYTO_ADDR,
      },
    });
    const logger = makeLogger();
    const result = await signAndSettleDownstream(agent, logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'CHAIN_NOT_SUPPORTED',
        initialized: ['avalanche-fuji', 'base-sepolia', 'kite-ozone-testnet'],
      }),
      expect.any(String),
    );
    expect(mockGetPaymentAdapter).not.toHaveBeenCalled();
    expect(mockFujiSign).not.toHaveBeenCalled();
  });

  it('T-AC5: chain=base-sepolia → getPaymentAdapter ALWAYS base-sepolia + settle network == signed network (AC-5/CD-6)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const agent = makeAgent({
      payment: {
        method: 'x402',
        chain: 'base-sepolia',
        contract: PAYTO_ADDR,
      },
    });
    await signAndSettleDownstream(agent, makeLogger());
    expect(mockGetPaymentAdapter.mock.calls.length).toBeGreaterThan(0);
    expect(
      mockGetPaymentAdapter.mock.calls.every((c) => c[0] === 'base-sepolia'),
    ).toBe(true);
    // verify + settle were given the network from signed.paymentRequest.
    expect(mockBaseVerify).toHaveBeenCalledWith(
      expect.objectContaining({ network: 'eip155:84532' }),
    );
    expect(mockBaseSettle).toHaveBeenCalledWith(
      expect.objectContaining({ network: 'eip155:84532' }),
    );
  });

  it('T-AC6: to/value/network come from input + adapter, not chain literals (AC-6/CD-3)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const agent = makeAgent({
      payment: {
        method: 'x402',
        chain: 'base-sepolia',
        contract: PAYTO_ADDR,
      },
    });
    await signAndSettleDownstream(agent, makeLogger());
    // `to` comes from agent.payment.contract (input), `value` from the adapter
    // decimals (6-dec → 500000), `network` from signed.paymentRequest.
    const signArg = mockBaseSign.mock.calls[0][0];
    expect(signArg.to).toBe(PAYTO_ADDR);
    expect(signArg.value).toBe('500000');
    expect(mockBaseSettle).toHaveBeenCalledWith(
      expect.objectContaining({ network: 'eip155:84532' }),
    );
  });

  it('T-AuthWindow: adapter.sign receives timeoutSeconds=300 — legacy EIP-3009 window preserved (CD-1/AR BLQ-MED-1)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    // Default agent → chain=avalanche → resolves avalanche-fuji (the path the
    // legacy VALID_BEFORE_SECONDS=300 window governed).
    await signAndSettleDownstream(makeAgent(), makeLogger());
    expect(mockFujiSign).toHaveBeenCalledTimes(1);
    expect(mockFujiSign.mock.calls[0][0]).toMatchObject({
      timeoutSeconds: 300,
    });
  });

  it('T-Balance-NoRpc: resolved chain without RPC env → fail-soft, continues to sign, info BALANCE_PRECHECK_SKIPPED (DT-3/CD-1)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    delete process.env.BASE_TESTNET_RPC_URL; // no RPC for base-sepolia
    const agent = makeAgent({
      payment: {
        method: 'x402',
        chain: 'base-sepolia',
        contract: PAYTO_ADDR,
      },
    });
    const logger = makeLogger();
    const result = await signAndSettleDownstream(agent, logger);
    expect(result).toEqual({ txHash: '0xBASE', settledAmount: '500000' });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'BALANCE_PRECHECK_SKIPPED' }),
      expect.any(String),
    );
    expect(mockReadContract).not.toHaveBeenCalled();
    expect(mockBaseSign).toHaveBeenCalled();
  });
});
