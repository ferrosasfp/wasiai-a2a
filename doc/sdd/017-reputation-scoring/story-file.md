# Story File -- #017: Reputation Scoring

> WKH-28 | Branch: `feat/017-reputation-scoring`
> Fecha: 2026-04-05
> Self-contained contract for Dev -- execute wave by wave, verify after each.

---

## Wave 0: Migration + Types

### W0.1 -- Create Migration File

**Create**: `supabase/migrations/20260405300000_reputation_view.sql`

```sql
-- ============================================================
-- Migration: 20260405300000_reputation_view
-- WKH-28: SQL VIEW for reputation score computation
-- ============================================================

CREATE OR REPLACE VIEW v_reputation_scores AS
SELECT
  agent_id                                              AS agent_slug,
  MAX(agent_name)                                       AS agent_name,
  MAX(registry)                                         AS registry,
  COUNT(*)                                              AS total_invocations,
  COUNT(*) FILTER (WHERE status = 'success')            AS success_count,
  CASE
    WHEN COUNT(*) > 0
    THEN COUNT(*) FILTER (WHERE status = 'success')::numeric / COUNT(*)
    ELSE 0
  END                                                   AS success_rate,
  COALESCE(AVG(latency_ms)::integer, 0)                AS avg_latency_ms,
  COALESCE(AVG(cost_usdc), 0)                          AS avg_cost_usdc
FROM a2a_events
WHERE event_type = 'compose_step'
  AND agent_id IS NOT NULL
GROUP BY agent_id;
```

**Critical notes**:
- `agent_id` column stores the SLUG (CD-3), VIEW aliases it as `agent_slug`
- `WHERE event_type = 'compose_step'` -- excludes `orchestrate_goal` events (CD-2)
- `AND agent_id IS NOT NULL` -- excludes events without agent association (CD-2)
- This is a VIEW, not a TABLE -- no indexes needed

**Verification**:
```bash
cat supabase/migrations/20260405300000_reputation_view.sql | npx supabase db query --linked
```

### W0.2 -- Update Types

**Modify**: `src/types/index.ts`

Add the following BEFORE the closing of the file (after DashboardStats interface):

```typescript
// ============================================================
// REPUTATION TYPES (WKH-28)
// ============================================================

export interface ReputationScore {
  agentSlug: string
  agentName: string
  registry: string
  totalInvocations: number
  successCount: number
  successRate: number
  avgLatencyMs: number
  avgCostUsdc: number
  latencyScore: number
  costEfficiency: number
  reputationScore: number  // 0-5 scale (CD-1)
}
```

Add `reputationScore` to `AgentSummary` (existing interface):

```typescript
export interface AgentSummary {
  agentId: string
  agentName: string
  registry: string
  invocations: number
  avgLatencyMs: number
  totalCostUsdc: number
  reputationScore?: number | null  // WKH-28: 0-5 scale, null if no events
}
```

**Verification**:
```bash
npx tsc --noEmit
```

---

## Wave 1: Service + Tests (test-first)

### W1.1 -- Create Test File

**Create**: `src/services/reputation.test.ts`

```typescript
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
```

**Key patterns used** (from exemplars):
- `vi.mock('../lib/supabase.js', ...)` -- same as task.test.ts
- `vi.mocked(supabase.from)` -- same as task.test.ts
- `mockChain()` builder -- adapted from task.test.ts for `.select().in()` chain
- `vi.spyOn(console, 'error')` -- same as task.test.ts pattern
- `beforeEach(() => vi.clearAllMocks())` -- standard pattern
- T8 uses `filterByMinReputation` exported helper (Option A -- pure function, no mocks needed)

### W1.2 -- Create Service File

**Create**: `src/services/reputation.ts`

```typescript
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
```

**Verification**:
```bash
npx vitest run src/services/reputation.test.ts
npx tsc --noEmit
```

---

## Wave 2: Integration

### W2.1 -- Modify Discovery Service

**Modify**: `src/services/discovery.ts`

**Step 1**: Add import at the top of the file (after existing imports):

```typescript
import { reputationService } from './reputation.js'
```

**Step 2**: In `discover()`, inject reputation enrichment between `results.flat()` and the sort block. The existing code:

```typescript
    // Merge and sort results
    const allAgents = results.flat()

    // Sort by reputation (desc) then by price (asc)
    allAgents.sort((a, b) => {
```

Becomes:

```typescript
    // Merge and sort results
    const allAgents = results.flat()

    // ── Reputation enrichment (WKH-28) ───────────────────────
    try {
      const slugs = allAgents.map(a => a.slug)
      const scores = await reputationService.getScores(slugs)
      const scoreMap = new Map(scores.map(s => [s.agentSlug, s.reputationScore]))
      for (const agent of allAgents) {
        const computed = scoreMap.get(agent.slug)
        if (computed !== undefined) {
          agent.reputation = computed
        }
      }
    } catch (err) {
      // CD-4: Reputation errors NEVER break discovery
      console.error('[Discovery] Reputation enrichment failed, continuing:',
        err instanceof Error ? err.message : err)
    }

    // Sort by reputation (desc) then by price (asc)
    allAgents.sort((a, b) => {
```

