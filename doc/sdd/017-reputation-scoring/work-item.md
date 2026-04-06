# Work Item — #017: Reputation Scoring — Modelo de Latencia, Success Rate, Cost Efficiency

> SDD: doc/sdd/017-reputation-scoring/
> Fecha: 2026-04-05
> Branch: feat/017-reputation-scoring
> HU: WKH-28 — "[S4-P6] Reputation scoring — modelo de latencia, success rate, cost efficiency (Eli)"
> Revision: **v2.1** (quick fixes M-2, M-4/M-5, M-7, M-8)

---

## Changelog v2 → v2.1

| ID | Tipo | Cambio |
|----|------|--------|
| **M-2** | MENOR | **Explicit operation order added to Wave 2.1.** `discover()` step order documented: fetch → flat → enrich reputation → sort → filter minReputation → limit. Also adds comment fix scope: `src/routes/discover.ts` `minReputation: (0-1)` → `(0-5)`. |
| **M-5** | MENOR | **R4 risk added.** 100% failure agents score misleadingly high (2.5/5) because failed events have `latency_ms ~0` and `cost_usdc = 0`. Documented as acceptable for demo (mock agents always succeed). Post-hackathon mitigation noted. |
| **M-7** | MENOR | **Test cases T6 and T7 added.** T6: formula clamps at boundaries (latency > 30000ms → latencyScore=0, cost > 0.10 → costEfficiency=0). T7: `minReputation` filter excludes agents below threshold. |
| **M-8** | MENOR | **`src/routes/discover.ts` added to Scope IN.** Comment fix: `minReputation: (0-1)` → `minReputation: minimum reputation score (0-5)`. Archivos modificados count updated to 4. |

---

## Changelog v1 → v2

| ID | Tipo | Cambio |
|----|------|--------|
| **B-1** | BLOQUEANTE | **Scale mismatch 0-1 vs 0-5 corregido.** Mock registry agents use 0-5 scale (4.5-4.9). Computed scores now scaled to 0-5 (`raw_score * 5`) so discovery sorting works on a unified scale. Agents without events keep their registry score as-is. |
| **B-2** | BLOQUEANTE | **event_type filter added.** `eventService.stats()` does NOT filter by event_type — `orchestrate_goal` events have `agent_id=null` and pollute aggregation. Reputation queries now explicitly require `WHERE event_type = 'compose_step' AND agent_id IS NOT NULL`. This is implemented inside the SQL VIEW, not reusing `stats()`. |
| **B-3** | BLOQUEANTE | **slug vs id confusion resolved.** `a2a_events.agent_id` stores the agent SLUG (e.g., "docusynth"), NOT a UUID. See `compose.ts:110` -> `agentId: agent.slug`. All references renamed from `agent_id` to `agent_slug` in the reputation domain. Discovery enrichment joins on `agent.slug`, not `agent.id`. |
| **M-1** | MENOR | **MAX_COST_USDC lowered from 1.0 to 0.10.** Mock agent prices are 0.01-0.05 USDC. With MAX=1.0, all agents score ~0.95-0.99 cost_efficiency (no differentiation). With MAX=0.10, a $0.05 agent scores 0.50 and a $0.01 agent scores 0.90. |
| **S-1** | SIMPLIFICACION | **SQL VIEW replaces materialized table.** Instead of a `reputation_scores` table with upsert + TTL cache, use a SQL VIEW `v_reputation_scores` that computes aggregates from `a2a_events` directly. Service SELECTs from the view and applies the scoring formula in code. Eliminates: migration for table, upsert logic, TTL cache, `computed_at` management. For <1000 events in a hackathon, this is perfectly fast. |
| **S-4** | SIMPLIFICACION | **MIN_INVOCATIONS lowered from 3 to 1.** For hackathon demo-ability, even a single invocation should produce a score. Prevents "empty reputation" in demos with few events. |
| **M-4** | CONSTRAINT | **Dashboard successRate scale documented.** `DashboardStats.successRate` is 0-100 (percentage). Reputation `success_rate` is 0-1 (ratio). Added to Constraint Directives to prevent confusion. |

---

## 1. Context Map (Codebase Grounding)

### 1.1 Archivos leidos

