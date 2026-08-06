/**
 * Falso de PostgREST para los tests de aislamiento por dueño.
 *
 * ⚠️ POR QUÉ ESTÁ EN `__tests__/` Y NO EN `__fixtures__/`. Medido: el
 * `tsconfig.build.json` excluye exactamente `src/**\/*.test.ts` y
 * `src/**\/__tests__/**`. Un archivo en `src/services/__fixtures__/` SÍ entra al
 * build de producción y termina en `dist/`. Un doble de test publicado en el
 * artefacto de producción es una superficie que nadie pidió.
 *
 * ── DE DÓNDE SALE ──────────────────────────────────────────────────────────
 *
 * De DOS implementaciones independientes del mismo falso que ya convivían en el
 * repo, escritas por separado y convergidas en la misma forma:
 *
 *   E-1  `src/services/task.ownership.test.ts:91-225`
 *   E-1b `src/services/identity.require-signature.ownership.test.ts:140-215`
 *
 * Lo que las dos tienen es lo que se extrajo (tabla en memoria, `applyFilters`,
 * los shapes de PostgREST, el registro de queries). Lo que sólo tiene E-1b y se
 * heredó a propósito es `unknownColumn`: ver abajo.
 *
 * ── LA TRAMPA QUE ESTE FALSO EVITA (y que haría vacuo a todo test que lo use) ──
 *
 * El falso NO filtra por dueño por su cuenta. Aplica ÚNICAMENTE los `.eq(col,
 * val)` que el servicio le pide, sobre la tabla en memoria. Si hardcodeara
 * «devolvé sólo las filas del dueño», todo test pasaría IGUAL con el filtro
 * borrado del servicio, que es exactamente el punto de partida que esta HU
 * existe para medir. Por eso «si filtra por dueño» es lo único que NO se
 * parametriza.
 *
 * ── POR QUÉ `unknownColumn` (la herencia de E-1b) ──────────────────────────
 *
 * Un filtro sobre una columna que no existe devuelve un ERROR de Postgres
 * (`42703`), no un predicado vacío. Sin eso, un `.eq('ownerRef', …)` mal escrito
 * en camelCase se leería como «no matcheó ninguna fila», que es indistinguible
 * de un cross-tenant legítimo: el test cross-tenant pasaría por la razón
 * equivocada y el dueño se quedaría sin ver sus propias filas en producción.
 * Con esto, el test que afirma que A ve lo suyo explota con un mensaje que se
 * entiende.
 *
 * ── QUÉ MÉTODOS TIENE Y POR QUÉ NO MÁS ─────────────────────────────────────
 *
 * Los que las 11 cadenas de este corte ejercitan: `select`, `insert`, `update`,
 * `delete`, `eq`, `order`, `limit`, `single`, `maybeSingle` y el thenable. Más
 * `upsert`, que ninguna de las 11 usa pero sí toca un camino colateral (el
 * `persistToL2` best-effort de `llm/transform.ts:301`, al que se llega cuando la
 * caché L2 no matchea).
 *
 * NO tiene `in` / `not` / `match` / `is` / `neq` / `lt`: ninguna de las 11 los
 * usa (verificado cadena por cadena). Omitirlos es seguro porque el modo de
 * falla es ruidoso: una cadena que llame a un método ausente explota con «is not
 * a function», no degrada a «no matcheó nada».
 *
 * Tampoco tiene `onUpdateStart` (E-1 sí lo tiene): el único entrelazado de este
 * corte es sobre un DELETE, así que el hook que hay es `onDeleteStart`.
 */

/** Un filtro pedido por el servicio: columna y valor, tal cual llegaron. */
export type Filter = readonly [column: string, value: unknown];

export type Kind = 'select' | 'insert' | 'update' | 'delete' | 'upsert';

export type Row = Record<string, unknown>;

export interface FakeError {
  message: string;
  code: string;
}

export interface FakeResult<T> {
  data: T | null;
  error: FakeError | null;
}

/**
 * Una cadena construida contra el falso.
 *
 * ⚠️ `resolved` distingue dos cosas que se confunden todo el tiempo: una cadena
 * ARMADA y una cadena que LLEGÓ A LA BASE. En PostgREST real el request se
 * dispara dentro de `then()` (`@supabase/postgrest-js@2.101.1`,
 * `dist/index.mjs:104` — es el ÚNICO call-site de `fetch` de la librería), así
 * que una cadena que nadie resuelve nunca sale a la red. El falso reproduce esa
 * semántica en vez de taparla, porque hay al menos un sitio de producción que
 * depende de eso sin saberlo (ver `transform.ownership.test.ts`).
 */
