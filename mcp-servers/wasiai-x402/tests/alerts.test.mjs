// alerts.test.mjs — WKH-66 W3.2.
//
// 4 tests T-AL-01..T-AL-04.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { sendAlert, sanitizeAlertBody, formatForDiscord } from '../src/alerts.mjs';
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

test('T-AL-02: sendAlert body whitelist enforced (CD-12 + WKH-75 CD-11)', async () => {
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
      event: 'bearer-rotation-failed',
      reason: 'failed to list Vercel envs',
      rotatedAt: '2026-05-01T09:00:00.000Z',
      pk: 'pk-must-not-leak',
      bearer: 'bearer-must-not-leak',
      'error.message': 'sensitive backtrace',
      kiteTxHash: '0xdead...',
      signature: '0xbeef...',
      OPERATOR_PRIVATE_KEY: '0xPRIVATE',
    },
    webhookUrl: 'https://hooks.example.com/x',
  });

  assert.ok(captured);
  assert.equal(captured.severity, 'critical');
  assert.equal(captured.chain, 'avax');
  assert.equal(captured.operator, '0xabc');
  assert.equal(captured.balanceUsdc, 0.1);
  assert.equal(captured.threshold, 0.5);
  assert.equal(captured.event, 'bearer-rotation-failed');
  assert.equal(captured.reason, 'failed to list Vercel envs');
  assert.equal(captured.rotatedAt, '2026-05-01T09:00:00.000Z');
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

test('T-AL-05: rotation-secret keys silently dropped (CD-11 deny-by-default)', async () => {
  let captured;
  globalThis.fetch = async (url, init = {}) => {
    captured = JSON.parse(init.body);
    return new Response('{}', { status: 200 });
  };
  const TEST_BEARER = 'cafebabe' + 'a'.repeat(56);
  const TEST_VERCEL_TOKEN = 'vercel_test_token_must_not_leak_xxxxxxxxxxxxx';
  const TEST_PREV = 'deadbeef' + 'b'.repeat(56);

  await sendAlert({
    severity: 'critical',
    body: {
      event: 'bearer-rotation-failed',
      reason: 'failed to update current env (rolled back)',
      rotatedAt: '2026-05-01T09:00:00.000Z',
      bearer: TEST_BEARER,
      vercelToken: TEST_VERCEL_TOKEN,
      MCP_BEARER_TOKEN: TEST_BEARER,
      MCP_BEARER_TOKEN_PREV: TEST_PREV,
      VERCEL_TOKEN: TEST_VERCEL_TOKEN,
      value: 'env-value-with-secret',
    },
    webhookUrl: 'https://hooks.example.com/x',
  });

  assert.ok(captured);
  assert.equal(captured.event, 'bearer-rotation-failed');
  assert.equal(captured.reason, 'failed to update current env (rolled back)');
  assert.equal(captured.rotatedAt, '2026-05-01T09:00:00.000Z');
  assert.ok(!('bearer' in captured));
  assert.ok(!('vercelToken' in captured));
  assert.ok(!('MCP_BEARER_TOKEN' in captured));
  assert.ok(!('MCP_BEARER_TOKEN_PREV' in captured));
  assert.ok(!('VERCEL_TOKEN' in captured));
  assert.ok(!('value' in captured));
  const serialized = JSON.stringify(captured);
  assert.ok(!serialized.includes(TEST_BEARER));
  assert.ok(!serialized.includes(TEST_VERCEL_TOKEN));
  assert.ok(!serialized.includes(TEST_PREV));
});

// ─────────────────────────────────────────────────────────────────────────────
// WKH-90 — Discord-aware payload formatting tests (T-AL-DISC-01..08).
// ─────────────────────────────────────────────────────────────────────────────