| Archivo | Existe | Patron extraido |
|---------|--------|-----------------|
| `src/services/discovery.ts` | Si | `discoveryService.discover()` sorts by `reputation` desc, then `priceUsdc` asc (line 36). `Agent.reputation` is `number?` mapped from registry via `agentMapping.reputation`. Currently static from registry. Sort uses `(b.reputation ?? 0) - (a.reputation ?? 0)`. |
| `src/services/event.ts` | Si | `eventService.track()` inserts into `a2a_events`. `eventService.stats()` does a **full table scan** of ALL events (no event_type filter!) and aggregates per agent_id in-memory. **IMPORTANT**: stats() includes `orchestrate_goal` events which have `agent_id=null` — reputation MUST NOT reuse this query. |
| `src/services/compose.ts` | Si | Line 110: `agentId: agent.slug` — confirms that `a2a_events.agent_id` stores the agent **slug**, NOT the agent UUID/id. Both success (line 110) and failed (line 150) paths track with `agent.slug`. |
| `src/services/orchestrate.ts` | Si | Tracks `orchestrate_goal` events with `agent_id=null`. Discovery receives agent list including reputation field. |
| `src/types/index.ts` | Si | `Agent.reputation?: number`. `DiscoveryQuery.minReputation?: number`. `AgentSummary` has `invocations`, `avgLatencyMs`, `totalCostUsdc` but NO `successRate` or `reputationScore`. |
| `src/routes/mock-registry.ts` | Si | Mock agents have `reputation_score`: 4.7 (docusynth), 4.5 (codeweaver), 4.9 (dataforge). **Scale is 0-5.** |
| `src/routes/dashboard.ts` | Si | `GET /dashboard/api/stats` returns `DashboardStats`. `successRate` is 0-100 (percentage). |
| `supabase/migrations/20260404200000_events.sql` | Si | `a2a_events` table: `agent_id TEXT` (stores slug), `event_type TEXT`, `status TEXT CHECK (success/failed)`, `latency_ms INTEGER`, `cost_usdc NUMERIC(12,6)`. |
| `supabase/migrations/20260404000000_mock_community_registry.sql` | Si | Registry schema maps `"reputation": "reputation_score"` from mock API. |

### 1.2 Datos disponibles en `a2a_events`

| Campo | Tipo | Realidad del codebase | Uso para reputation |
|-------|------|----------------------|---------------------|
| `agent_id` | TEXT | Stores **agent slug** (e.g., "docusynth"), set at `compose.ts:110` via `agent.slug` | Group metrics by agent slug |
| `status` | TEXT (success/failed) | Always present | Calculate success_rate |
| `latency_ms` | INTEGER | Present in compose_step events | Calculate avg_latency |
| `cost_usdc` | NUMERIC(12,6) | Always present | Calculate cost_efficiency |
| `event_type` | TEXT | 'compose_step' (per-agent) or 'orchestrate_goal' (no agent_id) | **MUST filter to compose_step only** |
| `created_at` | TIMESTAMPTZ | Always present | Future: time-windowed scoring |

### 1.3 Archivos que NO existen aun

| Archivo esperado (scope HU) | Estado |
|------------------------------|--------|
| `src/services/reputation.ts` | NO EXISTE — se crea en este WI |
| `src/services/reputation.test.ts` | NO EXISTE — se crea en este WI |
| `supabase/migrations/20260405300000_reputation_view.sql` | NO EXISTE — se crea en este WI (VIEW, not TABLE) |

### 1.4 Patrones del codebase

| Patron | Ejemplo | Aplicar en |
|--------|---------|------------|
| **Named exports (no default)** en services | `export const eventService = { ... }` | `export const reputationService = { ... }` |
| **Supabase query + map** | `eventService.stats()` fetches events, maps in-memory | `reputationService` reads from `v_reputation_scores` VIEW, applies formula in code |
| **Fire-and-forget** | `eventService.track({...}).catch(err => ...)` | Score computation is NOT fire-and-forget — it feeds discovery sort |
| **rowToEvent helper** | `event.ts: function rowToEvent(row)` | `function rowToReputationInput(row)` to map VIEW row -> domain |
| **Types co-located** | `src/types/index.ts` — all types in one file | Add `ReputationScore` type here |

### 1.5 Constraint Directives (Cross-cutting)

| Constraint | Detail |
|------------|--------|
| **CD-1: Scale alignment** | Mock registry uses 0-5 scale for `reputation_score`. Computed reputation MUST be scaled to 0-5 before enrichment (`raw_score * 5`). Discovery sorts on single `agent.reputation` field — all values must be comparable. |
| **CD-2: Dashboard successRate vs reputation success_rate** | `DashboardStats.successRate` is 0-100 (percentage, see `event.ts` line: `successRate.toFixed(1)`). Reputation `success_rate` is 0-1 (ratio). Dev MUST NOT confuse these two scales. They are independent. |
| **CD-3: agent_id is actually agent_slug** | The column `a2a_events.agent_id` stores the agent SLUG string (e.g., "docusynth"), NOT the agent's UUID `id`. This is set at `compose.ts:110`. All reputation code must join on `Agent.slug`, never `Agent.id`. |

