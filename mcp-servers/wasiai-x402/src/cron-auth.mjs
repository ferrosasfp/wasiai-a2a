// cron-auth.mjs — Bearer auth for /api/cron/* endpoints (WKH-66 W1.1).
//
// Mirrors src/auth.mjs (validateBearerToken) but exposes a different error
// type so the cron handlers can map to {401, 500} cleanly:
//   - missing CRON_SECRET env → 500 (server misconfigured, NEVER "auth
//     disabled" — CD-4).
//   - missing/malformed/wrong header → 401.
//
// Why a separate module: src/auth.mjs is locked under CD-1 and its error
// shape is tied to the api/mcp.mjs path. The cron handlers run on a
// different surface (cron-job.org pings) and need:
//   - a status code on the error so the handler can `res.status(err.status)`
//   - a slightly different missing-secret semantic (500 vs the auth.mjs
//     defensive 500-equivalent).
//
// Security invariants:
//   - CD-2: timing-safe comparison via crypto.timingSafeEqual.
//   - CD-10: NEVER log the presented header or the expected secret. The
//     handlers log only `mcp.cron.unauthorized` with no payload fields that
//     could carry the secret.
//   - CD-17: when a caller logs around this module, it MUST NOT pass
//     `event:` inside the fields object — log.warn already takes the event
//     name as the first arg.

import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';

export class CronAuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = 'CronAuthError';
    this.status = status;
  }
}

const BEARER_RE = /^Bearer (.+)$/;

/**
 * Validate the Authorization header against CRON_SECRET.
 *
 * @param {string} authHeader  raw Authorization header value (may be '').
 * @param {string} expectedSecret  process.env.CRON_SECRET equivalent.
 * @returns {true}  on success.
 * @throws {CronAuthError}  with status 500 if expectedSecret is missing,
 *                          status 401 on any other failure.
 */
export function validateCronSecret(authHeader, expectedSecret) {
  // CD-4: never silently disable auth. Missing CRON_SECRET in production
  // MUST be a 500 misconfiguration, NOT a 200 with auth bypassed.
  if (typeof expectedSecret !== 'string' || expectedSecret.length === 0) {
    throw new CronAuthError('CRON_SECRET not configured', 500);
  }

  if (typeof authHeader !== 'string' || authHeader.length === 0) {
    throw new CronAuthError('unauthorized', 401);
  }

  const m = authHeader.match(BEARER_RE);
  if (!m) {
    throw new CronAuthError('unauthorized', 401);
  }
  const presented = m[1];

  // Length pre-check — timingSafeEqual throws on length mismatch, and the
  // CRON_SECRET format (32-byte hex, 64 chars) is public knowledge, so this
  // length-only branch does not leak secret bits.
  const presentedBuf = Buffer.from(presented, 'utf8');
  const expectedBuf = Buffer.from(expectedSecret, 'utf8');
  if (presentedBuf.length !== expectedBuf.length) {
    throw new CronAuthError('unauthorized', 401);
  }

  if (!timingSafeEqual(presentedBuf, expectedBuf)) {
    throw new CronAuthError('unauthorized', 401);
  }
  return true;
}
