/**
 * Delegation Service Unit Tests — WKH-101 (Fase 2)
 *
 * Cubre: AC-1 (create happy), AC-3 (signer mismatch), AC-4 (nonce replay),
 * AC-8/AC-9 (RPC mapping), AC-10/AC-12 (revoke/list ownership), AC-14 (domain),
 * ataques T18 (race/atomic), T19 (TOCTOU), T20 (domain spoof).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
}));

vi.mock('viem', () => ({
  recoverTypedDataAddress: vi.fn(),
}));

import { recoverTypedDataAddress } from 'viem';
import { supabase } from '../lib/supabase.js';
import type {
  A2AAgentKeyRow,
  CreateDelegationInput,
  DelegationPolicy,
} from '../types/index.js';
import { delegationService, exceedsPerTxLimit } from './delegation.js';
import {
  AgentKeyBudgetExhaustedError,
  AgentKeyInactiveError,
  AgentKeyNotFoundError,
  DailyLimitExceededError,
  DelegationExpiredError,
  DelegationNonceReplayError,
  DelegationNotFoundError,
  DelegationRevokedError,
  DelegationSignerMismatchError,
  DelegationTotalLimitExceededError,
  OwnershipMismatchError,
} from './security/errors.js';

const mockFrom = vi.mocked(supabase.from);
const mockRpc = vi.mocked(supabase.rpc);
const mockRecover = vi.mocked(recoverTypedDataAddress);

// ── Fixtures ────────────────────────────────────────────────

const FUNDING_WALLET = '0xabc0000000000000000000000000000000000001';
const SESSION_KEY = '0xdef0000000000000000000000000000000000002';

function makePolicy(
  overrides: Partial<DelegationPolicy> = {},
): DelegationPolicy {
  return {
    max_amount_per_tx: '0.50',
    max_total_amount: '100.00',
    expires_at: Math.floor(Date.now() / 1000) + 3600, // 1h en el futuro
    allowed_chains: [],
    allowed_agent_slugs: [],
    allowed_registries: [],
    ...overrides,
  };
}

function makeInput(policy = makePolicy()): CreateDelegationInput {
  return {
    signature: `0x${'11'.repeat(65)}`,
    session_key_address: SESSION_KEY,
    policy,
    typed_data: {
      domain: {
        name: 'WasiAI-a2a Delegation',
        version: '1',
        chainId: 2368,
      },
      types: {
        Delegation: [
          { name: 'session_key', type: 'address' },
          { name: 'policy', type: 'DelegationPolicy' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'Delegation',
      message: {
        session_key: SESSION_KEY as `0x${string}`,
        policy,
        nonce: `0x${'00'.repeat(32)}` as `0x${string}`,
      },
    },
  };
}

function makeParentKey(): A2AAgentKeyRow {
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
    funding_wallet: FUNDING_WALLET,
    metadata: {},
  };
}

/** Mock supabase builder chainable; `single` resuelve la query final. */
function chainMock(overrides: Record<string, unknown> = {}) {
  const chain: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    ...overrides,
  };
  for (const key of ['select', 'insert', 'update', 'eq', 'order']) {
    if (!overrides[key]) {
      (chain[key] as ReturnType<typeof vi.fn>).mockReturnValue(chain);
    }
  }
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DELEGATION_EIP712_NAME = 'WasiAI-a2a Delegation';
  process.env.DELEGATION_EIP712_VERSION = '1';
  process.env.KITE_CHAIN_ID = '2368';
});

// ── exceedsPerTxLimit (AC-7 helper, CD-AB-3) ─────────────────

describe('exceedsPerTxLimit (decimal-safe, AC-7)', () => {
  it('returns false when cost == limit', () => {
    expect(exceedsPerTxLimit('0.50', 0.5)).toBe(false);
  });
  it('returns true when cost > limit', () => {
    expect(exceedsPerTxLimit('0.50', 0.51)).toBe(true);
  });
  it('returns false for the classic float case 0.1+0.2 vs 0.30', () => {
    expect(exceedsPerTxLimit('0.30', 0.1 + 0.2)).toBe(false);
  });
  it('fail-secure: invalid limit string denies', () => {
    expect(exceedsPerTxLimit('abc', 0.01)).toBe(true);
  });
});

// ── verifyTypedData (AC-3/AC-14, T20 domain spoof) ───────────

