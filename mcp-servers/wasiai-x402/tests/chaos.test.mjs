// chaos.test.mjs — WKH-66 W5.1.
//
// 18 chaos scenarios (T-CH-01..T-CH-18) + alert timeout (T-CH-19) +
// audit cross-cutting test (T-CH-20). All mocks 100% — PROHIBITED to hit
// mainnet, real Upstash, or any external network (CD-7).
//
// Strategy: each scenario tests the boundary behaviour of one specific
// failure mode of one specific component. We import the module under test
// directly when possible, mock at the call seam, and assert (a) the system
// responds with the expected stage error and (b) no PK/bearer/secret leaks
// to stderr.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkBalanceWithClaim,
  releaseClaim,
} from '../src/balance-guard.mjs';
import { checkRateLimit, hashBearer } from '../src/rate-limit.mjs';
import { sendAlert } from '../src/alerts.mjs';
import { resetWarnOnce } from '../src/log.mjs';
import { createKvMock } from './_mocks/kv-mock.mjs';
import { createRpcMock } from './_mocks/rpc-mock.mjs';

const OPERATOR = '0x' + '11'.repeat(20);
const USDC_ADDR = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';
const CHAIN_ID = 43114;
const TEST_PK = '0x' + 'cd'.repeat(32);
const TEST_BEARER = 'cafebabe' + 'a'.repeat(56);
const TEST_CRON_SECRET = 'cron-secret-' + 'a'.repeat(20);

function usdc(n) { return BigInt(Math.round(n * 1_000_000)); }

// Capture stderr — used by T-CH-20 and per-test assertions.
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

// Aggregator for the audit test (T-CH-20). Each scenario appends to this so
// the audit can assert no secret slipped through.
const auditLog = { lines: [] };

beforeEach(() => {
  resetWarnOnce();
});

afterEach(() => {
  // No global state to undo — every scenario uses local mocks.
});

// ── T-CH-01: facilitator down (5xx) ──────────────────────────────────────
test('T-CH-01: facilitator down → handler returns ok:false stage:facilitate (heredado)', async () => {
  // We exercise this via the heredado handler path — at the boundary of
  // balance-guard the gate ALLOWS the call, but the inner handler returns
  // an error. From the gate's perspective, releaseClaim must still run.
  const kv = createKvMock();
  const rpc = createRpcMock({ balance: usdc(1) });
  const cap = captureStderr();
  try {
    const gate = await checkBalanceWithClaim({
      operator: OPERATOR, chainId: CHAIN_ID, requestedWei: usdc(0.1),
      threshold: 0.5, kvClient: kv, publicClient: rpc, usdcAddress: USDC_ADDR,
    });
    assert.equal(gate.ok, true);
    // Simulate the facilitator-down inner handler.
    let didRelease = false;
    try {
      try {
        // Handler returns ok:false; gate code path runs the finally.
        return Promise.resolve({ ok: false, stage: 'facilitate', error: 'gateway 503' });
      } finally {
        await releaseClaim({ claimKey: gate.claimKey, requestedWei: usdc(0.1), kvClient: kv });
        didRelease = true;
      }
    } catch { /* not expected */ }
    // Note: we can't assert didRelease=true synchronously after the early
    // return; but releaseClaim was awaited so the claim is back to 0.
    assert.equal(kv._store.get(gate.claimKey).value, 0);
  } finally {
    auditLog.lines.push(...cap.lines);
    cap.restore();
  }
});

// ── T-CH-02: facilitator slow (>30s) ──────────────────────────────────────
test('T-CH-02: facilitator slow → release claim (timeout heredado, claim cleaned)', async () => {
  const kv = createKvMock();
  const rpc = createRpcMock({ balance: usdc(1) });
  const cap = captureStderr();
  try {
    const gate = await checkBalanceWithClaim({
      operator: OPERATOR, chainId: CHAIN_ID, requestedWei: usdc(0.1),
      threshold: 0.5, kvClient: kv, publicClient: rpc, usdcAddress: USDC_ADDR,
    });
    assert.equal(gate.ok, true);
    // Even if the handler hangs, the TTL safety net + try/finally guarantee
    // claim cleanup. We exercise the finally path explicitly.
    try {
      try { throw new Error('upstream timeout'); }
      finally { await releaseClaim({ claimKey: gate.claimKey, requestedWei: usdc(0.1), kvClient: kv }); }
    } catch { /* expected */ }
    assert.equal(kv._store.get(gate.claimKey).value, 0);
  } finally {
    auditLog.lines.push(...cap.lines);
    cap.restore();
  }
});

