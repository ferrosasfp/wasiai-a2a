/**
 * Unit tests for transform-hmac — WKH-60 / SEC-RCE-1 W1
 *
 * 8 tests:
 *  - T-HM-1 sign produces a 64-char lowercase hex digest
 *  - T-HM-2 sign is deterministic for (fn, key)
 *  - T-HM-3 sign differs across keys (same fn)
 *  - T-HM-4 sign differs across fns (same key)
 *  - T-HM-5 verify returns true on a real signature
 *  - T-HM-6 verify returns false on a tampered fn (single byte flipped)
 *  - T-HM-7 verify returns false on malformed signature (wrong length / hex)
 *  - T-HM-8 sign throws on empty/invalid hmacKey; verify returns false (no throw)
 */
import { describe, expect, it } from 'vitest';
import { signTransformFn, verifyTransformFn } from './transform-hmac.js';

const KEY = 'super-secret-32-byte-test-key-aaaaaaaaaa';
const FN = 'return { query: output.text };';

describe('transform-hmac — signTransformFn', () => {
  // T-HM-1
  it('T-HM-1: produces a 64-char lowercase hex digest', () => {
    const sig = signTransformFn(FN, KEY);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  // T-HM-2
  it('T-HM-2: is deterministic for the same (fn, key)', () => {
    const a = signTransformFn(FN, KEY);
    const b = signTransformFn(FN, KEY);
    expect(a).toBe(b);
  });

  // T-HM-3
  it('T-HM-3: produces different digests across keys (same fn)', () => {
    const sig1 = signTransformFn(FN, KEY);
    const sig2 = signTransformFn(FN, `${KEY}-rotated`);
    expect(sig1).not.toBe(sig2);
  });

  // T-HM-4
  it('T-HM-4: produces different digests across fns (same key)', () => {
    const sig1 = signTransformFn(FN, KEY);
    const sig2 = signTransformFn(`${FN};/* tampered */`, KEY);
    expect(sig1).not.toBe(sig2);
  });
});

describe('transform-hmac — verifyTransformFn', () => {
  // T-HM-5
  it('T-HM-5: returns true on a freshly signed transformFn', () => {
    const sig = signTransformFn(FN, KEY);
    expect(verifyTransformFn(FN, sig, KEY)).toBe(true);
  });

  // T-HM-6
  it('T-HM-6: returns false when the transformFn was tampered (single byte)', () => {
    const sig = signTransformFn(FN, KEY);
    const tampered = FN.replace('output.text', 'output.text /* BAD */');
    expect(verifyTransformFn(tampered, sig, KEY)).toBe(false);
  });

  // T-HM-7
  it('T-HM-7: returns false on malformed signatures (length / chars)', () => {
    const sig = signTransformFn(FN, KEY);
    expect(verifyTransformFn(FN, '', KEY)).toBe(false);
    expect(verifyTransformFn(FN, sig.slice(0, 32), KEY)).toBe(false);
    expect(verifyTransformFn(FN, sig.toUpperCase(), KEY)).toBe(false); // not lowercase
    expect(verifyTransformFn(FN, `${sig.slice(0, 63)}z`, KEY)).toBe(false);
  });

  // T-HM-8
  it('T-HM-8: sign throws on invalid keys; verify returns false (does not throw)', () => {
    expect(() => signTransformFn(FN, '')).toThrow();
    expect(() => signTransformFn(FN, null as unknown as string)).toThrow();
    // verify must NOT throw on bad inputs — return false so callers treat
    // it as cache miss.
    expect(verifyTransformFn(FN, 'sig', '')).toBe(false);
    expect(verifyTransformFn(null as unknown as string, 'sig', KEY)).toBe(
      false,
    );
    expect(verifyTransformFn(FN, null as unknown as string, KEY)).toBe(false);
  });
});
