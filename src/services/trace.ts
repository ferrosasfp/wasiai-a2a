/**
 * Trace Service — WKH-191x · seguimiento operativo READ-ONLY del tráfico real.
 *
 * Lee telemetría ya escrita (`a2a_events`, `a2a_receipts`, `a2a_protocol_fees`) y la
 * arma en "llamadas" para la pantalla `/dashboard/trace`. NUNCA escribe, NUNCA
 * invoca un agente, NUNCA dispara un settle: cada ejecución real cuesta dinero, así
 * que esta superficie no tiene ni un camino que pueda gastar.
 *
 * ── Ownership Guard (CLAUDE.md) ────────────────────────────────────────────────
 * Esta pantalla es ADMIN y CROSS-TENANT POR DISEÑO (el operador tiene que ver el
 * tráfico de todos los owners), igual que `arbiterService.listHolds` (WKH-189, CD-5)
 * y `reconciliationService.listPending` (WKH-191c). Dos consecuencias explícitas:
 *
 *  1. Este service NO toca `a2a_agent_keys`, así que la regla de
 *     `.eq('owner_ref', …)` no tiene nada que proteger acá: sólo lee tablas de
 *     telemetría, y el `owner_ref` que muestra viene del propio recibo.
 *  2. NO se reusa `receiptService.list/getById`: esos tienen el guard por
 *     `ownerRef` y son per-tenant POR CONTRATO. Pasarles un owner falso, o
 *     agregarles un modo "sin guard", erosionaría el guard para todos sus callers.
 *     Un service admin con su propia query explícita es la opción segura.
 *
 * El control de acceso vive en la ruta (`requireAdminTokenForTrace`, fail-closed).
 *
 * ── Precisión numérica (lección WKH-196) ───────────────────────────────────────
 * Todos los montos se seleccionan con `::text` y viajan como STRING hasta el DOM.
 * `supabase-js` lee NUMERIC como número JSON y eso redondea valores grandes; acá
 * los montos son chicos (`NUMERIC(20,8)` / `NUMERIC(18,6)`), pero no parsear nada
 * es gratis y elimina la clase de bug entera.
 */

import {
  getAdaptersBundle,
  getDefaultChainKey,
  getInitializedChainKeys,
} from '../adapters/registry.js';
import {
  buildExplorerTxUrl,
  describeCaip2,
  describeChainId,
} from '../lib/chain-display.js';
import {
  describePublicSkipCode,
  isPublicSkipCode,
  type PublicDownstreamSkipCode,
} from '../lib/downstream-skip-code.js';
import { getLogger } from '../lib/logger.js';
import { supabase } from '../lib/supabase.js';
import { buildEventType } from '../middleware/event-tracking.js';
import type {
  TraceCall,
  TraceCorrelation,
  TraceFee,
  TraceHealth,
  TraceLastCrossChainSettle,
  TraceMoneyLeg,
  TraceNetwork,
  TracePayload,
  TraceSkipCount,
} from '../types/trace.js';

const log = getLogger('trace');

/**
 * Endpoints que mueven dinero: son los únicos cuyo evento vale la pena trazar
 * (`/discover` no paga a nadie). `/orchestrate/plan` queda afuera a propósito:
 * cotiza, no ejecuta.
 */
const TRACED_ENDPOINTS = [
  '/compose',
  '/orchestrate',
  '/orchestrate/execute',
] as const;

/** `event_type` construido con el MISMO helper que los escribe (cero drift). */
const TRACED_EVENT_TYPES = TRACED_ENDPOINTS.map((e) =>
  buildEventType('POST', e),
);

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 168; // 7 días
/** Recibos leídos por llamada pedida: un compose de 3 pasos emite ~7 recibos. */
const RECEIPTS_PER_CALL = 8;
/** Techo de eventos escaneados para el conteo de skips (query acotada). */
const SKIP_SCAN_LIMIT = 500;
/**
 * Cuántos settles recientes se miran para encontrar el último CRUCE de redes: un
 * settle en el mismo rail no cuenta, así que hace falta margen.
 */
const CROSS_CHAIN_SCAN_LIMIT = 25;

// ── Filas crudas (lo que devuelve el select, ya con `::text` aplicado) ─────────

interface EventSelectRow {
  id: string;
  event_type: string;
  status: string;
  latency_ms: number | null;
  metadata: unknown;
  created_at: string;
}

interface ReceiptSelectRow {
  id: string;
  owner_ref: string;
  receipt_type: string;
  amount_usd: string;
  chain_id: number;
  tx_hash: string | null;
  orchestration_id: string | null;
  created_at: string;
  settle_caip2: string | null;
  settle_signature: string | null;
}

