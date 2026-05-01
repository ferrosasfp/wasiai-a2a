// handlers-balance-gate.test.mjs — WKH-67 W4.
//
// 11 core tests + 3 adversarial covering AC-1..AC-7 + V1, V7, V9 of the
// in-handler balance-gate contract. The gate now lives INSIDE
// payX402Handler (post-probe, pre-cap-guard). Decimals separation:
//   - INBOUND PYUSD 18d  → args.maxAmountWei  (cap guard, [2])
//   - OUTBOUND USDC 6d   → payload.maxBudget  (balance gate, [1.5])
//
// Test surface:
//   - Override globalThis.fetch with a programmable fake. The fake
//     intercepts BOTH the gateway probe/settle calls AND the Avalanche
//     RPC eth_call that viem performs from inside checkBalanceWithClaim.
//   - setKvClientForTesting injects a kv-mock so we never hit Upstash.
//   - _resetAvaxClient() clears the singleton between tests so each test
//     starts from a clean viem PublicClient bound to the test fetch.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetWarnOnce } from '../src/log.mjs';
import { setKvClientForTesting, resetKvClient } from '../src/kv-client.mjs';
import { _resetAvaxClient } from '../src/avax-client.mjs';
import { createKvMock } from './_mocks/kv-mock.mjs';

const TEST_PK = '0x' + 'de'.repeat(32);

// USDC has 6 decimals on Avalanche → 1 USDC = 1_000_000n wei.
function usdc(n) {
  return BigInt(Math.round(n * 1_000_000));
}

// Encode a bigint balance as the 32-byte hex eth_call would return.
function balanceHex(weiBigint) {
  return '0x' + weiBigint.toString(16).padStart(64, '0');
}

// Build a fake config matching loadConfig output (mirrors tools.test.mjs).
function fakeConfig(overrides = {}) {
  return {
    operatorAddress: '0x' + 'aa'.repeat(20),
    gatewayUrl: new URL('https://app.wasiai.io'),
    chainId: 2368,
    contract: '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9',
    domainName: 'PYUSD',
    domainVersion: '1',
    maxAmountWeiDefault: undefined,
    payTimeoutMs: 5000,
    nodeEnv: 'development',
    ...overrides,
  };
}

