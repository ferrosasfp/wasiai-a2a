/**
 * Tests for `src/lib/caller-hash.ts` — HMAC-SHA256 del owner_ref para
 * anti-sybil sin exponer la identidad cruda (WKH-104 TD-SYBIL, CD-5/CD-6/CD-11).
 */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetCallerHashWarn, hashCallerRef } from './caller-hash.js';

const FIXED_SECRET = 'test-secret-A';
const OTHER_SECRET = 'test-secret-B';

describe('hashCallerRef', () => {
  beforeEach(() => {
    process.env.REPUTATION_CALLER_HMAC_SECRET = FIXED_SECRET;
    _resetCallerHashWarn();
  });

  afterEach(() => {
    process.env.REPUTATION_CALLER_HMAC_SECRET = undefined;
    delete process.env.REPUTATION_CALLER_HMAC_SECRET;
    _resetCallerHashWarn();
    vi.restoreAllMocks();
  });

  it('determinismo: mismo ownerRef + mismo secret → mismo hex (AC-9/CD-11)', () => {
    const a = hashCallerRef('owner-A');
    const b = hashCallerRef('owner-A');
    expect(a).toBe(b);
    expect(a).not.toBeNull();
  });

  it('secret distinto → hash distinto (CD-6, prueba HMAC no hash plano)', () => {
    process.env.REPUTATION_CALLER_HMAC_SECRET = FIXED_SECRET;
    const withA = hashCallerRef('owner-A');
    process.env.REPUTATION_CALLER_HMAC_SECRET = OTHER_SECRET;
    const withB = hashCallerRef('owner-A');
    expect(withA).not.toBe(withB);
  });

  it('no-leak: el output no contiene el raw y es hex de 64 chars (AC-10/CD-5)', () => {
    const hash = hashCallerRef('owner-A');
    expect(hash).not.toBeNull();
    expect(hash).not.toContain('owner-A');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('coincide con createHmac directo (HMAC-SHA256 hex)', () => {
    const expected = createHmac('sha256', FIXED_SECRET)
      .update('owner-A')
      .digest('hex');
    expect(hashCallerRef('owner-A')).toBe(expected);
  });

  it('null passthrough: null/undefined/"" → null (AC-12)', () => {
    expect(hashCallerRef(null)).toBeNull();
    expect(hashCallerRef(undefined)).toBeNull();
    expect(hashCallerRef('')).toBeNull();
  });

  it('fallback warn: sin env, console.warn se llama 1 sola vez', () => {
    delete process.env.REPUTATION_CALLER_HMAC_SECRET;
    _resetCallerHashWarn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    hashCallerRef('owner-A');
    hashCallerRef('owner-B');
    hashCallerRef('owner-C');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
