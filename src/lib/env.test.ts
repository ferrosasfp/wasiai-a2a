/**
 * Env helpers Tests — F-08 (audit 2026-06-29): boot-time required-secret
 * assertion. `assertRequiredEnv` must throw (listing ALL missing vars) when a
 * required secret is absent IN PRODUCTION, and be a no-op outside production.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertRequiredEnv } from './env.js';

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
