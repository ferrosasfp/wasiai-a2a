/**
 * Tests — gasless-signer (WKH-29)
 *
 * PK determinista publica de test (NO usar en produccion).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// PK determinista — debe estar en env ANTES del primer import del modulo bajo test
const TEST_PK =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
process.env.OPERATOR_PRIVATE_KEY = TEST_PK
process.env.KITE_RPC_URL = process.env.KITE_RPC_URL ?? 'https://rpc-testnet.gokite.ai/'

// Mock kite-client: requireKiteClient for signing, kiteClient for balance reads
// vi.hoisted ensures these are available when vi.mock factory runs (hoisted above imports)
const { mockGetBlock, mockReadContract } = vi.hoisted(() => ({
  mockGetBlock: vi.fn(),
  mockReadContract: vi.fn(),
}))
vi.mock('../services/kite-client.js', () => ({
  requireKiteClient: () => ({ getBlock: mockGetBlock }),
  kiteClient: { readContract: mockReadContract },
}))

import {
  getSupportedToken,
  signTransferWithAuthorization,
  submitGaslessTransfer,
  getGaslessStatus,
  _resetGaslessSigner,
} from './gasless-signer.js'

const TESTNET_RAW = {
  testnet: [
    {
      address: '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9',
      decimals: 18,
      eip712_name: 'PYUSD',
      eip712_version: '1',
      minimum_transfer_amount: '10000000000000000',
      symbol: 'PYUSD',
    },
  ],
}

function mockFetchOk(json: unknown): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => json,
    text: async () => JSON.stringify(json),
  })
}

describe('gasless-signer', () => {
  beforeEach(() => {
    _resetGaslessSigner()
    vi.restoreAllMocks()
    mockGetBlock.mockReset()
    mockReadContract.mockReset()
  })

  // ─── getSupportedToken ───────────────────────────────────

  it('should cache getSupportedToken result on second call', async () => {
    const fetchMock = mockFetchOk(TESTNET_RAW)
    vi.stubGlobal('fetch', fetchMock)

    const a = await getSupportedToken()
    const b = await getSupportedToken()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(a.symbol).toBe('PYUSD')
  })

  it('should fall back to PYUSD when fetch rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network down')),
    )

    const t = await getSupportedToken()
    expect(t.symbol).toBe('PYUSD')
    expect(t.address).toBe('0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9')
  })

  it('should fall back when fetch returns non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: async () => ({}),
        text: async () => '',
      }),
    )

    const t = await getSupportedToken()
    expect(t.symbol).toBe('PYUSD')
    expect(t.address).toBe('0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9')
  })

  // ─── signTransferWithAuthorization ───────────────────────

  it('should set validAfter = blockTs - 1 and validBefore = validAfter + 25', async () => {
    vi.stubGlobal('fetch', mockFetchOk(TESTNET_RAW))
    mockGetBlock.mockResolvedValue({ timestamp: 1700000000n })

    const r = await signTransferWithAuthorization({
      to: '0x000000000000000000000000000000000000dEaD',
      value: 20000000000000000n,
    })

    expect(r.validAfter).toBe('1699999999')
    expect(r.validBefore).toBe('1700000024')
  })

  it('should reject when value < minimumTransferAmount', async () => {
    vi.stubGlobal('fetch', mockFetchOk(TESTNET_RAW))
    mockGetBlock.mockResolvedValue({ timestamp: 1700000000n })

    await expect(
      signTransferWithAuthorization({
        to: '0x000000000000000000000000000000000000dEaD',
        value: 1n,
      }),
    ).rejects.toThrow(/minimum_transfer_amount/)
  })

  it('should decompose signature into valid v/r/s recoverable by signer', async () => {
    vi.stubGlobal('fetch', mockFetchOk(TESTNET_RAW))
    mockGetBlock.mockResolvedValue({ timestamp: 1700000000n })

    const r = await signTransferWithAuthorization({
      to: '0x000000000000000000000000000000000000dEaD',
      value: 20000000000000000n,
    })

    // H-19: v debe ser numero finito y EIP-155-legacy (27 o 28), no NaN.
    expect(typeof r.v).toBe('number')
    expect(Number.isFinite(r.v)).toBe(true)
    expect([27, 28]).toContain(r.v)

    // r y s son hex strings de 66 chars (0x + 64).
    expect(r.r).toMatch(/^0x[0-9a-f]{64}$/)
    expect(r.s).toMatch(/^0x[0-9a-f]{64}$/)
    expect(r.nonce.length).toBe(66)

    // Reconstruimos la firma y verificamos contra la address del signer.
    const { recoverTypedDataAddress, serializeSignature } = await import('viem')
    const { privateKeyToAccount } = await import('viem/accounts')
    const expected = privateKeyToAccount(TEST_PK as `0x${string}`).address

    const sig = serializeSignature({
      r: r.r as `0x${string}`,
      s: r.s as `0x${string}`,
      v: BigInt(r.v),
    })

    const recovered = await recoverTypedDataAddress({
      domain: {
        name: 'PYUSD',
        version: '1',
        chainId: 2368,
        verifyingContract: r.tokenAddress as `0x${string}`,
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
        from: r.from as `0x${string}`,
        to: r.to as `0x${string}`,
        value: BigInt(r.value),
        validAfter: BigInt(r.validAfter),
        validBefore: BigInt(r.validBefore),
        nonce: r.nonce as `0x${string}`,
      },
      signature: sig,
    })

    expect(recovered.toLowerCase()).toBe(expected.toLowerCase())
  })

  // ─── submitGaslessTransfer ───────────────────────────────

  it('should return txHash from submitGaslessTransfer on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ txHash: '0xdeadbeef' }),
        text: async () => '',
      }),
    )

    const r = await submitGaslessTransfer({
      from: '0x0000000000000000000000000000000000000001',
      to: '0x0000000000000000000000000000000000000002',
      value: '20000000000000000',
      validAfter: '1699999999',
      validBefore: '1700000024',
      tokenAddress: '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9',
      nonce: `0x${'00'.repeat(32)}`,
      v: 27,
      r: `0x${'11'.repeat(32)}`,
      s: `0x${'22'.repeat(32)}`,
    })

    expect(r.txHash).toBe('0xdeadbeef')
  })

  it('should throw sanitized error on 5xx without leaking body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal',
        json: async () => ({}),
        text: async () => 'SECRET_BODY',
      }),
    )

    await expect(
      submitGaslessTransfer({
        from: '0x0000000000000000000000000000000000000001',
        to: '0x0000000000000000000000000000000000000002',
        value: '20000000000000000',
        validAfter: '1699999999',
        validBefore: '1700000024',
        tokenAddress: '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9',
        nonce: `0x${'00'.repeat(32)}`,
        v: 27,
        r: `0x${'11'.repeat(32)}`,
        s: `0x${'22'.repeat(32)}`,
      }),
    ).rejects.toThrow(/500/)

    // Verifica que el mensaje sanitizado NO contiene el body secreto
    try {
      await submitGaslessTransfer({
        from: '0x0000000000000000000000000000000000000001',
        to: '0x0000000000000000000000000000000000000002',
        value: '20000000000000000',
        validAfter: '1699999999',
        validBefore: '1700000024',
        tokenAddress: '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9',
        nonce: `0x${'00'.repeat(32)}`,
        v: 27,
        r: `0x${'11'.repeat(32)}`,
        s: `0x${'22'.repeat(32)}`,
      })
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRET_BODY')
    }
  })

  // ─── getGaslessStatus (WKH-38 funding_state) ─────────────

  it('AC-6: should return funding_state "disabled" when GASLESS_ENABLED is falsy', async () => {
    const prev = process.env.GASLESS_ENABLED
    delete process.env.GASLESS_ENABLED

    const s = await getGaslessStatus()

    process.env.GASLESS_ENABLED = prev

    expect(s.enabled).toBe(false)
    expect(s.funding_state).toBe('disabled')
    expect(s.operatorAddress).toBeNull()
    expect(s.supportedToken).toBeNull()
    // Enrichment fields present
    expect(s.chain_id).toBe(2368)
    expect(s.relayer).toBeTruthy()
    expect(s.documentation).toBeTruthy()
  })

  it('AC-1: should return funding_state "unconfigured" when PK is absent', async () => {
    vi.stubGlobal('fetch', mockFetchOk(TESTNET_RAW))
    const prevEnabled = process.env.GASLESS_ENABLED
    const prevPk = process.env.OPERATOR_PRIVATE_KEY
    process.env.GASLESS_ENABLED = 'true'
    delete process.env.OPERATOR_PRIVATE_KEY

    const s = await getGaslessStatus()

    process.env.GASLESS_ENABLED = prevEnabled
    process.env.OPERATOR_PRIVATE_KEY = prevPk

    expect(s.enabled).toBe(true)
    expect(s.funding_state).toBe('unconfigured')
    expect(s.operatorAddress).toBeNull()
  })

  it('AC-2: should return funding_state "unconfigured" when PK is malformed', async () => {
    vi.stubGlobal('fetch', mockFetchOk(TESTNET_RAW))
    const prevEnabled = process.env.GASLESS_ENABLED
    const prevPk = process.env.OPERATOR_PRIVATE_KEY
    process.env.GASLESS_ENABLED = 'true'
    process.env.OPERATOR_PRIVATE_KEY = 'not-a-valid-hex-key'

    const s = await getGaslessStatus()

    process.env.GASLESS_ENABLED = prevEnabled
    process.env.OPERATOR_PRIVATE_KEY = prevPk

    expect(s.enabled).toBe(true)
    expect(s.funding_state).toBe('unconfigured')
    expect(s.operatorAddress).toBeNull()
  })

  it('AC-3: should return funding_state "unfunded" when PK valid but balance is 0', async () => {
    vi.stubGlobal('fetch', mockFetchOk(TESTNET_RAW))
    mockReadContract.mockResolvedValue(0n)
    const prevEnabled = process.env.GASLESS_ENABLED
    process.env.GASLESS_ENABLED = 'true'

    const s = await getGaslessStatus()

    process.env.GASLESS_ENABLED = prevEnabled

    expect(s.enabled).toBe(true)
    expect(s.funding_state).toBe('unfunded')
    expect(s.operatorAddress).toBeTruthy()
  })

  it('AC-4: should return funding_state "ready" when PK valid and balance > 0', async () => {
    vi.stubGlobal('fetch', mockFetchOk(TESTNET_RAW))
    mockReadContract.mockResolvedValue(20000000000000000n) // 0.02 PYUSD
    const prevEnabled = process.env.GASLESS_ENABLED
    process.env.GASLESS_ENABLED = 'true'

    const s = await getGaslessStatus()

    process.env.GASLESS_ENABLED = prevEnabled

    expect(s.enabled).toBe(true)
    expect(s.funding_state).toBe('ready')
    expect(s.operatorAddress).toBeTruthy()
    expect(s.operatorAddress?.startsWith('0x')).toBe(true)
    expect(s.operatorAddress?.length).toBe(42)
  })

  it('AC-8: should never expose private key in any status response', async () => {
    vi.stubGlobal('fetch', mockFetchOk(TESTNET_RAW))
    mockReadContract.mockResolvedValue(20000000000000000n)
    const prevEnabled = process.env.GASLESS_ENABLED
    process.env.GASLESS_ENABLED = 'true'

    const s = await getGaslessStatus()

    process.env.GASLESS_ENABLED = prevEnabled

    const serialized = JSON.stringify(s)
    expect(serialized).not.toContain(TEST_PK)
    expect(serialized).not.toContain('privateKey')
    expect(serialized).not.toContain('OPERATOR_PRIVATE_KEY')
  })

  it('CD-3: getGaslessStatus never throws even when readContract fails', async () => {
    vi.stubGlobal('fetch', mockFetchOk(TESTNET_RAW))
    mockReadContract.mockRejectedValue(new Error('RPC down'))
    const prevEnabled = process.env.GASLESS_ENABLED
    process.env.GASLESS_ENABLED = 'true'

    // Must not throw -- CD-3
    const s = await getGaslessStatus()

    process.env.GASLESS_ENABLED = prevEnabled

    // Balance check failed → null → unfunded (safe state)
    expect(s.funding_state).toBe('unfunded')
  })

  it('AC-7: getGaslessStatus never throws at import time regardless of env state', async () => {
    // This test validates that getGaslessStatus itself never throws
    // even with unusual env combinations
    const prevEnabled = process.env.GASLESS_ENABLED
    const prevPk = process.env.OPERATOR_PRIVATE_KEY
    process.env.GASLESS_ENABLED = 'true'
    process.env.OPERATOR_PRIVATE_KEY = ''

    const s = await getGaslessStatus()

    process.env.GASLESS_ENABLED = prevEnabled
    process.env.OPERATOR_PRIVATE_KEY = prevPk

    expect(s.funding_state).toBe('unconfigured')
  })
})
