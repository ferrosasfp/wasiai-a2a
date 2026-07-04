/**
 * Key Session Service Unit Tests — WKH-121 (server-side session keys)
 *
 * Cubre: AC-1 (create happy + token/hash), AC-2 (scope ⊆ padre + budget),
 * AC-3 (TTL), AC-8/AC-9 (RPC mapping/atomicity), AC-11 (list/debit ownership),
 * AC-13 (status derivado), CD-AB-1 (mapeo completo de prefijos RPC, sin leak PG).
 */

import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
}));

vi.mock('../adapters/registry.js', () => ({
  getAdaptersBundle: vi.fn(() => ({
    chainConfig: { name: 'kite', chainId: 2368, explorerUrl: '' },
  })),
}));

import { supabase } from '../lib/supabase.js';
import type { A2AAgentKeyRow, CreateKeySessionInput } from '../types/index.js';
import {
  InvalidKeySessionInputError,
  keySessionService,
  ScopeExceedsParentError,
} from './key-session.js';
import {
  AgentKeyBudgetExhaustedError,
  AgentKeyInactiveError,
  AgentKeyNotFoundError,
  DailyLimitExceededError,
  DestCapExceededError,
  InvalidDebitAmountError,
  OwnershipMismatchError,
  SessionBudgetExhaustedError,
  SessionExpiredError,
  SessionNotFoundError,
  SessionTokenInvalidError,
  SigningSecretNotSetError,
} from './security/errors.js';

const mockFrom = vi.mocked(supabase.from);
const mockRpc = vi.mocked(supabase.rpc);

// ── Fixtures ────────────────────────────────────────────────

function makeParentKey(
  overrides: Partial<A2AAgentKeyRow> = {},
): A2AAgentKeyRow {
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
  overrides: Partial<CreateKeySessionInput> = {},
): CreateKeySessionInput {
  return {
    ttl_seconds: 3600,
    max_budget_usd: '10.00',
    ...overrides,
  };
}

/** Mock supabase builder chainable; `single`/`order` resuelven la query final. */
function chainMock(overrides: Record<string, unknown> = {}) {
  const chain: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue({ data: [], error: null }),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    ...overrides,
  };
  for (const key of ['select', 'insert', 'update', 'eq']) {
    if (!overrides[key]) {
      (chain[key] as ReturnType<typeof vi.fn>).mockReturnValue(chain);
    }
  }
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.SESSION_MAX_TTL_SECONDS;
});

// ── create (AC-1 / AC-2 / AC-3) ──────────────────────────────

