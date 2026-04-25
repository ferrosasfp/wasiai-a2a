#!/usr/bin/env node
/**
 * Cross-chain x402 smoke test against wasiai-v2 STAGING with external facilitator active.
 *
 * Flow:
 *   1. Get /capabilities to fetch the agent's payment requirements
 *   2. Sign EIP-3009 TransferWithAuthorization (Avalanche Fuji USDC, operator → marketplace contract)
 *   3. POST /api/v1/agents/{slug}/invoke with X-PAYMENT header (base64-encoded x402 v2 payload)
 *   4. v2 staging routes to settlePaymentX402() which (with X402_FACILITATOR_URL set) delegates to
 *      our wasiai-facilitator. Facilitator settles on Fuji on-chain.
 *   5. Response includes the settlement tx hash from the facilitator.
 *
 * If we see HTTP 200 + tx hash on Fuji explorer, the cross-chain integration is PROVEN.
 */
import {
  createPublicClient,
  http,
  parseUnits,
  formatUnits,
  defineChain,
  keccak256,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

// Load operator PK from facilitator .env.local (matches v2 op wallet 0xf432baf…7Ba)
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
const v2Env = readEnv('/home/ferdev/.openclaw/workspace/wasiai-v2/.env.local');
function normPk(s) {
  const hex = s.replace(/[^0-9a-fA-F]/g, '');
  return '0x' + hex.slice(-64);
}

const STAGING_URL = 'https://wasiai-v2.vercel.app';
const FUJI_USDC = '0x5425890298aed601595a70AB815c96711a31Bc65';
const MARKETPLACE = '0xC01DEF0ca66b86E9F8655dc202347F1cf104b7A7';
const CHAIN_ID = 43113;
const OPERATOR_PK = normPk(v2Env.OPERATOR_PRIVATE_KEY);

const fuji = defineChain({
  id: CHAIN_ID,
  name: 'Avalanche Fuji',
  nativeCurrency: { name: 'AVAX', symbol: 'AVAX', decimals: 18 },
  rpcUrls: { default: { http: ['https://api.avax-test.network/ext/bc/C/rpc'] } },
});
const rpc = createPublicClient({ chain: fuji, transport: http() });

const operator = privateKeyToAccount(OPERATOR_PK);
console.log('=== Smoke staging x402 ===');
console.log(`  Operator (signer): ${operator.address}`);
console.log(`  Marketplace (payTo): ${MARKETPLACE}`);
console.log();

// Step 1: discover an agent
console.log('▶ Step 1: GET /capabilities');
const capRes = await fetch(`${STAGING_URL}/api/v1/capabilities?limit=5`);
const cap = await capRes.json();
console.log(`  HTTP ${capRes.status} — ${cap.agents?.length ?? 0} agents`);
if (!cap.agents?.length) {
  console.error('  no agents available'); process.exit(1);
}
// Pick the cheapest one
const agent = cap.agents.sort((a, b) => (a.price_per_call_usdc ?? 999) - (b.price_per_call_usdc ?? 999))[0];
console.log(`  Selected: ${agent.slug} @ ${agent.price_per_call_usdc} USDC`);
console.log(`  payment.chain=${agent.payment?.chain} payment.contract=${agent.payment?.contract}`);

// Step 2: sign EIP-3009 authorization
console.log('\n▶ Step 2: Sign EIP-3009 (USDC Fuji)');
const amount = parseUnits(String(agent.price_per_call_usdc), 6);
const now = Math.floor(Date.now() / 1000);
const validAfter = 0n;
const validBefore = BigInt(now + 300);
const nonce = ('0x' + randomBytes(32).toString('hex'));

console.log(`  amount: ${formatUnits(amount, 6)} USDC (${amount}n atomic)`);

// Pre-flight balance check
const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const balance = await rpc.readContract({
  address: FUJI_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [operator.address],
});
console.log(`  Operator USDC balance: ${formatUnits(balance, 6)}`);
if (balance < amount) {
  console.error('  insufficient USDC'); process.exit(1);
}

const signature = await operator.signTypedData({
  domain: {
    name: 'USD Coin', version: '2', chainId: CHAIN_ID, verifyingContract: FUJI_USDC,
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
    to: MARKETPLACE,
    value: amount,
    validAfter,
    validBefore,
    nonce,
  },
});
console.log(`  signature: ${signature.slice(0, 16)}…${signature.slice(-6)}`);

// Step 3: build x402 v2 payload + base64-encode for X-PAYMENT
const payload = {
  x402Version: 2,
  scheme: 'exact',
  network: 'eip155:43113',
  payload: {
    signature,
    authorization: {
      from: operator.address,
      to: MARKETPLACE,
      value: amount.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
    },
  },
};
const xPaymentHeader = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');

// Step 4: POST /invoke (canonical path /api/v1/models for x402 payment)
console.log('\n▶ Step 4: POST /api/v1/models/{slug}/invoke');
const startedAt = Date.now();
const invokeRes = await fetch(`${STAGING_URL}/api/v1/models/${agent.slug}/invoke`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-PAYMENT': xPaymentHeader,
  },
  body: JSON.stringify({ input: { symbol: 'AVAX' } }),
});
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`  HTTP ${invokeRes.status} (${elapsed}s)`);

const txHashHeader = invokeRes.headers.get('X-PAYMENT-RESPONSE') || invokeRes.headers.get('PAYMENT-RESPONSE');
const respText = await invokeRes.text();
console.log(`  X-PAYMENT-RESPONSE header: ${txHashHeader ?? '(none)'}`);
console.log(`  body: ${respText.slice(0, 600)}`);

// Step 5: try to extract tx hash for verification
let txHash;
try {
  if (txHashHeader) {
    const decoded = JSON.parse(Buffer.from(txHashHeader, 'base64').toString('utf-8'));
    txHash = decoded.transactionHash || decoded.txHash;
  }
  if (!txHash) {
    const body = JSON.parse(respText);
    txHash = body.txHash || body.transactionHash || body.tx_hash || body.meta?.txHash;
  }
} catch {}

if (txHash) {
  console.log(`\n✅ TX HASH: ${txHash}`);
  console.log(`   Explorer: https://testnet.snowtrace.io/tx/${txHash}`);
  console.log('\n=== CROSS-CHAIN PROVEN ===');
  console.log('   v2 staging → wasiai-facilitator → Avalanche Fuji USDC tx');
} else {
  console.log('\n⚠ No tx hash extracted from response. Check above body for clues.');
  console.log(`   Likely outcomes: 402 (no payment), 502 (settle failed), 200 (success)`);
}
