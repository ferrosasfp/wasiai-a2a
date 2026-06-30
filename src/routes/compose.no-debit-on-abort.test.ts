/**
 * Compose route — money-path regression: NO budget debit when the price
 * preHandler short-circuits (404 AGENT_NOT_FOUND / 503 REGISTRY_UNAVAILABLE).
 *
 * WHY A SEPARATE FILE: the sibling `compose.test.ts` globally mocks
 * `requirePaymentOrA2AKey` with a pass-through that NEVER debits — so it can
 * never observe the placeholder-fee drain bug. This suite wires the REAL
 * `requirePaymentOrA2AKey` middleware and mocks ONLY the data layer
 * (`identityService.lookupByHash` + `budgetService`) + the chain registry
 * helpers, so the actual debit path executes. The regression assertion is that
 * `budgetService.debit` is NEVER called on a short-circuited request, i.e. the
 * funded prepaid key's budget stays UNCHANGED.
 *
 * THE BUG (confirmed live, reproduced 3x): `POST /compose` with a non-existent
 * agent returned 404 AGENT_NOT_FOUND but STILL debited PLACEHOLDER_FEE_USD = 1.0
 * from the prepaid agent-key budget (never credited back) → a caller could drain
 * any key 1 USDC at a time with bogus agent names. The 404 path in the price
 * preHandler must `return reply.status(404).send(...)` so the preHandler chain
 * aborts BEFORE the debit middleware runs.
 */

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

// ── Structured logger mock (compose.ts + a2a-key.ts use getLogger) ──
const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({
  getLogger: () => logSpy,
}));

// ── Chain registry helpers (resolveTargetChain dependencies) ──
// The REAL middleware resolves a chain before debiting. Give it a working one.
vi.mock('../adapters/chain-resolver.js', () => ({
  resolveChainKey: () => 'kite',
}));
vi.mock('../adapters/registry.js', () => ({
  getDefaultChainKey: () => 'kite',
  getInitializedChainKeys: () => ['kite'],
  getAdaptersBundle: () => ({
    chainConfig: { chainId: 2368 },
    payment: { supportedTokens: [{ symbol: 'USDC' }] },
  }),
}));

// ── Agent price service: drives the preHandler short-circuit branch ──
vi.mock('../services/agent-price.js', () => ({
  resolveAgentPriceUsdc: vi.fn(),
  resolveAgentDestination: vi.fn().mockResolvedValue(null),
}));

// ── composeService: should NEVER be reached on an abort path ──
vi.mock('../services/compose.js', () => ({
  composeService: { compose: vi.fn() },
}));

// ── identityService: REAL middleware looks up the master key by hash ──
// Return a funded, active master key with a $10 budget on chain 2368.
// Hoisted so the vi.mock factory (lifted to top of file) can reference it.
const fundedKey = vi.hoisted(
  (): A2AAgentKeyRow => ({
    id: 'k1',
    owner_ref: 'o1',
    key_hash: 'hash',
    display_name: null,
    budget: { '2368': '10.00' },
    daily_limit_usd: null,
    daily_spent_usd: '0',
    daily_reset_at: new Date(Date.now() + 86_400_000).toISOString(),
    allowed_registries: null,
    allowed_agent_slugs: null,
    allowed_categories: null,
    max_spend_per_call_usd: null,
    is_active: true,
    last_used_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    erc8004_identity: null,
    kite_passport: null,
    agentkit_wallet: null,
    funding_wallet: null,
    metadata: {},
    require_signature: false,
  }),
);
vi.mock('../services/identity.js', () => ({
  isIdentityVerified: () => false,
  identityService: {
    lookupByHash: vi.fn().mockResolvedValue(fundedKey),
  },
}));

