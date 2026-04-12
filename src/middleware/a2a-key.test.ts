/**
 * A2A Key Middleware Tests — WKH-34-W4
 * Tests: AC-1 (happy path), AC-2 (x402 fallback), AC-3 (error codes),
 *        AC-4 (request augmentation), AC-5 (per-call limit)
 */

import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { A2AAgentKeyRow } from '../types/index.js';

// ── Mocks ──────────────────────────────────────────────────

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

vi.mock('../adapters/registry.js', () => ({
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
  getGaslessAdapter: vi.fn(),
  getIdentityBindingAdapter: vi.fn(),
  initAdapters: vi.fn(),
  _resetRegistry: vi.fn(),
}));

import { budgetService } from '../services/budget.js';
import { identityService } from '../services/identity.js';
import { requirePaymentOrA2AKey } from './a2a-key.js';

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

function makeKeyRow(overrides: Partial<A2AAgentKeyRow> = {}): A2AAgentKeyRow {
  return {
    id: TEST_KEY_ID,
    owner_ref: 'user-1',
    key_hash: TEST_KEY_HASH,
    display_name: 'Test Key',
    budget: { '2368': '10.000000' },
    daily_limit_usd: '100.000000',
    daily_spent_usd: '5.000000',
    daily_reset_at: new Date(Date.now() + 86400000).toISOString(), // tomorrow
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
    metadata: {},
    ...overrides,
  };
}

// ── Setup ──────────────────────────────────────────────────

