#!/usr/bin/env node
/**
 * Raw chain smoke test for Base Sepolia — WKH-107 BASE-04
 *
 * Validates the COMPLETE EIP-3009 transferWithAuthorization flow on Base Sepolia
 * WITHOUT requiring the wasiai-a2a gateway or wasiai-facilitator services to run.
 *
 * Why this exists: the production gateway URL doesn't have Base Sepolia support
 * yet (WKH-104 is on feat/wkh-base-port-v1, not merged). To produce verifiable
 * tx hashes for AC-2 of WKH-107, this script exercises the chain layer directly:
 *
 *   1. Client wallet (0xf432... — wasiai-a2a OPERATOR) signs EIP-3009 authorization
 *      using the same EIP-712 domain that the production Base adapter (WKH-104)
 *      will build at runtime.
 *   2. Submitter wallet (0x9c06... — wasiai-facilitator OPERATOR) calls
 *      USDC.transferWithAuthorization on Base Sepolia, paying gas.
 *   3. The 0.001 USDC moves from client to submitter (self-transfer pattern for
 *      MVP — produces real tx hash without requiring a third-party payTo).
 *
 * This validates:
 *   - EIP-712 domain name="USDC" version="2" chainId=84532 is correct onchain
 *     (the silent-fail risk WKH-105 discovered)
 *   - USDC sepolia contract 0x036CbD53842c5426634e7929541eC2318f3dCF7e accepts
 *     transferWithAuthorization with this signature shape
 *   - Both operator wallets are configured with valid keys
 *
 * Run:
 *   AMOUNT_USDC=0.001 node scripts/smoke-base-sepolia-raw.mjs
 *
 * Output: tx hash printed to stdout + Basescan URL.
 */

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  formatEther,
  hexToSignature,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

// ─── Constants ──────────────────────────────────────────────────────────
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const USDC_DECIMALS = 6;
const CHAIN_ID = 84532;
// EIP-712 domain verified onchain by WKH-105 — Sepolia uses "USDC" (not "USD Coin").
const EIP712_DOMAIN = {
  name: 'USDC',
  version: '2',
  chainId: CHAIN_ID,
  verifyingContract: USDC,
};
const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};
const USDC_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
]);

// ─── Env loaders ────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const A2A_REPO = join(__dirname, '..');
const FAC_REPO = '/home/ferdev/.openclaw/workspace/wasiai-facilitator';

function parseEnv(filePath) {
  const out = {};
  try {
    const text = readFileSync(filePath, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      let val = m[2].trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      out[m[1]] = val;
    }
  } catch {
    // file not present
  }
  return out;
}

const a2aEnv = { ...parseEnv(join(A2A_REPO, '.env')), ...parseEnv(join(A2A_REPO, '.env.local')) };
const facEnv = { ...parseEnv(join(FAC_REPO, '.env')), ...parseEnv(join(FAC_REPO, '.env.local')) };

const clientKey = a2aEnv.OPERATOR_PRIVATE_KEY;
const submitterKey = facEnv.OPERATOR_PRIVATE_KEY;

if (!clientKey || !clientKey.startsWith('0x')) {
  console.error('ERROR: OPERATOR_PRIVATE_KEY not set in wasiai-a2a/.env');
  process.exit(1);
}
if (!submitterKey || !submitterKey.startsWith('0x')) {
  console.error('ERROR: OPERATOR_PRIVATE_KEY not set in wasiai-facilitator/.env.local');
  process.exit(1);
}

// ─── Setup clients ──────────────────────────────────────────────────────
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const AMOUNT = process.env.AMOUNT_USDC || '0.001';
const valueUnits = parseUnits(AMOUNT, USDC_DECIMALS);

const publicClient = createPublicClient({
  chain: baseSepolia,
  transport: http(RPC_URL),
});

const clientAccount = privateKeyToAccount(clientKey);
const submitterAccount = privateKeyToAccount(submitterKey);

const submitterClient = createWalletClient({
  account: submitterAccount,
  chain: baseSepolia,
  transport: http(RPC_URL),
});

// ─── Run ────────────────────────────────────────────────────────────────
const SEPARATOR = '═'.repeat(72);

