/**
 * Tests for Compose Service — auth headers + x402 payment
 *
 * 9 tests: T-1 through T-9
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type {
  Agent,
  RegistryConfig,
  X402PaymentRequest,
} from '../types/index.js'

// ─── Mocks ───────────────────────────────────────────────────

// Mock registryService
vi.mock('./registry.js', () => ({
  registryService: {
    getEnabled: vi.fn(),
  },
}))

// Mock x402-signer
vi.mock('../lib/x402-signer.js', () => ({
  signX402Authorization: vi.fn(),
}))

// Mock settlePayment
vi.mock('../middleware/x402.js', () => ({
  settlePayment: vi.fn(),
}))

// Mock discoveryService
vi.mock('./discovery.js', () => ({
  discoveryService: {
    getAgent: vi.fn(),
    discover: vi.fn(),
  },
}))

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Import after mocks
import { composeService } from './compose.js'
import { registryService } from './registry.js'
import { signX402Authorization } from '../lib/x402-signer.js'
import { settlePayment } from '../middleware/x402.js'
import { discoveryService } from './discovery.js'

// ─── Fixtures ────────────────────────────────────────────────

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    slug: 'test-agent',
    description: 'A test agent',
    capabilities: ['test'],
    priceUsdc: 0,
    registry: 'test-registry',
    invokeUrl: 'https://example.com/invoke',
    metadata: {},
    ...overrides,
  }
}

function makeRegistry(overrides: Partial<RegistryConfig> = {}): RegistryConfig {
  return {
    id: 'reg-1',
    name: 'test-registry',
    discoveryEndpoint: 'https://example.com/discover',
    invokeEndpoint: 'https://example.com/invoke/{slug}',
    schema: {
      discovery: {},
      invoke: { method: 'POST' },
    },
    enabled: true,
    createdAt: new Date(),
    ...overrides,
  }
}

function mockFetchOk(data: unknown = { result: 'ok' }) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => data,
  })
}

function mockFetchError(status: number) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => ({ error: 'fail' }),
  })
}

// ─── Setup ───────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(discoveryService.getAgent).mockResolvedValue(null)
  vi.mocked(discoveryService.discover).mockResolvedValue({
    agents: [],
    total: 0,
    registries: [],
  })
})

// ─── Tests ───────────────────────────────────────────────────

describe('composeService.invokeAgent', () => {
  // T-1: Auth headers — bearer
  it('T-1: includes Bearer auth header from registry', async () => {
    const registry = makeRegistry({
      auth: { type: 'bearer', key: 'Authorization', value: 'test-token' },
    })
    vi.mocked(registryService.getEnabled).mockResolvedValue([registry])

    const agent = makeAgent({ priceUsdc: 0 })
    mockFetchOk()

    await composeService.invokeAgent(agent, { q: 'hello' })

    const callHeaders = mockFetch.mock.calls[0][1].headers as Record<string, string>
    expect(callHeaders['Authorization']).toBe('Bearer test-token')
    expect(callHeaders['X-Payment']).toBeUndefined()
  })

  // T-2: Auth headers — header type
  it('T-2: includes custom header auth from registry', async () => {
    const registry = makeRegistry({
      auth: { type: 'header', key: 'X-API-Key', value: 'abc123' },
    })
    vi.mocked(registryService.getEnabled).mockResolvedValue([registry])

    const agent = makeAgent({ priceUsdc: 0 })
    mockFetchOk()

    await composeService.invokeAgent(agent, { q: 'hello' })

    const callHeaders = mockFetch.mock.calls[0][1].headers as Record<string, string>
    expect(callHeaders['X-API-Key']).toBe('abc123')
  })

  // T-3: x402 payment — happy path
  it('T-3: generates X-Payment header and settles on success', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([])

    const mockPaymentRequest: X402PaymentRequest = {
      authorization: {
        from: '0xAAA',
        to: '0xBBB',
        value: '1000000000000000000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: '0x1234',
      },
      signature: '0xSIG',
      network: 'kite-testnet',
    }

    vi.mocked(signX402Authorization).mockResolvedValue({
      xPaymentHeader: 'base64mock',
      paymentRequest: mockPaymentRequest,
    })

    vi.mocked(settlePayment).mockResolvedValue({
      success: true,
      txHash: '0xDEADBEEF',
    })

    const agent = makeAgent({
      priceUsdc: 1.0,
      metadata: { payTo: '0xBBB' },
    })
    mockFetchOk()

    const result = await composeService.invokeAgent(agent, { q: 'hello' })

    // X-Payment header sent
    const callHeaders = mockFetch.mock.calls[0][1].headers as Record<string, string>
    expect(callHeaders['X-Payment']).toBe('base64mock')

    // Settle called
    expect(settlePayment).toHaveBeenCalledWith(mockPaymentRequest)

    // txHash returned
    expect(result.txHash).toBe('0xDEADBEEF')
    expect(result.output).toBe('ok')
  })

  // T-4: x402 — settle failure
  it('T-4: throws when settle fails', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([])
    vi.mocked(signX402Authorization).mockResolvedValue({
      xPaymentHeader: 'base64mock',
      paymentRequest: {
        authorization: {
          from: '0xAAA', to: '0xBBB', value: '1', validAfter: '0',
          validBefore: '9999999999', nonce: '0x1234',
        },
        signature: '0xSIG',
        network: 'kite-testnet',
      },
    })
    vi.mocked(settlePayment).mockResolvedValue({
      success: false,
      txHash: '',
      error: 'insufficient funds',
    })

    const agent = makeAgent({
      priceUsdc: 1.0,
      metadata: { payTo: '0xBBB' },
    })
    mockFetchOk()

    await expect(
      composeService.invokeAgent(agent, { q: 'hello' }),
    ).rejects.toThrow('x402 settle failed')
  })

  // T-5: agent returns non-2xx — no settle (CD-5)
  it('T-5: does not settle when agent returns non-2xx', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([])
    vi.mocked(signX402Authorization).mockResolvedValue({
      xPaymentHeader: 'base64mock',
      paymentRequest: {
        authorization: {
          from: '0xAAA', to: '0xBBB', value: '1', validAfter: '0',
          validBefore: '9999999999', nonce: '0x1234',
        },
        signature: '0xSIG',
        network: 'kite-testnet',
      },
    })

    const agent = makeAgent({
      priceUsdc: 1.0,
      metadata: { payTo: '0xBBB' },
    })
    mockFetchError(500)

    await expect(
      composeService.invokeAgent(agent, { q: 'hello' }),
    ).rejects.toThrow('returned 500')

    expect(settlePayment).not.toHaveBeenCalled()
  })

  // T-6: No registry found — still invokes without auth headers
  it('T-6: invokes without auth headers when registry not found', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([])

    const agent = makeAgent({ priceUsdc: 0 })
    mockFetchOk()

    const result = await composeService.invokeAgent(agent, { q: 'hello' })

    const callHeaders = mockFetch.mock.calls[0][1].headers as Record<string, string>
    expect(callHeaders['Content-Type']).toBe('application/json')
    expect(callHeaders['Authorization']).toBeUndefined()
    expect(result.output).toBe('ok')
  })

  // T-7: Budget check with priceUsdc (regression)
  it('T-7: budget check rejects when cost exceeds maxBudget', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([])

    const agent1 = makeAgent({ slug: 'a1', priceUsdc: 0.5, metadata: { payTo: '0xPAY' } })
    const agent2 = makeAgent({ slug: 'a2', priceUsdc: 0.6, metadata: { payTo: '0xPAY' } })

    vi.mocked(discoveryService.getAgent)
      .mockResolvedValueOnce(agent1)
      .mockResolvedValueOnce(agent2)

    // Need to sign x402 for agent1 (priceUsdc > 0)
    vi.mocked(signX402Authorization).mockResolvedValue({
      xPaymentHeader: 'base64mock',
      paymentRequest: {
        authorization: { from: '0xAAA', to: '0xPAY', value: '1', validAfter: '0', validBefore: '9999999999', nonce: '0x1234' },
        signature: '0xSIG',
        network: 'kite-testnet',
      },
    })
    vi.mocked(settlePayment).mockResolvedValue({ success: true, txHash: '0xTX' })

    // Mock invokeAgent fetch for step 1 only (step 2 should be budget-rejected)
    mockFetchOk({ result: 'step1-done' })

    const result = await composeService.compose({
      steps: [
        { agent: 'a1', input: {} },
        { agent: 'a2', input: {} },
      ],
      maxBudget: 1.0,
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Budget exceeded')
    expect(result.steps).toHaveLength(1)
  })

  // T-8: payTo missing → error (CD-9)
  it('T-8: throws when agent.metadata.payTo is missing', async () => {
    vi.mocked(registryService.getEnabled).mockResolvedValue([])

    const agent = makeAgent({
      priceUsdc: 1.0,
      metadata: {}, // no payTo!
    })

    await expect(
      composeService.invokeAgent(agent, { q: 'hello' }),
    ).rejects.toThrow('No payTo address')
  })

  // T-9: Private key / signature never logged (CD-1)
  it('T-9: console.log never receives private key or raw signature', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    vi.mocked(registryService.getEnabled).mockResolvedValue([])
    vi.mocked(signX402Authorization).mockResolvedValue({
      xPaymentHeader: 'base64mock',
      paymentRequest: {
        authorization: {
          from: '0xAAA', to: '0xBBB', value: '1', validAfter: '0',
          validBefore: '9999999999', nonce: '0x1234',
        },
        signature: '0xSECRET_SIG_VALUE',
        network: 'kite-testnet',
      },
    })
    vi.mocked(settlePayment).mockResolvedValue({
      success: true,
      txHash: '0xTXHASH',
    })

    const agent = makeAgent({
      priceUsdc: 1.0,
      metadata: { payTo: '0xBBB' },
    })
    mockFetchOk()

    // Set a fake private key in env
    const originalPK = process.env.OPERATOR_PRIVATE_KEY
    process.env.OPERATOR_PRIVATE_KEY = '0xDEAD_PRIVATE_KEY_NEVER_LOG'

    try {
      await composeService.invokeAgent(agent, { q: 'hello' })
    } finally {
      process.env.OPERATOR_PRIVATE_KEY = originalPK
    }

    // Check no log call contains private key or raw signature
    for (const call of logSpy.mock.calls) {
      const logStr = call.join(' ')
      expect(logStr).not.toContain('DEAD_PRIVATE_KEY_NEVER_LOG')
      expect(logStr).not.toContain('SECRET_SIG_VALUE')
    }

    logSpy.mockRestore()
  })
})
