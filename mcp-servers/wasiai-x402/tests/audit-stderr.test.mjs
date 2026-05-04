// audit-stderr.test.mjs — WKH-66 W5 cross-cutting audit (AC-X-1)
// + WKH-75 W5 rotation/invalidation audit (T-AUD-01..T-AUD-03).
//
// This is a focused stderr-leak audit that complements T-CH-20 inside
// chaos.test.mjs. It re-runs the most secret-sensitive paths (auth fail,
// rate-limit hit, balance-gate reject, alert webhook fail) and asserts no
// secret slipped through ANY stderr line emitted by:
//   - src/balance-guard.mjs
//   - src/rate-limit.mjs
//   - src/alerts.mjs
//   - src/cron-auth.mjs
//   - src/kv-client.mjs
//   - src/bearer-rotation.mjs (WKH-75)
//   - api/cron/rotate-bearer.mjs (WKH-75)
//   - api/cron/invalidate-prev-bearer.mjs (WKH-75)
//
// Forbidden patterns:
//   - OPERATOR_PRIVATE_KEY (raw, hex, with/without 0x prefix)
//   - MCP_BEARER_TOKEN (raw)
//   - CRON_SECRET (raw)
//   - CRONJOB_ORG_API_TOKEN (raw)
//   - KV_REST_API_TOKEN (raw)
//   - VERCEL_TOKEN (raw, vercel_*-shape)
//   - any 0x-prefixed 64-char hex (unattributed)
//   - any bare 64-hex sequence inside the rotation-flow audits.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkBalanceWithClaim } from '../src/balance-guard.mjs';
import { checkRateLimit, hashBearer } from '../src/rate-limit.mjs';
import { sendAlert } from '../src/alerts.mjs';
import { validateCronSecret, CronAuthError } from '../src/cron-auth.mjs';
import {
  setKvClientForTesting,
  resetKvClient,
} from '../src/kv-client.mjs';
import { resetWarnOnce } from '../src/log.mjs';
import { createKvMock } from './_mocks/kv-mock.mjs';
import { createRpcMock } from './_mocks/rpc-mock.mjs';

// Distinct secret values so substring checks are unambiguous.
const SECRETS = {
  PK: '0x' + 'cd'.repeat(32),
  PK_BARE: 'cd'.repeat(32),
  BEARER: 'cafebabe' + 'a'.repeat(56),
  CRON_SECRET: 'cron-secret-' + 'a'.repeat(20),
  CRONJOB_TOKEN: 'cronjob-token-' + 'b'.repeat(20),
  KV_TOKEN: 'kv-token-' + 'c'.repeat(20),
};

const OPERATOR = '0x' + '11'.repeat(20);
const USDC_ADDR = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';

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

