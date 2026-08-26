/**
 * Registry Service — Ownership Guard Tests (WKH-63 / SEC-REG-1).
 *
 * Verifies the app-layer ownership guard on `register`, `update`, `delete`.
 * If a future change removes the pre-fetch or the `.eq('owner_ref', ...)`
 * defense-in-depth, these tests must fail.
 *
 * Mirrors the structure of `services/security/ownership.test.ts` (WKH-53).
 *
 * Naming: T-SVC-01..T-SVC-10.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

// SSRF validator stubbed: every URL valid in this suite (the suite tests
// ownership, not URL validation; URL flow is covered by registries.ssrf.test.ts).
vi.mock('../lib/url-validator.js', async (orig) => {
  const actual = await orig<typeof import('../lib/url-validator.js')>();
  return {
    ...actual,
    validateRegistryUrl: vi.fn().mockResolvedValue(undefined),
  };
});

import { supabase } from '../lib/supabase.js';
import {
  registryService,
  SYSTEM_OWNER_REF,
  SystemRegistryImmutableError,
} from './registry.js';
import { OwnershipMismatchError } from './security/errors.js';

const mockFrom = vi.mocked(supabase.from);

// ── Fixtures ────────────────────────────────────────────────

const OWNER_A = 'owner-A-uuid';
const OWNER_B = 'owner-B-uuid';

interface SupabaseRowOwnerOverride {
  id?: string;
  owner_ref?: string;
}

function rowOf(o: SupabaseRowOwnerOverride = {}) {
  return {
    id: o.id ?? 'reg-1',
    name: 'reg-1',
    discovery_endpoint: 'https://example.com/discover',
    invoke_endpoint: 'https://example.com/invoke',
    agent_endpoint: null,
    schema: { discovery: {}, invoke: { method: 'POST' as const } },
    auth: null,
    enabled: true,
    created_at: '2026-04-27T00:00:00Z',
    owner_ref: o.owner_ref ?? OWNER_A,
  };
}

/**
 * chainMock — fidelity to Supabase QueryBuilder.
 *
 * Accepts override hooks for the terminal calls used by registry.ts:
 *   - `single` for SELECTs that resolve a single row,
 *   - `maybeSingle` for nullable SELECTs (used by `get`),
 *   - `selectFinal` for INSERT/UPDATE/DELETE chains that end in `.select()`
 *     after a non-`single` (returns an array).
 */
function chainMock(
  overrides: {
    maybeSingle?: () => unknown;
    single?: () => unknown;
    selectFinal?: () => unknown;
  } = {},
) {
  const chain: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    maybeSingle:
      overrides.maybeSingle ??
      vi.fn().mockResolvedValue({ data: null, error: null }),
    single:
      overrides.single ??
      vi.fn().mockResolvedValue({ data: null, error: null }),
  };

  // For DELETE/UPDATE that end with `.select()` (no `.single`), the LAST
  // .select() call must resolve to a Promise. We model that by overriding
  // `select` to return a thenable on its 2nd invocation.
  if (overrides.selectFinal) {
    let calls = 0;
    chain.select = vi.fn(() => {
      calls += 1;
      if (calls === 1) return chain;
      // 2nd select() is the terminal one — return an awaitable.
      return overrides.selectFinal!();
    });
  }

  for (const key of ['insert', 'update', 'delete', 'eq', 'order']) {
    (chain[key] as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  }
  return chain;
}

// ── Suite: register ─────────────────────────────────────────

