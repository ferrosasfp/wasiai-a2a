/**
 * pricing — Anthropic per-model cost computation (audit 2026-06-24, P2-11)
 *
 * WKH-57: computeCostUsd es pure. Verifica el cálculo exacto $/MTok por modelo
 * y la separación input/output. Si alguien renombra una key del pricing table
 * o invierte input/output, estos tests rompen.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// ─── Structured logger mock ─────────────────────────────────
// WKH-135: computeCostUsd loguea via getLogger('pricing') en la rama de modelo
// desconocido. Mock para asertar log.warn sin throw.
const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../../lib/logger.js', () => ({
  getLogger: () => logSpy,
}));

import {
  computeCostUsd,
  PRICING_USD_PER_M_TOKENS,
  type PricedModel,
} from './pricing.js';

afterEach(() => {
  logSpy.warn.mockClear();
  logSpy.error.mockClear();
  logSpy.info.mockClear();
});

describe('PRICING_USD_PER_M_TOKENS (P2-11)', () => {
  it('exposes both supported models with input/output rates', () => {
    expect(PRICING_USD_PER_M_TOKENS['claude-haiku-4-5-20251001']).toEqual({
      input: 1.0,
      output: 5.0,
    });
    expect(PRICING_USD_PER_M_TOKENS['claude-sonnet-5']).toEqual({
      input: 3.0,
      output: 15.0,
    });
  });
});

describe('computeCostUsd (P2-11)', () => {
  it('returns 0 for zero tokens', () => {
    expect(computeCostUsd('claude-haiku-4-5-20251001', 0, 0)).toBe(0);
  });

  it('computes haiku cost: 1M in + 1M out = $1 + $5 = $6', () => {
    expect(
      computeCostUsd('claude-haiku-4-5-20251001', 1_000_000, 1_000_000),
    ).toBeCloseTo(6.0, 6);
  });

  it('computes sonnet cost: 1M in + 1M out = $3 + $15 = $18', () => {
    expect(computeCostUsd('claude-sonnet-5', 1_000_000, 1_000_000)).toBeCloseTo(
      18.0,
      6,
    );
  });

  it('scales linearly with token count (500k in haiku = $0.50)', () => {
    expect(computeCostUsd('claude-haiku-4-5-20251001', 500_000, 0)).toBeCloseTo(
      0.5,
      6,
    );
  });

  it('keeps input and output rates distinct (output is more expensive)', () => {
    const inputOnly = computeCostUsd('claude-sonnet-5', 1_000_000, 0);
    const outputOnly = computeCostUsd('claude-sonnet-5', 0, 1_000_000);
    expect(inputOnly).toBeCloseTo(3.0, 6);
    expect(outputOnly).toBeCloseTo(15.0, 6);
    expect(outputOnly).toBeGreaterThan(inputOnly);
  });

  it('computes a realistic small request (1200 in / 350 out, haiku)', () => {
    const expected = (1200 / 1_000_000) * 1.0 + (350 / 1_000_000) * 5.0;
    expect(computeCostUsd('claude-haiku-4-5-20251001', 1200, 350)).toBeCloseTo(
      expected,
      9,
    );
  });
});

// ─── AC-2 / CD-2 / CD-10: tolerante a modelo desconocido ─────
describe('computeCostUsd — unknown model (WKH-135, AC-2)', () => {
  it('does NOT throw for a model ID outside the table', () => {
    expect(() =>
      computeCostUsd('modelo-inexistente', 1_000_000, 1_000_000),
    ).not.toThrow();
  });

  it('uses DEFAULT_PRICING (Sonnet $3/$15) → $18 @ 1M/1M', () => {
    expect(
      computeCostUsd('modelo-inexistente', 1_000_000, 1_000_000),
    ).toBeCloseTo(18.0, 6);
  });

  it('emits exactly one log.warn carrying the unknown model id', () => {
    computeCostUsd('modelo-inexistente', 1_000_000, 1_000_000);
    expect(logSpy.warn).toHaveBeenCalledTimes(1);
    expect(logSpy.warn).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'modelo-inexistente' }),
      expect.any(String),
    );
  });

  it('does NOT warn for a known model (byte-identical known branch)', () => {
    computeCostUsd('claude-sonnet-5', 1_000_000, 1_000_000);
    expect(logSpy.warn).not.toHaveBeenCalled();
  });

  // CD-10: default nunca sub-reporta — costo default >= costo de cualquier
  // modelo conocido para los mismos tokens.
  it('DEFAULT_PRICING does not under-report vs any known model', () => {
    const tokensIn = 1_000_000;
    const tokensOut = 1_000_000;
    const defaultCost = computeCostUsd('unknown-xyz', tokensIn, tokensOut);
    for (const known of Object.keys(
      PRICING_USD_PER_M_TOKENS,
    ) as PricedModel[]) {
      expect(defaultCost).toBeGreaterThanOrEqual(
        computeCostUsd(known, tokensIn, tokensOut),
      );
    }
  });
});

// ─── AC-6: e2e de tipo — string env-driven fluye sin cast ────
describe('computeCostUsd — string model type flow (WKH-135, AC-6)', () => {
  it('accepts an arbitrary string model (widening PricedModel→string)', () => {
    const model: string = 'claude-sonnet-5';
    expect(computeCostUsd(model, 1_000_000, 0)).toBeCloseTo(3.0, 6);
  });
});
