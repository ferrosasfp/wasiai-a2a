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
 * Las dos RPC no pasan por el falso: son `supabase.rpc`, y acá se moquean por
 * su CONTRATO (qué error levanta la base). Que la base levante ESE error lo
 * verifica `test/wkh225-suspended-runs.migration.test.ts` sobre el `.sql`. Los
 * dos juntos cubren el camino; ninguno solo alcanza, y decirlo es parte del
 * control.
 *
 * Naming: T-OWN-1..T-OWN-4.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

import { supabase } from '../lib/supabase.js';
import { createOwnerScopedFake } from './__tests__/owner-scoped-fake.js';
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
    steps_json: [],
    last_output: null,
    remaining_steps: [],
    frozen_step_prices: null,
    total_cost_usdc: '1.00000000',
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

const mockFrom = vi.mocked(supabase.from);

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

  it('T-OWN-1: `listForOwner` devuelve SÓLO las filas del dueño que pregunta', () => {
    return (async () => {
      const a = await suspendedRunService.listForOwner(OWNER_A);
      expect(a.ok).toBe(true);
      if (!a.ok) return;
      expect(a.rows.map((r) => r.id)).toEqual([RUN_A]);

      const b = await suspendedRunService.listForOwner(OWNER_B);
      expect(b.ok).toBe(true);
      if (!b.ok) return;
      expect(b.rows.map((r) => r.id)).toEqual([RUN_B]);
    })();
  });

  it('T-OWN-2: un dueño sin runs recibe una lista VACÍA, no la del otro', async () => {
    const res = await suspendedRunService.listForOwner('owner-C-0xcccc');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows).toEqual([]);
  });

  it('T-OWN-3: `listForOwner` no devuelve el material de la credencial', async () => {
    // El dueño puede ver SUS runs; lo que no necesita es el hash del que sale
    // el token. Que la fila lo tenga en la base no obliga a echarlo.
    const res = await suspendedRunService.listForOwner(OWNER_A);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows[0]?.token_hash).toBe('');
    expect(JSON.stringify(res.rows)).not.toContain('hash-de-a');
  });

  it('T-OWN-4: el `expire` de un run ajeno NO lee la fila del otro dueño', async () => {
    // `expire` emite el residuo de un run vencido leyendo `steps_json`. Si su
    // select no cruzara el token_hash con el dueño, el dueño B podría provocar
    // la lectura —y la emisión del evento— de la fila de A.
    await suspendedRunService.expire('hash-de-a', OWNER_B);
    const resueltas = fake.resolved();
    expect(resueltas.length).toBeGreaterThan(0);
    const ultima = resueltas[resueltas.length - 1];
    // La cadena pidió los DOS filtros, y con el dueño equivocado no matcheó nada.
    expect(ultima?.filters).toEqual(
      expect.arrayContaining([
        ['token_hash', 'hash-de-a'],
        ['owner_ref', OWNER_B],
      ]),
    );
    expect((ultima as unknown as { rows?: unknown[] })?.rows ?? []).toEqual([]);
  });
});
