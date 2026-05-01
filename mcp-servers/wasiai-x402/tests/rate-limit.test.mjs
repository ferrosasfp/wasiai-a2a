// rate-limit.test.mjs — WKH-66 W2.4.
//
// 6 tests T-RL-01..T-RL-06 covering AC-W5-4 (a..f).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { checkRateLimit, hashBearer } from '../src/rate-limit.mjs';
import { createKvMock } from './_mocks/kv-mock.mjs';

let kv;
beforeEach(() => {
  kv = createKvMock();
});

test('T-RL-01: primer request OK + INCR returns 1', async () => {
  const h = hashBearer('bearer-A');
  const r = await checkRateLimit({ bearerHash16: h, kvClient: kv, perMin: 5, windowSec: 60 });
  assert.equal(r.ok, true);
  // Internal: counter is exactly 1 after first call.
  const v = await kv.get(`rl:${h}`);
  assert.equal(Number(v), 1);
});

test('T-RL-02: request 6 dentro de ventana → 429 with retryAfter > 0', async () => {
  const h = hashBearer('bearer-A');
  for (let i = 0; i < 5; i++) {
    const r = await checkRateLimit({ bearerHash16: h, kvClient: kv, perMin: 5, windowSec: 60 });
    assert.equal(r.ok, true, `call ${i + 1}/5 should be ok`);
  }
  const r6 = await checkRateLimit({ bearerHash16: h, kvClient: kv, perMin: 5, windowSec: 60 });
  assert.equal(r6.ok, false);
  assert.ok(r6.retryAfter > 0, `retryAfter should be > 0, got ${r6.retryAfter}`);
});

test('T-RL-03: bearer hash es sha256 trunc16 (no plano)', async () => {
  const plain = 'super-secret-bearer-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const h = hashBearer(plain);
  await checkRateLimit({ bearerHash16: h, kvClient: kv, perMin: 5, windowSec: 60 });
  // KV inspector: keys must be `rl:<16 hex>` and MUST NOT contain plaintext.
  const keys = Array.from(kv._store.keys());
  assert.equal(keys.length, 1);
  const k = keys[0];
  assert.match(k, /^rl:[0-9a-f]{16}$/);
  assert.ok(!k.includes(plain), 'key must not contain plain bearer');
  assert.ok(!k.includes(plain.slice(0, 8)), 'key must not contain bearer prefix');
});

test('T-RL-04: KV down → fail-open', async () => {
  kv._setFailNext(99); // every call throws.
  const h = hashBearer('bearer-A');
  const r = await checkRateLimit({ bearerHash16: h, kvClient: kv, perMin: 5, windowSec: 60 });
  assert.equal(r.ok, true, 'KV down → fail-open');
});

test('T-RL-05: bearers diferentes no se afectan', async () => {
  const a = hashBearer('bearer-A');
  const b = hashBearer('bearer-B');
  for (let i = 0; i < 5; i++) {
    const r = await checkRateLimit({ bearerHash16: a, kvClient: kv, perMin: 5, windowSec: 60 });
    assert.equal(r.ok, true);
  }
  // Bearer A is now at limit. Bearer B must still pass.
  const rb = await checkRateLimit({ bearerHash16: b, kvClient: kv, perMin: 5, windowSec: 60 });
  assert.equal(rb.ok, true);
});

test('T-RL-06: request post-ventana → OK (TTL elapsed)', async () => {
  const h = hashBearer('bearer-A');
  for (let i = 0; i < 5; i++) {
    await checkRateLimit({ bearerHash16: h, kvClient: kv, perMin: 5, windowSec: 60 });
  }
  // Advance past the window.
  kv._advanceTime(61_000);
  const r = await checkRateLimit({ bearerHash16: h, kvClient: kv, perMin: 5, windowSec: 60 });
  assert.equal(r.ok, true);
});
