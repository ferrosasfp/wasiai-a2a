// cron-health-check.test.mjs — WKH-77 health monitor cron handler.
//
// Integration-style: mocks the outbound health GET + webhook via global fetch,
// asserting auth, the alert body whitelist (CD-4), dryRun test-alert (AC-6),
// per-service isolation (AC-7) and always-200 fail-open (CD-2).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { resetWarnOnce } from '../src/log.mjs';

const TEST_SECRET = 'cron-secret-' + 'a'.repeat(20);

let origFetch;

function makeReq({ auth = `Bearer ${TEST_SECRET}`, url = '/api/cron/health-check' } = {}) {
  return { headers: auth === null ? {} : { authorization: auth }, method: 'GET', url };
}

function makeRes() {
  let statusCode = 200;
  let body = '';
  const headers = {};
  return {
    get statusCode() { return statusCode; },
    set statusCode(v) { statusCode = v; },
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    end(c) { body = c ?? ''; },
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

const TARGETS_JSON = JSON.stringify([
  { label: 'gateway-a2a', url: 'https://gw.test/health', tier: 'P0', healthyField: 'status', healthyValue: 'ok' },
  { label: 'facilitator', url: 'https://fac.test/health', tier: 'P0', degradedPath: 'degraded' },
  { label: 'x402-mcp', url: 'https://mcp.test/', tier: 'P1', mode: 'reachability' },
  { label: 'app-wasiai', url: 'https://app.test/', tier: 'P1' },
]);

beforeEach(() => {
  origFetch = globalThis.fetch;
  process.env.CRON_SECRET = TEST_SECRET;
  resetWarnOnce();
});

afterEach(() => {
  globalThis.fetch = origFetch;
  delete process.env.CRON_SECRET;
  delete process.env.HEALTH_MONITOR_TARGETS;
  delete process.env.MCP_ALERT_WEBHOOK_URL;
  delete process.env.ONCALL_MENTION;
  delete process.env.HEALTH_MONITOR_TIMEOUT_MS;
});

async function loadHandler() {
  const mod = await import(
    `../api/cron/health-check.mjs?t=${Date.now()}_${Math.random()}`
  );
  return mod.default;
}

test('T-HC-01: auth missing → 401, NO outbound fetch', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  process.env.HEALTH_MONITOR_TARGETS = TARGETS_JSON;
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq({ auth: null }), res);
    assert.equal(res.statusCode, 401);
    assert.equal(calls, 0, 'auth-fail must not probe any service');
  } finally {
    cap.restore();
  }
});

test('T-HC-02: no targets configured → 200 checked:0 (fail-open)', async () => {
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.checked, 0);
    assert.match(cap.lines.join('\n'), /mcp\.health-cron\.no-targets/);
  } finally {
    cap.restore();
  }
});

test('T-HC-03: mixed health → correct alerts, isolation, 200; webhook bodies whitelisted', async () => {
  process.env.HEALTH_MONITOR_TARGETS = TARGETS_JSON;
  process.env.MCP_ALERT_WEBHOOK_URL = 'https://hooks.test/x';

  const webhookBodies = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('hooks.test')) {
      webhookBodies.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }
    // gateway healthy (status ok)
    if (u.includes('gw.test')) return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    // facilitator degraded (200 but degraded:true) → warning
    if (u.includes('fac.test')) return new Response(JSON.stringify({ degraded: true }), { status: 200 });
    // x402-mcp returns 404 (reachability → alive, no alert)
    if (u.includes('mcp.test')) return new Response('not found', { status: 404 });
    // app down (500) → warning P1
    if (u.includes('app.test')) return new Response('err', { status: 500 });
    throw new Error('unexpected url ' + u);
  };

  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.checked, 4);
    // facilitator degraded (warning) + app down (warning) = 2 alerts.
    assert.equal(body.alerts, 2);
    assert.equal(webhookBodies.length, 2);

    const byService = Object.fromEntries(webhookBodies.map((b) => [b.service, b]));
    assert.equal(byService['facilitator'].severity, 'warning');
    assert.equal(byService['facilitator'].reason, 'health-degraded');
    assert.equal(byService['app-wasiai'].severity, 'warning');
    assert.equal(byService['app-wasiai'].httpStatus, 500);
    // No secrets in any webhook body.
    for (const b of webhookBodies) {
      assert.ok(!('CRON_SECRET' in b));
      assert.ok(!('privateKey' in b));
    }
    // gateway healthy + mcp 404 (reachability) → NOT alerted.
    assert.ok(!('gateway-a2a' in byService));
    assert.ok(!('x402-mcp' in byService));
  } finally {
    cap.restore();
  }
});