export interface QueryRecord {
  table: string;
  kind: Kind;
  filters: Filter[];
  /** `true` sólo si la cadena se resolvió (`single`/`maybeSingle`/`await`). */
  resolved: boolean;
  inserted: Row | null;
  patch: Row | null;
}

/** Definición de una tabla del falso. */
export interface TableSpec {
  /**
   * Las columnas que existen. Filtrar por una que no esté acá devuelve `42703`,
   * igual que Postgres. Es lo que convierte un nombre de columna mal escrito en
   * un rojo ruidoso en vez de un «no encontré nada» silencioso.
   */
  columns: string[];
  rows?: Row[];
}

export interface OwnerScopedFake {
  /** Lo que se le enchufa a `vi.mocked(supabase.from)`. */
  from(table: string): unknown;
  /** Las filas vivas de una tabla (el estado, para afirmar sobre él). */
  rows(table: string): Row[];
  /** Toda cadena construida, resuelta o no. */
  queries: QueryRecord[];
  /** Sólo las cadenas que llegaron a la base. */
  resolved(): QueryRecord[];
  /**
   * Corre al entrar a `.delete()`, o sea ENTRE el read previo del servicio y la
   * escritura. Es lo que hace comprobable el filtro de una escritura que está
   * detrás de un pre-chequeo en JavaScript.
   */
  onDeleteStart: ((table: string) => void) | null;
}

/** Mismo shape que PostgREST cuando `single()` no matchea exactamente una fila. */
export const NO_ROWS: FakeError = {
  message: 'JSON object requested, multiple (or no) rows returned',
  code: 'PGRST116',
};

/** Aplica EXACTAMENTE los filtros pedidos. Ni uno más. */
function applyFilters(rows: Row[], filters: Filter[]): Row[] {
  return rows.filter((row) =>
    filters.every(([column, value]) => row[column] === value),
  );
}

/** Primer filtro sobre una columna inexistente, si hay alguno. */
function unknownColumn(
  filters: Filter[],
  columns: string[],
): string | undefined {
  return filters.map(([column]) => column).find((c) => !columns.includes(c));
}

function columnError(table: string, column: string): FakeError {
  return {
    message: `column ${table}.${column} does not exist`,
    code: '42703',
  };
}

