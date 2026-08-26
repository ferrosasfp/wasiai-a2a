/**
 * WKH-365 — el service del tablero de las tres preguntas.
 *
 * El falso de Supabase de este archivo APLICA los filtros que la cadena pidió,
 * no los ignora: es lo que hace que sacar `.eq('owner_ref', …)` del service
 * ponga rojo el caso feliz en vez de dejarlo verde.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentStandingCounters } from '../types/index.js';

// ── Falso de Supabase que RECUERDA y APLICA la cadena ────────────────────────

interface ChainCall {
  table: string;
  select: string;
  eqs: Array<[string, unknown]>;
  gte: [string, unknown] | null;
  order: [string, unknown] | null;
  limit: number | null;
}

interface FakeState {
  calls: ChainCall[];
  keyRows: Array<Record<string, unknown>>;
  keyError: { code: string; message: string } | null;
  keyThrows: boolean;
  eventRows: Array<{ agent_id: string | null }>;
  eventError: { code: string; message: string } | null;
}

const state = vi.hoisted(
  () =>
    ({
      calls: [],
      keyRows: [],
      keyError: null,
      keyThrows: false,
      eventRows: [],
      eventError: null,
    }) as FakeState,
);

vi.mock('../lib/supabase.js', () => {
  const NOT_ONE_ROW = {
    code: 'PGRST116',
    message: 'JSON object requested, multiple (or no) rows returned',
  };

  function project(
    row: Record<string, unknown>,
    select: string,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const col of select.split(',').map((c) => c.trim())) {
      out[col] = row[col];
    }
    return out;
  }

  return {
    supabase: {
      from(table: string) {
        const call: ChainCall = {
          table,
          select: '',
          eqs: [],
          gte: null,
          order: null,
          limit: null,
        };
        state.calls.push(call);

        const eventsResult = async () => {
          if (state.eventError) {
            return { data: null, error: state.eventError };
          }
          return { data: state.eventRows, error: null };
        };

        const builder = {
          select(cols: string) {
            call.select = cols;
            return builder;
          },
          eq(column: string, value: unknown) {
            call.eqs.push([column, value]);
            return builder;
          },
          gte(column: string, value: unknown) {
            call.gte = [column, value];
            return builder;
          },
          order(column: string, opts: unknown) {
            call.order = [column, opts];
            return builder;
          },
          limit(n: number) {
            call.limit = n;
            return eventsResult();
          },
          async single() {
            if (state.keyThrows) throw new Error('la conexión se cayó');
            if (state.keyError) return { data: null, error: state.keyError };
            // Se aplican TODOS los `.eq` que la cadena pidió, y sólo ésos.
            const matched = state.keyRows.filter((row) =>
              call.eqs.every(([column, value]) => row[column] === value),
            );
            if (matched.length !== 1) {
              return { data: null, error: NOT_ONE_ROW };
            }
            return {
              data: project(matched[0] as Record<string, unknown>, call.select),
              error: null,
            };
          },
        };
        return builder;
      },
    },
  };
});

const computeStandingBatch = vi.hoisted(() => vi.fn());
vi.mock('./reputation.js', () => ({
  reputationService: { computeStandingBatch },
}));

const scanEscrows = vi.hoisted(() => vi.fn());
vi.mock('../adapters/solana/escrow-scan.js', () => ({ scanEscrows }));

import {
  leerCajaDeLaSonda,
  leerReputacion,
  tableroService,
} from './tablero.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const PROBE_KEY_ID = '11111111-2222-3333-4444-555555555555';
const PROBE_OWNER = 'owner-de-la-sonda';
const OTRO_OWNER = 'owner-ajeno';

/**
 * DOS filas con el MISMO `id` y distinto dueño, a propósito.
 *
 * No es una base realista: es un detector. Con los dos filtros la cadena deja
 * exactamente una fila y el caso feliz pasa; sacando cualquiera de los dos
 * quedan dos filas, `single()` devuelve `PGRST116` y el caso feliz se pone rojo.
 */
function seedKeyRows(): void {
  state.keyRows = [
    {
      id: PROBE_KEY_ID,
      owner_ref: PROBE_OWNER,
      key_hash: 'hash-que-nunca-tiene-que-salir',
      budget: { '900001': '14.97' },
      daily_limit_usd: 2,
      daily_spent_usd: 0.03,
      daily_reset_at: '2026-08-26T00:00:00.000Z',
      is_active: true,
    },
    {
      id: PROBE_KEY_ID,
      owner_ref: OTRO_OWNER,
      key_hash: 'hash-ajeno',
      budget: { '900001': '9999.00' },
      daily_limit_usd: 500,
      daily_spent_usd: 400,
      daily_reset_at: '2026-08-26T00:00:00.000Z',
      is_active: true,
    },
  ];
}

