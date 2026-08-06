/**
 * Arbiter evidence reader — unit tests (WKH-139 v2, MNR-1)
 *
 * Cubre la lógica determinística de readEvidence con un doble de supabase fiel a
 * la semántica de las 3 queries owner-guarded (intent / vouchers / receipts):
 *   - tamper: verify.valid===false && tamper_detected===true → proofChainOk=false;
 *     un valid:false por config (secret ausente, sin tamper_detected) NO invalida.
 *   - agregación receiptSettleTotalUsd sobre SETTLE_RECEIPT_TYPES (null si ninguno).
 *   - mapeo PGRST116 → INTENT_NOT_FOUND (disclosure-safe).
 *
 * ⚠️ WKH-SEC-04 — LÍMITE DE ESTE ARCHIVO: su doble NO aplica los filtros (`:55`
 * es `eq: () => b`) y su fixture tiene un solo dueño (`:42`), así que lo que
 * mide es la lógica determinística, NO el acotamiento por `owner_ref`; los tres
 * `.eq('owner_ref', …)` de `evidence.ts` (`:57`, `:76`, `:96`) los cubre por
 * comportamiento `src/services/arbiter/evidence.ownership.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../../lib/logger.js', () => ({ getLogger: () => logSpy }));

vi.mock('../../lib/supabase.js', () => ({
  supabase: { from: vi.fn() },
}));

const mockVerify = vi.hoisted(() => vi.fn());
vi.mock('../receipt.js', () => ({
  receiptService: { verify: (...a: unknown[]) => mockVerify(...a) },
}));

import { supabase } from '../../lib/supabase.js';
import { ArbiterError } from '../../types/arbiter.js';
import { readEvidence } from './evidence.js';

const mockFrom = vi.mocked(supabase.from);

const OWNER = 'tenant-A';
const PAYTO = '0x2222222222222222222222222222222222222222';

interface QueryResult {
  data?: unknown;
  error?: unknown;
}

// Doble encadenable fiel: select()/eq() devuelven el builder; single() y el await
// directo (then) resuelven el mismo resultado (vouchers/receipts se awaitan sin single).
function makeQuery(result: QueryResult): unknown {
  const b = {
    select: () => b,
    eq: () => b,
    single: () => Promise.resolve(result),
    // biome-ignore lint/suspicious/noThenProperty: awaitable supabase builder double
    then: (resolve: (r: QueryResult) => void) => resolve(result),
  };
  return b;
}

function wireTables(t: {
  intent: QueryResult;
  vouchers: QueryResult;
  receipts: QueryResult;
}): void {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'a2a_payment_intents') return makeQuery(t.intent) as never;
    if (table === 'a2a_payment_vouchers') return makeQuery(t.vouchers) as never;
    if (table === 'a2a_receipts') return makeQuery(t.receipts) as never;
    return makeQuery({ data: null, error: null }) as never;
  });
}

const OK_INTENT: QueryResult = {
  data: {
    authorized_usd: 10,
    consumed_usd: 5,
    chain_id: 2368,
    pay_to: PAYTO,
    seller_ref: 'reg/agent',
  },
  error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readEvidence tamper (proofChainOk)', () => {
  it('un recibo tampered (valid:false + tamper_detected:true) → proofChainOk=false', async () => {
    wireTables({
      intent: OK_INTENT,
      vouchers: { data: [{ amount_usd: 5 }], error: null },
      receipts: {
        data: [
          { id: 'r1', receipt_type: 'budget_debit', amount_usd: 5 },
          { id: 'r2', receipt_type: 'protocol_fee', amount_usd: 1 },
        ],
        error: null,
      },
    });
    mockVerify.mockImplementation((id: string) =>
      Promise.resolve(
        id === 'r2'
          ? { valid: false, receipt_id: id, tamper_detected: true }
          : { valid: true, receipt_id: id },
      ),
    );

    const ev = await readEvidence('i1', OWNER);

    expect(ev.proofChainOk).toBe(false);
    expect(ev.voucherCount).toBe(1);
    expect(ev.vouchersTotalUsd).toBeCloseTo(5, 8);
    // protocol_fee NO es settle-type: excluido de la Σ pese al tamper.
    expect(ev.receiptSettleTotalUsd).toBeCloseTo(5, 8);
    expect(ev.chainId).toBe(2368);
  });

  it('valid:false SIN tamper_detected (config/secret ausente) → proofChainOk=true', async () => {
    wireTables({
      intent: OK_INTENT,
      vouchers: { data: [], error: null },
      receipts: {
        data: [
          { id: 'r1', receipt_type: 'arbitration_release', amount_usd: 3 },
          { id: 'r2', receipt_type: 'arbitration_split', amount_usd: 2 },
        ],
        error: null,
      },
    });
    mockVerify.mockResolvedValue({
      valid: false,
      receipt_id: 'x',
      reason: 'SIGNING_SECRET_UNAVAILABLE',
    });

    const ev = await readEvidence('i1', OWNER);

    expect(ev.proofChainOk).toBe(true); // config, no tamper
    // ambos son settle-types → Σ = 5.
    expect(ev.receiptSettleTotalUsd).toBeCloseTo(5, 8);
    expect(ev.voucherCount).toBe(0);
  });
});

describe('readEvidence receiptSettleTotalUsd (agregación)', () => {
  it('sin recibos settle-type → receiptSettleTotalUsd=null', async () => {
    wireTables({
      intent: OK_INTENT,
      vouchers: { data: [{ amount_usd: 2 }], error: null },
      receipts: {
        data: [{ id: 'r1', receipt_type: 'protocol_fee', amount_usd: 1 }],
        error: null,
      },
    });
    mockVerify.mockResolvedValue({ valid: true, receipt_id: 'r1' });

    const ev = await readEvidence('i1', OWNER);

    expect(ev.receiptSettleTotalUsd).toBeNull();
    expect(ev.proofChainOk).toBe(true);
  });

  it('Σ sólo sobre SETTLE_RECEIPT_TYPES (budget_debit+arbitration_release/split)', async () => {
    wireTables({
      intent: OK_INTENT,
      vouchers: { data: [], error: null },
      receipts: {
        data: [
          { id: 'r1', receipt_type: 'budget_debit', amount_usd: 4 },
          { id: 'r2', receipt_type: 'arbitration_release', amount_usd: 3 },
          { id: 'r3', receipt_type: 'arbitration_split', amount_usd: 2 },
          { id: 'r4', receipt_type: 'arbitration_hold', amount_usd: 100 },
          { id: 'r5', receipt_type: 'protocol_fee', amount_usd: 100 },
        ],
        error: null,
      },
    });
    mockVerify.mockResolvedValue({ valid: true, receipt_id: 'x' });

    const ev = await readEvidence('i1', OWNER);

    // 4 + 3 + 2 = 9 (hold y protocol_fee excluidos).
    expect(ev.receiptSettleTotalUsd).toBeCloseTo(9, 8);
  });
});

describe('readEvidence PGRST116 → INTENT_NOT_FOUND', () => {
  it('intent inexistente / de otro owner (PGRST116) → ArbiterError INTENT_NOT_FOUND, sin verify', async () => {
    wireTables({
      intent: { data: null, error: { code: 'PGRST116', message: 'no rows' } },
      vouchers: { data: [], error: null },
      receipts: { data: [], error: null },
    });

    await expect(readEvidence('i1', OWNER)).rejects.toBeInstanceOf(
      ArbiterError,
    );
    await expect(readEvidence('i1', OWNER)).rejects.toMatchObject({
      code: 'INTENT_NOT_FOUND',
    });
    expect(mockVerify).not.toHaveBeenCalled();
  });

  it('error no-PGRST116 en la query del intent → INTENT/INTERNAL (fail-closed)', async () => {
    wireTables({
      intent: { data: null, error: { code: '58000', message: 'db down' } },
      vouchers: { data: [], error: null },
      receipts: { data: [], error: null },
    });

    await expect(readEvidence('i1', OWNER)).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });
});
