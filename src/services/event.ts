/**
 * Event Service — Track compose/orchestrate events for Dashboard
 * WKH-27: Dashboard Analytics
 */

import { supabase } from '../lib/supabase.js';
import type { A2AEvent, AgentSummary, DashboardStats } from '../types/index.js';

// ── Tipo interno para filas de Supabase ─────────────────────

interface EventRow {
  id: string;
  event_type: string;
  agent_id: string | null;
  agent_name: string | null;
  registry: string | null;
  status: 'success' | 'failed';
  latency_ms: number | null;
  cost_usdc: number;
  tx_hash: string | null;
  goal: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

// ── Helper: Row → Domain ────────────────────────────────────

function rowToEvent(row: EventRow): A2AEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    agentId: row.agent_id,
    agentName: row.agent_name,
    registry: row.registry,
    status: row.status,
    latencyMs: row.latency_ms,
    costUsdc: Number(row.cost_usdc),
    txHash: row.tx_hash,
    goal: row.goal,
    metadata: row.metadata,
    createdAt: new Date(row.created_at),
  };
}

// ── Service ─────────────────────────────────────────────────

export const eventService = {
  /**
   * Track a compose/orchestrate event.
   * Designed to be called fire-and-forget: caller uses .catch() to avoid unhandled rejections.
   */
  async track(input: {
    eventType?: string;
    agentId?: string;
    agentName?: string;
    registry?: string;
    status: 'success' | 'failed';
    latencyMs?: number;
    costUsdc?: number;
    txHash?: string;
    goal?: string;
    metadata?: Record<string, unknown>;
  }): Promise<A2AEvent> {
    const row: Partial<EventRow> = {
      event_type: input.eventType ?? 'compose_step',
      agent_id: input.agentId ?? null,
      agent_name: input.agentName ?? null,
      registry: input.registry ?? null,
      status: input.status,
      latency_ms: input.latencyMs ?? null,
      cost_usdc: input.costUsdc ?? 0,
      tx_hash: input.txHash ?? null,
      goal: input.goal ?? null,
      metadata: input.metadata ?? {},
    };

    const { data, error } = await supabase
      .from('a2a_events')
      .insert(row)
      .select()
      .single();

    if (error) throw new Error(`Failed to track event: ${error.message}`);
    return rowToEvent(data as EventRow);
  },

  /**
   * Get aggregated dashboard stats.
   * Runs multiple queries: registries count, tasks by status, event aggregations, agent summaries.
   */
  async stats(): Promise<DashboardStats> {
    // 1. Registries count
    const { count: registriesCount, error: regErr } = await supabase
      .from('registries')
      .select('*', { count: 'exact', head: true });

    if (regErr)
      throw new Error(`Failed to count registries: ${regErr.message}`);

    // 2. Tasks by status
    const { data: tasksData, error: tasksErr } = await supabase
      .from('tasks')
      .select('status');

    if (tasksErr) throw new Error(`Failed to get tasks: ${tasksErr.message}`);

    const tasksByStatus: Record<string, number> = {};
    for (const row of tasksData ?? []) {
      const s = (row as { status: string }).status;
      tasksByStatus[s] = (tasksByStatus[s] ?? 0) + 1;
    }

    // 3. Event aggregations
    const { data: eventsData, error: eventsErr } = await supabase
      .from('a2a_events')
      .select('status, latency_ms, cost_usdc, agent_id, agent_name, registry');

    if (eventsErr)
      throw new Error(`Failed to get events: ${eventsErr.message}`);

    const events = eventsData ?? [];
    const eventsTotal = events.length;
    const successCount = events.filter(
      (e: Record<string, unknown>) => e.status === 'success',
    ).length;
    const successRate =
      eventsTotal > 0 ? (successCount / eventsTotal) * 100 : 0;

    let totalCostUsdc = 0;
    let totalLatency = 0;
    let latencyCount = 0;

    // Agent aggregation map
    const agentMap = new Map<
      string,
      {
        agentName: string;
        registry: string;
        invocations: number;
        totalLatency: number;
        latencyCount: number;
        totalCost: number;
      }
    >();

    for (const e of events) {
      const event = e as Record<string, unknown>;
      totalCostUsdc += Number(event.cost_usdc ?? 0);
      if (event.latency_ms != null) {
        totalLatency += Number(event.latency_ms);
        latencyCount++;
      }

      // Per-agent aggregation
      const agentId = event.agent_id as string | null;
      if (agentId) {
        const existing = agentMap.get(agentId);
        if (existing) {
          existing.invocations++;
          existing.totalCost += Number(event.cost_usdc ?? 0);
          if (event.latency_ms != null) {
            existing.totalLatency += Number(event.latency_ms);
            existing.latencyCount++;
          }
        } else {
          agentMap.set(agentId, {
            agentName: (event.agent_name as string) ?? agentId,
            registry: (event.registry as string) ?? 'unknown',
            invocations: 1,
            totalLatency:
              event.latency_ms != null ? Number(event.latency_ms) : 0,
            latencyCount: event.latency_ms != null ? 1 : 0,
            totalCost: Number(event.cost_usdc ?? 0),
          });
        }
      }
    }

    const avgLatencyMs =
      latencyCount > 0 ? Math.round(totalLatency / latencyCount) : 0;

    const agents: AgentSummary[] = Array.from(agentMap.entries()).map(
      ([agentId, data]) => ({
        agentId,
        agentName: data.agentName,
        registry: data.registry,
        invocations: data.invocations,
        avgLatencyMs:
          data.latencyCount > 0
            ? Math.round(data.totalLatency / data.latencyCount)
            : 0,
        totalCostUsdc: Number(data.totalCost.toFixed(6)),
      }),
    );

    return {
      registriesCount: registriesCount ?? 0,
      tasksByStatus,
      eventsTotal,
      successRate: Number(successRate.toFixed(1)),
      totalCostUsdc: Number(totalCostUsdc.toFixed(6)),
      avgLatencyMs,
      agents,
    };
  },

  /**
   * Get recent events, ordered by created_at DESC.
   */
  async recent(limit = 20): Promise<A2AEvent[]> {
    const safeLimit = Math.min(Math.max(limit, 1), 100);

    const { data, error } = await supabase
      .from('a2a_events')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(safeLimit);

    if (error) throw new Error(`Failed to get recent events: ${error.message}`);
    return (data as EventRow[]).map(rowToEvent);
  },
};
