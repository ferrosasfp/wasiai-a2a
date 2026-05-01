// balance-guard.test.mjs — WKH-66 W2.3.
//
// 8 tests T-BG-01..T-BG-08 covering AC-W5-3 (a..h):
//   01 happy path
//   02 below threshold reject
//   03 RPC fail → fail-secure
//   04 claim atomic INCRBY + EXPIRE 30
//   05 release on settle ok
//   06 release on settle fail (try/finally invariant)
//   07 release on sign fail
//   08 claim TTL expiry releases orphans

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkBalanceWithClaim,
  releaseClaim,
} from '../src/balance-guard.mjs';
// WKH-67: runWithBalanceGate eliminated; threshold-validation coverage moved
// to tests/handlers-balance-gate.test.mjs (T-FIX-10).
import { createKvMock } from './_mocks/kv-mock.mjs';
import { createRpcMock } from './_mocks/rpc-mock.mjs';

const OPERATOR = '0x' + '11'.repeat(20);
const USDC_ADDR = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';
const CHAIN_ID = 43114;

// USDC has 6 decimals on Avalanche → 1 USDC = 1_000_000 wei.
function usdc(n) {
  return BigInt(Math.round(n * 1_000_000));
}

let kv;
let rpc;

beforeEach(() => {
  kv = createKvMock();
  rpc = createRpcMock();
});

test('T-BG-01: balance > threshold + amount → permite (claim ok, claimId is uuid)', async () => {
  rpc = createRpcMock({ balance: usdc(1) });
  const r = await checkBalanceWithClaim({
    operator: OPERATOR,
    chainId: CHAIN_ID,
    requestedWei: usdc(0.1),
    threshold: 0.5,
    kvClient: kv,
    publicClient: rpc,
    usdcAddress: USDC_ADDR,
  });
  assert.equal(r.ok, true);
  assert.match(r.claimId, /^[0-9a-f-]{36}$/);
  assert.equal(r.claimedTotalWei, usdc(0.1));
  assert.equal(r.claimKey, `balance-claim:eip155:${CHAIN_ID}:${OPERATOR.toLowerCase()}`);
});

test('T-BG-02: balance < threshold → reject pre-firma', async () => {
  rpc = createRpcMock({ balance: usdc(0.4) });
  const r = await checkBalanceWithClaim({
    operator: OPERATOR,
    chainId: CHAIN_ID,
    requestedWei: usdc(0.1),
    threshold: 0.5,
    kvClient: kv,
    publicClient: rpc,
    usdcAddress: USDC_ADDR,
  });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'balance-gate');
  assert.equal(r.error, 'operator balance below threshold');
});

test('T-BG-03: RPC fail → fail-secure reject', async () => {
  rpc = createRpcMock({ failNext: 1 });
  const r = await checkBalanceWithClaim({
    operator: OPERATOR,
    chainId: CHAIN_ID,
    requestedWei: usdc(0.1),
    threshold: 0.5,
    kvClient: kv,
    publicClient: rpc,
    usdcAddress: USDC_ADDR,
  });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'balance-gate');
  assert.equal(r.error, 'balance check unavailable');
});

test('T-BG-04: claim atomic INCRBY + EXPIRE 30', async () => {
  rpc = createRpcMock({ balance: usdc(1) });
  const r = await checkBalanceWithClaim({
    operator: OPERATOR,
    chainId: CHAIN_ID,
    requestedWei: usdc(0.1),
    threshold: 0.5,
    kvClient: kv,
    publicClient: rpc,
    usdcAddress: USDC_ADDR,
  });
  assert.equal(r.ok, true);
  // Claim key was incremented to requestedWei.
  const claimEntry = kv._store.get(r.claimKey);
  assert.ok(claimEntry, 'claim key must exist after success');
  assert.equal(claimEntry.value, Number(usdc(0.1)));
  // TTL set to ~30s — verified via virtual-now.
  assert.ok(
    claimEntry.expiresAt !== null && claimEntry.expiresAt > Date.now() + 25_000,
    'EXPIRE 30 must set TTL ~30s in the future',
  );
  assert.ok(
    claimEntry.expiresAt < Date.now() + 35_000,
    'EXPIRE 30 must NOT exceed 35s',
  );
});

test('T-BG-05: claim release on settle ok (DECRBY called)', async () => {
  rpc = createRpcMock({ balance: usdc(1) });
  const r = await checkBalanceWithClaim({
    operator: OPERATOR,
    chainId: CHAIN_ID,
    requestedWei: usdc(0.1),
    threshold: 0.5,
    kvClient: kv,
    publicClient: rpc,
    usdcAddress: USDC_ADDR,
  });
  assert.equal(r.ok, true);
  const claimedBefore = kv._store.get(r.claimKey).value;
  assert.equal(claimedBefore, Number(usdc(0.1)));
  await releaseClaim({ claimKey: r.claimKey, requestedWei: usdc(0.1), kvClient: kv });
  const claimedAfter = kv._store.get(r.claimKey).value;
  assert.equal(claimedAfter, 0);
});

