// cron-synthetic-tx-check.test.mjs — WKH-74 capa D cron handler.
//
// Integration-style: mocks the Railway GraphQL deploy-id query + the real-tx
// /orchestrate probe + webhook via global fetch, and the KV via kv-mock. Asserts
// auth (CD-2), the spend gate (AC-5 unchanged → no tx), the pass path (AC-3 tx +
// KV advance), the fail path (AC-4 alert + KV untouched), the dedicated key
// header (CD-6) and always-200 fail-open (CD-3).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { resetWarnOnce } from '../src/log.mjs';
import { setKvClientForTesting, resetKvClient } from '../src/kv-client.mjs';
import { createKvMock } from './_mocks/kv-mock.mjs';
import { KV_KEYS } from '../src/kv-keys.mjs';

const TEST_SECRET = 'cron-secret-' + 'a'.repeat(20);
const MONITOR_KEY = 'wasi_a2a_' + 'k'.repeat(20);
const PROBE_URL = 'https://gw.test/orchestrate';
const RAILWAY_URL = 'https://backboard.railway.app/graphql/v2';
const TX = '0x' + 'a'.repeat(64);

let origFetch;

function makeReq({ auth = `Bearer ${TEST_SECRET}`, url = '/api/cron/synthetic-tx-check' } = {}) {
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

function railwayResponse(deployId) {
  return new Response(
    JSON.stringify({ data: { deployments: { edges: [{ node: { id: deployId, status: 'SUCCESS' } }] } } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

// Multi-edge Railway response (MNR-3): the API returns up to 5 deploys newest
// first; nodes = [{ id, status }, ...] in that order.
function railwayEdges(nodes) {
  return new Response(
    JSON.stringify({ data: { deployments: { edges: nodes.map((node) => ({ node })) } } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function orchestrateOk() {
  return new Response(
    JSON.stringify({ kiteTxHash: TX, pipeline: { success: true, steps: [] } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

// Wire a fetch router. `onProbe` captures the real-tx probe init; `deployId`
// drives the Railway response; `orchestrateResp` overrides the probe response.
function routeFetch({ deployId = 'dep-1', orchestrateResp = orchestrateOk, railwayResp, onProbe, onWebhook } = {}) {
  return async (url, init = {}) => {
    const u = String(url);
    if (u.includes('backboard.railway.app')) return railwayResp ? railwayResp() : railwayResponse(deployId);
    if (u.includes('hooks.example.com')) {
      if (onWebhook) onWebhook(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }
    if (u.includes('/orchestrate')) {
      if (onProbe) onProbe(init);
      return orchestrateResp();
    }
    throw new Error(`unexpected fetch ${u}`);
  };
}

function setEnv() {
  process.env.CRON_SECRET = TEST_SECRET;
  process.env.SYNTH_ORCHESTRATE_URL = PROBE_URL;
  process.env.MONITOR_A2A_KEY = MONITOR_KEY;
  process.env.RAILWAY_TOKEN = 'rw-token-secret';
  process.env.RAILWAY_PROJECT_ID = 'proj-1';
  process.env.RAILWAY_ENVIRONMENT_ID = 'env-1';
  process.env.RAILWAY_SERVICE_ID = 'svc-1';
}

beforeEach(() => {
  origFetch = globalThis.fetch;
  resetWarnOnce();
  resetKvClient();
});

afterEach(() => {
  globalThis.fetch = origFetch;
  resetKvClient();
  for (const k of [
    'CRON_SECRET', 'SYNTH_ORCHESTRATE_URL', 'MONITOR_A2A_KEY', 'MONITOR_TX_GOAL',
    'MONITOR_TX_BUDGET', 'RAILWAY_TOKEN', 'RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID',
    'RAILWAY_SERVICE_ID', 'MCP_ALERT_WEBHOOK_URL', 'ONCALL_MENTION',
  ]) delete process.env[k];
});

async function loadHandler() {
  const mod = await import(
    `../api/cron/synthetic-tx-check.mjs?t=${Date.now()}_${Math.random()}`
  );
  return mod.default;
}

test('T-STC-01: auth missing → 401, NO outbound fetch', async () => {
  setEnv();
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  setKvClientForTesting(createKvMock());
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq({ auth: null }), res);
    assert.equal(res.statusCode, 401);
    assert.equal(calls, 0);
  } finally { cap.restore(); }
});

test('T-STC-02: unconfigured (no key/railway) → 200 no-op', async () => {
  process.env.CRON_SECRET = TEST_SECRET;
  process.env.SYNTH_ORCHESTRATE_URL = PROBE_URL;
  // MONITOR_A2A_KEY + RAILWAY_* unset.
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  setKvClientForTesting(createKvMock());
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res._body).reason, 'not-configured');
    assert.match(cap.lines.join('\n'), /mcp\.synth-tx-cron\.not-configured/);
  } finally { cap.restore(); }
});

test('T-STC-03: AC-5 — deploy id unchanged → 200, NO real-tx', async () => {
  setEnv();
  const kv = createKvMock();
  await kv.set(KV_KEYS.SYNTH_LAST_DEPLOY, 'dep-SAME');
  setKvClientForTesting(kv);
  let probes = 0;
  globalThis.fetch = routeFetch({ deployId: 'dep-SAME', onProbe: () => { probes += 1; } });
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res._body).ran, false);
    assert.equal(probes, 0, 'must NOT run a real-tx when deploy unchanged');
  } finally { cap.restore(); }
});

test('T-STC-04: AC-3 — deploy changed → real-tx with x-a2a-key, KV advanced', async () => {
  setEnv();
  const kv = createKvMock();
  await kv.set(KV_KEYS.SYNTH_LAST_DEPLOY, 'dep-OLD');
  setKvClientForTesting(kv);
  let probeInit = null;
  globalThis.fetch = routeFetch({ deployId: 'dep-NEW', onProbe: (init) => { probeInit = init; } });
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ran, true);
    assert.equal(body.ok, true);
    // CD-6: the dedicated monitoring Agent Key is sent as x-a2a-key.
    const hdrs = Object.fromEntries(
      Object.entries(probeInit.headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    assert.equal(hdrs['x-a2a-key'], MONITOR_KEY);
    // KV advanced to the validated deploy id.
    assert.equal(await kv.get(KV_KEYS.SYNTH_LAST_DEPLOY), 'dep-NEW');
  } finally { cap.restore(); }
});

test('T-STC-04b: AC-3 — REAL agent-key shape (steps[].txHash, NO top-level kiteTxHash) → OK, KV advanced', async () => {
  setEnv();
  const kv = createKvMock();
  await kv.set(KV_KEYS.SYNTH_LAST_DEPLOY, 'dep-OLD');
  setKvClientForTesting(kv);
  globalThis.fetch = routeFetch({
    deployId: 'dep-NEW',
    // Production prepago shape: no top-level kiteTxHash — the settle proof is a
    // downstream step. This is what the real agent-key /orchestrate API emits.
    orchestrateResp: () => new Response(
      JSON.stringify({ pipeline: { success: true, steps: [{ txHash: TX }] } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  });
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ran, true);
    assert.equal(body.ok, true);
    // KV advanced — the steps[].txHash counted as valid on-chain proof.
    assert.equal(await kv.get(KV_KEYS.SYNTH_LAST_DEPLOY), 'dep-NEW');
  } finally { cap.restore(); }
});

test('T-STC-05: AC-4 — real-tx fails (no tx hash) → alert, KV NOT advanced, 200', async () => {
  setEnv();
  process.env.MCP_ALERT_WEBHOOK_URL = 'https://hooks.example.com/x';
  const kv = createKvMock();
  await kv.set(KV_KEYS.SYNTH_LAST_DEPLOY, 'dep-OLD');
  setKvClientForTesting(kv);
  let webhookBody = null;
  globalThis.fetch = routeFetch({
    deployId: 'dep-NEW',
    orchestrateResp: () => new Response(
      JSON.stringify({ pipeline: { success: true, steps: [] } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
    onWebhook: (b) => { webhookBody = b; },
  });
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res._body).ok, false);
    assert.ok(webhookBody, 'webhook should fire');
    assert.equal(webhookBody.reason, 'post-deploy-synthetic-tx-failed');
    // AC-4: KV left at OLD so the probe retries next tick.
    assert.equal(await kv.get(KV_KEYS.SYNTH_LAST_DEPLOY), 'dep-OLD');
    // CD-7: no secret in the alert body.
    assert.ok(!('MONITOR_A2A_KEY' in webhookBody));
  } finally { cap.restore(); }
});

test('T-STC-06: CD-3 — Railway deploy-id query fails → 200 skip, no probe', async () => {
  setEnv();
  const kv = createKvMock();
  setKvClientForTesting(kv);
  let probes = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('backboard.railway.app')) return new Response('err', { status: 500 });
    probes += 1;
    return orchestrateOk();
  };
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res._body).reason, 'deploy-id-unavailable');
    assert.equal(probes, 0, 'no real-tx when deploy id unreadable');
  } finally { cap.restore(); }
});

test('T-STC-07: CD-3 — no KV configured → 200 no-op, no probe', async () => {
  setEnv();
  // No setKvClientForTesting → getKvClient returns null (env KV unset).
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response('{}', { status: 200 }); };
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res._body).reason, 'kv-not-configured');
    assert.equal(calls, 0);
  } finally { cap.restore(); }
});