// ── budgetService: in-memory budget so we OBSERVE the debit side-effect ──
// `debit` decrements the tracked balance and records every call. The whole
// point of this suite is to assert it is NEVER invoked on an abort path.
// Hoisted so the vi.mock factory can reference them.
const budgetState = vi.hoisted(() => ({ balance: 10 }));
const debitMock = vi.hoisted(() =>
  vi.fn(
    async (
      _keyId: string,
      _chainId: number,
      amountUsd: number,
    ): Promise<{ success: boolean; error?: string }> => {
      budgetState.balance -= amountUsd;
      return { success: true };
    },
  ),
);
vi.mock('../services/budget.js', () => ({
  budgetService: {
    debit: debitMock,
    getBalance: vi.fn(async () => budgetState.balance.toFixed(2)),
    credit: vi.fn().mockResolvedValue({ success: true }),
    creditWithDest: vi.fn().mockResolvedValue({ success: true }),
  },
}));

// ── receiptService: fire-and-forget, no-op ──
vi.mock('../services/receipt.js', () => ({
  receiptService: { emit: vi.fn().mockResolvedValue(undefined) },
}));

// ── timeout + rate-limit middlewares: no-ops (not under test) ──
vi.mock('../middleware/timeout.js', () => ({
  createTimeoutHandler:
    () => async (_request: FastifyRequest, _reply: FastifyReply) => {
      /* no-op */
    },
}));
vi.mock('../middleware/rate-limit.js', () => ({
  orchestrateRateLimit: () => false,
}));

import { resolveAgentPriceUsdc } from '../services/agent-price.js';
import { composeService } from '../services/compose.js';
// NOTE: requirePaymentOrA2AKey is NOT mocked — the REAL middleware runs.
import composeRoutes from './compose.js';

const mockResolvePrice = vi.mocked(resolveAgentPriceUsdc);
const mockCompose = vi.mocked(composeService.compose);

describe('compose route — NO debit when price preHandler short-circuits', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(composeRoutes, { prefix: '/compose' });
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
    budgetState.balance = 10;
  });

  it('T-NO-DEBIT-404: non-existent agent → 404, prepaid budget UNCHANGED (no placeholder drain)', async () => {
    // Agent not found → price preHandler must 404 and ABORT before the debit.
    mockResolvePrice.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_funded_master_key' },
      payload: { steps: [{ agent: 'ghost-agent-does-not-exist', input: {} }] },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error_code).toBe('AGENT_NOT_FOUND');
    // THE REGRESSION ASSERTION: the debit middleware never ran → no $1
    // placeholder taken from the funded prepaid key.
    expect(debitMock).not.toHaveBeenCalled();
    expect(budgetState.balance).toBe(10);
    // And the pipeline never executed.
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('T-NO-DEBIT-503: discovery throws → 503, prepaid budget UNCHANGED', async () => {
    // Discovery error → price preHandler must 503 and ABORT before the debit.
    mockResolvePrice.mockRejectedValueOnce(new Error('PGRST connection lost'));

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_funded_master_key' },
      payload: { steps: [{ agent: 'kyc', input: {} }] },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error_code).toBe('REGISTRY_UNAVAILABLE');
    expect(debitMock).not.toHaveBeenCalled();
    expect(budgetState.balance).toBe(10);
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('T-NO-DEBIT-CONTROL: valid agent → debit DOES run (control: the harness can observe a real debit)', async () => {
    // Sanity check: if the agent resolves, the REAL middleware DOES debit, so a
    // 404/503 leaving the budget unchanged is a meaningful negative result.
    mockResolvePrice.mockResolvedValueOnce(0.5);
    mockCompose.mockResolvedValueOnce({
      success: true,
      output: 'ok',
      steps: [],
      totalCostUsdc: 0.5,
      totalLatencyMs: 1,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_funded_master_key' },
      payload: { steps: [{ agent: 'kyc', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    // The real debit ran and decremented the budget.
    expect(debitMock).toHaveBeenCalledTimes(1);
    expect(budgetState.balance).toBeLessThan(10);
  });
});
