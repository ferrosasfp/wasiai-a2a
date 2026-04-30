// cron-balance-check.test.mjs — WKH-66 W3.4.
//
// 5 tests T-BC-01..T-BC-05.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setKvClientForTesting, resetKvClient } from '../src/kv-client.mjs';
import { resetWarnOnce } from '../src/log.mjs';
import { createKvMock } from './_mocks/kv-mock.mjs';

const TEST_SECRET = 'cron-secret-' + 'a'.repeat(20);
const TEST_PK = '0x' + 'cd'.repeat(32);

let origFetch;

function makeReq({ auth = `Bearer ${TEST_SECRET}` } = {}) {
  return { headers: auth === null ? {} : { authorization: auth }, method: 'GET' };
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

// Mock the Avalanche RPC by responding to eth_call (balanceOf) and
// eth_blockNumber. We answer 32-byte hex as expected.
function makeRpcFetch(balanceWeiBig, opts = {}) {
  const slowMs = opts.slowMs ?? 0;
  return async (url, init = {}) => {
    if (slowMs > 0) await new Promise((r) => setTimeout(r, slowMs));
    if (!String(url).includes('avax.network')) {
      throw new Error('rpc-fetch: unexpected URL ' + url);
    }
    const body = JSON.parse(init.body);
    if (body.method === 'eth_call') {
      const hex = '0x' + balanceWeiBig.toString(16).padStart(64, '0');
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: hex }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (body.method === 'eth_blockNumber') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0xbc614e' /* 12345678 */ }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: null }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
}

beforeEach(() => {
  origFetch = globalThis.fetch;
  process.env.CRON_SECRET = TEST_SECRET;
  process.env.OPERATOR_PRIVATE_KEY = TEST_PK;
  process.env.AVALANCHE_RPC_URL = 'https://api.avax.network/ext/bc/C/rpc';
  process.env.AVALANCHE_USDC_ADDRESS = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';
  process.env.MCP_OPERATOR_CHAIN_ID = '43114';
  process.env.MCP_BALANCE_THRESHOLD_USDC = '0.50';
  resetWarnOnce();
});

afterEach(() => {
  globalThis.fetch = origFetch;
  resetKvClient();
  delete process.env.CRON_SECRET;
  delete process.env.OPERATOR_PRIVATE_KEY;
  delete process.env.MCP_BALANCE_THRESHOLD_USDC;
  delete process.env.MCP_ALERT_WEBHOOK_URL;
});

async function loadHandler() {
  const mod = await import(`../api/cron/balance-check.mjs?t=${Date.now()}_${Math.random()}`);
  return mod.default;
}

test('T-BC-01: balance-check happy path 200 + KV snapshot persisted with TTL 1800s', async () => {
  const kv = createKvMock();
  setKvClientForTesting(kv);
  globalThis.fetch = makeRpcFetch(5_000_000n); // 5 USDC

  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.balanceWei, '5000000');
    assert.equal(body.balanceUsdc, 5);
    assert.match(body.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
    // Snapshot key persisted in KV.
    const snapEntry = Array.from(kv._store.entries())
      .find(([k]) => k.startsWith('balance-snapshot:'));
    assert.ok(snapEntry, 'snapshot must be in KV');
    // TTL ~1800s.
    assert.ok(
      snapEntry[1].expiresAt > Date.now() + 1700_000 &&
      snapEntry[1].expiresAt < Date.now() + 1900_000,
      `expected TTL ~1800s, got expiresAt=${snapEntry[1].expiresAt - Date.now()}ms in future`,
    );
  } finally {
    cap.restore();
  }
});

test('T-BC-02: balance < threshold + webhook configured → POST whitelist body', async () => {
  const kv = createKvMock();
  setKvClientForTesting(kv);
  process.env.MCP_ALERT_WEBHOOK_URL = 'https://hooks.example.com/x';

  let webhookBody = null;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('hooks.example.com')) {
      webhookBody = JSON.parse(init.body);
      return new Response('{}', { status: 200 });
    }
    return makeRpcFetch(400_000n)(url, init); // 0.4 USDC < 0.5 threshold
  };

  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.ok(webhookBody, 'webhook should have been called');
    // Whitelist checks.
    assert.equal(webhookBody.severity, 'critical');
    assert.equal(webhookBody.chain, 'avalanche-c-chain-mainnet');
    assert.ok(webhookBody.operator.startsWith('0x'));
    assert.ok(webhookBody.balanceUsdc < 0.5);
    assert.equal(webhookBody.threshold, 0.5);
    // Forbidden keys must NOT be present.
    assert.ok(!('pk' in webhookBody));
    assert.ok(!('bearer' in webhookBody));
    assert.ok(!('OPERATOR_PRIVATE_KEY' in webhookBody));
  } finally {
    cap.restore();
  }
});

test('T-BC-03: webhook timeout → log only, cron still 200', async () => {
  const kv = createKvMock();
  setKvClientForTesting(kv);
  process.env.MCP_ALERT_WEBHOOK_URL = 'https://hooks.example.com/x';

  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('hooks.example.com')) {
      return new Promise((resolve, reject) => {
        const sig = init?.signal;
        if (sig && sig.addEventListener) {
          sig.addEventListener('abort', () => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            reject(e);
          });
        }
        // Never resolve — wait for abort.
      });
    }
    return makeRpcFetch(400_000n)(url, init);
  };

  // Reduce sendAlert timeout via MCP_ALERT_WEBHOOK_URL — but we use the
  // default 5s. To keep the test fast we shrink at the source: stub
  // AbortSignal.timeout call by overriding the env. The simplest path is
  // to assert end-to-end by setting fetch to reject quickly via abort.
  // We trigger abort manually by polluting AbortSignal isn't easy; instead
  // override timeout via a tighter signal in test. We patch the imported
  // alerts module to use 100ms. Skip patching: use a sync rejected fetch
  // that simulates a timeout outcome.
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('hooks.example.com')) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    return makeRpcFetch(400_000n)(url, init);
  };

  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200, 'cron must NOT 500 on webhook failure');
    const body = JSON.parse(res._body);
    assert.ok(body.balanceUsdc < 0.5);
    const blob = cap.lines.join('\n');
    assert.match(blob, /mcp\.alert\.webhook-failed/);
  } finally {
    cap.restore();
  }
});

test('T-BC-04: webhook URL not set → warnOnce + 200', async () => {
  const kv = createKvMock();
  setKvClientForTesting(kv);
  // MCP_ALERT_WEBHOOK_URL intentionally NOT set.
  delete process.env.MCP_ALERT_WEBHOOK_URL;

  globalThis.fetch = makeRpcFetch(400_000n);
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    const blob = cap.lines.join('\n');
    assert.match(blob, /mcp\.alert\.no-webhook-configured/);
  } finally {
    cap.restore();
  }
});

test('T-BC-05: auth missing → 401, NO RPC call', async () => {
  const kv = createKvMock();
  setKvClientForTesting(kv);
  let rpcCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    rpcCalls += 1;
    return makeRpcFetch(5_000_000n)(url, init);
  };

  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const req = makeReq({ auth: null });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 401);
    assert.equal(rpcCalls, 0, 'auth-fail must not invoke RPC');
  } finally {
    cap.restore();
  }
});
