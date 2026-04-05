/**
 * Tests for Orchestrate Service — LLM Planning + Fallback
 *
 * 10 tests: T-1 through T-10
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Agent, ComposeResult, DiscoveryResult } from '../types/index.js'

// ─── Shared mock for Anthropic ───────────────────────────────

const mockCreate = vi.fn()

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: { create: mockCreate },
    })),
  }
})

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

vi.mock('./event.js', () => ({
  eventService: {
    track: vi.fn().mockResolvedValue({}),
  },
}))

// ─── Imports (after mocks) ───────────────────────────────────

import { orchestrateService } from './orchestrate.js'
import { discoveryService } from './discovery.js'
import { composeService } from './compose.js'
import { eventService } from './event.js'

// ─── Fixtures ────────────────────────────────────────────────

const mockAgents: Agent[] = [
  {
    id: 'agent-1',
    name: 'Summarizer',
    slug: 'summarizer-v1',
    description: 'Summarizes text documents',
    capabilities: ['summarization', 'text-analysis'],
    priceUsdc: 0.50,
    reputation: 90,
    registry: 'wasiai',
    invokeUrl: 'https://example.com/invoke/summarizer-v1',
  },
  {
    id: 'agent-2',
    name: 'Translator',
    slug: 'translator-v1',
    description: 'Translates text between languages',
    capabilities: ['translation', 'nlp'],
    priceUsdc: 0.30,
    reputation: 85,
    registry: 'wasiai',
    invokeUrl: 'https://example.com/invoke/translator-v1',
  },
]

const mockDiscoveryResult: DiscoveryResult = {
  agents: mockAgents,
  total: 2,
  registries: ['wasiai'],
}

const mockComposeResult: ComposeResult = {
  success: true,
  output: 'Final summarized output',
  steps: [
    {
      agent: mockAgents[0],
      output: 'Summarized text',
      costUsdc: 0.50,
      latencyMs: 1200,
      txHash: '0xabc123',
    },
  ],
  totalCostUsdc: 0.50,
  totalLatencyMs: 1200,
}

function setLlmResponse(content: string) {
  mockCreate.mockResolvedValue({
    content: [{ type: 'text', text: content }],
  })
}

function setLlmError(error: Error) {
  mockCreate.mockRejectedValue(error)
}

// ─── Tests ───────────────────────────────────────────────────

describe('orchestrateService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.ANTHROPIC_API_KEY = 'test-key'
    vi.mocked(discoveryService.discover).mockResolvedValue(mockDiscoveryResult)
    vi.mocked(composeService.compose).mockResolvedValue(mockComposeResult)
  })

  // T-1: LLM happy path — inputs dinamicos
  it('T-1: uses LLM to plan pipeline with dynamic inputs', async () => {
    setLlmResponse(JSON.stringify({
      selectedAgents: [
        {
          slug: 'summarizer-v1',
          registry: 'wasiai',
          input: { query: 'Summarize the research paper on quantum computing' },
          reasoning: 'Best match for summarization goal',
        },
      ],
      reasoning: 'Selected summarizer for text analysis task',
    }))

    const result = await orchestrateService.orchestrate(
      { goal: 'Summarize a paper on quantum computing', budget: 5.0 },
      'test-orch-id-1',
    )

    expect(result.reasoning).toContain('summarizer')
    expect(result.answer).toBeDefined()

    // Verify compose was called with dynamic input from LLM
    const composeCall = vi.mocked(composeService.compose).mock.calls[0][0]
    expect(composeCall.steps[0].input).toHaveProperty('query')
  })

  // T-2: Response includes orchestrationId + protocolFeeUsdc
  it('T-2: response includes orchestrationId and protocolFeeUsdc', async () => {
    setLlmResponse(JSON.stringify({
      selectedAgents: [
        { slug: 'summarizer-v1', registry: 'wasiai', input: { query: 'test' }, reasoning: 'ok' },
      ],
      reasoning: 'Test plan',
    }))

    const result = await orchestrateService.orchestrate(
      { goal: 'test', budget: 5.0 },
      'orch-id-abc',
    )

    expect(result.orchestrationId).toBe('orch-id-abc')
    expect(result.protocolFeeUsdc).toBeCloseTo(0.50 * 0.01, 6) // 1% of 0.50
  })

  // T-3: No agents found returns answer:null
  it('T-3: no agents found returns answer null with reasoning', async () => {
    vi.mocked(discoveryService.discover).mockResolvedValue({
      agents: [],
      total: 0,
      registries: [],
    })

    const result = await orchestrateService.orchestrate(
      { goal: 'find quantum agents', budget: 5.0 },
      'orch-no-agents',
    )

    expect(result.answer).toBeNull()
    expect(result.reasoning).toContain('No agents found')
    expect(result.pipeline.steps).toHaveLength(0)
  })

  // T-4: LLM fails -> fallback greedy with warning
  it('T-4: LLM failure falls back to greedy with warning', async () => {
    setLlmError(new Error('API timeout'))

    const result = await orchestrateService.orchestrate(
      { goal: 'test fallback', budget: 5.0 },
      'orch-fallback',
    )

    expect(result.reasoning).toContain('[FALLBACK]')
    expect(result.answer).toBeDefined()
  })

  // T-5: LLM returns invalid slug -> discard, keep valid
  it('T-5: LLM invalid slugs are discarded, valid ones kept', async () => {
    setLlmResponse(JSON.stringify({
      selectedAgents: [
        { slug: 'non-existent-agent', registry: 'wasiai', input: { q: 'x' }, reasoning: 'bad' },
        { slug: 'summarizer-v1', registry: 'wasiai', input: { query: 'real' }, reasoning: 'good' },
      ],
      reasoning: 'Mixed plan',
    }))

    const result = await orchestrateService.orchestrate(
      { goal: 'test slug validation', budget: 5.0 },
      'orch-slug-check',
    )

    // Should only have 1 step (the valid one)
    const composeCall = vi.mocked(composeService.compose).mock.calls[0][0]
    expect(composeCall.steps).toHaveLength(1)
    expect(composeCall.steps[0].agent).toBe('summarizer-v1')
  })

  // T-6: Event tracking called with orchestrate_goal
  it('T-6: tracks orchestrate_goal event', async () => {
    setLlmResponse(JSON.stringify({
      selectedAgents: [
        { slug: 'summarizer-v1', registry: 'wasiai', input: { q: 'x' }, reasoning: 'ok' },
      ],
      reasoning: 'Plan ok',
    }))

    await orchestrateService.orchestrate(
      { goal: 'track this goal', budget: 5.0 },
      'orch-track',
    )

    // Give fire-and-forget a tick
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(vi.mocked(eventService.track)).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'orchestrate_goal',
        goal: 'track this goal',
        metadata: expect.objectContaining({ orchestrationId: 'orch-track' }),
      }),
    )
  })

  // T-7: protocolFeeUsdc = totalCostUsdc * 0.01
  it('T-7: protocolFeeUsdc is 1% of totalCostUsdc', async () => {
    const customCompose: ComposeResult = {
      ...mockComposeResult,
      totalCostUsdc: 10.0,
    }
    vi.mocked(composeService.compose).mockResolvedValue(customCompose)

    setLlmResponse(JSON.stringify({
      selectedAgents: [
        { slug: 'summarizer-v1', registry: 'wasiai', input: { q: 'x' }, reasoning: 'ok' },
      ],
      reasoning: 'ok',
    }))

    const result = await orchestrateService.orchestrate(
      { goal: 'fee test', budget: 20.0 },
      'orch-fee',
    )

    expect(result.protocolFeeUsdc).toBeCloseTo(0.10, 6) // 1% of 10.0
  })
  // T-8: LLM returns malformed JSON -> fallback (AR fix M-1)
  it('T-8: LLM malformed JSON triggers fallback', async () => {
    setLlmResponse('Sure! Here is the plan:\n\n```json\n{"bad"}\n```')

    const result = await orchestrateService.orchestrate(
      { goal: 'malformed test', budget: 5.0 },
      'orch-malformed',
    )

    expect(result.reasoning).toContain('[FALLBACK]')
    expect(result.answer).toBeDefined()
  })

  // T-9: All LLM slugs invalid -> full fallback (AR fix M-4)
  it('T-9: all LLM slugs invalid triggers full fallback', async () => {
    setLlmResponse(JSON.stringify({
      selectedAgents: [
        { slug: 'ghost-agent-1', registry: 'wasiai', input: { q: 'x' }, reasoning: 'bad' },
        { slug: 'ghost-agent-2', registry: 'wasiai', input: { q: 'y' }, reasoning: 'bad' },
      ],
      reasoning: 'All ghosts',
    }))

    const result = await orchestrateService.orchestrate(
      { goal: 'all invalid slugs', budget: 5.0 },
      'orch-all-invalid',
    )

    expect(result.reasoning).toContain('[FALLBACK]')
    expect(result.reasoning).toContain('not found in discovery')
    expect(result.answer).toBeDefined()
  })

  // T-10: Missing ANTHROPIC_API_KEY -> fallback (AR fix M-7)
  it('T-10: missing API key triggers fallback', async () => {
    delete process.env.ANTHROPIC_API_KEY

    const result = await orchestrateService.orchestrate(
      { goal: 'no key test', budget: 5.0 },
      'orch-no-key',
    )

    expect(result.reasoning).toContain('[FALLBACK]')
    expect(result.answer).toBeDefined()
    // LLM should NOT have been called
    expect(mockCreate).not.toHaveBeenCalled()
  })

})
