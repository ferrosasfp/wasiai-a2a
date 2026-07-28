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

// WKH-121: middleware now imports keySessionService for the wasi_a2a_sess_ branch.
vi.mock('../services/key-session.js', () => ({
  keySessionService: {
    lookupByTokenHash: vi.fn(),
    getParentKey: vi.fn(),
    debitSessionAndParent: vi.fn(),
  },
}));

// WKH-123: middleware imports verifySignedAuth for the per-request signature
// check (master EIP-712 + session HMAC). Mocked so tests drive the result
// without hitting supabase; the orchestrator's own logic is covered in
// signed-auth.test.ts (unit, real crypto round-trip).
vi.mock('../services/signed-auth.js', () => ({
  verifySignedAuth: vi.fn(),
}));

// WKH-124 (MNR-3): the master debit success path emits a budget_debit receipt
// fire-and-forget (a2a-key.ts ~L816). Mock receiptService so we can assert the
// master lineage (keyRow.owner_ref/id, receipt_type:'budget_debit') and so a
// rejecting emit cannot interrupt the request (CD-1 / AC-6).
vi.mock('../services/receipt.js', () => ({
  receiptService: { emit: vi.fn() },
}));

// WKH-MULTICHAIN W2: registry mock exposes multi-chain Map + new getters.
// `getAdaptersBundle(chainKey)` returns a per-chain bundle with chainConfig +
// payment.supportedTokens, so the middleware can resolve the right chainId
// and asset_symbol for structured logs (CD-7).
type MockChainKey =
  | 'kite-ozone-testnet'
  | 'avalanche-fuji'
  | 'avalanche-mainnet';

// HU-204: `payment.vmFamily` es OBLIGATORIO en el bundle real (discriminante de
// la unión EVM/Solana) y ahora lo lee el guard de inbound del middleware x402.
// Las 3 chains simuladas acá son EVM.
type MockBundle = {
  chainConfig: { name: string; chainId: number; explorerUrl: string };
  payment: {
    vmFamily: 'evm';
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
      vmFamily: 'evm',
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
      vmFamily: 'evm',
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
      vmFamily: 'evm',
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

vi.mock('../adapters/registry.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../adapters/registry.js')>();
  return {
    // HU-204: la REGLA del guard de inbound sale del módulo real (un stub podría
    // mentir y dejarlo verde sin existir).
    acceptsInboundPayment: actual.acceptsInboundPayment,
    getInboundPaymentChainKeys: vi.fn(() => [...mockInitializedChains]),
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
  };
});

import { getPaymentAdapter } from '../adapters/registry.js';
import { budgetService } from '../services/budget.js';
import {
  delegationService,
  exceedsPerTxLimit,
} from '../services/delegation.js';
import { identityService } from '../services/identity.js';
import { keySessionService } from '../services/key-session.js';
import { receiptService } from '../services/receipt.js';
import {
  AgentKeyBudgetExhaustedError,
  DailyLimitExceededError,
  DelegationTotalLimitExceededError,
  DestCapExceededError,
  SessionBudgetExhaustedError,
} from '../services/security/errors.js';
import { verifySignedAuth } from '../services/signed-auth.js';
import type { DelegationRow, KeySessionRow } from '../types/index.js';
import {
  buildDelegationEffectiveRow,
  buildSessionEffectiveRow,
  requireA2AKey,
  requirePaymentOrA2AKey,
} from './a2a-key.js';
// WKH-175: el dedup del warn "default aplicado" vive en x402.ts (choke-point
// compartido con el path x402). Se resetea por test para evitar contaminación.
import { _resetDefaultChainWarnDedup } from './x402.js';

const mockLookupByHash = vi.mocked(identityService.lookupByHash);
const mockGetBalance = vi.mocked(budgetService.getBalance);
const mockDebit = vi.mocked(budgetService.debit);
const mockLookupToken = vi.mocked(delegationService.lookupByTokenHash);
const mockGetParentKey = vi.mocked(delegationService.getParentKey);
const mockDebitDelegation = vi.mocked(
  delegationService.debitDelegationAndParent,
);
const mockExceedsPerTx = vi.mocked(exceedsPerTxLimit);
const mockGetPaymentAdapter = vi.mocked(getPaymentAdapter);
const mockSessionLookup = vi.mocked(keySessionService.lookupByTokenHash);
const mockSessionGetParent = vi.mocked(keySessionService.getParentKey);
const mockSessionDebit = vi.mocked(keySessionService.debitSessionAndParent);
const mockVerifySignedAuth = vi.mocked(verifySignedAuth);
const mockReceiptEmit = vi.mocked(receiptService.emit);

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
    require_signature: false,
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
    // WKH-124: emit is fire-and-forget (`.emit(...).catch(...)`); default it to a
    // resolved promise so the `.catch` chain never sees `undefined`.
    mockReceiptEmit.mockResolvedValue(undefined);
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
    expect(mockDebit).toHaveBeenCalledWith(
      TEST_KEY_ID,
      2368,
      1.0,
      undefined,
      undefined,
      undefined,
      'user-1', // F-04 (audit): threaded caller owner_ref
    );
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

  // ── T-AK-COEX (AC-2): Agent Key wins when X-PAYMENT coexists ──

  it('T-AK-COEX: x-a2a-key + X-PAYMENT simultaneous — Agent Key honored, x402 adapter never invoked', async () => {
    const keyRow = makeKeyRow();
    mockLookupByHash.mockResolvedValue(keyRow);
    mockDebit.mockResolvedValue({ success: true });
    mockGetBalance.mockResolvedValue('9.000000');

    const response = await app.inject({
      method: 'POST',
      url: '/test',
      headers: {
        'x-a2a-key': TEST_KEY,
        // Canonical x402 payload present at the same time — must be ignored.
        'x-payment': Buffer.from(
          JSON.stringify({
            authorization: { from: '0x1', to: '0x2', value: '1' },
            signature: '0xabc',
          }),
          'utf8',
        ).toString('base64'),
      },
      payload: {},
    });

    // Path Agent Key honored: 200, debit called, a2aKeyRow set.
    expect(response.statusCode).toBe(200);
    expect(response.json().a2aKeyId).toBe(TEST_KEY_ID);
    expect(mockDebit).toHaveBeenCalledTimes(1);
    expect(mockDebit).toHaveBeenCalledWith(
      TEST_KEY_ID,
      2368,
      1.0,
      undefined,
      undefined,
      undefined,
      'user-1', // F-04 (audit): threaded caller owner_ref
    );
    // x402 verify/settle path NEVER reached → registry payment adapter not used.
    expect(mockGetPaymentAdapter).not.toHaveBeenCalled();
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
    // WKH-175: el texto ahora también trae el slug, la causa (default aplicado
    // por falta de header) y las OTRAS chains con saldo. `status` + `error_code`
    // NO cambian (contrato estable para los clientes que los parsean).
    // Fix-pack MNR-3 (CR): esta key SÓLO tiene budget en 2368, que es justo la
    // chain target → la lista queda vacía y el mensaje dice "no other chain has
    // balance". La expectativa ANTERIOR ("chains with balance:
    // kite-ozone-testnet") pinneaba el defecto de UX que MNR-3 corrige: le
    // sugería al caller la misma red que lo acababa de rechazar.
    expect(response.json().error).toBe(
      "chain 2368 (kite-ozone-testnet) balance is 0; no x-payment-chain header sent, used default 'kite-ozone-testnet'; no other chain has balance",
    );
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
    // WKH-175: + slug + causa del default + OTRAS chains con saldo (mismo
    // 403/code). Fix-pack MNR-3 (CR): la única chain con budget de esta key es
    // la target (2368) → excluida de la lista → "no other chain has balance".
    expect(response.json().error).toBe(
      "chain 2368 (kite-ozone-testnet) balance is 0; no x-payment-chain header sent, used default 'kite-ozone-testnet'; no other chain has balance",
    );
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
      expect(mockDebit).toHaveBeenCalledWith(
        TEST_KEY_ID,
        43113,
        1.0,
        undefined,
        undefined,
        undefined,
        'user-1', // F-04 (audit): threaded caller owner_ref
      );
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
      expect(mockDebit).toHaveBeenCalledWith(
        TEST_KEY_ID,
        43113,
        1.0,
        undefined,
        undefined,
        undefined,
        'user-1', // F-04 (audit): threaded caller owner_ref
      );
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
      expect(mockDebit).toHaveBeenCalledWith(
        TEST_KEY_ID,
        2368,
        1.0,
        undefined,
        undefined,
        undefined,
        'user-1', // F-04 (audit): threaded caller owner_ref
      );
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
      expect(mockDebit).toHaveBeenCalledWith(
        TEST_KEY_ID,
        43113,
        1.0,
        undefined,
        undefined,
        undefined,
        'user-1', // F-04 (audit): threaded caller owner_ref
      );
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
      // WKH-175: el header VINO presente (avalanche-fuji) → el mensaje NO habla
      // de default, pero SÍ lista dónde la key tiene saldo (kite), que es
      // exactamente la confusión cross-chain que este 403 tenía que explicar.
      // Fix-pack MNR-3: la target (43113, saldo '0') se excluye de la lista;
      // kite (43113 ≠ 2368) SÍ es una alternativa real → el texto no cambia.
      expect(response.json().error).toBe(
        'chain 43113 (avalanche-fuji) balance is 0; chains with balance: kite-ozone-testnet (10.000000)',
      );
      // CD-12: debit AND getBalance read chainId from the same bundle (43113).
      expect(mockDebit).toHaveBeenCalledWith(
        TEST_KEY_ID,
        43113,
        1.0,
        undefined,
        undefined,
        undefined,
        'user-1', // F-04 (audit): threaded caller owner_ref
      );
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
      expect(mockDebit).toHaveBeenCalledWith(
        TEST_KEY_ID,
        2368,
        1.0,
        undefined,
        undefined,
        undefined,
        'user-1', // F-04 (audit): threaded caller owner_ref
      );
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
      expect(mockDebit).toHaveBeenCalledWith(
        TEST_KEY_ID,
        2368,
        5,
        undefined,
        undefined,
        undefined,
        'user-1', // F-04 (audit): threaded caller owner_ref
      );
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
      expect(mockDebit).toHaveBeenCalledWith(
        TEST_KEY_ID,
        2368,
        0.001,
        undefined,
        undefined,
        undefined,
        'user-1', // F-04 (audit): threaded caller owner_ref
      );
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
      expect(mockDebit).toHaveBeenCalledWith(
        TEST_KEY_ID,
        2368,
        0.05,
        undefined,
        undefined,
        undefined,
        'user-1', // F-04 (audit): threaded caller owner_ref
      );
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
      expect(mockDebit).toHaveBeenCalledWith(
        TEST_KEY_ID,
        2368,
        1.0,
        undefined,
        undefined,
        undefined,
        'user-1', // F-04 (audit): threaded caller owner_ref
      );
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

  // AR-MNR-1/AR-MNR-2 — parent DAILY_LIMIT under delegation → 403 (was 503),
  // and the raw Postgres message must NEVER reach the client body.
  it('AR-MNR-1: step-0 parent DAILY_LIMIT from RPC → 403 DAILY_LIMIT, no raw PG in body', async () => {
    mockLookupToken.mockResolvedValue(makeDelegationRow());
    mockGetParentKey.mockResolvedValue(makeKeyRow());
    mockDebitDelegation.mockRejectedValue(new DailyLimitExceededError());
    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('DAILY_LIMIT');
    // No info-leak: el body NO contiene el detalle crudo del RAISE de Postgres.
    expect(res.body).not.toContain('limit is');
    expect(res.body).not.toContain('daily spend');
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
    expect(mockDebit).toHaveBeenCalledWith(
      TEST_KEY_ID,
      2368,
      1.0,
      undefined,
      undefined,
      undefined,
      'user-1', // F-04 (audit): threaded caller owner_ref
    );
  });

  // ── WKH-124 (AC-2, MNR-3): budget_debit receipt on the MASTER path ──
  // Mirrors the delegation/key-session emit tests but for the master call-site
  // (a2a-key.ts ~L816): asserts the master lineage (keyRow.owner_ref/id, no
  // session/delegation) and budget_debit type without touching debit's signature.
  it('WKH-124 (AC-2): master debit success emits budget_debit from the call-site', async () => {
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
    // CD-7: the debit signature assertion stays untouched.
    expect(mockDebit).toHaveBeenCalledWith(
      TEST_KEY_ID,
      2368,
      1.0,
      undefined,
      undefined,
      undefined,
      'user-1', // F-04 (audit): threaded caller owner_ref
    );
    expect(mockReceiptEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerRef: 'user-1',
        agentKeyId: TEST_KEY_ID,
        sessionId: null,
        delegationId: null,
        receiptType: 'budget_debit',
        amountUsd: 1.0,
        chainId: 2368,
      }),
    );
  });

  it('WKH-124 (AC-2/AC-6): a rejecting emit does NOT break the master request', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockDebit.mockResolvedValue({ success: true });
    mockGetBalance.mockResolvedValue('9.00');
    mockReceiptEmit.mockRejectedValue(new Error('receipt down'));

    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().a2aKeyId).toBe(TEST_KEY_ID);
  });
});

