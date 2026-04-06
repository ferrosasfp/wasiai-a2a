# SDD -- #017: Reputation Scoring

> WKH-28 | Branch: `feat/017-reputation-scoring`
> Fecha: 2026-04-05
> Status: APPROVED -- ready for Dev

---

## 1. Context Map

### 1.1 Files Read

| File | Role | Key Patterns Extracted |
|------|------|-----------------------|
| `doc/sdd/017-reputation-scoring/work-item.md` | Approved Work Item v2.1 | Formula, scale 0-5, VIEW approach, CD-1..CD-5, AC-1..AC-7 |
| `src/services/event.ts` | **Exemplar**: Supabase service singleton | `export const eventService = {...}`, `supabase.from()` query, `rowToEvent()` helper, AgentSummary aggregation in `stats()` |
| `src/services/task.ts` | **Exemplar**: Simple service | Named export singleton, try/catch returning null on failure, `console.warn` on error |
| `src/services/task.test.ts` | **Exemplar**: Test patterns | `vi.mock()` BEFORE import, `vi.fn()` for mock functions, `beforeEach(() => vi.clearAllMocks())`, `vi.spyOn(console, ...)`, env var save/restore |
| `src/services/task.test.ts` | **Exemplar**: Supabase mock | `vi.mock('../lib/supabase.js', () => ({ supabase: { from: vi.fn() } }))`, chain builder for fluent API, `vi.mocked(supabase.from)` |
| `src/services/discovery.ts` | **Injection target** | `discover()`: fetch registries -> `Promise.all` -> `results.flat()` -> sort by reputation desc/price asc -> apply limit |
| `src/types/index.ts` | All project types | `Agent.reputation?: number`, `AgentSummary` (no reputationScore yet), `DiscoveryQuery.minReputation?: number` |
| `supabase/migrations/20260404200000_events.sql` | Migration pattern | `CREATE TABLE IF NOT EXISTS`, indexes, `NUMERIC(12,6)` for cost_usdc |
| `src/routes/discover.ts` | Route with comment bug | Line: `minReputation: minimum reputation score (0-1)` -- must change to `(0-5)` |

### 1.2 Patterns Extracted

| Pattern | Source | Application |
|---------|--------|-------------|
| Singleton service object | `eventService`, `attestationService` | `export const reputationService = {...}` |
| Import supabase | `import { supabase } from '../lib/supabase.js'` | Same path, `.js` extension (ESM) |
| Row-to-domain helper | `rowToEvent(row: EventRow): A2AEvent` in event.ts | `computeScore(row: ReputationRow): ReputationScore` |
| Error = empty/null, not throw | `attestationService.write()` returns null | `getScores()` returns `[]` on error + `console.error` |
| vi.mock before import | task.test.ts | Mock `'../lib/supabase.js'` before importing reputationService |
| Supabase fluent chain mock | task.test.ts `mockChain()` + `vi.mocked(supabase.from)` | Same for mocking `.from().select().in()` |
| Types in index.ts | All types co-located | Add `ReputationScore` and update `AgentSummary` there |

---

## 2. Technical Design

### 2.1 Migration: SQL VIEW `v_reputation_scores`

**File**: `supabase/migrations/20260405300000_reputation_view.sql`

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

**Why VIEW**: For <1000 events (hackathon), always-fresh aggregation is fast (<50ms). No upsert, no TTL, no `computed_at`. Supabase treats VIEWs like tables for SELECT operations.

### 2.2 Type Definitions

**File**: `src/types/index.ts` (additions)

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

**AgentSummary addition**:

```typescript
export interface AgentSummary {
  // ... existing fields ...
  reputationScore?: number | null  // 0-5 scale, null if no events
}
```

### 2.3 Reputation Service

**File**: `src/services/reputation.ts`

```typescript
import type { ReputationScore } from '../types/index.js'
import { supabase } from '../lib/supabase.js'

// -- Constants --

export const SCORE_SCALE = 5
export const MAX_LATENCY_MS = 30_000
export const MAX_COST_USDC = 0.10
export const MIN_INVOCATIONS = 1

export const WEIGHTS = {
  SUCCESS: 0.50,
  LATENCY: 0.30,
  COST: 0.20,
} as const

// -- Internal row type from VIEW --

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

// -- Pure function: row -> ReputationScore --

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

// -- Service --

export const reputationService = {
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

// -- Helper: filter agents by minimum reputation threshold --

export function filterByMinReputation<T extends { reputationScore: number }>(
  agents: T[],
  threshold: number,
): T[] {
  return agents.filter(a => a.reputationScore >= threshold)
}
```

### 2.4 Discovery Enrichment -- Exact Injection Point

**File**: `src/services/discovery.ts` -- `discover()` method

Current code (simplified):

```
results.flat()       // line ~33
allAgents.sort(...)  // line ~36
query.limit ? ...    // line ~42
```

New operation order (CD-5):

```
1. results.flat()                          // existing
2. ENRICH with reputationService           // NEW -- try/catch
3. allAgents.sort(...)                     // existing (sorts by enriched reputation)
4. FILTER by minReputation                 // NEW
5. query.limit ? allAgents.slice(...)      // existing
```

Exact code to inject between `flat()` and `sort()`:

```typescript
// -- Reputation enrichment (WKH-28) --
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
  console.error('[Discovery] Reputation enrichment failed, continuing:',
    err instanceof Error ? err.message : err)
}
```

After sort, before limit:

```typescript
// -- minReputation filter (WKH-28) --
const filtered = query.minReputation
  ? allAgents.filter(a => (a.reputation ?? 0) >= query.minReputation!)
  : allAgents
```

