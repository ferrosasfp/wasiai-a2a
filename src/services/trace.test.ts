/**
 * Trace Service — WKH-191x (pantalla `/dashboard/trace`).
 *
 * `traceService` REAL; supabase, logger y registry de adapters mockeados. Cubre:
 *   · el agrupado por `orchestration_id` y el aislamiento de los recibos que lo
 *     tienen NULL (AC-4, hallazgo H-2 del work-item),
 *   · la detección de cruce de redes (AC-5),
 *   · el conteo de skips con vocabulario PÚBLICO y el descarte de los internos (AC-6),
 *   · la precisión: los montos NUNCA se parsean a float y el select pide `::text`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({ getLogger: () => logSpy }));

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn() },
}));

const SOLANA_CAIP2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';

const BUNDLES = vi.hoisted(() => ({
  'avalanche-fuji': {
    chainConfig: {
      name: 'Avalanche Fuji',
      chainId: 43113,
      explorerUrl: 'https://testnet.snowtrace.io',
    },
    payment: { vmFamily: 'evm', chainId: 43113 },
  },
  'solana-devnet': {
    chainConfig: {
      name: 'Solana Devnet',
      chainId: 900001,
      explorerUrl: 'https://explorer.solana.com?cluster=devnet',
    },
    payment: {
      vmFamily: 'solana',
      caip2ChainId: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    },
  },
}));

vi.mock('../adapters/registry.js', () => ({
  getInitializedChainKeys: () => Object.keys(BUNDLES),
  getAdaptersBundle: (key: string) =>
    (BUNDLES as Record<string, unknown>)[key] ?? undefined,
  getDefaultChainKey: () => 'avalanche-fuji',
}));

import { supabase } from '../lib/supabase.js';
import { traceService } from './trace.js';

const mockFrom = vi.mocked(supabase.from);

// ── Fixtures con la FORMA REAL de las filas ──────────────────────────────────

const REQ_ID = 'req-abc';
const OWNER = 'tenant-A';

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ev-1',
    event_type: 'request:POST:/compose',
    status: 'success',
    latency_ms: 1234,
    metadata: {
      endpoint: '/compose',
      method: 'POST',
      statusCode: 200,
      requestId: REQ_ID,
      timestamp: '2026-07-26T12:00:00.000Z',
    },
    created_at: '2026-07-26T12:00:00.000Z',
    ...overrides,
  };
}

/** Débito al caller: budget_debit sin ninguna prueba on-chain. */
function callerDebit(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rc-debit',
    owner_ref: OWNER,
    receipt_type: 'budget_debit',
    amount_usd: '0.03000000',
    chain_id: 43113,
    tx_hash: null,
    orchestration_id: REQ_ID,
    created_at: '2026-07-26T11:59:58.000Z',
    settle_caip2: null,
    settle_signature: null,
    ...overrides,
  };
}

/** Settle al agente en Solana: MISMO tipo y monto, con firma base58. */
function solanaSettle(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rc-settle',
    owner_ref: OWNER,
    receipt_type: 'budget_debit',
    amount_usd: '0.03000000',
    chain_id: 43113,
    tx_hash: '5Nbi6LDKw3iUdv',
    orchestration_id: REQ_ID,
    created_at: '2026-07-26T11:59:59.000Z',
    settle_caip2: SOLANA_CAIP2,
    settle_signature: '5Nbi6LDKw3iUdv',
    ...overrides,
  };
}

function feeRow(overrides: Record<string, unknown> = {}) {
  return {
    orchestration_id: REQ_ID,
    fee_usdc: '0.000300',
    fee_total_usdc: '0.000300',
    status: 'charged',
    tx_hash: '0xfee',
    created_at: '2026-07-26T12:00:00.000Z',
    ...overrides,
  };
}

interface TableData {
  events?: unknown[];
  receipts?: unknown[];
  fees?: unknown[];
  /** Recibos devueltos a la query de `lastCrossChainSettle` (filtrada). */
  crossChainReceipts?: unknown[];
  error?: { message: string } | null;
}

/**
 * Test-double chainable de `supabase.from`. Distingue las DOS queries sobre
 * `a2a_receipts` por el filtro `.not('settle_caip2', …)` que sólo usa
 * `lastCrossChainSettle`, y captura columnas y límites para poder asertar el
 * `::text` y el clamp.
 */
