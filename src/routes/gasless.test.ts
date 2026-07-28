/**
 * Tests for POST /gasless/transfer (WKH-59 / SEC-DRAIN-1).
 *
 * Cobertura:
 *   T-DRAIN-1: happy path — value=$5, key budget $100 → 200, debit $5
 *   T-DRAIN-2: cap exceeded — value=$50 > cap $10 → 403 PER_CALL_LIMIT
 *   T-DRAIN-3: insufficient budget — value=$5, key budget $1 → 403
 *   T-DRAIN-4: daily limit — value=$5, daily_limit=$2 → 403 DAILY_LIMIT
 *   T-DRAIN-5: missing fields — body sin to/value → 400
 *   T-DRAIN-6: invalid bigint — value="not-a-number" → 400
 *   T-DRAIN-7: success log — verifica request.log.info structured payload
 *   T-DRAIN-8: cap boundary — value === cap → 200 (no excede)
 *
 * Mocks: identityService, budgetService, getGaslessAdapter (CD-15).
 */

import crypto from 'node:crypto';
import Fastify from 'fastify';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { A2AAgentKeyRow } from '../types/index.js';

// ── Mocks (definidos ANTES del import del SUT) ─────────────

vi.mock('../services/identity.js', () => ({
  identityService: {
    createKey: vi.fn(),
    lookupByHash: vi.fn(),
    deactivate: vi.fn(),
  },
  // WKH-100: middleware imports this derived helper (AC-6/DT-17).
  isIdentityVerified: (row: { erc8004_identity?: unknown } | null) =>
    row?.erc8004_identity != null,
}));

vi.mock('../services/budget.js', () => ({
  budgetService: {
    getBalance: vi.fn(),
    debit: vi.fn(),
    registerDeposit: vi.fn(),
    // HU-192: la ruta reembolsa el débito cuando el transfer no ocurre.
    credit: vi.fn(),
    creditDelegation: vi.fn(),
    creditSession: vi.fn(),
  },
}));

// HU-192: el refund best-effort encola en el outbox si el credit no revierte
// nada. Mockeado para que ningún test toque supabase.
vi.mock('../services/refund-outbox.js', () => ({
  refundOutbox: {
    enqueueRefund: vi.fn().mockResolvedValue(undefined),
    processRefundOutbox: vi.fn().mockResolvedValue(undefined),
  },
}));

const mockGaslessTransfer = vi.fn();
const mockGaslessStatus = vi.fn();

vi.mock('../adapters/registry.js', () => {
  // WKH-MULTICHAIN W2 + WKH-138: middleware AND the route use
  // getAdaptersBundle/getDefaultChainKey/getInitializedChainKeys to resolve the
  // chain per-request. Default chain = kite-ozone-testnet (2368). The registry
  // is chain-aware: only these three keys are "initialized"; any other valid
  // slug (e.g. base-mainnet) → undefined bundle → 400 CHAIN_NOT_SUPPORTED.
  const bundles: Record<
    string,
    {
      chainConfig: { name: string; chainId: number; explorerUrl: string };
      payment: {
        supportedTokens: {
          symbol: string;
          address: `0x${string}`;
          decimals: number;
        }[];
      };
    }
  > = {
    'kite-ozone-testnet': {
      chainConfig: {
        name: 'eip155:2368',
        chainId: 2368,
        explorerUrl: 'https://explorer.test',
      },
      payment: {
        supportedTokens: [
          {
            symbol: 'PYUSD',
            address:
              '0x0000000000000000000000000000000000000000' as `0x${string}`,
            decimals: 6,
          },
        ],
      },
    },
    'avalanche-fuji': {
      chainConfig: {
        name: 'Avalanche Fuji',
        chainId: 43113,
        explorerUrl: 'https://testnet.snowtrace.io',
      },
      payment: {
        supportedTokens: [
          {
            symbol: 'USDC',
            address:
              '0x5425890298aed601595a70AB815c96711a31Bc65' as `0x${string}`,
            decimals: 6,
          },
        ],
      },
    },
    'base-sepolia': {
      chainConfig: {
        name: 'Base Sepolia',
        chainId: 84532,
        explorerUrl: 'https://sepolia.basescan.org',
      },
      payment: {
        supportedTokens: [
          {
            symbol: 'USDC',
            address:
              '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`,
            decimals: 6,
          },
        ],
      },
    },
  };
  return {
    getGaslessAdapter: vi.fn(() => ({
      status: mockGaslessStatus,
      transfer: mockGaslessTransfer,
    })),
    getPaymentAdapter: vi.fn(() => ({
      name: 'mock',
      chainId: 2368,
      supportedTokens: [],
      getScheme: () => 'exact',
      getNetwork: () => 'eip155:2368',
      getToken: () => '0x0000000000000000000000000000000000000000' as const,
      getMaxTimeoutSeconds: () => 60,
      getMerchantName: () => 'WasiAI Test',
      settle: vi.fn(),
      verify: vi.fn(),
      quote: vi.fn().mockResolvedValue({
        amountWei: '1000000',
        token: { symbol: 'PYUSD', address: '0x0', decimals: 6 },
        facilitatorUrl: '',
      }),
      sign: vi.fn(),
    })),
    getChainConfig: vi.fn(() => ({
      name: 'eip155:2368',
      chainId: 2368,
      explorerUrl: 'https://explorer.test',
    })),
    getAttestationAdapter: vi.fn(),
    getIdentityBindingAdapter: vi.fn(),
    initAdapters: vi.fn(),
    _resetRegistry: vi.fn(),
    getAdaptersBundle: vi.fn(
      (key?: string) => bundles[key ?? 'kite-ozone-testnet'],
    ),
    getInitializedChainKeys: vi.fn(() => Object.keys(bundles)),
    getDefaultChainKey: vi.fn(() => 'kite-ozone-testnet'),
  };
});