// Programmable fetch fake. Intercepts:
//   - https://api.avax.network/... (RPC eth_call) → returns balance hex.
//   - https://app.wasiai.io/...    (gateway)      → returns the next canned
//     response from `gatewayResponses` in declared order.
function makeFetchFake({ balanceWei = usdc(1), gatewayResponses = [], onRpc, onGateway } = {}) {
  const calls = [];
  const rpcCalls = [];
  let gwIdx = 0;
  const fetchFn = async (url, init = {}) => {
    const u = typeof url === 'string' ? url : url.toString();
    const call = {
      url: u,
      method: init.method ?? 'GET',
      headers: { ...(init.headers ?? {}) },
      body: init.body,
      redirect: init.redirect,
    };
    calls.push(call);
    if (u.includes('avax.network')) {
      rpcCalls.push(call);
      if (onRpc) {
        const r = onRpc(call, rpcCalls.length);
        if (r) return r;
      }
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: balanceHex(balanceWei) }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (onGateway) {
      const r = onGateway(call);
      if (r) return r;
    }
    const r = gatewayResponses[gwIdx];
    if (!r) throw new Error(`fake fetch: no canned gateway response for #${gwIdx + 1} ${call.method} ${u}`);
    gwIdx += 1;
    if (r.throw) throw r.throw;
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    return new Response(text, {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchFn, calls, rpcCalls };
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

async function loadHandlers() {
  return await import('../src/handlers.mjs');
}

let _origFetch;
let _kv;

beforeEach(() => {
  process.env.OPERATOR_PRIVATE_KEY = TEST_PK;
  process.env.MCP_BALANCE_THRESHOLD_USDC = '0.50';
  process.env.MCP_OPERATOR_CHAIN_ID = '43114';
  process.env.AVALANCHE_RPC_URL = 'https://api.avax.network/ext/bc/C/rpc';
  process.env.AVALANCHE_USDC_ADDRESS = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';
  resetWarnOnce();
  resetKvClient();
  _resetAvaxClient();
  _kv = createKvMock();
  setKvClientForTesting(_kv);
  _origFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = _origFetch;
  resetKvClient();
  _resetAvaxClient();
  delete process.env.MCP_BALANCE_THRESHOLD_USDC;
  delete process.env.MCP_OPERATOR_CHAIN_ID;
  delete process.env.AVALANCHE_RPC_URL;
  delete process.env.AVALANCHE_USDC_ADDRESS;
});

// ── T-FIX-01 (AC-1): Happy path — payload.maxBudget=0.5 + balance OK → settled
test('T-FIX-01 (AC-1): pay_x402 with payload.maxBudget=0.5 + balance OK → settled', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000000000000000000', network: 'eip155:2368' };
  const { fetchFn, calls, rpcCalls } = makeFetchFake({
    balanceWei: usdc(1),
    gatewayResponses: [
      { status: 402, body: { accepts: [accepts] } },
      { status: 200, body: { kiteTxHash: '0xabc', settled: true } },
    ],
  });
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler(
      { endpoint: '/api/v1/orchestrate', payload: { maxBudget: 0.5, task: 'foo' } },
      fakeConfig(),
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.stage, 'settled');
    assert.equal(r.kiteTxHash, '0xabc');
    // RPC was hit once for balanceOf.
    assert.equal(rpcCalls.length, 1, 'RPC must be called for balance read');
    // Claim was incremented + then released (decrby called).
    const claimKey = `balance-claim:eip155:43114:${'0x' + 'aa'.repeat(20)}`;
    const finalEntry = _kv._store.get(claimKey);
    // After release, value is back to 0.
    assert.equal(finalEntry.value, 0, 'claim must be released back to 0');
  } finally {
    cap.restore();
  }
});

// ── T-FIX-02 (AC-2): Balance-gate uses USDC 6d, not PYUSD 18d
test('T-FIX-02 (AC-2): balance 0.4 USDC vs threshold 0.5 → balance-gate reject (USDC 6d magnitude)', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000000000000000000' };
  const { fetchFn } = makeFetchFake({
    balanceWei: usdc(0.4),
    gatewayResponses: [
      { status: 402, body: { accepts: [accepts] } },
    ],
  });
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler(
      { endpoint: '/api/v1/orchestrate', payload: { maxBudget: 0.05 } },
      fakeConfig(),
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'balance-gate');
    assert.match(r.error, /below threshold/);
    // Sanity: claim never touched (balance fail-secure before INCRBY).
    const claimKey = `balance-claim:eip155:43114:${'0x' + 'aa'.repeat(20)}`;
    assert.equal(_kv._store.get(claimKey), undefined, 'claim key must not exist');
  } finally {
    cap.restore();
  }
});

// ── T-FIX-03 (AC-3): Sign-guard regression — maxBudget OK + maxAmountWei rejects challenge
test('T-FIX-03 (AC-3): maxBudget=0.5 + maxAmountWei=10^17 + accepts.maxAmountRequired=10^18 → stage:sign reject', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000000000000000000' }; // 1 PYUSD
  const { fetchFn } = makeFetchFake({
    balanceWei: usdc(1),
    gatewayResponses: [
      { status: 402, body: { accepts: [accepts] } },
    ],
  });
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler(
      {
        endpoint: '/api/v1/orchestrate',
        payload: { maxBudget: 0.5 },
        maxAmountWei: '100000000000000000', // 0.1 PYUSD < 1 PYUSD challenge
      },
      fakeConfig(),
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'sign');
    assert.match(r.error, /amount exceeds maxAmountWei guard/);
  } finally {
    cap.restore();
  }
});

// ── T-FIX-04 (AC-5): Ordering probe → balance-gate → cap → sign → settle
test('T-FIX-04 (AC-5): call ordering probe → INCRBY (balance-gate) → settle', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000' };
  const events = []; // chronological log of mock calls
  const origIncrby = _kv.incrby.bind(_kv);
  _kv.incrby = async (...a) => {
    events.push(['kv.incrby', ...a]);
    return origIncrby(...a);
  };
  const { fetchFn } = makeFetchFake({
    balanceWei: usdc(1),
    onGateway: (call) => {
      events.push(['fetch.gateway', call.method, call.url, call.headers['payment-signature'] ? 'settle' : 'probe']);
      return null;
    },
    onRpc: (_call) => {
      events.push(['fetch.rpc']);
      return null;
    },
    gatewayResponses: [
      { status: 402, body: { accepts: [accepts] } },
      { status: 200, body: { kiteTxHash: '0xok' } },
    ],
  });
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler(
      { endpoint: '/api/v1/x', payload: { maxBudget: 0.1 } },
      fakeConfig(),
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    // Find indices.
    const probeIdx = events.findIndex(e => e[0] === 'fetch.gateway' && e[3] === 'probe');
    const incrbyIdx = events.findIndex(e => e[0] === 'kv.incrby');
    const settleIdx = events.findIndex(e => e[0] === 'fetch.gateway' && e[3] === 'settle');
    assert.ok(probeIdx >= 0 && probeIdx < incrbyIdx, 'probe must precede INCRBY');
    assert.ok(incrbyIdx >= 0 && incrbyIdx < settleIdx, 'INCRBY must precede settle');
  } finally {
    cap.restore();
  }
});

