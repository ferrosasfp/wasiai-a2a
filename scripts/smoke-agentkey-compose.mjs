#!/usr/bin/env node
/**
 * Smoke — prepaid AGENT-KEY compose path (budget debit, NO x402 inbound).
 *
 * Exercises the prepaid path: a budgeted caldz agent key (x-a2a-key) drives a
 * /compose pipeline. The middleware (requirePaymentOrA2AKey) debits the key's
 * budget per call instead of negotiating an inbound x402 payment, then each step
 * settles downstream on its target chain.
 *
 * Asserts (when a FUNDED key is provided):
 *   1. GET /auth/me → key is active and has a positive budget on some chain.
 *   2. POST /compose with x-a2a-key (NO payment-signature header):
 *      → HTTP 200 (NOT a 402 challenge — proves no x402 inbound was required).
 *      → pipeline succeeds, at least one step ran.
 *      → at least one downstream settle tx hash is present.
 *      → x-a2a-remaining-budget header is returned and DECREASED vs the pre-call
 *        budget (budget was debited).
 *
 * FOUNDER-GATED: this needs a funded caldz agent key. The repo .env key
 * (AGENT_KEY_WASIAI) is NOT valid against prod (different DB / stale), and a fresh
 * /auth/agent-signup key has $0 budget. Without a funded key this script SKIPS
 * with exit 0 and a clear message (it is a no-op, not a failure).
 *
 * Required env:
 *   A2A_URL        gateway base (default prod testnet)
 *   A2A_KEY        a FUNDED caldz agent key (wasi_a2a_...). REQUIRED to run.
 *   COMPOSE_AGENT  (optional) agent slug for the single step (default a cheap one)
 *   COMPOSE_CHAIN  (optional) chainId to check budget on (default first funded)
 *
 * Usage:
 *   A2A_KEY=wasi_a2a_xxx node scripts/smoke-agentkey-compose.mjs
 */
const A2A =
  process.env.A2A_URL || 'https://wasiai-a2a-production.up.railway.app';
const AGENT = process.env.COMPOSE_AGENT || 'agentshop-kyc-validator';

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

const key = process.env.A2A_KEY;
if (!key) {
  console.log(`\n🔬 Smoke agent-key compose vs ${A2A}\n`);
  console.log(
    '  ⏭️  SKIPPED: needs a funded caldz agent key (set A2A_KEY=wasi_a2a_...)\n',
  );
  console.log(
    '     The prepaid compose path debits an agent key budget instead of an x402',
  );
  console.log(
    '     inbound payment. No funded key is available in this environment',
  );
  console.log(
    '     (repo .env AGENT_KEY_WASIAI is stale vs prod; signup keys are $0).',
  );
  console.log('     FOUNDER-GATED — provide a funded key to exercise it.\n');
  process.exit(0);
}

const sumBudget = (budget) => {
  if (!budget || typeof budget !== 'object') return 0;
  return Object.values(budget).reduce((acc, v) => acc + (Number(v) || 0), 0);
};

const main = async () => {
  console.log(`\n🔬 Smoke agent-key compose vs ${A2A}\n`);
  console.log(`  Key: ${key.slice(0, 12)}…   Agent step: ${AGENT}\n`);

  // 1. Key must be active + funded.
  const meRes = await fetch(`${A2A}/auth/me`, {
    headers: { 'x-a2a-key': key },
  });
  const me = await meRes.json().catch(() => null);
  ok('GET /auth/me → key active', meRes.status === 200 && me?.is_active === true,
    `HTTP ${meRes.status}`);
  if (meRes.status !== 200 || !me?.is_active) {
    banner('A2A_KEY is not a valid/active key against this gateway');
    process.exit(1);
  }
  const budgetBefore = sumBudget(me.budget);
  ok('key has positive budget on some chain', budgetBefore > 0,
    `budget=${JSON.stringify(me.budget)}`);
  if (budgetBefore <= 0) {
    banner('A2A_KEY has $0 budget — cannot exercise the prepaid path');
    process.exit(1);
  }

  // 2. Compose with the agent key — NO payment-signature header.
  console.log('\n  POST /compose (x-a2a-key, no payment-signature)');
  const res = await fetch(`${A2A}/compose`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-a2a-key': key },
    body: JSON.stringify({
      steps: [{ agent: AGENT, input: { query: 'smoke prepaid compose probe' } }],
    }),
  });
  const remainingHeader = res.headers.get('x-a2a-remaining-budget');
  const body = await res.json().catch(() => null);

  ok('compose → HTTP 200 (no x402 inbound required)', res.status === 200,
    `HTTP ${res.status}`);
  if (res.status === 402) {
    banner('got 402 — the agent-key path did NOT bypass x402 inbound');
    process.exit(1);
  }
  if (res.status !== 200) {
    banner(`compose failed: ${JSON.stringify(body).slice(0, 120)}`);
    process.exit(1);
  }

  ok('pipeline.success === true', body?.success === true || body?.pipeline?.success === true,
    `success=${body?.success ?? body?.pipeline?.success}`);

  const steps = body?.steps ?? body?.pipeline?.steps ?? [];
  ok('at least one step executed', Array.isArray(steps) && steps.length >= 1,
    `steps=${steps.length}`);

  const downstreamTxs = steps.map((s) => s.downstreamTxHash).filter(Boolean);
  ok('at least one downstream settle tx present', downstreamTxs.length >= 1,
    `downstream=${downstreamTxs.length}`);
  downstreamTxs.forEach((tx) => console.log(`     downstream tx: ${tx}`));

  // 3. Budget debited.
  ok('x-a2a-remaining-budget header returned', remainingHeader !== null,
    `header=${remainingHeader}`);
  const remaining = Number(remainingHeader);
  ok('remaining budget DECREASED (budget debited, no x402 inbound)',
    Number.isFinite(remaining) && remaining < budgetBefore,
    `before≈${budgetBefore} after=${remaining}`);

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
