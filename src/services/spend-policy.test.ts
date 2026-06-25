/**
 * Spend Policy Service Unit Tests — WKH-125 (KEY-CONSTRAINTS)
 *
 * Cubre: AC-1 (set persiste + ownership), AC-7 (ownership guard read/write),
 * CD-6 (invariante de ventana total/rolling), AC-3 (estructura SUM rolling vía
 * el SQL — assert estructural sobre la migración), AC-4 (orden de locks en el
 * RPC + dispatch al RPC, NO check app-layer separado).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
}));

import { supabase } from '../lib/supabase.js';
import type { A2AAgentKeyRow, SpendPolicyInput } from '../types/index.js';
import { OwnershipMismatchError } from './security/errors.js';
import {
  InvalidSpendPolicyInputError,
  normalizeDestination,
  spendPolicyService,
} from './spend-policy.js';

const mockFrom = vi.mocked(supabase.from);

// ── Fixtures ────────────────────────────────────────────────

function makeKey(overrides: Partial<A2AAgentKeyRow> = {}): A2AAgentKeyRow {
  return {
    id: 'key-1',
    owner_ref: 'user-1',
    key_hash: 'hash',
    display_name: null,
    budget: { '2368': '50.00' },
    daily_limit_usd: null,
    daily_spent_usd: '0',
    daily_reset_at: new Date().toISOString(),
    allowed_registries: null,
    allowed_agent_slugs: null,
    allowed_categories: null,
    max_spend_per_call_usd: null,
    is_active: true,
    last_used_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    erc8004_identity: null,
    kite_passport: null,
    agentkit_wallet: null,
    funding_wallet: null,
    metadata: {},
    require_signature: false,
    ...overrides,
  };
}

function makeInput(
  overrides: Partial<SpendPolicyInput> = {},
): SpendPolicyInput {
  return {
    destination: 'kite/translator',
    max_usd: '50.00',
    window_type: 'total',
    window_secs: null,
    ...overrides,
  };
}

/** Mock supabase builder chainable; `single`/`order`/`limit` resuelven la query. */
function chainMock(overrides: Record<string, unknown> = {}) {
  const chain: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue({ data: [], error: null }),
    limit: vi.fn().mockResolvedValue({ data: [], error: null }),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    ...overrides,
  };
  for (const key of ['select', 'upsert', 'delete', 'eq']) {
    if (!overrides[key]) {
      (chain[key] as ReturnType<typeof vi.fn>).mockReturnValue(chain);
    }
  }
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── normalizeDestination ─────────────────────────────────────

describe('normalizeDestination', () => {
  it('trims and lowercases', () => {
    expect(normalizeDestination('  Kite/Translator  ')).toBe('kite/translator');
  });

  it('empty after trim → InvalidSpendPolicyInputError', () => {
    expect(() => normalizeDestination('   ')).toThrow(
      InvalidSpendPolicyInputError,
    );
  });
});

// ── set (AC-1 / AC-7 / CD-6) ────────────────────────────────