describe('create', () => {
  it('AC-1 happy: persists only the hash, returns the plaintext token once', async () => {
    const insertChain = chainMock();
    insertChain.single = vi
      .fn()
      .mockResolvedValue({ data: { id: 'sess-1' }, error: null });
    mockFrom.mockReturnValue(
      insertChain as unknown as ReturnType<typeof supabase.from>,
    );

    const result = await keySessionService.create(makeParentKey(), makeInput());

    expect(result.session_id).toBe('sess-1');
    expect(result.session_token).toMatch(/^wasi_a2a_sess_[0-9a-f]{96}$/);
    const insertedRow = (insertChain.insert as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Record<string, unknown>;
    // DB guarda solo SHA-256(token), nunca el token plano (CD-3).
    expect(insertedRow.session_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(insertedRow)).not.toContain(result.session_token);
    // owner_ref/key_id desde parentKey, NUNCA del request.
    expect(insertedRow.owner_ref).toBe('user-1');
    expect(insertedRow.key_id).toBe('key-1');
  });

  it('AC-3 ttl_seconds <= 0 → InvalidKeySessionInputError, no insert', async () => {
    const insertChain = chainMock();
    mockFrom.mockReturnValue(
      insertChain as unknown as ReturnType<typeof supabase.from>,
    );
    await expect(
      keySessionService.create(makeParentKey(), makeInput({ ttl_seconds: 0 })),
    ).rejects.toBeInstanceOf(InvalidKeySessionInputError);
    expect(insertChain.insert).not.toHaveBeenCalled();
  });

  it('AC-3 ttl_seconds > SESSION_MAX_TTL_SECONDS → Invalid', async () => {
    await expect(
      keySessionService.create(
        makeParentKey(),
        makeInput({ ttl_seconds: 86401 }),
      ),
    ).rejects.toBeInstanceOf(InvalidKeySessionInputError);
  });

  it('AC-3 NaN/<=0 env → fail-safe default 86400 (24h valid, 86401 invalid)', async () => {
    process.env.SESSION_MAX_TTL_SECONDS = 'not-a-number';
    const insertChain = chainMock();
    insertChain.single = vi
      .fn()
      .mockResolvedValue({ data: { id: 'sess-1' }, error: null });
    mockFrom.mockReturnValue(
      insertChain as unknown as ReturnType<typeof supabase.from>,
    );
    await expect(
      keySessionService.create(
        makeParentKey(),
        makeInput({ ttl_seconds: 86400 }),
      ),
    ).resolves.toMatchObject({ session_id: 'sess-1' });
  });

  it('AC-2 max_budget_usd <= 0 → Invalid', async () => {
    await expect(
      keySessionService.create(
        makeParentKey(),
        makeInput({ max_budget_usd: '0' }),
      ),
    ).rejects.toBeInstanceOf(InvalidKeySessionInputError);
  });

  it('T-SCOPE-2 (AC-2) max_budget_usd > parent balance → ScopeExceedsParent', async () => {
    await expect(
      keySessionService.create(
        makeParentKey({ budget: { '2368': '5.00' } }),
        makeInput({ max_budget_usd: '10.00' }),
      ),
    ).rejects.toBeInstanceOf(ScopeExceedsParentError);
  });

  it('AC-2 allowed_registries ⊄ parent → ScopeExceedsParent', async () => {
    await expect(
      keySessionService.create(
        makeParentKey({ allowed_registries: ['a', 'b'] }),
        makeInput({ allowed_registries: ['a', 'c'] }),
      ),
    ).rejects.toBeInstanceOf(ScopeExceedsParentError);
  });

  it('AC-2 session list ⊆ parent list → persists effective list', async () => {
    const insertChain = chainMock();
    insertChain.single = vi
      .fn()
      .mockResolvedValue({ data: { id: 'sess-1' }, error: null });
    mockFrom.mockReturnValue(
      insertChain as unknown as ReturnType<typeof supabase.from>,
    );
    const result = await keySessionService.create(
      makeParentKey({ allowed_registries: ['a', 'b'] }),
      makeInput({ allowed_registries: ['a'] }),
    );
    expect(result.scope.allowed_registries).toEqual(['a']);
    const insertedRow = (insertChain.insert as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Record<string, unknown>;
    expect(insertedRow.allowed_registries).toEqual(['a']);
  });

  it('AC-2 session null (no declara) → persists null (hereda del padre)', async () => {
    const insertChain = chainMock();
    insertChain.single = vi
      .fn()
      .mockResolvedValue({ data: { id: 'sess-1' }, error: null });
    mockFrom.mockReturnValue(
      insertChain as unknown as ReturnType<typeof supabase.from>,
    );
    const result = await keySessionService.create(
      makeParentKey({ allowed_registries: ['a', 'b'] }),
      makeInput(),
    );
    expect(result.scope.allowed_registries).toBeNull();
  });

  // ── WKH-123 (AC-11 / CD-5): signing_secret ────────────────
  it('AC-11 require_signature:true → genera secret, persiste SOLO hash, devuelve plano una vez', async () => {
    const insertChain = chainMock();
    insertChain.single = vi
      .fn()
      .mockResolvedValue({ data: { id: 'sess-1' }, error: null });
    mockFrom.mockReturnValue(
      insertChain as unknown as ReturnType<typeof supabase.from>,
    );

    const result = await keySessionService.create(
      makeParentKey(),
      makeInput({ require_signature: true }),
    );

    // El plano viaja UNA vez, 32 bytes = 64 hex chars.
    expect(result.signing_secret).toMatch(/^[0-9a-f]{64}$/);

    const insertedRow = (insertChain.insert as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Record<string, unknown>;
    // CD-5: el INSERT lleva el HASH, NUNCA el plano.
    expect(insertedRow.require_signature).toBe(true);
    expect(insertedRow.signing_secret_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(insertedRow).not.toHaveProperty('signing_secret');
    expect(JSON.stringify(insertedRow)).not.toContain(
      result.signing_secret as string,
    );
    // El hash persistido === SHA-256 del secret plano devuelto.
    const expectedHash = crypto
      .createHash('sha256')
      .update(result.signing_secret as string)
      .digest('hex');
    expect(insertedRow.signing_secret_hash).toBe(expectedHash);
  });

  it('require_signature ausente → no secret, hash null, sin signing_secret en la respuesta', async () => {
    const insertChain = chainMock();
    insertChain.single = vi
      .fn()
      .mockResolvedValue({ data: { id: 'sess-1' }, error: null });
    mockFrom.mockReturnValue(
      insertChain as unknown as ReturnType<typeof supabase.from>,
    );

    const result = await keySessionService.create(makeParentKey(), makeInput());

    expect(result.signing_secret).toBeUndefined();
    const insertedRow = (insertChain.insert as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Record<string, unknown>;
    expect(insertedRow.require_signature).toBe(false);
    expect(insertedRow.signing_secret_hash).toBeNull();
  });
});

// ── setRequireSignature (WKH-123, AC-10) ─────────────────────
describe('setRequireSignature', () => {
  /**
   * Mock de una cadena `.select().eq().eq()` (SELECT del row) que resuelve en el
   * SEGUNDO `.eq` (id + owner_ref).
   */
  function selectChain(result: { data: unknown; error: unknown }) {
    return {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnValueOnce({
        eq: vi.fn().mockResolvedValue(result),
      }),
    };
  }

  /**
   * Mock de una cadena `.update().eq().eq().select()` (UPDATE) que resuelve en
   * `.select()`.
   */
  function updateChain(result: { data: unknown; error: unknown }) {
    return {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnValueOnce({
        eq: vi.fn().mockReturnValueOnce({
          select: vi.fn().mockResolvedValue(result),
        }),
      }),
    };
  }

  it('enable on a session with secret → UPDATE guarded by id + owner_ref', async () => {
    mockFrom
      .mockReturnValueOnce(
        selectChain({
          data: [{ id: 'sess-1', signing_secret_hash: 'f'.repeat(64) }],
          error: null,
        }) as unknown as ReturnType<typeof supabase.from>,
      )
      .mockReturnValueOnce(
        updateChain({
          data: [{ id: 'sess-1' }],
          error: null,
        }) as unknown as ReturnType<typeof supabase.from>,
      );

    await expect(
      keySessionService.setRequireSignature('sess-1', 'user-1', true),
    ).resolves.toBeUndefined();
  });

  it('enable on a session WITHOUT secret → SigningSecretNotSetError', async () => {
    mockFrom.mockReturnValue(
      selectChain({
        data: [{ id: 'sess-1', signing_secret_hash: null }],
        error: null,
      }) as unknown as ReturnType<typeof supabase.from>,
    );

    await expect(
      keySessionService.setRequireSignature('sess-1', 'user-1', true),
    ).rejects.toBeInstanceOf(SigningSecretNotSetError);
  });

  it('unknown session / other owner → SessionNotFoundError (disclosure-safe)', async () => {
    mockFrom.mockReturnValue(
      selectChain({ data: [], error: null }) as unknown as ReturnType<
        typeof supabase.from
      >,
    );

    await expect(
      keySessionService.setRequireSignature('sess-x', 'user-1', true),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});

// ── debitSessionAndParent (RPC mapping: AC-8/AC-9 + CD-AB-1) ──

describe('debitSessionAndParent', () => {
  it('T-RPC-ATOMIC success: returns new spent_usd', async () => {
    mockRpc.mockResolvedValue({ data: '0.30', error: null } as never);
    const spent = await keySessionService.debitSessionAndParent(
      'sess-1',
      'user-1',
      'key-1',
      2368,
      0.3,
    );
    expect(mockRpc).toHaveBeenCalledWith('debit_session_and_parent', {
      p_session_id: 'sess-1',
      p_owner_ref: 'user-1',
      p_key_id: 'key-1',
      p_chain_id: 2368,
      p_amount_usd: 0.3,
      // WKH-125 (AC-6): sin destino → p_destination NULL (back-compat por DEFAULT).
      p_destination: null,
    });
    expect(spent).toBe('0.30');
  });

  it('T-BUDGET-EXH (AC-9) SESSION_BUDGET_EXHAUSTED → SessionBudgetExhaustedError', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'SESSION_BUDGET_EXHAUSTED: 9 + 5 > 10' },
    } as never);
    await expect(
      keySessionService.debitSessionAndParent('s', 'o', 'k', 1, 5),
    ).rejects.toBeInstanceOf(SessionBudgetExhaustedError);
  });

  it('WKH-125 (AC-6) destination is forwarded as p_destination to the RPC', async () => {
    mockRpc.mockResolvedValue({ data: '0.30', error: null } as never);
    await keySessionService.debitSessionAndParent(
      'sess-1',
      'user-1',
      'key-1',
      2368,
      0.3,
      'kite/translator',
    );
    expect(mockRpc).toHaveBeenCalledWith(
      'debit_session_and_parent',
      expect.objectContaining({ p_destination: 'kite/translator' }),
    );
  });

  it('WKH-125 (AC-6/AC-2) DEST_CAP_EXCEEDED → DestCapExceededError (inherited cap)', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'DEST_CAP_EXCEEDED: dest x accum 1 + 1 > cap 1' },
    } as never);
    await expect(
      keySessionService.debitSessionAndParent(
        's',
        'o',
        'k',
        1,
        1,
        'kite/translator',
      ),
    ).rejects.toBeInstanceOf(DestCapExceededError);
  });

  it('CD-AB-1 SESSION_REVOKED → SessionTokenInvalidError', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'SESSION_REVOKED: sess-1' },
    } as never);
    await expect(
      keySessionService.debitSessionAndParent('s', 'o', 'k', 1, 5),
    ).rejects.toBeInstanceOf(SessionTokenInvalidError);
  });

  it('CD-AB-1 SESSION_EXPIRED → SessionExpiredError', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'SESSION_EXPIRED: sess-1' },
    } as never);
    await expect(
      keySessionService.debitSessionAndParent('s', 'o', 'k', 1, 5),
    ).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('CD-AB-1 SESSION_NOT_FOUND → SessionTokenInvalidError', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'SESSION_NOT_FOUND: sess-1' },
    } as never);
    await expect(
      keySessionService.debitSessionAndParent('s', 'o', 'k', 1, 5),
    ).rejects.toBeInstanceOf(SessionTokenInvalidError);
  });

  it('CD-AB-1 INSUFFICIENT_BUDGET (parent RPC) → AgentKeyBudgetExhaustedError', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'INSUFFICIENT_BUDGET: chain 2368 balance is 1' },
    } as never);
    await expect(
      keySessionService.debitSessionAndParent('s', 'o', 'k', 1, 5),
    ).rejects.toBeInstanceOf(AgentKeyBudgetExhaustedError);
  });

  it('CD-AB-1 DAILY_LIMIT (parent RPC) → DailyLimitExceededError, NO raw PG', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'DAILY_LIMIT: daily spend would be 11, limit is 10' },
    } as never);
    let thrown: unknown;
    try {
      await keySessionService.debitSessionAndParent('s', 'o', 'k', 1, 5);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DailyLimitExceededError);
    expect((thrown as Error).message).not.toContain('limit is');
  });

  it('CD-AB-1 KEY_INACTIVE (parent RPC) → AgentKeyInactiveError', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'KEY_INACTIVE: key_id k is deactivated' },
    } as never);
    await expect(
      keySessionService.debitSessionAndParent('s', 'o', 'k', 1, 5),
    ).rejects.toBeInstanceOf(AgentKeyInactiveError);
  });

  it('CD-AB-1 KEY_NOT_FOUND (parent RPC) → AgentKeyNotFoundError', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'KEY_NOT_FOUND: key_id k does not exist' },
    } as never);
    await expect(
      keySessionService.debitSessionAndParent('s', 'o', 'k', 1, 5),
    ).rejects.toBeInstanceOf(AgentKeyNotFoundError);
  });

  it('T-OWNERSHIP-1 (AC-11) OWNERSHIP_MISMATCH from RPC → OwnershipMismatchError', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'OWNERSHIP_MISMATCH: session sess-1 not owned' },
    } as never);
    await expect(
      keySessionService.debitSessionAndParent('sess-1', 'evil', 'k', 1, 5),
    ).rejects.toBeInstanceOf(OwnershipMismatchError);
  });

  // WKH-142 (T8): el prefijo INVALID_AMOUNT del parent RPC (guard NULL/<0/NaN)
  // vía el PERFORM → InvalidDebitAmountError, sin filtrar el msg crudo de PG.
  it('WKH-142 INVALID_AMOUNT (parent RPC) → InvalidDebitAmountError', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: {
        message:
          'INVALID_AMOUNT: p_amount_usd -1 must be a non-negative number',
      },
    } as never);
    await expect(
      keySessionService.debitSessionAndParent('sess-1', 'o', 'k', 1, -1),
    ).rejects.toBeInstanceOf(InvalidDebitAmountError);
  });

  it('CD-AB-1 unmapped RPC error → SESSION_DEBIT_FAILED, NO raw PG leak', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'P0001: some internal postgres detail 0xdeadbeef' },
    } as never);
    let thrown: unknown;
    try {
      await keySessionService.debitSessionAndParent('s', 'o', 'k', 1, 5);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).toBe('SESSION_DEBIT_FAILED');
    expect((thrown as Error).message).not.toContain('postgres');
    expect((thrown as Error).message).not.toContain('0xdeadbeef');
  });

  it('T-RPC-ATOMIC race: one succeeds, the other hits SESSION_BUDGET_EXHAUSTED', async () => {
    mockRpc
      .mockResolvedValueOnce({ data: '9.00', error: null } as never)
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'SESSION_BUDGET_EXHAUSTED: 9 + 5 > 10' },
      } as never);
    const [r1, r2] = await Promise.allSettled([
      keySessionService.debitSessionAndParent('s', 'o', 'k', 1, 9),
      keySessionService.debitSessionAndParent('s', 'o', 'k', 1, 5),
    ]);
    expect(r1.status).toBe('fulfilled');
    expect(r2.status).toBe('rejected');
    if (r2.status === 'rejected') {
      expect(r2.reason).toBeInstanceOf(SessionBudgetExhaustedError);
    }
  });
});

