/**
 * `services/task.ts` — CANDADO del aislamiento entre tenants (Ownership Guard).
 *
 * ── EL HUECO QUE CIERRA ESTE ARCHIVO ──────────────────────────────────────
 *
 * Los 4 `.eq('owner_ref', ownerRef)` de `services/task.ts` son la ÚNICA barrera
 * real entre tenants: el cliente de Supabase usa `SUPABASE_SERVICE_KEY`, que
 * BYPASSEA RLS, así que la política de Postgres no protege nada acá (ver
 * `CLAUDE.md`, sección Ownership Guard). Y hasta esta HU, NINGÚN test los miraba:
 * borrando el filtro de `get()` la suite completa quedaba en
 * `3669 passed | 19 skipped`, cero rojos, con un IDOR vivo (cualquier caller
 * autenticado leyendo las tareas de otro owner). Reproducido antes de escribir
 * esto, para no arreglar un hallazgo sin verificarlo.
 *
 * ── POR QUÉ UN FAKE DE COMPORTAMIENTO Y NO UN `expect(eq).toHaveBeenCalledWith` ──
 *
 * Había dos formas de candadear esto:
 *
 *   (A) espiar la llamada: afirmar que el builder recibió `.eq('owner_ref', X)`;
 *   (B) un fake con datos de DOS owners que APLICA los filtros que le piden, y
 *       afirmar la propiedad: el caller A no puede ver ni mutar el recurso de B.
 *
 * Elegí (B) como test principal, por tres razones:
 *
 *   1. (A) verifica la IMPLEMENTACIÓN ("llamaste a este método con estos
 *      argumentos"), no la PROPIEDAD DE SEGURIDAD. Un test que pasa porque la
 *      llamada existe no dice nada sobre qué datos salen;
 *   2. (B) atrapa fallas que (A) no ve: p.ej. `.eq('ownerRef', …)` con el nombre
 *      de columna mal escrito pasaría (A) perfectamente (la llamada existe, con
 *      su valor correcto) y sin embargo dejaría al owner sin ver sus PROPIAS
 *      tareas — eso lo caza T-OWN-02, no el espía;
 *   3. la forma del test es la del ataque ("A pide lo de B"), así que se lee como
 *      el riesgo que existe, no como la línea de código que hoy lo evita.
 *
 * ⚠️ LA TRAMPA QUE ESTE FAKE EVITA (y que haría el test vacuo): el fake NO filtra
 * por owner por su cuenta. Aplica ÚNICAMENTE los `.eq(col, val)` que el servicio
 * le pide, sobre una tabla en memoria. Si hubiera hardcodeado "devolvé sólo las
 * filas del owner", el test pasaría IGUAL sin el filtro en el servicio y
 * volveríamos al punto de partida. Ese es exactamente el modo de falla del mock
 * anterior (`task.test.ts`): su `eq` era `vi.fn().mockReturnValue(chain)`, o sea
 * ignoraba los argumentos.
 *
 * (A) igual está, pero como BACKSTOP declarativo y en UN solo test (T-OWN-06),
 * que además nombra el sitio que falla.
 *
 * Naming: T-OWN-01..T-OWN-06.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn() },
}));

import { supabase } from '../lib/supabase.js';
import { taskService } from './task.js';

// ── Los dos tenants del escenario ────────────────────────────
const OWNER_A = 'owner-A-0xaaaa';
const OWNER_B = 'owner-B-0xbbbb';
const TASK_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TASK_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface Row {
  id: string;
  owner_ref: string;
  context_id: string | null;
  status: string;
  messages: unknown[];
  artifacts: unknown[];
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

function makeRow(id: string, ownerRef: string, over: Partial<Row> = {}): Row {
  return {
    id,
    owner_ref: ownerRef,
    context_id: null,
    status: 'submitted',
    messages: [],
    artifacts: [],
    metadata: null,
    created_at: '2026-07-27T18:00:00.000Z',
    updated_at: '2026-07-27T18:00:00.000Z',
    ...over,
  };
}

// ── Fake PostgREST: tabla en memoria + los filtros QUE LE PIDEN ───────────

type Filter = readonly [column: string, value: unknown];
type Kind = 'select' | 'insert' | 'update';

interface FakeError {
  message: string;
  code: string;
}
interface FakeResult<T> {
  data: T | null;
  error: FakeError | null;
}

/** Query registrada, para el backstop estructural de T-OWN-06. */
interface Recorded {
  kind: Kind;
  filters: Filter[];
  inserted: Record<string, unknown> | null;
}

interface Builder {
  select(columns?: string): Builder;
  insert(row: Record<string, unknown>): Builder;
  update(patch: Record<string, unknown>): Builder;
  eq(column: string, value: unknown): Builder;
  order(column: string, opts?: { ascending?: boolean }): Builder;
  limit(n: number): Builder;
  single(): Promise<FakeResult<Row>>;
  maybeSingle(): Promise<FakeResult<Row>>;
  /** Thenable por diseño: es lo que hace que `await query` resuelva en `list()`. */
  then<R>(onFulfilled: (value: FakeResult<Row[]>) => R): Promise<R>;
}