test('audit: no secret leaks across balance-guard / rate-limit / alerts / cron-auth fail paths', async () => {
  resetWarnOnce();
  // Stage env vars that COULD leak if the modules misbehave.
  process.env.OPERATOR_PRIVATE_KEY = SECRETS.PK;
  process.env.MCP_BEARER_TOKEN = SECRETS.BEARER;
  process.env.CRON_SECRET = SECRETS.CRON_SECRET;
  process.env.CRONJOB_ORG_API_TOKEN = SECRETS.CRONJOB_TOKEN;
  process.env.KV_REST_API_TOKEN = SECRETS.KV_TOKEN;

  const cap = captureStderr();
  try {
    // 1. balance-guard: fail-secure on null kv.
    await checkBalanceWithClaim({
      operator: OPERATOR, chainId: 43114, requestedWei: 100_000n,
      threshold: 0.5, kvClient: null, publicClient: createRpcMock(),
      usdcAddress: USDC_ADDR,
    });

    // 2. balance-guard: RPC throw fail-secure.
    const kv = createKvMock();
    const rpc = createRpcMock({ failNext: 1 });
    await checkBalanceWithClaim({
      operator: OPERATOR, chainId: 43114, requestedWei: 100_000n,
      threshold: 0.5, kvClient: kv, publicClient: rpc,
      usdcAddress: USDC_ADDR,
    });

    // 3. rate-limit: KV throw → fail-open + log warn.
    kv._setFailNext(1);
    await checkRateLimit({
      bearerHash16: hashBearer(SECRETS.BEARER), kvClient: kv,
      perMin: 5, windowSec: 60,
    });

    // 4. alerts: webhook missing → warnOnce.
    await sendAlert({
      severity: 'critical',
      body: { chain: 'avax', operator: OPERATOR },
      webhookUrl: '',
    });

    // 5. alerts: webhook throws → log warn.
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('boom'); };
    try {
      await sendAlert({
        severity: 'critical',
        body: { chain: 'avax', operator: OPERATOR },
        webhookUrl: 'https://hooks.example.com/x',
      });
    } finally {
      globalThis.fetch = origFetch;
    }

    // 6. cron-auth: wrong secret → 401 (caller would log warn).
    try {
      validateCronSecret('Bearer wrong-' + 'x'.repeat(50), SECRETS.CRON_SECRET);
    } catch (e) {
      assert.ok(e instanceof CronAuthError);
    }
  } finally {
    cap.restore();
    delete process.env.OPERATOR_PRIVATE_KEY;
    delete process.env.MCP_BEARER_TOKEN;
    delete process.env.CRON_SECRET;
    delete process.env.CRONJOB_ORG_API_TOKEN;
    delete process.env.KV_REST_API_TOKEN;
  }

  const blob = cap.lines.join('\n');
  // Check every secret variant.
  assert.ok(!blob.includes(SECRETS.PK), 'stderr leaked PK (0x-form)');
  assert.ok(!blob.includes(SECRETS.PK_BARE), 'stderr leaked PK (bare hex)');
  assert.ok(!blob.includes(SECRETS.BEARER), 'stderr leaked bearer');
  assert.ok(!blob.includes(SECRETS.CRON_SECRET), 'stderr leaked CRON_SECRET');
  assert.ok(!blob.includes(SECRETS.CRONJOB_TOKEN), 'stderr leaked CRONJOB_ORG_API_TOKEN');
  assert.ok(!blob.includes(SECRETS.KV_TOKEN), 'stderr leaked KV_REST_API_TOKEN');
  // Generic 0x{64hex} pattern — anything matching is a private key shape.
  const matches = blob.match(/0x[0-9a-fA-F]{64}/g) ?? [];
  assert.equal(matches.length, 0, `stderr contains 0x{64hex} pattern(s): ${matches.join(', ')}`);
});

// ─────────────────────────────────────────────────────────────────────────
// WKH-75 W5 — rotation/invalidation stderr audit (T-AUD-01..T-AUD-03)
// ─────────────────────────────────────────────────────────────────────────
//
// Forbidden patterns for the rotation flow (CD-3 + CD-9):
//   - /vercel_[a-zA-Z0-9]+/         — VERCEL_TOKEN raw value
//   - /MCP_BEARER_TOKEN[^_PREV]/    — env name on its own (without _PREV) is
//                                      acceptable in error messages, but the
//                                      VALUE next to an `=` is not. We assert
//                                      the synthetic fixture value never appears.
//   - /\b[a-f0-9]{64}\b/             — any bare 64-hex sequence (bearer shape).
//
// Approach: drive the actual cron handlers via mocked fetch + KV mock, exactly
// as in production but without network. Capture every stderr line. After the
// flow completes, run regex assertions against the joined blob.

const ROT_SECRETS = {
  CRON_SECRET: 'cron-secret-aud-' + 'a'.repeat(20),
  VERCEL_TOKEN: 'vercel_audit_token_must_not_leak_' + 'b'.repeat(20),
  CURRENT_BEARER: 'cafef00d' + 'a'.repeat(56),
  PREV_BEARER: 'feedbeef' + 'a'.repeat(56),
};
const ROT_PROJECT = 'prj_audit_test';
const ROT_TEAM = 'team_audit_test';
const ALERT_HOST = 'hooks.audit.example.com';
const ALERT_URL = `https://${ALERT_HOST}/x`;

function _makeReq() {
  return {
    headers: { authorization: `Bearer ${ROT_SECRETS.CRON_SECRET}` },
    method: 'POST',
  };
}