interface FeeSelectRow {
  orchestration_id: string;
  fee_usdc: string;
  fee_total_usdc: string | null;
  status: string;
  tx_hash: string | null;
  created_at: string;
}

const EVENT_COLUMNS =
  'id, event_type, status, latency_ms, metadata, created_at';
const RECEIPT_COLUMNS =
  'id, owner_ref, receipt_type, amount_usd::text, chain_id, tx_hash, ' +
  'orchestration_id, created_at, settle_caip2, settle_signature';
const FEE_COLUMNS =
  'orchestration_id, fee_usdc::text, fee_total_usdc::text, status, tx_hash, created_at';

// ── Helpers puros ─────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function toNetwork(display: {
  key: string | null;
  label: string;
}): TraceNetwork {
  return { key: display.key, label: display.label };
}

/**
 * Explorer de la chain DEFAULT. Es el que corresponde al tx del protocol fee:
 * `chargeProtocolFee` firma y settlea con `getPaymentAdapter()` SIN `chainKey`
 * (`services/fee-charge.ts:458`/`:481`), o sea siempre en la chain default.
 * `a2a_protocol_fees` no tiene columna de chain, así que este es el único dato
 * derivable de la config real: nada hardcodeado.
 */
function defaultChainExplorer(): string | null {
  const key = getDefaultChainKey();
  if (!key) return null;
  return getAdaptersBundle(key)?.chainConfig.explorerUrl ?? null;
}

/** Lee una clave string de `metadata` (jsonb sin garantía de forma). */
function metaString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function metaNumber(metadata: unknown, key: string): number | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Skips PÚBLICOS de un evento. `null` = la fila no trae la señal (tráfico previo
 * a WKH-191x), que NO es lo mismo que "cero skips". Cualquier valor que no esté en
 * el vocabulario público se descarta (AC-6): un código interno no llega a la UI.
 */
function metaSkips(metadata: unknown): PublicDownstreamSkipCode[] | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = (metadata as Record<string, unknown>).downstreamSkips;
  if (!Array.isArray(raw)) return null;
  return raw.filter(isPublicSkipCode);
}