describe('set', () => {
  it('AC-1: persists policy with owner_ref/key_id from callerKey, returns response', async () => {
    const chain = chainMock();
    chain.single = vi.fn().mockResolvedValue({
      data: {
        id: 'pol-1',
        key_id: 'key-1',
        owner_ref: 'user-1',
        destination: 'kite/translator',
        max_usd: '50.000000',
        window_type: 'total',
        window_secs: null,
        created_at: 'ts',
        updated_at: 'ts',
      },
      error: null,
    });
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );

    const result = await spendPolicyService.set(makeKey(), makeInput());

    expect(result.destination).toBe('kite/translator');
    expect(result.max_usd).toBe('50.000000');
    const upsertRow = (chain.upsert as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Record<string, unknown>;
    // owner_ref/key_id desde callerKey, NUNCA del input (AC-7).
    expect(upsertRow.owner_ref).toBe('user-1');
    expect(upsertRow.key_id).toBe('key-1');
    expect(upsertRow.destination).toBe('kite/translator');
    const onConflict = (chain.upsert as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as Record<string, unknown>;
    expect(onConflict.onConflict).toBe('key_id,destination');
  });

  it('normalizes the destination before persisting', async () => {
    const chain = chainMock();
    chain.single = vi.fn().mockResolvedValue({
      data: {
        id: 'pol-1',
        key_id: 'key-1',
        owner_ref: 'user-1',
        destination: 'kite/translator',
        max_usd: '50.000000',
        window_type: 'total',
        window_secs: null,
        created_at: 'ts',
        updated_at: 'ts',
      },
      error: null,
    });
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );

    await spendPolicyService.set(
      makeKey(),
      makeInput({ destination: '  KITE/Translator ' }),
    );
    const upsertRow = (chain.upsert as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Record<string, unknown>;
    expect(upsertRow.destination).toBe('kite/translator');
  });

  it('CD-6: total with window_secs set → InvalidSpendPolicyInputError, no upsert', async () => {
    const chain = chainMock();
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );
    await expect(
      spendPolicyService.set(
        makeKey(),
        makeInput({ window_type: 'total', window_secs: 3600 }),
      ),
    ).rejects.toBeInstanceOf(InvalidSpendPolicyInputError);
    expect(chain.upsert).not.toHaveBeenCalled();
  });

  it('CD-6: rolling with window_secs <= 0 → InvalidSpendPolicyInputError', async () => {
    const chain = chainMock();
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );
    await expect(
      spendPolicyService.set(
        makeKey(),
        makeInput({ window_type: 'rolling', window_secs: 0 }),
      ),
    ).rejects.toBeInstanceOf(InvalidSpendPolicyInputError);
  });

  it('CD-6: rolling with null window_secs → InvalidSpendPolicyInputError', async () => {
    const chain = chainMock();
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );
    await expect(
      spendPolicyService.set(
        makeKey(),
        makeInput({ window_type: 'rolling', window_secs: null }),
      ),
    ).rejects.toBeInstanceOf(InvalidSpendPolicyInputError);
  });

  it('rolling with positive window_secs → persists window_secs', async () => {
    const chain = chainMock();
    chain.single = vi.fn().mockResolvedValue({
      data: {
        id: 'pol-1',
        key_id: 'key-1',
        owner_ref: 'user-1',
        destination: 'kite/translator',
        max_usd: '50.000000',
        window_type: 'rolling',
        window_secs: 86400,
        created_at: 'ts',
        updated_at: 'ts',
      },
      error: null,
    });
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );

    const result = await spendPolicyService.set(
      makeKey(),
      makeInput({ window_type: 'rolling', window_secs: 86400 }),
    );
    expect(result.window_type).toBe('rolling');
    expect(result.window_secs).toBe(86400);
    const upsertRow = (chain.upsert as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Record<string, unknown>;
    expect(upsertRow.window_secs).toBe(86400);
  });

  it('invalid max_usd → InvalidSpendPolicyInputError', async () => {
    const chain = chainMock();
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );
    await expect(
      spendPolicyService.set(makeKey(), makeInput({ max_usd: 'abc' })),
    ).rejects.toBeInstanceOf(InvalidSpendPolicyInputError);
  });
});

// ── list (AC-7) ──────────────────────────────────────────────

describe('list', () => {
  it('AC-7: filters by key_id and owner_ref', async () => {
    const chain = chainMock();
    chain.order = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'pol-1',
          key_id: 'key-1',
          owner_ref: 'user-1',
          destination: 'kite/translator',
          max_usd: '50.000000',
          window_type: 'total',
          window_secs: null,
          created_at: 'ts',
          updated_at: 'ts',
        },
      ],
      error: null,
    });
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );

    const result = await spendPolicyService.list('key-1', 'user-1');
    expect(result).toHaveLength(1);
    expect(result[0]!.destination).toBe('kite/translator');
    expect(chain.eq).toHaveBeenCalledWith('key_id', 'key-1');
    expect(chain.eq).toHaveBeenCalledWith('owner_ref', 'user-1');
  });
});

// ── delete (AC-7) ────────────────────────────────────────────

