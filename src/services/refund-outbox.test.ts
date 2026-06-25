/**
 * Refund Outbox Service Unit Tests — M6 (audit 2026-06-24)
 *
 * Cubre: enqueue (INSERT); process re-aplica y marca done; refund que sigue
 * fallando → attempts++ → dead tras N; claim concurrente no procesa dos veces
 * (mock); NUNCA doble-aplica (un entry done no se re-procesa, y un credit que SÍ
 * revirtió NUNCA dispara un re-credit).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock supabase ───────────────────────────────────────────
vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
}));

// ── Mock budgetService (no DB) ──────────────────────────────
vi.mock('./budget.js', () => ({
  budgetService: {
    credit: vi.fn(),
    creditWithDest: vi.fn(),
  },
}));

import { supabase } from '../lib/supabase.js';
import { budgetService } from './budget.js';
import { MAX_REFUND_ATTEMPTS, refundOutbox } from './refund-outbox.js';

const mockFrom = vi.mocked(supabase.from);
const mockRpc = vi.mocked(supabase.rpc);
const mockCredit = vi.mocked(budgetService.credit);
const mockCreditWithDest = vi.mocked(budgetService.creditWithDest);

// Captura la última fila pasada a update(...) por id, para aserciones de status.
function makeFromMock() {
  const insert = vi.fn().mockResolvedValue({ error: null });
  const updateCalls: Array<Record<string, unknown>> = [];
  const update = vi.fn((patch: Record<string, unknown>) => {
    updateCalls.push(patch);
    return { eq: vi.fn().mockResolvedValue({ error: null }) };
  });
  const fromObj = { insert, update };
  mockFrom.mockReturnValue(
    fromObj as unknown as ReturnType<typeof supabase.from>,
  );
  return { insert, update, updateCalls };
}

const ENTRY = {
  keyId: 'key-1',
  chainId: 8453,
  amountUsd: 0.25,
  ownerRef: 'user-1',
  reason: 'orchestrate.refund-failed',
};

function claimedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    key_id: 'key-1',
    chain_id: 8453,
    amount_usd: '0.25',
    owner_ref: 'user-1',
    destination: null,
    reason: 'orchestrate.refund-failed',
    attempts: 0,
    status: 'processing',
    last_error: null,
    ...overrides,
  };
}

describe('refundOutbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── enqueue ──────────────────────────────────────────────
  describe('enqueueRefund', () => {
    it('inserts a pending row (no destination)', async () => {
      const { insert } = makeFromMock();
      await refundOutbox.enqueueRefund(ENTRY);
      expect(mockFrom).toHaveBeenCalledWith('a2a_refund_outbox');
      expect(insert).toHaveBeenCalledWith({
        key_id: 'key-1',
        chain_id: 8453,
        amount_usd: 0.25,
        owner_ref: 'user-1',
        destination: null,
        reason: 'orchestrate.refund-failed',
      });
    });

    it('passes destination when present', async () => {
      const { insert } = makeFromMock();
      await refundOutbox.enqueueRefund({ ...ENTRY, destination: 'reg/slug' });
      expect(insert).toHaveBeenCalledWith(
        expect.objectContaining({ destination: 'reg/slug' }),
      );
    });

    it('never throws when the table is missing (migration not applied)', async () => {
      const insert = vi
        .fn()
        .mockResolvedValue({ error: { message: 'relation does not exist' } });
      mockFrom.mockReturnValue({
        insert,
      } as unknown as ReturnType<typeof supabase.from>);
      await expect(refundOutbox.enqueueRefund(ENTRY)).resolves.toBeUndefined();
    });

    it('never throws when insert rejects', async () => {
      const insert = vi.fn().mockRejectedValue(new Error('boom'));
      mockFrom.mockReturnValue({
        insert,
      } as unknown as ReturnType<typeof supabase.from>);
      await expect(refundOutbox.enqueueRefund(ENTRY)).resolves.toBeUndefined();
    });
  });

  // ── process: success → done ──────────────────────────────
  describe('processRefundOutbox', () => {
    it('re-applies the credit and marks the entry done when reverted', async () => {
      const { update, updateCalls } = makeFromMock();
      mockRpc.mockResolvedValue({ data: [claimedRow()], error: null } as never);
      mockCredit.mockResolvedValue({ success: true, reverted: true });

      await refundOutbox.processRefundOutbox(10);

      expect(mockRpc).toHaveBeenCalledWith('claim_refund_outbox', {
        p_limit: 10,
      });
      expect(mockCredit).toHaveBeenCalledWith('key-1', 8453, 0.25, 'user-1');
      expect(update).toHaveBeenCalledTimes(1);
      expect(updateCalls[0]).toMatchObject({
        status: 'done',
        last_error: null,
      });
    });

    it('uses creditWithDest when the entry has a destination', async () => {
      makeFromMock();
      mockRpc.mockResolvedValue({
        data: [claimedRow({ destination: 'reg/slug' })],
        error: null,
      } as never);
      mockCreditWithDest.mockResolvedValue({ success: true, reverted: true });

      await refundOutbox.processRefundOutbox();

      expect(mockCreditWithDest).toHaveBeenCalledWith(
        'key-1',
        8453,
        0.25,
        'user-1',
        'reg/slug',
      );
      expect(mockCredit).not.toHaveBeenCalled();
    });

    // ── retry: still failing → attempts++ → pending, then dead ──
    it('bumps attempts and re-queues pending when still not reverted', async () => {
      const { updateCalls } = makeFromMock();
      mockRpc.mockResolvedValue({
        data: [claimedRow({ attempts: 0 })],
        error: null,
      } as never);
      mockCredit.mockResolvedValue({
        success: false,
        reverted: false,
        error: 'REFUND_NOT_REVERTED',
      });

      await refundOutbox.processRefundOutbox();

      expect(updateCalls[0]).toMatchObject({ attempts: 1, status: 'pending' });
    });

    it('marks dead after MAX_REFUND_ATTEMPTS without reverting', async () => {
      const { updateCalls } = makeFromMock();
      // attempts is already MAX-1 → next bump reaches MAX → dead.
      mockRpc.mockResolvedValue({
        data: [claimedRow({ attempts: MAX_REFUND_ATTEMPTS - 1 })],
        error: null,
      } as never);
      mockCredit.mockResolvedValue({
        success: false,
        reverted: false,
        error: 'REFUND_FAILED',
      });

      await refundOutbox.processRefundOutbox();

      expect(updateCalls[0]).toMatchObject({
        attempts: MAX_REFUND_ATTEMPTS,
        status: 'dead',
      });
    });

    it('bumps attempts (does not crash) when the credit throws', async () => {
      const { updateCalls } = makeFromMock();
      mockRpc.mockResolvedValue({
        data: [claimedRow({ attempts: 0 })],
        error: null,
      } as never);
      mockCredit.mockRejectedValue(new Error('db down'));

      await expect(refundOutbox.processRefundOutbox()).resolves.toBeUndefined();
      expect(updateCalls[0]).toMatchObject({ attempts: 1, status: 'pending' });
    });

    // ── concurrency: claim returns disjoint sets ──────────────
    it('processes only the rows the atomic claim returned (no double-claim)', async () => {
      makeFromMock();
      // Instance A claims row-1; instance B's claim returns [] (SKIP LOCKED).
      mockRpc
        .mockResolvedValueOnce({ data: [claimedRow()], error: null } as never)
        .mockResolvedValueOnce({ data: [], error: null } as never);
      mockCredit.mockResolvedValue({ success: true, reverted: true });

      await refundOutbox.processRefundOutbox(); // A
      await refundOutbox.processRefundOutbox(); // B (concurrent sweep)

      // Only ONE credit happened despite two sweeps → no double-process.
      expect(mockCredit).toHaveBeenCalledTimes(1);
    });

    // ── invariant: a done entry is never re-applied ──────────
    it('never re-applies: empty claim never touches credit (done entries excluded)', async () => {
      makeFromMock();
      mockRpc.mockResolvedValue({ data: [], error: null } as never);
      await refundOutbox.processRefundOutbox();
      expect(mockCredit).not.toHaveBeenCalled();
      expect(mockCreditWithDest).not.toHaveBeenCalled();
    });

    it('never double-applies: a reverted credit only triggers ONE credit call', async () => {
      makeFromMock();
      mockRpc.mockResolvedValue({ data: [claimedRow()], error: null } as never);
      mockCredit.mockResolvedValue({ success: true, reverted: true });
      await refundOutbox.processRefundOutbox();
      // Exactly one credit; the entry is marked done, not retried.
      expect(mockCredit).toHaveBeenCalledTimes(1);
    });

    it('never throws when the claim RPC errors (table/RPC missing)', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'function does not exist' },
      } as never);
      await expect(refundOutbox.processRefundOutbox()).resolves.toBeUndefined();
      expect(mockCredit).not.toHaveBeenCalled();
    });
  });
});