export function createOwnerScopedFake(
  spec: Record<string, TableSpec>,
): OwnerScopedFake {
  const data = new Map<string, Row[]>();
  const columns = new Map<string, string[]>();
  for (const [table, def] of Object.entries(spec)) {
    data.set(
      table,
      (def.rows ?? []).map((r) => ({ ...r })),
    );
    columns.set(table, [...def.columns]);
  }

  const fake: OwnerScopedFake = {
    queries: [],
    onDeleteStart: null,
    rows: (table) => data.get(table) ?? [],
    resolved: () => fake.queries.filter((q) => q.resolved),
    from: (table) => makeBuilder(table),
  };

  function makeBuilder(table: string): unknown {
    const filters: Filter[] = [];
    let kind: Kind = 'select';
    let patch: Row | null = null;
    let inserted: Row | null = null;
    let max = Number.POSITIVE_INFINITY;
    let sort: { column: string; ascending: boolean } | null = null;

    // Se registra al ARMARSE, no al resolverse, y se marca `resolved` recién
    // cuando la cadena se consume. Así una cadena que nadie awaitea queda
    // visible como lo que es: armada y jamás enviada.
    const record: QueryRecord = {
      table,
      kind,
      filters,
      resolved: false,
      inserted: null,
      patch: null,
    };
    fake.queries.push(record);

    /**
     * Refleja el verbo y el payload en el registro APENAS se los pide, sin
     * esperar a la resolución. Es lo que hace observable una cadena que nadie
     * resuelve: si el verbo se anotara recién en `sync()`, un
     * `void supabase.from(x).update(y).eq(...)` quedaría registrado como
     * `select` y sería indistinguible de una lectura.
     */
    const touch = (): void => {
      record.kind = kind;
      record.inserted = inserted;
      record.patch = patch;
    };

    const sync = (): void => {
      touch();
      record.resolved = true;
    };

    const tableRows = (): Row[] => {
      let rows = data.get(table);
      if (rows === undefined) {
        rows = [];
        data.set(table, rows);
      }
      return rows;
    };

    const badColumn = (): FakeError | null => {
      const bad = unknownColumn(filters, columns.get(table) ?? []);
      return bad === undefined ? null : columnError(table, bad);
    };

    const matched = (): Row[] => {
      const rows = applyFilters(tableRows(), filters);
      if (sort !== null) {
        const { column, ascending } = sort;
        rows.sort((a, b) => {
          const av = String(a[column] ?? '');
          const bv = String(b[column] ?? '');
          return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      return rows.slice(0, max);
    };

    const builder = {
      select: () => builder,
      insert: (row: Row) => {
        kind = 'insert';
        inserted = row;
        touch();
        return builder;
      },
      update: (next: Row) => {
        kind = 'update';
        patch = next;
        touch();
        return builder;
      },
      /**
       * ⚠️ El falso NO modela resolución de conflictos: un `upsert` acá
       * simplemente agrega la fila. Ningún test de este corte depende de la
       * semántica de `onConflict` — está para que las cadenas que lo llaman
       * (p. ej. el `persistToL2` best-effort de `llm/transform.ts:301`) no
       * exploten con «upsert is not a function» y ensucien el resultado con un
       * error que no es el que se está midiendo.
       */
      upsert: (row: Row) => {
        kind = 'upsert';
        inserted = row;
        touch();
        return builder;
      },
      delete: () => {
        kind = 'delete';
        touch();
        // El escenario puede cambiar la realidad debajo de la escritura, justo
        // acá: el servicio ya hizo su read y todavía no aplicó los filtros.
        fake.onDeleteStart?.(table);
        return builder;
      },
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return builder;
      },
      order: (column: string, opts?: { ascending?: boolean }) => {
        sort = { column, ascending: opts?.ascending !== false };
        return builder;
      },
      limit: (n: number) => {
        max = n;
        return builder;
      },

      single: async (): Promise<FakeResult<Row>> => {
        sync();
        const bad = badColumn();
        if (bad !== null) return { data: null, error: bad };
        if ((kind === 'insert' || kind === 'upsert') && inserted !== null) {
          const row = { ...inserted };
          tableRows().push(row);
          return { data: row, error: null };
        }
        const rows = matched();
        // PostgREST: `single()` es error tanto con 0 filas como con más de una.
        if (rows.length !== 1) return { data: null, error: NO_ROWS };
        const first = rows[0] as Row;
        if (kind === 'update' && patch !== null) Object.assign(first, patch);
        return { data: first, error: null };
      },

      maybeSingle: async (): Promise<FakeResult<Row>> => {
        sync();
        const bad = badColumn();
        if (bad !== null) return { data: null, error: bad };
        const rows = matched();
        if (rows.length > 1) return { data: null, error: NO_ROWS };
        const first = rows[0];
        if (first === undefined) return { data: null, error: null };
        if (kind === 'update' && patch !== null) Object.assign(first, patch);
        return { data: first, error: null };
      },

      // biome-ignore lint/suspicious/noThenProperty: es lo que hace que `await query` resuelva, igual que PostgREST
      then: <R>(onFulfilled: (value: FakeResult<Row[]>) => R): Promise<R> => {
        sync();
        const bad = badColumn();
        if (bad !== null) {
          return Promise.resolve(onFulfilled({ data: null, error: bad }));
        }
        const rows = matched();
        if (kind === 'update' && patch !== null) {
          for (const row of rows) Object.assign(row, patch);
        }
        if (kind === 'delete') {
          const live = tableRows();
          for (const row of rows) {
            const at = live.indexOf(row);
            if (at !== -1) live.splice(at, 1);
          }
        }
        if ((kind === 'insert' || kind === 'upsert') && inserted !== null) {
          const row = { ...inserted };
          tableRows().push(row);
          return Promise.resolve(onFulfilled({ data: [row], error: null }));
        }
        return Promise.resolve(onFulfilled({ data: rows, error: null }));
      },
    };

    return builder;
  }

  return fake;
}
