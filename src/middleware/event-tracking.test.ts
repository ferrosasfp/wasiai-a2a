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

import { registerEventTracking } from './event-tracking.js';

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
    const call = mockTrack.mock.calls[0][0];
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
    expect(mockTrack.mock.calls[0][0].eventType).toBe(
      'request:POST:/orchestrate',
    );
  });

  it('AC-1: POST /compose — tracked', async () => {
    await app.inject({ method: 'POST', url: '/compose', payload: {} });
    await new Promise((r) => setTimeout(r, 50));

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack.mock.calls[0][0].eventType).toBe('request:POST:/compose');
  });

  it('AC-1: POST /auth/agent-signup — tracked', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/agent-signup',
      payload: {},
    });
    await new Promise((r) => setTimeout(r, 50));

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack.mock.calls[0][0].eventType).toBe(
      'request:POST:/auth/agent-signup',
    );
  });

  it('AC-1: GET /gasless/status — tracked', async () => {
    await app.inject({ method: 'GET', url: '/gasless/status' });
    await new Promise((r) => setTimeout(r, 50));

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack.mock.calls[0][0].eventType).toBe(
      'request:GET:/gasless/status',
    );
  });

  // ── AC-2: Latency measurement ────────────────────────────

  it('AC-2: latencyMs is a non-negative number', async () => {
    await app.inject({ method: 'POST', url: '/discover', payload: {} });
    await new Promise((r) => setTimeout(r, 50));

    const call = mockTrack.mock.calls[0][0];
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
    expect(mockTrack.mock.calls[0][0].status).toBe('failed');
  });
});
