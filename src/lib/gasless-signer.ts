/**
 * Gasless EIP-3009 Signer (WKH-29) — testnet only (PYUSD).
 *
 * Firma TransferWithAuthorization (EIP-3009) con viem signTypedData,
 * descompone v/r/s con hexToSignature, y submite al relayer Kite Gasless.
 *
 * NUNCA logear OPERATOR_PRIVATE_KEY, signature, nonce ni payloads sensibles (CD-1).
 * Aislado de src/middleware/x402.ts y src/lib/x402-signer.ts (CD-2, CD-5).
 */
import { createWalletClient, http, parseSignature } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { randomBytes } from 'node:crypto'
import { kiteTestnet } from './kite-chain.js'
import { requireKiteClient } from '../services/kite-client.js'
import type {
  GaslessSupportedToken,
  GaslessTransferRequest,
  GaslessTransferResponse,
  GaslessStatus,
} from '../types/index.js'

// ─── Constantes ──────────────────────────────────────────────

const GASLESS_BASE_URL = 'https://gasless.gokite.ai'
const GASLESS_SUBMIT_URL = `${GASLESS_BASE_URL}/testnet` // CD-8
const GASLESS_TOKENS_URL = `${GASLESS_BASE_URL}/supported_tokens`
const VALIDITY_WINDOW_SECONDS = 25n // CD-6

const FALLBACK_TOKEN: GaslessSupportedToken = {
  network: 'testnet',
  symbol: 'PYUSD',
  address: '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9',
  decimals: 18,
  eip712Name: 'PYUSD',
  eip712Version: '1',
  minimumTransferAmount: '10000000000000000', // 0.01 PYUSD (18 dec)
}

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

// ─── Estado del modulo ───────────────────────────────────────

let _walletClient: ReturnType<typeof createWalletClient> | null = null
let _tokenCache: GaslessSupportedToken | null = null

// ─── Helpers privados ────────────────────────────────────────

function getWalletClient() {
  if (_walletClient) return _walletClient

  const pk = process.env.OPERATOR_PRIVATE_KEY
  if (!pk) {
    throw new Error('OPERATOR_PRIVATE_KEY is required for gasless signer')
  }

  const account = privateKeyToAccount(pk as `0x${string}`)
  _walletClient = createWalletClient({
    account,
    chain: kiteTestnet,
    transport: http(process.env.KITE_RPC_URL),
  })

  return _walletClient
}

function buildDomain(token: GaslessSupportedToken) {
  return {
    name: token.eip712Name,
    version: token.eip712Version,
    chainId: kiteTestnet.id,
    verifyingContract: token.address,
  } as const
}

function generateNonce(): `0x${string}` {
  return `0x${randomBytes(32).toString('hex')}` as `0x${string}`
}

function assertMinimumValue(value: bigint, token: GaslessSupportedToken): void {
  if (value < BigInt(token.minimumTransferAmount)) {
    throw new Error('value below minimum_transfer_amount')
  }
}

function sanitizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message.substring(0, 120)
  }
  return 'unknown error'
}

interface RawTokenEntry {
  address?: string
  decimals?: number
  eip712_name?: string
  eip712_version?: string
  minimum_transfer_amount?: string
  symbol?: string
}

function parseTestnetToken(raw: unknown): GaslessSupportedToken | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as { testnet?: unknown }
  if (!Array.isArray(obj.testnet) || obj.testnet.length === 0) return null
  const entry = obj.testnet[0] as RawTokenEntry
  if (
    typeof entry.address !== 'string' ||
    typeof entry.decimals !== 'number' ||
    typeof entry.eip712_name !== 'string' ||
    typeof entry.eip712_version !== 'string' ||
    typeof entry.minimum_transfer_amount !== 'string' ||
    typeof entry.symbol !== 'string'
  ) {
    return null
  }
  return {
    network: 'testnet',
    symbol: entry.symbol,
    address: entry.address as `0x${string}`,
    decimals: entry.decimals,
    eip712Name: entry.eip712_name,
    eip712Version: entry.eip712_version,
    minimumTransferAmount: entry.minimum_transfer_amount,
  }
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Discovery de token soportado en testnet (AC-4).
 * Cachea el resultado en el primer call. Fallback hardcoded a PYUSD si la
 * llamada falla, devuelve non-2xx, o el shape no es parseable.
 */