describe('verifyTypedData', () => {
  it('AC-1/AC-14 recovers the signer when domain matches', async () => {
    mockRecover.mockResolvedValue(FUNDING_WALLET as `0x${string}`);
    const input = makeInput();
    const signer = await delegationService.verifyTypedData(
      input.typed_data,
      input.signature,
    );
    expect(signer).toBe(FUNDING_WALLET);
  });

  it('T20 domain spoof: divergent name → SignerMismatch without recovering', async () => {
    const input = makeInput();
    input.typed_data.domain.name = 'Evil Domain';
    await expect(
      delegationService.verifyTypedData(input.typed_data, input.signature),
    ).rejects.toBeInstanceOf(DelegationSignerMismatchError);
    expect(mockRecover).not.toHaveBeenCalled();
  });

  it('T20 domain spoof: divergent chainId → SignerMismatch without recovering', async () => {
    const input = makeInput();
    input.typed_data.domain.chainId = 999;
    await expect(
      delegationService.verifyTypedData(input.typed_data, input.signature),
    ).rejects.toBeInstanceOf(DelegationSignerMismatchError);
    expect(mockRecover).not.toHaveBeenCalled();
  });

  it('AC-3 recover throw → SignerMismatch', async () => {
    mockRecover.mockRejectedValue(new Error('bad signature'));
    const input = makeInput();
    await expect(
      delegationService.verifyTypedData(input.typed_data, input.signature),
    ).rejects.toBeInstanceOf(DelegationSignerMismatchError);
  });
});

// ── create (AC-1/AC-3/AC-4) ──────────────────────────────────

