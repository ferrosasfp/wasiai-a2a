// rate-limit.mjs — Per-bearer fixed-window rate limit (WKH-66 W2.2).
//
// Why this module exists:
//   We expose api/mcp.mjs to the public internet on Vercel. Even though the
//   bearer is required, a leaked or compromised bearer must NOT be able to
//   exhaust the operator wallet via a rapid-fire concurrent flood. This
//   module gates each bearer to MCP_RATE_LIMIT_PER_MIN requests per
//   MCP_RATE_LIMIT_WINDOW_SEC seconds.
//
// Algorithm: fixed-window with TTL = window. Atomic INCR + EXPIRE. The
// race-condition is acceptable per CD-2: at the window boundary an attacker
// might get ~2x the limit in flight; that's compatible with Upstash semantics
// and bounded enough not to drain the wallet (balance-guard catches the rest).
//
// PROHIBITED:
//   - Use the raw bearer as the key (CD-3) — KV inspector could enumerate
//     bearers via `KEYS rl:*`. We hash to sha256 truncated to 16 hex chars.
//   - Use IP as key (CD-3) — a single user behind NAT can disable themselves.
//   - Lua EVAL (DT-I).
//
// Fail-open contract: when KV is down or returns null we ALLOW the request
// (the inverse of balance-guard's fail-secure stance). Rationale: balance
// gate is the second line of defense for actual fund safety; rate-limit is
// noise control. Failing closed on rate-limit would let an Upstash outage
// take the MCP offline entirely, which is worse than letting traffic
// through during a transient KV blip.

import { createHash } from 'node:crypto';
import * as log from './log.mjs';

/**
 * Hash a bearer to a 16-hex-char (64-bit) prefix.
 * sha256 → hex → slice(0,16). Birthday collision bound ~2^32 — outside the
 * threat model (V2.4).
 */
export function hashBearer(bearerToken) {
  return createHash('sha256').update(bearerToken, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Check the rate limit for a hashed bearer.
 *
 * @param {object} args
 * @param {string} args.bearerHash16  hashBearer(token) — 16 hex chars.
 * @param {object|null} args.kvClient @upstash/redis-shaped client OR null.
 * @param {number} args.perMin        max calls per window.
 * @param {number} args.windowSec     window TTL in seconds.
 * @returns {Promise<{ok:true} | {ok:false, retryAfter:number}>}
 */
export async function checkRateLimit({ bearerHash16, kvClient, perMin, windowSec }) {
  // Fail-open per the module contract.
  if (!kvClient) return { ok: true };

  const key = `rl:${bearerHash16}`;

  let count;
  try {
    count = await kvClient.incr(key);
  } catch (e) {
    log.warn('mcp.ratelimit.kv-incr-failed', { stage: 'rate-limit', error: e?.message ?? 'unknown' });
    return { ok: true };
  }

  // First call of the window: set TTL. Race-tolerant: if a parallel call also
  // sees count===1 (impossible under single-shard Upstash, but defensive)
  // EXPIRE just sets idempotently.
  if (count === 1) {
    try {
      await kvClient.expire(key, windowSec);
    } catch (e) {
      log.warn('mcp.ratelimit.kv-expire-failed', { stage: 'rate-limit', error: e?.message ?? 'unknown' });
    }
  }

  if (count > perMin) {
    let retryAfter = windowSec;
    try {
      const ttl = await kvClient.ttl(key);
      if (typeof ttl === 'number' && ttl > 0) retryAfter = ttl;
    } catch {
      // Use windowSec fallback.
    }
    return { ok: false, retryAfter };
  }

  return { ok: true };
}
