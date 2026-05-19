#!/usr/bin/env node
/**
 * Smoke E2E real-tx contra Base Sepolia (chainId 84532) — WKH-107 / BASE-04.
 *
 * Flow (x402 v2 canonical):
 *   1. Pre-flight: verify operator wallet has enough USDC sepolia (AC-6).
 *   2. POST /compose without payment → expect HTTP 402 challenge with accepts[0].payTo.
 *   3. Sign EIP-3009 TransferWithAuthorization against USDC sepolia
 *      (0x036CbD53842c5426634e7929541eC2318f3dCF7e), EIP-712 domain
 *      { name: 'USDC', version: '2', chainId: 84532 } — VERIFIED ONCHAIN BY WKH-105.
 *   4. POST /compose again with base64 `payment-signature` header + `x-payment-chain: base-sepolia`.
 *   5. Capture tx hash from response body (top-level or per-step downstreamTxHash)
 *      and print Basescan link for manual verification (CD-4 — no API calls).
 *
 * Exit codes: 0 success | 1 insufficient balance / HTTP failure / no tx hash.
 *
 * Required env (read from wasiai-a2a/.env or process env):
 *   OPERATOR_PRIVATE_KEY     — client signer wallet PK (e.g. 0xf432...9eD)
 * Optional env (defaults shown):
 *   BASE_SMOKE_PRIVATE_KEY   — overrides OPERATOR_PRIVATE_KEY (DT-5 of WKH-107)
 *   BASE_SMOKE_GATEWAY_URL   — gateway base URL (default: http://localhost:3001)
 *   BASE_SMOKE_AMOUNT_USDC   — amount to settle in USDC (default: 0.001)
 *   BASE_SMOKE_AGENT_SLUG    — pipeline agent slug (default: wasi-chainlink-price)
 *   BASE_SMOKE_AGENT_REGISTRY — registry name (default: wasiai)
 *   BASE_SEPOLIA_RPC_URL     — Base Sepolia RPC (default: https://sepolia.base.org)
 */