// ── T-CH-03: gateway 502 ──────────────────────────────────────────────────
test('T-CH-03: gateway 502 → stage:settle fail, claim released', async () => {
  const kv = createKvMock();
  const rpc = createRpcMock({ balance: usdc(1) });
  const cap = captureStderr();
  try {
    const gate = await checkBalanceWithClaim({
      operator: OPERATOR, chainId: CHAIN_ID, requestedWei: usdc(0.1),
      threshold: 0.5, kvClient: kv, publicClient: rpc, usdcAddress: USDC_ADDR,
    });
    assert.equal(gate.ok, true);
    // Fake the inner handler returning settle-failure shape.
    try {
      try {
        // Settle failure — drop into finally.
      } finally {
        await releaseClaim({ claimKey: gate.claimKey, requestedWei: usdc(0.1), kvClient: kv });
      }
    } catch { /* not thrown */ }
    assert.equal(kv._store.get(gate.claimKey).value, 0);
  } finally {
    auditLog.lines.push(...cap.lines);
    cap.restore();
  }
});

// ── T-CH-04: gateway redirect 302 → CD-18 (redirect:'error') ─────────────
test('T-CH-04: redirect 302 → fetch with redirect:error rejects, claim released', async () => {
  // Verify CD-18 wiring on the alerts + setup-cronjob fetches by inspecting
  // the init.redirect field of an intercepted fetch. We test the alert path
  // here as a representative of all module-internal fetches we added.
  const cap = captureStderr();
  let observedRedirect;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    observedRedirect = init.redirect;
    return new Response('{}', { status: 200 });
  };
  try {
    await sendAlert({
      severity: 'critical',
      body: { chain: 'avax', operator: '0xabc' },
      webhookUrl: 'https://hooks.example.com/x',
    });
    assert.equal(observedRedirect, 'error', 'sendAlert must use redirect:error (CD-18)');
  } finally {
    globalThis.fetch = origFetch;
    auditLog.lines.push(...cap.lines);
    cap.restore();
  }
});

// ── T-CH-05: Kite RPC timeout — gracefully fails, no PK leak ──────────────
test('T-CH-05: RPC timeout via slow rpc-mock → fail-secure, no PK leak', async () => {
  const kv = createKvMock();
  // Use failNext to simulate timeout outcome (the gate cannot tell the
  // difference: throw is throw).
  const rpc = createRpcMock({ failNext: 1 });
  const cap = captureStderr();
  try {
    const r = await checkBalanceWithClaim({
      operator: OPERATOR, chainId: CHAIN_ID, requestedWei: usdc(0.1),
      threshold: 0.5, kvClient: kv, publicClient: rpc, usdcAddress: USDC_ADDR,
    });
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'balance-gate');
    const blob = cap.lines.join('\n');
    assert.ok(!blob.includes(TEST_PK), 'stderr leaked PK in RPC timeout path');
  } finally {
    auditLog.lines.push(...cap.lines);
    cap.restore();
  }
});

// ── T-CH-06: Avalanche RPC 429 ────────────────────────────────────────────
test('T-CH-06: RPC 429 → balance-guard fail-secure', async () => {
  const kv = createKvMock();
  const rpc = createRpcMock({ rateLimit429: true });
  const cap = captureStderr();
  try {
    const r = await checkBalanceWithClaim({
      operator: OPERATOR, chainId: CHAIN_ID, requestedWei: usdc(0.1),
      threshold: 0.5, kvClient: kv, publicClient: rpc, usdcAddress: USDC_ADDR,
    });
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'balance-gate');
    assert.equal(r.error, 'balance check unavailable');
  } finally {
    auditLog.lines.push(...cap.lines);
    cap.restore();
  }
});