function _makeRes() {
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

// _makeRotationFetch — mocks api.vercel.com (env CRUD + redeploy) + alert
// webhook. Returns the fetch impl and recorded calls.
function _makeRotationFetch({ envs = [], failOn = {} } = {}) {
  const vercelCalls = [];
  const alertCalls = [];
  const state = { envs: envs.map((e) => ({ ...e })), nextEnvId: 7000 };

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

  const impl = async (url, init = {}) => {
    const u = typeof url === 'string' ? new URL(url) : new URL(url.toString());
    const method = init.method ?? 'GET';

    if (u.host === ALERT_HOST) {
      let body;
      try { body = init.body ? JSON.parse(init.body) : null; } catch { body = init.body; }
      alertCalls.push({ host: u.host, body });
      return new Response('{}', { status: 200 });
    }
    if (u.host !== 'api.vercel.com') {
      return new Response('{}', { status: 200 });
    }
    vercelCalls.push({ method, pathname: u.pathname });

    if (method === 'GET' && u.pathname.endsWith('/env')) {
      return respond('listEnvs', { envs: state.envs });
    }
    if (method === 'POST' && u.pathname.endsWith('/env')) {
      const id = `env_${state.nextEnvId++}`;
      const body = init.body ? JSON.parse(init.body) : {};
      const created = {
        id, key: body.key, value: body.value,
        target: ['production'], type: 'encrypted',
      };
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
      return respond('triggerRedeploy', { id: 'dpl_audit' });
    }
    return new Response(JSON.stringify({ error: 'unhandled' }), { status: 500 });
  };
  return { impl, vercelCalls, alertCalls, state };
}

function _captureRotationStderr() {
  const orig = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (const part of s.split('\n')) if (part.length) lines.push(part);
    return true;
  };
  return { lines, restore() { process.stderr.write = orig; } };
}

function _setRotationEnv() {
  process.env.CRON_SECRET = ROT_SECRETS.CRON_SECRET;
  process.env.VERCEL_TOKEN = ROT_SECRETS.VERCEL_TOKEN;
  process.env.VERCEL_PROJECT_ID = ROT_PROJECT;
  process.env.VERCEL_TEAM_ID = ROT_TEAM;
  process.env.MCP_ALERT_WEBHOOK_URL = ALERT_URL;
}

function _clearRotationEnv() {
  delete process.env.CRON_SECRET;
  delete process.env.VERCEL_TOKEN;
  delete process.env.VERCEL_PROJECT_ID;
  delete process.env.VERCEL_TEAM_ID;
  delete process.env.MCP_ALERT_WEBHOOK_URL;
}

function _assertNoRotationLeaks(lines) {
  const blob = lines.join('\n');
  // CD-3: VERCEL_TOKEN must NEVER appear (matches /vercel_[a-zA-Z0-9_]+/).
  const vercelMatches = blob.match(/vercel_[a-zA-Z0-9_]+/g) ?? [];
  assert.equal(
    vercelMatches.length, 0,
    `stderr leaked vercel_*-shaped token(s): ${vercelMatches.join(', ')}`,
  );
  assert.ok(!blob.includes(ROT_SECRETS.VERCEL_TOKEN), 'VERCEL_TOKEN value leaked');
  // CD-9: CRON_SECRET value must NEVER appear.
  assert.ok(!blob.includes(ROT_SECRETS.CRON_SECRET), 'CRON_SECRET leaked');
  // Bearer values: CURRENT and PREV must NEVER appear.
  assert.ok(!blob.includes(ROT_SECRETS.CURRENT_BEARER), 'current bearer leaked');
  assert.ok(!blob.includes(ROT_SECRETS.PREV_BEARER), 'prev bearer leaked');
  // Bare 64-hex sequence: nothing matching the bearer shape.
  const hexMatches = blob.match(/\b[a-f0-9]{64}\b/g) ?? [];
  assert.equal(
    hexMatches.length, 0,
    `stderr leaked 64-hex value(s): ${hexMatches.join(', ')}`,
  );
}

