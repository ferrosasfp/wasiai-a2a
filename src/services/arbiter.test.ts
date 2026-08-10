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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
// WKH-191g: getDefaultChainKey/getAdaptersBundle sólo se consultan con el flag ON;
// con el flag OFF (default de la suite) el árbitro jamás los invoca (byte-idéntico).
const mockGetDefaultChainKey = vi.hoisted(() =>
  vi.fn((..._a: unknown[]): string | null => 'kite'),
);
const mockGetAdaptersBundle = vi.hoisted(() =>
  vi.fn((..._a: unknown[]) => ({
    payment: { supportedTokens: [{ decimals: 6 }] },
  })),
);
vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: () => ({ sign: mockSign, settle: mockSettle }),
  getChainConfig: () => ({ name: 'kite', chainId: 2368, explorerUrl: '' }),
  getDefaultChainKey: (...a: unknown[]) => mockGetDefaultChainKey(...a),
  getAdaptersBundle: (...a: unknown[]) => mockGetAdaptersBundle(...a),
}));

// WKH-191g: escrow-verifier (readArbitrationConsent/resolveEscrowContract) — sólo
// consultados con el flag ON. deriveArbiterNonce del executor se preserva REAL.
const mockReadConsent = vi.hoisted(() =>
  vi.fn((..._a: unknown[]): Promise<boolean> => Promise.resolve(false)),
);
const mockResolveEscrow = vi.hoisted(() =>
  vi.fn((..._a: unknown[]): string | null => null),
);
vi.mock('../adapters/escrow-verifier.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../adapters/escrow-verifier.js')>()),
  readArbitrationConsent: (...a: unknown[]) => mockReadConsent(...a),
  resolveEscrowContract: (...a: unknown[]) => mockResolveEscrow(...a),
}));

const mockExecResolve = vi.hoisted(() => vi.fn());
const mockExecLock = vi.hoisted(() => vi.fn());
const mockExecRelease = vi.hoisted(() => vi.fn());
vi.mock('../adapters/escrow/arbiter-executor.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../adapters/escrow/arbiter-executor.js')
  >()),
  executeResolveDispute: (...a: unknown[]) => mockExecResolve(...a),
  executeLockForDispute: (...a: unknown[]) => mockExecLock(...a),
  executeReleaseDispute: (...a: unknown[]) => mockExecRelease(...a),
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

import { keccak256, parseUnits, stringToBytes } from 'viem';
import { deriveArbiterNonce } from '../adapters/escrow/arbiter-executor.js';
import { supabase } from '../lib/supabase.js';
import { paymentsRoutes } from '../routes/payments.js';
import { ArbiterError, type DisputeEvidence } from '../types/arbiter.js';
import { arbiterService, settleArbitrationOnChain } from './arbiter.js';
import { paymentIntentService } from './payment-intent.js';

const ESCROW_ADDR =
  '0x7777777777777777777777777777777777777777' as `0x${string}`;

// WKH-194: secreto de test (≥32 chars) para el nonce del árbitro.
// Alta entropía (≥16 caracteres únicos) para pasar el guard de entropía de
// getArbiterNonceSecret (AR MNR-1): espeja `openssl rand -hex 32` (64 hex chars).
const TEST_SECRET = '0123456789abcdef'.repeat(4);

const mockRpc = vi.mocked(supabase.rpc);
const mockFrom = vi.mocked(supabase.from);

const OWNER = 'tenant-A';

/**
 * El id del intent que conoce el falso de la base (`:_conds.id` en `makeArbDb`).
 *
 * WKH-345: tiene forma de UUID porque `a2a_payment_intents.id` ES una columna
 * `uuid`, y porque cuatro de estos fixtures se inyectan por HTTP contra
 * `POST /payments/session/:id/dispute`, que ahora valida la forma en el borde.
 * Con el `'i1'` anterior esas cuatro URLs cruzaban el guard por accidente.
 */
const INTENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
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
    intentId: INTENT_ID,
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
  owner_ref: string;
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
  owner_ref?: string;
  // WKH-196 T-NEW-5: preset del nonce ya persistido (read-first HIT directo).
  nonceStore?: string;
}): {
  row: FakeRow;
  refunds: number[];
  arbRows: Record<string, unknown>[];
  state: { failFinalize: number };
  handlers: Record<string, RpcHandler>;
  fromImpl: (table: string) => unknown;
  // WKH-196 T-NEW-4: cols pasadas al .select() de a2a_arbiter_nonces (capturable).
  nonceSelectCols: () => string | null;
} {
  const row: FakeRow = {
    status: init.status ?? 'open',
    intent_type: 'session',
    owner_ref: init.owner_ref ?? OWNER,
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
  // WKH-194: store del nonce persistido (first-writer-wins). null = miss.
  let nonceStore: { nonce: string } | null =
    init.nonceStore != null ? { nonce: init.nonceStore } : null;
  // WKH-196: cols capturadas del .select() sobre a2a_arbiter_nonces (dentro del
  // closure — sin símbolo top-level nuevo consumido por la factory vi.mock, CD-8).
  let nonceSelectCols: string | null = null;

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
    // WKH-194: get_or_create_arbiter_nonce first-writer-wins. El PRIMER writer
    // persiste su candidate; un writer posterior lee el ya persistido (idéntico al
    // ON CONFLICT DO NOTHING + re-SELECT del RPC real).
    get_or_create_arbiter_nonce: (args) => {
      if (nonceStore === null) nonceStore = { nonce: String(args.p_nonce) };
      return { data: [{ persisted_nonce: nonceStore.nonce }], error: null };
    },
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
      // WKH-189: predicado ensanchado (FIEL a la migración) — arb_hold entra por la
      // MISMA rama que disputed (transición a arb_closing persistiendo el monto).
      if (row.status === 'disputed' || row.status === 'arb_hold') {
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

  // from() fiel para el pre-check select + arb_hold update + a2a_arbitrations upsert.
  const fromImpl = (table: string) => {
    const b: {
      _op: string | null;
      _vals: Record<string, unknown> | null;
      _conds: Record<string, unknown>;
      select: (cols: string) => typeof b;
      update: (v: Record<string, unknown>) => typeof b;
      upsert: (v: Record<string, unknown>) => typeof b;
      eq: (c: string, v: unknown) => typeof b;
      maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
      then: (resolve: (r: { error: null }) => void) => void;
    } = {
      _op: null,
      _vals: null,
      _conds: {},
      select(cols) {
        b._op = 'select';
        // WKH-196: capturá el arg del select del read-first del nonce (CD-8).
        if (table === 'a2a_arbiter_nonces') nonceSelectCols = cols;
        return b;
      },
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
      // Pre-check openDispute: SELECT owner_ref, chain_id FROM a2a_payment_intents
      // WHERE id = ?. Devuelve la fila autoritativa (owner-check en app). null si el id
      // no matchea el de la db (intent inexistente → INTENT_NOT_FOUND).
      maybeSingle() {
        // WKH-194: read-first del nonce persistido (owner-guarded). null = miss.
        if (table === 'a2a_arbiter_nonces') {
          return Promise.resolve({ data: nonceStore, error: null });
        }
        if (table === 'a2a_payment_intents' && b._conds.id !== INTENT_ID) {
          return Promise.resolve({ data: null, error: null });
        }
        // WKH-189: resolveHold lee la fila a2a_arbitrations original (best-effort)
        // para preservar ambiguity_reason/llm_reasoning. Devolvemos el último upsert
        // (o null si no hay arbitraje persistido).
        if (table === 'a2a_arbitrations') {
          const last = arbRows[arbRows.length - 1];
          return Promise.resolve({
            data: last
              ? {
                  ambiguity_reason: (last.ambiguity_reason as string) ?? null,
                  llm_reasoning: (last.llm_reasoning as string) ?? null,
                }
              : null,
            error: null,
          });
        }
        // a2a_payment_intents: fila autoritativa (openDispute pre-check lee
        // owner_ref/chain_id; resolveHold lee además status/authorized_usd/seller_ref).
        return Promise.resolve({
          data: {
            owner_ref: row.owner_ref,
            chain_id: row.chain_id,
            status: row.status,
            authorized_usd: row.authorized_usd,
            seller_ref: row.seller_ref,
          },
          error: null,
        });
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

  return {
    row,
    refunds,
    arbRows,
    state,
    handlers,
    fromImpl,
    nonceSelectCols: () => nonceSelectCols,
  };
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
  // WKH-191g: flag OFF por defecto → árbitro byte-idéntico al de hoy.
  delete process.env.ESCROW_ARBITER_ENABLED;
  // WKH-194: sin secreto por defecto (fail-closed). Los tests ON lo setean.
  delete process.env.ARBITER_NONCE_SECRET;
  mockGetDefaultChainKey.mockReturnValue('kite');
  mockGetAdaptersBundle.mockReturnValue({
    payment: { supportedTokens: [{ decimals: 6 }] },
  });
  mockResolveEscrow.mockReturnValue(null);
  mockReadConsent.mockResolvedValue(false);
  mockExecResolve.mockResolvedValue({
    kind: 'confirmed',
    txHash: '0xESCROWTX',
    blockNumber: 1n,
  });
  mockExecLock.mockResolvedValue({
    kind: 'confirmed',
    txHash: '0xLOCKTX',
    blockNumber: 1n,
  });
  mockExecRelease.mockResolvedValue({
    kind: 'confirmed',
    txHash: '0xRELEASETX',
    blockNumber: 1n,
  });
});

// ── AC-1: rules inequívoco (consumed==0 → refund, SIN LLM) ──────
describe('AC-1 rules inequívoco', () => {
  it('consumed==0 → refund, sin invocar LLM, recibo arbitration_refund, deposit al buyer', async () => {
    happySettle();
    const db = makeArbDb({ authorized_usd: 10, consumed_usd: 0 });
    wireDb(db);
    mockReadEvidence.mockResolvedValue(makeEvidence({ consumedUsd: 0 }));

    const r = await arbiterService.openDispute(INTENT_ID, OWNER);

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

    const r = await arbiterService.openDispute(INTENT_ID, OWNER);

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

    const r = await arbiterService.openDispute(INTENT_ID, OWNER);

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

    const r = await arbiterService.openDispute(INTENT_ID, OWNER);

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

    const r = await arbiterService.openDispute(INTENT_ID, OWNER);

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

    const r = await arbiterService.openDispute(INTENT_ID, OWNER);

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

    const r = await arbiterService.openDispute(INTENT_ID, OWNER);
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
      paymentIntentService.closeSession(INTENT_ID, OWNER),
    ).rejects.toMatchObject({ code: 'INTENT_NOT_OPEN' });
    // El cierre normal NO settlea el intent en disputa (doble-settle imposible).
    expect(mockSettle).not.toHaveBeenCalled();
    expect(db.refunds).toEqual([]);
  });

  it('open_dispute sobre intent NO-open → INTENT_NOT_OPEN (el perdedor del row-lock aborta)', async () => {
    const db = makeArbDb({ authorized_usd: 10, status: 'closing' });
    wireDb(db);
    await expect(
      arbiterService.openDispute(INTENT_ID, OWNER),
    ).rejects.toMatchObject({ code: 'INTENT_NOT_OPEN' });
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
    const r1 = await arbiterService.openDispute(INTENT_ID, OWNER);
    expect(r1.status).toBe('executed');
    expect(db.refunds).toEqual([6]);
    expect(db.row.status).toBe('settled');

    // recovery 2× (barrido/retry): finalize idempotente no-op → sin doble-refund.
    await arbiterService.recoverArbClosing(INTENT_ID, OWNER, true);
    await arbiterService.recoverArbClosing(INTENT_ID, OWNER, true);
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
    const r1 = await arbiterService.openDispute(INTENT_ID, OWNER);
    expect(r1.status).toBe('executed');
    expect(db.refunds).toEqual([]);
    expect(db.row.status).toBe('arb_closing');
    expect(db.row.settle_outcome).toBe('settled');

    // recovery: finalize idempotente → residual acreditado una sola vez.
    await arbiterService.recoverArbClosing(INTENT_ID, OWNER, true);
    expect(db.refunds).toEqual([6]);
    await arbiterService.recoverArbClosing(INTENT_ID, OWNER, true);
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
    await expect(
      arbiterService.openDispute(INTENT_ID, OWNER),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(db.refunds).toEqual([]);
    expect(db.row.status).toBe('arb_closing');
    expect(db.row.settle_outcome).toBe('failed_unequivocal');

    // recovery: finalize idempotente → refund del deposit COMPLETO una sola vez.
    await arbiterService.recoverArbClosing(INTENT_ID, OWNER, true);
    expect(db.refunds).toEqual([10]);
    await arbiterService.recoverArbClosing(INTENT_ID, OWNER, true);
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

    const r = await arbiterService.openDispute(INTENT_ID, OWNER);
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

    const r = await arbiterService.openDispute(INTENT_ID, OWNER);
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

    await expect(
      arbiterService.openDispute(INTENT_ID, OWNER),
    ).rejects.toMatchObject({ code: 'CHAIN_NOT_SUPPORTED' });
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
    const r = await arbiterService.openDispute(INTENT_ID, OWNER);
    expect(r.status).toBe('executed'); // refund total, sin chain rejection
  });
});

// ── BLQ-BAJO-1: 'disputed' ya no es una trampa terminal irrecuperable ──
describe('BLQ-BAJO-1 disputed no-brick', () => {
  it('(a) dispute mainnet → CHAIN_NOT_SUPPORTED SIN transicionar; sigue open y closeSession normal funciona', async () => {
    happySettle();
    const db = makeArbDb({
      authorized_usd: 10,
      consumed_usd: 4,
      chain_id: 43114,
    });
    wireDb(db);
    mockReadEvidence.mockResolvedValue(makeEvidence({ chainId: 43114 }));

    await expect(
      arbiterService.openDispute(INTENT_ID, OWNER),
    ).rejects.toMatchObject({ code: 'CHAIN_NOT_SUPPORTED' });
    // Pre-check ANTES de transicionar: el intent NUNCA pasó a 'disputed'.
    expect(db.row.status).toBe('open');
    expect(mockSettle).not.toHaveBeenCalled();
    expect(db.refunds).toEqual([]);

    // No bricked: el settlement normal sigue disponible.
    const r = await paymentIntentService.closeSession(INTENT_ID, OWNER);
    expect(r.status).toBe('settled');
    expect(mockSettle).toHaveBeenCalledTimes(1);
    expect(db.refunds).toEqual([6]); // residual 10-4 al buyer
  });

  it('(b) throw post-transición (readEvidence tira) → revierte disputed→open; closeSession normal funciona', async () => {
    happySettle();
    const db = makeArbDb({ authorized_usd: 10, consumed_usd: 4 });
    wireDb(db);
    mockReadEvidence.mockRejectedValue(new ArbiterError('INTERNAL'));

    await expect(
      arbiterService.openDispute(INTENT_ID, OWNER),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    // Rollback best-effort: NO quedó bricked en 'disputed'.
    expect(db.row.status).toBe('open');
    expect(mockSettle).not.toHaveBeenCalled();
    expect(db.refunds).toEqual([]);

    // No bricked: closeSession normal procede tras el rollback.
    const r = await paymentIntentService.closeSession(INTENT_ID, OWNER);
    expect(r.status).toBe('settled');
    expect(mockSettle).toHaveBeenCalledTimes(1);
    expect(db.refunds).toEqual([6]);
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
      arbiterService.openDispute(INTENT_ID, 'tenant-B'),
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
      url: `/payments/session/${INTENT_ID}/dispute`,
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
      url: `/payments/session/${INTENT_ID}/dispute`,
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
    const r = await paymentIntentService.closeSession(INTENT_ID, OWNER);
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
      url: `/payments/session/${INTENT_ID}/dispute`,
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
      url: `/payments/session/${INTENT_ID}/dispute`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error_code).toBe('INTENT_NOT_OPEN');
    await app.close();
  });
});

// ════════════════════════════════════════════════════════════════════
// WKH-189 · Override humano admin-gated de intents en arb_hold (resolveHold)
// ════════════════════════════════════════════════════════════════════

// ── T-2 (AC-2): resolveHold(release) sobre arb_hold → settle al seller ──
describe('WKH-189 T-2 resolveHold(release) money-path', () => {
  it('release sobre arb_hold → settlea deposit al seller, arb_hold→arb_closing→settled', async () => {
    happySettle();
    const db = makeArbDb({ authorized_usd: 10, status: 'arb_hold' });
    wireDb(db);

    const r = await arbiterService.resolveHold(INTENT_ID, {
      decision: 'release',
      resolvedBy: 'admin-jane',
      note: null,
    });

    expect(r.status).toBe('executed');
    expect(r.decision).toBe('release');
    expect(r.method).toBe('admin_override');
    expect(r.settleUsd).toBe(10);
    expect(r.residualUsd).toBe(0);
    expect(r.txHash).toBe('0xTX');
    expect(mockSettle).toHaveBeenCalledTimes(1);
    expect(db.refunds).toEqual([]); // residual 0 → sin refund
    expect(db.row.status).toBe('settled');
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ receiptType: 'arbitration_release' }),
    );
  });
});

// ── T-3 (AC-3): persiste admin_override + auditoría, preserva evidencia ──
describe('WKH-189 T-3 persistencia de auditoría + preservación de evidencia', () => {
  it('override(split) persiste method/resolved_* y PRESERVA ambiguity/llm del hold original; recibo por decision', async () => {
    happySettle();
    const db = makeArbDb({ authorized_usd: 10, status: 'arb_hold' });
    // Fila de arbitraje original del hold (evidencia a preservar).
    db.arbRows.push({
      ambiguity_reason: 'proof_chain_tamper',
      llm_reasoning: 'seed reasoning',
      method: 'hold',
      status: 'held',
    });
    wireDb(db);

    const r = await arbiterService.resolveHold(INTENT_ID, {
      decision: 'split',
      splitPct: 50,
      resolvedBy: 'admin-jane',
      note: 'revisado manualmente',
    });

    expect(r.decision).toBe('split');
    expect(r.method).toBe('admin_override');
    expect(r.settleUsd).toBe(5); // 10 * 50%

    // El upsert nuevo es el último arbRow.
    const upserted = db.arbRows[db.arbRows.length - 1] as Record<
      string,
      unknown
    >;
    expect(upserted).toMatchObject({
      method: 'admin_override',
      decision: 'split',
      resolved_by: 'admin-jane',
      resolution_note: 'revisado manualmente',
      ambiguity_reason: 'proof_chain_tamper', // preservado del hold original
      llm_reasoning: 'seed reasoning', // preservado del hold original
      status: 'executed',
    });
    expect(typeof upserted.resolved_at).toBe('string');
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ receiptType: 'arbitration_split' }),
    );
  });
});

