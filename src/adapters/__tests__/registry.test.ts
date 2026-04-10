/**
 * Registry tests -- adapter resolution
 *
 * Verifies WASIAI_A2A_CHAIN env var handling, init lifecycle,
 * and getChainConfig output.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the kite-ozone factory to avoid real client init
vi.mock('../kite-ozone/index.js', () => ({
  createKiteOzoneAdapters: vi.fn().mockResolvedValue({
    payment: { name: 'kite-ozone', chainId: 2368 },
    attestation: { name: 'kite-ozone', chainId: 2368 },
    gasless: { name: 'kite-ozone', chainId: 2368 },
    identity: null,
    chainConfig: { name: 'KiteAI Testnet', chainId: 2368, explorerUrl: 'https://testnet.kitescan.ai' },
  }),
}))

import {
  initAdapters,
  getPaymentAdapter,
  getAttestationAdapter,
  getGaslessAdapter,
  getIdentityBindingAdapter,
  getChainConfig,
  _resetRegistry,
} from '../registry.js'

describe('adapter registry', () => {
  beforeEach(() => {
    _resetRegistry()
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    delete process.env.WASIAI_A2A_CHAIN
  })

  it('default WASIAI_A2A_CHAIN resolves to kite-ozone adapters', async () => {
    await initAdapters()

    const adapter = getPaymentAdapter()
    expect(adapter.name).toBe('kite-ozone')
    expect(adapter.chainId).toBe(2368)
  })

  it('unsupported chain throws error listing supported chains', async () => {
    process.env.WASIAI_A2A_CHAIN = 'ethereum-mainnet'

    await expect(initAdapters()).rejects.toThrow(
      "Unsupported chain 'ethereum-mainnet'. Supported: kite-ozone-testnet"
    )
  })

  it('getChainConfig() returns { name, chainId, explorerUrl }', async () => {
    await initAdapters()

    const config = getChainConfig()
    expect(config).toHaveProperty('name')
    expect(config).toHaveProperty('chainId')
    expect(config).toHaveProperty('explorerUrl')
    expect(config.chainId).toBe(2368)
    expect(config.name).toBe('KiteAI Testnet')
  })

  it('get*Adapter() throws if initAdapters() not called', () => {
    expect(() => getPaymentAdapter()).toThrow('Adapters not initialized')
    expect(() => getAttestationAdapter()).toThrow('Adapters not initialized')
    expect(() => getGaslessAdapter()).toThrow('Adapters not initialized')
    expect(() => getChainConfig()).toThrow('Adapters not initialized')
  })

  it('getIdentityBindingAdapter() throws not implemented for kite-ozone', async () => {
    await initAdapters()

    expect(() => getIdentityBindingAdapter()).toThrow(
      'IdentityBindingAdapter not implemented for kite-ozone-testnet'
    )
  })
})
