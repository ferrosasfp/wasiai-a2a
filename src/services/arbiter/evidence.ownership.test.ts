/**
 * `readEvidence` — las TRES consultas por dueño del lector de evidencia de una
 * disputa (WKH-SEC-04, sitios 8/9/10 de los 12).
 *
 * ── EL HUECO QUE CIERRA ESTE ARCHIVO ──────────────────────────────────────
 *
 * `src/services/arbiter/evidence.ts` tiene `.eq('owner_ref', ownerRef)` en `:57`
 * (intent), `:76` (vouchers) y `:96` (recibos). Los tres SOBREVIVÍAN a la suite.
 * Medido en `b7fa4e7`, quitando cualquiera de los tres: el único rojo es el del
 * guardián estructural (`test/ownership-filter-guard.test.ts`, G-08 y G-09).
 * Ningún test de comportamiento se enteraba.
 *
 * ── POR QUÉ HAY UN ARCHIVO NUEVO SI YA EXISTE `evidence.test.ts` ──────────
 *
 * Porque `evidence.test.ts` no mide esto, aunque su prosa diga que sí. Su doble
 * de supabase es `eq: () => b` (`evidence.test.ts:49`): REGISTRA el filtro y no
 * lo APLICA — la respuesta la decide el nombre de la tabla. Y su fixture tiene
 * un solo dueño (`OWNER`, `:36`), así que su caso titulado «de otro owner»
 * (`:186`) devuelve un `PGRST116` enlatado que sale igual con el filtro puesto o
 * borrado. No se toca (rompe contratos de los que dependen sus otros tests): lo
 * que hace este archivo es cubrir la propiedad que aquél no cubre.
 *
 * ── QUÉ PROPIEDAD SE PRUEBA, Y CUÁL NO ────────────────────────────────────
 *
 * La propiedad de la función: dado un par `(intentId, ownerRef)` que no se
 * corresponde, `readEvidence` no entrega los datos del intent ajeno ni suma sus
 * vouchers y recibos al veredicto.
 *
 * Lo que NO se prueba, porque no es cierto: que esto detenga un IDOR vivo. El
 * camino de producción es `POST /session/:id/dispute` (`src/routes/payments.ts:339`),
 * que llama `openDispute(req.params.id, callerKey.owner_ref)`, y `openDispute`
 * compara los dos dueños en JavaScript (`src/services/arbiter.ts:606-608`) antes
 * de llegar hasta acá: un `intentId` ajeno se rechaza con `OWNERSHIP_MISMATCH`
 * primero. Decir que estos filtros «impiden» un IDOR sería afirmar de más.
 *
 * Naming: EV-01, EV-02, EV-BS.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/supabase.js', () => ({
  supabase: { from: vi.fn() },
}));

// `readEvidence` llama `receiptService.verify` una vez por recibo (`:112`) sólo
// para decidir `proofChainOk`. Se dobla porque no es el sujeto de este archivo:
// lo que se mide son las filas que las tres consultas devuelven, no la
// integridad de la proof-chain.
vi.mock('../receipt.js', () => ({
  receiptService: {
    verify: vi.fn(async (id: string) => ({ valid: true, receipt_id: id })),
  },
}));

import { supabase } from '../../lib/supabase.js';
import { ArbiterError } from '../../types/arbiter.js';
import { createOwnerScopedFake } from '../__tests__/owner-scoped-fake.js';
import { readEvidence } from './evidence.js';

const OWNER_A = 'owner-A-0xaaaa';
const OWNER_B = 'owner-B-0xbbbb';
const INTENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INTENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Lo que `evidence.ts:55` selecciona, más las dos columnas que filtra. */
const INTENT_COLUMNS = [
  'id',
  'owner_ref',
  'authorized_usd',
  'consumed_usd',
  'chain_id',
  'pay_to',
  'seller_ref',
];

/** Lo que `evidence.ts:74-76` selecciona y filtra. */
const VOUCHER_COLUMNS = ['intent_id', 'owner_ref', 'amount_usd'];