describe('requirePaymentOrA2AKey middleware', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();

    app.post(
      '/test',
      {
        preHandler: requirePaymentOrA2AKey({
          description: 'Test endpoint',
        }),
      },
      async (request: FastifyRequest, reply: FastifyReply) => {
        return reply.send({
          ok: true,
          a2aKeyId: request.a2aKeyRow?.id ?? null,
        });
      },
    );

    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── AC-1: Happy path ──────────────────────────────────────

  it('AC-1: valid a2a key — 200 with augmented request and remaining budget header', async () => {
    const keyRow = makeKeyRow();
    mockLookupByHash.mockResolvedValue(keyRow);
    mockDebit.mockResolvedValue({ success: true });
    // getBalance called AFTER debit to read post-debit balance
    mockGetBalance.mockResolvedValue('9.000000');

    const response = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.a2aKeyId).toBe(TEST_KEY_ID);
    expect(response.headers['x-a2a-remaining-budget']).toBe('9.000000');

    // BLQ-1/2: debit happens BEFORE response, not fire-and-forget on close
    expect(mockDebit).toHaveBeenCalledWith(TEST_KEY_ID, 2368, 1.0);
    expect(mockDebit).toHaveBeenCalledTimes(1);
  });

  // ── AC-2: x402 fallback ───────────────────────────────────

  it('AC-2: no x-a2a-key header — falls through to x402 (returns 402)', async () => {
    // Without PAYMENT_WALLET_ADDRESS set, x402 returns 503
    // With it set, returns 402. Set env to get 402 behavior.
    const prev = process.env.PAYMENT_WALLET_ADDRESS;
    process.env.PAYMENT_WALLET_ADDRESS =
      '0x1234567890123456789012345678901234567890';

    const response = await app.inject({
      method: 'POST',
      url: '/test',
      payload: {},
    });

    // x402 should return 402 since no X-Payment header
    expect(response.statusCode).toBe(402);

    process.env.PAYMENT_WALLET_ADDRESS = prev;
  });

  // ── AC-3: Error codes ─────────────────────────────────────

  it('AC-3: KEY_NOT_FOUND — key hash not in DB', async () => {
    mockLookupByHash.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error_code).toBe('KEY_NOT_FOUND');
  });

  it('AC-3: KEY_INACTIVE — key exists but is_active=false', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow({ is_active: false }));

    const response = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error_code).toBe('KEY_INACTIVE');
  });

  it('AC-3: DAILY_LIMIT — daily_spent_usd >= daily_limit_usd', async () => {
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({
        daily_limit_usd: '10.000000',
        daily_spent_usd: '10.000000',
        daily_reset_at: new Date(Date.now() + 86400000).toISOString(),
      }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error_code).toBe('DAILY_LIMIT');
  });

  it('AC-3: DAILY_LIMIT lazy reset — spent resets when past daily_reset_at', async () => {
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({
        daily_limit_usd: '10.000000',
        daily_spent_usd: '10.000000',
        daily_reset_at: new Date(Date.now() - 86400000).toISOString(), // yesterday
      }),
    );
    mockDebit.mockResolvedValue({ success: true });
    mockGetBalance.mockResolvedValue('9.000000');

    const response = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });

    // Should pass because lazy reset makes dailySpent = 0
    expect(response.statusCode).toBe(200);
  });

  it('AC-3: INSUFFICIENT_BUDGET — debit fails (insufficient funds)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockDebit.mockResolvedValue({
      success: false,
      error: 'Insufficient budget',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error_code).toBe('INSUFFICIENT_BUDGET');
  });

  it('AC-3: SCOPE_DENIED — registry not in allowed list', async () => {
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({ allowed_registries: ['morpheus'] }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error_code).toBe('SCOPE_DENIED');
  });

  // ── AC-5: PER_CALL_LIMIT ─────────────────────────────────

  it('AC-5: PER_CALL_LIMIT — max_spend_per_call_usd < estimated cost (1.0)', async () => {
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({ max_spend_per_call_usd: '0.500000' }),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error_code).toBe('PER_CALL_LIMIT');
  });

  it('AC-5: per_call_limit passes when limit >= estimated cost', async () => {
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({ max_spend_per_call_usd: '5.000000' }),
    );
    mockDebit.mockResolvedValue({ success: true });
    mockGetBalance.mockResolvedValue('9.000000');

    const response = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
  });

  // ── WKH-BEARER-AUTH: Bearer token as alternative auth ──────

  it('BEARER AC-1: Authorization: Bearer wasi_a2a_xxx (no x-a2a-key) — processes as a2a key', async () => {
    const keyRow = makeKeyRow();
    mockLookupByHash.mockResolvedValue(keyRow);
    mockDebit.mockResolvedValue({ success: true });
    mockGetBalance.mockResolvedValue('9.000000');

    const response = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().a2aKeyId).toBe(TEST_KEY_ID);
    expect(response.headers['x-a2a-remaining-budget']).toBe('9.000000');
    expect(mockLookupByHash).toHaveBeenCalledWith(TEST_KEY_HASH);
  });

  it('BEARER AC-2: both x-a2a-key and Bearer present — x-a2a-key wins', async () => {
    const keyRow = makeKeyRow();
    mockLookupByHash.mockResolvedValue(keyRow);
    mockDebit.mockResolvedValue({ success: true });
    mockGetBalance.mockResolvedValue('9.000000');

    const response = await app.inject({
      method: 'POST',
      url: '/test',
      headers: {
        'x-a2a-key': TEST_KEY,
        authorization: 'Bearer wasi_a2a_should_be_ignored',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    // Verify lookup used the x-a2a-key value, not the Bearer value
    expect(mockLookupByHash).toHaveBeenCalledWith(TEST_KEY_HASH);
  });

  it('BEARER AC-3/DT-1: Bearer without wasi_a2a_ prefix — falls through to x402', async () => {
    const prev = process.env.PAYMENT_WALLET_ADDRESS;
    process.env.PAYMENT_WALLET_ADDRESS =
      '0x1234567890123456789012345678901234567890';

    const response = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: 'Bearer some_other_token_abc123' },
      payload: {},
    });

    // Should fall through to x402 (402 since no X-Payment header)
    expect(response.statusCode).toBe(402);
    expect(mockLookupByHash).not.toHaveBeenCalled();

    process.env.PAYMENT_WALLET_ADDRESS = prev;
  });

  it('BEARER AC-5: non-Bearer scheme (Basic) — falls through to x402', async () => {
    const prev = process.env.PAYMENT_WALLET_ADDRESS;
    process.env.PAYMENT_WALLET_ADDRESS =
      '0x1234567890123456789012345678901234567890';

    const response = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
      payload: {},
    });

    expect(response.statusCode).toBe(402);
    expect(mockLookupByHash).not.toHaveBeenCalled();

    process.env.PAYMENT_WALLET_ADDRESS = prev;
  });

  it('BEARER: invalid key via Bearer — 403 KEY_NOT_FOUND', async () => {
    mockLookupByHash.mockResolvedValue(null);

    const response = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${TEST_KEY}` },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error_code).toBe('KEY_NOT_FOUND');
  });

  // ── BLQ-2: debit failure is surfaced ────────────────────────

  it('BLQ-2: debit fails → 403 INSUFFICIENT_BUDGET (not silent 200)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockDebit.mockResolvedValue({
      success: false,
      error: 'Budget debit failed',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error_code).toBe('INSUFFICIENT_BUDGET');
    expect(response.json().error).toContain('Budget debit failed');
  });

  // ── BLQ-3: lookupByHash throws → 503 ───────────────────────

  it('BLQ-3: lookupByHash throws → 503 SERVICE_ERROR', async () => {
    mockLookupByHash.mockRejectedValue(new Error('DB connection lost'));

    const response = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('SERVICE_ERROR');
  });

  // ── BLQ-3: debit rejects with error → 503 ──────────────────

  it('BLQ-3: debit rejects (throws) → 503 SERVICE_ERROR', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockDebit.mockRejectedValue(new Error('PG timeout'));

    const response = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('SERVICE_ERROR');
  });
});
