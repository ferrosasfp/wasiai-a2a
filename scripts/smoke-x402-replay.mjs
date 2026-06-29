#!/usr/bin/env node
/**
 * Smoke — x402 INBOUND anti-replay guard (X402_REPLAY / nonce uniqueness).
 *
 * Proves the live gateway+facilitator reject a replayed EIP-3009 authorization:
 *   1. Sign ONE EIP-3009 TransferWithAuthorization (PYUSD on Kite testnet) and
 *      settle it through a paid endpoint (/orchestrate with an irrelevant goal so
 *      there is exactly ONE inbound settle and ZERO outbound spend).
 *      → assert HTTP 200 + a real inbound kiteTxHash.
 *   2. RESUBMIT the SAME authorization (same nonce, same signature) to the same
 *      endpoint.
 *      → assert HTTP 402 with a replay/duplicate-nonce reason and NO second tx.
 *
 * This exercises the M1 anti-replay layer (src/middleware/x402.ts → X402_REPLAY,
 * UNIQUE(network, nonce) in a2a_x402_nonces) on top of the on-chain EIP-3009
 * single-use nonce.
 *
 * Settlement: ONE settle total (step 1). No loops. Testnet only.
 *
 * Required env:
 *   A2A_URL    gateway base (default prod testnet)
 *   ENV_FILE   path to .env with OPERATOR_PRIVATE_KEY + X402_PAYMENT_TOKEN +
 *              X402_EIP712_DOMAIN_NAME/VERSION (default repo .env)
 *
 * Usage:
 *   node scripts/smoke-x402-replay.mjs
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
// Irrelevant goal → inbound settles once, NOTHING is spent outbound.
const GOAL = 'compose a symphony about cats';

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
  return out;
}
const env = readEnv(ENV_FILE);
if (!env.OPERATOR_PRIVATE_KEY) {
  banner('OPERATOR_PRIVATE_KEY missing in ENV_FILE');
  process.exit(1);
}
const op = privateKeyToAccount(
  '0x' + env.OPERATOR_PRIVATE_KEY.replace(/[^0-9a-fA-F]/g, '').slice(-64),
);

/** Build ONE base64 X-PAYMENT payload (fixed nonce → reusable for the replay). */
async function buildPayment(treasury, amount) {
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
  return { header: Buffer.from(JSON.stringify(payload)).toString('base64'), nonce };
}

const post = async (header) => {
  const res = await fetch(`${A2A}/orchestrate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'payment-signature': header },
    body: JSON.stringify({ goal: GOAL, budget: 0.5 }),
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
  console.log(`\n🔬 Smoke x402 anti-replay vs ${A2A}\n`);
  console.log(`  Operator: ${op.address}`);

  // 402 challenge → get treasury + amount.
  const probe = await fetch(`${A2A}/orchestrate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal: GOAL, budget: 0.5 }),
  });
  if (probe.status !== 402) {
    banner(`expected 402 challenge, got ${probe.status}`);
    process.exit(1);
  }
  const accept = (await probe.json()).accepts?.[0];
  const { header, nonce } = await buildPayment(
    accept.payTo,
    BigInt(accept.maxAmountRequired),
  );
  console.log(`  Nonce: ${nonce}\n`);

  // ── Step 1: first settle (must succeed) ───────────────────────────
  console.log('  Step 1: settle the authorization (first use)');
  const first = await post(header);
  ok('first settle → HTTP 200', first.code === 200, `HTTP ${first.code}`);
  ok('first settle produced an inbound kiteTxHash',
    typeof first.json?.kiteTxHash === 'string' && first.json.kiteTxHash.length > 0,
    first.json?.kiteTxHash ?? 'none');
  if (first.json?.kiteTxHash) {
    console.log(`     inbound tx: ${KITE_EXPLORER}/${first.json.kiteTxHash}`);
  }
  // Sanity: irrelevant goal → no outbound spend.
  ok('first settle spent nothing outbound (irrelevant goal)',
    Number(first.json?.pipeline?.totalCostUsdc) === 0,
    `outbound cost=${first.json?.pipeline?.totalCostUsdc}`);

  if (first.code !== 200) {
    banner('first settle failed — cannot test replay');
    process.exit(1);
  }

  // ── Step 2: replay the SAME nonce (must be rejected) ──────────────
  console.log('\n  Step 2: RESUBMIT the same authorization (same nonce)');
  const replay = await post(header);
  ok('replay → HTTP 402 (rejected)', replay.code === 402, `HTTP ${replay.code}`);

  const reason = String(replay.json?.error ?? '');
  ok('replay reason mentions replay / nonce-already-used',
    /replay|already used|duplicate|nonce/i.test(reason),
    reason.slice(0, 80));

  ok('replay produced NO second tx (no kiteTxHash)',
    !replay.json?.kiteTxHash,
    `kiteTxHash=${replay.json?.kiteTxHash ?? 'none'}`);

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