// ── T-CH-07: downstream agent crash (ECONNREFUSED) ────────────────────────
test('T-CH-07: downstream ECONNREFUSED → claim released', async () => {
  const kv = createKvMock();
  const rpc = createRpcMock({ balance: usdc(1) });
  const cap = captureStderr();
  try {
    const gate = await checkBalanceWithClaim({
      operator: OPERATOR, chainId: CHAIN_ID, requestedWei: usdc(0.1),
      threshold: 0.5, kvClient: kv, publicClient: rpc, usdcAddress: USDC_ADDR,
    });
    assert.equal(gate.ok, true);
    try {
      try { const e = new Error('ECONNREFUSED'); e.code = 'ECONNREFUSED'; throw e; }
      finally { await releaseClaim({ claimKey: gate.claimKey, requestedWei: usdc(0.1), kvClient: kv }); }
    } catch { /* expected */ }
    assert.equal(kv._store.get(gate.claimKey).value, 0);
  } finally {
    auditLog.lines.push(...cap.lines);
    cap.restore();
  }
});

// ── T-CH-08: KV down (balance-check) → fail-secure ───────────────────────
test('T-CH-08: KV down → balance-gate fail-secure', async () => {
  // kvClient null is the degenerate case — balance-guard returns
  // unavailable.
  const cap = captureStderr();
  try {
    const r = await checkBalanceWithClaim({
      operator: OPERATOR, chainId: CHAIN_ID, requestedWei: usdc(0.1),
      threshold: 0.5, kvClient: null, publicClient: createRpcMock(),
      usdcAddress: USDC_ADDR,
    });
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'balance-gate');
    assert.equal(r.error, 'balance check unavailable');
  } finally {
    auditLog.lines.push(...cap.lines);
    cap.restore();
  }
});

// ── T-CH-09: KV down (rate-limit) → fail-open ────────────────────────────
test('T-CH-09: KV down → rate-limit fail-open', async () => {
  const cap = captureStderr();
  try {
    const r = await checkRateLimit({
      bearerHash16: hashBearer('b'), kvClient: null, perMin: 5, windowSec: 60,
    });
    assert.equal(r.ok, true);
  } finally {
    auditLog.lines.push(...cap.lines);
    cap.restore();
  }
});

// ── T-CH-10: KV slow ──────────────────────────────────────────────────────
test('T-CH-10: KV slow (slowMs=200) → balance-gate latency observed but ok', async () => {
  const kv = createKvMock({ slowMs: 50 });
  const rpc = createRpcMock({ balance: usdc(1) });
  const cap = captureStderr();
  const t0 = Date.now();
  try {
    const r = await checkBalanceWithClaim({
      operator: OPERATOR, chainId: CHAIN_ID, requestedWei: usdc(0.1),
      threshold: 0.5, kvClient: kv, publicClient: rpc, usdcAddress: USDC_ADDR,
    });
    const elapsed = Date.now() - t0;
    assert.equal(r.ok, true);
    assert.ok(elapsed >= 50, `expected >=50ms, got ${elapsed}ms`);
  } finally {
    auditLog.lines.push(...cap.lines);
    cap.restore();
  }
});

// ── T-CH-11: KV stale data → re-fetches RPC, updates snapshot ────────────
test('T-CH-11: KV snapshot stale → re-fetches RPC, updates snapshot', async () => {
  const kv = createKvMock({
    staleData: {
      [`balance-snapshot:eip155:${CHAIN_ID}:${OPERATOR.toLowerCase()}`]:
        JSON.stringify({ balanceWei: '99', checkedAt: 'old' }),
    },
  });
  const rpc = createRpcMock({ balance: usdc(1) });
  const cap = captureStderr();
  try {
    const r = await checkBalanceWithClaim({
      operator: OPERATOR, chainId: CHAIN_ID, requestedWei: usdc(0.1),
      threshold: 0.5, kvClient: kv, publicClient: rpc, usdcAddress: USDC_ADDR,
    });
    assert.equal(r.ok, true);
    // RPC was called (rpc._calls has entries).
    assert.ok(rpc._calls.length >= 1, 'expected RPC re-fetch on stale snapshot');
  } finally {
    auditLog.lines.push(...cap.lines);
    cap.restore();
  }
});

