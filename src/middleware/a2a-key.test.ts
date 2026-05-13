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

// WKH-MULTICHAIN W2: registry mock exposes multi-chain Map + new getters.
// `getAdaptersBundle(chainKey)` returns a per-chain bundle with chainConfig +
// payment.supportedTokens, so the middleware can resolve the right chainId
// and asset_symbol for structured logs (CD-7).
type MockChainKey =
  | 'kite-ozone-testnet'
  | 'avalanche-fuji'
  | 'avalanche-mainnet';

type MockBundle = {
  chainConfig: { name: string; chainId: number; explorerUrl: string };
  payment: {
    supportedTokens: ReadonlyArray<{
      symbol: string;
      address: `0x${string}`;
      decimals: number;
    }>;
  };
};

const MOCK_BUNDLES: Record<MockChainKey, MockBundle> = {
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
          address: '0x1111111111111111111111111111111111111111',
          decimals: 6,
        },
      ],
    },
  },
  'avalanche-fuji': {
    chainConfig: {
      name: 'eip155:43113',
      chainId: 43113,
      explorerUrl: 'https://testnet.snowtrace.io',
    },
    payment: {
      supportedTokens: [
        {
          symbol: 'USDC',
          address: '0x2222222222222222222222222222222222222222',
          decimals: 6,
        },
      ],
    },
  },
  'avalanche-mainnet': {
    chainConfig: {
      name: 'eip155:43114',
      chainId: 43114,
      explorerUrl: 'https://snowtrace.io',
    },
    payment: {
      supportedTokens: [
        {
          symbol: 'USDC',
          address: '0x3333333333333333333333333333333333333333',
          decimals: 6,
        },
      ],
    },
  },
};

// Mutable test state — controlled per-test via `setMockRegistryState`.
let mockInitializedChains: MockChainKey[] = ['kite-ozone-testnet'];
let mockDefaultChain: MockChainKey | null = 'kite-ozone-testnet';

