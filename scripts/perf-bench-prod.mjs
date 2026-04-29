#!/usr/bin/env node
/**
 * Performance benchmark via app.wasiai.io thin-proxy — 5 runs.
 * Compares with direct Railway baseline (perf-bench-cross-chain.mjs).
 */
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const APP_URL = 'https://app.wasiai.io';
const KITE_CHAIN_ID = 2368;
const KITE_PYUSD = '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9';
const RUNS = 5;

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

async function singleRun(idx) {
  const probe = await fetch(`${APP_URL}/api/v1/compose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ steps: PIPELINE.map(p => ({ agent: p.agent, registry: p.registry, input: p.input })), maxBudget: 0.5 }),
  });
  if (probe.status !== 402) return { run: idx, status: 'probe-fail', latency: 0, costUsdc: 0, txs: 0 };
  const ch = await probe.json();
  const treasury = ch.accepts?.[0]?.payTo;
  const maxAmount = BigInt(ch.accepts?.[0]?.maxAmountRequired);
  const header = await signInbound(treasury, maxAmount);
  const t0 = Date.now();
  const res = await fetch(`${APP_URL}/api/v1/compose`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'payment-signature': header },
    body: JSON.stringify({ steps: PIPELINE.map(p => ({ agent: p.agent, registry: p.registry, input: p.input })), maxBudget: 0.5 }),
  });
  const elapsed = Date.now() - t0;
  if (res.status !== 200) return { run: idx, status: `HTTP-${res.status}`, latency: elapsed, costUsdc: 0, txs: 0 };
  const body = await res.json();
  const txs = (body.kiteTxHash ? 1 : 0) + (body.steps ?? []).filter(s => s.downstreamTxHash).length;
  return { run: idx, status: 'OK', latency: elapsed, costUsdc: body.totalCostUsdc ?? 0, txs };
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

console.log('═══════════════════════════════════════════════════════════════');
console.log(`  Performance Benchmark via app.wasiai.io — ${RUNS} runs`);
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  Pipeline: ${PIPELINE.map(s => s.agent).join(' → ')}`);
console.log();

const results = [];
for (let i = 1; i <= RUNS; i++) {
  process.stdout.write(`  Run ${i}/${RUNS}... `);
  const r = await singleRun(i);
  results.push(r);
  console.log(`${r.status} (${r.latency}ms, ${r.txs} txs, $${r.costUsdc} USDC)`);
}

const okRuns = results.filter(r => r.status === 'OK');
const lats = okRuns.map(r => r.latency);
const totalCost = okRuns.reduce((s, r) => s + r.costUsdc, 0);
const totalTxs = okRuns.reduce((s, r) => s + r.txs, 0);

console.log('\n┌─────────────────────────────────────┬──────────┐');
console.log('│ Metric                              │ Value    │');
console.log('├─────────────────────────────────────┼──────────┤');
console.log(`│ Success rate                        │ ${okRuns.length}/${RUNS} (${((okRuns.length/RUNS)*100).toFixed(0)}%)   │`);
if (okRuns.length > 0) {
  console.log(`│ Latency p50 (ms)                    │ ${percentile(lats, 50).toString().padStart(8)} │`);
  console.log(`│ Latency p95 (ms)                    │ ${percentile(lats, 95).toString().padStart(8)} │`);
  console.log(`│ Latency p99 (ms)                    │ ${percentile(lats, 99).toString().padStart(8)} │`);
  console.log(`│ Latency min (ms)                    │ ${Math.min(...lats).toString().padStart(8)} │`);
  console.log(`│ Latency max (ms)                    │ ${Math.max(...lats).toString().padStart(8)} │`);
  console.log(`│ Avg latency (ms)                    │ ${(lats.reduce((s,l)=>s+l,0)/lats.length).toFixed(0).padStart(8)} │`);
  console.log(`│ Total USDC moved                    │ $${totalCost.toFixed(3).padStart(7)} │`);
  console.log(`│ Total on-chain txs                  │ ${totalTxs.toString().padStart(8)} │`);
  console.log(`│ Avg txs per run                     │ ${(totalTxs/okRuns.length).toFixed(1).padStart(8)} │`);
}
console.log('└─────────────────────────────────────┴──────────┘');
