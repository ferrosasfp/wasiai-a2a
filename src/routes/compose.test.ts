/**
 * Compose Routes Integration Tests — WKH-61 W4
 *
 * Mocks: a2a-key middleware (pass-through populating a2aKeyRow),
 *        timeout + rate-limit middlewares (no-ops),
 *        composeService (controlled responses).
 *
 * Tests cubren:
 *   - T-ROUTE-1  (AC-2 e2e): errorCode='SCOPE_DENIED' → HTTP 403
 *   - T-ROUTE-1b (regresión): success=false sin errorCode → HTTP 400
 *   - T-ROUTE-1c (happy path): success → HTTP 200 con kiteTxHash
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
import type { A2AAgentKeyRow, ComposeResult } from '../types/index.js';

// ── Mock auth middleware (W4 pattern, mirroring tasks.test.ts) ──
// Devuelve un array porque routes/compose.ts hace `...requirePaymentOrA2AKey(...)`.
// El handler pass-through setea `a2aKeyRow` para que el route lo propague a
// composeService como `scopingKeyRow`.
let nextKeyRow: Partial<A2AAgentKeyRow> | undefined;
vi.mock('../middleware/a2a-key.js', () => ({
  requirePaymentOrA2AKey: () => [
    async (request: FastifyRequest, _reply: FastifyReply) => {
      (request as unknown as { a2aKeyRow: unknown }).a2aKeyRow = nextKeyRow;
    },
  ],
}));

// ── Mock timeout middleware (no-op) ─────────────────────────
vi.mock('../middleware/timeout.js', () => ({
  createTimeoutHandler:
    () => async (_request: FastifyRequest, _reply: FastifyReply) => {
      /* no-op */
    },
}));

// ── Mock rate-limit middleware (no-op config) ──────────────
vi.mock('../middleware/rate-limit.js', () => ({
  orchestrateRateLimit: () => false, // disable rate-limit on the route
}));

// ── Mock composeService ─────────────────────────────────────
vi.mock('../services/compose.js', () => ({
  composeService: {
    compose: vi.fn(),
  },
}));

// ── Mock agent-price service (WKH-59) ───────────────────────
vi.mock('../services/agent-price.js', () => ({
  resolveAgentPriceUsdc: vi.fn(),
}));

import { resolveAgentPriceUsdc } from '../services/agent-price.js';
import { composeService } from '../services/compose.js';
import composeRoutes from './compose.js';

const mockCompose = vi.mocked(composeService.compose);
const mockResolvePrice = vi.mocked(resolveAgentPriceUsdc);

// ── Setup ───────────────────────────────────────────────────