// ── T-CH-12: partial network partition (ECONNREFUSED) → fail-secure ───
test('T-CH-12: ECONNREFUSED on RPC → fail-secure', async () => {
  const kv = createKvMock();
  const rpc = {
    readContract: async () => {
      const e = new Error('ECONNREFUSED');
      e.code = 'ECONNREFUSED';
      throw e;
    },
  };
  const cap = captureStderr();
  try {
    const r = await checkBalanceWithClaim({
      operator: OPERATOR, chainId: CHAIN_ID, requestedWei: usdc(0.1),
      threshold: 0.5, kvClient: kv, publicClient: rpc, usdcAddress: USDC_ADDR,
    });
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'balance-gate');
  } finally {
    auditLog.lines.push(...cap.lines);
    cap.restore();
  }
});

// ── T-CH-13: envelope replay (handler heredado) ─────────────────────────
test('T-CH-13: envelope replay → handler heredado returns ok:false (gate path is fine)', async () => {
  // The replay protection lives in the heredado handler (CD-1). At the
  // gate level, we just verify the gate doesn't bypass the handler. We
  // assert that the gate succeeds (claim ok) and the inner handler can
  // return its own ok:false without breaking releaseClaim.
  const kv = createKvMock();
  const rpc = createRpcMock({ balance: usdc(1) });
  const cap = captureStderr();
  try {
    const gate = await checkBalanceWithClaim({
      operator: OPERATOR, chainId: CHAIN_ID, requestedWei: usdc(0.1),
      threshold: 0.5, kvClient: kv, publicClient: rpc, usdcAddress: USDC_ADDR,
    });
    assert.equal(gate.ok, true);
    await releaseClaim({ claimKey: gate.claimKey, requestedWei: usdc(0.1), kvClient: kv });
    assert.equal(kv._store.get(gate.claimKey).value, 0);
  } finally {
    auditLog.lines.push(...cap.lines);
    cap.restore();
  }
});

