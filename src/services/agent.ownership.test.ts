/**
 * `publishedAgentService` — aislamiento y defensa en profundidad (WKH-SEC-03).
 *
 * ── LOS DOS HUECOS QUE CIERRA ESTE ARCHIVO ────────────────────────────────
 *
 * `src/services/agent.ts:549` (`listMine`) y `src/services/agent.ts:715` (el
 * DELETE). Medido en `ef384b7`: borrando cualquiera de las dos líneas la suite
 * entera quedaba idéntica a la baseline.
 *
 * ── NO CONFUNDIR CON `src/routes/agents.ownership.test.ts` ────────────────
 *
 * Ese archivo existe, se titula "anti-IDOR" y prueba OTRA cosa: su mock registra
 * los `.eq()` (`:49`) pero `maybeSingle`/`single` (`:53-54`) devuelven
 * `state.row` sin importar qué columna ni qué valor se filtró. Verifica que la
 * consulta se escribió, no que aisló. Acá el falso APLICA los filtros pedidos
 * sobre una tabla con dos dueños, así que lo que se afirma es la propiedad.
 *
 * ── HONESTIDAD SOBRE EL ESCENARIO DE AG-02 ───────────────────────────────
 *
 * `agentService.delete` hace `this.getRow(slug)` SIN filtro de dueño (`:692`),
 * compara el dueño en JavaScript (`:701`) y recién ahí ejecuta el DELETE
 * (`:712-716`). O sea que un cross-tenant simple muere en el pre-chequeo y el
 * filtro de la ESCRITURA nunca se ejercita: se puede borrar y la suite queda
 * verde. Por eso AG-02 ataca lo que ese segundo filtro acota de verdad — read y
 * write son DOS viajes a la base, y nada asegura que la fila siga siendo la
 * misma en el segundo.
 *
 * Hoy ninguna operación de este repo cambia el `owner_ref` de un agente, así que
 * la carrera exacta que se simula NO es alcanzable en producción. Eso es lo que
 * significa defensa en profundidad: el filtro está para que la escritura siga
 * acotada si mañana el read previo se refactoriza, se saltea, o devuelve un dato
 * viejo. Sin test, ese filtro es decoración: se puede borrar y nadie se entera.
 *
 * ⚠️ La forma de la aserción NO se copia de `task.ownership.test.ts:285-317`.
 * `taskService.updateStatus` LANZA; `agentService.delete` devuelve un booleano
 * (`agent.ts:721`: `return Array.isArray(data) && data.length > 0`). Con la fila
 * ya pasada a B, el DELETE no matchea nada, `data` es `[]` y la función devuelve
 * `false` SIN excepción. Un `rejects.toThrow` acá no se pone rojo nunca: se pone
 * gris.
 *
 * Naming: AG-01, AG-02.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn() },
}));

import { supabase } from '../lib/supabase.js';
import { createOwnerScopedFake } from './__tests__/owner-scoped-fake.js';
import { publishedAgentService } from './agent.js';

const OWNER_A = 'owner-A-0xaaaa';
const OWNER_B = 'owner-B-0xbbbb';
const SLUG_A = 'agente-de-a';
const SLUG_B = 'agente-de-b';

const AGENT_COLUMNS = [
  'slug',
  'name',
  'description',
  'capabilities',
  'agent_url',
  'price_usdc',
  'metadata',
  'enabled',
  'owner_ref',
  'created_at',
];

function agentRow(
  slug: string,
  ownerRef: string,
  createdAt: string,
): Record<string, unknown> {
  return {
    slug,
    name: `Agente ${slug}`,
    description: 'x',
    capabilities: ['a'],
    agent_url: `https://example.test/${slug}`,
    price_usdc: 1,
    metadata: null,
    enabled: true,
    owner_ref: ownerRef,
    created_at: createdAt,
  };
}

const mockFrom = vi.mocked(supabase.from);

describe('publishedAgentService — aislamiento entre tenants (WKH-SEC-03)', () => {
  let fake: ReturnType<typeof createOwnerScopedFake>;

  beforeEach(() => {
    vi.clearAllMocks();
    fake = createOwnerScopedFake({
      a2a_agents: {
        columns: AGENT_COLUMNS,
        rows: [
          agentRow(SLUG_A, OWNER_A, '2026-01-01T00:00:00.000Z'),
          agentRow(SLUG_B, OWNER_B, '2026-01-02T00:00:00.000Z'),
        ],
      },
    });
    mockFrom.mockImplementation(
      (table: string) => fake.from(table) as ReturnType<typeof mockFrom>,
    );
  });

  it('AG-01 [agent.ts:549]: listMine(A) devuelve exactamente los agentes de A, nunca el de B', async () => {
    const records = await publishedAgentService.listMine(OWNER_A);

    const slugs = records.map((r) => r.slug);
    // Las dos direcciones: A ve lo suyo (si el filtro usara la columna
    // equivocada esto fallaría) y NO ve lo de B.
    expect(slugs).toEqual([SLUG_A]);
    expect(slugs).not.toContain(SLUG_B);
    // Y el de B sigue existiendo: lo único que lo esconde es el filtro.
    expect(fake.rows('a2a_agents').some((r) => r.slug === SLUG_B)).toBe(true);
  });

  it('AG-02 [agent.ts:715]: si la fila pasa a ser de B entre el pre-chequeo y el DELETE, el DELETE no la toca', async () => {
    const rowA = fake.rows('a2a_agents').find((r) => r.slug === SLUG_A);
    expect(rowA).toBeDefined();

    // Entre el `getRow()` (que ve la fila como de A) y el DELETE, la fila pasa
    // a B. El hook corre DENTRO de `.delete()` del falso, o sea exactamente
    // entre los dos viajes a la base.
    fake.onDeleteStart = () => {
      if (rowA !== undefined) rowA.owner_ref = OWNER_B;
    };

    const deleted = await publishedAgentService.delete(SLUG_A, OWNER_A);

    // LA ASERCIÓN QUE IMPORTA, y no es `rejects.toThrow`: la función devuelve
    // `false` sin lanzar, y la fila que ahora es de B sigue en la tabla.
    expect(deleted).toBe(false);
    expect(rowA?.owner_ref).toBe(OWNER_B);
    expect(fake.rows('a2a_agents').some((r) => r.slug === SLUG_A)).toBe(true);
  });

  it('AG-02b (anti-vacuidad): sin la carrera, A SÍ borra su propio agente', async () => {
    // Sin esta dirección, un falso que nunca borrara nada haría pasar AG-02 por
    // la razón equivocada.
    const deleted = await publishedAgentService.delete(SLUG_A, OWNER_A);

    expect(deleted).toBe(true);
    expect(fake.rows('a2a_agents').some((r) => r.slug === SLUG_A)).toBe(false);
    // Y no se llevó puesto al de B.
    expect(fake.rows('a2a_agents').some((r) => r.slug === SLUG_B)).toBe(true);
  });
});
