/**
 * Compose HTTP e2e flow — audit 2026-06-24 (P0)
 *
 * Closes the e2e gap: there was no HTTP happy-path that drives the REAL
 * composeService through the route over the wire. This file mounts the real
 * `composeRoutes` + real `composeService` and mocks only the leaf I/O:
 *   - a2a-key middleware (pass-through; injects a2aKeyRow + price fields, like
 *     the AUDIT A1 pattern in routes/compose.test.ts),
 *   - agent-price resolvers (so the price preHandler resolves),
 *   - discovery.getAgent / discovery.discover (resolve the per-step agents),
 *   - budget.debit / credit / creditWithDest (per-step debit + step-0 refund),
 *   - registryService.getEnabled, the payment adapter, fee-charge, receipt,
 *     event, the LLM bridge + downstream payment, and global fetch
 *     (the agent HTTP call).
 *
 * Scenarios:
 *   P0-1  2-step happy path → 200, success, both step outputs, totalCostUsdc.
 *   P0-2  2-step where step-2's agent returns 500 → 4xx, success=false, and the
 *         route's step-0 refund is attempted (creditWithDest).
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
import type { Agent } from '../../types/index.js';

// ── Mock auth middleware (pass-through, injects price/debit fields) ──
let nextKeyRow: { id: string; owner_ref: string } | undefined;
let nextEstimatedCostUsd: number | undefined;
let nextResolvedChainId: number | undefined;
let nextInjectedDestination: string | undefined;
vi.mock('../../middleware/a2a-key.js', () => ({
  requirePaymentOrA2AKey: () => [
    async (request: FastifyRequest, _reply: FastifyReply) => {
      (request as unknown as { a2aKeyRow: unknown }).a2aKeyRow = nextKeyRow;
      if (nextEstimatedCostUsd !== undefined) {
        (
          request as unknown as { composeEstimatedCostUsd?: number }
        ).composeEstimatedCostUsd = nextEstimatedCostUsd;
      }
      if (nextResolvedChainId !== undefined) {
        (request as unknown as { resolvedChainId?: number }).resolvedChainId =
          nextResolvedChainId;
      }
      if (nextInjectedDestination !== undefined) {
        (
          request as unknown as { composeDestination?: string }
        ).composeDestination = nextInjectedDestination;
      }
    },
  ],
}));

vi.mock('../../middleware/timeout.js', () => ({
  createTimeoutHandler:
    () => async (_request: FastifyRequest, _reply: FastifyReply) => {
      /* no-op */
    },
}));

vi.mock('../../middleware/forward-key.js', () => ({
  requireForwardKey: () => [],
}));

vi.mock('../../middleware/rate-limit.js', () => ({
  orchestrateRateLimit: () => false,
}));

// ── agent-price resolvers (price preHandler) ────────────────
vi.mock('../../services/agent-price.js', () => ({
  resolveAgentPriceUsdc: vi.fn(),
  resolveAgentDestination: vi.fn(),
}));

// ── budget (per-step debit + step-0 refund) ─────────────────
vi.mock('../../services/budget.js', () => ({
  budgetService: {
    debit: vi.fn().mockResolvedValue({ success: true }),
    credit: vi.fn().mockResolvedValue({ success: true }),
    creditWithDest: vi.fn().mockResolvedValue({ success: true }),
  },
}));

// ── discovery (resolveAgent) ────────────────────────────────
vi.mock('../../services/discovery.js', () => ({
  discoveryService: { getAgent: vi.fn(), discover: vi.fn() },
}));

// ── registry (invokeAgent → getEnabled) ─────────────────────
vi.mock('../../services/registry.js', () => ({
  registryService: { getEnabled: vi.fn().mockResolvedValue([]) },
}));

// ── payment adapter (sign is unused on a2a-key path) ────────
vi.mock('../../adapters/registry.js', () => ({
  getPaymentAdapter: () => ({ sign: vi.fn(), settle: vi.fn() }),
}));

// ── fee-charge (best-effort; skip so it's a no-op) ──────────
vi.mock('../../services/fee-charge.js', () => ({
  chargeProtocolFee: vi
    .fn()
    .mockResolvedValue({ status: 'skipped', feeUsdc: 0 }),
  getProtocolFeeRate: vi.fn().mockReturnValue(0.01),
}));

