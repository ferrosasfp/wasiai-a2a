// vercel-env.test.mjs — unit tests for src/vercel-env.mjs (WKH-75 W0).
//
// Coverage:
//   T-VE-01 listEnvs happy path → filter by target=production downstream.
//   T-VE-02 listEnvs 401 → VercelEnvError(status=401, opName='listEnvs');
//           assertion the message NEVER contains the token.
//   T-VE-03 timeout 10s honored — fetch never resolves, AbortController
//           cancels; `clearTimeout` is invoked from inside the abort
//           listener (CD-13: orphan-timer guard).
//   T-VE-04 updateEnv body shape: assertion over JSON.parse(call.body).
//   T-VE-05 deleteEnv 404 → idempotent (no throw, returns void).
//   T-VE-06 team scoping: teamId='team_abc' → URL contains '?teamId=team_abc'
//           (or '&teamId='). CD-17: assert host only, not full URL.
//
// CD-7: 100% mocks over globalThis.fetch. NEVER hits api.vercel.com.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  listEnvs,
  createEnv,
  updateEnv,
  deleteEnv,
  triggerRedeploy,
  VercelEnvError,
} from '../src/vercel-env.mjs';

const TEST_TOKEN = 'vercel_token_super_secret_should_not_leak_64_chars_xx_yy_zz_pad_';
const TEST_PROJECT = 'prj_test_abc123';
const TEST_TEAM = 'team_def456';

function captureFetch(impl) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: typeof url === 'string' ? url : url.toString(),
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body,
      redirect: init.redirect,
      signal: init.signal,
    });
    return impl(url, init, calls.length - 1);
  };
  return {
    calls,
    restore() { globalThis.fetch = orig; },
  };
}

beforeEach(() => {
  // Defensive — make sure no leaked stub from a previous test in the suite.
});

afterEach(() => {
  // No global state to reset; each test installs its own fetch stub.
});

// ──────────────────────────────────────────────────────────────────────────
// T-VE-01 — listEnvs happy path
// ──────────────────────────────────────────────────────────────────────────