// ── list (AC-13 / AC-11 ownership) ───────────────────────────

describe('list', () => {
  it('T-LIST (AC-13) derives status active/expired/revoked, filtered by owner', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const rows = [
      {
        id: 's-active',
        expires_at: new Date((nowSec + 3600) * 1000).toISOString(),
        max_budget_usd: '10.00',
        spent_usd: '1.00',
        revoked_at: null,
        allowed_registries: ['a'],
        allowed_agent_slugs: null,
        allowed_categories: null,
      },
      {
        id: 's-expired',
        expires_at: new Date((nowSec - 3600) * 1000).toISOString(),
        max_budget_usd: '10.00',
        spent_usd: '2.00',
        revoked_at: null,
        allowed_registries: null,
        allowed_agent_slugs: null,
        allowed_categories: null,
      },
      {
        id: 's-revoked',
        expires_at: new Date((nowSec + 3600) * 1000).toISOString(),
        max_budget_usd: '10.00',
        spent_usd: '3.00',
        revoked_at: new Date().toISOString(),
        allowed_registries: null,
        allowed_agent_slugs: null,
        allowed_categories: null,
      },
    ];
    const chain = chainMock();
    chain.order = vi.fn().mockResolvedValue({ data: rows, error: null });
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );

    const items = await keySessionService.list('user-1');
    // T-OWNERSHIP-1 (AC-11): list filtra por owner_ref.
    expect(chain.eq).toHaveBeenCalledWith('owner_ref', 'user-1');
    expect(items.map((i) => i.status)).toEqual([
      'active',
      'expired',
      'revoked',
    ]);
    expect(items[0]!.session_id).toBe('s-active');
    expect(items[0]!.spent).toBe('1.00');
    expect(items[0]!.scope.allowed_registries).toEqual(['a']);
  });
});