function counters(over: Partial<AgentStandingCounters>): AgentStandingCounters {
  return {
    tasksSettled: 0,
    successCount: 0,
    failedCount: 0,
    failedCallerCount: 0,
    reputation: null,
    ...over,
  };
}

const ESCROWS_OK = {
  status: 'ok' as const,
  escrows_vivos: 2,
  usdc_bloqueado: '12.5',
  otros_mints_count: 0,
  vencidos: 1,
};

const ORIGINAL = {
  id: process.env.A2A_PROBE_KEY_ID,
  owner: process.env.A2A_PROBE_KEY_OWNER_REF,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.calls = [];
  state.keyError = null;
  state.keyThrows = false;
  state.eventRows = [];
  state.eventError = null;
  seedKeyRows();
  process.env.A2A_PROBE_KEY_ID = PROBE_KEY_ID;
  process.env.A2A_PROBE_KEY_OWNER_REF = PROBE_OWNER;
  computeStandingBatch.mockResolvedValue({
    degraded: false,
    standings: new Map(),
  });
  scanEscrows.mockResolvedValue(ESCROWS_OK);
});

afterEach(() => {
  if (ORIGINAL.id === undefined) delete process.env.A2A_PROBE_KEY_ID;
  else process.env.A2A_PROBE_KEY_ID = ORIGINAL.id;
  if (ORIGINAL.owner === undefined) delete process.env.A2A_PROBE_KEY_OWNER_REF;
  else process.env.A2A_PROBE_KEY_OWNER_REF = ORIGINAL.owner;
});

function cajaCall(): ChainCall {
  const hit = state.calls.find((c) => c.table === 'a2a_agent_keys');
  if (hit === undefined) throw new Error('no se consultó a2a_agent_keys');
  return hit;
}

// ── Tarjeta 1: la caja ───────────────────────────────────────────────────────

describe('T-CAJA-1: la caja de la sonda (control POSITIVO)', () => {
  it('devuelve ok con la fila del dueño configurado', async () => {
    const card = await leerCajaDeLaSonda();

    expect(card).toEqual({
      status: 'ok',
      budget: { '900001': '14.97' },
      daily_limit_usd: 2,
      daily_spent_usd: 0.03,
      daily_reset_at: '2026-08-26T00:00:00.000Z',
      is_active: true,
    });
  });

  it('la cadena lleva `.eq(id)` Y `.eq(owner_ref)`', async () => {
    await leerCajaDeLaSonda();

    expect(cajaCall().eqs).toEqual([
      ['id', PROBE_KEY_ID],
      ['owner_ref', PROBE_OWNER],
    ]);
  });

  it('el `select` NO pide `id` ni `key_hash` (CD-5 se cumple en la QUERY)', async () => {
    await leerCajaDeLaSonda();

    const columnas = cajaCall()
      .select.split(',')
      .map((c) => c.trim());
    expect(columnas).toEqual([
      'budget',
      'daily_limit_usd',
      'daily_spent_usd',
      'daily_reset_at',
      'is_active',
    ]);
    expect(columnas).not.toContain('id');
    expect(columnas).not.toContain('key_hash');
  });

  it('un dueño que no casa NO devuelve el saldo del otro', async () => {
    process.env.A2A_PROBE_KEY_OWNER_REF = 'nadie';

    const card = await leerCajaDeLaSonda();

    expect(card).toEqual({ status: 'sin_dato', reason: 'no_encontrada' });
    expect(JSON.stringify(card)).not.toContain('9999.00');
  });

  it('`is_active: false` sigue siendo ok (es un dato, no una ausencia)', async () => {
    state.keyRows = [
      {
        id: PROBE_KEY_ID,
        owner_ref: PROBE_OWNER,
        budget: { '900001': '14.97' },
        daily_limit_usd: 2,
        daily_spent_usd: 0.03,
        daily_reset_at: null,
        is_active: false,
      },
    ];

    const card = await leerCajaDeLaSonda();

    expect(card.status).toBe('ok');
    if (card.status !== 'ok') return;
    expect(card.is_active).toBe(false);
  });
});

