// http.test.mjs — Vercel HTTP transport tests (WKH-65 / AC-13).
//
// Strategy:
//   - Import api/mcp.mjs default handler directly. Vercel's Node runtime
//     uses the same Web Standards `(Request) => Response` shape, so we can
//     exercise the function in-process without a real HTTP server.
//   - Set env vars for OPERATOR_PRIVATE_KEY, MCP_BEARER_TOKEN before each
//     test so config loads cleanly.
//   - Mock globalThis.fetch when exercising tools/call to avoid hitting
//     the real gateway (same pattern as tools.test.mjs).
//   - Spy process.stderr.write to verify PK + bearer NEVER appear in logs.
//
// Coverage (≥10 cases):
//   T-HTTP-01 401 on missing Authorization
//   T-HTTP-02 401 on malformed Authorization
//   T-HTTP-03 401 on wrong bearer token
//   T-HTTP-04 200 on initialize with correct bearer
//   T-HTTP-05 tools/list returns 3 tools (intact schemas)
//   T-HTTP-06 tools/call discover_agents delegates to handler (mock fetch)
//   T-HTTP-07 405 on GET / PUT / DELETE
//   T-HTTP-08 204 OPTIONS preflight allowed origin → echoes Allow-Origin
//   T-HTTP-09 204 OPTIONS preflight non-allowed origin → no Allow-Origin
//   T-HTTP-10 500 when MCP_BEARER_TOKEN is missing (auth not bypassed)
//   T-HTTP-11 PK + bearer NEVER appear in stderr across multiple paths
//   T-HTTP-12 auth check happens BEFORE body parse (AC-5)

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetWarnOnce } from '../src/log.mjs';

// Test vectors. Distinct strings so substring leak checks are unambiguous.
const TEST_PK = '0x' + 'de'.repeat(32);                 // 64 hex chars
const PK_BARE_LOWER = 'de'.repeat(32);
const PK_BARE_UPPER = 'DE'.repeat(32);
const TEST_BEARER = 'cafebabe' + 'a'.repeat(56);        // 64 hex chars
const WRONG_BEARER = 'deadbeef' + 'b'.repeat(56);       // same length, wrong

// Capture stderr lines.
function captureStderr() {
  const orig = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (const part of s.split('\n')) {
      if (part.length) lines.push(part);
    }
    return true;
  };
  return {
    lines,
    restore() { process.stderr.write = orig; },
  };
}

// Build a JSON-RPC POST Request to /api/mcp.
function jsonRpcRequest(body, { auth = `Bearer ${TEST_BEARER}`, method = 'POST', extraHeaders = {} } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...extraHeaders,
  };
  if (auth !== null) headers.Authorization = auth;
  return new Request('https://wasiai-x402-mcp.vercel.app/api/mcp', {
    method,
    headers,
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });
}

async function loadHandler() {
  // Reload module to pick up env-driven behavior on every test (cheap).
  const mod = await import(`../api/mcp.mjs?t=${Date.now()}_${Math.random()}`);
  return mod.default;
}

beforeEach(() => {
  process.env.OPERATOR_PRIVATE_KEY = TEST_PK;
  process.env.MCP_BEARER_TOKEN = TEST_BEARER;
  process.env.WASIAI_GATEWAY_URL = 'https://app.wasiai.io';
  process.env.MCP_CORS_ALLOWED_ORIGINS = 'https://platform.claude.com,https://claude.ai';
  resetWarnOnce();
});

afterEach(() => {
  // No-op — env vars are reset on next beforeEach.
});

// ──────────────────────────────────────────────────────────────────────────
// AUTH PATH
// ──────────────────────────────────────────────────────────────────────────

test('T-HTTP-01 (AC-5): 401 on missing Authorization header', async () => {
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = jsonRpcRequest(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } },
      { auth: null },
    );
    const res = await handler(req);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.deepEqual(body, { error: 'unauthorized' });
    // Bearer must NOT appear in stderr for this path.
    const blob = cap.lines.join('\n');
    assert.ok(!blob.includes(TEST_BEARER), 'bearer must not be logged');
  } finally {
    cap.restore();
  }
});

test('T-HTTP-02 (AC-6): 401 on malformed Authorization (no Bearer prefix)', async () => {
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = jsonRpcRequest(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { auth: `Basic ${TEST_BEARER}` },
    );
    const res = await handler(req);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.deepEqual(body, { error: 'unauthorized' });
  } finally {
    cap.restore();
  }
});

