/**
 * Arbiter Service — money-path integration tests (WKH-139 v2, W4.2)
 *
 * DB in-memory FIEL a las semánticas SQL de WKH-139:
 *   - open_dispute: open→disputed (gate anti-race), idempotente.
 *   - close_payment_intent_for_arbitration: disputed→arb_closing (clamp+persiste
 *     consumed), arb_closing→recovery (lee persistido), else INTENT_NOT_OPEN.
 *   - record_settle_outcome / finalize_payment_intent: gate ensanchado a
 *     ('closing','arb_closing'); finalize mueve el refund status-gated (exactly-once).
 *   - close_payment_intent_for_settle: para el anti-race con closeSession.
 *
 * Cubre TODOS los ACs + los casos obligatorios money-path. arbiterService REAL;
 * readEvidence + classifyAmbiguous + receiptService + adapters mockeados.
 */

import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks (hoisted) ─────────────────────────────────────────────
const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({ getLogger: () => logSpy }));

const mockSign = vi.fn();
const mockSettle = vi.fn();
vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: () => ({ sign: mockSign, settle: mockSettle }),
  getChainConfig: () => ({ name: 'kite', chainId: 2368, explorerUrl: '' }),
}));

const mockVerify = vi.fn().mockResolvedValue({ ok: true });
vi.mock('../adapters/settle-verifier.js', () => ({
  verifyDefaultChainSettle: (...a: unknown[]) => mockVerify(...a),
}));

vi.mock('../lib/supabase.js', () => ({
  supabase: { rpc: vi.fn(), from: vi.fn() },
}));

const mockReadEvidence = vi.hoisted(() => vi.fn());
vi.mock('./arbiter/evidence.js', () => ({
  readEvidence: (...a: unknown[]) => mockReadEvidence(...a),
}));

const mockClassifyAmbiguous = vi.hoisted(() => vi.fn());
vi.mock('./arbiter/llm-classifier.js', () => ({
  classifyAmbiguous: (...a: unknown[]) => mockClassifyAmbiguous(...a),
}));

const mockEmit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('./receipt.js', () => ({
  receiptService: { emit: (...a: unknown[]) => mockEmit(...a) },
}));

const mockResolveCallerKey = vi.hoisted(() => vi.fn());
vi.mock('../routes/auth/parsers.js', () => ({
  resolveCallerKey: mockResolveCallerKey,
}));

import { supabase } from '../lib/supabase.js';
import { paymentsRoutes } from '../routes/payments.js';
import type { DisputeEvidence } from '../types/arbiter.js';
import { arbiterService } from './arbiter.js';
import { paymentIntentService } from './payment-intent.js';

const mockRpc = vi.mocked(supabase.rpc);
const mockFrom = vi.mocked(supabase.from);

const OWNER = 'tenant-A';
const PAYTO = '0x2222222222222222222222222222222222222222';

type RpcHandler = (args: Record<string, unknown>) => {
  data?: unknown;
  error?: { code?: string; message?: string } | null;
};

function happySettle(): void {
  mockSign.mockResolvedValue({
    xPaymentHeader: 'h',
    paymentRequest: {
      authorization: { value: '1' },
      signature: '0xsig',
      network: 'kite',
    },
  });
  mockSettle.mockResolvedValue({ txHash: '0xTX', success: true });
  mockVerify.mockResolvedValue({ ok: true });
}

function makeEvidence(over: Partial<DisputeEvidence>): DisputeEvidence {
  return {
    intentId: 'i1',
    authorizedUsd: 10,
    consumedUsd: 0,
    chainId: 2368,
    payTo: PAYTO,
    sellerRef: 'reg/agent',
    voucherCount: 0,
    vouchersTotalUsd: 0,
    proofChainOk: true,
    receiptSettleTotalUsd: null,
    ...over,
  };
}

