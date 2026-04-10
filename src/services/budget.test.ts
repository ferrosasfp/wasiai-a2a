/**
 * Budget Service Unit Tests — WKH-34
 * Tests: AC-8 (getBalance), AC-9 (debit), AC-10 (registerDeposit), AC-11 (daily reset)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock supabase ───────────────────────────────────────────

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
}))

import { supabase } from '../lib/supabase.js'
import { budgetService } from './budget.js'

const mockFrom = vi.mocked(supabase.from)
const mockRpc = vi.mocked(supabase.rpc)

// ── Helpers ─────────────────────────────────────────────────

function chainMock(overrides: Record<string, unknown> = {}) {
  const chain: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    ...overrides,
  }
  for (const key of ['select', 'update', 'eq']) {
    if (!overrides[key]) {
      (chain[key] as ReturnType<typeof vi.fn>).mockReturnValue(chain)
    }
  }
  return chain
}

// ── Tests ───────────────────────────────────────────────────

describe('budgetService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getBalance', () => {
    it('returns "0" for missing chain entry (AC-8)', async () => {
      const mock = chainMock()
      mock.single = vi.fn().mockResolvedValue({
        data: { budget: { '1': '5.00' } },
        error: null,
      })
      mockFrom.mockReturnValue(mock as unknown as ReturnType<typeof supabase.from>)

      const result = await budgetService.getBalance('key-1', 2368)
      expect(result).toBe('0')
    })

    it('returns correct balance for existing chain (AC-8)', async () => {
      const mock = chainMock()
      mock.single = vi.fn().mockResolvedValue({
        data: { budget: { '2368': '10.500000' } },
        error: null,
      })
      mockFrom.mockReturnValue(mock as unknown as ReturnType<typeof supabase.from>)

      const result = await budgetService.getBalance('key-1', 2368)
      expect(result).toBe('10.500000')
    })

    it('throws on DB error', async () => {
      const mock = chainMock()
      mock.single = vi.fn().mockResolvedValue({
        data: null,
        error: { message: 'DB down' },
      })
      mockFrom.mockReturnValue(mock as unknown as ReturnType<typeof supabase.from>)

      await expect(budgetService.getBalance('x', 1))
        .rejects.toThrow('Failed to get balance: DB down')
    })
  })

  describe('debit', () => {
    it('calls supabase.rpc with correct params and returns success (AC-9)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockRpc.mockResolvedValue({ data: null, error: null } as any)

      const result = await budgetService.debit('key-1', 2368, 1.5)

      expect(mockRpc).toHaveBeenCalledWith('increment_a2a_key_spend', {
        p_key_id: 'key-1',
        p_chain_id: 2368,
        p_amount_usd: 1.5,
      })
      expect(result).toEqual({ success: true })
    })

    it('returns failure with DAILY_LIMIT error from Postgres (AC-9)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'DAILY_LIMIT: daily spend would be 9 + 2 = 11, limit is 10' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      const result = await budgetService.debit('key-1', 2368, 2)

      expect(result).toEqual({
        success: false,
        error: 'DAILY_LIMIT: daily spend would be 9 + 2 = 11, limit is 10',
      })
    })

    it('returns failure with INSUFFICIENT_BUDGET error from Postgres (AC-9)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'INSUFFICIENT_BUDGET: chain 2368 balance is 1, requested 5' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)

      const result = await budgetService.debit('key-1', 2368, 5)

      expect(result).toEqual({
        success: false,
        error: 'INSUFFICIENT_BUDGET: chain 2368 balance is 1, requested 5',
      })
    })
  })

  describe('registerDeposit', () => {
    it('calls supabase.rpc with correct params and returns new balance (AC-10, BLQ-4)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockRpc.mockResolvedValue({ data: '15.000000', error: null } as any)

      const result = await budgetService.registerDeposit('key-1', 2368, '10.00')

      expect(mockRpc).toHaveBeenCalledWith('register_a2a_key_deposit', {
        p_key_id: 'key-1',
        p_chain_id: 2368,
        p_amount_usd: 10.00,
      })
      expect(result).toBe('15.000000')
    })

    it('throws on RPC error (BLQ-4)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockRpc.mockResolvedValue({ data: null, error: { message: 'key_not_found' } } as any)

      await expect(budgetService.registerDeposit('x', 1, '1'))
        .rejects.toThrow('Failed to register deposit: key_not_found')
    })
  })
})
