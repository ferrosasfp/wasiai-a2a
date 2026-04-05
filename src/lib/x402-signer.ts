/**
 * x402 Client-Side Signer — genera X-Payment header para invocar agentes con pago.
 *
 * Usa viem WalletClient + signTypedData (EIP-712).
 * NUNCA logear privateKey ni signature (CD-1).
 */
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { kiteTestnet } from './kite-chain.js'
import {
  KITE_FACILITATOR_ADDRESS,
  KITE_NETWORK,
} from '../middleware/x402.js'
import type { X402PaymentRequest } from '../types/index.js'
import { randomBytes } from 'node:crypto'

// ─── EIP-712 Domain & Types ──────────────────────────────────

const EIP712_DOMAIN = {
  name: 'Kite x402',
  version: '1',
  chainId: kiteTestnet.id, // 2368
  verifyingContract: KITE_FACILITATOR_ADDRESS,
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

// ─── Wallet Client (lazy singleton) ─────────────────────────

let _walletClient: ReturnType<typeof createWalletClient> | null = null

export function getWalletClient() {
  if (_walletClient) return _walletClient

  const pk = process.env.OPERATOR_PRIVATE_KEY
  if (!pk) {
    throw new Error('OPERATOR_PRIVATE_KEY not set — x402 client signing disabled')
  }

  const account = privateKeyToAccount(pk as `0x${string}`)
  _walletClient = createWalletClient({
    account,
    chain: kiteTestnet,
    transport: http(process.env.KITE_RPC_URL),
  })

  return _walletClient
}

// ─── Public API ──────────────────────────────────────────────

export interface SignX402Options {
  /** Wallet del service provider (payTo) */
  to: `0x${string}`
  /** Monto en wei (string) */
  value: string
  /** Timeout en segundos (default 300) */
  timeoutSeconds?: number
}

/**
 * Firma una autorización x402 EIP-712 y retorna el X-Payment header (base64).
 *
 * @returns base64-encoded JSON de X402PaymentRequest
 */
export async function signX402Authorization(
  opts: SignX402Options,
): Promise<{ xPaymentHeader: string; paymentRequest: X402PaymentRequest }> {
  const client = getWalletClient()
  const account = client.account!

  const now = Math.floor(Date.now() / 1000)
  const nonce = `0x${randomBytes(32).toString('hex')}` as `0x${string}`

  const authorization = {
    from: account.address,
    to: opts.to,
    value: opts.value,
    validAfter: '0',
    validBefore: String(now + (opts.timeoutSeconds ?? 300)),
    nonce,
  }

  const signature = await client.signTypedData({
    account,
    domain: EIP712_DOMAIN,
    types: EIP712_TYPES,
    primaryType: 'Authorization',
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce as `0x${string}`,
    },
  })

  const paymentRequest: X402PaymentRequest = {
    authorization,
    signature,
    network: KITE_NETWORK,
  }

  const xPaymentHeader = Buffer.from(
    JSON.stringify(paymentRequest),
  ).toString('base64')

  return { xPaymentHeader, paymentRequest }
}

/**
 * Reset del singleton para testing.
 * @internal
 */
export function _resetWalletClient(): void {
  _walletClient = null
}