// ── DB in-memory fiel (open_dispute + arb close + record/finalize) ──
interface FakeRow {
  status: string;
  intent_type: 'session';
  authorized_usd: number;
  consumed_usd: number;
  chain_id: number;
  pay_to: string;
  seller_ref: string;
  key_id: string;
  settle_tx_hash: string | null;
  settle_outcome: string | null;
  error_message: string | null;
  expires_at: string;
}

function makeArbDb(init: {
  authorized_usd: number;
  consumed_usd?: number;
  status?: string;
  chain_id?: number;
}): {
  row: FakeRow;
  refunds: number[];
  arbRows: Record<string, unknown>[];
  state: { failFinalize: number };
  handlers: Record<string, RpcHandler>;
  fromImpl: (table: string) => unknown;
} {
  const row: FakeRow = {
    status: init.status ?? 'open',
    intent_type: 'session',
    authorized_usd: init.authorized_usd,
    consumed_usd: init.consumed_usd ?? 0,
    chain_id: init.chain_id ?? 2368,
    pay_to: PAYTO,
    seller_ref: 'reg/agent',
    key_id: 'k1',
    settle_tx_hash: null,
    settle_outcome: null,
    error_message: null,
    expires_at: '2026-07-05T00:00:00.000Z',
  };
  const refunds: number[] = [];
  const arbRows: Record<string, unknown>[] = [];
  const state = { failFinalize: 0 };

  const snapshot = (prev: string, final: number) => ({
    data: [
      {
        final_amount: final,
        prev_status: prev,
        intent_type: row.intent_type,
        key_id: row.key_id,
        chain_id: row.chain_id,
        pay_to: row.pay_to,
        authorized_usd: row.authorized_usd,
        consumed_usd: row.consumed_usd,
        settle_tx_hash: row.settle_tx_hash,
        settle_outcome: row.settle_outcome,
      },
    ],
    error: null,
  });

  const handlers: Record<string, RpcHandler> = {
    open_dispute: () => {
      if (row.status !== 'open') {
        return {
          data: null,
          error: { message: `INTENT_NOT_OPEN: intent i1 is ${row.status}` },
        };
      }
      row.status = 'disputed';
      return {
        data: [
          {
            intent_type: row.intent_type,
            key_id: row.key_id,
            chain_id: row.chain_id,
            pay_to: row.pay_to,
            seller_ref: row.seller_ref,
            authorized_usd: row.authorized_usd,
            consumed_usd: row.consumed_usd,
            expires_at: row.expires_at,
          },
        ],
        error: null,
      };
    },
    close_payment_intent_for_arbitration: (args) => {
      const prev = row.status;
      let final = 0;
      if (row.status === 'disputed') {
        const arb = Math.max(
          0,
          Math.min(row.authorized_usd, Number(args.p_arb_amount) || 0),
        );
        row.consumed_usd = arb;
        row.status = 'arb_closing';
        final = arb;
      } else if (row.status === 'arb_closing') {
        final = row.consumed_usd; // recovery: lee persistido
      } else {
        return {
          data: null,
          error: { message: `INTENT_NOT_OPEN: intent i1 is ${row.status}` },
        };
      }
      return snapshot(prev, final);
    },
    close_payment_intent_for_settle: () => {
      const prev = row.status;
      let final = 0;
      if (row.status === 'open') {
        final = Math.min(row.consumed_usd, row.authorized_usd);
        row.status = 'closing';
      }
      return snapshot(prev, final);
    },
    record_settle_outcome: (args) => {
      // gate ensanchado (Option B): anota mientras closing/arb_closing.
      if (row.status === 'closing' || row.status === 'arb_closing') {
        row.settle_outcome = String(args.p_outcome);
        if (args.p_tx_hash != null) row.settle_tx_hash = String(args.p_tx_hash);
        row.error_message = (args.p_error as string) ?? row.error_message;
      }
      return { error: null };
    },
    finalize_payment_intent: (args) => {
      if (state.failFinalize > 0) {
        state.failFinalize -= 1;
        return { error: { message: 'db blip' } };
      }
      // gate ensanchado (Option B): idempotente fuera de closing/arb_closing.
      if (row.status !== 'closing' && row.status !== 'arb_closing') {
        return { error: null };
      }
      const outcome = String(args.p_outcome);
      if (outcome === 'settled') {
        row.status = 'settled';
        row.settle_outcome = 'settled';
        if (args.p_tx_hash != null) row.settle_tx_hash = String(args.p_tx_hash);
        if (args.p_residual != null && Number(args.p_residual) > 0) {
          refunds.push(Number(args.p_residual)); // credit-back residual (session)
        }
      } else if (outcome === 'failed_unequivocal') {
        row.status = 'refunded';
        row.settle_outcome = 'failed_unequivocal';
        row.error_message = (args.p_error as string) ?? row.error_message;
        if (row.authorized_usd > 0) refunds.push(row.authorized_usd); // deposit completo
      } else {
        row.status = 'failed';
        row.settle_outcome = 'failed_ambiguous';
        row.error_message = (args.p_error as string) ?? row.error_message;
      }
      return { error: null };
    },
  };

  // from() fiel para el arb_hold update + a2a_arbitrations upsert.
  const fromImpl = (table: string) => {
    const b: {
      _op: string | null;
      _vals: Record<string, unknown> | null;
      _conds: Record<string, unknown>;
      update: (v: Record<string, unknown>) => typeof b;
      upsert: (v: Record<string, unknown>) => typeof b;
      eq: (c: string, v: unknown) => typeof b;
      then: (resolve: (r: { error: null }) => void) => void;
    } = {
      _op: null,
      _vals: null,
      _conds: {},
      update(v) {
        b._op = 'update';
        b._vals = v;
        return b;
      },
      upsert(v) {
        b._op = 'upsert';
        b._vals = v;
        return b;
      },
      eq(c, v) {
        b._conds[c] = v;
        return b;
      },
      // biome-ignore lint/suspicious/noThenProperty: awaitable supabase builder test double
      then(resolve) {
        if (table === 'a2a_payment_intents' && b._op === 'update') {
          // arb_hold: sólo aplica si el status actual matchea el guard.
          if (row.status === b._conds.status && b._vals) {
            row.status = String(b._vals.status);
          }
        } else if (table === 'a2a_arbitrations' && b._op === 'upsert') {
          if (b._vals) arbRows.push(b._vals);
        }
        resolve({ error: null });
      },
    };
    return b;
  };

  return { row, refunds, arbRows, state, handlers, fromImpl };
}