describe('create', () => {
  it('T1 (AC-1) happy: recover==funding_wallet → token + hash persisted', async () => {
    mockRecover.mockResolvedValue(FUNDING_WALLET as `0x${string}`);
    const insertChain = chainMock();
    insertChain.single = vi
      .fn()
      .mockResolvedValue({ data: { id: 'del-1' }, error: null });
    mockFrom.mockReturnValue(
      insertChain as unknown as ReturnType<typeof supabase.from>,
    );

    const result = await delegationService.create(makeParentKey(), makeInput());

    expect(result.delegation_id).toBe('del-1');
    expect(result.session_token).toMatch(/^wasi_a2a_session_[0-9a-f]{96}$/);
    // El INSERT recibió session_token_hash (no el token plano).
    const insertedRow = (insertChain.insert as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Record<string, unknown>;
    expect(insertedRow.session_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(insertedRow)).not.toContain(result.session_token);
    // owner_ref/key_id desde parentKey, NUNCA del request.
    expect(insertedRow.owner_ref).toBe('user-1');
    expect(insertedRow.key_id).toBe('key-1');
  });

  it('T3 (AC-3) signer != funding_wallet → SignerMismatch, 0 inserts', async () => {
    mockRecover.mockResolvedValue(
      '0x9999999999999999999999999999999999999999' as `0x${string}`,
    );
    const insertChain = chainMock();
    mockFrom.mockReturnValue(
      insertChain as unknown as ReturnType<typeof supabase.from>,
    );

    await expect(
      delegationService.create(makeParentKey(), makeInput()),
    ).rejects.toBeInstanceOf(DelegationSignerMismatchError);
    expect(insertChain.insert).not.toHaveBeenCalled();
  });

  it('T4 (AC-4) duplicate (key_id, nonce) → 23505 → NonceReplay', async () => {
    mockRecover.mockResolvedValue(FUNDING_WALLET as `0x${string}`);
    const insertChain = chainMock();
    insertChain.single = vi
      .fn()
      .mockResolvedValue({ data: null, error: { code: '23505' } });
    mockFrom.mockReturnValue(
      insertChain as unknown as ReturnType<typeof supabase.from>,
    );

    await expect(
      delegationService.create(makeParentKey(), makeInput()),
    ).rejects.toBeInstanceOf(DelegationNonceReplayError);
  });

  it('policy mismatch between input and signed message → SignerMismatch', async () => {
    mockRecover.mockResolvedValue(FUNDING_WALLET as `0x${string}`);
    const input = makeInput();
    // input.policy diverge de la policy firmada en el message.
    input.policy = makePolicy({ max_total_amount: '999.99' });
    await expect(
      delegationService.create(makeParentKey(), input),
    ).rejects.toBeInstanceOf(DelegationSignerMismatchError);
  });

  it('expired policy (past expires_at) → SignerMismatch', async () => {
    mockRecover.mockResolvedValue(FUNDING_WALLET as `0x${string}`);
    const past = makePolicy({ expires_at: Math.floor(Date.now() / 1000) - 10 });
    await expect(
      delegationService.create(makeParentKey(), makeInput(past)),
    ).rejects.toBeInstanceOf(DelegationSignerMismatchError);
  });
});

// ── debitDelegationAndParent (RPC mapping: T8, T9, T10, T13, T19) ─

describe('debitDelegationAndParent', () => {
  it('T10 success: returns new total_spent (RPC RETURN)', async () => {
    mockRpc.mockResolvedValue({ data: '0.30', error: null } as never);
    const total = await delegationService.debitDelegationAndParent(
      'del-1',
      'user-1',
      'key-1',
      2368,
      0.3,
    );
    expect(mockRpc).toHaveBeenCalledWith('debit_delegation_and_parent', {
      p_delegation_id: 'del-1',
      p_owner_ref: 'user-1',
      p_key_id: 'key-1',
      p_chain_id: 2368,
      p_amount_usd: 0.3,
    });
    expect(total).toBe('0.30');
  });

  it('T8 (AC-8) DELEGATION_TOTAL_LIMIT_EXCEEDED → mapped error', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'DELEGATION_TOTAL_LIMIT_EXCEEDED: 99 + 5 > 100' },
    } as never);
    await expect(
      delegationService.debitDelegationAndParent('d', 'o', 'k', 1, 5),
    ).rejects.toBeInstanceOf(DelegationTotalLimitExceededError);
  });

  it('T9 (AC-9) INSUFFICIENT_BUDGET → AgentKeyBudgetExhausted', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'INSUFFICIENT_BUDGET: chain 2368 balance is 1' },
    } as never);
    await expect(
      delegationService.debitDelegationAndParent('d', 'o', 'k', 1, 5),
    ).rejects.toBeInstanceOf(AgentKeyBudgetExhaustedError);
  });

  it('T19 (TOCTOU) DELEGATION_REVOKED under lock → DelegationRevoked', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'DELEGATION_REVOKED: del-1' },
    } as never);
    await expect(
      delegationService.debitDelegationAndParent('del-1', 'o', 'k', 1, 5),
    ).rejects.toBeInstanceOf(DelegationRevokedError);
  });

  it('DELEGATION_EXPIRED under lock → DelegationExpired', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'DELEGATION_EXPIRED: del-1' },
    } as never);
    await expect(
      delegationService.debitDelegationAndParent('del-1', 'o', 'k', 1, 5),
    ).rejects.toBeInstanceOf(DelegationExpiredError);
  });

  it('T13 (AC-12) OWNERSHIP_MISMATCH from RPC → OwnershipMismatch', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'OWNERSHIP_MISMATCH: delegation del-1 not owned' },
    } as never);
    await expect(
      delegationService.debitDelegationAndParent('del-1', 'evil', 'k', 1, 5),
    ).rejects.toBeInstanceOf(OwnershipMismatchError);
  });

  // ── AR-MNR-1/AR-MNR-2: prefijos del parent RPC bajo delegación ──

  it('AR-MNR-1 DAILY_LIMIT (parent RPC) → DailyLimitExceededError (no raw PG)', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: {
        message: 'DAILY_LIMIT: daily spend would be 9 + 2 = 11, limit is 10',
      },
    } as never);
    let thrown: unknown;
    try {
      await delegationService.debitDelegationAndParent('d', 'o', 'k', 1, 5);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DailyLimitExceededError);
    // El error class semántico NO acarrea el detalle crudo de Postgres.
    expect((thrown as Error).message).not.toContain('limit is');
    expect((thrown as Error).message).not.toContain('daily spend');
  });

  it('AR-MNR-1 KEY_INACTIVE (parent RPC) → AgentKeyInactiveError', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'KEY_INACTIVE: key_id k is deactivated' },
    } as never);
    await expect(
      delegationService.debitDelegationAndParent('d', 'o', 'k', 1, 5),
    ).rejects.toBeInstanceOf(AgentKeyInactiveError);
  });

  it('AR-MNR-1 KEY_NOT_FOUND (parent RPC) → AgentKeyNotFoundError', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'KEY_NOT_FOUND: key_id k does not exist' },
    } as never);
    await expect(
      delegationService.debitDelegationAndParent('d', 'o', 'k', 1, 5),
    ).rejects.toBeInstanceOf(AgentKeyNotFoundError);
  });

  it('AR-MNR-1 DELEGATION_NOT_FOUND → DelegationNotFoundError', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'DELEGATION_NOT_FOUND: del-1' },
    } as never);
    await expect(
      delegationService.debitDelegationAndParent('del-1', 'o', 'k', 1, 5),
    ).rejects.toBeInstanceOf(DelegationNotFoundError);
  });

  it('AR-MNR-2 unmapped RPC error → generic code, NO raw PG message leak', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'P0001: some internal postgres detail 0xdeadbeef' },
    } as never);
    let thrown: unknown;
    try {
      await delegationService.debitDelegationAndParent('d', 'o', 'k', 1, 5);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).toBe('DELEGATION_DEBIT_FAILED');
    expect((thrown as Error).message).not.toContain('postgres');
    expect((thrown as Error).message).not.toContain('0xdeadbeef');
  });
});

