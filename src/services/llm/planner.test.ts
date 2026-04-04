/**
 * LLM Planner Unit Tests — WKH-10
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Agent } from '../../types/index.js'

// ── Mock @anthropic-ai/sdk BEFORE importing planner ─────────

const mockCreate = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  })),
}))

// ── Import planner after mocks ──────────────────────────────

import { planOrchestration } from './planner.js'

// ── Helpers ─────────────────────────────────────────────────

const mockAgents: Agent[] = [
  {
    id: '1',
    name: 'Token Analyzer',
    slug: 'token-analyzer',
    description: 'Analyzes token metrics on-chain',
    capabilities: ['token-analysis', 'market-data'],
    priceUsdc: 0.01,
    registry: 'wasiai',
    invokeUrl: 'https://example.com/invoke/token-analyzer',
  },
  {
    id: '2',
    name: 'Price Feed',
    slug: 'price-feed',
    description: 'Provides real-time token prices',
    capabilities: ['market-data', 'price-feed'],
    priceUsdc: 0.005,
    registry: 'wasiai',
    invokeUrl: 'https://example.com/invoke/price-feed',
  },
]

function mockLLMResponse(text: string) {
  mockCreate.mockResolvedValue({
    content: [{ type: 'text', text }],
  })
}

// ── Tests ────────────────────────────────────────────────────

describe('planOrchestration', () => {
  const originalEnv = process.env.ANTHROPIC_API_KEY

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ANTHROPIC_API_KEY
    } else {
      process.env.ANTHROPIC_API_KEY = originalEnv
    }
  })

  it('throws when ANTHROPIC_API_KEY is not set', async () => {
    delete process.env.ANTHROPIC_API_KEY
    await expect(planOrchestration('analiza token X', mockAgents, 1, 5)).rejects.toThrow(
      'ANTHROPIC_API_KEY not configured',
    )
  })

  it('returns steps and reasoning when LLM responds correctly', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    mockLLMResponse(JSON.stringify({
      steps: [
        { agent: 'price-feed', registry: 'wasiai', input: { goal: 'analiza token X' }, passOutput: false },
        { agent: 'token-analyzer', registry: 'wasiai', input: { goal: 'analiza token X' }, passOutput: true },
      ],
      reasoning: 'Price feed primero para obtener datos, luego análisis.',
    }))

    const result = await planOrchestration('analiza token X', mockAgents, 1, 5)

    expect(result).not.toHaveProperty('error')
    if (!('error' in result)) {
      expect(result.steps).toHaveLength(2)
      expect(result.steps[0].agent).toBe('price-feed')
      expect(result.reasoning).toContain('Price feed')
    }
  })

  it('returns missing_capabilities when LLM cannot build pipeline', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    mockLLMResponse(JSON.stringify({
      error: 'missing_capabilities',
      missingCapabilities: ['blockchain-analysis', 'defi-data'],
    }))

    const result = await planOrchestration('analiza defi protocol', mockAgents, 1, 5)

    expect(result).toMatchObject({
      error: 'missing_capabilities',
      missingCapabilities: expect.arrayContaining(['blockchain-analysis', 'defi-data']),
    })
  })

  it('throws when LLM returns empty steps array', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    mockLLMResponse(JSON.stringify({ steps: [], reasoning: 'nada' }))

    await expect(planOrchestration('analiza token X', mockAgents, 1, 5)).rejects.toThrow(
      'LLM returned empty steps',
    )
  })

  it('throws when LLM returns unknown agent slug', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    mockLLMResponse(JSON.stringify({
      steps: [{ agent: 'nonexistent-agent', registry: 'wasiai', input: {}, passOutput: false }],
      reasoning: 'test',
    }))

    await expect(planOrchestration('analiza token X', mockAgents, 1, 5)).rejects.toThrow(
      'unknown agent slug',
    )
  })

  it('throws when LLM returns invalid JSON', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    mockLLMResponse('this is not json { broken')

    await expect(planOrchestration('analiza token X', mockAgents, 1, 5)).rejects.toThrow()
  })
})
