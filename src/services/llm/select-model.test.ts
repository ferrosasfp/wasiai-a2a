/**
 * selectModel — cost-aware model selector (audit 2026-06-24, P2-11)
 *
 * WKH-57 DT-A: haiku para schemas triviales, sonnet para schemas complejos
 * (>=5 required, nested object, oneOf/anyOf/allOf). Pure, never throws.
 */
import { describe, expect, it } from 'vitest';
import { selectModel } from './select-model.js';

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';

describe('selectModel (P2-11)', () => {
  // ── Trivial → haiku ──────────────────────────────────────
  it('returns haiku for undefined schema', () => {
    expect(selectModel(undefined)).toBe(HAIKU);
  });

  it('returns haiku for an empty object schema', () => {
    expect(selectModel({})).toBe(HAIKU);
  });

  it('returns haiku for a flat schema with < 5 required fields', () => {
    expect(
      selectModel({
        required: ['a', 'b', 'c', 'd'],
        properties: { a: { type: 'string' }, b: { type: 'number' } },
      }),
    ).toBe(HAIKU);
  });

  it('returns haiku for flat scalar properties (no nested object)', () => {
    expect(
      selectModel({
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' },
          active: { type: 'boolean' },
        },
      }),
    ).toBe(HAIKU);
  });

  // ── Complex → sonnet ─────────────────────────────────────
  it('returns sonnet when required has exactly 5 fields (boundary)', () => {
    expect(selectModel({ required: ['a', 'b', 'c', 'd', 'e'] })).toBe(SONNET);
  });

  it('returns sonnet when required has > 5 fields', () => {
    expect(selectModel({ required: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })).toBe(
      SONNET,
    );
  });

  it('returns sonnet when schema has oneOf', () => {
    expect(selectModel({ oneOf: [{ type: 'string' }] })).toBe(SONNET);
  });

  it('returns sonnet when schema has anyOf', () => {
    expect(selectModel({ anyOf: [{ type: 'string' }] })).toBe(SONNET);
  });

  it('returns sonnet when schema has allOf', () => {
    expect(selectModel({ allOf: [{ type: 'object' }] })).toBe(SONNET);
  });

  it('returns sonnet when a property is a nested object', () => {
    expect(
      selectModel({
        properties: {
          name: { type: 'string' },
          address: { type: 'object' },
        },
      }),
    ).toBe(SONNET);
  });

  // ── Defensive: never throws on malformed input ──────────────
  it('does not throw and returns haiku for an array masquerading as schema', () => {
    // Array.isArray short-circuit → haiku.
    expect(() =>
      selectModel(['not', 'a', 'schema'] as unknown as Record<string, unknown>),
    ).not.toThrow();
    expect(selectModel(['x'] as unknown as Record<string, unknown>)).toBe(
      HAIKU,
    );
  });

  it('does not throw when required is not an array (treats as 0 required)', () => {
    expect(selectModel({ required: 'oops' as unknown as string[] })).toBe(
      HAIKU,
    );
  });

  it('does not throw when properties is null', () => {
    expect(
      selectModel({ properties: null as unknown as Record<string, unknown> }),
    ).toBe(HAIKU);
  });

  it('ignores null property values without throwing', () => {
    expect(
      selectModel({
        properties: { weird: null } as unknown as Record<string, unknown>,
      }),
    ).toBe(HAIKU);
  });
});