test('T-AL-DISC-01: critical → Discord payload shape (username + red embed + fields)', async () => {
  let captured;
  let capturedUrl;
  globalThis.fetch = async (url, init = {}) => {
    capturedUrl = String(url);
    captured = JSON.parse(init.body);
    return new Response('{}', { status: 200 });
  };

  const r = await sendAlert({
    severity: 'critical',
    body: {
      chain: 'avax',
      operator: '0xabc',
      balanceUsdc: 0.1,
      threshold: 0.5,
      event: 'bearer-rotation-failed',
      reason: 'failed to update current env (rolled back)',
      rotatedAt: '2026-05-01T09:00:00.000Z',
      blockNumber: 42,
    },
    webhookUrl: 'https://discord.com/api/webhooks/123/abc',
  });

  assert.equal(r.sent, true);
  assert.equal(capturedUrl, 'https://discord.com/api/webhooks/123/abc');
  assert.ok(captured, 'fetch must be called with a JSON body');
  // AC-1: top-level Discord shape
  assert.equal(captured.username, 'wasiai-alerts');
  assert.ok(Array.isArray(captured.embeds), 'embeds must be array');
  assert.equal(captured.embeds.length, 1);
  const e = captured.embeds[0];
  // AC-2: critical → 0xE74C3C (15158332)
  assert.equal(e.color, 15158332);
  // DT-3: title format "[<severity>] <event>"
  assert.equal(e.title, '[critical] bearer-rotation-failed');
  // DT-3: reason → description
  assert.equal(e.description, 'failed to update current env (rolled back)');
  // DT-3: rotatedAt → timestamp
  assert.equal(e.timestamp, '2026-05-01T09:00:00.000Z');
  // DT-3: fields[] from whitelisted body keys (excluding severity/event/reason/rotatedAt/checkedAt)
  assert.ok(Array.isArray(e.fields), 'fields must be array');
  const fieldNames = e.fields.map((f) => f.name).sort();
  assert.deepEqual(fieldNames, ['balanceUsdc', 'blockNumber', 'chain', 'operator', 'threshold']);
  for (const f of e.fields) {
    assert.equal(typeof f.value, 'string');
    assert.equal(f.inline, true);
  }
  // Spot-check String() coercion of values
  const balanceField = e.fields.find((f) => f.name === 'balanceUsdc');
  assert.equal(balanceField.value, '0.1');
});

test('T-AL-DISC-02: warning → yellow color (15844367)', async () => {
  let captured;
  globalThis.fetch = async (url, init = {}) => {
    captured = JSON.parse(init.body);
    return new Response('{}', { status: 200 });
  };

  await sendAlert({
    severity: 'warning',
    body: { chain: 'avax', balanceUsdc: 0.4, threshold: 0.5 },
    webhookUrl: 'https://discordapp.com/api/webhooks/9/xyz',
  });

  assert.ok(captured);
  assert.equal(captured.username, 'wasiai-alerts');
  assert.equal(captured.embeds[0].color, 15844367);
  assert.equal(captured.embeds[0].title, '[warning]');
});

test('T-AL-DISC-03: info → green color (3066993) + unknown severity falls back to info color', async () => {
  let captured;
  globalThis.fetch = async (url, init = {}) => {
    captured = JSON.parse(init.body);
    return new Response('{}', { status: 200 });
  };

  // info → green
  await sendAlert({
    severity: 'info',
    body: { event: 'bearer-rotated', rotatedAt: '2026-05-02T00:00:00.000Z' },
    webhookUrl: 'https://discord.com/api/webhooks/1/info',
  });
  assert.ok(captured);
  assert.equal(captured.embeds[0].color, 3066993);
  assert.equal(captured.embeds[0].title, '[info] bearer-rotated');
  assert.equal(captured.embeds[0].timestamp, '2026-05-02T00:00:00.000Z');

  // DT-4: unknown severity → defaults to info color (3066993), no throw
  captured = undefined;
  const r = await sendAlert({
    severity: 'banana',
    body: { chain: 'avax' },
    webhookUrl: 'https://discord.com/api/webhooks/1/u',
  });
  assert.equal(r.sent, true);
  assert.ok(captured);
  assert.equal(captured.embeds[0].color, 3066993);
});

test('T-AL-DISC-04: Discord HTTP 400 → {sent:false, status:400, reason} no throw (AC-4 / CD-12)', async () => {
  globalThis.fetch = async () => new Response('Bad Request', { status: 400 });

  const r = await sendAlert({
    severity: 'critical',
    body: { chain: 'avax', operator: '0xabc', balanceUsdc: 0.1 },
    webhookUrl: 'https://discord.com/api/webhooks/123/abc',
  });

  assert.equal(r.sent, false);
  assert.equal(r.status, 400);
  assert.equal(r.reason, 'webhook status 400');
});

