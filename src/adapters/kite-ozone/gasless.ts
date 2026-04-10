import { createWalletClient, http, parseSignature } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { randomBytes } from 'node:crypto'
import { kiteTestnet } from './chain.js'
import { getClient, requireClient } from './client.js'
import type { GaslessAdapter, GaslessTransferAdapterRequest, GaslessAdapterResult, GaslessAdapterStatus } from '../types.js'
import type { GaslessSupportedToken, GaslessFundingState } from '../../types/index.js'

const GASLESS_BASE_URL = 'https://gasless.gokite.ai'
const GASLESS_SUBMIT_URL = `${GASLESS_BASE_URL}/testnet`
const GASLESS_TOKENS_URL = `${GASLESS_BASE_URL}/supported_tokens`
const VALIDITY_WINDOW_SECONDS = 25n
const FALLBACK_TOKEN: GaslessSupportedToken = { network: 'testnet', symbol: 'PYUSD', address: '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9', decimals: 18, eip712Name: 'PYUSD', eip712Version: '1', minimumTransferAmount: '10000000000000000' }
const EIP3009_TYPES = { TransferWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] } as const

let _walletClient: ReturnType<typeof createWalletClient> | null = null
let _tokenCache: GaslessSupportedToken | null = null

function getWalletClient() {
  if (_walletClient) return _walletClient
  const pk = process.env.OPERATOR_PRIVATE_KEY
  if (!pk) throw new Error('OPERATOR_PRIVATE_KEY is required for gasless signer')
  const account = privateKeyToAccount(pk as `0x${string}`)
  _walletClient = createWalletClient({ account, chain: kiteTestnet, transport: http(process.env.KITE_RPC_URL) })
  return _walletClient
}

function buildDomain(token: GaslessSupportedToken) {
  return { name: token.eip712Name, version: token.eip712Version, chainId: kiteTestnet.id, verifyingContract: token.address } as const
}

function generateNonce(): `0x${string}` { return `0x${randomBytes(32).toString('hex')}` as `0x${string}` }
function assertMinimumValue(value: bigint, token: GaslessSupportedToken): void { if (value < BigInt(token.minimumTransferAmount)) throw new Error('value below minimum_transfer_amount') }
function sanitizeError(err: unknown): string { return err instanceof Error ? err.message.substring(0, 120) : 'unknown error' }

interface RawTokenEntry { address?: string; decimals?: number; eip712_name?: string; eip712_version?: string; minimum_transfer_amount?: string; symbol?: string }

function parseTestnetToken(raw: unknown): GaslessSupportedToken | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as { testnet?: unknown }
  if (!Array.isArray(obj.testnet) || obj.testnet.length === 0) return null
  const entry = obj.testnet[0] as RawTokenEntry
  if (typeof entry.address !== 'string' || typeof entry.decimals !== 'number' || typeof entry.eip712_name !== 'string' || typeof entry.eip712_version !== 'string' || typeof entry.minimum_transfer_amount !== 'string' || typeof entry.symbol !== 'string') return null
  return { network: 'testnet', symbol: entry.symbol, address: entry.address as `0x${string}`, decimals: entry.decimals, eip712Name: entry.eip712_name, eip712Version: entry.eip712_version, minimumTransferAmount: entry.minimum_transfer_amount }
}

export async function getSupportedToken(): Promise<GaslessSupportedToken> {
  if (_tokenCache) return _tokenCache
  try {
    const res = await fetch(GASLESS_TOKENS_URL, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) { _tokenCache = FALLBACK_TOKEN; return _tokenCache }
    const json = (await res.json()) as unknown
    const parsed = parseTestnetToken(json)
    _tokenCache = parsed ?? FALLBACK_TOKEN
    return _tokenCache
  } catch { _tokenCache = FALLBACK_TOKEN; return _tokenCache }
}

