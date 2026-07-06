/**
 * Inbound Adapter Routes — integration tests (WKH-115).
 *
 * Cubre: AC-1 (firma válida → ingest invocado → 200), AC-2 (sin firma / firma
 * inválida → 401, cero ingest), mapeo error→HTTP (400/500), y el VERIFY-AT-IMPL
 * del parser raw-body ENCAPSULADO (no se filtra a otros routes — CD-7).
 *
 * Middlewares + inboundTaskService mockeados.
 */

import Fastify, { type FastifyRequest } from 'fastify';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// ── Mock middlewares (no-ops) ───────────────────────────────
vi.mock('../middleware/timeout.js', () => ({
  createTimeoutHandler: () => async () => {
    /* no-op */
  },
}));
vi.mock('../middleware/rate-limit.js', () => ({
  orchestrateRateLimit: () => false,
}));
vi.mock('../middleware/backpressure.js', () => ({
  createBackpressureHandler: () => async () => {
    /* no-op */
  },
}));

// ── Mocks hoisted ──
const { mockVerifyAuth, mockIngest } = vi.hoisted(() => ({
  mockVerifyAuth: vi.fn(),
  mockIngest: vi.fn(),
}));

// ── Mock service (mantiene error classes reales) ──
vi.mock('../services/inbound-task.js', async (importActual) => {
  const actual =
    await importActual<typeof import('../services/inbound-task.js')>();
  return {
    ...actual,
    inboundTaskService: {
      verifySourceAuth: mockVerifyAuth,
      ingest: mockIngest,
    },
  };
});

import inboundRoutes from './inbound.js';

let app: ReturnType<typeof Fastify>;

const CFG = {
  source: 'TEST',
  secret: 's',
  a2aKeyRaw: 'k',
  maxBudgetUsdc: 10,
  defaultBudgetUsdc: 2,
  chainId: 2368,
};

beforeAll(async () => {
  app = Fastify();
  await app.register(inboundRoutes, { prefix: '/inbound' });
  // Control route (sibling del plugin) para verificar que el parser raw-body
  // NO se filtró: si estuviera global, `req.rawBody` estaría definido acá.
  app.post('/ctrl', async (req: FastifyRequest) => ({
    hasRawBody:
      (req as FastifyRequest & { rawBody?: Buffer }).rawBody !== undefined,
    body: req.body,
  }));
  await app.ready();
});

afterAll(() => app.close());

beforeEach(() => {
  vi.clearAllMocks();
});

// ── AC-1 — firma válida → ingest invocado → 200 ──
describe('AC-1: firma válida crea ingested (ruta → ingest)', () => {
  it('verifySourceAuth ok → ingest(source, cfg, body) → 200 settled', async () => {
    mockVerifyAuth.mockReturnValue(CFG);
    mockIngest.mockResolvedValue({
      status: 'settled',
      orchestrationId: 'orch-1',
      answer: 'done',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/inbound/test/tasks',
      headers: {
        'content-type': 'application/json',
        'x-wasiai-timestamp': '1751826000',
        'x-wasiai-signature': 'a'.repeat(64),
      },
      payload: { goal: 'build a report' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('settled');
    expect(mockIngest).toHaveBeenCalledTimes(1);
    const [src, cfgArg, body] = mockIngest.mock.calls[0]!;
    expect(src).toBe('test');
    expect(cfgArg).toBe(CFG);
    expect(body).toEqual({ goal: 'build a report' });
  });
});

// ── AC-2 — auth falla → 401, cero ingest ──
describe('AC-2: auth falla → 401 sin ingest', () => {
  it('sin headers de firma → 401, verifyAuth/ingest no invocados por firma', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/inbound/test/tasks',
      headers: { 'content-type': 'application/json' },
      payload: { goal: 'x' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error_code).toBe('UNAUTHORIZED');
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('firma inválida (verifyAuth null) → 401, cero ingest', async () => {
    mockVerifyAuth.mockReturnValue(null);
    const res = await app.inject({
      method: 'POST',
      url: '/inbound/test/tasks',
      headers: {
        'content-type': 'application/json',
        'x-wasiai-timestamp': '1751826000',
        'x-wasiai-signature': 'b'.repeat(64),
      },
      payload: { goal: 'x' },
    });
    expect(res.statusCode).toBe(401);
    expect(mockIngest).not.toHaveBeenCalled();
  });
});

// ── error→HTTP mapping ──
describe('mapeo error→HTTP', () => {
  it('InvalidInboundPayloadError → 400 INVALID_PAYLOAD', async () => {
    mockVerifyAuth.mockReturnValue(CFG);
    const { InvalidInboundPayloadError } = await import(
      '../services/inbound-task.js'
    );
    mockIngest.mockRejectedValue(
      new InvalidInboundPayloadError('goal missing'),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/inbound/test/tasks',
      headers: {
        'content-type': 'application/json',
        'x-wasiai-timestamp': '1751826000',
        'x-wasiai-signature': 'a'.repeat(64),
      },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('INVALID_PAYLOAD');
  });

  it('InboundSourceMisconfiguredError → 500 INBOUND_SOURCE_MISCONFIGURED', async () => {
    mockVerifyAuth.mockReturnValue(CFG);
    const { InboundSourceMisconfiguredError } = await import(
      '../services/inbound-task.js'
    );
    mockIngest.mockRejectedValue(new InboundSourceMisconfiguredError());
    const res = await app.inject({
      method: 'POST',
      url: '/inbound/test/tasks',
      headers: {
        'content-type': 'application/json',
        'x-wasiai-timestamp': '1751826000',
        'x-wasiai-signature': 'a'.repeat(64),
      },
      payload: { goal: 'x' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error_code).toBe('INBOUND_SOURCE_MISCONFIGURED');
  });

  it('rejected → 200 con status rejected', async () => {
    mockVerifyAuth.mockReturnValue(CFG);
    mockIngest.mockResolvedValue({ status: 'rejected', reason: 'escrow' });
    const res = await app.inject({
      method: 'POST',
      url: '/inbound/test/tasks',
      headers: {
        'content-type': 'application/json',
        'x-wasiai-timestamp': '1751826000',
        'x-wasiai-signature': 'a'.repeat(64),
      },
      payload: { goal: 'x', payment: {} },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('rejected');
  });
});

// ── VERIFY-AT-IMPL: parser raw-body encapsulado (no se filtra) — CD-7 ──
describe('parser raw-body encapsulado (CD-7)', () => {
  it('el parser NO se filtró: /ctrl parsea JSON normal sin rawBody', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/ctrl',
      headers: { 'content-type': 'application/json' },
      payload: { hello: 'world' },
    });
    expect(res.statusCode).toBe(200);
    // Body parseado normalmente por el parser GLOBAL (default de Fastify).
    expect(res.json().body).toEqual({ hello: 'world' });
    // rawBody NO está seteado fuera del plugin inbound → parser encapsulado.
    expect(res.json().hasRawBody).toBe(false);
  });
});