test('T-HC-04: P0 down + ONCALL_MENTION on Discord webhook → push content present', async () => {
  process.env.HEALTH_MONITOR_TARGETS = JSON.stringify([
    { label: 'gateway-a2a', url: 'https://gw.test/health', tier: 'P0', healthyField: 'status', healthyValue: 'ok' },
  ]);
  process.env.MCP_ALERT_WEBHOOK_URL = 'https://discord.com/api/webhooks/1/abc';
  process.env.ONCALL_MENTION = '<@123456789012345678>';

  let webhookBody = null;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('discord.com')) { webhookBody = JSON.parse(init.body); return new Response('{}', { status: 200 }); }
    // gateway down (503) → critical P0
    return new Response('down', { status: 503 });
  };

  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200);
    assert.ok(webhookBody);
    assert.equal(typeof webhookBody.content, 'string');
    assert.ok(webhookBody.content.startsWith('<@123456789012345678> '));
    assert.ok(Array.isArray(webhookBody.embeds));
  } finally {
    cap.restore();
  }
});

test('T-HC-05: dryRun=1 → synthetic alert per target, still auth-gated, 200', async () => {
  process.env.HEALTH_MONITOR_TARGETS = TARGETS_JSON;
  process.env.MCP_ALERT_WEBHOOK_URL = 'https://hooks.test/x';

  let probes = 0;
  const webhookBodies = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('hooks.test')) { webhookBodies.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); }
    probes += 1;
    return new Response('{}', { status: 200 });
  };

  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq({ url: '/api/cron/health-check?dryRun=1' }), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.dryRun, true);
    assert.equal(probes, 0, 'dryRun must not probe real services');
    // One synthetic alert per configured target.
    assert.equal(webhookBodies.length, 4);
    for (const b of webhookBodies) assert.equal(b.reason, 'health-test-alert');
  } finally {
    cap.restore();
  }
});

test('T-HC-06: webhook failure → cron still 200 (CD-2 fail-open)', async () => {
  process.env.HEALTH_MONITOR_TARGETS = JSON.stringify([
    { label: 'app-wasiai', url: 'https://app.test/', tier: 'P1' },
  ]);
  process.env.MCP_ALERT_WEBHOOK_URL = 'https://hooks.test/x';
  globalThis.fetch = async (url) => {
    if (String(url).includes('hooks.test')) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    return new Response('err', { status: 500 }); // app down
  };
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200, 'cron must NOT 500 on webhook failure');
  } finally {
    cap.restore();
  }
});

test('T-HC-07: a hung/timeout service does not block the others (AC-7), 200', async () => {
  process.env.HEALTH_MONITOR_TARGETS = JSON.stringify([
    { label: 'slow', url: 'https://slow.test/health', tier: 'P0' },
    { label: 'ok', url: 'https://ok.test/health', tier: 'P0' },
  ]);
  process.env.MCP_ALERT_WEBHOOK_URL = 'https://hooks.test/x';
  const webhookBodies = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('hooks.test')) { webhookBodies.push(JSON.parse(init.body)); return new Response('{}', { status: 200 }); }
    if (u.includes('slow.test')) { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; }
    return new Response(JSON.stringify({}), { status: 200 }); // ok healthy
  };

  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.checked, 2);
    // slow → timeout alert; ok → healthy (no alert).
    assert.equal(webhookBodies.length, 1);
    assert.equal(webhookBodies[0].service, 'slow');
    assert.equal(webhookBodies[0].reason, 'health-timeout');
  } finally {
    cap.restore();
  }
});
