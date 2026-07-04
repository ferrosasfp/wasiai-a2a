/**
 * Tests for src/lib/price.ts (WKH-59 / SEC-DRAIN-1).
 *
 * Cobertura:
 *   T-PRICE-1..T-PRICE-5  → getPyusdUsdRate (env handling)
 *   T-PRICE-6..T-PRICE-8  → pyusdWeiToUsd (conversion + overflow)
 *   T-PRICE-9..T-PRICE-10 → getGaslessDefaultCapUsd
 *
 * price.ts emite los warnings de fallback vía getLogger('price'). El logger se
 * mockea (object-first / message-second) para verificar las advertencias sin
 * contaminar stderr global.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Structured logger mock ─────────────────────────────────
// hoisted so the factory can reference it before the price.js import resolves.
const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('./logger.js', () => ({
  getLogger: () => logSpy,
}));

import {
  estimateGaslessValueUsd,
  getGaslessDefaultCapUsd,
  getPyusdUsdRate,
  getUsdcUsdRate,
  pyusdWeiToUsd,
  USDC_GASLESS_DECIMALS,
  usdcWeiToUsd,
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
    const warnSpy = logSpy.warn;
    warnSpy.mockClear();
    expect(getPyusdUsdRate()).toBe(1.0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('T-PRICE-2: env empty string → returns 1.0 silently', () => {
    process.env.PYUSD_USD_RATE = '';
    const warnSpy = logSpy.warn;
    warnSpy.mockClear();
    expect(getPyusdUsdRate()).toBe(1.0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('T-PRICE-3: env "abc" (non-numeric) → fallback 1.0 + warns', () => {
    process.env.PYUSD_USD_RATE = 'abc';
    const warnSpy = logSpy.warn;
    warnSpy.mockClear();
    expect(getPyusdUsdRate()).toBe(1.0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // object-first / message-second: the raw value lives in the structured ctx.
    expect(warnSpy.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ raw: 'abc' }),
    );
    expect(String(warnSpy.mock.calls[0]![1])).toContain('PYUSD_USD_RATE');
  });

  it('T-PRICE-4: env "200" (out of range) → fallback 1.0 + warns', () => {
    process.env.PYUSD_USD_RATE = '200';
    const warnSpy = logSpy.warn;
    warnSpy.mockClear();
    expect(getPyusdUsdRate()).toBe(1.0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('T-PRICE-5: env "0.95" (depeg) → returns 0.95', () => {
    process.env.PYUSD_USD_RATE = '0.95';
    const warnSpy = logSpy.warn;
    warnSpy.mockClear();
    expect(getPyusdUsdRate()).toBeCloseTo(0.95, 10);
    expect(warnSpy).not.toHaveBeenCalled();
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
    const warnSpy = logSpy.warn;
    warnSpy.mockClear();
    expect(getGaslessDefaultCapUsd()).toBe(10);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('T-PRICE-9b: env "25" → returns 25', () => {
    process.env.GASLESS_DEFAULT_CAP_USD = '25';
    expect(getGaslessDefaultCapUsd()).toBe(25);
  });

  it('T-PRICE-10: env "0" (≤ lower bound) → fallback 10 + warns', () => {
    process.env.GASLESS_DEFAULT_CAP_USD = '0';
    const warnSpy = logSpy.warn;
    warnSpy.mockClear();
    expect(getGaslessDefaultCapUsd()).toBe(10);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // object-first / message-second: the raw value lives in the structured ctx.
    expect(warnSpy.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ raw: '0' }),
    );
    expect(String(warnSpy.mock.calls[0]![1])).toContain(
      'GASLESS_DEFAULT_CAP_USD',
    );
  });

  it('T-PRICE-10b: env "20000" (> upper bound) → fallback 10 + warns', () => {
    process.env.GASLESS_DEFAULT_CAP_USD = '20000';
    const warnSpy = logSpy.warn;
    warnSpy.mockClear();
    expect(getGaslessDefaultCapUsd()).toBe(10);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// WKH-138 — USDC gasless pricing (chain-aware, fail-closed drain guard)
// ══════════════════════════════════════════════════════════════════════════

// ── getUsdcUsdRate (CD-10: independiente de PYUSD_USD_RATE) ──────────────────

describe('getUsdcUsdRate (WKH-138)', () => {
  let originalUsdc: string | undefined;
  let originalPyusd: string | undefined;

  beforeEach(() => {
    originalUsdc = process.env.USDC_USD_RATE;
    originalPyusd = process.env.PYUSD_USD_RATE;
    delete process.env.USDC_USD_RATE;
    delete process.env.PYUSD_USD_RATE;
  });

  afterEach(() => {
    if (originalUsdc === undefined) delete process.env.USDC_USD_RATE;
    else process.env.USDC_USD_RATE = originalUsdc;
    if (originalPyusd === undefined) delete process.env.PYUSD_USD_RATE;
    else process.env.PYUSD_USD_RATE = originalPyusd;
  });

  it('T-RATE-GUARD: env unset → 1.0 silently', () => {
    const warnSpy = logSpy.warn;
    warnSpy.mockClear();
    expect(getUsdcUsdRate()).toBe(1.0);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('T-RATE-GUARD: env "200" (out of range) → fallback 1.0 + warns', () => {
    process.env.USDC_USD_RATE = '200';
    const warnSpy = logSpy.warn;
    warnSpy.mockClear();
    expect(getUsdcUsdRate()).toBe(1.0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]![1])).toContain('USDC_USD_RATE');
  });

  it('T-RATE-GUARD: env "abc" (NaN) → fallback 1.0 + warns', () => {
    process.env.USDC_USD_RATE = 'abc';
    const warnSpy = logSpy.warn;
    warnSpy.mockClear();
    expect(getUsdcUsdRate()).toBe(1.0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('T-RATE-GUARD: env "0.99" (depeg) → returns 0.99', () => {
    process.env.USDC_USD_RATE = '0.99';
    expect(getUsdcUsdRate()).toBeCloseTo(0.99, 10);
  });

  it('CD-10: USDC rate is NOT coupled to PYUSD_USD_RATE', () => {
    process.env.PYUSD_USD_RATE = '0.5';
    delete process.env.USDC_USD_RATE;
    // PYUSD depegged to 0.5 must NOT move the USDC rate.
    expect(getUsdcUsdRate()).toBe(1.0);
    expect(getPyusdUsdRate()).toBeCloseTo(0.5, 10);
  });
});

// ── usdcWeiToUsd (6 dec + fail-closed) ──────────────────────────────────────

describe('usdcWeiToUsd (WKH-138)', () => {
  let originalUsdc: string | undefined;

  beforeEach(() => {
    originalUsdc = process.env.USDC_USD_RATE;
    delete process.env.USDC_USD_RATE;
  });

  afterEach(() => {
    if (originalUsdc === undefined) delete process.env.USDC_USD_RATE;
    else process.env.USDC_USD_RATE = originalUsdc;
  });

  it('T-USDC-6DEC: 5_000_000n wei (5 USDC) at rate 1.0 → 5 USD', () => {
    expect(usdcWeiToUsd(5_000_000n, USDC_GASLESS_DECIMALS)).toBeCloseTo(5, 10);
  });

  it('T-USDC-6DEC: differs from an 18-dec (PYUSD-scale) interpretation', () => {
    // Same wei, 6 decimals → 5 USD, but if (wrongly) read as 18 dec → ~5e-12.
    const at6 = usdcWeiToUsd(5_000_000n, 6);
    const at18 = usdcWeiToUsd(5_000_000n, 18);
    expect(at6).toBeCloseTo(5, 10);
    expect(at18).toBeLessThan(1e-6);
    expect(at6).not.toBeCloseTo(at18, 10);
  });

  it('T-USDC-6DEC: rate applied — 5_000_000n at rate 0.99 → 4.95 USD', () => {
    process.env.USDC_USD_RATE = '0.99';
    expect(usdcWeiToUsd(5_000_000n, 6)).toBeCloseTo(4.95, 10);
  });

  it('T-DEC-INVALID: non-integer decimals → +Infinity (AC-5)', () => {
    expect(usdcWeiToUsd(5_000_000n, 6.5)).toBe(Number.POSITIVE_INFINITY);
  });

  it('T-DEC-INVALID: negative decimals → +Infinity (AC-5)', () => {
    expect(usdcWeiToUsd(5_000_000n, -1)).toBe(Number.POSITIVE_INFINITY);
  });

  it('T-DEC-INVALID: decimals > 36 → +Infinity (AC-5)', () => {
    expect(usdcWeiToUsd(5_000_000n, 37)).toBe(Number.POSITIVE_INFINITY);
  });

  it('T-DEC-INVALID: NaN decimals → +Infinity (AC-5)', () => {
    expect(usdcWeiToUsd(5_000_000n, Number.NaN)).toBe(Number.POSITIVE_INFINITY);
  });

  it('T-DRAIN-CAP: value > MAX_SAFE_INTEGER → +Infinity (AC-5)', () => {
    const huge = 2n ** 60n;
    expect(huge > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(usdcWeiToUsd(huge, 6)).toBe(Number.POSITIVE_INFINITY);
  });

  it('negative wei → 0 (defensa)', () => {
    expect(usdcWeiToUsd(-1n, 6)).toBe(0);
  });

  it('0n wei → 0 USD', () => {
    expect(usdcWeiToUsd(0n, 6)).toBe(0);
  });
});

// ── estimateGaslessValueUsd (dispatcher chain-aware) ────────────────────────

describe('estimateGaslessValueUsd (WKH-138)', () => {
  let originalUsdc: string | undefined;
  let originalPyusd: string | undefined;

  beforeEach(() => {
    originalUsdc = process.env.USDC_USD_RATE;
    originalPyusd = process.env.PYUSD_USD_RATE;
    delete process.env.USDC_USD_RATE;
    delete process.env.PYUSD_USD_RATE;
  });

  afterEach(() => {
    if (originalUsdc === undefined) delete process.env.USDC_USD_RATE;
    else process.env.USDC_USD_RATE = originalUsdc;
    if (originalPyusd === undefined) delete process.env.PYUSD_USD_RATE;
    else process.env.PYUSD_USD_RATE = originalPyusd;
  });

  it('T-DISPATCH: avalanche-fuji → USDC 6-dec conversion', () => {
    expect(estimateGaslessValueUsd('avalanche-fuji', 5_000_000n)).toBeCloseTo(
      5,
      10,
    );
  });

  it('T-DISPATCH: avalanche-mainnet → USDC 6-dec conversion', () => {
    expect(
      estimateGaslessValueUsd('avalanche-mainnet', 5_000_000n),
    ).toBeCloseTo(5, 10);
  });

  it('T-DISPATCH: base-sepolia → USDC 6-dec conversion', () => {
    expect(estimateGaslessValueUsd('base-sepolia', 5_000_000n)).toBeCloseTo(
      5,
      10,
    );
  });

  it('T-DISPATCH: base-mainnet → USDC 6-dec conversion', () => {
    expect(estimateGaslessValueUsd('base-mainnet', 5_000_000n)).toBeCloseTo(
      5,
      10,
    );
  });

  it('T-DISPATCH: kite-ozone-testnet → pyusd conversion', () => {
    expect(estimateGaslessValueUsd('kite-ozone-testnet', 5_000_000n)).toBe(
      pyusdWeiToUsd(5_000_000n),
    );
  });

  it('T-DISPATCH: kite-mainnet → pyusd conversion', () => {
    expect(estimateGaslessValueUsd('kite-mainnet', 5_000_000n)).toBe(
      pyusdWeiToUsd(5_000_000n),
    );
  });

  it('T-DRAIN-CAP: unknown chain → +Infinity (AC-5 fail-closed)', () => {
    // Cast simulates a slug outside the ChainKey union reaching the dispatcher.
    expect(estimateGaslessValueUsd('solana-mainnet' as never, 5_000_000n)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it('T-REGR-PRICE: kite chainKey is byte-identical to pyusdWeiToUsd (CD-4)', () => {
    process.env.PYUSD_USD_RATE = '0.95';
    for (const wei of [0n, 1n, 5_000_000n, 10_000_000n, 999_999n]) {
      expect(estimateGaslessValueUsd('kite-ozone-testnet', wei)).toBe(
        pyusdWeiToUsd(wei),
      );
    }
  });

  it('T-DEC (consistencia): avalanche/base use the SAME decimals constant', () => {
    // The dispatcher passes USDC_GASLESS_DECIMALS (=6) — the same value the
    // adapters use for the on-chain token (CD-2).
    expect(USDC_GASLESS_DECIMALS).toBe(6);
    expect(estimateGaslessValueUsd('avalanche-fuji', 1_000_000n)).toBe(
      usdcWeiToUsd(1_000_000n, USDC_GASLESS_DECIMALS),
    );
  });
});
