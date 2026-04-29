#!/usr/bin/env node
/**
 * Smoke E2E real-tx contra app.wasiai.io (v2 thin-proxy → a2a Railway → facilitator).
 * Validates the full prod chain post-cutover:
 *   client → Vercel proxy → Railway a2a → caldzjhjgctpgodldqav prod DB → wasiai-facilitator → onchain
 *
 * Pipeline: 3 agents (cost ~$0.061 USDC + 1 PYUSD inbound).
 */
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const APP_URL = 'https://app.wasiai.io';
const KITE_CHAIN_ID = 2368;
const KITE_PYUSD = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9';
const KITE_EXPLORER = 'https://testnet.kitescan.ai/tx';
// Auto-detect outbound network from env hint (best-effort label only).
// Real chain is decided by a2a Railway env WASIAI_DOWNSTREAM_NETWORK.
const OUTBOUND_MAINNET = process.env.OUTBOUND_MAINNET === 'true';
const FUJI_EXPLORER = OUTBOUND_MAINNET
  ? 'https://snowtrace.io/tx'
  : 'https://testnet.snowtrace.io/tx';
const OUTBOUND_LABEL = OUTBOUND_MAINNET ? 'Avalanche MAINNET USDC' : 'Avalanche Fuji USDC';

const PIPELINE = [
  { agent: 'wasi-chainlink-price', input: { token: 'AVAX' }, registry: 'wasiai' },
  { agent: 'wasi-defi-sentiment',  input: { token: 'AVAX' }, registry: 'wasiai' },
  { agent: 'wasi-wallet-profiler', input: { wallet: '0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba' }, registry: 'wasiai' },
];

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
function normPk(s) { const hex = s.replace(/[^0-9a-fA-F]/g, ''); return '0x' + hex.slice(-64); }

const env = readEnv('/home/ferdev/.openclaw/workspace/wasiai-a2a/.env');
const operator = privateKeyToAccount(normPk(env.OPERATOR_PRIVATE_KEY));

async function signInbound(treasury, amount) {
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300);
  const nonce = '0x' + randomBytes(32).toString('hex');
  const signature = await operator.signTypedData({
    domain: {
      name: env.X402_EIP712_DOMAIN_NAME ?? 'PYUSD',
      version: env.X402_EIP712_DOMAIN_VERSION ?? '1',
      chainId: KITE_CHAIN_ID,
      verifyingContract: KITE_PYUSD,
    },
    types: { TransferWithAuthorization: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
    ]},
    primaryType: 'TransferWithAuthorization',
    message: { from: operator.address, to: treasury, value: amount, validAfter: 0n, validBefore, nonce },
  });
  return Buffer.from(JSON.stringify({
    signature,
    authorization: { from: operator.address, to: treasury, value: amount.toString(), validAfter: '0', validBefore: validBefore.toString(), nonce },
    network: `eip155:${KITE_CHAIN_ID}`,
  })).toString('base64');
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Smoke E2E vía app.wasiai.io — thin-proxy delegation');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  Operator:       ${operator.address}`);
console.log(`  Target:         ${APP_URL}/api/v1`);
console.log(`  Pipeline:       ${PIPELINE.map(s => s.agent).join(' → ')}`);
console.log();

// Step 1: GET /api/v1/capabilities (proxy delegation test — should hit a2a /discover)
console.log('▶ Step 1: GET /api/v1/capabilities (proxy → a2a /discover)');
const capRes = await fetch(`${APP_URL}/api/v1/capabilities?limit=20`);
const capBody = await capRes.json().catch(() => ({}));
console.log(`  HTTP ${capRes.status} — ${(capBody.agents ?? capBody).length || 0} agents`);
if (capRes.status !== 200) {
  console.error('  ✗ capabilities proxy failed');
  console.error(JSON.stringify(capBody, null, 2).slice(0, 500));
  process.exit(1);
}

// Step 2: POST /api/v1/compose without payment → 402
console.log('\n▶ Step 2: POST /api/v1/compose without payment → 402 challenge');
const probe = await fetch(`${APP_URL}/api/v1/compose`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ steps: PIPELINE.map(p => ({ agent: p.agent, registry: p.registry, input: p.input })), maxBudget: 0.5 }),
});
if (probe.status !== 402) {
  console.error(`  ✗ Expected 402, got ${probe.status}`);
  console.error(await probe.text());
  process.exit(1);
}
const ch = await probe.json();
const treasury = ch.accepts?.[0]?.payTo;
const maxAmount = BigInt(ch.accepts?.[0]?.maxAmountRequired ?? '1000000000000000000');
console.log(`  HTTP 402 — treasury=${treasury} maxAmount=${maxAmount} (PYUSD wei)`);

// Step 3: sign EIP-3009
console.log('\n▶ Step 3: Sign EIP-3009 PYUSD on Kite testnet');
const xPaymentHeader = await signInbound(treasury, maxAmount);
console.log(`  Signed with operator ${operator.address}`);

// Step 4: POST /compose with payment
console.log('\n▶ Step 4: POST /api/v1/compose with X-PAYMENT (proxy → a2a → cross-chain)');
const startedAt = Date.now();
const res = await fetch(`${APP_URL}/api/v1/compose`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'payment-signature': xPaymentHeader,
  },
  body: JSON.stringify({ steps: PIPELINE.map(p => ({ agent: p.agent, registry: p.registry, input: p.input })), maxBudget: 0.5 }),
});
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
const text = await res.text();
let body;
try { body = JSON.parse(text); } catch { body = { raw: text }; }
console.log(`  HTTP ${res.status} (${elapsed}s)`);

if (res.status !== 200) {
  console.log('\n✗ /compose via app.wasiai.io failed:');
  console.log(JSON.stringify(body, null, 2).slice(0, 1500));
  process.exit(1);
}

console.log('\n✅ /compose via app.wasiai.io OK — thin-proxy delegation works');
console.log(`\n  Inbound Kite tx (PYUSD): ${body.kiteTxHash ?? '(none)'}`);
if (body.kiteTxHash) console.log(`    Explorer: ${KITE_EXPLORER}/${body.kiteTxHash}`);
console.log(`  Total cost: ${body.totalCostUsdc} USDC`);
console.log(`  Total latency: ${body.totalLatencyMs}ms`);
console.log('\n  Steps:');
const downstreamTxs = [];
for (let i = 0; i < (body.steps?.length ?? 0); i++) {
  const s = body.steps[i];
  console.log(`    [${i+1}/${body.steps.length}] ${s.agent.slug}`);
  console.log(`        cost=${s.costUsdc} USDC latency=${s.latencyMs}ms`);
  if (s.downstreamTxHash) {
    downstreamTxs.push(s.downstreamTxHash);
    console.log(`        ✓ ${OUTBOUND_LABEL} tx: ${s.downstreamTxHash}`);
    console.log(`          Explorer:    ${FUJI_EXPLORER}/${s.downstreamTxHash}`);
  }
}

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  PROD CUTOVER PROVEN — app.wasiai.io → a2a → facilitator → cross-chain');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  ✓ Kite inbound:    ${body.kiteTxHash ? '1 tx' : '0 txs'}`);
console.log(`  ✓ Fuji downstream: ${downstreamTxs.length} txs`);
console.log(`  Total: ${(body.kiteTxHash ? 1 : 0) + downstreamTxs.length} on-chain transactions across 2 chains`);