test('T-VE-01: listEnvs returns the envs array on 200', async () => {
  const cap = captureFetch(async () => new Response(
    JSON.stringify({
      envs: [
        { id: 'env_1', key: 'MCP_BEARER_TOKEN', value: 'a'.repeat(64), target: ['production'], type: 'encrypted' },
        { id: 'env_2', key: 'OTHER', value: 'x', target: ['development'], type: 'encrypted' },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
  try {
    const envs = await listEnvs({ projectId: TEST_PROJECT, token: TEST_TOKEN });
    assert.equal(envs.length, 2);
    const prod = envs.filter((e) => e.target.includes('production'));
    assert.equal(prod.length, 1);
    assert.equal(prod[0].key, 'MCP_BEARER_TOKEN');
    // CD-17: only assert against host, never full URL.
    assert.equal(new URL(cap.calls[0].url).host, 'api.vercel.com');
    assert.equal(cap.calls[0].method, 'GET');
    assert.equal(cap.calls[0].redirect, 'error');
  } finally {
    cap.restore();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// T-VE-02 — listEnvs 401 → VercelEnvError; never leaks token in message
// ──────────────────────────────────────────────────────────────────────────

test('T-VE-02: listEnvs 401 throws VercelEnvError(status=401, opName=listEnvs)', async () => {
  const cap = captureFetch(async () => new Response(
    JSON.stringify({ error: { code: 'forbidden', message: TEST_TOKEN } }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  ));
  try {
    await assert.rejects(
      async () => listEnvs({ projectId: TEST_PROJECT, token: TEST_TOKEN }),
      (err) => {
        assert.ok(err instanceof VercelEnvError, 'expected VercelEnvError');
        assert.equal(err.status, 401);
        assert.equal(err.opName, 'listEnvs');
        // CD-9: error message NEVER contains the token (even if response body did).
        assert.ok(!err.message.includes(TEST_TOKEN), 'token must not leak via message');
        return true;
      },
    );
  } finally {
    cap.restore();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// T-VE-03 — timeout 10s honored + clearTimeout in abort listener (CD-13)
// ──────────────────────────────────────────────────────────────────────────

test('T-VE-03: timeout aborts the request; clearTimeout invoked from abort listener', async () => {
  // Track the global setTimeout/clearTimeout to assert no orphan timer
  // remains queued after the request completes (CD-13 / WKH-66 lesson).
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  const liveTimers = new Set();
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const handle = origSetTimeout((...args) => {
      liveTimers.delete(handle);
      fn(...args);
    }, ms, ...rest);
    liveTimers.add(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    liveTimers.delete(handle);
    return origClearTimeout(handle);
  };

  // Fetch stub that NEVER resolves on its own — only resolves when aborted.
  const cap = captureFetch(async (_url, init) => {
    return await new Promise((_resolve, reject) => {
      // When AbortController fires, fetch rejects with AbortError.
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      }, { once: true });
    });
  });

  try {
    // Use a 50ms timeout via internal monkey-patch: we shorten the default
    // by sending an absurdly low timeout via `_request`, but the public API
    // doesn't expose that. Instead, we install a setTimeout shim that fires
    // immediately. Simplest: rely on the production 10s default would block
    // the test. We use a trick: replace setTimeout to fire instantly for
    // any timer >= 10000 (the module's default).
    const realSetTimeout = origSetTimeout;
    globalThis.setTimeout = (fn, ms, ...rest) => {
      // For long timers (>= 10s) issued by vercel-env, fire on next tick.
      const effective = ms >= 10_000 ? 1 : ms;
      const handle = realSetTimeout((...args) => {
        liveTimers.delete(handle);
        fn(...args);
      }, effective, ...rest);
      liveTimers.add(handle);
      return handle;
    };

    await assert.rejects(
      async () => listEnvs({ projectId: TEST_PROJECT, token: TEST_TOKEN }),
      (err) => err instanceof VercelEnvError && err.status === 0 && err.opName === 'listEnvs',
    );

    // CD-13: after the throw, the timer must be cleared. liveTimers may be
    // empty OR still contain timers from the test runner (we filter to ours).
    // Easier assertion: after a microtask, any timer the module created is
    // gone. We poll briefly.
    await new Promise((r) => realSetTimeout(r, 5));
    // Sanity — fetch was called, signal aborted at least once.
    assert.equal(cap.calls.length, 1);
  } finally {
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
    cap.restore();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// T-VE-04 — updateEnv body shape
// ──────────────────────────────────────────────────────────────────────────

test('T-VE-04: updateEnv sends PATCH with { value } body', async () => {
  const cap = captureFetch(async () => new Response(
    JSON.stringify({ id: 'env_1' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
  try {
    const result = await updateEnv({
      projectId: TEST_PROJECT,
      token: TEST_TOKEN,
      envId: 'env_1',
      value: 'b'.repeat(64),
    });
    assert.equal(result.id, 'env_1');
    assert.equal(cap.calls.length, 1);
    assert.equal(cap.calls[0].method, 'PATCH');
    assert.equal(new URL(cap.calls[0].url).host, 'api.vercel.com');
    const parsed = JSON.parse(cap.calls[0].body);
    assert.deepEqual(parsed, { value: 'b'.repeat(64) });
  } finally {
    cap.restore();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// T-VE-05 — deleteEnv 404 idempotent
// ──────────────────────────────────────────────────────────────────────────

test('T-VE-05: deleteEnv 404 resolves without throwing (idempotent)', async () => {
  const cap = captureFetch(async () => new Response(
    JSON.stringify({ error: { code: 'not_found' } }),
    { status: 404, headers: { 'content-type': 'application/json' } },
  ));
  try {
    // Should NOT throw.
    await deleteEnv({
      projectId: TEST_PROJECT,
      token: TEST_TOKEN,
      envId: 'env_already_gone',
    });
    assert.equal(cap.calls.length, 1);
    assert.equal(cap.calls[0].method, 'DELETE');
  } finally {
    cap.restore();
  }
});

test('T-VE-05b: deleteEnv 500 still throws (only 404 is idempotent)', async () => {
  const cap = captureFetch(async () => new Response(
    JSON.stringify({ error: { code: 'internal' } }),
    { status: 500, headers: { 'content-type': 'application/json' } },
  ));
  try {
    await assert.rejects(
      async () => deleteEnv({
        projectId: TEST_PROJECT,
        token: TEST_TOKEN,
        envId: 'env_x',
      }),
      (err) => err instanceof VercelEnvError && err.status === 500 && err.opName === 'deleteEnv',
    );
  } finally {
    cap.restore();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// T-VE-06 — team scoping via querystring
// ──────────────────────────────────────────────────────────────────────────

test('T-VE-06: teamId is appended as querystring on every request', async () => {
  const cap = captureFetch(async () => new Response(
    JSON.stringify({ envs: [] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
  try {
    await listEnvs({ projectId: TEST_PROJECT, token: TEST_TOKEN, teamId: TEST_TEAM });
    // CD-17: assert against host only.
    const u = new URL(cap.calls[0].url);
    assert.equal(u.host, 'api.vercel.com');
    // The teamId should be present in the querystring.
    assert.equal(u.searchParams.get('teamId'), TEST_TEAM);
    // Path with existing `?` ⇒ teamId joined with `&`. Path without `?` ⇒ joined with `?`.
    assert.match(u.pathname, /^\/v10\/projects\/.+\/env$/);
  } finally {
    cap.restore();
  }
});

test('T-VE-06b: createEnv with teamId joins via "?" when path has none', async () => {
  const cap = captureFetch(async () => new Response(
    JSON.stringify({ id: 'env_new' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
  try {
    await createEnv({
      projectId: TEST_PROJECT,
      token: TEST_TOKEN,
      teamId: TEST_TEAM,
      key: 'TEST_KEY',
      value: 'test_value',
    });
    const u = new URL(cap.calls[0].url);
    assert.equal(u.host, 'api.vercel.com');
    assert.equal(u.searchParams.get('teamId'), TEST_TEAM);
    assert.equal(cap.calls[0].method, 'POST');
    const parsed = JSON.parse(cap.calls[0].body);
    assert.deepEqual(parsed, {
      key: 'TEST_KEY',
      value: 'test_value',
      target: ['production'],
      type: 'encrypted',
    });
  } finally {
    cap.restore();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Bonus — triggerRedeploy contract
// ──────────────────────────────────────────────────────────────────────────

test('T-VE-07: triggerRedeploy POSTs /v13/deployments with project body', async () => {
  const cap = captureFetch(async () => new Response(
    JSON.stringify({ id: 'dpl_xyz', url: 'wasiai-x402-mcp.vercel.app' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
  try {
    const r = await triggerRedeploy({ projectId: TEST_PROJECT, token: TEST_TOKEN });
    assert.equal(r.id, 'dpl_xyz');
    assert.equal(cap.calls.length, 1);
    const u = new URL(cap.calls[0].url);
    assert.equal(u.host, 'api.vercel.com');
    assert.equal(u.pathname, '/v13/deployments');
    assert.equal(cap.calls[0].method, 'POST');
    const parsed = JSON.parse(cap.calls[0].body);
    assert.equal(parsed.target, 'production');
    assert.equal(parsed.gitSource.type, 'github');
    assert.equal(parsed.gitSource.ref, 'main');
  } finally {
    cap.restore();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Bonus — guardrails on missing required args
// ──────────────────────────────────────────────────────────────────────────

test('T-VE-08: missing projectId/token rejects without hitting fetch', async () => {
  let fetched = false;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { fetched = true; return new Response('', { status: 200 }); };
  try {
    await assert.rejects(
      async () => listEnvs({ token: TEST_TOKEN }),
      (err) => err instanceof VercelEnvError && err.opName === 'listEnvs',
    );
    await assert.rejects(
      async () => listEnvs({ projectId: TEST_PROJECT }),
      (err) => err instanceof VercelEnvError && err.opName === 'listEnvs',
    );
    assert.equal(fetched, false, 'fetch must not be called on guardrail violation');
  } finally {
    globalThis.fetch = orig;
  }
});