---

## 2. Discovery — Analisis Critico de la HU

### 2.1 Key Design Decisions

#### Decision 1: SQL VIEW vs. materialized table

**Decision: SQL VIEW `v_reputation_scores`** — computes aggregates on-the-fly.

Rationale (changed from v1):
- For a hackathon with <1000 events, a VIEW over `a2a_events` is fast enough.
- Eliminates: migration for a dedicated table, upsert logic, TTL cache, `computed_at` management.
- Service simply SELECTs from the VIEW (aggregated per agent_slug), then applies the weighted formula in TypeScript.
- If performance becomes an issue post-hackathon, convert to a materialized view or table.

#### Decision 2: Should `/discover` sort by reputation score?

**Decision: Yes, with fallback and scale normalization.**

- Discovery sorts by `Agent.reputation` desc (line 36 of discovery.ts).
- Currently `reputation` comes from registry (0-5 scale, e.g., 4.5-4.9).
- New behavior: after fetching agents, enrich with computed scores from VIEW.
- **Scale normalization**: computed score (0-1) is multiplied by 5 -> 0-5 scale, matching registry scores.
- If an agent has no events, fall back to registry-provided reputation (or 0).
- This ensures computed score 0.92 -> displayed as 4.60 (same ballpark as registry 4.5-4.9).

#### Decision 3: Scoring formula

**Decision: Simple weighted average of 3 normalized metrics (0-1 internal, displayed as 0-5).**

```
raw_score = (w1 * success_rate) + (w2 * latency_score) + (w3 * cost_efficiency)
reputation_score = raw_score * 5     # Scale to 0-5 for display

Where:
  success_rate    = successful_invocations / total_invocations           (0-1)
  latency_score   = 1 - min(avg_latency_ms / MAX_LATENCY_MS, 1)        (0-1, lower latency = higher score)
  cost_efficiency = 1 - min(avg_cost_usdc / MAX_COST_USDC, 1)          (0-1, lower cost = higher score)

Weights (hackathon defaults):
  w1 = 0.50  (reliability is king)
  w2 = 0.30  (speed matters)
  w3 = 0.20  (cost is a differentiator)

Normalization constants:
  MAX_LATENCY_MS = 30000  (30s — anything above scores 0)
  MAX_COST_USDC  = 0.10   (0.10 USDC — meaningful differentiation with mock prices 0.01-0.05)
```

#### Decision 4: Minimum invocations threshold

**Decision: Agents with < 1 invocation get a `null` reputation (no data).**

Changed from v1 (was 3). For hackathon demo-ability, even a single invocation should produce a score. Avoids "empty reputation" scenario in demos with few events.

### 2.2 Desglose del scope pedido vs realidad

| Item del scope HU | Analisis | Veredicto |
|--------------------|----------|-----------|
| **Metricas: latencia** | `latency_ms` tracked per `compose_step` event | **IN SCOPE** — use avg from events |
| **Metricas: success rate** | `status` (success/failed) tracked per event | **IN SCOPE** — ratio calculation |
| **Metricas: cost efficiency** | `cost_usdc` tracked per event | **IN SCOPE** — normalize against MAX_COST_USDC=0.10 |
| **Alimenta /discover para ranking inteligente** | Discovery already sorts by `reputation` field | **IN SCOPE** — enrich agents with computed scores (0-5 scale) |
| **User ratings** | No user rating system exists. No UI. | **SCOPE OUT** — hackathon, no UI for user input. |
| **ML model / complex weighting** | Over-engineering for hackathon | **SCOPE OUT** — simple weighted formula |
| **Historical trend / decay** | Nice-to-have but not needed for demo | **SCOPE OUT** — flat average over all events |
| **Dashboard integration** | Dashboard already shows per-agent stats | **IN SCOPE** — add reputation score to agent summary |

### 2.3 Preguntas criticas (resueltas)

