/**
 * Identity Service Unit Tests — WKH-34
 * Tests: AC-5 (createKey), AC-6 (lookupByHash), AC-7 (deactivate)
 */

import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock supabase ───────────────────────────────────────────

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: vi.fn(),
  },
}));

import { supabase } from '../lib/supabase.js';
import { identityService } from './identity.js';

const mockFrom = vi.mocked(supabase.from);

// ── Helpers ─────────────────────────────────────────────────

function chainMock(overrides: Record<string, unknown> = {}) {
  const chain: Record<string, unknown> = {
    insert: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    ...overrides,
  };
  for (const key of ['insert', 'select', 'update', 'eq']) {
    if (!overrides[key]) {
      (chain[key] as ReturnType<typeof vi.fn>).mockReturnValue(chain);
    }
  }
  return chain;
}

// ── Tests ───────────────────────────────────────────────────

describe('identityService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createKey', () => {
    it('returns key with wasi_a2a_ prefix and 73 chars total', async () => {
      const mock = chainMock();
      mock.single = vi.fn().mockResolvedValue({
        data: { id: 'test-uuid-123' },
        error: null,
      });
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );

      const result = await identityService.createKey({ owner_ref: 'user-1' });

      expect(result.key).toMatch(/^wasi_a2a_[0-9a-f]{64}$/);
      expect(result.key.length).toBe(73);
      expect(result.key_id).toBe('test-uuid-123');
    });

    it('stores SHA-256 hash of the plaintext key, not the plaintext', async () => {
      const mock = chainMock();
      let storedHash: string | undefined;
      mock.insert = vi
        .fn()
        .mockImplementation((row: Record<string, unknown>) => {
          storedHash = row.key_hash as string;
          return mock;
        });
      mock.single = vi.fn().mockResolvedValue({
        data: { id: 'test-uuid-456' },
        error: null,
      });
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );

      const result = await identityService.createKey({ owner_ref: 'user-2' });

      const expectedHash = crypto
        .createHash('sha256')
        .update(result.key)
        .digest('hex');
      expect(storedHash).toBe(expectedHash);
      expect(result.key).not.toBe(storedHash);
    });

    it('passes scoping fields to the DB insert', async () => {
      const mock = chainMock();
      let insertedRow: Record<string, unknown> | undefined;
      mock.insert = vi
        .fn()
        .mockImplementation((row: Record<string, unknown>) => {
          insertedRow = row;
          return mock;
        });
      mock.single = vi.fn().mockResolvedValue({
        data: { id: 'test-uuid-789' },
        error: null,
      });
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );

      await identityService.createKey({
        owner_ref: 'user-3',
        display_name: 'My Key',
        daily_limit_usd: 100,
        allowed_registries: ['kite'],
        allowed_agent_slugs: ['agent-1'],
        allowed_categories: ['text'],
        max_spend_per_call_usd: 5,
      });

      expect(insertedRow).toMatchObject({
        owner_ref: 'user-3',
        display_name: 'My Key',
        daily_limit_usd: 100,
        allowed_registries: ['kite'],
        allowed_agent_slugs: ['agent-1'],
        allowed_categories: ['text'],
        max_spend_per_call_usd: 5,
      });
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

      await expect(
        identityService.createKey({ owner_ref: 'x' }),
      ).rejects.toThrow('Failed to create agent key: DB down');
    });
  });

  describe('lookupByHash', () => {
    it('returns row when found', async () => {
      const fakeRow = {
        id: 'uuid-1',
        key_hash: 'abc',
        owner_ref: 'user-1',
        is_active: true,
      };
      const mock = chainMock();
      mock.single = vi.fn().mockResolvedValue({ data: fakeRow, error: null });
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );

      const result = await identityService.lookupByHash('abc');
      expect(result).toEqual(fakeRow);
    });

    it('returns null when not found (PGRST116)', async () => {
      const mock = chainMock();
      mock.single = vi.fn().mockResolvedValue({
        data: null,
        error: { code: 'PGRST116', message: 'no rows' },
      });
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );

      const result = await identityService.lookupByHash('nonexistent');
      expect(result).toBeNull();
    });

    it('throws on unexpected DB error', async () => {
      const mock = chainMock();
      mock.single = vi.fn().mockResolvedValue({
        data: null,
        error: { code: 'OTHER', message: 'unexpected' },
      });
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );

      await expect(identityService.lookupByHash('x')).rejects.toThrow(
        'Failed to lookup agent key: unexpected',
      );
    });
  });

  describe('deactivate', () => {
    it('calls update with is_active = false AND owner_ref filter (AC-4)', async () => {
      const mock = chainMock();
      const mockUpdate = vi.fn().mockReturnValue(mock);
      mock.update = mockUpdate;
      mock.select = vi.fn().mockResolvedValue({
        data: [{ id: 'key-id-1' }],
        error: null,
      });
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );

      await identityService.deactivate('key-id-1', 'user-A');

      expect(mockUpdate).toHaveBeenCalledWith({ is_active: false });
      expect(mock.eq).toHaveBeenCalledWith('id', 'key-id-1');
      expect(mock.eq).toHaveBeenCalledWith('owner_ref', 'user-A');
    });

    it('throws OwnershipMismatchError when owner mismatch (AC-4)', async () => {
      const mock = chainMock();
      mock.update = vi.fn().mockReturnValue(mock);
      mock.select = vi.fn().mockResolvedValue({ data: [], error: null });
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );

      await expect(
        identityService.deactivate('other-key', 'user-A'),
      ).rejects.toMatchObject({ code: 'OWNERSHIP_MISMATCH' });
    });

    it('throws on DB error', async () => {
      const mock = chainMock();
      mock.update = vi.fn().mockReturnValue(mock);
      mock.select = vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'fail' },
      });
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );

      await expect(identityService.deactivate('x', 'user-A')).rejects.toThrow(
        'Failed to deactivate agent key: fail',
      );
    });
  });

  describe('bindFundingWallet (WKH-35 FIX-1)', () => {
    it('updates funding_wallet lowercase filtered by id AND owner_ref (Ownership Guard)', async () => {
      const mock = chainMock();
      const mockUpdate = vi.fn().mockReturnValue(mock);
      mock.update = mockUpdate;
      mock.select = vi.fn().mockResolvedValue({
        data: [{ id: 'key-id-1' }],
        error: null,
      });
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );

      const stored = await identityService.bindFundingWallet(
        'key-id-1',
        'user-A',
        '0xABCDEF0000000000000000000000000000000001',
      );

      expect(stored).toBe('0xabcdef0000000000000000000000000000000001');
      expect(mockUpdate).toHaveBeenCalledWith({
        funding_wallet: '0xabcdef0000000000000000000000000000000001',
      });
      expect(mock.eq).toHaveBeenCalledWith('id', 'key-id-1');
      expect(mock.eq).toHaveBeenCalledWith('owner_ref', 'user-A');
    });

    it('throws FundingWalletAlreadyBoundError on 23505 unique violation', async () => {
      const mock = chainMock();
      mock.update = vi.fn().mockReturnValue(mock);
      mock.select = vi.fn().mockResolvedValue({
        data: null,
        error: { code: '23505', message: 'duplicate key' },
      });
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );

      await expect(
        identityService.bindFundingWallet(
          'key-id-1',
          'user-A',
          '0x1111111111111111111111111111111111111111',
        ),
      ).rejects.toMatchObject({ code: 'FUNDING_WALLET_ALREADY_BOUND' });
    });

    it('throws OwnershipMismatchError when no row matches (id, owner_ref)', async () => {
      const mock = chainMock();
      mock.update = vi.fn().mockReturnValue(mock);
      mock.select = vi.fn().mockResolvedValue({ data: [], error: null });
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );

      await expect(
        identityService.bindFundingWallet(
          'other-key',
          'user-A',
          '0x1111111111111111111111111111111111111111',
        ),
      ).rejects.toMatchObject({ code: 'OWNERSHIP_MISMATCH' });
    });

    it('throws on generic DB error', async () => {
      const mock = chainMock();
      mock.update = vi.fn().mockReturnValue(mock);
      mock.select = vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'fail' },
      });
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );

      await expect(
        identityService.bindFundingWallet(
          'x',
          'user-A',
          '0x1111111111111111111111111111111111111111',
        ),
      ).rejects.toThrow('Failed to bind funding wallet: fail');
    });
  });

  // ── WKH-100 FIX-PACK (BLQ-MED-1 / DT-21.6) — bindErc8004Identity ──
  describe('bindErc8004Identity', () => {
    const binding = {
      token_id: '42',
      chain_id: 84532,
      agent_card_url: '',
      owner_address: '0xabc',
      verified_at: '2026-05-10T00:00:00.000Z',
    };

    /**
     * The service calls supabase.from twice: (1) uniqueness pre-check (thenable
     * chain `.select.eq.neq.eq.eq.limit`), (2) UPDATE (`.update.eq.eq.select`).
     */
    function setupBindMocks(opts: {
      clash: Array<{ id: string }>;
      clashError?: { message: string } | null;
      updateData: Array<{ id: string }> | null;
      updateError?: { code?: string; message: string } | null;
    }) {
      const preCheck: Record<string, unknown> = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        neq: vi.fn().mockReturnThis(),
        // thenable terminal: limit() resolves the candidates
        limit: vi.fn().mockResolvedValue({
          data: opts.clashError ? null : opts.clash,
          error: opts.clashError ?? null,
        }),
      };
      for (const k of ['select', 'eq', 'neq']) {
        (preCheck[k] as ReturnType<typeof vi.fn>).mockReturnValue(preCheck);
      }
      const update: Record<string, unknown> = {
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        select: vi.fn().mockResolvedValue({
          data: opts.updateData,
          error: opts.updateError ?? null,
        }),
      };
      update.update = vi.fn().mockReturnValue(update);
      update.eq = vi.fn().mockReturnValue(update);
      let call = 0;
      mockFrom.mockReset();
      mockFrom.mockImplementation(() => {
        call += 1;
        return (call === 1 ? preCheck : update) as unknown as ReturnType<
          typeof supabase.from
        >;
      });
      return { preCheck, update };
    }

    it('binds when no clashing active key (Ownership Guard id+owner_ref)', async () => {
      const { update } = setupBindMocks({
        clash: [],
        updateData: [{ id: 'key-1' }],
      });
      const result = await identityService.bindErc8004Identity(
        'key-1',
        'user-A',
        binding,
      );
      expect(result).toEqual(binding);
      expect(update.eq).toHaveBeenCalledWith('id', 'key-1');
      expect(update.eq).toHaveBeenCalledWith('owner_ref', 'user-A');
    });

    it('pre-check SELECTs only id + filters is_active/token/chain excluding own key', async () => {
      const { preCheck } = setupBindMocks({
        clash: [],
        updateData: [{ id: 'key-1' }],
      });
      await identityService.bindErc8004Identity('key-1', 'user-A', binding);
      expect(preCheck.select).toHaveBeenCalledWith('id');
      expect(preCheck.eq).toHaveBeenCalledWith('is_active', true);
      expect(preCheck.neq).toHaveBeenCalledWith('id', 'key-1');
      expect(preCheck.eq).toHaveBeenCalledWith(
        'erc8004_identity->>token_id',
        '42',
      );
      expect(preCheck.eq).toHaveBeenCalledWith(
        'erc8004_identity->>chain_id',
        '84532',
      );
    });

    it('throws Erc8004TokenAlreadyBoundError when another active key has the token', async () => {
      setupBindMocks({
        clash: [{ id: 'other-key' }],
        updateData: null,
      });
      await expect(
        identityService.bindErc8004Identity('key-1', 'user-A', binding),
      ).rejects.toMatchObject({ code: 'ERC8004_TOKEN_ALREADY_BOUND' });
    });

    it('maps 23505 on UPDATE to Erc8004TokenAlreadyBoundError (hardening)', async () => {
      setupBindMocks({
        clash: [],
        updateData: null,
        updateError: { code: '23505', message: 'duplicate' },
      });
      await expect(
        identityService.bindErc8004Identity('key-1', 'user-A', binding),
      ).rejects.toMatchObject({ code: 'ERC8004_TOKEN_ALREADY_BOUND' });
    });

    it('throws OwnershipMismatchError when UPDATE matches 0 rows', async () => {
      setupBindMocks({
        clash: [],
        updateData: [],
      });
      await expect(
        identityService.bindErc8004Identity('key-1', 'user-A', binding),
      ).rejects.toMatchObject({ code: 'OWNERSHIP_MISMATCH' });
    });
  });
});
