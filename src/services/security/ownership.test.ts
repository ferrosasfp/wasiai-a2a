/**
 * Security Suite — Ownership Guard (WKH-53)
 *
 * Verifica defensa contra cross-tenant access en a2a_agent_keys.
 * Estos tests DEBEN fallar si alguien quita el .eq('owner_ref', ...) de
 * los services modificados.
 *
 * Scope: getBalance + deactivate (ambos en a2a_agent_keys con owner_ref).
 * NOTA: debit/registerDeposit NO están aquí por DD-6 — la RPC PG no verifica
 * owner_ref, y agregar tests "verdes" acá sería engañoso. Residual risk
 * trackeado en WKH-54.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/supabase.js', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

import { supabase } from '../../lib/supabase.js';
import { budgetService } from '../budget.js';
import { identityService } from '../identity.js';

const mockFrom = vi.mocked(supabase.from);

// ── Helper — chainMock (fidelity CD-A1) ─────────────────────
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

const OWNER_A = 'owner-A-uuid';
const OWNER_B = 'owner-B-uuid';
const KEY_OF_A = 'key-belongs-to-A';
const KEY_OF_B = 'key-belongs-to-B';

// ── Suite 1: getBalance ─────────────────────────────────────
describe('Ownership Guard — budgetService.getBalance', () => {
  beforeEach(() => vi.clearAllMocks());

  it('owner A cannot read balance of owner B — rejects with OwnershipMismatchError (AC-1)', async () => {
    const mock = chainMock();
    // Supabase simula "no rows" cuando id=KEY_OF_B y owner_ref=OWNER_A no matchea.
    mock.single = vi.fn().mockResolvedValue({
      data: null,
      error: { code: 'PGRST116', message: 'no rows' },
    });
    mockFrom.mockReturnValue(
      mock as unknown as ReturnType<typeof supabase.from>,
    );

    await expect(
      budgetService.getBalance(KEY_OF_B, 2368, OWNER_A),
    ).rejects.toMatchObject({ code: 'OWNERSHIP_MISMATCH' });
  });

  it('calls .eq("owner_ref", ownerId) on the query chain (AC-3)', async () => {
    const mock = chainMock();
    mock.single = vi.fn().mockResolvedValue({
      data: { budget: { '2368': '5.00' } },
      error: null,
    });
    mockFrom.mockReturnValue(
      mock as unknown as ReturnType<typeof supabase.from>,
    );

    await budgetService.getBalance(KEY_OF_A, 2368, OWNER_A);

    expect(mock.eq).toHaveBeenCalledWith('id', KEY_OF_A);
    expect(mock.eq).toHaveBeenCalledWith('owner_ref', OWNER_A);
  });

  it('owner A reads own balance successfully (AC-6)', async () => {
    const mock = chainMock();
    mock.single = vi.fn().mockResolvedValue({
      data: { budget: { '2368': '42.00' } },
      error: null,
    });
    mockFrom.mockReturnValue(
      mock as unknown as ReturnType<typeof supabase.from>,
    );

    const balance = await budgetService.getBalance(KEY_OF_A, 2368, OWNER_A);
    expect(balance).toBe('42.00');
  });
});

// ── Suite 2: deactivate ─────────────────────────────────────
describe('Ownership Guard — identityService.deactivate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('owner A cannot deactivate key of owner B — rejects with OwnershipMismatchError (AC-2)', async () => {
    const mock = chainMock();
    mock.update = vi.fn().mockReturnValue(mock);
    // UPDATE cross-owner → afecta 0 rows, no error.
    mock.select = vi.fn().mockResolvedValue({ data: [], error: null });
    mockFrom.mockReturnValue(
      mock as unknown as ReturnType<typeof supabase.from>,
    );

    await expect(
      identityService.deactivate(KEY_OF_B, OWNER_A),
    ).rejects.toMatchObject({ code: 'OWNERSHIP_MISMATCH' });
  });

  it('calls .eq("owner_ref", ownerId) on the UPDATE chain (AC-4)', async () => {
    const mock = chainMock();
    mock.update = vi.fn().mockReturnValue(mock);
    mock.select = vi.fn().mockResolvedValue({
      data: [{ id: KEY_OF_A }],
      error: null,
    });
    mockFrom.mockReturnValue(
      mock as unknown as ReturnType<typeof supabase.from>,
    );

    await identityService.deactivate(KEY_OF_A, OWNER_A);

    expect(mock.eq).toHaveBeenCalledWith('id', KEY_OF_A);
    expect(mock.eq).toHaveBeenCalledWith('owner_ref', OWNER_A);
  });

  it('owner A deactivates own key successfully (AC-6)', async () => {
    const mock = chainMock();
    mock.update = vi.fn().mockReturnValue(mock);
    mock.select = vi.fn().mockResolvedValue({
      data: [{ id: KEY_OF_A }],
      error: null,
    });
    mockFrom.mockReturnValue(
      mock as unknown as ReturnType<typeof supabase.from>,
    );

    await expect(
      identityService.deactivate(KEY_OF_A, OWNER_A),
    ).resolves.toBeUndefined();
  });
});