| # | Pregunta | Respuesta |
|---|----------|-----------|
| 1 | Donde se computa el score? | In `reputationService.getScores()` — reads aggregated metrics from `v_reputation_scores` VIEW, applies formula in TypeScript, returns scores. No upsert, no TTL. |
| 2 | Por que no reusar `eventService.stats()` para los datos? | Because `stats()` does NOT filter by `event_type` and includes `orchestrate_goal` events (which have `agent_id=null`). Reputation needs a dedicated query: `WHERE event_type = 'compose_step' AND agent_id IS NOT NULL`. The VIEW encapsulates this filter. (B-2) |
| 3 | Que escala tiene el score final? | Internal computation is 0-1. Final score is **0-5** (multiplied by 5) to match registry scale. (B-1) |
| 4 | `agent_id` o `agent_slug`? | The `a2a_events.agent_id` column stores the agent SLUG, not UUID (confirmed at `compose.ts:110`). Reputation domain uses `agent_slug` naming. Discovery enrichment joins on `Agent.slug`. (B-3) |
| 5 | Como se enrichen los agentes en discovery? | Post-fetch from registries, call `reputationService.getScores()` passing agent slugs. For each agent with a computed score, override `agent.reputation` with the 0-5 scaled score. Sort as today. |
| 6 | minReputation de DiscoveryQuery se implementa? | **Si.** Filter agents with `reputation < minReputation` post-enrichment. Already in the type, needs implementation. |
| 7 | Que pasa si no hay eventos para un agente? | No row in VIEW -> no computed score -> keep registry reputation (or 0). Sorted normally — registry scores (4.5-4.9) are valid on the same 0-5 scale. |

### 2.4 Dependencias bloqueantes

| Dependencia | Tipo | Estado | Impacto |
|-------------|------|--------|---------|
| Tabla `a2a_events` con datos | Interna | OK (WKH-27 DONE) | Reputation computed from events. Sin eventos = sin scores. |
| Supabase migration tooling | Interna | OK (patron existente) | Nueva migracion SQL para VIEW. |

### 2.5 Riesgos

| # | Riesgo | Probabilidad | Impacto | Mitigacion |
|---|--------|-------------|---------|------------|
| R1 | Pocos eventos => scores basados en 1 call | Alta (hackathon) | Volatile scores | Acceptable for demo. threshold=1 chosen intentionally for demo-ability. |
| R2 | VIEW scan on every /discover call | Baja (hackathon, <1000 events) | +10-50ms | VIEW query is fast for small datasets. Post-hackathon: materialized view if needed. |
| R3 | Scale mismatch between registries | Baja | Inconsistent sorting | All registries use same mock schema. Computed scores scaled to 0-5 to match. |
| R4 | 100% failure agents score misleadingly high (2.5/5) because failed events have `latency_ms ~0` and `cost_usdc = 0`, rewarding failures on latency and cost axes. Acceptable for demo (mock agents always succeed). Post-hackathon: compute `avg_cost` and `avg_latency` over successful events only, or add a `success_rate` floor. | Low (demo) |

---

## 3. Work Item Normalizado

### 3.1 Metadata

| Campo | Valor |
|-------|-------|
| **#** | 017 |
| **Titulo** | Reputation Scoring — Modelo de Latencia, Success Rate, Cost Efficiency |
| **Tipo** | feature |
| **HU** | WKH-28 |
| **Branch** | `feat/017-reputation-scoring` |
| **SDD_MODE** | full |
| **Sizing** | **S** (~2h, 3 waves — simplified by VIEW approach) |
| **Objetivo** | Computar reputation scores para agentes basado en metricas existentes (latency, success rate, cost efficiency) del event log via SQL VIEW, y enriquecer el endpoint `/discover` para ranking inteligente por reputation computada en escala 0-5. |

### 3.2 Acceptance Criteria (EARS)

| AC | Criterio |
|----|----------|
| AC-1 | WHEN `reputationService.getScores()` is invoked, THEN it SHALL query the `v_reputation_scores` SQL VIEW (which aggregates only `compose_step` events where `agent_id IS NOT NULL` from `a2a_events`), compute per-agent metrics (success_rate, avg_latency_ms, avg_cost_usdc, total_invocations), apply the weighted formula `raw = 0.50 * success_rate + 0.30 * latency_score + 0.20 * cost_efficiency`, scale to 0-5 (`raw * 5`), and return the results. |
| AC-2 | WHEN an agent has fewer than 1 `compose_step` event (i.e., zero rows in VIEW), THEN its computed reputation SHALL be absent (no override), and the agent SHALL retain its registry-provided reputation value. |
| AC-3 | WHEN `GET /discover` is called, THEN the service SHALL enrich returned agents with computed reputation scores (0-5 scale) from the VIEW. IF a computed score exists for an agent slug, THEN it SHALL override the registry-provided reputation value. IF no computed score exists, THEN the registry-provided reputation (or 0) SHALL be used. Enrichment joins on `Agent.slug` (NOT `Agent.id`). |
| AC-4 | WHEN `GET /discover?minReputation=X` is called, THEN agents with `reputation < X` SHALL be filtered out from the results (post-enrichment). |
| AC-5 | WHEN `GET /dashboard/api/stats` is called, THEN the `agents` array in the response SHALL include a `reputationScore` field per agent (nullable, 0-5 scale). |
| AC-6 | WHILE computing reputation scores, IF the VIEW query fails, THEN the service SHALL log the error and return an empty array (non-blocking — discovery continues with registry-provided scores). |
| AC-7 | WHEN the scoring formula is applied, THEN `MAX_COST_USDC` SHALL be `0.10` (NOT 1.0), ensuring meaningful cost differentiation among mock agents priced at 0.01-0.05 USDC. |

