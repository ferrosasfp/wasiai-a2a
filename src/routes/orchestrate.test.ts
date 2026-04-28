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

import { orchestrateService } from '../services/orchestrate.js';
import orchestrateRoutes from './orchestrate.js';

const mockOrchestrate = vi.mocked(orchestrateService.orchestrate);

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
        error: 'Step 0 denied by scope: SCOPE_DENIED: category not in allowed list',
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
