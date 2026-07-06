// cron-synthetic-payment-check.test.mjs — WKH-74 capa A cron handler.
//
// Integration-style: mocks the outbound /orchestrate probe + webhook via global
// fetch, asserting auth (CD-2), the "naked" no-payment-header probe (CD-4), the
// 402-expected happy path, the broken-path alert (AC-2), the alert body
// whitelist (CD-7) and always-200 fail-open (CD-3).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { resetWarnOnce } from '../src/log.mjs';

const TEST_SECRET = 'cron-secret-' + 'a'.repeat(20);
const PAYTO = '0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba';
const ASSET = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9';
const NETWORK = 'eip155:2368';
const PROBE_URL = 'https://gw.test/orchestrate';

let origFetch;

function makeReq({ auth = `Bearer ${TEST_SECRET}`, url = '/api/cron/synthetic-payment-check' } = {}) {
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

function challengeBody(overrides = {}) {
  return JSON.stringify({
    error: 'payment required',
    x402Version: 2,
    accepts: [{ scheme: 'exact', payTo: PAYTO, asset: ASSET, network: NETWORK, maxAmountRequired: '10000', ...overrides }],
  });
}

function setExpectEnv() {
  process.env.SYNTH_ORCHESTRATE_URL = PROBE_URL;
  process.env.SYNTH_EXPECT_PAYTO = PAYTO;
  process.env.SYNTH_EXPECT_ASSET = ASSET;
  process.env.SYNTH_EXPECT_NETWORK = NETWORK;
}

beforeEach(() => {
  origFetch = globalThis.fetch;
  process.env.CRON_SECRET = TEST_SECRET;
  resetWarnOnce();
});

afterEach(() => {
  globalThis.fetch = origFetch;
  delete process.env.CRON_SECRET;
  delete process.env.SYNTH_ORCHESTRATE_URL;
  delete process.env.SYNTH_EXPECT_PAYTO;
  delete process.env.SYNTH_EXPECT_ASSET;
  delete process.env.SYNTH_EXPECT_NETWORK;
  delete process.env.SYNTH_PROBE_GOAL;
  delete process.env.SYNTH_PROBE_BUDGET;
  delete process.env.MCP_ALERT_WEBHOOK_URL;
  delete process.env.ONCALL_MENTION;
});

async function loadHandler() {
  const mod = await import(
    `../api/cron/synthetic-payment-check.mjs?t=${Date.now()}_${Math.random()}`
  );
  return mod.default;
}

test('T-SPC-01: auth missing → 401, NO outbound probe', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  setExpectEnv();
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq({ auth: null }), res);
    assert.equal(res.statusCode, 401);
    assert.equal(calls, 0, 'auth-fail must not probe');
  } finally { cap.restore(); }
});

test('T-SPC-02: unconfigured (no URL/expected) → 200 checked:0 (fail-open)', async () => {
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res._body).checked, 0);
    assert.match(cap.lines.join('\n'), /mcp\.synth-payment-cron\.not-configured/);
  } finally { cap.restore(); }
});

test('T-SPC-03: expected 402 challenge → 200 ok, NO payment header sent (CD-4)', async () => {
  setExpectEnv();
  let seenInit = null;
  globalThis.fetch = async (url, init = {}) => {
    seenInit = init;
    return new Response(challengeBody(), { status: 402, headers: { 'content-type': 'application/json' } });
  };
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.severity, 'ok');
    assert.equal(body.alerts, 0);
    // CD-4: the probe carries ONLY content-type + user-agent — NO payment/auth
    // header of any kind.
    const hdrs = Object.fromEntries(
      Object.entries(seenInit.headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    assert.ok(!('x-a2a-key' in hdrs));
    assert.ok(!('authorization' in hdrs));
    assert.ok(!('x-payment' in hdrs));
    assert.ok(!('payment-signature' in hdrs));
    assert.equal(seenInit.method, 'POST');
  } finally { cap.restore(); }
});

test('T-SPC-04: 200 instead of 402 → critical alert, cron still 200', async () => {
  setExpectEnv();
  process.env.MCP_ALERT_WEBHOOK_URL = 'https://hooks.example.com/x';
  let webhookBody = null;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('hooks.example.com')) {
      webhookBody = JSON.parse(init.body);
      return new Response('{}', { status: 200 });
    }
    // The payment path is (wrongly) returning 200 — a broken free path.
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res._body).alerts, 1);
    assert.ok(webhookBody, 'webhook should fire');
    assert.equal(webhookBody.reason, 'synthetic-payment-path-broken');
    assert.equal(webhookBody.httpStatus, 200);
    // CD-7: no secret keys.
    assert.ok(!('MONITOR_A2A_KEY' in webhookBody));
    assert.ok(!('privateKey' in webhookBody));
  } finally { cap.restore(); }
});

test('T-SPC-05: 402 with wrong payTo → critical alert', async () => {
  setExpectEnv();
  process.env.MCP_ALERT_WEBHOOK_URL = 'https://hooks.example.com/x';
  let webhookBody = null;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('hooks.example.com')) {
      webhookBody = JSON.parse(init.body);
      return new Response('{}', { status: 200 });
    }
    return new Response(
      challengeBody({ payTo: '0x0000000000000000000000000000000000000009' }),
      { status: 402, headers: { 'content-type': 'application/json' } },
    );
  };
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res._body).alerts, 1);
    assert.equal(webhookBody.reason, 'synthetic-payment-path-broken');
  } finally { cap.restore(); }
});

test('T-SPC-06: probe network error → cron still 200 (CD-3 fail-open)', async () => {
  setExpectEnv();
  globalThis.fetch = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200, 'cron must not 500 on probe failure');
    assert.equal(JSON.parse(res._body).alerts, 1);
  } finally { cap.restore(); }
});
