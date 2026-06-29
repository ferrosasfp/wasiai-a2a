/**
 * x402 INBOUND anti-replay Unit Tests — M1 (audit 2026-06-24)
 *
 * Cubre: nonce nuevo → fresh (registrado); (network,nonce) repetido → replay
 * (23505); mismo nonce en distinto network → fresh; otro error de DB → fail-open
 * (unavailable, NUNCA throw).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────
// Structured logger mock: x402-nonce.ts logs the fail-open via
// getLogger('x402-nonce'). Mock it so the test asserts log emission
// (object-first / message-second) instead of spying on console. hoisted so
// the factory can reference it.
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
import { checkAndRecordX402Nonce } from './x402-nonce.js';

const mockFrom = vi.mocked(supabase.from);

/** chainable mock cuyo `insert` resuelve `{ error }`. */
function insertMock(error: { code?: string; message?: string } | null) {
  const insert = vi.fn().mockResolvedValue({ data: null, error });
  return { chain: { insert }, insert };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkAndRecordX402Nonce', () => {
  it('nonce nuevo → fresh y se registra con (network, nonce)', async () => {
    const { chain, insert } = insertMock(null);
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );

    const res = await checkAndRecordX402Nonce('base-sepolia', '0xabc');

    expect(res).toEqual({ kind: 'fresh' });
    expect(mockFrom).toHaveBeenCalledWith('a2a_x402_nonces');
    expect(insert).toHaveBeenCalledWith({
      network: 'base-sepolia',
      nonce: '0xabc',
    });
  });

  it('nonce repetido (mismo network+nonce) → replay (23505)', async () => {
    const { chain } = insertMock({ code: '23505', message: 'dup' });
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );

    const res = await checkAndRecordX402Nonce('base-sepolia', '0xabc');

    expect(res).toEqual({ kind: 'replay' });
  });

  it('mismo nonce en distinto network → fresh (la UNIQUE es por (network, nonce))', async () => {
    // El primer network ya lo vio (23505), pero el segundo network es un INSERT
    // limpio (sin error) → fresh. Cada llamada usa su propio insert mock.
    const { chain: chainA } = insertMock({ code: '23505', message: 'dup' });
    const { chain: chainB, insert: insertB } = insertMock(null);
    mockFrom
      .mockReturnValueOnce(
        chainA as unknown as ReturnType<typeof supabase.from>,
      )
      .mockReturnValueOnce(
        chainB as unknown as ReturnType<typeof supabase.from>,
      );

    const replay = await checkAndRecordX402Nonce('base-sepolia', '0xsame');
    const fresh = await checkAndRecordX402Nonce('kite-testnet', '0xsame');

    expect(replay).toEqual({ kind: 'replay' });
    expect(fresh).toEqual({ kind: 'fresh' });
    expect(insertB).toHaveBeenCalledWith({
      network: 'kite-testnet',
      nonce: '0xsame',
    });
  });

  it('otro error de DB → fail-open (unavailable), NUNCA throw', async () => {
    const warnSpy = logSpy.warn;
    warnSpy.mockClear();
    const { chain } = insertMock({ code: '500', message: 'db down' });
    mockFrom.mockReturnValue(
      chain as unknown as ReturnType<typeof supabase.from>,
    );

    const res = await checkAndRecordX402Nonce('base-sepolia', '0xabc');

    expect(res).toEqual({ kind: 'unavailable' });
    // object-first / message-second: network lives in the structured context.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ network: 'base-sepolia' }),
      'record failed, failing open',
    );
  });
});
