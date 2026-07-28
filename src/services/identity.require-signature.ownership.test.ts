/**
 * `identityService.setRequireSignature` — CANDADO de su Ownership Guard
 * (`identity.ts:143-144`).
 *
 * ── QUÉ ES ESTO Y QUÉ NO ES ───────────────────────────────────────────────
 *
 * ESTO **NO** DOCUMENTA UN IDOR VIVO. Hoy el `keyId` que llega al servicio NO es
 * controlable por el atacante: su ÚNICO caller (`routes/auth/require-signature.ts`)
 * rechaza con 403 si `req.params.id !== callerKey.id` (línea 47) y después le pasa
 * al servicio `callerKey.id` + `callerKey.owner_ref`, los DOS derivados de la MISMA
 * fila de la credencial autenticada. Por ese camino, el `.eq('owner_ref', …)` del
 * servicio es redundante.
 *
 * Lo que este archivo candadea es **defensa en profundidad**. El comentario de
 * `identity.ts:129-131` promete "UPDATE filtered by id AND owner_ref so a caller
 * can only flip ITS OWN key", y hasta esta HU NADA lo verificaba: borrando el
 * `.eq('owner_ref', ownerRef)` de `identity.ts:144` la suite completa quedaba en
 * `3756 passed | 19 skipped`, cero rojos (medido antes de escribir esto). O sea:
 * un caller nuevo, o un refactor que traiga el `keyId` de otra procedencia
 * (path param, body, job batch, panel de admin), se queda sin la promesa EN
 * SILENCIO. Este test existe para que la promesa siga siendo verdad.
 *
 * Si se abriera, el impacto es cross-tenant en las DOS direcciones, y por eso
 * las dos están testeadas (T-RS-01 y T-RS-02):
 *   - prender `require_signature` en la key de otro owner = DoS de ese tenant
 *     (todos sus callers empiezan a comer `SIGNATURE_REQUIRED`);
 *   - apagarlo = desactivarle un control de seguridad que ese owner eligió.
 *
 * ── POR QUÉ SE ESCAPÓ (la asimetría) ──────────────────────────────────────
 *
 * De los 6 `.eq('owner_ref', …)` sobre `a2a_agent_keys` en `src/services/`, cinco
 * se ponen rojos al quitarlos (`budget.ts:99`, `identity.ts:116`, `identity.ts:182`,
 * `identity.ts:222`, `identity.ts:289`); ESTE era el único que no. La razón: su
 * único caller se testea con el servicio MOCKEADO (`routes/auth.signed-auth.test.ts:35`),
 * así que ese test no puede ver la query, y el servicio no tenía test unitario.
 * Encima su hermano `keySessionService.setRequireSignature` (otra tabla) SÍ tiene
 * el suyo (`key-session.test.ts:296`), y esa asimetría es lo que lo hizo fácil de
 * pasar por alto: "require_signature ya está cubierto".
 *
 * ── POR QUÉ UN FAKE DE COMPORTAMIENTO Y NO UN `expect(eq).toHaveBeenCalledWith` ─
 *
 * Mismo criterio que `task.ownership.test.ts` (HU-197), que es el patrón de este
 * repo: un espía verifica la IMPLEMENTACIÓN ("llamaste `.eq` con estos
 * argumentos"), no la PROPIEDAD DE SEGURIDAD. El caso que lo demuestra es la
 * columna mal escrita: `.eq('ownerRef', ownerRef)` pasa el espía PERFECTO (la
 * llamada existe, con su valor correcto) y sin embargo deja al dueño sin poder
 * tocar su PROPIA key (Postgres tiraría `42703`). Eso lo cazan T-RS-03 y T-RS-04,
 * no el espía. El espía igual está, como BACKSTOP que UBICA el sitio roto, en un
 * solo test (T-RS-05).
 *
 * ⚠️ LA TRAMPA QUE ESTE FAKE EVITA (y que haría el test vacuo): el fake NO filtra
 * por owner por su cuenta. Aplica ÚNICAMENTE los `.eq(col, val)` que el servicio
 * le pide, sobre una tabla en memoria de DOS owners. Si hardcodeara "devolvé sólo
 * las filas del owner", el test pasaría IGUAL sin el filtro en el servicio y
 * volveríamos al punto de partida — que es exactamente el modo de falla del mock
 * de `identity.test.ts:29` (`eq: vi.fn().mockReturnThis()`, ignora los argumentos).
 * Además el fake FALLA RUIDOSO ante una columna que no existe (`42703`, como
 * Postgres), en vez de degradar a "no matcheó nada"; T-RS-04 lo auto-verifica.
 *
 * Naming: T-RS-01..T-RS-05.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn() },
}));

import { supabase } from '../lib/supabase.js';
import { identityService } from './identity.js';
import { OwnershipMismatchError } from './security/errors.js';

// ── Los dos tenants del escenario ────────────────────────────
const OWNER_A = 'owner-A-0xaaaa';
const OWNER_B = 'owner-B-0xbbbb';
const KEY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Sub-shape de `a2a_agent_keys` que toca esta función. */
interface Row {
  id: string;
  owner_ref: string;
  require_signature: boolean;
  funding_wallet: string | null;
  is_active: boolean;
}

