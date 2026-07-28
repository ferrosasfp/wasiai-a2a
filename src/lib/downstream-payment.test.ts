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
import { FacilitatorSettleError } from '../adapters/errors.js';
import type { Agent } from '../types/index.js';
// it2 BLQ-MED-1: el productor REAL de `Agent.payment` (módulo puro, no mockeado)
// para ejercitar el camino card → readPaymentSpec → gate, en vez de inyectar un
// `payment.chain` que ningún productor genera.
import { readPaymentSpec } from './payment-spec-reader.js';

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
  vmFamily: 'evm' as const, // WKH-234: discriminante para el narrowing downstream
  sign: (...a: unknown[]) => mockBaseSign(...a),
  verify: (...a: unknown[]) => mockBaseVerify(...a),
  settle: (...a: unknown[]) => mockBaseSettle(...a),
  supportedTokens: [{ symbol: 'USDC', address: BASE_USDC, decimals: 6 }],
  getToken: vi.fn().mockReturnValue(BASE_USDC),
  getNetwork: vi.fn().mockReturnValue('eip155:84532'),
};

const fujiAdapter = {
  vmFamily: 'evm' as const,
  sign: (...a: unknown[]) => mockFujiSign(...a),
  verify: (...a: unknown[]) => mockFujiVerify(...a),
  settle: (...a: unknown[]) => mockFujiSettle(...a),
  supportedTokens: [{ symbol: 'USDC', address: FUJI_USDC, decimals: 6 }],
  getToken: vi.fn().mockReturnValue(FUJI_USDC),
  getNetwork: vi.fn().mockReturnValue('eip155:43113'),
};

const kiteAdapter = {
  vmFamily: 'evm' as const,
  sign: (...a: unknown[]) => mockKiteSign(...a),
  verify: (...a: unknown[]) => mockKiteVerify(...a),
  settle: (...a: unknown[]) => mockKiteSettle(...a),
  supportedTokens: [{ symbol: 'PYUSD', address: KITE_PYUSD, decimals: 18 }],
  getToken: vi.fn().mockReturnValue(KITE_PYUSD),
  getNetwork: vi.fn().mockReturnValue('eip155:2368'),
};

// WKH-234: Solana adapter mock (settle-only, base58). vmFamily discriminante.
const SOL_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const SOL_PAYTO = 'So11111111111111111111111111111111111111112';
const SOL_SIG = '5'.repeat(64); // firma base58 (no 0x)
const mockSolanaSettle = vi.fn();
// CR-2 (WKH-234): balance SPL del operador leído por el pre-flight del leg.
const mockSolanaBalance = vi.fn();
// Fix-pack AR-profundo FIX 2: peek in-memory del seam de idempotencia. Default
// `undefined` (intent nunca settleado) → los tests preexistentes no cambian.
const mockSolanaSettledSig = vi.fn();
const solanaAdapter = {
  vmFamily: 'solana' as const,
  settle: (...a: unknown[]) => mockSolanaSettle(...a),
  verify: vi.fn(),
  supportedTokens: [{ symbol: 'USDC', mint: SOL_MINT, decimals: 6 }],
  getMint: vi.fn().mockReturnValue(SOL_MINT),
  getNetwork: vi.fn().mockReturnValue('solana:test'),
  caip2ChainId: 'solana:testcluster',
  getOperatorSplBalance: (...a: unknown[]) => mockSolanaBalance(...a),
  getSettledSignature: (...a: unknown[]) => mockSolanaSettledSig(...a),
};

// Fix-pack AR-profundo FIX 1(b): adapters MAINNET para ejercitar el gate de
// opt-in. Los slugs mainnet SIEMPRE estuvieron en SUPPORTED_CHAINS (rail
// inbound), así que el mock del registry los resuelve como cualquier otro.
const AVAX_MAINNET_USDC = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E' as const;
const mockAvaxMainnetSign = vi.fn();
const mockAvaxMainnetVerify = vi.fn();
const mockAvaxMainnetSettle = vi.fn();
const avaxMainnetAdapter = {
  vmFamily: 'evm' as const,
  sign: (...a: unknown[]) => mockAvaxMainnetSign(...a),
  verify: (...a: unknown[]) => mockAvaxMainnetVerify(...a),
  settle: (...a: unknown[]) => mockAvaxMainnetSettle(...a),
  supportedTokens: [
    { symbol: 'USDC', address: AVAX_MAINNET_USDC, decimals: 6 },
  ],
  getToken: vi.fn().mockReturnValue(AVAX_MAINNET_USDC),
  getNetwork: vi.fn().mockReturnValue('eip155:43114'),
};
const BASE_MAINNET_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
const mockBaseMainnetSign = vi.fn();
const mockBaseMainnetVerify = vi.fn();
const mockBaseMainnetSettle = vi.fn();
const baseMainnetAdapter = {
  vmFamily: 'evm' as const,
  sign: (...a: unknown[]) => mockBaseMainnetSign(...a),
  verify: (...a: unknown[]) => mockBaseMainnetVerify(...a),
  settle: (...a: unknown[]) => mockBaseMainnetSettle(...a),
  supportedTokens: [
    { symbol: 'USDC', address: BASE_MAINNET_USDC, decimals: 6 },
  ],
  getToken: vi.fn().mockReturnValue(BASE_MAINNET_USDC),
  getNetwork: vi.fn().mockReturnValue('eip155:8453'),
};

// chainId per bundle (used by the ephemeral public client in the balance check)
const CHAIN_IDS: Record<string, number> = {
  'base-sepolia': 84532,
  'avalanche-fuji': 43113,
  'kite-ozone-testnet': 2368,
  'solana-devnet': 900001, // WKH-234 sentinel (DT-8)
  // Fix-pack AR-profundo FIX 1(b): bundles mainnet inicializados (así el gate
  // de opt-in se ejercita DESPUÉS del guard CHAIN_NOT_SUPPORTED, no antes).
  'avalanche-mainnet': 43114,
  'base-mainnet': 8453,
};
const CHAIN_NAMES: Record<string, string> = {
  'base-sepolia': 'Base Sepolia',
  'avalanche-fuji': 'Avalanche Fuji',
  'kite-ozone-testnet': 'Kite Ozone Testnet',
  'solana-devnet': 'Solana Devnet',
  'avalanche-mainnet': 'Avalanche C-Chain',
  'base-mainnet': 'Base',
};

