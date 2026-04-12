/**
 * Request ID Tests — WKH-18 Hardening — AC-10
 */

import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { genReqId, registerRequestIdHook } from './request-id.js';

describe('request-id middleware', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ genReqId });
    registerRequestIdHook(app);

    app.get('/test', async () => ({ ok: true }));

    await app.ready();
  });

  afterAll(() => app.close());

  it('AC-10: response includes x-request-id header with UUID v4 format', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/test',
    });

    const requestId = response.headers['x-request-id'] as string;
    expect(requestId).toBeDefined();
    // UUID v4 format: 8-4-4-4-12 hex chars
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('AC-10: each request gets a unique requestId', async () => {
    const r1 = await app.inject({ method: 'GET', url: '/test' });
    const r2 = await app.inject({ method: 'GET', url: '/test' });

    const id1 = r1.headers['x-request-id'] as string;
    const id2 = r2.headers['x-request-id'] as string;

    expect(id1).not.toBe(id2);
  });

  it('AC-10: genReqId returns valid UUID v4', () => {
    const id = genReqId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