/** Estado del fake, reseteado en cada test. */
let db: Row[] = [];
let recorded: Recorded[] = [];
/**
 * Hook que corre cuando el servicio arranca un UPDATE, o sea ENTRE el read
 * previo y la escritura. Es lo que hace COMPROBABLE el filtro de la escritura
 * (ver T-OWN-03 / T-OWN-04).
 */
let onUpdateStart: (() => void) | null = null;

function rowField(row: Row, column: string): unknown {
  return (row as unknown as Record<string, unknown>)[column];
}

/** Aplica EXACTAMENTE los filtros pedidos. Ni uno más. */
function applyFilters(rows: Row[], filters: Filter[]): Row[] {
  return rows.filter((row) =>
    filters.every(([column, value]) => rowField(row, column) === value),
  );
}

const NO_ROWS: FakeError = {
  // Mismo shape que PostgREST cuando `single()` no matchea nada.
  message: 'JSON object requested, multiple (or no) rows returned',
  code: 'PGRST116',
};

function makeBuilder(): Builder {
  const filters: Filter[] = [];
  let kind: Kind = 'select';
  let patch: Record<string, unknown> | null = null;
  let inserted: Record<string, unknown> | null = null;
  let max = Number.POSITIVE_INFINITY;

  const record = (): void => {
    recorded.push({ kind, filters: [...filters], inserted });
  };

  const builder: Builder = {
    select: () => builder,
    insert: (row) => {
      kind = 'insert';
      inserted = row;
      return builder;
    },
    update: (nextPatch) => {
      kind = 'update';
      patch = nextPatch;
      // El servicio ya hizo su read; acá es donde el escenario puede cambiar la
      // realidad debajo de la escritura.
      onUpdateStart?.();
      return builder;
    },
    eq: (column, value) => {
      filters.push([column, value]);
      return builder;
    },
    order: () => builder,
    limit: (n) => {
      max = n;
      return builder;
    },

    single: async (): Promise<FakeResult<Row>> => {
      record();
      if (kind === 'insert') {
        const row = makeRow(
          String(inserted?.id ?? TASK_A),
          String(inserted?.owner_ref ?? ''),
          inserted as Partial<Row>,
        );
        db.push(row);
        return { data: row, error: null };
      }
      const matched = applyFilters(db, filters);
      const first = matched[0];
      if (!first) return { data: null, error: NO_ROWS };
      if (kind === 'update' && patch) {
        for (const row of matched) {
          Object.assign(row, patch);
        }
      }
      return { data: first, error: null };
    },

    maybeSingle: async (): Promise<FakeResult<Row>> => {
      record();
      const first = applyFilters(db, filters)[0];
      return { data: first ?? null, error: null };
    },

    // biome-ignore lint/suspicious/noThenProperty: idem — es lo que hace que `await query` funcione en `list()`
    then: <R>(onFulfilled: (value: FakeResult<Row[]>) => R): Promise<R> => {
      record();
      const matched = applyFilters(db, filters).slice(0, max);
      return Promise.resolve(onFulfilled({ data: matched, error: null }));
    },
  };

  return builder;
}

const mockFrom = vi.mocked(supabase.from);