describe('registryService.register — owner_ref persisted (WKH-63)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('T-SVC-01: persists owner_ref from caller', async () => {
    const insertedRow = rowOf({ id: 'new-reg', owner_ref: OWNER_A });
    const mock = chainMock({
      single: vi.fn().mockResolvedValue({ data: insertedRow, error: null }),
    });
    mockFrom.mockReturnValue(
      mock as unknown as ReturnType<typeof supabase.from>,
    );

    const result = await registryService.register(
      {
        name: 'new-reg',
        discoveryEndpoint: 'https://example.com/discover',
        invokeEndpoint: 'https://example.com/invoke',
        schema: { discovery: {}, invoke: { method: 'POST' } },
        enabled: true,
      },
      OWNER_A,
    );

    // MNR-5: el `ownerRef` YA NO viaja en la respuesta pública (`GET
    // /registries` es sin auth → nada de identificadores de tenant). Lo que este
    // test tiene que fijar es que el owner del CALLER se persiste, y eso se
    // verifica sobre la columna del INSERT (abajo), no sobre el body.
    expect(result).not.toHaveProperty('ownerRef');

    // Verify INSERT carried owner_ref column.
    const insertSpy = mock.insert as ReturnType<typeof vi.fn>;
    const insertedArg = insertSpy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertedArg.owner_ref).toBe(OWNER_A);
  });

  // ── FIX v3 (DT-23.4 / BLQ-MED-1): name → PK injective ──────
  describe('SEC-COLLISION-REG: anti-collision rule', () => {
    function registerName(name: string) {
      return registryService.register(
        {
          name,
          discoveryEndpoint: 'https://example.com/discover',
          invokeEndpoint: 'https://example.com/invoke',
          schema: { discovery: {}, invoke: { method: 'POST' } },
          enabled: true,
        },
        OWNER_A,
      );
    }

    it('rejects leading/trailing whitespace (the v2 collision vector "WasiAI ")', async () => {
      const mock = chainMock();
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );
      await expect(registerName('WasiAI ')).rejects.toThrow(
        /leading\/trailing whitespace/,
      );
      // Never reaches the insert.
      expect((mock.insert as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
        0,
      );
    });

    it('rejects collapsible internal whitespace ("WasiAI  X")', async () => {
      const mock = chainMock();
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );
      await expect(registerName('WasiAI  X')).rejects.toThrow(
        /collapsible internal whitespace/,
      );
      expect((mock.insert as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
        0,
      );
    });

    // ── WKH-366 fix-pack (AR/BLQ-ALTO-1): el namespace RESERVADO ────────────
    //
    // 🔴 QUÉ SOSTIENE ESTO. `self-published` es el `registry_id` sintético que el
    // gateway le pone a los agentes de `POST /agents`; su docblock decía que "NO
    // existe como fila en `registries`", y no existir NO es estar reservado.
    // Hasta este fix, cualquier caller autenticado podía crear la fila real.
    //
    // 🧬 MUTANTE: borrar el `if (isReservedRegistryName(...))` de `register` ⇒ las
    // cuatro filas de abajo se ponen rojas (la promesa resuelve en vez de tirar).
    // 🧬 MUTANTE: comparar contra el `name` CRUDO en vez del normalizado ⇒ se
    // ponen rojas las tres últimas, que son las que producen el mismo PK por otro
    // camino. Ésa es la mutación que importa: un check case-sensitive sobre el
    // nombre es indistinguible del bueno mirando sólo la primera fila.
    it.each([
      ['exacto', 'self-published'],
      ['en mayúsculas', 'SELF-PUBLISHED'],
      ['con espacios en vez del guion', 'Self Published'],
    ])('rejects the reserved namespace — %s', async (_caso, name) => {
      const mock = chainMock();
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );
      await expect(registerName(name)).rejects.toThrow(/is reserved/);
      // Nunca llega al insert: el rechazo es puro sobre el body.
      expect((mock.insert as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
        0,
      );
    });

    // ⚠️ PRECEDENCIA, MEDIDA Y NO ASUMIDA: `' self-published '` NO sale por acá.
    // El guard de whitespace de borde (DT-23.4) corre ANTES en `register` y se lo
    // lleva primero. Se deja escrito en vez de reordenar los guards: el desenlace
    // es el mismo (rechazo, 400, sin insert) y mover un guard preexistente para
    // que el mensaje quede lindo es un cambio de comportamiento gratis en la
    // puerta de escritura del catálogo.
    //
    // 🔴 Y POR LA RUTA —que es por donde entra un caller real— ESE MISMO INPUT SÍ
    // sale como "reserved", porque `validateRegisterBody` corre PRE-COBRO y su
    // check normaliza con `.trim()` (`isReservedRegistryName`). Ese camino tiene
    // su propio testigo: **T-NCR-19**, cuarta fila del `it.each` (el caso
    // `'con whitespace de borde'`), en
    // `src/routes/registries.no-charge-before-validating.test.ts`.
    //
    // ⚠️ ACÁ HABÍA UN PUNTERO A UN ARCHIVO QUE NO EXISTE (WKH-366, MNR-3 del AR
    // ronda 2): decía `routes/registries.reserved-namespace.test.ts`. El
    // CONTENIDO de la afirmación era cierto; el archivo, no. Por eso el puntero
    // ahora se ancla en el NOMBRE del testigo y no en una línea: `T-NCR-19` se
    // falsea con un `grep -rn 'T-NCR-19' src/` y leer si sale de un `it(`, y un
    // nombre no se desplaza cuando alguien inserta una línea más arriba.
    //
    // Y NO SE DA DE ALTA EN `CITED_LINES`, medido y no supuesto: `scanSource`
    // sobre ESTE archivo devuelve sólo los falsos positivos de un timestamp ISO
    // —cero citas reales—, porque una referencia sin número de línea le es
    // invisible por construcción (caso (a) de su docblock, «la prosa suelta»).
    // Declararla exigiría (1) ponerle un número de línea —o sea cambiar un ancla
    // que no envejece por una que sí— y (2) meter
    // este archivo en `CORTE_A_PATHS`, que tiene assert duro
    // `expect(CORTE_A_PATHS.length).toBe(14)` en `G-C1`. Ampliar el universo del
    // Corte A es un Corte, no un renglón de un fix-pack de MENORes.
    it('the border-whitespace variant is rejected FIRST by the whitespace guard', async () => {
      const mock = chainMock();
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );
      await expect(registerName(' self-published ')).rejects.toThrow(
        /leading\/trailing whitespace/,
      );
      expect((mock.insert as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
        0,
      );
    });

    // ✅ CALIBRACIÓN. Sin esto, las tres filas de arriba serían verdes con un
    // `register` que rechaza TODO nombre, y no se notaría.
    it('a name that merely CONTAINS the reserved one is NOT rejected', async () => {
      const mock = chainMock({
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        single: vi.fn().mockResolvedValue({
          data: rowOf({ id: 'self-published-mirror', owner_ref: OWNER_A }),
          error: null,
        }),
      });
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );
      // 🔴 La reserva es sobre el ID DERIVADO, no sobre una subcadena: reservar
      // por `includes` sacaría de circulación un espacio de nombres entero que
      // nadie decidió reservar.
      await expect(registerName('self-published-mirror')).resolves.toBeTruthy();
    });

    it('rejects a name whose PK already exists (pre-check get(id))', async () => {
      // get(id) → maybeSingle resolves an existing row → clash.
      const mock = chainMock({
        maybeSingle: vi.fn().mockResolvedValue({
          data: rowOf({ id: 'wasiai', owner_ref: OWNER_B }),
          error: null,
        }),
      });
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );
      await expect(registerName('WasiAI')).rejects.toThrow(
        /Registry 'wasiai' already exists/,
      );
      expect((mock.insert as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
        0,
      );
    });
  });

  // ── Audit 2026-06-24 (P2-10): insert-failure → typed error ───
  describe('register insert failure (P2-10)', () => {
    it('PK violation (23505) on insert → "already exists" (race defense)', async () => {
      // get(id) → no clash (null), but the insert hits a concurrent 23505.
      const mock = chainMock({
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        single: vi.fn().mockResolvedValue({
          data: null,
          error: { code: '23505', message: 'duplicate key value' },
        }),
      });
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );

      await expect(
        registryService.register(
          {
            name: 'racy-reg',
            discoveryEndpoint: 'https://example.com/discover',
            invokeEndpoint: 'https://example.com/invoke',
            schema: { discovery: {}, invoke: { method: 'POST' } },
            enabled: true,
          },
          OWNER_A,
        ),
      ).rejects.toThrow(/Registry 'racy-reg' already exists/);
    });

    it('generic DB error on insert → "Failed to register: <msg>"', async () => {
      const mock = chainMock({
        maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        single: vi.fn().mockResolvedValue({
          data: null,
          error: { code: '08006', message: 'connection failure' },
        }),
      });
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );

      await expect(
        registryService.register(
          {
            name: 'broken-reg',
            discoveryEndpoint: 'https://example.com/discover',
            invokeEndpoint: 'https://example.com/invoke',
            schema: { discovery: {}, invoke: { method: 'POST' } },
            enabled: true,
          },
          OWNER_A,
        ),
      ).rejects.toThrow(/Failed to register: connection failure/);
    });
  });
});

