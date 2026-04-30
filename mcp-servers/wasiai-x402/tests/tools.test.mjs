// tools.test.mjs — 12 tests + bonus for src/index.mjs handlers.
//
// Strategy:
//   - Override globalThis.fetch with a programmable fake that records
//     calls and returns canned Response objects (status + body).
//   - Use a fixed test PK in env so any leak shows as a substring match.
//   - Spy process.stderr.write to capture log lines + assert PK never leaks.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetWarnOnce } from '../src/log.mjs';

const TEST_PK = '0x' + 'DE'.repeat(32);          // 64 hex chars; uppercase substring 'DE'×32 distinct
const TEST_PK_LC = '0x' + 'de'.repeat(32);       // lowercase variant
const PK_BARE_UPPER = 'DE'.repeat(32);
const PK_BARE_LOWER = 'de'.repeat(32);

// Build a fake config that mirrors a successfully-loaded config object.
function fakeConfig(overrides = {}) {
  return {
    operatorAddress: '0x' + '0'.repeat(40),  // overridden by getOperatorAddress real call
    gatewayUrl: new URL('https://app.wasiai.io'),
    chainId: 2368,
    contract: '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9',
    domainName: 'PYUSD',
    domainVersion: '1',
    maxAmountWeiDefault: undefined,
    payTimeoutMs: 5000,
    nodeEnv: 'development',
    ...overrides,
  };
}

