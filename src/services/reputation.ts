/**
 * Reputation Service — off-chain score computado desde `a2a_events` (WKH-103).
 *
 * Computa un score de reputación 0-100 por agente a partir de las tasks
 * liquidadas verificables (`status='success' AND cost_usdc>0`, anti-sybil
 * CD-1). Cero gas, cero escritura on-chain — lee SOLO `a2a_events`.
 *
 * WKH-104 (TD-SYBIL): cap anti-sybil POR CALLER. `tasks_settled` ya no es el
 * conteo crudo de tasks liquidadas: cada caller (`caller_ref_hash` del evento,
 * o el bucket `'__anon__'` para históricos/anónimos) aporta a lo sumo K tasks
 * (`REPUTATION_MAX_TASKS_PER_CALLER`, default 5). Así un único caller no puede
 * inflar el score de un agente vía autopago repetido. El cap se aplica 100% en
 * el reduce JS in-memory (1 query por path, anti-N+1 CD-10). `success_rate` y
 * `total_volume_usdc` NO se capean (OBS-1). Efecto en históricos (CD-8): los
 * eventos previos a WKH-104 no tienen `caller_ref_hash` → caen en `'__anon__'`
 * capeado a K, por lo que scores inflados existentes pueden BAJAR (esperado).
 *
 * `agent_id` en `a2a_events` = `agent.slug` (compose.ts:278), NO `agent.id`.
 * El service recibe el slug.
 *
 * Cache: Map en-proceso con TTL por env (DT-4). NO hay Redis en el repo
 * (AH-4) — el cache es memoria del proceso. Patrón lazy-Map de los adapters.
 *
 * Graceful (CD-5/CD-18): cualquier error de Supabase se loguea server-side y
 * la función devuelve `null` (single) o `Map` vacío (batch). NUNCA se propaga
 * `error.message` crudo al caller. NO toca `a2a_agent_keys` (CD-2/CD-3).
 */
import { supabase } from '../lib/supabase.js';
import type { AgentReputation } from '../types/index.js';

// ── Env helpers (patrón resolveTimeoutMs, erc8004-identity.ts:89-93) ──

function resolveScaleFactor(): number {
  const raw = process.env.REPUTATION_SCALE_FACTOR;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 50;
}

// WKH-104 (TD-SYBIL CD-7): K del cap por caller. Cada (agent, caller_ref_hash)
// aporta a lo sumo K tasks liquidadas → un caller no puede inflar su propio
// score con autopago. Default 5 si ausente/inválido. Patrón resolveScaleFactor.
function resolveMaxTasksPerCaller(): number {
  const raw = process.env.REPUTATION_MAX_TASKS_PER_CALLER;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 5;
}

function resolveCacheTtlMs(): number {
  const raw = process.env.REPUTATION_CACHE_TTL_MS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}

// ── Cache en-proceso (NO Redis — AH-4). Patrón lazy-Map adapters. ──

interface CacheEntry {
  value: AgentReputation | null;
  expiresAt: number;
}
const _cache = new Map<string, CacheEntry>();

/** TEST-ONLY — limpia el cache (patrón _resetErc8004Reader). */
export function _resetReputationCache(): void {
  _cache.clear();
}

// ── Acumulador interno del reduce JS (patrón agentMap, event.ts:134) ──

interface RepAccumulator {
  // WKH-104 (TD-SYBIL CD-7): tasks liquidadas por caller. key =
  // caller_ref_hash | '__anon__'. El cap por caller se aplica en
  // computeFromAccumulator (reduce JS, anti-N+1 CD-10).
  settledByCaller: Map<string, number>;
  settledVolume: number; // SUM(cost_usdc) de los liquidados (sin cap, OBS-1)
  settledLatencySum: number; // SUM(latency_ms) de los liquidados (no null)
  settledLatencyCount: number;
  successCount: number; // status='success' (cualquier costo)
  failedCount: number; // status='failed'
}

/** Filas que pedimos a Supabase (select mínimo, DT-5/CD-2). */
interface RepRow {
  agent_id: string | null;
  status: string;
  cost_usdc: number | string | null;
  latency_ms: number | null;
  // WKH-104 (CD-15): metadata para extraer caller_ref_hash. Sin `any`.
  metadata: Record<string, unknown> | null;
}

function emptyAccumulator(): RepAccumulator {
  return {
    settledByCaller: new Map<string, number>(),
    settledVolume: 0,
    settledLatencySum: 0,
    settledLatencyCount: 0,
    successCount: 0,
    failedCount: 0,
  };
}

/** Acumula una fila en el accumulator del slug (anti-sybil CD-1 en JS). */
function accumulateRow(acc: RepAccumulator, row: RepRow): void {
  const isSuccess = row.status === 'success';
  const isFailed = row.status === 'failed';
  const cost = Number(row.cost_usdc ?? 0);

  if (isSuccess) {
    acc.successCount++;
    // tasks_settled exige success AND cost_usdc>0 (anti-sybil CD-1).
    if (Number.isFinite(cost) && cost > 0) {
      // WKH-104 (CD-7/CD-8): contabilizar la task bajo su caller. Eventos sin
      // caller_ref_hash (históricos o anónimos) caen en el bucket '__anon__'
      // (capeado a K en computeFromAccumulator), NUNCA error ni colapso a null.
      const hash =
        (row.metadata?.['caller_ref_hash'] as string | null | undefined) ??
        '__anon__';
      acc.settledByCaller.set(hash, (acc.settledByCaller.get(hash) ?? 0) + 1);
      acc.settledVolume += cost;
      if (row.latency_ms != null) {
        acc.settledLatencySum += row.latency_ms;
        acc.settledLatencyCount++;
      }
    }
  } else if (isFailed) {
    acc.failedCount++;
  }
}

