// kv-client.mjs — Lazy singleton wrapper over @upstash/redis (WKH-66 W0.7).
//
// Why this module exists:
//   - api/mcp.mjs (rate-limit) and src/balance-guard.mjs both need the same
//     KV client. We do NOT want each call site to construct its own Redis
//     instance — that would re-read env vars per request and also pay the
//     lib's per-instance setup cost on every cold/warm path.
//
// Null-safe contract (CD-2):
//   - If env vars are missing, getKvClient() returns `null` instead of
//     throwing. Call sites MUST handle null:
//       - balance-guard → fail-secure (reject pay_x402).
//       - rate-limit    → fail-open  (allow request through).
//   - This split is intentional and documented in SDD §4.3.
//
// Test override:
//   - setKvClientForTesting(mock) bypasses the real Redis. Tests inject a
//     kv-mock built from tests/_mocks/kv-mock.mjs.
//   - resetKvClient() clears both the singleton and the test override (the
//     fixture in beforeEach uses this so each test starts from a clean
//     slate).

import { Redis } from '@upstash/redis';
import { warnOnce } from './log.mjs';

let _client = null;
let _testOverride = null;

export function getKvClient() {
  if (_testOverride !== null) return _testOverride;
  if (_client) return _client;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    // warnOnce keeps cold-start logs clean — we only emit this line on the
    // first call after env vars are checked. resetKvClient() also clears the
    // warnOnce flag indirectly because tests reset the log module.
    warnOnce('kv-not-configured', 'kv.client.not-configured', {});
    return null;
  }
  _client = new Redis({ url, token });
  return _client;
}

export function setKvClientForTesting(client) { _testOverride = client; }
export function resetKvClient() { _client = null; _testOverride = null; }
