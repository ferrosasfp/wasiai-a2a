/**
 * Contract tests for KiteOzoneGaslessAdapter
 *
 * Verifies the adapter implements GaslessAdapter interface
 * with correct shape and WKH-38 degradation states.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock kite client
const mockGetBlock = vi.fn()
const mockReadContract = vi.fn()
vi.mock('../../adapters/kite-ozone/client.js', () => ({
  requireClient: () => ({ getBlock: mockGetBlock }),
  getClient: () => ({ readContract: mockReadContract }),
}))

// Mock fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { KiteOzoneGaslessAdapter, _resetGaslessSigner } from '../../adapters/kite-ozone/gasless.js'
import type { GaslessAdapter } from '../../adapters/types.js'

const TESTNET_RAW = {
  testnet: [{
    address: '0x8E04D099b1a8Dd20E6caD4b2Ab2B405B98242ec9',
    decimals: 18,
    eip712_name: 'PYUSD',
    eip712_version: '1',
    minimum_transfer_amount: '10000000000000000',
    symbol: 'PYUSD',
  }],
}

function mockFetchOk(json: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true, status: 200, statusText: 'OK',
    json: async () => json,
    text: async () => JSON.stringify(json),
  })
}

describe('KiteOzoneGaslessAdapter', () => {
  let adapter: GaslessAdapter
  const TEST_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
  let origPk: string | undefined
  let origEnabled: string | undefined

  beforeEach(() => {
    adapter = new KiteOzoneGaslessAdapter()
    _resetGaslessSigner()
    vi.clearAllMocks()
    mockGetBlock.mockReset()
    mockReadContract.mockReset()
    origPk = process.env.OPERATOR_PRIVATE_KEY
    origEnabled = process.env.GASLESS_ENABLED
    process.env.OPERATOR_PRIVATE_KEY = TEST_PK
  })

  afterEach(() => {
    if (origPk !== undefined) process.env.OPERATOR_PRIVATE_KEY = origPk
    else delete process.env.OPERATOR_PRIVATE_KEY
    if (origEnabled !== undefined) process.env.GASLESS_ENABLED = origEnabled
    else delete process.env.GASLESS_ENABLED
  })

  it('implements GaslessAdapter with name "kite-ozone"', () => {
    expect(adapter.name).toBe('kite-ozone')
  })

  it('has chainId 2368', () => {
    expect(adapter.chainId).toBe(2368)
  })

  it('transfer() returns GaslessAdapterResult shape', async () => {
    vi.stubGlobal('fetch', mockFetchOk(TESTNET_RAW))
    mockGetBlock.mockResolvedValue({ timestamp: 1700000000n })

    // First call: getSupportedToken (mocked above)
    // Second call: submitGaslessTransfer
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', json: async () => TESTNET_RAW, text: async () => '' })
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK', json: async () => ({ txHash: '0xdeadbeef' }), text: async () => '' })
    vi.stubGlobal('fetch', fetchImpl)

    const result = await adapter.transfer({
      to: '0x000000000000000000000000000000000000dEaD' as `0x${string}`,
      value: 20000000000000000n,
    })

    expect(result).toHaveProperty('txHash')
    expect(result.txHash).toMatch(/^0x/)
  })

  it('status() returns GaslessAdapterStatus shape', async () => {
    delete process.env.GASLESS_ENABLED
    const result = await adapter.status()

    expect(result).toHaveProperty('enabled')
    expect(result).toHaveProperty('network')
    expect(result).toHaveProperty('supportedToken')
    expect(result).toHaveProperty('operatorAddress')
    expect(result).toHaveProperty('funding_state')
  })

  // WKH-38 degradation states
  it('status() returns "disabled" when GASLESS_ENABLED is falsy', async () => {
    delete process.env.GASLESS_ENABLED
    const s = await adapter.status()
    expect(s.funding_state).toBe('disabled')
    expect(s.enabled).toBe(false)
  })

  it('status() returns "unconfigured" when PK is absent', async () => {
    vi.stubGlobal('fetch', mockFetchOk(TESTNET_RAW))
    process.env.GASLESS_ENABLED = 'true'
    delete process.env.OPERATOR_PRIVATE_KEY

    const s = await adapter.status()
    expect(s.funding_state).toBe('unconfigured')
  })

  it('status() returns "unfunded" when PK valid but balance is 0', async () => {
    vi.stubGlobal('fetch', mockFetchOk(TESTNET_RAW))
    mockReadContract.mockResolvedValue(0n)
    process.env.GASLESS_ENABLED = 'true'

    const s = await adapter.status()
    expect(s.funding_state).toBe('unfunded')
  })

  it('status() returns "ready" when PK valid and balance > 0', async () => {
    vi.stubGlobal('fetch', mockFetchOk(TESTNET_RAW))
    mockReadContract.mockResolvedValue(20000000000000000n)
    process.env.GASLESS_ENABLED = 'true'

    const s = await adapter.status()
    expect(s.funding_state).toBe('ready')
  })
})