// Programmable fetch fake: array of {status, body, captureRef?}.
function makeFetchFake(responses) {
  const calls = [];
  let idx = 0;
  const fetchFn = async (url, init = {}) => {
    const call = {
      url: typeof url === 'string' ? url : url.toString(),
      method: init.method ?? 'GET',
      headers: { ...(init.headers ?? {}) },
      body: init.body,
    };
    calls.push(call);
    const r = responses[idx];
    if (!r) throw new Error(`fake fetch: no canned response for call #${idx + 1} ${call.method} ${call.url}`);
    idx += 1;
    if (r.throw) throw r.throw;
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    return new Response(text, {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchFn, calls };
}

// Capture stderr lines emitted during fn().
function captureStderr() {
  const orig = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    // chunks may contain multiple newline-delimited lines; split.
    for (const part of s.split('\n')) {
      if (part.length) lines.push(part);
    }
    return true;
  };
  return {
    lines,
    restore() { process.stderr.write = orig; },
  };
}

// Lazy-import handlers fresh each test (cheap; module is small).
async function loadHandlers() {
  return await import('../src/index.mjs');
}

beforeEach(() => {
  process.env.OPERATOR_PRIVATE_KEY = TEST_PK_LC;  // lower-case to match viem's normalized output
  resetWarnOnce();
});

afterEach(() => {
  // No-op; per-test cleanup happens inline.
});

// ── T25 (AC-1) ─────────────────────────────────────────────────────────────
test('T25 (AC-1): discover_agents builds GET capabilities with query/maxPrice/capabilities', async () => {
  const { fetchFn, calls } = makeFetchFake([{ status: 200, body: { agents: [] } }]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { discoverAgentsHandler } = await loadHandlers();
    await discoverAgentsHandler(
      { query: 'AVAX price', maxPrice: 10, capabilities: ['defi', 'price'] },
      fakeConfig(),
    );
    assert.equal(calls.length, 1);
    const u = new URL(calls[0].url);
    assert.equal(u.pathname, '/api/v1/capabilities');
    assert.equal(u.searchParams.get('query'), 'AVAX price');
    assert.equal(u.searchParams.get('maxPrice'), '10');
    assert.equal(u.searchParams.get('capabilities'), 'defi,price');
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

// ── T26 (AC-1) ─────────────────────────────────────────────────────────────
test('T26 (AC-1): discover_agents returns body unchanged', async () => {
  const expected = { agents: [{ id: 'X' }], extra: 'Y' };
  const { fetchFn } = makeFetchFake([{ status: 200, body: expected }]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { discoverAgentsHandler } = await loadHandlers();
    const r = await discoverAgentsHandler({}, fakeConfig());
    assert.deepEqual(r, expected);
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

// ── T27 (AC-2) ─────────────────────────────────────────────────────────────
test('T27 (AC-2): get_payment_quote captures 402 and parses accepts[0]', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000', network: 'eip155:2368' };
  const { fetchFn, calls } = makeFetchFake([{ status: 402, body: { accepts: [accepts], extra: 1 } }]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { getPaymentQuoteHandler } = await loadHandlers();
    const r = await getPaymentQuoteHandler({ endpoint: '/api/v1/orchestrate' }, fakeConfig());
    assert.equal(r.ok, true);
    assert.equal(r.stage, 'quote');
    assert.deepEqual(r.quote, accepts);
    assert.equal(calls.length, 1);
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

// ── T28 (AC-2) ─────────────────────────────────────────────────────────────
test('T28 (AC-2): get_payment_quote does NOT include payment-signature header', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000' };
  const { fetchFn, calls } = makeFetchFake([{ status: 402, body: { accepts: [accepts] } }]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { getPaymentQuoteHandler } = await loadHandlers();
    await getPaymentQuoteHandler({ endpoint: '/api/v1/compose' }, fakeConfig());
    assert.equal(calls.length, 1);
    const headerKeys = Object.keys(calls[0].headers).map(k => k.toLowerCase());
    assert.ok(!headerKeys.includes('payment-signature'), 'payment-signature must NOT be sent during quote probe');
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

// ── T29 (AC-3) ─────────────────────────────────────────────────────────────
test('T29 (AC-3): pay_x402 full flow probe→402→sign→retry→200', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000', network: 'eip155:2368' };
  const { fetchFn, calls } = makeFetchFake([
    { status: 402, body: { accepts: [accepts] } },
    { status: 200, body: { kiteTxHash: '0xabc', settled: true } },
  ]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler({ endpoint: '/api/v1/orchestrate', payload: { hello: 1 } }, fakeConfig());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.stage, 'settled');
    assert.equal(r.kiteTxHash, '0xabc');
    // V8.1: response NEVER includes signature.
    assert.ok(!('signature' in r), 'response must not include signature');
    assert.ok(!('authorization' in r), 'response must not include authorization');
    // Second call must include the payment-signature header.
    assert.equal(calls.length, 2);
    const settleHeaders = Object.fromEntries(
      Object.entries(calls[1].headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    assert.ok(settleHeaders['payment-signature']?.length > 0, 'payment-signature missing on retry');
    // header value must be a base64 string that decodes to JSON containing signature.
    const decoded = JSON.parse(Buffer.from(settleHeaders['payment-signature'], 'base64').toString('utf8'));
    assert.match(decoded.signature, /^0x[0-9a-f]{130}$/i);
    assert.equal(decoded.network, 'eip155:2368');
    assert.equal(decoded.authorization.value, '1000');
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

// ── T30 (AC-4) ─────────────────────────────────────────────────────────────
test('T30 (AC-4): pay_x402 probe 500 → {ok:false, stage:"probe", status:500}; no signature', async () => {
  const { fetchFn } = makeFetchFake([{ status: 500, body: { error: 'boom' } }]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler({ endpoint: '/api/v1/orchestrate' }, fakeConfig());
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'probe');
    assert.equal(r.status, 500);
    assert.ok(!('kiteTxHash' in r));
    assert.ok(!('signature' in r));
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

// ── T31 (AC-4) ─────────────────────────────────────────────────────────────
test('T31 (AC-4): pay_x402 retry 400 → {ok:false, stage:"settle", status:400}', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000' };
  const { fetchFn, calls } = makeFetchFake([
    { status: 402, body: { accepts: [accepts] } },
    { status: 400, body: { error: 'bad envelope' } },
  ]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler({ endpoint: '/api/v1/orchestrate' }, fakeConfig());
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'settle');
    assert.equal(r.status, 400);
    assert.ok(!('kiteTxHash' in r));
    assert.equal(calls.length, 2);
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

// ── T32 (AC-5) ─────────────────────────────────────────────────────────────
test('T32 (AC-5): pay_x402 sign throw → {ok:false, stage:"sign"}; PK never echoed', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000' };
  const { fetchFn } = makeFetchFake([
    { status: 402, body: { accepts: [accepts] } },
    // no second call — sign should throw before settle fetch
  ]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  // Force sign to throw by deleting PK after handler imports (sign module reads on-demand).
  delete process.env.OPERATOR_PRIVATE_KEY;
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler({ endpoint: '/api/v1/orchestrate' }, fakeConfig());
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'sign');
    assert.match(r.error, /signing failed/);
    // PK never appears in response error.
    assert.ok(!r.error.includes(PK_BARE_UPPER));
    assert.ok(!r.error.includes(PK_BARE_LOWER));
  } finally {
    process.env.OPERATOR_PRIVATE_KEY = TEST_PK_LC;
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

// ── T33 (AC-9) ─────────────────────────────────────────────────────────────
test('T33 (AC-9): PK NEVER appears in stderr across all error paths', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000' };
  const origFetch = globalThis.fetch;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    // Run multiple paths.
    // 1. probe 500
    {
      const { fetchFn } = makeFetchFake([{ status: 500, body: { e: 1 } }]);
      globalThis.fetch = fetchFn;
      await payX402Handler({ endpoint: '/api/v1/x' }, fakeConfig());
    }
    // 2. settle 400
    {
      const { fetchFn } = makeFetchFake([
        { status: 402, body: { accepts: [accepts] } },
        { status: 400, body: { e: 2 } },
      ]);
      globalThis.fetch = fetchFn;
      await payX402Handler({ endpoint: '/api/v1/x' }, fakeConfig());
    }
    // 3. successful
    {
      const { fetchFn } = makeFetchFake([
        { status: 402, body: { accepts: [accepts] } },
        { status: 200, body: { kiteTxHash: '0xff' } },
      ]);
      globalThis.fetch = fetchFn;
      await payX402Handler({ endpoint: '/api/v1/x' }, fakeConfig());
    }
    // 4. invalid 402
    {
      const { fetchFn } = makeFetchFake([{ status: 402, body: { accepts: [] } }]);
      globalThis.fetch = fetchFn;
      await payX402Handler({ endpoint: '/api/v1/x' }, fakeConfig());
    }
    // 5. guard exceeded
    {
      const cfg = fakeConfig({ maxAmountWeiDefault: 100n });
      const { fetchFn } = makeFetchFake([
        { status: 402, body: { accepts: [{ ...accepts, maxAmountRequired: '999999999' }] } },
      ]);
      globalThis.fetch = fetchFn;
      await payX402Handler({ endpoint: '/api/v1/x' }, cfg);
    }
    // 6. probe network err
    {
      const fetchFn = async () => { throw new Error('econnrefused'); };
      globalThis.fetch = fetchFn;
      await payX402Handler({ endpoint: '/api/v1/x' }, fakeConfig());
    }
    // Now assert PK substring (in either case) does NOT appear in any captured line.
    const blob = cap.lines.join('\n');
    assert.ok(!blob.includes(PK_BARE_UPPER), `stderr leaked PK (upper): see lines\n${blob}`);
    assert.ok(!blob.includes(PK_BARE_LOWER), `stderr leaked PK (lower): see lines\n${blob}`);
    // Belt-and-suspenders: also check the full 0x-prefixed forms.
    assert.ok(!blob.includes(TEST_PK));
    assert.ok(!blob.includes(TEST_PK_LC));
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

// ── T34 (AC-10) ────────────────────────────────────────────────────────────
test('T34 (AC-10): pay_x402 ignores forbidden top-level keys + warn-once', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000' };
  const INPUT_PK = '0x' + 'CA'.repeat(32);
  const INPUT_SIG = '0x' + 'BE'.repeat(65);
  const { fetchFn, calls } = makeFetchFake([
    { status: 402, body: { accepts: [accepts] } },
    { status: 200, body: { kiteTxHash: '0xok' } },
  ]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler(
      {
        endpoint: '/api/v1/x',
        OPERATOR_PRIVATE_KEY: INPUT_PK,
        signature: INPUT_SIG,
        authorization: { from: '0xattacker' },
      },
      fakeConfig(),
    );
    assert.equal(r.ok, true);
    // Envelope.from must derive from the env PK (lowercase de×32 → some address), NOT from the input authorization.
    const decoded = JSON.parse(
      Buffer.from(calls[1].headers['payment-signature'], 'base64').toString('utf8'),
    );
    assert.notEqual(decoded.authorization.from, '0xattacker');
    // warn-once log line emitted exactly 1 time.
    const stripped = cap.lines.filter(l => l.includes('mcp.input.forbidden-keys-stripped'));
    assert.equal(stripped.length, 1, `expected 1 stripped warn, got ${stripped.length}`);
    // Input PK/sig NEVER appear in stderr.
    const blob = cap.lines.join('\n');
    assert.ok(!blob.includes('CA'.repeat(32)));
    assert.ok(!blob.includes('BE'.repeat(65)));
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

// ── T35 (AC-11) ────────────────────────────────────────────────────────────
test('T35 (AC-11): pay_x402 aborts pre-sign when maxAmountRequired exceeds env guard', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '9999999999999999999' };
  const { fetchFn, calls } = makeFetchFake([
    { status: 402, body: { accepts: [accepts] } },
    // no second call expected
  ]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler(
      { endpoint: '/api/v1/x' },
      fakeConfig({ maxAmountWeiDefault: 1000n }),
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'sign');
    assert.match(r.error, /exceeds maxAmountWei guard/);
    assert.equal(calls.length, 1, 'second fetch must NOT be called');
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

// ── T36 (AC-16) ────────────────────────────────────────────────────────────
test('T36 (AC-16): logs are JSON-line per event with canonical keys', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000' };
  const { fetchFn } = makeFetchFake([
    { status: 402, body: { accepts: [accepts] } },
    { status: 200, body: { kiteTxHash: '0xok' } },
  ]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    await payX402Handler({ endpoint: '/api/v1/x' }, fakeConfig());
    // Each line is JSON.parseable.
    let foundSigOk = false;
    for (const line of cap.lines) {
      const parsed = JSON.parse(line);
      assert.ok(parsed.ts, `missing ts in ${line}`);
      assert.ok(parsed.level, `missing level in ${line}`);
      assert.ok(parsed.event, `missing event in ${line}`);
      // operator (when present) must be a 40-char address, NEVER 64-char PK.
      if (parsed.operator !== undefined) {
        assert.match(parsed.operator, /^0x[0-9a-fA-F]{40}$/);
        assert.ok(parsed.operator.length === 42, `operator length ${parsed.operator.length} != 42`);
      }
      if (parsed.event === 'tool.pay_x402.signed') {
        foundSigOk = true;
        // signature should be truncated by redact()
        assert.ok(parsed.signature.endsWith('…'), 'signature should be truncated');
      }
    }
    assert.ok(foundSigOk, 'expected a tool.pay_x402.signed log line');
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

// ── Bonus V7.1: 10 concurrent calls — distinct nonces, no log corruption ──
test('Bonus V7.1: 10 concurrent pay_x402 calls — distinct nonces, log lines all JSON', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000' };
  // Concurrent flows interleave fetches → use a header-aware fake (probe vs settle)
  // instead of strict-order canned responses.
  const calls = [];
  let settleCounter = 0;
  const fetchFn = async (url, init = {}) => {
    const headers = { ...(init.headers ?? {}) };
    const lowerHeaders = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    calls.push({
      url: typeof url === 'string' ? url : url.toString(),
      method: init.method ?? 'GET',
      headers,
    });
    if (lowerHeaders['payment-signature']) {
      const i = settleCounter++;
      return new Response(JSON.stringify({ kiteTxHash: `0x${i.toString(16)}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ accepts: [accepts] }), {
      status: 402,
      headers: { 'content-type': 'application/json' },
    });
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => payX402Handler({ endpoint: '/api/v1/x' }, fakeConfig())),
    );
    assert.equal(results.filter(r => r.ok).length, 10);
    // Extract nonces from any call that carried a payment-signature header
    // (concurrent flows interleave probe/settle calls, so order is not fixed).
    const nonces = new Set();
    let settleCalls = 0;
    for (const c of calls) {
      const sigHeader = Object.entries(c.headers).find(
        ([k]) => k.toLowerCase() === 'payment-signature',
      )?.[1];
      if (!sigHeader) continue;
      settleCalls += 1;
      const decoded = JSON.parse(Buffer.from(sigHeader, 'base64').toString('utf8'));
      nonces.add(decoded.authorization.nonce);
    }
    assert.equal(settleCalls, 10, `expected 10 settle calls, got ${settleCalls}`);
    assert.equal(nonces.size, 10, '10 distinct nonces expected');
    // Every captured stderr line must be JSON-parseable.
    for (const line of cap.lines) {
      JSON.parse(line);
    }
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

// ── Bonus V6.2: per-call cap > env > undefined priority ────────────────────
test('Bonus V6.2: per-call maxAmountWei wins over env default', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '2000' };
  // env=1000 would block, but per-call=100000000000 should allow.
  const { fetchFn, calls } = makeFetchFake([
    { status: 402, body: { accepts: [accepts] } },
    { status: 200, body: { kiteTxHash: '0xok' } },
  ]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler(
      { endpoint: '/api/v1/x', maxAmountWei: 100000000000n.toString() },
      fakeConfig({ maxAmountWeiDefault: 1000n }),
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(calls.length, 2);
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

// ── BLQ-1 fix-pack iter 1: SSRF runtime via absolute endpoint ──────────────
// pay_x402 / get_payment_quote MUST reject absolute / protocol-relative URLs.
// Otherwise `new URL(endpoint, base)` discards the gateway base and the
// signed envelope is captured by an attacker-controlled host (replay drain).

test('T-X1: pay_x402 rejects absolute https endpoint (no fetch, no sign)', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(typeof url === 'string' ? url : url.toString());
    throw new Error('fetch must NOT be called for rejected absolute URL');
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler(
      { endpoint: 'https://attacker.com/x402' },
      fakeConfig(),
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'validation');
    assert.match(r.error, /path starting with/);
    assert.equal(calls.length, 0, 'fetch must not be invoked');
    // Signature must never appear (no sign performed).
    const blob = cap.lines.join('\n');
    assert.ok(!blob.includes('attacker.com'), 'attacker host must not be reached');
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

test('T-X2: pay_x402 rejects AWS metadata endpoint', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(typeof url === 'string' ? url : url.toString());
    throw new Error('fetch must NOT be called');
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler(
      { endpoint: 'http://169.254.169.254/latest/meta-data/' },
      fakeConfig(),
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'validation');
    assert.equal(calls.length, 0);
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

test('T-X3: pay_x402 rejects protocol-relative URL', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(typeof url === 'string' ? url : url.toString());
    throw new Error('fetch must NOT be called');
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler(
      { endpoint: '//evil.com/path' },
      fakeConfig(),
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'validation');
    assert.equal(calls.length, 0);
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

test('T-X4: pay_x402 accepts valid path-only endpoint /api/v1/compose', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000' };
  const { fetchFn, calls } = makeFetchFake([
    { status: 402, body: { accepts: [accepts] } },
    { status: 200, body: { kiteTxHash: '0xok' } },
  ]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler(
      { endpoint: '/api/v1/compose' },
      fakeConfig(),
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(calls.length, 2);
    // First request must hit the configured gateway, NOT an attacker host.
    const probeUrl = new URL(calls[0].url);
    assert.equal(probeUrl.hostname, 'app.wasiai.io');
    assert.equal(probeUrl.pathname, '/api/v1/compose');
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

test('T-X1q: get_payment_quote rejects absolute https endpoint', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(typeof url === 'string' ? url : url.toString());
    throw new Error('fetch must NOT be called');
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { getPaymentQuoteHandler } = await loadHandlers();
    const r = await getPaymentQuoteHandler(
      { endpoint: 'https://attacker.com/api/v1/orchestrate' },
      fakeConfig(),
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'validation');
    assert.match(r.error, /path starting with/);
    assert.equal(calls.length, 0);
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

// ── BLQ-2 fix-pack iter 1: sanitize sign error in agent response ───────────
test('T-Y1: pay_x402 sign throw via viem returns sanitized error (no internals)', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000' };
  // Force viem signTypedData to throw with verbose internals by injecting
  // a malformed PK that viem will reject during privateKeyToAccount.
  const { fetchFn } = makeFetchFake([
    { status: 402, body: { accepts: [accepts] } },
  ]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  // PK that is NOT obviously "missing" but is invalid → viem throws verbose error.
  process.env.OPERATOR_PRIVATE_KEY = '0xZZ' + 'ee'.repeat(31);
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler({ endpoint: '/api/v1/x' }, fakeConfig());
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'sign');
    // Sanitized: stable label, NO viem internals leaked.
    assert.equal(r.error, 'signing failed (see stderr logs)');
    // Defensive: no stack trace, no "viem" word, no PK substring.
    assert.ok(!r.error.includes('viem'));
    assert.ok(!r.error.includes('Stack'));
    assert.ok(!r.error.includes('ZZ'));
  } finally {
    process.env.OPERATOR_PRIVATE_KEY = TEST_PK_LC;
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

// ── BLQ-3 fix-pack iter 1: signature truncation tightened to 4 chars ───────
test('T-Z1: signature in stderr is truncated to 4 chars (no fingerprint correlation)', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000' };
  const origFetch = globalThis.fetch;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    // Run 5 sign calls back-to-back with distinct nonces (random per call).
    for (let i = 0; i < 5; i++) {
      const { fetchFn } = makeFetchFake([
        { status: 402, body: { accepts: [accepts] } },
        { status: 200, body: { kiteTxHash: `0x${i}` } },
      ]);
      globalThis.fetch = fetchFn;
      const r = await payX402Handler({ endpoint: '/api/v1/x' }, fakeConfig());
      assert.equal(r.ok, true, JSON.stringify(r));
    }
    // Pull all signed-event log lines and assert truncation length.
    const signedLines = cap.lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((p) => p && p.event === 'tool.pay_x402.signed');
    assert.equal(signedLines.length, 5, 'expected 5 sign events');
    for (const ev of signedLines) {
      // Truncated form: '0x' + 2 hex + ellipsis = 5 chars total (slice(0,4) + '…')
      assert.ok(ev.signature.endsWith('…'), 'signature must be truncated');
      assert.equal(ev.signature.length, 5, `signature truncated to 5 chars (4+ellipsis), got: ${ev.signature}`);
      // Cannot reconstruct full signature from 4-char prefix (16 bits).
      assert.ok(!/^0x[0-9a-f]{130}/i.test(ev.signature), 'full signature must not appear');
    }
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

// ── BLQ-iter2-1 fix-pack iter 2: backslash bypass of SSRF guard ────────────
// The WHATWG URL parser treats `\` as `/` for special schemes (https:/http:),
// so endpoints like `/\evil.com/x` resolve to https://evil.com/x when combined
// with the gateway base — the signed envelope would then be replayed to an
// attacker host. iter-1's `startsWith('//')` check did NOT cover this class.
// iter-2 fix combines a tightened isPathOnly() (rejects `\`) with a
// post-resolution host/protocol guard. Both layers must reject these inputs;
// fetch() must NEVER be called and signing must NEVER occur.

test('T-X5 (iter2): pay_x402 rejects /\\evil.com/x (backslash → host hijack)', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(typeof url === 'string' ? url : url.toString());
    throw new Error('fetch must NOT be called for backslash-bypass URL');
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler({ endpoint: '/\\evil.com/x' }, fakeConfig());
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'validation');
    assert.equal(calls.length, 0, 'fetch must not be invoked for backslash bypass');
    const blob = cap.lines.join('\n');
    assert.ok(!blob.includes('evil.com'), 'attacker host must not appear in any log');
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

test('T-X6 (iter2): pay_x402 rejects /\\@evil.com (backslash + userinfo trick)', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(typeof url === 'string' ? url : url.toString());
    throw new Error('fetch must NOT be called');
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler({ endpoint: '/\\@evil.com' }, fakeConfig());
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'validation');
    assert.equal(calls.length, 0);
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

test('T-X7 (iter2): pay_x402 rejects /\\\\evil.com (double backslash)', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(typeof url === 'string' ? url : url.toString());
    throw new Error('fetch must NOT be called');
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler({ endpoint: '/\\\\evil.com' }, fakeConfig());
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'validation');
    assert.equal(calls.length, 0);
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

test('T-X8 (iter2): pay_x402 rejects /\\/evil.com (backslash + slash)', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(typeof url === 'string' ? url : url.toString());
    throw new Error('fetch must NOT be called');
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler({ endpoint: '/\\/evil.com' }, fakeConfig());
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'validation');
    assert.equal(calls.length, 0);
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

test('T-X9 (iter2): pay_x402 still accepts valid /api/v1/compose (no regression)', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000' };
  const { fetchFn, calls } = makeFetchFake([
    { status: 402, body: { accepts: [accepts] } },
    { status: 200, body: { kiteTxHash: '0xok' } },
  ]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler({ endpoint: '/api/v1/compose' }, fakeConfig());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(calls.length, 2);
    const u = new URL(calls[0].url);
    assert.equal(u.hostname, 'app.wasiai.io');
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

// Same coverage on get_payment_quote (no signature involved, but the SSRF
// guard must still reject — captured probe could fingerprint internal hosts).
test('T-X5q (iter2): get_payment_quote rejects /\\evil.com/x', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(typeof url === 'string' ? url : url.toString());
    throw new Error('fetch must NOT be called');
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { getPaymentQuoteHandler } = await loadHandlers();
    const r = await getPaymentQuoteHandler({ endpoint: '/\\evil.com/x' }, fakeConfig());
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'validation');
    assert.equal(calls.length, 0);
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

test('T-X6q (iter2): get_payment_quote rejects /\\@evil.com', async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(typeof url === 'string' ? url : url.toString());
    throw new Error('fetch must NOT be called');
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { getPaymentQuoteHandler } = await loadHandlers();
    const r = await getPaymentQuoteHandler({ endpoint: '/\\@evil.com' }, fakeConfig());
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'validation');
    assert.equal(calls.length, 0);
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

// Defense-in-depth: even if isPathOnly() is hypothetically bypassed, the
// post-resolution guard alone must still reject a host mismatch. We exercise
// resolveEndpoint() directly to lock that behavior.
test('T-X10 (iter2): resolveEndpoint rejects host mismatch even without shape check', async () => {
  const { resolveEndpoint } = await loadHandlers();
  const gw = new URL('https://app.wasiai.io');
  // Direct backslash variants — confirm post-resolution catches them all.
  for (const bad of ['/\\evil.com/x', '/\\@evil.com', '/\\\\evil.com', '/\\/evil.com']) {
    const r = resolveEndpoint(bad, gw);
    assert.equal(r.ok, false, `expected reject for ${JSON.stringify(bad)}`);
    assert.match(r.error, /host and protocol must match|could not be resolved/);
  }
  // Sanity: a valid path is accepted and resolves to the gateway host.
  const ok = resolveEndpoint('/api/v1/compose', gw);
  assert.equal(ok.ok, true);
  assert.equal(new URL(ok.url).hostname, 'app.wasiai.io');
});

// MNR-iter2-1: chain-mismatch warn payload must NOT clobber `event` field.
test('T-MNR-iter2-1: chain-mismatch log line keeps canonical event name', async () => {
  // 402 challenge with mismatched network field.
  const accepts = {
    payTo: '0x' + '99'.repeat(20),
    maxAmountRequired: '1000',
    network: 'eip155:43114', // does not match cfg.chainId 2368 → triggers warn
  };
  const { fetchFn } = makeFetchFake([
    { status: 402, body: { accepts: [accepts] } },
    { status: 200, body: { kiteTxHash: '0xok' } },
  ]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler({ endpoint: '/api/v1/x' }, fakeConfig());
    assert.equal(r.ok, true, JSON.stringify(r));
    // Find the chain-mismatch log line.
    const mismatchLines = cap.lines
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((p) => p && p.event === 'tool.pay_x402.chain-mismatch');
    assert.equal(mismatchLines.length, 1, 'expected exactly 1 chain-mismatch log line');
    const ev = mismatchLines[0];
    // Canonical event name preserved (no 'chain_mismatch' clobber).
    assert.equal(ev.event, 'tool.pay_x402.chain-mismatch');
    assert.notEqual(ev.event, 'chain_mismatch');
    // Diagnostic fields still present.
    assert.equal(ev.expected, 'eip155:2368');
    assert.equal(ev.received, 'eip155:43114');
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

// ── BLQ-iter3-1: redirect:'error' on all fetch() calls ────────────────────
//
// The hostile gateway is allowed to authenticate the request via TLS host
// pinning (it IS the configured gateway). But it can still reply 3xx with
// `Location: https://evil.com/...`. WHATWG fetch only strips
// Authorization/Cookie/Proxy-Authorization on cross-origin redirects;
// custom headers like `payment-signature` carrying the EIP-3009 envelope
// are FORWARDED. Without `redirect:'error'`, undici follows the redirect
// and leaks the signed envelope to the attacker host, who can replay it
// on the legitimate gateway and drain the operator wallet.
//
// We simulate the undici behavior: when `redirect:'error'` is set and the
// upstream returns a 3xx, undici throws TypeError('fetch failed') with
// `cause: Error('redirect mode is set to "error"')`. Our handlers must
// detect this and surface a stable message (no leak of internals).

// Helper: build a fetch fake that returns 3xx if `redirect` option is NOT
// 'error', and throws an undici-shaped TypeError if it IS 'error'. This
// captures whether we correctly opted into redirect:'error' AND whether
// the error path produces the right user-facing response.
function makeRedirectFetchFake({ when = () => true, status = 302, location = 'https://evil.com/x' } = {}) {
  const calls = [];
  let idx = 0;
  const fetchFn = async (url, init = {}) => {
    const callIdx = idx;
    idx += 1;
    const call = {
      url: typeof url === 'string' ? url : url.toString(),
      method: init.method ?? 'GET',
      headers: { ...(init.headers ?? {}) },
      body: init.body,
      redirect: init.redirect,
      callIdx,
    };
    calls.push(call);
    if (when(call)) {
      // Verify the handler opted into redirect:'error' for this call. If
      // not, that's a regression: surface the 3xx Response, which would
      // let undici follow → handler likely treats it as 200/4xx/5xx.
      if (init.redirect !== 'error') {
        return new Response('', {
          status,
          headers: { 'content-type': 'text/plain', location },
        });
      }
      // Simulate undici's TypeError on redirect:'error'.
      const err = new TypeError('fetch failed');
      err.cause = new Error("redirect mode is set to 'error'");
      throw err;
    }
    // Non-redirect call: behave as a benign 200.
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchFn, calls };
}

test('T-X11 (iter3): pay_x402 settle 302 → reject with stage:settle, no leak of attacker host', async () => {
  // Probe returns 402 OK, then settle returns 302.
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000' };
  let callIdx = 0;
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const i = callIdx;
    callIdx += 1;
    calls.push({
      url: typeof url === 'string' ? url : url.toString(),
      headers: { ...(init.headers ?? {}) },
      redirect: init.redirect,
      callIdx: i,
    });
    if (i === 0) {
      // Probe: 402 challenge.
      return new Response(JSON.stringify({ accepts: [accepts] }), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      });
    }
    // Settle: hostile 302. If the handler did NOT opt into redirect:'error',
    // returning the 302 here would let undici follow it (in real life). To
    // surface the regression in the test, we throw if redirect !== 'error'.
    if (init.redirect !== 'error') {
      throw new Error('REGRESSION: settle fetch missing redirect:"error"');
    }
    // Simulate undici redirect-error throw.
    const err = new TypeError('fetch failed');
    err.cause = new Error("redirect mode is set to 'error'");
    throw err;
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler({ endpoint: '/api/v1/orchestrate' }, fakeConfig());
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.stage, 'settle');
    assert.match(r.error, /redirect/i, `expected error to mention redirect, got: ${r.error}`);
    // Stable message: no undici internals like "fetch failed" or "redirect mode is set to".
    assert.ok(!/fetch failed/.test(r.error), `must not leak undici "fetch failed": ${r.error}`);
    assert.ok(!/redirect mode is set/.test(r.error), `must not leak undici cause text: ${r.error}`);
    // Two calls happened: probe + attempted settle. NO call to evil.com.
    assert.equal(calls.length, 2, 'probe + attempted settle = 2 calls');
    for (const c of calls) {
      assert.ok(!c.url.includes('evil.com'), `call URL must stay on gateway, got ${c.url}`);
    }
    // Verify settle was the one that opted into redirect:'error'.
    assert.equal(calls[1].redirect, 'error', 'settle fetch must opt into redirect:"error"');
    // payment-signature header was prepared (we got past sign), but it never
    // reached evil.com because undici threw on redirect.
    assert.ok(calls[1].headers['payment-signature'], 'settle should carry payment-signature');
    // No attacker host name in any log line.
    const blob = cap.lines.join('\n');
    assert.ok(!blob.includes('evil.com'), 'attacker host must not appear in stderr');
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

test('T-X12 (iter3): pay_x402 probe 302 → reject with stage:probe, never signs', async () => {
  // Probe returns 302 directly. The handler must reject before sign.
  let callIdx = 0;
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const i = callIdx;
    callIdx += 1;
    calls.push({
      url: typeof url === 'string' ? url : url.toString(),
      headers: { ...(init.headers ?? {}) },
      redirect: init.redirect,
      callIdx: i,
    });
    // First call (probe) always: simulate 302 via redirect:'error' throw.
    if (init.redirect !== 'error') {
      throw new Error('REGRESSION: probe fetch missing redirect:"error"');
    }
    const err = new TypeError('fetch failed');
    err.cause = new Error("redirect mode is set to 'error'");
    throw err;
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler({ endpoint: '/api/v1/orchestrate' }, fakeConfig());
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'probe');
    assert.match(r.error, /redirect/i);
    // Only the probe call happened, no settle.
    assert.equal(calls.length, 1, 'only probe should run; no signing, no settle');
    assert.equal(calls[0].redirect, 'error');
    // No payment-signature header on the probe call (it never gets that far,
    // and even at the probe stage we never include it).
    assert.ok(!calls[0].headers['payment-signature'], 'probe must NOT carry payment-signature');
    // No "signed" log line — sign step must not have run.
    const signedLines = cap.lines.filter(l => l.includes('tool.pay_x402.signed'));
    assert.equal(signedLines.length, 0, 'sign step must NOT execute when probe rejects');
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

test('T-X13 (iter3): discover_agents gateway 302 → reject with stage:probe', async () => {
  let callIdx = 0;
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    callIdx += 1;
    calls.push({
      url: typeof url === 'string' ? url : url.toString(),
      redirect: init.redirect,
    });
    if (init.redirect !== 'error') {
      throw new Error('REGRESSION: discover_agents fetch missing redirect:"error"');
    }
    const err = new TypeError('fetch failed');
    err.cause = new Error("redirect mode is set to 'error'");
    throw err;
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { discoverAgentsHandler } = await loadHandlers();
    const r = await discoverAgentsHandler({ query: 'AVAX price' }, fakeConfig());
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'probe');
    assert.match(r.error, /redirect/i);
    assert.ok(!/fetch failed/.test(r.error), 'must not leak undici internals');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].redirect, 'error');
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

test('T-X14 (iter3): pay_x402 settle 301 (any 3xx) → reject', async () => {
  // Same shape as T-X11 but with 301 to confirm the behavior is generic to
  // any 3xx, not coupled to 302 specifically.
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000' };
  let callIdx = 0;
  const fetchFn = async (url, init = {}) => {
    const i = callIdx;
    callIdx += 1;
    if (i === 0) {
      return new Response(JSON.stringify({ accepts: [accepts] }), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      });
    }
    // Settle with any 3xx → undici raises the same redirect-error class.
    if (init.redirect !== 'error') {
      throw new Error('REGRESSION: settle fetch missing redirect:"error"');
    }
    const err = new TypeError('fetch failed');
    err.cause = new Error("redirect mode is set to 'error'");
    throw err;
  };
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler({ endpoint: '/api/v1/compose' }, fakeConfig());
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'settle');
    assert.match(r.error, /redirect/i);
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});

// MNR-iter3-1: resolveEndpoint defensive type/empty guard.
test('T-MNR-iter3-1: resolveEndpoint rejects non-string / empty inputs early', async () => {
  const { resolveEndpoint } = await loadHandlers();
  const gw = new URL('https://app.wasiai.io');
  for (const bad of [null, undefined, '', 0, false, {}, [], 42]) {
    const r = resolveEndpoint(bad, gw);
    assert.equal(r.ok, false, `expected reject for ${JSON.stringify(bad)}`);
    assert.match(r.error, /non-empty string/);
  }
});

// ── Bonus AC-10: signature/authorization in input ignored ──────────────────
test('Bonus AC-10: pay_x402 ignores signature/authorization keys in input', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000' };
  const { fetchFn } = makeFetchFake([
    { status: 402, body: { accepts: [accepts] } },
    { status: 200, body: { kiteTxHash: '0xok' } },
  ]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler(
      { endpoint: '/api/v1/x', signature: '0xINJECT', authorization: { from: '0xINJECT' } },
      fakeConfig(),
    );
    assert.equal(r.ok, true);
    const stripped = cap.lines.filter(l => l.includes('mcp.input.forbidden-keys-stripped'));
    assert.equal(stripped.length, 1);
    const blob = cap.lines.join('\n');
    assert.ok(!blob.includes('0xINJECT'), 'injected fields must not appear in logs');
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
  }
});