function wireDb(db: ReturnType<typeof makeArbDb>): void {
  mockRpc.mockImplementation((name: string, args?: Record<string, unknown>) => {
    const h = db.handlers[name];
    const res = h ? h(args ?? {}) : { data: null, error: null };
    // biome-ignore lint/suspicious/noExplicitAny: test double for supabase builder
    return Promise.resolve(res) as any;
  });
  // biome-ignore lint/suspicious/noExplicitAny: test double for supabase builder
  mockFrom.mockImplementation(db.fromImpl as any);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerify.mockResolvedValue({ ok: true });
  mockEmit.mockResolvedValue(undefined);
  process.env.ARBITER_ENABLED = 'true';
  delete process.env.ARBITER_AUTO_CAP_USD;
});

// ── AC-1: rules inequívoco (consumed==0 → refund, SIN LLM) ──────
describe('AC-1 rules inequívoco', () => {
  it('consumed==0 → refund, sin invocar LLM, recibo arbitration_refund, deposit al buyer', async () => {
    happySettle();
    const db = makeArbDb({ authorized_usd: 10, consumed_usd: 0 });
    wireDb(db);
    mockReadEvidence.mockResolvedValue(makeEvidence({ consumedUsd: 0 }));

    const r = await arbiterService.openDispute('i1', OWNER);

    expect(r.decision).toBe('refund');
    expect(r.method).toBe('rules');
    expect(mockClassifyAmbiguous).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled(); // refund total: sin tx on-chain
    expect(db.refunds).toEqual([10]); // deposit completo al buyer
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ receiptType: 'arbitration_refund' }),
    );
    expect(db.row.status).toBe('settled');
  });
});