export async function getSupportedToken(): Promise<GaslessSupportedToken> {
  if (_tokenCache) return _tokenCache

  try {
    const res = await fetch(GASLESS_TOKENS_URL, {
      signal: AbortSignal.timeout(5000), // H-11
    })
    if (!res.ok) {
      _tokenCache = FALLBACK_TOKEN
      return _tokenCache
    }
    const json = (await res.json()) as unknown
    const parsed = parseTestnetToken(json)
    _tokenCache = parsed ?? FALLBACK_TOKEN
    return _tokenCache
  } catch {
    _tokenCache = FALLBACK_TOKEN
    return _tokenCache
  }
}

/**
 * Firma EIP-3009 TransferWithAuthorization (AC-2, AC-3, AC-4).
 *
 * Pipeline: token discovery → assertMin → getBlock → validAfter/Before
 *           → nonce → signTypedData → hexToSignature.
 */
export async function signTransferWithAuthorization(opts: {
  to: `0x${string}`
  value: bigint
}): Promise<GaslessTransferRequest> {
  const token = await getSupportedToken()
  assertMinimumValue(opts.value, token) // CD-9

  const block = await requireKiteClient().getBlock({ blockTag: 'latest' })
  const blockTs = block.timestamp // bigint (A-5)
  const validAfter = blockTs - 1n // AC-3
  const validBefore = validAfter + VALIDITY_WINDOW_SECONDS // CD-6

  const client = getWalletClient()
  const account = client.account!

  const nonce = generateNonce()

  const signature = await client.signTypedData({
    account,
    domain: buildDomain(token),
    types: EIP3009_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: account.address,
      to: opts.to,
      value: opts.value,
      validAfter,
      validBefore,
      nonce,
    },
  })

  // viem 2.47.6: parseSignature returns {r, s, v?: bigint, yParity: 0|1}.
  // For 64-byte EIP-2098 sigs from signTypedData, v may be undefined; derive
  // v from yParity (27 + yParity) so we always send a valid v ∈ {27,28} (H-4).
  const parsed = parseSignature(signature)
  const v =
    parsed.v !== undefined ? Number(parsed.v) : Number(parsed.yParity) + 27

  return {
    from: account.address,
    to: opts.to,
    value: opts.value.toString(),
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    tokenAddress: token.address,
    nonce,
    v,
    r: parsed.r,
    s: parsed.s,
  }
}

/**
 * Submite el TransferWithAuthorization firmado al relayer Kite (AC-1, AC-6).
 * Errores sanitizados (CD-1) — NUNCA loggear body, signature ni private key.
 *
 * TODO(WKH-29): verify POST shape with relayer when test wallet has balance.
 * Asumimos camelCase ({tokenAddress, validAfter, validBefore, v, r, s}) según
 * story-file A-2; el smoke test real queda pendiente del fondeo de la wallet.
 */
export async function submitGaslessTransfer(
  payload: GaslessTransferRequest,
): Promise<GaslessTransferResponse> {
  let res: Response
  try {
    res = await fetch(GASLESS_SUBMIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000), // H-11
    })
  } catch (err) {
    throw new Error(`gasless submit failed: ${sanitizeError(err)}`)
  }

  if (!res.ok) {
    throw new Error(
      `gasless submit failed: ${res.status} ${res.statusText ?? ''}`.trim(),
    )
  }

  const json = (await res.json()) as { txHash?: string }
  if (typeof json.txHash !== 'string' || !json.txHash.startsWith('0x')) {
    throw new Error('gasless submit failed: invalid response')
  }

  return { txHash: json.txHash as `0x${string}` }
}

/**
 * Status del modulo gasless (AC-7). NUNCA throw — degrada a supportedToken null.
 * NUNCA expone private key.
 */
export async function getGaslessStatus(): Promise<GaslessStatus> {
  const enabled = process.env.GASLESS_ENABLED === 'true'

  // H-3: short-circuit con flag OFF — sin side effects (no PK load, no fetch).
  if (!enabled) {
    return {
      enabled: false,
      network: 'kite-testnet',
      supportedToken: null,
      operatorAddress: null,
    }
  }

  let operatorAddress: `0x${string}` | null = null
  const pk = process.env.OPERATOR_PRIVATE_KEY
  if (pk) {
    try {
      operatorAddress = privateKeyToAccount(pk as `0x${string}`).address
    } catch {
      operatorAddress = null
    }
  }

  let supportedToken: GaslessSupportedToken | null = null
  try {
    supportedToken = await getSupportedToken()
  } catch {
    supportedToken = null
  }

  return {
    enabled,
    network: 'kite-testnet',
    supportedToken,
    operatorAddress,
  }
}

/**
 * Reset de singletons para tests.
 * @internal
 */
export function _resetGaslessSigner(): void {
  _walletClient = null
  _tokenCache = null
}
