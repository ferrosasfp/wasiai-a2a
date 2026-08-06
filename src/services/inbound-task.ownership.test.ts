/**
 * `inboundTaskService` — ligadura de fila e idempotencia (WKH-SEC-03).
 *
 * ⚠️ NINGUNO DE LOS DOS FILTROS DE ESTE ARCHIVO ES UNA BARRERA ALCANZABLE HOY,
 * y las dos razones son distintas. Declararlas es parte del entregable.
 *
 * ── `inbound-task.ts:316` (`get`) NO TIENE LLAMADOR DE PRODUCCIÓN ─────────
 *
 * Medido: `grep -rn 'inboundTaskService' src --include=*.ts` fuera de tests da
 * exactamente dos call-sites, los dos en `src/routes/inbound.ts` — `:78`
 * (`verifySourceAuth`) y `:89` (`ingest`). Ninguno llama a `get`, y dentro del
 * propio archivo `get` no se auto-llama. **La única superficie que ejercita este
 * filtro es este test.** No se puede afirmar que proteja una ruta, porque no hay
 * ruta. Lo que sí se puede afirmar: el filtro existe, hoy se puede borrar sin
 * que nada se ponga rojo, y si mañana alguien le cuelga una ruta con un id de
 * `req.params`, este test ya está.
 *
 * ── `inbound-task.ts:338` (`getByExternalRef`) ES IDEMPOTENCIA, NO AISLAMIENTO ──
 *
 * Su `ownerRef` NO lo elige el caller: sale de `keyRow.owner_ref`, derivado
 * server-side del hash de la credencial (`inbound-task.ts:425`). El filtro es la
 * primera pata de la clave de dedup `(owner_ref, source, external_ref)`. Sin él,
 * el `external_ref` de un dueño dedupearía contra el de otro: el daño no es que
 * A LEA lo de B, es que la tarea de A se descarte como "duplicada" porque B usó
 * el mismo `external_ref`. Por eso IT-02 se lee como idempotencia y no como
 * ataque.
 *
 * Naming: IT-01, IT-02.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn() },
}));

import { supabase } from '../lib/supabase.js';
import { createOwnerScopedFake } from './__tests__/owner-scoped-fake.js';
import { inboundTaskService } from './inbound-task.js';

const OWNER_A = 'owner-A-0xaaaa';
const OWNER_B = 'owner-B-0xbbbb';
const TASK_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TASK_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SOURCE = 'partner-x';
/** El MISMO `external_ref` para los dos dueños: es el punto de IT-02. */
const EXTERNAL_REF = 'pedido-1234';

const INBOUND_COLUMNS = [
  'id',
  'owner_ref',
  'source',
  'external_ref',
  'status',
  'goal',
  'budget_usdc',
  'constraints',
  'orchestration_id',
  'error_reason',
  'created_at',
  'updated_at',
];

function inboundRow(
  id: string,
  ownerRef: string,
  goal: string,
): Record<string, unknown> {
  return {
    id,
    owner_ref: ownerRef,
    source: SOURCE,
    external_ref: EXTERNAL_REF,
    status: 'ingested',
    goal,
    budget_usdc: null,
    constraints: {},
    orchestration_id: null,
    error_reason: null,
    created_at: '2026-08-05T00:00:00.000Z',
    updated_at: '2026-08-05T00:00:00.000Z',
  };
}

const mockFrom = vi.mocked(supabase.from);
let fake: ReturnType<typeof createOwnerScopedFake>;

describe('inboundTaskService — ligadura de fila e idempotencia (WKH-SEC-03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fake = createOwnerScopedFake({
      a2a_inbound_tasks: {
        columns: INBOUND_COLUMNS,
        rows: [
          inboundRow(TASK_A, OWNER_A, 'lo de A'),
          inboundRow(TASK_B, OWNER_B, 'lo de B'),
        ],
      },
    });
    mockFrom.mockImplementation(
      (table: string) => fake.from(table) as ReturnType<typeof mockFrom>,
    );
  });

  it('IT-01 [inbound-task.ts:316]: get(A, idDeB) → undefined, con el id PRESENTE en la tabla', async () => {
    // Sin afirmar que el id existe, un `undefined` podría venir de que la fila
    // nunca se insertó.
    expect(fake.rows('a2a_inbound_tasks').some((r) => r.id === TASK_B)).toBe(
      true,
    );

    const found = await inboundTaskService.get(OWNER_A, TASK_B);

    expect(found).toBeUndefined();
  });

  it('IT-01b (anti-vacuidad): get(A, idDeA) devuelve la fila de A', async () => {
    const found = await inboundTaskService.get(OWNER_A, TASK_A);

    expect(found?.id).toBe(TASK_A);
    expect(found?.goal).toBe('lo de A');
  });

  it('IT-02 [inbound-task.ts:338]: dos dueños con el MISMO (source, external_ref) no dedupean entre sí', async () => {
    // Las dos filas comparten `source` y `external_ref` y difieren sólo en el
    // dueño. Si el filtro no estuviera, el pre-check de idempotencia de A
    // encontraría la tarea de B y trataría la de A como replay.
    const paraA = await inboundTaskService.getByExternalRef(
      OWNER_A,
      SOURCE,
      EXTERNAL_REF,
    );
    const paraB = await inboundTaskService.getByExternalRef(
      OWNER_B,
      SOURCE,
      EXTERNAL_REF,
    );

    // Cada dueño ve LA SUYA, y son distintas: las dos direcciones en un solo
    // escenario.
    expect(paraA?.id).toBe(TASK_A);
    expect(paraB?.id).toBe(TASK_B);
    expect(paraA?.id).not.toBe(paraB?.id);
  });

  it('IT-02b: un dueño sin fila para ese external_ref obtiene undefined aunque otro sí la tenga', async () => {
    const OWNER_C = 'owner-C-0xcccc';

    const paraC = await inboundTaskService.getByExternalRef(
      OWNER_C,
      SOURCE,
      EXTERNAL_REF,
    );

    // C tiene que poder ingestar su propio `pedido-1234` sin que las filas de A
    // y B se lo dedupeen.
    expect(paraC).toBeUndefined();
    expect(fake.rows('a2a_inbound_tasks')).toHaveLength(2);
  });
});
