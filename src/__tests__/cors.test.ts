/**
 * CORS Env-Aware Tests — WKH-SEC-01
 * Tests: AC-4 (production with allowlist), AC-5 (development wildcard),
 *        AC-6 (production fail-secure when CORS_ALLOWED_ORIGINS unset)
 *
 * Each test replicates the env-aware logic from `src/index.ts` and asserts
 * the actual behavior of `@fastify/cors` (CD-3: no hardcoded origins, CD-7:
 * logic stays inline, CD-8: no callback `origin: (origin, cb) => ...`, CD-9:
 * warn via `fastify.log.warn`).
 */

import cors, { type FastifyCorsOptions } from '@fastify/cors';
import Fastify from 'fastify';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';

describe('CORS env-aware configuration (WKH-SEC-01)', () => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevOrigins = process.env.CORS_ALLOWED_ORIGINS;

  beforeEach(() => {
    // Start each test with a clean slate.
    delete process.env.NODE_ENV;
    delete process.env.CORS_ALLOWED_ORIGINS;
  });

  afterEach(() => {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevOrigins === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = prevOrigins;
  });

  // Mirror of the logic in `src/index.ts` (CD-7: duplication is intentional).
  function computeCorsOptions(warn: (msg: string) => void): FastifyCorsOptions {
    const isProduction = process.env.NODE_ENV === 'production';
    const originsEnv = process.env.CORS_ALLOWED_ORIGINS;

    if (!isProduction) {
      return { origin: '*' };
    }
    const origins = (originsEnv ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (origins.length > 0) {
      return { origin: origins };
    }
    warn(
      'CORS_ALLOWED_ORIGINS not set in production — blocking all cross-origin requests',
    );
    return { origin: false };
  }

  async function buildApp(): Promise<{
    app: ReturnType<typeof Fastify>;
    warnSpy: MockInstance;
  }> {
    const app = Fastify();
    const warnSpy = vi.spyOn(app.log, 'warn');
    const corsOptions = computeCorsOptions((msg) => app.log.warn(msg));
    await app.register(cors, corsOptions);
    app.get('/health', async () => ({ status: 'ok' }));
    await app.ready();
    return { app, warnSpy };
  }

  it('AC-4: in production with CORS_ALLOWED_ORIGINS set, disallowed origin is rejected', async () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ALLOWED_ORIGINS = 'https://app.wasiai.io';

    const { app } = await buildApp();

    // Disallowed origin
    const badRes = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.com' },
    });
    expect(badRes.headers['access-control-allow-origin']).not.toBe('*');
    expect(badRes.headers['access-control-allow-origin']).not.toBe(
      'https://evil.com',
    );

    // Allowed origin passes through with echo
    const goodRes = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://app.wasiai.io' },
    });
    expect(goodRes.headers['access-control-allow-origin']).toBe(
      'https://app.wasiai.io',
    );

    await app.close();
  });

  it('AC-5: in development, all origins are allowed (wildcard)', async () => {
    // NODE_ENV unset ⇒ treated as non-production
    process.env.NODE_ENV = 'development';

    const { app } = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://anything.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('*');

    await app.close();
  });

  it('AC-6: in production without CORS_ALLOWED_ORIGINS, all cross-origin is blocked and warn is logged', async () => {
    process.env.NODE_ENV = 'production';
    // CORS_ALLOWED_ORIGINS intentionally unset

    const { app, warnSpy } = await buildApp();

    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();

    // fastify.log.warn called with a message mentioning the env var
    const warnCalls = warnSpy.mock.calls.map((args) => String(args[0]));
    expect(warnCalls.some((msg) => msg.includes('CORS_ALLOWED_ORIGINS'))).toBe(
      true,
    );

    await app.close();
  });
});