test('T-HTTP-03 (AC-6): 401 on wrong bearer token (same length)', async () => {
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = jsonRpcRequest(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { auth: `Bearer ${WRONG_BEARER}` },
    );
    const res = await handler(req);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.deepEqual(body, { error: 'unauthorized' });
    // The wrong bearer the attacker presented MUST NOT be echoed in logs.
    const blob = cap.lines.join('\n');
    assert.ok(!blob.includes(WRONG_BEARER), 'presented bearer must not be logged');
  } finally {
    cap.restore();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// HAPPY PATH (initialize + tools/list + tools/call)
// ──────────────────────────────────────────────────────────────────────────

test('T-HTTP-04 (AC-1): 200 on initialize with correct bearer', async () => {
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = jsonRpcRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.0.1' },
      },
    });
    const res = await handler(req);
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${await res.clone().text()}`);
    const text = await res.text();
    // Body may be JSON or SSE-framed JSON. We accept either.
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      // SSE frame: extract `data:` line.
      const dataLine = text.split('\n').find(l => l.startsWith('data:'));
      assert.ok(dataLine, `unparseable initialize response: ${text}`);
      payload = JSON.parse(dataLine.slice(5).trim());
    }
    assert.equal(payload.jsonrpc, '2.0');
    assert.equal(payload.id, 1);
    assert.equal(payload.result.serverInfo.name, 'wasiai-x402');
    assert.equal(payload.result.serverInfo.version, '0.1.0');
    assert.ok(payload.result.capabilities.tools);
  } finally {
    cap.restore();
  }
});

test('T-HTTP-05 (AC-2): tools/list returns 3 tools with intact schemas', async () => {
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = jsonRpcRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
    const res = await handler(req);
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${await res.clone().text()}`);
    const text = await res.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      const dataLine = text.split('\n').find(l => l.startsWith('data:'));
      assert.ok(dataLine, `unparseable tools/list response: ${text}`);
      payload = JSON.parse(dataLine.slice(5).trim());
    }
    const names = payload.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['discover_agents', 'get_payment_quote', 'pay_x402']);
    // Schemas intact: pay_x402 has 'maxAmountWei'.
    const pay = payload.result.tools.find((t) => t.name === 'pay_x402');
    assert.ok(pay.inputSchema.properties.maxAmountWei);
    assert.ok(pay.inputSchema.properties.endpoint);
  } finally {
    cap.restore();
  }
});

test('T-HTTP-06 (AC-3): tools/call discover_agents delegates to handler (mock fetch)', async () => {
  const handler = await loadHandler();
  const cap = captureStderr();
  // Mock the gateway fetch.
  const fetchCalls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({
      url: typeof url === 'string' ? url : url.toString(),
      method: init.method ?? 'GET',
      redirect: init.redirect,
    });
    return new Response(
      JSON.stringify({ agents: [{ id: 'agent-1', name: 'echo' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    const req = jsonRpcRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'discover_agents',
        arguments: { query: 'echo' },
      },
    });
    const res = await handler(req);
    assert.equal(res.status, 200);
    const text = await res.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      const dataLine = text.split('\n').find(l => l.startsWith('data:'));
      assert.ok(dataLine, `unparseable tools/call response: ${text}`);
      payload = JSON.parse(dataLine.slice(5).trim());
    }
    // CallTool returns content: [{ type:'text', text: JSON.stringify(...) }].
    const content = payload.result.content;
    assert.ok(Array.isArray(content) && content.length === 1);
    assert.equal(content[0].type, 'text');
    const inner = JSON.parse(content[0].text);
    assert.deepEqual(inner, { agents: [{ id: 'agent-1', name: 'echo' }] });
    // The handler called fetch with the gateway capabilities URL.
    assert.equal(fetchCalls.length, 1);
    const u = new URL(fetchCalls[0].url);
    assert.equal(u.hostname, 'app.wasiai.io');
    assert.equal(u.pathname, '/api/v1/capabilities');
    assert.equal(u.searchParams.get('query'), 'echo');
    // BLQ-iter3-1 invariant: redirect:'error' is set on the gateway fetch.
    assert.equal(fetchCalls[0].redirect, 'error');
  } finally {
    globalThis.fetch = origFetch;
    cap.restore();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// METHOD GATE
// ──────────────────────────────────────────────────────────────────────────

test('T-HTTP-07a: 405 on GET', async () => {
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = jsonRpcRequest({}, { method: 'GET' });
    const res = await handler(req);
    assert.equal(res.status, 405);
    const body = await res.json();
    assert.deepEqual(body, { error: 'method not allowed' });
  } finally {
    cap.restore();
  }
});

test('T-HTTP-07b: 405 on PUT', async () => {
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = new Request('https://wasiai-x402-mcp.vercel.app/api/mcp', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TEST_BEARER}` },
    });
    const res = await handler(req);
    assert.equal(res.status, 405);
  } finally {
    cap.restore();
  }
});

test('T-HTTP-07c: 405 on DELETE', async () => {
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = new Request('https://wasiai-x402-mcp.vercel.app/api/mcp', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TEST_BEARER}` },
    });
    const res = await handler(req);
    assert.equal(res.status, 405);
  } finally {
    cap.restore();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// CORS
// ──────────────────────────────────────────────────────────────────────────

test('T-HTTP-08 (AC-9): OPTIONS preflight with allowed origin echoes Allow-Origin', async () => {
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = new Request('https://wasiai-x402-mcp.vercel.app/api/mcp', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://platform.claude.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization, Content-Type',
      },
    });
    const res = await handler(req);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://platform.claude.com');
    assert.match(res.headers.get('access-control-allow-methods') ?? '', /POST/);
    assert.match(res.headers.get('access-control-allow-headers') ?? '', /Authorization/i);
  } finally {
    cap.restore();
  }
});