// ── T-FIX-05 (AC-6): Release on success — DECRBY called exactly once with requestedWei
test('T-FIX-05 (AC-6): success path → release once with requestedWei (100_000n for $0.1)', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000' };
  let decrbyCalls = 0;
  const captured = [];
  const origDecrby = _kv.decrby.bind(_kv);
  _kv.decrby = async (key, delta) => {
    decrbyCalls += 1;
    captured.push({ key, delta });
    return origDecrby(key, delta);
  };
  const { fetchFn } = makeFetchFake({
    balanceWei: usdc(1),
    gatewayResponses: [
      { status: 402, body: { accepts: [accepts] } },
      { status: 200, body: { kiteTxHash: '0xok' } },
    ],
  });
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler(
      { endpoint: '/api/v1/x', payload: { maxBudget: 0.1 } },
      fakeConfig(),
    );
    assert.equal(r.ok, true);
    assert.equal(decrbyCalls, 1, 'DECRBY must be called exactly once');
    assert.equal(captured[0].delta, Number(usdc(0.1)));
  } finally {
    cap.restore();
  }
});

// ── T-FIX-06 (AC-6): Release on settle 400 → DECRBY still called
test('T-FIX-06 (AC-6): settle 400 → release still runs (try/finally invariant)', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000' };
  let decrbyCalls = 0;
  const origDecrby = _kv.decrby.bind(_kv);
  _kv.decrby = async (...a) => { decrbyCalls += 1; return origDecrby(...a); };
  const { fetchFn } = makeFetchFake({
    balanceWei: usdc(1),
    gatewayResponses: [
      { status: 402, body: { accepts: [accepts] } },
      { status: 400, body: { error: 'bad envelope' } },
    ],
  });
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler(
      { endpoint: '/api/v1/x', payload: { maxBudget: 0.1 } },
      fakeConfig(),
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'settle');
    assert.equal(decrbyCalls, 1, 'DECRBY must run on settle 400');
  } finally {
    cap.restore();
  }
});

// ── T-FIX-07 (AC-6): Release on sign error — DECRBY still called
test('T-FIX-07 (AC-6): sign error → release still runs (PK missing)', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000' };
  let decrbyCalls = 0;
  const origDecrby = _kv.decrby.bind(_kv);
  _kv.decrby = async (...a) => { decrbyCalls += 1; return origDecrby(...a); };
  const { fetchFn } = makeFetchFake({
    balanceWei: usdc(1),
    gatewayResponses: [
      { status: 402, body: { accepts: [accepts] } },
    ],
  });
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  // Force sign to throw by deleting PK (sign module reads on-demand).
  delete process.env.OPERATOR_PRIVATE_KEY;
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler(
      { endpoint: '/api/v1/x', payload: { maxBudget: 0.1 } },
      fakeConfig(),
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'sign');
    assert.match(r.error, /signing failed/);
    assert.equal(decrbyCalls, 1, 'DECRBY must run on sign error');
  } finally {
    process.env.OPERATOR_PRIVATE_KEY = TEST_PK;
    cap.restore();
  }
});

// ── T-FIX-08 (AC-7): Invalid maxBudget post-probe → balance-gate reject
test('T-FIX-08 (AC-7): payload.maxBudget undefined → stage:balance-gate (probe ran first)', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000' };
  const { fetchFn, calls } = makeFetchFake({
    balanceWei: usdc(1),
    gatewayResponses: [
      { status: 402, body: { accepts: [accepts] } },
    ],
  });
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler(
      { endpoint: '/api/v1/x' /* no payload */ },
      fakeConfig(),
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'balance-gate');
    assert.match(r.error, /invalid or missing payload\.maxBudget/);
    // Probe DID run (gateway hit), but no settle (sign skipped).
    const gwCalls = calls.filter(c => c.url.includes('app.wasiai.io'));
    assert.equal(gwCalls.length, 1, 'only probe fetch should run, no settle');
    // No 'tool.pay_x402.signed' log line.
    const signedLines = cap.lines.filter(l => l.includes('tool.pay_x402.signed'));
    assert.equal(signedLines.length, 0, 'sign step must NOT execute');
  } finally {
    cap.restore();
  }
});

