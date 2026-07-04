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
    expect(finalizeArgs[0]?.p_success).toBe(true);
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
    expect(finalizeArgs[0]?.p_success).toBe(true);
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

  it('verify.ok===false → failed, NO settled, NO refund', async () => {
    happySettle();
    mockVerify.mockResolvedValue({ ok: false, reason: 'AMOUNT_MISMATCH' });
    openSessionClose();
    const r = await paymentIntentService.closeSession('i1', OWNER);
    expect(r.status).toBe('failed');
    // finalize se llamó con p_success=false y sin refund (p_residual null).
    expect(mockRpc).toHaveBeenCalledWith(
      'finalize_payment_intent',
      expect.objectContaining({ p_success: false, p_residual: null }),
    );
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
    const refunds: number[] = [];
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
        budget -= Number(args.p_amount_usd);
        return { data: null, error: null };
      },
      refund_a2a_key_spend: (args) => {
        refunds.push(Number(args.p_amount_usd));
        budget += Number(args.p_amount_usd);
        return { data: 1, error: null };
      },
      finalize_payment_intent: () => ({ error: null }),
    });

    const r = await paymentIntentService.settleUpto('i1', OWNER, 5);
    expect(r.status).toBe('failed');
    expect(refunds).toEqual([5]); // se reembolsó el débito
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
    let status = 'open';
    let finalizeCalls = 0;
    const refunds: number[] = [];
    routeRpc({
      close_payment_intent_for_settle: () => {
        const prev = status;
        if (status === 'open') status = 'closing';
        return {
          data: [
            {
              final_amount: prev === 'open' ? 4 : 0,
              prev_status: prev,
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
        };
      },
      finalize_payment_intent: (args) => {
        finalizeCalls += 1;
        // El 1er finalize falla (blip DB) → el intent queda 'closing' huérfano.
        if (finalizeCalls === 1) return { error: { message: 'db blip' } };
        // Recovery: sólo actúa mientras 'closing' (idempotente, sin doble-refund).
        if (status === 'closing') {
          if (args.p_success && args.p_residual) {
            refunds.push(Number(args.p_residual));
          }
          status = 'settled';
        }
        return { error: null };
      },
    });

    // 1er close: settle on-chain OK, finalize FALLA → huérfano en 'closing'.
    const r1 = await paymentIntentService.closeSession('i1', OWNER);
    expect(r1.status).toBe('settled'); // el dinero se movió on-chain
    expect(refunds).toEqual([]); // residual AÚN no acreditado

    // retry: ve 'closing' → re-ejecuta finalize idempotente → acredita residual.
    const r2 = await paymentIntentService.closeSession('i1', OWNER);
    expect(r2.status).toBe('settled');
    expect(refunds).toEqual([6]); // residual 10-4 acreditado EXACTAMENTE una vez
    expect(mockSettle).toHaveBeenCalledTimes(1); // NO re-settle en el retry
  });

  it('retry de closing con finalize aún fallando → NO reporta settled (INTERNAL para reintentar)', async () => {
    happySettle();
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
            settle_tx_hash: null,
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
    // El huérfano 'closing' disparó un finalize con el residual recomputado (6).
    expect(finalizeArgs).toHaveLength(1);
    expect(finalizeArgs[0]?.p_residual).toBeCloseTo(6, 8);
    expect(mockSettle).not.toHaveBeenCalled(); // NO re-settle
  });
});

// ── T-CONC: concurrencia (serializado por FOR UPDATE) ───────────
describe('T-CONC concurrencia', () => {
  it('2 closes concurrentes → settle 1 vez (2º ve closing)', async () => {
    happySettle();
    let seen = 0;
    routeRpc({
      close_payment_intent_for_settle: () => {
        seen += 1;
        const first = seen === 1;
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
              settle_tx_hash: first ? null : '0xTX',
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
    expect([a.status, b.status]).toContain('settled');
    expect(mockSettle).toHaveBeenCalledTimes(1);
  });
});