// ── AC-3: release / split / refund → settle+residual correctos ──
describe('AC-3 ejecución de desenlaces', () => {
  it('release (consumed>=deposit) → settle=deposit al seller, residual 0', async () => {
    happySettle();
    const db = makeArbDb({ authorized_usd: 10 });
    wireDb(db);
    mockReadEvidence.mockResolvedValue(
      makeEvidence({ consumedUsd: 10, voucherCount: 2, vouchersTotalUsd: 10 }),
    );

    const r = await arbiterService.openDispute('i1', OWNER);

    expect(r.decision).toBe('release');
    expect(r.settleUsd).toBe(10);
    expect(r.residualUsd).toBe(0);
    expect(mockSettle).toHaveBeenCalledTimes(1);
    const signVal = mockSign.mock.calls[0]?.[0] as { value: string };
    expect(signVal.value).toBe('10000000000000000000'); // 10 USD → 18 dec
    expect(db.refunds).toEqual([]); // residual 0 → sin refund
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ receiptType: 'arbitration_release' }),
    );
  });

  it('split (0<consumed<deposit) → settle=consumed, residual=deposit-consumed al buyer', async () => {
    happySettle();
    const db = makeArbDb({ authorized_usd: 10 });
    wireDb(db);
    mockReadEvidence.mockResolvedValue(
      makeEvidence({
        consumedUsd: 3.7,
        voucherCount: 2,
        vouchersTotalUsd: 3.7,
      }),
    );

    const r = await arbiterService.openDispute('i1', OWNER);

    expect(r.decision).toBe('split');
    expect(r.settleUsd).toBeCloseTo(3.7, 8);
    expect(r.residualUsd).toBeCloseTo(6.3, 8);
    expect(mockSettle).toHaveBeenCalledTimes(1);
    expect(db.refunds[0]).toBeCloseTo(6.3, 8); // residual al buyer, 1 vez
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ receiptType: 'arbitration_split' }),
    );
  });
});

// ── AC-2/AC-3: ambiguo → LLM acotado → ejecuta con llm_reasoning ─
describe('AC-2 escalado a LLM acotado', () => {
  it('ambiguo → classifyAmbiguous(split 50%) → ejecuta, method llm, fila con llm_reasoning', async () => {
    happySettle();
    const db = makeArbDb({ authorized_usd: 10 });
    wireDb(db);
    mockReadEvidence.mockResolvedValue(
      makeEvidence({ proofChainOk: false, consumedUsd: 5, voucherCount: 2 }),
    );
    mockClassifyAmbiguous.mockResolvedValue({
      decision: 'split',
      splitPct: 50,
      reasoning: 'partial delivery per on-chain evidence',
    });

    const r = await arbiterService.openDispute('i1', OWNER);

    expect(mockClassifyAmbiguous).toHaveBeenCalledTimes(1);
    expect(r.method).toBe('llm');
    expect(r.decision).toBe('split');
    expect(r.settleUsd).toBe(5); // 10 * 50%
    expect(r.llmReasoning).toBe('partial delivery per on-chain evidence');
    expect(mockSettle).toHaveBeenCalledTimes(1);
    expect(db.arbRows[0]).toMatchObject({
      method: 'llm',
      llm_reasoning: 'partial delivery per on-chain evidence',
      status: 'executed',
    });
  });
});

