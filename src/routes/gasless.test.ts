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
}));

vi.mock('../services/budget.js', () => ({
  budgetService: {
    getBalance: vi.fn(),
    debit: vi.fn(),
    registerDeposit: vi.fn(),
  },
}));

const mockGaslessTransfer = vi.fn();
const mockGaslessStatus = vi.fn();

vi.mock('../adapters/registry.js', () => {
  // WKH-MULTICHAIN W2: middleware uses getAdaptersBundle/getDefaultChainKey to
  // resolve chainId per-request. Default chain = kite-ozone-testnet (2368).
  const kiteBundle = {
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
    getAdaptersBundle: vi.fn(() => kiteBundle),
    getInitializedChainKeys: vi.fn(() => ['kite-ozone-testnet']),
    getDefaultChainKey: vi.fn(() => 'kite-ozone-testnet'),
  };
});

import { budgetService } from '../services/budget.js';
import { identityService } from '../services/identity.js';
import gaslessRoutes from './gasless.js';

const mockLookupByHash = vi.mocked(identityService.lookupByHash);
const mockGetBalance = vi.mocked(budgetService.getBalance);
const mockDebit = vi.mocked(budgetService.debit);

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
    expect(mockDebit).toHaveBeenCalledWith(TEST_KEY_ID, 2368, 5);
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
    expect(mockDebit).toHaveBeenCalledWith(TEST_KEY_ID, 2368, 5);
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
    expect(mockDebit).toHaveBeenCalledWith(TEST_KEY_ID, 2368, 10);
  });
});
