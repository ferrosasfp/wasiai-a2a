// balance-guard.mjs — Operator wallet balance gate + atomic claim (WKH-66 W2.1).
//
// Why this module exists:
//   The wasiai-x402 MCP signs USDC EIP-3009 transfers from a single operator
//   wallet. Concurrent pay_x402 calls in mainnet drain that wallet faster
//   than RPC propagation, so a "balance > amount" check on each call is not
//   enough. We need:
//     (1) Fail-secure check BEFORE signing (CD-2): if we can't read balance,
//         reject. Never sign blind.
//     (2) An atomic claim that serializes concurrent calls against the SAME
//         operator. We use Upstash INCRBY (single-threaded JS, V10.1.a)
//         on a `balance-claim:eip155:<chainId>:<operator>` key with a TTL
//         ceiling of CD-13 (≤60s). Reads happen against KV first (cached
//         TTL 30s) and fall back to viem.readContract.
//     (3) A best-effort release on settle (try/finally in api/mcp.mjs) so
//         the claim ledger doesn't accumulate orphans. The 30s TTL acts as
//         the safety net if the function dies mid-flow (SDD §V7).
//
// PROHIBITED:
//   - Lua EVAL (DT-I) — Upstash supports it but DT-I locks us to INCRBY +
//     CAS-revert because it is portable across all KV vendors.
//   - TTL > 60s on any key set here (CD-13).
//   - logging the operator address as part of `event:` payload (CD-17).
//
// Public surface:
//   - checkBalanceWithClaim(opts) → { ok, claimId, claimKey, balanceUsdc, claimedTotalWei }
//                                 | { ok:false, stage:'balance-gate', error }
//   - releaseClaim({ claimKey, requestedWei, kvClient }) → void (best-effort)
//   - getOperatorBalance(rpcUrl, operator, usdcAddress) → bigint
//   - isCircuitOpen(balanceUsdc, threshold) → boolean

import { randomUUID } from 'node:crypto';
import { erc20Abi } from 'viem';
import { getAvaxClient } from './avax-client.mjs';
import * as log from './log.mjs';

// USDC on Avalanche has 6 decimals. Native USDC.
const USDC_DECIMALS = 6;
const USDC_DECIMALS_DIVISOR = 10n ** BigInt(USDC_DECIMALS);

const CLAIM_TTL_DEFAULT_SEC = 30;
const SNAPSHOT_TTL_DEFAULT_SEC = 30;

// BLQ-ALTO-1 (CD-2): never trust a snapshot whose checkedAt is older than this.
// The cron writes Redis TTL 1800s; this freshness window forces an RPC fallback
// after 30s even if the cached blob is technically still in Redis. Closes the
// 15-min blind-gate window between cron runs after an external drain.
const SNAPSHOT_FRESH_MS = 30_000;

// ── Helpers ──────────────────────────────────────────────────────────────

function _claimKey(chainId, operator) {
  return `balance-claim:eip155:${chainId}:${operator.toLowerCase()}`;
}

function _snapshotKey(chainId, operator) {
  return `balance-snapshot:eip155:${chainId}:${operator.toLowerCase()}`;
}

/**
 * Convert wei (USDC, 6 decimals) → number USDC (Number is fine here — values
 * are bounded by mainnet operator balances ≤ a few thousand USDC).
 */
function _weiToUsdc(weiBigint) {
  const whole = weiBigint / USDC_DECIMALS_DIVISOR;
  const frac = weiBigint % USDC_DECIMALS_DIVISOR;
  return Number(whole) + Number(frac) / Number(USDC_DECIMALS_DIVISOR);
}

