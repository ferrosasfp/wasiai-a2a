// concurrent-stress.test.mjs — WKH-66 W5.2.
//
// 1 test T-CS-01: 10 concurrent pay_x402 against tight balance.
//
// Setup (refined per Story File §9):
//   - balance = $0.61 USDC = 610_000n wei
//   - threshold = $0.50 USDC
//   - amount = $0.10 USDC = 100_000n wei
//   - margin = balance - threshold = $0.11 = 110_000n wei
//   - exactly floor(110_000 / 100_000) = 1 call should pass the gate.
//
// Why this matters (V7 — concurrent claim contention):
//   single-threaded JS guarantees INCRBY atomicity per call (V10.1.a), but
//   the post-INCRBY check + DECRBY-revert is NOT atomic across calls.
//   This test demonstrates serialization is correct end-to-end: even with
//   10 Promise.all calls, the ledger never lets more than 1 reservation
//   stick, and there is NO double-spend.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkBalanceWithClaim, releaseClaim } from '../src/balance-guard.mjs';
import { createKvMock } from './_mocks/kv-mock.mjs';
import { createRpcMock } from './_mocks/rpc-mock.mjs';

const OPERATOR = '0x' + '11'.repeat(20);
const USDC_ADDR = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';
const CHAIN_ID = 43114;

function usdc(n) { return BigInt(Math.round(n * 1_000_000)); }

test('T-CS-01: 10 concurrent claims against $0.61 / threshold $0.50 / amount $0.10 → exactly 1 pass', async () => {
  const kv = createKvMock();
  const rpc = createRpcMock({ balance: usdc(0.61) });

  // The mock is body-aware indirectly: each call goes through INCRBY which
  // is atomic at the single-threaded JS layer. We don't need
  // per-request mock routing because the ledger is the source of truth.

  const calls = Array.from({ length: 10 }, () =>
    checkBalanceWithClaim({
      operator: OPERATOR,
      chainId: CHAIN_ID,
      requestedWei: usdc(0.1),
      threshold: 0.5,
      kvClient: kv,
      publicClient: rpc,
      usdcAddress: USDC_ADDR,
    }),
  );
  const results = await Promise.all(calls);

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.filter((r) => r.ok === false).length;

  // Render results without BigInt for clean assertion messages.
  const dump = results.map((r) => ({
    ok: r.ok,
    stage: r.stage,
    error: r.error,
    claimedTotalWei: r.claimedTotalWei !== undefined ? r.claimedTotalWei.toString() : undefined,
  }));
  assert.equal(okCount, 1, `expected exactly 1 pass, got ${okCount} (results: ${JSON.stringify(dump)})`);
  assert.equal(failCount, 9, `expected exactly 9 fails, got ${failCount}`);

  // Failures must all carry the canonical concurrent-claim error.
  for (const r of results.filter((r) => !r.ok)) {
    assert.equal(r.stage, 'balance-gate');
    assert.match(r.error, /(concurrent claim exceeded|operator balance below threshold)/);
  }

  // Ledger invariant: exactly one outstanding claim worth requestedWei.
  const claimKey = `balance-claim:eip155:${CHAIN_ID}:${OPERATOR.toLowerCase()}`;
  const claimedRaw = await kv.get(claimKey);
  // The 9 failing calls performed CAS-revert (DECRBY requestedWei), so the
  // ledger is exactly 1 * requestedWei.
  assert.equal(Number(claimedRaw), Number(usdc(0.1)),
    `ledger must be 1 * requestedWei (no double spend), got ${claimedRaw}`);

  // Sanity: release the surviving claim and verify ledger zeroes out.
  const winner = results.find((r) => r.ok);
  await releaseClaim({ claimKey: winner.claimKey, requestedWei: usdc(0.1), kvClient: kv });
  const zero = Number(await kv.get(claimKey));
  assert.equal(zero, 0, 'ledger should be zero after winner release');
});

// ── T-CS-02: concurrent stress with Redis-fresh / data-stale snapshot ───
//
// BLQ-ALTO-1 regression: simulate the exact mainnet scenario the bug enabled:
//   - On-chain real balance is $0.30 (below threshold $0.50) — gate must reject.
//   - But the cron snapshot says $5.00 with checkedAt 60s ago (data-stale).
//   - Without the freshness check, 4 concurrent calls would each see $5 cached,
//     pass threshold, INCRBY to claim, and double-spend.
//   - With the fix, every call sees the >30s checkedAt, falls through to RPC,
//     reads the real $0.30, and rejects with `below threshold`.
test('T-CS-02: concurrent stress + stale snapshot → no double-spend (BLQ-ALTO-1)', async () => {
  const kv = createKvMock();
  // Real on-chain: $0.30 — below threshold $0.50.
  const rpc = createRpcMock({ balance: usdc(0.3) });

  // Pre-seed snapshot: Redis-fresh (TTL 1500s) BUT data-stale (60s old) with
  // a wrong "approve me" balance of $5.00.
  const snapKey = `balance-snapshot:eip155:${CHAIN_ID}:${OPERATOR.toLowerCase()}`;
  await kv.set(
    snapKey,
    JSON.stringify({
      balanceWei: usdc(5).toString(),
      balanceUsdc: 5.0,
      checkedAt: new Date(Date.now() - 60_000).toISOString(),
      blockNumber: '12345',
    }),
    { ex: 1500 },
  );

  const calls = Array.from({ length: 10 }, () =>
    checkBalanceWithClaim({
      operator: OPERATOR,
      chainId: CHAIN_ID,
      requestedWei: usdc(0.1),
      threshold: 0.5,
      kvClient: kv,
      publicClient: rpc,
      usdcAddress: USDC_ADDR,
    }),
  );
  const results = await Promise.all(calls);

  const okCount = results.filter((r) => r.ok).length;
  assert.equal(okCount, 0, `expected ZERO passes (real balance below threshold), got ${okCount}`);

  // Every failure must be `below threshold` — the gate consulted the RPC,
  // not the stale snapshot.
  for (const r of results) {
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'balance-gate');
    assert.match(r.error, /below threshold/);
  }

  // Ledger invariant: zero outstanding claims (no INCRBY survived).
  const claimKey = `balance-claim:eip155:${CHAIN_ID}:${OPERATOR.toLowerCase()}`;
  const claimed = await kv.get(claimKey);
  // Either absent or 0 — both prove no double-spend.
  assert.ok(
    claimed === null || Number(claimed) === 0,
    `ledger must be 0 (no double-spend), got ${claimed}`,
  );
});
