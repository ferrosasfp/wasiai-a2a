/**
 * Tests for Orchestrate Service — WKH-13
 *
 * Tests: T-1 through T-5
 * Covers: orchestrationId, protocolFeeUsdc, steps, timeout, attestation fallback
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Agent, ComposeResult } from '../types/index.js'

// ─── Mocks ────────────────────────────────────────────────────

vi.mock('./discovery.js', () => ({
  discoveryService: {
    discover: vi.fn(),
  },
}))

vi.mock('./compose.js', () => ({
  composeService: {
    compose: vi.fn(),
  },
}))

vi.mock('../lib/kite-attestation.js', () => ({
  attestOrchestration: vi.fn(),
  computePipelineHash: vi.fn().mockReturnValue('0xdeadbeef'),
}))

// ─── Test data ────────────────────────────────────────────────

const mockAgent: Agent = {
  id: 'agent-1',
  name: 'Token Analyzer',
  slug: 'token-analyzer',
  description: 'Analyzes ERC-20 tokens',
  capabilities: ['token-analysis'],
  priceUsdc: 0.01,
  registry: 'mock-registry',
  invokeUrl: 'https://example.com/invoke',
}

const mockPipeline: ComposeResult = {
  success: true,
  output: { analysis: 'Token 0xABC is a valid ERC-20 token' },
  steps: [
    {
      agent: mockAgent,
      output: { analysis: 'Token 0xABC is a valid ERC-20 token' },
      costUsdc: 0.01,
      latencyMs: 100,
      txHash: '0xabc123',
    },
  ],
  totalCostUsdc: 0.01,
  totalLatencyMs: 100,
}

// ─── Tests ────────────────────────────────────────────────────

describe('orchestrateService (WKH-13)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('T-1: orchestrate() retorna orchestrationId UUID válido', async () => {
    const { discoveryService } = await import('./discovery.js')
    const { composeService } = await import('./compose.js')
    const { attestOrchestration } = await import('../lib/kite-attestation.js')

    vi.mocked(discoveryService.discover).mockResolvedValue({ agents: [mockAgent], total: 1, registries: ["mock-registry"] })
    vi.mocked(composeService.compose).mockResolvedValue(mockPipeline)
    vi.mocked(attestOrchestration).mockResolvedValue('0xtxhash123')

    const { orchestrateService } = await import('./orchestrate.js')

    const result = await orchestrateService.orchestrate({
      goal: 'Analyze token 0xABC',
      budget: 1,
    })

    expect(result.orchestrationId).toBeDefined()
    expect(result.orchestrationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
  })

  it('T-2: protocolFeeUsdc es exactamente 1% de totalCostUsdc', async () => {
    const { discoveryService } = await import('./discovery.js')
    const { composeService } = await import('./compose.js')
    const { attestOrchestration } = await import('../lib/kite-attestation.js')

    vi.mocked(discoveryService.discover).mockResolvedValue({ agents: [mockAgent], total: 1, registries: ["mock-registry"] })
    vi.mocked(composeService.compose).mockResolvedValue({ ...mockPipeline, totalCostUsdc: 1.5 })
    vi.mocked(attestOrchestration).mockResolvedValue('0xtxhash123')

    const { orchestrateService } = await import('./orchestrate.js')

    const result = await orchestrateService.orchestrate({
      goal: 'Analyze token 0xABC',
      budget: 5,
    })

    expect(result.totalCostUsdc).toBe(1.5)
    expect(result.protocolFeeUsdc).toBeCloseTo(0.015)
  })

  it('T-3: response incluye steps del pipeline', async () => {
    const { discoveryService } = await import('./discovery.js')
    const { composeService } = await import('./compose.js')
    const { attestOrchestration } = await import('../lib/kite-attestation.js')

    vi.mocked(discoveryService.discover).mockResolvedValue({ agents: [mockAgent], total: 1, registries: ["mock-registry"] })
    vi.mocked(composeService.compose).mockResolvedValue(mockPipeline)
    vi.mocked(attestOrchestration).mockResolvedValue('0xtxhash123')

    const { orchestrateService } = await import('./orchestrate.js')

    const result = await orchestrateService.orchestrate({
      goal: 'Analyze token 0xABC',
      budget: 1,
    })

    expect(result.steps).toBeDefined()
    expect(Array.isArray(result.steps)).toBe(true)
    expect(result.steps.length).toBe(1)
    expect(result.steps[0].costUsdc).toBe(0.01)
  })

  it('T-4: timeout lanza error ORCHESTRATION_TIMEOUT', async () => {
    const { orchestrateService } = await import('./orchestrate.js')

    // Mock _runPipeline para que nunca resuelva
    vi.spyOn(orchestrateService, '_runPipeline').mockImplementation(
      () => new Promise(() => {}), // Never resolves
    )

    // Usar timeout muy corto para el test
    const originalRace = Promise.race.bind(Promise)
    vi.spyOn(Promise, 'race').mockImplementationOnce((promises) => {
      // Inyectar timeout de 10ms en lugar de 120s
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(Object.assign(new Error('Orchestration timeout: exceeded 120s'), { code: 'ORCHESTRATION_TIMEOUT' })),
          10,
        ),
      )
      return originalRace([...(promises as Promise<unknown>[]), timeout])
    })

    await expect(
      orchestrateService.orchestrate({ goal: 'test', budget: 1 }),
    ).rejects.toMatchObject({
      message: 'Orchestration timeout: exceeded 120s',
      code: 'ORCHESTRATION_TIMEOUT',
    })
  })

  it('T-5: attestation falla → orquestación igual exitosa, attestationTxHash undefined', async () => {
    vi.restoreAllMocks()

    const { discoveryService } = await import('./discovery.js')
    const { composeService } = await import('./compose.js')
    const { attestOrchestration } = await import('../lib/kite-attestation.js')

    vi.mocked(discoveryService.discover).mockResolvedValue({ agents: [mockAgent], total: 1, registries: ["mock-registry"] })
    vi.mocked(composeService.compose).mockResolvedValue(mockPipeline)
    vi.mocked(attestOrchestration).mockResolvedValue(null) // Attestation falla → null

    const { orchestrateService } = await import('./orchestrate.js')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (orchestrateService as any)._runPipeline(crypto.randomUUID(), {
      goal: 'Analyze token 0xABC',
      budget: 1,
    })

    // Orquestación exitosa a pesar de attestation fallida
    expect(result.orchestrationId).toBeDefined()
    expect(result.totalCostUsdc).toBe(0.01)
    expect(result.attestationTxHash).toBeUndefined()
  })
})
