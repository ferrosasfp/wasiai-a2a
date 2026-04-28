/**
 * Tests for src/lib/price.ts (WKH-59 / SEC-DRAIN-1).
 *
 * Cobertura:
 *   T-PRICE-1..T-PRICE-5  → getPyusdUsdRate (env handling)
 *   T-PRICE-6..T-PRICE-8  → pyusdWeiToUsd (conversion + overflow)
 *   T-PRICE-9..T-PRICE-10 → getGaslessDefaultCapUsd
 *
 * AB-WKH-57: usar `vi.spyOn(console, 'warn').mockImplementation(() => {})`
 * para verificar warnings sin contaminar stderr global. NO usar `vi.mock`
 * sobre console.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getGaslessDefaultCapUsd,
  getPyusdUsdRate,
  pyusdWeiToUsd,
} from './price.js';

// ── getPyusdUsdRate ──────────────────────────────────────────

describe('getPyusdUsdRate', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.PYUSD_USD_RATE;
    delete process.env.PYUSD_USD_RATE;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PYUSD_USD_RATE;
    else process.env.PYUSD_USD_RATE = originalEnv;
  });

  it('T-PRICE-1: env unset → returns 1.0 silently', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getPyusdUsdRate()).toBe(1.0);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('T-PRICE-2: env empty string → returns 1.0 silently', () => {
    process.env.PYUSD_USD_RATE = '';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getPyusdUsdRate()).toBe(1.0);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('T-PRICE-3: env "abc" (non-numeric) → fallback 1.0 + warns', () => {
    process.env.PYUSD_USD_RATE = 'abc';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getPyusdUsdRate()).toBe(1.0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('PYUSD_USD_RATE="abc"');
    warnSpy.mockRestore();
  });

  it('T-PRICE-4: env "200" (out of range) → fallback 1.0 + warns', () => {
    process.env.PYUSD_USD_RATE = '200';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getPyusdUsdRate()).toBe(1.0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('T-PRICE-5: env "0.95" (depeg) → returns 0.95', () => {
    process.env.PYUSD_USD_RATE = '0.95';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getPyusdUsdRate()).toBeCloseTo(0.95, 10);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ── pyusdWeiToUsd ────────────────────────────────────────────

describe('pyusdWeiToUsd', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.PYUSD_USD_RATE;
    delete process.env.PYUSD_USD_RATE;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PYUSD_USD_RATE;
    else process.env.PYUSD_USD_RATE = originalEnv;
  });

  it('T-PRICE-6: 5_000_000n wei (5 PYUSD) at rate 1.0 → 5 USD', () => {
    expect(pyusdWeiToUsd(5_000_000n)).toBeCloseTo(5, 10);
  });

  it('T-PRICE-7: 0n wei → 0 USD', () => {
    expect(pyusdWeiToUsd(0n)).toBe(0);
  });

  it('T-PRICE-8: 2n ** 60n (excede safe integer) → returns Infinity (no throws)', () => {
    const huge = 2n ** 60n;
    expect(huge > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(pyusdWeiToUsd(huge)).toBe(Number.POSITIVE_INFINITY);
  });

  it('T-PRICE-8b: bigint negativo → 0 (defensa)', () => {
    expect(pyusdWeiToUsd(-1n)).toBe(0);
  });

  it('T-PRICE-8c: rate aplicado — 5_000_000n wei a rate 0.95 → 4.75 USD', () => {
    process.env.PYUSD_USD_RATE = '0.95';
    expect(pyusdWeiToUsd(5_000_000n)).toBeCloseTo(4.75, 10);
  });
});

// ── getGaslessDefaultCapUsd ──────────────────────────────────

describe('getGaslessDefaultCapUsd', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.GASLESS_DEFAULT_CAP_USD;
    delete process.env.GASLESS_DEFAULT_CAP_USD;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.GASLESS_DEFAULT_CAP_USD;
    else process.env.GASLESS_DEFAULT_CAP_USD = originalEnv;
  });

  it('T-PRICE-9: env unset → returns 10 silently', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getGaslessDefaultCapUsd()).toBe(10);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('T-PRICE-9b: env "25" → returns 25', () => {
    process.env.GASLESS_DEFAULT_CAP_USD = '25';
    expect(getGaslessDefaultCapUsd()).toBe(25);
  });

  it('T-PRICE-10: env "0" (≤ lower bound) → fallback 10 + warns', () => {
    process.env.GASLESS_DEFAULT_CAP_USD = '0';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getGaslessDefaultCapUsd()).toBe(10);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('GASLESS_DEFAULT_CAP_USD="0"');
    warnSpy.mockRestore();
  });

  it('T-PRICE-10b: env "20000" (> upper bound) → fallback 10 + warns', () => {
    process.env.GASLESS_DEFAULT_CAP_USD = '20000';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getGaslessDefaultCapUsd()).toBe(10);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
