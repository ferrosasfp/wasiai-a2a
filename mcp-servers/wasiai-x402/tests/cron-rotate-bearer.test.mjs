// cron-rotate-bearer.test.mjs — WKH-75 W3 (T-CRO-01..T-CRO-05).
//
// Tests the cron endpoint api/cron/rotate-bearer.mjs end-to-end with mocked
// fetch (Vercel API + alert webhook) and a kv-mock. CD-7: 100% mock; no real
// HTTP. CD-3: no real bearers / tokens in tests.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  setKvClientForTesting,
  resetKvClient,
} from '../src/kv-client.mjs';
import { resetWarnOnce } from '../src/log.mjs';
import { createKvMock } from './_mocks/kv-mock.mjs';

const TEST_SECRET = 'cron-secret-' + 'a'.repeat(20);
const TEST_VERCEL_TOKEN = 'vercel_token_unit_test_must_not_leak_xxxxxxxxxx';
const TEST_PROJECT = 'prj_test_rotation_cron';
const TEST_TEAM = 'team_test_rotation_cron';
const FIXTURE_CURRENT_BEARER = 'cafebabe' + '0'.repeat(56);

let origFetch;

function makeReq({ auth = `Bearer ${TEST_SECRET}` } = {}) {
  return {
    headers: auth === null ? {} : { authorization: auth },
    method: 'POST',
  };
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
    get _headers() { return headers; },
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

function makeVercelMock({ envs = [], failOn = {} } = {}) {
  const calls = [];
  const state = { envs: envs.map((e) => ({ ...e })), nextEnvId: 2000 };
  function respond(opName, body, statusOverride) {
    if (failOn[opName]) {
      const status = typeof failOn[opName] === 'number' ? failOn[opName] : 500;
      return new Response(
        JSON.stringify({ error: { code: 'mock_fail' } }),
        { status, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify(body ?? {}),
      { status: statusOverride ?? 200, headers: { 'content-type': 'application/json' } },
    );
  }
  globalThis.fetch = async (url, init = {}) => {
    const u = typeof url === 'string' ? new URL(url) : new URL(url.toString());
    const method = init.method ?? 'GET';
    if (u.host !== 'api.vercel.com') {
      // Webhook (alert) — record + 200.
      return new Response('{}', { status: 200 });
    }
    calls.push({
      url: u.toString(),
      host: u.host,
      pathname: u.pathname,
      method,
      teamId: u.searchParams.get('teamId'),
    });
    if (method === 'GET' && u.pathname.endsWith('/env')) {
      return respond('listEnvs', { envs: state.envs });
    }
    if (method === 'POST' && u.pathname.endsWith('/env')) {
      const id = `env_${state.nextEnvId++}`;
      const body = init.body ? JSON.parse(init.body) : {};
      const created = { id, key: body.key, value: body.value, target: ['production'], type: 'encrypted' };
      if (!failOn.createEnv) state.envs.push(created);
      return respond('createEnv', { id, created });
    }
    if (method === 'PATCH' && u.pathname.includes('/env/')) {
      const envId = u.pathname.split('/env/')[1];
      const target = state.envs.find((e) => e.id === envId);
      const body = init.body ? JSON.parse(init.body) : {};
      if (target && !failOn.updateEnv) target.value = body.value;
      return respond('updateEnv', { id: envId });
    }
    if (method === 'DELETE' && u.pathname.includes('/env/')) {
      const envId = u.pathname.split('/env/')[1];
      const idx = state.envs.findIndex((e) => e.id === envId);
      if (idx >= 0 && !failOn.deleteEnv) state.envs.splice(idx, 1);
      return respond('deleteEnv', null, 200);
    }
    if (method === 'POST' && u.pathname === '/v13/deployments') {
      return respond('triggerRedeploy', { id: 'dpl_mock', url: 'mock.vercel.app' });
    }
    return new Response(JSON.stringify({ error: 'unhandled' }), { status: 500 });
  };
  return { calls, state };
}

async function loadHandler() {
  const mod = await import(`../api/cron/rotate-bearer.mjs?t=${Date.now()}_${Math.random()}`);
  return mod.default;
}

beforeEach(() => {
  origFetch = globalThis.fetch;
  process.env.CRON_SECRET = TEST_SECRET;
  process.env.VERCEL_TOKEN = TEST_VERCEL_TOKEN;
  process.env.VERCEL_PROJECT_ID = TEST_PROJECT;
  process.env.VERCEL_TEAM_ID = TEST_TEAM;
  resetWarnOnce();
});

afterEach(() => {
  globalThis.fetch = origFetch;
  resetKvClient();
  delete process.env.CRON_SECRET;
  delete process.env.VERCEL_TOKEN;
  delete process.env.VERCEL_PROJECT_ID;
  delete process.env.VERCEL_TEAM_ID;
  delete process.env.MCP_ALERT_WEBHOOK_URL;
});

test('T-CRO-01: rotate-bearer no auth header → 401', async () => {
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = makeReq({ auth: null });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res._body);
    assert.deepEqual(body, { error: 'unauthorized' });
    // Negative log assertion: rotation MUST NOT have run.
    const blob = cap.lines.join('\n');
    assert.ok(!/mcp\.cron\.rotate-bearer\.ok/.test(blob));
    assert.match(blob, /mcp\.cron\.unauthorized/);
    // CD-9: secret must NEVER appear in logs.
    assert.ok(!blob.includes(TEST_SECRET));
    assert.ok(!blob.includes(TEST_VERCEL_TOKEN));
  } finally {
    cap.restore();
  }
});

test('T-CRO-02: rotate-bearer CRON_SECRET unset → 500 server misconfigured', async () => {
  delete process.env.CRON_SECRET;
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 500);
    const body = JSON.parse(res._body);
    assert.deepEqual(body, { error: 'server misconfigured' });
    const blob = cap.lines.join('\n');
    assert.match(blob, /mcp\.cron\.unauthorized/);
  } finally {
    cap.restore();
  }
});

