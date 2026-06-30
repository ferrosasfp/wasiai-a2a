/**
 * Budget Service Unit Tests — WKH-34
 * Tests: AC-8 (getBalance), AC-9 (debit), AC-10 (registerDeposit), AC-11 (daily reset)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  DestCapExceededError,
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
      mockOwnerSelect('user-1');
      mockRpc.mockResolvedValue({ data: null, error: null } as never);

      const result = await budgetService.debit('key-1', 2368, 1.5);

      expect(mockRpc).toHaveBeenCalledWith('increment_a2a_key_spend', {
        p_key_id: 'key-1',
        p_chain_id: 2368,
        p_amount_usd: 1.5,
        p_owner_ref: 'user-1',
      });
      expect(result).toEqual({ success: true });
    });

    it('returns failure with DAILY_LIMIT error from Postgres (AC-9)', async () => {
      mockOwnerSelect('user-1');
      mockRpc.mockResolvedValue({
        data: null,
        error: {
          message: 'DAILY_LIMIT: daily spend would be 9 + 2 = 11, limit is 10',
        },
      } as never);

      const result = await budgetService.debit('key-1', 2368, 2);

      // M5 (audit 2026-06-24): el msg crudo de PG NO se propaga — se mapea al
      // código estable DAILY_LIMIT (espejo de la ruta dest-policy).
      expect(result).toEqual({
        success: false,
        error: 'DAILY_LIMIT',
      });
    });

    it('returns failure with INSUFFICIENT_BUDGET error from Postgres (AC-9)', async () => {
      mockOwnerSelect('user-1');
      mockRpc.mockResolvedValue({
        data: null,
        error: {
          message: 'INSUFFICIENT_BUDGET: chain 2368 balance is 1, requested 5',
        },
      } as never);

      const result = await budgetService.debit('key-1', 2368, 5);

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
      mockOwnerSelect('user-1');
      const rawPgMsg =
        'duplicate key value violates unique constraint "a2a_spend_pkey" DETAIL: Key (id)=(abc) already exists.';
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: rawPgMsg },
      } as never);
      const result = await budgetService.debit('key-1', 2368, 1);

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

    // ── WKH-101 (DT-11): delegation-aware debit ──────────────

    // T14 (AC-13): master key path — NO delegationContext → increment_a2a_key_spend,
    // NEVER calls debitDelegationAndParent (backward-compat, CD-5).
    it('T14 master key path uses increment_a2a_key_spend, not the delegation RPC (AC-13)', async () => {
      mockOwnerSelect('user-1');
      mockRpc.mockResolvedValue({ data: null, error: null } as never);

      const result = await budgetService.debit('key-1', 2368, 1.5);

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
      const result = await budgetService.debit('key-1', 2368, 1.0, {
        ...DELEGATION_CTX,
        maxAmountPerTx: '0.50',
      });

      expect(result).toEqual({
        success: false,
        error: 'DELEGATION_TX_LIMIT_EXCEEDED',
      });
      expect(mockDebitDelegation).not.toHaveBeenCalled();
    });

    it('delegation path within per-tx limit calls debitDelegationAndParent (AC-8/AC-9)', async () => {
      mockDebitDelegation.mockResolvedValue('0.30');

      const result = await budgetService.debit('key-1', 2368, 0.3, {
        ...DELEGATION_CTX,
        maxAmountPerTx: '0.50',
      });

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
      const result = await budgetService.debit('key-1', 2368, 0.3, {
        ...DELEGATION_CTX,
        maxAmountPerTx: '0.50',
      });
      expect(result).toEqual({ success: false, error: 'DEST_CAP_EXCEEDED' });
      expect(mockReceiptEmit).not.toHaveBeenCalled();
    });

    // ── WKH-124 (AC-2): budget_debit receipt on the delegation success path ──
    it('WKH-124 (AC-2): delegation success emits budget_debit with delegation_id', async () => {
      mockDebitDelegation.mockResolvedValue('0.30');

      await budgetService.debit('key-1', 2368, 0.3, {
        ...DELEGATION_CTX,
        maxAmountPerTx: '0.50',
      });

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

      const result = await budgetService.debit('key-1', 2368, 0.3, {
        ...DELEGATION_CTX,
        maxAmountPerTx: '0.50',
      });

      expect(result).toEqual({ success: true });
    });

    // ── WKH-124 (AC-2, MNR-3): budget_debit receipt on the key-session path ──
    // Mirrors the delegation receipt test but for the key-session call-site
    // (budget.ts ~L88): asserts the session lineage (session_id + owner_ref +
    // agent_key_id) and budget_debit type without touching the debit signature.
    it('WKH-124 (AC-2): key-session success emits budget_debit with session_id', async () => {
      mockDebitSession.mockResolvedValue('0.30');

      await budgetService.debit('key-1', 2368, 0.3, undefined, KEY_SESSION_CTX);

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
      );

      expect(result).toEqual({ success: true });
    });

    it('maps DelegationTotalLimitExceededError → DELEGATION_TOTAL_LIMIT_EXCEEDED (AC-8)', async () => {
      mockDebitDelegation.mockRejectedValue(
        new DelegationTotalLimitExceededError(),
      );
      const result = await budgetService.debit('key-1', 2368, 0.1, {
        ...DELEGATION_CTX,
        maxAmountPerTx: '100',
      });
      expect(result).toEqual({
        success: false,
        error: 'DELEGATION_TOTAL_LIMIT_EXCEEDED',
      });
    });

    it('maps AgentKeyBudgetExhaustedError → AGENT_KEY_BUDGET_EXHAUSTED (AC-9)', async () => {
      mockDebitDelegation.mockRejectedValue(new AgentKeyBudgetExhaustedError());
      const result = await budgetService.debit('key-1', 2368, 0.1, {
        ...DELEGATION_CTX,
        maxAmountPerTx: '100',
      });
      expect(result).toEqual({
        success: false,
        error: 'AGENT_KEY_BUDGET_EXHAUSTED',
      });
    });

    it('maps DelegationRevokedError → DELEGATION_REVOKED (TOCTOU)', async () => {
      mockDebitDelegation.mockRejectedValue(new DelegationRevokedError());
      const result = await budgetService.debit('key-1', 2368, 0.1, {
        ...DELEGATION_CTX,
        maxAmountPerTx: '100',
      });
      expect(result).toEqual({ success: false, error: 'DELEGATION_REVOKED' });
    });

    it('maps DelegationExpiredError → DELEGATION_EXPIRED (TOCTOU)', async () => {
      mockDebitDelegation.mockRejectedValue(new DelegationExpiredError());
      const result = await budgetService.debit('key-1', 2368, 0.1, {
        ...DELEGATION_CTX,
        maxAmountPerTx: '100',
      });
      expect(result).toEqual({ success: false, error: 'DELEGATION_EXPIRED' });
    });

    it('maps OwnershipMismatchError → OWNERSHIP_MISMATCH', async () => {
      mockDebitDelegation.mockRejectedValue(new OwnershipMismatchError());
      const result = await budgetService.debit('key-1', 2368, 0.1, {
        ...DELEGATION_CTX,
        maxAmountPerTx: '100',
      });
      expect(result).toEqual({ success: false, error: 'OWNERSHIP_MISMATCH' });
    });

    // ── AR-MNR-1/AR-MNR-2: parent-RPC limits + no-raw-PG fallback ──

    it('AR-MNR-1 maps DailyLimitExceededError → DAILY_LIMIT (no raw PG)', async () => {
      mockDebitDelegation.mockRejectedValue(new DailyLimitExceededError());
      const result = await budgetService.debit('key-1', 2368, 0.1, {
        ...DELEGATION_CTX,
        maxAmountPerTx: '100',
      });
      expect(result).toEqual({ success: false, error: 'DAILY_LIMIT' });
      expect(result.error).not.toContain('limit is');
    });

    it('AR-MNR-1 maps AgentKeyInactiveError → KEY_INACTIVE', async () => {
      mockDebitDelegation.mockRejectedValue(new AgentKeyInactiveError());
      const result = await budgetService.debit('key-1', 2368, 0.1, {
        ...DELEGATION_CTX,
        maxAmountPerTx: '100',
      });
      expect(result).toEqual({ success: false, error: 'KEY_INACTIVE' });
    });

    it('AR-MNR-1 maps AgentKeyNotFoundError → KEY_NOT_FOUND', async () => {
      mockDebitDelegation.mockRejectedValue(new AgentKeyNotFoundError());
      const result = await budgetService.debit('key-1', 2368, 0.1, {
        ...DELEGATION_CTX,
        maxAmountPerTx: '100',
      });
      expect(result).toEqual({ success: false, error: 'KEY_NOT_FOUND' });
    });

    it('AR-MNR-1 maps DelegationNotFoundError → DELEGATION_NOT_FOUND', async () => {
      mockDebitDelegation.mockRejectedValue(new DelegationNotFoundError());
      const result = await budgetService.debit('key-1', 2368, 0.1, {
        ...DELEGATION_CTX,
        maxAmountPerTx: '100',
      });
      expect(result).toEqual({ success: false, error: 'DELEGATION_NOT_FOUND' });
    });

    it('AR-MNR-2 unmapped delegation error → DELEGATION_DEBIT_FAILED, no raw PG', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockDebitDelegation.mockRejectedValue(
        new Error('P0001: raw postgres detail 0xdeadbeef'),
      );
      const result = await budgetService.debit('key-1', 2368, 0.1, {
        ...DELEGATION_CTX,
        maxAmountPerTx: '100',
      });
      expect(result).toEqual({
        success: false,
        error: 'DELEGATION_DEBIT_FAILED',
      });
      expect(result.error).not.toContain('postgres');
      expect(result.error).not.toContain('0xdeadbeef');
      errSpy.mockRestore();
    });

    // ── WKH-125 (KEY-CONSTRAINTS): dest-aware master route ──────

    /** Mock para el SELECT owner_ref cold-path de la ruta dest-aware. */
    function mockOwnerSelect(ownerRef: string | null) {
      const chain = chainMock();
      chain.single = vi
        .fn()
        .mockResolvedValue(
          ownerRef === null
            ? { data: null, error: { code: 'PGRST116' } }
            : { data: { owner_ref: ownerRef }, error: null },
        );
      mockFrom.mockReturnValue(
        chain as unknown as ReturnType<typeof supabase.from>,
      );
    }

    // ── WKH-SEC-02b: owner guard DB-level en la ruta master-no-dest ──

    it('WKH-SEC-02b master: válido pasa p_owner_ref al RPC (AC-2)', async () => {
      mockOwnerSelect('user-1');
      mockRpc.mockResolvedValue({ data: null, error: null } as never);

      const result = await budgetService.debit('key-1', 2368, 1.5);

      expect(mockRpc).toHaveBeenCalledWith('increment_a2a_key_spend', {
        p_key_id: 'key-1',
        p_chain_id: 2368,
        p_amount_usd: 1.5,
        p_owner_ref: 'user-1',
      });
      expect(result).toEqual({ success: true });
    });

    it('WKH-SEC-02b master: OWNERSHIP_MISMATCH mapea a code estable (AC-1/AC-6)', async () => {
      mockOwnerSelect('user-1');
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'OWNERSHIP_MISMATCH: key x not owned by caller' },
      } as never);

      const result = await budgetService.debit('key-1', 2368, 1.5);

      expect(result).toEqual({ success: false, error: 'OWNERSHIP_MISMATCH' });
    });

    it('WKH-SEC-02b master: KEY_NOT_FOUND en SELECT cold-path no llama al RPC (AC-2)', async () => {
      mockOwnerSelect(null);

      const result = await budgetService.debit('key-1', 2368, 1.5);

      expect(result).toEqual({ success: false, error: 'KEY_NOT_FOUND' });
      expect(mockRpc).not.toHaveBeenCalled();
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
      mockOwnerSelect('user-1');
      mockRpc.mockResolvedValue({ data: null, error: null } as never);

      const result = await budgetService.debit('key-1', 2368, 1.5);

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
      mockOwnerSelect('user-1');
      mockRpc.mockResolvedValue({ data: null, error: null } as never);

      const result = await budgetService.debit(
        'key-1',
        2368,
        1.5,
        undefined,
        undefined,
        'kite/translator',
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
      mockOwnerSelect('user-1');
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
      );

      expect(result).toEqual({ success: false, error: 'DEST_CAP_EXCEEDED' });
    });

    // CD-B: prefijos heredados de increment_a2a_key_spend mapeados, sin leak PG.
    it('maps INSUFFICIENT_BUDGET prefix → AGENT_KEY_BUDGET_EXHAUSTED', async () => {
      mockOwnerSelect('user-1');
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
      );

      expect(result).toEqual({
        success: false,
        error: 'AGENT_KEY_BUDGET_EXHAUSTED',
      });
    });

    // CD-B: error inesperado del RPC dest-aware → code estable, sin msg crudo PG.
    it('unmapped dest-policy error → DEST_POLICY_DEBIT_FAILED, no raw PG', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockOwnerSelect('user-1');
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
      mockOwnerSelect('user-1');
      // Simula la serialización del RPC: la 1ª llamada OK, la 2ª rechazada por el
      // cap (el SUM bajo lock ya incluye el débito de la 1ª).
      mockRpc
        .mockResolvedValueOnce({ data: null, error: null } as never)
        .mockResolvedValueOnce({
          data: null,
          error: { message: 'DEST_CAP_EXCEEDED: dest x accum 1 + 1 > cap 1' },
        } as never);

      const [r1, r2] = await Promise.all([
        budgetService.debit('key-1', 2368, 1, undefined, undefined, 'kite/x'),
        budgetService.debit('key-1', 2368, 1, undefined, undefined, 'kite/x'),
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
      );

      expect(result).toEqual({ success: false, error: 'DEST_CAP_EXCEEDED' });
    });
  });

  describe('registerDeposit', () => {
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

  // WKH-129: credit() (4-arg, refund_a2a_key_spend) back-compat. NO debe romperse
  // ni cambiar de RPC con la nueva creditWithDest (CD-6).
  describe('credit', () => {
    // T-NOREG-CREDIT (AC-7): credit 4-arg sigue llamando refund_a2a_key_spend,
    // NO refund_with_dest_policy. Back-compat de orchestrate step-0 intacto.
    it('T-NOREG-CREDIT credit 4-arg still calls refund_a2a_key_spend (AC-7)', async () => {
      // A2 (audit 2026-06-24): la RPC ahora devuelve el nº de filas revertidas.
      // >=1 → reversión real → success.
      mockRpc.mockResolvedValue({ data: 1, error: null } as never);

      const result = await budgetService.credit('k1', 84532, 0.05, 'owner');

      expect(mockRpc).toHaveBeenCalledWith('refund_a2a_key_spend', {
        p_key_id: 'k1',
        p_chain_id: 84532,
        p_amount_usd: 0.05,
        p_owner_ref: 'owner',
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

      const result = await budgetService.credit('k1', 84532, 0.05, 'owner');

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

      const result = await budgetService.credit('k1', 84532, 0.05, 'other');

      expect(result).toEqual({ success: false, error: 'OWNERSHIP_MISMATCH' });
      // The raw PG detail must NOT appear in the returned error.
      expect(result.error).not.toContain('not owned by caller');
    });

    it('P2-8: RPC KEY_NOT_FOUND → maps to KEY_NOT_FOUND', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'KEY_NOT_FOUND: key_id k1 does not exist' },
      } as never);

      const result = await budgetService.credit('k1', 84532, 0.05, 'owner');

      expect(result).toEqual({ success: false, error: 'KEY_NOT_FOUND' });
    });

    it('P2-8: generic RPC error → REFUND_FAILED + logged, never leaks the raw message', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'deadlock detected on relation a2a_agent_keys' },
      } as never);

      const result = await budgetService.credit('k1', 84532, 0.05, 'owner');

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
      );

      expect(mockRpc).toHaveBeenCalledWith('refund_with_dest_policy', {
        p_key_id: 'k1',
        p_chain_id: 84532,
        p_amount_usd: 0.05,
        p_owner_ref: 'owner',
        p_destination: 'wasiai/corridor',
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
      );

      expect(result).toEqual({ success: false, error: 'KEY_NOT_FOUND' });
    });
  });
});
