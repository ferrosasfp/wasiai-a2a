/**
 * Error Boundary Tests — WKH-18 Hardening — AC-3, AC-4
 */

import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CircuitOpenError } from '../lib/circuit-breaker.js';
import { registerErrorBoundary } from './error-boundary.js';
import { genReqId, registerRequestIdHook } from './request-id.js';

describe('error-boundary middleware', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify({ genReqId });
    registerRequestIdHook(app);
    registerErrorBoundary(app);

    // Route that throws a generic error
    app.get('/throw-generic', async () => {
      throw new Error('Something broke');
    });

    // Route that throws CircuitOpenError
    app.get('/throw-circuit', async () => {
      throw new CircuitOpenError('anthropic');
    });

    // Route with schema validation
    app.post(
      '/validated',
      {
        schema: {
          body: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string' },
            },
          },
        },
      },
      async () => ({ ok: true }),
    );

    // Route that throws error with statusCode
    app.get('/throw-custom-status', async () => {
      const err = new Error('Custom error') as Error & { statusCode: number };
      err.statusCode = 422;
      throw err;
    });

    await app.ready();
  });

  afterAll(() => app.close());

  // ── AC-3: Consistent error shape ─────────────────────────────

  it('AC-3: generic error returns { error, code, requestId } with INTERNAL_ERROR', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/throw-generic',
    });

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.requestId).toBeDefined();
    expect(typeof body.error).toBe('string');
  });

  it('AC-3: CircuitOpenError returns 503 with code CIRCUIT_OPEN and requestId', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/throw-circuit',
    });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.code).toBe('CIRCUIT_OPEN');
    expect(body.error).toBe('Circuit breaker "anthropic" is open');
    expect(body.requestId).toBeDefined();
  });

  it('AC-3: error responses include x-request-id header', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/throw-generic',
    });

    expect(response.headers['x-request-id']).toBeDefined();
    const body = response.json();
    expect(body.requestId).toBe(response.headers['x-request-id']);
  });

  it('AC-3: custom statusCode is preserved', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/throw-custom-status',
    });

    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.code).toBe('INTERNAL_ERROR');
  });

  // ── AC-4: Validation errors ───────────────────────────────────

  it('AC-4: schema validation error returns 400 with VALIDATION_ERROR and details', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/validated',
      payload: {},
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.error).toBe('Validation failed');
    expect(body.details).toBeDefined();
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.requestId).toBeDefined();
  });
});
