/**
 * Tests for Fee Charge Service — WKH-44
 *
 * Wave 1: FT-1..FT-8 — `getProtocolFeeRate` env parsing + safety guard.
 * Wave 2: FT-9..FT-16 — `chargeProtocolFee` helper (idempotency + sign/settle).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────
// Mock del payment adapter (patrón verificado en src/services/compose.test.ts:15-17)
const mockSign = vi.fn();
const mockSettle = vi.fn();
vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: () => ({ sign: mockSign, settle: mockSettle }),
}));

// Mock del cliente supabase — exponemos `from` con builder chainable.
const mockMaybeSingle = vi.fn();
const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockFrom = vi.fn();

vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: (...args: unknown[]) => mockFrom(...args),
  },
}));

// ─── Imports (tras mocks) ───────────────────────────────────

import {
  chargeProtocolFee,
  getProtocolFeeRate,
  ProtocolFeeError,
} from './fee-charge.js';

// ─── Utilities ──────────────────────────────────────────────

/**
 * Builder helper para construir el chain que usa `chargeProtocolFee` al
 * consultar la fila previa de `a2a_protocol_fees`:
 *   supabase.from('a2a_protocol_fees').select('...').eq('orchestration_id', id).maybeSingle()
 */
function stubSelect(result: { data: unknown; error?: unknown }) {
  mockFrom.mockImplementationOnce(() => ({
    select: mockSelect.mockImplementationOnce(() => ({
      eq: mockEq.mockImplementationOnce(() => ({
        maybeSingle: mockMaybeSingle.mockResolvedValueOnce(result),
      })),
    })),
  }));
}

/**
 * Stub para el INSERT (pending). Pattern:
 *   supabase.from('a2a_protocol_fees').insert({...})  → Promise<{error}>
 */
function stubInsert(result: { error?: unknown }) {
  mockFrom.mockImplementationOnce(() => ({
    insert: mockInsert.mockImplementationOnce(() => Promise.resolve(result)),
  }));
}

/**
 * Stub para el UPDATE (charged | failed). Pattern:
 *   supabase.from('a2a_protocol_fees').update({...}).eq('orchestration_id', id)
 */
function stubUpdate(result: { error?: unknown }) {
  mockFrom.mockImplementationOnce(() => ({
    update: mockUpdate.mockImplementationOnce(() => ({
      eq: mockEq.mockImplementationOnce(() => Promise.resolve(result)),
    })),
  }));
}

// ─── getProtocolFeeRate (FT-1..FT-8) ────────────────────────

describe('getProtocolFeeRate', () => {
  const originalEnv = process.env.PROTOCOL_FEE_RATE;

  beforeEach(() => {
    delete process.env.PROTOCOL_FEE_RATE;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PROTOCOL_FEE_RATE;
    } else {
      process.env.PROTOCOL_FEE_RATE = originalEnv;
    }
  });

  // FT-1 (AC-9): unset → 0.01
  it('FT-1: returns default 0.01 when env var is unset', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getProtocolFeeRate()).toBe(0.01);
    expect(errSpy).not.toHaveBeenCalled();
  });

  // FT-2 (AC-9): valid value parses cleanly
  it('FT-2: parses valid "0.05" → 0.05', () => {
    process.env.PROTOCOL_FEE_RATE = '0.05';
    expect(getProtocolFeeRate()).toBe(0.05);
  });

  // FT-3 (AC-9, CD-E): NaN input → fallback + console.error
  it('FT-3: falls back to 0.01 + console.error on NaN input ("abc")', () => {
    process.env.PROTOCOL_FEE_RATE = 'abc';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getProtocolFeeRate()).toBe(0.01);
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]?.[0]).toContain('Invalid PROTOCOL_FEE_RATE');
  });

  // FT-4 (AC-9): negative value → fallback + console.error
  it('FT-4: falls back to 0.01 + console.error on negative ("-0.01")', () => {
    process.env.PROTOCOL_FEE_RATE = '-0.01';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getProtocolFeeRate()).toBe(0.01);
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  // FT-5 (AC-9): > 0.10 → fallback + console.error
  it('FT-5: falls back to 0.01 + console.error on > 0.10 ("0.5")', () => {
    process.env.PROTOCOL_FEE_RATE = '0.5';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getProtocolFeeRate()).toBe(0.01);
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  // FT-6 (AC-10): no cache — cambiar env entre calls refleja el nuevo valor
  it('FT-6: re-reads env on every call (no cache)', () => {
    process.env.PROTOCOL_FEE_RATE = '0.02';
    expect(getProtocolFeeRate()).toBe(0.02);

    process.env.PROTOCOL_FEE_RATE = '0.03';
    expect(getProtocolFeeRate()).toBe(0.03);

    delete process.env.PROTOCOL_FEE_RATE;
    expect(getProtocolFeeRate()).toBe(0.01);
  });

  // FT-7 (AC-9 boundary): 0.10 exacto → aceptado
  it('FT-7: accepts upper boundary 0.10', () => {
    process.env.PROTOCOL_FEE_RATE = '0.10';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getProtocolFeeRate()).toBe(0.1);
    expect(errSpy).not.toHaveBeenCalled();
  });

  // FT-8 (AC-9 boundary): 0.0 exacto → aceptado
  it('FT-8: accepts lower boundary 0.0', () => {
    process.env.PROTOCOL_FEE_RATE = '0.0';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getProtocolFeeRate()).toBe(0.0);
    expect(errSpy).not.toHaveBeenCalled();
  });

  // Bonus (defensive): Infinity → fallback
  it('FT-8b (defensive): rejects Infinity → fallback 0.01', () => {
    process.env.PROTOCOL_FEE_RATE = 'Infinity';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getProtocolFeeRate()).toBe(0.01);
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  // Bonus (defensive): empty string → default (no error)
  it('FT-8c (defensive): empty string → default 0.01 without error', () => {
    process.env.PROTOCOL_FEE_RATE = '';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getProtocolFeeRate()).toBe(0.01);
    expect(errSpy).not.toHaveBeenCalled();
  });
});