test('T-HTTP-09 (AC-9): OPTIONS preflight with non-allowed origin omits Allow-Origin', async () => {
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = new Request('https://wasiai-x402-mcp.vercel.app/api/mcp', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.com',
        'Access-Control-Request-Method': 'POST',
      },
    });
    const res = await handler(req);
    assert.equal(res.status, 204);
    // Either absent or empty string — both are equivalent for the browser
    // and prevent the cross-origin request.
    const allow = res.headers.get('access-control-allow-origin');
    assert.ok(!allow, `expected no Allow-Origin, got: ${allow}`);
  } finally {
    cap.restore();
  }
});

test('T-HTTP-09b (AC-9): OPTIONS preflight when MCP_CORS_ALLOWED_ORIGINS is empty omits Allow-Origin', async () => {
  process.env.MCP_CORS_ALLOWED_ORIGINS = '';
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = new Request('https://wasiai-x402-mcp.vercel.app/api/mcp', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://platform.claude.com',
      },
    });
    const res = await handler(req);
    assert.equal(res.status, 204);
    const allow = res.headers.get('access-control-allow-origin');
    assert.ok(!allow, `expected no Allow-Origin when env empty, got: ${allow}`);
  } finally {
    cap.restore();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// MISCONFIG (AC-7, CD-7)
// ──────────────────────────────────────────────────────────────────────────

test('T-HTTP-10 (AC-7): 500 when MCP_BEARER_TOKEN is missing — auth NOT bypassed', async () => {
  delete process.env.MCP_BEARER_TOKEN;
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = jsonRpcRequest({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
    }, { auth: `Bearer anything-goes` });
    const res = await handler(req);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.deepEqual(body, { error: 'server misconfigured' });
    // Structured log line was emitted.
    const blob = cap.lines.join('\n');
    assert.match(blob, /missing-bearer-token/);
  } finally {
    cap.restore();
  }
});

test('T-HTTP-10b (AC-7): 500 when OPERATOR_PRIVATE_KEY is missing', async () => {
  delete process.env.OPERATOR_PRIVATE_KEY;
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = jsonRpcRequest({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
    });
    const res = await handler(req);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.deepEqual(body, { error: 'server misconfigured' });
  } finally {
    cap.restore();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// LEAK ASSERTIONS (AC-8, CD-1, CD-5)
// ──────────────────────────────────────────────────────────────────────────

test('T-HTTP-11 (AC-8): PK + bearer NEVER appear in stderr across error paths', async () => {
  const cap = captureStderr();
  try {
    // Path A — missing auth.
    {
      const handler = await loadHandler();
      const req = jsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { auth: null });
      await handler(req);
    }
    // Path B — wrong bearer.
    {
      const handler = await loadHandler();
      const req = jsonRpcRequest({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }, { auth: `Bearer ${WRONG_BEARER}` });
      await handler(req);
    }
    // Path C — malformed bearer.
    {
      const handler = await loadHandler();
      const req = jsonRpcRequest({ jsonrpc: '2.0', id: 3, method: 'initialize', params: {} }, { auth: `Basic ${TEST_BEARER}` });
      await handler(req);
    }
    // Path D — 405 on GET.
    {
      const handler = await loadHandler();
      const req = new Request('https://wasiai-x402-mcp.vercel.app/api/mcp', {
        method: 'GET', headers: { Authorization: `Bearer ${TEST_BEARER}` },
      });
      await handler(req);
    }
    // Path E — happy path tools/list (forces config.startup log).
    {
      const handler = await loadHandler();
      const req = jsonRpcRequest({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} });
      await handler(req);
    }

    const blob = cap.lines.join('\n');
    // PK in any case form.
    assert.ok(!blob.includes(PK_BARE_LOWER), `stderr leaked PK (lower): see lines\n${blob}`);
    assert.ok(!blob.includes(PK_BARE_UPPER), `stderr leaked PK (upper): see lines\n${blob}`);
    assert.ok(!blob.includes(TEST_PK), `stderr leaked PK (0x-form): see lines\n${blob}`);
    // Bearer (correct) must never appear.
    assert.ok(!blob.includes(TEST_BEARER), `stderr leaked correct bearer: see lines\n${blob}`);
    // Bearer (wrong, attacker-presented) must also never appear — we treat
    // any presented bearer as a secret in case it is reused as the real
    // token elsewhere.
    assert.ok(!blob.includes(WRONG_BEARER), `stderr leaked presented bearer: see lines\n${blob}`);
  } finally {
    cap.restore();
  }
});