// ── AC-2/AC-6: LLM null (breaker/timeout) → arb_hold, cero fondos ─
describe('AC-6 fail-closed (LLM null → hold)', () => {
  it('ambiguo + classifyAmbiguous null → arb_hold, recibo arbitration_hold, CERO fondos', async () => {
    happySettle();
    const db = makeArbDb({ authorized_usd: 10 });
    wireDb(db);
    mockReadEvidence.mockResolvedValue(
      makeEvidence({ proofChainOk: false, consumedUsd: 5, voucherCount: 2 }),
    );
    mockClassifyAmbiguous.mockResolvedValue(null); // breaker/timeout/invalid

    const r = await arbiterService.openDispute('i1', OWNER);

    expect(r.status).toBe('held');
    expect(r.decision).toBe('hold');
    expect(r.settleUsd).toBe(0);
    expect(mockSettle).not.toHaveBeenCalled(); // CERO fondos
    expect(db.refunds).toEqual([]);
    expect(db.row.status).toBe('arb_hold');
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        receiptType: 'arbitration_hold',
        amountUsd: 0,
      }),
    );
    expect(db.arbRows[0]).toMatchObject({ decision: 'hold', status: 'held' });
  });
});

// ── AC-6: sobre-tope → arb_hold, NO settle (aún con rules inequívoco) ─
describe('AC-6 sobre-tope (cap gate)', () => {
  it('at_stake > cap → arb_hold + recibo, NO settle, con decisión rules inequívoca', async () => {
    happySettle();
    const db = makeArbDb({ authorized_usd: 100 }); // deposit 100 > cap default 25
    wireDb(db);
    mockReadEvidence.mockResolvedValue(
      makeEvidence({
        authorizedUsd: 100,
        consumedUsd: 100,
        voucherCount: 3,
        vouchersTotalUsd: 100,
      }),
    );

    const r = await arbiterService.openDispute('i1', OWNER);

    expect(r.status).toBe('held');
    expect(r.atStakeUsd).toBe(100);
    expect(mockSettle).not.toHaveBeenCalled(); // NO settle pese a release inequívoco
    expect(db.refunds).toEqual([]);
    expect(db.row.status).toBe('arb_hold');
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ receiptType: 'arbitration_hold' }),
    );
  });

  it('cap configurable por env: ARBITER_AUTO_CAP_USD=200 permite ejecutar deposit 100', async () => {
    happySettle();
    process.env.ARBITER_AUTO_CAP_USD = '200';
    const db = makeArbDb({ authorized_usd: 100 });
    wireDb(db);
    mockReadEvidence.mockResolvedValue(
      makeEvidence({
        authorizedUsd: 100,
        consumedUsd: 100,
        voucherCount: 3,
        vouchersTotalUsd: 100,
      }),
    );

    const r = await arbiterService.openDispute('i1', OWNER);
    expect(r.status).toBe('executed');
    expect(mockSettle).toHaveBeenCalledTimes(1);
  });
});

// ── AC-4: anti-race doble-settle (disputed bloquea closeSession) ─
describe('AC-4 anti-race doble-settle', () => {
  it('intent disputed → closeSession normal ve prev_status disputed → INTENT_NOT_OPEN, NO settlea', async () => {
    happySettle();
    // El intent ya está en disputa (open_dispute ganó el row-lock).
    const db = makeArbDb({
      authorized_usd: 10,
      consumed_usd: 4,
      status: 'disputed',
    });
    wireDb(db);

    await expect(
      paymentIntentService.closeSession('i1', OWNER),
    ).rejects.toMatchObject({ code: 'INTENT_NOT_OPEN' });
    // El cierre normal NO settlea el intent en disputa (doble-settle imposible).
    expect(mockSettle).not.toHaveBeenCalled();
    expect(db.refunds).toEqual([]);
  });

  it('open_dispute sobre intent NO-open → INTENT_NOT_OPEN (el perdedor del row-lock aborta)', async () => {
    const db = makeArbDb({ authorized_usd: 10, status: 'closing' });
    wireDb(db);
    await expect(arbiterService.openDispute('i1', OWNER)).rejects.toMatchObject(
      { code: 'INTENT_NOT_OPEN' },
    );
  });
});