### 3.3 Scope IN

| Archivo | Accion | Descripcion |
|---------|--------|-------------|
| `supabase/migrations/20260405300000_reputation_view.sql` | **Crear** | SQL VIEW `v_reputation_scores` that aggregates `a2a_events` WHERE `event_type = 'compose_step' AND agent_id IS NOT NULL`, grouped by `agent_id` (which stores slug). Returns: `agent_slug`, `agent_name`, `registry`, `total_invocations`, `success_count`, `success_rate`, `avg_latency_ms`, `avg_cost_usdc`. |
| `src/services/reputation.ts` | **Crear** | `reputationService` with: `getScores(agentSlugs?: string[])` — reads from VIEW, applies formula in code, returns array of `ReputationScore`. `getScore(agentSlug: string)` — single agent convenience. No TTL, no upsert, no `computed_at`. |
| `src/services/reputation.test.ts` | **Crear** | Tests: (T1) getScores happy path with known VIEW data, (T2) formula correctness for known inputs, (T3) agent with no events returns no score, (T4) error handling returns empty array, (T5) scores are scaled to 0-5, (T6) formula clamps at boundaries: `avg_latency_ms > 30000` → `latencyScore=0`; `avg_cost_usdc > 0.10` → `costEfficiency=0`, (T7) `minReputation` filter excludes agents with reputation below threshold. |
| `src/types/index.ts` | **Modificar** | Add `ReputationScore` interface with `agentSlug` (not `agentId`). Add `reputationScore?: number \| null` to `AgentSummary`. |
| `src/services/discovery.ts` | **Modificar** | After fetching agents from registries, call `reputationService.getScores(slugs)` to enrich `Agent.reputation` with computed scores (0-5). Join on `agent.slug`. Implement `minReputation` filter. Wrap in try/catch. |
| `src/services/event.ts` | **Modificar** | In `stats()`, after building `agents` array, call `reputationService.getScores(slugs)` to merge `reputationScore` into each `AgentSummary`. Wrap in try/catch (non-blocking). |
| `src/routes/discover.ts` | **Modificar** | Fix comment: `minReputation: (0-1)` → `minReputation: minimum reputation score (0-5)` to reflect actual 0-5 scale after B-1 scale correction. |

### 3.4 Scope OUT

- **Materialized table / upsert / TTL cache** — replaced by SQL VIEW (S-1). No `reputation_scores` table, no `computed_at`, no TTL logic.
- **User ratings system** — no UI for input, no API endpoint. No `user_rating_avg` field in VIEW.
- **ML-based scoring model** — simple weighted formula only.
- **Time-decay / windowed scoring** — all events weighted equally regardless of age.
- **Real-time streaming updates** — VIEW is always fresh by definition.
- **Dedicated `/reputation` API routes** — reputation is consumed internally by discovery and dashboard.
- **Cron job / background worker** — not needed with VIEW approach.
- **Configurable weights via API** — weights are constants in code.
- **Reputation history / trend** — VIEW computes current snapshot only.

---

## 4. Scoring Formula — Detailed Specification

### 4.1 Data Source: SQL VIEW `v_reputation_scores`

The VIEW queries `a2a_events` with **explicit filters** (B-2):

```sql
WHERE event_type = 'compose_step'
  AND agent_id IS NOT NULL
```

This excludes `orchestrate_goal` events (which have `agent_id=null`) and any future event types. This is NOT the same query as `eventService.stats()`.

### 4.2 Input Metrics (from VIEW, grouped by agent_id/slug)