describe('T-CAJA-2: los tres motivos de "sin dato"', () => {
  it('T-CAJA-2a: falta A2A_PROBE_KEY_ID → no_configurado, sin tocar la base', async () => {
    delete process.env.A2A_PROBE_KEY_ID;

    const card = await leerCajaDeLaSonda();

    expect(card).toEqual({ status: 'sin_dato', reason: 'no_configurado' });
    expect(card.status).not.toBe('ok');
    expect(state.calls).toHaveLength(0);
  });

  it('T-CAJA-2a bis: falta A2A_PROBE_KEY_OWNER_REF → no_configurado', async () => {
    delete process.env.A2A_PROBE_KEY_OWNER_REF;

    const card = await leerCajaDeLaSonda();

    expect(card).toEqual({ status: 'sin_dato', reason: 'no_configurado' });
    expect(state.calls).toHaveLength(0);
  });

  it('T-CAJA-2b: PGRST116 → no_encontrada', async () => {
    state.keyError = { code: 'PGRST116', message: 'no rows' };

    const card = await leerCajaDeLaSonda();

    expect(card).toEqual({ status: 'sin_dato', reason: 'no_encontrada' });
    expect(card.status).not.toBe('ok');
  });

  it('T-CAJA-2c: cualquier otro error → error_db', async () => {
    state.keyError = { code: '57014', message: 'statement timeout' };

    const card = await leerCajaDeLaSonda();

    expect(card).toEqual({ status: 'sin_dato', reason: 'error_db' });
    expect(card.status).not.toBe('ok');
  });
});

// ── Tarjeta 2: la reputación ─────────────────────────────────────────────────

