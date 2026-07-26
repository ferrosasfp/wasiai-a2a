/**
 * Event Tracking Middleware Tests — WKH-EVENT-TRACKING
 * Tests: AC-1 (tracked endpoints), AC-2 (latency), AC-3 (error suppression),
 *        AC-4 (non-tracked exclusion), AC-5 (no interference with existing tracking)
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

// ── Mock eventService BEFORE importing the middleware ──────

const mockTrack = vi.fn().mockResolvedValue({
  id: 'evt-1',
  eventType: 'test',
  status: 'success',
  createdAt: new Date(),
});

vi.mock('../services/event.js', () => ({
  eventService: {
    track: (...args: unknown[]) => mockTrack(...args),
  },
}));

import {
  noteDownstreamSkips,
  registerEventTracking,
} from './event-tracking.js';

// ── Setup ──────────────────────────────────────────────────

describe('registerEventTracking middleware', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    registerEventTracking(app);

    // Tracked endpoints
    app.post('/discover', async (_req: FastifyRequest, reply: FastifyReply) =>
      reply.send({ agents: [] }),
    );
    app.post(
      '/orchestrate',
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ result: 'ok' }),
    );
    app.post('/compose', async (_req: FastifyRequest, reply: FastifyReply) =>
      reply.send({ result: 'ok' }),
    );
    app.post(
      '/auth/agent-signup',
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    app.get(
      '/gasless/status',
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ enabled: true }),
    );

    // Non-tracked endpoints
    app.get('/health', async (_req: FastifyRequest, reply: FastifyReply) =>
      reply.send({ status: 'ok' }),
    );
    app.get(
      '/dashboard/stats',
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ stats: {} }),
    );
    app.get('/', async (_req: FastifyRequest, reply: FastifyReply) =>
      reply.send({ name: 'WasiAI' }),
    );

    // Tracked endpoint returning 400 (for status mapping test)
    app.post(
      '/discover/fail-test',
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.status(400).send({ error: 'bad' }),
    );

    await app.ready();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
    mockTrack.mockResolvedValue({
      id: 'evt-1',
      eventType: 'test',
      status: 'success',
      createdAt: new Date(),
    });
  });

  // ── AC-1: Tracked endpoints fire eventService.track() ─────

  it('AC-1: POST /discover — tracks event with correct fields', async () => {
    await app.inject({ method: 'POST', url: '/discover', payload: {} });

    // onResponse is async fire-and-forget; give it a tick
    await new Promise((r) => setTimeout(r, 50));

    expect(mockTrack).toHaveBeenCalledTimes(1);
    const call = mockTrack.mock.calls[0]![0]!;
    expect(call.eventType).toBe('request:POST:/discover');
    expect(call.status).toBe('success');
    expect(call.metadata.endpoint).toBe('/discover');
    expect(call.metadata.method).toBe('POST');
    expect(call.metadata.statusCode).toBe(200);
    expect(typeof call.metadata.requestId).toBe('string');
    expect(typeof call.metadata.timestamp).toBe('string');
  });

  it('AC-1: POST /orchestrate — tracked', async () => {
    await app.inject({ method: 'POST', url: '/orchestrate', payload: {} });
    await new Promise((r) => setTimeout(r, 50));

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack.mock.calls[0]![0]!.eventType).toBe(
      'request:POST:/orchestrate',
    );
  });

  it('AC-1: POST /compose — tracked', async () => {
    await app.inject({ method: 'POST', url: '/compose', payload: {} });
    await new Promise((r) => setTimeout(r, 50));

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack.mock.calls[0]![0]!.eventType).toBe(
      'request:POST:/compose',
    );
  });

  it('AC-1: POST /auth/agent-signup — tracked', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/agent-signup',
      payload: {},
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack.mock.calls[0]![0]!.eventType).toBe(
      'request:POST:/auth/agent-signup',
    );
  });

  it('AC-1: GET /gasless/status — tracked', async () => {
    await app.inject({ method: 'GET', url: '/gasless/status' });
    await new Promise((r) => setTimeout(r, 50));

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack.mock.calls[0]![0]!.eventType).toBe(
      'request:GET:/gasless/status',
    );
  });

  // ── AC-2: Latency measurement ────────────────────────────

  it('AC-2: latencyMs is a non-negative number', async () => {
    await app.inject({ method: 'POST', url: '/discover', payload: {} });
    await new Promise((r) => setTimeout(r, 50));

    const call = mockTrack.mock.calls[0]![0]!;
    expect(typeof call.latencyMs).toBe('number');
    expect(call.latencyMs).toBeGreaterThanOrEqual(0);
    expect(call.metadata.responseTimeMs).toBe(call.latencyMs);
  });

  // ── AC-3: Error suppression (fire-and-forget) ────────────

  it('AC-3: track() error is swallowed — response still 200', async () => {
    mockTrack.mockRejectedValue(new Error('Supabase down'));

    const response = await app.inject({
      method: 'POST',
      url: '/discover',
      payload: {},
    });
    await new Promise((r) => setTimeout(r, 50));

    // Response is NOT affected by tracking failure
    expect(response.statusCode).toBe(200);
    expect(mockTrack).toHaveBeenCalledTimes(1);
  });

  // ── AC-4: Non-tracked endpoints are excluded ─────────────

  it('AC-4: GET /health — NOT tracked', async () => {
    await app.inject({ method: 'GET', url: '/health' });
    await new Promise((r) => setTimeout(r, 50));

    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('AC-4: GET /dashboard/stats — NOT tracked (CD-4)', async () => {
    await app.inject({ method: 'GET', url: '/dashboard/stats' });
    await new Promise((r) => setTimeout(r, 50));

    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('AC-4: GET / (root) — NOT tracked', async () => {
    await app.inject({ method: 'GET', url: '/' });
    await new Promise((r) => setTimeout(r, 50));

    expect(mockTrack).not.toHaveBeenCalled();
  });

  // ── AC-1 status mapping: 4xx/5xx → failed ────────────────

  it('AC-1: 4xx response → status: failed', async () => {
    await app.inject({
      method: 'POST',
      url: '/discover/fail-test',
      payload: {},
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack.mock.calls[0]![0]!.status).toBe('failed');
  });

  // ── WKH-69 AC-4: payment_origin tagging ──

  it('T-AC4-1: paymentOrigin=passport → metadata.payment_origin=passport', async () => {
    // Inject the request and use a preHandler hook to set paymentOrigin
    // before the route runs. We register a separate Fastify app to keep
    // this isolated from the shared `app` (which has no preHandler).
    const localApp = Fastify();
    registerEventTracking(localApp);
    localApp.addHook('preHandler', async (req: FastifyRequest) => {
      req.paymentOrigin = 'passport';
    });
    localApp.post(
      '/orchestrate',
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await localApp.ready();

    try {
      await localApp.inject({
        method: 'POST',
        url: '/orchestrate',
        payload: {},
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockTrack).toHaveBeenCalledTimes(1);
      const metadata = mockTrack.mock.calls[0]![0]!.metadata;
      expect(metadata.payment_origin).toBe('passport');
    } finally {
      await localApp.close();
    }
  });

  it('T-AC4-2: paymentOrigin=eoa → metadata.payment_origin=eoa', async () => {
    const localApp = Fastify();
    registerEventTracking(localApp);
    localApp.addHook('preHandler', async (req: FastifyRequest) => {
      req.paymentOrigin = 'eoa';
    });
    localApp.post(
      '/orchestrate',
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await localApp.ready();

    try {
      await localApp.inject({
        method: 'POST',
        url: '/orchestrate',
        payload: {},
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockTrack).toHaveBeenCalledTimes(1);
      const metadata = mockTrack.mock.calls[0]![0]!.metadata;
      expect(metadata.payment_origin).toBe('eoa');
    } finally {
      await localApp.close();
    }
  });

  it('T-AC4-3: paymentOrigin undefined → metadata.payment_origin key ABSENT (forward-compat)', async () => {
    // Use the shared app (no preHandler sets paymentOrigin → it stays undefined)
    await app.inject({ method: 'POST', url: '/discover', payload: {} });
    await new Promise((r) => setTimeout(r, 50));

    expect(mockTrack).toHaveBeenCalledTimes(1);
    const metadata = mockTrack.mock.calls[0]![0]!.metadata;
    // Strict: key must be ABSENT, not present-with-undefined.
    expect('payment_origin' in metadata).toBe(false);
  });

  // ══════════════════════════════════════════════════════════════════
  // WKH-191x · persistencia de los skips del leg downstream
  //
  // AR MENOR-1: el spread de `downstreamSkips` (event-tracking.ts) NO tenía
  // ningún test: borrarlo dejaba la suite en verde y la pantalla en "sin
  // datos" para siempre. Estos cuatro casos son el tripwire de esa línea, y
  // están bajo MUTACIÓN: quitando el spread, T-SKIP-1/2/4 se ponen rojos.
  // ══════════════════════════════════════════════════════════════════

  /** App aislada cuyo handler corre `noteDownstreamSkips` como lo hace /compose. */
  async function appWithSteps(
    steps: ReadonlyArray<{ downstreamSettle?: string | undefined }>,
  ) {
    const localApp = Fastify();
    registerEventTracking(localApp);
    localApp.post(
      '/compose',
      async (req: FastifyRequest, reply: FastifyReply) => {
        noteDownstreamSkips(req, steps);
        return reply.send({ ok: true });
      },
    );
    await localApp.ready();
    return localApp;
  }

  async function trackedMetadata(
    steps: ReadonlyArray<{ downstreamSettle?: string | undefined }>,
  ) {
    const localApp = await appWithSteps(steps);
    try {
      await localApp.inject({ method: 'POST', url: '/compose', payload: {} });
      await new Promise((r) => setTimeout(r, 50));
      expect(mockTrack).toHaveBeenCalledTimes(1);
      return mockTrack.mock.calls[0]![0]!.metadata;
    } finally {
      await localApp.close();
    }
  }

  it('T-SKIP-1: los skips del pipeline llegan a metadata.downstreamSkips', async () => {
    const metadata = await trackedMetadata([
      { downstreamSettle: 'skipped:NO_PAYMENT_FIELD' },
      // Un leg PAGADO no aporta código: su valor es el hash del settle.
      { downstreamSettle: '0xabc123' },
      { downstreamSettle: 'skipped:SETTLE_FAILED' },
    ]);
    expect(metadata.downstreamSkips).toEqual([
      'NO_PAYMENT_FIELD',
      'SETTLE_FAILED',
    ]);
  });

  it('T-SKIP-2: pipeline sin skips → array VACÍO (que no es lo mismo que "sin datos")', async () => {
    const metadata = await trackedMetadata([{ downstreamSettle: '0xabc123' }]);
    // La clave PRESENTE con [] es la señal de "este gateway sí reporta y no
    // hubo skips". Su AUSENCIA significa "tráfico sin la señal" (T-SKIP-3).
    expect('downstreamSkips' in metadata).toBe(true);
    expect(metadata.downstreamSkips).toEqual([]);
  });

  it('T-SKIP-3: ruta que no corre pipeline → la clave está AUSENTE (no undefined)', async () => {
    await app.inject({ method: 'POST', url: '/discover', payload: {} });
    await new Promise((r) => setTimeout(r, 50));

    expect(mockTrack).toHaveBeenCalledTimes(1);
    const metadata = mockTrack.mock.calls[0]![0]!.metadata;
    expect('downstreamSkips' in metadata).toBe(false);
  });

  it('T-SKIP-4: un código INTERNO no se persiste (no puede llegar a la pantalla)', async () => {
    const metadata = await trackedMetadata([
      // Ninguno de estos existe en el vocabulario público: revelan el estado de
      // la hot wallet del operador y de un feature flag.
      { downstreamSettle: 'skipped:INSUFFICIENT_BALANCE' },
      { downstreamSettle: 'skipped:FLAG_OFF' },
      { downstreamSettle: 'skipped:MAINNET_NOT_ALLOWED' },
      { downstreamSettle: 'skipped:UNAVAILABLE' },
    ]);
    expect(metadata.downstreamSkips).toEqual(['UNAVAILABLE']);
  });
});