| Metric | SQL Expression | Type |
|--------|---------------|------|
| `agent_slug` | `agent_id` (column stores slug, see B-3) | TEXT |
| `agent_name` | `MAX(agent_name)` | TEXT |
| `registry` | `MAX(registry)` | TEXT |
| `total_invocations` | `COUNT(*)` | INTEGER |
| `success_count` | `COUNT(*) FILTER (WHERE status = 'success')` | INTEGER |
| `success_rate` | `success_count::numeric / total_invocations` | NUMERIC 0-1 |
| `avg_latency_ms` | `AVG(latency_ms)::integer` | INTEGER |
| `avg_cost_usdc` | `AVG(cost_usdc)` | NUMERIC |

### 4.3 Normalized Scores (0-1 internal, applied in TypeScript)

```typescript
const MAX_LATENCY_MS = 30_000  // 30 seconds
const MAX_COST_USDC  = 0.10   // 0.10 USDC (M-1: lowered from 1.0 for mock price differentiation)
const MIN_INVOCATIONS = 1     // minimum events for scoring (S-4: lowered from 3 for demo-ability)
const SCORE_SCALE    = 5      // multiply raw 0-1 score to 0-5 (B-1: match registry scale)

// Success rate: already 0-1 from VIEW
const successRate = row.success_rate

// Latency score: lower latency -> higher score
const latencyScore = 1 - Math.min(row.avg_latency_ms / MAX_LATENCY_MS, 1)

// Cost efficiency: lower cost -> higher score
const costEfficiency = 1 - Math.min(row.avg_cost_usdc / MAX_COST_USDC, 1)
```

### 4.4 Weighted Formula

```typescript
const W_SUCCESS  = 0.50
const W_LATENCY  = 0.30
const W_COST     = 0.20

const rawScore = (
  W_SUCCESS * successRate +
  W_LATENCY * latencyScore +
  W_COST * costEfficiency
)
// rawScore: 0-1

const reputationScore = Number((rawScore * SCORE_SCALE).toFixed(2))
// reputationScore: 0-5 (B-1: matches registry scale)
```

### 4.5 Examples (with corrected constants)

| Agent | Invocations | Success Rate | Avg Latency | Avg Cost | Latency Score | Cost Score | Raw (0-1) | **Reputation (0-5)** |
|-------|-------------|-------------|-------------|----------|---------------|------------|-----------|---------------------|
| docusynth | 10 | 0.90 | 2000ms | $0.03 | 0.933 | 0.700 | 0.870 | **4.35** |
| codeweaver | 5 | 1.00 | 500ms | $0.05 | 0.983 | 0.500 | 0.895 | **4.48** |
| dataforge | 20 | 0.60 | 15000ms | $0.01 | 0.500 | 0.900 | 0.630 | **3.15** |
| new-agent | 1 | 1.00 | 100ms | $0.02 | 0.997 | 0.800 | 0.959 | **4.80** |
| unknown-agent | 0 | -- | -- | -- | -- | -- | -- | **null** (no events, keep registry value) |

Note how with `MAX_COST_USDC=0.10`, costs of $0.01-$0.05 produce meaningfully different cost_efficiency scores (0.50-0.90), unlike with MAX=1.0 where they would all be 0.95-0.99.

---

## 5. Database Schema — SQL VIEW `v_reputation_scores`

```sql
-- ============================================================
-- Migration: 20260405300000_reputation_view
-- WKH-28: SQL VIEW for reputation score computation
-- Simplified approach (S-1): VIEW instead of materialized table
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
WHERE event_type = 'compose_step'                       -- B-2: only compose_step events
  AND agent_id IS NOT NULL                              -- B-2: exclude orchestrate_goal (agent_id=null)
GROUP BY agent_id;

-- NOTE: agent_id column in a2a_events stores the agent SLUG (B-3).
-- The VIEW aliases it as agent_slug for clarity.
-- No index needed — this is a VIEW, not a table.
-- For <1000 events (hackathon), query is fast (<50ms).
```

**Why VIEW and not TABLE (S-1):**

| Aspect | TABLE (v1) | VIEW (v2) |
|--------|-----------|-----------|
| Migration | CREATE TABLE + indices | CREATE VIEW (5 lines) |
| Write logic | Upsert on every recompute | None — read-only |
| Staleness | TTL cache (60s), `computed_at` | Always fresh |
| Code complexity | `computeScores()` + `getScores()` + TTL | `getScores()` only |
| Performance (<1000 rows) | Fast reads | Fast reads (VIEW on small table) |
| Performance (>10K rows) | Better (pre-computed) | Convert to materialized view |

