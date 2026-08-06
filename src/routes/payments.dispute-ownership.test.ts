/**
 * `GET /session/:id/dispute` — aislamiento entre inquilinos a nivel HTTP
 * (WKH-SEC-03).
 *
 * ── EL HUECO QUE CIERRA ESTE ARCHIVO ──────────────────────────────────────
 *
 * `src/routes/payments.ts:384` es `.eq('owner_ref', callerKey.owner_ref)`.
 * Medido en `ef384b7`: borrando esa línea la suite entera quedaba idéntica a la
 * baseline.
 *
 * El id sale de `req.params.id`, o sea que lo elige el caller, y el cuerpo de la
 * respuesta trae `settle_usd` y `at_stake_usd`. Sin el filtro, A pide el id de
 * un intent de B y recibe las cifras de dinero de la disputa ajena. Por eso
 * PD-01 afirma DOS cosas: el 404 y la AUSENCIA de los montos. El status solo no
 * alcanza — un 200 con el cuerpo vacío y un 404 se distinguen, pero un 404 que
 * igual filtrara el cuerpo no lo cazaría nadie.
 *
 * ── POR QUÉ NO SE COPIA EL MOCK DE `agents.ownership.test.ts` ────────────
 *
 * De ese archivo se toma SÓLO el patrón de montaje (Fastify + ruta real +
 * middleware de auth mockeado + `app.inject`). Su mock de supabase NO sirve
 * acá: registra los `.eq()` (`:72`) pero `maybeSingle`/`single` (`:76-77`)
 * devuelven `state.row` sin importar qué columna ni qué valor se filtró, así que
 * un test cross-tenant montado sobre él pasa aunque el filtro no exista. Acá se
 * usa el falso de `../services/__tests__/owner-scoped-fake.js`, que aplica los
 * filtros pedidos sobre una tabla con dos dueños.
 *
 * Naming: PD-01, PD-02.
 */

import Fastify from 'fastify';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn() },
}));

const { callerKey } = vi.hoisted(() => ({
  callerKey: {
    current: null as {
      id: string;
      owner_ref: string;
      is_active: boolean;
    } | null,
  },
}));

vi.mock('./auth/parsers.js', async () => {
  const actual =
    await vi.importActual<typeof import('./auth/parsers.js')>(
      './auth/parsers.js',
    );
  return { ...actual, resolveCallerKey: async () => callerKey.current };
});

import { supabase } from '../lib/supabase.js';
import { createOwnerScopedFake } from '../services/__tests__/owner-scoped-fake.js';
import paymentsRoutes from './payments.js';

const OWNER_A = 'owner-A-0xaaaa';
const OWNER_B = 'owner-B-0xbbbb';
const INTENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INTENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Las columnas que `payments.ts:381-383` selecciona, más la clave y el dueño. */
const ARBITRATION_COLUMNS = [
  'intent_id',
  'owner_ref',
  'decision',
  'method',
  'status',
  'settle_usd',
  'at_stake_usd',
  'ambiguity_reason',
  'created_at',
];

function arbitrationRow(
  intentId: string,
  ownerRef: string,
  settleUsd: string,
  atStakeUsd: string,
): Record<string, unknown> {
  return {
    intent_id: intentId,
    owner_ref: ownerRef,
    decision: 'release',
    method: 'llm',
    status: 'executed',
    settle_usd: settleUsd,
    at_stake_usd: atStakeUsd,
    ambiguity_reason: null,
    created_at: '2026-08-05T00:00:00.000Z',
  };
}

const mockFrom = vi.mocked(supabase.from);
let fake: ReturnType<typeof createOwnerScopedFake>;
let arbiterBackup: string | undefined;

describe('GET /session/:id/dispute — aislamiento entre tenants (WKH-SEC-03)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    app = Fastify();
    await app.register(paymentsRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    arbiterBackup = process.env.ARBITER_ENABLED;
    // Sin esto la ruta contesta 404 antes de consultar nada (payments.ts:370-372)
    // y los dos tests pasarían sin tocar la base.
    process.env.ARBITER_ENABLED = 'true';
    callerKey.current = { id: 'key-A', owner_ref: OWNER_A, is_active: true };
    fake = createOwnerScopedFake({
      a2a_arbitrations: {
        columns: ARBITRATION_COLUMNS,
        rows: [
          arbitrationRow(INTENT_A, OWNER_A, '1.000000', '2.000000'),
          arbitrationRow(INTENT_B, OWNER_B, '999.000000', '1234.000000'),
        ],
      },
    });
    mockFrom.mockImplementation(
      (table: string) => fake.from(table) as ReturnType<typeof mockFrom>,
    );
  });

  afterEach(() => {
    if (arbiterBackup === undefined) {
      delete process.env.ARBITER_ENABLED;
    } else {
      process.env.ARBITER_ENABLED = arbiterBackup;
    }
  });

  it('PD-01 [payments.ts:384]: A pide la disputa de B → 404 y el cuerpo NO trae los montos', async () => {
    // El intent de B existe: lo único que lo esconde es el filtro por dueño.
    expect(
      fake.rows('a2a_arbitrations').some((r) => r.intent_id === INTENT_B),
    ).toBe(true);

    const res = await app.inject({
      method: 'GET',
      url: `/session/${INTENT_B}/dispute`,
    });

    expect(res.statusCode).toBe(404);
    // Las dos cifras de dinero, por nombre de campo de la respuesta y por valor.
    expect(res.body).not.toContain('settleUsd');
    expect(res.body).not.toContain('atStakeUsd');
    expect(res.body).not.toContain('999');
    expect(res.body).not.toContain('1234');
  });

  it('PD-02 (anti-vacuidad): A pide la SUYA y recibe 200 con el cuerpo', async () => {
    // Sin esta dirección, una ruta que contestara 404 siempre pasaría PD-01.
    const res = await app.inject({
      method: 'GET',
      url: `/session/${INTENT_A}/dispute`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.decision).toBe('release');
    expect(body.settleUsd).toBe('1.000000');
    expect(body.atStakeUsd).toBe('2.000000');
  });
});
