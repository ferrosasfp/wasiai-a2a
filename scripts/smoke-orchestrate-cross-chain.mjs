#!/usr/bin/env node
/**
 * Smoke E2E /orchestrate cross-chain — LLM planner end-to-end.
 *
 * Path:
 *   1. Caller firma EIP-3009 PYUSD en Kite testnet (inbound)
 *   2. POST /orchestrate con goal natural language + budget
 *   3. wasiai-a2a:
 *      - settla inbound vía wasiai-facilitator (Kite)
 *      - LLM (Claude) selecciona agentes via /discover
 *      - Genera pipeline + ejecuta /compose internamente
 *      - Cada step: invoca v2 + signAndSettleDownstream Fuji USDC
 *   4. Output: pipeline + plan + outputs + tx hashes
 */
import {
  defineChain,
  createPublicClient,
  http,
  parseUnits,
  formatUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const A2A_URL = 'https://wasiai-a2a-production.up.railway.app';
const KITE_CHAIN_ID = 2368;
const KITE_PYUSD = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9';
const KITE_EXPLORER = 'https://testnet.kitescan.ai/tx';
const FUJI_EXPLORER = 'https://testnet.snowtrace.io/tx';

// Goal natural — el LLM debe elegir agentes y orden
const GOAL = 'Get the current AVAX price and DeFi market sentiment';
const BUDGET_USDC = 0.5; // $0.50 USDC budget

function readEnv(p) {
  const out = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
function normPk(s) {
  const hex = s.replace(/[^0-9a-fA-F]/g, '');
  return '0x' + hex.slice(-64);
}

const env = readEnv('/home/ferdev/.openclaw/workspace/wasiai-a2a/.env');
const operator = privateKeyToAccount(normPk(env.OPERATOR_PRIVATE_KEY));

async function signX402Inbound(treasuryAddress, totalAmount) {
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300);
  const nonce = '0x' + randomBytes(32).toString('hex');
  const signature = await operator.signTypedData({
    domain: {
      name: env.X402_EIP712_DOMAIN_NAME ?? 'PYUSD',
      version: env.X402_EIP712_DOMAIN_VERSION ?? '1',
      chainId: KITE_CHAIN_ID,
      verifyingContract: KITE_PYUSD,
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
      from: operator.address,
      to: treasuryAddress,
      value: totalAmount,
      validAfter: 0n,
      validBefore,
      nonce,
    },
  });
  const payload = {
    signature,
    authorization: {
      from: operator.address,
      to: treasuryAddress,
      value: totalAmount.toString(),
      validAfter: '0',
      validBefore: validBefore.toString(),
      nonce,
    },
    network: `eip155:${KITE_CHAIN_ID}`,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Smoke E2E /orchestrate — LLM planner cross-chain');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  Operator: ${operator.address}`);
console.log(`  Goal:     "${GOAL}"`);
console.log(`  Budget:   $${BUDGET_USDC} USDC`);
console.log();

// Step 1: 402 challenge
console.log('▶ Step 1: POST /orchestrate without payment → 402 challenge');
const probe = await fetch(`${A2A_URL}/orchestrate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ goal: GOAL, budget: BUDGET_USDC }),
});
if (probe.status !== 402) {
  console.error(`  ✗ Expected 402, got ${probe.status}`);
  console.error(await probe.text());
  process.exit(1);
}
const challenge = await probe.json();
const accept = challenge.accepts?.[0];
const treasury = accept.payTo;
const maxAmount = BigInt(accept.maxAmountRequired);
console.log(`  HTTP 402 — treasury=${treasury} maxAmount=${maxAmount} (PYUSD wei)`);

// Step 2: sign + invoke
console.log('\n▶ Step 2: Sign + POST /orchestrate with X-PAYMENT');
const xPaymentHeader = await signX402Inbound(treasury, maxAmount);
const startedAt = Date.now();
const res = await fetch(`${A2A_URL}/orchestrate`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'payment-signature': xPaymentHeader,
  },
  body: JSON.stringify({ goal: GOAL, budget: BUDGET_USDC }),
});
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
const text = await res.text();
let body;
try { body = JSON.parse(text); } catch { body = { raw: text }; }
console.log(`  HTTP ${res.status} (${elapsed}s)`);

if (res.status !== 200) {
  console.log('\n✗ /orchestrate failed:');
  console.log(JSON.stringify(body, null, 2).slice(0, 2000));
  process.exit(1);
}

console.log('\n✅ /orchestrate OK');
console.log(`\n  Inbound Kite tx: ${body.kiteTxHash ?? '(none)'}`);
if (body.kiteTxHash) console.log(`    ${KITE_EXPLORER}/${body.kiteTxHash}`);

console.log(`  Plan: ${body.plan ? JSON.stringify(body.plan).slice(0, 200) : '(none)'}`);
console.log(`  Pipeline success: ${body.pipeline?.success ?? '?'}`);
console.log(`  Total cost: ${body.pipeline?.totalCostUsdc ?? '?'} USDC`);
console.log(`  Total latency: ${body.pipeline?.totalLatencyMs ?? '?'}ms`);

console.log('\n  Steps:');
const downstreamTxs = [];
for (const s of body.pipeline?.steps ?? []) {
  const slug = s.agent?.slug ?? s.agent ?? '?';
  console.log(`    - ${slug}: cost=${s.costUsdc} USDC latency=${s.latencyMs}ms`);
  if (s.downstreamTxHash) {
    downstreamTxs.push(s.downstreamTxHash);
    console.log(`      ✓ Fuji USDC tx: ${s.downstreamTxHash}`);
    console.log(`        ${FUJI_EXPLORER}/${s.downstreamTxHash}`);
  }
}

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  /orchestrate cross-chain — RESULT');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  ✓ Kite inbound:   ${body.kiteTxHash ? '1 tx' : '0 txs'}`);
console.log(`  ✓ Fuji downstream: ${downstreamTxs.length} txs`);
console.log(`  Total: ${(body.kiteTxHash ? 1 : 0) + downstreamTxs.length} on-chain transactions`);
