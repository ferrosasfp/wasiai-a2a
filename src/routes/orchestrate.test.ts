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
  afterEach,
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
// WKH-303: contextos de delegación/sesión simulables para los tests del binding del
// quote (T-Q-R10/T-Q-R11). Default `undefined` en ambos ⇒ los describes preexistentes
// ven exactamente lo que veían antes (la prop ausente y la prop en `undefined` son
// indistinguibles para el route, que solo la lee).
let nextDelegationContext: { delegationId: string } | undefined;
let nextKeySessionContext: { sessionId: string } | undefined;
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
      (
        request as unknown as { delegationContext: unknown }
      ).delegationContext = nextDelegationContext;
      (
        request as unknown as { keySessionContext: unknown }
      ).keySessionContext = nextKeySessionContext;
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
import { resolveAgentPriceUsdc } from '../services/agent-price.js';
// WKH-303: módulo REAL (no mockeado) — los tests firman quotes de verdad y el route
// los verifica de verdad. Re-implementar el HMAC en el test lo volvería vacuo (CD-17).
import {
  type QuoteCaller,
  signQuote,
  verifyQuote,
} from '../services/orchestrate-quote.js';
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
    // WKH-132 (BLQ-MED-1): par coherente con rate mock 0.01 → fee = 0.5 * 0.01 = 0.005;
    // techo 0.505 == total 0.5 + fee 0.005 (precio resuelto, sin placeholder).
    protocolFeeUsdc: 0.005,
    maxQuotedCostUsdc: 0.505,
    reasoning: 'plan ok',
    consideredAgents: [],
    plannedCostUsd: 0.5,
    feeUsdc: 0.005,
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
    // WKH-132 (BLQ-MED-1): fee cost-based derivado a nivel respuesta = total * rate =
    // 0.5 * 0.01 = 0.005. CD-4: totalCostUsdc/maxQuotedCostUsdc intactos (aditivo).
    expect(body.protocolFeeUsdc).toBe(0.005);
    expect(body.totalCostUsdc).toBe(0.5);
    expect(body.maxQuotedCostUsdc).toBe(0.505);
  });

  // T-ROUTE-PLAN-FEE (WKH-132 CD-3 / BLQ-MED-1 fix): la ruta DERIVA protocolFeeUsdc
  // cost-based (= totalCostUsdc × getProtocolFeeRate()) a nivel respuesta; NO ecoa
  // el protocolFeeUsdc que venga del plan. Para probar el cálculo REAL (no un fixture
  // cocinado), el mock devuelve un protocolFeeUsdc INCONSISTENTE (el residual inflado
  // del techo, ~1.01, con maxQuotedCostUsdc 1.02) y se aserta que la ruta lo IGNORA y
  // reporta el fee cost-based que reconcilia con feeRatePercent por construcción.
  it('T-ROUTE-PLAN-FEE (CD-3): route derives cost-based protocolFeeUsdc, ignores stale plan residual', async () => {
    // totalCostUsdc 0.5; el plan trae un residual inflado (1.01) y techo 1.02.
    mockPlan.mockResolvedValue(
      readyPlan({
        totalCostUsdc: 0.5,
        protocolFeeUsdc: 1.01,
        maxQuotedCostUsdc: 1.02,
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
    // rate mock 0.01 → feeRatePercent 1; fee cost-based = 0.5 * 0.01 = 0.005.
    expect(body.feeRatePercent).toBe(1);
    expect(body.protocolFeeUsdc).toBeCloseTo(0.005, 6);
    // La ruta NO ecoa el residual cocinado del plan (1.01).
    expect(body.protocolFeeUsdc).not.toBeCloseTo(1.01, 4);
    // Reconcilia por construcción: fee == total × feeRatePercent/100.
    const expectedFee = body.totalCostUsdc * (body.feeRatePercent / 100);
    expect(body.protocolFeeUsdc).toBeCloseTo(expectedFee, 6);
    // Invariante del quote: el techo es ≥ total + fee (1.02 ≥ 0.505).
    expect(body.maxQuotedCostUsdc).toBeGreaterThanOrEqual(
      body.totalCostUsdc + body.protocolFeeUsdc,
    );
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

  // ══════════════════════════════════════════════════════════════
  // WKH-305 (CR MNR-3) — `inputFromPrevious` por ESTA ruta
  //
  // El schema de `steps[]` de /execute NO declara `additionalProperties:false`,
  // así que ajv NO remueve las claves desconocidas: un `inputFromPrevious`
  // malformado llega intacto. Sin el preHandler de forma, el rechazo ocurría
  // DESPUÉS del débito del step 0 (un débito y su reembolso en vez de un error
  // gratis) y S8 no se aplicaba nunca por acá.
  //
  // El ORDEN se afirma con `lastSkipMiddlewareDebit`: lo setea
  // `markSkipMiddlewareDebitHandler`, que corre JUSTO ANTES del middleware de
  // pago. Si queda `undefined`, ni el débito ni nada posterior llegó a correr.
  // ══════════════════════════════════════════════════════════════

  it('T-MAP-25 (CR MNR-3): mapeo malformado en /execute → 400 ANTES del middleware de pago', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/execute',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: {
        orchestrationId: 'o-map-25',
        steps: [
          { agent: 'a1', registry: 'wasiai', input: {} },
          {
            agent: 'a2',
            registry: 'wasiai',
            input: {},
            inputFromPrevious: ['quoteId'], // array: no expresa destino→origen
          },
        ],
        maxQuotedCostUsdc: 1.0,
        budget: 1.0,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    expect(res.json().error).toContain('Step 1:');
    expect(res.json().error).toContain('non-array object');
    // NADA posterior corrió: ni el marcador pre-débito, ni el pricing, ni el
    // service. O sea: sin débito y sin reembolso, que es el punto.
    expect(lastSkipMiddlewareDebit).toBeUndefined();
    expect(vi.mocked(resolveAgentPriceUsdc)).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('T-MAP-26 (CR MNR-3 · S8): mapeo en el step 0 por /execute → 400 que apunta al step correcto', async () => {
    // Antes esta regla no se aplicaba por esta ruta, así que el integrador
    // recibía un error del lugar equivocado (o pagaba para descubrirlo).
    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/execute',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: {
        orchestrationId: 'o-map-26',
        steps: [
          {
            agent: 'a1',
            registry: 'wasiai',
            input: {},
            inputFromPrevious: { quoteId: 'quoteId' },
          },
        ],
        maxQuotedCostUsdc: 1.0,
        budget: 1.0,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().step).toBe(0);
    expect(res.json().error).toContain('not allowed on step 0');
    expect(lastSkipMiddlewareDebit).toBeUndefined();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('T-MAP-27 (CR MNR-3, invariante): un mapeo BIEN formado pasa y llega INTACTO al service', async () => {
    // El guard no puede rechazar de más, y el campo no puede perderse por el
    // camino: el service es quien lo resuelve contra la salida del step previo.
    mockExecute.mockResolvedValue(okResult());

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/execute',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: {
        orchestrationId: 'o-map-27',
        steps: [
          { agent: 'a1', registry: 'wasiai', input: {} },
          {
            agent: 'a2',
            registry: 'wasiai',
            input: { method: 'yape' },
            inputFromPrevious: { quoteId: 'quoteId' },
          },
        ],
        maxQuotedCostUsdc: 1.0,
        budget: 1.0,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(lastSkipMiddlewareDebit).toBe(true);
    // Los steps viajan en el PLAN (2º arg), que es lo que el service ejecuta.
    const steps = mockExecute.mock.calls[0]?.[1]?.steps as
      | { inputFromPrevious?: Record<string, string> }[]
      | undefined;
    expect(steps?.[1]?.inputFromPrevious).toEqual({ quoteId: 'quoteId' });
  });
});

// ══════════════════════════════════════════════════════════════
// WKH-303 — quote freeze: emisión en /plan y redención en /execute
//
// Todo test de RECHAZO afirma, además del status, que
// `orchestrateService.executeApprovedPlan` NUNCA fue llamado: es la única línea
// que mueve dinero en esta ruta, así que "no fue llamada" ES la prueba de 0
// débito. Afirmar sólo el status code pasaría igual si el código debitó antes
// de responder (ya pasó tres veces en este repo).
// ══════════════════════════════════════════════════════════════

describe('orchestrate routes — WKH-303 quote freeze', () => {
  let app: ReturnType<typeof Fastify>;
  const QUOTE_KEY = 'c'.repeat(64);
  let quoteEnvSnapshot: string | undefined;

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
    nextDelegationContext = undefined;
    nextKeySessionContext = undefined;
    // resolveAgentPriceUsdc vuelve al default del harness tras clearAllMocks.
    vi.mocked(resolveAgentPriceUsdc).mockResolvedValue(0.05);
    // CD-16: se restaura en afterEach, nunca al final del cuerpo del test.
    quoteEnvSnapshot = process.env.ORCHESTRATE_QUOTE_HMAC_KEY;
    process.env.ORCHESTRATE_QUOTE_HMAC_KEY = QUOTE_KEY;
  });

  afterEach(() => {
    if (quoteEnvSnapshot === undefined) {
      delete process.env.ORCHESTRATE_QUOTE_HMAC_KEY;
    } else {
      process.env.ORCHESTRATE_QUOTE_HMAC_KEY = quoteEnvSnapshot;
    }
  });

  /** Emite un quote real con el módulo de producción (no se re-implementa el HMAC). */
  function issueQuote(over: {
    caller?: QuoteCaller;
    steps?: { agent: string; registry: string | null; priceUsdc: number }[];
    nowMs?: number;
  } = {}): string {
    const signed = signQuote({
      orchestrationId: 'plan-q-1',
      caller: over.caller ?? { kind: 'key', id: 'k1' },
      steps: over.steps ?? [
        { agent: 'a1', registry: 'wasiai', priceUsdc: 0.05 },
      ],
      ...(over.nowMs !== undefined && { nowMs: over.nowMs }),
    });
    if (signed === null) throw new Error('signQuote devolvió null en el arrange');
    return signed.token;
  }

  function executePayload(over: Record<string, unknown> = {}) {
    return {
      orchestrationId: 'plan-q-1',
      steps: [{ agent: 'a1', registry: 'wasiai', input: { q: 0 } }],
      maxQuotedCostUsdc: 1.0,
      budget: 5.0,
      ...over,
    };
  }

  // ── Emisión (/plan) ──────────────────────────────────────────

  // T-Q-P1 — AC-1
  it('T-Q-P1: /plan ready emite un quote que congela los MISMOS precios que costPerStep', async () => {
    mockPlan.mockResolvedValue(readyPlan());

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/plan',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { goal: 'do it', budget: 1.0 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.quote).toBe('string');
    expect(typeof body.quoteExpiresAt).toBe('string');

    const verified = verifyQuote(body.quote, { kind: 'key', id: 'k1' });
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error('unreachable');
    // Los precios congelados son EXACTAMENTE los cotizados.
    expect(verified.payload.steps.map((s) => Number(s.p))).toEqual(
      body.costPerStep,
    );
    expect(verified.payload.steps.map((s) => s.a)).toEqual(['a1']);
    expect(verified.payload.steps.map((s) => s.r)).toEqual(['wasiai']);
    // quoteExpiresAt informa el mismo instante que el exp firmado (iat + 600).
    expect(verified.payload.exp - verified.payload.iat).toBe(600);
    expect(body.quoteExpiresAt).toBe(
      new Date(verified.payload.exp * 1000).toISOString(),
    );
  });

  // T-Q-P2 — AC-6
  it('T-Q-P2: sin secreto, el body NO trae las claves quote ni quoteExpiresAt', async () => {
    process.env.ORCHESTRATE_QUOTE_HMAC_KEY = '';
    mockPlan.mockResolvedValue(readyPlan());

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/plan',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { goal: 'do it', budget: 1.0 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect('quote' in body).toBe(false);
    expect('quoteExpiresAt' in body).toBe(false);
    // El resto del body sigue siendo el de siempre.
    expect(body.planStatus).toBe('ready');
    expect(body.costPerStep).toEqual([0.5]);
    expect(body.maxQuotedCostUsdc).toBe(0.505);
  });

  // T-Q-P3 — AC-1
  it('T-Q-P3: planStatus != ready ⇒ sin quote (no se congela un plan que no está listo)', async () => {
    mockPlan.mockResolvedValue(
      readyPlan({ planStatus: 'no_agents', steps: [], costPerStep: [] }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/plan',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { goal: 'do it', budget: 1.0 },
    });

    expect(res.statusCode).toBe(200);
    expect('quote' in res.json()).toBe(false);
  });

  // T-Q-P4 — AC-1
  it('T-Q-P4: un costPerStep en 0 ⇒ sin quote (no se congela un $0 ni un placeholder)', async () => {
    mockPlan.mockResolvedValue(
      readyPlan({
        steps: [
          { agent: 'a1', registry: 'wasiai', input: {} },
          { agent: 'a2', registry: 'wasiai', input: {} },
        ],
        costPerStep: [0.5, 0],
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/plan',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { goal: 'do it', budget: 1.0 },
    });

    expect(res.statusCode).toBe(200);
    expect('quote' in res.json()).toBe(false);
  });

  // T-Q-P5 — AC-4
  it('T-Q-P5: caller x402 (sin key, sin delegación, sin sesión) ⇒ sin quote', async () => {
    nextKeyRow = undefined;
    mockPlan.mockResolvedValue(readyPlan());

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/plan',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { goal: 'do it', budget: 1.0 },
    });

    expect(res.statusCode).toBe(200);
    expect('quote' in res.json()).toBe(false);
  });

  // ── Redención (/execute) ─────────────────────────────────────

  // T-Q-R1 — AC-2
  it('T-Q-R1: quote válido ⇒ el service recibe precios CONGELADOS y NINGÚN maxQuotedCostUsdc', async () => {
    mockExecute.mockResolvedValue(okResult());
    // El precio vivo es OTRO (0.09): si el congelado no mandara, se colaría acá.
    vi.mocked(resolveAgentPriceUsdc).mockResolvedValue(0.09);
    const quote = issueQuote();

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/execute',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: executePayload({ quote }),
    });

    expect(res.statusCode).toBe(200);
    const serviceRequest = mockExecute.mock.calls[0]![0] as {
      maxQuotedCostUsdc?: number;
      frozenStepPricesUsd?: readonly number[];
    };
    const plan = mockExecute.mock.calls[0]![1] as {
      plannedCostUsd: number;
      costPerStep: number[];
    };
    expect(plan.costPerStep).toEqual([0.05]);
    expect(plan.plannedCostUsd).toBe(0.05);
    expect(serviceRequest.frozenStepPricesUsd).toEqual([0.05]);
    // El cap gate NO corre con garantía de precio: la prop ni siquiera viaja.
    expect('maxQuotedCostUsdc' in serviceRequest).toBe(false);
  });

  // T-Q-R2 — AC-6 (back-compat)
  it('T-Q-R2: SIN quote ⇒ precios vivos, maxQuotedCostUsdc presente y sin frozenStepPricesUsd', async () => {
    mockExecute.mockResolvedValue(okResult());
    vi.mocked(resolveAgentPriceUsdc).mockResolvedValue(0.09);

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/execute',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: executePayload(),
    });

    expect(res.statusCode).toBe(200);
    const serviceRequest = mockExecute.mock.calls[0]![0] as {
      maxQuotedCostUsdc?: number;
      frozenStepPricesUsd?: readonly number[];
    };
    const plan = mockExecute.mock.calls[0]![1] as {
      plannedCostUsd: number;
      costPerStep: number[];
    };
    expect(plan.costPerStep).toEqual([0.09]);
    expect(plan.plannedCostUsd).toBe(0.09);
    expect(serviceRequest.maxQuotedCostUsdc).toBe(1.0);
    expect('frozenStepPricesUsd' in serviceRequest).toBe(false);
  });

  // T-Q-R3 — AC-3
  it('T-Q-R3: quote expirado ⇒ 409 QUOTE_EXPIRED, requiresNewQuote y CERO ejecución', async () => {
    const quote = issueQuote({ nowMs: Date.now() - 601_000 });

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/execute',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: executePayload({ quote }),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error_code: 'QUOTE_EXPIRED',
      requiresNewQuote: true,
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // T-Q-R4 — AC-4
  it('T-Q-R4: quote de otra key ⇒ 403 QUOTE_CALLER_MISMATCH y CERO ejecución', async () => {
    const quote = issueQuote({ caller: { kind: 'key', id: 'k-otra' } });

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/execute',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: executePayload({ quote }),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('QUOTE_CALLER_MISMATCH');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // T-Q-R5 — AC-2 (§3.2: rechaza, NO corrige)
  it('T-Q-R5: agente distinto del congelado ⇒ 400 QUOTE_STEP_MISMATCH, sin ejecutar con NINGUNA de las dos identidades', async () => {
    const quote = issueQuote(); // congela 'a1'

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/execute',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: executePayload({
        quote,
        steps: [{ agent: 'a2-impostor', registry: 'wasiai', input: { q: 0 } }],
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('QUOTE_STEP_MISMATCH');
    // Ni con el agente pedido ni "corrigiendo" al congelado: no se ejecuta nada.
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('T-Q-R5b: registry distinto del congelado ⇒ 400 QUOTE_STEP_MISMATCH', async () => {
    const quote = issueQuote(); // congela registry 'wasiai'

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/execute',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: executePayload({
        quote,
        steps: [{ agent: 'a1', registry: 'otro-registry', input: { q: 0 } }],
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('QUOTE_STEP_MISMATCH');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // T-Q-R6 — AC-2
  it('T-Q-R6: un step de más en el body ⇒ 400 QUOTE_STEP_MISMATCH y CERO ejecución', async () => {
    const quote = issueQuote(); // 1 step congelado

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/execute',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: executePayload({
        quote,
        steps: [
          { agent: 'a1', registry: 'wasiai', input: { q: 0 } },
          { agent: 'a1', registry: 'wasiai', input: { q: 1 } },
        ],
      }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('QUOTE_STEP_MISMATCH');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // T-Q-R7 — AC-5
  it('T-Q-R7: agente congelado que ya no resuelve ⇒ 409 QUOTE_AGENT_UNAVAILABLE y CERO ejecución', async () => {
    vi.mocked(resolveAgentPriceUsdc).mockResolvedValue(null);
    const quote = issueQuote();

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/execute',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: executePayload({ quote }),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error_code).toBe('QUOTE_AGENT_UNAVAILABLE');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // T-Q-R8 — AC-2
  it('T-Q-R8: precio vivo por ENCIMA del techo ⇒ 200 al precio congelado (nunca 409 QUOTE_STALE)', async () => {
    mockExecute.mockResolvedValue(okResult());
    // vivo 5.0, techo declarado 1.0: sin el freeze, el cap gate lo mataría.
    vi.mocked(resolveAgentPriceUsdc).mockResolvedValue(5.0);
    const quote = issueQuote();

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/execute',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: executePayload({ quote, maxQuotedCostUsdc: 1.0 }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().error_code).toBeUndefined();
    const plan = mockExecute.mock.calls[0]![1] as { costPerStep: number[] };
    expect(plan.costPerStep).toEqual([0.05]);
  });

  // T-Q-R9 — AC-3
  it('T-Q-R9: quote basura ⇒ 400 QUOTE_INVALID y NO degrada al camino de precio vivo', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/execute',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: executePayload({ quote: 'basura' }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error_code: 'QUOTE_INVALID',
      requiresNewQuote: true,
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // T-Q-R10 — AC-4 (mismo owner, otra credencial)
  it('T-Q-R10: quote de una DELEGACIÓN presentado por la master key del mismo owner ⇒ 403', async () => {
    const quote = issueQuote({
      caller: { kind: 'delegation', id: 'deleg-1' },
    });
    // El caller que lo presenta es la master key del MISMO owner (o1).
    nextKeyRow = { id: 'k1', owner_ref: 'o1' };
    nextDelegationContext = undefined;

    const res = await app.inject({
      method: 'POST',
      url: '/orchestrate/execute',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: executePayload({ quote }),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error_code).toBe('QUOTE_CALLER_MISMATCH');
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // T-Q-R11 — AC-4 (los 3 contextos, punta a punta)
  it('T-Q-R11: master, delegación y sesión emiten y redimen CADA UNO su propio quote', async () => {
    const contexts: {
      label: string;
      apply: () => void;
    }[] = [
      {
        label: 'master',
        apply: () => {
          nextKeyRow = { id: 'k1', owner_ref: 'o1' };
          nextDelegationContext = undefined;
          nextKeySessionContext = undefined;
        },
      },
      {
        label: 'delegación',
        apply: () => {
          nextKeyRow = { id: 'k1', owner_ref: 'o1' };
          nextDelegationContext = { delegationId: 'deleg-9' };
          nextKeySessionContext = undefined;
        },
      },
      {
        label: 'sesión',
        apply: () => {
          nextKeyRow = { id: 'k1', owner_ref: 'o1' };
          nextDelegationContext = undefined;
          nextKeySessionContext = { sessionId: 'sess-9' };
        },
      },
    ];

    for (const ctx of contexts) {
      vi.clearAllMocks();
      vi.mocked(resolveAgentPriceUsdc).mockResolvedValue(0.05);
      mockPlan.mockResolvedValue(readyPlan({ costPerStep: [0.05] }));
      mockExecute.mockResolvedValue(okResult());
      ctx.apply();

      // 1) el plan emite el quote bajo ESE contexto
      const planRes = await app.inject({
        method: 'POST',
        url: '/orchestrate/plan',
        headers: { 'x-a2a-key': 'wasi_a2a_test' },
        payload: { goal: 'do it', budget: 1.0 },
      });
      expect(planRes.statusCode).toBe(200);
      const issued = planRes.json().quote;
      expect(typeof issued).toBe(`string`);

      // 2) el MISMO contexto lo redime
      const execRes = await app.inject({
        method: 'POST',
        url: '/orchestrate/execute',
        headers: { 'x-a2a-key': 'wasi_a2a_test' },
        payload: executePayload({ quote: issued }),
      });
      expect(execRes.statusCode).toBe(200);
      const plan = mockExecute.mock.calls[0]![1] as { costPerStep: number[] };
      expect(plan.costPerStep).toEqual([0.05]);
    }
  });
});