import { getGaslessAdapter } from '../adapters/registry.js';
import { budgetService } from '../services/budget.js';
import { identityService } from '../services/identity.js';
import gaslessRoutes from './gasless.js';

const mockLookupByHash = vi.mocked(identityService.lookupByHash);
const mockGetBalance = vi.mocked(budgetService.getBalance);
const mockDebit = vi.mocked(budgetService.debit);
const mockCredit = vi.mocked(budgetService.credit);
const mockGetGaslessAdapter = vi.mocked(getGaslessAdapter);

// ── Helpers ────────────────────────────────────────────────

const TEST_KEY = `wasi_a2a_${'a'.repeat(64)}`;
const TEST_KEY_HASH = crypto
  .createHash('sha256')
  .update(TEST_KEY)
  .digest('hex');
const TEST_KEY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TEST_TO = '0x1234567890123456789012345678901234567890';

function makeKeyRow(overrides: Partial<A2AAgentKeyRow> = {}): A2AAgentKeyRow {
  return {
    id: TEST_KEY_ID,
    owner_ref: 'user-1',
    key_hash: TEST_KEY_HASH,
    display_name: 'Test Key',
    budget: { '2368': '100.000000' },
    daily_limit_usd: null,
    daily_spent_usd: '0.000000',
    daily_reset_at: new Date(Date.now() + 86400000).toISOString(),
    allowed_registries: null,
    allowed_agent_slugs: null,
    allowed_categories: null,
    max_spend_per_call_usd: null,
    is_active: true,
    last_used_at: null,
    created_at: '2026-04-06T12:00:00.000Z',
    updated_at: '2026-04-06T12:00:00.000Z',
    erc8004_identity: null,
    kite_passport: null,
    agentkit_wallet: null,
    funding_wallet: null,
    metadata: {},
    require_signature: false,
    ...overrides,
  };
}

// ── Setup ──────────────────────────────────────────────────

