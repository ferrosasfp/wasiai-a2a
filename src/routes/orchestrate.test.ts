/**
 * Orchestrate Routes Integration Tests — WKH-61 W4
 *
 * Mocks: a2a-key middleware (pass-through populating a2aKeyRow),
 *        timeout + rate-limit + backpressure middlewares (no-ops),
 *        orchestrateService (controlled responses).
 *
 * Tests cubren:
 *   - T-ROUTE-2  (AC-4 e2e): pipeline.errorCode='SCOPE_DENIED' → HTTP 403
 *   - T-ROUTE-2b (regresión): success → HTTP 200 (legacy)
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
import type { A2AAgentKeyRow, OrchestrateResult } from '../types/index.js';

// ── Mock auth middleware ─────────────────────────────────────
let nextKeyRow: Partial<A2AAgentKeyRow> | undefined;
vi.mock('../middleware/a2a-key.js', () => ({
  requirePaymentOrA2AKey: () => [
    async (request: FastifyRequest, _reply: FastifyReply) => {
      (request as unknown as { a2aKeyRow: unknown }).a2aKeyRow = nextKeyRow;
    },
  ],
}));

// ── Mock timeout middleware ─────────────────────────────────
vi.mock('../middleware/timeout.js', () => ({
  createTimeoutHandler:
    () => async (_request: FastifyRequest, _reply: FastifyReply) => {
      /* no-op */
    },
}));

// ── Mock rate-limit middleware ──────────────────────────────
vi.mock('../middleware/rate-limit.js', () => ({
  orchestrateRateLimit: () => false,
}));

// ── Mock backpressure middleware ────────────────────────────
vi.mock('../middleware/backpressure.js', () => ({
  createBackpressureHandler:
    () => async (_request: FastifyRequest, _reply: FastifyReply) => {
      /* no-op */
    },
}));

// ── Mock orchestrateService ─────────────────────────────────
vi.mock('../services/orchestrate.js', () => ({
  orchestrateService: {
    orchestrate: vi.fn(),
  },
}));

import { registerErrorBoundary } from '../middleware/error-boundary.js';
import { genReqId, registerRequestIdHook } from '../middleware/request-id.js';
import { orchestrateService } from '../services/orchestrate.js';
import orchestrateRoutes from './orchestrate.js';

const mockOrchestrate = vi.mocked(orchestrateService.orchestrate);

function okResult(over: Partial<OrchestrateResult> = {}): OrchestrateResult {
  return {
    orchestrationId: '33333333-3333-3333-3333-333333333333',
    answer: 'done',
    reasoning: 'ok',
    pipeline: {
      success: true,
      output: 'done',
      steps: [],
      totalCostUsdc: 0.4,
      totalLatencyMs: 50,
    },
    consideredAgents: [],
    protocolFeeUsdc: 0.004,
    ...over,
  };
}

// ── Setup ───────────────────────────────────────────────────

