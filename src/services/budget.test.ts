/**
 * Budget Service Unit Tests — WKH-34
 * Tests: AC-8 (getBalance), AC-9 (debit), AC-10 (registerDeposit), AC-11 (daily reset)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock structured logger ──────────────────────────────────
// budget.ts logs server-side via getLogger('budget'). Mock it so tests can
// assert the (object, message) shape — including the security invariant that
// the raw Postgres message is logged server-side but NEVER leaked to the caller.
const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({
  getLogger: () => logSpy,
}));

// ── Mock supabase ───────────────────────────────────────────

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
}));

// WKH-101 (CD-AB-1): budget.ts now imports delegationService + exceedsPerTxLimit.
// exceedsPerTxLimit must keep its REAL decimal-safe behaviour for T7b, so we
// re-export the actual impl and only mock the service methods that hit the DB.
vi.mock('./delegation.js', async () => {
  const actual =
    await vi.importActual<typeof import('./delegation.js')>('./delegation.js');
  return {
    exceedsPerTxLimit: actual.exceedsPerTxLimit,
    delegationService: {
      debitDelegationAndParent: vi.fn(),
    },
  };
});

// WKH-124: budget.ts now emits budget_debit receipts fire-and-forget on the
// key-session / delegation success paths. Mock the service so we can assert the
// emission shape WITHOUT touching the debit signature (CD-7) and so a rejecting
// emit cannot affect the debit result (CD-1 / AC-6).
vi.mock('./receipt.js', () => ({
  receiptService: { emit: vi.fn() },
}));

// WKH-124 (MNR-3): exercise the key-session success path to assert its receipt
// emission. budget.ts routes to keySessionService.debitSessionAndParent on that
// path; mock it so we can drive a success without hitting the DB.
vi.mock('./key-session.js', () => ({
  keySessionService: {
    debitSessionAndParent: vi.fn(),
  },
}));

import { supabase } from '../lib/supabase.js';
import { budgetService } from './budget.js';
import { delegationService } from './delegation.js';
import { keySessionService } from './key-session.js';
import { receiptService } from './receipt.js';
import {
  AgentKeyBudgetExhaustedError,
  AgentKeyInactiveError,
  AgentKeyNotFoundError,
  DailyLimitExceededError,
  DelegationExpiredError,
  DelegationNotFoundError,
  DelegationRevokedError,
  DelegationTotalLimitExceededError,
  DepositAlreadyCreditedError,
  DepositAmountInvalidError,
  DepositBelowMinimumError,
  DepositMinimumNotConfiguredError,
  DestCapExceededError,
  InvalidDebitAmountError,
  OwnershipMismatchError,
} from './security/errors.js';

const mockFrom = vi.mocked(supabase.from);
const mockRpc = vi.mocked(supabase.rpc);
const mockDebitDelegation = vi.mocked(
  delegationService.debitDelegationAndParent,
);
const mockReceiptEmit = vi.mocked(receiptService.emit);
const mockDebitSession = vi.mocked(keySessionService.debitSessionAndParent);

const DELEGATION_CTX = {
  delegationId: 'del-1',
  ownerRef: 'user-1',
  keyId: 'key-1',
  maxAmountPerTx: '0.50',
};

// WKH-124 (MNR-3): key-session debit context (no per-tx limit field).
const KEY_SESSION_CTX = {
  sessionId: 'sess-1',
  ownerRef: 'user-1',
  keyId: 'key-1',
};

// ── Helpers ─────────────────────────────────────────────────

function chainMock(overrides: Record<string, unknown> = {}) {
  const chain: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    ...overrides,
  };
  for (const key of ['select', 'update', 'eq']) {
    if (!overrides[key]) {
      (chain[key] as ReturnType<typeof vi.fn>).mockReturnValue(chain);
    }
  }
  return chain;
}

// ── Tests ───────────────────────────────────────────────────

describe('budgetService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // WKH-124: emit is fire-and-forget (`.emit(...).catch(...)`); default it to a
    // resolved promise so the `.catch` chain never sees `undefined`.
    mockReceiptEmit.mockResolvedValue(undefined);
  });

  describe('getBalance', () => {
    it('returns "0" for missing chain entry (AC-8)', async () => {
      const mock = chainMock();
      mock.single = vi.fn().mockResolvedValue({
        data: { budget: { '1': '5.00' } },
        error: null,
      });
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );

      const result = await budgetService.getBalance('key-1', 2368, 'user-1');
      expect(result).toBe('0');
    });

    it('returns correct balance for existing chain (AC-8)', async () => {
      const mock = chainMock();
      mock.single = vi.fn().mockResolvedValue({
        data: { budget: { '2368': '10.500000' } },
        error: null,
      });
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );

      const result = await budgetService.getBalance('key-1', 2368, 'user-1');
      expect(result).toBe('10.500000');
    });

    it('throws on DB error', async () => {
      const mock = chainMock();
      mock.single = vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'DB down' },
      });
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );

      await expect(budgetService.getBalance('x', 1, 'user-1')).rejects.toThrow(
        'Failed to get balance: DB down',
      );
    });

    it('throws OwnershipMismatchError when owner mismatch (AC-3)', async () => {
      const mock = chainMock();
      mock.single = vi.fn().mockResolvedValue({
        data: null,
        error: { code: 'PGRST116', message: 'no rows' },
      });
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );

      await expect(
        budgetService.getBalance('key-of-other-owner', 2368, 'user-A'),
      ).rejects.toMatchObject({ code: 'OWNERSHIP_MISMATCH' });

      expect(mock.eq).toHaveBeenCalledWith('owner_ref', 'user-A');
    });
  });

  describe('debit', () => {
    it('calls supabase.rpc with correct params and returns success (AC-9)', async () => {
      mockRpc.mockResolvedValue({ data: null, error: null } as never);

      const result = await budgetService.debit(
        'key-1',
        2368,
        1.5,
        undefined,
        undefined,
        undefined,
        'user-1',
      );

      expect(mockRpc).toHaveBeenCalledWith('increment_a2a_key_spend', {
        p_key_id: 'key-1',
        p_chain_id: 2368,
        p_amount_usd: 1.5,
        p_owner_ref: 'user-1',
      });
      expect(result).toEqual({ success: true });
    });

    // ── WKH-234 (W5) fix-pack AR-BLQ-1: CAIP-2 aditivo + ownership guard ──
    // Nota: el registro del leg Solana NO se hace ya dentro de `debit` (el
    // débito per-step es fee-on-attempt y precede al settle downstream donde
    // nace la firma). Se hace vía `recordSolanaSettleReceipt`, invocado por
    // `compose` DESPUÉS del settle. El threading end-to-end compose→receipt se
    // valida en compose.test.ts (T-234-AC8-INTEG). Estos units cubren el emit.
    const SOL_CAIP2 = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
    const SOL_SIG = '5'.repeat(64);

    it('T-234-AC8: recordSolanaSettleReceipt emits receipt with settle_caip2/settle_signature; reuses ownerRef (no a2a_agent_keys query)', () => {
      mockReceiptEmit.mockClear();
      mockRpc.mockClear();

      budgetService.recordSolanaSettleReceipt({
        keyId: 'key-1',
        ownerRef: 'user-1',
        chainId: 900001, // sentinel DT-8
        amountUsd: 0.5,
        settleCaip2: SOL_CAIP2,
        settleSignature: SOL_SIG,
      });

      // Additive Solana settle receipt carries the CAIP-2 + base58 signature,
      // reusing the caller's ownerRef (CD-1/AC-9 — no new a2a_agent_keys query).
      expect(mockReceiptEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerRef: 'user-1',
          agentKeyId: 'key-1',
          chainId: 900001,
          settleCaip2: SOL_CAIP2,
          settleSignature: SOL_SIG,
        }),
      );
      // No RPC over a2a_agent_keys is opened by the receipt path (CD-1/AC-9).
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('T-234-AC8b: EVM leg debit does NOT emit a solana settle receipt (column stays NULL, byte-identical)', async () => {
      mockRpc.mockResolvedValue({ data: null, error: null } as never);
      mockReceiptEmit.mockClear();

      await budgetService.debit(
        'key-1',
        2368,
        1.5,
        undefined,
        undefined,
        undefined,
        'user-1',
      );

      const solanaEmit = mockReceiptEmit.mock.calls.find(
        (c) => (c[0] as { settleCaip2?: string }).settleCaip2 !== undefined,
      );
      expect(solanaEmit).toBeUndefined();
    });

    it('T-234-AC9: recordSolanaSettleReceipt threads the caller ownerRef verbatim into the receipt (ownership guard datum reused)', () => {
      mockReceiptEmit.mockClear();

      budgetService.recordSolanaSettleReceipt({
        keyId: 'key-1',
        ownerRef: 'owner-A',
        chainId: 900001,
        amountUsd: 0.5,
        settleCaip2: SOL_CAIP2,
        settleSignature: SOL_SIG,
      });

      // The receipt carries the AUTHENTICATED caller's owner_ref (reused, not
      // re-derived from the target row) — no cross-tenant leak (CD-1/AC-9).
      expect(mockReceiptEmit).toHaveBeenCalledWith(
        expect.objectContaining({ ownerRef: 'owner-A', agentKeyId: 'key-1' }),
      );
    });

    it('returns failure with DAILY_LIMIT error from Postgres (AC-9)', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: {
          message: 'DAILY_LIMIT: daily spend would be 9 + 2 = 11, limit is 10',
        },
      } as never);

      const result = await budgetService.debit(
        'key-1',
        2368,
        2,
        undefined,
        undefined,
        undefined,
        'user-1',
      );

      // M5 (audit 2026-06-24): el msg crudo de PG NO se propaga — se mapea al
      // código estable DAILY_LIMIT (espejo de la ruta dest-policy).
      expect(result).toEqual({
        success: false,
        error: 'DAILY_LIMIT',
      });
    });

    it('returns failure with INSUFFICIENT_BUDGET error from Postgres (AC-9)', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: {
          message: 'INSUFFICIENT_BUDGET: chain 2368 balance is 1, requested 5',
        },
      } as never);

      const result = await budgetService.debit(
        'key-1',
        2368,
        5,
        undefined,
        undefined,
        undefined,
        'user-1',
      );

      // M5 (audit 2026-06-24): el msg crudo de PG NO se propaga — se mapea al
      // código estable AGENT_KEY_BUDGET_EXHAUSTED (espejo de la ruta dest-policy).
      expect(result).toEqual({
        success: false,
        error: 'AGENT_KEY_BUDGET_EXHAUSTED',
      });
    });

    // M5 (audit 2026-06-24): un error PG genérico/inesperado en la ruta master
    // NO debe filtrar el msg crudo (info disclosure) → código estable
    // DEBIT_FAILED + log server-side. Espejo de la ruta dest-policy.
    it('master debit maps a generic Postgres error to DEBIT_FAILED, never the raw message (M5)', async () => {
      const rawPgMsg =
        'duplicate key value violates unique constraint "a2a_spend_pkey" DETAIL: Key (id)=(abc) already exists.';
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: rawPgMsg },
      } as never);
      const result = await budgetService.debit(
        'key-1',
        2368,
        1,
        undefined,
        undefined,
        undefined,
        'user-1',
      );

      expect(result).toEqual({ success: false, error: 'DEBIT_FAILED' });
      // El msg crudo NUNCA llega al caller.
      expect(JSON.stringify(result)).not.toContain('constraint');
      expect(JSON.stringify(result)).not.toContain('a2a_spend_pkey');
      // El detalle SÍ se loguea server-side.
      expect(logSpy.error).toHaveBeenCalledWith(
        expect.objectContaining({ detail: rawPgMsg }),
        'master debit failed',
      );
    });

    // ── WKH-142: guard de importe negativo → code estable DEBIT_INVALID_AMOUNT ──

    // T7 (master route): el prefijo INVALID_AMOUNT del RPC (guard NULL/<0/NaN) se
    // mapea al code estable DEBIT_INVALID_AMOUNT, sin filtrar el msg crudo de PG.
    it('T7 master route maps INVALID_AMOUNT → DEBIT_INVALID_AMOUNT (CD-8)', async () => {
      const rawPgMsg =
        'INVALID_AMOUNT: p_amount_usd -1 must be a non-negative number';
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: rawPgMsg },
      } as never);

      const result = await budgetService.debit(
        'key-1',
        2368,
        -1,
        undefined,
        undefined,
        undefined,
        'user-1',
      );

      expect(result).toEqual({ success: false, error: 'DEBIT_INVALID_AMOUNT' });
      // El msg crudo de PG NUNCA llega al caller.
      expect(JSON.stringify(result)).not.toContain('p_amount_usd');
    });

    // T7 (master-dest route): mismo mapeo bajo debit_with_dest_policy.
    it('T7 master-dest route maps INVALID_AMOUNT → DEBIT_INVALID_AMOUNT (CD-8)', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: {
          message:
            'INVALID_AMOUNT: p_amount_usd -1 must be a non-negative number',
        },
      } as never);

      const result = await budgetService.debit(
        'key-1',
        2368,
        -1,
        undefined,
        undefined,
        'kite/translator',
        'user-1',
      );

      expect(result).toEqual({ success: false, error: 'DEBIT_INVALID_AMOUNT' });
    });

    // T8 (session route): el service key-session lanza InvalidDebitAmountError;
    // budget.ts lo mapea al code estable DEBIT_INVALID_AMOUNT.
    it('T8 session route maps InvalidDebitAmountError → DEBIT_INVALID_AMOUNT (CD-8)', async () => {
      mockDebitSession.mockRejectedValue(new InvalidDebitAmountError());

      const result = await budgetService.debit(
        'key-1',
        2368,
        -1,
        undefined,
        KEY_SESSION_CTX,
        undefined,
        'user-1',
      );

      expect(result).toEqual({ success: false, error: 'DEBIT_INVALID_AMOUNT' });
      // No emite receipt en el path de fallo.
      expect(mockReceiptEmit).not.toHaveBeenCalled();
    });

    // T8 (delegation route): el service delegation lanza InvalidDebitAmountError;
    // budget.ts lo mapea al code estable DEBIT_INVALID_AMOUNT.
    it('T8 delegation route maps InvalidDebitAmountError → DEBIT_INVALID_AMOUNT (CD-8)', async () => {
      mockDebitDelegation.mockRejectedValue(new InvalidDebitAmountError());

      const result = await budgetService.debit(
        'key-1',
        2368,
        0.3,
        DELEGATION_CTX,
        undefined,
        undefined,
        'user-1',
      );

      expect(result).toEqual({ success: false, error: 'DEBIT_INVALID_AMOUNT' });
      expect(mockReceiptEmit).not.toHaveBeenCalled();
    });

    // T9 (no-regresión): un débito POSITIVO legítimo sigue funcionando (master).
    it('T9 no-regression: positive debit still succeeds (master route)', async () => {
      mockRpc.mockResolvedValue({ data: null, error: null } as never);

      const result = await budgetService.debit(
        'key-1',
        2368,
        1.0,
        undefined,
        undefined,
        undefined,
        'user-1',
      );

      expect(mockRpc).toHaveBeenCalledWith('increment_a2a_key_spend', {
        p_key_id: 'key-1',
        p_chain_id: 2368,
        p_amount_usd: 1.0,
        p_owner_ref: 'user-1',
      });
      expect(result).toEqual({ success: true });
    });

    // ── WKH-101 (DT-11): delegation-aware debit ──────────────

    // T14 (AC-13): master key path — NO delegationContext → increment_a2a_key_spend,
    // NEVER calls debitDelegationAndParent (backward-compat, CD-5).
    it('T14 master key path uses increment_a2a_key_spend, not the delegation RPC (AC-13)', async () => {
      mockRpc.mockResolvedValue({ data: null, error: null } as never);

      const result = await budgetService.debit(
        'key-1',
        2368,
        1.5,
        undefined,
        undefined,
        undefined,
        'user-1',
      );

      expect(mockRpc).toHaveBeenCalledWith('increment_a2a_key_spend', {
        p_key_id: 'key-1',
        p_chain_id: 2368,
        p_amount_usd: 1.5,
        p_owner_ref: 'user-1',
      });
      expect(mockDebitDelegation).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    // T7b (AC-7 per-step): per-tx checked BEFORE the RPC; over-limit → fail,
    // debitDelegationAndParent is NOT invoked.
    it('T7b per-tx limit exceeded per-step blocks before the RPC (AC-7)', async () => {
      const result = await budgetService.debit(
        'key-1',
        2368,
        1.0,
        {
          ...DELEGATION_CTX,
          maxAmountPerTx: '0.50',
        },
        undefined,
        undefined,
        'user-1',
      );

      expect(result).toEqual({
        success: false,
        error: 'DELEGATION_TX_LIMIT_EXCEEDED',
      });
      expect(mockDebitDelegation).not.toHaveBeenCalled();
    });

    it('delegation path within per-tx limit calls debitDelegationAndParent (AC-8/AC-9)', async () => {
      mockDebitDelegation.mockResolvedValue('0.30');

      const result = await budgetService.debit(
        'key-1',
        2368,
        0.3,
        {
          ...DELEGATION_CTX,
          maxAmountPerTx: '0.50',
        },
        undefined,
        undefined,
        'user-1',
      );

      expect(mockDebitDelegation).toHaveBeenCalledWith(
        'del-1',
        'user-1',
        'key-1',
        2368,
        0.3,
        undefined,
      );
      expect(mockRpc).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    // WKH-125b (AC-1): cap por destino excedido bajo delegación → success:false,
    // budget no se decrementó (rollback de la tx en el RPC) → NO emite receipt.
    it('WKH-125b delegation DEST_CAP_EXCEEDED → { success:false, error:DEST_CAP_EXCEEDED } (AC-1)', async () => {
      mockDebitDelegation.mockRejectedValue(new DestCapExceededError());
      const result = await budgetService.debit(
        'key-1',
        2368,
        0.3,
        {
          ...DELEGATION_CTX,
          maxAmountPerTx: '0.50',
        },
        undefined,
        undefined,
        'user-1',
      );
      expect(result).toEqual({ success: false, error: 'DEST_CAP_EXCEEDED' });
      expect(mockReceiptEmit).not.toHaveBeenCalled();
    });

    // ── WKH-124 (AC-2): budget_debit receipt on the delegation success path ──
    it('WKH-124 (AC-2): delegation success emits budget_debit with delegation_id', async () => {
      mockDebitDelegation.mockResolvedValue('0.30');

      await budgetService.debit(
        'key-1',
        2368,
        0.3,
        {
          ...DELEGATION_CTX,
          maxAmountPerTx: '0.50',
        },
        undefined,
        undefined,
        'user-1',
      );

      expect(mockReceiptEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerRef: 'user-1',
          agentKeyId: 'key-1',
          sessionId: null,
          delegationId: 'del-1',
          receiptType: 'budget_debit',
          amountUsd: 0.3,
          chainId: 2368,
        }),
      );
    });

    it('WKH-124 (AC-2/AC-6): a rejecting emit does NOT break the debit result', async () => {
      mockDebitDelegation.mockResolvedValue('0.30');
      mockReceiptEmit.mockRejectedValue(new Error('receipt down'));

      const result = await budgetService.debit(
        'key-1',
        2368,
        0.3,
        {
          ...DELEGATION_CTX,
          maxAmountPerTx: '0.50',
        },
        undefined,
        undefined,
        'user-1',
      );

      expect(result).toEqual({ success: true });
    });

    // ── WKH-124 (AC-2, MNR-3): budget_debit receipt on the key-session path ──
    // Mirrors the delegation receipt test but for the key-session call-site
    // (budget.ts ~L88): asserts the session lineage (session_id + owner_ref +
    // agent_key_id) and budget_debit type without touching the debit signature.
    it('WKH-124 (AC-2): key-session success emits budget_debit with session_id', async () => {
      mockDebitSession.mockResolvedValue('0.30');

      await budgetService.debit(
        'key-1',
        2368,
        0.3,
        undefined,
        KEY_SESSION_CTX,
        undefined,
        'user-1',
      );

      expect(mockReceiptEmit).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerRef: 'user-1',
          agentKeyId: 'key-1',
          sessionId: 'sess-1',
          delegationId: null,
          receiptType: 'budget_debit',
          amountUsd: 0.3,
          chainId: 2368,
        }),
      );
    });

    it('WKH-124 (AC-2/AC-6): a rejecting emit does NOT break the key-session debit', async () => {
      mockDebitSession.mockResolvedValue('0.30');
      mockReceiptEmit.mockRejectedValue(new Error('receipt down'));

      const result = await budgetService.debit(
        'key-1',
        2368,
        0.3,
        undefined,
        KEY_SESSION_CTX,
        undefined,
        'user-1',
      );

      expect(result).toEqual({ success: true });
    });

    it('maps DelegationTotalLimitExceededError → DELEGATION_TOTAL_LIMIT_EXCEEDED (AC-8)', async () => {
      mockDebitDelegation.mockRejectedValue(
        new DelegationTotalLimitExceededError(),
      );
      const result = await budgetService.debit(
        'key-1',
        2368,
        0.1,
        {
          ...DELEGATION_CTX,
          maxAmountPerTx: '100',
        },
        undefined,
        undefined,
        'user-1',
      );
      expect(result).toEqual({
        success: false,
        error: 'DELEGATION_TOTAL_LIMIT_EXCEEDED',
      });
    });

    it('maps AgentKeyBudgetExhaustedError → AGENT_KEY_BUDGET_EXHAUSTED (AC-9)', async () => {
      mockDebitDelegation.mockRejectedValue(new AgentKeyBudgetExhaustedError());
      const result = await budgetService.debit(
        'key-1',
        2368,
        0.1,
        {
          ...DELEGATION_CTX,
          maxAmountPerTx: '100',
        },
        undefined,
        undefined,
        'user-1',
      );
      expect(result).toEqual({
        success: false,
        error: 'AGENT_KEY_BUDGET_EXHAUSTED',
      });
    });

    it('maps DelegationRevokedError → DELEGATION_REVOKED (TOCTOU)', async () => {
      mockDebitDelegation.mockRejectedValue(new DelegationRevokedError());
      const result = await budgetService.debit(
        'key-1',
        2368,
        0.1,
        {
          ...DELEGATION_CTX,
          maxAmountPerTx: '100',
        },
        undefined,
        undefined,
        'user-1',
      );
      expect(result).toEqual({ success: false, error: 'DELEGATION_REVOKED' });
    });

    it('maps DelegationExpiredError → DELEGATION_EXPIRED (TOCTOU)', async () => {
      mockDebitDelegation.mockRejectedValue(new DelegationExpiredError());
      const result = await budgetService.debit(
        'key-1',
        2368,
        0.1,
        {
          ...DELEGATION_CTX,
          maxAmountPerTx: '100',
        },
        undefined,
        undefined,
        'user-1',
      );
      expect(result).toEqual({ success: false, error: 'DELEGATION_EXPIRED' });
    });

    it('maps OwnershipMismatchError → OWNERSHIP_MISMATCH', async () => {
      mockDebitDelegation.mockRejectedValue(new OwnershipMismatchError());
      const result = await budgetService.debit(
        'key-1',
        2368,
        0.1,
        {
          ...DELEGATION_CTX,
          maxAmountPerTx: '100',
        },
        undefined,
        undefined,
        'user-1',
      );
      expect(result).toEqual({ success: false, error: 'OWNERSHIP_MISMATCH' });
    });

    // ── AR-MNR-1/AR-MNR-2: parent-RPC limits + no-raw-PG fallback ──

    it('AR-MNR-1 maps DailyLimitExceededError → DAILY_LIMIT (no raw PG)', async () => {
      mockDebitDelegation.mockRejectedValue(new DailyLimitExceededError());
      const result = await budgetService.debit(
        'key-1',
        2368,
        0.1,
        {
          ...DELEGATION_CTX,
          maxAmountPerTx: '100',
        },
        undefined,
        undefined,
        'user-1',
      );
      expect(result).toEqual({ success: false, error: 'DAILY_LIMIT' });
      expect(result.error).not.toContain('limit is');
    });

    it('AR-MNR-1 maps AgentKeyInactiveError → KEY_INACTIVE', async () => {
      mockDebitDelegation.mockRejectedValue(new AgentKeyInactiveError());
      const result = await budgetService.debit(
        'key-1',
        2368,
        0.1,
        {
          ...DELEGATION_CTX,
          maxAmountPerTx: '100',
        },
        undefined,
        undefined,
        'user-1',
      );
      expect(result).toEqual({ success: false, error: 'KEY_INACTIVE' });
    });

    it('AR-MNR-1 maps AgentKeyNotFoundError → KEY_NOT_FOUND', async () => {
      mockDebitDelegation.mockRejectedValue(new AgentKeyNotFoundError());
      const result = await budgetService.debit(
        'key-1',
        2368,
        0.1,
        {
          ...DELEGATION_CTX,
          maxAmountPerTx: '100',
        },
        undefined,
        undefined,
        'user-1',
      );
      expect(result).toEqual({ success: false, error: 'KEY_NOT_FOUND' });
    });

    it('AR-MNR-1 maps DelegationNotFoundError → DELEGATION_NOT_FOUND', async () => {
      mockDebitDelegation.mockRejectedValue(new DelegationNotFoundError());
      const result = await budgetService.debit(
        'key-1',
        2368,
        0.1,
        {
          ...DELEGATION_CTX,
          maxAmountPerTx: '100',
        },
        undefined,
        undefined,
        'user-1',
      );
      expect(result).toEqual({ success: false, error: 'DELEGATION_NOT_FOUND' });
    });

    it('AR-MNR-2 unmapped delegation error → DELEGATION_DEBIT_FAILED, no raw PG', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockDebitDelegation.mockRejectedValue(
        new Error('P0001: raw postgres detail 0xdeadbeef'),
      );
      const result = await budgetService.debit(
        'key-1',
        2368,
        0.1,
        {
          ...DELEGATION_CTX,
          maxAmountPerTx: '100',
        },
        undefined,
        undefined,
        'user-1',
      );
      expect(result).toEqual({
        success: false,
        error: 'DELEGATION_DEBIT_FAILED',
      });
      expect(result.error).not.toContain('postgres');
      expect(result.error).not.toContain('0xdeadbeef');
      errSpy.mockRestore();
    });

    // ── WKH-125 (KEY-CONSTRAINTS): dest-aware master route ──────
    // N5 (audit 2026-07-02): the `mockOwnerSelect` helper (which mocked the
    // now-removed owner_ref cold-path SELECT) was deleted along with the SELECT.
    // With `ownerRef` a REQUIRED arg, every debit test threads a caller owner_ref
    // straight to the RPC — no cold-path to stub.

    // ── WKH-SEC-02b: owner guard DB-level en la ruta master-no-dest ──

    it('WKH-SEC-02b master: válido pasa p_owner_ref al RPC (AC-2)', async () => {
      mockRpc.mockResolvedValue({ data: null, error: null } as never);

      const result = await budgetService.debit(
        'key-1',
        2368,
        1.5,
        undefined,
        undefined,
        undefined,
        'user-1',
      );

      expect(mockRpc).toHaveBeenCalledWith('increment_a2a_key_spend', {
        p_key_id: 'key-1',
        p_chain_id: 2368,
        p_amount_usd: 1.5,
        p_owner_ref: 'user-1',
      });
      expect(result).toEqual({ success: true });
    });

    it('WKH-SEC-02b master: OWNERSHIP_MISMATCH mapea a code estable (AC-1/AC-6)', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'OWNERSHIP_MISMATCH: key x not owned by caller' },
      } as never);

      const result = await budgetService.debit(
        'key-1',
        2368,
        1.5,
        undefined,
        undefined,
        undefined,
        'user-1',
      );

      expect(result).toEqual({ success: false, error: 'OWNERSHIP_MISMATCH' });
    });

    // ── F-04 (audit 2026-06-29): threaded caller owner_ref ──────
    // The fix removes the tautological self-derivation: when the AUTHENTICATED
    // caller's owner_ref is threaded, it is fed to the RPC AS-IS and the
    // cold-path SELECT (supabase.from) is NEVER executed. This proves the guard
    // compares against the caller, not the target row.
    it('F-04 master: threaded ownerRef goes to p_owner_ref WITHOUT a cold-path SELECT', async () => {
      // No mockOwnerSelect — if the code SELECTs owner_ref, supabase.from is
      // unmocked and the call would blow up. We assert it is never touched.
      mockFrom.mockClear();
      mockRpc.mockResolvedValue({ data: null, error: null } as never);

      const result = await budgetService.debit(
        'key-1',
        2368,
        1.5,
        undefined,
        undefined,
        undefined,
        'caller-owner', // F-04: authenticated caller's owner_ref
      );

      expect(mockRpc).toHaveBeenCalledWith('increment_a2a_key_spend', {
        p_key_id: 'key-1',
        p_chain_id: 2368,
        p_amount_usd: 1.5,
        p_owner_ref: 'caller-owner', // the CALLER's owner, not a re-derived one
      });
      // No cold-path SELECT was performed (the security point of F-04).
      expect(mockFrom).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    it('F-04 dest-aware: threaded ownerRef goes to p_owner_ref WITHOUT a cold-path SELECT', async () => {
      mockFrom.mockClear();
      mockRpc.mockResolvedValue({ data: null, error: null } as never);

      const result = await budgetService.debit(
        'key-1',
        2368,
        1.5,
        undefined,
        undefined,
        'kite/translator',
        'caller-owner', // F-04: authenticated caller's owner_ref
      );

      expect(mockRpc).toHaveBeenCalledWith('debit_with_dest_policy', {
        p_key_id: 'key-1',
        p_chain_id: 2368,
        p_amount_usd: 1.5,
        p_owner_ref: 'caller-owner',
        p_destination: 'kite/translator',
      });
      expect(mockFrom).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    // AC-5 back-compat: SIN destino → increment_a2a_key_spend directo, sin
    // tocar la tabla de keys ni el RPC dest-aware (byte-idéntico a hoy).
    it('AC-5 back-compat: no destination → increment_a2a_key_spend directo', async () => {
      mockRpc.mockResolvedValue({ data: null, error: null } as never);

      const result = await budgetService.debit(
        'key-1',
        2368,
        1.5,
        undefined,
        undefined,
        undefined,
        'user-1',
      );

      expect(mockRpc).toHaveBeenCalledWith('increment_a2a_key_spend', {
        p_key_id: 'key-1',
        p_chain_id: 2368,
        p_amount_usd: 1.5,
        p_owner_ref: 'user-1',
      });
      expect(mockRpc).not.toHaveBeenCalledWith(
        'debit_with_dest_policy',
        expect.anything(),
      );
      expect(result).toEqual({ success: true });
    });

    // AC-2/AC-4/CD-1: con destino → debit_with_dest_policy (atómico). NO hay
    // check de cap app-layer separado: el service sólo invoca el RPC.
    it('AC-2/AC-4: with destination → debit_with_dest_policy (atomic RPC)', async () => {
      mockRpc.mockResolvedValue({ data: null, error: null } as never);

      const result = await budgetService.debit(
        'key-1',
        2368,
        1.5,
        undefined,
        undefined,
        'kite/translator',
        'user-1',
      );

      expect(mockRpc).toHaveBeenCalledWith('debit_with_dest_policy', {
        p_key_id: 'key-1',
        p_chain_id: 2368,
        p_amount_usd: 1.5,
        p_owner_ref: 'user-1',
        p_destination: 'kite/translator',
      });
      expect(mockRpc).not.toHaveBeenCalledWith(
        'increment_a2a_key_spend',
        expect.anything(),
      );
      expect(result).toEqual({ success: true });
    });

    // AC-2: cap excedido → DEST_CAP_EXCEEDED (mapeado del prefijo del RPC),
    // budget intacto (el rollback de la tx vive en el RPC).
    it('AC-2: DEST_CAP_EXCEEDED prefix → error code DEST_CAP_EXCEEDED', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'DEST_CAP_EXCEEDED: dest x accum 1 + 1 > cap 1' },
      } as never);

      const result = await budgetService.debit(
        'key-1',
        2368,
        1,
        undefined,
        undefined,
        'kite/translator',
        'user-1',
      );

      expect(result).toEqual({ success: false, error: 'DEST_CAP_EXCEEDED' });
    });

    // CD-B: prefijos heredados de increment_a2a_key_spend mapeados, sin leak PG.
    it('maps INSUFFICIENT_BUDGET prefix → AGENT_KEY_BUDGET_EXHAUSTED', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'INSUFFICIENT_BUDGET: chain 2368 balance is 1' },
      } as never);

      const result = await budgetService.debit(
        'key-1',
        2368,
        5,
        undefined,
        undefined,
        'kite/translator',
        'user-1',
      );

      expect(result).toEqual({
        success: false,
        error: 'AGENT_KEY_BUDGET_EXHAUSTED',
      });
    });

    // CD-B: error inesperado del RPC dest-aware → code estable, sin msg crudo PG.
    it('unmapped dest-policy error → DEST_POLICY_DEBIT_FAILED, no raw PG', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'P0001: raw postgres detail 0xdeadbeef' },
      } as never);

      const result = await budgetService.debit(
        'key-1',
        2368,
        1,
        undefined,
        undefined,
        'kite/translator',
        'user-1',
      );

      expect(result).toEqual({
        success: false,
        error: 'DEST_POLICY_DEBIT_FAILED',
      });
      expect(result.error).not.toContain('postgres');
      expect(result.error).not.toContain('0xdeadbeef');
      errSpy.mockRestore();
    });

    // AC-6 herencia: con session ctx + destino, el destino se propaga al
    // debitSessionAndParent (el RPC de sesión dispatcha a debit_with_dest_policy
    // → la sesión aplica el cap por destino de la PARENT key).
    it('AC-6: session + destination → debitSessionAndParent receives the destination', async () => {
      mockDebitSession.mockResolvedValue('0.30');

      await budgetService.debit(
        'key-1',
        2368,
        0.3,
        undefined,
        KEY_SESSION_CTX,
        'kite/translator',
        'user-1',
      );

      expect(mockDebitSession).toHaveBeenCalledWith(
        'sess-1',
        'user-1',
        'key-1',
        2368,
        0.3,
        'kite/translator',
      );
    });

    // AC-4 concurrencia: 2 débitos al mismo destino, cap=1, monto=1 c/u. El RPC
    // `debit_with_dest_policy` serializa (FOR UPDATE) → exactamente 1 pasa y el
    // otro recibe DEST_CAP_EXCEEDED. El service NO hace un check app-layer
    // separado: ambas llamadas dispatchan al MISMO RPC (assert de dispatch). El
    // ordenamiento de locks vive en el SQL (assert estructural en
    // spend-policy.test.ts).
    it('AC-4 concurrency: same destination cap=1 → exactly one passes (serialized by RPC)', async () => {
      // Simula la serialización del RPC: la 1ª llamada OK, la 2ª rechazada por el
      // cap (el SUM bajo lock ya incluye el débito de la 1ª).
      mockRpc
        .mockResolvedValueOnce({ data: null, error: null } as never)
        .mockResolvedValueOnce({
          data: null,
          error: { message: 'DEST_CAP_EXCEEDED: dest x accum 1 + 1 > cap 1' },
        } as never);

      const [r1, r2] = await Promise.all([
        budgetService.debit(
          'key-1',
          2368,
          1,
          undefined,
          undefined,
          'kite/x',
          'user-1',
        ),
        budgetService.debit(
          'key-1',
          2368,
          1,
          undefined,
          undefined,
          'kite/x',
          'user-1',
        ),
      ]);

      const passed = [r1, r2].filter((r) => r.success);
      const rejected = [r1, r2].filter((r) => !r.success);
      expect(passed).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.error).toBe('DEST_CAP_EXCEEDED');
      // Dispatch al RPC atómico en AMBAS (sin check app-layer separado, CD-1).
      const destCalls = mockRpc.mock.calls.filter(
        (c) => c[0] === 'debit_with_dest_policy',
      );
      expect(destCalls).toHaveLength(2);
    });

    // AC-6 + AC-2: la sesión hereda el cap → DEST_CAP_EXCEEDED se mapea igual.
    it('AC-6/AC-2: session inherits cap → DestCapExceededError maps to DEST_CAP_EXCEEDED', async () => {
      mockDebitSession.mockRejectedValue(new DestCapExceededError());

      const result = await budgetService.debit(
        'key-1',
        2368,
        1,
        undefined,
        KEY_SESSION_CTX,
        'kite/translator',
        'user-1',
      );

      expect(result).toEqual({ success: false, error: 'DEST_CAP_EXCEEDED' });
    });
  });

  describe('registerDeposit', () => {
    // El guard de minimo de deposito es FAIL-CLOSED: sin `A2A_DEPOSIT_MIN_USDC`
    // ningun deposito acredita en NINGUNA cadena. Los casos de este bloque prueban
    // el payload de la RPC, asi que necesitan el minimo puesto para llegar hasta
    // ella. El guard en si se prueba en el bloque de mas abajo.
    beforeEach(() => {
      process.env.A2A_DEPOSIT_MIN_USDC = '1';
    });
    afterEach(() => {
      delete process.env.A2A_DEPOSIT_MIN_USDC;
    });

    // T10 — firma v2 (6 args): pasa p_owner_ref + p_tx_hash + p_token a la rpc.
    it('passes p_owner_ref + p_tx_hash + p_token to rpc and returns balance (AC-1, AC-5, WKH-35)', async () => {
      mockRpc.mockResolvedValue({ data: '15.000000', error: null } as never);

      const result = await budgetService.registerDeposit(
        'key-1',
        2368,
        '10.00',
        'user-1',
        '0xdeadbeef',
        'PYUSD',
      );

      expect(mockRpc).toHaveBeenCalledWith('register_a2a_key_deposit', {
        p_key_id: 'key-1',
        p_chain_id: 2368,
        p_amount_usd: 10.0,
        p_owner_ref: 'user-1',
        p_tx_hash: '0xdeadbeef',
        p_token: 'PYUSD',
      });
      expect(result).toBe('15.000000');
    });

    it('passes p_token: null when token omitted (AC-10)', async () => {
      mockRpc.mockResolvedValue({ data: '5.000000', error: null } as never);

      await budgetService.registerDeposit(
        'key-1',
        2368,
        '5.00',
        'user-1',
        '0xfeed',
      );

      expect(mockRpc).toHaveBeenCalledWith('register_a2a_key_deposit', {
        p_key_id: 'key-1',
        p_chain_id: 2368,
        p_amount_usd: 5.0,
        p_owner_ref: 'user-1',
        p_tx_hash: '0xfeed',
        p_token: null,
      });
    });

    // ── WKH-315 (AC-3 / AC-13 / M12) — el 7º param, ADITIVO ─────────────────
    //
    // ⚠️ LA PROPIEDAD ES LA AUSENCIA DE LA CLAVE, no su valor. La llamada EVM tiene
    // que quedar BYTE-IDENTICA (CD-1): exactamente los 6 args nombrados de hoy. Un
    // `p_vm_family: vmFamily ?? 'evm'` parecería equivalente y no lo es — cambia el
    // payload que viaja a PostgREST y con eso la resolución de la sobrecarga.
    it('T-315-11b: SIN vmFamily el payload NO tiene la clave p_vm_family (CD-1, CD-9)', async () => {
      mockRpc.mockResolvedValue({ data: '5.000000', error: null } as never);

      await budgetService.registerDeposit(
        'key-1',
        2368,
        '5.00',
        'user-1',
        '0xfeed',
        'USDC',
      );

      // Se CAPTURA el arg y se inspeccionan sus claves: `toHaveBeenCalledWith` con
      // un objeto exacto ya lo cubre, pero esta aserción dice explícitamente QUE
      // propiedad se está protegiendo, para que no se pierda en un futuro refactor
      // del fixture de arriba.
      const [, args] = mockRpc.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(Object.hasOwn(args, 'p_vm_family')).toBe(false);
      expect(Object.keys(args).sort()).toEqual([
        'p_amount_usd',
        'p_chain_id',
        'p_key_id',
        'p_owner_ref',
        'p_token',
        'p_tx_hash',
      ]);
    });

    it("T-315-11b: con vmFamily 'solana' el payload SI la manda", async () => {
      mockRpc.mockResolvedValue({ data: '5.000000', error: null } as never);

      await budgetService.registerDeposit(
        'key-1',
        900001,
        '5.00',
        'user-1',
        'SoLaNaSiGnAtUrE',
        'USDC',
        'solana',
      );

      expect(mockRpc).toHaveBeenCalledWith('register_a2a_key_deposit', {
        p_key_id: 'key-1',
        p_chain_id: 900001,
        p_amount_usd: 5.0,
        p_owner_ref: 'user-1',
        p_tx_hash: 'SoLaNaSiGnAtUrE',
        p_token: 'USDC',
        p_vm_family: 'solana',
      });
    });

    it("T-315-11b: con vmFamily 'evm' EXPLICITO la manda (el default de la SQL no es el único camino)", async () => {
      // Andamiaje: prueba que el spread condicional depende de `undefined` y no de
      // una comparación contra `'solana'`. Si el código hiciera
      // `vmFamily === 'solana' ? {...} : {}`, este caso quedaría sin cubrir y una
      // llamada EVM explícita perdería el arg en silencio.
      mockRpc.mockResolvedValue({ data: '5.000000', error: null } as never);

      await budgetService.registerDeposit(
        'key-1',
        2368,
        '5.00',
        'user-1',
        '0xfeed',
        'USDC',
        'evm',
      );

      const [, args] = mockRpc.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(args.p_vm_family).toBe('evm');
    });

    // T11 — DEPOSIT_ALREADY_CREDITED → DepositAlreadyCreditedError. AC-3.
    it('maps DEPOSIT_ALREADY_CREDITED rpc error to DepositAlreadyCreditedError (AC-3)', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: {
          message:
            'DEPOSIT_ALREADY_CREDITED: chain 2368 tx 0xabc already credited',
        },
      } as never);

      await expect(
        budgetService.registerDeposit('key-1', 2368, '10', 'user-1', '0xabc'),
      ).rejects.toBeInstanceOf(DepositAlreadyCreditedError);
    });

    // T12 — OWNERSHIP_MISMATCH → OwnershipMismatchError. AC-5.
    it('maps OWNERSHIP_MISMATCH rpc error to OwnershipMismatchError (AC-5)', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: {
          message: 'OWNERSHIP_MISMATCH: key_id key-1 does not belong to caller',
        },
      } as never);

      await expect(
        budgetService.registerDeposit(
          'key-1',
          2368,
          '10',
          'other-owner',
          '0xabc',
        ),
      ).rejects.toBeInstanceOf(OwnershipMismatchError);
    });

    it('throws generic on other RPC error (BLQ-4)', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'KEY_NOT_FOUND: key_id x does not exist' },
      } as never);

      await expect(
        budgetService.registerDeposit('x', 1, '1', 'user-1', '0xabc'),
      ).rejects.toThrow('Failed to register deposit: KEY_NOT_FOUND');
    });
  });

  /**
   * Minimo de deposito, EN EL UNICO ACREDITADOR.
   *
   * `registerDeposit` es la unica funcion del repo que llama a la RPC
   * `register_a2a_key_deposit`, y esa RPC es lo unico que inserta en
   * `a2a_key_deposits` y suma al budget. Por eso los tests de abajo alcanzan para
   * afirmar que el guard aplica a TODAS las cadenas: no hay otro camino al credito.
   *
   * La afirmacion "no se consume la prueba" se assertea siempre de la misma forma:
   * `mockRpc` NO fue llamado. Sin RPC no hay INSERT, y sin INSERT el UNIQUE
   * (chain_id, tx_hash) sigue libre para el proximo intento.
   */
  describe('registerDeposit: minimo de deposito del camino de deposito', () => {
    const EVM_CHAIN = 43113;
    const SOLANA_CHAIN = 900001;
    const EVM_TX = `0x${'a'.repeat(64)}`;
    const SOLANA_SIG = 'So1anaSignatureBase58';

    afterEach(() => {
      delete process.env.A2A_DEPOSIT_MIN_USDC;
    });

    it('EXACTAMENTE el minimo ACREDITA: el borde va para adentro', async () => {
      process.env.A2A_DEPOSIT_MIN_USDC = '1';
      mockRpc.mockResolvedValue({ data: '1.000000', error: null } as never);

      const balance = await budgetService.registerDeposit(
        'key-1',
        EVM_CHAIN,
        '1',
        'user-1',
        EVM_TX,
        'USDC',
      );

      expect(balance).toBe('1.000000');
      expect(mockRpc).toHaveBeenCalledTimes(1);
    });

    it('UN ATOMO por debajo del minimo RECHAZA y NO llama a la RPC', async () => {
      process.env.A2A_DEPOSIT_MIN_USDC = '1';

      await expect(
        budgetService.registerDeposit(
          'key-1',
          EVM_CHAIN,
          '0.999999',
          'user-1',
          EVM_TX,
          'USDC',
        ),
      ).rejects.toBeInstanceOf(DepositBelowMinimumError);
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('muy por debajo (0.000001, el piso efectivo de antes de este guard) RECHAZA', async () => {
      process.env.A2A_DEPOSIT_MIN_USDC = '1';

      await expect(
        budgetService.registerDeposit(
          'key-1',
          EVM_CHAIN,
          '0.000001',
          'user-1',
          EVM_TX,
          'USDC',
        ),
      ).rejects.toBeInstanceOf(DepositBelowMinimumError);
      expect(mockRpc).not.toHaveBeenCalled();
    });

    // ── El guard es CHAIN-AGNOSTICO: mismo rechazo por las dos familias ───────
    //
    // `registerDeposit` no ramifica por cadena, asi que estos dos casos no prueban
    // dos implementaciones: prueban que hay UNA sola y que las dos familias pasan
    // por ella. Si alguien moviera el guard a la rama EVM de la ruta, el caso
    // Solana se pondria rojo.
    it('EVM (sin vmFamily): mismo rechazo, sin RPC', async () => {
      process.env.A2A_DEPOSIT_MIN_USDC = '1';

      await expect(
        budgetService.registerDeposit(
          'key-1',
          EVM_CHAIN,
          '0.5',
          'user-1',
          EVM_TX,
          'USDC',
        ),
      ).rejects.toBeInstanceOf(DepositBelowMinimumError);
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it("SOLANA (vmFamily 'solana'): mismo rechazo, sin RPC", async () => {
      process.env.A2A_DEPOSIT_MIN_USDC = '1';

      await expect(
        budgetService.registerDeposit(
          'key-1',
          SOLANA_CHAIN,
          '0.5',
          'user-1',
          SOLANA_SIG,
          'USDC',
          'solana',
        ),
      ).rejects.toBeInstanceOf(DepositBelowMinimumError);
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('SOLANA: exactamente el minimo tambien acredita (el guard no discrimina familia)', async () => {
      process.env.A2A_DEPOSIT_MIN_USDC = '1';
      mockRpc.mockResolvedValue({ data: '1.000000', error: null } as never);

      await budgetService.registerDeposit(
        'key-1',
        SOLANA_CHAIN,
        '1',
        'user-1',
        SOLANA_SIG,
        'USDC',
        'solana',
      );

      expect(mockRpc).toHaveBeenCalledTimes(1);
    });

    // ── Fail-closed ───────────────────────────────────────────────────────────

    it('env AUSENTE: rechaza, y el error dice QUE FALTA CONFIGURAR, no que el monto sea chico', async () => {
      delete process.env.A2A_DEPOSIT_MIN_USDC;

      const err = await budgetService
        .registerDeposit('key-1', EVM_CHAIN, '1000', 'user-1', EVM_TX, 'USDC')
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(DepositMinimumNotConfiguredError);
      expect(err).not.toBeInstanceOf(DepositBelowMinimumError);
      expect((err as Error).message).toContain('A2A_DEPOSIT_MIN_USDC');
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('env ausente en SOLANA tambien: el fail-closed no es de una cadena', async () => {
      delete process.env.A2A_DEPOSIT_MIN_USDC;

      await expect(
        budgetService.registerDeposit(
          'key-1',
          SOLANA_CHAIN,
          '1000',
          'user-1',
          SOLANA_SIG,
          'USDC',
          'solana',
        ),
      ).rejects.toBeInstanceOf(DepositMinimumNotConfiguredError);
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it.each([
      ['vacia', ''],
      ['espacios', '   '],
      ['negativa', '-1'],
      ['no numerica', 'un dolar'],
      ['NaN', 'NaN'],
      ['Infinity', 'Infinity'],
      ['cientifica', '1e6'],
      ['cero', '0'],
      ['sub-grilla', '1.0000001'],
    ])('env %s (%j): fail-closed, ni siquiera un deposito grande acredita', async (_label, raw) => {
      process.env.A2A_DEPOSIT_MIN_USDC = raw;

      await expect(
        budgetService.registerDeposit(
          'key-1',
          EVM_CHAIN,
          '1000',
          'user-1',
          EVM_TX,
          'USDC',
        ),
      ).rejects.toBeInstanceOf(DepositMinimumNotConfiguredError);
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it('un monto verificado ilegible NO acredita, y se distingue del "es chico"', async () => {
      process.env.A2A_DEPOSIT_MIN_USDC = '1';

      await expect(
        budgetService.registerDeposit(
          'key-1',
          EVM_CHAIN,
          'NaN',
          'user-1',
          EVM_TX,
          'USDC',
        ),
      ).rejects.toBeInstanceOf(DepositAmountInvalidError);
      expect(mockRpc).not.toHaveBeenCalled();
    });

    // ── La prueba NO se consume ───────────────────────────────────────────────

    it('el rechazo por monto NO consume la prueba: el MISMO tx acredita despues con el monto correcto', async () => {
      process.env.A2A_DEPOSIT_MIN_USDC = '1';

      // Intento 1: por debajo del minimo.
      await expect(
        budgetService.registerDeposit(
          'key-1',
          EVM_CHAIN,
          '0.25',
          'user-1',
          EVM_TX,
          'USDC',
        ),
      ).rejects.toBeInstanceOf(DepositBelowMinimumError);
      // La prueba de que la prueba no se consumio: NO hubo INSERT. El UNIQUE
      // (chain_id, tx_hash) sigue libre.
      expect(mockRpc).not.toHaveBeenCalled();

      // Intento 2: mismo tx_hash, monto correcto. Acredita.
      mockRpc.mockResolvedValue({ data: '2.000000', error: null } as never);
      const balance = await budgetService.registerDeposit(
        'key-1',
        EVM_CHAIN,
        '2',
        'user-1',
        EVM_TX,
        'USDC',
      );

      expect(balance).toBe('2.000000');
      expect(mockRpc).toHaveBeenCalledTimes(1);
      expect(mockRpc).toHaveBeenCalledWith('register_a2a_key_deposit', {
        p_key_id: 'key-1',
        p_chain_id: EVM_CHAIN,
        p_amount_usd: 2,
        p_owner_ref: 'user-1',
        p_tx_hash: EVM_TX, // el MISMO de la vez que se rechazo
        p_token: 'USDC',
      });
    });

    it('el rechazo por fail-closed tampoco consume la prueba', async () => {
      delete process.env.A2A_DEPOSIT_MIN_USDC;
      await expect(
        budgetService.registerDeposit(
          'key-1',
          SOLANA_CHAIN,
          '5',
          'user-1',
          SOLANA_SIG,
          'USDC',
          'solana',
        ),
      ).rejects.toBeInstanceOf(DepositMinimumNotConfiguredError);
      expect(mockRpc).not.toHaveBeenCalled();

      process.env.A2A_DEPOSIT_MIN_USDC = '1';
      mockRpc.mockResolvedValue({ data: '5.000000', error: null } as never);
      await budgetService.registerDeposit(
        'key-1',
        SOLANA_CHAIN,
        '5',
        'user-1',
        SOLANA_SIG,
        'USDC',
        'solana',
      );
      const [, args] = mockRpc.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(args.p_tx_hash).toBe(SOLANA_SIG);
    });

    // ── Que se le dice al caller ──────────────────────────────────────────────

    it('el error lleva el minimo requerido y NADA del depositante', async () => {
      process.env.A2A_DEPOSIT_MIN_USDC = '2.5';

      const err = (await budgetService
        .registerDeposit('key-1', EVM_CHAIN, '0.75', 'user-1', EVM_TX, 'USDC')
        .catch((e: unknown) => e)) as DepositBelowMinimumError;

      expect(err).toBeInstanceOf(DepositBelowMinimumError);
      expect(err.minimumUsdc).toBe('2.5');
      expect(err.message).toContain('2.5');
      // Ni el monto depositado, ni la key, ni el owner, ni el tx.
      expect(err.message).not.toContain('0.75');
      expect(err.message).not.toContain('key-1');
      expect(err.message).not.toContain('user-1');
      expect(err.message).not.toContain(EVM_TX);
    });

    it('el fail-closed se loguea (config del operador) y el rechazo por monto NO', async () => {
      // El de config tiene que ser ruidoso: nadie puede depositar hasta que se
      // arregle. El de monto no se loguea por intento, porque un log por rechazo es
      // el mismo amplificador que el guard busca desalentar.
      delete process.env.A2A_DEPOSIT_MIN_USDC;
      await budgetService
        .registerDeposit('key-1', EVM_CHAIN, '5', 'user-1', EVM_TX, 'USDC')
        .catch(() => undefined);
      expect(logSpy.error).toHaveBeenCalledTimes(1);
      const [meta] = logSpy.error.mock.calls[0] as [Record<string, unknown>];
      expect(meta.error_code).toBe('DEPOSIT_MINIMUM_NOT_CONFIGURED');
      expect(meta.envVar).toBe('A2A_DEPOSIT_MIN_USDC');
      // Sin datos del depositante en el log tampoco.
      expect(Object.keys(meta)).not.toContain('keyId');
      expect(Object.keys(meta)).not.toContain('ownerId');

      logSpy.error.mockClear();
      process.env.A2A_DEPOSIT_MIN_USDC = '1';
      await budgetService
        .registerDeposit('key-1', EVM_CHAIN, '0.5', 'user-1', EVM_TX, 'USDC')
        .catch(() => undefined);
      expect(logSpy.error).not.toHaveBeenCalled();
    });
  });

  // WKH-129: credit() (4-arg, refund_a2a_key_spend) back-compat. NO debe romperse
  // ni cambiar de RPC con la nueva creditWithDest (CD-6).
  describe('credit', () => {
    // T-NOREG-CREDIT (AC-7): credit 4-arg sigue llamando refund_a2a_key_spend,
    // NO refund_with_dest_policy. Back-compat de orchestrate step-0 intacto.
    it('T-NOREG-CREDIT credit 4-arg still calls refund_a2a_key_spend (AC-7)', async () => {
      // A2 (audit 2026-06-24): la RPC ahora devuelve el nº de filas revertidas.
      // >=1 → reversión real → success.
      mockRpc.mockResolvedValue({ data: 1, error: null } as never);

      const result = await budgetService.credit('k1', 84532, 0.05, 'owner', {
        idemKey: null,
      });

      expect(mockRpc).toHaveBeenCalledWith('refund_a2a_key_spend', {
        p_key_id: 'k1',
        p_chain_id: 84532,
        p_amount_usd: 0.05,
        p_owner_ref: 'owner',
        p_idem_key: null,
      });
      expect(mockRpc).not.toHaveBeenCalledWith(
        'refund_with_dest_policy',
        expect.anything(),
      );
      expect(result).toEqual({ success: true, reverted: true });
    });

    // A2 (audit 2026-06-24): refund que afecta 0 filas → success:false / reverted:false.
    it('A2: credit with 0 rows affected → success:false, reverted:false', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockRpc.mockResolvedValue({ data: 0, error: null } as never);

      const result = await budgetService.credit('k1', 84532, 0.05, 'owner', {
        idemKey: null,
      });

      expect(result).toEqual({
        success: false,
        error: 'REFUND_NOT_REVERTED',
        reverted: false,
      });
      errSpy.mockRestore();
    });

    // ── Audit 2026-06-24 (P2-8): credit() error-path mapping ─────
    // El 4-arg credit() comparte el contrato disclosure-safe de creditWithDest:
    // NUNCA propaga el mensaje crudo de Postgres al caller.

    it('P2-8: RPC OWNERSHIP_MISMATCH → maps to OWNERSHIP_MISMATCH (no raw PG leak)', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: {
          message: 'OWNERSHIP_MISMATCH: key k1 not owned by caller xyz',
        },
      } as never);

      const result = await budgetService.credit('k1', 84532, 0.05, 'other', {
        idemKey: null,
      });

      expect(result).toEqual({ success: false, error: 'OWNERSHIP_MISMATCH' });
      // The raw PG detail must NOT appear in the returned error.
      expect(result.error).not.toContain('not owned by caller');
    });

    it('P2-8: RPC KEY_NOT_FOUND → maps to KEY_NOT_FOUND', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'KEY_NOT_FOUND: key_id k1 does not exist' },
      } as never);

      const result = await budgetService.credit('k1', 84532, 0.05, 'owner', {
        idemKey: null,
      });

      expect(result).toEqual({ success: false, error: 'KEY_NOT_FOUND' });
    });

    it('P2-8: generic RPC error → REFUND_FAILED + logged, never leaks the raw message', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'deadlock detected on relation a2a_agent_keys' },
      } as never);

      const result = await budgetService.credit('k1', 84532, 0.05, 'owner', {
        idemKey: null,
      });

      expect(result).toEqual({ success: false, error: 'REFUND_FAILED' });
      expect(result.error).not.toContain('deadlock');
      expect(logSpy.error).toHaveBeenCalledWith(
        expect.objectContaining({ keyId: 'k1', chainId: 84532 }),
        'refund failed',
      );
    });
  });

  // WKH-129 (AC-1/AC-2/AC-3): creditWithDest() — refund completo del dest-cap.
  describe('creditWithDest', () => {
    // T-CWD-1 (AC-1/AC-2): invoca refund_with_dest_policy con los 5 params snake_case
    // exactos; RPC sin error → { success: true }.
    it('T-CWD-1 calls refund_with_dest_policy with 5 params and returns success (AC-1/AC-2)', async () => {
      // A2 (audit 2026-06-24): RPC devuelve nº de filas revertidas; >=1 → success.
      mockRpc.mockResolvedValue({ data: 1, error: null } as never);

      const result = await budgetService.creditWithDest(
        'k1',
        84532,
        0.05,
        'owner',
        'wasiai/corridor',
        { idemKey: null },
      );

      expect(mockRpc).toHaveBeenCalledWith('refund_with_dest_policy', {
        p_key_id: 'k1',
        p_chain_id: 84532,
        p_amount_usd: 0.05,
        p_owner_ref: 'owner',
        p_destination: 'wasiai/corridor',
        p_idem_key: null,
      });
      expect(result).toEqual({ success: true, reverted: true });
    });

    // A2 (audit 2026-06-24): refund-with-dest que afecta 0 filas (p. ej. mismatch
    // de destino → la fila compensatoria del dest-cap NO se insertó) →
    // success:false / reverted:false. El retry adaptativo NO debe re-debitar.
    it('A2: creditWithDest with 0 rows affected → success:false, reverted:false', async () => {
      mockRpc.mockResolvedValue({ data: 0, error: null } as never);

      const result = await budgetService.creditWithDest(
        'k1',
        84532,
        0.05,
        'owner',
        'wasiai/corridor',
        { idemKey: null },
      );

      expect(result).toEqual({
        success: false,
        error: 'REFUND_NOT_REVERTED',
        reverted: false,
      });
      expect(logSpy.error).toHaveBeenCalledWith(
        expect.objectContaining({ destination: 'wasiai/corridor' }),
        'refund-with-dest NOT reverted (0 rows)',
      );
    });

    // T-CWD-2 (AC-3): RPC OWNERSHIP_MISMATCH → no propaga el msg crudo de PG.
    it('T-CWD-2 maps OWNERSHIP_MISMATCH without leaking raw PG message (AC-3)', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'OWNERSHIP_MISMATCH: key k1 not owned by caller' },
      } as never);

      const result = await budgetService.creditWithDest(
        'k1',
        84532,
        0.05,
        'other-owner',
        'wasiai/corridor',
        { idemKey: null },
      );

      expect(result).toEqual({ success: false, error: 'OWNERSHIP_MISMATCH' });
    });

    // T-CWD-3 (AC-2): RPC error genérico → REFUND_FAILED + console.error con
    // destination. KEY_NOT_FOUND → error: 'KEY_NOT_FOUND'.
    it('T-CWD-3 maps generic RPC error to REFUND_FAILED and logs destination (AC-2)', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'some unexpected pg failure' },
      } as never);

      const result = await budgetService.creditWithDest(
        'k1',
        84532,
        0.05,
        'owner',
        'wasiai/corridor',
        { idemKey: null },
      );

      expect(result).toEqual({ success: false, error: 'REFUND_FAILED' });
      expect(logSpy.error).toHaveBeenCalledWith(
        expect.objectContaining({ destination: 'wasiai/corridor' }),
        'refund-with-dest failed',
      );
    });

    it('T-CWD-3 maps KEY_NOT_FOUND rpc error to KEY_NOT_FOUND (AC-2)', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'KEY_NOT_FOUND: key_id k1 does not exist' },
      } as never);

      const result = await budgetService.creditWithDest(
        'k1',
        84532,
        0.05,
        'owner',
        'wasiai/corridor',
        { idemKey: null },
      );

      expect(result).toEqual({ success: false, error: 'KEY_NOT_FOUND' });
    });
  });

  // M1 (audit 2026-07-01): dual-ledger credit-back. creditDelegation /
  // creditSession call the delegation/session-aware refund RPCs so a step-0
  // refund decrements a2a_delegations.total_spent / a2a_key_sessions.spent_usd
  // ALONGSIDE the parent budget (mirror of the dual-ledger debit).
  describe('creditDelegation / creditSession (M1 dual-ledger refund)', () => {
    it('creditDelegation calls refund_delegation_and_parent with 6 snake_case params and returns reverted (with destination)', async () => {
      mockRpc.mockResolvedValue({ data: 1, error: null } as never);

      const result = await budgetService.creditDelegation(
        'del-1',
        'owner-1',
        'k1',
        84532,
        0.05,
        { idemKey: null },
        'wasiai/corridor',
      );

      expect(mockRpc).toHaveBeenCalledWith('refund_delegation_and_parent', {
        p_delegation_id: 'del-1',
        p_owner_ref: 'owner-1',
        p_key_id: 'k1',
        p_chain_id: 84532,
        p_amount_usd: 0.05,
        p_destination: 'wasiai/corridor',
        p_idem_key: null,
      });
      expect(result).toEqual({ success: true, reverted: true });
    });

    it('creditDelegation omits p_destination when no destination (SQL DEFAULT NULL, master-like dispatch)', async () => {
      mockRpc.mockResolvedValue({ data: 1, error: null } as never);

      await budgetService.creditDelegation(
        'del-1',
        'owner-1',
        'k1',
        2368,
        0.3,
        {
          idemKey: null,
        },
      );

      // CR NIT-1: without a destination the key is OMITTED (no `as unknown as`
      // cast); the SQL `p_destination TEXT DEFAULT NULL` supplies NULL — the
      // dest-agnostic dispatch is byte-identical to the old explicit `null`.
      expect(mockRpc).toHaveBeenCalledWith('refund_delegation_and_parent', {
        p_delegation_id: 'del-1',
        p_owner_ref: 'owner-1',
        p_key_id: 'k1',
        p_chain_id: 2368,
        p_amount_usd: 0.3,
        // HU-194: la clave viaja SIEMPRE (null = sin dedup).
        p_idem_key: null,
      });
    });

    it('creditDelegation with 0 rows reverted → success:false / reverted:false', async () => {
      mockRpc.mockResolvedValue({ data: 0, error: null } as never);

      const result = await budgetService.creditDelegation(
        'del-1',
        'owner-1',
        'k1',
        2368,
        0.3,
        { idemKey: null },
      );

      expect(result).toEqual({
        success: false,
        error: 'REFUND_NOT_REVERTED',
        reverted: false,
      });
    });

    it('creditDelegation maps OWNERSHIP_MISMATCH without leaking raw PG message', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'OWNERSHIP_MISMATCH: delegation del-1 not owned' },
      } as never);

      const result = await budgetService.creditDelegation(
        'del-1',
        'other-owner',
        'k1',
        2368,
        0.3,
        { idemKey: null },
      );

      expect(result).toEqual({ success: false, error: 'OWNERSHIP_MISMATCH' });
    });

    it('creditSession calls refund_session_and_parent with 6 snake_case params and returns reverted', async () => {
      mockRpc.mockResolvedValue({ data: 1, error: null } as never);

      const result = await budgetService.creditSession(
        'sess-1',
        'owner-1',
        'k1',
        84532,
        0.05,
        { idemKey: null },
        'wasiai/corridor',
      );

      expect(mockRpc).toHaveBeenCalledWith('refund_session_and_parent', {
        p_session_id: 'sess-1',
        p_owner_ref: 'owner-1',
        p_key_id: 'k1',
        p_chain_id: 84532,
        p_amount_usd: 0.05,
        p_destination: 'wasiai/corridor',
        p_idem_key: null,
      });
      expect(result).toEqual({ success: true, reverted: true });
    });

    // HU-194: reuso de clave con OTRO monto → code estable, sin msg crudo de PG y
    // sin aplicar nada (fail-closed y visible en `last_error` del outbox).
    it('T-194-B1: creditWithDest mapea REFUND_IDEM_AMOUNT_MISMATCH', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: {
          message: 'REFUND_IDEM_AMOUNT_MISMATCH: idem_key v1:k1:2368:op:step0',
        },
      } as never);

      const result = await budgetService.creditWithDest(
        'k1',
        2368,
        0.3,
        'owner',
        'wasiai/corridor',
        { idemKey: 'v1:k1:2368:op:step0' },
      );

      expect(result).toEqual({
        success: false,
        error: 'REFUND_IDEM_AMOUNT_MISMATCH',
      });
      expect(result.error).not.toContain('idem_key');
    });

    it('T-194-B2: creditDelegation mapea REFUND_IDEM_AMOUNT_MISMATCH', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'REFUND_IDEM_AMOUNT_MISMATCH: idem_key x' },
      } as never);

      const result = await budgetService.creditDelegation(
        'del-1',
        'owner-1',
        'k1',
        2368,
        0.3,
        { idemKey: 'x' },
      );

      expect(result).toEqual({
        success: false,
        error: 'REFUND_IDEM_AMOUNT_MISMATCH',
      });
    });

    it('T-194-B3: creditSession mapea REFUND_IDEM_AMOUNT_MISMATCH', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'REFUND_IDEM_AMOUNT_MISMATCH: idem_key x' },
      } as never);

      const result = await budgetService.creditSession(
        'sess-1',
        'owner-1',
        'k1',
        2368,
        0.3,
        { idemKey: 'x' },
      );

      expect(result).toEqual({
        success: false,
        error: 'REFUND_IDEM_AMOUNT_MISMATCH',
      });
    });

    // HU-194 AR MNR-4: la clave ya está aplicada a OTRA (key, chain, owner) —
    // sería una dedup CRUZADA. Code estable propio (no el de monto: el mismatch no
    // es de monto) y sin msg crudo de PG. Las 4 variantes lo mapean igual: una que
    // devolviera `REFUND_FAILED` escondería el bug de composición de clave.
    it('T-194-B4: credit mapea REFUND_IDEM_IDENTITY_MISMATCH', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: {
          message:
            'REFUND_IDEM_IDENTITY_MISMATCH: idem_key v1:k1:2368:op:step0 ya aplicada a (key k9, chain 2368, owner other)',
        },
      } as never);

      const result = await budgetService.credit('k1', 2368, 0.3, 'owner', {
        idemKey: 'v1:k1:2368:op:step0',
      });

      expect(result).toEqual({
        success: false,
        error: 'REFUND_IDEM_IDENTITY_MISMATCH',
      });
      expect(result.error).not.toContain('idem_key');
    });

    it('T-194-B5: creditWithDest mapea REFUND_IDEM_IDENTITY_MISMATCH', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'REFUND_IDEM_IDENTITY_MISMATCH: idem_key x' },
      } as never);

      const result = await budgetService.creditWithDest(
        'k1',
        2368,
        0.3,
        'owner',
        'wasiai/corridor',
        { idemKey: 'x' },
      );

      expect(result).toEqual({
        success: false,
        error: 'REFUND_IDEM_IDENTITY_MISMATCH',
      });
    });

    it('T-194-B6: creditDelegation mapea REFUND_IDEM_IDENTITY_MISMATCH', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'REFUND_IDEM_IDENTITY_MISMATCH: idem_key x' },
      } as never);

      const result = await budgetService.creditDelegation(
        'del-1',
        'owner-1',
        'k1',
        2368,
        0.3,
        { idemKey: 'x' },
      );

      expect(result).toEqual({
        success: false,
        error: 'REFUND_IDEM_IDENTITY_MISMATCH',
      });
    });

    it('T-194-B7: creditSession mapea REFUND_IDEM_IDENTITY_MISMATCH', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'REFUND_IDEM_IDENTITY_MISMATCH: idem_key x' },
      } as never);

      const result = await budgetService.creditSession(
        'sess-1',
        'owner-1',
        'k1',
        2368,
        0.3,
        { idemKey: 'x' },
      );

      expect(result).toEqual({
        success: false,
        error: 'REFUND_IDEM_IDENTITY_MISMATCH',
      });
    });

    it('creditSession maps SESSION_NOT_FOUND to KEY_NOT_FOUND (no raw PG leak)', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'SESSION_NOT_FOUND: sess-1' },
      } as never);

      const result = await budgetService.creditSession(
        'sess-1',
        'owner-1',
        'k1',
        2368,
        0.3,
        { idemKey: null },
      );

      expect(result).toEqual({ success: false, error: 'KEY_NOT_FOUND' });
    });
  });
});
