/**
 * Refund Outbox Service Unit Tests — M6 (audit 2026-06-24)
 *
 * Cubre: enqueue (INSERT); process re-aplica y marca done; refund que sigue
 * fallando → attempts++ → dead tras N; claim concurrente no procesa dos veces
 * (mock); NUNCA doble-aplica (un entry done no se re-procesa, y un credit que SÍ
 * revirtió NUNCA dispara un re-credit).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Logger: silenciado y asertable (HU-194 distingue info vs error) ──
const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({ getLogger: () => logSpy }));

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

const IDEM_KEY = 'v1:key-1:8453:op-1:orchestrate-step0';

const ENTRY = {
  keyId: 'key-1',
  chainId: 8453,
  amountUsd: 0.25,
  ownerRef: 'user-1',
  reason: 'orchestrate.refund-failed',
  idemKey: IDEM_KEY,
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
    idem_key: IDEM_KEY,
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
        // HU-194: la clave del refund LÓGICO viaja a la fila para que el sweep
        // pueda dedupear contra el crédito original.
        idem_key: IDEM_KEY,
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

    // HU-194: el índice único parcial `uq_refund_outbox_idem_key` es la segunda
    // defensa — dos procesos que encolan el MISMO refund lógico dejan UNA fila.
    it('T-194-OB-4: unique_violation (23505) → no-op deduplicado, NO error', async () => {
      const insert = vi.fn().mockResolvedValue({
        error: { code: '23505', message: 'duplicate key value' },
      });
      mockFrom.mockReturnValue({
        insert,
      } as unknown as ReturnType<typeof supabase.from>);

      await expect(refundOutbox.enqueueRefund(ENTRY)).resolves.toBeUndefined();

      // Se registra como dedup (info), NO como fallo del outbox: el refund ya
      // está encolado por el otro camino/proceso.
      expect(logSpy.info).toHaveBeenCalledWith(
        expect.objectContaining({ idemKey: IDEM_KEY }),
        '[refund-outbox.enqueue-deduped]',
      );
      expect(logSpy.error).not.toHaveBeenCalled();
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
    // ── HU-194 ─────────────────────────────────────────────
    it('T-194-OB-1: pasa la idem_key de la fila al credit (sin ella el sweep duplica)', async () => {
      makeFromMock();
      mockRpc.mockResolvedValue({ data: [claimedRow()], error: null } as never);
      mockCredit.mockResolvedValue({ success: true, reverted: true });

      await refundOutbox.processRefundOutbox();

      // La clave es lo único que le permite a Postgres saber que este refund
      // lógico ya se acreditó (crédito original commiteado + respuesta perdida).
      expect(mockCredit).toHaveBeenCalledWith('key-1', 8453, 0.25, 'user-1', {
        idemKey: IDEM_KEY,
      });
    });

    it('T-194-OB-2: fila legacy (idem_key NULL) → credit con idemKey null, sweep intacto', async () => {
      const { updateCalls } = makeFromMock();
      mockRpc.mockResolvedValue({
        data: [claimedRow({ idem_key: null })],
        error: null,
      } as never);
      mockCredit.mockResolvedValue({ success: true, reverted: true });

      await refundOutbox.processRefundOutbox();

      // Encolada ANTES de la migración: no hay clave que deducir. Se procesa
      // exactamente como antes (sin dedup) en vez de quedar trabada.
      expect(mockCredit).toHaveBeenCalledWith('key-1', 8453, 0.25, 'user-1', {
        idemKey: null,
      });
      expect(updateCalls[0]).toMatchObject({ status: 'done' });
    });

    // AR BLQ-BAJO-1: el título viejo ("migración no aplicada → no rompe") prometía
    // back-compat que este test NO prueba: el credit está mockeado como exitoso, así
    // que no se ejercita ni el write de `idem_key` (PGRST204) ni la RPC con
    // `p_idem_key` (PGRST202). Lo único que cubre es el READ del sweep. El orden
    // migración → deploy es un GATE de release, no algo que el código tolere: ver el
    // header de `supabase/migrations/20260727000000_hu194_refund_idempotency.sql`.
    it('T-194-OB-3: el READ del sweep tolera una fila SIN la propiedad idem_key → idemKey null', async () => {
      makeFromMock();
      const row = claimedRow();
      delete (row as Record<string, unknown>).idem_key;
      mockRpc.mockResolvedValue({ data: [row], error: null } as never);
      mockCredit.mockResolvedValue({ success: true, reverted: true });

      await expect(refundOutbox.processRefundOutbox()).resolves.toBeUndefined();
      expect(mockCredit).toHaveBeenCalledWith('key-1', 8453, 0.25, 'user-1', {
        idemKey: null,
      });
    });

    it('re-applies the credit and marks the entry done when reverted', async () => {
      const { update, updateCalls } = makeFromMock();
      mockRpc.mockResolvedValue({ data: [claimedRow()], error: null } as never);
      mockCredit.mockResolvedValue({ success: true, reverted: true });

      await refundOutbox.processRefundOutbox(10);

      expect(mockRpc).toHaveBeenCalledWith('claim_refund_outbox', {
        p_limit: 10,
      });
      expect(mockCredit).toHaveBeenCalledWith('key-1', 8453, 0.25, 'user-1', {
        idemKey: IDEM_KEY,
      });
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
        { idemKey: IDEM_KEY },
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
