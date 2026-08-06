/**
 * `receiptService.getById` — aislamiento entre inquilinos (WKH-SEC-03).
 *
 * ── EL HUECO QUE CIERRA ESTE ARCHIVO ──────────────────────────────────────
 *
 * `src/services/receipt.ts:293` es `.eq('owner_ref', ownerRef)`, y hasta esta HU
 * NINGÚN test lo miraba. Medido en `ef384b7`: borrando esa línea la suite entera
 * quedaba en `5294 passed | 19 skipped`, byte por byte igual que la baseline.
 *
 * Lo que ese filtro acota es real y alcanzable HOY: el id sale de
 * `req.params.id` (`src/routes/receipts.ts:78-80`), o sea que lo elige el
 * caller. Sin el filtro, A pide el id de un recibo de B por la API y lo recibe,
 * con su monto, su contraparte y su tx hash.
 *
 * ── POR QUÉ UN FALSO DE COMPORTAMIENTO Y NO UN ESPÍA DE LLAMADA ───────────
 *
 * Un `expect(eq).toHaveBeenCalledWith('owner_ref', X)` verifica que la consulta
 * SE ESCRIBIÓ; no dice nada sobre qué datos salen. El falso de
 * `__tests__/owner-scoped-fake.ts` aplica exactamente los filtros que el
 * servicio pide sobre una tabla con dos dueños, así que lo que se afirma acá es
 * la propiedad ("A no obtiene el recibo de B"), no la línea de código.
 *
 * Naming: R-01, R-02.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn() },
}));

import { supabase } from '../lib/supabase.js';
import { createOwnerScopedFake } from './__tests__/owner-scoped-fake.js';
import { receiptService } from './receipt.js';

const OWNER_A = 'owner-A-0xaaaa';
const OWNER_B = 'owner-B-0xbbbb';
const RECEIPT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RECEIPT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Las 13 columnas que `receipt.ts:288-290` selecciona, más nada. */
const RECEIPT_COLUMNS = [
  'id',
  'owner_ref',
  'agent_key_id',
  'session_id',
  'delegation_id',
  'receipt_type',
  'amount_usd',
  'chain_id',
  'tx_hash',
  'counterparty',
  'orchestration_id',
  'prev_receipt_hash',
  'receipt_hash',
  'created_at',
];

function receiptRow(
  id: string,
  ownerRef: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    owner_ref: ownerRef,
    agent_key_id: 'key-1',
    session_id: null,
    delegation_id: null,
    receipt_type: 'settle',
    amount_usd: '12.500000',
    chain_id: 84532,
    tx_hash: '0xdeadbeef',
    counterparty: '0xcafe',
    orchestration_id: null,
    prev_receipt_hash: null,
    receipt_hash: 'h',
    created_at: '2026-08-05T00:00:00.000Z',
    ...over,
  };
}

const mockFrom = vi.mocked(supabase.from);

describe('receiptService.getById — aislamiento entre tenants (WKH-SEC-03)', () => {
  let fake: ReturnType<typeof createOwnerScopedFake>;

  beforeEach(() => {
    vi.clearAllMocks();
    fake = createOwnerScopedFake({
      a2a_receipts: {
        columns: RECEIPT_COLUMNS,
        rows: [
          receiptRow(RECEIPT_A, OWNER_A, { amount_usd: '1.000000' }),
          receiptRow(RECEIPT_B, OWNER_B, {
            amount_usd: '999.000000',
            tx_hash: '0xsecreto-de-B',
          }),
        ],
      },
    });
    mockFrom.mockImplementation(
      (table: string) => fake.from(table) as ReturnType<typeof mockFrom>,
    );
  });

  it('R-01 [receipt.ts:293]: A pide por id el recibo de B → null, y el id EXISTE en la tabla', async () => {
    // Sin afirmar que el id existe, un `null` podría venir de que la fila nunca
    // se insertó y el test pasaría sin ejercitar nada.
    expect(fake.rows('a2a_receipts').some((r) => r.id === RECEIPT_B)).toBe(
      true,
    );

    const found = await receiptService.getById(RECEIPT_B, OWNER_A);

    expect(found).toBeNull();
  });

  it('R-02 (anti-vacuidad): A pide el SUYO y lo obtiene entero', async () => {
    // La otra dirección. Sin esto, un filtro con la columna mal escrita
    // —`.eq('ownerRef', …)`— pasaría R-01 perfectamente y dejaría al dueño sin
    // ver sus propios recibos. Con el falso, además, una columna inexistente
    // explota con 42703 en vez de degradar a "no encontré nada".
    const found = await receiptService.getById(RECEIPT_A, OWNER_A);

    expect(found).not.toBeNull();
    expect(found?.id).toBe(RECEIPT_A);
    expect(found?.owner_ref).toBe(OWNER_A);
    // Y no se trajo de arrastre el de B.
    expect(found?.amount_usd).toBe('1.000000');
  });
});
