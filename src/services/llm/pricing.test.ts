/**
 * pricing — Anthropic per-model cost computation (audit 2026-06-24, P2-11)
 *
 * WKH-57: computeCostUsd es pure. Verifica el cálculo exacto $/MTok por modelo
 * y la separación input/output. Si alguien renombra una key del pricing table
 * o invierte input/output, estos tests rompen.
 */
import { describe, expect, it } from 'vitest';
import { computeCostUsd, PRICING_USD_PER_M_TOKENS } from './pricing.js';

describe('PRICING_USD_PER_M_TOKENS (P2-11)', () => {
  it('exposes both supported models with input/output rates', () => {
    expect(PRICING_USD_PER_M_TOKENS['claude-haiku-4-5-20251001']).toEqual({
      input: 1.0,
      output: 5.0,
    });
    expect(PRICING_USD_PER_M_TOKENS['claude-sonnet-4-6']).toEqual({
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
    expect(
      computeCostUsd('claude-sonnet-4-6', 1_000_000, 1_000_000),
    ).toBeCloseTo(18.0, 6);
  });

  it('scales linearly with token count (500k in haiku = $0.50)', () => {
    expect(computeCostUsd('claude-haiku-4-5-20251001', 500_000, 0)).toBeCloseTo(
      0.5,
      6,
    );
  });

  it('keeps input and output rates distinct (output is more expensive)', () => {
    const inputOnly = computeCostUsd('claude-sonnet-4-6', 1_000_000, 0);
    const outputOnly = computeCostUsd('claude-sonnet-4-6', 0, 1_000_000);
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