// ── Suite: update ───────────────────────────────────────────

describe('registryService.update — ownership guard (WKH-63)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('T-SVC-02: row absent → OwnershipMismatchError (404 disclosure-safe)', async () => {
    // Pre-fetch (via .get → maybeSingle) returns null.
    const mock = chainMock();
    mockFrom.mockReturnValue(
      mock as unknown as ReturnType<typeof supabase.from>,
    );

    await expect(
      registryService.update('does-not-exist', { name: 'x' }, OWNER_A),
    ).rejects.toBeInstanceOf(OwnershipMismatchError);
  });

  it('T-SVC-03: row.owner_ref === SYSTEM_OWNER_REF → SystemRegistryImmutableError (403)', async () => {
    const mock = chainMock({
      maybeSingle: vi.fn().mockResolvedValue({
        data: rowOf({ id: 'wasiai', owner_ref: SYSTEM_OWNER_REF }),
        error: null,
      }),
    });
    mockFrom.mockReturnValue(
      mock as unknown as ReturnType<typeof supabase.from>,
    );

    await expect(
      registryService.update('wasiai', { name: 'pwn3d' }, OWNER_A),
    ).rejects.toBeInstanceOf(SystemRegistryImmutableError);
  });

  it('T-SVC-04: cross-tenant row → OwnershipMismatchError (404, NOT 403)', async () => {
    const mock = chainMock({
      maybeSingle: vi.fn().mockResolvedValue({
        data: rowOf({ id: 'reg-of-B', owner_ref: OWNER_B }),
        error: null,
      }),
    });
    mockFrom.mockReturnValue(
      mock as unknown as ReturnType<typeof supabase.from>,
    );

    await expect(
      registryService.update('reg-of-B', { name: 'steal' }, OWNER_A),
    ).rejects.toBeInstanceOf(OwnershipMismatchError);
  });

  it('T-SVC-05: same-owner update succeeds and UPDATE filters by (id, owner_ref)', async () => {
    const updatedRow = rowOf({ id: 'reg-of-A', owner_ref: OWNER_A });
    const mock = chainMock({
      maybeSingle: vi.fn().mockResolvedValue({
        data: updatedRow,
        error: null,
      }),
      single: vi.fn().mockResolvedValue({ data: updatedRow, error: null }),
    });
    mockFrom.mockReturnValue(
      mock as unknown as ReturnType<typeof supabase.from>,
    );

    await registryService.update('reg-of-A', { name: 'renamed' }, OWNER_A);

    // The UPDATE chain must call .eq('owner_ref', OWNER_A) — TOCTOU defense.
    const eqSpy = mock.eq as ReturnType<typeof vi.fn>;
    const eqCalls = eqSpy.mock.calls.map((c) => `${c[0]}=${c[1]}`);
    expect(eqCalls).toContain(`owner_ref=${OWNER_A}`);
    expect(eqCalls).toContain(`id=reg-of-A`);
  });

  it('T-SVC-06: TOCTOU race (PGRST116 from UPDATE) → OwnershipMismatchError', async () => {
    const mock = chainMock({
      maybeSingle: vi.fn().mockResolvedValue({
        data: rowOf({ id: 'reg-of-A', owner_ref: OWNER_A }),
        error: null,
      }),
      // UPDATE post-pre-fetch sees no row (race: alguien cambió owner_ref).
      single: vi.fn().mockResolvedValue({
        data: null,
        error: { code: 'PGRST116', message: 'no rows' },
      }),
    });
    mockFrom.mockReturnValue(
      mock as unknown as ReturnType<typeof supabase.from>,
    );

    await expect(
      registryService.update('reg-of-A', { name: 'race' }, OWNER_A),
    ).rejects.toBeInstanceOf(OwnershipMismatchError);
  });
});