import {
  createPublicClient,
  http,
  defineChain,
  parseUnits,
  formatUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

// ──────────────────────────────────────────────────────────────────────────────
// Constants (NOT hardcodes — these are canonical onchain identifiers verified
// by WKH-105 and pinned in src/adapters/base/payment.ts)
// ──────────────────────────────────────────────────────────────────────────────
const BASE_SEPOLIA_CHAIN_ID = 84532;
const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const BASE_SEPOLIA_NETWORK_TAG = `eip155:${BASE_SEPOLIA_CHAIN_ID}`;
const BASE_SEPOLIA_CHAIN_SLUG = 'base-sepolia';
const USDC_EIP712_NAME = 'USDC'; // sepolia, NOT 'USD Coin'
const USDC_EIP712_VERSION = '2';
const USDC_DECIMALS = 6;
const BASESCAN_TX_BASE = 'https://sepolia.basescan.org/tx';
const ENV_FILE = '/home/ferdev/.openclaw/workspace/wasiai-a2a/.env';

// ──────────────────────────────────────────────────────────────────────────────
// Env loading (mirror of smoke-prod-via-app-wasiai.mjs)
// ──────────────────────────────────────────────────────────────────────────────
function readEnvFile(p) {
  const out = {};
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function normPk(s) {
  if (!s || typeof s !== 'string') return null;
  const hex = s.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length < 64) return null;
  return '0x' + hex.slice(-64);
}

const fileEnv = readEnvFile(ENV_FILE);
function envVar(name) {
  return process.env[name] ?? fileEnv[name];
}

// ──────────────────────────────────────────────────────────────────────────────
// Configuration resolution (all env-driven — CD-1, CD-7 of WKH-107)
// ──────────────────────────────────────────────────────────────────────────────
const rawPk = envVar('BASE_SMOKE_PRIVATE_KEY') ?? envVar('OPERATOR_PRIVATE_KEY');
const OPERATOR_PK = normPk(rawPk);
if (!OPERATOR_PK) {
  console.error(
    '✗ ERROR: BASE_SMOKE_PRIVATE_KEY or OPERATOR_PRIVATE_KEY must be set ' +
      `(checked process.env and ${ENV_FILE}).`,
  );
  process.exit(1);
}

const GATEWAY_URL = (envVar('BASE_SMOKE_GATEWAY_URL') ?? 'http://localhost:3001')
  .replace(/\/+$/, '');
const AMOUNT_USDC_STR = envVar('BASE_SMOKE_AMOUNT_USDC') ?? '0.001';
const AGENT_SLUG = envVar('BASE_SMOKE_AGENT_SLUG') ?? 'wasi-chainlink-price';
const AGENT_REGISTRY = envVar('BASE_SMOKE_AGENT_REGISTRY') ?? 'wasiai';
const RPC_URL = envVar('BASE_SEPOLIA_RPC_URL') ?? 'https://sepolia.base.org';

let amount;
try {
  amount = parseUnits(AMOUNT_USDC_STR, USDC_DECIMALS);
} catch (e) {
  console.error(`✗ ERROR: invalid BASE_SMOKE_AMOUNT_USDC="${AMOUNT_USDC_STR}": ${e.message}`);
  process.exit(1);
}
if (amount <= 0n) {
  console.error(`✗ ERROR: BASE_SMOKE_AMOUNT_USDC must be > 0 (got "${AMOUNT_USDC_STR}")`);
  process.exit(1);
}

const operator = privateKeyToAccount(OPERATOR_PK);
const FACILITATOR_ADDRESS_HINT = '0x9c0638506F8C5fc44F0d8C7b9E9e267eA311BB5c'; // display only — pays gas

// ──────────────────────────────────────────────────────────────────────────────
// Viem RPC client
// ──────────────────────────────────────────────────────────────────────────────
const baseSepolia = defineChain({
  id: BASE_SEPOLIA_CHAIN_ID,
  name: 'Base Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const rpc = createPublicClient({ chain: baseSepolia, transport: http() });

const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
];

function shortAddr(a) {
  if (!a) return '(none)';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Banner
// ──────────────────────────────────────────────────────────────────────────────
console.log('🟦 Base Sepolia smoke — wasiai-a2a');
console.log(`   Gateway:      ${GATEWAY_URL}`);
console.log(`   Chain:        ${BASE_SEPOLIA_CHAIN_SLUG} (${BASE_SEPOLIA_CHAIN_ID})`);
console.log(`   RPC:          ${RPC_URL}`);
console.log(`   Client:       ${operator.address}`);
console.log(`   Amount:       ${AMOUNT_USDC_STR} USDC (${amount} micro)`);
console.log(`   Agent:        ${AGENT_REGISTRY}/${AGENT_SLUG}`);
console.log();

// ──────────────────────────────────────────────────────────────────────────────
// Step 1: pre-flight balance check (AC-6)
// ──────────────────────────────────────────────────────────────────────────────
console.log('[1/5] Pre-flight balance check…');
let usdcBalance;
try {
  usdcBalance = await rpc.readContract({
    address: BASE_SEPOLIA_USDC,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [operator.address],
  });
} catch (e) {
  console.error(`   ✗ RPC call balanceOf failed: ${e.message}`);
  console.error(`     Check BASE_SEPOLIA_RPC_URL (${RPC_URL}) — RPC may be down or rate-limited.`);
  process.exit(1);
}
console.log(`   USDC balance: ${formatUnits(usdcBalance, USDC_DECIMALS)} USDC (need ${AMOUNT_USDC_STR})`);
if (usdcBalance < amount) {
  console.error(
    `   ✗ INSUFFICIENT_BALANCE: client wallet ${operator.address} has ` +
      `${formatUnits(usdcBalance, USDC_DECIMALS)} USDC sepolia but needs ${AMOUNT_USDC_STR}.\n` +
      `     Fund the wallet via https://faucet.circle.com (select Base Sepolia).`,
  );
  process.exit(1);
}
console.log(`   ✓ Sufficient USDC.`);

// Best-effort ETH check on the facilitator (informational only — facilitator runs in cloud).
try {
  const facEth = await rpc.getBalance({ address: FACILITATOR_ADDRESS_HINT });
  console.log(
    `   Facilitator ETH (${shortAddr(FACILITATOR_ADDRESS_HINT)}): ` +
      `${formatUnits(facEth, 18)} ETH (informational)`,
  );
} catch {
  console.log('   (facilitator ETH check skipped — RPC error, not fatal)');
}
console.log();

// ──────────────────────────────────────────────────────────────────────────────
// Step 2: initial /compose request → expect 402
// ──────────────────────────────────────────────────────────────────────────────
console.log('[2/5] POST /compose (initial, expecting 402)…');
const composeBody = {
  steps: [
    { agent: AGENT_SLUG, registry: AGENT_REGISTRY, input: { token: 'ETH' } },
  ],
  maxBudget: Math.max(0.5, Number(AMOUNT_USDC_STR) * 10),
};

let probeRes, probeBody;
try {
  probeRes = await fetch(`${GATEWAY_URL}/compose`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-payment-chain': BASE_SEPOLIA_CHAIN_SLUG,
    },
    body: JSON.stringify(composeBody),
  });
} catch (e) {
  console.error(`   ✗ Network error talking to gateway ${GATEWAY_URL}: ${e.message}`);
  console.error('     Is the gateway running? (npm run dev — listens on :3001)');
  process.exit(1);
}

const probeText = await probeRes.text();
try {
  probeBody = JSON.parse(probeText);
} catch {
  probeBody = { raw: probeText };
}

if (probeRes.status !== 402) {
  console.error(`   ✗ Expected HTTP 402, got ${probeRes.status}`);
  console.error(`     Body: ${probeText.slice(0, 600)}`);
  process.exit(1);
}

const accept = Array.isArray(probeBody.accepts) ? probeBody.accepts[0] : undefined;
const payTo = accept?.payTo;
const scheme = accept?.scheme ?? '(unknown)';
const network = accept?.network ?? '(unknown)';
const maxAmountRequiredStr = accept?.maxAmountRequired;

if (!payTo || typeof payTo !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
  console.error(`   ✗ 402 response missing accepts[0].payTo (got: ${payTo})`);
  console.error(`     Full body: ${JSON.stringify(probeBody, null, 2).slice(0, 800)}`);
  process.exit(1);
}

console.log(`   ← HTTP 402 (expected)`);
console.log(`     scheme:  ${scheme}`);
console.log(`     network: ${network}`);
console.log(`     payTo:   ${payTo}`);
if (maxAmountRequiredStr) {
  console.log(`     maxAmountRequired: ${maxAmountRequiredStr}`);
}

// If gateway advertises a maxAmountRequired larger than what we want to pay,
// honor the gateway (otherwise settle will fail). Same pattern as exemplar.
const requestedAmount = maxAmountRequiredStr
  ? BigInt(maxAmountRequiredStr)
  : amount;
if (requestedAmount > amount) {
  console.log(
    `   ⚠ Gateway requires ${requestedAmount} micro-USDC > requested ${amount}. ` +
      `Will sign for ${requestedAmount} to satisfy facilitator.`,
  );
}
const valueToSign = requestedAmount > amount ? requestedAmount : amount;

// Re-check balance covers the actual amount that will be signed.
if (usdcBalance < valueToSign) {
  console.error(
    `   ✗ INSUFFICIENT_BALANCE for gateway-required amount: have ` +
      `${formatUnits(usdcBalance, USDC_DECIMALS)} USDC, need ` +
      `${formatUnits(valueToSign, USDC_DECIMALS)} USDC.`,
  );
  process.exit(1);
}
console.log();

// ──────────────────────────────────────────────────────────────────────────────
// Step 3: sign EIP-3009 TransferWithAuthorization
// ──────────────────────────────────────────────────────────────────────────────
console.log('[3/5] Sign EIP-3009 transferWithAuthorization…');
const validAfter = 0n;
const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300); // +5 min
const nonceHex = '0x' + randomBytes(32).toString('hex');

