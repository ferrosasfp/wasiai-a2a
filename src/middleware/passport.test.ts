/**
 * requirePassport Middleware Tests — WKH-69
 *
 * Coverage (≥6 tests, AC-10):
 *   - T-AC10-1: env unset → factory returns [] (NOT mounted)
 *   - T-AC10-2: env 'true' + paymentOrigin='passport' → passthrough
 *   - T-AC10-3: env 'true' + paymentOrigin='eoa' → 403 PASSPORT_REQUIRED
 *   - T-AC10-4: env 'true' + paymentOrigin undefined → 403 (fail-secure)
 *   - T-AC10-5: env 'TRUE' (case mismatch) → factory returns [] (strict)
 *   - T-AC10-6: env 'false' or other → factory returns []
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requirePassport } from './passport.js';

describe('requirePassport middleware (WKH-69)', () => {
  const ORIGINAL_ENV = process.env.PASSPORT_REQUIRE_INBOUND;

  beforeEach(() => {
    delete process.env.PASSPORT_REQUIRE_INBOUND;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.PASSPORT_REQUIRE_INBOUND;
    } else {
      process.env.PASSPORT_REQUIRE_INBOUND = ORIGINAL_ENV;
    }
  });

  // ── T-AC10-1: env unset → not mounted ──

  it('T-AC10-1: PASSPORT_REQUIRE_INBOUND unset → factory returns []', () => {
    delete process.env.PASSPORT_REQUIRE_INBOUND;
    const handlers = requirePassport();
    expect(handlers).toEqual([]);
    expect(handlers.length).toBe(0);
  });

  // ── T-AC10-2: env 'true' + passport origin → passthrough ──

  it("T-AC10-2: env 'true' + paymentOrigin=passport → passthrough", async () => {
    process.env.PASSPORT_REQUIRE_INBOUND = 'true';

    const app = Fastify();
    app.addHook('preHandler', async (req: FastifyRequest) => {
      req.paymentOrigin = 'passport';
    });
    app.post(
      '/test',
      { preHandler: requirePassport() },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  // ── T-AC10-3: env 'true' + eoa origin → 403 ──

  it("T-AC10-3: env 'true' + paymentOrigin=eoa → 403 PASSPORT_REQUIRED", async () => {
    process.env.PASSPORT_REQUIRE_INBOUND = 'true';

    const app = Fastify();
    app.addHook('preHandler', async (req: FastifyRequest) => {
      req.paymentOrigin = 'eoa';
    });
    app.post(
      '/test',
      { preHandler: requirePassport() },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        payload: {},
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({
        error: 'Passport session required',
        error_code: 'PASSPORT_REQUIRED',
      });
    } finally {
      await app.close();
    }
  });

  // ── T-AC10-4: env 'true' + undefined origin → 403 (fail-secure) ──

  it("T-AC10-4: env 'true' + paymentOrigin=undefined → 403 (fail-secure)", async () => {
    process.env.PASSPORT_REQUIRE_INBOUND = 'true';

    const app = Fastify();
    // intentionally NO preHandler that sets paymentOrigin
    app.post(
      '/test',
      { preHandler: requirePassport() },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        payload: {},
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error_code).toBe('PASSPORT_REQUIRED');
    } finally {
      await app.close();
    }
  });

  // ── T-AC10-5: env 'TRUE' (case mismatch) → not mounted ──

  it("T-AC10-5: env 'TRUE' (uppercase) → factory returns [] (strict literal)", () => {
    process.env.PASSPORT_REQUIRE_INBOUND = 'TRUE';
    const handlers = requirePassport();
    expect(handlers).toEqual([]);
  });

  // ── T-AC10-6: env 'false' or other → not mounted ──

  it("T-AC10-6: env 'false' → factory returns []", () => {
    process.env.PASSPORT_REQUIRE_INBOUND = 'false';
    expect(requirePassport()).toEqual([]);
  });

  it("T-AC10-6b: env '1' → factory returns [] (only literal 'true' activates)", () => {
    process.env.PASSPORT_REQUIRE_INBOUND = '1';
    expect(requirePassport()).toEqual([]);
  });

  it('T-AC10-6c: env empty string → factory returns []', () => {
    process.env.PASSPORT_REQUIRE_INBOUND = '';
    expect(requirePassport()).toEqual([]);
  });
});
