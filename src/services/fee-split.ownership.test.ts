/**
 * `fee-split.ts` — los cuatro filtros por dueño del reparto del protocol fee
 * (WKH-SEC-04, sitios 1..4 de los 12).
 *
 * ── EL HUECO QUE CIERRA ESTE ARCHIVO ──────────────────────────────────────
 *
 * `src/services/fee-split.ts` lleva `.eq('owner_ref', ownerRef)` en `:365`
 * (SELECT de idempotencia), `:538` (UPDATE `charged`), `:618` (`markLegFailed`)
 * y `:697` (`reverseFeeSplits`). Los cuatro SOBREVIVÍAN a la suite. Medido en
 * `b7fa4e7`: quitando cualquiera de los cuatro, el único rojo es el del guardián
 * estructural (`test/ownership-filter-guard.test.ts`, G-08 y G-09). Ningún test
 * de comportamiento se enteraba.
 *
 * ── POR QUÉ NO SIRVE `fee-split.test.ts` PARA ESTO ────────────────────────
 *
 * Su doble es `chain.eq = () => chain` (`fee-split.test.ts:68` y `:83`): tira
 * columna y valor. La respuesta la decide una cola, `mockState.selectQ.shift()`,
 * o sea que sale la misma con el filtro puesto o borrado. No se lo toca (sus
 * otros tests dependen de esas colas): este archivo usa el falso de
 * `__tests__/owner-scoped-fake.ts`, que aplica EXACTAMENTE los filtros pedidos.
 *
 * ── DE DÓNDE SALE EL `ownerRef` ACÁ: DE ADENTRO, NO DEL CALLER ────────────
 *
 * `settleFeeSplits` recibe los `recipients` que arma `resolveRecipients`
 * (`fee-split.ts:215`, `:224`, `:238`), que resuelve el dueño SERVER-SIDE. El
 * caller no lo elige. Por eso ninguno de estos cuatro filtros «impide» un IDOR,
 * y decirlo sería afirmar de más. Lo que sí protegen es la INTEGRIDAD CONTABLE
 * de un leg: que el fee de un dueño no se dé por cobrado, por fallado o por
 * reversado mirando la fila de otro.
 *
 * ── LA DECISIÓN DEL FIXTURE (H-5b): `unique` EN EL FALSO ──────────────────
 *
 * El camino real de `chargeLeg` con el filtro puesto es
 * `SELECT → null → INSERT → 23505 → 'in-progress'` (`fee-split.ts:404-407`).
 * Ese `23505` sale del índice `UNIQUE (orchestration_id, recipient_role)` de
 * `supabase/migrations/20260705000000_wkh136_fee_splits.sql:40`, que NO incluye
 * `owner_ref`. Se eligió modelarlo en el falso (`unique`, agregado en W0) en vez
 * de mockear el adapter: así el test recorre el camino REAL y no uno inventado.
 *
 * Naming: FS-01..FS-04 y sus gemelos positivos, FS-BS.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({ getLogger: () => logSpy }));

const mockSign = vi.hoisted(() => vi.fn());
const mockSettle = vi.hoisted(() => vi.fn());
vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: () => ({
    sign: mockSign,
    settle: mockSettle,
    supportedTokens: [{ symbol: 'PYUSD', address: '0x0', decimals: 18 }],
  }),
}));

const mockVerifySettle = vi.hoisted(() => vi.fn());
vi.mock('../adapters/settle-verifier.js', () => ({
  verifyDefaultChainSettle: (...a: unknown[]) => mockVerifySettle(...a),
}));

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn() },
}));

import { supabase } from '../lib/supabase.js';
import { createOwnerScopedFake } from './__tests__/owner-scoped-fake.js';
import { reverseFeeSplits, settleFeeSplits } from './fee-split.js';

const OWNER_A = 'owner-A-0xaaaa';
const OWNER_B = 'owner-B-0xbbbb';
const ORCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WALLET_A = '0x1111111111111111111111111111111111111111';
const TX_DE_A = '0xAAA-tx-de-A';
const TX_DE_B = '0xBBB-tx-de-B';

/** Las columnas de `a2a_fee_splits` (migración `…wkh136_fee_splits.sql:25-40`). */
const SPLIT_COLUMNS = [
  'id',
  'orchestration_id',
  'recipient_role',
  'recipient_wallet',
  'owner_ref',
  'bps',
  'amount_usdc',
  'status',
  'tx_hash',
  'error_message',
];

