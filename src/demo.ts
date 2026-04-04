/**
 * WKH-24: Autonomous Claude Agent Demo Script
 *
 * Usage: ts-node src/demo.ts "<goal>"
 *
 * This script demonstrates the WasiAI A2A protocol by:
 * 1. Discovering agents for a natural-language goal
 * 2. Signing a single x402 EIP-712 payment to the A2A server
 * 3. Calling /compose with the signed payment
 * 4. Printing the txHash + pipeline output
 *
 * ⚠️ CD-1: This script ONLY calls /compose — never agent.invokeUrl directly.
 * ⚠️ CD-2: OPERATOR_PRIVATE_KEY and signatures are NEVER logged.
 */

import { signX402Authorization } from './lib/x402-signer.js'
import type { ComposeStep, ComposeResult } from './types/index.js'

// ─── W0: Validation & Setup ───────────────────────────────────────────────────

const goal = process.argv[2]

if (!goal) {
  console.error('Usage: ts-node src/demo.ts "<goal>"')
  process.exit(1)
}

const OPERATOR_PRIVATE_KEY = process.env.OPERATOR_PRIVATE_KEY
const KITE_WALLET_ADDRESS = process.env.KITE_WALLET_ADDRESS as `0x${string}`

if (!OPERATOR_PRIVATE_KEY) {
  console.error('[ERROR] OPERATOR_PRIVATE_KEY is not set. Cannot sign x402 authorization.')
  process.exit(1)
}

if (!KITE_WALLET_ADDRESS) {
  console.error('[ERROR] KITE_WALLET_ADDRESS is not set. Cannot determine payment destination.')
  process.exit(1)
}

const A2A_SERVER_URL = process.env.A2A_SERVER_URL ?? 'http://localhost:3001'
const KITE_PAYMENT_AMOUNT = process.env.KITE_PAYMENT_AMOUNT ?? '1000000000000000000'

// ─── Main (async IIFE to allow top-level await) ───────────────────────────────

;(async () => {
  // ─── W1: Discover Agents ───────────────────────────────────────────────────

  console.log(`\n🔍 [STEP 1] Discovering agents for goal: "${goal}"`)

  const discoverUrl = `${A2A_SERVER_URL}/discover?q=${encodeURIComponent(goal)}&limit=5`
  const discoverRes = await fetch(discoverUrl)

  if (!discoverRes.ok) {
    console.error(`[ERROR] /discover failed with HTTP ${discoverRes.status}`)
    process.exit(1)
  }

  const discovery = await discoverRes.json() as {
    agents: Array<{ id: string; name: string; slug: string; registry: string }>
  }
  const agents = discovery.agents ?? []

  if (agents.length === 0) {
    console.error('[ERROR] No agents found for this goal. Cannot proceed.')
    process.exit(1)
  }

  console.log(`✅ Found ${agents.length} agent(s): ${agents.map(a => a.name).join(', ')}`)

  // ─── W2: Build ComposeStep[] ───────────────────────────────────────────────

  const MAX_AGENTS = 3
  const selectedAgents = agents.slice(0, MAX_AGENTS)

  console.log(`\n📋 [STEP 2] Building pipeline with ${selectedAgents.length} step(s)`)

  const steps: ComposeStep[] = selectedAgents.map((agent, index) => ({
    agent: agent.slug,
    registry: agent.registry,
    input: { query: goal },
    passOutput: index > 0, // steps 2+ chain output from previous step
  }))

  // ─── W3: Sign x402 Authorization ──────────────────────────────────────────

  console.log(`\n🔐 [STEP 3] Signing x402 EIP-712 authorization for A2A server...`)

  const { xPaymentHeader } = await signX402Authorization({
    to: KITE_WALLET_ADDRESS,
    value: KITE_PAYMENT_AMOUNT,
    timeoutSeconds: 300,
  })

  // CD-2: Do NOT log xPaymentHeader, privateKey, or signature
  console.log(`✅ Payment authorized (KITE_WALLET_ADDRESS: ${KITE_WALLET_ADDRESS})`)

  // ─── W4: POST /compose ─────────────────────────────────────────────────────

  console.log(`\n🚀 [STEP 4] Calling ${A2A_SERVER_URL}/compose...`)

  const composeRes = await fetch(`${A2A_SERVER_URL}/compose`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Payment': xPaymentHeader,
    },
    body: JSON.stringify({ steps, maxBudget: undefined }),
  })

  if (!composeRes.ok) {
    const errBody = await composeRes.text()
    console.error(`[ERROR] /compose failed with HTTP ${composeRes.status}: ${errBody}`)
    process.exit(1)
  }

  const result = await composeRes.json() as { kiteTxHash?: string } & ComposeResult

  if (!result.success) {
    console.error(`[ERROR] Compose pipeline failed: ${result.error ?? 'unknown error'}`)
    process.exit(1)
  }

  // ─── W5: Print Output ──────────────────────────────────────────────────────

  console.log(`\n✅ [STEP 5] Done!`)

  if (result.kiteTxHash) {
    console.log(`💳 txHash: ${result.kiteTxHash}`)
  } else {
    console.log(`⚠️  txHash not available (payment settlement may be pending)`)
  }

  console.log(`📊 Output:\n${JSON.stringify(result.output, null, 2)}`)
  console.log(`💰 Total cost: ${result.totalCostUsdc ?? 0} USDC`)
  console.log(`⏱️  Latency: ${result.totalLatencyMs ?? 0}ms`)

  process.exit(0)
})().catch(err => {
  console.error('[FATAL] Unhandled error:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