describe('taskService — aislamiento entre tenants (Ownership Guard, WKH-54)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db = [];
    recorded = [];
    onUpdateStart = null;
    mockFrom.mockImplementation(
      () => makeBuilder() as unknown as ReturnType<typeof mockFrom>,
    );
  });

  // ══════════════════════════════════════════════════════════
  // (1) LECTURAS — A no puede VER lo de B
  // ══════════════════════════════════════════════════════════

  it('T-OWN-01 [get, task.ts:102]: A pide por id la task de B → undefined (no se filtra ni su existencia)', async () => {
    db.push(makeRow(TASK_B, OWNER_B, { metadata: { secret: 'de B' } }));

    const found = await taskService.get(OWNER_A, TASK_B);

    // El id EXISTE en la tabla; lo único que lo esconde es el filtro por dueño.
    expect(db.some((r) => r.id === TASK_B)).toBe(true);
    expect(found).toBeUndefined();
  });

  it('T-OWN-02 [list, task.ts:126]: A lista y sólo salen SUS tasks, nunca las de B', async () => {
    db.push(makeRow(TASK_A, OWNER_A));
    db.push(makeRow(TASK_B, OWNER_B));

    const tasks = await taskService.list(OWNER_A);

    const ids = tasks.map((t) => t.id);
    // Las dos direcciones: A ve lo suyo (si el filtro usara la columna
    // equivocada, esto fallaría) y NO ve lo de B (el IDOR).
    expect(ids).toEqual([TASK_A]);
    expect(ids).not.toContain(TASK_B);
  });

  // ══════════════════════════════════════════════════════════
  // (2) ESCRITURAS — A no puede MUTAR lo de B
  // ══════════════════════════════════════════════════════════
  // POR QUÉ NO ALCANZA "A pide mutar la task de B": esas dos rutas hacen un
  // `this.get(ownerRef, id)` ANTES de escribir, así que el cross-tenant simple
  // muere en el filtro de `get()` (T-OWN-01) y el filtro DEL UPDATE nunca se
  // ejercita — se podría borrar sin romper nada. Por eso el escenario ataca lo
  // que ese segundo filtro protege de verdad: read y write son DOS viajes a la
  // DB, y nada garantiza que la fila siga siendo la misma en el segundo.
  //
  // HONESTIDAD SOBRE EL ESCENARIO: hoy ninguna operación de este repo cambia el
  // `owner_ref` de una task, así que la carrera exacta que se simula no es
  // alcanzable en producción HOY. Eso es precisamente lo que significa "defensa
  // en profundidad" (comentario de `task.ts:163`): el filtro está para que la
  // escritura siga acotada si mañana el read previo se refactoriza, se saltea o
  // devuelve un dato viejo. Sin un test, ese filtro es decoración: se puede
  // borrar y la suite entera queda verde.

  it('T-OWN-03 [updateStatus, task.ts:168]: si la fila pasa a ser de B entre el read y el UPDATE, el UPDATE no la toca', async () => {
    const row = makeRow(TASK_A, OWNER_A, { status: 'submitted' });
    db.push(row);
    // Entre el `get()` (que ve la fila como de A) y el UPDATE, la fila pasa a B.
    onUpdateStart = () => {
      row.owner_ref = OWNER_B;
    };

    await expect(
      taskService.updateStatus(OWNER_A, TASK_A, 'working'),
    ).rejects.toThrow('Failed to update task status');

    // LA ASERCIÓN QUE IMPORTA: la fila de B quedó intacta.
    expect(row.owner_ref).toBe(OWNER_B);
    expect(row.status).toBe('submitted');
  });

  it('T-OWN-04 [append, task.ts:218]: si la fila pasa a ser de B entre el read y el UPDATE, no se le appendea nada', async () => {
    const row = makeRow(TASK_A, OWNER_A, { messages: [{ text: 'de A' }] });
    db.push(row);
    onUpdateStart = () => {
      row.owner_ref = OWNER_B;
    };

    await expect(
      taskService.append(OWNER_A, TASK_A, {
        messages: [{ text: 'inyectado por A' }],
      }),
    ).rejects.toThrow('Failed to append to task');

    expect(row.owner_ref).toBe(OWNER_B);
    expect(row.messages).toEqual([{ text: 'de A' }]);
  });

  // ══════════════════════════════════════════════════════════
  // (3) EL ORIGEN DEL DUEÑO Y EL BACKSTOP ESTRUCTURAL
  // ══════════════════════════════════════════════════════════

  it('T-OWN-05 [create, task.ts:74]: el insert ESTAMPA el owner_ref del caller', async () => {
    // Los 4 filtros de arriba no sirven de nada si la fila nace sin dueño (o con
    // el dueño de otro): todo el esquema arranca acá.
    await taskService.create(OWNER_A, { messages: [{ text: 'hola' }] });

    const insert = recorded.find((q) => q.kind === 'insert');
    expect(insert?.inserted?.owner_ref).toBe(OWNER_A);
    expect(db[0]?.owner_ref).toBe(OWNER_A);
  });

  it('T-OWN-06 (backstop estructural): las 4 queries llevan el filtro por dueño, y nombra la que falte', async () => {
    // Complemento de los tests de propiedad: si alguien borra UN filtro, este
    // test dice CUÁL de los 4 sitios quedó abierto. No reemplaza a T-OWN-01..04
    // (una llamada existente no prueba qué datos salen), los ubica.
    db.push(makeRow(TASK_A, OWNER_A));

    await taskService.get(OWNER_A, TASK_A);
    await taskService.list(OWNER_A);
    await taskService.updateStatus(OWNER_A, TASK_A, 'working');
    await taskService.append(OWNER_A, TASK_A, { messages: [{ t: 1 }] });

    // Una entrada por query que llegó a la DB, en orden. `updateStatus` y
    // `append` son dos queries cada una (el read previo + la escritura).
    const scoped = recorded.map(
      (q) =>
        `${q.kind}:${q.filters.some(([c, v]) => c === 'owner_ref' && v === OWNER_A) ? 'scoped' : 'UNSCOPED'}`,
    );
    expect(scoped).toEqual([
      'select:scoped', // get()            → task.ts:102
      'select:scoped', // list()           → task.ts:126
      'select:scoped', // updateStatus → get() previo
      'update:scoped', // updateStatus     → task.ts:168
      'select:scoped', // append → get() previo
      'update:scoped', // append           → task.ts:218
    ]);
  });
});
