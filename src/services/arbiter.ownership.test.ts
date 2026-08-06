/**
 * `arbiterService` — los filtros por dueño de las dos transiciones de disputa
 * (WKH-SEC-04, sitios 6 y 7 de los 12).
 *
 * ── EL HUECO QUE CIERRA ESTE ARCHIVO ──────────────────────────────────────
 *
 * `src/services/arbiter.ts:1070` (`revertDisputeToOpen`) y `:1100`
 * (`holdArbitration`) llevan `.eq('owner_ref', ownerRef)` y SOBREVIVÍAN a la
 * suite. Medido en `b7fa4e7`: quitando cualquiera de los dos, el único rojo es
 * el del guardián estructural (`test/ownership-filter-guard.test.ts`, G-08 y
 * G-09). Ningún test de comportamiento se enteraba.
 *
 * ── POR QUÉ NO SIRVE `arbiter.test.ts` PARA ESTO ──────────────────────────
 *
 * Su doble de supabase (`arbiter.test.ts:340-430`) vive bajo un comentario que
 * dice «from() fiel» y aplica `id` (`:385`) y `status` (`:420`) — pero NUNCA
 * `owner_ref`. Un UPDATE con el filtro por dueño borrado toca exactamente las
 * mismas filas en ese doble. No se lo toca (decenas de tests dependen de su
 * contrato `db.fromImpl`): este archivo usa el falso de
 * `__tests__/owner-scoped-fake.ts`, que aplica EXACTAMENTE los filtros pedidos.
 *
 * ── NO SON DOS TESTS DE UN ENTRELAZADO ────────────────────────────────────
 *
 * El AC-3 del work-item de WKH-SEC-03 daba estos dos sitios por «sólo matables
 * con un test de entrelazado». Medido: no. Los dos son métodos del objeto
 * exportado `arbiterService` (`arbiter.ts:576`, `:1064`, `:1090`) que reciben
 * `(intentId, ownerRef)` como argumentos INDEPENDIENTES. Se los mata cruzando el
 * par de argumentos sobre una base perfectamente consistente, sin ningún hook.
 *
 * ── QUÉ PROPIEDAD SE PRUEBA, Y CUÁL NO ────────────────────────────────────
 *
 * La propiedad de la función: dado un par `(intentId, ownerRef)` que no se
 * corresponde, la transición no se aplica sobre el intent ajeno.
 *
 * Lo que NO se prueba, porque no es cierto: que esto detenga un IDOR vivo. El
 * camino de producción es `POST /session/:id/dispute` (`src/routes/payments.ts:339`),
 * que llama `openDispute(req.params.id, callerKey.owner_ref)`, y `openDispute`
 * compara los dos dueños en JavaScript (`arbiter.ts:606-608`) antes de llegar
 * hasta acá: un `intentId` ajeno se rechaza con `OWNERSHIP_MISMATCH` primero.
 * Decir que estos filtros «impiden» un IDOR sería afirmar de más.
 *
 * Naming: AR-01..AR-04, AR-BS.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/logger.js', () => ({
  getLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

// `holdArbitration` emite un recibo (`arbiter.ts:1106-1117`) que no es el sujeto
// de este archivo. Se dobla para que el test afirme sobre el estado de la tabla
// de intents, no sobre la proof-chain.
const mockEmit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('./receipt.js', () => ({
  receiptService: { emit: (...a: unknown[]) => mockEmit(...a) },
}));

import { supabase } from '../lib/supabase.js';
import { createOwnerScopedFake } from './__tests__/owner-scoped-fake.js';
import { arbiterService } from './arbiter.js';

const OWNER_A = 'owner-A-0xaaaa';
const OWNER_B = 'owner-B-0xbbbb';
const INTENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INTENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Las columnas que las dos cadenas filtran o escriben. */
const INTENT_COLUMNS = ['id', 'owner_ref', 'status'];

/** Las columnas que `upsertArbitrationRow` (`arbiter.ts:520-537`) empuja. */
const ARBITRATION_COLUMNS = [
  'intent_id',
  'owner_ref',
  'decision',
  'method',
  'at_stake_usd',
  'settle_usd',
  'ambiguity_reason',
  'llm_reasoning',
  'evidence_digest',
  'resolved_by',
  'resolved_at',
  'resolution_note',
  'status',
];

const META = {
  decision: 'hold' as const,
  method: 'hold' as const,
  atStakeUsd: 10,
  ambiguityReason: 'test',
  llmReasoning: null,
  evidenceDigest: null,
  sellerRef: 'seller-1',
  resolvedBy: null,
  resolvedAt: null,
  resolutionNote: null,
};

const mockFrom = vi.mocked(supabase.from);

