// auth.test.mjs — bearer token validation (WKH-65).
//
// Coverage:
//   - missing header → AuthError
//   - malformed header (no "Bearer " prefix) → AuthError
//   - wrong token (same length) → AuthError "unauthorized"
//   - correct token → returns true
//   - empty expected token (config error) → AuthError
//   - length mismatch → AuthError without invoking timingSafeEqual
//
// CD-2: every comparison MUST be timing-safe via node:crypto.timingSafeEqual.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBearerToken, AuthError } from '../src/auth.mjs';

const VALID_TOKEN = 'a'.repeat(64);
const WRONG_TOKEN = 'b'.repeat(64); // same length, different bytes

test('AUTH-01: missing Authorization header throws AuthError', () => {
  assert.throws(
    () => validateBearerToken('', VALID_TOKEN),
    (err) => err instanceof AuthError && /missing or malformed/.test(err.message),
  );
});

test('AUTH-02: undefined-shaped header throws AuthError', () => {
  // Some runtimes return null when the header is absent. The function takes
  // string only; we test that non-string inputs are rejected as malformed.
  for (const bad of [null, undefined, 0, false, {}, []]) {
    assert.throws(
      () => validateBearerToken(bad, VALID_TOKEN),
      (err) => err instanceof AuthError && /missing or malformed/.test(err.message),
      `expected AuthError for ${JSON.stringify(bad)}`,
    );
  }
});

test('AUTH-03: malformed header (no "Bearer " prefix) throws AuthError', () => {
  for (const bad of [
    VALID_TOKEN,                       // raw token, no prefix
    'Basic ' + VALID_TOKEN,            // wrong scheme
    'bearer ' + VALID_TOKEN,           // lowercase scheme (RFC 7235 says case-insensitive,
                                       // but we deliberately enforce exact "Bearer ")
    'Bearer',                          // no space, no token
    'Bearer ',                         // trailing space, empty token
    'Token ' + VALID_TOKEN,            // arbitrary scheme
  ]) {
    assert.throws(
      () => validateBearerToken(bad, VALID_TOKEN),
      (err) => err instanceof AuthError,
      `expected AuthError for ${JSON.stringify(bad)}`,
    );
  }
});

test('AUTH-04: wrong token (same length) throws AuthError "unauthorized"', () => {
  assert.throws(
    () => validateBearerToken(`Bearer ${WRONG_TOKEN}`, VALID_TOKEN),
    (err) => err instanceof AuthError && err.message === 'unauthorized',
  );
});

test('AUTH-05: correct token returns true', () => {
  const r = validateBearerToken(`Bearer ${VALID_TOKEN}`, VALID_TOKEN);
  assert.equal(r, true);
});

test('AUTH-06: empty expected token throws (server misconfigured)', () => {
  for (const bad of ['', null, undefined, 0]) {
    assert.throws(
      () => validateBearerToken(`Bearer ${VALID_TOKEN}`, bad),
      (err) => err instanceof AuthError && /server misconfigured/.test(err.message),
      `expected AuthError for expected=${JSON.stringify(bad)}`,
    );
  }
});

test('AUTH-07: length mismatch throws AuthError without RangeError leak', () => {
  // If we naively passed two buffers of different lengths to timingSafeEqual,
  // it would throw RangeError. We pre-check lengths and surface AuthError
  // instead, so the failure mode for a short/long token is the same as
  // for a wrong token of equal length (no info leak).
  const shortPresented = 'Bearer ' + 'a'.repeat(10);
  const longPresented = 'Bearer ' + 'a'.repeat(128);
  assert.throws(
    () => validateBearerToken(shortPresented, VALID_TOKEN),
    (err) => err instanceof AuthError && err.message === 'unauthorized',
  );
  assert.throws(
    () => validateBearerToken(longPresented, VALID_TOKEN),
    (err) => err instanceof AuthError && err.message === 'unauthorized',
  );
});

test('AUTH-08: presented token containing the expected as substring still rejected', () => {
  // Defense: substring/indexOf-based comparators would accept this. The
  // timing-safe byte compare must reject because lengths differ.
  const inner = VALID_TOKEN;
  const presented = `Bearer extra-${inner}-extra`;
  assert.throws(
    () => validateBearerToken(presented, VALID_TOKEN),
    (err) => err instanceof AuthError && err.message === 'unauthorized',
  );
});

test('AUTH-09: AuthError has name "AuthError" and is instanceof Error', () => {
  try {
    validateBearerToken('', VALID_TOKEN);
    assert.fail('expected throw');
  } catch (e) {
    assert.equal(e.name, 'AuthError');
    assert.ok(e instanceof Error);
    assert.ok(e instanceof AuthError);
  }
});