---

## 6. Propuesta de Waves

### Wave 0: Types + Migration (~20 min)

| Task | Archivo | Accion | Descripcion |
|------|---------|--------|-------------|
| W0.1 | `supabase/migrations/20260405300000_reputation_view.sql` | Crear | SQL VIEW `v_reputation_scores` as specified in section 5. |
| W0.2 | `src/types/index.ts` | Modificar | Add `ReputationScore` interface: `{ agentSlug: string, agentName: string, registry: string, totalInvocations: number, successCount: number, successRate: number, avgLatencyMs: number, avgCostUsdc: number, latencyScore: number, costEfficiency: number, reputationScore: number }`. Add `reputationScore?: number \| null` to `AgentSummary`. Note: `agentSlug` not `agentId` (B-3). |

**Verificacion W0:** `tsc --noEmit` passes. Migration applied to Supabase (VIEW created).

### Wave 1: Reputation Service + Tests (~45 min, test-first)

| Task | Archivo | Accion | Descripcion | Exemplar |
|------|---------|--------|-------------|----------|
| W1.1 | `src/services/reputation.test.ts` | Crear | Tests: (T1) getScores returns scored agents from VIEW data, (T2) formula correctness: known inputs -> expected 0-5 output, (T3) empty VIEW -> empty array (not error), (T4) Supabase error -> empty array + console.error, (T5) scores are in 0-5 range (not 0-1), (T6) formula clamps at boundaries: agent with `avg_latency_ms > 30000` gets `latencyScore=0`, agent with `avg_cost_usdc > 0.10` gets `costEfficiency=0`, (T7) `minReputation` filter in discovery excludes agents with reputation below the given threshold. | `src/services/event.ts` pattern |
| W1.2 | `src/services/reputation.ts` | Crear | `reputationService` object: `getScores(agentSlugs?)` reads from `v_reputation_scores` VIEW, optionally filtered by slugs (`.in('agent_slug', slugs)`), applies formula in code (section 4), returns `ReputationScore[]`. `getScore(agentSlug)` is convenience wrapper. Constants: `MAX_LATENCY_MS=30000`, `MAX_COST_USDC=0.10`, `MIN_INVOCATIONS=1`, `SCORE_SCALE=5`. Uses `rowToReputationInput(row)` helper. | `src/services/event.ts` |

**Key implementation notes for W1.2:**
- Query VIEW: `supabase.from('v_reputation_scores').select('*')` — Supabase treats views like tables for SELECT.
- If `agentSlugs` provided: `.in('agent_slug', agentSlugs)`.
- Filter: `row.total_invocations >= MIN_INVOCATIONS` (should always be true since VIEW only has rows with events, but defensive).
- Formula applied in TypeScript (section 4.4), NOT in SQL.
- Error handling: try/catch -> `console.error(...)` -> return `[]`.

**Verificacion W1:** `tsc --noEmit` + `vitest run src/services/reputation.test.ts` pass.

### Wave 2: Discovery Enrichment + Dashboard + Filter (~45 min)

| Task | Archivo | Accion | Descripcion | Exemplar |
|------|---------|--------|-------------|----------|
| W2.1 | `src/services/discovery.ts` | Modificar | In `discover()`: after `results.flat()`, extract slugs via `allAgents.map(a => a.slug)`. Call `reputationService.getScores(slugs)`. Build a `Map<string, number>` of slug->score. For each agent: if map has score for `agent.slug`, set `agent.reputation = score` (already 0-5). Then apply `minReputation` filter: `allAgents.filter(a => !query.minReputation \|\| (a.reputation ?? 0) >= query.minReputation)`. Wrap entire enrichment in try/catch (non-blocking). | Existing sort at line 36 |
| W2.2 | `src/services/event.ts` | Modificar | In `stats()`: after building `agents` array, extract agentIds (which are slugs). Call `reputationService.getScores(slugs)`. Build a Map. For each AgentSummary, set `reputationScore = map.get(agent.agentId) ?? null`. Wrap in try/catch (non-blocking). | Existing agent loop in `stats()` |
| W2.3 | Verificacion final | -- | `npm run lint && npm run test && npm run build`. Discovery returns agents sorted by computed reputation (0-5 scale). Dashboard API includes reputationScore per agent. `minReputation` filter works. |

**Operation order in `discover()` (M-2):**
1. Fetch agents from registries (existing)
2. Merge results with `flat()` (existing)
3. Enrich with reputation scores (NEW)
4. Sort by reputation desc, price asc (existing)
5. Filter by `minReputation` if provided (NEW)
6. Apply limit (existing)