describe('orchestrate routes — WKH-61 scope mapping', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(orchestrateRoutes, { prefix: '/orchestrate' });
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
    nextKeyRow = { id: 'k1', owner_ref: 'o1' };
  });

  it('T-ROUTE-2 (AC-4 e2e): pipeline.errorCode=SCOPE_DENIED → 403', async () => {
    const denyResult: OrchestrateResult = {
      orchestrationId: '11111111-1111-1111-1111-111111111111',
      answer: null,
      reasoning: 'denied at compose step 0',
      pipeline: {
        success: false,
        output: null,
        steps: [],
        totalCostUsdc: 0,
        totalLatencyMs: 0,
        error:
          'Step 0 denied by scope: SCOPE_DENIED: category not in allowed list',
        errorCode: 'SCOPE_DENIED',
        scopeDeniedTarget: {
          registry: 'wasiai',
          agent_slug: 'social-bot',
          category: 'social',
        },
      },
      consideredAgents: [],
      protocolFeeUsdc: 0,
    };
    mockOrchestrate.mockResolvedValue(denyResult);

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: {
        goal: 'do the thing',
        budget: 1.0,
      },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.pipeline.errorCode).toBe('SCOPE_DENIED');
    expect(body.pipeline.scopeDeniedTarget?.category).toBe('social');
    // El service recibió scopingKeyRow propagado desde el middleware mock.
    expect(mockOrchestrate).toHaveBeenCalledWith(
      expect.objectContaining({
        goal: 'do the thing',
        scopingKeyRow: expect.objectContaining({ id: 'k1', owner_ref: 'o1' }),
      }),
      expect.any(String), // orchestrationId
    );
  });

  it('T-ROUTE-2b (regresión): success path → 200 (legacy preserved)', async () => {
    const okResult: OrchestrateResult = {
      orchestrationId: '22222222-2222-2222-2222-222222222222',
      answer: 'final answer',
      reasoning: 'all good',
      pipeline: {
        success: true,
        output: 'final answer',
        steps: [],
        totalCostUsdc: 0.5,
        totalLatencyMs: 100,
      },
      consideredAgents: [],
      protocolFeeUsdc: 0.05,
    };
    mockOrchestrate.mockResolvedValue(okResult);

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: {
        goal: 'do the thing',
        budget: 1.0,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().pipeline.success).toBe(true);
    expect(res.json().answer).toBe('final answer');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Audit 2026-06-24 (P1-5): headers (debitFallback, remainingBudgetUsd),
// reply.sent early-return, and the catch wrapper preserving requestId.
// ─────────────────────────────────────────────────────────────────────

describe('orchestrate route — response headers (P1-5)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(orchestrateRoutes, { prefix: '/orchestrate' });
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
    nextKeyRow = { id: 'k1', owner_ref: 'o1' };
  });

  it('P1-5: result.debitFallback=true → x-debit-fallback: registry-miss header', async () => {
    mockOrchestrate.mockResolvedValue(okResult({ debitFallback: true }));

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { goal: 'do it', budget: 1.0 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-debit-fallback']).toBe('registry-miss');
  });

  it('P1-5: result.debitFallback absent → NO x-debit-fallback header', async () => {
    mockOrchestrate.mockResolvedValue(okResult());

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { goal: 'do it', budget: 1.0 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-debit-fallback']).toBeUndefined();
  });

  it('P1-5: result.remainingBudgetUsd defined → x-a2a-remaining-budget header carries the value', async () => {
    mockOrchestrate.mockResolvedValue(okResult({ remainingBudgetUsd: '9.6' }));

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { goal: 'do it', budget: 10 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-a2a-remaining-budget']).toBe('9.6');
  });

  it('P1-5: remainingBudgetUsd decreases as cost is spent (header reflects service value)', async () => {
    // budget 10, two calls reporting decreasing remaining budget.
    mockOrchestrate.mockResolvedValueOnce(
      okResult({ remainingBudgetUsd: '9.5' }),
    );
    const res1 = await app.inject({
      method: 'POST',
      url: '/orchestrate',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { goal: 'first', budget: 10 },
    });
    mockOrchestrate.mockResolvedValueOnce(
      okResult({ remainingBudgetUsd: '9.0' }),
    );
    const res2 = await app.inject({
      method: 'POST',
      url: '/orchestrate',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { goal: 'second', budget: 10 },
    });

    const r1 = parseFloat(res1.headers['x-a2a-remaining-budget'] as string);
    const r2 = parseFloat(res2.headers['x-a2a-remaining-budget'] as string);
    expect(r2).toBeLessThan(r1);
  });

  it('P1-5: result.remainingBudgetUsd undefined → NO x-a2a-remaining-budget header', async () => {
    mockOrchestrate.mockResolvedValue(okResult());

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { goal: 'do it', budget: 1.0 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-a2a-remaining-budget']).toBeUndefined();
  });
});

describe('orchestrate route — catch wrapper preserves requestId (P1-5)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ genReqId });
    registerRequestIdHook(app);
    registerErrorBoundary(app);
    await app.register(orchestrateRoutes, { prefix: '/orchestrate' });
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
    nextKeyRow = { id: 'k1', owner_ref: 'o1' };
  });

  it('P1-5: service throws → 500 structured error with requestId + orchestrationId', async () => {
    mockOrchestrate.mockRejectedValue(new Error('planner blew up'));

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { goal: 'do it', budget: 1.0 },
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    // The error-boundary attaches requestId, and the route's catch attaches
    // the orchestrationId to the wrapped error so it survives to the response.
    expect(body).toHaveProperty('requestId');
    expect(typeof body.requestId).toBe('string');
    expect(body).toHaveProperty('orchestrationId');
    expect(typeof body.orchestrationId).toBe('string');
  });

  it('P1-5: a non-Error throw is wrapped and still yields a requestId-bearing 500', async () => {
    mockOrchestrate.mockRejectedValue('string failure');

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { goal: 'do it', budget: 1.0 },
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body).toHaveProperty('requestId');
    expect(body).toHaveProperty('orchestrationId');
  });
});