function countSkips(codes: PublicDownstreamSkipCode[]): TraceSkipCount[] {
  const counts = new Map<PublicDownstreamSkipCode, number>();
  for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);
  return [...counts.entries()]
    .map(([code, count]) => ({
      code,
      count,
      meaning: describePublicSkipCode(code),
    }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

/**
 * ¿El recibo es el DÉBITO al caller (y no el settle al agente ni el fee)?
 *
 * Los dos son `budget_debit` con el mismo `chain_id` y el mismo monto, así que se
 * distinguen por lo que SÓLO tiene el settle: una prueba on-chain
 * (`settle_caip2`/`settle_signature` para Solana, `tx_hash` para EVM). El débito al
 * caller se emite con los tres en NULL (`middleware/a2a-key.ts:1268`,
 * `services/budget.ts:174`/`:258`).
 */
function isCallerDebit(row: ReceiptSelectRow): boolean {
  return (
    row.receipt_type === 'budget_debit' &&
    !row.settle_caip2 &&
    !row.settle_signature &&
    !row.tx_hash
  );
}

function toMoneyLeg(row: ReceiptSelectRow): TraceMoneyLeg {
  const paid = describeChainId(row.chain_id);
  const collected = row.settle_caip2 ? describeCaip2(row.settle_caip2) : null;
  // La firma base58 del leg Solana vive en `settle_signature` (y se copia a
  // `tx_hash`); un settle EVM sólo tiene `tx_hash`.
  const hash = row.settle_signature ?? row.tx_hash;
  const explorerBase = collected ? collected.explorerUrl : paid.explorerUrl;
  return {
    receiptId: row.id,
    at: row.created_at,
    receiptType: row.receipt_type,
    amountUsd: row.amount_usd,
    ownerRef: row.owner_ref,
    paidOn: toNetwork(paid),
    collectedOn: collected ? toNetwork(collected) : null,
    crossChain:
      collected !== null &&
      (paid.key !== null && collected.key !== null
        ? paid.key !== collected.key
        : paid.label !== collected.label),
    txHash: hash,
    explorerTxUrl: buildExplorerTxUrl(explorerBase, hash),
    isCallerDebit: isCallerDebit(row),
  };
}

// ── Grupo mutable (una "llamada") ─────────────────────────────────────────────

interface MutableCall {
  id: string;
  at: string;
  hasEvent: boolean;
  endpoint: string | null;
  method: string | null;
  status: 'success' | 'failed' | null;
  httpStatus: number | null;
  latencyMs: number | null;
  legs: TraceMoneyLeg[];
  skips: PublicDownstreamSkipCode[];
  fee: TraceFee | null;
}

function emptyCall(id: string, at: string): MutableCall {
  return {
    id,
    at,
    hasEvent: false,
    endpoint: null,
    method: null,
    status: null,
    httpStatus: null,
    latencyMs: null,
    legs: [],
    skips: [],
    fee: null,
  };
}

function correlationOf(call: MutableCall): TraceCorrelation {
  const hasMoney = call.legs.length > 0 || call.fee !== null;
  if (call.hasEvent && hasMoney) return 'full';
  return call.hasEvent ? 'call-only' : 'money-only';
}

function finalizeCall(call: MutableCall): TraceCall {
  const legs = [...call.legs].sort((a, b) => a.at.localeCompare(b.at));
  return {
    id: call.id,
    at: call.at,
    correlation: correlationOf(call),
    endpoint: call.endpoint,
    method: call.method,
    status: call.status,
    httpStatus: call.httpStatus,
    latencyMs: call.latencyMs,
    ownerRef: legs[0]?.ownerRef ?? null,
    legs,
    skips: countSkips(call.skips),
    crossChain: legs.some((l) => l.crossChain),
    fee: call.fee,
  };
}

// ── Service ───────────────────────────────────────────────────────────────────

export const traceService = {
  /**
   * Salud del rail: chains registradas (misma fuente que `GET /capabilities`),
   * antigüedad del último settle cross-chain exitoso y skips por código público.
   */
  async health(windowHours = DEFAULT_WINDOW_HOURS): Promise<TraceHealth> {
    const hours = clamp(windowHours, 1, MAX_WINDOW_HOURS);
    const defaultChain = getDefaultChainKey();
    const chains = getInitializedChainKeys().flatMap((key) => {
      const bundle = getAdaptersBundle(key);
      if (!bundle) return [];
      return [
        {
          key,
          label: bundle.chainConfig.name,
          chainId: bundle.chainConfig.chainId,
          isDefault: key === defaultChain,
        },
      ];
    });

    const [lastCrossChainSettle, skipStats] = await Promise.all([
      this.lastCrossChainSettle(),
      this.skipCounts(hours),
    ]);

    return {
      chains,
      defaultChain,
      lastCrossChainSettle,
      skipWindowHours: hours,
      skips: skipStats.skips,
      skipsTotal: skipStats.total,
      skipSignalPresent: skipStats.signalPresent,
    };
  },

  /**
   * Último settle que CRUZÓ de red (pagado en un rail, cobrado en otro) con firma
   * on-chain. Es el mejor indicador de vida del rail: si tiene horas, algo se rompió.
   */
  async lastCrossChainSettle(): Promise<TraceLastCrossChainSettle | null> {
    const { data, error } = await supabase
      .from('a2a_receipts')
      .select(RECEIPT_COLUMNS)
      .not('settle_caip2', 'is', null)
      .not('settle_signature', 'is', null)
      .order('created_at', { ascending: false })
      .limit(CROSS_CHAIN_SCAN_LIMIT);
    if (error) {
      log.error({ detail: error.message }, 'lastCrossChainSettle query failed');
      throw new Error('trace read failed');
    }
    const rows = (data as unknown as ReceiptSelectRow[] | null) ?? [];
    for (const row of rows) {
      const leg = toMoneyLeg(row);
      // Un settle Solana pagado con budget Solana NO es cruce: no sirve como
      // prueba de vida del rail cross-chain.
      if (!leg.crossChain || !leg.collectedOn) continue;
      const ageMs = Date.now() - new Date(leg.at).getTime();
      return {
        at: leg.at,
        ageSeconds: Math.max(0, Math.round(ageMs / 1000)),
        paidOn: leg.paidOn,
        collectedOn: leg.collectedOn,
        signature: leg.txHash,
        explorerTxUrl: leg.explorerTxUrl,
        amountUsd: leg.amountUsd,
      };
    }
    return null;
  },

  /**
   * Conteo de skips por código PÚBLICO en la ventana. `signalPresent=false` = ningún
   * evento de la ventana trae la señal, o sea "sin datos", NO "cero skips".
   */
  async skipCounts(windowHours = DEFAULT_WINDOW_HOURS): Promise<{
    skips: TraceSkipCount[];
    total: number;
    signalPresent: boolean;
  }> {
    const hours = clamp(windowHours, 1, MAX_WINDOW_HOURS);
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    const { data, error } = await supabase
      .from('a2a_events')
      .select('metadata, created_at')
      .in('event_type', TRACED_EVENT_TYPES)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(SKIP_SCAN_LIMIT);
    if (error) {
      log.error({ detail: error.message }, 'skipCounts query failed');
      throw new Error('trace read failed');
    }
    const rows = (data as unknown as Array<{ metadata: unknown }> | null) ?? [];
    const codes: PublicDownstreamSkipCode[] = [];
    let signalPresent = false;
    for (const row of rows) {
      const skips = metaSkips(row.metadata);
      if (skips === null) continue;
      signalPresent = true;
      codes.push(...skips);
    }
    return { skips: countSkips(codes), total: codes.length, signalPresent };
  },

  /**
   * Últimas `limit` llamadas, lo último primero. Une TRES fuentes por clave de
   * correlación, sin heurísticas temporales (ver H-1/H-2 del work-item):
   *
   *   evento → `metadata.requestId ?? id` · recibo → `orchestration_id ??
   *   'receipt:<id>'` · fee → `orchestration_id`
   *
   * Un `/compose` con Agent Key queda como un grupo completo. Un flujo
   * `/orchestrate*` (cuyo `orchestrationId` es un UUID propio, NO el `request.id`) y
   * los `budget_debit` (que se emiten con `orchestration_id` NULL) quedan como
   * grupos propios en vez de mezclarse con la llamada de otro tenant.
   */
  async recentCalls(limit = DEFAULT_LIMIT): Promise<TraceCall[]> {
    const safeLimit = clamp(limit, 1, MAX_LIMIT);

    const [eventsRes, receiptsRes, feesRes] = await Promise.all([
      supabase
        .from('a2a_events')
        .select(EVENT_COLUMNS)
        .in('event_type', TRACED_EVENT_TYPES)
        .order('created_at', { ascending: false })
        .limit(safeLimit),
      supabase
        .from('a2a_receipts')
        .select(RECEIPT_COLUMNS)
        .order('created_at', { ascending: false })
        .limit(safeLimit * RECEIPTS_PER_CALL),
      supabase
        .from('a2a_protocol_fees')
        .select(FEE_COLUMNS)
        .order('created_at', { ascending: false })
        .limit(safeLimit),
    ]);

    for (const res of [eventsRes, receiptsRes, feesRes]) {
      if (res.error) {
        log.error({ detail: res.error.message }, 'recentCalls query failed');
        throw new Error('trace read failed');
      }
    }

    const events = (eventsRes.data as unknown as EventSelectRow[] | null) ?? [];
    const receipts =
      (receiptsRes.data as unknown as ReceiptSelectRow[] | null) ?? [];
    const fees = (feesRes.data as unknown as FeeSelectRow[] | null) ?? [];

    const calls = new Map<string, MutableCall>();
    const upsert = (id: string, at: string): MutableCall => {
      const existing = calls.get(id);
      if (existing) return existing;
      const created = emptyCall(id, at);
      calls.set(id, created);
      return created;
    };

    for (const ev of events) {
      const id = metaString(ev.metadata, 'requestId') ?? ev.id;
      const call = upsert(id, ev.created_at);
      call.hasEvent = true;
      // El evento manda la hora del grupo: es el momento de la llamada.
      call.at = ev.created_at;
      call.endpoint = metaString(ev.metadata, 'endpoint');
      call.method = metaString(ev.metadata, 'method');
      call.status = ev.status === 'success' ? 'success' : 'failed';
      call.httpStatus = metaNumber(ev.metadata, 'statusCode');
      call.latencyMs = ev.latency_ms;
      const skips = metaSkips(ev.metadata);
      if (skips) call.skips = skips;
    }

    for (const row of receipts) {
      const id = row.orchestration_id ?? `receipt:${row.id}`;
      const call = upsert(id, row.created_at);
      call.legs.push(toMoneyLeg(row));
      if (!call.hasEvent && row.created_at > call.at) call.at = row.created_at;
    }

    for (const row of fees) {
      const call = upsert(row.orchestration_id, row.created_at);
      call.fee = {
        // WKH-167: `fee_usdc` es SÓLO la pata plataforma del split; el total es
        // `fee_total_usdc` (NULL en filas previas a esa columna).
        totalUsd: row.fee_total_usdc,
        platformUsd: row.fee_usdc,
        status: row.status,
        txHash: row.tx_hash,
        explorerTxUrl: buildExplorerTxUrl(defaultChainExplorer(), row.tx_hash),
      };
    }

    return [...calls.values()]
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, safeLimit)
      .map(finalizeCall);
  },

  /** Payload completo de la pantalla (salud + trace). */
  async snapshot(opts?: {
    limit?: number | undefined;
    windowHours?: number | undefined;
  }): Promise<TracePayload> {
    const limit = clamp(opts?.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
    const [health, calls] = await Promise.all([
      this.health(opts?.windowHours ?? DEFAULT_WINDOW_HOURS),
      this.recentCalls(limit),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      limit,
      health,
      calls,
    };
  },
};