function setMockRegistryState(
  initialized: MockChainKey[],
  defaultChain: MockChainKey | null = initialized[0] ?? null,
): void {
  mockInitializedChains = [...initialized];
  mockDefaultChain = defaultChain;
}

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
  getAdaptersBundle: vi.fn((chainKey?: MockChainKey) => {
    const key = chainKey ?? mockDefaultChain;
    if (!key) return undefined;
    if (!mockInitializedChains.includes(key)) return undefined;
    return MOCK_BUNDLES[key];
  }),
  getInitializedChainKeys: vi.fn(() => [...mockInitializedChains]),
  getDefaultChainKey: vi.fn(() => mockDefaultChain),
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
    // Reset registry mock to default single-chain state (CD-2 byte-identical).
    setMockRegistryState(['kite-ozone-testnet'], 'kite-ozone-testnet');
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
    // AC-8 (W2): error path enriches message with target chainId + balance.
    mockGetBalance.mockResolvedValue('0');

    const response = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error_code).toBe('INSUFFICIENT_BUDGET');
    // AC-8: message includes the target chainId.
    expect(response.json().error).toBe('chain 2368 balance is 0');
  });

  it('REGRESSION-WKH-61: key with allowed_registries no longer 403s at middleware level', async () => {
    // WKH-61 fix: middleware ya no chequea scope; eso vive en composeService post-resolve.
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({ allowed_registries: ['morpheus'] }),
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
    // AC-8 (W2): error path enriches message with target chainId + balance.
    mockGetBalance.mockResolvedValue('0');

    const response = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error_code).toBe('INSUFFICIENT_BUDGET');
    // WKH-MULTICHAIN W2: message now includes target chainId (AC-8) instead of
    // the raw PG error. The error is logged via request.log.warn but does not
    // leak to the client.
    expect(response.json().error).toBe('chain 2368 balance is 0');
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

  // ── WKH-MULTICHAIN W2: chain resolver per-request ─────────────

  describe('WKH-MULTICHAIN W2 — chain resolver per-request', () => {
    beforeEach(() => {
      // Multi-chain init: kite-ozone-testnet (default) + avalanche-fuji.
      setMockRegistryState(
        ['kite-ozone-testnet', 'avalanche-fuji'],
        'kite-ozone-testnet',
      );
    });

    // ── AC-4: header slug routes debit to target chain ─────────

    it('AC-4: x-payment-chain: avalanche-fuji → debit on chainId 43113', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());
      mockDebit.mockResolvedValue({ success: true });
      mockGetBalance.mockResolvedValue('5.000000');

      const response = await app.inject({
        method: 'POST',
        url: '/test',
        headers: {
          'x-a2a-key': TEST_KEY,
          'x-payment-chain': 'avalanche-fuji',
        },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(mockDebit).toHaveBeenCalledWith(TEST_KEY_ID, 43113, 1.0);
      expect(mockDebit).toHaveBeenCalledTimes(1);
    });

    // ── AC-4-bis: numeric chainId in header is normalised ───────

    it('AC-4-bis: x-payment-chain: 43113 (numeric) → debit on chainId 43113', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());
      mockDebit.mockResolvedValue({ success: true });
      mockGetBalance.mockResolvedValue('5.000000');

      const response = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { 'x-a2a-key': TEST_KEY, 'x-payment-chain': '43113' },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      expect(mockDebit).toHaveBeenCalledWith(TEST_KEY_ID, 43113, 1.0);
    });

    // ── AC-5/AC-6: no header → registry default ────────────────

    it('AC-5/AC-6: no x-payment-chain header → debit on default chain (kite-ozone-testnet)', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());
      mockDebit.mockResolvedValue({ success: true });
      mockGetBalance.mockResolvedValue('9.000000');

      const response = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { 'x-a2a-key': TEST_KEY },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      // Default chain = kite-ozone-testnet → chainId 2368.
      expect(mockDebit).toHaveBeenCalledWith(TEST_KEY_ID, 2368, 1.0);
    });

    // ── AC-7: unrecognised slug → 400 CHAIN_NOT_SUPPORTED ──────

    it('AC-7: x-payment-chain: ethereum-mainnet (unknown) → 400 CHAIN_NOT_SUPPORTED', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());

      const response = await app.inject({
        method: 'POST',
        url: '/test',
        headers: {
          'x-a2a-key': TEST_KEY,
          'x-payment-chain': 'ethereum-mainnet',
        },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error_code).toBe('CHAIN_NOT_SUPPORTED');
      expect(response.json().error).toContain(
        "is not a recognized slug or chainId",
      );
      // CD-5: no debit attempted when chain resolution fails.
      expect(mockDebit).not.toHaveBeenCalled();
    });

    // ── AC-7-bis: recognised but not initialised → 400 with list ─

    it('AC-7-bis: x-payment-chain: avalanche-mainnet but registry init only fuji → 400 with Initialized list (DT-C)', async () => {
      // Override: only fuji + testnet initialised; avalanche-mainnet recognised
      // by the resolver but missing from the Map.
      setMockRegistryState(
        ['kite-ozone-testnet', 'avalanche-fuji'],
        'kite-ozone-testnet',
      );
      mockLookupByHash.mockResolvedValue(makeKeyRow());

      const response = await app.inject({
        method: 'POST',
        url: '/test',
        headers: {
          'x-a2a-key': TEST_KEY,
          'x-payment-chain': 'avalanche-mainnet',
        },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error_code).toBe('CHAIN_NOT_SUPPORTED');
      expect(response.json().error).toContain('is not initialized');
      expect(response.json().error).toContain(
        'kite-ozone-testnet, avalanche-fuji',
      );
      expect(mockDebit).not.toHaveBeenCalled();
    });

    // ── AC-11: structured log shape on debit ───────────────────

    it('AC-11: debit emits structured log with chainKey, chainId, asset_symbol', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());
      mockDebit.mockResolvedValue({ success: true });
      mockGetBalance.mockResolvedValue('5.000000');

      // Build a fresh app with a logger spy.
      const appLog = Fastify();
      const logInfoSpy = vi.fn();
      appLog.addHook('preHandler', async (req: FastifyRequest) => {
        req.log.info = logInfoSpy as unknown as FastifyRequest['log']['info'];
      });
      appLog.post(
        '/test-log',
        {
          preHandler: requirePaymentOrA2AKey({
            description: 'Log shape test',
          }),
        },
        async (_req: FastifyRequest, reply: FastifyReply) =>
          reply.send({ ok: true }),
      );
      await appLog.ready();

      const response = await appLog.inject({
        method: 'POST',
        url: '/test-log',
        headers: {
          'x-a2a-key': TEST_KEY,
          'x-payment-chain': 'avalanche-fuji',
        },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      // CD-7: log entry shape includes chainKey + chainId + asset_symbol.
      const debitLogCall = logInfoSpy.mock.calls.find(
        (c) => c[1] === 'a2a-key.debit',
      );
      expect(debitLogCall).toBeDefined();
      const [logFields, logMsg] = debitLogCall ?? [];
      expect(logMsg).toBe('a2a-key.debit');
      expect(logFields).toMatchObject({
        keyId: TEST_KEY_ID,
        chainKey: 'avalanche-fuji',
        chainId: 43113,
        asset_symbol: 'USDC',
        amountUsd: 1.0,
      });

      await appLog.close();
    });

    // ── AC-9 / CD-5: single debit per request (no double-debit) ─

    it('AC-9 / CD-5: single HTTP request → single debit call (no double-debit)', async () => {
      // Architectural guarantee: the middleware is a Fastify preHandler hook
      // that runs ONCE per HTTP request. A /compose request with multiple
      // pipeline steps still triggers a single debit at the gateway boundary
      // (steps are fan-out from the same request). This test pins that
      // contract: even with overrides + multi-chain init, exactly ONE
      // budgetService.debit call is observable per request.
      mockLookupByHash.mockResolvedValue(makeKeyRow());
      mockDebit.mockResolvedValue({ success: true });
      mockGetBalance.mockResolvedValue('9.000000');

      const response = await app.inject({
        method: 'POST',
        url: '/test',
        headers: {
          'x-a2a-key': TEST_KEY,
          'x-payment-chain': 'avalanche-fuji',
        },
        // Simulate a compose-like body with multiple steps — middleware MUST
        // ignore steps[] and debit once at the gateway. CD-7: middleware does
        // not read request.body for chain decisions.
        payload: {
          steps: [
            { agent: 'agent-a' },
            { agent: 'agent-b' },
            { agent: 'agent-c' },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      // CD-5: never two chains debited for the same request.
      expect(mockDebit).toHaveBeenCalledTimes(1);
      // Debit happened on the target chain only (43113), never on default 2368.
      expect(mockDebit).toHaveBeenCalledWith(TEST_KEY_ID, 43113, 1.0);
      expect(mockDebit).not.toHaveBeenCalledWith(
        TEST_KEY_ID,
        2368,
        expect.anything(),
      );
    });

    // ── AC-8 cross-chain: budget on chain X, request on chain Y ─

    it('AC-8: debit fails on target chain → 403 with chain <chainId> balance message', async () => {
      // Key has budget on 2368 (default chain) but request targets 43113.
      mockLookupByHash.mockResolvedValue(
        makeKeyRow({ budget: { '2368': '10.000000', '43113': '0' } }),
      );
      mockDebit.mockResolvedValue({
        success: false,
        error: 'Insufficient budget on chainId 43113',
      });
      mockGetBalance.mockResolvedValue('0');

      const response = await app.inject({
        method: 'POST',
        url: '/test',
        headers: {
          'x-a2a-key': TEST_KEY,
          'x-payment-chain': 'avalanche-fuji',
        },
        payload: {},
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error_code).toBe('INSUFFICIENT_BUDGET');
      // AC-8: target chainId in the message (not the original 2368 default).
      expect(response.json().error).toBe('chain 43113 balance is 0');
      // CD-12: debit AND getBalance read chainId from the same bundle (43113).
      expect(mockDebit).toHaveBeenCalledWith(TEST_KEY_ID, 43113, 1.0);
      expect(mockGetBalance).toHaveBeenCalledWith(
        TEST_KEY_ID,
        43113,
        'user-1',
      );
    });
  });

  // ── WKH-59: cost estimation injection ────────────────────────

  describe('WKH-59 cost estimation injection', () => {
    let appB: ReturnType<typeof Fastify>;

    beforeAll(async () => {
      appB = Fastify();

      // Ruta SIN preHandler upstream → middleware debe usar placeholder $1.
      appB.post(
        '/test-legacy',
        {
          preHandler: requirePaymentOrA2AKey({
            description: 'legacy route without cost injection',
          }),
        },
        async (_req: FastifyRequest, reply: FastifyReply) =>
          reply.send({ ok: true }),
      );

      // Ruta CON preHandler upstream que inyecta gaslessEstimatedCostUsd=5.
      appB.post(
        '/test-gasless-mw',
        {
          preHandler: [
            async (req: FastifyRequest) => {
              req.gaslessEstimatedCostUsd = 5;
            },
            ...requirePaymentOrA2AKey({
              description: 'route with cost injection',
            }),
          ],
        },
        async (_req: FastifyRequest, reply: FastifyReply) =>
          reply.send({ ok: true }),
      );

      await appB.ready();
    });

    afterAll(() => appB.close());

    beforeEach(() => {
      vi.clearAllMocks();
      // Reset registry mock to default single-chain state (CD-2).
      setMockRegistryState(['kite-ozone-testnet'], 'kite-ozone-testnet');
    });

    it('T-MW-GASLESS-1: ruta legacy sin gaslessEstimatedCostUsd → debita $1 placeholder (regresión)', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());
      mockDebit.mockResolvedValue({ success: true });
      mockGetBalance.mockResolvedValue('9.000000');

      const response = await appB.inject({
        method: 'POST',
        url: '/test-legacy',
        headers: { 'x-a2a-key': TEST_KEY },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      // CD-3 backward-compat: debit con placeholder $1.
      expect(mockDebit).toHaveBeenCalledWith(TEST_KEY_ID, 2368, 1.0);
    });

    it('T-MW-GASLESS-2: con gaslessEstimatedCostUsd=5 inyectado → debita $5', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());
      mockDebit.mockResolvedValue({ success: true });
      mockGetBalance.mockResolvedValue('5.000000');

      const response = await appB.inject({
        method: 'POST',
        url: '/test-gasless-mw',
        headers: { 'x-a2a-key': TEST_KEY },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      // El middleware lee request.gaslessEstimatedCostUsd y lo usa en debit.
      expect(mockDebit).toHaveBeenCalledWith(TEST_KEY_ID, 2368, 5);
    });
  });
});