vi.mock('../../services/receipt.js', () => ({
  receiptService: { emit: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../services/event.js', () => ({
  eventService: { track: vi.fn().mockResolvedValue(undefined) },
}));

// ── LLM bridge + downstream payment (leaf I/O) ──────────────
vi.mock('../../services/llm/transform.js', () => ({
  maybeTransform: vi.fn().mockResolvedValue({
    transformedOutput: null,
    cacheHit: 'SKIPPED',
    bridgeType: 'SKIPPED',
    latencyMs: 0,
  }),
}));
vi.mock('../../services/llm/input-retry.js', () => ({
  regenerateInputFromErrors: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../lib/downstream-payment.js', () => ({
  signAndSettleDownstream: vi.fn().mockResolvedValue(null),
}));

// undici-8 migration (#124): `ssrfFetch` calls undici's OWN `fetch` (not
// the Node global) so the undici-8 Agent and the fetch implementation share a
// version. Route BOTH the global stub and undici's `fetch` to the same
// `mockFetch` so the outbound-call assertions still intercept while the real
// undici `Agent` (connect-time SSRF lookup) stays intact.
const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.stubGlobal('fetch', mockFetch);
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: mockFetch };
});

import composeRoutes from '../../routes/compose.js';
import {
  resolveAgentDestination,
  resolveAgentPriceUsdc,
} from '../../services/agent-price.js';
import { budgetService } from '../../services/budget.js';
import { discoveryService } from '../../services/discovery.js';

const mockResolvePrice = vi.mocked(resolveAgentPriceUsdc);
const mockResolveDest = vi.mocked(resolveAgentDestination);
const mockGetAgent = vi.mocked(discoveryService.getAgent);
const mockDiscoverSvc = vi.mocked(discoveryService.discover);
const mockDebit = vi.mocked(budgetService.debit);
const mockCreditWithDest = vi.mocked(budgetService.creditWithDest);

// ── Fixtures ────────────────────────────────────────────────
function makeAgent(o: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    slug: 'test-agent',
    description: 'A test agent',
    capabilities: ['test'],
    priceUsdc: 0.05,
    registry: 'wasiai',
    registry_id: 'wasiai',
    invokeUrl: 'https://example.com/invoke',
    invocationNote: 'use /compose',
    verified: false,
    status: 'active',
    metadata: {},
    ...o,
  };
}

