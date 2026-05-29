/**
 * WKH-35 — k6 load test (PROD). Read-only / non-mutating: it never creates keys
 * and never writes to the DB. It exercises the hot, side-effect-free paths:
 *   - GET  /health                        (liveness, cheapest path)
 *   - POST /auth/deposit  (no auth)        → 403 (routing + auth resolution)
 *   - POST /auth/deposit  (garbage key)    → 403 (SHA-256 key lookup, 1 indexed read)
 *   - POST /auth/deposit  (valid key shape, bad input, no auth) stays at the gate
 *
 * Why no happy-path deposit under load: crediting mutates prod (deposit rows +
 * budget) and burns the global anti-replay on real txHashes — not safe to hammer.
 * Auth/validation latency is the meaningful SLO for this endpoint anyway.
 *
 * Rate limiter: the API enforces a GLOBAL 60 req/min PER IP (RATE_LIMIT_MAX=60,
 * RATE_LIMIT_WINDOW_MS=60000; /health is exempt). A single-IP load run WILL get
 * 429s on /auth/deposit once it exceeds 60/min — that is the limiter working as
 * designed. So: latency/throughput SLOs are measured on /health (exempt), and
 * the 429s are treated as a POSITIVE signal (the limiter engaged under burst),
 * not a failure.
 *
 * Tunables (env):
 *   PROD_URL   default https://wasiai-a2a-production.up.railway.app
 *   VUS        default 10   (prod is a Railway hobby tier — keep it modest)
 *   DURATION   default 30s
 *   RPS        optional arrival-rate cap; if set, uses constant-arrival-rate
 *
 * Run:
 *   k6 run scripts/k6-prod-deposit-load.js
 *   VUS=25 DURATION=1m k6 run scripts/k6-prod-deposit-load.js
 *   RPS=50 DURATION=1m k6 run scripts/k6-prod-deposit-load.js
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const PROD = __ENV.PROD_URL || 'https://wasiai-a2a-production.up.railway.app';
const VUS = Number(__ENV.VUS || 10);
const DURATION = __ENV.DURATION || '30s';
const RPS = __ENV.RPS ? Number(__ENV.RPS) : 0;

// 403/400 are EXPECTED (auth/validation gates) — don't count them as request failures.
// 429 is expected-but-flagged: it means the rate limiter engaged under load.
http.setResponseCallback(http.expectedStatuses(200, 400, 403, 429));

const healthLatency = new Trend('health_latency', true);
const depositGateLatency = new Trend('deposit_gate_latency', true);
const rateLimited = new Rate('rate_limited_429');

export const options = {
  scenarios: RPS
    ? {
        load: {
          executor: 'constant-arrival-rate',
          rate: RPS,
          timeUnit: '1s',
          duration: DURATION,
          preAllocatedVUs: Math.max(VUS, RPS),
          maxVUs: Math.max(VUS, RPS) * 2,
        },
      }
    : {
        load: {
          executor: 'ramping-vus',
          startVUs: 1,
          stages: [
            { duration: '5s', target: VUS },
            { duration: DURATION, target: VUS },
            { duration: '5s', target: 0 },
          ],
        },
      },
  thresholds: {
    // SLOs on the exempt liveness path (not distorted by the rate limiter).
    health_latency: ['p(95)<800', 'p(99)<1500'],
    // All responses must be EXPECTED (200 / 403 gate / 429 throttle) — no 5xx, no timeouts.
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.01'],
  },
};

const GARBAGE_KEY = 'wasi_a2a_' + 'd'.repeat(64);
const FAKE_TX = '0x' + '1'.repeat(64);

export default function () {
  // 1. Liveness
  const h = http.get(`${PROD}/health`);
  healthLatency.add(h.timings.duration);
  check(h, { 'health 200': (r) => r.status === 200 });

  // 2. Deposit no-auth → 403 (routing + auth resolution, no DB write)
  const noAuth = http.post(
    `${PROD}/auth/deposit`,
    JSON.stringify({ key_id: 'x', tx_hash: FAKE_TX, chain_id: 43113 }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  depositGateLatency.add(noAuth.timings.duration);
  rateLimited.add(noAuth.status === 429);
  check(noAuth, { 'deposit no-auth 403/429': (r) => r.status === 403 || r.status === 429 });

  // 3. Deposit garbage key → 403 (exercises the SHA-256 key lookup, indexed read)
  const badKey = http.post(
    `${PROD}/auth/deposit`,
    JSON.stringify({ key_id: 'x', tx_hash: FAKE_TX, chain_id: 43113 }),
    { headers: { 'Content-Type': 'application/json', 'x-a2a-key': GARBAGE_KEY } },
  );
  rateLimited.add(badKey.status === 429);
  check(badKey, { 'deposit bad-key 403/429': (r) => r.status === 403 || r.status === 429 });

  sleep(0.5);
}