test('T-BG-06: claim release on settle fail (try/finally invariant — DECRBY still called)', async () => {
  rpc = createRpcMock({ balance: usdc(1) });
  const r = await checkBalanceWithClaim({
    operator: OPERATOR,
    chainId: CHAIN_ID,
    requestedWei: usdc(0.1),
    threshold: 0.5,
    kvClient: kv,
    publicClient: rpc,
    usdcAddress: USDC_ADDR,
  });
  assert.equal(r.ok, true);
  // Simulate the api/mcp.mjs try/finally: handler throws, release MUST run.
  let didRelease = false;
  try {
    try {
      throw new Error('settle failed');
    } finally {
      await releaseClaim({ claimKey: r.claimKey, requestedWei: usdc(0.1), kvClient: kv });
      didRelease = true;
    }
  } catch { /* expected */ }
  assert.equal(didRelease, true);
  assert.equal(kv._store.get(r.claimKey).value, 0);
});

test('T-BG-07: claim release on sign fail (releaseClaim never throws)', async () => {
  rpc = createRpcMock({ balance: usdc(1) });
  const r = await checkBalanceWithClaim({
    operator: OPERATOR,
    chainId: CHAIN_ID,
    requestedWei: usdc(0.1),
    threshold: 0.5,
    kvClient: kv,
    publicClient: rpc,
    usdcAddress: USDC_ADDR,
  });
  assert.equal(r.ok, true);
  // KV becomes broken right after claim — releaseClaim must swallow the error.
  kv._setFailNext(1);
  let threw = false;
  try {
    await releaseClaim({ claimKey: r.claimKey, requestedWei: usdc(0.1), kvClient: kv });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, 'releaseClaim must not throw');
});

test('T-BG-08: claim TTL expiry libera huérfanos', async () => {
  rpc = createRpcMock({ balance: usdc(1) });
  const r = await checkBalanceWithClaim({
    operator: OPERATOR,
    chainId: CHAIN_ID,
    requestedWei: usdc(0.1),
    threshold: 0.5,
    kvClient: kv,
    publicClient: rpc,
    usdcAddress: USDC_ADDR,
  });
  assert.equal(r.ok, true);
  // Advance virtual time past the TTL window.
  kv._advanceTime(31_000);
  // get() purges expired entries.
  const after = await kv.get(r.claimKey);
  assert.equal(after, null, 'expired claim key must be absent');
});

// ── BLQ-ALTO-1: snapshot freshness gate (≤30s checkedAt) ────────────────
//
// The cron writes a balance snapshot with Redis TTL 1800s (30 min) but the
// guard MUST validate `checkedAt` against a 30s freshness window. Otherwise
// an external drain between cron runs would leave the gate approving
// against stale data for ≤15 min.

test('T-BG-09: stale snapshot (>30s checkedAt) → RPC fallback', async () => {
  // On-chain real balance is $5.00 (1 successful call's worth), but the
  // KV snapshot says $999 (stale, deliberately wrong).
  rpc = createRpcMock({ balance: usdc(5) });

  const snapKey = `balance-snapshot:eip155:${CHAIN_ID}:${OPERATOR.toLowerCase()}`;
  // Pre-seed snapshot with checkedAt 60s ago BUT Redis TTL still valid (1500s).
  await kv.set(
    snapKey,
    JSON.stringify({
      balanceWei: '999000000', // stale $999 — must be ignored
      balanceUsdc: 999.0,
      checkedAt: new Date(Date.now() - 60_000).toISOString(),
      blockNumber: '12345',
    }),
    { ex: 1500 },
  );

  const r = await checkBalanceWithClaim({
    operator: OPERATOR,
    chainId: CHAIN_ID,
    requestedWei: usdc(0.1),
    threshold: 0.5,
    kvClient: kv,
    publicClient: rpc,
    usdcAddress: USDC_ADDR,
  });

  // Must FALL THROUGH to RPC despite Redis-fresh snapshot.
  assert.equal(rpc._calls.length, 1, 'must call RPC despite Redis-fresh snapshot');
  assert.equal(r.ok, true, 'gate must approve against real on-chain $5');
  // Cached re-write happened on the RPC path (snapshot now reflects $5).
  const refreshed = await kv.get(snapKey);
  const parsed = typeof refreshed === 'string' ? JSON.parse(refreshed) : refreshed;
  assert.equal(parsed.balanceWei, usdc(5).toString(), 'snapshot must be refreshed with on-chain value');
});

test('T-BG-10: fresh snapshot (<30s) → no RPC call', async () => {
  rpc = createRpcMock({ balance: usdc(5) });

  const snapKey = `balance-snapshot:eip155:${CHAIN_ID}:${OPERATOR.toLowerCase()}`;
  // Fresh snapshot: checkedAt 5s ago.
  await kv.set(
    snapKey,
    JSON.stringify({
      balanceWei: usdc(5).toString(),
      balanceUsdc: 5.0,
      checkedAt: new Date(Date.now() - 5_000).toISOString(),
      blockNumber: '12345',
    }),
    { ex: 1500 },
  );

  const r = await checkBalanceWithClaim({
    operator: OPERATOR,
    chainId: CHAIN_ID,
    requestedWei: usdc(0.1),
    threshold: 0.5,
    kvClient: kv,
    publicClient: rpc,
    usdcAddress: USDC_ADDR,
  });

  assert.equal(rpc._calls.length, 0, 'fresh snapshot must NOT trigger RPC');
  assert.equal(r.ok, true);
});

// WKH-67: T-BG-11/T-BG-11b deleted. The MCP_BALANCE_THRESHOLD_USDC validation
// is now exercised inside payX402Handler — see T-FIX-10 in
// tests/handlers-balance-gate.test.mjs.
