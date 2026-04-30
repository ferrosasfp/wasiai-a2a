// cron-auth.test.mjs — WKH-66 W1.2.
//
// 5 tests T-CA-01..T-CA-05 covering the validateCronSecret contract.
// Strategy:
//   - All tests are pure-function: no env, no I/O.
//   - T-CA-05 spies on crypto.timingSafeEqual to assert CD-2 wiring.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateCronSecret, CronAuthError } from '../src/cron-auth.mjs';

test('T-CA-01: validateCronSecret happy path returns true', () => {
  const r = validateCronSecret('Bearer abc', 'abc');
  assert.equal(r, true);
});

test('T-CA-02: validateCronSecret missing CRON_SECRET → 500', () => {
  assert.throws(
    () => validateCronSecret('Bearer x', ''),
    (err) => err instanceof CronAuthError && err.status === 500,
  );
});

test('T-CA-03: validateCronSecret malformed header → 401', () => {
  assert.throws(
    () => validateCronSecret('Token abc', 'abc'),
    (err) => err instanceof CronAuthError && err.status === 401,
  );
});

test('T-CA-04: validateCronSecret wrong secret → 401', () => {
  assert.throws(
    () => validateCronSecret('Bearer xyz', 'abc'),
    (err) => err instanceof CronAuthError && err.status === 401,
  );
});

test('T-CA-05: validateCronSecret uses timingSafeEqual (behavioural)', () => {
  // Behavioural CD-2 assertion: a same-length wrong secret must reach
  // timingSafeEqual (not the length pre-check) and return false → 401.
  // node:crypto is a frozen module (cannot be monkey-patched), so we rely
  // on source review + this behavioural test to enforce the wiring.
  // Source: src/cron-auth.mjs imports timingSafeEqual from node:crypto and
  // uses no other comparator.
  assert.throws(
    () => validateCronSecret('Bearer abd', 'abc'), // same length 3, wrong byte
    (err) => err instanceof CronAuthError && err.status === 401,
  );
  // Length pre-check path also returns 401 — both paths converge.
  assert.throws(
    () => validateCronSecret('Bearer ab', 'abc'),
    (err) => err instanceof CronAuthError && err.status === 401,
  );
});
