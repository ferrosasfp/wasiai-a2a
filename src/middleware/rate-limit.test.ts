/**
 * Rate Limit Tests — WKH-18 Hardening — AC-1, AC-2
 */

import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerErrorBoundary } from './error-boundary.js';
import { registerRateLimit } from './rate-limit.js';
import { genReqId, registerRequestIdHook } from './request-id.js';

describe('rate-limit middleware', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    // Configure low limits for testing
    process.env.RATE_LIMIT_MAX = '3';
    process.env.RATE_LIMIT_WINDOW_MS = '60000';

    app = Fastify({ genReqId });
    registerRequestIdHook(app);
    registerErrorBoundary(app);
    await registerRateLimit(app);

    // Route with rate limit applied via config
    app.post(
      '/test',
      {
        config: {
          rateLimit: {
            max: 3,
            timeWindow: 60000,
          },
        },
      },
      async () => ({ ok: true }),
    );

    await app.ready();
  });

  afterAll(async () => {
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.RATE_LIMIT_WINDOW_MS;
    await app.close();
  });

  it('AC-1: requests within limit return 200', async () => {
    for (let i = 0; i < 3; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/test',
      });
      expect(response.statusCode).toBe(200);
    }
  });

  it('AC-1: request exceeding limit returns 429 with correct body shape', async () => {
    // 4th request (after 3 from previous test, all from same default IP)
    const response = await app.inject({
      method: 'POST',
      url: '/test',
    });

    expect(response.statusCode).toBe(429);
    const body = response.json();
    expect(body.error).toBe('Too Many Requests');
    expect(body.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(typeof body.retryAfterMs).toBe('number');
    expect(body.requestId).toBeDefined();
  });

  it('AC-2: 429 response includes Retry-After header', async () => {
    // Already exceeded from previous tests
    const response = await app.inject({
      method: 'POST',
      url: '/test',
    });

    expect(response.statusCode).toBe(429);
    const retryAfter = response.headers['retry-after'];
    expect(retryAfter).toBeDefined();
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });
});
