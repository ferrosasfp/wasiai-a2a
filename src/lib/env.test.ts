/**
 * Env helpers Tests — F-08 (audit 2026-06-29): boot-time required-secret
 * assertion. `assertRequiredEnv` must throw (listing ALL missing vars) when a
 * required secret is absent IN PRODUCTION, and be a no-op outside production.
 */

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertRequiredEnv, parseTrustProxy } from './env.js';

const KEYS = [
  'NODE_ENV',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'OPERATOR_PRIVATE_KEY',
] as const;
const ORIGINAL: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) ORIGINAL[k] = process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
});

describe('assertRequiredEnv — F-08', () => {
  it('is a no-op outside production even when secrets are missing', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
    delete process.env.OPERATOR_PRIVATE_KEY;
    expect(() => assertRequiredEnv()).not.toThrow();
  });

  it('does not throw in production when all required secrets are present', () => {
    process.env.NODE_ENV = 'production';
    process.env.SUPABASE_URL = 'https://x.supabase.co';
    process.env.SUPABASE_SERVICE_KEY = 'service-key';
    process.env.OPERATOR_PRIVATE_KEY = '0xabc';
    expect(() => assertRequiredEnv()).not.toThrow();
  });

  it('throws in production listing ALL missing required secrets', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
    process.env.OPERATOR_PRIVATE_KEY = '0xabc';
    expect(() => assertRequiredEnv()).toThrow(/SUPABASE_URL/);
    expect(() => assertRequiredEnv()).toThrow(/SUPABASE_SERVICE_KEY/);
  });

  it('treats an empty/whitespace value as missing in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.SUPABASE_URL = 'https://x.supabase.co';
    process.env.SUPABASE_SERVICE_KEY = '   ';
    process.env.OPERATOR_PRIVATE_KEY = '0xabc';
    expect(() => assertRequiredEnv()).toThrow(/SUPABASE_SERVICE_KEY/);
  });
});

// H3 (audit 2026-07-01): trustProxy env parsing + Fastify wiring regression.
// Without trustProxy `request.ip` (the default rate-limit key) collapses to the
// TCP peer (Railway edge) for ALL callers → one shared bucket → trivial
// unauthenticated DoS. These pin the parse + that trustProxy ON makes Fastify
// resolve request.ip from X-Forwarded-For (per-client bucket).
describe('parseTrustProxy — H3', () => {
  it('returns false when unset/empty (default, unchanged behavior)', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('   ')).toBe(false);
  });

  it('parses boolean strings (case/space-insensitive)', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('TRUE')).toBe(true);
    expect(parseTrustProxy(' true ')).toBe(true);
    expect(parseTrustProxy('false')).toBe(false);
  });

  it('parses an integer hop count', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
  });

  it('parses a comma-separated subnet/IP list into an array', () => {
    expect(parseTrustProxy('10.0.0.0/8,127.0.0.1')).toEqual([
      '10.0.0.0/8',
      '127.0.0.1',
    ]);
  });

  it('passes a single IP/subnet/keyword through as a string', () => {
    expect(parseTrustProxy('loopback')).toBe('loopback');
    expect(parseTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
  });
});

describe('Fastify trustProxy wiring — H3 regression', () => {
  async function ipFor(
    trustProxy: ReturnType<typeof parseTrustProxy>,
    xff: string,
  ): Promise<string> {
    const app = Fastify({ trustProxy });
    app.get('/ip', async (req) => ({ ip: req.ip }));
    const res = await app.inject({
      method: 'GET',
      url: '/ip',
      headers: { 'x-forwarded-for': xff },
    });
    await app.close();
    return res.json().ip as string;
  }

  it('trustProxy ON → request.ip resolves from X-Forwarded-For (per-client bucket)', async () => {
    const ipA = await ipFor(parseTrustProxy('true'), '203.0.113.7');
    const ipB = await ipFor(parseTrustProxy('true'), '198.51.100.42');
    expect(ipA).toBe('203.0.113.7');
    expect(ipB).toBe('198.51.100.42');
    expect(ipA).not.toBe(ipB);
  });

  it('trustProxy OFF (default) → request.ip does NOT reflect X-Forwarded-For (shared bucket)', async () => {
    const ipA = await ipFor(parseTrustProxy(undefined), '203.0.113.7');
    const ipB = await ipFor(parseTrustProxy(undefined), '198.51.100.42');
    expect(ipA).not.toBe('203.0.113.7');
    expect(ipA).toBe(ipB);
  });
});
