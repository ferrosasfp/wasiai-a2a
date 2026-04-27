/**
 * Tests for WKH-57 LLM Bridge Pro:
 *  - W0 unit tests for helpers (T-Wp1..T-Wp4, T-Ws1..T-Ws6)
 *  - W5 integration tests (T-VER-1..T-VER-8) for AC-1..AC-7
 *
 * Note imports are 3-level relative (`../../../lib/...`) because this file
 * lives in `src/services/llm/__tests__/`.
 */
import { describe, expect, it } from 'vitest';

import {
  canonicalJson,
  schemaHash,
} from '../canonical-json.js';
import {
  PRICING_USD_PER_M_TOKENS,
  computeCostUsd,
  type PricedModel,
} from '../pricing.js';
import { selectModel } from '../select-model.js';

// ──────────────────────────────────────────────────────────────
// W0 unit tests — pricing / canonical-json / select-model
// ──────────────────────────────────────────────────────────────

describe('WKH-57 W0 helpers — pricing', () => {
  it('T-Wp1: PRICING_USD_PER_M_TOKENS exposes Haiku and Sonnet entries with input/output rates', () => {
    const haiku: PricedModel = 'claude-haiku-4-5-20251001';
    const sonnet: PricedModel = 'claude-sonnet-4-6';
    expect(PRICING_USD_PER_M_TOKENS[haiku]).toEqual({ input: 0.8, output: 4.0 });
    expect(PRICING_USD_PER_M_TOKENS[sonnet]).toEqual({ input: 3.0, output: 15.0 });
  });

  it('T-Wp2: computeCostUsd with 1M in + 1M out returns input+output for the model', () => {
    const haikuCost = computeCostUsd(
      'claude-haiku-4-5-20251001',
      1_000_000,
      1_000_000,
    );
    expect(haikuCost).toBeCloseTo(0.8 + 4.0, 10);

    const sonnetCost = computeCostUsd(
      'claude-sonnet-4-6',
      1_000_000,
      1_000_000,
    );
    expect(sonnetCost).toBeCloseTo(3.0 + 15.0, 10);

    // Half-rate sanity check
    const half = computeCostUsd(
      'claude-haiku-4-5-20251001',
      500_000,
      500_000,
    );
    expect(half).toBeCloseTo((0.8 + 4.0) / 2, 10);
  });
});

describe('WKH-57 W0 helpers — canonicalJson / schemaHash', () => {
  it('T-Wp3: canonicalJson is order-independent (deterministic key sort)', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    // recursive
    expect(
      canonicalJson({ outer: { z: 1, a: 2 }, top: 'x' }),
    ).toBe(canonicalJson({ top: 'x', outer: { a: 2, z: 1 } }));
    // primitives + arrays
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]'); // arrays preserve order
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('hi')).toBe('"hi"');
    expect(canonicalJson(undefined)).toBe('null'); // defensive fallback
  });

  it('T-Wp4: schemaHash collapses logically-equal schemas + handles undefined', () => {
    expect(schemaHash({ a: 1, b: 2 })).toBe(schemaHash({ b: 2, a: 1 }));
    expect(schemaHash(undefined)).toBe('no-schema');
    // 16-char hex slice
    const h = schemaHash({ required: ['x'] });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('WKH-57 W0 helpers — selectModel', () => {
  it('T-Ws1: undefined schema -> Haiku', () => {
    expect(selectModel(undefined)).toBe('claude-haiku-4-5-20251001');
  });

  it('T-Ws2: empty schema -> Haiku', () => {
    expect(selectModel({})).toBe('claude-haiku-4-5-20251001');
  });

  it('T-Ws3: schema with required.length === 4 + primitives -> Haiku (AB-WKH-56-1: exact threshold)', () => {
    const schema = {
      required: ['a', 'b', 'c', 'd'],
      properties: {
        a: { type: 'string' },
        b: { type: 'string' },
        c: { type: 'number' },
        d: { type: 'boolean' },
      },
    };
    expect(selectModel(schema)).toBe('claude-haiku-4-5-20251001');
  });

  it('T-Ws4: schema with required.length === 5 -> Sonnet (AB-WKH-56-1: exact threshold)', () => {
    const schema = {
      required: ['a', 'b', 'c', 'd', 'e'],
      properties: {
        a: { type: 'string' },
        b: { type: 'string' },
        c: { type: 'number' },
        d: { type: 'boolean' },
        e: { type: 'string' },
      },
    };
    expect(selectModel(schema)).toBe('claude-sonnet-4-6');
  });

  it('T-Ws5: schema with oneOf|anyOf|allOf -> Sonnet', () => {
    expect(selectModel({ oneOf: [{ type: 'string' }] })).toBe(
      'claude-sonnet-4-6',
    );
    expect(selectModel({ anyOf: [{ type: 'number' }] })).toBe(
      'claude-sonnet-4-6',
    );
    expect(selectModel({ allOf: [{ type: 'object' }] })).toBe(
      'claude-sonnet-4-6',
    );
  });

  it('T-Ws6: schema with property type: object -> Sonnet', () => {
    const schema = {
      required: ['a'],
      properties: {
        a: { type: 'string' },
        nested: { type: 'object', properties: {} },
      },
    };
    expect(selectModel(schema)).toBe('claude-sonnet-4-6');
  });
});