console.log(`     from:    ${operator.address}`);
console.log(`     to:      ${payTo}`);
console.log(`     value:   ${valueToSign} (${formatUnits(valueToSign, USDC_DECIMALS)} USDC)`);
console.log(`     nonce:   ${nonceHex.slice(0, 12)}…${nonceHex.slice(-8)}`);
console.log(`     chainId: ${BASE_SEPOLIA_CHAIN_ID}`);
console.log(`     domain:  { name='${USDC_EIP712_NAME}', version='${USDC_EIP712_VERSION}' }`);

let signature;
try {
  signature = await operator.signTypedData({
    domain: {
      name: USDC_EIP712_NAME,
      version: USDC_EIP712_VERSION,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      verifyingContract: BASE_SEPOLIA_USDC,
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
      to: payTo,
      value: valueToSign,
      validAfter,
      validBefore,
      nonce: nonceHex,
    },
  });
} catch (e) {
  console.error(`   ✗ Sign failed: ${e.message}`);
  process.exit(1);
}
console.log(`     signature: ${signature.slice(0, 14)}…${signature.slice(-8)}`);

const paymentEnvelope = {
  signature,
  authorization: {
    from: operator.address,
    to: payTo,
    value: valueToSign.toString(),
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce: nonceHex,
  },
  network: BASE_SEPOLIA_NETWORK_TAG,
};
const xPaymentHeader = Buffer.from(JSON.stringify(paymentEnvelope), 'utf-8').toString('base64');
console.log();