describe('POST /gasless/transfer (WKH-59 SEC-DRAIN-1)', () => {
  let app: ReturnType<typeof Fastify>;
  let originalCap: string | undefined;
  let originalRate: string | undefined;

  beforeAll(async () => {
    originalCap = process.env.GASLESS_DEFAULT_CAP_USD;
    originalRate = process.env.PYUSD_USD_RATE;
    process.env.GASLESS_DEFAULT_CAP_USD = '10';
    process.env.PYUSD_USD_RATE = '1.0';

    app = Fastify();
    await app.register(gaslessRoutes, { prefix: '/gasless' });
    await app.ready();
  });

  afterAll(async () => {
    if (originalCap === undefined) delete process.env.GASLESS_DEFAULT_CAP_USD;
    else process.env.GASLESS_DEFAULT_CAP_USD = originalCap;
    if (originalRate === undefined) delete process.env.PYUSD_USD_RATE;
    else process.env.PYUSD_USD_RATE = originalRate;
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // default: gasless module ready
    mockGaslessStatus.mockResolvedValue({ funding_state: 'ready' });
    mockGaslessTransfer.mockResolvedValue({ txHash: '0xabc123' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── T-DRAIN-1: happy path ─────────────────────────────────

  it('T-DRAIN-1: value=$5 (5_000_000 wei), key budget $100 → 200 + debit $5', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockDebit.mockResolvedValue({ success: true });
    mockGetBalance.mockResolvedValue('95.000000');

    const response = await app.inject({
      method: 'POST',
      url: '/gasless/transfer',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: { to: TEST_TO, value: '5000000' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().txHash).toBe('0xabc123');
    // AC-1 — debit usa el valor REAL ($5), NO el placeholder $1.
    expect(mockDebit).toHaveBeenCalledWith(
      TEST_KEY_ID,
      2368,
      5,
      undefined,
      undefined,
      undefined,
      'user-1', // F-04 (audit): threaded caller owner_ref
    );
    expect(mockGaslessTransfer).toHaveBeenCalledTimes(1);
  });

  // ── T-DRAIN-2: cap exceeded ───────────────────────────────

  it('T-DRAIN-2: value=$50 > cap $10 → 403 PER_CALL_LIMIT, NO transfer', async () => {
    // No setup de mocks de identity/budget: el preHandler Stage A debe
    // bloquear ANTES de llegar a Stage B (requirePaymentOrA2AKey).
    const response = await app.inject({
      method: 'POST',
      url: '/gasless/transfer',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: { to: TEST_TO, value: '50000000' }, // $50
    });

    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.error_code).toBe('PER_CALL_LIMIT');
    expect(body.cap_usd).toBe(10);
    expect(body.requested_usd).toBe(50);
    expect(mockLookupByHash).not.toHaveBeenCalled();
    expect(mockDebit).not.toHaveBeenCalled();
    expect(mockGaslessTransfer).not.toHaveBeenCalled();
  });

  // ── T-DRAIN-3: insufficient budget ────────────────────────

  it('T-DRAIN-3: value=$5, key budget $1 → 403 INSUFFICIENT_BUDGET', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockDebit.mockResolvedValue({
      success: false,
      error: 'Insufficient budget',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/gasless/transfer',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: { to: TEST_TO, value: '5000000' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error_code).toBe('INSUFFICIENT_BUDGET');
    // El debit se intentó con el valor real ($5), no con $1.
    expect(mockDebit).toHaveBeenCalledWith(
      TEST_KEY_ID,
      2368,
      5,
      undefined,
      undefined,
      undefined,
      'user-1', // F-04 (audit): threaded caller owner_ref
    );
    // DT-F: NO se llama al adapter post-debit-fail.
    expect(mockGaslessTransfer).not.toHaveBeenCalled();
  });

  // ── T-DRAIN-4: daily limit ────────────────────────────────

  it('T-DRAIN-4: value=$5, daily_limit=$2 (already spent) → 403 DAILY_LIMIT', async () => {
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({
        daily_limit_usd: '2.000000',
        daily_spent_usd: '2.000000',
        daily_reset_at: new Date(Date.now() + 86400000).toISOString(),
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/gasless/transfer',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: { to: TEST_TO, value: '5000000' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error_code).toBe('DAILY_LIMIT');
    expect(mockGaslessTransfer).not.toHaveBeenCalled();
  });

  // ── T-DRAIN-5: missing fields ─────────────────────────────

  it('T-DRAIN-5: body sin to/value → 400 antes del middleware', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/gasless/transfer',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: { to: TEST_TO }, // missing value
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('missing required fields');
    expect(mockLookupByHash).not.toHaveBeenCalled();
  });

  // ── T-DRAIN-6: invalid bigint ─────────────────────────────

  it('T-DRAIN-6: value="not-a-number" → 400 invalid bigint', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/gasless/transfer',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: { to: TEST_TO, value: 'not-a-number' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain('invalid value');
    expect(mockLookupByHash).not.toHaveBeenCalled();
  });

  // ── T-DRAIN-7: success log ────────────────────────────────

  it('T-DRAIN-7: éxito → log estructurado con keyId/estimatedCostUsd/actualValueWei/to/txHash', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockDebit.mockResolvedValue({ success: true });
    mockGetBalance.mockResolvedValue('95.000000');

    const logSpy = vi.spyOn(app.log, 'info');

    const response = await app.inject({
      method: 'POST',
      url: '/gasless/transfer',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: { to: TEST_TO, value: '5000000' },
    });

    expect(response.statusCode).toBe(200);

    // Verificar que existe AL MENOS un log con la firma esperada.
    const matchingCall = logSpy.mock.calls.find(
      (call) => call[1] === 'gasless transfer executed',
    );
    expect(matchingCall).toBeDefined();
    if (!matchingCall) return; // type-narrowing
    const payload = matchingCall[0] as Record<string, unknown>;
    expect(payload.keyId).toBe(TEST_KEY_ID);
    expect(payload.estimatedCostUsd).toBe(5);
    expect(payload.actualValueWei).toBe('5000000');
    expect(payload.to).toBe(TEST_TO);
    expect(payload.txHash).toBe('0xabc123');
  });

  // ── T-DRAIN-8: cap boundary ───────────────────────────────

  it('T-DRAIN-8: value === cap ($10 exact) → 200 (no excede)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockDebit.mockResolvedValue({ success: true });
    mockGetBalance.mockResolvedValue('90.000000');

    const response = await app.inject({
      method: 'POST',
      url: '/gasless/transfer',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: { to: TEST_TO, value: '10000000' }, // $10 exact
    });

    expect(response.statusCode).toBe(200);
    expect(mockDebit).toHaveBeenCalledWith(
      TEST_KEY_ID,
      2368,
      10,
      undefined,
      undefined,
      undefined,
      'user-1', // F-04 (audit): threaded caller owner_ref
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// WKH-138 — chain-aware routing (x-payment-chain → Avalanche/Base gasless)
// ══════════════════════════════════════════════════════════════════════════

describe('POST /gasless/transfer — chain-aware (WKH-138)', () => {
  let app: ReturnType<typeof Fastify>;
  let originalCap: string | undefined;
  let originalPyusd: string | undefined;
  let originalUsdc: string | undefined;

  beforeAll(async () => {
    originalCap = process.env.GASLESS_DEFAULT_CAP_USD;
    originalPyusd = process.env.PYUSD_USD_RATE;
    originalUsdc = process.env.USDC_USD_RATE;
    process.env.GASLESS_DEFAULT_CAP_USD = '10';
    process.env.PYUSD_USD_RATE = '1.0';
    process.env.USDC_USD_RATE = '1.0';

    app = Fastify();
    await app.register(gaslessRoutes, { prefix: '/gasless' });
    await app.ready();
  });

  afterAll(async () => {
    if (originalCap === undefined) delete process.env.GASLESS_DEFAULT_CAP_USD;
    else process.env.GASLESS_DEFAULT_CAP_USD = originalCap;
    if (originalPyusd === undefined) delete process.env.PYUSD_USD_RATE;
    else process.env.PYUSD_USD_RATE = originalPyusd;
    if (originalUsdc === undefined) delete process.env.USDC_USD_RATE;
    else process.env.USDC_USD_RATE = originalUsdc;
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockGaslessStatus.mockResolvedValue({ funding_state: 'ready' });
    mockGaslessTransfer.mockResolvedValue({ txHash: '0xavax01' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── T-AC1-ROUTE: x-payment-chain avalanche-fuji → 200 { txHash } ──────────
  it('T-AC1-ROUTE: header avalanche-fuji → 200, routes to that chain adapter', async () => {
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({ budget: { '43113': '100.000000' } }),
    );
    mockDebit.mockResolvedValue({ success: true });
    mockGetBalance.mockResolvedValue('95.000000');

    const response = await app.inject({
      method: 'POST',
      url: '/gasless/transfer',
      headers: { 'x-a2a-key': TEST_KEY, 'x-payment-chain': 'avalanche-fuji' },
      payload: { to: TEST_TO, value: '5000000' }, // 5 USDC = $5 < cap $10
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().txHash).toBe('0xavax01');
    // CD-3: the handler resolved + used the avalanche-fuji chainKey.
    expect(mockGetGaslessAdapter).toHaveBeenCalledWith('avalanche-fuji');
    expect(mockGaslessTransfer).toHaveBeenCalledTimes(1);
  });

  // ── T-AC2-ROUTE: value > cap on USDC chain → 403 PER_CALL_LIMIT, no debit ──
  it('T-AC2-ROUTE: avalanche-fuji value $50 > cap $10 → 403 PER_CALL_LIMIT, no transfer', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/gasless/transfer',
      headers: { 'x-a2a-key': TEST_KEY, 'x-payment-chain': 'avalanche-fuji' },
      payload: { to: TEST_TO, value: '50000000' }, // $50
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error_code).toBe('PER_CALL_LIMIT');
    expect(response.json().requested_usd).toBe(50);
    expect(mockLookupByHash).not.toHaveBeenCalled();
    expect(mockDebit).not.toHaveBeenCalled();
    expect(mockGaslessTransfer).not.toHaveBeenCalled();
  });

  // ── T-AC3-ROUTE: funding_state != ready → 503 gasless_not_operational ─────
  it('T-AC3-ROUTE: base-sepolia funding_state unfunded → 503', async () => {
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({ budget: { '84532': '100.000000' } }),
    );
    mockDebit.mockResolvedValue({ success: true });
    mockGetBalance.mockResolvedValue('95.000000');
    mockGaslessStatus.mockResolvedValue({ funding_state: 'unfunded' });
    mockCredit.mockResolvedValue({ success: true, reverted: true });

    const response = await app.inject({
      method: 'POST',
      url: '/gasless/transfer',
      headers: { 'x-a2a-key': TEST_KEY, 'x-payment-chain': 'base-sepolia' },
      payload: { to: TEST_TO, value: '5000000' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('gasless_not_operational');
    expect(mockGaslessTransfer).not.toHaveBeenCalled();
    // HU-192: el débito se aplicó y no hubo transfer → credit-back del monto
    // exacto, con el owner_ref del caller (ownership guard).
    expect(mockCredit).toHaveBeenCalledWith(TEST_KEY_ID, 84532, 5, 'user-1', {
      // HU-194: clave del refund LÓGICO.
      idemKey: expect.any(String),
    });
  });

  // ── T-CHAIN-BAD: unrecognized slug → 400 CHAIN_NOT_SUPPORTED ──────────────
  it('T-CHAIN-BAD: x-payment-chain solana → 400 CHAIN_NOT_SUPPORTED', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/gasless/transfer',
      headers: { 'x-a2a-key': TEST_KEY, 'x-payment-chain': 'solana' },
      payload: { to: TEST_TO, value: '5000000' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error_code).toBe('CHAIN_NOT_SUPPORTED');
    expect(mockLookupByHash).not.toHaveBeenCalled();
    expect(mockGaslessTransfer).not.toHaveBeenCalled();
  });

  // ── T-CHAIN-BAD: valid slug but not initialized → 400 + initialized list ──
  it('T-CHAIN-BAD: base-mainnet valid slug but not initialized → 400 + list', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/gasless/transfer',
      headers: { 'x-a2a-key': TEST_KEY, 'x-payment-chain': 'base-mainnet' },
      payload: { to: TEST_TO, value: '5000000' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error_code).toBe('CHAIN_NOT_SUPPORTED');
    expect(response.json().error).toContain('is not initialized');
    expect(mockGaslessTransfer).not.toHaveBeenCalled();
  });

  // ── T-REGR-ROUTE: no header → Kite default byte-identical ─────────────────
  it('T-REGR-ROUTE: no header → routes to Kite default (byte-identical), 200', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockDebit.mockResolvedValue({ success: true });
    mockGetBalance.mockResolvedValue('95.000000');

    const response = await app.inject({
      method: 'POST',
      url: '/gasless/transfer',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: { to: TEST_TO, value: '5000000' },
    });

    expect(response.statusCode).toBe(200);
    // CD-4: default chain = kite-ozone-testnet.
    expect(mockGetGaslessAdapter).toHaveBeenCalledWith('kite-ozone-testnet');
  });
});

// ── GET /gasless/status — chain-aware (WKH-138) ────────────────────────────

describe('GET /gasless/status — chain-aware (WKH-138)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(gaslessRoutes, { prefix: '/gasless' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── T-AC4-ROUTE: GET status with header → status of that chain ────────────
  it('T-AC4-ROUTE: header avalanche-fuji → status of that chain', async () => {
    mockGaslessStatus.mockResolvedValue({
      enabled: true,
      network: 'avalanche-fuji',
      funding_state: 'ready',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/gasless/status',
      headers: { 'x-payment-chain': 'avalanche-fuji' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().network).toBe('avalanche-fuji');
    expect(mockGetGaslessAdapter).toHaveBeenCalledWith('avalanche-fuji');
  });

  it('T-AC4-ROUTE: no header → status of Kite default', async () => {
    mockGaslessStatus.mockResolvedValue({
      enabled: false,
      network: 'kite-testnet',
      funding_state: 'disabled',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/gasless/status',
    });

    expect(response.statusCode).toBe(200);
    expect(mockGetGaslessAdapter).toHaveBeenCalledWith('kite-ozone-testnet');
  });

  it('T-CHAIN-BAD: GET status with solana → 400 CHAIN_NOT_SUPPORTED', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/gasless/status',
      headers: { 'x-payment-chain': 'solana' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error_code).toBe('CHAIN_NOT_SUPPORTED');
  });
});
