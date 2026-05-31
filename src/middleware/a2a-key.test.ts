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
  // WKH-100: middleware/auth now import this derived helper (AC-6/DT-17).
  isIdentityVerified: (row: { erc8004_identity?: unknown } | null) =>
    row?.erc8004_identity != null,
}));

vi.mock('../services/budget.js', () => ({
  budgetService: {
    getBalance: vi.fn(),
    debit: vi.fn(),
    registerDeposit: vi.fn(),
  },
}));

// WKH-101 (CD-AB-1): middleware now imports delegationService + exceedsPerTxLimit.
vi.mock('../services/delegation.js', () => ({
  delegationService: {
    lookupByTokenHash: vi.fn(),
    getParentKey: vi.fn(),
    debitDelegationAndParent: vi.fn(),
  },
  exceedsPerTxLimit: vi.fn(),
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
import {
  delegationService,
  exceedsPerTxLimit,
} from '../services/delegation.js';
import { identityService } from '../services/identity.js';
import {
  AgentKeyBudgetExhaustedError,
  DelegationTotalLimitExceededError,
} from '../services/security/errors.js';
import type { DelegationRow } from '../types/index.js';
import { requirePaymentOrA2AKey } from './a2a-key.js';

const mockLookupByHash = vi.mocked(identityService.lookupByHash);
const mockGetBalance = vi.mocked(budgetService.getBalance);
const mockDebit = vi.mocked(budgetService.debit);
const mockLookupToken = vi.mocked(delegationService.lookupByTokenHash);
const mockGetParentKey = vi.mocked(delegationService.getParentKey);
const mockDebitDelegation = vi.mocked(
  delegationService.debitDelegationAndParent,
);
const mockExceedsPerTx = vi.mocked(exceedsPerTxLimit);

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
    funding_wallet: null,
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
        'is not a recognized slug or chainId',
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
      expect(mockGetBalance).toHaveBeenCalledWith(TEST_KEY_ID, 43113, 'user-1');
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

  // ── WKH-59 (real-price-debit): compose cost estimation injection ──
  // CD-7: middleware solo lee campos augmentados, no request.body.
  // CD-9: composeEstimatedCostUsd y gaslessEstimatedCostUsd son distintos.
  // CD-14: NO usar failNext. Usar mockResolvedValueOnce chained.

  describe('WKH-59 compose cost estimation injection', () => {
    let appC: ReturnType<typeof Fastify>;

    beforeAll(async () => {
      appC = Fastify();

      // Ruta CON preHandler upstream que inyecta composeEstimatedCostUsd=0.001.
      appC.post(
        '/test-compose-mw',
        {
          preHandler: [
            async (req: FastifyRequest) => {
              req.composeEstimatedCostUsd = 0.001;
            },
            ...requirePaymentOrA2AKey({
              description: 'compose route with cost injection',
            }),
          ],
        },
        async (req: FastifyRequest, reply: FastifyReply) =>
          reply.send({
            ok: true,
            resolvedChainId: req.resolvedChainId ?? null,
          }),
      );

      // Ruta con AMBOS campos inyectados — precedence test.
      appC.post(
        '/test-both-mw',
        {
          preHandler: [
            async (req: FastifyRequest) => {
              req.composeEstimatedCostUsd = 0.05;
              req.gaslessEstimatedCostUsd = 10;
            },
            ...requirePaymentOrA2AKey({
              description: 'route with both costs injected',
            }),
          ],
        },
        async (_req: FastifyRequest, reply: FastifyReply) =>
          reply.send({ ok: true }),
      );

      // Ruta SIN inyección — placeholder fallback.
      appC.post(
        '/test-no-injection',
        {
          preHandler: requirePaymentOrA2AKey({
            description: 'route without any injection',
          }),
        },
        async (_req: FastifyRequest, reply: FastifyReply) =>
          reply.send({ ok: true }),
      );

      await appC.ready();
    });

    afterAll(() => appC.close());

    beforeEach(() => {
      vi.clearAllMocks();
      setMockRegistryState(['kite-ozone-testnet'], 'kite-ozone-testnet');
    });

    it('T-MW-COMPOSE-1 should debit composeEstimatedCostUsd when set', async () => {
      mockLookupByHash.mockResolvedValueOnce(makeKeyRow());
      mockDebit.mockResolvedValueOnce({ success: true });
      mockGetBalance.mockResolvedValueOnce('9.999000');

      const response = await appC.inject({
        method: 'POST',
        url: '/test-compose-mw',
        headers: { 'x-a2a-key': TEST_KEY },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      // AC-1: debit usa el valor real inyectado, NO el placeholder $1.
      expect(mockDebit).toHaveBeenCalledWith(TEST_KEY_ID, 2368, 0.001);
    });

    it('T-MW-COMPOSE-2 should prefer composeEstimatedCostUsd over gaslessEstimatedCostUsd when both set', async () => {
      mockLookupByHash.mockResolvedValueOnce(makeKeyRow());
      mockDebit.mockResolvedValueOnce({ success: true });
      mockGetBalance.mockResolvedValueOnce('9.950000');

      const response = await appC.inject({
        method: 'POST',
        url: '/test-both-mw',
        headers: { 'x-a2a-key': TEST_KEY },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      // DT-F: compose-first precedence. 0.05 wins over 10.
      expect(mockDebit).toHaveBeenCalledWith(TEST_KEY_ID, 2368, 0.05);
    });

    it('T-MW-COMPOSE-3 should fall back to $1 placeholder when neither field is set', async () => {
      mockLookupByHash.mockResolvedValueOnce(makeKeyRow());
      mockDebit.mockResolvedValueOnce({ success: true });
      mockGetBalance.mockResolvedValueOnce('9.000000');

      const response = await appC.inject({
        method: 'POST',
        url: '/test-no-injection',
        headers: { 'x-a2a-key': TEST_KEY },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      // AC-7: backward-compat placeholder $1 cuando ningún campo está seteado.
      expect(mockDebit).toHaveBeenCalledWith(TEST_KEY_ID, 2368, 1.0);
    });

    it('T-MW-COMPOSE-4 should augment request.resolvedChainId after bundle resolution', async () => {
      mockLookupByHash.mockResolvedValueOnce(makeKeyRow());
      mockDebit.mockResolvedValueOnce({ success: true });
      mockGetBalance.mockResolvedValueOnce('9.999000');

      const response = await appC.inject({
        method: 'POST',
        url: '/test-compose-mw',
        headers: { 'x-a2a-key': TEST_KEY },
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      // DT-D: el route handler ve el chainId del bundle (CD-12: 2368 default).
      expect(response.json().resolvedChainId).toBe(2368);
    });
  });
});

// ── WKH-101: BRANCH DELEGACIÓN (session token) ────────────────

const SESSION_TOKEN = `wasi_a2a_session_${'b'.repeat(96)}`;
const SESSION_HASH = crypto
  .createHash('sha256')
  .update(SESSION_TOKEN)
  .digest('hex');

function makeDelegationRow(
  overrides: Partial<DelegationRow> = {},
): DelegationRow {
  const policy = {
    max_amount_per_tx: '5.00',
    max_total_amount: '100.00',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    allowed_chains: [] as number[],
    allowed_agent_slugs: [] as string[],
    allowed_registries: [] as string[],
  };
  return {
    id: 'del-1',
    key_id: TEST_KEY_ID,
    owner_ref: 'user-1',
    session_key_address: '0xdef0000000000000000000000000000000000002',
    session_token_hash: SESSION_HASH,
    policy,
    total_spent: '0',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    revoked_at: null,
    typed_data_raw: {} as DelegationRow['typed_data_raw'],
    nonce: `0x${'00'.repeat(32)}`,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('requirePaymentOrA2AKey — delegation branch (WKH-101)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    app.post(
      '/test',
      { preHandler: requirePaymentOrA2AKey({ description: 'Test endpoint' }) },
      async (request: FastifyRequest, reply: FastifyReply) => {
        return reply.send({
          ok: true,
          a2aKeyId: request.a2aKeyRow?.id ?? null,
          delegationId: request.delegationRow?.id ?? null,
          hasDelegationContext: request.delegationContext !== undefined,
        });
      },
    );
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
    setMockRegistryState(['kite-ozone-testnet'], 'kite-ozone-testnet');
    // exceedsPerTxLimit defaults to "not exceeded" unless a test overrides it.
    mockExceedsPerTx.mockReturnValue(false);
  });

  // T5 (AC-5)
  it('T5: valid session token → branch + augment + delegationContext set', async () => {
    mockLookupToken.mockResolvedValue(makeDelegationRow());
    mockGetParentKey.mockResolvedValue(makeKeyRow());
    mockDebitDelegation.mockResolvedValue('1.00');
    mockGetBalance.mockResolvedValue('49.00');

    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.delegationId).toBe('del-1');
    expect(body.hasDelegationContext).toBe(true);
    expect(res.headers['x-a2a-remaining-budget']).toBe('49.00');
    // step-0 debit went through the atomic delegation RPC, not master debit.
    expect(mockDebitDelegation).toHaveBeenCalledWith(
      'del-1',
      'user-1',
      TEST_KEY_ID,
      2368,
      1.0,
    );
    expect(mockDebit).not.toHaveBeenCalled();
  });

  // T5 (AC-5) — unknown token
  it('T5: unknown session token → 401 INVALID_SESSION_TOKEN', async () => {
    mockLookupToken.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error_code).toBe('INVALID_SESSION_TOKEN');
  });

  // T6 (AC-6) — revoked
  it('T6: revoked delegation → 403 DELEGATION_REVOKED (pre-debit)', async () => {
    mockLookupToken.mockResolvedValue(
      makeDelegationRow({ revoked_at: new Date().toISOString() }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('DELEGATION_REVOKED');
    expect(mockDebitDelegation).not.toHaveBeenCalled();
  });

  // T6 (AC-6) — expired
  it('T6: expired delegation → 403 DELEGATION_EXPIRED (pre-debit)', async () => {
    mockLookupToken.mockResolvedValue(
      makeDelegationRow({
        expires_at: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('DELEGATION_EXPIRED');
  });

  // inactive parent key
  it('inactive parent key → 403 KEY_INACTIVE', async () => {
    mockLookupToken.mockResolvedValue(makeDelegationRow());
    mockGetParentKey.mockResolvedValue(makeKeyRow({ is_active: false }));
    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('KEY_INACTIVE');
  });

  // T7 (AC-7) — step 0 per-tx
  it('T7: step-0 cost > max_amount_per_tx → 403 DELEGATION_TX_LIMIT_EXCEEDED before debit', async () => {
    mockLookupToken.mockResolvedValue(makeDelegationRow());
    mockGetParentKey.mockResolvedValue(makeKeyRow());
    mockExceedsPerTx.mockReturnValue(true);

    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('DELEGATION_TX_LIMIT_EXCEEDED');
    expect(mockDebitDelegation).not.toHaveBeenCalled();
  });

  // T8 step-0 — total limit from RPC
  it('T8: step-0 total limit from RPC → 403 DELEGATION_TOTAL_LIMIT_EXCEEDED', async () => {
    mockLookupToken.mockResolvedValue(makeDelegationRow());
    mockGetParentKey.mockResolvedValue(makeKeyRow());
    mockDebitDelegation.mockRejectedValue(
      new DelegationTotalLimitExceededError(),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('DELEGATION_TOTAL_LIMIT_EXCEEDED');
  });

  // T9 step-0 — budget exhausted from RPC
  it('T9: step-0 parent budget exhausted from RPC → 403 AGENT_KEY_BUDGET_EXHAUSTED', async () => {
    mockLookupToken.mockResolvedValue(makeDelegationRow());
    mockGetParentKey.mockResolvedValue(makeKeyRow());
    mockDebitDelegation.mockRejectedValue(new AgentKeyBudgetExhaustedError());
    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('AGENT_KEY_BUDGET_EXHAUSTED');
  });

  // T17 (DT-3) — allowed_chains restriction
  it('T17: allowed_chains=[999] and resolved chain 2368 → 403 DELEGATION_CHAIN_NOT_ALLOWED', async () => {
    mockLookupToken.mockResolvedValue(
      makeDelegationRow({
        policy: {
          ...makeDelegationRow().policy,
          allowed_chains: [999],
        },
      }),
    );
    mockGetParentKey.mockResolvedValue(makeKeyRow());
    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('DELEGATION_CHAIN_NOT_ALLOWED');
    expect(mockDebitDelegation).not.toHaveBeenCalled();
  });

  // T17 (DT-3) — empty allowed_chains = no restriction
  it('T17: allowed_chains=[] → no restriction (passes)', async () => {
    mockLookupToken.mockResolvedValue(makeDelegationRow()); // allowed_chains []
    mockGetParentKey.mockResolvedValue(makeKeyRow());
    mockDebitDelegation.mockResolvedValue('1.00');
    mockGetBalance.mockResolvedValue('49.00');
    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  // T14 (AC-13) backward-compat — master key path untouched
  it('T14: master key (no session prefix) → master debit path, no delegation calls', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockDebit.mockResolvedValue({ success: true });
    mockGetBalance.mockResolvedValue('9.00');
    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hasDelegationContext).toBe(false);
    expect(mockLookupToken).not.toHaveBeenCalled();
    expect(mockDebitDelegation).not.toHaveBeenCalled();
    expect(mockDebit).toHaveBeenCalledWith(TEST_KEY_ID, 2368, 1.0);
  });
});