// ── T-FIX-09 (AC-7): KV null fail-secure
test('T-FIX-09 (AC-7): kvClient=null → balance-gate fail-secure', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000' };
  // Override KV with null.
  setKvClientForTesting(null);
  const { fetchFn } = makeFetchFake({
    balanceWei: usdc(1),
    gatewayResponses: [
      { status: 402, body: { accepts: [accepts] } },
    ],
  });
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler(
      { endpoint: '/api/v1/x', payload: { maxBudget: 0.1 } },
      fakeConfig(),
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'balance-gate');
    assert.match(r.error, /balance check unavailable/);
  } finally {
    cap.restore();
  }
});

// ── T-FIX-10 (AC-7): Invalid threshold env → reject
test('T-FIX-10 (AC-7): MCP_BALANCE_THRESHOLD_USDC=abc → balance-gate reject', async () => {
  process.env.MCP_BALANCE_THRESHOLD_USDC = 'abc';
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000' };
  const { fetchFn } = makeFetchFake({
    balanceWei: usdc(1),
    gatewayResponses: [
      { status: 402, body: { accepts: [accepts] } },
    ],
  });
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler(
      { endpoint: '/api/v1/x', payload: { maxBudget: 0.1 } },
      fakeConfig(),
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'balance-gate');
    assert.match(r.error, /invalid threshold/i);
  } finally {
    cap.restore();
  }
});

// ── T-FIX-10b (AC-7): Negative threshold → reject
test('T-FIX-10b (AC-7): MCP_BALANCE_THRESHOLD_USDC=-1 → balance-gate reject', async () => {
  process.env.MCP_BALANCE_THRESHOLD_USDC = '-1';
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000' };
  const { fetchFn } = makeFetchFake({
    balanceWei: usdc(1),
    gatewayResponses: [
      { status: 402, body: { accepts: [accepts] } },
    ],
  });
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler(
      { endpoint: '/api/v1/x', payload: { maxBudget: 0.1 } },
      fakeConfig(),
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'balance-gate');
    assert.match(r.error, /invalid threshold/i);
  } finally {
    cap.restore();
  }
});

// ── T-FIX-11 (AC-1 free): probe 200 → stage:'free' WITHOUT touching balance-gate
test('T-FIX-11 (AC-1 free): probe 200 → stage:free, no INCRBY', async () => {
  let incrbyCalls = 0;
  const origIncrby = _kv.incrby.bind(_kv);
  _kv.incrby = async (...a) => { incrbyCalls += 1; return origIncrby(...a); };
  const { fetchFn, rpcCalls } = makeFetchFake({
    balanceWei: usdc(1),
    gatewayResponses: [
      { status: 200, body: { hello: 'world' } },
    ],
  });
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler(
      { endpoint: '/api/v1/free', payload: { maxBudget: 0.5 } },
      fakeConfig(),
    );
    assert.equal(r.ok, true);
    assert.equal(r.stage, 'free');
    assert.equal(incrbyCalls, 0, 'free path must not touch claim ledger');
    assert.equal(rpcCalls.length, 0, 'free path must not hit RPC');
  } finally {
    cap.restore();
  }
});

