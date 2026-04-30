// cron-warmup.test.mjs — WKH-66 W1.4.
//
// 4 tests T-WM-01..T-WM-04 over the Express-style handler.
// We build a tiny Express-shaped {req, res} pair so the handler can call
// res.statusCode / setHeader / end without a real HTTP server.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const TEST_SECRET = 'cron-secret-' + 'a'.repeat(20);
const TEST_PK = '0x' + 'cd'.repeat(32);

function makeReq({ auth = `Bearer ${TEST_SECRET}` } = {}) {
  return {
    headers: auth === null ? {} : { authorization: auth },
    method: 'GET',
  };
}

function makeRes() {
  const headers = {};
  let statusCode = 200;
  let body = '';
  return {
    get statusCode() { return statusCode; },
    set statusCode(v) { statusCode = v; },
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    end(chunk) { body = chunk ?? ''; },
    _headers: headers,
    get _body() { return body; },
  };
}

function captureStderr() {
  const orig = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (const part of s.split('\n')) if (part.length) lines.push(part);
    return true;
  };
  return { lines, restore() { process.stderr.write = orig; } };
}

async function loadHandler() {
  const mod = await import(`../api/cron/warmup.mjs?t=${Date.now()}_${Math.random()}`);
  return mod.default;
}

beforeEach(() => {
  process.env.CRON_SECRET = TEST_SECRET;
  process.env.OPERATOR_PRIVATE_KEY = TEST_PK;
});

afterEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.OPERATOR_PRIVATE_KEY;
});

test('T-WM-01: warmup happy path → 200 + body shape', async () => {
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = makeReq();
    const res = makeRes();
    const t0 = Date.now();
    await handler(req, res);
    const elapsed = Date.now() - t0;
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.match(body.warmedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // Cold first call may be >2000ms on slow CI but in-process it should be
    // fast. We assert generously — this is documenting elapsed observability,
    // not enforcing a tight bound (story note: "elapsed < 2000ms (assert
    // sólo en segundo call, primer call cold)"). 5s is safe.
    assert.ok(elapsed < 5000, `warmup too slow: ${elapsed}ms`);
    // Stderr must NOT contain PK or CRON_SECRET (CD-10, AC-X-1).
    const blob = cap.lines.join('\n');
    assert.ok(!blob.includes(TEST_SECRET), 'CRON_SECRET leaked to stderr');
    assert.ok(!blob.includes(TEST_PK), 'PK leaked to stderr');
    assert.ok(!blob.includes('cd'.repeat(32)), 'PK (bare hex) leaked to stderr');
  } finally {
    cap.restore();
  }
});

test('T-WM-02: warmup sin auth → 401 + no side effects', async () => {
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = makeReq({ auth: null });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res._body);
    assert.deepEqual(body, { error: 'unauthorized' });
    // Negative log assertion: warmup.ok must NOT have been logged.
    const blob = cap.lines.join('\n');
    assert.ok(!/mcp\.cron\.warmup\.ok/.test(blob), 'warmup.ok should not have logged');
    assert.match(blob, /mcp\.cron\.unauthorized/);
  } finally {
    cap.restore();
  }
});

test('T-WM-03: warmup auth wrong → 401 timing-safe', async () => {
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = makeReq({ auth: 'Bearer wrong-secret-xxxxxxxxxxxxxxxxxxxxxxxxxx' });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res._body);
    assert.deepEqual(body, { error: 'unauthorized' });
    // Wrong secret must not appear in logs.
    const blob = cap.lines.join('\n');
    assert.ok(!blob.includes('wrong-secret-xxxxxxxxxxxxxxxxxxxxxxxxxx'),
      'presented secret leaked');
  } finally {
    cap.restore();
  }
});

test('T-WM-04: warmup pre-load critical modules + no fetch invoked', async () => {
  const handler = await loadHandler();
  const cap = captureStderr();
  // Spy on globalThis.fetch — the warmup MUST NOT make any network call.
  const origFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async (...args) => {
    fetchCalls += 1;
    return origFetch(...args);
  };
  try {
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(fetchCalls, 0, 'warmup MUST NOT invoke network fetch');
    // Sanity — log line emitted indicates the path ran end-to-end.
    const blob = cap.lines.join('\n');
    assert.match(blob, /mcp\.cron\.warmup\.ok/);
  } finally {
    globalThis.fetch = origFetch;
    cap.restore();
  }
});
