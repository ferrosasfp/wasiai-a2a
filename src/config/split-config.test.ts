/**
 * Tests for Split Config — WKH-136
 *
 * T-WRITE (CD-7, AC-2): `getSplitConfig` valida cada bps en el write-boundary
 * (entero en [0, 10000]) y la suma exacta == 10000, fail-CLOSED
 * (`SplitConfigError`). Sin cache (re-lee env por call).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSplitConfig, SplitConfigError } from './split-config.js';

describe('getSplitConfig', () => {
  const KEYS = [
    'SPLIT_BPS_PLATFORM',
    'SPLIT_BPS_CREATOR',
    'SPLIT_BPS_REFERRAL',
  ] as const;
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      original[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  // Default: unset → 10000/0/0 (byte-idéntico a WKH-44/132).
  it('returns default 10000/0/0 when env is unset', () => {
    expect(getSplitConfig()).toEqual({
      platformBps: 10000,
      creatorBps: 0,
      referralBps: 0,
    });
  });

  // Empty string → default (no error).
  it('treats empty string as default (no error)', () => {
    process.env.SPLIT_BPS_PLATFORM = '';
    process.env.SPLIT_BPS_CREATOR = '';
    process.env.SPLIT_BPS_REFERRAL = '';
    expect(getSplitConfig()).toEqual({
      platformBps: 10000,
      creatorBps: 0,
      referralBps: 0,
    });
  });

  // Valid split.
  it('parses a valid split 8000/1500/500', () => {
    process.env.SPLIT_BPS_PLATFORM = '8000';
    process.env.SPLIT_BPS_CREATOR = '1500';
    process.env.SPLIT_BPS_REFERRAL = '500';
    expect(getSplitConfig()).toEqual({
      platformBps: 8000,
      creatorBps: 1500,
      referralBps: 500,
    });
  });

  // T-WRITE: negative → SplitConfigError.
  it('T-WRITE: rejects a negative bps', () => {
    process.env.SPLIT_BPS_PLATFORM = '10100';
    process.env.SPLIT_BPS_CREATOR = '-100';
    process.env.SPLIT_BPS_REFERRAL = '0';
    expect(() => getSplitConfig()).toThrow(SplitConfigError);
  });

  // T-WRITE: NaN / non-numeric → SplitConfigError.
  it('T-WRITE: rejects a non-numeric bps (NaN)', () => {
    process.env.SPLIT_BPS_PLATFORM = 'abc';
    process.env.SPLIT_BPS_CREATOR = '0';
    process.env.SPLIT_BPS_REFERRAL = '0';
    expect(() => getSplitConfig()).toThrow(SplitConfigError);
  });

  // T-WRITE: > 10000 → SplitConfigError.
  it('T-WRITE: rejects a bps > 10000', () => {
    process.env.SPLIT_BPS_PLATFORM = '10001';
    process.env.SPLIT_BPS_CREATOR = '0';
    process.env.SPLIT_BPS_REFERRAL = '0';
    expect(() => getSplitConfig()).toThrow(SplitConfigError);
  });

  // T-WRITE: non-integer (12.5) → SplitConfigError (CD-7 entero).
  it('T-WRITE: rejects a non-integer bps ("12.5")', () => {
    process.env.SPLIT_BPS_PLATFORM = '9987.5';
    process.env.SPLIT_BPS_CREATOR = '12.5';
    process.env.SPLIT_BPS_REFERRAL = '0';
    expect(() => getSplitConfig()).toThrow(SplitConfigError);
  });

  // T-WRITE / AC-2: Σ ≠ 10000 → SplitConfigError (fail-CLOSED).
  it('T-WRITE: rejects when sum ≠ 10000 (5000/3000/1000 = 9000)', () => {
    process.env.SPLIT_BPS_PLATFORM = '5000';
    process.env.SPLIT_BPS_CREATOR = '3000';
    process.env.SPLIT_BPS_REFERRAL = '1000';
    expect(() => getSplitConfig()).toThrow(SplitConfigError);
  });

  // SplitConfigError carries HTTP 400.
  it('SplitConfigError has statusCode 400', () => {
    process.env.SPLIT_BPS_PLATFORM = '5000';
    process.env.SPLIT_BPS_CREATOR = '3000';
    process.env.SPLIT_BPS_REFERRAL = '1000';
    try {
      getSplitConfig();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SplitConfigError);
      expect((err as SplitConfigError).statusCode).toBe(400);
    }
  });

  // No cache: re-reads env every call.
  it('re-reads env on every call (no cache)', () => {
    process.env.SPLIT_BPS_PLATFORM = '10000';
    expect(getSplitConfig().platformBps).toBe(10000);

    process.env.SPLIT_BPS_PLATFORM = '8000';
    process.env.SPLIT_BPS_CREATOR = '2000';
    expect(getSplitConfig()).toEqual({
      platformBps: 8000,
      creatorBps: 2000,
      referralBps: 0,
    });
  });
});
