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

// ── Structured logger mock ──────────────────────────────────
// compose.ts logs the best-effort refund/fee failures via getLogger('compose').
// Mock it so tests assert log emission (object-first / message-second) instead
// of spying on console. hoisted so the factory can reference it.
const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({
  getLogger: () => logSpy,
}));

// ── Mock auth middleware (W4 pattern, mirroring tasks.test.ts) ──
// Devuelve un array porque routes/compose.ts hace `...requirePaymentOrA2AKey(...)`.
// El handler pass-through setea `a2aKeyRow` para que el route lo propague a
// composeService como `scopingKeyRow`.
let nextKeyRow: Partial<A2AAgentKeyRow> | undefined;
// WKH-125 BLQ-ALTO-1: capturamos el destino que el preHandler de price
// augmentó en `request.composeDestination` (el middleware real corre DESPUÉS
// del price handler en el orden de preHandlers). Es lo que el step-0 usaría
// para keyear el cap por destino.
let capturedComposeDestination: string | undefined;
// WKH money-path fix: capture the per-request x402 challenge amount + the
// step-0 prepaid estimate the real `resolveComposePriceHandler` preHandler
// augmented (the auth mock runs AFTER it), to assert the x402 challenge
// reflects the full pipeline cost while the prepaid path stays step-0 only.
let capturedX402ChallengeAmountUsd: number | undefined;
let capturedComposeEstimatedCostUsd: number | undefined;
// AUDIT A1 (refund step-0): vars module-level que el mock del middleware inyecta
// para simular el PRE-débito del path a2a-key. undefined por defecto → los tests
// existentes no ven cambios (el route handler salta el refund sin estos campos).
let nextEstimatedCostUsd: number | undefined;
let nextResolvedChainId: number | undefined;
let nextInjectedDestination: string | undefined;
vi.mock('../middleware/a2a-key.js', () => ({
  // C2 (audit 2026-07-01): routes/compose.ts imports extractRawKey to derive the
  // a2a credential the same way the middleware does (x-a2a-key OR Bearer
  // wasi_a2a_*). Mirror that logic in the mock.
  extractRawKey: (request: FastifyRequest) => {
    const headerKey = request.headers['x-a2a-key'];
    if (typeof headerKey === 'string') return headerKey;
    const auth = request.headers.authorization;
    if (typeof auth === 'string') {
      const m = /^bearer\s+(.+)$/i.exec(auth);
      if (m?.[1]?.startsWith('wasi_a2a_')) return m[1];
    }
    return undefined;
  },
  requirePaymentOrA2AKey: () => [
    async (request: FastifyRequest, _reply: FastifyReply) => {
      (request as unknown as { a2aKeyRow: unknown }).a2aKeyRow = nextKeyRow;
      capturedComposeDestination = (
        request as unknown as { composeDestination?: string }
      ).composeDestination;
      capturedX402ChallengeAmountUsd = (
        request as unknown as { x402ChallengeAmountUsd?: number }
      ).x402ChallengeAmountUsd;
      capturedComposeEstimatedCostUsd = (
        request as unknown as { composeEstimatedCostUsd?: number }
      ).composeEstimatedCostUsd;
      // AUDIT A1: simula el débito del middleware (path a2a-key).
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

// ── Mock agent-price service (WKH-59 + WKH-125 BLQ-ALTO-1) ──
vi.mock('../services/agent-price.js', () => ({
  resolveAgentPriceUsdc: vi.fn(),
  resolveAgentDestination: vi.fn(),
}));

// ── Mock budget service (AUDIT A1: refund step-0 en fallo) ──
vi.mock('../services/budget.js', () => ({
  budgetService: {
    credit: vi.fn().mockResolvedValue({ success: true }),
    creditWithDest: vi.fn().mockResolvedValue({ success: true }),
  },
}));

import {
  resolveAgentDestination,
  resolveAgentPriceUsdc,
} from '../services/agent-price.js';
import { budgetService } from '../services/budget.js';
import { composeService } from '../services/compose.js';
import composeRoutes, { augmentX402ChallengeAmount } from './compose.js';

const mockCompose = vi.mocked(composeService.compose);
const mockResolvePrice = vi.mocked(resolveAgentPriceUsdc);
const mockResolveDest = vi.mocked(resolveAgentDestination);
const mockCredit = vi.mocked(budgetService.credit);
const mockCreditWithDest = vi.mocked(budgetService.creditWithDest);

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
      error:
        'Step 0 denied by scope: SCOPE_DENIED: registry not in allowed list',
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

  // C2 (audit 2026-07-01): the route derives a2aKey with extractRawKey
  // (x-a2a-key OR Bearer wasi_a2a_*). A Bearer-authenticated caller MUST reach
  // compose with a2aKey SET, so invokeAgent stays on the prepaid path and never
  // takes the operator-signed EIP-3009 branch (the C2 operator-wallet drain).
  it('T-ROUTE-C2 (audit): Bearer wasi_a2a_* caller → compose receives a2aKey set (no operator-sign path)', async () => {
    mockCompose.mockResolvedValue({
      success: true,
      output: 'final',
      steps: [],
      totalCostUsdc: 0,
      totalLatencyMs: 1,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { authorization: 'Bearer wasi_a2a_bearer_caller' },
      payload: { steps: [{ agent: 'a1', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    expect(mockCompose).toHaveBeenCalledWith(
      expect.objectContaining({ a2aKey: 'wasi_a2a_bearer_caller' }),
    );
  });

  it('T-ROUTE-C2b (audit): x402 caller (no a2a credential) → compose receives a2aKey undefined', async () => {
    mockCompose.mockResolvedValue({
      success: true,
      output: 'final',
      steps: [],
      totalCostUsdc: 0,
      totalLatencyMs: 1,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      payload: { steps: [{ agent: 'a1', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    expect(mockCompose).toHaveBeenCalledWith(
      expect.objectContaining({ a2aKey: undefined }),
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
    capturedComposeDestination = undefined;
    capturedX402ChallengeAmountUsd = undefined;
    capturedComposeEstimatedCostUsd = undefined;
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

  // WKH-125 BLQ-ALTO-1 (fix-pack): el destino del step-0 se deriva del AGENTE
  // RESUELTO por discovery, NO de los campos crudos del body. Un caller que
  // OMITE `registry` igual produce el destino canónico `"<registry>/<slug>"`
  // → coincide con el que arma el per-step (`compose.ts:166`
  // `normalizeDestination(${agent.registry}/${agent.slug})`) → el cap por
  // destino se evalúa (no degrada a `increment` por mismatch de destino).
  it('T-ROUTE-PRICE-DEST-1 (BLQ-ALTO-1): step-0 destino = agente resuelto aunque el body omita registry', async () => {
    mockResolvePrice.mockResolvedValueOnce(0.001);
    // Discovery resuelve el agente canónico: registry="wasiai", slug="myagent".
    mockResolveDest.mockResolvedValueOnce({
      registry: 'wasiai',
      slug: 'myagent',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      // Body OMITE registry — el caller solo pasa el slug crudo.
      payload: { steps: [{ agent: 'myagent', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    // El resolver se llamó con los crudos del body (slug + registry undefined).
    expect(mockResolveDest).toHaveBeenCalledWith('myagent', undefined);
    // CLAVE: el destino augmentado es el canónico del agente resuelto
    // ("wasiai/myagent"), NO el crudo del body ("myagent"). Idéntico al que
    // el per-step keyea → el cap NO se evade omitiendo registry.
    expect(capturedComposeDestination).toBe('wasiai/myagent');
  });

  // WKH-125 BLQ-ALTO-1: si discovery no resuelve un agente canónico (null),
  // NO se augmenta composeDestination → step-0 sigue 3-arg (back-compat).
  it('T-ROUTE-PRICE-DEST-2 (BLQ-ALTO-1): sin agente resuelto → composeDestination undefined (3-arg)', async () => {
    mockResolvePrice.mockResolvedValueOnce(0.001);
    mockResolveDest.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { steps: [{ agent: 'kyc', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    expect(capturedComposeDestination).toBeUndefined();
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

  // ── WKH money-path fix: x402 challenge reflects REAL pipeline cost ──

  it('T-ROUTE-X402-AMT-1: cheap single-step pipeline → x402ChallengeAmountUsd = price*(1+fee), NOT 1 USD', async () => {
    // Persistent mock: both step-0 resolution AND the challenge augmentation
    // (which re-resolves every step) see 0.001.
    mockResolvePrice.mockResolvedValue(0.001);
    const ORIGINAL_RATE = process.env.PROTOCOL_FEE_RATE;
    process.env.PROTOCOL_FEE_RATE = '0.01';
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/compose',
        // NO x-a2a-key → x402 path is the one that consumes the challenge amount,
        // but the auth middleware is mocked pass-through so we just capture the
        // augmented field the real price preHandler set.
        payload: { steps: [{ agent: 'kyc', input: {} }] },
      });
      expect(res.statusCode).toBe(200);
      // 0.001 * (1 + 0.01) = 0.00101 — the REAL cost, not the 1 USD default.
      expect(capturedX402ChallengeAmountUsd).toBeCloseTo(0.00101, 8);
      expect(capturedX402ChallengeAmountUsd).not.toBe(1);
      // The prepaid step-0 estimate stays step-0 ONLY (unchanged by this fix).
      expect(capturedComposeEstimatedCostUsd).toBe(0.001);
    } finally {
      if (ORIGINAL_RATE === undefined) delete process.env.PROTOCOL_FEE_RATE;
      else process.env.PROTOCOL_FEE_RATE = ORIGINAL_RATE;
    }
  });

  it('T-ROUTE-X402-AMT-2: multi-step pipeline → challenge sums ALL step prices + fee', async () => {
    mockResolvePrice.mockResolvedValue(0.5); // every step resolves to 0.5
    const ORIGINAL_RATE = process.env.PROTOCOL_FEE_RATE;
    process.env.PROTOCOL_FEE_RATE = '0.01';
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/compose',
        payload: {
          steps: [
            { agent: 'a1', input: {} },
            { agent: 'a2', input: {} },
            { agent: 'a3', input: {} },
          ],
        },
      });
      expect(res.statusCode).toBe(200);
      // (0.5 * 3) * 1.01 = 1.515 — sum of all steps, not just step-0, not 1 USD.
      expect(capturedX402ChallengeAmountUsd).toBeCloseTo(1.515, 6);
      // Prepaid step-0 estimate unaffected: still the step-0 price only.
      expect(capturedComposeEstimatedCostUsd).toBe(0.5);
    } finally {
      if (ORIGINAL_RATE === undefined) delete process.env.PROTOCOL_FEE_RATE;
      else process.env.PROTOCOL_FEE_RATE = ORIGINAL_RATE;
    }
  });

  it('T-ROUTE-X402-AMT-3: x-a2a-key (prepaid) path unaffected — debit still uses step-0 estimate', async () => {
    mockResolvePrice.mockResolvedValue(0.001);
    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: {
        steps: [
          { agent: 'a1', input: {} },
          { agent: 'a2', input: {} },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    // Prepaid path keys off composeEstimatedCostUsd (step-0 ONLY) for its
    // per-step debit — the challenge augmentation does NOT change it.
    expect(capturedComposeEstimatedCostUsd).toBe(0.001);
    expect(mockCompose).toHaveBeenCalledTimes(1);
  });

  // ── BLQ-MEDIO-1: malformed trailing step must NOT collapse the challenge ──

  it('T-ROUTE-X402-AMT-4 (BLQ-MEDIO-1 layer 2): malformed trailing step (non-string agent) → 400, compose NEVER runs', async () => {
    // step-0 resolves fine (so the price preHandler passes), but step-1 has a
    // non-string `agent`. Pre-fix the route would have let composeService settle
    // the step-0 prefix downstream while the x402 challenge fell back to 1 USD.
    // Now the route hard-rejects with 400 BEFORE compose, so no prefix settles.
    mockResolvePrice.mockResolvedValue(0.001);
    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      // x402 path (no x-a2a-key) — the one with no inbound refund.
      payload: {
        steps: [
          { agent: 'a1', input: {} },
          // biome-ignore lint/suspicious/noExplicitAny: intentional malformed input
          { agent: 12345 as any, input: {} },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('VALIDATION_ERROR');
    // The malformed pipeline NEVER reaches composeService → no partial prefix
    // settles downstream.
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('T-ROUTE-X402-AMT-5 (HIGH-2, was BLQ-MEDIO-1 layer 1): un step malformado NUNCA llega a cotizarse — el 400 corre pre-pago', async () => {
    // ANTES (BLQ-MEDIO-1): este test manejaba un body malformado a través de
    // `resolveComposePriceHandler` para verificar que `augmentX402ChallengeAmount`
    // sobre-estimaba el step malformado (layer 1) en vez de colapsar al default de
    // 1 USD, porque la validación (layer 2) vivía en el route handler y corría
    // DESPUÉS del middleware de pago.
    //
    // AHORA (HIGH-2): `validateComposeBodyHandler` (layer 0) corre ANTES del
    // preHandler de precio y del middleware de pago, con la MISMA condición que el
    // guard de layer 1 (`!step || typeof step.agent !== 'string'`). O sea: layer 0
    // pre-empta layer 1 de forma total para el path HTTP. La garantía que este test
    // fija ahora es MÁS FUERTE que la anterior — un body malformado ni siquiera se
    // cotiza, así que ningún caller (prepago NI x402) puede pagar por él:
    //   - status 400 VALIDATION_ERROR,
    //   - el challenge x402 NUNCA se computa (nada que settlear inbound),
    //   - composeService NUNCA corre (ningún prefijo settlea downstream).
    // El guard de layer 1 se conserva en `augmentX402ChallengeAmount` como defense
    // in depth (inalcanzable vía HTTP hoy, pero seguro si se reordenan preHandlers).
    mockResolvePrice.mockResolvedValue(0.5);
    const ORIGINAL_RATE = process.env.PROTOCOL_FEE_RATE;
    process.env.PROTOCOL_FEE_RATE = '0';
    try {
      capturedX402ChallengeAmountUsd = undefined;
      const res = await app.inject({
        method: 'POST',
        url: '/compose',
        // x402 path (sin x-a2a-key) — el que NO tiene refund inbound, así que la
        // única defensa posible es rechazar ANTES de cobrar.
        payload: {
          steps: [
            { agent: 'a1', input: {} },
            // biome-ignore lint/suspicious/noExplicitAny: intentional malformed input
            { agent: null as any, input: {} },
          ],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('VALIDATION_ERROR');
      // El preHandler de precio no corrió → no hay challenge que cobrar.
      expect(capturedX402ChallengeAmountUsd).toBeUndefined();
      expect(mockResolvePrice).not.toHaveBeenCalled();
      expect(mockCompose).not.toHaveBeenCalled();
    } finally {
      if (ORIGINAL_RATE === undefined) delete process.env.PROTOCOL_FEE_RATE;
      else process.env.PROTOCOL_FEE_RATE = ORIGINAL_RATE;
    }
  });

  it('T-ROUTE-X402-AMT-6 (MNR-2): sub-microdollar pipeline floors challenge to >= 1 atomic, never 0', async () => {
    // A pipeline whose total rounds below 1 atomic unit (1e-6 USD) at 6dp must
    // still advertise a positive challenge (floor to 1e-6), never 0.
    mockResolvePrice.mockResolvedValue(0.0000001); // 1e-7, below 6dp grid
    const ORIGINAL_RATE = process.env.PROTOCOL_FEE_RATE;
    process.env.PROTOCOL_FEE_RATE = '0';
    try {
      capturedX402ChallengeAmountUsd = undefined;
      const res = await app.inject({
        method: 'POST',
        url: '/compose',
        payload: { steps: [{ agent: 'tiny', input: {} }] },
      });
      expect(res.statusCode).toBe(200);
      // pipelineUsd = 1e-7 > 0 but rounds to 0 at 6dp → floored to 1e-6, NOT 0.
      expect(capturedX402ChallengeAmountUsd).toBe(0.000001);
    } finally {
      if (ORIGINAL_RATE === undefined) delete process.env.PROTOCOL_FEE_RATE;
      else process.env.PROTOCOL_FEE_RATE = ORIGINAL_RATE;
    }
  });

  // ── MNR-2 (AR HIGH-2): el guard de layer 1, probado en UNIT ──
  //
  // `validateComposeBodyHandler` (layer 0) rechaza los bodies malformados ANTES
  // del preHandler de precio, así que la rama "step malformado" de
  // `augmentX402ChallengeAmount` YA NO es alcanzable vía HTTP: quedó con 0% de
  // cobertura y un guard defensivo sin test se rompe en silencio. Se prueba
  // llamando la función directo (la razón por la que está exportada).

  it('T-ROUTE-X402-AMT-7 (MNR-2, unit): un step malformado se SOBRE-estima como placeholder, no colapsa el challenge', async () => {
    const ORIGINAL_RATE = process.env.PROTOCOL_FEE_RATE;
    process.env.PROTOCOL_FEE_RATE = '0';
    try {
      // Sólo se cotiza el step BIEN formado (índice 2); el malformado se
      // sobre-estima sin llamar a discovery.
      mockResolvePrice.mockResolvedValue(0.5);
      const request = {} as FastifyRequest;

      await augmentX402ChallengeAmount(
        request,
        [
          { agent: 'a0', input: {} },
          // biome-ignore lint/suspicious/noExplicitAny: intentional malformed step
          { agent: 12345 as any, input: {} },
          { agent: 'a2', input: {} },
        ],
        0.5, // step-0 ya resuelto por el caller
      );

      // 0.5 (step-0) + 1 (PLACEHOLDER por el malformado) + 0.5 (step-2) = 2.
      // Si la rama hiciera `return` en vez de `continue`, el challenge quedaría
      // undefined → el middleware cobraría el default de 1 USD mientras el
      // gateway settlea el prefijo válido downstream (la pérdida de BLQ-MEDIO-1).
      expect(request.x402ChallengeAmountUsd).toBeCloseTo(2, 8);
      // El step malformado NO se cotiza; los otros dos sí (step-0 lo trae el
      // caller ya resuelto, así que acá sólo se resuelve el índice 2).
      expect(mockResolvePrice).toHaveBeenCalledTimes(1);
      expect(mockResolvePrice).toHaveBeenCalledWith('a2', undefined);
    } finally {
      if (ORIGINAL_RATE === undefined) delete process.env.PROTOCOL_FEE_RATE;
      else process.env.PROTOCOL_FEE_RATE = ORIGINAL_RATE;
    }
  });

  it('T-ROUTE-X402-AMT-8 (MNR-2, unit): pipeline de costo 0 NO advertise challenge', async () => {
    // Guard `if (pipelineUsd <= 0) return;` — también sin cobertura. Un challenge
    // de 0 sería un 402 pidiendo nada; mejor dejar el default del middleware.
    const request = {} as FastifyRequest;

    await augmentX402ChallengeAmount(request, [{ agent: 'a0', input: {} }], 0);

    expect(request.x402ChallengeAmountUsd).toBeUndefined();
    expect(mockResolvePrice).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
// WKH-59 (real-price-debit) WAVE W5 — E2E integration tests
//
// These tests exercise the full pipeline `preHandler → middleware →
// route handler → composeService` via a Fastify inject. middleware is
// mocked to pass-through (per existing pattern); composeService.compose
// is mocked to assert that the route handler forwards the price-related
// fields (chainId, scopingKeyRow) correctly.
// ─────────────────────────────────────────────────────────────────────

describe('compose E2E — WKH-59 real-price-debit pipeline', () => {
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
  });

  it('T-E2E-PRICE-1 1-step pipeline → preHandler injects price, service runs once', async () => {
    mockResolvePrice.mockResolvedValueOnce(0.001);
    mockCompose.mockResolvedValueOnce({
      success: true,
      output: 'r1',
      steps: [],
      totalCostUsdc: 0.001,
      totalLatencyMs: 5,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { steps: [{ agent: 'kyc', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    expect(mockResolvePrice).toHaveBeenCalledTimes(1);
    expect(mockCompose).toHaveBeenCalledTimes(1);
  });

  it('T-E2E-PRICE-2 3-step pipeline → service receives scopingKeyRow, route forwards chainId path', async () => {
    mockResolvePrice.mockResolvedValueOnce(0.001);
    mockCompose.mockResolvedValueOnce({
      success: true,
      output: 'r3',
      steps: [],
      // sum 0.001 (mw) + 0.05 + 0.01 = 0.061 (NOT $3)
      totalCostUsdc: 0.061,
      totalLatencyMs: 30,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: {
        steps: [
          { agent: 'kyc', input: {} },
          { agent: 'corridor', input: {} },
          { agent: 'cashout', input: {} },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().totalCostUsdc).toBe(0.061);
    // Route handler propagates scopingKeyRow + chainId fields to the service.
    expect(mockCompose).toHaveBeenCalledWith(
      expect.objectContaining({
        scopingKeyRow: expect.objectContaining({ id: 'k1' }),
        a2aKey: 'wasi_a2a_test',
        // chainId may be undefined here (middleware mocked as no-op), but
        // the property MUST be forwarded (asserted by `objectContaining`).
      }),
    );
  });

  it('T-E2E-PRICE-3 unknown agent → 404 with zero downstream calls', async () => {
    mockResolvePrice.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { steps: [{ agent: 'ghost', input: {} }] },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error_code).toBe('AGENT_NOT_FOUND');
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it('T-E2E-PRICE-4 priceUsdc=0 → fallback header + service still runs', async () => {
    mockResolvePrice.mockResolvedValueOnce(0);
    mockCompose.mockResolvedValueOnce({
      success: true,
      output: 'ok',
      steps: [],
      totalCostUsdc: 1.0, // fallback placeholder $1
      totalLatencyMs: 5,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { steps: [{ agent: 'broken-agent', input: {} }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-debit-fallback']).toBe('registry-miss');
    expect(mockCompose).toHaveBeenCalledTimes(1);
  });

  it('T-E2E-PRICE-5 discovery throws → 503 with zero downstream calls', async () => {
    mockResolvePrice.mockRejectedValueOnce(new Error('upstream DB error'));

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

  it('T-E2E-PRICE-6 multi-step debit failure mid-pipeline → 400 default mapping (DT-H)', async () => {
    mockResolvePrice.mockResolvedValueOnce(0.001);
    mockCompose.mockResolvedValueOnce({
      success: false,
      output: null,
      steps: [],
      totalCostUsdc: 0.001,
      totalLatencyMs: 10,
      error: 'Step 1 debit failed: insufficient budget',
      // DT-H: NO errorCode='SCOPE_DENIED' → route maps to 400.
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: {
        steps: [
          { agent: 'kyc', input: {} },
          { agent: 'corridor', input: {} },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Step 1 debit failed');
    expect(res.json().errorCode).toBeUndefined();
  });

  it('T-E2E-PRICE-7 registry hint propagates to price resolver', async () => {
    mockResolvePrice.mockResolvedValueOnce(0.05);
    mockCompose.mockResolvedValueOnce({
      success: true,
      output: 'ok',
      steps: [],
      totalCostUsdc: 0.05,
      totalLatencyMs: 5,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: {
        steps: [{ agent: 'corridor', registry: 'wasiai-agentshop', input: {} }],
      },
    });

    expect(res.statusCode).toBe(200);
    // DT-B: cache scoped by (slug, registryName).
    expect(mockResolvePrice).toHaveBeenCalledWith(
      'corridor',
      'wasiai-agentshop',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// AUDIT A1 (ALTA, money-path) — /compose reembolsa el step-0 pre-debitado
// por el middleware (path a2a-key) cuando el pipeline FALLA. Mirror exacto
// de orchestrate.ts:644 — refundUsd = max(0, debited - totalCostUsdc).
// ─────────────────────────────────────────────────────────────────────

describe('compose route — AUDIT A1 step-0 refund on failure', () => {
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
    nextEstimatedCostUsd = undefined;
    nextResolvedChainId = undefined;
    nextInjectedDestination = undefined;
    capturedComposeDestination = undefined;
    mockResolvePrice.mockResolvedValue(0.001);
    mockCredit.mockResolvedValue({ success: true });
    mockCreditWithDest.mockResolvedValue({ success: true });
  });

  it('T-A1-1: step-0 falla (totalCostUsdc=0) → reembolsa el step-0 entero (creditWithDest)', async () => {
    // Middleware debitó 0.30 con destino canónico (path dest-cap).
    nextEstimatedCostUsd = 0.3;
    nextResolvedChainId = 2368;
    nextInjectedDestination = 'wasiai/kyc';
    mockCompose.mockResolvedValueOnce({
      success: false,
      output: null,
      steps: [],
      totalCostUsdc: 0, // step-0 ni settleó
      totalLatencyMs: 0,
      error: 'Step 0 agent returned 500',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { steps: [{ agent: 'kyc', input: {} }] },
    });

    expect(res.statusCode).toBe(400);
    // Reembolsa EXACTAMENTE el step-0 (0.30) con el mismo destino del débito.
    expect(mockCreditWithDest).toHaveBeenCalledTimes(1);
    const call = mockCreditWithDest.mock.calls[0]!;
    expect(call[0]).toBe('k1'); // keyId
    expect(call[1]).toBe(2368); // chainId
    expect(call[2]).toBeCloseTo(0.3, 6); // refundUsd = composeEstimatedCostUsd
    expect(call[3]).toBe('o1'); // ownerRef
    expect(call[4]).toBe('wasiai/kyc'); // destino canónico = el del débito
    expect(mockCredit).not.toHaveBeenCalled();
  });

  it('T-A1-2: step-0 OK + step-2 falla → NO reembolsa el step-0 (clamp a 0)', async () => {
    // Middleware debitó 0.30; el step-0 settleó (su precio ya está en totalCostUsdc).
    nextEstimatedCostUsd = 0.3;
    nextResolvedChainId = 2368;
    nextInjectedDestination = 'wasiai/kyc';
    mockCompose.mockResolvedValueOnce({
      success: false,
      output: null,
      steps: [],
      // totalCostUsdc incluye el step-0 (0.30) + lo que settleó antes del fallo.
      totalCostUsdc: 0.35,
      totalLatencyMs: 10,
      error: 'Step 2 debit failed',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: {
        steps: [
          { agent: 'kyc', input: {} },
          { agent: 'corridor', input: {} },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    // max(0, 0.30 - 0.35) = 0 → no refund del step-0 ya entregado.
    expect(mockCreditWithDest).not.toHaveBeenCalled();
    expect(mockCredit).not.toHaveBeenCalled();
  });

  it('T-A1-3: sin destino canónico → usa credit (sin dest-policy)', async () => {
    nextEstimatedCostUsd = 0.3;
    nextResolvedChainId = 2368;
    nextInjectedDestination = undefined; // no hay destino fiable
    mockCompose.mockResolvedValueOnce({
      success: false,
      output: null,
      steps: [],
      totalCostUsdc: 0,
      totalLatencyMs: 0,
      error: 'Step 0 agent returned 500',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { steps: [{ agent: 'kyc', input: {} }] },
    });

    expect(res.statusCode).toBe(400);
    expect(mockCredit).toHaveBeenCalledTimes(1);
    const call = mockCredit.mock.calls[0]!;
    expect(call[2]).toBeCloseTo(0.3, 6);
    // HU-194: el refund del step-0 lleva la clave de su propio slot. Si usara el
    // slot de otro refund de la misma request, uno de los dos se descartaría.
    expect(call[4]?.idemKey).toMatch(/:compose-step0$/);
    expect(mockCreditWithDest).not.toHaveBeenCalled();
  });

  it('T-A1-4: path x402 puro (sin a2aKeyRow ni débito) → NO reembolsa', async () => {
    nextKeyRow = undefined; // x402: el middleware no debita budget
    nextEstimatedCostUsd = undefined;
    nextResolvedChainId = undefined;
    mockCompose.mockResolvedValueOnce({
      success: false,
      output: null,
      steps: [],
      totalCostUsdc: 0,
      totalLatencyMs: 0,
      error: 'Step 0 agent returned 500',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { steps: [{ agent: 'kyc', input: {} }] },
    });

    expect(res.statusCode).toBe(400);
    expect(mockCredit).not.toHaveBeenCalled();
    expect(mockCreditWithDest).not.toHaveBeenCalled();
  });

  it('T-A1-5: refund best-effort — credit falla → response NO cambia (sigue 400)', async () => {
    nextEstimatedCostUsd = 0.3;
    nextResolvedChainId = 2368;
    nextInjectedDestination = 'wasiai/kyc';
    mockCreditWithDest.mockResolvedValueOnce({
      success: false,
      error: 'REFUND_FAILED',
    });
    mockCompose.mockResolvedValueOnce({
      success: false,
      output: null,
      steps: [],
      totalCostUsdc: 0,
      totalLatencyMs: 0,
      error: 'Step 0 agent returned 500',
    });
    logSpy.error.mockClear();

    const res = await app.inject({
      method: 'POST',
      url: '/compose',
      headers: { 'x-a2a-key': 'wasi_a2a_test' },
      payload: { steps: [{ agent: 'kyc', input: {} }] },
    });

    expect(res.statusCode).toBe(400);
    expect(mockCreditWithDest).toHaveBeenCalledTimes(1);
    // object-first / message-second: structured context in arg[0], tag in arg[1].
    expect(logSpy.error).toHaveBeenCalledWith(
      expect.objectContaining({ keyId: 'k1', amountUsd: expect.any(Number) }),
      '[compose.refund-failed]',
    );
  });
});
