// bearer-rotation.test.mjs — WKH-75 W2 (T-RB-03..T-RB-08).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { rotateBearer, STAGE_REASONS } from '../src/bearer-rotation.mjs';
import { resetWarnOnce } from '../src/log.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', 'scripts', 'rotate-bearer.mjs');

const TEST_TOKEN = 'vercel_token_unit_test_must_not_leak_xxxxxxxxxx';
const TEST_PROJECT = 'prj_test_rotation';
const TEST_TEAM = 'team_test_rotation';
const TEST_ALERT_URL = 'https://hooks.example.com/rotation';
const FIXTURE_CURRENT_BEARER = 'cafebabe' + '0'.repeat(56);
const FIXTURE_PREV_BEARER    = 'deadbeef' + '0'.repeat(56);

let origFetch;
beforeEach(() => { origFetch = globalThis.fetch; resetWarnOnce(); });
afterEach(() => { globalThis.fetch = origFetch; });

function makeVercelMock({ envs = [], failOn = {}, alertCalls } = {}) {
  const calls = [];
  const state = { envs: envs.map((e) => ({ ...e })), nextEnvId: 1000 };
  function respond(opName, body, statusOverride) {
    if (failOn[opName]) {
      const status = typeof failOn[opName] === 'number' ? failOn[opName] : 500;
      return new Response(JSON.stringify({ error: { code: 'mock_fail' } }), { status, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(body ?? {}), { status: statusOverride ?? 200, headers: { 'content-type': 'application/json' } });
  }
  globalThis.fetch = async (url, init = {}) => {
    const u = typeof url === 'string' ? new URL(url) : new URL(url.toString());
    const method = init.method ?? 'GET';
    if (u.host !== 'api.vercel.com') {
      if (alertCalls) {
        let body;
        try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body; }
        alertCalls.push({ url: u.toString(), method, body });
      }
      return new Response('{}', { status: 200 });
    }
    calls.push({ url: u.toString(), host: u.host, pathname: u.pathname, method,
      teamId: u.searchParams.get('teamId'),
      body: init.body ? (() => { try { return JSON.parse(init.body); } catch { return init.body; } })() : undefined,
      redirect: init.redirect });
    if (method === 'GET' && u.pathname.endsWith('/env')) return respond('listEnvs', { envs: state.envs });
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
    if (method === 'POST' && u.pathname === '/v13/deployments') return respond('triggerRedeploy', { id: 'dpl_mock', url: 'mock.vercel.app' });
    return new Response(JSON.stringify({ error: 'unhandled' }), { status: 500 });
  };
  return { calls, state };
}

function makeKvMock({ failNext = 0 } = {}) {
  let _failNext = failNext;
  const store = new Map();
  return {
    async set(key, value, opts) {
      if (_failNext > 0) { _failNext -= 1; throw new Error('kv: simulated failure'); }
      store.set(key, { value, opts });
      return 'OK';
    },
    _store: store,
  };
}

test('T-RB-03: rotateBearer happy path returns ok + writes KV snapshot', async () => {
  const alertCalls = [];
  const mock = makeVercelMock({
    envs: [{ id: 'env_current', key: 'MCP_BEARER_TOKEN', value: FIXTURE_CURRENT_BEARER, target: ['production'], type: 'encrypted' }],
    alertCalls,
  });
  const kv = makeKvMock();
  const result = await rotateBearer({
    vercelToken: TEST_TOKEN, projectId: TEST_PROJECT, teamId: TEST_TEAM,
    alertWebhookUrl: TEST_ALERT_URL, kvClient: kv,
  });
  assert.equal(result.ok, true);
  assert.match(result.rotatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(result.expiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Date.parse(result.expiresAt) - Date.parse(result.rotatedAt) === 24*60*60*1000);
  const methods = mock.calls.map((c) => c.method);
  assert.ok(methods.includes('GET'));
  assert.ok(methods.includes('POST'));
  assert.ok(methods.includes('PATCH'));
  for (const c of mock.calls) {
    assert.equal(c.host, 'api.vercel.com');
    assert.equal(c.redirect, 'error');
  }
  const kvEntry = kv._store.get('last-bearer-rotation');
  assert.ok(kvEntry);
  const blob = JSON.parse(kvEntry.value);
  assert.equal(blob.rotatedAt, result.rotatedAt);
  assert.equal(blob.expiresAt, result.expiresAt);
  assert.equal(kvEntry.opts.ex, 25*60*60);
  assert.equal(alertCalls.length, 0);
});

test('T-RB-03b: rotateBearer deletes existing PREV before creating new one', async () => {
  const mock = makeVercelMock({
    envs: [
      { id: 'env_current', key: 'MCP_BEARER_TOKEN', value: FIXTURE_CURRENT_BEARER, target: ['production'], type: 'encrypted' },
      { id: 'env_prev_old', key: 'MCP_BEARER_TOKEN_PREV', value: FIXTURE_PREV_BEARER, target: ['production'], type: 'encrypted' },
    ],
  });
  const result = await rotateBearer({ vercelToken: TEST_TOKEN, projectId: TEST_PROJECT, kvClient: null });
  assert.equal(result.ok, true);
  const deletedPrev = mock.calls.find((c) => c.method === 'DELETE' && c.pathname.endsWith('/env_prev_old'));
  assert.ok(deletedPrev);
});

test('T-RB-04: listEnvs failure (S1) → ok:false, alert dispatched, no env mutated', async () => {
  const alertCalls = [];
  const mock = makeVercelMock({
    envs: [{ id: 'env_current', key: 'MCP_BEARER_TOKEN', value: FIXTURE_CURRENT_BEARER, target: ['production'], type: 'encrypted' }],
    failOn: { listEnvs: 401 }, alertCalls,
  });
  const result = await rotateBearer({
    vercelToken: TEST_TOKEN, projectId: TEST_PROJECT,
    alertWebhookUrl: TEST_ALERT_URL, kvClient: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'list-envs');
  assert.equal(result.reason, STAGE_REASONS['list-envs-failed']);
  const mutating = mock.calls.filter((c) => c.method !== 'GET');
  assert.equal(mutating.length, 0);
  assert.equal(alertCalls.length, 1);
  assert.equal(alertCalls[0].body.severity, 'critical');
  const serialized = JSON.stringify(alertCalls[0].body);
  assert.ok(!serialized.includes(TEST_TOKEN));
});

test('T-RB-05: createEnv failure (S3) → ok:false, alert dispatched, current env intact', async () => {
  const alertCalls = [];
  const mock = makeVercelMock({
    envs: [{ id: 'env_current', key: 'MCP_BEARER_TOKEN', value: FIXTURE_CURRENT_BEARER, target: ['production'], type: 'encrypted' }],
    failOn: { createEnv: 500 }, alertCalls,
  });
  const result = await rotateBearer({
    vercelToken: TEST_TOKEN, projectId: TEST_PROJECT,
    alertWebhookUrl: TEST_ALERT_URL, kvClient: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'create-prev');
  assert.equal(result.reason, STAGE_REASONS['create-prev-failed']);
  const current = mock.state.envs.find((e) => e.key === 'MCP_BEARER_TOKEN');
  assert.equal(current.value, FIXTURE_CURRENT_BEARER);
  const prev = mock.state.envs.find((e) => e.key === 'MCP_BEARER_TOKEN_PREV');
  assert.equal(prev, undefined);
  assert.equal(alertCalls.length, 1);
  assert.equal(alertCalls[0].body.severity, 'critical');
});

test('T-RB-06: updateEnv failure (S4) → rollback DELETE PREV, alert, current intact', async () => {
  const alertCalls = [];
  const mock = makeVercelMock({
    envs: [{ id: 'env_current', key: 'MCP_BEARER_TOKEN', value: FIXTURE_CURRENT_BEARER, target: ['production'], type: 'encrypted' }],
    failOn: { updateEnv: 500 }, alertCalls,
  });
  const result = await rotateBearer({
    vercelToken: TEST_TOKEN, projectId: TEST_PROJECT,
    alertWebhookUrl: TEST_ALERT_URL, kvClient: null,
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'update-current');
  assert.equal(result.reason, STAGE_REASONS['update-current-failed']);
  const prev = mock.state.envs.find((e) => e.key === 'MCP_BEARER_TOKEN_PREV');
  assert.equal(prev, undefined);
  const current = mock.state.envs.find((e) => e.key === 'MCP_BEARER_TOKEN');
  assert.equal(current.value, FIXTURE_CURRENT_BEARER);
  const methods = mock.calls.map((c) => c.method);
  const patchIdx = methods.indexOf('PATCH');
  const deleteIdx = methods.indexOf('DELETE');
  assert.ok(patchIdx >= 0);
  assert.ok(deleteIdx > patchIdx);
  assert.equal(alertCalls.length, 1);
  assert.equal(alertCalls[0].body.severity, 'critical');
});

test('T-RB-07: triggerRedeploy failure (S5) → ok:true (best-effort), NO alert', async () => {
  const alertCalls = [];
  const mock = makeVercelMock({
    envs: [{ id: 'env_current', key: 'MCP_BEARER_TOKEN', value: FIXTURE_CURRENT_BEARER, target: ['production'], type: 'encrypted' }],
    failOn: { triggerRedeploy: 503 }, alertCalls,
  });
  const kv = makeKvMock();
  const result = await rotateBearer({
    vercelToken: TEST_TOKEN, projectId: TEST_PROJECT,
    alertWebhookUrl: TEST_ALERT_URL, kvClient: kv,
  });
  assert.equal(result.ok, true);
  const current = mock.state.envs.find((e) => e.key === 'MCP_BEARER_TOKEN');
  assert.notEqual(current.value, FIXTURE_CURRENT_BEARER);
  assert.ok(kv._store.get('last-bearer-rotation'));
  assert.equal(alertCalls.length, 0);
});

test('T-RB-08: KV write failure (S6) → ok:true (best-effort), NO alert', async () => {
  // WKH-88: rotateBearer now performs an S0-pre `kvClient.set(MUTEX, ..., {nx:true})`
  // BEFORE the S6 snapshot write. To exercise the S6 failure path we must let
  // the mutex acquire succeed and force the SECOND `set()` (snapshot) to throw.
  // The local makeKvMock does not honour nx semantics, so we mock the surface
  // directly: first call resolves OK (mutex acquired), second throws (S6 KV
  // write failure under test). All other calls are unreachable.
  const alertCalls = [];
  const mock = makeVercelMock({
    envs: [{ id: 'env_current', key: 'MCP_BEARER_TOKEN', value: FIXTURE_CURRENT_BEARER, target: ['production'], type: 'encrypted' }],
    alertCalls,
  });
  const setCalls = [];
  const kv = {
    async set(key, value, opts) {
      setCalls.push({ key, value, opts });
      if (setCalls.length === 1) return 'OK'; // mutex acquired
      throw new Error('kv: simulated failure');  // S6 snapshot write fails
    },
  };
  const result = await rotateBearer({
    vercelToken: TEST_TOKEN, projectId: TEST_PROJECT,
    alertWebhookUrl: TEST_ALERT_URL, kvClient: kv,
  });
  assert.equal(result.ok, true);
  // Two set() attempts: mutex (S0-pre) + snapshot (S6).
  assert.equal(setCalls.length, 2);
  // First call was the mutex with nx flag.
  assert.equal(setCalls[0].opts?.nx, true);
  // Second call was the snapshot (no nx flag).
  assert.equal(setCalls[1].opts?.nx, undefined);
  assert.equal(alertCalls.length, 0);
  const current = mock.state.envs.find((e) => e.key === 'MCP_BEARER_TOKEN');
  assert.notEqual(current.value, FIXTURE_CURRENT_BEARER);
  assert.ok(mock.calls.length >= 3);
});

test('T-MUTEX-01 (WKH-88): concurrent rotateBearer call → mutex skip, NO Vercel mutation', async () => {
  // CD-WKH88-2: the S0-pre mutex MUST use NX-flagged set (atomic). When a
  // prior rotation is in flight (mutex key already set), a concurrent call
  // MUST early-return `{ok:false, stage:'mutex'}` and MUST NOT progress to
  // any Vercel API call (no listEnvs, no createEnv, no updateEnv).
  //
  // CD-WKH88-4: the mock injects a deterministic mutex-busy state by having
  // `kvClient.set(MUTEX, ..., {nx:true})` return null on the very first call
  // (simulating "key already exists in KV"). This avoids any reliance on
  // real concurrency / event-loop timing.
  let vercelFetchCount = 0;
  globalThis.fetch = async (url) => {
    const u = typeof url === 'string' ? new URL(url) : new URL(url.toString());
    if (u.host === 'api.vercel.com') vercelFetchCount += 1;
    return new Response('{}', { status: 200 });
  };
  const setCalls = [];
  const kv = {
    async set(key, value, opts) {
      setCalls.push({ key, value, opts });
      // Simulate "mutex already taken" — Upstash NX returns null on collision.
      if (opts?.nx === true) return null;
      // Any non-mutex set is unreachable in this test; flag it loudly.
      throw new Error('unexpected non-mutex set during mutex-busy path');
    },
  };
  const result = await rotateBearer({
    vercelToken: TEST_TOKEN,
    projectId: TEST_PROJECT,
    teamId: TEST_TEAM,
    alertWebhookUrl: TEST_ALERT_URL,
    kvClient: kv,
  });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'mutex');
  assert.equal(result.reason, STAGE_REASONS['mutex-busy']);
  // Exactly one set() attempt — the mutex acquisition. Snapshot write is NOT
  // reached.
  assert.equal(setCalls.length, 1);
  assert.equal(setCalls[0].opts.nx, true);
  assert.ok(typeof setCalls[0].opts.ex === 'number' && setCalls[0].opts.ex > 0);
  assert.ok(setCalls[0].opts.ex <= 10 * 60, 'CD-WKH88-6: mutex TTL <= 10 min');
  // CD-WKH88-2: NO Vercel API call when mutex is busy.
  assert.equal(vercelFetchCount, 0);
});

test('T-RB-MANUAL: VERCEL_TOKEN absent → manual mode preserved (AC-2)', () => {
  const childEnv = { ...process.env };
  delete childEnv.VERCEL_TOKEN;
  delete childEnv.VERCEL_PROJECT_ID;
  const r = spawnSync(process.execPath, [SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: childEnv,
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Refusing/);
  assert.ok(!/[0-9a-f]{64}/.test(r.stdout));
});