test('T-CRO-03: rotate-bearer VERCEL_TOKEN missing → 500 server misconfigured', async () => {
  delete process.env.VERCEL_TOKEN;
  const kv = createKvMock();
  setKvClientForTesting(kv);
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response('{}', { status: 200 });
  };
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 500);
    const body = JSON.parse(res._body);
    assert.deepEqual(body, { error: 'server misconfigured' });
    // Server-config gate must trip BEFORE any fetch.
    assert.equal(fetchCalls, 0, 'must NOT call Vercel API when config missing');
    const blob = cap.lines.join('\n');
    assert.match(blob, /mcp\.cron\.rotate-bearer-error/);
    assert.match(blob, /VERCEL_TOKEN/);
  } finally {
    cap.restore();
  }
});

test('T-CRO-04: rotate-bearer happy path → 200 + KV snapshot', async () => {
  const kv = createKvMock();
  setKvClientForTesting(kv);
  const mock = makeVercelMock({
    envs: [
      {
        id: 'env_current',
        key: 'MCP_BEARER_TOKEN',
        value: FIXTURE_CURRENT_BEARER,
        target: ['production'],
        type: 'encrypted',
      },
    ],
  });
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res._headers['content-type'], 'application/json');
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.match(body.rotatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(body.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // 24h overlap window.
    assert.equal(
      Date.parse(body.expiresAt) - Date.parse(body.rotatedAt),
      24 * 60 * 60 * 1000,
    );
    // Vercel API was called: at least listEnvs + createEnv + updateEnv.
    const methods = mock.calls.map((c) => c.method);
    assert.ok(methods.includes('GET'));
    assert.ok(methods.includes('POST'));
    assert.ok(methods.includes('PATCH'));
    // teamId scoping respected.
    for (const c of mock.calls) {
      assert.equal(c.host, 'api.vercel.com');
      assert.equal(c.teamId, TEST_TEAM);
    }
    // KV snapshot persisted with TTL ~25h.
    const kvEntry = kv._store.get('last-bearer-rotation');
    assert.ok(kvEntry, 'snapshot must be in KV');
    const blob = JSON.parse(kvEntry.value);
    assert.equal(blob.rotatedAt, body.rotatedAt);
    assert.equal(blob.expiresAt, body.expiresAt);
    // CD-9: secrets must NEVER appear in stderr logs.
    const stderrBlob = cap.lines.join('\n');
    assert.ok(!stderrBlob.includes(TEST_SECRET), 'CRON_SECRET leaked');
    assert.ok(!stderrBlob.includes(TEST_VERCEL_TOKEN), 'VERCEL_TOKEN leaked');
    assert.ok(!stderrBlob.includes(FIXTURE_CURRENT_BEARER), 'current bearer leaked');
    // Outcome event present.
    assert.match(stderrBlob, /mcp\.cron\.rotate-bearer\.ok/);
  } finally {
    cap.restore();
  }
});

