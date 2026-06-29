/**
 * Receipt Service Unit Tests — WKH-124 KEY-RECEIPTS
 *
 * AC-3 (hash + canonical), AC-4 (verify match), AC-5 (tamper), AC-6 (best-effort:
 * secret-missing skip + RPC reject absorbed), AC-7 (list Ownership Guard).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Structured logger mock ─────────────────────────────────
// receipt.ts logs best-effort warnings via getLogger('receipts'). Mock it so
// tests assert log emission (object-first / message-second) instead of spying
// on console. hoisted so the factory can reference it.
const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({
  getLogger: () => logSpy,
}));

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
}));

import { supabase } from '../lib/supabase.js';
import type { ReceiptRow } from '../types/receipt.js';
import {
  buildCanonicalPayload,
  computeReceiptHash,
  receiptService,
} from './receipt.js';

const mockFrom = vi.mocked(supabase.from);
const mockRpc = vi.mocked(supabase.rpc);

const TEST_SECRET = 'test-receipt-signing-secret-32bytes';

// Un row firmable de ejemplo (campos exactos de a2a_receipts).
const SAMPLE_ROW: ReceiptRow = {
  id: '11111111-1111-1111-1111-111111111111',
  owner_ref: 'owner-A',
  agent_key_id: '22222222-2222-2222-2222-222222222222',
  session_id: null,
  delegation_id: null,
  receipt_type: 'budget_debit',
  amount_usd: '1.50000000',
  chain_id: 2368,
  tx_hash: null,
  counterparty: null,
  orchestration_id: null,
  prev_receipt_hash: null,
  receipt_hash: '',
  created_at: '2026-06-19T12:34:56.789Z',
};

function canonicalOf(row: ReceiptRow): string {
  return buildCanonicalPayload({
    agent_key_id: row.agent_key_id,
    amount_usd: row.amount_usd,
    chain_id: row.chain_id,
    counterparty: row.counterparty,
    created_at: row.created_at,
    delegation_id: row.delegation_id,
    id: row.id,
    orchestration_id: row.orchestration_id,
    owner_ref: row.owner_ref,
    prev_receipt_hash: row.prev_receipt_hash,
    receipt_type: row.receipt_type,
    session_id: row.session_id,
    tx_hash: row.tx_hash,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RECEIPT_SIGNING_SECRET = TEST_SECRET;
});

afterEach(() => {
  process.env.RECEIPT_SIGNING_SECRET = TEST_SECRET;
});

// ── AC-3: computeReceiptHash ────────────────────────────────
describe('computeReceiptHash (AC-3)', () => {
  it('produces a deterministic 64-char hex for a fixed canonical', () => {
    const canonical = canonicalOf(SAMPLE_ROW);
    const h1 = computeReceiptHash(canonical);
    const h2 = computeReceiptHash(canonical);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns null when RECEIPT_SIGNING_SECRET is unset', () => {
    delete process.env.RECEIPT_SIGNING_SECRET;
    expect(computeReceiptHash(canonicalOf(SAMPLE_ROW))).toBeNull();
  });
});

// ── AC-3 / DT-5: buildCanonicalPayload ──────────────────────
describe('buildCanonicalPayload (AC-3 / DT-5)', () => {
  it('orders keys alphabetically, normalises amount (toFixed(8)) and created_at (ISO), null → null literal', () => {
    const canonical = buildCanonicalPayload({
      // intentionally non-alphabetical insertion order:
      tx_hash: null,
      amount_usd: 1.5,
      chain_id: 2368,
      receipt_type: 'budget_debit',
      id: 'id-1',
      owner_ref: 'owner-A',
      agent_key_id: 'key-1',
      session_id: null,
      delegation_id: null,
      counterparty: null,
      orchestration_id: null,
      prev_receipt_hash: null,
      created_at: '2026-06-19T12:34:56.789Z',
    });
    const parsed = JSON.parse(canonical);
    expect(Object.keys(parsed)).toEqual([
      'agent_key_id',
      'amount_usd',
      'chain_id',
      'counterparty',
      'created_at',
      'delegation_id',
      'id',
      'orchestration_id',
      'owner_ref',
      'prev_receipt_hash',
      'receipt_type',
      'session_id',
      'tx_hash',
    ]);
    expect(parsed.amount_usd).toBe('1.50000000');
    expect(parsed.chain_id).toBe(2368);
    expect(parsed.created_at).toBe('2026-06-19T12:34:56.789Z');
    // null literal (not the string "null")
    expect(canonical).toContain('"counterparty":null');
    expect(parsed.counterparty).toBeNull();
  });

  it('amount_usd string from Supabase is normalised identically to number', () => {
    const fromString = buildCanonicalPayload({
      agent_key_id: null,
      amount_usd: '1.5',
      chain_id: 1,
      counterparty: null,
      created_at: '2026-06-19T00:00:00.000Z',
      delegation_id: null,
      id: 'x',
      orchestration_id: null,
      owner_ref: 'o',
      prev_receipt_hash: null,
      receipt_type: 'budget_debit',
      session_id: null,
      tx_hash: null,
    });
    expect(JSON.parse(fromString).amount_usd).toBe('1.50000000');
  });
});

// ── AC-4 / AC-5: verify ─────────────────────────────────────
describe('verify (AC-4 / AC-5)', () => {
  function selectSingleMock(row: ReceiptRow | null, errCode?: string) {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi
        .fn()
        .mockResolvedValue(
          row
            ? { data: row, error: null }
            : { data: null, error: { code: errCode ?? 'PGRST116' } },
        ),
    };
    return chain;
  }

  it('untampered row → { valid:true, computed==stored } (AC-4)', async () => {
    const stored = computeReceiptHash(canonicalOf(SAMPLE_ROW)) as string;
    const row: ReceiptRow = { ...SAMPLE_ROW, receipt_hash: stored };
    mockFrom.mockReturnValue(selectSingleMock(row) as never);

    const result = await receiptService.verify(row.id, 'owner-A');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.computed_hash).toBe(result.stored_hash);
      expect(result.stored_hash).toBe(stored);
    }
  });

  it('tampered amount_usd → { valid:false, tamper_detected:true } (AC-5)', async () => {
    const stored = computeReceiptHash(canonicalOf(SAMPLE_ROW)) as string;
    // Store a valid hash but alter the amount so recompute diverges.
    const row: ReceiptRow = {
      ...SAMPLE_ROW,
      amount_usd: '999.00000000',
      receipt_hash: stored,
    };
    mockFrom.mockReturnValue(selectSingleMock(row) as never);

    const result = await receiptService.verify(row.id, 'owner-A');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.tamper_detected).toBe(true);
    }
  });

  it('cross-owner / missing → getById null → UNSIGNED sentinel (AC-8 handled at router)', async () => {
    mockFrom.mockReturnValue(selectSingleMock(null, 'PGRST116') as never);
    const result = await receiptService.verify('nope', 'owner-A');
    expect(result.valid).toBe(false);
  });
});

// ── AC-6 / DT-6 / CD-1: emit best-effort ────────────────────
describe('emit (AC-6 / best-effort)', () => {
  it('RECEIPT_SIGNING_SECRET unset → does NOT insert, WARN, no throw', async () => {
    delete process.env.RECEIPT_SIGNING_SECRET;
    const warn = logSpy.warn;
    warn.mockClear();

    await expect(
      receiptService.emit({
        ownerRef: 'owner-A',
        agentKeyId: 'key-1',
        sessionId: null,
        delegationId: null,
        receiptType: 'budget_debit',
        amountUsd: 1.5,
        chainId: 2368,
        txHash: null,
        counterparty: null,
        orchestrationId: null,
      }),
    ).resolves.toBeUndefined();

    expect(mockRpc).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('empty ownerRef → skip, no insert (CD-D)', async () => {
    const warn = logSpy.warn;
    warn.mockClear();
    await receiptService.emit({
      ownerRef: '',
      agentKeyId: null,
      sessionId: null,
      delegationId: null,
      receiptType: 'budget_debit',
      amountUsd: 1,
      chainId: 1,
      txHash: null,
      counterparty: null,
      orchestrationId: null,
    });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('skip: no ownerRef');
  });

  it('RPC rejects → .catch absorbs, no throw (best-effort CD-1)', async () => {
    const warn = logSpy.warn;
    warn.mockClear();
    mockRpc.mockRejectedValue(new Error('db down') as never);

    await expect(
      receiptService.emit({
        ownerRef: 'owner-A',
        agentKeyId: 'key-1',
        sessionId: null,
        delegationId: null,
        receiptType: 'budget_debit',
        amountUsd: 1.5,
        chainId: 2368,
        txHash: null,
        counterparty: null,
        orchestrationId: null,
      }),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
  });

  it('RPC returns error → WARN, no throw, no UPDATE', async () => {
    const warn = logSpy.warn;
    warn.mockClear();
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'boom' },
    } as never);

    await receiptService.emit({
      ownerRef: 'owner-A',
      agentKeyId: null,
      sessionId: null,
      delegationId: null,
      receiptType: 'budget_debit',
      amountUsd: 1,
      chainId: 1,
      txHash: null,
      counterparty: null,
      orchestrationId: null,
    });

    expect(mockFrom).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("happy path → RPC insert then UPDATE-once on receipt_hash='' (CD-2)", async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          id: SAMPLE_ROW.id,
          prev_receipt_hash: null,
          created_at: SAMPLE_ROW.created_at,
        },
      ],
      error: null,
    } as never);

    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
    };
    // The final .eq returns the resolved promise.
    updateChain.eq
      .mockReturnValueOnce(updateChain)
      .mockResolvedValueOnce({ error: null });
    mockFrom.mockReturnValue(updateChain as never);

    await receiptService.emit({
      ownerRef: 'owner-A',
      agentKeyId: SAMPLE_ROW.agent_key_id,
      sessionId: null,
      delegationId: null,
      receiptType: 'budget_debit',
      amountUsd: 1.5,
      chainId: 2368,
      txHash: null,
      counterparty: null,
      orchestrationId: null,
    });

    expect(mockRpc).toHaveBeenCalledWith('insert_receipt', expect.any(Object));
    expect(updateChain.update).toHaveBeenCalledWith({
      receipt_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // CD-2: UPDATE-once gated on receipt_hash=''
    expect(updateChain.eq).toHaveBeenCalledWith('id', SAMPLE_ROW.id);
    expect(updateChain.eq).toHaveBeenCalledWith('receipt_hash', '');
  });
});

// ── AC-7 / CD-3: list Ownership Guard ───────────────────────
describe('list (AC-7 / CD-3)', () => {
  it('applies .eq(owner_ref, ownerA)', async () => {
    const chain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    mockFrom.mockReturnValue(chain as never);

    await receiptService.list('owner-A');
    expect(chain.eq).toHaveBeenCalledWith('owner_ref', 'owner-A');
  });
});