function wireFrom(data: TableData) {
  const captured = {
    receiptCols: null as string | null,
    eventCols: null as string | null,
    eventTypes: null as unknown,
    limits: [] as number[],
    gte: null as string | null,
  };
  mockFrom.mockImplementation(((table: string) => {
    let filteredByCaip2 = false;
    const builder: Record<string, unknown> = {
      select: (cols?: string) => {
        if (table === 'a2a_receipts') captured.receiptCols = cols ?? null;
        if (table === 'a2a_events') captured.eventCols = cols ?? null;
        return builder;
      },
      in: (_col: string, values: unknown) => {
        captured.eventTypes = values;
        return builder;
      },
      not: () => {
        filteredByCaip2 = true;
        return builder;
      },
      gte: (_col: string, value: string) => {
        captured.gte = value;
        return builder;
      },
      order: () => builder,
      limit: (n: number) => {
        captured.limits.push(n);
        return builder;
      },
      // biome-ignore lint/suspicious/noThenProperty: awaitable supabase builder test double
      then: (resolve: (v: unknown) => void) => {
        if (data.error) return resolve({ data: null, error: data.error });
        if (table === 'a2a_events') {
          return resolve({ data: data.events ?? [], error: null });
        }
        if (table === 'a2a_protocol_fees') {
          return resolve({ data: data.fees ?? [], error: null });
        }
        return resolve({
          data: filteredByCaip2
            ? (data.crossChainReceipts ?? [])
            : (data.receipts ?? []),
          error: null,
        });
      },
    };
    return builder;
    // biome-ignore lint/suspicious/noExplicitAny: test double for supabase builder
  }) as any);
  return captured;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── T-1: agrupado por orchestration_id ───────────────────────────────────────
describe('T-1 recentCalls: agrupa por orchestration_id (AC-4)', () => {
  it('evento + 2 recibos + fee con el mismo id → UNA llamada, correlation full', async () => {
    wireFrom({
      events: [event()],
      receipts: [solanaSettle(), callerDebit()],
      fees: [feeRow()],
    });
    const calls = await traceService.recentCalls(25);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.id).toBe(REQ_ID);
    expect(call?.correlation).toBe('full');
    expect(call?.endpoint).toBe('/compose');
    expect(call?.method).toBe('POST');
    expect(call?.status).toBe('success');
    expect(call?.httpStatus).toBe(200);
    expect(call?.latencyMs).toBe(1234);
    expect(call?.ownerRef).toBe(OWNER);
    expect(call?.legs).toHaveLength(2);
    expect(call?.fee?.totalUsd).toBe('0.000300');
    expect(call?.fee?.status).toBe('charged');
  });

  it('las patas quedan en orden cronológico (se lee como un trace)', async () => {
    wireFrom({
      events: [event()],
      receipts: [solanaSettle(), callerDebit()],
    });
    const legs = (await traceService.recentCalls(25))[0]?.legs ?? [];
    expect(legs.map((l) => l.receiptId)).toEqual(['rc-debit', 'rc-settle']);
  });

  it('dos orchestration_id distintos NO se mezclan, y sale el último primero', async () => {
    wireFrom({
      events: [
        event(),
        {
          ...event(),
          id: 'ev-2',
          metadata: {
            endpoint: '/compose',
            method: 'POST',
            statusCode: 402,
            requestId: 'req-viejo',
          },
          status: 'failed',
          created_at: '2026-07-26T10:00:00.000Z',
        },
      ],
      receipts: [
        callerDebit(),
        callerDebit({ id: 'rc-2', orchestration_id: 'req-viejo' }),
      ],
    });
    const calls = await traceService.recentCalls(25);
    expect(calls.map((c) => c.id)).toEqual([REQ_ID, 'req-viejo']);
    expect(calls[0]?.legs).toHaveLength(1);
    expect(calls[1]?.legs).toHaveLength(1);
    expect(calls[1]?.status).toBe('failed');
    expect(calls[1]?.httpStatus).toBe(402);
  });
});

// ── T-2: recibos con orchestration_id NULL (H-2) ─────────────────────────────
describe('T-2 recentCalls: orchestration_id NULL no inventa grupos', () => {
  it('cada recibo sin id queda en su propio grupo money-only (no se mezclan)', async () => {
    wireFrom({
      events: [],
      receipts: [
        callerDebit({ id: 'rc-a', orchestration_id: null }),
        solanaSettle({ id: 'rc-b', orchestration_id: null }),
      ],
    });
    const calls = await traceService.recentCalls(25);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.id).sort()).toEqual([
      'receipt:rc-a',
      'receipt:rc-b',
    ]);
    for (const call of calls) {
      expect(call.correlation).toBe('money-only');
      expect(call.endpoint).toBeNull();
      expect(call.latencyMs).toBeNull();
      expect(call.legs).toHaveLength(1);
    }
  });

  it('un evento sin recibos queda call-only (la llamada existió, no movió dinero)', async () => {
    wireFrom({ events: [event()], receipts: [], fees: [] });
    const calls = await traceService.recentCalls(25);
    expect(calls[0]?.correlation).toBe('call-only');
    expect(calls[0]?.legs).toEqual([]);
    expect(calls[0]?.ownerRef).toBeNull();
  });
});