// ── exactly-once: finalize re-invocada (recovery) → settle/refund 1× ─
describe('exactly-once (recovery idempotente)', () => {
  it('split ejecutado + recoverArbClosing 2× → refund del residual EXACTAMENTE una vez, settle 1×', async () => {
    happySettle();
    const db = makeArbDb({ authorized_usd: 10 });
    wireDb(db);
    mockReadEvidence.mockResolvedValue(
      makeEvidence({ consumedUsd: 4, voucherCount: 2, vouchersTotalUsd: 4 }),
    );

    // 1ª ejecución: split settle 4, residual 6 refundado.
    const r1 = await arbiterService.openDispute('i1', OWNER);
    expect(r1.status).toBe('executed');
    expect(db.refunds).toEqual([6]);
    expect(db.row.status).toBe('settled');

    // recovery 2× (barrido/retry): finalize idempotente no-op → sin doble-refund.
    await arbiterService.recoverArbClosing('i1', OWNER, true);
    await arbiterService.recoverArbClosing('i1', OWNER, true);
    expect(db.refunds).toEqual([6]); // jamás dos veces
    expect(mockSettle).toHaveBeenCalledTimes(1); // NO re-settle
  });

  it('settle OK + finalize blip → executed (dinero on-chain); recovery re-acredita el residual una vez', async () => {
    happySettle();
    const db = makeArbDb({ authorized_usd: 10 });
    db.state.failFinalize = 1; // el 1er finalize hace blip
    wireDb(db);
    mockReadEvidence.mockResolvedValue(
      makeEvidence({ consumedUsd: 4, voucherCount: 2, vouchersTotalUsd: 4 }),
    );

    // settle on-chain OK, record 'settled' OK, finalize BLIP. El dinero YA se movió
    // on-chain → executed; el residual aún no acreditado (huérfano arb_closing),
    // igual que closeSession (settled branch NO lanza INTERNAL).
    const r1 = await arbiterService.openDispute('i1', OWNER);
    expect(r1.status).toBe('executed');
    expect(db.refunds).toEqual([]);
    expect(db.row.status).toBe('arb_closing');
    expect(db.row.settle_outcome).toBe('settled');

    // recovery: finalize idempotente → residual acreditado una sola vez.
    await arbiterService.recoverArbClosing('i1', OWNER, true);
    expect(db.refunds).toEqual([6]);
    await arbiterService.recoverArbClosing('i1', OWNER, true);
    expect(db.refunds).toEqual([6]); // terminal, sin doble-refund
    expect(mockSettle).toHaveBeenCalledTimes(1);
  });

  it('settle unequivocal fail + finalize blip → INTERNAL; recovery refunda el deposit una vez', async () => {
    mockSign.mockResolvedValue({
      paymentRequest: {
        authorization: { value: '1' },
        signature: '0xsig',
        network: 'kite',
      },
    });
    mockSettle.mockResolvedValue({ txHash: '', success: false, error: 'boom' });
    mockVerify.mockResolvedValue({ ok: true });
    const db = makeArbDb({ authorized_usd: 10 });
    db.state.failFinalize = 1;
    wireDb(db);
    mockReadEvidence.mockResolvedValue(
      makeEvidence({ consumedUsd: 10, voucherCount: 2, vouchersTotalUsd: 10 }),
    );

    // release, settle inequívoco falla → record failed_unequivocal, finalize BLIP → INTERNAL.
    await expect(arbiterService.openDispute('i1', OWNER)).rejects.toMatchObject(
      { code: 'INTERNAL' },
    );
    expect(db.refunds).toEqual([]);
    expect(db.row.status).toBe('arb_closing');
    expect(db.row.settle_outcome).toBe('failed_unequivocal');

    // recovery: finalize idempotente → refund del deposit COMPLETO una sola vez.
    await arbiterService.recoverArbClosing('i1', OWNER, true);
    expect(db.refunds).toEqual([10]);
    await arbiterService.recoverArbClosing('i1', OWNER, true);
    expect(db.refunds).toEqual([10]); // terminal, sin doble-refund
    expect(mockSettle).toHaveBeenCalledTimes(1);
  });
});

