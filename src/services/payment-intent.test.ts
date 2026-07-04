/**
 * Payment Intent Service — money-path tests (WKH-135).
 *
 * Cubre: T-AC1 (idempotencia close), T-AC2 / T-AC2b (refund residual), T-AC3 (cap
 * inviolable), T-AC4 (owner guard IDOR), T-AC6 (expiry), T-SIG (firma cap +
 * replay), T-VCHR (voucher idempotente), T-VERIFY (settle on-chain), T-CONC
 * (concurrencia). supabase.rpc + adapter + verifier + viem mockeados.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks (hoisted logger) ──────────────────────────────────────
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
}));

const mockVerify = vi.fn().mockResolvedValue({ ok: true });
vi.mock('../adapters/settle-verifier.js', () => ({
  verifyDefaultChainSettle: (...a: unknown[]) => mockVerify(...a),
}));

const mockRecover = vi.fn();
vi.mock('viem', () => ({
  recoverTypedDataAddress: (...a: unknown[]) => mockRecover(...a),
}));

vi.mock('../lib/supabase.js', () => ({
  supabase: { rpc: vi.fn(), from: vi.fn() },
}));

import { supabase } from '../lib/supabase.js';
import type { CreateUptoInput } from '../types/index.js';
import {
  paymentIntentService,
  settlePaymentIntentOnChain,
} from './payment-intent.js';

const mockRpc = vi.mocked(supabase.rpc);
const mockFrom = vi.mocked(supabase.from);

// ── RPC router: name → handler ──────────────────────────────────
type RpcHandler = (args: Record<string, unknown>) => {
  data?: unknown;
  error?: { code?: string; message?: string } | null;
};
function routeRpc(handlers: Record<string, RpcHandler>): void {
  mockRpc.mockImplementation((name: string, args?: Record<string, unknown>) => {
    const h = handlers[name];
    const res = h ? h(args ?? {}) : { data: null, error: null };
    // biome-ignore lint/suspicious/noExplicitAny: test double for the supabase builder
    return Promise.resolve(res) as any;
  });
}

const OWNER = 'tenant-A';
const PAYTO = '0x2222222222222222222222222222222222222222';
const FUNDING = '0xabc0000000000000000000000000000000000001';

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

beforeEach(() => {
  vi.clearAllMocks();
  mockVerify.mockResolvedValue({ ok: true });
  process.env.KITE_CHAIN_ID = '2368';
  delete process.env.UPTO_EIP712_NAME;
  delete process.env.UPTO_EIP712_VERSION;
});

// ── Faithful in-memory DB for the 3 money-path RPCs (BLQ-DR) ─────
// Modela close/record/finalize con las MISMAS semánticas que el SQL:
//  - close: open→closing (persiste consumed para upto), idempotente.
//  - record_settle_outcome: anota settle_outcome money-free mientras 'closing'.
//  - finalize: money (refund) + status flip en la MISMA "tx", status-gated en
//    'closing'; re-invocar terminal = no-op. `failFinalize` simula blips atómicos
//    (rollback: NO muta). `refunds` prueba el invariante "refund exactamente 1 vez".
interface FakeRow {
  status: string;
  intent_type: 'session' | 'upto';
  authorized_usd: number;
  consumed_usd: number;
  settle_tx_hash: string | null;
  settle_outcome: string | null;
  error_message: string | null;
  key_id: string;
  chain_id: number;
  pay_to: string;
}
function makeIntentDb(init: {
  intent_type: 'session' | 'upto';
  authorized_usd: number;
  consumed_usd: number;
  status?: string;
}): {
  row: FakeRow;
  refunds: number[];
  state: { failFinalize: number };
  handlers: Record<string, RpcHandler>;
} {
  const row: FakeRow = {
    status: init.status ?? 'open',
    intent_type: init.intent_type,
    authorized_usd: init.authorized_usd,
    consumed_usd: init.consumed_usd,
    settle_tx_hash: null,
    settle_outcome: null,
    error_message: null,
    key_id: 'k1',
    chain_id: 2368,
    pay_to: PAYTO,
  };
  const refunds: number[] = [];
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
    close_payment_intent_for_settle: (args) => {
      const prev = row.status;
      let final = 0;
      if (row.status === 'open') {
        if (row.intent_type === 'session') {
          final = Math.min(row.consumed_usd, row.authorized_usd);
        } else {
          final = Math.min(
            row.authorized_usd,
            Number(args.p_reported_usage) || 0,
          );
          row.consumed_usd = final; // persistido al transicionar (MNR-2)
        }
        row.status = 'closing';
      }
      return snapshot(prev, final);
    },
    record_settle_outcome: (args) => {
      // money-free + status-gated: solo anota mientras 'closing'.
      if (row.status === 'closing') {
        row.settle_outcome = String(args.p_outcome);
        if (args.p_tx_hash != null) row.settle_tx_hash = String(args.p_tx_hash);
        row.error_message = (args.p_error as string) ?? row.error_message;
      }
      return { error: null };
    },
    finalize_payment_intent: (args) => {
      if (state.failFinalize > 0) {
        state.failFinalize -= 1;
        return { error: { message: 'db blip' } }; // rollback atómico: NADA muta
      }
      if (row.status !== 'closing') return { error: null }; // idempotente no-op
      const outcome = String(args.p_outcome);
      if (outcome === 'settled') {
        row.status = 'settled';
        row.settle_outcome = 'settled';
        if (args.p_tx_hash != null) row.settle_tx_hash = String(args.p_tx_hash);
        // credit-back del residual (session). upto NO reservó → NO refunda.
        if (
          row.intent_type === 'session' &&
          args.p_residual != null &&
          Number(args.p_residual) > 0
        ) {
          refunds.push(Number(args.p_residual));
        }
      } else if (outcome === 'failed_unequivocal') {
        row.status = 'refunded';
        row.settle_outcome = 'failed_unequivocal';
        row.error_message = (args.p_error as string) ?? row.error_message;
        // refund del monto reservado/debitado, DENTRO de la tx status-gated.
        if (row.intent_type === 'session') {
          if (row.authorized_usd > 0) refunds.push(row.authorized_usd);
        } else if (row.consumed_usd > 0) {
          refunds.push(row.consumed_usd);
        }
      } else {
        row.status = 'failed';
        row.settle_outcome = 'failed_ambiguous';
        row.error_message = (args.p_error as string) ?? row.error_message;
      }
      return { error: null };
    },
  };
  return { row, refunds, state, handlers };
}

// ── T-AC1: idempotencia del close (settle 1 sola vez) ───────────
describe('T-AC1 close idempotente', () => {
  it('2 closes del mismo intent → settle() 1 sola vez', async () => {
    happySettle();
    let closeCalls = 0;
    routeRpc({
      close_payment_intent_for_settle: () => {
        closeCalls += 1;
        return {
          data: [
            {
              final_amount: closeCalls === 1 ? 3.7 : 0,
              prev_status: closeCalls === 1 ? 'open' : 'closing',
              intent_type: 'session',
              key_id: 'k1',
              chain_id: 2368,
              pay_to: PAYTO,
              authorized_usd: 10,
              consumed_usd: closeCalls === 1 ? 3.7 : 3.7,
              settle_tx_hash: closeCalls === 1 ? null : '0xTX',
              settle_outcome: closeCalls === 1 ? null : 'settled',
            },
          ],
          error: null,
        };
      },
      finalize_payment_intent: () => ({ error: null }),
    });

    const r1 = await paymentIntentService.closeSession('i1', OWNER);
    const r2 = await paymentIntentService.closeSession('i1', OWNER);

    expect(r1.status).toBe('settled');
    expect(r2.status).toBe('settled');
    expect(mockSettle).toHaveBeenCalledTimes(1); // no doble-cobro
  });
});

// ── T-AC2 / T-AC2b: refund residual ─────────────────────────────
describe('T-AC2 refund residual', () => {
  it('deposit=10, consumed=3.7 → settle 3.7 + refund 6.3 (micro-exacto)', async () => {
    happySettle();
    const finalizeArgs: Record<string, unknown>[] = [];
    routeRpc({
      close_payment_intent_for_settle: () => ({
        data: [
          {
            final_amount: 3.7,
            prev_status: 'open',
            intent_type: 'session',
            key_id: 'k1',
            chain_id: 2368,
            pay_to: PAYTO,
            authorized_usd: 10,
            consumed_usd: 3.7,
            settle_tx_hash: null,
          },
        ],
        error: null,
      }),
      finalize_payment_intent: (args) => {
        finalizeArgs.push(args);
        return { error: null };
      },
    });

    const r = await paymentIntentService.closeSession('i1', OWNER);
    expect(r.status).toBe('settled');
    expect(r.consumedUsd).toBeCloseTo(3.7, 8);
    expect(r.residualUsd).toBeCloseTo(6.3, 8);
    expect(finalizeArgs[0]?.p_final_amount).toBeCloseTo(3.7, 8);
    expect(finalizeArgs[0]?.p_residual).toBeCloseTo(6.3, 8);
    expect(finalizeArgs[0]?.p_outcome).toBe('settled');
  });

  it('T-AC2b: consumed==deposit → residual 0; consumed>deposit → residual nunca negativo', async () => {
    happySettle();
    routeRpc({
      close_payment_intent_for_settle: () => ({
        data: [
          {
            final_amount: 10,
            prev_status: 'open',
            intent_type: 'session',
            key_id: 'k1',
            chain_id: 2368,
            pay_to: PAYTO,
            authorized_usd: 10,
            consumed_usd: 12, // defensivo: aunque venga > deposit, residual = 0
            settle_tx_hash: null,
          },
        ],
        error: null,
      }),
      finalize_payment_intent: () => ({ error: null }),
    });

    const r = await paymentIntentService.closeSession('i1', OWNER);
    expect(r.residualUsd).toBe(0);
    expect(r.residualUsd).toBeGreaterThanOrEqual(0);
  });
});

// ── T-AC3: cap inviolable (upto) ────────────────────────────────
describe('T-AC3 cap inviolable', () => {
  function uptoClose(): void {
    routeRpc({
      close_payment_intent_for_settle: (args) => {
        const reported = Number(args.p_reported_usage);
        return {
          data: [
            {
              final_amount: Math.min(5, reported),
              prev_status: 'open',
              intent_type: 'upto',
              key_id: 'k1',
              chain_id: 2368,
              pay_to: PAYTO,
              authorized_usd: 5,
              consumed_usd: 0,
              settle_tx_hash: null,
            },
          ],
          error: null,
        };
      },
      finalize_payment_intent: () => ({ error: null }),
    });
  }

  it('cap=5, uso=8 → cobra 5 (cappedAt) — NUNCA > cap', async () => {
    happySettle();
    uptoClose();
    const r = await paymentIntentService.settleUpto('i1', OWNER, 8);
    expect(r.finalAmountUsd).toBe(5);
    expect(r.cappedAt).toBe(true);
    // settle firmado por el cap (5 USD → 18 decimals).
    const signVal = mockSign.mock.calls[0]?.[0] as { value: string };
    expect(signVal.value).toBe('5000000000000000000');
  });

  it('cap=5, uso=2 → cobra 2 (no capped)', async () => {
    happySettle();
    uptoClose();
    const r = await paymentIntentService.settleUpto('i1', OWNER, 2);
    expect(r.finalAmountUsd).toBe(2);
    expect(r.cappedAt).toBe(false);
  });
});

// ── T-AC4: owner guard (IDOR) ───────────────────────────────────
describe('T-AC4 owner guard', () => {
  it('caller B cierra intent de A → OWNERSHIP_MISMATCH', async () => {
    routeRpc({
      close_payment_intent_for_settle: () => ({
        data: null,
        error: { message: 'OWNERSHIP_MISMATCH: intent i1 not owned by caller' },
      }),
    });
    await expect(
      paymentIntentService.closeSession('i1', 'tenant-B'),
    ).rejects.toMatchObject({ code: 'OWNERSHIP_MISMATCH' });
    expect(mockSettle).not.toHaveBeenCalled();
  });
});

// ── T-AC6: expiry auto-settle + refund ──────────────────────────
describe('T-AC6 expiry', () => {
  it('intent vencido → expireStale auto-settlea consumido + refund', async () => {
    happySettle();
    // expireStale hace DOS queries: status='open' (vencidos) y status='closing'
    // (huérfanos, BLQ-2). El builder trackea el .eq('status', ...) y sólo devuelve
    // el intent 'open'; 'closing' → vacío (no hay huérfanos en este caso).
    const builder = {
      _status: undefined as string | undefined,
      select: () => builder,
      eq: (col: string, val: string) => {
        if (col === 'status') builder._status = val;
        return builder;
      },
      lt: () =>
        Promise.resolve({
          data:
            builder._status === 'open'
              ? [{ id: 'i1', owner_ref: OWNER, intent_type: 'session' }]
              : [],
          error: null,
        }),
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    mockFrom.mockReturnValue(builder as any);
    const finalizeArgs: Record<string, unknown>[] = [];
    routeRpc({
      close_payment_intent_for_settle: () => ({
        data: [
          {
            final_amount: 2,
            prev_status: 'open',
            intent_type: 'session',
            key_id: 'k1',
            chain_id: 2368,
            pay_to: PAYTO,
            authorized_usd: 10,
            consumed_usd: 2,
            settle_tx_hash: null,
          },
        ],
        error: null,
      }),
      finalize_payment_intent: (args) => {
        finalizeArgs.push(args);
        return { error: null };
      },
    });

    await paymentIntentService.expireStale();
    expect(mockSettle).toHaveBeenCalledTimes(1);
    expect(finalizeArgs[0]?.p_residual).toBeCloseTo(8, 8); // 10 - 2 refund
    expect(finalizeArgs[0]?.p_outcome).toBe('settled');
  });
});

// ── T-SIG: firma del cap + replay ───────────────────────────────
describe('T-SIG firma cap', () => {
  function makeUptoInput(over: Partial<CreateUptoInput> = {}): CreateUptoInput {
    const nonce = `0x${'11'.repeat(32)}`;
    return {
      intentId: 'i1',
      keyId: 'k1',
      ownerRef: OWNER,
      buyerWallet: FUNDING,
      sellerRef: 'reg/agent',
      payTo: PAYTO,
      chainId: 2368,
      capUsd: 5,
      capSignature: `0x${'22'.repeat(65)}`,
      capNonce: nonce,
      typedData: {
        domain: { name: 'WasiAI-a2a Upto', version: '1', chainId: 2368 },
        types: {},
        primaryType: 'UptoCap',
        message: {
          seller_ref: 'reg/agent',
          cap: '5',
          chain_id: 2368,
          nonce: nonce as `0x${string}`,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        },
      },
      ...over,
    };
  }

  it('firma válida (firmante==funding_wallet) → crea el intent', async () => {
    mockRecover.mockResolvedValue(FUNDING);
    routeRpc({ open_payment_intent: () => ({ error: null }) });
    const r = await paymentIntentService.createUpto(makeUptoInput());
    expect(r.intentId).toBe('i1');
    expect(mockRpc).toHaveBeenCalledWith(
      'open_payment_intent',
      expect.objectContaining({ p_intent_type: 'upto' }),
    );
  });

  it('firmante != funding_wallet → CAP_SIGNATURE_INVALID, intent NO creado', async () => {
    mockRecover.mockResolvedValue('0x9999999999999999999999999999999999999999');
    routeRpc({ open_payment_intent: () => ({ error: null }) });
    await expect(
      paymentIntentService.createUpto(makeUptoInput()),
    ).rejects.toMatchObject({ code: 'CAP_SIGNATURE_INVALID' });
    expect(mockRpc).not.toHaveBeenCalledWith(
      'open_payment_intent',
      expect.anything(),
    );
  });

  it('domain distinto → CAP_SIGNATURE_INVALID (antes del recover)', async () => {
    const input = makeUptoInput();
    input.typedData.domain.name = 'evil-domain';
    await expect(paymentIntentService.createUpto(input)).rejects.toMatchObject({
      code: 'CAP_SIGNATURE_INVALID',
    });
    expect(mockRecover).not.toHaveBeenCalled();
  });

  it('nonce reusado (23505) → CAP_SIGNATURE_INVALID', async () => {
    mockRecover.mockResolvedValue(FUNDING);
    routeRpc({
      open_payment_intent: () => ({
        error: { code: '23505', message: 'uq_a2a_payment_intents_cap_nonce' },
      }),
    });
    await expect(
      paymentIntentService.createUpto(makeUptoInput()),
    ).rejects.toMatchObject({ code: 'CAP_SIGNATURE_INVALID' });
  });
});

// ── T-VCHR: voucher idempotente ─────────────────────────────────
describe('T-VCHR voucher idempotente', () => {
  it('mismo voucherId 2× → consumed incrementa 1 sola vez (duplicate)', async () => {
    let calls = 0;
    routeRpc({
      accumulate_payment_voucher: () => {
        calls += 1;
        return {
          data: [{ consumed: 3.7, is_duplicate: calls > 1 }],
          error: null,
        };
      },
    });
    const r1 = await paymentIntentService.addVoucher({
      intentId: 'i1',
      ownerRef: OWNER,
      voucherId: 'v1',
      amountUsd: 3.7,
    });
    const r2 = await paymentIntentService.addVoucher({
      intentId: 'i1',
      ownerRef: OWNER,
      voucherId: 'v1',
      amountUsd: 3.7,
    });
    expect(r1.duplicate).toBe(false);
    expect(r2.duplicate).toBe(true);
    expect(r1.consumedUsd).toBeCloseTo(3.7, 8);
    expect(r2.consumedUsd).toBeCloseTo(3.7, 8); // no doble-conteo
  });

  it('voucher sobre intent no-open → INTENT_NOT_OPEN', async () => {
    routeRpc({
      accumulate_payment_voucher: () => ({
        data: null,
        error: { message: 'INTENT_NOT_OPEN: intent i1 is closing' },
      }),
    });
    await expect(
      paymentIntentService.addVoucher({
        intentId: 'i1',
        ownerRef: OWNER,
        voucherId: 'v9',
        amountUsd: 1,
      }),
    ).rejects.toMatchObject({ code: 'INTENT_NOT_OPEN' });
  });
});

// ── T-VERIFY: settle on-chain (CD-5) ────────────────────────────
describe('T-VERIFY settle on-chain', () => {
  function openSessionClose(): void {
    routeRpc({
      close_payment_intent_for_settle: () => ({
        data: [
          {
            final_amount: 5,
            prev_status: 'open',
            intent_type: 'session',
            key_id: 'k1',
            chain_id: 2368,
            pay_to: PAYTO,
            authorized_usd: 10,
            consumed_usd: 5,
            settle_tx_hash: null,
          },
        ],
        error: null,
      }),
      finalize_payment_intent: () => ({ error: null }),
    });
  }

  it('verify.ok===false (AMBIGUO) → failed reconciliable, NO refund (evita doble-gasto) + warn', async () => {
    happySettle();
    // settle OK on-chain pero la re-verificación lo contradice → el transfer PUDO
    // haber ocurrido → NO refundar (doble-gasto), pero marcar reconciliable.
    mockVerify.mockResolvedValue({ ok: false, reason: 'AMOUNT_MISMATCH' });
    const refunds: number[] = [];
    const finalizeArgs: Record<string, unknown>[] = [];
    routeRpc({
      close_payment_intent_for_settle: () => ({
        data: [
          {
            final_amount: 5,
            prev_status: 'open',
            intent_type: 'session',
            key_id: 'k1',
            chain_id: 2368,
            pay_to: PAYTO,
            authorized_usd: 10,
            consumed_usd: 5,
            settle_tx_hash: null,
          },
        ],
        error: null,
      }),
      refund_a2a_key_spend: (args) => {
        refunds.push(Number(args.p_amount_usd));
        return { data: 1, error: null };
      },
      finalize_payment_intent: (args) => {
        finalizeArgs.push(args);
        return { error: null };
      },
    });
    const r = await paymentIntentService.closeSession('i1', OWNER);
    expect(r.status).toBe('failed');
    // Caso AMBIGUO: NO se refunda (el deposit PUDO haberse transferido on-chain).
    expect(refunds).toEqual([]);
    // Reconciliable: finalize con outcome ambiguo + flag RECONCILE en error_message.
    expect(finalizeArgs[0]?.p_outcome).toBe('failed_ambiguous');
    expect(finalizeArgs[0]?.p_residual).toBeNull();
    expect(String(finalizeArgs[0]?.p_error)).toMatch(/^RECONCILE:/);
    // Señal de reconciliación explícita (nunca perder la señal).
    expect(logSpy.warn).toHaveBeenCalled();
  });

  it('verify.warn===true (RPC_UNAVAILABLE) → fail-OPEN settled + warn', async () => {
    happySettle();
    mockVerify.mockResolvedValue({
      ok: true,
      warn: true,
      reason: 'RPC_UNAVAILABLE',
    });
    openSessionClose();
    const r = await paymentIntentService.closeSession('i1', OWNER);
    expect(r.status).toBe('settled');
    expect(logSpy.warn).toHaveBeenCalled();
  });

  it('settlePaymentIntentOnChain: sign throws → failed (nunca rechaza, CD-7)', async () => {
    mockSign.mockRejectedValue(new Error('sig failure'));
    const r = await settlePaymentIntentOnChain({
      intentId: 'i1',
      ownerRef: OWNER,
      payTo: PAYTO,
      finalAmountUsd: 5,
      chainId: 2368,
    });
    expect(r.status).toBe('failed');
    expect(r.txHash).toBeNull();
    expect(r.failureKind).toBe('unequivocal'); // no hubo transfer
  });

  it('settlePaymentIntentOnChain: settle.success===false → failed inequívoco', async () => {
    mockSign.mockResolvedValue({
      paymentRequest: {
        authorization: { value: '1' },
        signature: '0xsig',
        network: 'kite',
      },
    });
    mockSettle.mockResolvedValue({ txHash: '', success: false, error: 'boom' });
    const r = await settlePaymentIntentOnChain({
      intentId: 'i1',
      ownerRef: OWNER,
      payTo: PAYTO,
      finalAmountUsd: 5,
      chainId: 2368,
    });
    expect(r.status).toBe('failed');
    expect(r.failureKind).toBe('unequivocal');
  });

  it('settlePaymentIntentOnChain: verify contradiction → failed AMBIGUO', async () => {
    happySettle();
    mockVerify.mockResolvedValue({ ok: false, reason: 'AMOUNT_MISMATCH' });
    const r = await settlePaymentIntentOnChain({
      intentId: 'i1',
      ownerRef: OWNER,
      payTo: PAYTO,
      finalAmountUsd: 5,
      chainId: 2368,
    });
    expect(r.status).toBe('failed');
    expect(r.failureKind).toBe('ambiguous'); // el transfer PUDO ocurrir
  });
});

// ── BLQ-ALTO-1: session no pierde el deposit en settle fallido ────
describe('BLQ-ALTO-1 session deposit on settle failure', () => {
  it('settle.success===false (INEQUÍVOCO) → refund del deposit COMPLETO, seller NO cobró (budget_post == budget_pre)', async () => {
    // sign OK, settle reporta success:false → NO se envió ninguna tx.
    mockSign.mockResolvedValue({
      paymentRequest: {
        authorization: { value: '1' },
        signature: '0xsig',
        network: 'kite',
      },
    });
    mockSettle.mockResolvedValue({ txHash: '', success: false, error: 'boom' });
    mockVerify.mockResolvedValue({ ok: true });

    const budgetPre = 100; // openSession ya debitó el deposit (10) → budget 90.
    const db = makeIntentDb({
      intent_type: 'session',
      authorized_usd: 10,
      consumed_usd: 4,
    });
    routeRpc(db.handlers);

    const r = await paymentIntentService.closeSession('i1', OWNER);
    expect(r.status).toBe('failed');
    // Refund del deposit COMPLETO (10), DENTRO de finalize (status-gated), NO 6.
    expect(db.refunds).toEqual([10]);
    // Invariante money-path: budget restaurado a su valor previo.
    const budgetPost = budgetPre - 10 + db.refunds.reduce((a, b) => a + b, 0);
    expect(budgetPost).toBe(budgetPre);
    expect(r.residualUsd).toBe(10);
  });

  it('verify contradiction (AMBIGUO) → NO refund + estado reconciliable + log.warn', async () => {
    happySettle();
    mockVerify.mockResolvedValue({ ok: false, reason: 'AMOUNT_MISMATCH' });
    const refunds: number[] = [];
    const finalizeArgs: Record<string, unknown>[] = [];
    routeRpc({
      close_payment_intent_for_settle: () => ({
        data: [
          {
            final_amount: 4,
            prev_status: 'open',
            intent_type: 'session',
            key_id: 'k1',
            chain_id: 2368,
            pay_to: PAYTO,
            authorized_usd: 10,
            consumed_usd: 4,
            settle_tx_hash: null,
          },
        ],
        error: null,
      }),
      refund_a2a_key_spend: (args) => {
        refunds.push(Number(args.p_amount_usd));
        return { data: 1, error: null };
      },
      finalize_payment_intent: (args) => {
        finalizeArgs.push(args);
        return { error: null };
      },
    });

    const r = await paymentIntentService.closeSession('i1', OWNER);
    expect(r.status).toBe('failed');
    // Caso AMBIGUO: el transfer PUDO haberse ejecutado on-chain → NO refundar.
    expect(refunds).toEqual([]);
    // Reconciliable: flag RECONCILE en error_message + señal log.warn explícita.
    expect(String(finalizeArgs[0]?.p_error)).toMatch(/^RECONCILE:/);
    expect(logSpy.warn).toHaveBeenCalled();
  });

  it('sign() throws (INEQUÍVOCO) → refund del deposit COMPLETO', async () => {
    mockSign.mockRejectedValue(new Error('sig down'));
    const db = makeIntentDb({
      intent_type: 'session',
      authorized_usd: 10,
      consumed_usd: 4,
    });
    routeRpc(db.handlers);
    const r = await paymentIntentService.closeSession('i1', OWNER);
    expect(r.status).toBe('failed');
    expect(db.refunds).toEqual([10]); // deposit completo reembolsado, 1 vez
  });
});

// ── BLQ-1: upto debita al buyer ANTES de transferir (money-path) ──
describe('BLQ-1 upto debit-before-transfer', () => {
  function uptoOpenClose(final: number): void {
    routeRpc({
      close_payment_intent_for_settle: () => ({
        data: [
          {
            final_amount: final,
            prev_status: 'open',
            intent_type: 'upto',
            key_id: 'k1',
            chain_id: 2368,
            pay_to: PAYTO,
            authorized_usd: 5,
            consumed_usd: final,
            settle_tx_hash: null,
          },
        ],
        error: null,
      }),
      finalize_payment_intent: () => ({ error: null }),
    });
  }

  it('success → debita min(cap,uso) ANTES del transfer; budget_post == budget_pre − charged', async () => {
    happySettle();
    let budget = 10;
    const budgetPre = budget;
    const order: string[] = [];
    // El settle empuja 'transfer' al orden.
    mockSettle.mockImplementation(async () => {
      order.push('transfer');
      return { txHash: '0xTX', success: true };
    });
    routeRpc({
      close_payment_intent_for_settle: () => ({
        data: [
          {
            final_amount: 5,
            prev_status: 'open',
            intent_type: 'upto',
            key_id: 'k1',
            chain_id: 2368,
            pay_to: PAYTO,
            authorized_usd: 5,
            consumed_usd: 5,
            settle_tx_hash: null,
          },
        ],
        error: null,
      }),
      increment_a2a_key_spend: (args) => {
        order.push('debit');
        const amt = Number(args.p_amount_usd);
        if (amt > budget) {
          return { data: null, error: { message: 'INSUFFICIENT_BUDGET' } };
        }
        budget -= amt;
        return { data: null, error: null };
      },
      finalize_payment_intent: () => ({ error: null }),
    });

    const r = await paymentIntentService.settleUpto('i1', OWNER, 8); // uso 8 > cap 5
    expect(r.status).toBe('settled');
    expect(r.finalAmountUsd).toBe(5); // clamp al cap
    // Invariante money-path: se debitó exactamente min(cap,uso)=5.
    expect(budget).toBe(budgetPre - 5);
    // Y el débito ocurrió ANTES de la transferencia on-chain.
    expect(order).toEqual(['debit', 'transfer']);
  });

  it('budget insuficiente → settle FALLA sin transferir (fail-closed)', async () => {
    happySettle();
    uptoOpenClose(5);
    routeRpc({
      close_payment_intent_for_settle: () => ({
        data: [
          {
            final_amount: 5,
            prev_status: 'open',
            intent_type: 'upto',
            key_id: 'k1',
            chain_id: 2368,
            pay_to: PAYTO,
            authorized_usd: 5,
            consumed_usd: 5,
            settle_tx_hash: null,
          },
        ],
        error: null,
      }),
      increment_a2a_key_spend: () => ({
        data: null,
        error: { message: 'INSUFFICIENT_BUDGET: chain 2368 balance is 1' },
      }),
      finalize_payment_intent: () => ({ error: null }),
    });

    await expect(
      paymentIntentService.settleUpto('i1', OWNER, 5),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BUDGET' });
    // NUNCA se transfirió al seller.
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it('transfer on-chain falla DESPUÉS del débito → refund del débito (buyer made whole)', async () => {
    mockSign.mockResolvedValue({
      paymentRequest: {
        authorization: { value: '1' },
        signature: '0xsig',
        network: 'kite',
      },
    });
    mockSettle.mockResolvedValue({ txHash: '', success: false, error: 'boom' });
    mockVerify.mockResolvedValue({ ok: true });
    let budget = 10;
    const db = makeIntentDb({
      intent_type: 'upto',
      authorized_usd: 5,
      consumed_usd: 0,
    });
    routeRpc({
      ...db.handlers,
      increment_a2a_key_spend: (args) => {
        budget -= Number(args.p_amount_usd);
        return { data: null, error: null };
      },
    });

    const r = await paymentIntentService.settleUpto('i1', OWNER, 5);
    expect(r.status).toBe('failed');
    // El refund del débito vive DENTRO de finalize (status-gated), no un RPC aparte.
    expect(db.refunds).toEqual([5]);
    budget += db.refunds.reduce((a, b) => a + b, 0);
    expect(budget).toBe(10); // buyer made whole
  });

  it('MNR-2: retry idempotente reporta el monto settleado real (consumed_usd), no el reportedUsage del request', async () => {
    happySettle();
    routeRpc({
      close_payment_intent_for_settle: () => ({
        data: [
          {
            final_amount: 0,
            prev_status: 'settled', // ya settleado
            intent_type: 'upto',
            key_id: 'k1',
            chain_id: 2368,
            pay_to: PAYTO,
            authorized_usd: 5,
            consumed_usd: 3, // monto REALMENTE settleado (persistido)
            settle_tx_hash: '0xTX',
          },
        ],
        error: null,
      }),
    });
    // El retry pasa reportedUsage=5, pero debe reportar el settleado real = 3.
    const r = await paymentIntentService.settleUpto('i1', OWNER, 5);
    expect(r.status).toBe('settled');
    expect(r.finalAmountUsd).toBe(3);
    expect(mockSettle).not.toHaveBeenCalled();
  });
});

// ── BLQ-2: huérfano en 'closing' recuperable (finalize falló) ────
describe('BLQ-2 closing orphan recovery', () => {
  it('session close con finalize fallando 1ª vez → recuperable en el retry, residual refundado 1 sola vez', async () => {
    happySettle();
    const db = makeIntentDb({
      intent_type: 'session',
      authorized_usd: 10,
      consumed_usd: 4,
    });
    db.state.failFinalize = 1; // el 1er finalize hace blip → huérfano 'closing'
    routeRpc(db.handlers);

    // 1er close: settle on-chain OK, finalize FALLA → huérfano en 'closing'.
    const r1 = await paymentIntentService.closeSession('i1', OWNER);
    expect(r1.status).toBe('settled'); // el dinero se movió on-chain
    expect(db.refunds).toEqual([]); // residual AÚN no acreditado
    expect(db.row.settle_outcome).toBe('settled'); // veredicto persistido (record)

    // retry: ve 'closing' con veredicto 'settled' → finalize idempotente → residual.
    const r2 = await paymentIntentService.closeSession('i1', OWNER);
    expect(r2.status).toBe('settled');
    expect(db.refunds).toEqual([6]); // residual 10-4 acreditado EXACTAMENTE una vez
    expect(mockSettle).toHaveBeenCalledTimes(1); // NO re-settle en el retry
  });

  it('retry de closing con veredicto persistido y finalize aún fallando → NO reporta settled (INTERNAL para reintentar)', async () => {
    happySettle();
    // Huérfano GENUINO: veredicto ya persistido ('settled') pero el finalize sigue
    // caído. La recovery re-aplica el veredicto conocido; si finalize falla → INTERNAL
    // (que el retry/expireStale reintente). BLQ-MED-1: sólo con veredicto conocido se
    // finaliza en el path directo — un 'closing' con settle_outcome=NULL es in-flight.
    routeRpc({
      close_payment_intent_for_settle: () => ({
        data: [
          {
            final_amount: 0,
            prev_status: 'closing',
            intent_type: 'session',
            key_id: 'k1',
            chain_id: 2368,
            pay_to: PAYTO,
            authorized_usd: 10,
            consumed_usd: 4,
            settle_tx_hash: '0xTX',
            settle_outcome: 'settled',
          },
        ],
        error: null,
      }),
      finalize_payment_intent: () => ({ error: { message: 'still down' } }),
    });
    await expect(
      paymentIntentService.closeSession('i1', OWNER),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it('expireStale barre huérfanos en closing y re-ejecuta finalize', async () => {
    happySettle();
    const builder = {
      _status: undefined as string | undefined,
      select: () => builder,
      eq: (col: string, val: string) => {
        if (col === 'status') builder._status = val;
        return builder;
      },
      lt: () =>
        Promise.resolve({
          data:
            builder._status === 'closing'
              ? [{ id: 'i9', owner_ref: OWNER, intent_type: 'session' }]
              : [],
          error: null,
        }),
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    mockFrom.mockReturnValue(builder as any);
    const finalizeArgs: Record<string, unknown>[] = [];
    routeRpc({
      close_payment_intent_for_settle: () => ({
        data: [
          {
            final_amount: 0,
            prev_status: 'closing',
            intent_type: 'session',
            key_id: 'k1',
            chain_id: 2368,
            pay_to: PAYTO,
            authorized_usd: 10,
            consumed_usd: 4,
            settle_tx_hash: '0xTX',
            settle_outcome: 'settled',
          },
        ],
        error: null,
      }),
      finalize_payment_intent: (args) => {
        finalizeArgs.push(args);
        return { error: null };
      },
    });

    await paymentIntentService.expireStale();
    // El huérfano 'closing' con veredicto 'settled' → finalize con residual (6).
    expect(finalizeArgs).toHaveLength(1);
    expect(finalizeArgs[0]?.p_residual).toBeCloseTo(6, 8);
    expect(mockSettle).not.toHaveBeenCalled(); // NO re-settle
  });
});

// ── BLQ-DR: doble-fallo compuesto (fix de raíz del double-refund) ─
// Repro exacto del F4 QA: el settle resuelve un veredicto, PERO el finalize que
// aplica el refund + status flip falla (blip DB). El retry/expireStale re-aplica el
// veredicto PERSISTIDO — el refund vive dentro de finalize (status-gated) ⇒ se aplica
// EXACTAMENTE UNA VEZ, jamás dos. Servicio real; el finalize se modela con las mismas
// semánticas del RPC (status-gate + refund-inside), NO como un no-op que oculte el bug.
describe('BLQ-DR compound-failure (double-refund root fix)', () => {
  it('session fallo INEQUÍVOCO → finalize falla → retry → refund del deposit EXACTAMENTE una vez (budget_post == budget_pre)', async () => {
    // settle inequívoco: settle.success===false → NO hubo transfer on-chain.
    mockSign.mockResolvedValue({
      paymentRequest: {
        authorization: { value: '1' },
        signature: '0xsig',
        network: 'kite',
      },
    });
    mockSettle.mockResolvedValue({ txHash: '', success: false, error: 'boom' });
    mockVerify.mockResolvedValue({ ok: true });

    const db = makeIntentDb({
      intent_type: 'session',
      authorized_usd: 10,
      consumed_usd: 4,
    });
    db.state.failFinalize = 1; // el finalize del 1er intento hace blip
    routeRpc(db.handlers);

    const budgetPre = 100; // openSession ya debitó el deposit (10) → 90.

    // 1er close: settle inequívoco falla → record(unequivocal) OK → finalize BLIP.
    // El refund vive en finalize → NO se aplicó; el servicio propaga INTERNAL.
    await expect(
      paymentIntentService.closeSession('i1', OWNER),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(db.refunds).toEqual([]); // NADA reembolsado aún
    expect(db.row.status).toBe('closing'); // huérfano recuperable
    expect(db.row.settle_outcome).toBe('failed_unequivocal'); // veredicto persistido

    // retry: recovery lee 'failed_unequivocal' → finalize → refund del deposit 1 vez.
    const r2 = await paymentIntentService.closeSession('i1', OWNER);
    expect(r2.status).toBe('failed');
    expect(db.refunds).toEqual([10]); // deposit COMPLETO, exactamente una vez

    // 3er retry (terminal): no-op, refunds intactos (jamás 16 sobre 10).
    const r3 = await paymentIntentService.closeSession('i1', OWNER);
    expect(r3.status).toBe('failed');
    expect(db.refunds).toEqual([10]);

    const budgetPost = budgetPre - 10 + db.refunds.reduce((a, b) => a + b, 0);
    expect(budgetPost).toBe(budgetPre); // invariante restaurado (no +6 de más)
    expect(mockSettle).toHaveBeenCalledTimes(1); // NO re-settle en los retries
  });

  it('session ÉXITO → finalize falla → recovery re-acredita el residual EXACTAMENTE una vez', async () => {
    happySettle();
    const db = makeIntentDb({
      intent_type: 'session',
      authorized_usd: 10,
      consumed_usd: 4,
    });
    db.state.failFinalize = 1;
    routeRpc(db.handlers);

    // 1er close: settle OK, record('settled') OK, finalize BLIP (success NO throw).
    const r1 = await paymentIntentService.closeSession('i1', OWNER);
    expect(r1.status).toBe('settled'); // el dinero se movió on-chain
    expect(db.refunds).toEqual([]); // residual AÚN no acreditado
    expect(db.row.settle_outcome).toBe('settled');

    // retry: recovery lee 'settled' → acredita residual (10-4=6) una sola vez.
    const r2 = await paymentIntentService.closeSession('i1', OWNER);
    expect(r2.status).toBe('settled');
    expect(db.refunds).toEqual([6]);

    const r3 = await paymentIntentService.closeSession('i1', OWNER);
    expect(r3.status).toBe('settled');
    expect(db.refunds).toEqual([6]); // residual jamás doble
    expect(mockSettle).toHaveBeenCalledTimes(1);
  });

  it('session fallo AMBIGUO → finalize falla → recovery NO refunda (sigue reconcile)', async () => {
    happySettle();
    mockVerify.mockResolvedValue({ ok: false, reason: 'AMOUNT_MISMATCH' }); // ambiguo
    const db = makeIntentDb({
      intent_type: 'session',
      authorized_usd: 10,
      consumed_usd: 4,
    });
    db.state.failFinalize = 1;
    routeRpc(db.handlers);

    await expect(
      paymentIntentService.closeSession('i1', OWNER),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(db.refunds).toEqual([]);
    expect(db.row.settle_outcome).toBe('failed_ambiguous');

    // retry: recovery lee 'failed_ambiguous' → finalize → status failed, NO refund.
    const r2 = await paymentIntentService.closeSession('i1', OWNER);
    expect(r2.status).toBe('failed');
    expect(db.refunds).toEqual([]); // ambiguo → NUNCA refunda (evita doble-gasto)
    expect(db.row.status).toBe('failed');
    expect(String(db.row.error_message)).toMatch(/^RECONCILE:/);
  });

  it('upto fallo INEQUÍVOCO → finalize falla → retry vía expireStale → refund del débito una sola vez', async () => {
    mockSign.mockResolvedValue({
      paymentRequest: {
        authorization: { value: '1' },
        signature: '0xsig',
        network: 'kite',
      },
    });
    mockSettle.mockResolvedValue({ txHash: '', success: false, error: 'boom' });
    mockVerify.mockResolvedValue({ ok: true });

    const db = makeIntentDb({
      intent_type: 'upto',
      authorized_usd: 5,
      consumed_usd: 0,
    });
    db.state.failFinalize = 1;
    let budget = 10;
    routeRpc({
      ...db.handlers,
      increment_a2a_key_spend: (args) => {
        budget -= Number(args.p_amount_usd);
        return { data: null, error: null };
      },
    });

    // 1er settle: debita 5 (10→5), settle inequívoco falla, finalize BLIP → INTERNAL.
    await expect(
      paymentIntentService.settleUpto('i1', OWNER, 8),
    ).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(db.refunds).toEqual([]);
    expect(db.row.settle_outcome).toBe('failed_unequivocal');
    expect(budget).toBe(5); // debitado, aún no reembolsado

    // expireStale barre el 'closing' huérfano → recovery refunda el débito (5) 1 vez.
    const builder = {
      _status: undefined as string | undefined,
      select: () => builder,
      eq: (col: string, val: string) => {
        if (col === 'status') builder._status = val;
        return builder;
      },
      lt: () =>
        Promise.resolve({
          data:
            builder._status === 'closing'
              ? [{ id: 'i1', owner_ref: OWNER, intent_type: 'upto' }]
              : [],
          error: null,
        }),
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    mockFrom.mockReturnValue(builder as any);

    await paymentIntentService.expireStale();
    expect(db.refunds).toEqual([5]); // débito reembolsado exactamente una vez
    budget += db.refunds.reduce((a, b) => a + b, 0);
    expect(budget).toBe(10); // buyer made whole

    // otra pasada: terminal → sin doble-refund.
    await paymentIntentService.expireStale();
    expect(db.refunds).toEqual([5]);
    expect(mockSettle).toHaveBeenCalledTimes(1);
  });
});

// ── T-CONC: concurrencia (serializado por FOR UPDATE) ───────────
describe('T-CONC concurrencia', () => {
  it('2 closes concurrentes → settle 1 vez; el 2º ve closing sin veredicto (in-flight) → in_progress', async () => {
    happySettle();
    let seen = 0;
    routeRpc({
      close_payment_intent_for_settle: () => {
        seen += 1;
        const first = seen === 1;
        // BLQ-MED-1: durante el settle in-flight del 1º, el 2º close serializa por el
        // row-lock y ve 'closing' con settle_outcome=NULL (record_settle_outcome AÚN no
        // corrió). Modela la race REAL — antes hardcodeaba 'settled', lo que ocultaba el
        // bug: el 2º NO debe finalizar/mover dinero, debe devolver 'in_progress'.
        return {
          data: [
            {
              final_amount: first ? 4 : 0,
              prev_status: first ? 'open' : 'closing',
              intent_type: 'session',
              key_id: 'k1',
              chain_id: 2368,
              pay_to: PAYTO,
              authorized_usd: 10,
              consumed_usd: 4,
              settle_tx_hash: null,
              settle_outcome: null,
            },
          ],
          error: null,
        };
      },
      finalize_payment_intent: () => ({ error: null }),
    });
    const [a, b] = await Promise.all([
      paymentIntentService.closeSession('i1', OWNER),
      paymentIntentService.closeSession('i1', OWNER),
    ]);
    // exactamente uno settlea (el que ganó open→closing); el otro es no-op in_progress.
    expect([a.status, b.status].sort()).toEqual(['in_progress', 'settled']);
    expect(mockSettle).toHaveBeenCalledTimes(1);
  });

  // BLQ-MED-1: la race completa con la DB fiel — un 2º close aterriza DURANTE el settle
  // in-flight del 1º (settle_outcome=NULL) → NO finaliza ni mueve dinero; el 1º completa
  // con el veredicto real → residual reembolsado EXACTAMENTE UNA vez.
  it('close concurrente durante settle in-flight → no-op; el in-flight refunda 1 vez', async () => {
    const db = makeIntentDb({
      intent_type: 'session',
      authorized_usd: 10,
      consumed_usd: 4,
    });
    routeRpc(db.handlers);

    // sign feliz; settle GATEADO → el 1º close queda in-flight (row 'closing', outcome NULL).
    mockSign.mockResolvedValue({
      xPaymentHeader: 'h',
      paymentRequest: {
        authorization: { value: '1' },
        signature: '0xsig',
        network: 'kite',
      },
    });
    mockVerify.mockResolvedValue({ ok: true });
    let releaseSettle: (v: { txHash: string; success: boolean }) => void =
      () => {
        /* set below */
      };
    const gate = new Promise<{ txHash: string; success: boolean }>((res) => {
      releaseSettle = res;
    });
    mockSettle.mockReturnValue(gate);

    // 1º close: transiciona open→closing y se BLOQUEA en el settle gateado.
    const p1 = paymentIntentService.closeSession('i1', OWNER);
    // dejar que p1 avance hasta el gate (row ya 'closing', settle_outcome NULL).
    await new Promise((r) => setTimeout(r, 0));
    expect(db.row.status).toBe('closing');
    expect(db.row.settle_outcome).toBeNull();

    // 2º close CONCURRENTE dentro de la ventana in-flight → no-op in_progress.
    const r2 = await paymentIntentService.closeSession('i1', OWNER);
    expect(r2.status).toBe('in_progress');
    expect(db.refunds).toEqual([]); // NO movió dinero
    expect(db.row.status).toBe('closing'); // NO finalizó (no 'failed')

    // el 1º (in-flight) termina con éxito → record 'settled' + finalize → refunda residual.
    releaseSettle({ txHash: '0xTX', success: true });
    const r1 = await p1;
    expect(r1.status).toBe('settled');
    expect(db.row.status).toBe('settled');
    expect(db.refunds).toEqual([6]); // residual (10-4) reembolsado EXACTAMENTE una vez
    expect(mockSettle).toHaveBeenCalledTimes(1);
  });
});
