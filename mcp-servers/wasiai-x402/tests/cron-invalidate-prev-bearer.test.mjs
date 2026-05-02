// cron-invalidate-prev-bearer.test.mjs — WKH-75 W3 (T-CIN-01..T-CIN-04).
//
// Tests api/cron/invalidate-prev-bearer.mjs with mocked fetch + kv-mock.

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
const TEST_PROJECT = 'prj_test_invalidate_cron';
const TEST_TEAM = 'team_test_invalidate_cron';
const FIXTURE_PREV_BEARER = 'deadbeef' + '0'.repeat(56);

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
  const state = { envs: envs.map((e) => ({ ...e })) };
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
    if (method === 'DELETE' && u.pathname.includes('/env/')) {
      const envId = u.pathname.split('/env/')[1];
      const idx = state.envs.findIndex((e) => e.id === envId);
      if (idx >= 0 && !failOn.deleteEnv) state.envs.splice(idx, 1);
      return respond('deleteEnv', null, 200);
    }
    if (method === 'POST' && u.pathname === '/v13/deployments') {
      return respond('triggerRedeploy', { id: 'dpl_mock' });
    }
    return new Response(JSON.stringify({ error: 'unhandled' }), { status: 500 });
  };
  return { calls, state };
}

async function loadHandler() {
  const mod = await import(`../api/cron/invalidate-prev-bearer.mjs?t=${Date.now()}_${Math.random()}`);
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
});

test('T-CIN-01: invalidate-prev-bearer no KV snapshot → 200 skipped', async () => {
  const kv = createKvMock();
  setKvClientForTesting(kv);
  // No data in KV.
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; return new Response('{}', { status: 200 }); };

  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.skipped, true);
    assert.equal(body.reason, 'no rotation snapshot');
    // Must NOT call Vercel API on no-snapshot path.
    assert.equal(fetchCalls, 0, 'no Vercel call when KV is empty');
  } finally {
    cap.restore();
  }
});

test('T-CIN-02: invalidate-prev-bearer overlap window still active → 200 skipped, NO delete', async () => {
  const kv = createKvMock();
  setKvClientForTesting(kv);
  const futureExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // +1h
  await kv.set(
    'last-bearer-rotation',
    JSON.stringify({
      rotatedAt: new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString(),
      expiresAt: futureExpiresAt,
    }),
    { ex: 25 * 60 * 60 },
  );
  const mock = makeVercelMock({
    envs: [
      {
        id: 'env_prev',
        key: 'MCP_BEARER_TOKEN_PREV',
        value: FIXTURE_PREV_BEARER,
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
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.skipped, true);
    assert.equal(body.reason, 'overlap window still active');
    // Must NOT have called Vercel (not even listEnvs).
    assert.equal(mock.calls.length, 0, 'no Vercel call when overlap still active');
    const blob = cap.lines.join('\n');
    assert.match(blob, /mcp\.cron\.invalidate-prev-bearer\.skipped/);
  } finally {
    cap.restore();
  }
});

test('T-CIN-03: invalidate-prev-bearer expiresAt past → DELETE + redeploy + 200', async () => {
  const kv = createKvMock();
  setKvClientForTesting(kv);
  const pastExpiresAt = new Date(Date.now() - 60 * 1000).toISOString(); // -1min
  await kv.set(
    'last-bearer-rotation',
    JSON.stringify({
      rotatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      expiresAt: pastExpiresAt,
    }),
    { ex: 25 * 60 * 60 },
  );
  const mock = makeVercelMock({
    envs: [
      {
        id: 'env_prev_to_delete',
        key: 'MCP_BEARER_TOKEN_PREV',
        value: FIXTURE_PREV_BEARER,
        target: ['production'],
        type: 'encrypted',
      },
      {
        id: 'env_current',
        key: 'MCP_BEARER_TOKEN',
        value: 'cafe' + '0'.repeat(60),
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
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.skipped, undefined);
    assert.match(body.invalidatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // DELETE must have hit the PREV envId.
    const deleteCall = mock.calls.find(
      (c) => c.method === 'DELETE' && c.pathname.endsWith('/env_prev_to_delete'),
    );
    assert.ok(deleteCall, 'DELETE on PREV env must have been issued');
    // Redeploy issued.
    const redeployCall = mock.calls.find(
      (c) => c.method === 'POST' && c.pathname === '/v13/deployments',
    );
    assert.ok(redeployCall, 'redeploy must have been triggered');
    // teamId scoping respected.
    for (const c of mock.calls) {
      assert.equal(c.host, 'api.vercel.com');
      assert.equal(c.teamId, TEST_TEAM);
    }
    // PREV env removed from mock state.
    const remaining = mock.state.envs.find((e) => e.key === 'MCP_BEARER_TOKEN_PREV');
    assert.equal(remaining, undefined);
    // Current env intact.
    const current = mock.state.envs.find((e) => e.key === 'MCP_BEARER_TOKEN');
    assert.ok(current, 'current bearer must still exist');
    // CD-9: secrets must never appear in stderr.
    const blob = cap.lines.join('\n');
    assert.ok(!blob.includes(TEST_VERCEL_TOKEN));
    assert.ok(!blob.includes(FIXTURE_PREV_BEARER));
    assert.match(blob, /mcp\.cron\.invalidate-prev-bearer\.ok/);
  } finally {
    cap.restore();
  }
});

test('T-CIN-04: invalidate-prev-bearer no auth header → 401, NO Vercel/KV touch', async () => {
  const kv = createKvMock();
  setKvClientForTesting(kv);
  // Pre-seed an expired snapshot — handler must NOT read it on auth fail.
  await kv.set(
    'last-bearer-rotation',
    JSON.stringify({
      rotatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
    }),
    { ex: 25 * 60 * 60 },
  );
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; return new Response('{}', { status: 200 }); };

  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = makeReq({ auth: null });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res._body);
    assert.deepEqual(body, { error: 'unauthorized' });
    // Auth must trip BEFORE any Vercel call.
    assert.equal(fetchCalls, 0, 'no Vercel call on auth fail');
    const blob = cap.lines.join('\n');
    assert.match(blob, /mcp\.cron\.unauthorized/);
    assert.ok(!/mcp\.cron\.invalidate-prev-bearer\.ok/.test(blob));
    assert.ok(!blob.includes(TEST_SECRET));
  } finally {
    cap.restore();
  }
});