describe('delete', () => {
  it('AC-7: deletes filtered by key_id + owner_ref + destination', async () => {
    const chain = chainMock();
    chain.select = vi
      .fn()
      .mockResolvedValue({ data: [{ id: 'pol-1' }], error: null });
    chain.eq = vi.fn().mockReturnValue(chain);
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );

    await spendPolicyService.delete('key-1', 'user-1', 'Kite/Translator');
    expect(chain.eq).toHaveBeenCalledWith('key_id', 'key-1');
    expect(chain.eq).toHaveBeenCalledWith('owner_ref', 'user-1');
    expect(chain.eq).toHaveBeenCalledWith('destination', 'kite/translator');
  });

  it('AC-7: 0 rows (wrong owner) → OwnershipMismatchError', async () => {
    const chain = chainMock();
    chain.select = vi.fn().mockResolvedValue({ data: [], error: null });
    chain.eq = vi.fn().mockReturnValue(chain);
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );

    await expect(
      spendPolicyService.delete('key-1', 'attacker', 'kite/translator'),
    ).rejects.toBeInstanceOf(OwnershipMismatchError);
  });
});

// ── hasAnyPolicy (AC-7) ──────────────────────────────────────

describe('hasAnyPolicy', () => {
  it('AC-7: filters by key_id + owner_ref; true when rows exist', async () => {
    const chain = chainMock();
    chain.limit = vi
      .fn()
      .mockResolvedValue({ data: [{ id: 'pol-1' }], error: null });
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );

    const has = await spendPolicyService.hasAnyPolicy('key-1', 'user-1');
    expect(has).toBe(true);
    expect(chain.eq).toHaveBeenCalledWith('key_id', 'key-1');
    expect(chain.eq).toHaveBeenCalledWith('owner_ref', 'user-1');
  });

  it('false when no rows', async () => {
    const chain = chainMock();
    chain.limit = vi.fn().mockResolvedValue({ data: [], error: null });
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );
    expect(await spendPolicyService.hasAnyPolicy('key-1', 'user-1')).toBe(
      false,
    );
  });
});

// ── AC-3 / AC-4: assert estructural sobre el SQL del RPC ──────

describe('migration SQL structure (AC-3 / AC-4 / CD-1)', () => {
  const sql = readFileSync(
    join(
      process.cwd(),
      'supabase/migrations/20260606000000_a2a_key_spend_policies.sql',
    ),
    'utf8',
  );

  it('AC-4: atomicity — RPC locks key + policy FOR UPDATE before SUM/check/debit', () => {
    const rpcStart = sql.indexOf('FUNCTION debit_with_dest_policy');
    const rpcBody = sql.slice(rpcStart);
    // Lock de la key (FOR UPDATE) ANTES de leer el ledger.
    const keyLock = rpcBody.indexOf('FROM a2a_agent_keys');
    const polLock = rpcBody.indexOf('FROM a2a_key_spend_policies');
    const sumLedger = rpcBody.indexOf('SUM(amount_usd)');
    const capCheck = rpcBody.indexOf('DEST_CAP_EXCEEDED');
    const perform = rpcBody.indexOf('PERFORM increment_a2a_key_spend');
    const insertLedger = rpcBody.indexOf(
      'INSERT INTO a2a_key_dest_spend_ledger',
    );
    expect(keyLock).toBeGreaterThan(-1);
    expect(rpcBody).toContain('FOR UPDATE');
    // Orden: lock key → lock policy → SUM → check cap → debit → insert ledger.
    expect(keyLock).toBeLessThan(polLock);
    expect(polLock).toBeLessThan(sumLedger);
    expect(sumLedger).toBeLessThan(capCheck);
    expect(capCheck).toBeLessThan(perform);
    expect(perform).toBeLessThan(insertLedger);
  });

  it('AC-3: rolling window uses debited_at >= now() - secs * interval', () => {
    expect(sql).toContain(
      "debited_at >= now() - (v_pol_wsecs * interval '1 second')",
    );
  });

  it('CD-2: reuses increment_a2a_key_spend via PERFORM (not reimplemented)', () => {
    expect(sql).toContain('PERFORM increment_a2a_key_spend(');
  });

  it('CD-1: hardened (search_path + REVOKE + GRANT service_role)', () => {
    expect(sql).toContain('SET search_path = public, pg_temp');
    expect(sql).toContain(
      'REVOKE EXECUTE ON FUNCTION public.debit_with_dest_policy',
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.debit_with_dest_policy',
    );
  });
});