**Step 3**: After the sort block, add minReputation filter BEFORE the limit. The existing code:

```typescript
    // Apply limit
    const limited = query.limit ? allAgents.slice(0, query.limit) : allAgents
```

Becomes:

```typescript
    // ── minReputation filter (WKH-28) ────────────────────────
    const filtered = query.minReputation
      ? allAgents.filter(a => (a.reputation ?? 0) >= query.minReputation!)
      : allAgents

    // Apply limit
    const limited = query.limit ? filtered.slice(0, query.limit) : filtered
```

**Step 4**: Update the return statement to use `filtered` for `total`:

```typescript
    return {
      agents: limited,
      total: filtered.length,
      registries: registries.map(r => r.name),
    }
```

### W2.2 -- Modify Event Service

**Modify**: `src/services/event.ts`

**Step 1**: Add import at the top (after existing imports):

```typescript
import { reputationService } from './reputation.js'
```

**Step 2**: In `stats()`, after building the `agents` array (around line 119), add reputation enrichment:

Find this code block:

```typescript
    const agents: AgentSummary[] = Array.from(agentMap.entries()).map(
      ([agentId, data]) => ({
        agentId,
        agentName: data.agentName,
        registry: data.registry,
        invocations: data.invocations,
        avgLatencyMs: data.latencyCount > 0 ? Math.round(data.totalLatency / data.latencyCount) : 0,
        totalCostUsdc: Number(data.totalCost.toFixed(6)),
      }),
    )
```

Replace with:

```typescript
    const agents: AgentSummary[] = Array.from(agentMap.entries()).map(
      ([agentId, data]) => ({
        agentId,
        agentName: data.agentName,
        registry: data.registry,
        invocations: data.invocations,
        avgLatencyMs: data.latencyCount > 0 ? Math.round(data.totalLatency / data.latencyCount) : 0,
        totalCostUsdc: Number(data.totalCost.toFixed(6)),
        reputationScore: null as number | null,
      }),
    )

    // ── Reputation enrichment (WKH-28) ───────────────────────
    try {
      const slugs = agents.map(a => a.agentId)  // agentId stores slug (CD-3)
      const scores = await reputationService.getScores(slugs)
      const scoreMap = new Map(scores.map(s => [s.agentSlug, s.reputationScore]))
      for (const agent of agents) {
        agent.reputationScore = scoreMap.get(agent.agentId) ?? null
      }
    } catch {
      // Non-blocking: dashboard continues without reputation scores
    }
```

### W2.3 -- Fix Route Comment

**Modify**: `src/routes/discover.ts`

Find:
```typescript
   * - minReputation: minimum reputation score (0-1)
```

Replace with:
```typescript
   * - minReputation: minimum reputation score (0-5)
```

### Verification (Wave 2):

```bash
npx vitest run
npx tsc --noEmit
```

---

## Anti-Hallucination Checklist

Before submitting, Dev MUST verify:

- [ ] **Import paths use `.js` extension** (ESM): `'../lib/supabase.js'`, `'./reputation.js'`, `'../types/index.js'`
- [ ] **Mock pattern matches exemplar**: `vi.mock('../lib/supabase.js', () => ({ supabase: { from: vi.fn() } }))` -- BEFORE the import of the module under test
- [ ] **VIEW query**: `supabase.from('v_reputation_scores').select('*').in('agent_slug', slugs)` -- Supabase treats VIEWs like tables for SELECT
- [ ] **Scale is 0-5**: `computeScore()` multiplies `rawScore * SCORE_SCALE` where `SCORE_SCALE = 5`
- [ ] **JOIN on slug**: `scoreMap.get(agent.slug)` in discovery, `scoreMap.get(agent.agentId)` in event.ts (because agentId stores slug -- CD-3)
- [ ] **try/catch wrapping**: Both in `getScores()` (returns []) and in `discover()` (catches, continues)
- [ ] **Operation order in discover()**: flat -> enrich -> sort -> filter minRep -> limit (CD-5)
- [ ] **ReputationScore type** added to `src/types/index.ts` with `agentSlug` (not `agentId`)
- [ ] **AgentSummary** updated with `reputationScore?: number | null`
- [ ] **No default exports**: `export const reputationService = {...}` (singleton object pattern)
- [ ] **filterByMinReputation exported**: `export function filterByMinReputation<T extends { reputationScore: number }>(agents: T[], threshold: number): T[]` in reputation.ts
- [ ] **Null safety**: `((data ?? []) as ReputationRow[])` -- not `(data as ReputationRow[])` (MNR-5)
- [ ] **VIEW SQL**: `WHERE event_type = 'compose_step' AND agent_id IS NOT NULL` (CD-2)
- [ ] **Comment fix**: `(0-1)` changed to `(0-5)` in `src/routes/discover.ts`

---

## Escalation Rule

> If something is NOT in this Story File or the SDD, Dev STOPS and asks Architect.
> Do not invent. Do not assume. Do not improvise.

---

*Story File generated by NexusAgil F2.5 (Architect)*
*Date: 2026-04-05*
*v1.1: Fixed BLQ-1 (T7→T8 minReputation test), MNR-4 (exemplar refs), MNR-5 (null safety)*