function findIntent(
  fake: ReturnType<typeof createOwnerScopedFake>,
  id: string,
): Record<string, unknown> | undefined {
  return fake.rows('a2a_payment_intents').find((r) => r.id === id);
}

describe('arbiterService — filtros por dueño de las transiciones de disputa (WKH-SEC-04)', () => {
  let fake: ReturnType<typeof createOwnerScopedFake>;

  beforeEach(() => {
    vi.clearAllMocks();
    fake = createOwnerScopedFake({
      a2a_payment_intents: {
        columns: INTENT_COLUMNS,
        rows: [
          { id: INTENT_A, owner_ref: OWNER_A, status: 'disputed' },
          { id: INTENT_B, owner_ref: OWNER_B, status: 'disputed' },
        ],
      },
      a2a_arbitrations: { columns: ARBITRATION_COLUMNS, rows: [] },
    });
    mockFrom.mockImplementation(
      (table: string) => fake.from(table) as ReturnType<typeof mockFrom>,
    );
  });

  it('AR-01 [arbiter.ts:1070]: A revierte la disputa de B → la fila de B sigue en `disputed`', async () => {
    // Sin afirmar que la fila existe, un "no cambió nada" podría venir de una
    // tabla vacía y el test pasaría sin ejercitar el filtro (CD-25).
    expect(findIntent(fake, INTENT_B)?.status).toBe('disputed');

    // ⚠️ `revertDisputeToOpen` TRAGA sus errores (`arbiter.ts:1072-1083`): no
    // lanza y no devuelve nada. La única aserción posible —y la que importa— es
    // el estado de la tabla. Sin el filtro, la disputa de B se cancela sola.
    await arbiterService.revertDisputeToOpen(INTENT_B, OWNER_A);

    expect(findIntent(fake, INTENT_B)?.status).toBe('disputed');
    expect(findIntent(fake, INTENT_B)?.owner_ref).toBe(OWNER_B);
  });

  it('AR-02 (anti-vacuidad): A revierte la SUYA y sí pasa a `open`', async () => {
    // La otra dirección (CD-6). Sin esto, un filtro con la columna mal escrita
    // —`.eq('ownerRef', …)`— pasaría AR-01 perfectamente y dejaría al dueño con
    // su propio intent bricked en `disputed`, que es exactamente el bug que
    // `revertDisputeToOpen` existe para reparar (`arbiter.ts:1058-1062`).
    await arbiterService.revertDisputeToOpen(INTENT_A, OWNER_A);

    expect(findIntent(fake, INTENT_A)?.status).toBe('open');
    // Y no arrastró la de B.
    expect(findIntent(fake, INTENT_B)?.status).toBe('disputed');
  });

  it('AR-03 [arbiter.ts:1100]: A congela la disputa de B → la fila de B sigue en `disputed`', async () => {
    expect(findIntent(fake, INTENT_B)?.status).toBe('disputed');

    await arbiterService.holdArbitration(INTENT_B, OWNER_A, META);

    // `arb_hold` es TERMINAL (`arbiter.ts:1060-1061`): sin el filtro, A dejaría
    // la disputa de B congelada y esperando revisión humana.
    expect(findIntent(fake, INTENT_B)?.status).toBe('disputed');
    expect(findIntent(fake, INTENT_B)?.owner_ref).toBe(OWNER_B);
  });

  it('AR-04 (anti-vacuidad): A congela la SUYA y sí pasa a `arb_hold`', async () => {
    const out = await arbiterService.holdArbitration(INTENT_A, OWNER_A, META);

    expect(findIntent(fake, INTENT_A)?.status).toBe('arb_hold');
    expect(out.status).toBe('held');
    expect(findIntent(fake, INTENT_B)?.status).toBe('disputed');
  });

  it('AR-BS (backstop estructural): las dos escrituras llevan el filtro por dueño, y nombra la que falte', async () => {
    // Complemento de los tests de propiedad: si alguien borra UN filtro, este
    // test dice CUÁL de los dos sitios quedó abierto. No los reemplaza —una
    // llamada existente no prueba qué filas se tocaron—, los ubica.
    await arbiterService.revertDisputeToOpen(INTENT_A, OWNER_A);
    await arbiterService.holdArbitration(INTENT_A, OWNER_A, META);

    const writes = fake
      .resolved()
      .filter((q) => q.table === 'a2a_payment_intents' && q.kind === 'update')
      .map(
        (q) =>
          `update:${q.filters.some(([c, v]) => c === 'owner_ref' && v === OWNER_A) ? 'scoped' : 'UNSCOPED'}`,
      );
    expect(writes).toEqual([
      'update:scoped', // revertDisputeToOpen → arbiter.ts:1070
      'update:scoped', // holdArbitration     → arbiter.ts:1100
    ]);
  });
});