/** El UNIQUE de la tabla (`…wkh136_fee_splits.sql:40`). NO incluye `owner_ref`. */
const SPLIT_UNIQUE = [['orchestration_id', 'recipient_role']];

const mockFrom = vi.mocked(supabase.from);

function splitRow(
  ownerRef: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `row-${ownerRef}`,
    orchestration_id: ORCH,
    recipient_role: 'creator',
    recipient_wallet: WALLET_A,
    owner_ref: ownerRef,
    bps: 1000,
    amount_usdc: 1,
    status: 'pending',
    tx_hash: null,
    error_message: null,
    ...over,
  };
}

/** El único recipient de todos los escenarios: el creator, de `owner-A`. */
const RECIPIENT_A = {
  role: 'creator' as const,
  wallet: WALLET_A,
  ownerRef: OWNER_A,
  bps: 1000,
  amountUsdc: 1,
};

function findLeg(
  fake: ReturnType<typeof createOwnerScopedFake>,
): Record<string, unknown> | undefined {
  return fake
    .rows('a2a_fee_splits')
    .find((r) => r.recipient_role === 'creator');
}

describe('fee-split — los 4 filtros por dueño del reparto del fee (WKH-SEC-04)', () => {
  let fake: ReturnType<typeof createOwnerScopedFake>;

  /** Monta el falso con las filas iniciales que pida el escenario. */
  function mount(rows: Record<string, unknown>[]): void {
    fake = createOwnerScopedFake({
      a2a_fee_splits: {
        columns: SPLIT_COLUMNS,
        unique: SPLIT_UNIQUE,
        rows,
      },
    });
    mockFrom.mockImplementation(
      (table: string) => fake.from(table) as ReturnType<typeof mockFrom>,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Camino feliz del transfer: lo que decide el resultado es la DB, no la red.
    mockSign.mockResolvedValue({
      paymentRequest: {
        authorization: 'auth',
        signature: 'sig',
        network: 'base-sepolia',
      },
    });
    mockSettle.mockResolvedValue({ success: true, txHash: TX_DE_A });
    mockVerifySettle.mockResolvedValue({ ok: true, warn: false });
    mount([]);
  });

  // ══════════════════════════════════════════════════════════
  // SITIO 1 — el SELECT de idempotencia (fee-split.ts:365)
  // ══════════════════════════════════════════════════════════
  //
  // POR QUÉ EL ESTADO ES ALCANZABLE: el UNIQUE es `(orchestration_id,
  // recipient_role)` SIN `owner_ref`, así que una fila `(orch, 'creator')` de
  // otro dueño existe si el creador resuelto cambió entre dos settlements de la
  // MISMA orquestación. No hace falta ninguna carrera para llegar acá.

  it('FS-01 [fee-split.ts:365]: un leg `charged` de B NO da por cobrado el leg de A, ni le presta su tx_hash', async () => {
    // La fila ajena, ya cobrada, sobre el mismo (orch, role).
    mount([splitRow(OWNER_B, { status: 'charged', tx_hash: TX_DE_B })]);
    expect(findLeg(fake)?.owner_ref).toBe(OWNER_B);

    const out = await settleFeeSplits({
      orchestrationId: ORCH,
      recipients: [RECIPIENT_A],
    });

    const leg = out.legs[0];
    // Sin el filtro: el SELECT trae la fila de B, la ve `charged` y devuelve
    // `already-charged` CON el `tx_hash` de B (`fee-split.ts:379-383`). O sea:
    // el fee de A se da por pagado y NUNCA se paga.
    expect(leg?.status).not.toBe('already-charged');
    expect(leg?.txHash).not.toBe(TX_DE_B);
    expect(out.txHash).not.toBe(TX_DE_B);
    // Con el filtro: SELECT vacío → INSERT → 23505 contra la fila de B → el leg
    // queda `in-progress` (`:404-407`), que es el camino real de la base.
    expect(leg?.status).toBe('in-progress');
    // Y no se movió un peso: el 23505 corta antes del sign/settle (`:415-421`).
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it('FS-01b (anti-vacuidad): un leg `charged` PROPIO sí da `already-charged`, con SU tx_hash', async () => {
    // La otra dirección (CD-6). Sin esto, un filtro con la columna mal escrita
    // —`.eq('ownerRef', …)`— pasaría FS-01 perfectamente y ROMPERÍA la
    // idempotencia: cada reintento volvería a pagarle al creator.
    mount([splitRow(OWNER_A, { status: 'charged', tx_hash: TX_DE_A })]);

    const out = await settleFeeSplits({
      orchestrationId: ORCH,
      recipients: [RECIPIENT_A],
    });

    expect(out.legs[0]?.status).toBe('already-charged');
    expect(out.legs[0]?.txHash).toBe(TX_DE_A);
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it('FS-BS (backstop estructural): las consultas del leg llevan el filtro por dueño, y nombra la que falte', async () => {
    // Complemento de los tests de propiedad: si alguien borra UN filtro, este
    // test dice CUÁL sitio quedó abierto. No los reemplaza —una llamada
    // existente no prueba qué filas se tocaron—, los ubica.
    await settleFeeSplits({
      orchestrationId: ORCH,
      recipients: [RECIPIENT_A],
    });

    const scoped = fake
      .resolved()
      .map(
        (q) =>
          `${q.kind}:${q.filters.some(([c, v]) => c === 'owner_ref' && v === OWNER_A) ? 'scoped' : 'sin-filtro'}`,
      );
    expect(scoped).toEqual([
      'select:scoped', // idempotencia   → fee-split.ts:365
      'insert:sin-filtro', // el INSERT no filtra: ESTAMPA el owner_ref (:397)
      'update:scoped', // UPDATE charged → fee-split.ts:538
    ]);
    // Y el INSERT estampa el dueño del recipient resuelto server-side.
    const insert = fake.resolved().find((q) => q.kind === 'insert');
    expect(insert?.inserted?.owner_ref).toBe(OWNER_A);
  });

  // ══════════════════════════════════════════════════════════
  // SITIOS 2, 3 y 4 — las TRES escrituras. ENTRELAZADO OBLIGATORIO.
  // ══════════════════════════════════════════════════════════
  //
  // DECLARACIÓN OBLIGATORIA (AC-3). Los tres UPDATE apuntan a una fila que el
  // UNIQUE `(orchestration_id, recipient_role)` ya determina por completo, y ese
  // índice NO incluye `owner_ref` (`…wkh136_fee_splits.sql:40`). Consecuencia
  // medida: EN UNA SOLA PASADA, con el filtro por dueño o sin él, la escritura
  // toca exactamente la misma fila. Los dos casos sólo se separan si la fila
  // cambia de dueño ENTRE la lectura previa y la escritura.
  //
  // Esa carrera NO es alcanzable en producción HOY: ninguna operación de este
  // repo cambia el `owner_ref` de un leg ya insertado. El test igual vale, y es
  // lo que significa «defensa en profundidad»: el filtro está para que la
  // escritura siga acotada si mañana el read previo se refactoriza, se saltea o
  // devuelve un dato viejo. Sin un test, nadie se entera de que dejó de estar.
  //
  // Y sobre `reverseFeeSplits` (sitio 4) hay algo más fuerte que declarar: NO
  // TIENE NINGÚN LLAMADOR DE PRODUCCIÓN. Su propio docblock lo dice
  // (`fee-split.ts:636`: «v1: NO se cablea a orchestrate/compose»), y
  // `command grep -rn "reverseFeeSplits" src/ --include=*.ts` devuelve sólo el
  // propio `fee-split.ts` y una mención en un comentario de `fee-charge.ts:677`.

  it('FS-02 [fee-split.ts:538]: si el leg pasa a ser de B entre el INSERT y el UPDATE, NO queda `charged` con el tx de A', async () => {
    // Arranca vacío: el INSERT crea la fila como de A.
    mount([]);
    fake.onUpdateStart = () => {
      const row = findLeg(fake);
      if (row) row.owner_ref = OWNER_B;
    };

    const out = await settleFeeSplits({
      orchestrationId: ORCH,
      recipients: [RECIPIENT_A],
    });

    // LA ASERCIÓN QUE IMPORTA: la fila, ya de B, quedó intacta.
    const row = findLeg(fake);
    expect(row?.owner_ref).toBe(OWNER_B);
    expect(row?.status).toBe('pending');
    // `?? null` porque el INSERT de `chargeLeg` (`:393-401`) no manda la columna:
    // en la fila del falso está AUSENTE, no en `null`. En la base real el DEFAULT
    // la deja `NULL`. Lo que se afirma es que no tiene el tx de A.
    expect(row?.tx_hash ?? null).toBeNull();
    // ⚠️ Y esto es comportamiento REAL que conviene tener escrito: el leg se
    // reporta `charged` igual (`fee-split.ts:549`), porque el transfer SÍ salió
    // y el `updateErr` sólo se loguea (`:540-547`). El filtro acota la
    // ESCRITURA, no el reporte.
    expect(out.legs[0]?.status).toBe('charged');
  });

  it('FS-02b (anti-vacuidad): sin el entrelazado, la fila propia SÍ queda `charged` con el tx de A', async () => {
    // La otra dirección (CD-6). Sin esto, un filtro con la columna mal escrita
    // pasaría FS-02 perfectamente y dejaría TODOS los legs en `pending` para
    // siempre: un ledger que nunca cierra.
    mount([]);

    await settleFeeSplits({ orchestrationId: ORCH, recipients: [RECIPIENT_A] });

    const row = findLeg(fake);
    expect(row?.status).toBe('charged');
    expect(row?.tx_hash).toBe(TX_DE_A);
  });

  it('FS-03 [fee-split.ts:618]: si el leg pasa a ser de B antes de `markLegFailed`, NO queda `failed` con el error de A', async () => {
    mount([]);
    // Rama de fallo: el settle no tuvo éxito (`fee-split.ts:462-499`).
    mockSettle.mockResolvedValue({ success: false, error: 'facilitator 502' });
    fake.onUpdateStart = () => {
      const row = findLeg(fake);
      if (row) row.owner_ref = OWNER_B;
    };

    await settleFeeSplits({ orchestrationId: ORCH, recipients: [RECIPIENT_A] });

    const row = findLeg(fake);
    expect(row?.owner_ref).toBe(OWNER_B);
    expect(row?.status).toBe('pending');
    // Ídem FS-02: el INSERT no manda `error_message`, así que está ausente.
    expect(row?.error_message ?? null).toBeNull();
  });

  it('FS-03b (anti-vacuidad): sin el entrelazado, la fila propia SÍ queda `failed` con su error', async () => {
    mount([]);
    mockSettle.mockResolvedValue({ success: false, error: 'facilitator 502' });

    await settleFeeSplits({ orchestrationId: ORCH, recipients: [RECIPIENT_A] });

    const row = findLeg(fake);
    expect(row?.status).toBe('failed');
    expect(String(row?.error_message)).toContain('facilitator 502');
  });

  it('FS-04 [fee-split.ts:697]: si el leg pasa a ser de B entre el pre-chequeo en JS y el UPDATE, NO queda `reversed`', async () => {
    // El pre-chequeo de `:676-683` filtra `rows` por dueño EN MEMORIA y corta
    // con `ownership_mismatch` si no queda ninguno. O sea que el cross-tenant
    // simple muere ahí y el filtro DEL UPDATE nunca se ejercita. Por eso el
    // escenario ataca lo que ese segundo filtro protege de verdad: el SELECT y
    // el UPDATE son DOS viajes a la base.
    mount([splitRow(OWNER_A, { status: 'charged', tx_hash: TX_DE_A })]);
    fake.onUpdateStart = () => {
      const row = findLeg(fake);
      if (row) row.owner_ref = OWNER_B;
    };

    const out = await reverseFeeSplits(ORCH, OWNER_A);

    const row = findLeg(fake);
    expect(row?.owner_ref).toBe(OWNER_B);
    expect(row?.status).toBe('charged');
    // ⚠️ Comportamiento REAL que conviene tener escrito: `reversedCount` cuenta
    // igual (`fee-split.ts:707`), porque el UPDATE no devuelve error cuando no
    // matchea ninguna fila — sólo se saltea el `continue` de `:699-705`. El
    // contador NO es evidencia de que algo se haya reversado.
    expect(out).toMatchObject({ status: 'reversed', reversedCount: 1 });
  });

  it('FS-04b (anti-vacuidad): sin el entrelazado, la fila propia SÍ pasa a `reversed`', async () => {
    mount([splitRow(OWNER_A, { status: 'charged', tx_hash: TX_DE_A })]);

    const out = await reverseFeeSplits(ORCH, OWNER_A);

    expect(findLeg(fake)?.status).toBe('reversed');
    expect(out).toMatchObject({ status: 'reversed', reversedCount: 1 });
  });
});
