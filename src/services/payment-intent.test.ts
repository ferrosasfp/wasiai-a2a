/**
 * Payment Intent Service — money-path tests (WKH-135).
 *
 * Cubre: T-AC1 (idempotencia close), T-AC2 / T-AC2b (refund residual), T-AC3 (cap
 * inviolable), T-AC4 (owner guard IDOR), T-AC6 (expiry), T-SIG (firma cap +
 * replay), T-VCHR (voucher idempotente), T-VERIFY (settle on-chain), T-CONC
 * (concurrencia). supabase.rpc + adapter + verifier + viem mockeados.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks (hoisted logger) ──────────────────────────────────────
const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({ getLogger: () => logSpy }));

const mockSign = vi.fn();
const mockSettle = vi.fn();
// WKH-191a (T-8): la captura real (debit-capture.ts) consume getDefaultChainKey +
// getAdaptersBundle del registry. Se stubean para que el path real llegue al RPC
// (mock aditivo: el resto de la suite NO los usa).
const mockGetDefaultChainKey = vi.fn(() => 'kite');
const mockGetAdaptersBundle = vi.fn(() => ({
  payment: { supportedTokens: [{ decimals: 6, symbol: 'USDC' }] },
}));
// WKH-192: supportedTokens seteable por test para variar decimals del default chain.
// Default 18d = modela el default chain Kite de HOY → la suite preexistente byte-idéntica.
const mockSupportedTokens = vi.hoisted(() => ({
  current: [{ decimals: 18, symbol: 'PYUSD' }] as
    | { decimals: number; symbol: string }[]
    | undefined,
}));
vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: () => ({
    sign: mockSign,
    settle: mockSettle,
    supportedTokens: mockSupportedTokens.current,
  }),
  getDefaultChainKey: () => mockGetDefaultChainKey(),
  getAdaptersBundle: () => mockGetAdaptersBundle(),
}));

// WKH-191a (T-8): resolveEscrowContract del path real de captura. Truthy → el
// gate escrow pasa y la captura llega al RPC capture_debit_signature.
const mockResolveEscrowContract = vi.fn(
  (): string | null => '0x1111111111111111111111111111111111111111',
);
vi.mock('../adapters/escrow-verifier.js', () => ({
  resolveEscrowContract: () => mockResolveEscrowContract(),
}));

const mockVerify = vi.fn().mockResolvedValue({ ok: true });
vi.mock('../adapters/settle-verifier.js', () => ({
  verifyDefaultChainSettle: (...a: unknown[]) => mockVerify(...a),
}));

const mockRecover = vi.fn();
// WKH-191a (T-8): la captura real usa keccak256/parseUnits/stringToBytes de viem
// → se preserva el módulo real y sólo se overridea recoverTypedDataAddress.
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    recoverTypedDataAddress: (...a: unknown[]) => mockRecover(...a),
  };
});

vi.mock('../lib/supabase.js', () => ({
  supabase: { rpc: vi.fn(), from: vi.fn() },
}));

// WKH-139: expireStale importa dinámicamente arbiterService para barrer huérfanos
// 'arb_closing' (recoverArbClosing) y 'disputed' (revertDisputeToOpen). Mock del
// módulo para verificar el CABLEADO (import dinámico + iteración) sin cargar el real.
const mockRecoverArbClosing = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const mockRevertDisputeToOpen = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
vi.mock('./arbiter.js', () => ({
  arbiterService: {
    recoverArbClosing: (...a: unknown[]) => mockRecoverArbClosing(...a),
    revertDisputeToOpen: (...a: unknown[]) => mockRevertDisputeToOpen(...a),
  },
}));

// WKH-191b: gate + reader del two-hop settle. Partial mock de debit-capture.js
// para preservar `captureDebitSignatureBestEffort` REAL (T-8 lo ejercita) y sólo
// overridear el gate + reader. Default `isEscrowSettleEnabled` = false → todos los
// tests heredados corren el path operator-custodial byte-idéntico (flag OFF).
const mockIsEscrowSettleEnabled = vi.hoisted(() => vi.fn(() => false));
const mockReadValidDebitSignature = vi.hoisted(() =>
  vi.fn((_args: unknown) => undefined as unknown),
);
vi.mock('../adapters/escrow/debit-capture.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../adapters/escrow/debit-capture.js')
    >();
  return {
    ...actual,
    isEscrowSettleEnabled: () => mockIsEscrowSettleEnabled(),
    readValidDebitSignature: (args: unknown) =>
      mockReadValidDebitSignature(args),
  };
});

// WKH-191b: ejecutor hop 1 + wrappers RPC (mock completo — el módulo real es on-chain).
const mockExecuteDebitHop1 = vi.hoisted(() =>
  vi.fn((_args: unknown) => undefined as unknown),
);
const mockRecordDebitHop1 = vi.hoisted(() =>
  vi.fn(async (_args: unknown) => '0xhop1' as string | null),
);
const mockRecordDebitSettleStatus = vi.hoisted(() =>
  vi.fn(async (_args: unknown) => undefined),
);
vi.mock('../adapters/escrow/debit-executor.js', () => ({
  executeDebitHop1: (args: unknown) => mockExecuteDebitHop1(args),
  recordDebitHop1: (args: unknown) => mockRecordDebitHop1(args),
  recordDebitSettleStatus: (args: unknown) => mockRecordDebitSettleStatus(args),
}));

import { supabase } from '../lib/supabase.js';
import type { CreateUptoInput } from '../types/index.js';
import {
  paymentIntentService,
  settleEscrowAware,
  settlePaymentIntentOnChain,
  usdToAtomic,
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
  // WKH-192: reset a 18d (default chain Kite) → suite preexistente byte-idéntica.
  mockSupportedTokens.current = [{ decimals: 18, symbol: 'PYUSD' }];
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

  it('MNR-2: siembra arb_closing stale → recoverArbClosing corre 1× (import dinámico + query)', async () => {
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
            builder._status === 'arb_closing'
              ? [{ id: 'iA', owner_ref: OWNER }]
              : [],
          error: null,
        }),
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    mockFrom.mockReturnValue(builder as any);
    routeRpc({});

    await paymentIntentService.expireStale();
    expect(mockRecoverArbClosing).toHaveBeenCalledTimes(1);
    expect(mockRecoverArbClosing).toHaveBeenCalledWith('iA', OWNER, true);
    expect(mockRevertDisputeToOpen).not.toHaveBeenCalled();
  });

  it('BLQ-BAJO-1 (c): siembra disputed stale → revertDisputeToOpen corre 1× (desbrickea)', async () => {
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
            builder._status === 'disputed'
              ? [{ id: 'iD', owner_ref: OWNER }]
              : [],
          error: null,
        }),
    };
    // biome-ignore lint/suspicious/noExplicitAny: test double
    mockFrom.mockReturnValue(builder as any);
    routeRpc({});

    await paymentIntentService.expireStale();
    expect(mockRevertDisputeToOpen).toHaveBeenCalledTimes(1);
    expect(mockRevertDisputeToOpen).toHaveBeenCalledWith('iD', OWNER);
    expect(mockRecoverArbClosing).not.toHaveBeenCalled();
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

// ── T-8: captura best-effort NUNCA rompe el settle (CD-2/DT-4/R-4) ──
// INTEGRACIÓN: se ejercita el `captureDebitSignatureBestEffort` REAL (NO se mockea
// el wrapper). El RPC subyacente `capture_debit_signature` throwea (data-layer error)
// → el wrapper real lo atrapa (no-throw, CD-2) y el settle sigue byte-idéntico. El
// no-throw del wrapper en aislamiento lo cubre T-7 (debit-capture.test.ts); acá se
// valida que la integración settle↔captura no se rompe aunque la captura falle.
describe('T-8 captura best-effort no rompe el settle', () => {
  // Flag ON: el gate secundario del wrapper real deja correr la captura.
  beforeEach(() => {
    process.env.ESCROW_DEBIT_CAPTURE_ENABLED = 'true';
    // buyer_wallet owner-guarded que lee el path real de captura (paso 5).
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: () =>
        Promise.resolve({
          data: { buyer_wallet: '0xabc0000000000000000000000000000000000001' },
          error: null,
        }),
    };
    // biome-ignore lint/suspicious/noExplicitAny: supabase builder test double
    mockFrom.mockReturnValue(builder as any);
    mockRecover.mockResolvedValue('0xabc0000000000000000000000000000000000001');
  });

  afterEach(() => {
    delete process.env.ESCROW_DEBIT_CAPTURE_ENABLED;
  });

  // El RPC de captura throwea (error del data-layer) → persist() re-lanza → el
  // wrapper real lo traga. Se compone con los handlers money-path del fake DB.
  const explodingCapture: RpcHandler = () => ({
    data: null,
    error: { message: 'db boom (capture)' },
  });

  it('closeSession: el RPC de captura throwea → SettleOutcome normal, sin propagar', async () => {
    const db = makeIntentDb({
      intent_type: 'session',
      authorized_usd: 10,
      consumed_usd: 0, // finalMicro<=0 → settled sin on-chain (la captura corre igual)
    });
    routeRpc({ ...db.handlers, capture_debit_signature: explodingCapture });

    const r = await paymentIntentService.closeSession('i1', OWNER, false, {
      signature: '0xdeadbeef',
      nonce: '1',
      deadline: 9_999_999_999,
      amount: '1000000',
    });

    expect(r.status).toBe('settled');
    // el path REAL de captura llegó al RPC (no un stub del wrapper)…
    expect(
      mockRpc.mock.calls.some((c) => c[0] === 'capture_debit_signature'),
    ).toBe(true);
    // …y su error fue tragado por el wrapper real (best-effort no-throw).
    expect(logSpy.warn).toHaveBeenCalled();
    expect(db.row.status).toBe('settled'); // settle byte-idéntico pese al throw
  });

  it('settleUpto: el RPC de captura throwea → SettleOutcome normal, sin propagar', async () => {
    const db = makeIntentDb({
      intent_type: 'upto',
      authorized_usd: 5,
      consumed_usd: 0,
    });
    routeRpc({ ...db.handlers, capture_debit_signature: explodingCapture });

    const r = await paymentIntentService.settleUpto('i1', OWNER, 0, false, {
      signature: '0xdeadbeef',
      nonce: '1',
      deadline: 9_999_999_999,
      amount: '1000000',
    });

    expect(r.status).toBe('settled');
    expect(
      mockRpc.mock.calls.some((c) => c[0] === 'capture_debit_signature'),
    ).toBe(true);
    expect(logSpy.warn).toHaveBeenCalled();
    expect(db.row.status).toBe('settled');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WKH-191b — settleEscrowAware (two-hop, flag-gated). Reader/executor/RPC
// mockeados; el SEAM (settlePaymentIntentOnChain) es REAL y se controla vía el
// payment adapter (mockSign/mockSettle/mockVerify). Debe ir AL FINAL del archivo:
// deja `isEscrowSettleEnabled` en ON dentro del describe y lo restaura por
// afterEach (los tests heredados corren antes, con el default OFF).
// ════════════════════════════════════════════════════════════════════════════
describe('WKH-191b settleEscrowAware (two-hop)', () => {
  const ESCROW = '0x1111111111111111111111111111111111111111';

  function baseEscrowRow(overrides: Record<string, unknown> = {}) {
    return {
      debit_signature: `0x${'ab'.repeat(65)}`,
      debit_amount_atomic: '3700000',
      debit_deadline: 9_999_999_999,
      debit_nonce: '7',
      debit_key_id_hash: '0xkeyhash',
      debit_hop1_tx_hash: null,
      debit_settle_status: null,
      ...overrides,
    };
  }

  function callEscrow(overrides: Record<string, unknown> = {}) {
    return settleEscrowAware({
      intentId: 'i1',
      ownerRef: OWNER,
      payTo: PAYTO,
      finalAmountUsd: 3.7,
      chainId: 2368,
      keyId: 'k1',
      ...overrides,
    });
  }

  // seam → failed_unequivocal (sign ok, settle.success===false, ANTES de verify).
  function failSettleUnequivocal(): void {
    mockSign.mockResolvedValue({
      paymentRequest: {
        authorization: { value: '1' },
        signature: '0xsig',
        network: 'kite',
      },
    });
    mockSettle.mockResolvedValue({ success: false, error: 'settle failed' });
  }

  beforeEach(() => {
    mockIsEscrowSettleEnabled.mockReturnValue(true);
    mockResolveEscrowContract.mockReturnValue(ESCROW);
    mockGetDefaultChainKey.mockReturnValue('kite');
    mockReadValidDebitSignature.mockResolvedValue(baseEscrowRow());
    mockExecuteDebitHop1.mockResolvedValue({
      kind: 'confirmed',
      txHash: '0xhop1',
      blockNumber: 1n,
    });
    mockRecordDebitHop1.mockResolvedValue('0xhop1');
    mockRecordDebitSettleStatus.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Restaurar el default OFF (clearAllMocks NO resetea implementaciones).
    mockIsEscrowSettleEnabled.mockReturnValue(false);
    mockResolveEscrowContract.mockReturnValue(ESCROW);
  });

  // ── T-1: happy path — hop1 confirmed → recordDebitHop1 ANTES de hop2 → settled ──
  it('T-1 (AC-1): confirmed → recordDebitHop1 antes del seam; settled con txHash del hop2', async () => {
    happySettle(); // seam → { settled, txHash: '0xTX' }

    const outcome = await callEscrow();

    expect(mockExecuteDebitHop1).toHaveBeenCalledTimes(1);
    // BLQ-DR/CD-3: recordDebitHop1 ANTES del seam (mockSign es el 1er paso del seam).
    expect(mockRecordDebitHop1).toHaveBeenCalled();
    const hop1Order = mockRecordDebitHop1.mock.invocationCallOrder[0] as number;
    const signOrder = mockSign.mock.invocationCallOrder[0] as number;
    expect(hop1Order).toBeLessThan(signOrder);
    expect(mockRecordDebitSettleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'settled' }),
    );
    expect(outcome.status).toBe('settled');
    expect(outcome.txHash).toBe('0xTX');
  });

  // ── T-2: flag OFF → seam en la 1ª línea, cero lecturas ──
  it('T-2 (AC-2): flag OFF → seam byte-idéntico; reader/executor NUNCA llamados', async () => {
    mockIsEscrowSettleEnabled.mockReturnValue(false);
    happySettle();

    const outcome = await callEscrow();

    expect(mockReadValidDebitSignature).not.toHaveBeenCalled();
    expect(mockExecuteDebitHop1).not.toHaveBeenCalled();
    expect(outcome.status).toBe('settled');
    expect(outcome.txHash).toBe('0xTX');
  });

  // ── T-2b: flag ON pero sin firma valid → fallback al seam ──
  it('T-2b (AC-2): readValidDebitSignature → null → seam; executor nunca llamado', async () => {
    mockReadValidDebitSignature.mockResolvedValue(null);
    happySettle();

    const outcome = await callEscrow();

    expect(mockExecuteDebitHop1).not.toHaveBeenCalled();
    expect(outcome.status).toBe('settled');
    expect(outcome.txHash).toBe('0xTX');
  });

  // ── T-3: hop1 not_moved → fallback operador-custodial, cero evidencia ──
  it('T-3 (AC-3): hop1 not_moved → seam; record* NUNCA llamados; settle completa', async () => {
    mockExecuteDebitHop1.mockResolvedValue({
      kind: 'not_moved',
      reason: 'REVERTED',
    });
    happySettle();

    const outcome = await callEscrow();

    expect(outcome.status).toBe('settled');
    expect(outcome.txHash).toBe('0xTX');
    expect(mockRecordDebitHop1).not.toHaveBeenCalled();
    expect(mockRecordDebitSettleStatus).not.toHaveBeenCalled();
  });

  // ── T-4: hop1 confirmed + hop2 fail → reconcile + remap unequivocal→ambiguous ──
  it('T-4 (AC-4): hop2 failed_unequivocal → remap ambiguous + reconciliation_pending', async () => {
    failSettleUnequivocal(); // seam → failed_unequivocal

    const outcome = await callEscrow();

    expect(outcome.status).toBe('failed');
    expect(outcome.failureKind).toBe('ambiguous'); // REMAP (CD-S4)
    expect(outcome.error).toMatch(/^RECONCILE-ESCROW:/);
    expect(mockRecordDebitSettleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'reconciliation_pending' }),
    );
  });

  // ── HU-198: el hop 2 de resultado DESCONOCIDO no puede quedar auto-reclamable ──
  //
  // LA PROPIEDAD DE DINERO: `reconciliation_pending` lo AUTO-RECLAMA
  // `claim_reconciliation` y, sin `debit_resolution_tx_hash` que verificar,
  // `reconciliation.ts` RE-ENVÍA el hop 2. Si el hop 2 original pudo haber pagado
  // (settle que TIRÓ — p.ej. el techo de wall-clock del hop pieverse), ese re-envío
  // paga DOS VECES al seller. Por eso ese caso va a `resolving_settle`, que el claim
  // no reclama sin tx previa. Los dos tests son el par: sin el de abajo
  // (`unequivocal` → `reconciliation_pending`) alguien podría mandar TODO a
  // `resolving_settle` y romper el caso legítimo de re-envío sin que nada se ponga
  // rojo.
  it('T-198-Escrow-Ambiguous: hop2 que TIRÓ (pudo haber pagado) → resolving_settle, NO reconciliation_pending', async () => {
    // settle() que rechaza ⇒ `settlePaymentIntentOnChain` devuelve
    // failureKind:'ambiguous' (la tx pudo haberse broadcasteado antes del throw).
    mockSign.mockResolvedValue({
      paymentRequest: {
        authorization: { value: '1' },
        signature: '0xsig',
        network: 'kite',
      },
    });
    mockSettle.mockRejectedValue(
      new Error('Facilitator network error on settle: aborted due to timeout'),
    );

    const outcome = await callEscrow();

    expect(outcome.status).toBe('failed');
    expect(outcome.failureKind).toBe('ambiguous');
    // El estado persistido es el NO auto-reclamable.
    expect(mockRecordDebitSettleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'resolving_settle' }),
    );
    // Y NO el que dispararía el re-envío ciego.
    expect(mockRecordDebitSettleStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'reconciliation_pending' }),
    );
  });

  it('T-198-Escrow-Unequivocal: hop2 rechazado por el facilitator → sigue en reconciliation_pending (el re-envío ES correcto)', async () => {
    // Contra-ejemplo del anterior: probado que el hop 2 NO se ejecutó, re-enviarlo es
    // para lo que existe el lado settle del reconciliador. Si esto también fuera
    // `resolving_settle`, el seller nunca cobraría automáticamente.
    failSettleUnequivocal();

    const outcome = await callEscrow();

    expect(outcome.status).toBe('failed');
    expect(mockRecordDebitSettleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'reconciliation_pending' }),
    );
    expect(mockRecordDebitSettleStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'resolving_settle' }),
    );
  });

  // ── T-4 (caller): closeSession con hop2 fail → finalize failed_ambiguous, NO refund ──
  it('T-4 caller: closeSession hop2-fail → finalize failed_ambiguous, NO refund', async () => {
    const db = makeIntentDb({
      intent_type: 'session',
      authorized_usd: 10,
      consumed_usd: 4, // finalMicro>0 → llega al settle
    });
    routeRpc(db.handlers);
    failSettleUnequivocal();

    const r = await paymentIntentService.closeSession('i1', OWNER);

    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/^RECONCILE-ESCROW:/);
    // remap → failed_ambiguous → NO refund (los fondos del buyer ya salieron en hop1).
    expect(db.row.settle_outcome).toBe('failed_ambiguous');
    expect(db.refunds).toEqual([]);
  });

  // ── T-4b: hop1 ambiguous → reconcile SIN hop2 SIN refund ──
  it('T-4b (AC-4): hop1 ambiguous → seam NUNCA llamado; reconciliation_pending; sin refund', async () => {
    mockExecuteDebitHop1.mockResolvedValue({
      kind: 'ambiguous',
      reason: 'RECEIPT_TIMEOUT',
      txHash: '0xhop1',
    });

    const outcome = await callEscrow();

    expect(mockSign).not.toHaveBeenCalled(); // hop 2 (seam) nunca corrió
    expect(mockRecordDebitHop1).toHaveBeenCalledWith(
      expect.objectContaining({ txHash: '0xhop1' }),
    );
    expect(mockRecordDebitSettleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'reconciliation_pending' }),
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.failureKind).toBe('ambiguous');
    expect(outcome.error).toBe(
      'RECONCILE-ESCROW: hop1 ambiguous (RECEIPT_TIMEOUT)',
    );
  });

  // ── T-5: exactly-once — hop1 tx ya persistido → skip hop1, ir directo a hop2 ──
  it('T-5 (AC-5): debit_hop1_tx_hash seteado → executeDebitHop1 NUNCA; seam corre; settled', async () => {
    mockReadValidDebitSignature.mockResolvedValue(
      baseEscrowRow({ debit_hop1_tx_hash: '0xhop1prev' }),
    );
    happySettle();

    const outcome = await callEscrow();

    expect(mockExecuteDebitHop1).not.toHaveBeenCalled();
    expect(mockSign).toHaveBeenCalled(); // seam (hop 2) corrió
    expect(mockRecordDebitSettleStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'settled' }),
    );
    expect(outcome.status).toBe('settled');
  });

  // ── T-6: chain sin escrow → fallback al seam, cero hop1 ──
  it('T-6 (AC-6): resolveEscrowContract=null → seam; reader/executor nunca llamados', async () => {
    mockResolveEscrowContract.mockReturnValue(null);
    happySettle();

    const outcome = await callEscrow();

    expect(mockReadValidDebitSignature).not.toHaveBeenCalled();
    expect(mockExecuteDebitHop1).not.toHaveBeenCalled();
    expect(outcome.status).toBe('settled');
    expect(outcome.txHash).toBe('0xTX');
  });

  // ── T-9: reader/executor lanza → settleEscrowAware NO rechaza, cae al seam ──
  it('T-9 (CD-S5): readValidDebitSignature lanza → fallback al seam, no rechaza', async () => {
    mockReadValidDebitSignature.mockRejectedValue(new Error('reader boom'));
    happySettle();

    const outcome = await callEscrow();
    expect(outcome.status).toBe('settled');
    expect(outcome.txHash).toBe('0xTX');
  });

  it('T-9 (CD-S5): executeDebitHop1 lanza → fallback al seam; closeSession normal', async () => {
    mockExecuteDebitHop1.mockRejectedValue(new Error('executor boom'));
    const db = makeIntentDb({
      intent_type: 'session',
      authorized_usd: 10,
      consumed_usd: 4,
    });
    routeRpc(db.handlers);
    happySettle();

    const r = await paymentIntentService.closeSession('i1', OWNER);
    expect(r.status).toBe('settled'); // el seam corrió byte-idéntico
    expect(db.row.status).toBe('settled');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WKH-192 — settle decimals-aware (usdToAtomic + wiring del seam).
// T-1/T-2 unit puros (import directo). T-3/T-4/T-5 ejercitan el SEAM
// (settlePaymentIntentOnChain) variando mockSupportedTokens.current. T-6 hereda
// vía settleEscrowAware (two-hop). Legacy = BigInt(round(usd*1e6))*BigInt(1e12).
// ════════════════════════════════════════════════════════════════════════════
describe('WKH-192 settle decimals-aware', () => {
  // Fórmula legacy inline (18d) para la convergencia byte-idéntica (CD-2/CD-AB3).
  const legacyWei = (usd: number): string =>
    String(BigInt(Math.round(usd * 1_000_000)) * BigInt(1_000_000_000_000));

  // ── T-1 (AC-2, AC-6, CD-2): convergencia byte-idéntica Kite 18d ──
  it('T-1: usdToAtomic(usd,18) === legacy usdToWei byte-a-byte (incl. 6d de precisión)', () => {
    for (const usd of [1.5, 0.333333, 100, 0.000001]) {
      expect(usdToAtomic(usd, 18)).toBe(legacyWei(usd));
    }
  });

  // ── T-2 (AC-1, AC-6): Base 6d atómico correcto (10¹² menos que 18d) ──
  it('T-2: usdToAtomic(usd,6) es el atómico 6d; == 10¹² menos que 18d', () => {
    expect(usdToAtomic(1.5, 6)).toBe('1500000');
    for (const x of [1.5, 0.333333, 100, 0.000001, 42.42]) {
      expect(BigInt(usdToAtomic(x, 6)) * 10n ** 12n).toBe(
        BigInt(usdToAtomic(x, 18)),
      );
    }
  });

  // ── T-3 (AC-3, CD-7): fallback ?? 18 sin token → nunca throw, byte-idéntico ──
  it('T-3: supportedTokens undefined/[] → fallback 18d (legacy), settled, sin throw', async () => {
    const usd = 5;
    for (const tokens of [
      undefined,
      [] as { decimals: number; symbol: string }[],
    ]) {
      vi.clearAllMocks();
      mockSupportedTokens.current = tokens;
      happySettle();
      const r = await settlePaymentIntentOnChain({
        intentId: 'i1',
        ownerRef: OWNER,
        payTo: PAYTO,
        finalAmountUsd: usd,
        chainId: 2368,
      });
      expect(r.status).toBe('settled');
      expect(mockSign.mock.calls[0]?.[0]).toMatchObject({
        value: usdToAtomic(usd, 18),
      });
      expect(usdToAtomic(usd, 18)).toBe(legacyWei(usd));
    }
  });

  // ── T-4 (AC-1, AC-4): Base 6d → sign y verify reciben el MISMO atómico 6d ──
  it('T-4: default 6d → sign(value) y verify(requiredAmountAtomic) convergen en 6d', async () => {
    const usd = 5;
    mockSupportedTokens.current = [{ decimals: 6, symbol: 'USDC' }];
    happySettle();
    const r = await settlePaymentIntentOnChain({
      intentId: 'i1',
      ownerRef: OWNER,
      payTo: PAYTO,
      finalAmountUsd: usd,
      chainId: 2368,
    });
    expect(r.status).toBe('settled');
    // sign firma el atómico 6d, NO el 18d (falsificable: si el wiring hardcodeara
    // 18, este value sería 10¹² mayor y el assert fallaría).
    expect(mockSign.mock.calls[0]?.[0]).toMatchObject({
      value: usdToAtomic(usd, 6),
    });
    expect(mockSign.mock.calls[0]?.[0]?.value).not.toBe(usdToAtomic(usd, 18));
    // verify recibe el MISMO atómico derivado (no diverge).
    expect(mockVerify.mock.calls[0]?.[0]).toMatchObject({
      requiredAmountAtomic: BigInt(usdToAtomic(usd, 6)),
    });
  });

  // ── T-5 (AC-2): operator-custodial Kite 18d intacto (byte-idéntico al legacy) ──
  it('T-5: default 18d (escrow OFF) → sign recibe el value byte-idéntico al legacy; settled', async () => {
    const usd = 5;
    // default beforeEach: supportedTokens 18d, isEscrowSettleEnabled OFF.
    happySettle();
    const r = await settlePaymentIntentOnChain({
      intentId: 'i1',
      ownerRef: OWNER,
      payTo: PAYTO,
      finalAmountUsd: usd,
      chainId: 2368,
    });
    expect(r.status).toBe('settled');
    expect(mockSign.mock.calls[0]?.[0]?.value).toBe(legacyWei(usd));
  });

  // ── T-6 (AC-5): herencia transparente two-hop (191b) en 6d ──
  it('T-6: settleEscrowAware two-hop 6d → hop2 firma el mismo atómico que el hop1', async () => {
    const ESCROW = '0x1111111111111111111111111111111111111111';
    const usd = 3.7;
    const atomic6 = usdToAtomic(usd, 6); // '3700000'
    mockSupportedTokens.current = [{ decimals: 6, symbol: 'USDC' }];
    mockIsEscrowSettleEnabled.mockReturnValue(true);
    mockResolveEscrowContract.mockReturnValue(ESCROW);
    mockGetDefaultChainKey.mockReturnValue('kite');
    mockReadValidDebitSignature.mockResolvedValue({
      debit_signature: `0x${'ab'.repeat(65)}`,
      debit_amount_atomic: atomic6, // hop 1 atómico 6d
      debit_deadline: 9_999_999_999,
      debit_nonce: '7',
      debit_key_id_hash: '0xkeyhash',
      debit_hop1_tx_hash: null,
      debit_settle_status: null,
    });
    mockExecuteDebitHop1.mockResolvedValue({
      kind: 'confirmed',
      txHash: '0xhop1',
      blockNumber: 1n,
    });
    mockRecordDebitHop1.mockResolvedValue('0xhop1');
    mockRecordDebitSettleStatus.mockResolvedValue(undefined);
    happySettle();

    const outcome = await settleEscrowAware({
      intentId: 'i1',
      ownerRef: OWNER,
      payTo: PAYTO,
      finalAmountUsd: usd,
      chainId: 2368,
      keyId: 'k1',
    });

    expect(outcome.status).toBe('settled');
    // el hop 2 (seam, SIN líneas nuevas) firma el atómico 6d que converge con el hop1.
    expect(mockSign.mock.calls[0]?.[0]?.value).toBe(atomic6);
    mockIsEscrowSettleEnabled.mockReturnValue(false);
  });
});
