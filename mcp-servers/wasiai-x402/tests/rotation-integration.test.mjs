// SPDX-License-Identifier: MIT
// rotation-integration.test.mjs — WKH-75 W5 (T-INT-01..T-INT-04).
//
// End-to-end integration of the rotation pipeline. Each test exercises the
// full HTTP-to-HTTP flow: cron handler invocation → rotateBearer / invalidate
// path → mocked Vercel REST API + KV mock + alert webhook. CD-7: 100% mocks.
// CD-3: NEVER use real bearers/tokens in fixtures.
//
// Coverage map:
//   T-INT-01 — rotate happy path: handler 200, MCP_BEARER_TOKEN_PREV created
//              from old current, MCP_BEARER_TOKEN updated to new value, KV
//              snapshot persisted with expiresAt = +24h, redeploy POSTed.
//   T-INT-02 — rotate mid-flow failure: updateEnv (S4) fails after createEnv
//              (S3), so rollback DELETE PREV runs. PREV gone, current intact,
//              alert dispatched, response 500.
//   T-INT-03 — invalidate happy path: pre-set KV with expiresAt past, PREV
//              env exists, handler returns 200 + {invalidatedAt}, PREV env
//              deleted, redeploy POSTed.
//   T-INT-04 — invalidate skip path: pre-set KV with expiresAt future, ZERO
//              Vercel calls, response 200 skipped reason="overlap window
//              still active".
//
// CDs touched:
//   CD-3 fixture bearers are obviously synthetic (zeros + label).
//   CD-7 globalThis.fetch + kv-mock fully replace network/storage.
//   CD-9 stderr is captured and asserted to contain NO secret material.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  setKvClientForTesting,
  resetKvClient,
} from '../src/kv-client.mjs';
import { resetWarnOnce } from '../src/log.mjs';
import { createKvMock } from './_mocks/kv-mock.mjs';

const TEST_SECRET = 'cron-secret-' + 'i'.repeat(20);
const TEST_VERCEL_TOKEN = 'vercel_token_int_test_must_not_leak_xxxxxxxxxx';
const TEST_PROJECT = 'prj_test_integration';
const TEST_TEAM = 'team_test_integration';
const FIXTURE_CURRENT_BEARER = 'cafef00d' + '0'.repeat(56);
const FIXTURE_PREV_BEARER = 'feedface' + '0'.repeat(56);
const ALERT_WEBHOOK = 'https://hooks.example.com/integration';

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

