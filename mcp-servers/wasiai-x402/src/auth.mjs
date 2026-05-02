// auth.mjs — bearer token validation with timing-safe comparison (WKH-65).
//
// Used by api/mcp.mjs to authenticate POST /api/mcp requests before any
// JSON-RPC body parsing (AC-5, CD-2). The check happens at the very edge of
// the function, so an attacker that does not know the token cannot reach
// any handler logic, cannot trigger fetch() to the gateway, and cannot cause
// signing.
//
// WKH-75 W1 — dual-bearer overlap window:
//   - Accepts an optional third arg `prevToken` (default '').
//   - When `prevToken` is a 64-char string AND the current-token compare
//     fails, a second timing-safe compare is attempted against `prevToken`.
//   - Backward-compatible with AUTH-01..AUTH-09 (pre-WKH-75 callers passed
//     two args; the third defaults to '' so behavior is identical).
//   - CD-8: AUTH-01..AUTH-09 must remain green.
//   - CD-2: BOTH comparisons (current + prev) are timing-safe; no `===`,
//     no early-return between length-check and timingSafeEqual within a
//     single token comparison.
//
// Security invariants:
//   - CD-2: comparison MUST be timing-safe (node:crypto.timingSafeEqual).
//     PROHIBITED: ===, indexOf, ad-hoc loops with early return.
//   - DT-D: token format = `Bearer <hex 64-chars>` from `openssl rand -hex 32`.
//     The `Bearer ` prefix length is constant; only the token bytes are
//     compared timing-safely.
//   - When buffer lengths differ, we skip timingSafeEqual (which itself
//     throws on length mismatch) and fall through. The token format is
//     public knowledge so the length-difference branch does not leak secret
//     bits; it only signals "the caller did not present a valid token".
//   - AC-7 / CD-7: callers MUST refuse to start the function if the
//     expected token env var is missing. This module only validates that
//     `expectedToken` is non-empty as a defensive guard; the real fail-fast
//     lives in api/mcp.mjs before we are even invoked.
//   - WKH-75 CD-9: NEVER log the prev token, the current token, or the
//     presented header from this module.

import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';

export class AuthError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'AuthError';
  }
}

const BEARER_RE = /^Bearer (.+)$/;

/**
 * Validate a bearer token presented in the `Authorization` header.
 *
 * @param {string} authHeader  raw value of the `Authorization` request header.
 *                              May be the empty string when the header is absent.
 * @param {string} expectedToken  the operator-configured bearer token
 *                                (typically from process.env.MCP_BEARER_TOKEN).
 * @param {string} [prevToken]   optional previous bearer token kept valid
 *                                during the 24h overlap window post-rotation
 *                                (typically from process.env.MCP_BEARER_TOKEN_PREV).
 *                                Default '' (no overlap; behaves like the
 *                                pre-WKH-75 single-bearer flow).
 * @returns {true}  on successful validation.
 * @throws {AuthError}  on any failure (missing header, malformed, wrong token,
 *                      empty expected token).
 */
export function validateBearerToken(authHeader, expectedToken, prevToken = '') {
  // Defensive: caller MUST pre-validate this in production (CD-7), but a
  // local guard here prevents accidental "auth disabled" if someone calls
  // this module directly with an empty expected.
  if (typeof expectedToken !== 'string' || expectedToken.length === 0) {
    throw new AuthError('server misconfigured: expected bearer token is empty');
  }

  if (typeof authHeader !== 'string' || authHeader.length === 0) {
    throw new AuthError('missing or malformed Authorization header');
  }

  const m = authHeader.match(BEARER_RE);
  if (!m) {
    throw new AuthError('missing or malformed Authorization header');
  }
  const presented = m[1];

  const presentedBuf = Buffer.from(presented, 'utf8');

  // CD-2: BOTH comparisons (current + prev) must be timing-safe via
  // timingSafeEqual. We do NOT use ===, indexOf, or any ad-hoc compare.
  // Length pre-check is mandatory because timingSafeEqual throws RangeError
  // on length mismatch — the format (hex 64 chars) is public knowledge so
  // the length-only branch does not leak secret bits.
  let currentMatch = false;
  const expectedBuf = Buffer.from(expectedToken, 'utf8');
  if (presentedBuf.length === expectedBuf.length) {
    currentMatch = timingSafeEqual(presentedBuf, expectedBuf);
  }
  if (currentMatch) return true;

  // WKH-75 W1.3 — dual-bearer overlap. Only attempt the prev compare when:
  //   - prevToken is a non-empty string of EXACTLY 64 chars (well-formed).
  //   - The malformed-prev case (length !== 64) is silently ignored: the
  //     operator can leave the env var blank or with a placeholder and only
  //     the current token will be honored. CD-8: this preserves AUTH-01..09.
  if (typeof prevToken === 'string' && prevToken.length === 64) {
    const prevBuf = Buffer.from(prevToken, 'utf8');
    if (presentedBuf.length === prevBuf.length) {
      const prevMatch = timingSafeEqual(presentedBuf, prevBuf);
      if (prevMatch) return true;
    }
  }

  throw new AuthError('unauthorized');
}
