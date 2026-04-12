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
    it('calls update with is_active = false', async () => {
      const mock = chainMock();
      const mockUpdate = vi.fn().mockReturnValue(mock);
      mock.update = mockUpdate;
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );

      mock.eq = vi.fn().mockResolvedValue({ error: null });

      await identityService.deactivate('key-id-1');

      expect(mockUpdate).toHaveBeenCalledWith({ is_active: false });
    });

    it('throws on DB error', async () => {
      const mock = chainMock();
      mock.update = vi.fn().mockReturnValue(mock);
      mock.eq = vi.fn().mockResolvedValue({ error: { message: 'fail' } });
      mockFrom.mockReturnValue(
        mock as unknown as ReturnType<typeof supabase.from>,
      );

      await expect(identityService.deactivate('x')).rejects.toThrow(
        'Failed to deactivate agent key: fail',
      );
    });
  });
});