test('T-HTTP-12 (AC-5): auth check runs BEFORE body parse', async () => {
  // We craft a payload large enough that, if it were parsed and the parser
  // failed, we'd get a different error. Even with malformed body, missing
  // Authorization → 401 (parser never runs).
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = new Request('https://wasiai-x402-mcp.vercel.app/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-valid-json' + 'x'.repeat(500),
    });
    const res = await handler(req);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.deepEqual(body, { error: 'unauthorized' });
  } finally {
    cap.restore();
  }
});

// ──────────────────────────────────────────────────────────────────────────
// FIX-PACK iter 1 — MNR-AR-2 + MNR-CR-6 covering tests
// ──────────────────────────────────────────────────────────────────────────

test('T-FIX-1 (MNR-AR-2): POST with allowed origin echoes Access-Control-Allow-Origin + Vary', async () => {
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    // tools/list is a happy-path call that returns 200 without needing fetch.
    const req = new Request('https://wasiai-x402-mcp.vercel.app/api/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TEST_BEARER}`,
        Origin: 'https://platform.claude.com',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const res = await handler(req);
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    // MNR-AR-2: response must echo Allow-Origin for browser cross-origin reads.
    assert.equal(
      res.headers.get('access-control-allow-origin'),
      'https://platform.claude.com',
      'POST response must echo allowed origin',
    );
    const vary = res.headers.get('vary') ?? '';
    assert.match(vary, /Origin/i, 'Vary must include Origin (cache correctness)');
  } finally {
    cap.restore();
  }
});

test('T-FIX-2 (MNR-AR-2): POST with non-allowed origin omits Access-Control-Allow-Origin', async () => {
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = new Request('https://wasiai-x402-mcp.vercel.app/api/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${TEST_BEARER}`,
        Origin: 'https://evil.com',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const res = await handler(req);
    // The JSON-RPC call should still succeed (CORS is enforced by the
    // browser, not by us refusing the body), but the response MUST NOT
    // include Allow-Origin so the browser blocks the JS read.
    assert.equal(res.status, 200);
    const allow = res.headers.get('access-control-allow-origin');
    assert.ok(!allow, `expected no Allow-Origin for non-allowed origin, got: ${allow}`);
  } finally {
    cap.restore();
  }
});

test('T-FIX-3 (MNR-CR-6): 401 short-circuits BEFORE loadConfig (no DNS / SSRF validation on unauth)', async () => {
  // Strategy: set WASIAI_GATEWAY_URL to a value that loadConfig would reject
  // (validateGatewayUrl flags it as invalid scheme). If the handler ran
  // loadConfig before auth, the response would be 500 ("server
  // misconfigured"). With auth-first ordering, an unauth caller MUST get
  // 401 — proving the config code path (and its DNS/SSRF lookups) was
  // never reached.
  process.env.WASIAI_GATEWAY_URL = 'ftp://invalid-scheme.example';
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = new Request('https://wasiai-x402-mcp.vercel.app/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }, // no Authorization
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    const res = await handler(req);
    assert.equal(res.status, 401, 'unauth → 401 (auth-first), NOT 500 (config validated before auth)');
    const body = await res.json();
    assert.deepEqual(body, { error: 'unauthorized' });
    // Negative log assertion: we should have an mcp.http.unauthorized log
    // line, but NOT mcp.http.config-error / config-error-unexpected.
    const blob = cap.lines.join('\n');
    assert.match(blob, /mcp\.http\.unauthorized/, 'expected unauthorized log');
    assert.ok(
      !/mcp\.http\.config-error/.test(blob),
      `loadConfig must NOT have run: stderr leaked config-error log: ${blob}`,
    );
    // Sanity: confirm loadConfig WOULD have failed if it had run, by
    // calling it directly with the same env var. This pins the test's
    // negative assertion to a truly-broken config (so the test can never
    // accidentally green if loadConfig becomes a no-op).
    const { loadConfig } = await import('../src/config.mjs');
    await assert.rejects(
      () => loadConfig(),
      (err) => /WASIAI_GATEWAY_URL invalid/.test(err.message),
      'sanity: loadConfig should reject ftp:// gateway',
    );
  } finally {
    delete process.env.WASIAI_GATEWAY_URL;
    cap.restore();
  }
});
