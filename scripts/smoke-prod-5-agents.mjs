#!/usr/bin/env node
/**
 * Smoke 5-agent pipeline cap vía app.wasiai.io thin-proxy.
 * Validates timeout 180s + parallel handling + proxy stability under cap.
 */
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const APP_URL = 'https://app.wasiai.io';
const KITE_CHAIN_ID = 2368;
const KITE_PYUSD = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9';
const KITE_EXPLORER = 'https://testnet.kitescan.ai/tx';
const FUJI_EXPLORER = 'https://testnet.snowtrace.io/tx';

const PIPELINE = [
  { agent: 'wasi-chainlink-price', input: { token: 'AVAX' }, registry: 'wasiai' },
  { agent: 'wasi-chainlink-price', input: { token: 'USDC' }, registry: 'wasiai' },
  { agent: 'wasi-defi-sentiment',  input: { token: 'AVAX' }, registry: 'wasiai' },
  { agent: 'wasi-wallet-profiler', input: { wallet: '0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba' }, registry: 'wasiai' },
  { agent: 'wasi-liquidity-analyzer', input: { token: 'USDC' }, registry: 'wasiai' },
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
    domain: { name: env.X402_EIP712_DOMAIN_NAME ?? 'PYUSD', version: env.X402_EIP712_DOMAIN_VERSION ?? '1', chainId: KITE_CHAIN_ID, verifyingContract: KITE_PYUSD },
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
console.log('  Smoke 5-AGENT cap vía app.wasiai.io thin-proxy');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  Pipeline: ${PIPELINE.map(s => s.agent).join(' → ')}`);
console.log();

const probe = await fetch(`${APP_URL}/api/v1/compose`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ steps: PIPELINE.map(p => ({ agent: p.agent, registry: p.registry, input: p.input })), maxBudget: 1.0 }),
});
if (probe.status !== 402) { console.error(`Expected 402, got ${probe.status}`); process.exit(1); }
const ch = await probe.json();
const treasury = ch.accepts?.[0]?.payTo;
const maxAmount = BigInt(ch.accepts?.[0]?.maxAmountRequired);
console.log(`  402 challenge: maxAmount=${maxAmount} (PYUSD wei)`);

const header = await signInbound(treasury, maxAmount);
console.log('\n▶ POST /api/v1/compose with 5 steps...');
const startedAt = Date.now();
const res = await fetch(`${APP_URL}/api/v1/compose`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'payment-signature': header },
  body: JSON.stringify({ steps: PIPELINE.map(p => ({ agent: p.agent, registry: p.registry, input: p.input })), maxBudget: 1.0 }),
});
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
const text = await res.text();
let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
console.log(`  HTTP ${res.status} (${elapsed}s)`);

if (res.status !== 200) {
  console.log(JSON.stringify(body, null, 2).slice(0, 1500));
  process.exit(1);
}

console.log(`\n✅ /compose 5-agent OK via app.wasiai.io`);
console.log(`  Kite inbound: ${body.kiteTxHash ?? '(none)'}`);
if (body.kiteTxHash) console.log(`    ${KITE_EXPLORER}/${body.kiteTxHash}`);
console.log(`  Total cost: ${body.totalCostUsdc} USDC`);
console.log(`  Total latency: ${body.totalLatencyMs}ms`);
const downstreamTxs = [];
for (let i = 0; i < (body.steps?.length ?? 0); i++) {
  const s = body.steps[i];
  console.log(`    [${i+1}/${body.steps.length}] ${s.agent.slug} — cost=${s.costUsdc} latency=${s.latencyMs}ms`);
  if (s.downstreamTxHash) {
    downstreamTxs.push(s.downstreamTxHash);
    console.log(`        ✓ Fuji: ${FUJI_EXPLORER}/${s.downstreamTxHash}`);
  }
}
console.log(`\n  TOTAL: ${(body.kiteTxHash ? 1 : 0) + downstreamTxs.length} on-chain txs (1 Kite + ${downstreamTxs.length} Fuji)`);
