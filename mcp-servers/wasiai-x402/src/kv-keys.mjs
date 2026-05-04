// SPDX-License-Identifier: MIT
// kv-keys.mjs — Centralised KV key registry for the bearer rotation pipeline
// (WKH-88).
//
// Why this file exists (CD-WKH88-3): WKH-75 left two files
// (`src/bearer-rotation.mjs` and `api/cron/invalidate-prev-bearer.mjs`) with
// the same magic string `'last-bearer-rotation'` declared inline. Drift
// between the two would silently break the invalidation flow (the cron handler
// would read a different key from the one the rotator wrote). WKH-88 collapses
// both inline `KV_KEY` constants into a single frozen registry.
//
// Conventions:
//   - Keys are short, hyphen-separated, and prefixed with the domain when
//     useful. `last-bearer-rotation` keeps the WKH-75 wire format (existing KV
//     entries in production are addressed by this exact string — renaming it
//     would orphan them).
//   - The export MUST be `Object.freeze({...})` (CD-WKH88-3). Plain objects can
//     be mutated at runtime; frozen objects refuse silently in non-strict mode
//     and throw in strict mode (which is the default for `.mjs`).
//
// CDs touched:
//   CD-WKH88-3 — frozen object only; PROHIBITED to export functions or loose
//                strings.

export const KV_KEYS = Object.freeze({
  /**
   * Snapshot of the most recent bearer rotation: `{rotatedAt, expiresAt}` JSON
   * with a 25h TTL. Written by `rotateBearer()` (S6) and consumed by
   * `invalidate-prev-bearer` cron handler.
   *
   * IMPORTANT: in-flight production data is keyed by this exact string. Do
   * NOT rename without a coordinated migration.
   */
  LAST_ROTATION: 'last-bearer-rotation',

  /**
   * NX-flagged mutex acquired at S0 of `rotateBearer()` to prevent concurrent
   * rotations from racing the Vercel `MCP_BEARER_TOKEN_PREV` write. TTL is
   * short (5 min) so a crashed worker does not block future rotations
   * permanently (CD-WKH88-6).
   */
  ROTATION_MUTEX: 'bearer-rotation-mutex',
});
