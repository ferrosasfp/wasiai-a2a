/**
 * PREFLIGHT DE ESQUEMA DEL CAMINO ESCROW — AR de HU-202, BLOQUEANTE 1.
 *
 * LO QUE ESTOS TESTS TIENEN QUE PROBAR, Y NO ALCANZA CON MENOS: que el preflight FALLA
 * DE VERDAD contra una base sin migrar. Un test que sólo verificara el camino feliz
 * dejaría el gate entero sin cubrir, que es exactamente el estado anterior al fix-pack
 * (el "gate" existía como prosa en un `.md`).
 *
 * Por eso la base VIEJA se SIMULA con su respuesta real, no se asume:
 *   · la columna `debit_hop2_attempted_at` que no existe ⟹ PostgREST contesta un error
 *     de columna desconocida en el `.select()`;
 *   · el `record_debit_settle_status` anterior a 20260728000000 ⟹ el `RAISE EXCEPTION
 *     'INVALID_SETTLE_STATUS'` del propio cuerpo de la función.
 * Y la base MIGRADA se distingue por el `INTENT_NOT_FOUND`, que es prueba POSITIVA: la
 * ejecución pasó el whitelist de status y murió en el lookup del intent, o sea después
 * del punto exacto que falla en la base vieja.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRpc = vi.fn();
const mockSelectLimit = vi.fn();
const mockLogError = vi.fn();

vi.mock('../../lib/logger.js', () => ({
  getLogger: () => ({
    error: (...a: unknown[]) => mockLogError(...a),
    warn: () => {},
    info: () => {},
    debug: () => {},
  }),
}));

vi.mock('../../lib/supabase.js', () => ({
  supabase: {
    rpc: (...a: unknown[]) => mockRpc(...a),
    from: () => ({
      select: () => ({ limit: (...a: unknown[]) => mockSelectLimit(...a) }),
    }),
  },
}));

import {
  _resetEscrowSchemaPreflight,
  ensureEscrowSchemaReady,
  warmEscrowSchemaPreflight,
} from './schema-preflight.js';

/** La base MIGRADA: la columna resuelve y el RPC llega al lookup del intent. */
function migratedDb(): void {
  mockSelectLimit.mockResolvedValue({ data: [], error: null });
  mockRpc.mockResolvedValue({
    data: null,
    error: {
      message: 'INTENT_NOT_FOUND: 0f6b2f1e-0000-4000-8000-000000000000',
    },
  });
}

beforeEach(() => {
  _resetEscrowSchemaPreflight();
  mockRpc.mockReset();
  mockSelectLimit.mockReset();
  mockLogError.mockReset();
  delete process.env.ESCROW_SCHEMA_PREFLIGHT_RETRY_MS;
});

afterEach(() => {
  _resetEscrowSchemaPreflight();
  delete process.env.ESCROW_SCHEMA_PREFLIGHT_RETRY_MS;
});