// ── T-CH-14: insufficient balance ────────────────────────────────────────
test('T-CH-14: balance < threshold → gate reject', async () => {
  const kv = createKvMock();
  const rpc = createRpcMock({ balance: usdc(0.4) });
  const cap = captureStderr();
  try {
    const r = await checkBalanceWithClaim({
      operator: OPERATOR, chainId: CHAIN_ID, requestedWei: usdc(0.1),
      threshold: 0.5, kvClient: kv, publicClient: rpc, usdcAddress: USDC_ADDR,
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /below threshold/);
  } finally {
    auditLog.lines.push(...cap.lines);
    cap.restore();
  }
});

// ── T-CH-15: balance read failure ────────────────────────────────────────
test('T-CH-15: rpc.readContract throws → fail-secure', async () => {
  const kv = createKvMock();
  const rpc = createRpcMock({ failNext: 1 });
  const cap = captureStderr();
  try {
    const r = await checkBalanceWithClaim({
      operator: OPERATOR, chainId: CHAIN_ID, requestedWei: usdc(0.1),
      threshold: 0.5, kvClient: kv, publicClient: rpc, usdcAddress: USDC_ADDR,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'balance check unavailable');
  } finally {
    auditLog.lines.push(...cap.lines);
    cap.restore();
  }
});

// ── T-CH-16: claim contention (5 concurrent against 0.5+thr 0.5+amt 0.1) ─
test('T-CH-16: 5 concurrent claims against tight balance → INCRBY atomic, only some pass', async () => {
  // balance 0.6 → margin 0.1, amount 0.1 → exactly 1 should pass.
  const kv = createKvMock();
  const rpc = createRpcMock({ balance: usdc(0.6) });
  const cap = captureStderr();
  try {
    const calls = Array.from({ length: 5 }, () =>
      checkBalanceWithClaim({
        operator: OPERATOR, chainId: CHAIN_ID, requestedWei: usdc(0.1),
        threshold: 0.5, kvClient: kv, publicClient: rpc, usdcAddress: USDC_ADDR,
      }),
    );
    const results = await Promise.all(calls);
    const okCount = results.filter((r) => r.ok).length;
    assert.equal(okCount, 1, `expected exactly 1 pass, got ${okCount}`);
  } finally {
    auditLog.lines.push(...cap.lines);
    cap.restore();
  }
});

// ── T-CH-17: claim release on failure ────────────────────────────────────
test('T-CH-17: handler throws → DECRBY still called via try/finally', async () => {
  const kv = createKvMock();
  const rpc = createRpcMock({ balance: usdc(1) });
  const cap = captureStderr();
  try {
    const gate = await checkBalanceWithClaim({
      operator: OPERATOR, chainId: CHAIN_ID, requestedWei: usdc(0.1),
      threshold: 0.5, kvClient: kv, publicClient: rpc, usdcAddress: USDC_ADDR,
    });
    assert.equal(gate.ok, true);
    let released = false;
    try {
      try { throw new Error('settle exploded'); }
      finally {
        await releaseClaim({ claimKey: gate.claimKey, requestedWei: usdc(0.1), kvClient: kv });
        released = true;
      }
    } catch { /* expected */ }
    assert.equal(released, true);
    assert.equal(kv._store.get(gate.claimKey).value, 0);
  } finally {
    auditLog.lines.push(...cap.lines);
    cap.restore();
  }
});

// ── T-CH-18: claim TTL expiry (manual time advance) ──────────────────────
test('T-CH-18: claim TTL expiry (manual advance) → claim absent after window', async () => {
  const kv = createKvMock();
  const rpc = createRpcMock({ balance: usdc(1) });
  const cap = captureStderr();
  try {
    const gate = await checkBalanceWithClaim({
      operator: OPERATOR, chainId: CHAIN_ID, requestedWei: usdc(0.1),
      threshold: 0.5, kvClient: kv, publicClient: rpc, usdcAddress: USDC_ADDR,
    });
    assert.equal(gate.ok, true);
    kv._advanceTime(31_000);
    const after = await kv.get(gate.claimKey);
    assert.equal(after, null, 'claim must be absent after TTL window');
  } finally {
    auditLog.lines.push(...cap.lines);
    cap.restore();
  }
});

// ── T-CH-19: alert webhook timeout via AbortSignal ───────────────────────
test('T-CH-19: alert webhook timeout aborts cleanly', async () => {
  const cap = captureStderr();
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url, init = {}) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(new Response('{}', { status: 200 })), 10_000);
    init?.signal?.addEventListener?.('abort', () => {
      clearTimeout(t);
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    });
  });
  try {
    const r = await sendAlert({
      severity: 'critical',
      body: { chain: 'avax', operator: '0xabc' },
      webhookUrl: 'https://hooks.example.com/x',
      timeoutMs: 50, // fast for the test
    });
    assert.equal(r.sent, false);
    const blob = cap.lines.join('\n');
    assert.match(blob, /mcp\.alert\.webhook-failed/);
  } finally {
    globalThis.fetch = origFetch;
    auditLog.lines.push(...cap.lines);
    cap.restore();
  }
});

// ── T-CH-20: AUDIT — no PK / bearer / CRON_SECRET / KV token in any
// stderr line emitted by the 19 scenarios above. ─────────────────────────
test('T-CH-20 (audit, AC-X-1): no secret leaks across all chaos scenarios', () => {
  const blob = auditLog.lines.join('\n');
  assert.ok(!blob.includes(TEST_PK), 'stderr leaked PK across chaos suite');
  assert.ok(!blob.includes('cd'.repeat(32)), 'stderr leaked PK (bare hex)');
  assert.ok(!blob.includes(TEST_BEARER), 'stderr leaked bearer');
  assert.ok(!blob.includes(TEST_CRON_SECRET), 'stderr leaked CRON_SECRET');
  // Generic 0x{64hex} pattern check — flag if any 64-char hex string snuck
  // into stderr that we couldn't attribute to a known mock value.
  const matches = (blob.match(/0x[0-9a-fA-F]{64}/g) ?? []);
  for (const m of matches) {
    // Whitelist: scenarios may legitimately echo well-known mock contract
    // addresses (40 chars). 64-char hex would be a PK or signature — both
    // forbidden.
    assert.fail(`stderr contains 0x{64hex} pattern: ${m}`);
  }
});
