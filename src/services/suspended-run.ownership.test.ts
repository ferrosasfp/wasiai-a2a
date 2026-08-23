/**
 * `suspendedRunService` — aislamiento entre dueños (WKH-225, AC-6).
 *
 * ── POR QUÉ NO ES REDUNDANTE CON EL GUARDIÁN AUTOMÁTICO ────────────────────
 *
 * `test/ownership-filter-guard.test.ts` verifica PRESENCIA, no VALOR: un
 * `.eq('owner_ref', otroOwner)` —la columna correcta con el valor equivocado—
 * lo pasa sin chistar. Y además NO mira los `supabase.rpc(...)`, así que las dos
 * RPC de esta HU quedan ENTERAS fuera de su alcance. Este archivo y el
 * `IS DISTINCT FROM` dentro del `.sql` son la única cobertura de ese hueco.
 *
 * El falso de acá APLICA los filtros pedidos sobre una tabla con DOS dueños. No
 * filtra por dueño por su cuenta: si lo hiciera, todo test pasaría igual con el
 * filtro borrado del servicio, que es exactamente lo que hay que medir.
 *
 * ── LO QUE ESTE ARCHIVO NO PUEDE DECIR ─────────────────────────────────────
 *
 * Las dos RPC no pasan por el falso: son `supabase.rpc`, y ni siquiera se
 * moquean acá — ningún test de este archivo las toca. Que la base levante los
 * errores del claim en el orden correcto lo verifica
 * `test/wkh225-suspended-runs.migration.test.ts` sobre el `.sql`, y que el
 * SERVICE los traduzca, `suspended-run.test.ts`. Ninguno de los tres solo
 * alcanza, y decirlo es parte del control.
 *
 * ⚠️ EL FALSO NO ES POSTGRES. Modela `applyFilters` con `===` sobre las columnas
 * pedidas, y eso alcanza para lo único que este archivo afirma: que el UPDATE
 * lleve los filtros y que su VALOR aísle. Lo que NO puede decir es que el gate
 * `status = 'suspended'` sea atómico bajo concurrencia — eso se midió a mano
 * contra un Postgres 16 real (5 sesiones simultáneas ⇒ una sola afecta fila).
 *
 * Fix-pack AR/MNR-1: acá vivían T-OWN-1..3 midiendo `listForOwner`, una función
 * SIN NINGÚN CONSUMIDOR de producción. Se borró la función y se movió la
 * medición al único sitio owner-scoped que sí corre en producción: el UPDATE
 * condicional de `expire`, que además es una ESCRITURA — donde un filtro de
 * dueño mal puesto no devuelve datos ajenos, los DESTRUYE.
 *
 * Naming: T-OWN-1..T-OWN-4.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));
vi.mock('./event.js', () => ({
  eventService: { track: vi.fn(async () => ({})) },
}));

import { supabase } from '../lib/supabase.js';
import type { StepResult } from '../types/index.js';
import { createOwnerScopedFake } from './__tests__/owner-scoped-fake.js';
import { eventService } from './event.js';
import { suspendedRunService } from './suspended-run.js';

const OWNER_A = 'owner-A-0xaaaa';
const OWNER_B = 'owner-B-0xbbbb';
const RUN_A = '11111111-1111-1111-1111-111111111111';
const RUN_B = '22222222-2222-2222-2222-222222222222';

const COLUMNS = [
  'id',
  'token_hash',
  'owner_ref',
  'key_id',
  'caller_kind',
  'caller_id',
  'compose_run_id',
  'step_index',
  'steps_json',
  'last_output',
  'remaining_steps',
  'frozen_step_prices',
  'total_cost_usdc',
  'max_budget_usdc',
  'total_latency_ms',
  'contracting_chain',
  'contracting_depth',
  'self_host_hint',
  'chain_id',
  'status',
  'ttl_seconds',
  'expires_at',
  'resumed_at',
  'error_message',
  'created_at',
  'updated_at',
];

function runRow(
  id: string,
  ownerRef: string,
  tokenHash: string,
  createdAt: string,
): Record<string, unknown> {
  return {
    id,
    token_hash: tokenHash,
    owner_ref: ownerRef,
    key_id: 'key-1',
    caller_kind: 'key',
    caller_id: 'key-1',
    compose_run_id: '33333333-3333-3333-3333-333333333333',
    step_index: 0,
    // CON evidencia on-chain: es la precondición para que la transición a
    // `expired` emita un residuo. Sin ella, "cero eventos" sería cierto por el
    // motivo equivocado y el test no mediría el aislamiento.
    steps_json: [PASO_PAGADO],
    last_output: null,
    remaining_steps: [],
    frozen_step_prices: null,
    total_cost_usdc: '1.00000000',
    max_budget_usdc: null,
    total_latency_ms: 10,
    contracting_chain: [],
    contracting_depth: 0,
    self_host_hint: null,
    chain_id: 1,
    status: 'suspended',
    ttl_seconds: 3600,
    expires_at: '2099-01-01T00:00:00.000Z',
    resumed_at: null,
    error_message: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

const PASO_PAGADO = {
  agent: {
    slug: 'remit-kyc-validator',
    registry: 'wasiai',
    payment: { chain: 'base-sepolia' },
  },
  output: {},
  costUsdc: 1.25,
  latencyMs: 30,
  downstreamTxHash: '0xdeadbeef',
} as unknown as StepResult;

const mockFrom = vi.mocked(supabase.from);
const mockTrack = vi.mocked(eventService.track);

describe('suspendedRunService — aislamiento entre dueños', () => {
  let fake: ReturnType<typeof createOwnerScopedFake>;

  beforeEach(() => {
    vi.clearAllMocks();
    fake = createOwnerScopedFake({
      a2a_suspended_runs: {
        columns: COLUMNS,
        rows: [
          runRow(RUN_A, OWNER_A, 'hash-de-a', '2026-01-01T00:00:00.000Z'),
          runRow(RUN_B, OWNER_B, 'hash-de-b', '2026-01-02T00:00:00.000Z'),
        ],
      },
    });
    mockFrom.mockImplementation(
      (table: string) => fake.from(table) as ReturnType<typeof mockFrom>,
    );
  });

  it('T-OWN-1: el `expire` de un dueño ajeno NO transiciona la fila del otro', async () => {
    await suspendedRunService.expire('hash-de-a', OWNER_B);
    // El VALOR del filtro, no su presencia: la fila de A sigue `suspended` y no
    // se emitió residuo por ella. Con `.eq('owner_ref', …)` borrado del
    // servicio, este UPDATE afectaría la fila de A y las dos cosas cambiarían.
    expect(fake.rows('a2a_suspended_runs')[0]?.status).toBe('suspended');
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('T-OWN-2: el `expire` del dueño CORRECTO sí transiciona, y sólo su fila', async () => {
    await suspendedRunService.expire('hash-de-a', OWNER_A);
    const filas = fake.rows('a2a_suspended_runs');
    expect(filas.find((r) => r.id === RUN_A)?.status).toBe('expired');
    // La fila del otro dueño no se movió: el `token_hash` sólo no alcanzaría
    // como control, porque es único; lo que se mide es que el UPDATE no barrió.
    expect(filas.find((r) => r.id === RUN_B)?.status).toBe('suspended');
    expect(mockTrack).toHaveBeenCalledTimes(1);
  });

  it('T-OWN-3 (BLQ-ALTO-1): el segundo `expire` afecta CERO filas y NO vuelve a emitir', async () => {
    await suspendedRunService.expire('hash-de-a', OWNER_A);
    expect(mockTrack).toHaveBeenCalledTimes(1);
    // 🔴 El gate es `.eq('status', 'suspended')`, y es lo que vuelve
    // "exactamente un residuo" una propiedad del MOTOR y no una promesa del
    // servicio: la fila ya está `expired`, así que el WHERE no matchea.
    await suspendedRunService.expire('hash-de-a', OWNER_A);
    await suspendedRunService.expire('hash-de-a', OWNER_A);
    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(fake.rows('a2a_suspended_runs')[0]?.status).toBe('expired');
  });

  it('T-OWN-4: la cadena del `expire` es un UPDATE con los TRES filtros', async () => {
    await suspendedRunService.expire('hash-de-a', OWNER_B);
    const resueltas = fake.resolved();
    expect(resueltas.length).toBeGreaterThan(0);
    const ultima = resueltas[resueltas.length - 1];
    // El verbo importa tanto como los filtros: antes esta cadena era un
    // `select`, y por eso `expired` era un estado inalcanzable.
    expect(ultima?.kind).toBe('update');
    expect(ultima?.patch).toEqual({ status: 'expired' });
    expect(ultima?.filters).toEqual(
      expect.arrayContaining([
        ['token_hash', 'hash-de-a'],
        ['owner_ref', OWNER_B],
        ['status', 'suspended'],
      ]),
    );
  });
});