const mockGetPaymentAdapter = vi.fn((chainKey?: string) => {
  if (chainKey === 'base-sepolia') return baseAdapter;
  if (chainKey === 'kite-ozone-testnet') return kiteAdapter;
  if (chainKey === 'solana-devnet') return solanaAdapter; // WKH-234
  if (chainKey === 'avalanche-mainnet') return avaxMainnetAdapter; // FIX 1(b)
  if (chainKey === 'base-mainnet') return baseMainnetAdapter; // FIX 1(b)
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
  getPaymentAdapterOrUnion: (chainKey?: string) =>
    mockGetPaymentAdapter(chainKey),
  getAdaptersBundle: (chainKey?: string) => mockGetAdaptersBundle(chainKey),
  getInitializedChainKeys: () => [
    'avalanche-fuji',
    'base-sepolia',
    'kite-ozone-testnet',
    'solana-devnet',
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
    registry_id: 'wasiai-v2',
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

  // WKH-234: Solana leg settle default (base58 signature).
  mockSolanaSettle.mockResolvedValue({ txHash: SOL_SIG, success: true });
  // CR-2: operator SPL balance amplio por defecto (10 USDC, 6-dec).
  mockSolanaBalance.mockResolvedValue('10000000');
  // FIX 2: por defecto NINGÚN intent está settleado (peek → undefined).
  mockSolanaSettledSig.mockReturnValue(undefined);

  // FIX 1(b): adapters mainnet (sólo se usan cuando el gate deja pasar).
  mockAvaxMainnetSign.mockResolvedValue({
    paymentRequest: {
      authorization: { from: '0xOP', to: PAYTO_ADDR, value: '500000' },
      signature: '0xSIGAM',
      network: 'eip155:43114',
    },
  });
  mockAvaxMainnetVerify.mockResolvedValue({ valid: true });
  mockAvaxMainnetSettle.mockResolvedValue({ txHash: '0xAVAXM', success: true });
  mockBaseMainnetSign.mockResolvedValue({
    paymentRequest: {
      authorization: { from: '0xOP', to: PAYTO_ADDR, value: '500000' },
      signature: '0xSIGBM',
      network: 'eip155:8453',
    },
  });
  mockBaseMainnetVerify.mockResolvedValue({ valid: true });
  mockBaseMainnetSettle.mockResolvedValue({ txHash: '0xBASEM', success: true });
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
  // FIX 1(b): el gate es fail-closed; ningún test debe heredar el opt-in.
  delete process.env.WASIAI_DOWNSTREAM_MAINNET_ALLOW;
});

// ─── Skip-code tests (legacy 1-a-1 mapping) ──────────────────────────

describe('signAndSettleDownstream — skip codes', () => {
  it('T-SkipFlagOff: flag off → null, adapter never resolved (FLAG_OFF / CD-7)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(false);
    const result = await signAndSettleDownstream(makeAgent(), makeLogger());
    expect(result).toBeNull();
    expect(mockGetPaymentAdapter).not.toHaveBeenCalled();
  });

  it('T-235a-FlagOff-Log: flag off → loguea el skip FLAG_OFF una sola vez por proceso, mismo comportamiento (null)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(false);
    const logger = makeLogger();

    const first = await signAndSettleDownstream(makeAgent(), logger);
    expect(first).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'FLAG_OFF' }),
      expect.stringContaining('WASIAI_DOWNSTREAM_X402'),
    );
    expect(logger.info).toHaveBeenCalledTimes(1);

    // warn-once: el segundo leg NO vuelve a loguear (no ensucia el hot-path),
    // pero sigue devolviendo null sin resolver adapters.
    const second = await signAndSettleDownstream(makeAgent(), logger);
    expect(second).toBeNull();
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
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

  // ── HU-198: un settle de resultado DESCONOCIDO no es un settle fallido ──
  //
  // El doble del adapter tira lo MISMO que tira el adapter real cuando el techo de
  // wall-clock corta el hop `pieverse` (ver `kite-ozone/payment.pieverse-ceiling.
  // test.ts`, que prueba ese extremo con un servidor node:http real). Acá se prueba
  // la mitad del CONSUMIDOR: que la disposición del valor gobierne el veredicto del
  // leg en vez de colapsarse en "no se pagó".
  it('T-198-SettleUnknown: settle tira con valueDisposition unknown → SETTLE_UNKNOWN (NO SETTLE_FAILED)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockFujiSettle.mockRejectedValueOnce(
      new FacilitatorSettleError(
        'Facilitator network error on settle: timeout',
        'unknown',
      ),
    );
    const logger = makeLogger();
    const result = await signAndSettleDownstream(makeAgent(), logger);

    // El leg NO devuelve un recibo: sin confirmación NO se puede afirmar que se
    // pagó (eso marcaría como cobrado algo no confirmado).
    expect(result).toBeNull();
    // Y TAMPOCO se reporta como "no se pagó": el código es el propio del estado
    // desconocido, que es el que le dice al operador que hay que reconciliar antes
    // de reintentar. Si alguien colapsa este camino en SETTLE_FAILED, este test se
    // pone rojo.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'SETTLE_UNKNOWN',
        valueDisposition: 'unknown',
      }),
      expect.any(String),
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SETTLE_FAILED' }),
      expect.any(String),
    );
  });

  it('T-198-SettleNotSent: settle tira con valueDisposition not-sent → SETTLE_FAILED (el request no salió)', async () => {
    // La otra mitad de la distinción: probado que NO hubo request, el leg SÍ es
    // "no se pagó" y se puede reintentar. Sin este test, `SETTLE_UNKNOWN` podría
    // emitirse para cualquier throw tipado y el test de arriba seguiría verde.
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockFujiSettle.mockRejectedValueOnce(
      new FacilitatorSettleError('ECONNREFUSED', 'not-sent'),
    );
    const logger = makeLogger();
    const result = await signAndSettleDownstream(makeAgent(), logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'SETTLE_FAILED',
        valueDisposition: 'not-sent',
      }),
      expect.any(String),
    );
  });

  // ── HU-201 (AR BLQ-BAJO-1): el mismo eje, pero en el RETURN en vez del THROW ──
  //
  // El `catch` de arriba ya distinguía "no se pagó" de "puede haberse pagado". El `if`
  // que sigue al settle NO: cualquier `success:false` salía como `SETTLE_FAILED`, que
  // en el catálogo público de códigos significa literalmente "no se pagó". Y el caso
  // con txHash es justo donde eso puede ser falso: pieverse devuelve la respuesta del
  // facilitator verbatim, así que el hash es de un broadcast real.
  it('T-201-SettleFalseWithHash: settle DEVUELVE success:false CON txHash → SETTLE_UNKNOWN (NO SETTLE_FAILED)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockFujiSettle.mockResolvedValueOnce({
      success: false,
      txHash: '0xBROADCASTEDBUTREJECTED',
      error: 'reverted after broadcast',
    });
    const logger = makeLogger();
    const result = await signAndSettleDownstream(makeAgent(), logger);

    // El leg sigue sin devolver recibo (sin confirmación no se cobra).
    expect(result).toBeNull();
    // Pero el código deja de AFIRMAR que no se pagó, y el hash viaja para poder
    // cruzarlo contra la cadena.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'SETTLE_UNKNOWN',
        valueDisposition: 'unknown',
        settleTxHash: '0xBROADCASTEDBUTREJECTED',
      }),
      expect.any(String),
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SETTLE_FAILED' }),
      expect.any(String),
    );
  });

  it('T-201-SettleFalseNoHash: settle DEVUELVE success:false SIN txHash → sigue siendo SETTLE_FAILED', async () => {
    // El contra-ejemplo obligatorio: sin él, mandar todo `success:false` a
    // SETTLE_UNKNOWN pasaría verde y el código dejaría de distinguir nada.
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockFujiSettle.mockResolvedValueOnce({
      success: false,
      txHash: '',
      error: 'insufficient balance',
    });
    const logger = makeLogger();
    const result = await signAndSettleDownstream(makeAgent(), logger);

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'SETTLE_FAILED',
        error: 'insufficient balance',
      }),
      expect.any(String),
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SETTLE_UNKNOWN' }),
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
    const signedValue = mockKiteSign.mock.calls[0]![0]!.value as string;
    expect(signedValue).not.toBe('500000');
  });

  // ── AR MENOR-5: la pata OUTBOUND usa el MISMO helper que la inbound ──────

  it('T-MNR5-1 (18-dec): el valor firmado ya no arrastra el artefacto de float de la conversión', async () => {
    // `parseUnits(String(1.005), 18)` no tenía el artefacto de `toFixed(18)`, así
    // que este valor NO cambia — el punto es que ahora sale del mismo helper que
    // el challenge inbound, y por lo tanto los dos coinciden exactamente.
    const { signAndSettleDownstream } = await importWithFlag(true);
    const agent = makeAgent({
      priceUsdc: 1.005,
      payment: {
        method: 'x402',
        chain: 'kite-ozone-testnet',
        contract: PAYTO_ADDR,
      },
    });
    mockKiteSign.mockResolvedValue({
      paymentRequest: {
        authorization: {
          from: '0xOP',
          to: PAYTO_ADDR,
          value: '1005000000000000000',
        },
        signature: '0xSIGK',
        network: 'eip155:2368',
      },
    });

    await signAndSettleDownstream(agent, makeLogger());

    expect(mockKiteSign).toHaveBeenCalledWith(
      expect.objectContaining({ value: '1005000000000000000' }),
    );
    // El artefacto de la expansión binaria (lo que emitía `toFixed(18)`).
    expect(mockKiteSign.mock.calls[0]![0]!.value).not.toBe(
      '1004999999999999893',
    );
  });

  it('T-MNR5-2 (notación científica, 18-dec): antes LANZABA INVALID_PRICE, ahora convierte igual que el challenge inbound', async () => {
    // Divergencia que cerró el AR: `priceUsdc = 1e-7` daba challenge inbound
    // (helper) y `INVALID_PRICE` outbound (`parseUnits('1e-7')` LANZA). Con 18
    // decimales el monto es representable, así que el agente cobra lo que se
    // cobró al caller en vez de saltearse el leg.
    const { signAndSettleDownstream } = await importWithFlag(true);
    const agent = makeAgent({
      priceUsdc: 1e-7,
      payment: {
        method: 'x402',
        chain: 'kite-ozone-testnet',
        contract: PAYTO_ADDR,
      },
    });
    mockKiteSign.mockResolvedValue({
      paymentRequest: {
        authorization: { from: '0xOP', to: PAYTO_ADDR, value: '100000000000' },
        signature: '0xSIGK',
        network: 'eip155:2368',
      },
    });
    const logger = makeLogger();

    const result = await signAndSettleDownstream(agent, logger);

    expect(result).not.toBeNull();
    expect(mockKiteSign).toHaveBeenCalledWith(
      expect.objectContaining({ value: '100000000000' }), // 1e-7 * 10^18
    );
  });

  it('T-MNR5-3 (fail-closed): un precio que redondea a 0 unidades atómicas NO se firma (INVALID_PRICE)', async () => {
    // Contrapartida del cambio de arriba: con 6 decimales `1e-7` redondea a 0.
    // Broadcastear un transfer de 0 quema gas y deja un recibo mentiroso, así que
    // el guard nuevo lo corta con el mismo código que un precio inválido.
    const { signAndSettleDownstream } = await importWithFlag(true);
    const logger = makeLogger();

    const result = await signAndSettleDownstream(
      makeAgent({ priceUsdc: 1e-7 }), // avalanche → 6-dec
      logger,
    );

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INVALID_PRICE', decimals: 6 }),
      expect.stringContaining('0 atomic units'),
    );
    expect(mockFujiSign).not.toHaveBeenCalled();
  });

  it('T-MNR5-4 (leg SOLANA): mismo helper y mismo guard de 0 que el leg EVM', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const solanaAgentAt = (price: number): Agent =>
      makeAgent({
        priceUsdc: price,
        payment: {
          method: 'x402',
          chain: 'solana-devnet',
          contract: SOL_PAYTO,
        },
      });
    mockSolanaBalance.mockResolvedValue('1000000000');
    mockSolanaSettle.mockResolvedValue({ txHash: SOL_SIG, success: true });

    // 0.5 USDC → 500000 (6-dec del mint), byte-idéntico al camino viejo.
    await signAndSettleDownstream(solanaAgentAt(0.5), makeLogger());
    expect(mockSolanaSettle).toHaveBeenCalledWith(
      expect.objectContaining({ amountAtomic: '500000' }),
    );

    // Sub-grilla → 0 atómico → fail-closed (antes: `parseUnits` lanzaba).
    mockSolanaSettle.mockClear();
    const logger = makeLogger();
    const result = await signAndSettleDownstream(solanaAgentAt(1e-7), logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INVALID_PRICE' }),
      expect.stringContaining('0 atomic units'),
    );
    expect(mockSolanaSettle).not.toHaveBeenCalled();
  });

  // WKH-234: `solana` now resolves (→ solana-devnet), so this "unrecognized"
  // test uses `solana-mainnet` — NOT recognized (devnet-only, CD-4).
  it('T-AC4a: chain=solana-mainnet (normalizeChainSlug→undefined) → null + CHAIN_NOT_SUPPORTED, sign NOT called (AC-4/CD-4)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const agent = makeAgent({
      payment: {
        method: 'x402',
        chain: 'solana-mainnet',
        contract: PAYTO_ADDR,
      },
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
        // WKH-234: mock now also initializes the solana-devnet rail.
        initialized: [
          'avalanche-fuji',
          'base-sepolia',
          'kite-ozone-testnet',
          'solana-devnet',
        ],
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
    const signArg = mockBaseSign.mock.calls[0]![0];
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
    expect(mockFujiSign.mock.calls[0]![0]).toMatchObject({
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

// ─── WKH-234: per-leg multichain (AC-3) ──────────────────────────────
describe('signAndSettleDownstream — Solana leg (WKH-234)', () => {
  const PAYTO_ADDR = '0x1111111111111111111111111111111111111111' as const;

  it('T-234-AC3a: solana-devnet leg → settles via Solana adapter (settle-only), returns base58 txHash', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const agent = makeAgent({
      priceUsdc: 0.5,
      payment: {
        method: 'x402',
        asset: 'USDC',
        chain: 'solana-devnet',
        contract: SOL_PAYTO,
      },
    });
    const result = await signAndSettleDownstream(agent, makeLogger());

    expect(result).not.toBeNull();
    expect(result?.txHash).toBe(SOL_SIG); // base58, not 0x
    // decimals-aware atomic from the adapter mint (6-dec): 0.5 → 500000.
    expect(result?.settledAmount).toBe('500000');
    // Solana leg is settle-only: adapter.settle called, NO EVM sign/verify.
    expect(mockSolanaSettle).toHaveBeenCalledTimes(1);
    const settleArg = mockSolanaSettle.mock.calls[0]?.[0] as {
      payTo: string;
      amountAtomic: string;
      intentId: string;
    };
    expect(settleArg.payTo).toBe(SOL_PAYTO);
    expect(settleArg.amountAtomic).toBe('500000');
    expect(typeof settleArg.intentId).toBe('string');
    // EVM adapters untouched for the Solana leg.
    expect(mockFujiSign).not.toHaveBeenCalled();
    expect(mockBaseSign).not.toHaveBeenCalled();
  });

  it('T-234-AC3b: mixed pipeline — avalanche-fuji leg byte-identical, solana leg via its adapter', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);

    // EVM leg (avalanche-fuji) — byte-identical to the pre-WKH-234 path.
    const evm = await signAndSettleDownstream(
      makeAgent({
        payment: {
          method: 'x402',
          asset: 'USDC',
          chain: 'avalanche-fuji',
          contract: PAYTO_ADDR,
        },
      }),
      makeLogger(),
    );
    expect(evm?.txHash).toBe('0xFUJI');
    expect(mockFujiSign).toHaveBeenCalledTimes(1);
    expect(mockFujiSettle).toHaveBeenCalledTimes(1);
    expect(mockSolanaSettle).not.toHaveBeenCalled();

    // Solana leg — settled via the Solana adapter, distinct rail.
    const sol = await signAndSettleDownstream(
      makeAgent({
        payment: {
          method: 'x402',
          asset: 'USDC',
          chain: 'solana-devnet',
          contract: SOL_PAYTO,
        },
      }),
      makeLogger(),
    );
    expect(sol?.txHash).toBe(SOL_SIG);
    expect(mockSolanaSettle).toHaveBeenCalledTimes(1);
    // EVM leg adapter not re-invoked by the Solana leg.
    expect(mockFujiSign).toHaveBeenCalledTimes(1);
  });

  it('T-234-AC3c: solana leg with invalid base58 payTo → null + INVALID_PAY_TO_FORMAT (NEVER throws)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const logger = makeLogger();
    const result = await signAndSettleDownstream(
      makeAgent({
        payment: {
          method: 'x402',
          asset: 'USDC',
          chain: 'solana-devnet',
          contract: '0xnotBase58', // EVM-shaped → invalid for Solana
        },
      }),
      logger,
    );
    expect(result).toBeNull();
    expect(mockSolanaSettle).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INVALID_PAY_TO_FORMAT' }),
      expect.any(String),
    );
  });

  // WKH-241 AC-5: el payment spec ahora también llega de agentes
  // self-published (metadata.payment, pass-through sin validar formato en
  // read-time — DT-3). Caso NO cubierto por T-234-AC3c: charset base58 VÁLIDO
  // pero longitud != 32 bytes. El guard settle-time lo rechaza igual, sin
  // mover fondos.
  it('T-241-AC5: base58 con charset válido pero longitud inválida → null + INVALID_PAY_TO_FORMAT, settle NUNCA llamado', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const logger = makeLogger();
    const result = await signAndSettleDownstream(
      makeAgent({
        payment: {
          method: 'x402',
          asset: 'USDC',
          chain: 'solana-devnet',
          contract: 'abc', // base58 charset ok, NO 32 bytes
        },
      }),
      logger,
    );
    expect(result).toBeNull();
    expect(mockSolanaSettle).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INVALID_PAY_TO_FORMAT' }),
      expect.any(String),
    );
  });

  // ── CR-2 (WKH-234): paridad del pre-flight de balance con la rama EVM ─────

  function solanaAgent() {
    return makeAgent({
      priceUsdc: 0.5,
      payment: {
        method: 'x402',
        asset: 'USDC',
        chain: 'solana-devnet',
        contract: SOL_PAYTO,
      },
    });
  }

  it('T-234-CR2a: operator SPL balance < amountAtomic → null + INSUFFICIENT_BALANCE (mismo skip-code que EVM), settle NUNCA llamado', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockSolanaBalance.mockResolvedValueOnce('499999'); // requerido: 500000
    const logger = makeLogger();

    const result = await signAndSettleDownstream(solanaAgent(), logger);

    expect(result).toBeNull();
    expect(mockSolanaSettle).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'INSUFFICIENT_BALANCE',
        balance: '499999',
        required: '500000',
      }),
      expect.any(String),
    );
  });

  it('T-234-CR2b: balance == amountAtomic (borde exacto) → settle SÍ se ejecuta (el pre-check no es off-by-one)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockSolanaBalance.mockResolvedValueOnce('500000');
    const logger = makeLogger();

    const result = await signAndSettleDownstream(solanaAgent(), logger);

    expect(result?.txHash).toBe(SOL_SIG);
    expect(mockSolanaSettle).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('T-234-CR2c: lectura de balance LANZA (RPC caído / ATA inexistente) → NO bloquea: degrada a BALANCE_PRECHECK_SKIPPED y settlea igual', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockSolanaBalance.mockRejectedValueOnce(
      new Error('could not find account'),
    );
    const logger = makeLogger();

    const result = await signAndSettleDownstream(solanaAgent(), logger);

    // Invariante: el pre-check es observabilidad, NUNCA un gate que produzca
    // falsos negativos sobre un settle legítimo.
    expect(result?.txHash).toBe(SOL_SIG);
    expect(mockSolanaSettle).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'BALANCE_PRECHECK_SKIPPED' }),
      expect.any(String),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('T-234-CR2d: camino feliz — el pre-check lee el balance 1× y no altera el resultado del settle', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const logger = makeLogger();

    const result = await signAndSettleDownstream(solanaAgent(), logger);

    expect(result?.txHash).toBe(SOL_SIG);
    expect(result?.settledAmount).toBe('500000');
    expect(mockSolanaBalance).toHaveBeenCalledTimes(1);
    expect(mockSolanaSettle).toHaveBeenCalledTimes(1);
  });

  // ── Fix-pack AR-profundo FIX 3: monto REAL settleado, en USD ──────────────
  it('T-FIX3a: el leg Solana propaga nonEvmSettle.amountUsd == monto on-chain (derivado del atómico + decimals)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const result = await signAndSettleDownstream(solanaAgent(), makeLogger());
    // 0.5 USDC 6-dec → 500000 atómico → 0.5 USD. Es el número que el ledger
    // debe cruzar contra la firma base58 (antes se registraba el débito del
    // caller, que vale 0 en el step 0).
    expect(result?.settledAmount).toBe('500000');
    // Fix-pack CR-MNR-1: CAIP-2 y monto viajan en UN objeto — el estado "uno sin
    // el otro" (que habría reescrito amount_usd=0 al lado de una firma real) ya
    // no es representable, así que se assertea el objeto COMPLETO.
    expect(result?.nonEvmSettle).toEqual({
      caip2: 'solana:testcluster',
      amountUsd: 0.5,
    });
  });

  it('T-CR-MNR-1: el leg EVM NO trae `nonEvmSettle` (el ledger no-EVM no se toca)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const result = await signAndSettleDownstream(makeAgent(), makeLogger());
    expect(result).not.toBeNull();
    expect(result?.nonEvmSettle).toBeUndefined();
  });

  // ── Fix-pack AR-profundo FIX 2: idempotencia ANTES del pre-check de fondos ──
  // Repro del hallazgo: balance 3 USDC, precio 3 USDC, MISMO intentId. La 1ª
  // llamada paga y deja el balance en 0; la 2ª (retry del mismo leg) cortaba con
  // INSUFFICIENT_BALANCE y `adapter.settle` NUNCA se invocaba ⇒ un pago SPL real
  // se reportaba como no pagado (sin recibo ni settle_signature en el ledger).
  it('T-FIX2: replay del MISMO intentId con el balance ya en 0 → devuelve la firma previa (NO null), un solo broadcast real', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const INTENT = 'ctx-abc:0:So11111111111111111111111111111111111111112';

    // Fake adapter con seam de idempotencia REAL: el primer settle broadcastea y
    // consume el balance; el segundo es un hit idempotente (sin broadcast).
    const store = new Map<string, string>();
    let balanceAtomic = 3_000_000n; // 3 USDC (6-dec) == el precio del leg
    let broadcasts = 0;
    mockSolanaSettle.mockImplementation(
      async (req: { intentId: string; amountAtomic: string }) => {
        const prior = store.get(req.intentId);
        if (prior) return { txHash: prior, success: true }; // idempotent hit
        broadcasts += 1;
        balanceAtomic -= BigInt(req.amountAtomic);
        store.set(req.intentId, SOL_SIG);
        return { txHash: SOL_SIG, success: true };
      },
    );
    mockSolanaBalance.mockImplementation(async () => balanceAtomic.toString());
    mockSolanaSettledSig.mockImplementation((id: string) => store.get(id));

    const agent = makeAgent({
      priceUsdc: 3,
      payment: {
        method: 'x402',
        asset: 'USDC',
        chain: 'solana-devnet',
        contract: SOL_PAYTO,
      },
    });

    const logger1 = makeLogger();
    const first = await signAndSettleDownstream(agent, logger1, INTENT);
    expect(first?.txHash).toBe(SOL_SIG);
    expect(balanceAtomic).toBe(0n);

    const logger2 = makeLogger();
    const second = await signAndSettleDownstream(agent, logger2, INTENT);

    // El corazón del fix: el retry NO es null y devuelve la MISMA firma.
    expect(second).not.toBeNull();
    expect(second?.txHash).toBe(SOL_SIG);
    expect(second?.nonEvmSettle?.amountUsd).toBe(3);
    // Un único broadcast real (el 2º settle resolvió por idempotencia).
    expect(broadcasts).toBe(1);
    // Y NUNCA se reporta INSUFFICIENT_BALANCE sobre un leg ya pagado.
    expect(logger2.warn).not.toHaveBeenCalled();
    // Fix-pack it2 MNR-1: en el replay el pre-check es SONDA, no gate — se lee el
    // balance (2ª lectura) y el balance bajo se reporta en INFO sin cortar, para
    // no perder la distinguibilidad si el `settle()` toma el camino self-heal
    // (firma previa que no verifica ⇒ re-broadcast FRESCO).
    expect(logger2.info).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'BALANCE_LOW_ON_IDEMPOTENT_REPLAY',
        intentId: INTENT,
        balance: '0',
        required: '3000000',
      }),
      expect.any(String),
    );
    expect(mockSolanaBalance).toHaveBeenCalledTimes(2);
  });

  it('T-FIX2b: intent NUEVO con balance insuficiente sigue cortando con INSUFFICIENT_BALANCE (el gate no se debilitó)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockSolanaSettledSig.mockReturnValue(undefined); // intent desconocido
    mockSolanaBalance.mockResolvedValueOnce('499999'); // requerido 500000
    const logger = makeLogger();

    const result = await signAndSettleDownstream(
      solanaAgent(),
      logger,
      'ctx-new:0:payTo',
    );

    expect(result).toBeNull();
    expect(mockSolanaSettle).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INSUFFICIENT_BALANCE' }),
      expect.any(String),
    );
  });

  // ── SETTLE_FAILED del leg Solana (P1 hallazgo 3) ───────────────────────
  //
  // Los DOS guards de `downstream-payment.ts:403-416` (el `catch` del settle y el
  // `!settleRes.success`) estaban SIN NINGÚN test: se verificó mutando los dos a
  // la vez (rethrow + seguir de largo cobrando) y la suite completa quedó verde
  // (3364 passed). El leg Solana tenía cubierto el corte por fondos y por payTo
  // inválido, pero NO el corte por settle fallido, que es justo el que decide si
  // un leg que no pagó igual se cobra.
  //
  // Invariante de los dos: `null` (⇒ el caller NO cobra el leg y /compose lo
  // reporta como salteado) + señal `SETTLE_FAILED` en el log, y NUNCA una
  // excepción que escape (el contrato de `signAndSettleDownstream` es fail-soft).

  it('T-P1-3a: adapter.settle LANZA → null + SETTLE_FAILED, sin excepción que escape', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockSolanaSettledSig.mockReturnValue(undefined);
    mockSolanaBalance.mockResolvedValueOnce('1000000'); // fondos de sobra
    mockSolanaSettle.mockRejectedValueOnce(
      new Error('blockhash not found / RPC down'),
    );
    const logger = makeLogger();

    // Fail-SOFT: el leg se corta, no explota el run entero.
    const result = await signAndSettleDownstream(solanaAgent(), logger);

    // `null` es lo que hace que el caller NO cobre este leg.
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'SETTLE_FAILED',
        detail: expect.stringContaining('blockhash not found'),
      }),
      expect.any(String),
    );
  });

  it('T-P1-3b: adapter.settle devuelve success=false → null + SETTLE_FAILED (no se cobra un leg no pagado)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockSolanaSettledSig.mockReturnValue(undefined);
    mockSolanaBalance.mockResolvedValueOnce('1000000');
    mockSolanaSettle.mockResolvedValueOnce({
      success: false,
      error: 'tx rejected by the cluster',
    });
    const logger = makeLogger();

    const result = await signAndSettleDownstream(solanaAgent(), logger);

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'SETTLE_FAILED',
        error: 'tx rejected by the cluster',
      }),
      expect.any(String),
    );
  });

  it('T-P1-3c: settle "exitoso" SIN txHash → null + SETTLE_FAILED (un recibo sin firma no es un pago)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockSolanaSettledSig.mockReturnValue(undefined);
    mockSolanaBalance.mockResolvedValueOnce('1000000');
    // `success: true` pero sin firma: no hay nada que anotar como
    // `settle_signature` en el ledger, así que NO puede contar como pagado.
    mockSolanaSettle.mockResolvedValueOnce({ success: true });
    const logger = makeLogger();

    const result = await signAndSettleDownstream(solanaAgent(), logger);

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SETTLE_FAILED' }),
      expect.any(String),
    );
  });
});