function _usdcToWei(usdcNumber) {
  // Convert via string to avoid float precision issues at 6 decimals.
  const fixed = Number(usdcNumber).toFixed(USDC_DECIMALS);
  const [whole, frac = ''] = fixed.split('.');
  const padded = (frac + '0'.repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  return BigInt(whole) * USDC_DECIMALS_DIVISOR + BigInt(padded);
}

// ── Public surface ──────────────────────────────────────────────────────

/**
 * Read the USDC balance of `operator` on Avalanche C-Chain mainnet.
 * Returns the raw bigint (wei with 6 decimals).
 *
 * NO retries — caller decides fail-secure semantics.
 */
export async function getOperatorBalance(rpcUrl, operator, usdcAddress) {
  // MNR-CR-3 + MNR-CR-4: reuse the singleton viem PublicClient instead of
  // instantiating one per call.
  const client = getAvaxClient(rpcUrl);
  const balance = await client.readContract({
    address: usdcAddress,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [operator],
  });
  return balance;
}

export function isCircuitOpen(balanceUsdc, threshold) {
  return balanceUsdc < threshold;
}

/**
 * Check the operator balance and reserve `requestedWei` against the claim
 * ledger. Returns:
 *   - { ok: true, claimId, claimKey, balanceUsdc, claimedTotalWei } on success
 *   - { ok: false, stage: 'balance-gate', error } on any failure (fail-secure)
 *
 * Inputs (all required unless noted):
 *   - operator        : 0x-address (case-insensitive)
 *   - chainId         : number (43114 mainnet)
 *   - requestedWei    : bigint (USDC 6-decimal wei, ≥ 1n)
 *   - threshold       : number (USDC, e.g. 0.5)
 *   - kvClient        : @upstash/redis-shaped client OR null
 *   - publicClient    : viem PublicClient OR an object exposing readContract
 *   - usdcAddress     : 0x-address of the USDC contract
 *   - claimTtlSec     : optional, default 30 (CD-13: must be ≤ 60)
 *   - snapshotTtlSec  : optional, default 30
 */
export async function checkBalanceWithClaim({
  operator,
  chainId,
  requestedWei,
  threshold,
  kvClient,
  publicClient,
  usdcAddress,
  claimTtlSec = CLAIM_TTL_DEFAULT_SEC,
  snapshotTtlSec = SNAPSHOT_TTL_DEFAULT_SEC,
}) {
  // CD-13 — clamp on TTL.
  if (claimTtlSec > 60) {
    return { ok: false, stage: 'balance-gate', error: 'claim TTL > 60s prohibited (CD-13)' };
  }

  // CD-2 — fail-secure if KV not available.
  if (!kvClient) {
    return { ok: false, stage: 'balance-gate', error: 'balance check unavailable' };
  }

  if (typeof requestedWei !== 'bigint' || requestedWei <= 0n) {
    return { ok: false, stage: 'balance-gate', error: 'invalid requestedWei' };
  }

  const snapKey = _snapshotKey(chainId, operator);
  const claimKey = _claimKey(chainId, operator);

  // 1) Try cached balance first — but only if the snapshot is FRESH.
  //
  // BLQ-ALTO-1: the cron writes the snapshot with Redis TTL 1800s (30 min)
  // because it runs every ~15 min. The Redis TTL is a coarse safety net
  // (snapshot eventually disappears) — it is NOT a freshness signal.
  // We MUST validate `checkedAt` against SNAPSHOT_FRESH_MS (30s) and fall
  // through to RPC if older. Otherwise an external drain between cron runs
  // would let the gate keep approving against stale data for ≤15 min.
  let balanceWei = null;
  try {
    const cached = await kvClient.get(snapKey);
    if (cached) {
      // Snapshot is JSON {balanceWei: '<bigint-string>', checkedAt: <iso>, ...}.
      let parsed;
      try {
        parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed.balanceWei === 'string' && typeof parsed.checkedAt === 'string') {
        const ageMs = Date.now() - new Date(parsed.checkedAt).getTime();
        if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= SNAPSHOT_FRESH_MS) {
          // Fresh — trust the cached value.
          balanceWei = BigInt(parsed.balanceWei);
        } else {
          // Stale (>30s or invalid timestamp) — log and fall through to RPC.
          log.info('mcp.balance.snapshot-stale', {
            stage: 'balance-gate', ageMs: Number.isFinite(ageMs) ? ageMs : null, ok: true,
          });
        }
      }
    }
  } catch (e) {
    // KV read failed: log and continue to RPC fallback. NOT fail-secure here
    // because we can still reach the source-of-truth.
    log.warn('mcp.balance.snapshot-read-failed', { stage: 'balance-gate', error: e?.message ?? 'unknown' });
  }

  // 2) Fallback to RPC.
  if (balanceWei === null) {
    try {
      balanceWei = await publicClient.readContract({
        address: usdcAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [operator],
      });
      // Cache (best-effort).
      try {
        await kvClient.set(
          snapKey,
          JSON.stringify({ balanceWei: balanceWei.toString(), checkedAt: new Date().toISOString() }),
          { ex: snapshotTtlSec },
        );
      } catch (e) {
        log.warn('mcp.balance.snapshot-write-failed', { stage: 'balance-gate', error: e?.message ?? 'unknown' });
      }
    } catch (e) {
      // RPC down → fail-secure.
      return { ok: false, stage: 'balance-gate', error: 'balance check unavailable' };
    }
  }

  // 3) Threshold gate (pre-claim).
  const balanceUsdc = _weiToUsdc(balanceWei);
  if (balanceUsdc < threshold) {
    return { ok: false, stage: 'balance-gate', error: 'operator balance below threshold' };
  }

  const thresholdWei = _usdcToWei(threshold);

  // 4) Atomic claim. INCRBY is single-call atomic (V10.1.a).
  //    We THEN check if the post-increment total exceeds (balance - threshold)
  //    and CAS-revert via DECRBY if so. This is the documented gap that
  //    Lua EVAL would close (DT-I trade-off accepted in SDD).
  let claimedTotalWei;
  try {
    claimedTotalWei = BigInt(await kvClient.incrby(claimKey, Number(requestedWei)));
    // Set TTL only on first claim — ignore errors; the claim lives at most
    // claimTtlSec from now on.
    await kvClient.expire(claimKey, claimTtlSec);
  } catch (e) {
    return { ok: false, stage: 'balance-gate', error: 'claim atomic failed' };
  }

  // 5) Post-claim invariant check.
  const maxClaimableWei = balanceWei - thresholdWei;
  if (claimedTotalWei > maxClaimableWei) {
    // CAS-revert. Best-effort — orphaned increment will expire by TTL.
    try { await kvClient.decrby(claimKey, Number(requestedWei)); } catch { /* swallowed: TTL safety net */ }
    return { ok: false, stage: 'balance-gate', error: 'concurrent claim exceeded' };
  }

  return {
    ok: true,
    claimId: randomUUID(),
    claimKey,
    balanceUsdc,
    claimedTotalWei,
  };
}

/**
 * Release the wei reserved by a previous successful checkBalanceWithClaim.
 * Best-effort — never throws.
 */
export async function releaseClaim({ claimKey, requestedWei, kvClient }) {
  if (!kvClient || !claimKey) return;
  try {
    await kvClient.decrby(claimKey, Number(requestedWei));
  } catch (e) {
    log.warn('mcp.balance.claim-release-failed', { stage: 'balance-gate', error: e?.message ?? 'unknown' });
  }
}

// Test surface — used to exercise the wei↔usdc conversion in unit tests.
export const _testHelpers = { _weiToUsdc, _usdcToWei };