// ── AC-3 fail-closed: settle on-chain falla (unequivocal / ambiguous) ─
describe('AC-3 fail-closed settle on-chain', () => {
  it('settle unequivocal fail (release) → refund del deposit COMPLETO al buyer', async () => {
    mockSign.mockResolvedValue({
      paymentRequest: {
        authorization: { value: '1' },
        signature: '0xsig',
        network: 'kite',
      },
    });
    mockSettle.mockResolvedValue({ txHash: '', success: false, error: 'boom' });
    mockVerify.mockResolvedValue({ ok: true });
    const db = makeArbDb({ authorized_usd: 10 });
    wireDb(db);
    mockReadEvidence.mockResolvedValue(
      makeEvidence({ consumedUsd: 10, voucherCount: 2, vouchersTotalUsd: 10 }),
    );

    const r = await arbiterService.openDispute('i1', OWNER);
    expect(r.status).toBe('executed');
    expect(db.refunds).toEqual([10]); // deposit completo (herencia BLQ-ALTO-1)
    expect(db.row.status).toBe('refunded');
  });

  it('settle ambiguous (verify contradice) → RECONCILE, NO refund + warn', async () => {
    happySettle();
    mockVerify.mockResolvedValue({ ok: false, reason: 'AMOUNT_MISMATCH' });
    const db = makeArbDb({ authorized_usd: 10 });
    wireDb(db);
    mockReadEvidence.mockResolvedValue(
      makeEvidence({ consumedUsd: 10, voucherCount: 2, vouchersTotalUsd: 10 }),
    );

    const r = await arbiterService.openDispute('i1', OWNER);
    expect(r.status).toBe('executed');
    expect(db.refunds).toEqual([]); // ambiguo → NO refund (evita doble-gasto)
    expect(db.row.status).toBe('failed');
    expect(String(db.row.error_message)).toMatch(/^RECONCILE:/);
    expect(logSpy.warn).toHaveBeenCalled();
  });
});

// ── AC-5: chain mainnet → CHAIN_NOT_SUPPORTED, cero fondos ───────
describe('AC-5 testnet-only (fail-closed)', () => {
  it.each([
    43114, 8453,
  ])('chain mainnet %i → CHAIN_NOT_SUPPORTED, cero fondos', async (chainId) => {
    happySettle();
    const db = makeArbDb({ authorized_usd: 10, chain_id: chainId });
    wireDb(db);
    mockReadEvidence.mockResolvedValue(makeEvidence({ chainId }));

    await expect(arbiterService.openDispute('i1', OWNER)).rejects.toMatchObject(
      { code: 'CHAIN_NOT_SUPPORTED' },
    );
    expect(mockSettle).not.toHaveBeenCalled();
    expect(db.refunds).toEqual([]);
  });

  it.each([
    2368, 43113, 84532,
  ])('chain testnet %i → permitido (allowlist)', async (chainId) => {
    happySettle();
    const db = makeArbDb({ authorized_usd: 10, chain_id: chainId });
    wireDb(db);
    mockReadEvidence.mockResolvedValue(
      makeEvidence({ chainId, consumedUsd: 0 }),
    );
    const r = await arbiterService.openDispute('i1', OWNER);
    expect(r.status).toBe('executed'); // refund total, sin chain rejection
  });
});