/**
 * Las columnas que EXISTEN en la tabla. Un `.eq()` sobre cualquier otra es un
 * error de Postgres (`42703`), no un filtro que no matchea (ver T-RS-04).
 */
const COLUMNS: readonly string[] = [
  'id',
  'owner_ref',
  'require_signature',
  'funding_wallet',
  'is_active',
];

function makeRow(id: string, ownerRef: string, over: Partial<Row> = {}): Row {
  return {
    id,
    owner_ref: ownerRef,
    require_signature: false,
    funding_wallet: '0xfeed000000000000000000000000000000000000',
    is_active: true,
    ...over,
  };
}

// ── Fake PostgREST: tabla en memoria + los filtros QUE LE PIDEN ───────────

type Filter = readonly [column: string, value: unknown];
type Kind = 'select' | 'update';

interface FakeError {
  message: string;
  code: string;
}
interface FakeResult<T> {
  data: T | null;
  error: FakeError | null;
}

/** Query registrada, para el backstop estructural de T-RS-05. */
interface Recorded {
  kind: Kind;
  filters: Filter[];
  patch: Record<string, unknown> | null;
}

interface Builder {
  select(columns?: string): Builder;
  update(patch: Record<string, unknown>): Builder;
  eq(column: string, value: unknown): Builder;
  /** Thenable por diseño: es lo que hace que `await …select('id')` resuelva. */
  then<R>(onFulfilled: (value: FakeResult<{ id: string }[]>) => R): Promise<R>;
}

/** Estado del fake, reseteado en cada test. */
let db: Row[] = [];
let recorded: Recorded[] = [];

function rowField(row: Row, column: string): unknown {
  return (row as unknown as Record<string, unknown>)[column];
}

/** Aplica EXACTAMENTE los filtros pedidos. Ni uno más. */
function applyFilters(rows: Row[], filters: Filter[]): Row[] {
  return rows.filter((row) =>
    filters.every(([column, value]) => rowField(row, column) === value),
  );
}

/** Primer filtro sobre una columna inexistente, si hay alguno. */
function unknownColumn(filters: Filter[]): string | undefined {
  return filters.map(([column]) => column).find((c) => !COLUMNS.includes(c));
}

function makeBuilder(): Builder {
  const filters: Filter[] = [];
  let kind: Kind = 'select';
  let patch: Record<string, unknown> | null = null;

  const builder: Builder = {
    select: () => builder,
    update: (nextPatch) => {
      kind = 'update';
      patch = nextPatch;
      return builder;
    },
    eq: (column, value) => {
      filters.push([column, value]);
      return builder;
    },

    // biome-ignore lint/suspicious/noThenProperty: es lo que hace que `await query` funcione (`.select('id')` sin `.single()`)
    then: <R>(
      onFulfilled: (value: FakeResult<{ id: string }[]>) => R,
    ): Promise<R> => {
      recorded.push({ kind, filters: [...filters], patch });

      // Igual que Postgres: una columna que no existe es un ERROR, no un
      // predicado vacío. Sin esto, `.eq('ownerRef', …)` se vería como
      // "no matcheó" y sería indistinguible de un cross-tenant legítimo.
      const bad = unknownColumn(filters);
      if (bad !== undefined) {
        return Promise.resolve(
          onFulfilled({
            data: null,
            error: {
              message: `column a2a_agent_keys.${bad} does not exist`,
              code: '42703',
            },
          }),
        );
      }

      const matched = applyFilters(db, filters);
      if (kind === 'update' && patch) {
        for (const row of matched) {
          Object.assign(row, patch);
        }
      }
      return Promise.resolve(
        onFulfilled({ data: matched.map((r) => ({ id: r.id })), error: null }),
      );
    },
  };

  return builder;
}

const mockFrom = vi.mocked(supabase.from);

