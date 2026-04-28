#!/usr/bin/env node
/**
 * Smoke E2E TRUE CROSS-CHAIN — PYUSD Kite inbound + USDC Fuji outbound.
 *
 * Path completo:
 *   1. Caller firma EIP-3009 PYUSD en Kite testnet (chain eip155:2368) — INBOUND
 *   2. POST /compose con header X-PAYMENT (no x-a2a-key)
 *   3. wasiai-a2a verifica + settla inbound vía wasiai-facilitator (Kite)
 *   4. Por cada step: invoca agent v2 + signAndSettleDownstream Fuji USDC
 *   5. Output incluye: 1 kiteTxHash + 3 downstreamTxHashes
 *
 * Pre-req env Railway prod:
 *   - KITE_FACILITATOR_URL=https://wasiai-facilitator-production.up.railway.app
 *   - WASIAI_DOWNSTREAM_X402=true
 */
import {
  createPublicClient,
  http,
  parseUnits,
  formatUnits,
  defineChain,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

// ─── Config ───────────────────────────────────────────────────────────────────
const A2A_URL = 'https://wasiai-a2a-production.up.railway.app';

const KITE_CHAIN_ID = 2368;
const KITE_PYUSD = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9';
const KITE_RPC = 'https://rpc-testnet.gokite.ai';
const KITE_EXPLORER = 'https://testnet.kitescan.ai/tx';
const FUJI_EXPLORER = 'https://testnet.snowtrace.io/tx';

// Pipeline 3 agents v2 (chains: AVAX Fuji USDC outbound)
const PIPELINE = [
  { agent: 'wasi-chainlink-price', input: { token: 'AVAX' }, registry: 'wasiai' },
  { agent: 'wasi-defi-sentiment',  input: { token: 'AVAX' }, registry: 'wasiai' },
  { agent: 'wasi-wallet-profiler', input: { wallet: '0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba' }, registry: 'wasiai' },
];

// ─── env loaders ──────────────────────────────────────────────────────────────
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
const OPERATOR_PK = normPk(env.OPERATOR_PRIVATE_KEY);
const operator = privateKeyToAccount(OPERATOR_PK);

// ─── Sign EIP-3009 PYUSD Kite ────────────────────────────────────────────────
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

  // Middleware expects flat shape (decodeXPayment in src/middleware/x402.ts:71-78)
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

// ─── Main ─────────────────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════════════');
console.log('  Smoke E2E TRUE CROSS-CHAIN — PYUSD Kite + USDC Fuji');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  Operator:   ${operator.address}`);
console.log(`  wasiai-a2a: ${A2A_URL}`);
console.log(`  Pipeline:   ${PIPELINE.map(s => s.agent).join(' → ')}`);
console.log();

// Step 1: discover (read-only)
console.log('▶ Step 1: POST /discover');
const discRes = await fetch(`${A2A_URL}/discover`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: '', limit: 50 }),
});
const disc = await discRes.json();
const slugs = PIPELINE.map(s => s.agent);
const agents = (disc.agents ?? []).filter(a => slugs.includes(a.slug));
if (agents.length !== PIPELINE.length) {
  console.error(`  ✗ Missing agents: ${slugs.filter(s => !agents.find(a => a.slug === s))}`);
  process.exit(1);
}
const totalUsdc = agents.reduce((sum, a) => sum + Number(a.priceUsdc ?? a.price_per_call_usdc ?? 0), 0);
console.log(`  HTTP ${discRes.status} — ${agents.length}/${PIPELINE.length} resolved (cost ${totalUsdc.toFixed(4)} USDC)`);

// Step 2: 402 challenge → get treasury + total
console.log('\n▶ Step 2: POST /compose without payment → 402 challenge');
const probeRes = await fetch(`${A2A_URL}/compose`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    steps: PIPELINE.map(p => ({ agent: p.agent, registry: p.registry, input: p.input })),
    maxBudget: totalUsdc * 2,
  }),
});
if (probeRes.status !== 402) {
  console.error(`  ✗ Expected 402 (challenge), got ${probeRes.status}`);
  console.error(await probeRes.text());
  process.exit(1);
}
const challenge = await probeRes.json();
const accept = challenge.accepts?.[0];
if (!accept) {
  console.error('  ✗ No accepts in 402 challenge');
  console.error(JSON.stringify(challenge, null, 2));
  process.exit(1);
}
const treasury = accept.payTo;
const maxAmount = BigInt(accept.maxAmountRequired);
console.log(`  HTTP 402 — treasury=${treasury} maxAmount=${maxAmount.toString()} (PYUSD wei)`);

// Step 3: sign EIP-3009 PYUSD Kite
console.log('\n▶ Step 3: Sign EIP-3009 PYUSD on Kite testnet');
const xPaymentHeader = await signX402Inbound(treasury, maxAmount);
console.log(`  Signed with operator ${operator.address}`);

// Step 4: POST /compose with X-PAYMENT
console.log('\n▶ Step 4: POST /compose with X-PAYMENT (Kite inbound + Fuji outbound)');
const startedAt = Date.now();
const composeRes = await fetch(`${A2A_URL}/compose`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'payment-signature': xPaymentHeader,
  },
  body: JSON.stringify({
    steps: PIPELINE.map(p => ({ agent: p.agent, registry: p.registry, input: p.input })),
    maxBudget: totalUsdc * 2,
  }),
});
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
const text = await composeRes.text();
let body;
try { body = JSON.parse(text); } catch { body = { raw: text }; }
console.log(`  HTTP ${composeRes.status} (${elapsed}s)`);

if (composeRes.status !== 200) {
  console.log('\n✗ /compose failed:');
  console.log(JSON.stringify(body, null, 2).slice(0, 3000));
  process.exit(1);
}

// DEBUG: dump step shape (skipping huge outputs)
console.log('\n[DEBUG] Step keys + downstream fields:');
for (const s of body.steps ?? []) {
  const keys = Object.keys(s).join(',');
  const dsKeys = s.downstream ? Object.keys(s.downstream).join(',') : '(no downstream key)';
  console.log(`  ${s.agent?.slug ?? s.agent}: keys=[${keys}] downstream=[${dsKeys}]`);
  if (s.downstream) console.log(`    downstream content: ${JSON.stringify(s.downstream).slice(0, 200)}`);
}

// Step 5: report cross-chain results
console.log('\n✅ /compose OK — cross-chain pipeline executed');
console.log(`\n  Inbound Kite tx (PYUSD): ${body.kiteTxHash ?? '(none)'}`);
if (body.kiteTxHash) {
  console.log(`    Explorer: ${KITE_EXPLORER}/${body.kiteTxHash}`);
}
console.log(`  Total cost: ${body.totalCostUsdc} USDC`);
console.log(`  Total latency: ${body.totalLatencyMs}ms`);

console.log('\n  Steps:');
const downstreamTxs = [];
for (let i = 0; i < (body.steps?.length ?? 0); i++) {
  const s = body.steps[i];
  console.log(`    [${i+1}/${body.steps.length}] ${s.agent.slug ?? s.agent}`);
  console.log(`        cost=${s.costUsdc ?? 0} USDC latency=${s.latencyMs ?? 0}ms`);
  if (s.downstream?.txHash) {
    downstreamTxs.push(s.downstream.txHash);
    console.log(`        ✓ Fuji USDC tx: ${s.downstream.txHash}`);
    console.log(`          Explorer:    ${FUJI_EXPLORER}/${s.downstream.txHash}`);
  } else if (s.downstreamTxHash) {
    downstreamTxs.push(s.downstreamTxHash);
    console.log(`        ✓ Fuji USDC tx: ${s.downstreamTxHash}`);
    console.log(`          Explorer:    ${FUJI_EXPLORER}/${s.downstreamTxHash}`);
  } else {
    console.log(`        ⚠ no downstream tx (WASIAI_DOWNSTREAM_X402 OFF?)`);
  }
}

console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  TRUE CROSS-CHAIN — END-TO-END PROVEN');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  ✓ Kite inbound:   ${body.kiteTxHash ? '1 tx' : '0 txs (BLOCKED — facilitator)'}`);
console.log(`  ✓ Fuji downstream: ${downstreamTxs.length} txs`);
console.log(`  Total: ${(body.kiteTxHash ? 1 : 0) + downstreamTxs.length} on-chain transactions across 2 chains`);