// ── WKH-125b: delegación hereda el cap por destino de la parent key ──
// El step-0 de un compose de 1 step bajo delegación EIP-712 debe propagar
// `composeDestination` a debitDelegationAndParent → RPC debit_with_dest_policy.
// Sin el fix el RPC recibía p_destination=NULL, caía a increment_a2a_key_spend
// y el cap por destino se evadía por completo (bypass del cap con delegación).
describe('requirePaymentOrA2AKey — WKH-125b delegation dest-cap propagation', () => {
  let appD: ReturnType<typeof Fastify>;
  const DEST = '0xDEADBEEFdeadBEEFdeadBEEFdeadBEEFdeadBEEF';

  beforeAll(async () => {
    appD = Fastify();
    // preHandler upstream que augmenta composeDestination (espeja lo que hace
    // routes/compose.ts:resolveComposePriceHandler antes del middleware).
    appD.post(
      '/test-compose-dest',
      {
        preHandler: [
          async (req: FastifyRequest) => {
            req.composeDestination = DEST;
          },
          ...requirePaymentOrA2AKey({ description: 'compose w/ dest' }),
        ],
      },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await appD.ready();
  });

  afterAll(() => appD.close());

  beforeEach(() => {
    vi.clearAllMocks();
    setMockRegistryState(['kite-ozone-testnet'], 'kite-ozone-testnet');
    mockExceedsPerTx.mockReturnValue(false);
  });

  // AC-1: cap por destino excedido bajo delegación → HTTP 402 DEST_CAP_EXCEEDED
  // (espeja el branch session), no 403/genérico.
  it('WKH-125b: dest cap exceeded under delegation → 402 DEST_CAP_EXCEEDED (AC-1)', async () => {
    mockLookupToken.mockResolvedValue(makeDelegationRow());
    mockGetParentKey.mockResolvedValue(makeKeyRow());
    mockDebitDelegation.mockRejectedValue(new DestCapExceededError());

    const res = await appD.inject({
      method: 'POST',
      url: '/test-compose-dest',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: {},
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().error_code).toBe('DEST_CAP_EXCEEDED');
  });

  // AC-1: con composeDestination → debitDelegationAndParent recibe el 6º arg
  // destino → RPC va por debit_with_dest_policy (cap evaluado). Reproduce el fix.
  it('WKH-125b: composeDestination → debitDelegationAndParent called WITH destination (AC-1)', async () => {
    mockLookupToken.mockResolvedValue(makeDelegationRow());
    mockGetParentKey.mockResolvedValue(makeKeyRow());
    mockDebitDelegation.mockResolvedValue('1.00');
    mockGetBalance.mockResolvedValue('9.00');

    const res = await appD.inject({
      method: 'POST',
      url: '/test-compose-dest',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(mockDebitDelegation).toHaveBeenCalledWith(
      'del-1',
      'user-1',
      TEST_KEY_ID,
      2368,
      1.0,
      DEST,
    );
    expect(mockDebit).not.toHaveBeenCalled();
  });

  // AC-2: SIN composeDestination → la llamada de 5 args queda INTACTA (back-compat).
  it('WKH-125b: no composeDestination → debitDelegationAndParent called with 5 args (AC-2)', async () => {
    const appNoDest = Fastify();
    appNoDest.post(
      '/test-no-dest',
      { preHandler: requirePaymentOrA2AKey({ description: 'no dest' }) },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await appNoDest.ready();

    mockLookupToken.mockResolvedValue(makeDelegationRow());
    mockGetParentKey.mockResolvedValue(makeKeyRow());
    mockDebitDelegation.mockResolvedValue('1.00');
    mockGetBalance.mockResolvedValue('9.00');

    const res = await appNoDest.inject({
      method: 'POST',
      url: '/test-no-dest',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    // 5 args exactos — el 6º (destino) NO se pasa cuando no hay composeDestination.
    expect(mockDebitDelegation).toHaveBeenCalledWith(
      'del-1',
      'user-1',
      TEST_KEY_ID,
      2368,
      1.0,
    );
    await appNoDest.close();
  });
});

// ── WKH-121: BRANCH KEY-SESSION (wasi_a2a_sess_ token) ────────

const SESS_TOKEN = `wasi_a2a_sess_${'c'.repeat(96)}`;
const SESS_HASH = crypto.createHash('sha256').update(SESS_TOKEN).digest('hex');

function makeKeySessionRow(
  overrides: Partial<KeySessionRow> = {},
): KeySessionRow {
  return {
    id: 'sess-1',
    key_id: TEST_KEY_ID,
    owner_ref: 'user-1',
    session_token_hash: SESS_HASH,
    ttl_seconds: 3600,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    max_budget_usd: '10.00',
    spent_usd: '0',
    allowed_registries: null,
    allowed_agent_slugs: null,
    allowed_categories: null,
    derivation_mode: 'server',
    revoked_at: null,
    created_at: new Date().toISOString(),
    require_signature: false,
    signing_secret_hash: null,
    ...overrides,
  };
}

describe('requirePaymentOrA2AKey — key-session branch (WKH-121)', () => {
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
          keySessionId: request.keySessionRow?.id ?? null,
          hasKeySessionContext: request.keySessionContext !== undefined,
          effectiveRegistries: request.a2aKeyRow?.allowed_registries ?? null,
        });
      },
    );
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
    setMockRegistryState(['kite-ozone-testnet'], 'kite-ozone-testnet');
  });

  // T-MW-LOOKUP (AC-4)
  it('T-MW-LOOKUP: valid session token → lookup by hash, augment, atomic session debit', async () => {
    mockSessionLookup.mockResolvedValue(makeKeySessionRow());
    mockSessionGetParent.mockResolvedValue(makeKeyRow());
    mockSessionDebit.mockResolvedValue('1.00');
    mockGetBalance.mockResolvedValue('9.00');

    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${SESS_TOKEN}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.keySessionId).toBe('sess-1');
    expect(body.hasKeySessionContext).toBe(true);
    expect(res.headers['x-a2a-remaining-budget']).toBe('9.00');
    // lookup uses the SHA-256 of the raw token.
    expect(mockSessionLookup).toHaveBeenCalledWith(SESS_HASH);
    // step-0 debit went through the atomic session RPC, not master debit.
    expect(mockSessionDebit).toHaveBeenCalledWith(
      'sess-1',
      'user-1',
      TEST_KEY_ID,
      2368,
      1.0,
    );
    expect(mockDebit).not.toHaveBeenCalled();
  });

  // T-MW-INVALID (AC-5)
  it('T-MW-INVALID: unknown session token → 401 SESSION_TOKEN_INVALID', async () => {
    mockSessionLookup.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${SESS_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error_code).toBe('SESSION_TOKEN_INVALID');
    expect(mockSessionDebit).not.toHaveBeenCalled();
  });

  // T-MW-EXPIRED (AC-6)
  it('T-MW-EXPIRED: now >= expires_at → 403 SESSION_EXPIRED (pre-debit)', async () => {
    mockSessionLookup.mockResolvedValue(
      makeKeySessionRow({
        expires_at: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${SESS_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('SESSION_EXPIRED');
    expect(mockSessionDebit).not.toHaveBeenCalled();
  });

  // revoked session → SESSION_TOKEN_INVALID (pre-debit)
  // T-MW-REVOKED — WKH-122 AC-2 (regresión): una sesión con revoked_at != null
  // es rechazada inmediatamente por el middleware (sin caché, sin débito).
  // El middleware NO se modifica en WKH-122; este test cubre el efecto inmediato
  // de keySessionService.revoke. NO cambiar la lógica del test.
  it('revoked session → 403 SESSION_TOKEN_INVALID (pre-debit)', async () => {
    mockSessionLookup.mockResolvedValue(
      makeKeySessionRow({ revoked_at: new Date().toISOString() }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${SESS_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('SESSION_TOKEN_INVALID');
    expect(mockSessionDebit).not.toHaveBeenCalled();
  });

  // T-MW-KEYINACTIVE (AC-7)
  it('T-MW-KEYINACTIVE: parent is_active=false → 403 KEY_INACTIVE', async () => {
    mockSessionLookup.mockResolvedValue(makeKeySessionRow());
    mockSessionGetParent.mockResolvedValue(makeKeyRow({ is_active: false }));
    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${SESS_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('KEY_INACTIVE');
  });

  // session budget exhausted from RPC
  it('session budget exhausted from RPC → 403 SESSION_BUDGET_EXHAUSTED', async () => {
    mockSessionLookup.mockResolvedValue(makeKeySessionRow());
    mockSessionGetParent.mockResolvedValue(makeKeyRow());
    mockSessionDebit.mockRejectedValue(new SessionBudgetExhaustedError());
    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${SESS_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('SESSION_BUDGET_EXHAUSTED');
  });

  // T-SCOPE-EFF (AC-10) — session list restricts within parent
  it('T-SCOPE-EFF: session allowed_registries=[a] → effective [a] (not parent)', async () => {
    mockSessionLookup.mockResolvedValue(
      makeKeySessionRow({ allowed_registries: ['a'] }),
    );
    mockSessionGetParent.mockResolvedValue(
      makeKeyRow({ allowed_registries: ['a', 'b'] }),
    );
    mockSessionDebit.mockResolvedValue('1.00');
    mockGetBalance.mockResolvedValue('9.00');
    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${SESS_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().effectiveRegistries).toEqual(['a']);
  });

  // T-SCOPE-EFF (AC-10) — session null inherits parent restriction
  it('T-SCOPE-EFF: session null + parent [a,b] → effective [a,b] (inherits)', async () => {
    mockSessionLookup.mockResolvedValue(
      makeKeySessionRow({ allowed_registries: null }),
    );
    mockSessionGetParent.mockResolvedValue(
      makeKeyRow({ allowed_registries: ['a', 'b'] }),
    );
    mockSessionDebit.mockResolvedValue('1.00');
    mockGetBalance.mockResolvedValue('9.00');
    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${SESS_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().effectiveRegistries).toEqual(['a', 'b']);
  });

  // ── WKH-125 (AC-6 fix): session key hereda el cap por destino ──────
  // BLQ-MED (auditoría cross-HU): el step-0 de un compose de 1 step con una
  // session key debe propagar `composeDestination` a debitSessionAndParent →
  // RPC `debit_with_dest_policy`. Sin el fix el RPC recibía p_destination=NULL,
  // caía a increment_a2a_key_spend y el cap por destino se evadía por completo.
  describe('WKH-125 session dest-cap propagation', () => {
    let appD: ReturnType<typeof Fastify>;
    const DEST = '0xDEADBEEFdeadBEEFdeadBEEFdeadBEEFdeadBEEF';

    beforeAll(async () => {
      appD = Fastify();
      // preHandler upstream que augmenta composeDestination (espeja lo que hace
      // routes/compose.ts:resolveComposePriceHandler antes del middleware).
      appD.post(
        '/test-compose-dest',
        {
          preHandler: [
            async (req: FastifyRequest) => {
              req.composeDestination = DEST;
            },
            ...requirePaymentOrA2AKey({ description: 'compose w/ dest' }),
          ],
        },
        async (_req: FastifyRequest, reply: FastifyReply) =>
          reply.send({ ok: true }),
      );
      await appD.ready();
    });

    afterAll(() => appD.close());

    beforeEach(() => {
      vi.clearAllMocks();
      setMockRegistryState(['kite-ozone-testnet'], 'kite-ozone-testnet');
    });

    // T-MW-SESS-DEST-1: el step-0 con session key + composeDestination llama a
    // debitSessionAndParent CON el 6º arg destino → RPC va por debit_with_dest_policy
    // (cap evaluado), NO por increment_a2a_key_spend. Reproduce el fix del bypass.
    it('T-MW-SESS-DEST-1: session key + composeDestination → debitSessionAndParent called WITH destination', async () => {
      mockSessionLookup.mockResolvedValue(makeKeySessionRow());
      mockSessionGetParent.mockResolvedValue(makeKeyRow());
      mockSessionDebit.mockResolvedValue('1.00');
      mockGetBalance.mockResolvedValue('9.00');

      const res = await appD.inject({
        method: 'POST',
        url: '/test-compose-dest',
        headers: { authorization: `Bearer ${SESS_TOKEN}` },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      // el destino se PROPAGA como 6º arg (antes del fix faltaba → cap evadido).
      expect(mockSessionDebit).toHaveBeenCalledWith(
        'sess-1',
        'user-1',
        TEST_KEY_ID,
        2368,
        1.0,
        DEST,
      );
      // master debit NO se usa en el branch session.
      expect(mockDebit).not.toHaveBeenCalled();
    });

    // T-MW-SESS-DEST-2: cap por destino excedido bajo session key → HTTP 402
    // DEST_CAP_EXCEEDED (espeja el branch master), no 403/genérico.
    it('T-MW-SESS-DEST-2: dest cap exceeded under session key → 402 DEST_CAP_EXCEEDED', async () => {
      mockSessionLookup.mockResolvedValue(makeKeySessionRow());
      mockSessionGetParent.mockResolvedValue(makeKeyRow());
      mockSessionDebit.mockRejectedValue(new DestCapExceededError());

      const res = await appD.inject({
        method: 'POST',
        url: '/test-compose-dest',
        headers: { authorization: `Bearer ${SESS_TOKEN}` },
        payload: {},
      });

      expect(res.statusCode).toBe(402);
      expect(res.json().error_code).toBe('DEST_CAP_EXCEEDED');
    });
  });

  // T-BACKCOMPAT (AC-14) — master key path untouched
  it('T-BACKCOMPAT: master key (no sess prefix) → master debit path, no session calls', async () => {
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
    expect(res.json().hasKeySessionContext).toBe(false);
    expect(mockSessionLookup).not.toHaveBeenCalled();
    expect(mockSessionDebit).not.toHaveBeenCalled();
    expect(mockDebit).toHaveBeenCalledWith(
      TEST_KEY_ID,
      2368,
      1.0,
      undefined,
      undefined,
      undefined,
      'user-1', // F-04 (audit): threaded caller owner_ref
    );
  });

  // T-COEXIST (AC-15) — sess token routes to keySessionService, NOT delegationService
  it('T-COEXIST: wasi_a2a_sess_ routes to keySessionService, not delegationService', async () => {
    mockSessionLookup.mockResolvedValue(makeKeySessionRow());
    mockSessionGetParent.mockResolvedValue(makeKeyRow());
    mockSessionDebit.mockResolvedValue('1.00');
    mockGetBalance.mockResolvedValue('9.00');
    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${SESS_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(mockSessionLookup).toHaveBeenCalledWith(SESS_HASH);
    // WKH-101 delegation service is NEVER touched by a sess token.
    expect(mockLookupToken).not.toHaveBeenCalled();
    expect(mockDebitDelegation).not.toHaveBeenCalled();
  });

  // T-COEXIST (AC-15) — session_ token routes to delegationService, NOT keySessionService
  it('T-COEXIST: wasi_a2a_session_ routes to delegationService, not keySessionService', async () => {
    mockLookupToken.mockResolvedValue(null); // delegation lookup → 401
    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error_code).toBe('INVALID_SESSION_TOKEN');
    expect(mockLookupToken).toHaveBeenCalledWith(SESSION_HASH);
    // WKH-121 session service is NEVER touched by a session_ token.
    expect(mockSessionLookup).not.toHaveBeenCalled();
  });
});

// ── WKH-123: SIGNED AUTH (per-request signature, opt-in) ─────────
// verifySignedAuth está mockeado (su crypto se cubre en signed-auth.test.ts).
// Acá probamos el cableado del middleware: cuándo se invoca, cómo se mapean los
// error_codes a HTTP, y la back-compat absoluta (require_signature:false).

describe('requirePaymentOrA2AKey — signed auth (WKH-123)', () => {
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
          keySessionId: request.keySessionRow?.id ?? null,
        });
      },
    );
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
    setMockRegistryState(['kite-ozone-testnet'], 'kite-ozone-testnet');
  });

  const SIG_HEADERS = {
    'x-a2a-signature': '0xsig',
    'x-a2a-nonce': `0x${'a'.repeat(64)}`,
    'x-a2a-timestamp': String(Math.floor(Date.now() / 1000)),
  };

  // ── AC-1: master EIP-712 OK → debit ───────────────────────
  it('AC-1: master require_signature + valid signature → 200, debit proceeds', async () => {
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({
        require_signature: true,
        funding_wallet: '0x1111111111111111111111111111111111111111',
      }),
    );
    mockVerifySignedAuth.mockResolvedValue({ ok: true });
    mockDebit.mockResolvedValue({ success: true });
    mockGetBalance.mockResolvedValue('9.00');

    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-a2a-key': TEST_KEY, ...SIG_HEADERS },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(mockVerifySignedAuth).toHaveBeenCalledTimes(1);
    // EIP-712 scheme with the bound funding_wallet, token_hash = keyHash (no 0x).
    expect(mockVerifySignedAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenHashHex: TEST_KEY_HASH,
        method: 'POST',
        path: '/test',
        scheme: {
          kind: 'eip712',
          fundingWallet: '0x1111111111111111111111111111111111111111',
        },
      }),
    );
    expect(mockDebit).toHaveBeenCalledWith(
      TEST_KEY_ID,
      2368,
      1.0,
      undefined,
      undefined,
      undefined,
      'user-1', // F-04 (audit): threaded caller owner_ref
    );
  });

  // ── AC-2: session HMAC OK → debit ─────────────────────────
  it('AC-2: session require_signature + valid HMAC → 200, atomic session debit', async () => {
    mockSessionLookup.mockResolvedValue(
      makeKeySessionRow({
        require_signature: true,
        signing_secret_hash: 'f'.repeat(64),
      }),
    );
    mockSessionGetParent.mockResolvedValue(makeKeyRow());
    mockVerifySignedAuth.mockResolvedValue({ ok: true });
    mockSessionDebit.mockResolvedValue('1.00');
    mockGetBalance.mockResolvedValue('9.00');

    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${SESS_TOKEN}`, ...SIG_HEADERS },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(mockVerifySignedAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenHashHex: SESS_HASH,
        scheme: { kind: 'hmac', signingSecretHash: 'f'.repeat(64) },
      }),
    );
    expect(mockSessionDebit).toHaveBeenCalledTimes(1);
  });

  // ── AC-3: missing signature → 401 SIGNATURE_REQUIRED (master + session) ──
  it('AC-3 master: require_signature but no x-a2a-signature → 401 SIGNATURE_REQUIRED, no debit', async () => {
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({
        require_signature: true,
        funding_wallet: '0x1111111111111111111111111111111111111111',
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-a2a-key': TEST_KEY }, // sin headers de firma
      payload: {},
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error_code).toBe('SIGNATURE_REQUIRED');
    expect(mockVerifySignedAuth).not.toHaveBeenCalled();
    expect(mockDebit).not.toHaveBeenCalled();
  });

  it('AC-3 session: require_signature but no x-a2a-signature → 401 SIGNATURE_REQUIRED, no debit', async () => {
    mockSessionLookup.mockResolvedValue(
      makeKeySessionRow({
        require_signature: true,
        signing_secret_hash: 'f'.repeat(64),
      }),
    );
    mockSessionGetParent.mockResolvedValue(makeKeyRow());

    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${SESS_TOKEN}` },
      payload: {},
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error_code).toBe('SIGNATURE_REQUIRED');
    expect(mockVerifySignedAuth).not.toHaveBeenCalled();
    expect(mockSessionDebit).not.toHaveBeenCalled();
  });

  // ── AC-4: signature invalid → 401 SIGNATURE_INVALID ───────
  it('AC-4 master: recover != funding_wallet → 401 SIGNATURE_INVALID, no debit', async () => {
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({
        require_signature: true,
        funding_wallet: '0x1111111111111111111111111111111111111111',
      }),
    );
    mockVerifySignedAuth.mockResolvedValue({
      ok: false,
      code: 'SIGNATURE_INVALID',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-a2a-key': TEST_KEY, ...SIG_HEADERS },
      payload: {},
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error_code).toBe('SIGNATURE_INVALID');
    expect(mockDebit).not.toHaveBeenCalled();
  });

  it('AC-4 session: HMAC mismatch → 401 SIGNATURE_INVALID, no debit', async () => {
    mockSessionLookup.mockResolvedValue(
      makeKeySessionRow({
        require_signature: true,
        signing_secret_hash: 'f'.repeat(64),
      }),
    );
    mockSessionGetParent.mockResolvedValue(makeKeyRow());
    mockVerifySignedAuth.mockResolvedValue({
      ok: false,
      code: 'SIGNATURE_INVALID',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${SESS_TOKEN}`, ...SIG_HEADERS },
      payload: {},
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error_code).toBe('SIGNATURE_INVALID');
    expect(mockSessionDebit).not.toHaveBeenCalled();
  });

  // ── AC-5: nonce replay → 401 NONCE_REPLAY (even with valid signature) ──
  it('AC-5: replayed nonce → 401 NONCE_REPLAY, no debit', async () => {
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({
        require_signature: true,
        funding_wallet: '0x1111111111111111111111111111111111111111',
      }),
    );
    mockVerifySignedAuth.mockResolvedValue({ ok: false, code: 'NONCE_REPLAY' });

    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-a2a-key': TEST_KEY, ...SIG_HEADERS },
      payload: {},
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error_code).toBe('NONCE_REPLAY');
    expect(mockDebit).not.toHaveBeenCalled();
  });

  // ── AC-6: timestamp out of window → 401 TIMESTAMP_EXPIRED ──
  it('AC-6: timestamp out of window → 401 TIMESTAMP_EXPIRED, no debit', async () => {
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({
        require_signature: true,
        funding_wallet: '0x1111111111111111111111111111111111111111',
      }),
    );
    mockVerifySignedAuth.mockResolvedValue({
      ok: false,
      code: 'TIMESTAMP_EXPIRED',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-a2a-key': TEST_KEY, ...SIG_HEADERS },
      payload: {},
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error_code).toBe('TIMESTAMP_EXPIRED');
    expect(mockDebit).not.toHaveBeenCalled();
  });

  // ── AC-7: back-compat — require_signature:false → bearer puro ──
  it('AC-7 master: require_signature false → bearer flow, signature check skipped even if headers present', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow()); // require_signature:false (default)
    mockDebit.mockResolvedValue({ success: true });
    mockGetBalance.mockResolvedValue('9.00');

    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-a2a-key': TEST_KEY, ...SIG_HEADERS }, // headers presentes → IGNORADOS
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(mockVerifySignedAuth).not.toHaveBeenCalled();
    expect(mockDebit).toHaveBeenCalledWith(
      TEST_KEY_ID,
      2368,
      1.0,
      undefined,
      undefined,
      undefined,
      'user-1', // F-04 (audit): threaded caller owner_ref
    );
  });

  it('AC-7 session: require_signature false → bearer flow, signature check skipped', async () => {
    mockSessionLookup.mockResolvedValue(makeKeySessionRow()); // require_signature:false
    mockSessionGetParent.mockResolvedValue(makeKeyRow());
    mockSessionDebit.mockResolvedValue('1.00');
    mockGetBalance.mockResolvedValue('9.00');

    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${SESS_TOKEN}`, ...SIG_HEADERS },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(mockVerifySignedAuth).not.toHaveBeenCalled();
    expect(mockSessionDebit).toHaveBeenCalledTimes(1);
  });

  // ── AC-8: WKH-101 branch ignores the x-a2a-* headers entirely ──
  it('AC-8: wasi_a2a_session_ (WKH-101) with signature headers → branch processes WITHOUT verifySignedAuth', async () => {
    mockLookupToken.mockResolvedValue(null); // delegation lookup → 401 (branch reached)

    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { authorization: `Bearer ${SESSION_TOKEN}`, ...SIG_HEADERS },
      payload: {},
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error_code).toBe('INVALID_SESSION_TOKEN');
    // WKH-123 NUNCA toca el branch WKH-101.
    expect(mockVerifySignedAuth).not.toHaveBeenCalled();
    expect(mockLookupToken).toHaveBeenCalledWith(SESSION_HASH);
  });

  // ── AC-9: master require_signature:true + funding_wallet null → 403 ──
  it('AC-9: master require_signature + funding_wallet null → 403 FUNDING_WALLET_NOT_BOUND, no debit', async () => {
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({ require_signature: true, funding_wallet: null }),
    );
    mockVerifySignedAuth.mockResolvedValue({
      ok: false,
      code: 'FUNDING_WALLET_NOT_BOUND',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/test',
      headers: { 'x-a2a-key': TEST_KEY, ...SIG_HEADERS },
      payload: {},
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('FUNDING_WALLET_NOT_BOUND');
    expect(mockDebit).not.toHaveBeenCalled();
  });
});

// ── WKH-127: skipMiddlewareDebit — master skip, deleg ignora el flag ──
describe('requirePaymentOrA2AKey — WKH-127 skipMiddlewareDebit', () => {
  let appS: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    appS = Fastify();

    // Ruta master CON skipMiddlewareDebit=true (simula orchestrate).
    appS.post(
      '/test-skip',
      {
        preHandler: [
          async (req: FastifyRequest) => {
            req.skipMiddlewareDebit = true;
          },
          ...requirePaymentOrA2AKey({ description: 'orchestrate-like skip' }),
        ],
      },
      async (req: FastifyRequest, reply: FastifyReply) =>
        reply.send({
          ok: true,
          a2aKeyId: req.a2aKeyRow?.id ?? null,
          resolvedChainId: req.resolvedChainId ?? null,
        }),
    );

    // Ruta master SIN flag — debita el placeholder $1 como hoy.
    appS.post(
      '/test-no-skip',
      {
        preHandler: requirePaymentOrA2AKey({ description: 'legacy master' }),
      },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );

    // Ruta delegación CON el flag seteado — H1 (audit 2026-07-01): ahora lo
    // RESPETA (como master) → sin débito de middleware, pero augmenta el contexto.
    appS.post(
      '/test-skip-deleg',
      {
        preHandler: [
          async (req: FastifyRequest) => {
            req.skipMiddlewareDebit = true;
          },
          ...requirePaymentOrA2AKey({ description: 'deleg respects skip' }),
        ],
      },
      async (req: FastifyRequest, reply: FastifyReply) =>
        reply.send({
          ok: true,
          hasDelegationContext: req.delegationContext !== undefined,
        }),
    );

    await appS.ready();
  });

  afterAll(() => appS.close());

  beforeEach(() => {
    vi.clearAllMocks();
    setMockRegistryState(['kite-ozone-testnet'], 'kite-ozone-testnet');
    mockReceiptEmit.mockResolvedValue(undefined);
    mockExceedsPerTx.mockReturnValue(false);
  });

  // T-MW-SKIP-on: master + skip flag → no middleware debit; a2aKeyRow + chainId augmented.
  it('T-MW-SKIP-on: skip flag suppresses the master debit but still augments request', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());

    const res = await appS.inject({
      method: 'POST',
      url: '/test-skip',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.a2aKeyId).toBe(TEST_KEY_ID);
    expect(body.resolvedChainId).toBe(2368);
    // débito step-0 NO ocurre en el middleware bajo skip.
    expect(mockDebit).not.toHaveBeenCalled();
    // header lo setea el route handler (no el middleware) bajo skip.
    expect(res.headers['x-a2a-remaining-budget']).toBeUndefined();
  });

  // T-MW-SKIP-off: master without flag → debits $1 as today.
  it('T-MW-SKIP-off: without the flag the master debit runs as today', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockDebit.mockResolvedValue({ success: true });
    mockGetBalance.mockResolvedValue('9.000000');

    const res = await appS.inject({
      method: 'POST',
      url: '/test-no-skip',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(mockDebit).toHaveBeenCalledWith(
      TEST_KEY_ID,
      2368,
      1.0,
      undefined,
      undefined,
      undefined,
      'user-1', // F-04 (audit): threaded caller owner_ref
    );
    expect(res.headers['x-a2a-remaining-budget']).toBe('9.000000');
  });

  // T-MW-SKIP-deleg-respected (H1 audit 2026-07-01): delegation branch now
  // RESPECTS the flag (like master) → NO middleware step-0 debit, but the
  // request is still augmented with the delegation context so downstream
  // (compose steps 1..N) can bill via delegationContext. This closes the H1
  // vector where delegation callers were charged a flat $1 on every
  // /orchestrate* call (including the zero-debit /plan quote) and never refunded.
  it('T-MW-SKIP-deleg-respected: delegation path respects the skip flag (no middleware debit)', async () => {
    mockLookupToken.mockResolvedValue(makeDelegationRow());
    mockGetParentKey.mockResolvedValue(makeKeyRow());
    mockDebitDelegation.mockResolvedValue('1.00');
    mockGetBalance.mockResolvedValue('49.00');

    const res = await appS.inject({
      method: 'POST',
      url: '/test-skip-deleg',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    // The delegation context IS still augmented (steps 1..N bill via compose).
    expect(res.json().hasDelegationContext).toBe(true);
    // H1: step-0 debit is SKIPPED in the middleware under skipMiddlewareDebit.
    expect(mockDebitDelegation).not.toHaveBeenCalled();
    expect(mockDebit).not.toHaveBeenCalled();
  });
});

// ── WKH-173: requireA2AKey auth-only ─────────────────────────

describe('requireA2AKey — auth-only (WKH-173)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    app.post(
      '/test-free',
      { preHandler: requireA2AKey() },
      async (request: FastifyRequest, reply: FastifyReply) =>
        reply.send({
          ok: true,
          a2aKeyId: request.a2aKeyRow?.id ?? null,
          ownerRef: request.a2aKeyRow?.owner_ref ?? null,
          allowedSlugs: request.a2aKeyRow?.allowed_agent_slugs ?? null,
        }),
    );
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
    setMockRegistryState(['kite-ozone-testnet'], 'kite-ozone-testnet');
    mockExceedsPerTx.mockReturnValue(false);
  });

  const SIG_HEADERS = {
    'x-a2a-signature': '0xsig',
    'x-a2a-nonce': `0x${'a'.repeat(64)}`,
    'x-a2a-timestamp': String(Math.floor(Date.now() / 1000)),
  };

  // ── T-RA-01 (AC-1): master key auth-only → 200, NO debit, NO budget header ──
  it('T-RA-01: valid master key → 200 augmented, no debit, no remaining-budget header', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());

    const response = await app.inject({
      method: 'POST',
      url: '/test-free',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().a2aKeyId).toBe(TEST_KEY_ID);
    expect(mockDebit).not.toHaveBeenCalled();
    expect(response.headers['x-a2a-remaining-budget']).toBeUndefined();
  });

  // ── T-RA-02 (AC-1): delegation auth-only → 200, NO debit ──
  it('T-RA-02: valid delegation token → 200, no delegation debit, no master debit', async () => {
    mockLookupToken.mockResolvedValue(makeDelegationRow());
    mockGetParentKey.mockResolvedValue(makeKeyRow());

    const response = await app.inject({
      method: 'POST',
      url: '/test-free',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().ownerRef).toBe('user-1');
    expect(mockDebitDelegation).not.toHaveBeenCalled();
    expect(mockDebit).not.toHaveBeenCalled();
  });

  // ── T-RA-03 (AC-1): key-session auth-only → 200, NO debit ──
  it('T-RA-03: valid key-session token → 200, no session debit, no master debit', async () => {
    mockSessionLookup.mockResolvedValue(makeKeySessionRow());
    mockSessionGetParent.mockResolvedValue(makeKeyRow());

    const response = await app.inject({
      method: 'POST',
      url: '/test-free',
      headers: { authorization: `Bearer ${SESS_TOKEN}` },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().a2aKeyId).toBe(TEST_KEY_ID);
    expect(mockSessionDebit).not.toHaveBeenCalled();
    expect(mockDebit).not.toHaveBeenCalled();
  });

  // ── T-RA-04 (AC-2): auth failures preserve status + error_code, never debit ──
  it('T-RA-04a master: lookup null → 403 KEY_NOT_FOUND', async () => {
    mockLookupByHash.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST',
      url: '/test-free',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('KEY_NOT_FOUND');
    expect(mockDebit).not.toHaveBeenCalled();
  });

  it('T-RA-04b master: inactive key → 403 KEY_INACTIVE', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow({ is_active: false }));
    const res = await app.inject({
      method: 'POST',
      url: '/test-free',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('KEY_INACTIVE');
    expect(mockDebit).not.toHaveBeenCalled();
  });

  it('T-RA-04c delegation: lookup null → 401 INVALID_SESSION_TOKEN', async () => {
    mockLookupToken.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST',
      url: '/test-free',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error_code).toBe('INVALID_SESSION_TOKEN');
    expect(mockDebitDelegation).not.toHaveBeenCalled();
  });

  it('T-RA-04d delegation: revoked → 403 DELEGATION_REVOKED', async () => {
    mockLookupToken.mockResolvedValue(
      makeDelegationRow({ revoked_at: new Date().toISOString() }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/test-free',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('DELEGATION_REVOKED');
    expect(mockDebitDelegation).not.toHaveBeenCalled();
  });

  it('T-RA-04e delegation: expired → 403 DELEGATION_EXPIRED', async () => {
    mockLookupToken.mockResolvedValue(
      makeDelegationRow({
        expires_at: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/test-free',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('DELEGATION_EXPIRED');
    expect(mockDebitDelegation).not.toHaveBeenCalled();
  });

  it('T-RA-04f delegation: parent inactive → 403 KEY_INACTIVE', async () => {
    mockLookupToken.mockResolvedValue(makeDelegationRow());
    mockGetParentKey.mockResolvedValue(makeKeyRow({ is_active: false }));
    const res = await app.inject({
      method: 'POST',
      url: '/test-free',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('KEY_INACTIVE');
    expect(mockDebitDelegation).not.toHaveBeenCalled();
  });

  it('T-RA-04g session: lookup null → 401 SESSION_TOKEN_INVALID', async () => {
    mockSessionLookup.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST',
      url: '/test-free',
      headers: { authorization: `Bearer ${SESS_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error_code).toBe('SESSION_TOKEN_INVALID');
    expect(mockSessionDebit).not.toHaveBeenCalled();
  });

  it('T-RA-04h session: expired → 403 SESSION_EXPIRED', async () => {
    mockSessionLookup.mockResolvedValue(
      makeKeySessionRow({
        expires_at: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    mockSessionGetParent.mockResolvedValue(makeKeyRow());
    const res = await app.inject({
      method: 'POST',
      url: '/test-free',
      headers: { authorization: `Bearer ${SESS_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('SESSION_EXPIRED');
    expect(mockSessionDebit).not.toHaveBeenCalled();
  });

  it('T-RA-04i session: parent inactive → 403 KEY_INACTIVE', async () => {
    mockSessionLookup.mockResolvedValue(makeKeySessionRow());
    mockSessionGetParent.mockResolvedValue(makeKeyRow({ is_active: false }));
    const res = await app.inject({
      method: 'POST',
      url: '/test-free',
      headers: { authorization: `Bearer ${SESS_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('KEY_INACTIVE');
    expect(mockSessionDebit).not.toHaveBeenCalled();
  });

  // ── T-RA-05 (AC-3): no credential → 403 A2A_KEY_REQUIRED, x402 never touched ──
  it('T-RA-05a: no a2a-key / no authorization → 403 A2A_KEY_REQUIRED, x402 untouched', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test-free',
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('A2A_KEY_REQUIRED');
    expect(mockGetPaymentAdapter).not.toHaveBeenCalled();
  });

  it('T-RA-05b: x-payment present but no a2a-key → 403 A2A_KEY_REQUIRED, x402 untouched', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test-free',
      headers: {
        'x-payment': Buffer.from(
          JSON.stringify({ scheme: 'exact', payload: {} }),
        ).toString('base64'),
      },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('A2A_KEY_REQUIRED');
    expect(mockGetPaymentAdapter).not.toHaveBeenCalled();
  });

  // ── T-RA-06 (AC-4): shared builder produces delegation scoping ──
  it('T-RA-06: delegation with allowed_agent_slugs → effectiveRow scoping propagated', async () => {
    mockLookupToken.mockResolvedValue(
      makeDelegationRow({
        policy: {
          max_amount_per_tx: '5.00',
          max_total_amount: '100.00',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          allowed_chains: [],
          allowed_agent_slugs: ['my-weather-agent'],
          allowed_registries: [],
        },
      }),
    );
    mockGetParentKey.mockResolvedValue(makeKeyRow());

    const res = await app.inject({
      method: 'POST',
      url: '/test-free',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().allowedSlugs).toEqual(['my-weather-agent']);
    expect(res.json().ownerRef).toBe('user-1');
  });

  // ── T-RA-07 (AC-7): per-request signature honored (opt-in) ──
  it('T-RA-07a master: require_signature + no signature → 401 SIGNATURE_REQUIRED', async () => {
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({
        require_signature: true,
        funding_wallet: '0x1111111111111111111111111111111111111111',
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/test-free',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error_code).toBe('SIGNATURE_REQUIRED');
    expect(mockVerifySignedAuth).not.toHaveBeenCalled();
  });

  it('T-RA-07b master: require_signature + valid signature → 200', async () => {
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({
        require_signature: true,
        funding_wallet: '0x1111111111111111111111111111111111111111',
      }),
    );
    mockVerifySignedAuth.mockResolvedValue({ ok: true });
    const res = await app.inject({
      method: 'POST',
      url: '/test-free',
      headers: { 'x-a2a-key': TEST_KEY, ...SIG_HEADERS },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(mockVerifySignedAuth).toHaveBeenCalledTimes(1);
    expect(mockDebit).not.toHaveBeenCalled();
  });

  it('T-RA-07c session: require_signature + no signature → 401 SIGNATURE_REQUIRED', async () => {
    mockSessionLookup.mockResolvedValue(
      makeKeySessionRow({
        require_signature: true,
        signing_secret_hash: 'f'.repeat(64),
      }),
    );
    mockSessionGetParent.mockResolvedValue(makeKeyRow());
    const res = await app.inject({
      method: 'POST',
      url: '/test-free',
      headers: { authorization: `Bearer ${SESS_TOKEN}` },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error_code).toBe('SIGNATURE_REQUIRED');
    expect(mockVerifySignedAuth).not.toHaveBeenCalled();
  });

  // ── T-RA-08 (AC-8/DT-C): spend-limits NOT checked in auth-only path ──
  it('T-RA-08: exhausted daily limit → still 200 (auth-only ignores spend-limits), no debit', async () => {
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({
        daily_limit_usd: '10.000000',
        daily_spent_usd: '10.000000',
        daily_reset_at: new Date(Date.now() + 86400000).toISOString(),
        max_spend_per_call_usd: '0.01',
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/test-free',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().a2aKeyId).toBe(TEST_KEY_ID);
    expect(mockDebit).not.toHaveBeenCalled();
  });

  // ── T-RA-BLD: builder contract anchors (DT-B) ──
  it('T-RA-BLD: buildDelegationEffectiveRow maps policy scoping', () => {
    const parent = makeKeyRow({
      allowed_registries: ['parent-reg'],
      allowed_agent_slugs: ['parent-slug'],
    });
    const del = makeDelegationRow({
      policy: {
        max_amount_per_tx: '5.00',
        max_total_amount: '100.00',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        allowed_chains: [],
        allowed_agent_slugs: ['deleg-slug'],
        allowed_registries: [],
      },
    });
    const row = buildDelegationEffectiveRow(parent, del);
    expect(row.allowed_agent_slugs).toEqual(['deleg-slug']);
    expect(row.allowed_registries).toBeNull();
    expect(row.owner_ref).toBe(parent.owner_ref);
  });

  it('T-RA-BLD: buildSessionEffectiveRow inherits parent on null dimensions', () => {
    const parent = makeKeyRow({
      allowed_registries: ['parent-reg'],
      allowed_agent_slugs: ['parent-slug'],
      allowed_categories: ['parent-cat'],
    });
    const session = makeKeySessionRow({
      allowed_registries: null,
      allowed_agent_slugs: ['sess-slug'],
      allowed_categories: null,
    });
    const row = buildSessionEffectiveRow(parent, session);
    expect(row.allowed_registries).toEqual(['parent-reg']);
    expect(row.allowed_agent_slugs).toEqual(['sess-slug']);
    expect(row.allowed_categories).toEqual(['parent-cat']);
  });
});

// ── WKH-175: default-chain UX en ops pagas ───────────────────────
// Las 3 mejoras son ADITIVAS (no cambian el default, no lo hacen obligatorio,
// no cambian status/code): (1) warn cuando se aplica el default por ausencia de
// `x-payment-chain`, (2) 403 INSUFFICIENT_BUDGET accionable (slug + causa +
// chains con saldo), (3) header de respuesta `x-a2a-payment-chain`.

describe('WKH-175 — default-chain UX (a2a-key paid path)', () => {
  let app: ReturnType<typeof Fastify>;
  let logWarnSpy: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    app = Fastify();
    // Mismo patrón que AC-11 (log shape): un hook global corre ANTES del
    // preHandler de la ruta, así que reemplazar `req.log.warn` acá alcanza para
    // observar lo que emite el middleware.
    app.addHook('preHandler', async (req: FastifyRequest) => {
      req.log.warn = logWarnSpy as unknown as FastifyRequest['log']['warn'];
    });
    app.post(
      '/test-175',
      { preHandler: requirePaymentOrA2AKey({ description: 'wkh-175' }) },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
    setMockRegistryState(
      ['kite-ozone-testnet', 'avalanche-fuji'],
      'kite-ozone-testnet',
    );
    mockReceiptEmit.mockResolvedValue(undefined);
    logWarnSpy = vi.fn();
    // El warn del default está deduplicado POR CALLER (keyId) + VENTANA temporal
    // (fix-pack MNR-1 del AR; ya NO es por proceso/slug): sin este reset, el
    // primer test que resuelve el default con este keyId se come el warn de los
    // siguientes durante los 15 min de la ventana. Sin argumento → cap de
    // producción (la política de desalojo se testea aparte, en
    // x402.chain-aware.test.ts, con un cap chico).
    _resetDefaultChainWarnDedup();
  });

  const findDefaultWarn = () =>
    logWarnSpy.mock.calls.find(
      (c) =>
        c[1] === 'payment chain resolved by default (x-payment-chain absent)',
    );

  // ── T-175-1 (mejora 1+3): header ausente → warn + eco del slug default ──
  it('T-175-1: sin x-payment-chain → warn del default aplicado + header x-a2a-payment-chain', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockDebit.mockResolvedValue({ success: true });
    mockGetBalance.mockResolvedValue('9.000000');

    const res = await app.inject({
      method: 'POST',
      url: '/test-175',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    // (1) el default ya NO es silencioso.
    const warnCall = findDefaultWarn();
    expect(warnCall).toBeDefined();
    expect(warnCall?.[0]).toMatchObject({
      chainKey: 'kite-ozone-testnet',
      header: 'x-payment-chain',
      // Fix-pack MNR-1: identidad del caller (id interno, NUNCA el rawKey) + ruta.
      keyId: TEST_KEY_ID,
      method: 'POST',
      route: '/test-175',
    });
    // (3) eco de la chain efectivamente usada.
    expect(res.headers['x-a2a-payment-chain']).toBe('kite-ozone-testnet');
    // Compatibilidad: el caller sin header sigue cobrando en el default (2368).
    expect(mockDebit).toHaveBeenCalledWith(
      TEST_KEY_ID,
      2368,
      1.0,
      undefined,
      undefined,
      undefined,
      'user-1',
    );
  });

  // ── T-175-2 (mejora 1+3): header presente y válido → sin warn, eco del slug ──
  it('T-175-2: con x-payment-chain válido → NO warn de default + header con ese slug', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockDebit.mockResolvedValue({ success: true });
    mockGetBalance.mockResolvedValue('5.000000');

    const res = await app.inject({
      method: 'POST',
      url: '/test-175',
      headers: { 'x-a2a-key': TEST_KEY, 'x-payment-chain': 'avalanche-fuji' },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(findDefaultWarn()).toBeUndefined();
    expect(res.headers['x-a2a-payment-chain']).toBe('avalanche-fuji');
  });

  // ── T-175-3 (hot-path): el warn está deduplicado por CALLER + ventana ──
  // Fix-pack MNR-1 — semántica NUEVA: la clave del dedup pasó de `chainKey`
  // (un solo valor posible: el default → 1 warn por proceso y nunca más) a la
  // identidad del caller (`keyId`) con una ventana temporal. Acá el caller es
  // el MISMO en los 2 requests → sigue esperando 1 solo warn; el caso "callers
  // distintos" lo cubre T-175-11.
  it('T-175-3: 2 requests del MISMO caller sin header → 1 solo warn (ventana, evita ruido en hot-path)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());
    mockDebit.mockResolvedValue({ success: true });
    mockGetBalance.mockResolvedValue('9.000000');

    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/test-175',
        headers: { 'x-a2a-key': TEST_KEY },
        payload: {},
      });
      // El header de respuesta SÍ va en las dos (no está deduplicado).
      expect(res.headers['x-a2a-payment-chain']).toBe('kite-ozone-testnet');
    }

    const defaultWarns = logWarnSpy.mock.calls.filter(
      (c) =>
        c[1] === 'payment chain resolved by default (x-payment-chain absent)',
    );
    expect(defaultWarns).toHaveLength(1);
  });

  // ── T-175-4 (mejora 2): 403 accionable con la causa del default ──
  it('T-175-4: 403 INSUFFICIENT_BUDGET → slug + causa (default) + chains con saldo, mismo status/code', async () => {
    // Saldo real en fuji (43113); la key pide sin header → cae en kite (2368).
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({ budget: { '2368': '0', '43113': '7.500000' } }),
    );
    mockDebit.mockResolvedValue({ success: false, error: 'Insufficient' });
    mockGetBalance.mockResolvedValue('0');

    const res = await app.inject({
      method: 'POST',
      url: '/test-175',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });

    // Contrato estable: status 403 + error_code INSUFFICIENT_BUDGET.
    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('INSUFFICIENT_BUDGET');
    expect(res.json().error).toBe(
      "chain 2368 (kite-ozone-testnet) balance is 0; no x-payment-chain header sent, used default 'kite-ozone-testnet'; chains with balance: avalanche-fuji (7.500000)",
    );
    // El header también viaja en el 403 (ahí es donde más se necesita).
    expect(res.headers['x-a2a-payment-chain']).toBe('kite-ozone-testnet');
    // Sin queries extra: el listado sale del `budget` en memoria (un solo
    // getBalance, el que ya existía para el chain target).
    expect(mockGetBalance).toHaveBeenCalledTimes(1);
  });

  // ── T-175-5 (mejora 2): la key no tiene saldo en NINGUNA chain ──
  it('T-175-5: sin saldo en ninguna chain → el mensaje lo dice sin romperse', async () => {
    // Fix-pack MNR-3: el segmento final pasó de "no chain has balance" a "no
    // other chain has balance" porque la chain target ya está excluida de la
    // lista por diseño (su saldo lo reporta el PRIMER segmento).
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({ budget: { '2368': '0', '43113': '0.000000' } }),
    );
    mockDebit.mockResolvedValue({ success: false, error: 'Insufficient' });
    mockGetBalance.mockResolvedValue('0');

    const res = await app.inject({
      method: 'POST',
      url: '/test-175',
      headers: { 'x-a2a-key': TEST_KEY, 'x-payment-chain': 'avalanche-fuji' },
      payload: {},
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('INSUFFICIENT_BUDGET');
    expect(res.json().error).toBe(
      'chain 43113 (avalanche-fuji) balance is 0; no other chain has balance',
    );
  });

  // ── T-175-6 (mejora 2): budget vacío {} → tampoco rompe ──
  it('T-175-6: budget vacío → mensaje sin lista, sin excepción', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow({ budget: {} }));
    mockDebit.mockResolvedValue({ success: false, error: 'Insufficient' });
    mockGetBalance.mockResolvedValue('0');

    const res = await app.inject({
      method: 'POST',
      url: '/test-175',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });

    expect(res.statusCode).toBe(403);
    // Fix-pack MNR-3: texto exacto (antes era un `toContain` parcial) con el
    // nuevo segmento "no other chain has balance".
    expect(res.json().error).toBe(
      "chain 2368 (kite-ozone-testnet) balance is 0; no x-payment-chain header sent, used default 'kite-ozone-testnet'; no other chain has balance",
    );
  });

  // ── T-175-7: chainId con saldo NO inicializado en este proceso ──
  it('T-175-7: saldo en una chain no inicializada → se muestra como "chain <id>" (no se inventa slug)', async () => {
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({ budget: { '2368': '0', '84532': '3.000000' } }),
    );
    mockDebit.mockResolvedValue({ success: false, error: 'Insufficient' });
    mockGetBalance.mockResolvedValue('0');

    const res = await app.inject({
      method: 'POST',
      url: '/test-175',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain(
      'chains with balance: chain 84532 (3.000000)',
    );
  });

  // ── T-175-8: los branches delegación/sesión también echan el header ──
  it('T-175-8: delegación sin header → warn + x-a2a-payment-chain del default', async () => {
    mockLookupToken.mockResolvedValue(makeDelegationRow());
    mockGetParentKey.mockResolvedValue(makeKeyRow());
    mockExceedsPerTx.mockReturnValue(false);
    mockDebitDelegation.mockResolvedValue('1.00');
    mockGetBalance.mockResolvedValue('49.00');

    const res = await app.inject({
      method: 'POST',
      url: '/test-175',
      headers: { authorization: `Bearer ${SESSION_TOKEN}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-a2a-payment-chain']).toBe('kite-ozone-testnet');
    expect(findDefaultWarn()).toBeDefined();
  });

  it('T-175-9: key-session con header válido → x-a2a-payment-chain de ese slug, sin warn', async () => {
    mockSessionLookup.mockResolvedValue(makeKeySessionRow());
    mockSessionGetParent.mockResolvedValue(makeKeyRow());
    mockSessionDebit.mockResolvedValue('1.00');
    mockGetBalance.mockResolvedValue('9.00');

    const res = await app.inject({
      method: 'POST',
      url: '/test-175',
      headers: {
        authorization: `Bearer ${SESS_TOKEN}`,
        'x-payment-chain': 'avalanche-fuji',
      },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-a2a-payment-chain']).toBe('avalanche-fuji');
    expect(findDefaultWarn()).toBeUndefined();
  });

  // ── T-175-10: header presente pero DESCONOCIDO → intacto (400, sin eco) ──
  it('T-175-10: x-payment-chain desconocido → 400 CHAIN_NOT_SUPPORTED intacto (scope OUT)', async () => {
    mockLookupByHash.mockResolvedValue(makeKeyRow());

    const res = await app.inject({
      method: 'POST',
      url: '/test-175',
      headers: { 'x-a2a-key': TEST_KEY, 'x-payment-chain': 'ethereum-mainnet' },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('CHAIN_NOT_SUPPORTED');
    // No hubo chain resuelta → no hay nada que ecoar, y NO se aplicó default.
    expect(res.headers['x-a2a-payment-chain']).toBeUndefined();
    expect(findDefaultWarn()).toBeUndefined();
    expect(mockDebit).not.toHaveBeenCalled();
  });

  // ── T-175-11 (fix-pack MNR-1): el dedup es por CALLER, no por chain ──
  // Es el caso de uso que motivó el ticket: si un caller nuevo empieza a
  // defaultear, tiene que avisar aunque otro caller ya haya warneado antes.
  it('T-175-11: 2 callers DISTINTOS sin header → 1 warn cada uno, con su keyId', async () => {
    const OTHER_KEY_ID = 'ffffffff-0000-1111-2222-333333333333';
    mockDebit.mockResolvedValue({ success: true });
    mockGetBalance.mockResolvedValue('9.000000');
    mockLookupByHash
      .mockResolvedValueOnce(makeKeyRow())
      .mockResolvedValueOnce(makeKeyRow({ id: OTHER_KEY_ID }));

    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/test-175',
        headers: { 'x-a2a-key': TEST_KEY },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
    }

    const defaultWarns = logWarnSpy.mock.calls.filter(
      (c) =>
        c[1] === 'payment chain resolved by default (x-payment-chain absent)',
    );
    expect(defaultWarns).toHaveLength(2);
    // Cada warn identifica a su caller por el id INTERNO de la key (nunca el
    // rawKey ni ningún secreto) + la ruta/método donde pasó.
    expect(defaultWarns.map((c) => (c[0] as { keyId: string }).keyId)).toEqual([
      TEST_KEY_ID,
      OTHER_KEY_ID,
    ]);
    expect(defaultWarns[0]?.[0]).toMatchObject({
      chainKey: 'kite-ozone-testnet',
      method: 'POST',
      route: '/test-175',
    });
  });

  // ── T-175-12 (fix-pack MNR-3): el 403 NUNCA sugiere la chain que falló ──
  // Repro determinístico del CR: saldo 0.500000 en la chain target y precio $1 →
  // el saldo es > 0 (pasa el filtro del `budget` jsonb) pero INSUFICIENTE. El
  // mensaje viejo salía "...; chains with balance: kite-ozone-testnet (0.500000)"
  // → le ofrecía como alternativa la misma red que lo acababa de rechazar, que es
  // exactamente lo que esta HU ("error accionable") quería evitar.
  it('T-175-12: saldo > 0 pero insuficiente en la chain target → NO aparece en "chains with balance"', async () => {
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({ budget: { '2368': '0.500000' } }),
    );
    mockDebit.mockResolvedValue({ success: false, error: 'Insufficient' });
    // Lectura fresca post-debit-fallido: el saldo real de la target.
    mockGetBalance.mockResolvedValue('0.500000');

    const res = await app.inject({
      method: 'POST',
      url: '/test-175',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('INSUFFICIENT_BUDGET');
    // El PRIMER segmento ya informa el saldo de la target; la lista de
    // alternativas queda vacía → "no other chain has balance".
    expect(res.json().error).toBe(
      "chain 2368 (kite-ozone-testnet) balance is 0.500000; no x-payment-chain header sent, used default 'kite-ozone-testnet'; no other chain has balance",
    );
    // Guard explícito: el slug de la chain target NO puede aparecer después del
    // "chains with balance:" (que acá no existe) ni como sugerencia.
    expect(res.json().error).not.toContain('chains with balance');
    // El log comparte EXACTAMENTE la misma lista (MNR-4: se computa una vez).
    const warnCall = logWarnSpy.mock.calls.find(
      (c) => c[1] === 'a2a-key.insufficient-budget',
    );
    expect(warnCall?.[0]).toMatchObject({
      chainId: 2368,
      fundedChains: [],
    });
  });

  // ── T-175-13 (fix-pack MNR-3): con OTRA chain fondeada, esa sí se sugiere ──
  it('T-175-13: target con saldo insuficiente + otra chain fondeada → lista sólo la otra', async () => {
    mockLookupByHash.mockResolvedValue(
      makeKeyRow({ budget: { '2368': '0.500000', '43113': '9.000000' } }),
    );
    mockDebit.mockResolvedValue({ success: false, error: 'Insufficient' });
    mockGetBalance.mockResolvedValue('0.500000');

    const res = await app.inject({
      method: 'POST',
      url: '/test-175',
      headers: { 'x-a2a-key': TEST_KEY },
      payload: {},
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe(
      "chain 2368 (kite-ozone-testnet) balance is 0.500000; no x-payment-chain header sent, used default 'kite-ozone-testnet'; chains with balance: avalanche-fuji (9.000000)",
    );
  });
});