/** Lo que `evidence.ts:94-96` selecciona y filtra. */
const RECEIPT_COLUMNS = [
  'id',
  'owner_ref',
  'session_id',
  'receipt_type',
  'amount_usd',
];

function intentRow(
  id: string,
  ownerRef: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    owner_ref: ownerRef,
    authorized_usd: '10.000000',
    consumed_usd: '4.000000',
    chain_id: 84532,
    pay_to: '0xpayto-de-A',
    seller_ref: 'seller-de-A',
    ...over,
  };
}

const mockFrom = vi.mocked(supabase.from);

describe('readEvidence — las 3 consultas por dueño (WKH-SEC-04)', () => {
  let fake: ReturnType<typeof createOwnerScopedFake>;

  beforeEach(() => {
    vi.clearAllMocks();
    fake = createOwnerScopedFake({
      a2a_payment_intents: {
        columns: INTENT_COLUMNS,
        rows: [
          intentRow(INTENT_A, OWNER_A),
          intentRow(INTENT_B, OWNER_B, {
            authorized_usd: '999.000000',
            consumed_usd: '777.000000',
            chain_id: 8453,
            pay_to: '0xpayto-secreto-de-B',
            seller_ref: 'seller-secreto-de-B',
          }),
        ],
      },
      a2a_payment_vouchers: {
        columns: VOUCHER_COLUMNS,
        rows: [
          { intent_id: INTENT_A, owner_ref: OWNER_A, amount_usd: '1.500000' },
          { intent_id: INTENT_B, owner_ref: OWNER_B, amount_usd: '500.000000' },
        ],
      },
      a2a_receipts: {
        columns: RECEIPT_COLUMNS,
        rows: [
          {
            id: 'rec-A',
            owner_ref: OWNER_A,
            session_id: INTENT_A,
            receipt_type: 'budget_debit',
            amount_usd: '2.000000',
          },
          {
            id: 'rec-B',
            owner_ref: OWNER_B,
            session_id: INTENT_B,
            receipt_type: 'budget_debit',
            amount_usd: '600.000000',
          },
        ],
      },
    });
    mockFrom.mockImplementation(
      (table: string) => fake.from(table) as ReturnType<typeof mockFrom>,
    );
  });

  it('EV-01 [evidence.ts:57]: A lee la evidencia del intent de B → INTENT_NOT_FOUND, y el intent de B SIGUE en la tabla', async () => {
    // Sin afirmar que la fila existe, el rechazo podría venir de una tabla vacía
    // y el test pasaría sin ejercitar el filtro (CD-25).
    expect(
      fake.rows('a2a_payment_intents').some((r) => r.id === INTENT_B),
    ).toBe(true);

    // Lo que sale sin el filtro no es un error: son `authorized_usd`,
    // `consumed_usd`, `chain_id`, `pay_to` y `seller_ref` del intent de B
    // (`evidence.ts:124-128`), o sea el estado financiero de una disputa ajena.
    await expect(readEvidence(INTENT_B, OWNER_A)).rejects.toMatchObject({
      name: 'ArbiterError',
      code: 'INTENT_NOT_FOUND',
    });
    await expect(readEvidence(INTENT_B, OWNER_A)).rejects.toBeInstanceOf(
      ArbiterError,
    );
  });

  it('EV-02 (anti-vacuidad): A lee la SUYA y la obtiene entera, sin nada de B', async () => {
    // La otra dirección (CD-6). Sin esto, un filtro con la columna mal escrita
    // —`.eq('ownerRef', …)`— pasaría EV-01 perfectamente y dejaría al dueño sin
    // poder abrir SU propia disputa. Con el falso, además, una columna
    // inexistente devuelve 42703 en vez de degradar a «no encontré nada».
    const ev = await readEvidence(INTENT_A, OWNER_A);

    expect(ev.intentId).toBe(INTENT_A);
    expect(ev.authorizedUsd).toBe(10);
    expect(ev.consumedUsd).toBe(4);
    expect(ev.chainId).toBe(84532);
    expect(ev.payTo).toBe('0xpayto-de-A');
    expect(ev.sellerRef).toBe('seller-de-A');
    // Y ni el voucher ni el recibo de B se colaron en los totales.
    expect(ev.voucherCount).toBe(1);
    expect(ev.vouchersTotalUsd).toBe(1.5);
    expect(ev.receiptSettleTotalUsd).toBe(2);
  });

  // ══════════════════════════════════════════════════════════
  // GRUPO B — integridad ante una fila inconsistente.
  //           ESTO NO ES AISLAMIENTO ENTRE INQUILINOS.
  // ══════════════════════════════════════════════════════════
  //
  // DECLARACIÓN OBLIGATORIA (AC-3). Los dos filtros de abajo no son redundantes
  // con ningún otro, pero el estado que los revela es una fila cuyo `owner_ref`
  // NO coincide con el del recurso al que apunta su clave foránea: un voucher de
  // `owner-B` colgado del intent de `owner-A`, y un recibo de `owner-B` colgado
  // de la sesión de `owner-A`. Ninguna restricción de base lo impide —no hay
  // CHECK ni FK compuesta que ligue los dos `owner_ref`— pero la aplicación no
  // lo produce hoy. O sea: el escenario NO es alcanzable en producción HOY.
  //
  // El test igual vale, y por una razón concreta: `voucherCount`,
  // `vouchersTotalUsd` (`evidence.ts:85-89`) y `receiptSettleTotalUsd`
  // (`:116-119`) son ENTRADAS de `classify` — o sea que una fila ajena que se
  // cuele cambia el VEREDICTO de una disputa, y con él a quién se le paga.
  //
  // Presentar esto como «A no ve los vouchers de B» sería afirmar de más: A
  // nunca pide los vouchers de B acá, porque el `intent_id` es el suyo.

  it('EV-03 [evidence.ts:76]: un voucher de B colgado del intent de A NO entra en el conteo ni en el total', async () => {
    // La fila inconsistente: `intent_id` de A, `owner_ref` de B.
    fake.rows('a2a_payment_vouchers').push({
      intent_id: INTENT_A,
      owner_ref: OWNER_B,
      amount_usd: '77.000000',
    });

    const ev = await readEvidence(INTENT_A, OWNER_A);

    // Sin el filtro: 2 vouchers y 78.5 USD. Los dos son entradas de `classify`.
    expect(ev.voucherCount).toBe(1);
    expect(ev.vouchersTotalUsd).toBe(1.5);
  });

  it('EV-04 [evidence.ts:96]: un recibo de B colgado de la sesión de A NO suma al total settleado', async () => {
    // La fila inconsistente: `session_id` de A, `owner_ref` de B. El
    // `receipt_type` es uno de los tres de `SETTLE_RECEIPT_TYPES`
    // (`evidence.ts:26-30`), o sea que sí sumaría si el filtro no estuviera.
    fake.rows('a2a_receipts').push({
      id: 'rec-B-colgado-de-A',
      owner_ref: OWNER_B,
      session_id: INTENT_A,
      receipt_type: 'budget_debit',
      amount_usd: '88.000000',
    });

    const ev = await readEvidence(INTENT_A, OWNER_A);

    // Sin el filtro: 90. Ese número corrobora `consumed_usd` aguas abajo.
    expect(ev.receiptSettleTotalUsd).toBe(2);
  });

  it('EV-BS (backstop estructural): las 3 consultas llevan el filtro por dueño, y nombra la que falte', async () => {
    // Complemento de los tests de propiedad: si alguien borra UN filtro, este
    // test dice CUÁL de los tres sitios quedó abierto. No los reemplaza —una
    // llamada existente no prueba qué datos salen—, los ubica.
    await readEvidence(INTENT_A, OWNER_A);

    const scoped = fake
      .resolved()
      .map(
        (q) =>
          `${q.table}:${q.filters.some(([c, v]) => c === 'owner_ref' && v === OWNER_A) ? 'scoped' : 'UNSCOPED'}`,
      );
    expect(scoped).toEqual([
      'a2a_payment_intents:scoped', // evidence.ts:57
      'a2a_payment_vouchers:scoped', // evidence.ts:76
      'a2a_receipts:scoped', // evidence.ts:96
    ]);
  });
});