// ── Suite: delete ───────────────────────────────────────────

describe('registryService.delete — ownership guard (WKH-63)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('T-SVC-07: row absent → OwnershipMismatchError', async () => {
    const mock = chainMock();
    mockFrom.mockReturnValue(
      mock as unknown as ReturnType<typeof supabase.from>,
    );

    await expect(
      registryService.delete('does-not-exist', OWNER_A),
    ).rejects.toBeInstanceOf(OwnershipMismatchError);
  });

  it('T-SVC-08: row.owner_ref === SYSTEM_OWNER_REF → SystemRegistryImmutableError', async () => {
    const mock = chainMock({
      maybeSingle: vi.fn().mockResolvedValue({
        data: rowOf({ id: 'wasiai', owner_ref: SYSTEM_OWNER_REF }),
        error: null,
      }),
    });
    mockFrom.mockReturnValue(
      mock as unknown as ReturnType<typeof supabase.from>,
    );

    await expect(
      registryService.delete('wasiai', OWNER_A),
    ).rejects.toBeInstanceOf(SystemRegistryImmutableError);
  });

  it('T-SVC-09: cross-tenant row → OwnershipMismatchError', async () => {
    const mock = chainMock({
      maybeSingle: vi.fn().mockResolvedValue({
        data: rowOf({ id: 'reg-of-B', owner_ref: OWNER_B }),
        error: null,
      }),
    });
    mockFrom.mockReturnValue(
      mock as unknown as ReturnType<typeof supabase.from>,
    );

    await expect(
      registryService.delete('reg-of-B', OWNER_A),
    ).rejects.toBeInstanceOf(OwnershipMismatchError);
  });

  it('T-SVC-10: same-owner delete succeeds and DELETE filters by (id, owner_ref)', async () => {
    const mock = chainMock({
      maybeSingle: vi.fn().mockResolvedValue({
        data: rowOf({ id: 'reg-of-A', owner_ref: OWNER_A }),
        error: null,
      }),
      selectFinal: () =>
        Promise.resolve({ data: [{ id: 'reg-of-A' }], error: null }),
    });
    mockFrom.mockReturnValue(
      mock as unknown as ReturnType<typeof supabase.from>,
    );

    const ok = await registryService.delete('reg-of-A', OWNER_A);
    expect(ok).toBe(true);

    const eqSpy = mock.eq as ReturnType<typeof vi.fn>;
    const eqCalls = eqSpy.mock.calls.map((c) => `${c[0]}=${c[1]}`);
    expect(eqCalls).toContain(`owner_ref=${OWNER_A}`);
    expect(eqCalls).toContain(`id=reg-of-A`);
  });
});