// ── T-3: cruce de redes (la tesis) ───────────────────────────────────────────
describe('T-3 recentCalls: cruce de redes (AC-5)', () => {
  it('pagó en Fuji y cobró en Solana → crossChain con las dos redes legibles', async () => {
    wireFrom({ events: [event()], receipts: [solanaSettle(), callerDebit()] });
    const call = (await traceService.recentCalls(25))[0];
    expect(call?.crossChain).toBe(true);

    const settle = call?.legs.find((l) => l.receiptId === 'rc-settle');
    expect(settle?.crossChain).toBe(true);
    expect(settle?.paidOn.label).toBe('Avalanche Fuji');
    expect(settle?.collectedOn?.label).toBe('Solana Devnet');
    // Link al explorer CORRECTO de la red donde cobró (query preservado).
    expect(settle?.explorerTxUrl).toBe(
      'https://explorer.solana.com/tx/5Nbi6LDKw3iUdv?cluster=devnet',
    );

    const debit = call?.legs.find((l) => l.receiptId === 'rc-debit');
    expect(debit?.crossChain).toBe(false);
    expect(debit?.collectedOn).toBeNull();
  });

  it('settle en el MISMO rail (budget Solana → agente Solana) no es cruce', async () => {
    wireFrom({
      events: [],
      receipts: [solanaSettle({ chain_id: 900001 })],
    });
    const call = (await traceService.recentCalls(25))[0];
    expect(call?.crossChain).toBe(false);
    expect(call?.legs[0]?.paidOn.label).toBe('Solana Devnet');
  });

  it('distingue el DÉBITO al caller del SETTLE al agente (mismo tipo y monto)', async () => {
    wireFrom({ events: [], receipts: [solanaSettle(), callerDebit()] });
    const legs = (await traceService.recentCalls(25))
      .flatMap((c) => c.legs)
      .sort((a, b) => a.receiptId.localeCompare(b.receiptId));
    expect(legs.map((l) => [l.receiptId, l.isCallerDebit])).toEqual([
      ['rc-debit', true],
      ['rc-settle', false],
    ]);
  });
});

// ── T-4: precisión (WKH-196) ─────────────────────────────────────────────────
describe('T-4 precisión: montos como string, select con ::text', () => {
  it('el monto llega VERBATIM, sin pasar por float', async () => {
    wireFrom({
      events: [],
      receipts: [callerDebit({ amount_usd: '0.03000000' })],
    });
    const leg = (await traceService.recentCalls(25))[0]?.legs[0];
    expect(leg?.amountUsd).toBe('0.03000000');
    expect(typeof leg?.amountUsd).toBe('string');
  });

  it('el select pide amount_usd::text (convención post WKH-196)', async () => {
    const captured = wireFrom({ events: [], receipts: [] });
    await traceService.recentCalls(25);
    expect(captured.receiptCols).toContain('amount_usd::text');
  });

  it('el fee expone fee_total_usdc y fee_usdc por separado (WKH-167)', async () => {
    wireFrom({
      events: [event()],
      fees: [feeRow({ fee_usdc: '0.000240', fee_total_usdc: '0.000300' })],
    });
    const fee = (await traceService.recentCalls(25))[0]?.fee;
    // fee_usdc es SOLO la pata plataforma; el total es fee_total_usdc.
    expect(fee?.platformUsd).toBe('0.000240');
    expect(fee?.totalUsd).toBe('0.000300');
  });
});

