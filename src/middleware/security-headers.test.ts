/**
 * Security Headers Tests — WKH-QG-HEADERS: AC-1, AC-2, AC-3
 */

import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerSecurityHeaders } from './security-headers.js';

describe('security-headers middleware', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    registerSecurityHeaders(app);

    app.get('/health', async () => ({ status: 'ok' }));

    await app.ready();
  });

  afterAll(() => app.close());

  it('AC-1: response includes X-Content-Type-Options: nosniff', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('AC-2: response includes X-Frame-Options: DENY', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.headers['x-frame-options']).toBe('DENY');
  });

  it('AC-3: both security headers present on /health response', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
  });
});