// ──────────────────────────────────────────────────────────────────────────────
// Step 4: POST /compose with payment-signature
// ──────────────────────────────────────────────────────────────────────────────
console.log('[4/5] POST /compose with payment-signature…');
const startedAt = Date.now();
let payRes, payBody, payText;
try {
  payRes = await fetch(`${GATEWAY_URL}/compose`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'payment-signature': xPaymentHeader,
      'x-payment-chain': BASE_SEPOLIA_CHAIN_SLUG,
    },
    body: JSON.stringify(composeBody),
  });
} catch (e) {
  console.error(`   ✗ Network error on paid /compose: ${e.message}`);
  process.exit(1);
}
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
payText = await payRes.text();
try {
  payBody = JSON.parse(payText);
} catch {
  payBody = { raw: payText };
}
console.log(`   ← HTTP ${payRes.status} (${elapsed}s)`);

if (payRes.status !== 200) {
  console.error('   ✗ /compose with payment failed:');
  console.error(JSON.stringify(payBody, null, 2).slice(0, 1500));
  console.error('\n   Common causes:');
  console.error('   - 402 again: signature rejected by facilitator (check EIP-712 domain)');
  console.error('   - 5xx:       facilitator down or no funds for gas on facilitator wallet');
  console.error('   - 4xx other: agent not registered for base-sepolia, or registry slug wrong');
  process.exit(1);
}

// Extract tx hash from multiple known locations (per exemplar + Base adapter shape).
let txHash;
const candidates = [
  payBody?.txHash,
  payBody?.transactionHash,
  payBody?.tx_hash,
  payBody?.meta?.txHash,
  payBody?.kiteTxHash,
];
for (const s of payBody?.steps ?? []) {
  candidates.push(s?.downstreamTxHash, s?.txHash, s?.settle?.txHash);
}
// Also check x-payment-response header (base64 JSON per x402 spec).
const xPaymentResponse =
  payRes.headers.get('x-payment-response') ?? payRes.headers.get('X-PAYMENT-RESPONSE');
if (xPaymentResponse) {
  try {
    const decoded = JSON.parse(Buffer.from(xPaymentResponse, 'base64').toString('utf-8'));
    candidates.push(decoded.transactionHash, decoded.txHash, decoded.transaction);
  } catch {
    // Some facilitators echo plain JSON, not base64
    try {
      const decoded = JSON.parse(xPaymentResponse);
      candidates.push(decoded.transactionHash, decoded.txHash, decoded.transaction);
    } catch {
      // best-effort only
    }
  }
}
txHash = candidates.find((h) => typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h));

if (!txHash) {
  console.error('   ✗ HTTP 200 but no tx hash found in response body or headers.');
  console.error('     Body keys: ' + Object.keys(payBody).join(', '));
  console.error('     Steps:     ' + JSON.stringify(payBody.steps ?? []).slice(0, 400));
  console.error('     x-payment-response: ' + (xPaymentResponse ?? '(absent)'));
  process.exit(1);
}

console.log(`     tx hash:  ${txHash}`);
console.log(`     Basescan: ${BASESCAN_TX_BASE}/${txHash}`);
if (typeof payBody.totalCostUsdc !== 'undefined') {
  console.log(`     cost:     ${payBody.totalCostUsdc} USDC`);
}
if (typeof payBody.totalLatencyMs !== 'undefined') {
  console.log(`     latency:  ${payBody.totalLatencyMs}ms`);
}
console.log();

// ──────────────────────────────────────────────────────────────────────────────
// Step 5: done — explorer indexing reminder
// ──────────────────────────────────────────────────────────────────────────────
console.log('[5/5] Done.');
console.log('   Wait 10-30s for Basescan to index the tx.');
console.log(`   Verify manually: ${BASESCAN_TX_BASE}/${txHash}`);
console.log();
console.log('═════════════════════════════════════════════════════════════════');
console.log(`  BASE SEPOLIA SETTLE PROVEN — ${formatUnits(valueToSign, USDC_DECIMALS)} USDC`);
console.log('═════════════════════════════════════════════════════════════════');
console.log(`  client:     ${operator.address}`);
console.log(`  payTo:      ${payTo}`);
console.log(`  tx:         ${txHash}`);
console.log(`  explorer:   ${BASESCAN_TX_BASE}/${txHash}`);
console.log(`  iso8601:    ${new Date().toISOString()}`);
console.log();
console.log('Append the above to doc/BASE-EVIDENCE.md (one new "Run N" block).');