### 2.5 Formula Specification

| Constant | Value | Purpose |
|----------|-------|---------|
| `SCORE_SCALE` | 5 | Multiply raw 0-1 to 0-5 (CD-1) |
| `MAX_LATENCY_MS` | 30,000 | 30s ceiling -- latency above scores 0 |
| `MAX_COST_USDC` | 0.10 | $0.10 ceiling -- meaningful for mock prices 0.01-0.05 |
| `MIN_INVOCATIONS` | 1 | Minimum events for scoring (hackathon demo-ability) |

| Weight | Metric | Value | Rationale |
|--------|--------|-------|-----------|
| `W_SUCCESS` | Success Rate | 0.50 | Reliability is king |
| `W_LATENCY` | Latency Score | 0.30 | Speed matters |
| `W_COST` | Cost Efficiency | 0.20 | Cost differentiator |

**Formula**:

```
success_rate    = successful / total                         (0-1)
latency_score   = 1 - min(avg_latency_ms / 30000, 1)       (0-1)
cost_efficiency = 1 - min(avg_cost_usdc / 0.10, 1)          (0-1)

raw_score       = 0.50 * success_rate
                + 0.30 * latency_score
                + 0.20 * cost_efficiency                     (0-1)

reputation_score = raw_score * 5                             (0-5)
```

**Spot-check -- docusynth** (10 invocations, 90% success, 2000ms avg, $0.03 avg):

```
success_rate    = 0.90
latency_score   = 1 - min(2000/30000, 1) = 1 - 0.0667 = 0.9333
cost_efficiency = 1 - min(0.03/0.10, 1)  = 1 - 0.30   = 0.70

raw = 0.50*0.90 + 0.30*0.9333 + 0.20*0.70
    = 0.45 + 0.28 + 0.14 = 0.87

reputation_score = 0.87 * 5 = 4.35
```

---

## 3. Constraint Directives

| ID | Constraint | Detail |
|----|-----------|--------|
| **CD-1** | Scale is 0-5, NOT 0-1 | Internal computation is 0-1, but `reputationScore` in `ReputationScore` and `Agent.reputation` MUST be 0-5 (multiply `rawScore * SCORE_SCALE`). This matches the registry scale (agents come with 4.5-4.9). Discovery sorts on a single `reputation` field -- all values must be comparable. |
| **CD-2** | VIEW filter: `WHERE event_type='compose_step' AND agent_id IS NOT NULL` | This is DIFFERENT from `eventService.stats()` which reads ALL events unfiltered. The VIEW excludes `orchestrate_goal` events (which have `agent_id=null`) and any future event types. Dev MUST NOT reuse `stats()` for reputation data. |
| **CD-3** | Join on `agent.slug`, NOT `agent.id` | The `a2a_events.agent_id` column stores the agent SLUG string (e.g., `"docusynth"`), set at `compose.ts:110`. The VIEW aliases it as `agent_slug`. Discovery enrichment joins `scoreMap.get(agent.slug)`. Never use `agent.id`. |
| **CD-4** | Reputation errors NEVER break discovery | All reputation calls in `discover()` MUST be wrapped in try/catch. On failure: `console.error(...)`, continue with registry-provided scores. The `getScores()` method itself also returns `[]` on error. Double safety net. |
| **CD-5** | Operation order: enrich -> sort -> filter minRep -> limit | In `discover()`: (1) fetch+flat, (2) enrich reputation, (3) sort by reputation desc/price asc, (4) filter by `minReputation`, (5) apply limit. The minReputation filter MUST come after sort but before limit, so the limit applies to the filtered set. |

---

## 4. Waves

### Wave 0: Migration + Types (~20 min)

| Task | File | Action |
|------|------|--------|
| W0.1 | `supabase/migrations/20260405300000_reputation_view.sql` | CREATE -- SQL VIEW as specified in section 2.1 |
| W0.2 | `src/types/index.ts` | MODIFY -- Add `ReputationScore` interface, add `reputationScore?: number \| null` to `AgentSummary` |

**Verification**: `tsc --noEmit` passes. Migration applies cleanly.

### Wave 1: Service + Tests (~45 min, test-first)

| Task | File | Action |
|------|------|--------|
| W1.1 | `src/services/reputation.test.ts` | CREATE -- T1-T8 test cases (see Story File for details) |
| W1.2 | `src/services/reputation.ts` | CREATE -- `reputationService` + `computeScore()` + `filterByMinReputation()` as specified in section 2.3 |

**Verification**: `vitest run src/services/reputation.test.ts` -- all 8 tests pass. `tsc --noEmit` passes.

### Wave 2: Integration (~45 min)

| Task | File | Action |
|------|------|--------|
| W2.1 | `src/services/discovery.ts` | MODIFY -- Enrich agents with reputation, add minReputation filter (section 2.4) |
| W2.2 | `src/services/event.ts` | MODIFY -- Add reputationScore to AgentSummary in `stats()` |
| W2.3 | `src/routes/discover.ts` | MODIFY -- Fix comment `(0-1)` to `(0-5)` |

**Verification**: `vitest run && tsc --noEmit` -- all tests pass, no type errors.

### Dependency Graph

```
W0.1 (VIEW SQL) --+
W0.2 (types)    --+
                  v
W1.1 (tests)   --> W1.2 (service)
                        |
                  +-----+------+
                  v     v      v
               W2.1  W2.2   W2.3
           (discovery)(event)(route)
```

---

*SDD generated by NexusAgil F2 (Architect)*
*Date: 2026-04-05*
*v1.1: Fixed BLQ-1 (T7→T8 minReputation test), MNR-4 (exemplar refs), MNR-5 (null safety)*
