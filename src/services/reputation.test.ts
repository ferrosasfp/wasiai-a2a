/**
 * Tests for reputation service -- WKH-28
 * Pattern: vi.mock for supabase (same as task.test.ts)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock supabase BEFORE importing service ───────────────────
vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: vi.fn(),
  },
}))

// ── Import AFTER mocks ──────────────────────────────────────
import { supabase } from '../lib/supabase.js'
import { reputationService, computeScore, filterByMinReputation, SCORE_SCALE, MAX_LATENCY_MS, MAX_COST_USDC } from './reputation.js'

const mockFrom = vi.mocked(supabase.from)

// ── Helpers ─────────────────────────────────────────────────

function makeViewRow(overrides: Partial<{
  agent_slug: string
  agent_name: string | null
  registry: string | null
  total_invocations: number
  success_count: number
  success_rate: number
  avg_latency_ms: number
  avg_cost_usdc: number
}> = {}) {
  return {
    agent_slug: 'docusynth',
    agent_name: 'DocuSynth',
    registry: 'mock-community',
    total_invocations: 10,
    success_count: 9,
    success_rate: 0.9,
    avg_latency_ms: 2000,
    avg_cost_usdc: 0.03,
    ...overrides,
  }
}

/**
 * Build a Supabase fluent chain mock.
 * Supports: .from().select().in() -> resolves { data, error }
 */
function mockChain(result: { data: unknown[] | null; error: { message: string } | null }) {
  const chain: Record<string, unknown> = {}
  const methods = ['select', 'in']
  for (const m of methods) {
    chain[m] = vi.fn().mockReturnValue(chain)
  }
  // Terminal: the chain itself is thenable
  Object.defineProperty(chain, 'then', {
    value: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(result).then(resolve, reject),
    configurable: true,
  })
  return chain
}

// ── Tests ───────────────────────────────────────────────────