// ── T-4 (AC-4): intent inexistente / no-hold → error, cero settle ──
describe('WKH-189 T-4 guardas de estado', () => {
  it('intent inexistente → INTENT_NOT_FOUND, cero settle', async () => {
    happySettle();
    const db = makeArbDb({ authorized_usd: 10, status: 'arb_hold' });
    wireDb(db);
    await expect(
      arbiterService.resolveHold('no-existe', {
        decision: 'release',
        resolvedBy: null,
        note: null,
      }),
    ).rejects.toMatchObject({ code: 'INTENT_NOT_FOUND' });
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it('intent settled (no arb_hold) → INTENT_NOT_OPEN, cero settle', async () => {
    happySettle();
    const db = makeArbDb({ authorized_usd: 10, status: 'settled' });
    wireDb(db);
    await expect(
      arbiterService.resolveHold(INTENT_ID, {
        decision: 'release',
        resolvedBy: null,
        note: null,
      }),
    ).rejects.toMatchObject({ code: 'INTENT_NOT_OPEN' });
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it('intent open (no arb_hold) → INTENT_NOT_OPEN, cero settle', async () => {
    happySettle();
    const db = makeArbDb({ authorized_usd: 10, status: 'open' });
    wireDb(db);
    await expect(
      arbiterService.resolveHold(INTENT_ID, {
        decision: 'refund',
        resolvedBy: null,
        note: null,
      }),
    ).rejects.toMatchObject({ code: 'INTENT_NOT_OPEN' });
    expect(mockSettle).not.toHaveBeenCalled();
  });
});

// ── T-6 (AC-6): chain mainnet → CHAIN_NOT_SUPPORTED, cero fondos ──
describe('WKH-189 T-6 testnet-guard fail-closed', () => {
  it('arb_hold en chain mainnet → CHAIN_NOT_SUPPORTED, sin mover fondos', async () => {
    happySettle();
    const db = makeArbDb({
      authorized_usd: 10,
      status: 'arb_hold',
      chain_id: 1,
    });
    wireDb(db);
    await expect(
      arbiterService.resolveHold(INTENT_ID, {
        decision: 'release',
        resolvedBy: null,
        note: null,
      }),
    ).rejects.toMatchObject({ code: 'CHAIN_NOT_SUPPORTED' });
    expect(mockSettle).not.toHaveBeenCalled();
    expect(db.refunds).toEqual([]);
  });
});

// ── T-7 (AC-7/CD-9): SIN cap; clamp settleUsd a [0,deposit] ──
describe('WKH-189 T-7 sin cap (CD-9) + clamp [0,deposit]', () => {
  it('deposit 1000 > ARBITER_AUTO_CAP_USD=25 → ejecuta igual (sin cap), split clampa a [0,deposit]', async () => {
    happySettle();
    process.env.ARBITER_AUTO_CAP_USD = '25';
    const db = makeArbDb({ authorized_usd: 1000, status: 'arb_hold' });
    wireDb(db);

    const r = await arbiterService.resolveHold(INTENT_ID, {
      decision: 'split',
      splitPct: 50,
      resolvedBy: null,
      note: null,
    });
    expect(r.status).toBe('executed'); // NO held pese a deposit >> cap
    expect(r.settleUsd).toBe(500); // 1000 * 50%, dentro de [0,deposit]
    expect(mockSettle).toHaveBeenCalledTimes(1);
  });

  it('splitPct > 100 → INVALID_INPUT (T-7/AC-7, NO clamp silencioso), sin mover fondos', async () => {
    happySettle();
    process.env.ARBITER_AUTO_CAP_USD = '25';
    const db = makeArbDb({ authorized_usd: 1000, status: 'arb_hold' });
    wireDb(db);

    await expect(
      arbiterService.resolveHold(INTENT_ID, {
        decision: 'split',
        splitPct: 500,
        resolvedBy: null,
        note: null,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(mockSettle).not.toHaveBeenCalled();
    expect(db.refunds).toEqual([]);
  });

  it('splitPct < 0 → INVALID_INPUT, sin mover fondos', async () => {
    happySettle();
    const db = makeArbDb({ authorized_usd: 1000, status: 'arb_hold' });
    wireDb(db);

    await expect(
      arbiterService.resolveHold(INTENT_ID, {
        decision: 'split',
        splitPct: -5,
        resolvedBy: null,
        note: null,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(mockSettle).not.toHaveBeenCalled();
    expect(db.refunds).toEqual([]);
  });

  it('splitPct en borde (0 y 100) es válido y settleUsd nunca excede deposit (2da baranda del clamp)', async () => {
    happySettle();
    const db0 = makeArbDb({ authorized_usd: 1000, status: 'arb_hold' });
    wireDb(db0);
    const r0 = await arbiterService.resolveHold(INTENT_ID, {
      decision: 'split',
      splitPct: 0,
      resolvedBy: null,
      note: null,
    });
    expect(r0.settleUsd).toBe(0);

    happySettle();
    const db100 = makeArbDb({ authorized_usd: 1000, status: 'arb_hold' });
    wireDb(db100);
    const r100 = await arbiterService.resolveHold(INTENT_ID, {
      decision: 'split',
      splitPct: 100,
      resolvedBy: null,
      note: null,
    });
    expect(r100.settleUsd).toBe(1000); // = deposit, nunca lo excede (clamp vivo)
    expect(r100.residualUsd).toBe(0);
  });

  it('release de deposit grande no excede deposit', async () => {
    happySettle();
    const db = makeArbDb({ authorized_usd: 1000, status: 'arb_hold' });
    wireDb(db);

    const r = await arbiterService.resolveHold(INTENT_ID, {
      decision: 'release',
      resolvedBy: null,
      note: null,
    });
    expect(r.settleUsd).toBe(1000);
    expect(r.residualUsd).toBe(0);
  });
});

// ── T-8 (AC-2/CD-10): override in-flight (arb_closing sin veredicto) = no-op ──
describe('WKH-189 T-8 idempotencia / no-op in-flight (CD-10)', () => {
  it('override que cae en rama recovery arb_closing con settle_outcome=NULL → no-op, sin double-settle', async () => {
    happySettle();
    // El advisory read ve arb_hold (race: otro override ya transicionó); el RPC ve
    // arb_closing sin veredicto persistido (in-flight).
    const db = makeArbDb({
      authorized_usd: 10,
      status: 'arb_hold',
      consumed_usd: 4,
    });
    db.handlers.close_payment_intent_for_arbitration = () => ({
      data: [
        {
          final_amount: 4,
          prev_status: 'arb_closing',
          intent_type: 'session',
          key_id: 'k1',
          chain_id: 2368,
          pay_to: PAYTO,
          authorized_usd: 10,
          consumed_usd: 4,
          settle_tx_hash: null,
          settle_outcome: null, // in-flight: sin veredicto
        },
      ],
      error: null,
    });
    wireDb(db);

    const r = await arbiterService.resolveHold(INTENT_ID, {
      decision: 'split',
      splitPct: 40,
      resolvedBy: null,
      note: null,
    });

    expect(r.status).toBe('executed');
    expect(mockSettle).not.toHaveBeenCalled(); // no double-settle
    expect(db.refunds).toEqual([]); // no-op in-flight: cero movimiento
  });
});

// ── T-10 (CD-8/R-1): el invariante que hace seguro el ensanche ──
describe('WKH-189 T-10 invariante CD-8 (arb_hold nunca al recovery)', () => {
  it('(a) expireStale NO selecciona arb_hold (solo arb_closing + disputed)', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/services/payment-intent.ts'),
      'utf8',
    );
    expect(src).toContain(".eq('status', 'arb_closing')");
    expect(src).toContain(".eq('status', 'disputed')");
    // El hazard: barrer arb_hold hacia recoverArbClosing. NUNCA debe existir.
    expect(src).not.toContain(".eq('status', 'arb_hold')");
  });

  it('(b) recoverArbClosing forzado sobre arb_hold NO reembolsa el deposit (guard prev_status)', async () => {
    happySettle();
    const db = makeArbDb({
      authorized_usd: 10,
      status: 'arb_hold',
      consumed_usd: 0,
    });
    wireDb(db);

    // Aunque el RPC ensanchado transicione arb_hold→arb_closing, el guard
    // `prev_status !== 'arb_closing'` de recoverArbClosing corta antes de refundar.
    await arbiterService.recoverArbClosing(INTENT_ID, OWNER, true);
    expect(db.refunds).toEqual([]); // deposit NO reembolsado
    expect(mockSettle).not.toHaveBeenCalled();
  });
});

// ── T-11: assert estructural sobre el SQL de la migración (up + down) ──
describe('WKH-189 T-11 migration SQL structure (up + down)', () => {
  const upSql = readFileSync(
    join(
      process.cwd(),
      'supabase/migrations/20260712000000_wkh189_arb_hold_override.sql',
    ),
    'utf8',
  );
  const downSql = readFileSync(
    join(
      process.cwd(),
      'supabase/migrations/20260712000000_wkh189_arb_hold_override_down.sql',
    ),
    'utf8',
  );

  it('UP: predicado ensanchado EXACTAMENTE una vez (sentencia completa, no substring)', () => {
    expect(
      upSql.split("IF v_status IN ('disputed','arb_hold') THEN").length - 1,
    ).toBe(1);
    // El predicado angosto original NO debe existir como sentencia en el up.
    expect(upSql).not.toContain("IF v_status = 'disputed' THEN");
  });

  it('UP: CHECK method con admin_override (sentencia completa)', () => {
    expect(upSql).toContain(
      "CHECK (method IN ('rules','llm','hold','admin_override'))",
    );
  });

  it('UP: las 3 columnas de auditoría (ADD COLUMN)', () => {
    expect(upSql).toContain('ADD COLUMN IF NOT EXISTS resolved_by');
    expect(upSql).toContain('ADD COLUMN IF NOT EXISTS resolved_at');
    expect(upSql).toContain('ADD COLUMN IF NOT EXISTS resolution_note');
  });

  it("DOWN: restaura el predicado a = 'disputed' y NO contiene el ensanchado", () => {
    expect(downSql).toContain("IF v_status = 'disputed' THEN");
    expect(
      downSql.split("IF v_status IN ('disputed','arb_hold') THEN").length - 1,
    ).toBe(0);
  });

  it('DOWN: CHECK method sin admin_override (sentencia completa)', () => {
    expect(downSql).toContain("CHECK (method IN ('rules','llm','hold'))");
    expect(downSql).not.toContain(
      "CHECK (method IN ('rules','llm','hold','admin_override'))",
    );
  });

  it('DOWN: dropea las 3 columnas de auditoría (DROP COLUMN)', () => {
    expect(downSql).toContain('DROP COLUMN IF EXISTS resolved_by');
    expect(downSql).toContain('DROP COLUMN IF EXISTS resolved_at');
    expect(downSql).toContain('DROP COLUMN IF EXISTS resolution_note');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// WKH-191g — wire on-chain del árbitro al escrow (flag-gated, aditivo).
// key_id de makeArbDb = 'k1'; el nonce esperado deriva de keccak256('k1') + INTENT_ID.
// ────────────────────────────────────────────────────────────────────────────
const EXPECTED_KEY_HASH = keccak256(stringToBytes('k1'));
const EXPECTED_NONCE = deriveArbiterNonce(
  EXPECTED_KEY_HASH,
  INTENT_ID,
  TEST_SECRET,
);

describe('WKH-191g wire — flag OFF (default) → byte-idéntico, cero on-chain', () => {
  it('AC-1/AC-7: release con flag OFF → settlePaymentIntentOnChain, executeResolveDispute NO llamado', async () => {
    delete process.env.ESCROW_ARBITER_ENABLED;
    happySettle();
    const db = makeArbDb({ authorized_usd: 10, consumed_usd: 10 });
    wireDb(db);
    mockReadEvidence.mockResolvedValue(
      makeEvidence({
        authorizedUsd: 10,
        consumedUsd: 10,
        voucherCount: 2,
        vouchersTotalUsd: 10,
      }),
    );

    const r = await arbiterService.openDispute(INTENT_ID, OWNER);

    expect(r.decision).toBe('release');
    expect(mockExecResolve).not.toHaveBeenCalled();
    expect(mockExecLock).not.toHaveBeenCalled();
    expect(mockSettle).toHaveBeenCalled(); // path operator-custodial de hoy
    expect(db.row.status).toBe('settled');
  });
});

describe('WKH-191g wire — triple gate → fallback', () => {
  it('AC-1: flag ON pero escrow NO configurado (resolveEscrowContract null) → fallback, sin executeResolveDispute', async () => {
    process.env.ESCROW_ARBITER_ENABLED = 'true';
    mockResolveEscrow.mockReturnValue(null);
    happySettle();
    const db = makeArbDb({ authorized_usd: 10, consumed_usd: 10 });
    wireDb(db);
    mockReadEvidence.mockResolvedValue(
      makeEvidence({
        authorizedUsd: 10,
        consumedUsd: 10,
        voucherCount: 2,
        vouchersTotalUsd: 10,
      }),
    );

    const r = await arbiterService.openDispute(INTENT_ID, OWNER);

    expect(r.decision).toBe('release');
    expect(mockExecResolve).not.toHaveBeenCalled();
    expect(mockExecLock).not.toHaveBeenCalled();
    expect(mockSettle).toHaveBeenCalled();
  });

  it('AC-2/CD-7: flag ON + escrow + consent=false → fallback, sin executeResolveDispute ni lock', async () => {
    process.env.ESCROW_ARBITER_ENABLED = 'true';
    mockResolveEscrow.mockReturnValue(ESCROW_ADDR);
    mockReadConsent.mockResolvedValue(false);
    happySettle();
    const db = makeArbDb({ authorized_usd: 10, consumed_usd: 10 });
    wireDb(db);
    mockReadEvidence.mockResolvedValue(
      makeEvidence({
        authorizedUsd: 10,
        consumedUsd: 10,
        voucherCount: 2,
        vouchersTotalUsd: 10,
      }),
    );

    const r = await arbiterService.openDispute(INTENT_ID, OWNER);

    expect(r.decision).toBe('release');
    expect(mockExecResolve).not.toHaveBeenCalled();
    expect(mockExecLock).not.toHaveBeenCalled();
    expect(mockSettle).toHaveBeenCalled();
  });
});

describe('WKH-191g wire — flag ON + escrow + consent=true', () => {
  function armOnChain(): void {
    process.env.ESCROW_ARBITER_ENABLED = 'true';
    // WKH-194: secreto presente y fuerte → nonce derivable server-side (no fallback).
    process.env.ARBITER_NONCE_SECRET = TEST_SECRET;
    mockResolveEscrow.mockReturnValue(ESCROW_ADDR);
    mockReadConsent.mockResolvedValue(true);
  }

  it('AC-4: release/split → executeResolveDispute(seller=pay_to, sellerAmount, nonce derivado), sin seam operador', async () => {
    armOnChain();
    const db = makeArbDb({ authorized_usd: 10, consumed_usd: 10 });
    wireDb(db);
    mockReadEvidence.mockResolvedValue(
      makeEvidence({
        authorizedUsd: 10,
        consumedUsd: 10,
        voucherCount: 2,
        vouchersTotalUsd: 10,
      }),
    );

    const r = await arbiterService.openDispute(INTENT_ID, OWNER);

    expect(r.decision).toBe('release');
    expect(mockExecResolve).toHaveBeenCalledTimes(1);
    expect(mockExecResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        escrowContract: ESCROW_ADDR,
        keyIdHash: EXPECTED_KEY_HASH,
        seller: PAYTO,
        sellerAmount: parseUnits('10', 6),
        nonce: EXPECTED_NONCE,
      }),
    );
    expect(mockSettle).not.toHaveBeenCalled(); // escrow path, no operador
    expect(r.txHash).toBe('0xESCROWTX');
    expect(db.row.status).toBe('settled');
  });

  it('AC-3: transición a disputed → executeLockForDispute UNA vez por deposit total', async () => {
    armOnChain();
    const db = makeArbDb({ authorized_usd: 10, consumed_usd: 10 });
    wireDb(db);
    mockReadEvidence.mockResolvedValue(
      makeEvidence({
        authorizedUsd: 10,
        consumedUsd: 10,
        voucherCount: 2,
        vouchersTotalUsd: 10,
      }),
    );

    await arbiterService.openDispute(INTENT_ID, OWNER);

    expect(mockExecLock).toHaveBeenCalledTimes(1);
    expect(mockExecLock).toHaveBeenCalledWith(
      expect.objectContaining({
        escrowContract: ESCROW_ADDR,
        keyIdHash: EXPECTED_KEY_HASH,
        amount: parseUnits('10', 6), // deposit TOTAL (authorized_usd), no settleUsd
      }),
    );
  });

  it('AC-5: refund (arbMicro<=0) → executeReleaseDispute, NO executeResolveDispute', async () => {
    armOnChain();
    const db = makeArbDb({ authorized_usd: 10, consumed_usd: 0 });
    wireDb(db);
    mockReadEvidence.mockResolvedValue(
      makeEvidence({ authorizedUsd: 10, consumedUsd: 0 }),
    );

    const r = await arbiterService.openDispute(INTENT_ID, OWNER);

    expect(r.decision).toBe('refund');
    expect(mockExecRelease).toHaveBeenCalledTimes(1);
    expect(mockExecRelease).toHaveBeenCalledWith(
      expect.objectContaining({
        escrowContract: ESCROW_ADDR,
        keyIdHash: EXPECTED_KEY_HASH,
      }),
    );
    expect(mockExecResolve).not.toHaveBeenCalled();
    expect(db.refunds).toEqual([10]); // refund off-chain de hoy intacto
  });

  it('CD-6: lock/release fallan (throw / not_moved) → logueado, la resolución NO se rompe', async () => {
    armOnChain();
    mockExecLock.mockRejectedValue(new Error('lock boom'));
    mockExecRelease.mockResolvedValue({
      kind: 'not_moved',
      reason: 'REVERTED',
    });
    const db = makeArbDb({ authorized_usd: 10, consumed_usd: 0 });
    wireDb(db);
    mockReadEvidence.mockResolvedValue(
      makeEvidence({ authorizedUsd: 10, consumedUsd: 0 }),
    );

    const r = await arbiterService.openDispute(INTENT_ID, OWNER);

    // Idéntico al happy off-chain: refund ejecutado, deposit al buyer.
    expect(r.decision).toBe('refund');
    expect(r.status).toBe('executed');
    expect(db.refunds).toEqual([10]);
  });

  it('AC-6: resolveDispute on-chain not_moved → failureKind unequivocal → refund deposit COMPLETO', async () => {
    armOnChain();
    mockExecResolve.mockResolvedValue({
      kind: 'not_moved',
      reason: 'REVERTED',
    });
    const db = makeArbDb({ authorized_usd: 10, consumed_usd: 10 });
    wireDb(db);
    mockReadEvidence.mockResolvedValue(
      makeEvidence({
        authorizedUsd: 10,
        consumedUsd: 10,
        voucherCount: 2,
        vouchersTotalUsd: 10,
      }),
    );

    const r = await arbiterService.openDispute(INTENT_ID, OWNER);

    expect(r.decision).toBe('release');
    expect(mockSettle).not.toHaveBeenCalled();
    expect(db.row.status).toBe('refunded'); // rama unequivocal → refund del deposit
    expect(db.refunds).toEqual([10]);
  });

  it('AC-6: resolveDispute on-chain ambiguous → failed_ambiguous + RECONCILE (NO refund)', async () => {
    armOnChain();
    mockExecResolve.mockResolvedValue({
      kind: 'ambiguous',
      reason: 'RECEIPT_TIMEOUT',
    });
    const db = makeArbDb({ authorized_usd: 10, consumed_usd: 10 });
    wireDb(db);
    mockReadEvidence.mockResolvedValue(
      makeEvidence({
        authorizedUsd: 10,
        consumedUsd: 10,
        voucherCount: 2,
        vouchersTotalUsd: 10,
      }),
    );

    const r = await arbiterService.openDispute(INTENT_ID, OWNER);

    expect(r.decision).toBe('release');
    expect(mockSettle).not.toHaveBeenCalled();
    expect(db.row.status).toBe('failed'); // rama ambiguo: NO refund, requiere reconcile
    expect(db.refunds).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// WKH-194 — nonce del árbitro exactly-once + no-adivinable + defensa colisión.
// ────────────────────────────────────────────────────────────────────────────
function releaseEvidence() {
  mockReadEvidence.mockResolvedValue(
    makeEvidence({
      authorizedUsd: 10,
      consumedUsd: 10,
      voucherCount: 2,
      vouchersTotalUsd: 10,
    }),
  );
}

function nonceRpcCalls(): number {
  return mockRpc.mock.calls.filter(
    (c) => c[0] === 'get_or_create_arbiter_nonce',
  ).length;
}

/** El `nonce` pasado a executeResolveDispute en la llamada `idx`. */
function resolveNonceArg(idx: number): bigint {
  const call = mockExecResolve.mock.calls[idx];
  return (call?.[0] as { nonce: bigint }).nonce;
}

const SETTLE_PARAMS = {
  intentId: INTENT_ID,
  ownerRef: OWNER,
  payTo: PAYTO,
  finalAmountUsd: 5,
  chainId: 2368,
  keyId: 'k1',
};

describe('WKH-194 exactly-once + no-adivinable + defensa', () => {
  function armEscrow(): void {
    process.env.ESCROW_ARBITER_ENABLED = 'true';
    process.env.ARBITER_NONCE_SECRET = TEST_SECRET;
    mockResolveEscrow.mockReturnValue(ESCROW_ADDR);
    mockReadConsent.mockResolvedValue(true);
  }

  // T4 · exactly-once persistencia (AC-1/AC-2/CD-1): la 2ª pasada lee el nonce
  // persistido y NO recomputa (mismo nonce pese a rotar el secreto; RPC no re-llamado).
  it('T4: read-first exactly-once — 2ª call NO recomputa (RPC no re-llamado, mismo nonce)', async () => {
    armEscrow();
    const db = makeArbDb({ authorized_usd: 10, consumed_usd: 10 });
    wireDb(db);

    const r1 = await settleArbitrationOnChain(SETTLE_PARAMS);
    expect(r1.status).toBe('settled');
    const nonce1 = resolveNonceArg(0);
    expect(nonce1).toBe(EXPECTED_NONCE);
    const rpcAfterFirst = nonceRpcCalls();
    expect(rpcAfterFirst).toBe(1); // 1ª pasada: miss → RPC persiste

    // Rotamos el secreto: si recomputara, el nonce cambiaría. NO debe.
    process.env.ARBITER_NONCE_SECRET = 'y'.repeat(64);
    const r2 = await settleArbitrationOnChain(SETTLE_PARAMS);
    expect(r2.status).toBe('settled');
    const nonce2 = resolveNonceArg(1);
    expect(nonce2).toBe(nonce1); // read-first hit → mismo nonce persistido
    expect(nonceRpcCalls()).toBe(rpcAfterFirst); // 2ª pasada NO llamó al RPC
  });

  // T-NEW-4 · cast-presence read-first (AC-3/AC-6, WKH-196): el .select() del
  // read-first sobre a2a_arbiter_nonces castea la columna NUMERIC(78,0) a ::text.
  it('T-NEW-4: read-first del nonce castea select("nonce::text")', async () => {
    armEscrow();
    const db = makeArbDb({ authorized_usd: 10, consumed_usd: 10 });
    wireDb(db);

    const r = await settleArbitrationOnChain(SETTLE_PARAMS);
    expect(r.status).toBe('settled');
    expect(db.nonceSelectCols()).toBe('nonce::text');
  });

  // T-NEW-5 · round-trip read-first HIT (AC-3, WKH-196): un nonce uint256 > 2^53 ya
  // persistido sobrevive EXACTO el SELECT directo de la tabla (no solo el RPC), y el
  // HIT no recomputa vía RPC.
  it('T-NEW-5: read-first HIT con nonce > 2^53 → bigint exacto, RPC no llamado', async () => {
    armEscrow();
    const db = makeArbDb({
      authorized_usd: 10,
      consumed_usd: 10,
      nonceStore: '4312989337224638380',
    });
    wireDb(db);

    const r = await settleArbitrationOnChain(SETTLE_PARAMS);
    expect(r.status).toBe('settled');
    // el bug era Number → 4312989337224638464n; con ::text el string exacto
    // reconstruye el bigint sin corrupción.
    expect(resolveNonceArg(0)).toBe(4312989337224638380n);
    expect(nonceRpcCalls()).toBe(0); // read-first HIT → NO recomputa vía RPC
  });

  // T5 · fallback secreto ausente → operator-custodial (AC-3/CD-3/CD-5).
  it('T5: secreto ausente → fallback custodial, executeResolveDispute NO invocado', async () => {
    process.env.ESCROW_ARBITER_ENABLED = 'true';
    delete process.env.ARBITER_NONCE_SECRET; // sin secreto → fail-closed
    mockResolveEscrow.mockReturnValue(ESCROW_ADDR);
    mockReadConsent.mockResolvedValue(true);
    happySettle();
    const db = makeArbDb({ authorized_usd: 10, consumed_usd: 10 });
    wireDb(db);

    const r = await settleArbitrationOnChain(SETTLE_PARAMS);

    expect(r.status).toBe('settled');
    expect(mockExecResolve).not.toHaveBeenCalled(); // NO escrow path
    expect(mockSettle).toHaveBeenCalled(); // operator-custodial
    expect(nonceRpcCalls()).toBe(0); // miss → secreto null → ni siquiera persiste
  });

  // T6 · flag OFF inerte (AC-6/CD-5): ni RPC ni lectura de a2a_arbiter_nonces.
  it('T6: flag OFF → inerte, ni RPC nonce ni from(a2a_arbiter_nonces)', async () => {
    delete process.env.ESCROW_ARBITER_ENABLED;
    process.env.ARBITER_NONCE_SECRET = TEST_SECRET;
    happySettle();
    const db = makeArbDb({ authorized_usd: 10, consumed_usd: 10 });
    wireDb(db);

    const r = await settleArbitrationOnChain(SETTLE_PARAMS);

    expect(r.status).toBe('settled');
    expect(mockExecResolve).not.toHaveBeenCalled();
    expect(nonceRpcCalls()).toBe(0);
    expect(
      mockFrom.mock.calls.filter(
        (c) => (c[0] as string) === 'a2a_arbiter_nonces',
      ).length,
    ).toBe(0);
  });

  // T8 · defensa no-refund (AC-7): colisión NONCE_ALREADY_USED → failed_ambiguous,
  // NO refund. Contraste: REVERTED (no colisión) → failed_unequivocal + refund completo.
  it('T8: colisión de nonce → failed_ambiguous + RECONCILE, db.refunds vacío (NO refund)', async () => {
    armEscrow();
    mockExecResolve.mockResolvedValue({
      kind: 'not_moved',
      reason: 'NONCE_ALREADY_USED',
    });
    const db = makeArbDb({ authorized_usd: 10, consumed_usd: 10 });
    wireDb(db);
    releaseEvidence();

    const r = await arbiterService.openDispute(INTENT_ID, OWNER);

    expect(r.decision).toBe('release');
    expect(db.row.settle_outcome).toBe('failed_ambiguous');
    expect(db.refunds).toEqual([]); // premio del griefing eliminado
    expect(db.row.status).toBe('failed');
    expect(String(db.row.error_message)).toContain(
      'RECONCILE: NONCE_COLLISION',
    );
  });

  it('T8-contraste: not_moved REVERTED (no colisión) → failed_unequivocal + refund COMPLETO', async () => {
    armEscrow();
    mockExecResolve.mockResolvedValue({
      kind: 'not_moved',
      reason: 'REVERTED',
    });
    const db = makeArbDb({ authorized_usd: 10, consumed_usd: 10 });
    wireDb(db);
    releaseEvidence();

    await arbiterService.openDispute(INTENT_ID, OWNER);

    expect(db.row.settle_outcome).toBe('failed_unequivocal');
    expect(db.refunds).toEqual([10]); // deposit completo al buyer (byte-idéntico a hoy)
    expect(db.row.status).toBe('refunded');
  });

  // T9 · atomicidad first-writer (AC-1/DT-3): el RPC devuelve el persisted_nonce
  // GANADOR aunque difiera del candidate local → se usa SIEMPRE el del RPC.
  it('T9: getOrCreateArbiterNonce usa el persisted_nonce del RPC, no el candidate local', async () => {
    armEscrow();
    const db = makeArbDb({ authorized_usd: 10, consumed_usd: 10 });
    // El RPC (ganador atómico de otro writer) devuelve un nonce DISTINTO al candidate.
    const winner = ((1n << 255n) | 424242n).toString();
    db.handlers.get_or_create_arbiter_nonce = () => ({
      data: [{ persisted_nonce: winner }],
      error: null,
    });
    wireDb(db);

    const r = await settleArbitrationOnChain(SETTLE_PARAMS);

    expect(r.status).toBe('settled');
    const nonceUsed = resolveNonceArg(0);
    expect(nonceUsed).toBe(BigInt(winner)); // el ganador del RPC, NO EXPECTED_NONCE
    expect(nonceUsed).not.toBe(EXPECTED_NONCE);
  });
});