// ── lookupByTokenHash (AC-4/AC-5) — única fn SIN owner gate ───

describe('lookupByTokenHash', () => {
  it('AC-5 returns null on PGRST116 (token not found)', async () => {
    const chain = chainMock();
    chain.single = vi
      .fn()
      .mockResolvedValue({ data: null, error: { code: 'PGRST116' } });
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );
    const row = await keySessionService.lookupByTokenHash('deadbeef');
    expect(row).toBeNull();
    // No owner gate: solo filtra por session_token_hash (NO es IDOR).
    expect(chain.eq).toHaveBeenCalledWith('session_token_hash', 'deadbeef');
    expect(chain.eq).not.toHaveBeenCalledWith('owner_ref', expect.anything());
  });
});

// ── revoke (WKH-122: AC-1 / AC-3 / AC-4 / AC-7) ──────────────

describe('revoke', () => {
  it('T-SVC-OWNERSHIP (AC-1/AC-7): UPDATE owner-guarded por id + owner_ref', async () => {
    const chain = chainMock();
    // Terminal `.select('id')` resuelve con ≥1 row (revocación exitosa).
    chain.select = vi
      .fn()
      .mockResolvedValue({ data: [{ id: 'sess-1' }], error: null });
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );

    await keySessionService.revoke('sess-1', 'user-1');

    expect(mockFrom).toHaveBeenCalledWith('a2a_key_sessions');
    expect(chain.update).toHaveBeenCalledWith(
      expect.objectContaining({ revoked_at: expect.any(String) }),
    );
    // Ownership Guard: ambos filtros antes de resolver (AC-7).
    expect(chain.eq).toHaveBeenCalledWith('id', 'sess-1');
    expect(chain.eq).toHaveBeenCalledWith('owner_ref', 'user-1');
  });

  it('T-IDEMPOTENT-SVC (AC-4): ≥1 row (ya revocada) → void sin lanzar', async () => {
    const chain = chainMock();
    chain.select = vi
      .fn()
      .mockResolvedValue({ data: [{ id: 'sess-1' }], error: null });
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );

    await expect(
      keySessionService.revoke('sess-1', 'user-1'),
    ).resolves.toBeUndefined();
  });

  it('T-NOTFOUND-SVC (AC-3): 0 rows → SessionNotFoundError', async () => {
    const chain = chainMock();
    chain.select = vi.fn().mockResolvedValue({ data: [], error: null });
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );

    await expect(
      keySessionService.revoke('sess-unknown', 'user-1'),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
    // Disclosure-safe: NO OwnershipMismatchError (divergencia vs delegación, CD-6).
    await expect(
      keySessionService.revoke('sess-unknown', 'user-1'),
    ).rejects.not.toBeInstanceOf(OwnershipMismatchError);
  });
});