// ── CD-2: ownership guard ────────────────────────────────────────
describe('CD-2 ownership guard', () => {
  it('dispute sobre intent de otro owner → OWNERSHIP_MISMATCH', async () => {
    const db = makeArbDb({ authorized_usd: 10 });
    // open_dispute con owner mismatch → el RPC lanza OWNERSHIP_MISMATCH.
    db.handlers.open_dispute = () => ({
      data: null,
      error: { message: 'OWNERSHIP_MISMATCH: intent i1 not owned by caller' },
    });
    wireDb(db);
    await expect(
      arbiterService.openDispute('i1', 'tenant-B'),
    ).rejects.toMatchObject({ code: 'OWNERSHIP_MISMATCH' });
    expect(mockSettle).not.toHaveBeenCalled();
  });
});

// ── AC-7: flag OFF byte-idéntico (route 404 + closeSession inerte) ─
describe('AC-7 flag OFF byte-idéntico', () => {
  async function buildApp(): Promise<ReturnType<typeof Fastify>> {
    const app = Fastify();
    await app.register(paymentsRoutes, { prefix: '/payments' });
    await app.ready();
    return app;
  }

  it('ARBITER_ENABLED off → POST /session/:id/dispute → 404 (ruta no existe)', async () => {
    delete process.env.ARBITER_ENABLED;
    mockResolveCallerKey.mockResolvedValue({
      is_active: true,
      owner_ref: OWNER,
      funding_wallet: '0xabc',
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/payments/session/i1/dispute',
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    // El gate es lo primero: ni siquiera se consultó la caller key.
    expect(mockResolveCallerKey).not.toHaveBeenCalled();
    await app.close();
  });

  it('ARBITER_ENABLED off → GET /session/:id/dispute → 404', async () => {
    delete process.env.ARBITER_ENABLED;
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/payments/session/i1/dispute',
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('flag OFF → closeSession de un intent open normal se comporta idéntico (guarda inerte)', async () => {
    delete process.env.ARBITER_ENABLED;
    happySettle();
    const db = makeArbDb({ authorized_usd: 10, consumed_usd: 4 });
    wireDb(db);
    // Un intent 'open' normal jamás alcanza disputed/arb_* con el flag OFF; la
    // guarda nueva es rama muerta → el cierre settlea igual que antes de WKH-139.
    const r = await paymentIntentService.closeSession('i1', OWNER);
    expect(r.status).toBe('settled');
    expect(mockSettle).toHaveBeenCalledTimes(1);
    expect(db.refunds).toEqual([6]); // residual 10-4 al buyer, idéntico
  });
});

// ── Route (flag ON): POST /dispute mapea el outcome + errores ────
describe('route dispute (flag ON)', () => {
  async function buildApp(): Promise<ReturnType<typeof Fastify>> {
    const app = Fastify();
    await app.register(paymentsRoutes, { prefix: '/payments' });
    await app.ready();
    return app;
  }

  it('POST /session/:id/dispute → 200 con el outcome', async () => {
    happySettle();
    mockResolveCallerKey.mockResolvedValue({
      is_active: true,
      owner_ref: OWNER,
      funding_wallet: '0xabc',
    });
    const db = makeArbDb({ authorized_usd: 10, consumed_usd: 0 });
    wireDb(db);
    mockReadEvidence.mockResolvedValue(makeEvidence({ consumedUsd: 0 }));
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/payments/session/i1/dispute',
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().decision).toBe('refund');
    await app.close();
  });

  it('INTENT_NOT_OPEN → 409 (disclosure-safe)', async () => {
    mockResolveCallerKey.mockResolvedValue({
      is_active: true,
      owner_ref: OWNER,
      funding_wallet: '0xabc',
    });
    const db = makeArbDb({ authorized_usd: 10, status: 'closing' });
    wireDb(db);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/payments/session/i1/dispute',
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error_code).toBe('INTENT_NOT_OPEN');
    await app.close();
  });
});