describe('reputation service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  // ─── T1: getScores happy path ─────────────────────────────
  it('T1: getScores returns correct scores for known VIEW data', async () => {
    const row = makeViewRow()
    const chain = mockChain({ data: [row], error: null })
    mockFrom.mockReturnValue(chain as never)

    const scores = await reputationService.getScores(['docusynth'])

    expect(scores).toHaveLength(1)
    expect(scores[0].agentSlug).toBe('docusynth')
    expect(scores[0].reputationScore).toBeGreaterThan(0)
    expect(scores[0].reputationScore).toBeLessThanOrEqual(5)
    expect(mockFrom).toHaveBeenCalledWith('v_reputation_scores')
  })

  // ─── T2: formula correctness (docusynth spot-check) ───────
  it('T2: computeScore produces expected output for docusynth example', () => {
    const row = makeViewRow({
      total_invocations: 10,
      success_count: 9,
      success_rate: 0.9,
      avg_latency_ms: 2000,
      avg_cost_usdc: 0.03,
    })

    const result = computeScore(row)

    // success_rate = 0.90
    // latency_score = 1 - (2000/30000) = 1 - 0.0667 = 0.9333
    // cost_efficiency = 1 - (0.03/0.10) = 1 - 0.30 = 0.70
    // raw = 0.50*0.90 + 0.30*0.9333 + 0.20*0.70 = 0.45 + 0.28 + 0.14 = 0.87
    // reputation = 0.87 * 5 = 4.35
    expect(result.reputationScore).toBe(4.35)
    expect(result.successRate).toBe(0.9)
    expect(result.latencyScore).toBeCloseTo(0.9333, 3)
    expect(result.costEfficiency).toBeCloseTo(0.70, 2)
  })

  // ─── T3: empty VIEW returns empty array ───────────────────
  it('T3: getScores returns empty array when VIEW has no data', async () => {
    const chain = mockChain({ data: [], error: null })
    mockFrom.mockReturnValue(chain as never)

    const scores = await reputationService.getScores(['unknown-agent'])

    expect(scores).toEqual([])
  })

  // ─── T4: Supabase error returns empty array + console.error
  it('T4: getScores returns empty array and logs error on Supabase failure', async () => {
    const chain = mockChain({ data: null, error: { message: 'connection refused' } })
    mockFrom.mockReturnValue(chain as never)

    const scores = await reputationService.getScores(['docusynth'])

    expect(scores).toEqual([])
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[Reputation] VIEW query failed:'),
      expect.stringContaining('connection refused'),
    )
  })

  // ─── T5: scores are in 0-5 range (not 0-1) ───────────────
  it('T5: all scores are scaled to 0-5 range', () => {
    // Perfect agent: 100% success, 0ms latency, $0.00 cost
    const perfect = computeScore(makeViewRow({
      success_rate: 1.0,
      avg_latency_ms: 0,
      avg_cost_usdc: 0,
    }))
    expect(perfect.reputationScore).toBe(5.0)

    // Worst agent: 0% success, max latency, max cost
    const worst = computeScore(makeViewRow({
      success_rate: 0,
      avg_latency_ms: MAX_LATENCY_MS,
      avg_cost_usdc: MAX_COST_USDC,
    }))
    expect(worst.reputationScore).toBe(0)

    // Both must be within 0-5
    expect(perfect.reputationScore).toBeLessThanOrEqual(SCORE_SCALE)
    expect(worst.reputationScore).toBeGreaterThanOrEqual(0)
  })

  // ─── T6: clamping at boundaries ──────────────────────────
  it('T6: latency > 30000ms clamps latencyScore to 0, cost > 0.10 clamps costEfficiency to 0', () => {
    // Extremely slow and expensive agent
    const clamped = computeScore(makeViewRow({
      success_rate: 1.0,
      avg_latency_ms: 60000,   // 60s >> 30s max
      avg_cost_usdc: 0.50,     // $0.50 >> $0.10 max
    }))

    expect(clamped.latencyScore).toBe(0)
    expect(clamped.costEfficiency).toBe(0)
    // Only success_rate contributes: 0.50 * 1.0 * 5 = 2.50
    expect(clamped.reputationScore).toBe(2.5)
  })

  // ─── T7: getScores filters by provided slugs via .in() ───────
  it('T7: getScores filters by provided slugs via .in()', async () => {
    const rows = [
      makeViewRow({ agent_slug: 'agent-a', success_rate: 1.0, avg_latency_ms: 100, avg_cost_usdc: 0.01 }),
      makeViewRow({ agent_slug: 'agent-b', success_rate: 0.5, avg_latency_ms: 20000, avg_cost_usdc: 0.08 }),
    ]
    const chain = mockChain({ data: rows, error: null })
    mockFrom.mockReturnValue(chain as never)

    const scores = await reputationService.getScores(['agent-a', 'agent-b'])

    expect(scores).toHaveLength(2)

    const scoreA = scores.find(s => s.agentSlug === 'agent-a')!
    const scoreB = scores.find(s => s.agentSlug === 'agent-b')!

    // agent-a should have much higher reputation than agent-b
    expect(scoreA.reputationScore).toBeGreaterThan(scoreB.reputationScore)

    // Both in 0-5 range
    expect(scoreA.reputationScore).toBeLessThanOrEqual(5)
    expect(scoreB.reputationScore).toBeGreaterThanOrEqual(0)

    // Verify .in() was called with correct args
    const inCall = (chain.in as ReturnType<typeof vi.fn>)
    expect(inCall).toHaveBeenCalledWith('agent_slug', ['agent-a', 'agent-b'])
  })

  // ─── T8: minReputation filter excludes low-reputation agents ──
  it('T8: minReputation filter excludes low-reputation agents', () => {
    const agents = [
      { agentSlug: 'high-rep', reputationScore: 4.5 },
      { agentSlug: 'mid-rep',  reputationScore: 3.0 },
      { agentSlug: 'low-rep',  reputationScore: 1.2 },
    ]
    const threshold = 3.0

    const filtered = filterByMinReputation(agents, threshold)

    expect(filtered).toHaveLength(2)
    expect(filtered.map(a => a.agentSlug)).toContain('high-rep')
    expect(filtered.map(a => a.agentSlug)).toContain('mid-rep')
    expect(filtered.map(a => a.agentSlug)).not.toContain('low-rep')
  })
})