test('T-AUD-01 (WKH-75): rotation success flow stderr — NO secret leaks', async () => {
  resetWarnOnce();
  _setRotationEnv();
  const kv = createKvMock();
  setKvClientForTesting(kv);
  const mock = _makeRotationFetch({
    envs: [
      {
        id: 'env_current_aud',
        key: 'MCP_BEARER_TOKEN',
        value: ROT_SECRETS.CURRENT_BEARER,
        target: ['production'],
        type: 'encrypted',
      },
    ],
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = mock.impl;

  const cap = _captureRotationStderr();
  try {
    const handlerMod = await import(
      `../api/cron/rotate-bearer.mjs?aud01=${Date.now()}_${Math.random()}`
    );
    const handler = handlerMod.default;
    const req = _makeReq();
    const res = _makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200, 'rotation success expected');
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
    resetKvClient();
    _clearRotationEnv();
  }

  _assertNoRotationLeaks(cap.lines);
});

test('T-AUD-02 (WKH-75): rotation failure flow stderr — NO secret leaks (error paths included)', async () => {
  resetWarnOnce();
  _setRotationEnv();
  const kv = createKvMock();
  setKvClientForTesting(kv);
  // Force a mid-flow failure on updateEnv → triggers rollback DELETE PREV
  // and dispatches the alert (CD-6). We need to confirm even in the error
  // paths the bearer/token never reach stderr.
  const mock = _makeRotationFetch({
    envs: [
      {
        id: 'env_current_aud_02',
        key: 'MCP_BEARER_TOKEN',
        value: ROT_SECRETS.CURRENT_BEARER,
        target: ['production'],
        type: 'encrypted',
      },
    ],
    failOn: { updateEnv: 502 },
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = mock.impl;

  const cap = _captureRotationStderr();
  try {
    const handlerMod = await import(
      `../api/cron/rotate-bearer.mjs?aud02=${Date.now()}_${Math.random()}`
    );
    const handler = handlerMod.default;
    const req = _makeReq();
    const res = _makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 500, 'rotation failure expected');
    const body = JSON.parse(res._body);
    assert.equal(body.ok, false);
    // Sanity: the alert was dispatched (CD-6 path exercised).
    assert.equal(mock.alertCalls.length, 1);
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
    resetKvClient();
    _clearRotationEnv();
  }

  _assertNoRotationLeaks(cap.lines);

  // Additional: alert body itself must not embed any secret. We snapshot the
  // alert body too (paranoid): even though it goes to a webhook, the JSON
  // serialization could be logged by a future caller.
  const alertSerialized = JSON.stringify(mock.alertCalls[0].body);
  assert.ok(!alertSerialized.includes(ROT_SECRETS.VERCEL_TOKEN));
  assert.ok(!alertSerialized.includes(ROT_SECRETS.CRON_SECRET));
  assert.ok(!alertSerialized.includes(ROT_SECRETS.CURRENT_BEARER));
  assert.ok(!alertSerialized.includes(ROT_SECRETS.PREV_BEARER));
  // CD-12: reason field is a literal from STAGE_REASONS (not error.message).
  assert.equal(
    mock.alertCalls[0].body.reason,
    'failed to update current env (rolled back)',
  );
});

test('T-AUD-03 (WKH-75): invalidation flow stderr (DELETE + redeploy) — NO secret leaks', async () => {
  resetWarnOnce();
  _setRotationEnv();
  const kv = createKvMock();
  setKvClientForTesting(kv);
  // Pre-seed expired snapshot → handler will invalidate.
  const expiredAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  await kv.set(
    'last-bearer-rotation',
    JSON.stringify({
      rotatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      expiresAt: expiredAt,
    }),
    { ex: 25 * 60 * 60 },
  );
  const mock = _makeRotationFetch({
    envs: [
      {
        id: 'env_prev_aud_03',
        key: 'MCP_BEARER_TOKEN_PREV',
        value: ROT_SECRETS.PREV_BEARER,
        target: ['production'],
        type: 'encrypted',
      },
      {
        id: 'env_current_aud_03',
        key: 'MCP_BEARER_TOKEN',
        value: ROT_SECRETS.CURRENT_BEARER,
        target: ['production'],
        type: 'encrypted',
      },
    ],
  });
  const origFetch = globalThis.fetch;
  globalThis.fetch = mock.impl;

  const cap = _captureRotationStderr();
  try {
    const handlerMod = await import(
      `../api/cron/invalidate-prev-bearer.mjs?aud03=${Date.now()}_${Math.random()}`
    );
    const handler = handlerMod.default;
    const req = _makeReq();
    const res = _makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.ok, true);
    assert.equal(body.skipped, undefined, 'must NOT be skipped (expired)');
    // PREV must have been deleted.
    const prev = mock.state.envs.find((e) => e.key === 'MCP_BEARER_TOKEN_PREV');
    assert.equal(prev, undefined);
  } finally {
    cap.restore();
    globalThis.fetch = origFetch;
    resetKvClient();
    _clearRotationEnv();
  }

  _assertNoRotationLeaks(cap.lines);
});
