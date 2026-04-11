#!/usr/bin/env npx tsx
/**
 * WasiAI A2A — x402 Payment Demo (E2E)
 *
 * Demonstrates the full x402 payment flow:
 * 1. Call POST /orchestrate → receive 402 with payment instructions
 * 2. Sign EIP-712 authorization (off-chain, zero gas)
 * 3. Re-send with PAYMENT-SIGNATURE header
 * 4. Pieverse verifies + settles → server executes → result
 *
 * Usage:
 *   npx tsx scripts/demo-x402.ts [BASE_URL]
 *
 * Env vars required:
 *   OPERATOR_PRIVATE_KEY — wallet private key (0x...)
 *   KITE_RPC_URL — Kite testnet RPC (default: https://rpc-testnet.gokite.ai/)
 */

import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { randomBytes } from 'node:crypto'

// ── Config ──────────────────────────────────────────────────
const BASE_URL = process.argv[2] ?? 'https://wasiai-a2a-production.up.railway.app'
const PK = process.env.OPERATOR_PRIVATE_KEY
if (!PK) { console.error('❌ OPERATOR_PRIVATE_KEY not set'); process.exit(1) }

const KITE_RPC = process.env.KITE_RPC_URL ?? 'https://rpc-testnet.gokite.ai/'
const KITE_CHAIN_ID = 2368
const FACILITATOR_ADDRESS = '0x12343e649e6b2b2b77649DFAb88f103c02F3C78b'

const kiteTestnet = {
  id: KITE_CHAIN_ID,
  name: 'KiteAI Testnet',
  nativeCurrency: { name: 'KITE', symbol: 'KITE', decimals: 18 },
  rpcUrls: { default: { http: [KITE_RPC] } },
} as const

const EIP712_DOMAIN = {
  name: 'Kite x402',
  version: '1',
  chainId: KITE_CHAIN_ID,
  verifyingContract: FACILITATOR_ADDRESS,
} as const

const EIP712_TYPES = {
  Authorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

// ── Setup wallet ────────────────────────────────────────────
const account = privateKeyToAccount(PK as `0x${string}`)
const walletClient = createWalletClient({
  account,
  chain: kiteTestnet,
  transport: http(KITE_RPC),
})

console.log('═══════════════════════════════════════════════')
console.log('  WasiAI A2A — x402 Payment Demo (E2E)')
console.log('═══════════════════════════════════════════════')
console.log(`  Target:  ${BASE_URL}`)
console.log(`  Wallet:  ${account.address}`)
console.log(`  Chain:   Kite Testnet (${KITE_CHAIN_ID})`)
console.log('═══════════════════════════════════════════════\n')

// ── Step 1: Call /orchestrate → get 402 ─────────────────────
console.log('📡 Step 1: POST /orchestrate (expect 402)...')
const orchestrateBody = {
  goal: 'Get the current price of AVAX in USD',
  budget: 0.10,
}

const res1 = await fetch(`${BASE_URL}/orchestrate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(orchestrateBody),
})

console.log(`   HTTP ${res1.status}`)

if (res1.status !== 402) {
  const body = await res1.text()
  console.log(`   ❌ Expected 402, got ${res1.status}: ${body.slice(0, 200)}`)
  process.exit(1)
}

const paymentInstructions = await res1.json() as {
  error: string
  accepts: Array<{
    scheme: string
    network: string
    maxAmountRequired: string
    payTo: string
    asset: string
    maxTimeoutSeconds: number
    merchantName: string
  }>
  x402Version: number
}

const accept = paymentInstructions.accepts[0]
console.log(`   ✅ 402 received — payment required`)
console.log(`   Scheme:     ${accept.scheme}`)
console.log(`   Pay To:     ${accept.payTo}`)
console.log(`   Amount:     ${accept.maxAmountRequired} wei`)
console.log(`   Asset:      ${accept.asset}`)
console.log(`   Merchant:   ${accept.merchantName}`)
console.log(`   Timeout:    ${accept.maxTimeoutSeconds}s`)
console.log()

// ── Step 2: Sign EIP-712 authorization (off-chain, 0 gas) ──
console.log('✍️  Step 2: Signing EIP-712 authorization (off-chain, zero gas)...')

const now = Math.floor(Date.now() / 1000)
const nonce = `0x${randomBytes(32).toString('hex')}` as `0x${string}`

const authorization = {
  from: account.address,
  to: accept.payTo as `0x${string}`,
  value: accept.maxAmountRequired,
  validAfter: '0',
  validBefore: String(now + accept.maxTimeoutSeconds),
  nonce,
}

const signature = await walletClient.signTypedData({
  account,
  domain: EIP712_DOMAIN,
  types: EIP712_TYPES,
  primaryType: 'Authorization',
  message: {
    from: authorization.from,
    to: authorization.to as `0x${string}`,
    value: BigInt(authorization.value),
    validAfter: BigInt(authorization.validAfter),
    validBefore: BigInt(authorization.validBefore),
    nonce: authorization.nonce,
  },
})

console.log(`   ✅ Signed by ${account.address}`)
console.log(`   Signature:  ${signature.slice(0, 20)}...${signature.slice(-10)}`)
console.log(`   Nonce:      ${nonce.slice(0, 20)}...`)
console.log()

// ── Step 3: Build PAYMENT-SIGNATURE header ─────────────────
const paymentPayload = {
  authorization,
  signature,
  network: accept.network,
}
const paymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString('base64')

console.log('📦 Step 3: Built PAYMENT-SIGNATURE header')
console.log(`   Length: ${paymentHeader.length} chars (base64)`)
console.log()

// ── Step 4: Re-send with payment ────────────────────────────
console.log('🚀 Step 4: POST /orchestrate with PAYMENT-SIGNATURE header...')
console.log('   (Pieverse will verify signature + settle USDT transfer on-chain)')
console.log()

const res2 = await fetch(`${BASE_URL}/orchestrate`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'PAYMENT-SIGNATURE': paymentHeader,
  },
  body: JSON.stringify(orchestrateBody),
})

console.log(`   HTTP ${res2.status}`)
const result = await res2.json()

if (res2.status === 200) {
  console.log('   ✅ ORCHESTRATION COMPLETE!')
  console.log()
  console.log('═══════════════════════════════════════════════')
  console.log('  RESULT')
  console.log('═══════════════════════════════════════════════')
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(`   ⚠️ HTTP ${res2.status}`)
  console.log(JSON.stringify(result, null, 2))

  if (res2.status === 402) {
    console.log('\n   💡 Payment was rejected. Possible reasons:')
    console.log('      - Insufficient USDT balance in wallet')
    console.log('      - Pieverse facilitator rejected the signature')
    console.log('      - Self-transfer not allowed (paying from same wallet)')
    console.log('      - Try with a different wallet as the client')
  }
}

console.log('\n═══════════════════════════════════════════════')
console.log('  Demo complete.')
console.log('═══════════════════════════════════════════════')
