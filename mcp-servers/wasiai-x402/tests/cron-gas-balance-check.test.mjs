// cron-gas-balance-check.test.mjs — WKH-71 gas monitor cron handler.
//
// Integration-style: mocks the RPC (eth_getBalance) + webhook via global fetch,
// asserting auth (CD-4), read-only balance reads (CD-3, AC-5), the alert body
// whitelist (CD-2) and always-200 fail-open (CD-4).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { resetWarnOnce } from '../src/log.mjs';

const TEST_SECRET = 'cron-secret-' + 'a'.repeat(20);
const WALLET_A = '0x9c0638506F8C5fc44F0d8C7b9E9e267eA311BB5c';

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

// Mock a JSON-RPC endpoint that ONLY answers eth_getBalance (read-only). Any
// write method (eth_sendRawTransaction) must never be called — it throws.
function makeRpcFetch(balanceWeiBig, seenMethods) {
  return async (url, init = {}) => {
    const body = JSON.parse(init.body);
    seenMethods.push(body.method);
    if (body.method === 'eth_getBalance') {
      const hex = '0x' + balanceWeiBig.toString(16);
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body.id, result: hex }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (body.method === 'eth_sendRawTransaction') {
      throw new Error('WRITE METHOD CALLED — monitor must be read-only');
    }
    // eth_chainId and other read probes viem may issue.
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0xa869' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
}

beforeEach(() => {
  origFetch = globalThis.fetch;
  process.env.CRON_SECRET = TEST_SECRET;
  resetWarnOnce();
});

afterEach(() => {
  globalThis.fetch = origFetch;
  delete process.env.CRON_SECRET;
  delete process.env.GAS_ALERT_TARGETS;
  delete process.env.MCP_ALERT_WEBHOOK_URL;
  delete process.env.GAS_ALERT_RPC_43113;
});

async function loadHandler() {
  const mod = await import(
    `../api/cron/gas-balance-check.mjs?t=${Date.now()}_${Math.random()}`
  );
  return mod.default;
}

test('T-GC-01: auth missing → 401, NO RPC call', async () => {
  const seen = [];
  globalThis.fetch = makeRpcFetch(0n, seen);
  process.env.GAS_ALERT_TARGETS = JSON.stringify([
    { label: 'facilitator', address: WALLET_A, chainIds: [43113] },
  ]);
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq({ auth: null }), res);
    assert.equal(res.statusCode, 401);
    assert.equal(seen.length, 0, 'auth-fail must not touch RPC');
  } finally {
    cap.restore();
  }
});

test('T-GC-02: no targets configured → 200 checked:0 (fail-open)', async () => {
  const seen = [];
  globalThis.fetch = makeRpcFetch(0n, seen);
  // GAS_ALERT_TARGETS intentionally unset.
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.checked, 0);
    assert.match(cap.lines.join('\n'), /mcp\.gas-cron\.no-targets/);
  } finally {
    cap.restore();
  }
});

test('T-GC-03: critical balance → read-only getBalance + webhook fired, 200', async () => {
  const seen = [];
  process.env.GAS_ALERT_RPC_43113 = 'https://fuji.test.rpc/';
  process.env.MCP_ALERT_WEBHOOK_URL = 'https://hooks.example.com/x';
  process.env.GAS_ALERT_TARGETS = JSON.stringify([
    { label: 'facilitator', address: WALLET_A, chainIds: [43113] },
  ]);

  let webhookBody = null;
  const rpc = makeRpcFetch(0n, seen); // 0 AVAX → below critical
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('hooks.example.com')) {
      webhookBody = JSON.parse(init.body);
      return new Response('{}', { status: 200 });
    }
    return rpc(url, init);
  };

  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res._body);
    assert.equal(body.checked, 1);
    assert.equal(body.alerts, 1);
    // Read-only: eth_getBalance used, never a write.
    assert.ok(seen.includes('eth_getBalance'), 'must read via eth_getBalance');
    assert.ok(!seen.includes('eth_sendRawTransaction'));
    // Webhook body whitelist (CD-2): public fields only, no secrets.
    assert.ok(webhookBody, 'webhook should have been called');
    assert.equal(webhookBody.severity, 'critical');
    assert.equal(webhookBody.operator, WALLET_A);
    assert.equal(webhookBody.balanceNative, '0');
    assert.equal(webhookBody.symbol, 'AVAX');
    assert.ok(!('privateKey' in webhookBody));
    assert.ok(!('OPERATOR_PRIVATE_KEY' in webhookBody));
  } finally {
    cap.restore();
  }
});

test('T-GC-04: webhook failure → cron still 200 (CD-4)', async () => {
  const seen = [];
  process.env.MCP_ALERT_WEBHOOK_URL = 'https://hooks.example.com/x';
  process.env.GAS_ALERT_TARGETS = JSON.stringify([
    { label: 'facilitator', address: WALLET_A, chainIds: [43113] },
  ]);
  const rpc = makeRpcFetch(0n, seen);
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('hooks.example.com')) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    return rpc(url, init);
  };
  const handler = await loadHandler();
  const cap = captureStderr();
  try {
    const res = makeRes();
    await handler(makeReq(), res);
    assert.equal(res.statusCode, 200, 'cron must NOT 500 on webhook failure');
  } finally {
    cap.restore();
  }
});
