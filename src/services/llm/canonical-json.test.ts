/**
 * canonical-json — deterministic JSON serialization (audit 2026-06-24, P2-11)
 *
 * WKH-57 DT-B: canonicalJson ordena keys alfabéticamente (recursivo) → mismo
 * objeto produce siempre el mismo string (estable para hashing/cache keys).
 * schemaHash es el SHA-256 truncado de esa forma canónica.
 */
import { describe, expect, it } from 'vitest';
import { canonicalJson, schemaHash } from './canonical-json.js';

describe('canonicalJson (P2-11)', () => {
  // ── Primitives ───────────────────────────────────────────
  it('serializes primitives like JSON.stringify', () => {
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson('hi')).toBe('"hi"');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(null)).toBe('null');
  });

  it('serializes undefined as the literal null (defensive)', () => {
    expect(canonicalJson(undefined)).toBe('null');
  });

  // ── Determinism: key order does not matter ───────────────
  it('produces identical output regardless of key insertion order', () => {
    const a = canonicalJson({ b: 1, a: 2, c: 3 });
    const b = canonicalJson({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it('sorts keys alphabetically', () => {
    expect(canonicalJson({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
  });

  it('sorts keys recursively in nested objects', () => {
    expect(canonicalJson({ outer: { y: 1, x: 2 }, a: 3 })).toBe(
      '{"a":3,"outer":{"x":2,"y":1}}',
    );
  });

  // ── Arrays preserve order ────────────────────────────────
  it('preserves array element order (arrays are ordered)', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('canonicalizes objects inside arrays', () => {
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  // ── Circular reference guard ─────────────────────────────
  it('throws on a circular reference', () => {
    const obj: Record<string, unknown> = {};
    obj.self = obj;
    expect(() => canonicalJson(obj)).toThrow(/circular reference/);
  });
});

describe('schemaHash (P2-11)', () => {
  it("returns 'no-schema' for undefined", () => {
    expect(schemaHash(undefined)).toBe('no-schema');
  });

  it('returns a 16-char hex slice', () => {
    const h = schemaHash({ type: 'object' });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable across key reordering (same canonical form → same hash)', () => {
    expect(schemaHash({ a: 1, b: 2 })).toBe(schemaHash({ b: 2, a: 1 }));
  });

  it('differs for structurally different schemas', () => {
    expect(schemaHash({ type: 'object' })).not.toBe(
      schemaHash({ type: 'array' }),
    );
  });
});