describe('T-REP: la reputación no estrena lógica', () => {
  it('T-REP-1: se delega en computeStandingBatch y NO hay red saliente', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    state.eventRows = [{ agent_id: 'agente-a' }, { agent_id: 'agente-a' }];
    computeStandingBatch.mockResolvedValue({
      degraded: false,
      standings: new Map([['agente-a', counters({ tasksSettled: 4 })]]),
    });

    await leerReputacion();

    expect(computeStandingBatch).toHaveBeenCalledTimes(1);
    // Dedupe: dos eventos del mismo agente son UN slug.
    expect(computeStandingBatch).toHaveBeenCalledWith(['agente-a']);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('T-REP-1 bis: el fuente del service no nombra ninguna operación que gaste', () => {
    const src = readFileSync(
      resolve(process.cwd(), 'src/services/tablero.ts'),
      'utf-8',
    );
    for (const prohibido of [
      'composeService',
      'orchestrate',
      'compose(',
      'debit',
    ]) {
      expect(src, `el tablero no puede nombrar ${prohibido}`).not.toContain(
        prohibido,
      );
    }
  });

  it('T-REP-2: degraded true → sin_dato/historial_ilegible', async () => {
    state.eventRows = [{ agent_id: 'agente-a' }];
    computeStandingBatch.mockResolvedValue({
      degraded: true,
      standings: new Map(),
    });

    const card = await leerReputacion();

    expect(card).toEqual({ status: 'sin_dato', reason: 'historial_ilegible' });
  });

  it('T-REP-3: control POSITIVO — degraded false con 0 slugs es `ok` con lista vacía', async () => {
    state.eventRows = [];

    const card = await leerReputacion();

    expect(card.status).toBe('ok');
    if (card.status !== 'ok') return;
    expect(card.agentes).toEqual([]);
    expect(card.ventana).toBe('últimos 30 días');
  });

  it('T-REP-2/3: los dos casos NO colapsan al mismo estado', async () => {
    state.eventRows = [];
    const vacio = await leerReputacion();

    computeStandingBatch.mockResolvedValue({
      degraded: true,
      standings: new Map(),
    });
    state.eventRows = [{ agent_id: 'agente-a' }];
    const degradado = await leerReputacion();

    expect(vacio.status).toBe('ok');
    expect(degradado.status).toBe('sin_dato');
    expect(vacio).not.toEqual(degradado);
  });

  it('un error de la query del universo también es historial_ilegible', async () => {
    state.eventError = { code: '42501', message: 'permission denied' };

    const card = await leerReputacion();

    expect(card).toEqual({ status: 'sin_dato', reason: 'historial_ilegible' });
    expect(computeStandingBatch).not.toHaveBeenCalled();
  });

  it('el universo sale de a2a_events con ventana, orden y tope', async () => {
    state.eventRows = [{ agent_id: 'agente-a' }];

    await leerReputacion();

    const call = state.calls.find((c) => c.table === 'a2a_events');
    if (call === undefined) throw new Error('no se consultó a2a_events');
    expect(call.select).toBe('agent_id');
    expect(call.gte?.[0]).toBe('created_at');
    expect(call.order).toEqual(['created_at', { ascending: false }]);
    expect(call.limit).toBe(1000);
  });

  it('el batch se pide con 50 slugs como techo', async () => {
    state.eventRows = Array.from({ length: 120 }, (_, i) => ({
      agent_id: `agente-${i}`,
    }));

    await leerReputacion();

    const slugs = computeStandingBatch.mock.calls[0]?.[0] as string[];
    expect(slugs).toHaveLength(50);
    expect(slugs[0]).toBe('agente-0');
  });

  it('los contadores por agente salen del batch, no se inventan', async () => {
    state.eventRows = [{ agent_id: 'agente-a' }, { agent_id: 'agente-b' }];
    computeStandingBatch.mockResolvedValue({
      degraded: false,
      standings: new Map([
        [
          'agente-a',
          counters({ tasksSettled: 7, successCount: 6, failedCount: 1 }),
        ],
      ]),
    });

    const card = await leerReputacion();

    if (card.status !== 'ok') throw new Error('esperaba ok');
    expect(card.agentes).toEqual([
      { slug: 'agente-a', tasksSettled: 7, successCount: 6, failedCount: 1 },
    ]);
  });
});

// ── El snapshot ──────────────────────────────────────────────────────────────

describe('T-SNAP: las tres juntas', () => {
  it('T-SNAP-1: las tres fuentes LANZAN → snapshot resuelve con las tres en sin_dato', async () => {
    // Con `Promise.all` en vez de `allSettled`, esto rechazaría y el test se
    // pone rojo (y la ruta devolvería 500 en vez de 200).
    state.keyThrows = true;
    computeStandingBatch.mockRejectedValue(new Error('boom'));
    state.eventRows = [{ agent_id: 'agente-a' }];
    scanEscrows.mockRejectedValue(new Error('boom'));

    const snap = await tableroService.snapshot();

    expect(snap.caja.status).toBe('sin_dato');
    expect(snap.reputacion.status).toBe('sin_dato');
    expect(snap.escrows.status).toBe('sin_dato');
    expect(typeof snap.servedAt).toBe('string');
  });

  it('T-SNAP-2: una falla, las otras dos siguen en ok', async () => {
    scanEscrows.mockResolvedValue({
      status: 'sin_dato',
      reason: 'rpc_error',
    });

    const snap = await tableroService.snapshot();

    expect(snap.caja.status).toBe('ok');
    expect(snap.reputacion.status).toBe('ok');
    expect(snap.escrows).toEqual({ status: 'sin_dato', reason: 'rpc_error' });
  });

  it('control POSITIVO: las tres sanas dan las tres en ok', async () => {
    const snap = await tableroService.snapshot();

    expect(snap.caja.status).toBe('ok');
    expect(snap.reputacion.status).toBe('ok');
    expect(snap.escrows).toEqual(ESCROWS_OK);
  });

  it('una tarjeta que llega cacheada NO se vuelve a leer de su fuente', async () => {
    const escrowsCacheado = {
      status: 'sin_dato' as const,
      reason: 'rpc_error' as const,
    };

    const snap = await tableroService.snapshot({ escrows: escrowsCacheado });

    expect(snap.escrows).toEqual(escrowsCacheado);
    // El punto entero: no se vuelve a golpear el RPC que ya estaba en 429.
    expect(scanEscrows).not.toHaveBeenCalled();
    // Y las otras dos sí se leyeron.
    expect(snap.caja.status).toBe('ok');
    expect(computeStandingBatch).toHaveBeenCalledTimes(1);
  });

  it('T-CD5-1: en NINGÚN estado el JSON trae el id de la key ni un hash', async () => {
    const estados = [] as string[];

    estados.push(JSON.stringify(await tableroService.snapshot()));

    state.keyError = { code: 'PGRST116', message: 'no rows' };
    estados.push(JSON.stringify(await tableroService.snapshot()));

    state.keyError = { code: '57014', message: 'timeout' };
    estados.push(JSON.stringify(await tableroService.snapshot()));

    state.keyError = null;
    delete process.env.A2A_PROBE_KEY_ID;
    estados.push(JSON.stringify(await tableroService.snapshot()));

    for (const json of estados) {
      expect(json).not.toContain(PROBE_KEY_ID);
      expect(json).not.toContain('key_id');
      expect(json).not.toContain('key_hash');
      expect(json).not.toContain('key_id_hash');
      expect(json).not.toContain('hash-que-nunca-tiene-que-salir');
    }
    expect(estados).toHaveLength(4);
  });

  it('T-CD14-1: la raíz no tiene ningún campo agregado de salud', async () => {
    const snap = await tableroService.snapshot();

    expect(Object.keys(snap).sort()).toEqual([
      'caja',
      'escrows',
      'reputacion',
      'servedAt',
    ]);
    for (const value of Object.values(snap)) {
      expect(typeof value).not.toBe('boolean');
    }
    for (const prohibido of ['healthy', 'ok', 'status', 'semaforo', 'health']) {
      expect(Object.keys(snap)).not.toContain(prohibido);
    }
    // El sello es `servedAt` y NO `generatedAt`: con tarjetas cacheadas, "cuándo
    // se generó" sería falso y "cuándo se sirvió" es cierto siempre.
    expect(Object.keys(snap)).not.toContain('generatedAt');
  });
});
