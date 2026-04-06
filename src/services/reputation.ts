/**
 * Reputation Service -- Compute agent reputation scores from event data
 * WKH-28: Reputation Scoring
 *
 * Reads from SQL VIEW v_reputation_scores (aggregated a2a_events).
 * Applies weighted formula in TypeScript, returns 0-5 scaled scores.
 * Errors are non-blocking: returns [] on failure.
 */

import type { ReputationScore } from '../types/index.js'
import { supabase } from '../lib/supabase.js'

// ── Constants ────────────────────────────────────────────────

export const SCORE_SCALE = 5
export const MAX_LATENCY_MS = 30_000
export const MAX_COST_USDC = 0.10
export const MIN_INVOCATIONS = 1

export const WEIGHTS = {
  SUCCESS: 0.50,
  LATENCY: 0.30,
  COST: 0.20,
} as const

// ── Internal row type from VIEW ──────────────────────────────

interface ReputationRow {
  agent_slug: string
  agent_name: string | null
  registry: string | null
  total_invocations: number
  success_count: number
  success_rate: number
  avg_latency_ms: number
  avg_cost_usdc: number
}

// ── Pure function: row -> ReputationScore ─────────────────────

export function computeScore(row: ReputationRow): ReputationScore {
  const successRate = Number(row.success_rate)
  const latencyScore = 1 - Math.min(row.avg_latency_ms / MAX_LATENCY_MS, 1)
  const costEfficiency = 1 - Math.min(Number(row.avg_cost_usdc) / MAX_COST_USDC, 1)

  const rawScore =
    WEIGHTS.SUCCESS * successRate +
    WEIGHTS.LATENCY * latencyScore +
    WEIGHTS.COST * costEfficiency

  const reputationScore = Number((rawScore * SCORE_SCALE).toFixed(2))

  return {
    agentSlug: row.agent_slug,
    agentName: row.agent_name ?? row.agent_slug,
    registry: row.registry ?? 'unknown',
    totalInvocations: Number(row.total_invocations),
    successCount: Number(row.success_count),
    successRate,
    avgLatencyMs: Number(row.avg_latency_ms),
    avgCostUsdc: Number(row.avg_cost_usdc),
    latencyScore,
    costEfficiency,
    reputationScore,
  }
}

// ── Service ──────────────────────────────────────────────────

export const reputationService = {
  /**
   * Get reputation scores for given agent slugs.
   * Queries v_reputation_scores VIEW, applies weighted formula.
   *
   * @param slugs - Optional array of agent slugs to filter. If empty/undefined, returns all.
   * @returns Array of ReputationScore (0-5 scale). Empty array on error.
   */
  async getScores(slugs?: string[]): Promise<ReputationScore[]> {
    try {
      let query = supabase
        .from('v_reputation_scores')
        .select('*')

      if (slugs && slugs.length > 0) {
        query = query.in('agent_slug', slugs)
      }

      const { data, error } = await query

      if (error) {
        console.error('[Reputation] VIEW query failed:', error.message)
        return []
      }

      return ((data ?? []) as ReputationRow[])
        .filter(row => row.total_invocations >= MIN_INVOCATIONS)
        .map(computeScore)
    } catch (err) {
      console.error(
        '[Reputation] getScores failed:',
        err instanceof Error ? err.message : err,
      )
      return []
    }
  },
}

// ── Helper: filter agents by minimum reputation threshold ────

export function filterByMinReputation<T extends { reputationScore: number }>(
  agents: T[],
  threshold: number,
): T[] {
  return agents.filter(a => a.reputationScore >= threshold)
}