// ─── chargeProtocolFee (FT-9..FT-16 — implementado en W2) ───

describe('chargeProtocolFee', () => {
  const originalWallet = process.env.WASIAI_PROTOCOL_FEE_WALLET;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockSign.mockReset();
    mockSettle.mockReset();
    mockFrom.mockReset();
    mockSelect.mockReset();
    mockEq.mockReset();
    mockInsert.mockReset();
    mockUpdate.mockReset();
    mockMaybeSingle.mockReset();
    delete process.env.WASIAI_PROTOCOL_FEE_WALLET;
  });

  afterEach(() => {
    if (originalWallet === undefined) {
      delete process.env.WASIAI_PROTOCOL_FEE_WALLET;
    } else {
      process.env.WASIAI_PROTOCOL_FEE_WALLET = originalWallet;
    }
  });

  // FT-9 (AC-5, CD-2): wallet unset → skipped, DB not called
  it('FT-9: skips when WASIAI_PROTOCOL_FEE_WALLET unset', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await chargeProtocolFee({
      orchestrationId: 'id-1',
      budgetUsdc: 1.0,
      feeRate: 0.01,
    });

    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toBe('WALLET_UNSET');
      expect(result.feeUsdc).toBeCloseTo(0.01, 6);
    }
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockSign).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  // FT-10 (AC-2): happy path — sign+settle OK, row charged, txHash propagated
  it('FT-10: happy path — sign+settle OK → status charged + txHash', async () => {
    process.env.WASIAI_PROTOCOL_FEE_WALLET =
      '0x1111111111111111111111111111111111111111';

    // 1. select previo: no existe
    stubSelect({ data: null });
    // 2. insert pending: OK
    stubInsert({});
    // 3. update charged: OK
    stubUpdate({});

    mockSign.mockResolvedValueOnce({
      xPaymentHeader: 'base64-header',
      paymentRequest: {
        authorization: { value: '10000000000000000' },
        signature: '0xsig',
        network: 'kite',
      },
    });
    mockSettle.mockResolvedValueOnce({
      txHash: '0xABC',
      success: true,
    });

    const result = await chargeProtocolFee({
      orchestrationId: 'id-10',
      budgetUsdc: 1.0,
      feeRate: 0.01,
    });

    expect(result.status).toBe('charged');
    if (result.status === 'charged') {
      expect(result.txHash).toBe('0xABC');
      expect(result.feeUsdc).toBeCloseTo(0.01, 6);
    }
    expect(mockSign).toHaveBeenCalledTimes(1);
    expect(mockSettle).toHaveBeenCalledTimes(1);
  });

  // FT-11 (AC-8 idempotent): second call finds charged row → skip sign
  it('FT-11: returns already-charged on existing charged row', async () => {
    process.env.WASIAI_PROTOCOL_FEE_WALLET =
      '0x1111111111111111111111111111111111111111';

    stubSelect({
      data: { status: 'charged', tx_hash: '0xEXISTING' },
    });

    const result = await chargeProtocolFee({
      orchestrationId: 'id-11',
      budgetUsdc: 1.0,
      feeRate: 0.01,
    });

    expect(result.status).toBe('already-charged');
    if (result.status === 'already-charged') {
      expect(result.txHash).toBe('0xEXISTING');
    }
    expect(mockSign).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
  });

  // FT-12 (AC-8 race): INSERT conflict → already-charged inProgress
  it('FT-12: handles insert conflict as already-charged (race)', async () => {
    process.env.WASIAI_PROTOCOL_FEE_WALLET =
      '0x1111111111111111111111111111111111111111';

    stubSelect({ data: null });
    // Postgres unique_violation 23505 al insertar pending
    stubInsert({ error: { code: '23505', message: 'dup' } });

    const result = await chargeProtocolFee({
      orchestrationId: 'id-12',
      budgetUsdc: 1.0,
      feeRate: 0.01,
    });

    expect(result.status).toBe('already-charged');
    if (result.status === 'already-charged') {
      expect(result.inProgress).toBe(true);
    }
    expect(mockSign).not.toHaveBeenCalled();
  });

  // FT-13 (AC-6): settle returns success:false → row failed
  it('FT-13: marks failed when settle returns success:false', async () => {
    process.env.WASIAI_PROTOCOL_FEE_WALLET =
      '0x1111111111111111111111111111111111111111';

    stubSelect({ data: null });
    stubInsert({});
    stubUpdate({});

    mockSign.mockResolvedValueOnce({
      xPaymentHeader: 'base64-header',
      paymentRequest: {
        authorization: { value: '10000000000000000' },
        signature: '0xsig',
        network: 'kite',
      },
    });
    mockSettle.mockResolvedValueOnce({
      txHash: '',
      success: false,
      error: 'network down',
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await chargeProtocolFee({
      orchestrationId: 'id-13',
      budgetUsdc: 1.0,
      feeRate: 0.01,
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('network down');
    }
    expect(errSpy).toHaveBeenCalled();
  });

  // FT-14 (AC-6): sign throws → failed
  it('FT-14: marks failed when sign throws', async () => {
    process.env.WASIAI_PROTOCOL_FEE_WALLET =
      '0x1111111111111111111111111111111111111111';

    stubSelect({ data: null });
    stubInsert({});
    stubUpdate({});

    mockSign.mockRejectedValueOnce(new Error('sig failure'));

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await chargeProtocolFee({
      orchestrationId: 'id-14',
      budgetUsdc: 1.0,
      feeRate: 0.01,
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('sig failure');
    }
    expect(errSpy).toHaveBeenCalled();
  });

  // FT-15 (CD-B): never rejects even on DB error
  it('FT-15: never rejects even if DB throws on select', async () => {
    process.env.WASIAI_PROTOCOL_FEE_WALLET =
      '0x1111111111111111111111111111111111111111';

    // El primer .from() lanza sincrónicamente
    mockFrom.mockImplementationOnce(() => {
      throw new Error('connection refused');
    });

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      chargeProtocolFee({
        orchestrationId: 'id-15',
        budgetUsdc: 1.0,
        feeRate: 0.01,
      }),
    ).resolves.toMatchObject({ status: 'failed' });
    expect(errSpy).toHaveBeenCalled();
  });

  // FT-16 (DT-8): feeUsdc=0.01 → feeWei="10000000000000000" (1e16, 18 decimals)
  it('FT-16: converts feeUsdc=0.01 to feeWei="10000000000000000"', async () => {
    process.env.WASIAI_PROTOCOL_FEE_WALLET =
      '0x1111111111111111111111111111111111111111';

    stubSelect({ data: null });
    stubInsert({});
    stubUpdate({});

    mockSign.mockResolvedValueOnce({
      xPaymentHeader: 'base64-header',
      paymentRequest: {
        authorization: { value: '10000000000000000' },
        signature: '0xsig',
        network: 'kite',
      },
    });
    mockSettle.mockResolvedValueOnce({
      txHash: '0xTX',
      success: true,
    });

    await chargeProtocolFee({
      orchestrationId: 'id-16',
      budgetUsdc: 1.0,
      feeRate: 0.01,
    });

    expect(mockSign).toHaveBeenCalledTimes(1);
    const signArg = mockSign.mock.calls[0]?.[0] as {
      to: string;
      value: string;
    };
    expect(signArg.value).toBe('10000000000000000');
    expect(signArg.to).toBe('0x1111111111111111111111111111111111111111');
  });

  // Bonus: safety guard feeUsdc > budget throws ProtocolFeeError
  it('FT-16b: throws ProtocolFeeError when feeUsdc > budget', async () => {
    process.env.WASIAI_PROTOCOL_FEE_WALLET =
      '0x1111111111111111111111111111111111111111';

    await expect(
      chargeProtocolFee({
        orchestrationId: 'id-guard',
        budgetUsdc: 1.0,
        feeRate: 1.5, // fee > budget
      }),
    ).rejects.toBeInstanceOf(ProtocolFeeError);
  });
});
