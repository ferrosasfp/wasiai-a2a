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
// WKH-131: rechazo de auth simulable para T-ROUTE-PLAN (401/402).
let authRejectStatus: number | undefined;
// WKH-131: captura del flag skipMiddlewareDebit visto por el middleware de pago
// (lo setea markSkipMiddlewareDebitHandler ANTES, T-EXEC-8).
let lastSkipMiddlewareDebit: boolean | undefined;
vi.mock('../middleware/a2a-key.js', () => ({
  requirePaymentOrA2AKey: () => [
    async (request: FastifyRequest, reply: FastifyReply) => {
      lastSkipMiddlewareDebit = (
        request as unknown as { skipMiddlewareDebit?: boolean }
      ).skipMiddlewareDebit;
      if (authRejectStatus !== undefined) {
        await reply.status(authRejectStatus).send({ error: 'unauthorized' });
        return;
      }
      (request as unknown as { a2aKeyRow: unknown }).a2aKeyRow = nextKeyRow;
    },
  ],
}));

// ── Mock forward-key middleware (no-op spread) ──────────────
vi.mock('../middleware/forward-key.js', () => ({
  requireForwardKey: () => [],
}));

// ── WKH-131: mock agent-price (route /execute re-resuelve server-side) ──
vi.mock('../services/agent-price.js', () => ({
  resolveAgentPriceUsdc: vi.fn().mockResolvedValue(0.05),
}));

// ── WKH-131: mock fee-charge (route /execute lee getProtocolFeeRate) ──
vi.mock('../services/fee-charge.js', () => ({
  getProtocolFeeRate: vi.fn().mockReturnValue(0.01),
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
    planOrchestration: vi.fn(),
    executeApprovedPlan: vi.fn(),
  },
}));

import { registerErrorBoundary } from '../middleware/error-boundary.js';
import { genReqId, registerRequestIdHook } from '../middleware/request-id.js';
import { orchestrateService } from '../services/orchestrate.js';
import orchestrateRoutes from './orchestrate.js';

const mockOrchestrate = vi.mocked(orchestrateService.orchestrate);
const mockPlan = vi.mocked(orchestrateService.planOrchestration);
const mockExecute = vi.mocked(orchestrateService.executeApprovedPlan);

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
    authRejectStatus = undefined;
    lastSkipMiddlewareDebit = undefined;
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
    authRejectStatus = undefined;
    lastSkipMiddlewareDebit = undefined;
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
    authRejectStatus = undefined;
    lastSkipMiddlewareDebit = undefined;
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

// ─────────────────────────────────────────────────────────────────────
// WKH-131 (HU-128): /orchestrate/plan + /orchestrate/execute routes.
// ─────────────────────────────────────────────────────────────────────

import type { OrchestratePlanResult } from '../types/index.js';

function readyPlan(
  over: Partial<OrchestratePlanResult> = {},
): OrchestratePlanResult {
  return {
    orchestrationId: 'plan-route-1',
    planStatus: 'ready',
    steps: [{ agent: 'a1', registry: 'wasiai', input: { q: 0 } }],
    costPerStep: [0.5],
    totalCostUsdc: 0.5,
    protocolFeeUsdc: 0.05,
    maxQuotedCostUsdc: 0.505,
    reasoning: 'plan ok',
    consideredAgents: [],
    plannedCostUsd: 0.5,
    feeUsdc: 0.05,
    usedFallback: false,
    debitFallback: false,
    billingKeyRow: undefined,
    discoveredAgents: [],
    ...over,
  };
}

