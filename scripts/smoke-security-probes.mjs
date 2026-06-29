#!/usr/bin/env node
/**
 * Smoke — live security probes (FREE, no settlement).
 *
 * (a) RATE LIMIT — burst N concurrent POST /auth/agent-signup (limit
 *     RATE_LIMIT_SIGNUP_MAX, default 5/min). Assert a 429 (RATE_LIMIT_EXCEEDED)
 *     eventually appears. Creates throwaway $0 keys only — no money moves.
 *
 * (b) SSRF — attempt to register a marketplace whose discoveryEndpoint is an
 *     internal IP (http://169.254.169.254 cloud-metadata). Assert it is BLOCKED.
 *     POST /registries is behind requirePaymentOrA2AKey AND the auth/budget check
 *     runs BEFORE the SSRF validator. So:
 *       • with a funded A2A_KEY → reaches the validator → assert 422 SSRF_BLOCKED.
 *       • with a fresh $0 key (default) → blocked earlier by the budget gate
 *         (403 INSUFFICIENT_BUDGET). That still proves the endpoint is auth-gated,
 *         but NOT the SSRF guard itself — reported as "needs funded key". The SSRF
 *         guard is unit-covered in registries.ssrf.test.ts.
 *
 * (c) UNAUTHORIZED — protected routes without a key:
 *       • GET  /receipts  → 403 (Invalid or inactive API key)
 *       • POST /compose   → 402 (payment required)
 *
 * Required env:
 *   A2A_URL   gateway base (default prod testnet)
 *   A2A_KEY   (optional) funded agent key → enables the real SSRF assertion
 *   RL_BURST  (optional) burst size for the rate-limit probe (default 70)
 *
 * Usage:
 *   node scripts/smoke-security-probes.mjs
 *   A2A_KEY=wasi_a2a_xxx node scripts/smoke-security-probes.mjs
 */
const A2A =
  process.env.A2A_URL || 'https://wasiai-a2a-production.up.railway.app';
const RL_BURST = parseInt(process.env.RL_BURST ?? '70', 10);

let pass = 0;
let fail = 0;
const ok = (label, cond, detail = '') => {
  console.log(
    `  ${cond ? '✅ PASS' : '❌ FAIL'}  ${label}${detail ? ' — ' + detail : ''}`,
  );
  cond ? pass++ : fail++;
};
const banner = (msg) => {
  console.error('\n╔══════════════════════════════════════════════════════╗');
  console.error(`║  FAIL: ${String(msg).slice(0, 46).padEnd(46)}║`);
  console.error('╚══════════════════════════════════════════════════════╝\n');
};

const status = async (method, path, headers = {}, body) => {
  const res = await fetch(A2A + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* */
  }
  return { code: res.status, json };
};

const main = async () => {
  console.log(`\n🔬 Smoke security probes vs ${A2A}\n`);

  // ── (a) Rate limit ────────────────────────────────────────────────
  console.log(
    `  (a) Rate-limit: ${RL_BURST} concurrent POST /auth/agent-signup`,
  );
  const codes = await Promise.all(
    Array.from({ length: RL_BURST }, (_, i) =>
      fetch(`${A2A}/auth/agent-signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner_ref: `sec-rl-${Date.now()}-${i}` }),
      })
        .then((r) => r.status)
        .catch(() => 0),
    ),
  );
  const n429 = codes.filter((c) => c === 429).length;
  const n201 = codes.filter((c) => c === 201).length;
  ok(
    'rate limiter eventually returns 429 (RATE_LIMIT_EXCEEDED)',
    n429 >= 1,
    `201=${n201} 429=${n429} of ${RL_BURST}`,
  );

  // ── (b) SSRF ──────────────────────────────────────────────────────
  console.log('\n  (b) SSRF: register marketplace with internal-IP endpoint');
  const ssrfBody = {
    name: 'sec-ssrf-probe',
    discoveryEndpoint: 'http://169.254.169.254/latest/meta-data/',
    invokeEndpoint: 'https://example.com/invoke',
    schema: { type: 'rest', discovery: {}, invoke: {} },
  };
  const fundedKey = process.env.A2A_KEY;
  let ssrfKey = fundedKey;
  if (!ssrfKey) {
    // Fresh $0 key — proves auth-gating; will be stopped at the budget gate.
    const su = await status('POST', '/auth/agent-signup', {}, {
      owner_ref: `sec-ssrf-${Date.now()}`,
    });
    ssrfKey = su.json?.key;
  }
  const ssrf = await status(
    'POST',
    '/registries',
    { 'x-a2a-key': ssrfKey },
    ssrfBody,
  );
  if (ssrf.code === 422 || ssrf.json?.error_code === 'SSRF_BLOCKED') {
    ok(
      'SSRF guard blocks internal-IP discoveryEndpoint (422 SSRF_BLOCKED)',
      true,
      `HTTP ${ssrf.code} ${ssrf.json?.error_code ?? ''}`,
    );
  } else if (
    ssrf.code === 403 &&
    ssrf.json?.error_code === 'INSUFFICIENT_BUDGET'
  ) {
    // The endpoint is auth/budget-gated BEFORE SSRF validation. With a $0 key we
    // can't reach the validator — report as needs-funded-key, NOT a pass/fail.
    console.log(
      `  ⚠️  SSRF guard NOT exercised — blocked earlier by budget gate ` +
        `(HTTP 403 INSUFFICIENT_BUDGET).`,
    );
    console.log(
      `      POST /registries needs a FUNDED agent key (set A2A_KEY=...) to reach`,
    );
    console.log(
      `      the SSRF validator without spending an x402 inbound payment.`,
    );
    console.log(
      `      Auth-gating itself is confirmed (no anonymous registration).`,
    );
    ok(
      'POST /registries is auth/budget-gated (no anonymous register)',
      true,
      'HTTP 403 INSUFFICIENT_BUDGET (SSRF assert needs funded key)',
    );
  } else {
    ok(
      'SSRF guard blocks internal-IP discoveryEndpoint',
      false,
      `unexpected HTTP ${ssrf.code} ${JSON.stringify(ssrf.json).slice(0, 80)}`,
    );
  }

  // ── (c) Unauthorized ──────────────────────────────────────────────
  console.log('\n  (c) Unauthorized access to protected routes');
  const rc = await status('GET', '/receipts');
  ok('GET /receipts without key → 403', rc.code === 403, `HTTP ${rc.code}`);
  const cmp = await status('POST', '/compose', {}, { agents: [] });
  ok(
    'POST /compose without payment → 402',
    cmp.code === 402,
    `HTTP ${cmp.code}`,
  );

  console.log(`\n  Resultado: ${pass} PASS / ${fail} FAIL\n`);
  if (fail > 0) {
    banner(`${fail} assertion(s) failed`);
    process.exit(1);
  }
  process.exit(0);
};

main().catch((e) => {
  banner(e.message);
  process.exit(1);
});