**Comment fix in `src/routes/discover.ts` (M-8):** Update `minReputation: (0-1)` → `minReputation: minimum reputation score (0-5)`.

**Verificacion W2:** Full QA — lint + tests + build + manual test of `/discover` and `/dashboard/api/stats`.

### Grafo de dependencias

```
Wave 0 (foundation, ~20 min)
  W0.1 VIEW migration SQL ----+
  W0.2 types/index.ts --------+
                               |
                               v
Wave 1 (service, test-first, ~45 min)
  W1.1 reputation.test.ts --> W1.2 reputation.ts
                                |
                                v
Wave 2 (integration, ~45 min)
  W2.1 discovery.ts enrichment (join on agent.slug, NOT agent.id)
  W2.2 event.ts dashboard (reputationScore in AgentSummary)
  W2.3 full QA
```

---

## 7. Smart Sizing

| Dimension | Valor | Justificacion |
|-----------|-------|---------------|
| **Archivos nuevos** | 3 | `reputation_view.sql`, `reputation.ts`, `reputation.test.ts` |
| **Archivos modificados** | 4 | `types/index.ts`, `discovery.ts`, `event.ts`, `routes/discover.ts` (comment fix) |
| **Complejidad tecnica** | Baja-Media | SQL VIEW + weighted formula in code. No upsert, no TTL, no cache. |
| **Riesgo integracion** | Bajo | Enrichment in discovery is additive — wrapped in try/catch, falls back to registry scores. |
| **Tests requeridos** | 7 | T1-T7 for reputation service (T6: boundary clamps, T7: minReputation filter) |
| **Estimacion** | **S — 2 SP (~2h)** | 3 waves, simplified by VIEW approach |

### Breakdown de esfuerzo

| Wave | Esfuerzo estimado | Notas |
|------|-------------------|-------|
| W0 | 20 min | VIEW migration + types |
| W1 | 45 min | Core service + tests (formula, VIEW query) |
| W2 | 45 min | Integration into discovery + dashboard + QA |
| **Total** | **~1.5-2h** | Reduced from v1 (~3h) by eliminating upsert/TTL complexity |

---

## 8. Decisiones de Diseno Consolidadas

| # | Decision | Rationale | Changed from v1? |
|---|----------|-----------|-------------------|
| D1 | **SQL VIEW** over materialized table | Simpler for hackathon. No upsert, no TTL, no computed_at. Always fresh. <1000 events = fast. | **YES** (was materialized table) |
| D2 | **Scale to 0-5** (raw * 5) | Registry scores are 0-5 (4.5-4.9). Discovery sorts on single `reputation` field. Must be comparable. | **YES** (was 0-1) |
| D3 | **Filter event_type='compose_step' AND agent_id IS NOT NULL** | `orchestrate_goal` events have null agent_id and would pollute per-agent aggregation. `stats()` does not filter. | **YES** (was implicit) |
| D4 | **Use agent_slug throughout** (not agent_id) | `a2a_events.agent_id` stores the slug. Discovery must join on `Agent.slug`. | **YES** (was agent_id) |
| D5 | **MAX_COST_USDC = 0.10** | Mock prices are 0.01-0.05. With MAX=1.0, cost_efficiency for all agents was ~0.95-0.99 (no differentiation). | **YES** (was 1.0) |
| D6 | **MIN_INVOCATIONS = 1** | Hackathon demo-ability. Even 1 call produces a score. | **YES** (was 3) |
| D7 | **Computed score overrides registry score** | Our observed data is more reliable than static registry values. Fallback to registry if no events. | No change |
| D8 | **Non-blocking enrichment in discovery** | Reputation errors must never break agent discovery. Try/catch wrapper, fallback to registry values. | No change |
| D9 | **Weights 50/30/20** (success/latency/cost) | Reliability most important. Speed second. Cost differentiator. | No change |
| D10 | **No user ratings for hackathon** | No UI exists. Formula uses only automated metrics. | No change |

---

## 9. Escalation Rule

> Si algo no esta en este Work Item, Dev PARA y pregunta a Architect.
> No inventar. No asumir. No improvisar.

---

*Work Item generado por NexusAgil — F0 + F1 (Analyst + Architect)*
*Fecha: 2026-04-05*
*Revision: v2 — incorpora hallazgos adversariales (B-1, B-2, B-3, M-1, M-4, S-1, S-4)*
*Revision: v2.1 — quick fixes (M-2, M-5, M-7, M-8)*