test('T-AL-DISC-05: backward compat — non-Discord host still gets raw JSON (AC-3)', async () => {
  let captured;
  globalThis.fetch = async (url, init = {}) => {
    captured = JSON.parse(init.body);
    return new Response('{}', { status: 200 });
  };

  await sendAlert({
    severity: 'critical',
    body: { chain: 'avax', operator: '0xabc', balanceUsdc: 0.1, threshold: 0.5 },
    webhookUrl: 'https://hooks.slack.com/services/T/B/zzz',
  });

  assert.ok(captured);
  // Raw shape: top-level severity/chain/etc., NO username, NO embeds.
  assert.equal(captured.severity, 'critical');
  assert.equal(captured.chain, 'avax');
  assert.equal(captured.operator, '0xabc');
  assert.ok(!('username' in captured), 'non-Discord host must NOT receive Discord shape');
  assert.ok(!('embeds' in captured));
});

test('T-AL-DISC-06: malformed URL falls back to raw path, never throws (CD-WKH90-2 / WKH-91 CD-WKH91-3)', async () => {
  // WKH-91 AC-4 / CD-WKH91-3: assertions MUST run unconditionally — no
  // `if (captured)` guard. We mock `fetch` to ALWAYS capture and return 200
  // so the test deterministically reaches the body-shape assertions, even
  // though `webhookUrl` is structurally invalid for `new URL()`.
  let captured;
  let fetchCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    fetchCalls += 1;
    captured = JSON.parse(init.body);
    return new Response('{}', { status: 200 });
  };

  const r = await sendAlert({
    severity: 'critical',
    body: { chain: 'avax', operator: '0xabc' },
    webhookUrl: 'not-a-valid-url',
  });

  // sendAlert must return a result object without throwing.
  assert.equal(typeof r, 'object');
  assert.ok('sent' in r);
  // The URL-parse failure means the raw-JSON branch is taken; fetch must
  // have been called once with the structurally-invalid URL.
  assert.equal(fetchCalls, 1, 'fetch must be called exactly once');
  assert.ok(captured, 'fetch body must be captured (mock always succeeds)');
  // The body MUST be raw (NOT Discord-shaped) because URL-parse failed.
  assert.ok(!('username' in captured), 'malformed URL must not reshape to Discord');
  assert.ok(!('embeds' in captured), 'malformed URL must not reshape to Discord');
  // Raw-shape sanity: severity / chain / operator must be top-level.
  assert.equal(captured.severity, 'critical');
  assert.equal(captured.chain, 'avax');
  assert.equal(captured.operator, '0xabc');
});

test('T-AL-DISC-07: formatForDiscord pure function — direct shape assertion', () => {
  const out = formatForDiscord({
    severity: 'critical',
    body: {
      event: 'bearer-rotation-failed',
      reason: 'rolled back',
      rotatedAt: '2026-05-01T09:00:00.000Z',
      chain: 'avax',
      operator: '0xabc',
    },
  });
  assert.equal(out.username, 'wasiai-alerts');
  assert.equal(out.embeds.length, 1);
  assert.equal(out.embeds[0].title, '[critical] bearer-rotation-failed');
  assert.equal(out.embeds[0].description, 'rolled back');
  assert.equal(out.embeds[0].color, 15158332);
  assert.equal(out.embeds[0].timestamp, '2026-05-01T09:00:00.000Z');
  const names = out.embeds[0].fields.map((f) => f.name).sort();
  assert.deepEqual(names, ['chain', 'operator']);
});

test('T-AL-DISC-08: HTTP 429 (rate-limited) → {sent:false, status:429, reason} no throw (WKH-91 AC-9)', async () => {
  // WKH-91 AC-9: when the webhook responds with 429 (Discord rate-limit),
  // sendAlert MUST return the exact triple shape without throwing.
  globalThis.fetch = async () => new Response('Too Many Requests', { status: 429 });

  const r = await sendAlert({
    severity: 'critical',
    body: { chain: 'avax', operator: '0xabc', balanceUsdc: 0.1 },
    webhookUrl: 'https://discord.com/api/webhooks/123/abc',
  });

  assert.equal(r.sent, false);
  assert.equal(r.status, 429);
  assert.equal(r.reason, 'webhook status 429');
  // Defensive: result keys are exactly {sent, status, reason} (no surprise extras).
  assert.deepEqual(Object.keys(r).sort(), ['reason', 'sent', 'status']);
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