describe('identityService.setRequireSignature — Ownership Guard (WKH-123, AC-10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db = [];
    recorded = [];
    mockFrom.mockImplementation(
      () => makeBuilder() as unknown as ReturnType<typeof mockFrom>,
    );
  });

  // ══════════════════════════════════════════════════════════
  // (1) CROSS-TENANT — las DOS direcciones del daño
  // ══════════════════════════════════════════════════════════

  it('T-RS-01 [identity.ts:144]: A no puede PRENDER require_signature en la key de B (DoS de ese tenant)', async () => {
    const rowB = makeRow(KEY_B, OWNER_B, { require_signature: false });
    db.push(rowB);

    await expect(
      identityService.setRequireSignature(KEY_B, OWNER_A, true),
    ).rejects.toThrow(OwnershipMismatchError);

    // El id EXISTE en la tabla; lo único que protege la fila es el filtro por
    // dueño. Y la aserción que importa: la key de B quedó INTACTA (si se
    // escribiera, todos los callers de B empezarían a comer SIGNATURE_REQUIRED).
    expect(db.some((r) => r.id === KEY_B)).toBe(true);
    expect(rowB.require_signature).toBe(false);
  });

  it('T-RS-02 [identity.ts:144]: A no puede APAGAR require_signature en la key de B (bajarle un control que B eligió)', async () => {
    const rowB = makeRow(KEY_B, OWNER_B, { require_signature: true });
    db.push(rowB);

    await expect(
      identityService.setRequireSignature(KEY_B, OWNER_A, false),
    ).rejects.toThrow(OwnershipMismatchError);

    // La dirección que un test de "no puede escribir" suele olvidar: acá el
    // daño es que el flag QUEDE en false, o sea desactivarle la firma a B.
    expect(rowB.require_signature).toBe(true);
  });

  // ══════════════════════════════════════════════════════════
  // (2) LA OTRA DIRECCIÓN: el dueño SÍ puede con lo suyo
  // ══════════════════════════════════════════════════════════

  it('T-RS-03 [identity.ts:143-144]: A prende el flag en SU PROPIA key y se escribe (columna correcta), sin tocar la de B', async () => {
    // Este es el test que un espía (`toHaveBeenCalledWith`) NO reemplaza: con la
    // columna mal escrita (`.eq('ownerRef', …)`) el espía pasaría y esto falla,
    // porque el dueño se quedaría sin poder tocar su propia key.
    const rowA = makeRow(KEY_A, OWNER_A, { require_signature: false });
    const rowB = makeRow(KEY_B, OWNER_B, { require_signature: false });
    db.push(rowA, rowB);

    await expect(
      identityService.setRequireSignature(KEY_A, OWNER_A, true),
    ).resolves.toBeUndefined();

    expect(rowA.require_signature).toBe(true);
    // El UPDATE está acotado a UNA fila: la del par (id, owner_ref).
    expect(rowB.require_signature).toBe(false);
  });

  // ══════════════════════════════════════════════════════════
  // (3) AUTO-TEST DEL FAKE + BACKSTOP ESTRUCTURAL
  // ══════════════════════════════════════════════════════════

  it('T-RS-04 (auto-test del fake): un filtro sobre una columna inexistente es 42703, no "no matcheó"', async () => {
    // Guarda del guard: si el fake degradara una columna mal escrita a "0 filas",
    // T-RS-03 seguiría rojo pero por el motivo equivocado, y peor, un fake futuro
    // más permisivo dejaría pasar el typo. Esto fija el comportamiento tipo
    // Postgres que hace DISCRIMINANTE al fake.
    db.push(makeRow(KEY_A, OWNER_A));
    const builder = supabase.from('a2a_agent_keys') as unknown as Builder;

    const { data, error } = await builder
      .select('id')
      .eq('id', KEY_A)
      .eq('ownerRef', OWNER_A); // typo deliberado

    expect(data).toBeNull();
    expect(error?.code).toBe('42703');
  });

  it('T-RS-05 (backstop estructural): el UPDATE lleva id + owner_ref, y nombra el sitio si falta', async () => {
    // Complemento de los tests de propiedad: si alguien borra UN filtro, este
    // test dice CUÁL sitio quedó abierto (`identity.ts:143` vs `:144`). No
    // reemplaza a T-RS-01..03 (una llamada existente no prueba qué se escribió).
    db.push(makeRow(KEY_A, OWNER_A));

    await identityService.setRequireSignature(KEY_A, OWNER_A, true);

    const update = recorded.find((q) => q.kind === 'update');
    expect(update?.filters).toEqual([
      ['id', KEY_A], // identity.ts:143
      ['owner_ref', OWNER_A], // identity.ts:144  ← el que no tenía candado
    ]);
    // Y el patch NO toca nada más que el flag (nunca budget / funding_wallet).
    expect(update?.patch).toEqual({ require_signature: true });
  });
});