/**
 * Fórmula determinista (DT-2 + OBS-1). Retorna `null` si 0 tasks liquidadas
 * (→ el caller omite el campo, CD-9). `success_rate` modula el score sobre el
 * universo success+failed del slug (OBS-1).
 */
function computeFromAccumulator(acc: RepAccumulator): AgentReputation | null {
  // WKH-104 (TD-SYBIL CD-7/CD-8): cap por caller. Cada caller (incl. el bucket
  // '__anon__' de históricos/anónimos) aporta a lo sumo K tasks. Esto evita
  // que un caller infle su propio score con autopago. Eventos legacy sin
  // caller_ref_hash caen en '__anon__' → su contribución queda capeada a K,
  // por lo que scores inflados pre-WKH-104 pueden BAJAR (esperado, no bug).
  const K = resolveMaxTasksPerCaller();
  let tasksSettled = 0;
  for (const n of acc.settledByCaller.values()) tasksSettled += Math.min(n, K);
  if (tasksSettled === 0) return null;

  const totalVolumeUsdc = Number(acc.settledVolume.toFixed(6));
  const avgLatencyMs =
    acc.settledLatencyCount > 0
      ? Math.round(acc.settledLatencySum / acc.settledLatencyCount)
      : undefined;

  const denom = acc.successCount + acc.failedCount;
  const successRate =
    denom > 0 ? Number((acc.successCount / denom).toFixed(2)) : 1;

  const raw = Math.min(tasksSettled / resolveScaleFactor(), 1);
  const score = Math.round(raw * 100 * successRate);

  return {
    score,
    tasks_settled: tasksSettled,
    success_rate: successRate,
    total_volume_usdc: totalVolumeUsdc,
    // OMITIDO si no hay latency (no null) — spread condicional (CD-9).
    ...(avgLatencyMs !== undefined && { avg_latency_ms: avgLatencyMs }),
    source: 'off-chain',
  };
}

export interface ReputationService {
  /**
   * Single-agent (path AgentCard). 1 query por slug + cache en-proceso (DT-4).
   * Retorna null si 0 tasks liquidadas (→ campo omitido por el caller, CD-9).
   */
  computeReputationForAgent(slug: string): Promise<AgentReputation | null>;

  /**
   * Batch (path /discover). UN solo SELECT con .in('agent_id', slugs) (CD-12).
   * Retorna Map<slug, AgentReputation> SOLO para slugs con score (>0 tasks).
   * Slugs sin tasks NO aparecen en el Map (caller omite el campo).
   */
  computeReputationBatch(
    slugs: string[],
  ): Promise<Map<string, AgentReputation>>;
}

export const reputationService: ReputationService = {
  async computeReputationForAgent(
    slug: string,
  ): Promise<AgentReputation | null> {
    const ttl = resolveCacheTtlMs();
    const hit = _cache.get(slug);
    if (hit && hit.expiresAt > Date.now()) return hit.value; // cache hit (T-CACHE)

    const { data, error } = await supabase
      .from('a2a_events')
      .select('agent_id, status, cost_usdc, latency_ms, metadata')
      .eq('agent_id', slug);

    if (error) {
      // CD-18: log server-side, NUNCA propagar error.message al caller.
      // NO cachear el fallo (AC-4/CD-5).
      console.error('[Reputation] computeReputationForAgent query failed', {
        slug,
        code: error.code,
      });
      return null;
    }

    const acc = emptyAccumulator();
    for (const row of (data ?? []) as RepRow[]) {
      accumulateRow(acc, row);
    }

    const result = computeFromAccumulator(acc);
    _cache.set(slug, { value: result, expiresAt: Date.now() + ttl });
    return result;
  },

  async computeReputationBatch(
    slugs: string[],
  ): Promise<Map<string, AgentReputation>> {
    const out = new Map<string, AgentReputation>();
    if (slugs.length === 0) return out;

    // UN solo SELECT con .in('agent_id', slugs) (CD-12/AH-7). PROHIBIDO 1
    // query por agente. status/cost se filtran en el reduce JS porque
    // necesitamos success+failed para success_rate (OBS-1).
    const { data, error } = await supabase
      .from('a2a_events')
      .select('agent_id, status, cost_usdc, latency_ms, metadata')
      .in('agent_id', slugs);

    if (error) {
      // CD-18: log server-side, NUNCA propagar error.message. Batch falla →
      // Map vacío (caller deja a los agentes sin el campo, AC-4).
      console.error('[Reputation] computeReputationBatch query failed', {
        count: slugs.length,
        code: error.code,
      });
      return out;
    }

    // Reduce JS por agent_id en Map<slug, RepAccumulator> (patrón agentMap).
    const accBySlug = new Map<string, RepAccumulator>();
    for (const row of (data ?? []) as RepRow[]) {
      const slug = row.agent_id;
      if (slug == null) continue; // .in por slugs ya excluye null, defensivo
      let acc = accBySlug.get(slug);
      if (!acc) {
        acc = emptyAccumulator();
        accBySlug.set(slug, acc);
      }
      accumulateRow(acc, row);
    }

    // Aplicar fórmula; solo agregar slugs con tasks_settled>0.
    for (const [slug, acc] of accBySlug) {
      const rep = computeFromAccumulator(acc);
      if (rep) out.set(slug, rep);
    }

    return out;
  },
};
