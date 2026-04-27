#!/usr/bin/env node
/**
 * Cross-chain x402 smoke test — BATCH version.
 *
 * Iterates over a list of agent slugs, signs EIP-3009 over Fuji USDC,
 * POSTs to wasiai-v2 staging /api/v1/models/{slug}/invoke and collects
 * the settle tx hashes from X-PAYMENT-RESPONSE.
 *
 * Surface: https://wasiai-v2.vercel.app (X402_FACILITATOR_URL active → routes
 * settle through wasiai-facilitator on Avalanche Fuji).
 *
 * Usage: node scripts/smoke-staging-x402-batch.mjs
 *   (slug list is hardcoded below — edit AGENT_SLUGS to change)
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
const STAGING_URL = 'https://wasiai-v2.vercel.app';
const FUJI_USDC = '0x5425890298aed601595a70AB815c96711a31Bc65';
const MARKETPLACE = '0xC01DEF0ca66b86E9F8655dc202347F1cf104b7A7';
const CHAIN_ID = 43113;

const AGENT_SLUGS = [
  'wasi-liquidity-analyzer',  // chain=avalanche-fuji declared in DB
  'wasi-wallet-profiler',     // chain=avalanche-fuji declared in DB
  'wasi-chainlink-price',     // cheapest ($0.001)
  'blexsignal-scanner',       // Railway production endpoint
  'wasiai-news-summarizer',   // beeceptor echo (happy-path upstream)
];

// Per-slug input payloads — schemas verified against /capabilities (2026-04-26).
// IMPORTANT: agent handlers read fields top-level (body.token / body.wallet / body.pairs).
// The v2 marketplace forwards body verbatim, so we send the raw input WITHOUT { input: ... }
// wrapper. Validation at v2 still passes because validator falls back to rawBody when
// rawBody.input is absent.
const AGENT_INPUTS = {
  'wasi-liquidity-analyzer': { token: 'USDC' },                            // required: token
  'wasi-wallet-profiler': { wallet: '0xf432baf1315ccDB23E683B95b03fD54Dd3e447Ba' }, // required: wallet
  'wasi-chainlink-price': { token: 'AVAX' },                               // required: token
  'blexsignal-scanner': { pairs: ['BTC-USDT', 'ETH-USDT'] },               // OKX uses dash format
  'wasiai-news-summarizer': {},                                            // no required props
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
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

const v2Env = readEnv('/home/ferdev/.openclaw/workspace/wasiai-v2/.env.local');
const OPERATOR_PK = normPk(v2Env.OPERATOR_PRIVATE_KEY);

const fuji = defineChain({
  id: CHAIN_ID,
  name: 'Avalanche Fuji',
  nativeCurrency: { name: 'AVAX', symbol: 'AVAX', decimals: 18 },
  rpcUrls: { default: { http: ['https://api.avax-test.network/ext/bc/C/rpc'] } },
});
const rpc = createPublicClient({ chain: fuji, transport: http() });
const operator = privateKeyToAccount(OPERATOR_PK);

const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view',
    inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];

async function fetchAgentMeta(slug) {
  const res = await fetch(`${STAGING_URL}/api/v1/capabilities?limit=50`);
  if (!res.ok) throw new Error(`capabilities HTTP ${res.status}`);
  const body = await res.json();
  const agent = body.agents?.find((a) => a.slug === slug);
  if (!agent) throw new Error(`agent ${slug} not found in capabilities`);
  return agent;
}

async function smokeOne(slug, idx, total) {
  const tag = `[${idx}/${total} ${slug}]`;
  console.log(`\n━━━ ${tag} ━━━`);
  let agent;
  try {
    agent = await fetchAgentMeta(slug);
  } catch (e) {
    console.log(`  ✗ capabilities: ${e.message}`);
    return { slug, status: 'capabilities_fail', error: e.message };
  }
  const price = agent.price_per_call_usdc ?? agent.price_per_call ?? 0;
  console.log(`  price=${price} USDC chain=${agent.payment?.chain ?? agent.chain}`);

  const amount = parseUnits(String(price), 6);
  const now = Math.floor(Date.now() / 1000);
  const validBefore = BigInt(now + 300);
  const nonce = '0x' + randomBytes(32).toString('hex');

  const balance = await rpc.readContract({
    address: FUJI_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [operator.address],
  });
  if (balance < amount) {
    return { slug, status: 'no_balance', balance: formatUnits(balance, 6), needed: formatUnits(amount, 6) };
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
      validAfter: 0n,
      validBefore,
      nonce,
    },
  });

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
        validAfter: '0',
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };
  const xPaymentHeader = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');

  const startedAt = Date.now();
  const invokeRes = await fetch(`${STAGING_URL}/api/v1/models/${slug}/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-PAYMENT': xPaymentHeader },
    // Send raw input (no `input:` wrapper) so the marketplace forwards the same
    // shape the upstream agent reads at top-level.
    body: JSON.stringify(AGENT_INPUTS[slug] ?? {}),
  });
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const txHashHeader = invokeRes.headers.get('X-PAYMENT-RESPONSE');
  const respText = await invokeRes.text();

  let txHash;
  try {
    if (txHashHeader) {
      const decoded = JSON.parse(Buffer.from(txHashHeader, 'base64').toString('utf-8'));
      txHash = decoded.transactionHash || decoded.txHash || decoded.tx_hash;
    }
    if (!txHash) {
      const body = JSON.parse(respText);
      txHash =
        body.txHash || body.transactionHash || body.tx_hash ||
        body.meta?.txHash || body.meta?.tx_hash || body.meta?.transactionHash;
    }
  } catch {}

  console.log(`  HTTP ${invokeRes.status} (${elapsed}s)`);
  if (txHash) console.log(`  ✓ tx: ${txHash}`);
  else console.log(`  body: ${respText.slice(0, 280)}`);

  return {
    slug,
    status: invokeRes.status,
    elapsed_s: parseFloat(elapsed),
    tx_hash: txHash ?? null,
    body_preview: respText.slice(0, 280),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
console.log('=== Batch smoke staging x402 (5 agents) ===');
console.log(`  Operator: ${operator.address}`);
console.log(`  Staging:  ${STAGING_URL}`);
console.log(`  Marketplace payTo: ${MARKETPLACE}`);

const results = [];
for (let i = 0; i < AGENT_SLUGS.length; i++) {
  const r = await smokeOne(AGENT_SLUGS[i], i + 1, AGENT_SLUGS.length);
  results.push(r);
}

console.log('\n\n═══════════════════════════════════════');
console.log('BATCH SUMMARY');
console.log('═══════════════════════════════════════');
for (const r of results) {
  const ok = r.tx_hash ? '✓' : '✗';
  console.log(`${ok} ${r.slug.padEnd(28)} HTTP ${String(r.status).padEnd(5)} ${r.tx_hash ?? '(no tx)'}`);
}
const successful = results.filter((r) => r.tx_hash);
console.log(`\n${successful.length}/${results.length} settled on-chain`);
if (successful.length) {
  console.log('\nExplorer links:');
  for (const r of successful) {
    console.log(`  ${r.slug}: https://testnet.snowtrace.io/tx/${r.tx_hash}`);
  }
}
