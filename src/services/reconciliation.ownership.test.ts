/**
 * `reconciliationService.readBudgetUsd` — el filtro por dueño del lector de
 * budget (WKH-SEC-04, sitio 11 de los 12).
 *
 * ── EL HUECO QUE CIERRA ESTE ARCHIVO ──────────────────────────────────────
 *
 * `src/services/reconciliation.ts:1448` es `.eq('owner_ref', ownerRef)` y
 * SOBREVIVÍA a la suite. Medido en `b7fa4e7`: quitándolo, el único rojo es el
 * del guardián estructural (`test/ownership-filter-guard.test.ts`, G-08 y
 * G-09). Ningún test de comportamiento se enteraba.
 *
 * Sin el filtro, `readBudgetUsd('k-B', 'owner-A', chainId)` devuelve el budget
 * de la key de B en vez de `null`, y ese número entra al reporte de drift
 * (`reconciliation.ts:1436-1437`) como si fuera el saldo off-chain de A.
 *
 * ── QUÉ PROPIEDAD SE PRUEBA, Y CUÁL NO ────────────────────────────────────
 *
 * La propiedad de la función: dado un par `(keyId, ownerRef)` que no se
 * corresponde, no entrega el budget.
 *
 * Lo que NO se prueba, porque no es cierto: que esto detenga un IDOR vivo.
 * `readBudgetUsd` tiene UN solo llamador de producción, `driftCheck`
 * (`reconciliation.ts:1402`), que le pasa el `ownerRef` sacado de la propia fila
 * que acaba de leer (`:1382`) — o sea que el par siempre se corresponde — y está
 * detrás del gate de admin. Decir que este filtro «impide» un IDOR sería
 * afirmar de más.
 *
 * Naming: RC-01, RC-02.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Cabecera de mocks: la de `reconciliation.test.ts:17-83`, que es el módulo
//    con más dependencias de este corte. Ninguna interviene en `readBudgetUsd`;
//    están para que el módulo importe sin explotar.
const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({ getLogger: () => logSpy }));

vi.mock('../lib/supabase.js', () => ({
  supabase: { rpc: vi.fn(), from: vi.fn() },
}));

vi.mock('../adapters/escrow/debit-capture.js', () => ({
  isEscrowSettleEnabled: () => true,
}));

vi.mock('../adapters/escrow/debit-executor.js', () => ({
  recordDebitSettleStatus: vi.fn(async () => ({ outcome: 'applied' as const })),
}));

vi.mock('../adapters/escrow/reconciler-onchain.js', () => ({
  reverifyDebitedByTxHash: vi.fn(),
  readEscrowBalanceAtomic: vi.fn(),
}));

vi.mock('../adapters/escrow-verifier.js', () => ({
  resolveEscrowContract: () => '0x7777777777777777777777777777777777777777',
}));

vi.mock('../adapters/registry.js', () => ({
  getDefaultChainKey: () => 'base-sepolia',
  getAdaptersBundle: () => ({
    payment: { supportedTokens: [{ decimals: 6 }] },
  }),
}));

vi.mock('../adapters/settle-verifier.js', () => ({
  verifyDefaultChainSettle: vi.fn(),
}));

vi.mock('./payment-intent.js', () => ({
  settlePaymentIntentOnChain: vi.fn(),
}));

import { supabase } from '../lib/supabase.js';
import { createOwnerScopedFake } from './__tests__/owner-scoped-fake.js';
import { reconciliationService } from './reconciliation.js';

const OWNER_A = 'owner-A-0xaaaa';
const OWNER_B = 'owner-B-0xbbbb';
const KEY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHAIN_ID = 8453;

/** Las columnas que `reconciliation.ts:1444-1449` selecciona y filtra. */
const KEY_COLUMNS = ['id', 'owner_ref', 'budget'];

const mockFrom = vi.mocked(supabase.from);

describe('reconciliationService.readBudgetUsd — aislamiento entre tenants (WKH-SEC-04)', () => {
  let fake: ReturnType<typeof createOwnerScopedFake>;

  beforeEach(() => {
    vi.clearAllMocks();
    fake = createOwnerScopedFake({
      a2a_agent_keys: {
        columns: KEY_COLUMNS,
        rows: [
          {
            id: KEY_A,
            owner_ref: OWNER_A,
            budget: { [String(CHAIN_ID)]: '12.500000' },
          },
          {
            id: KEY_B,
            owner_ref: OWNER_B,
            budget: { [String(CHAIN_ID)]: '9999.000000' },
          },
        ],
      },
    });
    mockFrom.mockImplementation(
      (table: string) => fake.from(table) as ReturnType<typeof mockFrom>,
    );
  });

  it('RC-01 [reconciliation.ts:1448]: A lee el budget de la key de B → null, y la key de B EXISTE', async () => {
    // Sin afirmar que la fila existe, un `null` podría venir de una tabla vacía
    // y el test pasaría sin ejercitar el filtro (CD-25).
    expect(fake.rows('a2a_agent_keys').some((r) => r.id === KEY_B)).toBe(true);

    const budget = await reconciliationService.readBudgetUsd(
      KEY_B,
      OWNER_A,
      CHAIN_ID,
    );

    expect(budget).toBeNull();
  });

  it('RC-02 (anti-vacuidad): A lee el budget de la SUYA y lo obtiene', async () => {
    // La otra dirección (CD-6). Sin esto, un filtro con la columna mal escrita
    // —`.eq('ownerRef', …)`— pasaría RC-01 perfectamente y dejaría el reporte de
    // drift sin el saldo off-chain propio. Con el falso, además, una columna
    // inexistente devuelve 42703 en vez de degradar a «no encontré nada».
    const budget = await reconciliationService.readBudgetUsd(
      KEY_A,
      OWNER_A,
      CHAIN_ID,
    );

    expect(budget).toBe('12.500000');
    // Y no se trajo el de B.
    expect(budget).not.toBe('9999.000000');
  });
});