export async function signTransferWithAuthorization(opts: { to: `0x${string}`; value: bigint }) {
  const token = await getSupportedToken()
  assertMinimumValue(opts.value, token)
  const block = await requireClient().getBlock({ blockTag: 'latest' })
  const blockTs = block.timestamp
  const validAfter = blockTs - 1n
  const validBefore = validAfter + VALIDITY_WINDOW_SECONDS
  const client = getWalletClient()
  const account = client.account!
  const nonce = generateNonce()
  const signature = await client.signTypedData({ account, domain: buildDomain(token), types: EIP3009_TYPES, primaryType: 'TransferWithAuthorization', message: { from: account.address, to: opts.to, value: opts.value, validAfter, validBefore, nonce } })
  const parsed = parseSignature(signature)
  const v = parsed.v !== undefined ? Number(parsed.v) : Number(parsed.yParity) + 27
  return { from: account.address, to: opts.to, value: opts.value.toString(), validAfter: validAfter.toString(), validBefore: validBefore.toString(), tokenAddress: token.address, nonce, v, r: parsed.r, s: parsed.s }
}

export async function submitGaslessTransfer(payload: { from: `0x${string}`; to: `0x${string}`; value: string; validAfter: string; validBefore: string; tokenAddress: `0x${string}`; nonce: `0x${string}`; v: number; r: `0x${string}`; s: `0x${string}` }): Promise<{ txHash: `0x${string}` }> {
  let res: Response
  try { res = await fetch(GASLESS_SUBMIT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) }) }
  catch (err) { throw new Error(`gasless submit failed: ${sanitizeError(err)}`) }
  if (!res.ok) throw new Error(`gasless submit failed: ${res.status} ${res.statusText ?? ''}`.trim())
  const json = (await res.json()) as { txHash?: string }
  if (typeof json.txHash !== 'string' || !json.txHash.startsWith('0x')) throw new Error('gasless submit failed: invalid response')
  return { txHash: json.txHash as `0x${string}` }
}

async function getOperatorTokenBalance(operatorAddress: `0x${string}`, tokenAddress: `0x${string}`): Promise<bigint | null> {
  try {
    const client = getClient()
    if (!client) return null
    const balance = await client.readContract({ address: tokenAddress, abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }] as const, functionName: 'balanceOf', args: [operatorAddress] })
    return balance
  } catch { return null }
}

function computeFundingState(opts: { enabled: boolean; operatorAddress: `0x${string}` | null; balance: bigint | null }): GaslessFundingState {
  if (!opts.enabled) return 'disabled'
  if (!opts.operatorAddress) return 'unconfigured'
  if (opts.balance === null || opts.balance === 0n) return 'unfunded'
  return 'ready'
}

export class KiteOzoneGaslessAdapter implements GaslessAdapter {
  readonly name = 'kite-ozone'
  readonly chainId = 2368

  async transfer(req: GaslessTransferAdapterRequest): Promise<GaslessAdapterResult> {
    const payload = await signTransferWithAuthorization({ to: req.to, value: req.value })
    const result = await submitGaslessTransfer(payload)
    return { txHash: result.txHash }
  }

  async status(): Promise<GaslessAdapterStatus> {
    const enabled = process.env.GASLESS_ENABLED === 'true'
    const baseFields = { network: 'kite-testnet' as const, chain_id: kiteTestnet.id, relayer: GASLESS_BASE_URL, documentation: 'https://github.com/ferrosasfp/wasiai-a2a/blob/main/doc/architecture/CHAIN-ADAPTIVE.md' }
    if (!enabled) return { enabled: false, ...baseFields, supportedToken: null, operatorAddress: null, funding_state: 'disabled' }
    let operatorAddress: `0x${string}` | null = null
    const pk = process.env.OPERATOR_PRIVATE_KEY
    if (pk) { try { operatorAddress = privateKeyToAccount(pk as `0x${string}`).address } catch { operatorAddress = null } }
    let supportedToken: GaslessSupportedToken | null = null
    try { supportedToken = await getSupportedToken() } catch { supportedToken = null }
    let balance: bigint | null = null
    if (operatorAddress && supportedToken) balance = await getOperatorTokenBalance(operatorAddress, supportedToken.address)
    const funding_state = computeFundingState({ enabled, operatorAddress, balance })
    return { enabled, ...baseFields, supportedToken, operatorAddress, funding_state }
  }
}

export async function getGaslessStatus() { const adapter = new KiteOzoneGaslessAdapter(); return adapter.status() }
export function _resetGaslessSigner(): void { _walletClient = null; _tokenCache = null }
