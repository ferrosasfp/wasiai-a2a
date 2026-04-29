/**
 * Forward-key Middleware Tests — WKH-65
 *
 * Coverage (≥4 tests, CD-5 / AC-8):
 *   - AC-1: env var unset → factory returns [] (middleware NOT mounted).
 *   - AC-3: header value mismatch → 401 INVALID_FORWARD_KEY.
 *   - AC-4: env set + header absent → passthrough (no rejection).
 *   - AC-5: length-safe timingSafeEqual — different lengths do NOT throw,
 *     return 401 cleanly without revealing expected length.
 *   - AC-2 (bonus): env set + matching header → 200 passthrough.
 *   - AC-6 (bonus): x-wasiai-source logged via pino, no routing effect.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireForwardKey } from './forward-key.js';

describe('requireForwardKey middleware', () => {
  const ORIGINAL_ENV = process.env.WASIAI_V2_FORWARD_KEY;

  beforeEach(() => {
    delete process.env.WASIAI_V2_FORWARD_KEY;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.WASIAI_V2_FORWARD_KEY;
    } else {
      process.env.WASIAI_V2_FORWARD_KEY = ORIGINAL_ENV;
    }
  });

  // ── AC-1: env unset → middleware NOT mounted ────────────────

  it('AC-1: WASIAI_V2_FORWARD_KEY unset → factory returns [] (no mount)', () => {
    delete process.env.WASIAI_V2_FORWARD_KEY;
    const handlers = requireForwardKey();
    expect(handlers).toEqual([]);
    expect(handlers.length).toBe(0);
  });

  it('AC-1: WASIAI_V2_FORWARD_KEY empty string → factory returns [] (no mount)', () => {
    process.env.WASIAI_V2_FORWARD_KEY = '';
    const handlers = requireForwardKey();
    expect(handlers).toEqual([]);
    expect(handlers.length).toBe(0);
  });

  // ── AC-3: invalid key → 401 INVALID_FORWARD_KEY ─────────────

  it('AC-3: invalid x-wasiai-forward-key → 401 INVALID_FORWARD_KEY', async () => {
    process.env.WASIAI_V2_FORWARD_KEY = 'expected-secret-value-1234567890';

    const app = Fastify();
    app.post(
      '/test',
      { preHandler: requireForwardKey() },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { 'x-wasiai-forward-key': 'wrong-secret-value-0987654321' },
        payload: {},
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error_code).toBe('INVALID_FORWARD_KEY');
    } finally {
      await app.close();
    }
  });

  // ── AC-4: env set + header absent → passthrough ─────────────

  it('AC-4: env set + x-wasiai-forward-key absent → passthrough (no rejection)', async () => {
    process.env.WASIAI_V2_FORWARD_KEY = 'expected-secret-value';

    const app = Fastify();
    app.post(
      '/test',
      { preHandler: requireForwardKey() },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        // intentionally NO x-wasiai-forward-key header
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  // ── AC-5: length-safe timingSafeEqual — no throw on different lengths ──

  it('AC-5: header shorter than expected → 401 without throw', async () => {
    process.env.WASIAI_V2_FORWARD_KEY = 'a-very-long-expected-secret-value-aaa';

    const app = Fastify();
    app.post(
      '/test',
      { preHandler: requireForwardKey() },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { 'x-wasiai-forward-key': 'short' },
        payload: {},
      });

      // No exception thrown internally; clean 401 returned.
      expect(res.statusCode).toBe(401);
      expect(res.json().error_code).toBe('INVALID_FORWARD_KEY');
    } finally {
      await app.close();
    }
  });

  it('AC-5: header longer than expected → 401 without throw', async () => {
    process.env.WASIAI_V2_FORWARD_KEY = 'short-expected';

    const app = Fastify();
    app.post(
      '/test',
      { preHandler: requireForwardKey() },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: {
          'x-wasiai-forward-key':
            'an-extremely-long-attacker-supplied-value-trying-to-leak-length',
        },
        payload: {},
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error_code).toBe('INVALID_FORWARD_KEY');
    } finally {
      await app.close();
    }
  });

  // ── AC-2 (bonus): valid match → passthrough 200 ──────────────

  it('AC-2: matching x-wasiai-forward-key → 200 passthrough', async () => {
    process.env.WASIAI_V2_FORWARD_KEY = 'matching-secret-value-xyz';

    const app = Fastify();
    app.post(
      '/test',
      { preHandler: requireForwardKey() },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { 'x-wasiai-forward-key': 'matching-secret-value-xyz' },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  // ── AC-6 (bonus): x-wasiai-source logged, no routing effect ──

  it('AC-6: x-wasiai-source logged via pino, no routing effect', async () => {
    process.env.WASIAI_V2_FORWARD_KEY = 'matching-secret-value-xyz';

    const logs: Array<{ forwardSource?: string; msg: string }> = [];
    const app = Fastify({
      logger: {
        level: 'info',
        // capture log output via a custom stream
        stream: {
          write(line: string) {
            try {
              const parsed = JSON.parse(line) as Record<string, unknown>;
              logs.push({
                forwardSource:
                  typeof parsed.forwardSource === 'string'
                    ? parsed.forwardSource
                    : undefined,
                msg: typeof parsed.msg === 'string' ? parsed.msg : '',
              });
            } catch {
              // ignore non-JSON output
            }
          },
        },
      },
    });

    app.post(
      '/test',
      { preHandler: requireForwardKey() },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: {
          'x-wasiai-forward-key': 'matching-secret-value-xyz',
          'x-wasiai-source': 'v2-proxy',
        },
        payload: {},
      });

      expect(res.statusCode).toBe(200);

      // Pino should have emitted at least one info entry with forwardSource.
      const sourceLog = logs.find((l) => l.forwardSource === 'v2-proxy');
      expect(sourceLog).toBeDefined();
    } finally {
      await app.close();
    }
  });

  // ── CD-4 guard: never log the key value ─────────────────────

  it('CD-4: forward key value is NEVER logged on failure', async () => {
    const SECRET = 'super-secret-value-do-not-log';
    const ATTACKER = 'attacker-supplied-bad-value';
    process.env.WASIAI_V2_FORWARD_KEY = SECRET;

    const logs: string[] = [];
    const app = Fastify({
      logger: {
        level: 'info',
        stream: {
          write(line: string) {
            logs.push(line);
          },
        },
      },
    });

    app.post(
      '/test',
      { preHandler: requireForwardKey() },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { 'x-wasiai-forward-key': ATTACKER },
        payload: {},
      });

      expect(res.statusCode).toBe(401);

      const all = logs.join('\n');
      expect(all).not.toContain(SECRET);
      expect(all).not.toContain(ATTACKER);
    } finally {
      await app.close();
    }
  });
});