test('T-MTHD-01 (WKH-88): rotate-bearer GET → 405, NO auth log, NO Vercel call', async () => {
  // CD-WKH88-1: req.method check MUST run BEFORE validateCronSecret. Wrong-
  // method probes (health-checks, GET preflights, browser fat-fingers) MUST
  // NOT produce 'mcp.cron.unauthorized' log lines — that would generate
  // spurious alerts. Behaviour: 405 + Allow:POST header + body
  // {error:'method not allowed'}, no Vercel API call regardless of CRON_SECRET
  // validity.
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; return new Response('{}', { status: 200 }); };
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    // Use a valid CRON_SECRET — even with valid auth, GET MUST NOT proceed.
    const req = { headers: { authorization: `Bearer ${TEST_SECRET}` }, method: 'GET' };
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 405);
    assert.equal(res._headers['allow'], 'POST');
    assert.equal(res._headers['content-type'], 'application/json');
    const body = JSON.parse(res._body);
    assert.deepEqual(body, { error: 'method not allowed' });
    // CD-WKH88-1: NO auth-related log lines — neither success nor failure.
    const blob = cap.lines.join('\n');
    assert.ok(!/mcp\.cron\.unauthorized/.test(blob), 'must NOT log auth event on wrong method');
    assert.ok(!/mcp\.cron\.rotate-bearer\.ok/.test(blob), 'must NOT log success event on wrong method');
    assert.ok(!/mcp\.cron\.rotate-bearer\.failed/.test(blob), 'must NOT log failure event on wrong method');
    // Method gate trips BEFORE any Vercel API call.
    assert.equal(fetchCalls, 0, 'no Vercel call on wrong method');
    // CD-9 still applies: secret must NEVER appear in stderr even on rejected
    // requests (defence in depth).
    assert.ok(!blob.includes(TEST_SECRET));
  } finally {
    cap.restore();
  }
});

test('T-CRO-05: rotate-bearer rotation failure (listEnvs 500) → 500 + failure body', async () => {
  const kv = createKvMock();
  setKvClientForTesting(kv);
  process.env.MCP_ALERT_WEBHOOK_URL = 'https://hooks.example.com/rotation';
  const alertCalls = [];
  globalThis.fetch = (() => {
    const inner = makeVercelMock({
      envs: [
        {
          id: 'env_current',
          key: 'MCP_BEARER_TOKEN',
          value: FIXTURE_CURRENT_BEARER,
          target: ['production'],
          type: 'encrypted',
        },
      ],
      failOn: { listEnvs: 500 },
    });
    const original = globalThis.fetch;
    return async (url, init = {}) => {
      const u = typeof url === 'string' ? new URL(url) : new URL(url.toString());
      if (u.host === 'hooks.example.com') {
        let body;
        try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body; }
        alertCalls.push({ host: u.host, body });
        return new Response('{}', { status: 200 });
      }
      return original(url, init);
    };
  })();
  // Replace with vercel mock that fails listEnvs.
  makeVercelMock({
    envs: [
      {
        id: 'env_current',
        key: 'MCP_BEARER_TOKEN',
        value: FIXTURE_CURRENT_BEARER,
        target: ['production'],
        type: 'encrypted',
      },
    ],
    failOn: { listEnvs: 500 },
  });
  // Now wrap the vercel fetch to also capture alerts.
  const innerFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = typeof url === 'string' ? new URL(url) : new URL(url.toString());
    if (u.host === 'hooks.example.com') {
      let body;
      try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body; }
      alertCalls.push({ host: u.host, body });
      return new Response('{}', { status: 200 });
    }
    return innerFetch(url, init);
  };

  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 500);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, false);
    assert.equal(body.stage, 'list-envs');
    assert.ok(typeof body.error === 'string' && body.error.length > 0);
    // Alert must have been dispatched by rotateBearer (CD-6).
    assert.equal(alertCalls.length, 1, 'rotateBearer should fire alert on critical failure');
    assert.equal(alertCalls[0].body.severity, 'critical');
    // Alert body MUST NOT carry the bearer/token (CD-9).
    const serializedAlert = JSON.stringify(alertCalls[0].body);
    assert.ok(!serializedAlert.includes(TEST_VERCEL_TOKEN));
    assert.ok(!serializedAlert.includes(FIXTURE_CURRENT_BEARER));
    // Stderr must show the failure event but NOT the secrets.
    const blob = cap.lines.join('\n');
    assert.match(blob, /mcp\.cron\.rotate-bearer\.failed/);
    assert.ok(!blob.includes(TEST_VERCEL_TOKEN));
    assert.ok(!blob.includes(FIXTURE_CURRENT_BEARER));
  } finally {
    cap.restore();
  }
});
