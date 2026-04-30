// auth.mjs — bearer token validation with timing-safe comparison (WKH-65).
//
// Used by api/mcp.mjs to authenticate POST /api/mcp requests before any
// JSON-RPC body parsing (AC-5, CD-2). The check happens at the very edge of
// the function, so an attacker that does not know the token cannot reach
// any handler logic, cannot trigger fetch() to the gateway, and cannot cause
// signing.
//
// Security invariants:
//   - CD-2: comparison MUST be timing-safe (node:crypto.timingSafeEqual).
//     PROHIBITED: ===, indexOf, ad-hoc loops with early return.
//   - DT-D: token format = `Bearer <hex 64-chars>` from `openssl rand -hex 32`.
//     The `Bearer ` prefix length is constant; only the token bytes are
//     compared timing-safely.
//   - When buffer lengths differ, we throw WITHOUT calling timingSafeEqual
//     (which itself throws on length mismatch). The token format is public
//     knowledge so the length-difference branch does not leak secret bits;
//     it only signals "the caller did not present a valid token".
//   - AC-7 / CD-7: callers MUST refuse to start the function if the
//     expected token env var is missing. This module only validates that
//     `expectedToken` is non-empty as a defensive guard; the real fail-fast
//     lives in api/mcp.mjs before we are even invoked.

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
 * @returns {true}  on successful validation.
 * @throws {AuthError}  on any failure (missing header, malformed, wrong token,
 *                      empty expected token).
 */
export function validateBearerToken(authHeader, expectedToken) {
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

  // Buffer comparison must be byte-equal length, otherwise timingSafeEqual
  // throws RangeError. We pre-check lengths to surface a stable AuthError.
  // This length-only branch does not leak secret bits because the token
  // format (hex 64 chars after `Bearer `) is public.
  const presentedBuf = Buffer.from(presented, 'utf8');
  const expectedBuf = Buffer.from(expectedToken, 'utf8');
  if (presentedBuf.length !== expectedBuf.length) {
    throw new AuthError('unauthorized');
  }

  // CD-2: timing-safe byte comparison.
  if (!timingSafeEqual(presentedBuf, expectedBuf)) {
    throw new AuthError('unauthorized');
  }
  return true;
}