test('T-STC-08: MNR-3 — latest deploy BUILDING + a SUCCESS below → gates on the SUCCESS', async () => {
  setEnv();
  const kv = createKvMock();
  await kv.set(KV_KEYS.SYNTH_LAST_DEPLOY, 'dep-OLD');
  setKvClientForTesting(kv);
  let probes = 0;
  globalThis.fetch = routeFetch({
    railwayResp: () => railwayEdges([
      { id: 'dep-BUILDING', status: 'BUILDING' },
      { id: 'dep-SUCCESS', status: 'SUCCESS' },
    ]),
    onProbe: () => { probes += 1; },
  });
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res._body).ran, true);
    assert.equal(probes, 1);
    // KV advanced to the SUCCESS id, NOT the BUILDING one at the top.
    assert.equal(await kv.get(KV_KEYS.SYNTH_LAST_DEPLOY), 'dep-SUCCESS');
  } finally { cap.restore(); }
});

test('T-STC-09: MNR-3 — no SUCCESS among returned deploys → skip, NO real-tx, KV untouched', async () => {
  setEnv();
  const kv = createKvMock();
  await kv.set(KV_KEYS.SYNTH_LAST_DEPLOY, 'dep-OLD');
  setKvClientForTesting(kv);
  let probes = 0;
  globalThis.fetch = routeFetch({
    railwayResp: () => railwayEdges([
      { id: 'dep-BUILDING', status: 'BUILDING' },
      { id: 'dep-FAILED', status: 'FAILED' },
    ]),
    onProbe: () => { probes += 1; },
  });
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res._body).reason, 'deploy-id-unavailable');
    assert.equal(probes, 0, 'no spend when no SUCCESS deploy exists');
    assert.equal(await kv.get(KV_KEYS.SYNTH_LAST_DEPLOY), 'dep-OLD');
  } finally { cap.restore(); }
});
