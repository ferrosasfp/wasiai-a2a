// alerts.test.mjs — WKH-66 W3.2.
//
// 4 tests T-AL-01..T-AL-04.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { sendAlert, sanitizeAlertBody } from '../src/alerts.mjs';
import { resetWarnOnce } from '../src/log.mjs';

let origFetch;

beforeEach(() => {
  origFetch = globalThis.fetch;
  resetWarnOnce();
});

afterEach(() => {
  globalThis.fetch = origFetch;
});

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

test('T-AL-01: sendAlert timeout 5s aborts via AbortSignal', async () => {
  // Mock fetch slower than timeout. We register an abort listener and
  // CLEAR the pending setTimeout so the test runner does not keep an
  // orphan timer alive. We also use a short timer (10s in case abort
  // somehow fails to fire — defensive cap).
  globalThis.fetch = (url, init = {}) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(new Response('{}', { status: 200 })), 10_000);
    const sig = init?.signal;
    if (sig && sig.addEventListener) {
      sig.addEventListener('abort', () => {
        clearTimeout(t);
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    }
  });

  const r = await sendAlert({
    severity: 'critical',
    body: { chain: 'avax', operator: '0xabc', balanceUsdc: 0.1 },
    webhookUrl: 'https://hooks.example.com/x',
    timeoutMs: 100, // tight to keep the test fast
  });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'webhook fetch failed');
});

test('T-AL-02: sendAlert body whitelist enforced (CD-12)', async () => {
  let captured;
  globalThis.fetch = async (url, init = {}) => {
    captured = JSON.parse(init.body);
    return new Response('{}', { status: 200 });
  };

  await sendAlert({
    severity: 'critical',
    body: {
      chain: 'avax',
      operator: '0xabc',
      balanceUsdc: 0.1,
      threshold: 0.5,
      // Forbidden:
      pk: 'pk-must-not-leak',
      bearer: 'bearer-must-not-leak',
      'error.message': 'sensitive backtrace',
      kiteTxHash: '0xdead...',
      signature: '0xbeef...',
      OPERATOR_PRIVATE_KEY: '0xPRIVATE',
    },
    webhookUrl: 'https://hooks.example.com/x',
  });

  assert.ok(captured, 'webhook fetch should have been called');
  assert.equal(captured.severity, 'critical');
  assert.equal(captured.chain, 'avax');
  assert.equal(captured.operator, '0xabc');
  assert.equal(captured.balanceUsdc, 0.1);
  assert.equal(captured.threshold, 0.5);
  assert.ok(!('pk' in captured));
  assert.ok(!('bearer' in captured));
  assert.ok(!('signature' in captured));
  assert.ok(!('kiteTxHash' in captured));
  assert.ok(!('OPERATOR_PRIVATE_KEY' in captured));
  assert.ok(!('error.message' in captured));
});

test('T-AL-03: sendAlert no-PK no-bearer (stderr + body capture)', async () => {
  const TEST_PK = '0x' + 'cd'.repeat(32);
  const TEST_BEARER = 'cafebabe' + 'a'.repeat(56);
  const cap = captureStderr();
  let bodyText = '';
  globalThis.fetch = async (url, init = {}) => {
    bodyText = String(init.body ?? '');
    return new Response('{}', { status: 200 });
  };
  try {
    await sendAlert({
      severity: 'critical',
      body: {
        chain: 'avax',
        operator: '0xabc',
        balanceUsdc: 0.1,
        threshold: 0.5,
        pk: TEST_PK, // forbidden — must be stripped
        bearer: TEST_BEARER, // forbidden — must be stripped
      },
      webhookUrl: 'https://hooks.example.com/x',
    });
  } finally {
    cap.restore();
  }
  // Webhook body never contains PK / bearer / 0x{64hex} pattern.
  assert.ok(!bodyText.includes(TEST_PK), 'webhook body leaked PK');
  assert.ok(!bodyText.includes(TEST_BEARER), 'webhook body leaked bearer');
  assert.ok(!/0x[0-9a-fA-F]{64}/.test(bodyText), 'webhook body has 0x{64hex} pattern');
  // Stderr never contains them either.
  const stderrBlob = cap.lines.join('\n');
  assert.ok(!stderrBlob.includes(TEST_PK), 'stderr leaked PK');
  assert.ok(!stderrBlob.includes(TEST_BEARER), 'stderr leaked bearer');
});

test('T-AL-04: sendAlert webhookUrl missing → warnOnce + no fetch', async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response('{}');
  };
  const cap = captureStderr();
  try {
    const r = await sendAlert({
      severity: 'critical',
      body: { chain: 'avax', operator: '0xabc', balanceUsdc: 0.1 },
      webhookUrl: '',
    });
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'webhook not configured');
    assert.equal(fetchCalls, 0, 'fetch must NOT be called when URL missing');
    const blob = cap.lines.join('\n');
    assert.match(blob, /mcp\.alert\.no-webhook-configured/);

    // Second call with empty URL → warnOnce dedup, no second log line.
    const beforeLines = cap.lines.length;
    await sendAlert({
      severity: 'critical',
      body: { chain: 'avax' },
      webhookUrl: '',
    });
    const afterLines = cap.lines.length;
    assert.equal(afterLines, beforeLines, 'warnOnce must dedupe');
  } finally {
    cap.restore();
  }
});

test('T-AL-bonus: sanitizeAlertBody returns only whitelisted keys', () => {
  const out = sanitizeAlertBody({
    severity: 'critical',
    chain: 'avax',
    operator: '0x1',
    balanceUsdc: 0.1,
    threshold: 0.5,
    checkedAt: 'now',
    blockNumber: 1,
    pk: 'should drop',
    extraGarbage: { lol: 1 },
  });
  assert.deepEqual(Object.keys(out).sort(), [
    'balanceUsdc', 'blockNumber', 'chain', 'checkedAt', 'operator', 'severity', 'threshold',
  ]);
});