// ─── Fix-pack AR-profundo FIX 1(b): gate fail-closed de MAINNET ───────────
// La chain del leg downstream la declara el AGENTE. Los slugs mainnet estaban en
// SUPPORTED_CHAINS sin gate (a diferencia de tempo/solana) y el control que la
// doc de operación prometía (WASIAI_DOWNSTREAM_NETWORK) no lo leía nadie.
describe('signAndSettleDownstream — mainnet opt-in gate (fix-pack AR-profundo FIX 1b)', () => {
  function mainnetAgent(chain: string) {
    return makeAgent({
      priceUsdc: 0.5,
      payment: {
        method: 'x402',
        asset: 'USDC',
        chain,
        contract: PAYTO_ADDR,
      },
    });
  }

  it('T-FIX1B-1: env AUSENTE → base-mainnet corta con MAINNET_NOT_ALLOWED, sign/settle NUNCA se invocan', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const logger = makeLogger();

    const result = await signAndSettleDownstream(
      mainnetAgent('base-mainnet'),
      logger,
    );

    expect(result).toBeNull();
    expect(mockBaseMainnetSign).not.toHaveBeenCalled();
    expect(mockBaseMainnetSettle).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'MAINNET_NOT_ALLOWED',
        chain: 'base-mainnet',
      }),
      expect.any(String),
    );
  });

  // `kite-mainnet` no está inicializado en el mock del registry → ya corta antes
  // con CHAIN_NOT_SUPPORTED (guard preexistente). Acá se ejercita la mainnet que
  // SÍ tiene bundle, que es el caso peligroso que el gate cierra.
  it('T-FIX1B-2: env AUSENTE → avalanche-mainnet también corta, incluido su alias numérico', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    for (const chain of ['avalanche-mainnet', '43114']) {
      const logger = makeLogger();
      const result = await signAndSettleDownstream(mainnetAgent(chain), logger);
      expect(result, `chain=${chain}`).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'MAINNET_NOT_ALLOWED' }),
        expect.any(String),
      );
    }
    expect(mockAvaxMainnetSign).not.toHaveBeenCalled();
  });

  it('T-FIX1B-3: opt-in explícito del slug → el settle mainnet procede', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    process.env.WASIAI_DOWNSTREAM_MAINNET_ALLOW = 'base-mainnet';
    const logger = makeLogger();

    const result = await signAndSettleDownstream(
      mainnetAgent('base-mainnet'),
      logger,
    );

    expect(result?.txHash).toBe('0xBASEM');
    expect(mockBaseMainnetSign).toHaveBeenCalledTimes(1);
    expect(mockBaseMainnetSettle).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  // Fix-pack it2 BLQ-MED-1 — REESCRITO. La versión anterior INYECTABA
  // `payment.chain = 'avalanche-mainnet'` en el fixture, una forma que los
  // productores reales (`readPaymentSpec`, el ÚNICO productor de `Agent.payment`:
  // `discovery.mapAgent` + `agent.mapRowToAgent`) JAMÁS generaban — colapsaban
  // todo alias mainnet a `'avalanche'`. Era un falso verde: el opt-in de avalanche
  // NO era ejercitable. Ahora el test recorre el camino REAL:
  //   agent card (lo que un registry declara) → readPaymentSpec → gate.
  it('T-FIX1B-4 (it2): el opt-in avalanche-mainnet es ejercitable END-TO-END desde un card real (card → readPaymentSpec → gate), acepta alias numéricos/CSV y es POR CHAIN', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);

    // Un registry declara mainnet por su alias NUMÉRICO — ni el literal.
    const card = {
      payment: { method: 'x402', chain: '43114', contract: PAYTO_ADDR },
    };
    const spec = readPaymentSpec(card);
    // El productor real ya NO colapsa el alias mainnet (antes: 'avalanche' → Fuji).
    expect(spec?.chain).toBe('avalanche-mainnet');
    const agentFromCard = makeAgent({ priceUsdc: 0.5, payment: spec });

    // 1) Sin opt-in → el gate corta el card mainnet.
    const closedLogger = makeLogger();
    expect(
      await signAndSettleDownstream(agentFromCard, closedLogger),
    ).toBeNull();
    expect(closedLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'MAINNET_NOT_ALLOWED',
        reason: 'NO_OPT_IN',
        chain: 'avalanche-mainnet',
        actualChainId: 43114,
      }),
      expect.any(String),
    );
    expect(mockAvaxMainnetSign).not.toHaveBeenCalled();

    // 2) Con el opt-in (CSV, alias numérico + espacios) el MISMO card settlea.
    process.env.WASIAI_DOWNSTREAM_MAINNET_ALLOW = ' 43114 , kite-mainnet ';
    const okLogger = makeLogger();
    const allowed = await signAndSettleDownstream(agentFromCard, okLogger);
    expect(allowed?.txHash).toBe('0xAVAXM');
    expect(mockAvaxMainnetSign).toHaveBeenCalledTimes(1);
    expect(okLogger.warn).not.toHaveBeenCalled();

    // 3) base-mainnet NO está en la lista → sigue cortado (es POR CHAIN, no un
    //    interruptor global).
    const blockedLogger = makeLogger();
    const blockedSpec = readPaymentSpec({
      payment: { method: 'x402', chain: 'base-mainnet', contract: PAYTO_ADDR },
    });
    const blocked = await signAndSettleDownstream(
      makeAgent({ priceUsdc: 0.5, payment: blockedSpec }),
      blockedLogger,
    );
    expect(blocked).toBeNull();
    expect(blockedLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'MAINNET_NOT_ALLOWED' }),
      expect.any(String),
    );
    expect(mockBaseMainnetSign).not.toHaveBeenCalled();
  });

  it('T-FIX1B-4b (it2): el card testnet real (alias legacy avalanche-testnet) sigue settleando en Fuji — el no-colapso mainnet no toca el path testnet', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const spec = readPaymentSpec({
      payment: {
        method: 'x402',
        chain: 'avalanche-testnet',
        contract: PAYTO_ADDR,
      },
    });
    expect(spec?.chain).toBe('avalanche'); // colapso legacy intacto (CD-2)
    const logger = makeLogger();
    const result = await signAndSettleDownstream(
      makeAgent({ priceUsdc: 0.5, payment: spec }),
      logger,
    );
    expect(result).toEqual({ txHash: '0xFUJI', settledAmount: '500000' });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('T-FIX1B-5: env con valor basura o vacío → fail-CLOSED (no habilita nada)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    for (const raw of ['', '   ', 'true', 'all', 'polygon-mainnet']) {
      process.env.WASIAI_DOWNSTREAM_MAINNET_ALLOW = raw;
      const logger = makeLogger();
      const result = await signAndSettleDownstream(
        mainnetAgent('base-mainnet'),
        logger,
      );
      expect(result, `raw='${raw}'`).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'MAINNET_NOT_ALLOWED' }),
        expect.any(String),
      );
    }
  });

  // ── Fix-pack it2 BLQ-ALTO-1: el gate se salteaba con KITE_NETWORK=mainnet ────
  // El bundle del ChainKey `kite-ozone-testnet` se construye SIN `opts`
  // (`registry.ts` → `createKiteOzoneAdapters()`) y `getKiteChain()` lee
  // `KITE_NETWORK` en CALL-TIME: con `KITE_NETWORK=mainnet` (lo que instruían los
  // dos runbooks) ese bundle apunta a chainId 2366 / USDC.e de Kite MAINNET
  // mientras `isMainnetChainKey('kite-ozone-testnet')` devuelve false ⇒ un card
  // con `payment.chain: 'kite-ozone-testnet'` (o `2368`/`kite-testnet`) settleaba
  // DINERO REAL con el gate vacío. Se simula devolviendo el bundle mainnet para
  // ese slug (exactamente lo que hace el factory con esa env).
  function driftBundle(chainKey?: string) {
    if (chainKey === 'kite-ozone-testnet') {
      return {
        chainConfig: {
          name: 'KiteAI Mainnet',
          chainId: 2366, // ← el destino REAL con KITE_NETWORK=mainnet
          explorerUrl: 'https://kitescan.ai',
        },
      };
    }
    return undefined;
  }

  it('T-it2-ALTO-1a: slug testnet cuyo bundle apunta a chainId 2366 (KITE_NETWORK=mainnet) → skip-code CHAIN_ENVIRONMENT_DRIFT, sin firmar ni settlear (todos sus alias)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    bundleOverride = driftBundle;

    for (const declared of ['kite-ozone-testnet', '2368', 'kite-testnet']) {
      const logger = makeLogger();
      const result = await signAndSettleDownstream(
        mainnetAgent(declared),
        logger,
      );
      expect(result, `chain=${declared}`).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          // Fix-pack CR-MNR-5: código PROPIO, ya NO `MAINNET_NOT_ALLOWED`. Un
          // dashboard que cuenta "agentes pidiendo mainnet sin opt-in" no debe
          // sumar "nuestra config es incoherente" (que además incluye el caso
          // declared=mainnet/actual=testnet, donde permitir mainnet no aplica).
          code: 'CHAIN_ENVIRONMENT_DRIFT',
          chain: 'kite-ozone-testnet',
          declaredEnvironment: 'testnet',
          actualEnvironment: 'mainnet',
          actualChainId: 2366,
          expectedChainId: 2368,
        }),
        expect.any(String),
      );
      // El drift ya NO comparte código con el gate de opt-in: son incidentes
      // distintos y deben ser distinguibles en los logs.
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ code: 'MAINNET_NOT_ALLOWED' }),
        expect.any(String),
      );
    }
    expect(mockKiteSign).not.toHaveBeenCalled();
    expect(mockKiteSettle).not.toHaveBeenCalled();
  });

  it('T-it2-ALTO-1b: el drift NO se puede habilitar con el opt-in (un slug que miente no es llave de nada)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    bundleOverride = driftBundle;

    for (const raw of ['kite-ozone-testnet', '2368', 'kite-mainnet', '2366']) {
      process.env.WASIAI_DOWNSTREAM_MAINNET_ALLOW = raw;
      const logger = makeLogger();
      const result = await signAndSettleDownstream(
        mainnetAgent('kite-ozone-testnet'),
        logger,
      );
      expect(result, `allow='${raw}'`).toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'CHAIN_ENVIRONMENT_DRIFT' }),
        expect.any(String),
      );
    }
    expect(mockKiteSign).not.toHaveBeenCalled();
  });

  it('T-it2-ALTO-1c: el MISMO slug con su bundle coherente (chainId 2368) settlea normal — el gate no rompe el path testnet', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const logger = makeLogger();

    const result = await signAndSettleDownstream(
      makeAgent({
        payment: {
          method: 'x402',
          asset: 'USDC',
          chain: 'kite-ozone-testnet',
          contract: PAYTO_ADDR,
        },
      }),
      logger,
    );

    expect(result?.txHash).toBe('0xKITE');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('T-it2-ALTO-1d: chainId DESCONOCIDO en un bundle → fail-CLOSED (cuenta como mainnet, no settlea a ciegas)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    bundleOverride = (chainKey?: string) =>
      chainKey === 'base-sepolia'
        ? {
            chainConfig: {
              name: 'Mystery chain',
              chainId: 999_999, // nadie lo clasificó
              explorerUrl: '',
            },
          }
        : undefined;
    const logger = makeLogger();

    const result = await signAndSettleDownstream(
      makeAgent({
        payment: {
          method: 'x402',
          asset: 'USDC',
          chain: 'base-sepolia',
          contract: PAYTO_ADDR,
        },
      }),
      logger,
    );

    expect(result).toBeNull();
    // El chainId desconocido se clasifica `mainnet` (fail-CLOSED). Con un slug
    // TESTNET declarado eso además es un DRIFT, así que corta en el guard 4b-i,
    // que es todavía más fuerte: no admite opt-in. Fix-pack CR-MNR-5: ese corte
    // ya tiene su propio skip-code (antes se logueaba como MAINNET_NOT_ALLOWED).
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'CHAIN_ENVIRONMENT_DRIFT',
        declaredEnvironment: 'testnet',
        actualEnvironment: 'mainnet',
        actualChainId: 999_999,
      }),
      expect.any(String),
    );
    expect(mockBaseSign).not.toHaveBeenCalled();
  });

  it('T-CR-MNR-5: chainId DESCONOCIDO bajo un slug MAINNET (sin drift) → MAINNET_NOT_ALLOWED / NO_OPT_IN, el otro código', async () => {
    // Misma clasificación fail-CLOSED que T-it2-ALTO-1d, pero sin incoherencia de
    // slug: declared=mainnet == actual=mainnet ⇒ no hay drift y el corte lo hace
    // el gate de opt-in. Es el par que prueba que los dos códigos NO son
    // sinónimos (el motivo de CR-MNR-5).
    const { signAndSettleDownstream } = await importWithFlag(true);
    bundleOverride = (chainKey?: string) =>
      chainKey === 'base-mainnet'
        ? {
            chainConfig: {
              name: 'Mystery chain',
              chainId: 999_999, // nadie lo clasificó
              explorerUrl: '',
            },
          }
        : undefined;
    const logger = makeLogger();

    const result = await signAndSettleDownstream(
      mainnetAgent('base-mainnet'),
      logger,
    );

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'MAINNET_NOT_ALLOWED',
        reason: 'NO_OPT_IN',
        actualChainId: 999_999,
      }),
      expect.any(String),
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ code: 'CHAIN_ENVIRONMENT_DRIFT' }),
      expect.any(String),
    );
    expect(mockBaseSign).not.toHaveBeenCalled();
  });

  it('T-FIX1B-6: los legs TESTNET son byte-idénticos con el gate presente (sin env, sin cambios)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const logger = makeLogger();

    const result = await signAndSettleDownstream(
      makeAgent({
        payment: {
          method: 'x402',
          asset: 'USDC',
          chain: 'avalanche-fuji',
          contract: PAYTO_ADDR,
        },
      }),
      logger,
    );

    expect(result).toEqual({ txHash: '0xFUJI', settledAmount: '500000' });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

// ─── Fix-pack P1 (hallazgo 4): captura del skip-code para la respuesta ────
//
// La señal `steps[].downstreamSettle` de /compose depende de un INVARIANTE de
// este módulo: todo camino que devuelve `null` loguea antes un `{ code }`. Estos
// tests lo fijan contra el código REAL (no contra un mock del logger), para que
// un `return null` nuevo sin código rompa la suite en vez de degradar la
// respuesta en silencio.

describe('captura del skip-code (fix-pack P1, hallazgo 4)', () => {
  it('T-P1-4a: FLAG_OFF se reporta SIEMPRE, incluso en el 2º leg (el log es warn-once)', async () => {
    // ESTE es el caso que un decorador de logger puro NO cubriría: el log de
    // FLAG_OFF es once-per-process, así que del 2º request en adelante el
    // decorador no vería nada y la respuesta perdería la señal. De ahí el
    // `noteSkip` explícito en ese branch.
    const { signAndSettleDownstream, createSkipCapturingLogger } =
      await importWithFlag(false);

    const cap1 = createSkipCapturingLogger(makeLogger());
    expect(await signAndSettleDownstream(makeAgent(), cap1)).toBeNull();
    expect(cap1.lastSkipCode()).toBe('FLAG_OFF');

    // 2º leg: el log ya no se emite, el CÓDIGO sí.
    const inner2 = makeLogger();
    const cap2 = createSkipCapturingLogger(inner2);
    expect(await signAndSettleDownstream(makeAgent(), cap2)).toBeNull();
    expect(inner2.info).not.toHaveBeenCalled(); // warn-once preservado
    expect(cap2.lastSkipCode()).toBe('FLAG_OFF'); // señal preservada
  });

  it('T-P1-4b: NO_PAYMENT_FIELD → capturado', async () => {
    const { signAndSettleDownstream, createSkipCapturingLogger } =
      await importWithFlag(true);
    const cap = createSkipCapturingLogger(makeLogger());

    expect(
      await signAndSettleDownstream(makeAgent({ payment: undefined }), cap),
    ).toBeNull();
    expect(cap.lastSkipCode()).toBe('NO_PAYMENT_FIELD');
  });

  it('T-P1-4c: METHOD_NOT_SUPPORTED → capturado', async () => {
    const { signAndSettleDownstream, createSkipCapturingLogger } =
      await importWithFlag(true);
    const cap = createSkipCapturingLogger(makeLogger());

    expect(
      await signAndSettleDownstream(
        makeAgent({
          payment: {
            method: 'stripe',
            asset: 'USDC',
            chain: 'avalanche',
            contract: PAYTO_ADDR,
          },
        }),
        cap,
      ),
    ).toBeNull();
    expect(cap.lastSkipCode()).toBe('METHOD_NOT_SUPPORTED');
  });

  it('T-P1-4d: CHAIN_NOT_SUPPORTED → capturado', async () => {
    const { signAndSettleDownstream, createSkipCapturingLogger } =
      await importWithFlag(true);
    const cap = createSkipCapturingLogger(makeLogger());

    expect(
      await signAndSettleDownstream(
        makeAgent({
          payment: {
            method: 'x402',
            asset: 'USDC',
            chain: 'una-chain-que-no-existe',
            contract: PAYTO_ADDR,
          },
        }),
        cap,
      ),
    ).toBeNull();
    expect(cap.lastSkipCode()).toBe('CHAIN_NOT_SUPPORTED');
  });

  it('T-P1-4e: INVALID_PAY_TO_FORMAT → capturado', async () => {
    const { signAndSettleDownstream, createSkipCapturingLogger } =
      await importWithFlag(true);
    const cap = createSkipCapturingLogger(makeLogger());

    expect(
      await signAndSettleDownstream(
        makeAgent({
          payment: {
            method: 'x402',
            asset: 'USDC',
            chain: 'avalanche',
            contract: 'no-es-una-address',
          },
        }),
        cap,
      ),
    ).toBeNull();
    expect(cap.lastSkipCode()).toBe('INVALID_PAY_TO_FORMAT');
  });

  it('T-P1-4f: INVALID_PRICE → capturado', async () => {
    const { signAndSettleDownstream, createSkipCapturingLogger } =
      await importWithFlag(true);
    const cap = createSkipCapturingLogger(makeLogger());

    expect(
      await signAndSettleDownstream(makeAgent({ priceUsdc: 0 }), cap),
    ).toBeNull();
    expect(cap.lastSkipCode()).toBe('INVALID_PRICE');
  });

  it('T-P1-4g: MAINNET_NOT_ALLOWED → capturado (y se genericiza en la respuesta)', async () => {
    const {
      signAndSettleDownstream,
      createSkipCapturingLogger,
      toPublicSkipCode,
    } = await importWithFlag(true);
    const cap = createSkipCapturingLogger(makeLogger());

    expect(
      await signAndSettleDownstream(
        makeAgent({
          payment: {
            method: 'x402',
            asset: 'USDC',
            chain: 'avalanche-mainnet',
            contract: PAYTO_ADDR,
          },
        }),
        cap,
      ),
    ).toBeNull();
    expect(cap.lastSkipCode()).toBe('MAINNET_NOT_ALLOWED');
    // La allow-list del gateway NO se filtra al caller.
    expect(toPublicSkipCode('MAINNET_NOT_ALLOWED')).toBe('NOT_CONFIGURED');
  });

  it('T-P1-4h: INSUFFICIENT_BALANCE → capturado (y se genericiza a UNAVAILABLE)', async () => {
    const {
      signAndSettleDownstream,
      createSkipCapturingLogger,
      toPublicSkipCode,
    } = await importWithFlag(true);
    mockReadContract.mockResolvedValue(1n); // operador sin fondos
    const cap = createSkipCapturingLogger(makeLogger());

    expect(await signAndSettleDownstream(makeAgent(), cap)).toBeNull();
    expect(cap.lastSkipCode()).toBe('INSUFFICIENT_BALANCE');
    // El estado de la tesorería del operador NO se filtra al caller.
    expect(toPublicSkipCode('INSUFFICIENT_BALANCE')).toBe('UNAVAILABLE');
  });

  it('T-P1-4i: SETTLE_FAILED → capturado', async () => {
    const { signAndSettleDownstream, createSkipCapturingLogger } =
      await importWithFlag(true);
    mockFujiSettle.mockResolvedValue({ success: false, error: 'boom' });
    const cap = createSkipCapturingLogger(makeLogger());

    expect(await signAndSettleDownstream(makeAgent(), cap)).toBeNull();
    expect(cap.lastSkipCode()).toBe('SETTLE_FAILED');
  });

  // P1 hallazgo 3: T-P1-4i cubre la captura sobre la rama EVM (fuji). La rama
  // SOLANA tiene su propio par de `return null` con `SETTLE_FAILED`
  // (`downstream-payment.ts:403-416`, dentro de `settleSolanaLeg`) y NINGÚN test
  // ataba su señal al contrato público — o sea que el rail Solana podía dejar de
  // reportar el motivo del leg no pagado sin romper nada.
  it('T-P1-3d: SETTLE_FAILED del rail SOLANA → capturado y expuesto VERBATIM en el contrato público', async () => {
    const {
      signAndSettleDownstream,
      createSkipCapturingLogger,
      toPublicSkipCode,
    } = await importWithFlag(true);
    mockSolanaSettledSig.mockReturnValue(undefined);
    mockSolanaBalance.mockResolvedValueOnce('1000000');
    mockSolanaSettle.mockResolvedValueOnce({
      success: false,
      error: 'cluster rejected',
    });
    const cap = createSkipCapturingLogger(makeLogger());

    const result = await signAndSettleDownstream(
      makeAgent({
        priceUsdc: 0.5,
        payment: {
          method: 'x402',
          asset: 'USDC',
          chain: 'solana-devnet',
          contract: SOL_PAYTO,
        },
      }),
      cap,
    );

    expect(result).toBeNull(); // no se cobra
    expect(cap.lastSkipCode()).toBe('SETTLE_FAILED');
    // Resultado TERMINAL de pago ⇒ el caller lo ve tal cual (no se genericiza).
    expect(toPublicSkipCode('SETTLE_FAILED')).toBe('SETTLE_FAILED');
  });

  it('T-P1-4j: VERIFY_FAILED → capturado (se genericiza a SETTLE_FAILED)', async () => {
    const {
      signAndSettleDownstream,
      createSkipCapturingLogger,
      toPublicSkipCode,
    } = await importWithFlag(true);
    mockFujiVerify.mockResolvedValue({ valid: false, error: 'nope' });
    const cap = createSkipCapturingLogger(makeLogger());

    expect(await signAndSettleDownstream(makeAgent(), cap)).toBeNull();
    expect(cap.lastSkipCode()).toBe('VERIFY_FAILED');
    expect(toPublicSkipCode('VERIFY_FAILED')).toBe('SETTLE_FAILED');
  });

  it('T-P1-4k: un leg EXITOSO no deja un skip-code terminal (la señal no se emite)', async () => {
    const { signAndSettleDownstream, createSkipCapturingLogger } =
      await importWithFlag(true);
    const cap = createSkipCapturingLogger(makeLogger());

    const result = await signAndSettleDownstream(makeAgent(), cap);

    expect(result).toEqual({ txHash: '0xFUJI', settledAmount: '500000' });
    // compose sólo consulta el código cuando el resultado es null, pero además
    // acá no se logueó ningún code: el happy path queda limpio.
    expect(cap.lastSkipCode()).toBeUndefined();
  });

  it('T-P1-4l: el decorador NO altera el log del money-path (delegación byte-idéntica)', async () => {
    const { signAndSettleDownstream, createSkipCapturingLogger } =
      await importWithFlag(true);
    const inner = makeLogger();
    const cap = createSkipCapturingLogger(inner);

    await signAndSettleDownstream(makeAgent({ priceUsdc: 0 }), cap);

    // El logger interno recibió el MISMO payload que recibiría sin decorador.
    expect(inner.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INVALID_PRICE', priceUsdc: 0 }),
      expect.any(String),
    );
  });
});