console.log(SEPARATOR);
console.log('🟦 Base Sepolia raw smoke — wasiai-a2a WKH-107');
console.log(SEPARATOR);
console.log(`  Chain      : Base Sepolia (${CHAIN_ID})`);
console.log(`  RPC        : ${RPC_URL}`);
console.log(`  USDC       : ${USDC}`);
console.log(`  Client     : ${clientAccount.address} (signs EIP-3009)`);
console.log(`  Submitter  : ${submitterAccount.address} (pays gas)`);
console.log(`  Amount     : ${AMOUNT} USDC (${valueUnits} micro-USDC)`);
console.log('');

console.log('[1/4] Pre-flight balance check...');
const clientUsdc = await publicClient.readContract({
  address: USDC,
  abi: USDC_ABI,
  functionName: 'balanceOf',
  args: [clientAccount.address],
});
const submitterEth = await publicClient.getBalance({ address: submitterAccount.address });

console.log(`      Client USDC : ${formatUnits(clientUsdc, USDC_DECIMALS)} USDC`);
console.log(`      Submitter ETH: ${formatEther(submitterEth)} ETH`);

if (clientUsdc < valueUnits) {
  console.error(`      ❌ Insufficient USDC. Need ${AMOUNT}, have ${formatUnits(clientUsdc, USDC_DECIMALS)}.`);
  process.exit(1);
}
if (submitterEth < 100000n * 1_000_000_000n) {
  // ~100K gas at 1 gwei = 1e14 wei = 0.0001 ETH
  console.warn(`      ⚠ Low submitter ETH (${formatEther(submitterEth)}). May fail on gas spike.`);
}
console.log('      ✓ Sufficient balances');
console.log('');

console.log('[2/4] Sign EIP-3009 transferWithAuthorization...');
const now = Math.floor(Date.now() / 1000);
const auth = {
  from: clientAccount.address,
  to: submitterAccount.address, // self-transfer pattern for MVP
  value: valueUnits,
  validAfter: 0n,
  validBefore: BigInt(now + 600), // 10-minute window
  nonce: `0x${randomBytes(32).toString('hex')}`,
};
console.log(`      from       : ${auth.from}`);
console.log(`      to         : ${auth.to}`);
console.log(`      value      : ${auth.value} (${AMOUNT} USDC)`);
console.log(`      validBefore: ${auth.validBefore} (in ${600}s)`);
console.log(`      nonce      : ${auth.nonce}`);

const signature = await clientAccount.signTypedData({
  domain: EIP712_DOMAIN,
  types: EIP3009_TYPES,
  primaryType: 'TransferWithAuthorization',
  message: auth,
});
const { v, r, s } = hexToSignature(signature);
console.log(`      signature  : ${signature.slice(0, 18)}... (v=${v} r=${r.slice(0, 10)}... s=${s.slice(0, 10)}...)`);
console.log('');

console.log('[3/4] Submit transferWithAuthorization onchain...');
let txHash;
try {
  txHash = await submitterClient.writeContract({
    address: USDC,
    abi: USDC_ABI,
    functionName: 'transferWithAuthorization',
    args: [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, Number(v), r, s],
  });
} catch (err) {
  console.error(`      ❌ Submission failed: ${err.shortMessage || err.message}`);
  if (err.cause?.shortMessage) console.error(`      cause: ${err.cause.shortMessage}`);
  process.exit(2);
}
console.log(`      tx hash    : ${txHash}`);
console.log(`      Basescan   : https://sepolia.basescan.org/tx/${txHash}`);
console.log('');

console.log('[4/4] Wait for confirmation (max 60s)...');
const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
console.log(`      status     : ${receipt.status} (${receipt.status === 'success' ? '✓' : '✗'})`);
console.log(`      blockNumber: ${receipt.blockNumber}`);
console.log(`      gasUsed    : ${receipt.gasUsed}`);
console.log('');

console.log(SEPARATOR);
if (receipt.status === 'success') {
  console.log(`✅ SUCCESS — ${AMOUNT} USDC transferred via EIP-3009 on Base Sepolia`);
  console.log(`   Tx hash    : ${txHash}`);
  console.log(`   Basescan   : https://sepolia.basescan.org/tx/${txHash}`);
  console.log(`   Timestamp  : ${new Date().toISOString()}`);
} else {
  console.log(`❌ FAILED — tx ${txHash} reverted onchain`);
  process.exit(3);
}
console.log(SEPARATOR);