// ── T-5: límites y filtros de las queries ────────────────────────────────────
describe('T-5 recentCalls: límites y filtro por event_type', () => {
  it('clampea el limit a 100 y pide más recibos que llamadas', async () => {
    const captured = wireFrom({ events: [], receipts: [] });
    await traceService.recentCalls(5000);
    expect(captured.limits).toContain(100);
    expect(captured.limits).toContain(800);
  });

  it('un limit basura cae al mínimo en vez de romper la query', async () => {
    const captured = wireFrom({ events: [], receipts: [] });
    await traceService.recentCalls(Number.NaN);
    expect(captured.limits).toContain(1);
  });

  it('filtra sólo los endpoints que mueven dinero', async () => {
    const captured = wireFrom({ events: [], receipts: [] });
    await traceService.recentCalls(25);
    expect(captured.eventTypes).toEqual([
      'request:POST:/compose',
      'request:POST:/orchestrate',
      'request:POST:/orchestrate/execute',
    ]);
  });

  it('recorta al limit pedido ordenando por hora descendente', async () => {
    wireFrom({
      events: [],
      receipts: [
        callerDebit({
          id: 'r1',
          orchestration_id: null,
          created_at: '2026-07-26T09:00:00.000Z',
        }),
        callerDebit({
          id: 'r2',
          orchestration_id: null,
          created_at: '2026-07-26T11:00:00.000Z',
        }),
        callerDebit({
          id: 'r3',
          orchestration_id: null,
          created_at: '2026-07-26T10:00:00.000Z',
        }),
      ],
    });
    const calls = await traceService.recentCalls(2);
    expect(calls.map((c) => c.id)).toEqual(['receipt:r2', 'receipt:r3']);
  });

  it('un error de la DB no se filtra crudo al caller', async () => {
    wireFrom({ error: { message: 'relation "a2a_receipts" does not exist' } });
    await expect(traceService.recentCalls(25)).rejects.toThrow(
      'trace read failed',
    );
    expect(logSpy.error).toHaveBeenCalled();
  });
});

// ── T-6: skips con vocabulario PÚBLICO ───────────────────────────────────────
describe('T-6 skipCounts: sólo vocabulario público (AC-6)', () => {
  it('cuenta los públicos, DESCARTA los internos y explica cada código', async () => {
    wireFrom({
      events: [
        {
          ...event(),
          metadata: {
            requestId: REQ_ID,
            // Dos públicos + dos INTERNOS (revelan flags y fondos del operador)
            // + basura. Sólo los públicos deben contar.
            downstreamSkips: [
              'SETTLE_FAILED',
              'NOT_CONFIGURED',
              'SETTLE_FAILED',
              'INSUFFICIENT_BALANCE',
              'MAINNET_NOT_ALLOWED',
              42,
            ],
          },
        },
      ],
    });
    const stats = await traceService.skipCounts(24);
    expect(stats.total).toBe(3);
    expect(stats.signalPresent).toBe(true);
    expect(stats.skips).toEqual([
      {
        code: 'SETTLE_FAILED',
        count: 2,
        meaning: expect.stringContaining('no se pudo confirmar'),
      },
      {
        code: 'NOT_CONFIGURED',
        count: 1,
        meaning: expect.stringContaining('no está configurado'),
      },
    ]);
    const codes = stats.skips.map((s) => s.code);
    expect(codes).not.toContain('INSUFFICIENT_BALANCE');
    expect(codes).not.toContain('MAINNET_NOT_ALLOWED');
  });

  it('sin la clave en metadata → signalPresent false (sin datos ≠ cero skips)', async () => {
    wireFrom({ events: [event()] });
    const stats = await traceService.skipCounts(24);
    expect(stats.signalPresent).toBe(false);
    expect(stats.total).toBe(0);
  });

  it('array vacío → signalPresent true con cero skips (el gateway sí reporta)', async () => {
    wireFrom({
      events: [
        { ...event(), metadata: { requestId: REQ_ID, downstreamSkips: [] } },
      ],
    });
    const stats = await traceService.skipCounts(24);
    expect(stats.signalPresent).toBe(true);
    expect(stats.total).toBe(0);
  });

  // AR BLQ-BAJO-1b: el conteo lee como máximo 500 eventos, pero la UI lo rotulaba
  // "últimas 24 h". Con más tráfico que el techo, el número NO es el de la ventana:
  // el service tiene que DECIRLO en vez de dejar que la pantalla afirme "todo bien".
  it('T-TRUNC-1: por debajo del techo, truncated=false (el conteo cubre la ventana)', async () => {
    wireFrom({
      events: [
        { ...event(), metadata: { requestId: REQ_ID, downstreamSkips: [] } },
      ],
    });
    const stats = await traceService.skipCounts(24);
    expect(stats.scanned).toBe(1);
    expect(stats.truncated).toBe(false);
  });

  it('T-TRUNC-2: con el techo lleno (500 filas), truncated=true', async () => {
    const events = Array.from({ length: 500 }, (_, i) => ({
      ...event(),
      id: `ev-${i}`,
      metadata: { requestId: `req-${i}`, downstreamSkips: [] },
    }));
    wireFrom({ events });
    const stats = await traceService.skipCounts(24);
    expect(stats.scanned).toBe(500);
    expect(stats.truncated).toBe(true);
    // El conteo sigue siendo el de lo leído: no se inventa nada.
    expect(stats.total).toBe(0);
    expect(stats.signalPresent).toBe(true);
  });

  it('T-TRUNC-3: health propaga el techo y la bandera al payload de la pantalla', async () => {
    const events = Array.from({ length: 500 }, (_, i) => ({
      ...event(),
      id: `ev-${i}`,
      metadata: { requestId: `req-${i}`, downstreamSkips: [] },
    }));
    wireFrom({ events, crossChainReceipts: [] });
    const health = await traceService.health(24);
    expect(health.skipScanLimit).toBe(500);
    expect(health.skipScanTruncated).toBe(true);
  });

  it('clampea la ventana a 7 días y filtra por created_at', async () => {
    const captured = wireFrom({ events: [] });
    await traceService.skipCounts(9999);
    const since = new Date(captured.gte ?? 0).getTime();
    const expected = Date.now() - 168 * 3_600_000;
    expect(Math.abs(since - expected)).toBeLessThan(5_000);
  });
});