describe('compose routes — WKH-61 scope mapping', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(composeRoutes, { prefix: '/compose' });
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
    nextKeyRow = { id: 'k1', owner_ref: 'o1' };
    // WKH-59: default price resolution succeeds so existing route tests
    // (T-ROUTE-1/1b/1c) don't 404 on the new preHandler. Each WKH-59-specific
    // test below overrides via mockResolvedValueOnce / mockRejectedValueOnce.
    mockResolvePrice.mockResolvedValue(0.001);
  });

  it('T-ROUTE-1 (AC-2 e2e): errorCode=SCOPE_DENIED → 403 con scopeDeniedTarget', async () => {
    const denyResult: ComposeResult = {
      success: false,
      output: null,
      steps: [],
      totalCostUsdc: 0,
      totalLatencyMs: 0,
      error: 'Step 0 denied by scope: SCOPE_DENIED: registry not in allowed list',
      errorCode: 'SCOPE_DENIED',
      scopeDeniedTarget: {
        registry: 'morpheus',
        agent_slug: 'forbidden-x',
      },
    };
    mockCompose.mockResolvedValue(denyResult);

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: {
        steps: [{ agent: 'forbidden-x', input: {} }],
      },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.errorCode).toBe('SCOPE_DENIED');
    expect(body.scopeDeniedTarget?.registry).toBe('morpheus');
    expect(body.requestId).toBeDefined();
  });

  it('T-ROUTE-1b (regresión): success=false sin errorCode → 400 (legacy)', async () => {
    const budgetResult: ComposeResult = {
      success: false,
      output: null,
      steps: [],
      totalCostUsdc: 0,
      totalLatencyMs: 0,
      error: 'Budget exceeded: would need 2.0, max is 1.0',
    };
    mockCompose.mockResolvedValue(budgetResult);

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: {
        steps: [{ agent: 'a1', input: {} }],
        maxBudget: 1.0,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBeUndefined();
    expect(res.json().error).toContain('Budget exceeded');
  });

  it('T-ROUTE-1c (happy path): success=true → 200 con kiteTxHash', async () => {
    const okResult: ComposeResult = {
      success: true,
      output: 'final',
      steps: [],
      totalCostUsdc: 0,
      totalLatencyMs: 5,
    };
    mockCompose.mockResolvedValue(okResult);

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: {
        steps: [{ agent: 'a1', input: {} }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(res.json().output).toBe('final');
    // mockCompose received scopingKeyRow propagated from middleware
    expect(mockCompose).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: expect.any(Array),
        scopingKeyRow: expect.objectContaining({ id: 'k1', owner_ref: 'o1' }),
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// WKH-59 (real-price-debit): preHandler tests + E2E
// ─────────────────────────────────────────────────────────────────────

describe('compose preHandler — WKH-59 real-price-debit', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(composeRoutes, { prefix: '/compose' });
    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
    nextKeyRow = { id: 'k1', owner_ref: 'o1' };
    // Default success path (each test overrides via mockResolvedValueOnce /
    // mockRejectedValueOnce). composeService default returns success.
    mockCompose.mockResolvedValue({
      success: true,
      output: 'ok',
      steps: [],
      totalCostUsdc: 0,
      totalLatencyMs: 1,
    });
  });

  it('T-ROUTE-PRICE-1 preHandler injects composeEstimatedCostUsd on happy path', async () => {
    mockResolvePrice.mockResolvedValueOnce(0.001);

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { steps: [{ agent: 'kyc', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    expect(mockResolvePrice).toHaveBeenCalledWith('kyc', undefined);
    // route handler still called → middleware short-circuit didn't happen.
    expect(mockCompose).toHaveBeenCalledTimes(1);
  });

  it('T-ROUTE-PRICE-2 should return 404 AGENT_NOT_FOUND when agent missing', async () => {
    mockResolvePrice.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { steps: [{ agent: 'ghost', input: {} }] },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error_code).toBe('AGENT_NOT_FOUND');
    // CD-10: route handler NEVER called (middleware short-circuited by reply.sent).
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('T-ROUTE-PRICE-3 should fallback to $1 + header when priceUsdc is 0', async () => {
    mockResolvePrice.mockResolvedValueOnce(0);

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { steps: [{ agent: 'broken-agent', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    // CD-4: header presente para que el caller sepa que fue fallback.
    expect(res.headers['x-debit-fallback']).toBe('registry-miss');
    // Route handler corre normalmente.
    expect(mockCompose).toHaveBeenCalledTimes(1);
  });

  it('T-ROUTE-PRICE-4 should return 503 REGISTRY_UNAVAILABLE when discovery throws', async () => {
    mockResolvePrice.mockRejectedValueOnce(new Error('PGRST connection lost'));

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { steps: [{ agent: 'kyc', input: {} }] },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error_code).toBe('REGISTRY_UNAVAILABLE');
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('T-ROUTE-PRICE-5 preHandler is a no-op for empty steps body (route handler responds 400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { steps: [] },
    });

    expect(res.statusCode).toBe(400);
    // CD-15: preHandler de price NO valida shape — el route handler lo hace.
    // Por eso resolveAgentPriceUsdc nunca debe ser llamado.
    expect(mockResolvePrice).not.toHaveBeenCalled();
    expect(mockCompose).not.toHaveBeenCalled();
  });
});
