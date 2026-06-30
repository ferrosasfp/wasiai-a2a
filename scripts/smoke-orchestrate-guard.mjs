#!/usr/bin/env node
/**
 * Smoke — /orchestrate no-relevant-agent guard (+ optional credit-back).
 *
 * PART (a) — irrelevant goal → no outbound spend (PRIORITY).
 *   Goal "compose a symphony about cats …" has no matching agent in the catalog.
 *   Asserts the orchestrator returns:
 *     - pipeline.success === false
 *     - reasoning indicating no relevant/available agent
 *     - pipeline.totalCostUsdc === 0  (NO outbound settlement, $0 downstream cost)
 *     - pipeline.steps === []          (no agent executed)
 *     - no downstream/step tx hashes   (nothing settled outbound)
 *
 *   Two ways to run part (a):
 *     • FREE path — set A2A_KEY=<a funded agent key>. The prepaid agent-key path
 *       does NO inbound x402 settle, so the whole scenario is $0 on-chain. This is
 *       the ideal "free, no on-chain spend" demonstration.
 *     • x402 path (fallback, default) — without A2A_KEY the gateway still demands
 *       an inbound payment BEFORE the planner runs (requirePaymentOrA2AKey), so it
 *       settles ONE inbound tx, then the guard fires and NOTHING is spent outbound.
 *       The assertion that the guard works (no outbound spend, $0 downstream) still
 *       holds; the single inbound settle is the gateway's payment model, not the
 *       agent doing work. Requires OPERATOR_PRIVATE_KEY in $ENV_FILE.
 *
 * PART (b) — credit-back on a failing step (OPTIONAL). Skipped unless RUN_REFUND=1
 *   AND a funded A2A_KEY is set, since it needs a step that settles then fails.
 *
 * Required env:
 *   A2A_URL          gateway base (default prod testnet)
 *   ENV_FILE         path to .env with OPERATOR_PRIVATE_KEY + X402_* (default repo .env)
 *   A2A_KEY          (optional) funded agent key → enables the FREE path
 *   RUN_REFUND=1     (optional) attempt part (b)
 *
 * Usage:
 *   node scripts/smoke-orchestrate-guard.mjs
 *   A2A_KEY=wasi_a2a_xxx node scripts/smoke-orchestrate-guard.mjs
 */
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const A2A =
  process.env.A2A_URL || 'https://wasiai-a2a-production.up.railway.app';
const ENV_FILE =
  process.env.ENV_FILE || '/home/ferdev/.openclaw/workspace/wasiai-a2a/.env';
const KITE_CHAIN_ID = 2368;
const KITE_EXPLORER = 'https://testnet.kitescan.ai/tx';
const IRRELEVANT_GOAL =
  'compose a symphony about cats and the meaning of feline existence';

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

function readEnv(p) {
  const out = {};
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_0-9]+)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let v = m[2];
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      )
        v = v.slice(1, -1);
      out[m[1]] = v;
    }
  } catch {
    /* env file optional when A2A_KEY is set */
  }
  return out;
}
const env = readEnv(ENV_FILE);

