/**
 * Discover Routes Rate-Limit Tests — WKH-AUDIT-A2A
 * AC-5: /discover ahora hereda el rate-limit global (ya no rateLimit:false).
 *       N+1 requests → 429 con body.code === 'RATE_LIMIT_EXCEEDED' (CD-6).
 *
 * CD-10: registerErrorBoundary ANTES de registerRateLimit (el rate-limit
 *        plugin THROWS el Error; el error-boundary lo convierte en respuesta).
 */

import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerErrorBoundary } from '../middleware/error-boundary.js';
import { registerRateLimit } from '../middleware/rate-limit.js';
import { genReqId, registerRequestIdHook } from '../middleware/request-id.js';

// Mock service: no fanout real.
vi.mock('../services/discovery.js', () => ({
  discoveryService: {
    discover: vi.fn().mockResolvedValue({ agents: [], total: 0 }),
    getAgent: vi.fn().mockResolvedValue(null),
  },
}));

import discoverRoutes from './discover.js';

describe('AC-5: /discover rate-limit', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    process.env.RATE_LIMIT_MAX = '3';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';

    app = Fastify({ genReqId });
    registerRequestIdHook(app);
    registerErrorBoundary(app); // CD-10: ANTES de rate-limit
    await registerRateLimit(app);
    await app.register(discoverRoutes, { prefix: '/discover' });
    await app.ready();
  });

  afterAll(async () => {
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.RATE_LIMIT_WINDOW_MS;
    await app.close();
  });

  it('GET within limit → 200', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'GET', url: '/discover' });
      expect(res.statusCode).toBe(200);
    }
  });

  it('GET exceeding limit → 429 with body.code RATE_LIMIT_EXCEEDED (CD-6)', async () => {
    // 4th request from the same default IP exceeds max=3.
    const res = await app.inject({ method: 'GET', url: '/discover' });
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe('RATE_LIMIT_EXCEEDED');
  });
});