describe('preflight — la base MIGRADA pasa', () => {
  it('T-P1: columna presente + RPC que acepta `resolving_settle` → ok', async () => {
    migratedDb();
    await expect(ensureEscrowSchemaReady()).resolves.toEqual({ ok: true });
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('T-P2: el probe del RPC pide EXACTAMENTE `resolving_settle` (si pidiera otro status no probaría nada)', async () => {
    migratedDb();
    await ensureEscrowSchemaReady();
    expect(mockRpc).toHaveBeenCalledWith(
      'record_debit_settle_status',
      expect.objectContaining({ p_status: 'resolving_settle' }),
    );
  });

  it('T-P3: el probe NO puede escribir — usa un intent id ALEATORIO, no uno real', async () => {
    migratedDb();
    await ensureEscrowSchemaReady();
    const args = mockRpc.mock.calls[0]?.[1] as { p_intent_id: string };
    // UUID v4: la fila no existe ⟹ el RPC tira ANTES de cualquier UPDATE.
    expect(args.p_intent_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('preflight — la base VIEJA falla, que es el punto', () => {
  it('T-P4: el RPC anterior a 20260728000000 rechaza `resolving_settle` → FALLA (éste es el que estacionaba la plata)', async () => {
    mockSelectLimit.mockResolvedValue({ data: [], error: null });
    // La respuesta REAL del cuerpo viejo de la función.
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'INVALID_SETTLE_STATUS: resolving_settle' },
    });

    await expect(ensureEscrowSchemaReady()).resolves.toEqual({
      ok: false,
      failure: 'RPC_REJECTS_RESOLVING_SETTLE',
      detail: 'INVALID_SETTLE_STATUS: resolving_settle',
    });
    // Y GRITA: el operador tiene que enterarse sin leer el código.
    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({ failure: 'RPC_REJECTS_RESOLVING_SETTLE' }),
      expect.stringContaining('ESCROW SCHEMA PREFLIGHT FAILED'),
    );
  });

  it('T-P5: sin la columna `debit_hop2_attempted_at` → FALLA y NI SIQUIERA llega al RPC', async () => {
    mockSelectLimit.mockResolvedValue({
      data: null,
      error: {
        message:
          'column a2a_payment_intent_debit_signatures.debit_hop2_attempted_at does not exist',
      },
    });

    const v = await ensureEscrowSchemaReady();

    expect(v.ok).toBe(false);
    expect(v).toMatchObject({ failure: 'COLUMN_MISSING' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('T-P6: DB caída (el select tira) → FALLA cerrado, no “ok por las dudas”', async () => {
    mockSelectLimit.mockRejectedValue(new Error('fetch failed'));
    const v = await ensureEscrowSchemaReady();
    expect(v).toEqual({
      ok: false,
      failure: 'PROBE_UNAVAILABLE',
      detail: 'fetch failed',
    });
  });

  it('T-P7: el RPC no existe (PGRST202, schema-cache) → FALLA cerrado', async () => {
    mockSelectLimit.mockResolvedValue({ data: [], error: null });
    mockRpc.mockResolvedValue({
      data: null,
      error: {
        message:
          'Could not find the function public.record_debit_settle_status',
      },
    });
    const v = await ensureEscrowSchemaReady();
    expect(v).toMatchObject({ failure: 'PROBE_UNAVAILABLE' });
  });

  it('T-P8: una respuesta SIN error para un intent inexistente es anómala → FALLA cerrado (no se asume que pasó)', async () => {
    // Un intent id aleatorio SIEMPRE tira. Si no tiró, el RPC no es el que creemos, y
    // afirmar que el esquema está bien sería inventarlo.
    mockSelectLimit.mockResolvedValue({ data: [], error: null });
    mockRpc.mockResolvedValue({ data: [{ applied: true }], error: null });
    const v = await ensureEscrowSchemaReady();
    expect(v).toMatchObject({ failure: 'PROBE_UNAVAILABLE' });
  });
});

describe('preflight — cache: ni una consulta por request, ni un fallo pegado para siempre', () => {
  it('T-P9: el veredicto POSITIVO se memoiza (el 2º settle no consulta la base)', async () => {
    migratedDb();
    await ensureEscrowSchemaReady();
    await ensureEscrowSchemaReady();
    await ensureEscrowSchemaReady();
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockSelectLimit).toHaveBeenCalledTimes(1);
  });

  it('T-P10: las llamadas CONCURRENTES comparten un único probe (single flight)', async () => {
    migratedDb();
    const all = await Promise.all([
      ensureEscrowSchemaReady(),
      ensureEscrowSchemaReady(),
      ensureEscrowSchemaReady(),
    ]);
    expect(all.every((v) => v.ok)).toBe(true);
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('T-P11: el veredicto NEGATIVO se re-intenta cuando vence el TTL (un blip no apaga el escrow hasta el próximo deploy)', async () => {
    process.env.ESCROW_SCHEMA_PREFLIGHT_RETRY_MS = '1';
    mockSelectLimit.mockRejectedValue(new Error('fetch failed'));

    const first = await ensureEscrowSchemaReady();
    expect(first.ok).toBe(false);

    // La base se recupera.
    await new Promise((r) => setTimeout(r, 5));
    migratedDb();

    await expect(ensureEscrowSchemaReady()).resolves.toEqual({ ok: true });
  });

  it('T-P12: dentro del TTL el negativo NO re-consulta (si no, una base caída = un probe por request)', async () => {
    process.env.ESCROW_SCHEMA_PREFLIGHT_RETRY_MS = '60000';
    mockSelectLimit.mockRejectedValue(new Error('fetch failed'));

    await ensureEscrowSchemaReady();
    await ensureEscrowSchemaReady();
    await ensureEscrowSchemaReady();

    expect(mockSelectLimit).toHaveBeenCalledTimes(1);
  });
});

describe('preflight — el warm-up del arranque', () => {
  it('T-P13: `warmEscrowSchemaPreflight` NO tira aunque el probe falle (no puede tumbar el boot)', async () => {
    mockSelectLimit.mockRejectedValue(new Error('fetch failed'));
    expect(() => warmEscrowSchemaPreflight()).not.toThrow();
    // Y comparte el cache con el gate: el settle NO vuelve a consultar.
    await ensureEscrowSchemaReady();
    expect(mockSelectLimit).toHaveBeenCalledTimes(1);
  });
});