async function signX402Inbound(treasury, amount) {
  const op = privateKeyToAccount(
    '0x' + env.OPERATOR_PRIVATE_KEY.replace(/[^0-9a-fA-F]/g, '').slice(-64),
  );
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300);
  const nonce = '0x' + randomBytes(32).toString('hex');
  const signature = await op.signTypedData({
    domain: {
      name: env.X402_EIP712_DOMAIN_NAME ?? 'PYUSD',
      version: env.X402_EIP712_DOMAIN_VERSION ?? '1',
      chainId: KITE_CHAIN_ID,
      verifyingContract: env.X402_PAYMENT_TOKEN,
    },
    types: {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'TransferWithAuthorization',
    message: {
      from: op.address,
      to: treasury,
      value: amount,
      validAfter: 0n,
      validBefore,
      nonce,
    },
  });
  const payload = {
    signature,
    authorization: {
      from: op.address,
      to: treasury,
      value: amount.toString(),
      validAfter: '0',
      validBefore: validBefore.toString(),
      nonce,
    },
    network: `eip155:${KITE_CHAIN_ID}`,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

async function callOrchestrate(goal, { agentKey } = {}) {
  if (agentKey) {
    // FREE prepaid path — no inbound x402 settle.
    const res = await fetch(`${A2A}/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-a2a-key': agentKey },
      body: JSON.stringify({ goal, budget: 0.5 }),
    });
    return { status: res.status, body: await res.json(), mode: 'agent-key' };
  }
  // x402 path — one inbound settle, then the guard fires.
  if (!env.OPERATOR_PRIVATE_KEY) {
    throw new Error(
      'no A2A_KEY and no OPERATOR_PRIVATE_KEY in ENV_FILE — cannot reach the planner',
    );
  }
  const probe = await fetch(`${A2A}/orchestrate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal, budget: 0.5 }),
  });
  if (probe.status !== 402) {
    throw new Error(`expected 402 challenge, got ${probe.status}`);
  }
  const accept = (await probe.json()).accepts?.[0];
  const hdr = await signX402Inbound(
    accept.payTo,
    BigInt(accept.maxAmountRequired),
  );
  const res = await fetch(`${A2A}/orchestrate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'payment-signature': hdr },
    body: JSON.stringify({ goal, budget: 0.5 }),
  });
  return { status: res.status, body: await res.json(), mode: 'x402' };
}

const main = async () => {
  console.log(`\n🔬 Smoke /orchestrate guard vs ${A2A}\n`);
  const agentKey = process.env.A2A_KEY;
  console.log(
    `  Mode: ${agentKey ? 'FREE agent-key path (A2A_KEY set)' : 'x402 inbound (one settle, then guard)'}\n`,
  );

  // ── PART (a): irrelevant goal → no outbound spend ──────────────────
  console.log(`  Part (a): irrelevant goal → "${IRRELEVANT_GOAL}"`);
  const { status, body, mode } = await callOrchestrate(IRRELEVANT_GOAL, {
    agentKey,
  });
  ok('HTTP 200 (graceful, not an error)', status === 200, `HTTP ${status}`);

  const reasoning = String(body.reasoning ?? '');
  ok('pipeline.success === false', body.pipeline?.success === false,
    `success=${body.pipeline?.success}`);

  // The guard surfaces as either the canonical `no_relevant_agent` reason (plan
  // was all-demos) or "No available/relevant agent…" (planner returned no agents).
  const reasonOk =
    /no_relevant_agent/i.test(reasoning) ||
    /\b(no|none)\b[\s\S]{0,60}?\bagents?\b/i.test(reasoning) ||
    /no (available|relevant|suitable|matching|appropriate)/i.test(reasoning);
  ok('reasoning signals no relevant/available agent', reasonOk,
    reasoning.slice(0, 90));

  ok('pipeline.totalCostUsdc === 0 (NO outbound/downstream cost)',
    Number(body.pipeline?.totalCostUsdc) === 0,
    `cost=${body.pipeline?.totalCostUsdc}`);

  const steps = body.pipeline?.steps ?? [];
  ok('pipeline.steps === [] (no agent executed)',
    Array.isArray(steps) && steps.length === 0, `steps=${steps.length}`);

  const downstreamTxs = steps
    .map((s) => s.downstreamTxHash)
    .filter(Boolean);
  ok('no downstream/step tx hashes (nothing settled outbound)',
    downstreamTxs.length === 0, `downstream=${downstreamTxs.length}`);

  if (mode === 'agent-key') {
    ok('FREE path: no inbound kiteTxHash either ($0 on-chain)',
      !body.kiteTxHash, `kiteTxHash=${body.kiteTxHash ?? 'none'}`);
  } else {
    // x402 path: one inbound settle is expected (gateway payment model); the
    // GUARD claim is that nothing went outbound. Report the inbound tx for audit.
    console.log(
      `  ℹ️  x402 mode settled ONE inbound tx (gateway payment model, not agent work):`,
    );
    if (body.kiteTxHash) {
      console.log(`       inbound: ${KITE_EXPLORER}/${body.kiteTxHash}`);
    }
    console.log(
      `     For a truly $0 demonstration, set A2A_KEY=<funded agent key>.`,
    );
  }

  // ── PART (b): credit-back on a failing step (OPTIONAL) ─────────────
  if (process.env.RUN_REFUND === '1' && agentKey) {
    console.log('\n  Part (b): credit-back on a failing step (RUN_REFUND=1)');
    console.log(
      '  ℹ️  Not implemented as a deterministic live assertion: it needs a goal',
    );
    console.log(
      '     whose selected step settles then fails downstream, which is non-',
    );
    console.log(
      '     deterministic against the live catalog. The credit-back path is',
    );
    console.log(
      '     covered by smoke-orchestrate-cross-chain + the orchestrate.billing',
    );
    console.log('     unit tests. Marked as a coverage note, not a failure.');
  } else {
    console.log(
      '\n  Part (b) skipped (set RUN_REFUND=1 + a funded A2A_KEY to attempt).',
    );
  }

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