function okFetch(body: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

describe('compose HTTP e2e flow (P0)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(composeRoutes, { prefix: '/compose' });
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
    nextKeyRow = { id: 'k1', owner_ref: 'o1' };
    nextEstimatedCostUsd = undefined;
    nextResolvedChainId = undefined;
    nextInjectedDestination = undefined;
    mockResolvePrice.mockResolvedValue(0.05);
    mockResolveDest.mockResolvedValue({ registry: 'wasiai', slug: 'kyc' });
    mockDebit.mockResolvedValue({ success: true });
    mockCreditWithDest.mockResolvedValue({ success: true });
    // discover fallback (resolveAgent hydration path) returns nothing useful.
    mockDiscoverSvc.mockResolvedValue({
      agents: [],
      total: 0,
      registries: [],
    });
  });

  // ── P0-1: 2-step happy path ────────────────────────────────
  it('P0-1: 2-step pipeline with a valid a2a key → 200, success, both outputs, totalCostUsdc', async () => {
    nextEstimatedCostUsd = 0.05; // middleware debited step-0
    nextResolvedChainId = 2368;
    nextInjectedDestination = 'wasiai/kyc';

    const kyc = makeAgent({
      id: 'kyc-id',
      slug: 'kyc',
      name: 'KYC',
      priceUsdc: 0.05,
      invokeUrl: 'https://example.com/kyc',
    });
    const corridor = makeAgent({
      id: 'corridor-id',
      slug: 'corridor',
      name: 'Corridor',
      priceUsdc: 0.1,
      invokeUrl: 'https://example.com/corridor',
    });

    // resolveAgent calls getAgent(slug, registry) then getAgent(slug).
    mockGetAgent.mockImplementation(async (slug: string) => {
      if (slug === 'kyc') return kyc;
      if (slug === 'corridor') return corridor;
      return null;
    });

    // Two agent invocations → two distinct outputs.
    mockFetch
      .mockResolvedValueOnce(okFetch({ result: { verified: true } }))
      .mockResolvedValueOnce(okFetch({ result: { corridor: 'US-MX' } }));

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: {
        steps: [
          { agent: 'kyc', input: { user: 'alice' } },
          { agent: 'corridor', input: { amount: 100 } },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    // Both steps executed and produced output.
    expect(body.steps).toHaveLength(2);
    expect(body.steps[0].output).toEqual({ verified: true });
    expect(body.steps[1].output).toEqual({ corridor: 'US-MX' });
    // Final output is the last step's output.
    expect(body.output).toEqual({ corridor: 'US-MX' });
    // totalCostUsdc = sum of per-step prices (0.05 + 0.10).
    expect(body.totalCostUsdc).toBeCloseTo(0.15, 6);
    // Step-2 (i=1) was debited per-step; step-0 was debited by the middleware.
    expect(mockDebit).toHaveBeenCalledTimes(1);
    expect(mockDebit).toHaveBeenCalledWith(
      'k1',
      2368,
      0.1,
      undefined,
      undefined,
      'wasiai/corridor',
      'o1', // F-04 (audit): threaded caller owner_ref
    );
    // Happy path → no refund.
    expect(mockCreditWithDest).not.toHaveBeenCalled();
  });

  // ── P0-2: step-2 agent returns 500 → failure + step-0 refund ──
  it('P0-2: step-2 agent returns 500 → 4xx, success=false, step-2 debit refunded + step-0 refunded', async () => {
    nextEstimatedCostUsd = 0.05; // step-0 pre-debit by middleware
    nextResolvedChainId = 2368;
    nextInjectedDestination = 'wasiai/kyc';

    const kyc = makeAgent({
      id: 'kyc-id',
      slug: 'kyc',
      name: 'KYC',
      priceUsdc: 0.05,
      invokeUrl: 'https://example.com/kyc',
    });
    const corridor = makeAgent({
      id: 'corridor-id',
      slug: 'corridor',
      name: 'Corridor',
      priceUsdc: 0.1,
      invokeUrl: 'https://example.com/corridor',
    });
    mockGetAgent.mockImplementation(async (slug: string) => {
      if (slug === 'kyc') return kyc;
      if (slug === 'corridor') return corridor;
      return null;
    });

    // Step 1 (kyc) succeeds; step 2 (corridor) HTTP 500.
    mockFetch
      .mockResolvedValueOnce(okFetch({ result: { verified: true } }))
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: 'boom' }),
        text: async () => 'internal agent error',
      });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: {
        steps: [
          { agent: 'kyc', input: { user: 'alice' } },
          { agent: 'corridor', input: { amount: 100 } },
        ],
      },
    });

    // Mid-pipeline failure (no SCOPE_DENIED / DEST_CAP) → default 400.
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain('Step 1');

    // The service refunds the step-2 per-step debit (WKH-128) via creditWithDest
    // with the corridor destination.
    const corridorRefund = mockCreditWithDest.mock.calls.find(
      (c) => c[4] === 'wasiai/corridor',
    );
    expect(corridorRefund).toBeDefined();
    expect(corridorRefund?.[0]).toBe('k1');
    expect(corridorRefund?.[1]).toBe(2368);
    expect(corridorRefund?.[2]).toBeCloseTo(0.1, 6);
  });

  // ── Single-step happy path (sanity for the simplest HTTP path) ──
  it('P0-1b: single-step pipeline → 200 success with one output', async () => {
    nextEstimatedCostUsd = 0.05;
    nextResolvedChainId = 2368;
    nextInjectedDestination = 'wasiai/kyc';

    const kyc = makeAgent({
      id: 'kyc-id',
      slug: 'kyc',
      priceUsdc: 0.05,
      invokeUrl: 'https://example.com/kyc',
    });
    mockGetAgent.mockResolvedValue(kyc);
    mockFetch.mockResolvedValueOnce(okFetch({ result: { ok: 1 } }));

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { steps: [{ agent: 'kyc', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(res.json().steps).toHaveLength(1);
    // Only step-0 → no per-step debit (i=0 guard).
    expect(mockDebit).not.toHaveBeenCalled();
  });
});