describe('orchestrate routes — WKH-131 /plan + /execute', () => {
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
    authRejectStatus = undefined;
    lastSkipMiddlewareDebit = undefined;
  });

  // T-ROUTE-PLAN (AC-12/CD-7): /plan sin auth → el middleware rechaza (401/402).
  it('T-ROUTE-PLAN: /plan unauthorized → 401 (auth middleware rejects)', async () => {
    authRejectStatus = 401;

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/plan',
      payload: { goal: 'do it', budget: 1.0 },
    });

    expect(res.statusCode).toBe(401);
    // El service NUNCA se llamó (auth cortó antes).
    expect(mockPlan).not.toHaveBeenCalled();
  });

  // T-ROUTE-PLAN happy: /plan → 200 con SOLO los campos públicos (sin internos).
  it('T-ROUTE-PLAN: /plan happy → 200 public fields only, no debit header', async () => {
    mockPlan.mockResolvedValue(readyPlan());

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/plan',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { goal: 'do it', budget: 1.0 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.planStatus).toBe('ready');
    expect(body.maxQuotedCostUsdc).toBe(0.505);
    // Internos NO serializados (CD: solo públicos).
    expect(body.plannedCostUsd).toBeUndefined();
    expect(body.billingKeyRow).toBeUndefined();
    expect(body.feeUsdc).toBeUndefined();
    // Sin débito → sin header de saldo.
    expect(res.headers['x-a2a-remaining-budget']).toBeUndefined();
  });

  // T-ROUTE-PLAN-FEE (WKH-132 AC-1/DT-2/CD-1): /plan ready → feeRatePercent
  // derivado de getProtocolFeeRate() * 100 (mock 0.01 → 1). Campo aditivo:
  // los existentes (protocolFeeUsdc, totalCostUsdc, maxQuotedCostUsdc) intactos.
  it('T-ROUTE-PLAN-FEE (AC-1): /plan ready → feeRatePercent = rate*100 (1), derived from getProtocolFeeRate', async () => {
    mockPlan.mockResolvedValue(readyPlan());

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/plan',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { goal: 'do it', budget: 1.0 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // getProtocolFeeRate mockeado a 0.01 → feeRatePercent 1.
    expect(body.feeRatePercent).toBe(1);
    // CD-4: campos existentes intactos (aditivo, sin cambios de nombre/tipo).
    expect(body.protocolFeeUsdc).toBe(0.05);
    expect(body.totalCostUsdc).toBe(0.5);
    expect(body.maxQuotedCostUsdc).toBe(0.505);
  });

  // T-ROUTE-PLAN-FEE (WKH-132 CD-3): consistencia protocolFeeUsdc ≈
  // totalCostUsdc * (feeRatePercent/100) dentro de tolerancia de redondeo.
  it('T-ROUTE-PLAN-FEE (CD-3): protocolFeeUsdc ≈ totalCostUsdc * feeRatePercent/100', async () => {
    // totalCostUsdc 0.5, protocolFeeUsdc = 0.5 * 0.01 = 0.005 (rate exacto).
    mockPlan.mockResolvedValue(
      readyPlan({ totalCostUsdc: 0.5, protocolFeeUsdc: 0.005 }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/plan',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { goal: 'do it', budget: 1.0 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const expectedFee = body.totalCostUsdc * (body.feeRatePercent / 100);
    expect(body.protocolFeeUsdc).toBeCloseTo(expectedFee, 6);
  });

  // T-ROUTE-PLAN-FEE (WKH-132 AC-2): planStatus != 'ready' → feeRatePercent
  // OMITIDO (no fee "cobrado" engañoso sin pipeline) y protocolFeeUsdc 0.
  it.each([
    'no_agents',
    'budget_exhausted',
    'insufficient_funds',
    'no_relevant_agent',
  ] as const)('T-ROUTE-PLAN-FEE (AC-2): /plan %s → protocolFeeUsdc 0 and feeRatePercent omitted', async (planStatus) => {
    mockPlan.mockResolvedValue(
      readyPlan({
        planStatus,
        steps: [],
        costPerStep: [],
        totalCostUsdc: 0,
        protocolFeeUsdc: 0,
        maxQuotedCostUsdc: 0,
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/plan',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { goal: 'do it', budget: 1.0 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.planStatus).toBe(planStatus);
    expect(body.protocolFeeUsdc).toBe(0);
    // AC-2: omitido (no un fee cobrado engañoso sin pipeline).
    expect(body).not.toHaveProperty('feeRatePercent');
  });

  // T-EXEC-8 (RIESGO-4/CD-NEW-5): markSkipMiddlewareDebit presente en /execute →
  // el middleware ve skipMiddlewareDebit=true (no debita placeholder $1).
  it('T-EXEC-8: /execute sets skipMiddlewareDebit before payment middleware', async () => {
    mockExecute.mockResolvedValue(okResult());

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/execute',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: {
        orchestrationId: 'o-exec-8',
        steps: [{ agent: 'a1', registry: 'wasiai', input: { q: 0 } }],
        maxQuotedCostUsdc: 1.0,
        budget: 1.0,
      },
    });

    expect(res.statusCode).toBe(200);
    // El flag lo vio el middleware de pago (lo seteó markSkipMiddlewareDebitHandler).
    expect(lastSkipMiddlewareDebit).toBe(true);
  });

  // T-ROUTE-EXEC (AC-10/CD-6): SCOPE_DENIED → 403; headers x-debit-fallback /
  // x-a2a-remaining-budget reflejan el result del service.
  it('T-ROUTE-EXEC: SCOPE_DENIED → 403', async () => {
    mockExecute.mockResolvedValue(
      okResult({
        pipeline: {
          success: false,
          output: null,
          steps: [],
          totalCostUsdc: 0,
          totalLatencyMs: 0,
          errorCode: 'SCOPE_DENIED',
        },
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/execute',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: {
        orchestrationId: 'o-exec-scope',
        steps: [{ agent: 'a1', registry: 'wasiai', input: { q: 0 } }],
        maxQuotedCostUsdc: 1.0,
        budget: 1.0,
      },
    });

    expect(res.statusCode).toBe(403);
  });

  it('T-ROUTE-EXEC: headers reflect debitFallback + remainingBudgetUsd', async () => {
    mockExecute.mockResolvedValue(
      okResult({ debitFallback: true, remainingBudgetUsd: '9.4' }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/execute',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: {
        orchestrationId: 'o-exec-headers',
        steps: [{ agent: 'a1', registry: 'wasiai', input: { q: 0 } }],
        maxQuotedCostUsdc: 1.0,
        budget: 10,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-debit-fallback']).toBe('registry-miss');
    expect(res.headers['x-a2a-remaining-budget']).toBe('9.4');
  });

  // AC-3/AC-5: __quoteStale → 409 QUOTE_STALE.
  it('T-ROUTE-EXEC: __quoteStale → 409 QUOTE_STALE body', async () => {
    mockExecute.mockResolvedValue({
      __quoteStale: true,
      currentCostUsdc: 0.9,
      maxQuotedCostUsdc: 0.1,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/execute',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: {
        orchestrationId: 'o-exec-stale',
        steps: [{ agent: 'a1', registry: 'wasiai', input: { q: 0 } }],
        maxQuotedCostUsdc: 0.1,
        budget: 1.0,
      },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error_code).toBe('QUOTE_STALE');
    expect(body.currentCostUsdc).toBe(0.9);
    expect(body.maxQuotedCostUsdc).toBe(0.1);
  });

  // T-EXEC-9 (BLQ-MED-1, AR fix): anti-replay del fee/billing. Dos llamadas a
  // /execute con el MISMO orchestrationId de CLIENTE deben producir DOS
  // execution-ids server-side DISTINTOS pasados a executeApprovedPlan (clave de
  // idempotencia del protocol fee + del débito). Si el route reusara el id del
  // cliente (código viejo), ambos serían iguales → el 2do compose movería fondos
  // reales pero chargeProtocolFee devolvería already-charged → fee 0% → revenue
  // leak. Con el fix cada ejecución cobra su fee. Asserta el conteo de ids
  // server-side únicos, no el del cliente.
  it('T-EXEC-9: replay del orchestrationId de cliente → execution-id server-side único por llamada', async () => {
    mockExecute.mockResolvedValue(okResult());

    const clientPlanId = 'replayed-client-plan-id';
    const payload = {
      orchestrationId: clientPlanId,
      steps: [{ agent: 'a1', registry: 'wasiai', input: { q: 0 } }],
      maxQuotedCostUsdc: 1.0,
      budget: 1.0,
    };

    const res1 = await app.inject({
      method: 'POST',
      url: '/orchestrate/execute',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload,
    });
    const res2 = await app.inject({
      method: 'POST',
      url: '/orchestrate/execute',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload,
    });

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect(mockExecute).toHaveBeenCalledTimes(2);

    // 3er arg de executeApprovedPlan = clave de idempotencia del fee/débito.
    const execId1 = mockExecute.mock.calls[0]![2];
    const execId2 = mockExecute.mock.calls[1]![2];

    // NINGUNO usa el id del cliente como clave de billing (sino sería replayable).
    expect(execId1).not.toBe(clientPlanId);
    expect(execId2).not.toBe(clientPlanId);
    // Cada ejecución produce un id ÚNICO → cada una cobra su fee (no already-charged).
    expect(execId1).not.toBe(execId2);

    // El plan.orchestrationId (2do arg) también es el id server-side, no el del cliente.
    expect(
      (mockExecute.mock.calls[0]![1] as { orchestrationId: string })
        .orchestrationId,
    ).toBe(execId1);
  });

  // T-EXEC-10 (AC-3, WKH-132): el /execute re-deriva el plan.feeUsdc COST-BASED
  // (totalCostUsdc * rate), NO budget * rate. resolveAgentPriceUsdc está mockeado
  // a 0.05 y feeRate a 0.01 → 1 step ⇒ totalCostUsdc 0.05, feeUsdc 0.0005.
  it('T-EXEC-10: /execute seeds plan.feeUsdc from cost (0.05*0.01), not budget', async () => {
    mockExecute.mockResolvedValue(okResult());

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/execute',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: {
        orchestrationId: 'o-exec-10',
        steps: [{ agent: 'a1', registry: 'wasiai', input: { q: 0 } }],
        maxQuotedCostUsdc: 1.0,
        budget: 5.0, // budget alto: si fuera budget-based el fee sería 0.05.
      },
    });

    expect(res.statusCode).toBe(200);
    const plan = mockExecute.mock.calls[0]![1] as {
      feeUsdc: number;
      protocolFeeUsdc: number;
      totalCostUsdc: number;
    };
    // Cost-based: 1 step * 0.05 = 0.05 total; fee = 0.05 * 0.01 = 0.0005.
    expect(plan.totalCostUsdc).toBeCloseTo(0.05, 6);
    expect(plan.feeUsdc).toBeCloseTo(0.0005, 6);
    expect(plan.protocolFeeUsdc).toBeCloseTo(0.0005, 6);
    // NO budget-based (5.0 * 0.01 = 0.05).
    expect(plan.feeUsdc).not.toBeCloseTo(5.0 * 0.01, 5);
  });
});