// ── T-FIX-12 (V9): adversarial payload.maxBudget inputs all reject
test('T-FIX-12 (V9): adversarial payload.maxBudget inputs all rejected at balance-gate', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000' };
  const adversarial = [
    { label: 'Infinity', value: Infinity },
    { label: '-Infinity', value: -Infinity },
    { label: 'NaN', value: NaN },
    { label: '1e308 (>= 1_000_000)', value: 1e308 },
    { label: '-1', value: -1 },
    { label: '0', value: 0 },
    { label: 'string "0.5"', value: '0.5' },
    { label: 'null', value: null },
    { label: 'undefined', value: undefined },
    { label: 'object {}', value: {} },
    { label: 'empty array', value: [] },
    { label: 'array [0.5]', value: [0.5] },
    { label: 'Symbol', value: Symbol('x') },
    { label: 'valueOf trick', value: { valueOf: () => 0.5 } },
  ];
  for (const { label, value } of adversarial) {
    let incrbyCalls = 0;
    const kvLocal = createKvMock();
    const origIncrby = kvLocal.incrby.bind(kvLocal);
    kvLocal.incrby = async (...a) => { incrbyCalls += 1; return origIncrby(...a); };
    setKvClientForTesting(kvLocal);

    const { fetchFn } = makeFetchFake({
      balanceWei: usdc(1),
      gatewayResponses: [
        { status: 402, body: { accepts: [accepts] } },
      ],
    });
    globalThis.fetch = fetchFn;
    const cap = captureStderr();
    try {
      const { payX402Handler } = await loadHandlers();
      const r = await payX402Handler(
        { endpoint: '/api/v1/x', payload: { maxBudget: value } },
        fakeConfig(),
      );
      assert.equal(r.ok, false, `[${label}] must reject`);
      assert.equal(r.stage, 'balance-gate', `[${label}] expected stage balance-gate, got ${r.stage}`);
      assert.equal(incrbyCalls, 0, `[${label}] claim must NOT be incremented`);
    } finally {
      cap.restore();
    }
  }
  // Prototype-pollution check: setting __proto__.maxBudget on input object
  // must NOT leak into payload.maxBudget detection.
  {
    setKvClientForTesting(createKvMock());
    const { fetchFn } = makeFetchFake({
      balanceWei: usdc(1),
      gatewayResponses: [
        { status: 402, body: { accepts: [accepts] } },
      ],
    });
    globalThis.fetch = fetchFn;
    const cap = captureStderr();
    try {
      const { payX402Handler } = await loadHandlers();
      // Build payload without own maxBudget, but with __proto__ pollution.
      const malicious = Object.create({ maxBudget: 0.5 });
      const r = await payX402Handler(
        { endpoint: '/api/v1/x', payload: malicious },
        fakeConfig(),
      );
      assert.equal(r.ok, false, 'prototype-polluted maxBudget must reject');
      assert.equal(r.stage, 'balance-gate');
    } finally {
      cap.restore();
    }
  }
});

// ── T-FIX-13 (V1): drain-prevention — maxBudget=999 vs balance $4.756 → reject
test('T-FIX-13 (V1): caller declares maxBudget=999 with balance 4.756 USDC → reject', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000' };
  const { fetchFn } = makeFetchFake({
    balanceWei: usdc(4.756),
    gatewayResponses: [
      { status: 402, body: { accepts: [accepts] } },
    ],
  });
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler(
      { endpoint: '/api/v1/x', payload: { maxBudget: 999 } },
      fakeConfig(),
    );
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'balance-gate');
    // No sign log line — sign never ran.
    const signedLines = cap.lines.filter(l => l.includes('tool.pay_x402.signed'));
    assert.equal(signedLines.length, 0);
  } finally {
    cap.restore();
  }
});

// ── T-FIX-14 (V7 documented): maxBudget USDC + accepts=10^18 PYUSD without
// maxAmountWei → balance-gate approves, cap-guard bypass, settle 200.
//
// This locks the documented contract: payload.maxBudget covers OUTBOUND, and
// when the caller does NOT pass maxAmountWei (and no env default), the cap
// guard is intentionally bypassed and the caller accepts the INBOUND amount.
test('T-FIX-14 (V7 doc): maxBudget=0.5 USDC + 10^18 PYUSD challenge + no maxAmountWei → settled', async () => {
  const accepts = { payTo: '0x' + '99'.repeat(20), maxAmountRequired: '1000000000000000000' };
  const { fetchFn } = makeFetchFake({
    balanceWei: usdc(1),
    gatewayResponses: [
      { status: 402, body: { accepts: [accepts] } },
      { status: 200, body: { kiteTxHash: '0xdef' } },
    ],
  });
  globalThis.fetch = fetchFn;
  const cap = captureStderr();
  try {
    const { payX402Handler } = await loadHandlers();
    const r = await payX402Handler(
      { endpoint: '/api/v1/orchestrate', payload: { maxBudget: 0.5 } },
      fakeConfig(),
    );
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.stage, 'settled');
    assert.equal(r.kiteTxHash, '0xdef');
  } finally {
    cap.restore();
  }
});