// ── revoke (AC-10/AC-12) ─────────────────────────────────────

describe('revoke', () => {
  it('AC-10 revokes own delegation (1 row matched)', async () => {
    const chain = chainMock();
    chain.select = vi
      .fn()
      .mockResolvedValue({ data: [{ id: 'del-1' }], error: null });
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );
    await expect(
      delegationService.revoke('del-1', 'user-1'),
    ).resolves.toBeUndefined();
    expect(chain.eq).toHaveBeenCalledWith('id', 'del-1');
    expect(chain.eq).toHaveBeenCalledWith('owner_ref', 'user-1');
  });

  it('T13 (AC-12) revoke of another owner → 0 rows → OwnershipMismatch', async () => {
    const chain = chainMock();
    chain.select = vi.fn().mockResolvedValue({ data: [], error: null });
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );
    await expect(
      delegationService.revoke('del-1', 'evil-owner'),
    ).rejects.toBeInstanceOf(OwnershipMismatchError);
  });
});

// ── list (AC-11) ─────────────────────────────────────────────

describe('list', () => {
  it('T12 (AC-11) derives status active/expired/revoked, filtered by owner', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const rows = [
      {
        id: 'd-active',
        session_key_address: SESSION_KEY,
        policy: makePolicy(),
        expires_at: new Date((nowSec + 3600) * 1000).toISOString(),
        total_spent: '1.00',
        revoked_at: null,
      },
      {
        id: 'd-expired',
        session_key_address: SESSION_KEY,
        policy: makePolicy(),
        expires_at: new Date((nowSec - 3600) * 1000).toISOString(),
        total_spent: '2.00',
        revoked_at: null,
      },
      {
        id: 'd-revoked',
        session_key_address: SESSION_KEY,
        policy: makePolicy(),
        expires_at: new Date((nowSec + 3600) * 1000).toISOString(),
        total_spent: '3.00',
        revoked_at: new Date().toISOString(),
      },
    ];
    const chain = chainMock();
    chain.order = vi.fn().mockResolvedValue({ data: rows, error: null });
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );

    const items = await delegationService.list('user-1');
    expect(chain.eq).toHaveBeenCalledWith('owner_ref', 'user-1');
    expect(items.map((i) => i.status)).toEqual([
      'active',
      'expired',
      'revoked',
    ]);
    expect(items[0].delegation_id).toBe('d-active');
  });
});

// ── lookupByTokenHash (AC-5) ─────────────────────────────────

describe('lookupByTokenHash', () => {
  it('AC-5 returns null on PGRST116 (token not found)', async () => {
    const chain = chainMock();
    chain.single = vi
      .fn()
      .mockResolvedValue({ data: null, error: { code: 'PGRST116' } });
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );
    const row = await delegationService.lookupByTokenHash('deadbeef');
    expect(row).toBeNull();
  });
});

// ── T18 atomic/race (semántica del RPC bajo concurrencia) ────

describe('T18 atomic race', () => {
  it('two concurrent debits: one succeeds, the other hits TOTAL (atomic RPC)', async () => {
    // Simula la serialización del FOR UPDATE: la 1ª pasa, la 2ª excede el total.
    mockRpc
      .mockResolvedValueOnce({ data: '99.00', error: null } as never)
      .mockResolvedValueOnce({
        data: null,
        error: { message: 'DELEGATION_TOTAL_LIMIT_EXCEEDED: 99 + 5 > 100' },
      } as never);

    const [r1, r2] = await Promise.allSettled([
      delegationService.debitDelegationAndParent('d', 'o', 'k', 1, 99),
      delegationService.debitDelegationAndParent('d', 'o', 'k', 1, 5),
    ]);

    expect(r1.status).toBe('fulfilled');
    expect(r2.status).toBe('rejected');
    if (r2.status === 'rejected') {
      expect(r2.reason).toBeInstanceOf(DelegationTotalLimitExceededError);
    }
  });
});