// makeFullStackFetch — combined Vercel + alert webhook mock. Returns a
// closure compatible with globalThis.fetch plus call-records for assertion.
function makeFullStackFetch({ envs = [], failOn = {} } = {}) {
  const vercelCalls = [];
  const alertCalls = [];
  const state = { envs: envs.map((e) => ({ ...e })), nextEnvId: 9000 };

  function vercelRespond(opName, body, statusOverride) {
    if (failOn[opName]) {
      const status = typeof failOn[opName] === 'number' ? failOn[opName] : 500;
      return new Response(
        JSON.stringify({ error: { code: 'mock_fail', op: opName } }),
        { status, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify(body ?? {}),
      { status: statusOverride ?? 200, headers: { 'content-type': 'application/json' } },
    );
  }

  const fetchImpl = async (url, init = {}) => {
    const u = typeof url === 'string' ? new URL(url) : new URL(url.toString());
    const method = init.method ?? 'GET';

    // Alert webhook capture (CD-9: body must NOT carry bearer/token).
    if (u.host === 'hooks.example.com') {
      let body;
      try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body; }
      alertCalls.push({ host: u.host, body });
      return new Response('{}', { status: 200 });
    }

    if (u.host !== 'api.vercel.com') {
      return new Response('{}', { status: 200 });
    }

    vercelCalls.push({
      url: u.toString(),
      host: u.host,
      pathname: u.pathname,
      method,
      teamId: u.searchParams.get('teamId'),
      bodyShape: init.body ? (() => { try { return JSON.parse(init.body); } catch { return null; } })() : null,
    });

    if (method === 'GET' && u.pathname.endsWith('/env')) {
      return vercelRespond('listEnvs', { envs: state.envs });
    }
    if (method === 'POST' && u.pathname.endsWith('/env')) {
      const id = `env_${state.nextEnvId++}`;
      const body = init.body ? JSON.parse(init.body) : {};
      const created = {
        id, key: body.key, value: body.value,
        target: ['production'], type: 'encrypted',
      };
      if (!failOn.createEnv) state.envs.push(created);
      return vercelRespond('createEnv', { id, created });
    }
    if (method === 'PATCH' && u.pathname.includes('/env/')) {
      const envId = u.pathname.split('/env/')[1];
      const target = state.envs.find((e) => e.id === envId);
      const body = init.body ? JSON.parse(init.body) : {};
      if (target && !failOn.updateEnv) target.value = body.value;
      return vercelRespond('updateEnv', { id: envId });
    }
    if (method === 'DELETE' && u.pathname.includes('/env/')) {
      const envId = u.pathname.split('/env/')[1];
      const idx = state.envs.findIndex((e) => e.id === envId);
      if (idx >= 0 && !failOn.deleteEnv) state.envs.splice(idx, 1);
      return vercelRespond('deleteEnv', null, 200);
    }
    if (method === 'POST' && u.pathname === '/v13/deployments') {
      return vercelRespond('triggerRedeploy', { id: 'dpl_int_mock', url: 'mock.vercel.app' });
    }
    return new Response(JSON.stringify({ error: 'unhandled' }), { status: 500 });
  };

  return { fetchImpl, vercelCalls, alertCalls, state };
}

async function loadRotateHandler() {
  const mod = await import(`../api/cron/rotate-bearer.mjs?int=${Date.now()}_${Math.random()}`);
  return mod.default;
}

async function loadInvalidateHandler() {
  const mod = await import(`../api/cron/invalidate-prev-bearer.mjs?int=${Date.now()}_${Math.random()}`);
  return mod.default;
}

beforeEach(() => {
  origFetch = globalThis.fetch;
  process.env.CRON_SECRET = TEST_SECRET;
  process.env.VERCEL_TOKEN = TEST_VERCEL_TOKEN;
  process.env.VERCEL_PROJECT_ID = TEST_PROJECT;
  process.env.VERCEL_TEAM_ID = TEST_TEAM;
  process.env.MCP_ALERT_WEBHOOK_URL = ALERT_WEBHOOK;
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

test('T-INT-01: end-to-end rotation success — PREV created, current updated, KV snapshot persisted, redeploy triggered', async () => {
  const kv = createKvMock();
  setKvClientForTesting(kv);
  const mock = makeFullStackFetch({
    envs: [
      {
        id: 'env_current_int',
        key: 'MCP_BEARER_TOKEN',
        value: FIXTURE_CURRENT_BEARER,
        target: ['production'],
        type: 'encrypted',
      },
    ],
  });
  globalThis.fetch = mock.fetchImpl;

  const handler = await loadRotateHandler();
  const cap = captureStderr();
  try {
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);

    // (e) response 200 ok.
    assert.equal(res.statusCode, 200);
    assert.equal(res._headers['content-type'], 'application/json');
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.match(body.rotatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(body.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // (a) MCP_BEARER_TOKEN_PREV created with old current's value.
    const prev = mock.state.envs.find((e) => e.key === 'MCP_BEARER_TOKEN_PREV');
    assert.ok(prev, 'PREV env must have been created');
    assert.equal(prev.value, FIXTURE_CURRENT_BEARER, 'PREV must hold old current bearer');

    // (b) MCP_BEARER_TOKEN updated with new (rotated) bearer — must be 64 hex.
    const current = mock.state.envs.find((e) => e.key === 'MCP_BEARER_TOKEN');
    assert.ok(current, 'current env must still exist');
    assert.match(current.value, /^[0-9a-f]{64}$/, 'current must be 64-hex random bearer');
    assert.notEqual(current.value, FIXTURE_CURRENT_BEARER, 'current must be NEW value');
    assert.notEqual(current.value, prev.value, 'current must differ from PREV');

    // (c) KV snapshot persisted with expiresAt = rotatedAt + 24h.
    const kvEntry = kv._store.get('last-bearer-rotation');
    assert.ok(kvEntry, 'snapshot must be in KV');
    const snapshot = JSON.parse(kvEntry.value);
    assert.equal(snapshot.rotatedAt, body.rotatedAt);
    assert.equal(snapshot.expiresAt, body.expiresAt);
    const ttlMs = Date.parse(snapshot.expiresAt) - Date.parse(snapshot.rotatedAt);
    assert.equal(ttlMs, 24 * 60 * 60 * 1000, 'overlap window must be exactly 24h');

    // (d) Redeploy triggered — POST /v13/deployments.
    const redeploy = mock.vercelCalls.find(
      (c) => c.method === 'POST' && c.pathname === '/v13/deployments',
    );
    assert.ok(redeploy, 'redeploy must have been triggered');

    // teamId scoping respected on every Vercel call.
    for (const c of mock.vercelCalls) {
      assert.equal(c.host, 'api.vercel.com');
      assert.equal(c.teamId, TEST_TEAM);
    }

    // CD-9: stderr must NEVER contain secrets.
    const blob = cap.lines.join('\n');
    assert.ok(!blob.includes(TEST_SECRET), 'CRON_SECRET leaked');
    assert.ok(!blob.includes(TEST_VERCEL_TOKEN), 'VERCEL_TOKEN leaked');
    assert.ok(!blob.includes(FIXTURE_CURRENT_BEARER), 'old current bearer leaked');
    assert.ok(!blob.includes(current.value), 'NEW bearer leaked');
    // No 64-hex sequences emitted at all.
    const hexHits = blob.match(/\b[a-f0-9]{64}\b/g) ?? [];
    assert.equal(hexHits.length, 0, `stderr leaked 64-hex value(s): ${hexHits.join(', ')}`);
    // Outcome event present.
    assert.match(blob, /mcp\.cron\.rotate-bearer\.ok/);
  } finally {
    cap.restore();
  }
});

test('T-INT-02: rotation fails mid-flow (updateEnv S4) → rollback DELETE PREV, alert dispatched, current intact, response 500', async () => {
  const kv = createKvMock();
  setKvClientForTesting(kv);
  const mock = makeFullStackFetch({
    envs: [
      {
        id: 'env_current_int',
        key: 'MCP_BEARER_TOKEN',
        value: FIXTURE_CURRENT_BEARER,
        target: ['production'],
        type: 'encrypted',
      },
    ],
    failOn: { updateEnv: 502 },
  });
  globalThis.fetch = mock.fetchImpl;

  const handler = await loadRotateHandler();
  const cap = captureStderr();
  try {
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);

    // Response 500 with failure body.
    assert.equal(res.statusCode, 500);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, false);
    assert.equal(body.stage, 'update-current');
    assert.ok(typeof body.error === 'string' && body.error.length > 0);

    // PREV must be deleted by rollback (DELETE issued) — net result: PREV gone.
    const prev = mock.state.envs.find((e) => e.key === 'MCP_BEARER_TOKEN_PREV');
    assert.equal(prev, undefined, 'PREV must have been rolled back (deleted)');

    // Current MUST be intact (still old value, NOT mutated by failed PATCH).
    const current = mock.state.envs.find((e) => e.key === 'MCP_BEARER_TOKEN');
    assert.ok(current, 'current must still exist');
    assert.equal(current.value, FIXTURE_CURRENT_BEARER, 'current must remain at old value');

    // KV snapshot must NOT have been written (failure path bails before S6).
    const kvEntry = kv._store.get('last-bearer-rotation');
    assert.equal(kvEntry, undefined, 'KV snapshot must NOT exist on failure');

    // Vercel calls expected: GET (list) + POST (create PREV) + PATCH (failed)
    // + DELETE (rollback PREV). NO redeploy on failure.
    const methods = mock.vercelCalls.map((c) => c.method);
    assert.ok(methods.includes('GET'));
    assert.ok(methods.includes('POST'));
    assert.ok(methods.includes('PATCH'));
    assert.ok(methods.includes('DELETE'), 'rollback DELETE must run');
    const redeploy = mock.vercelCalls.find(
      (c) => c.method === 'POST' && c.pathname === '/v13/deployments',
    );
    assert.equal(redeploy, undefined, 'redeploy must NOT be triggered on failure');

    // Alert dispatched via webhook (CD-6). Body must NOT carry secrets.
    assert.equal(mock.alertCalls.length, 1, 'rotation failure must fire exactly one alert');
    const alert = mock.alertCalls[0].body;
    assert.equal(alert.severity, 'critical');
    assert.equal(alert.event, 'bearer-rotation-failed');
    assert.equal(typeof alert.reason, 'string');
    assert.ok(alert.reason.length > 0);
    // CD-12: reason MUST be a literal from STAGE_REASONS — not error.message.
    assert.equal(alert.reason, 'failed to update current env (rolled back)');
    const serializedAlert = JSON.stringify(alert);
    assert.ok(!serializedAlert.includes(TEST_VERCEL_TOKEN), 'alert leaked VERCEL_TOKEN');
    assert.ok(!serializedAlert.includes(FIXTURE_CURRENT_BEARER), 'alert leaked current bearer');
    assert.ok(!serializedAlert.includes(TEST_SECRET), 'alert leaked CRON_SECRET');

    // CD-9 stderr leaks.
    const blob = cap.lines.join('\n');
    assert.ok(!blob.includes(TEST_VERCEL_TOKEN));
    assert.ok(!blob.includes(FIXTURE_CURRENT_BEARER));
    assert.ok(!blob.includes(TEST_SECRET));
    assert.match(blob, /mcp\.cron\.rotate-bearer\.failed/);
  } finally {
    cap.restore();
  }
});

test('T-INT-03: end-to-end invalidation success — KV expired, PREV deleted, redeploy triggered, response 200', async () => {
  const kv = createKvMock();
  setKvClientForTesting(kv);
  const pastExpiresAt = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // -5min
  const oldRotatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  await kv.set(
    'last-bearer-rotation',
    JSON.stringify({ rotatedAt: oldRotatedAt, expiresAt: pastExpiresAt }),
    { ex: 25 * 60 * 60 },
  );
  const mock = makeFullStackFetch({
    envs: [
      {
        id: 'env_prev_int_01',
        key: 'MCP_BEARER_TOKEN_PREV',
        value: FIXTURE_PREV_BEARER,
        target: ['production'],
        type: 'encrypted',
      },
      {
        id: 'env_current_int',
        key: 'MCP_BEARER_TOKEN',
        value: FIXTURE_CURRENT_BEARER,
        target: ['production'],
        type: 'encrypted',
      },
    ],
  });
  globalThis.fetch = mock.fetchImpl;

  const handler = await loadInvalidateHandler();
  const cap = captureStderr();
  try {
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);

    // Response 200 ok.
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.skipped, undefined, 'must NOT be skipped');
    assert.match(body.invalidatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // PREV must be deleted from Vercel state.
    const prev = mock.state.envs.find((e) => e.key === 'MCP_BEARER_TOKEN_PREV');
    assert.equal(prev, undefined, 'PREV must have been deleted');

    // Current must remain intact.
    const current = mock.state.envs.find((e) => e.key === 'MCP_BEARER_TOKEN');
    assert.ok(current);
    assert.equal(current.value, FIXTURE_CURRENT_BEARER);

    // DELETE on PREV envId must have been issued.
    const deleteCall = mock.vercelCalls.find(
      (c) => c.method === 'DELETE' && c.pathname.endsWith('/env_prev_int_01'),
    );
    assert.ok(deleteCall, 'DELETE on PREV env must have been issued');

    // Redeploy triggered.
    const redeploy = mock.vercelCalls.find(
      (c) => c.method === 'POST' && c.pathname === '/v13/deployments',
    );
    assert.ok(redeploy, 'redeploy must have been triggered');

    // teamId scoping respected.
    for (const c of mock.vercelCalls) {
      assert.equal(c.host, 'api.vercel.com');
      assert.equal(c.teamId, TEST_TEAM);
    }

    // No alerts on invalidation success.
    assert.equal(mock.alertCalls.length, 0, 'no alert on invalidation success');

    // CD-9 stderr leaks.
    const blob = cap.lines.join('\n');
    assert.ok(!blob.includes(TEST_VERCEL_TOKEN));
    assert.ok(!blob.includes(FIXTURE_PREV_BEARER));
    assert.ok(!blob.includes(FIXTURE_CURRENT_BEARER));
    assert.ok(!blob.includes(TEST_SECRET));
    const hexHits = blob.match(/\b[a-f0-9]{64}\b/g) ?? [];
    assert.equal(hexHits.length, 0, `stderr leaked 64-hex value(s): ${hexHits.join(', ')}`);
    assert.match(blob, /mcp\.cron\.invalidate-prev-bearer\.ok/);
  } finally {
    cap.restore();
  }
});

test('T-INT-04: invalidation skip — KV expiresAt in the future → ZERO Vercel calls, response 200 skipped', async () => {
  const kv = createKvMock();
  setKvClientForTesting(kv);
  const futureExpiresAt = new Date(Date.now() + 90 * 60 * 1000).toISOString(); // +90min
  const recentRotatedAt = new Date(Date.now() - 22 * 60 * 60 * 1000).toISOString();
  await kv.set(
    'last-bearer-rotation',
    JSON.stringify({ rotatedAt: recentRotatedAt, expiresAt: futureExpiresAt }),
    { ex: 25 * 60 * 60 },
  );
  const mock = makeFullStackFetch({
    envs: [
      {
        id: 'env_prev_keep',
        key: 'MCP_BEARER_TOKEN_PREV',
        value: FIXTURE_PREV_BEARER,
        target: ['production'],
        type: 'encrypted',
      },
    ],
  });
  globalThis.fetch = mock.fetchImpl;

  const handler = await loadInvalidateHandler();
  const cap = captureStderr();
  try {
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);

    // Response 200 skipped.
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.skipped, true);
    assert.equal(body.reason, 'overlap window still active');

    // ZERO Vercel calls — must short-circuit before listEnvs.
    assert.equal(mock.vercelCalls.length, 0, 'no Vercel call when overlap still active');

    // PREV must still exist in mock state (not touched).
    const prev = mock.state.envs.find((e) => e.key === 'MCP_BEARER_TOKEN_PREV');
    assert.ok(prev, 'PREV must still exist when overlap active');
    assert.equal(prev.value, FIXTURE_PREV_BEARER);

    // No alerts.
    assert.equal(mock.alertCalls.length, 0);

    // Stderr: skipped event present, no secrets.
    const blob = cap.lines.join('\n');
    assert.match(blob, /mcp\.cron\.invalidate-prev-bearer\.skipped/);
    assert.ok(!blob.includes(TEST_VERCEL_TOKEN));
    assert.ok(!blob.includes(FIXTURE_PREV_BEARER));
    assert.ok(!blob.includes(TEST_SECRET));
    const hexHits = blob.match(/\b[a-f0-9]{64}\b/g) ?? [];
    assert.equal(hexHits.length, 0, `stderr leaked 64-hex value(s): ${hexHits.join(', ')}`);
  } finally {
    cap.restore();
  }
});
