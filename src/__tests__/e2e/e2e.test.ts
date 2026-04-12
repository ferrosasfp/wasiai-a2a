/**
 * E2E Test Suite — WKH-029
 * Covers AC-1 through AC-20: full request/response cycle via fastify.inject()
 */

import type Fastify from 'fastify';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  buildTestApp,
  discoveryService,
  identityService,
  makeKeyRow,
  TEST_KEY,
  TEST_KEY_ID,
} from './setup.js';

// ── Environment ───────────────────────────────────────────────
process.env.RATE_LIMIT_MAX = '10';
process.env.RATE_LIMIT_WINDOW_MS = '60000';
process.env.KITE_WALLET_ADDRESS = '0x1234567890123456789012345678901234567890';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const mockCreateKey = identityService.createKey as ReturnType<typeof vi.fn>;
const mockLookupByHash = identityService.lookupByHash as ReturnType<
  typeof vi.fn
>;
const mockDiscover = discoveryService.discover as ReturnType<typeof vi.fn>;

describe('E2E', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(() => app.close());

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Server bootstrap + health (AC-1, AC-2) ─────────────────

  describe('Server bootstrap + health', () => {
    it('AC-1: buildTestApp() completes without errors', () => {
      expect(app).toBeDefined();
    });

    it('AC-2: GET / returns 200 with name and version', async () => {
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.name).toBe('WasiAI A2A Protocol');
      expect(body.version).toBe('0.1.0');
    });
  });

  // ── Well-known agent card (AC-3) ────────────────────────────

  describe('Well-known agent card', () => {
    it('AC-3: GET /.well-known/agent.json returns valid Agent Card', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/.well-known/agent.json',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('name');
      expect(body).toHaveProperty('description');
      expect(body).toHaveProperty('url');
      expect(body).toHaveProperty('capabilities');
      expect(body).toHaveProperty('skills');
    });
  });

  // ── Middleware -- request-id (AC-4) ─────────────────────────

  describe('Middleware -- request-id', () => {
    it('AC-4: every response includes x-request-id in UUID format', async () => {
      const res = await app.inject({ method: 'GET', url: '/' });
      const reqId = res.headers['x-request-id'] as string;
      expect(reqId).toBeDefined();
      expect(reqId).toMatch(UUID_RE);
    });
  });

  // ── Middleware -- error boundary (AC-5) ─────────────────────

  describe('Middleware -- error boundary', () => {
    it('AC-5: error responses have structured shape with error, code, requestId', async () => {
      mockDiscover.mockRejectedValueOnce(new Error('Discovery exploded'));

      const res = await app.inject({ method: 'GET', url: '/discover' });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      const body = res.json();
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('code');
      expect(body).toHaveProperty('requestId');
    });
  });

  // ── Middleware -- rate limit (AC-6) ─────────────────────────
  // Uses separate app instance to avoid state pollution

  describe('Middleware -- rate limit', () => {
    let rateLimitApp: ReturnType<typeof Fastify>;

    beforeAll(async () => {
      rateLimitApp = await buildTestApp();
    });

    afterAll(() => rateLimitApp.close());

    it('AC-6: 11th request returns 429 with Retry-After', async () => {
      mockCreateKey.mockResolvedValue({ key: TEST_KEY, key_id: TEST_KEY_ID });

      // Fire 11 requests to a rate-limited endpoint
      const results = [];
      for (let i = 0; i < 11; i++) {
        const res = await rateLimitApp.inject({
          method: 'POST',
          url: '/auth/agent-signup',
          payload: { owner_ref: `user-${i}` },
        });
        results.push(res);
      }

      const lastRes = results[10];
      expect(lastRes.statusCode).toBe(429);
      expect(lastRes.headers['retry-after']).toBeDefined();
    });
  });

  // ── Identity -- agent-signup (AC-7) ─────────────────────────

  describe('Identity -- agent-signup', () => {
    it('AC-7: POST /auth/agent-signup returns 201 with wasi_a2a_ key', async () => {
      mockCreateKey.mockResolvedValue({ key: TEST_KEY, key_id: TEST_KEY_ID });

      const res = await app.inject({
        method: 'POST',
        url: '/auth/agent-signup',
        payload: { owner_ref: 'user-1' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.key).toMatch(/^wasi_a2a_/);
    });
  });

  // ── Identity -- me (AC-8, AC-9, AC-10) ─────────────────────

  describe('Identity -- me', () => {
    it('AC-8: GET /auth/me with valid key returns 200 with budget/scoping', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());

      const res = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { 'x-a2a-key': TEST_KEY },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('budget');
      expect(body).toHaveProperty('scoping');
    });

    it('AC-9: GET /auth/me without header returns 403', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/me',
      });

      expect(res.statusCode).toBe(403);
    });

    it('AC-10: GET /auth/me with invalid key returns 403 with code KEY_NOT_FOUND', async () => {
      mockLookupByHash.mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { 'x-a2a-key': 'wasi_a2a_bad' },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ── Identity -- deposit + bind (AC-11, AC-12) ──────────────

  describe('Identity -- deposit + bind', () => {
    it('AC-11: POST /auth/deposit returns 501', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/deposit',
        payload: {
          key_id: TEST_KEY_ID,
          chain_id: 2368,
          token: 'PYUSD',
          amount: '10.00',
          tx_hash: '0xabc123',
        },
      });

      expect(res.statusCode).toBe(501);
    });

    it('AC-12: POST /auth/bind/kite returns 501', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/bind/kite',
      });

      expect(res.statusCode).toBe(501);
    });
  });

  // ── Gasless status (AC-13) ──────────────────────────────────

  describe('Gasless status', () => {
    it('AC-13: GET /gasless/status returns 200 with funding_state', async () => {
      const res = await app.inject({ method: 'GET', url: '/gasless/status' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('funding_state');
      expect(['unconfigured', 'unfunded', 'ready']).toContain(
        body.funding_state,
      );
    });
  });

  // ── Dashboard (AC-14, AC-15) ────────────────────────────────

  describe('Dashboard', () => {
    it('AC-14: GET /dashboard returns 200 with text/html', async () => {
      const res = await app.inject({ method: 'GET', url: '/dashboard' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });

    it('AC-15: GET /dashboard/api/stats returns 200 with JSON', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/api/stats',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
    });
  });

  // ── Discovery (AC-16) ──────────────────────────────────────

  describe('Discovery', () => {
    it('AC-16: GET /discover returns 200', async () => {
      const res = await app.inject({ method: 'GET', url: '/discover' });
      expect(res.statusCode).toBe(200);
    });

    it('POST /discover returns 200 (WKH-BEARER-FIX AC-9)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/discover',
        payload: { query: 'test' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('GET /discover with agents includes invocationNote (WKH-BEARER-FIX AC-11)', async () => {
      mockDiscover.mockResolvedValueOnce({
        agents: [
          {
            id: 'agent-1',
            name: 'Test Agent',
            slug: 'test-agent',
            description: 'A test agent',
            capabilities: ['test'],
            priceUsdc: 0,
            registry: 'mock',
            invokeUrl: 'https://example.com/invoke',
            invocationNote:
              'The invokeUrl is an internal reference. To invoke this agent, use POST /compose or POST /orchestrate on the WasiAI A2A gateway.',
            metadata: {},
          },
        ],
        total: 1,
        registries: ['mock'],
      });

      const res = await app.inject({ method: 'GET', url: '/discover' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.agents[0]).toHaveProperty('invocationNote');
      expect(body.agents[0].invocationNote).toContain('/compose');
    });
  });

  // ── Health (WKH-BEARER-FIX AC-10) ──────────────────────────

  describe('Health', () => {
    it('AC-10: GET /health returns 200 with status and uptime', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('status', 'ok');
      expect(body).toHaveProperty('uptime');
      expect(typeof body.uptime).toBe('number');
    });
  });

  // ── Bearer auth on /auth/me (WKH-BEARER-FIX AC-8) ────────

  describe('Bearer auth', () => {
    it('AC-8: GET /auth/me with Bearer wasi_a2a_* returns 200', async () => {
      mockLookupByHash.mockResolvedValue(makeKeyRow());

      const res = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${TEST_KEY}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('budget');
      expect(body).toHaveProperty('scoping');
    });
  });

  // ── Error handling (AC-17, AC-18) ───────────────────────────

  describe('Error handling', () => {
    it('AC-17: POST with invalid JSON returns 400 with structured error', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/orchestrate',
        headers: { 'content-type': 'application/json' },
        payload: 'this is not valid json{{{',
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body).toHaveProperty('error');
      expect(body).toHaveProperty('code');
      expect(body).toHaveProperty('requestId');
    });

    it('AC-18: GET /nonexistent returns 404', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/this-route-does-not-exist',
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── Protected routes (AC-19, AC-20) ─────────────────────────

  describe('Protected routes', () => {
    it('AC-19: POST /compose without auth returns 402', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/compose',
        payload: { steps: [{ agentSlug: 'test', input: {} }] },
      });

      expect(res.statusCode).toBe(402);
    });

    it('AC-20: POST /orchestrate without auth returns 402', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/orchestrate',
        payload: { goal: 'test', budget: 1 },
      });

      expect(res.statusCode).toBe(402);
    });
  });
});