// ── T-7: pulso del rail ──────────────────────────────────────────────────────
describe('T-7 lastCrossChainSettle: pulso del rail cross-chain', () => {
  it('salta los settles del mismo rail y devuelve el primer CRUCE con su antigüedad', async () => {
    const at = new Date(Date.now() - 3_600_000).toISOString();
    wireFrom({
      crossChainReceipts: [
        // Mismo rail: no es prueba de vida del cruce.
        solanaSettle({ id: 'rc-same', chain_id: 900001, created_at: at }),
        solanaSettle({ id: 'rc-cross', chain_id: 43113, created_at: at }),
      ],
    });
    const last = await traceService.lastCrossChainSettle();
    expect(last?.paidOn.label).toBe('Avalanche Fuji');
    expect(last?.collectedOn.label).toBe('Solana Devnet');
    expect(last?.signature).toBe('5Nbi6LDKw3iUdv');
    expect(last?.ageSeconds).toBeGreaterThanOrEqual(3595);
    expect(last?.ageSeconds).toBeLessThan(3700);
  });

  it('sin settles cross-chain → null (la UI lo dice, no muestra un cero)', async () => {
    wireFrom({ crossChainReceipts: [] });
    expect(await traceService.lastCrossChainSettle()).toBeNull();
  });
});

// ── T-8: salud ───────────────────────────────────────────────────────────────
describe('T-8 health: chains del registry real', () => {
  it('lista las chains inicializadas y marca la default', async () => {
    wireFrom({ events: [], crossChainReceipts: [] });
    const health = await traceService.health(24);
    expect(health.defaultChain).toBe('avalanche-fuji');
    expect(health.chains).toEqual([
      {
        key: 'avalanche-fuji',
        label: 'Avalanche Fuji',
        chainId: 43113,
        isDefault: true,
      },
      {
        key: 'solana-devnet',
        label: 'Solana Devnet',
        chainId: 900001,
        isDefault: false,
      },
    ]);
    expect(health.skipWindowHours).toBe(24);
    // Sin tráfico no hay nada tapado: el alcance del conteo es la ventana entera.
    expect(health.skipScanTruncated).toBe(false);
    expect(health.skipScanLimit).toBeGreaterThan(0);
  });
});

// ── T-9: snapshot ────────────────────────────────────────────────────────────
describe('T-9 snapshot: payload completo', () => {
  it('devuelve salud + llamadas + sello de tiempo', async () => {
    wireFrom({
      events: [event()],
      receipts: [callerDebit(), solanaSettle()],
      crossChainReceipts: [solanaSettle()],
      fees: [feeRow()],
    });
    const snap = await traceService.snapshot({ limit: 10, windowHours: 6 });
    expect(snap.limit).toBe(10);
    expect(snap.health.skipWindowHours).toBe(6);
    expect(snap.health.lastCrossChainSettle).not.toBeNull();
    expect(snap.calls).toHaveLength(1);
    expect(snap.calls[0]?.crossChain).toBe(true);
    expect(Number.isNaN(new Date(snap.generatedAt).getTime())).toBe(false);
  });
});
