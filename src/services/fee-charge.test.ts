/**
 * Tests for Fee Charge Service — WKH-44
 *
 * Wave 1: FT-1..FT-8 — `getProtocolFeeRate` env parsing + safety guard.
 * Wave 2: FT-9..FT-16 — `chargeProtocolFee` helper (idempotency + sign/settle).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Structured logger mock ─────────────────────────────────
// fee-charge.ts logs server-side via getLogger('fee-charge'). Mock it so tests
// assert log emission via logSpy (object-first / message-second) instead of
// spying on console. hoisted so the factory can reference it.
const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({
  getLogger: () => logSpy,
}));

// ─── Mocks ──────────────────────────────────────────────────
// Mock del payment adapter (patrón verificado en src/services/compose.test.ts:15-17)
const mockSign = vi.fn();
const mockSettle = vi.fn();
// WKH-195: supportedTokens seteable por test para variar los decimals del default
// chain (patrón WKH-192 payment-intent.test.ts:29-44). Default 18d modela el
// default chain Kite de HOY → la suite preexistente queda byte-idéntica (CD-4).
const mockSupportedTokens = vi.hoisted(() => ({
  current: [{ symbol: 'PYUSD', address: '0x0', decimals: 18 }] as
    | { symbol: string; address: string; decimals: number }[]
    | undefined,
}));
vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: (..._a: unknown[]) => ({
    sign: mockSign,
    settle: mockSettle,
    supportedTokens: mockSupportedTokens.current,
  }),
}));

// TB-01 (audit 2026-06-30): chargeProtocolFee now re-verifies the settle
// on-chain before marking it charged. Mock it to a pass so the existing
// happy-path tests stay focused on the fee bookkeeping; `mockVerifySettle`
// lets a test force a mismatch (re-verification covered in settle-verifier.test).
const mockVerifySettle = vi.fn().mockResolvedValue({ ok: true });
vi.mock('../adapters/settle-verifier.js', () => ({
  verifyDefaultChainSettle: (...a: unknown[]) => mockVerifySettle(...a),
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
  feeUsdcToWei,
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
    logSpy.error.mockClear();
    logSpy.warn.mockClear();
    logSpy.info.mockClear();
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
    expect(getProtocolFeeRate()).toBe(0.01);
    expect(logSpy.error).not.toHaveBeenCalled();
  });

  // FT-2 (AC-9): valid value parses cleanly
  it('FT-2: parses valid "0.05" → 0.05', () => {
    process.env.PROTOCOL_FEE_RATE = '0.05';
    expect(getProtocolFeeRate()).toBe(0.05);
  });

  // FT-3 (AC-9, CD-E): NaN input → fallback + log.error
  it('FT-3: falls back to 0.01 + log.error on NaN input ("abc")', () => {
    process.env.PROTOCOL_FEE_RATE = 'abc';
    expect(getProtocolFeeRate()).toBe(0.01);
    expect(logSpy.error).toHaveBeenCalledTimes(1);
    expect(logSpy.error.mock.calls[0]?.[1]).toContain(
      'Invalid PROTOCOL_FEE_RATE',
    );
  });

  // FT-4 (AC-9): negative value → fallback + log.error
  it('FT-4: falls back to 0.01 + log.error on negative ("-0.01")', () => {
    process.env.PROTOCOL_FEE_RATE = '-0.01';
    expect(getProtocolFeeRate()).toBe(0.01);
    expect(logSpy.error).toHaveBeenCalledTimes(1);
  });

  // FT-5 (AC-9): > 0.10 → fallback + log.error
  it('FT-5: falls back to 0.01 + log.error on > 0.10 ("0.5")', () => {
    process.env.PROTOCOL_FEE_RATE = '0.5';
    expect(getProtocolFeeRate()).toBe(0.01);
    expect(logSpy.error).toHaveBeenCalledTimes(1);
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
    expect(getProtocolFeeRate()).toBe(0.1);
    expect(logSpy.error).not.toHaveBeenCalled();
  });

  // FT-8 (AC-9 boundary): 0.0 exacto → aceptado
  it('FT-8: accepts lower boundary 0.0', () => {
    process.env.PROTOCOL_FEE_RATE = '0.0';
    expect(getProtocolFeeRate()).toBe(0.0);
    expect(logSpy.error).not.toHaveBeenCalled();
  });

  // Bonus (defensive): Infinity → fallback
  it('FT-8b (defensive): rejects Infinity → fallback 0.01', () => {
    process.env.PROTOCOL_FEE_RATE = 'Infinity';
    expect(getProtocolFeeRate()).toBe(0.01);
    expect(logSpy.error).toHaveBeenCalledTimes(1);
  });

  // Bonus (defensive): empty string → default (no error)
  it('FT-8c (defensive): empty string → default 0.01 without error', () => {
    process.env.PROTOCOL_FEE_RATE = '';
    expect(getProtocolFeeRate()).toBe(0.01);
    expect(logSpy.error).not.toHaveBeenCalled();
  });
});

// ─── chargeProtocolFee (FT-9..FT-16 — implementado en W2) ───

describe('chargeProtocolFee', () => {
  const originalWallet = process.env.WASIAI_PROTOCOL_FEE_WALLET;

  beforeEach(() => {
    vi.restoreAllMocks();
    logSpy.error.mockClear();
    logSpy.warn.mockClear();
    logSpy.info.mockClear();
    mockSign.mockReset();
    mockSettle.mockReset();
    mockFrom.mockReset();
    mockSelect.mockReset();
    mockEq.mockReset();
    mockInsert.mockReset();
    mockUpdate.mockReset();
    mockMaybeSingle.mockReset();
    // TB-01: default settle re-verification = pass.
    mockVerifySettle.mockReset();
    mockVerifySettle.mockResolvedValue({ ok: true });
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
    const result = await chargeProtocolFee({
      orchestrationId: 'id-1',
      feeBaseUsdc: 1.0,
      feeRate: 0.01,
    });

    expect(result.status).toBe('skipped');
    if (result.status === 'skipped') {
      expect(result.reason).toBe('WALLET_UNSET');
      expect(result.feeUsdc).toBeCloseTo(0.01, 6);
    }
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockSign).not.toHaveBeenCalled();
    expect(logSpy.warn).toHaveBeenCalledTimes(1);
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
      feeBaseUsdc: 1.0,
      feeRate: 0.01,
    });

    expect(result.status).toBe('charged');
    if (result.status === 'charged') {
      expect(result.txHash).toBe('0xABC');
      expect(result.feeUsdc).toBeCloseTo(0.01, 6);
    }
    expect(mockSign).toHaveBeenCalledTimes(1);
    expect(mockSettle).toHaveBeenCalledTimes(1);
    // WKH-167: default 10000/0/0 → pata plataforma == total. Ambos campos se
    // persisten y coinciden con feeUsdc (= budget×rate).
    const insertPayload = mockInsert.mock.calls[0]?.[0] as {
      fee_usdc: number;
      fee_total_usdc: number;
    };
    expect(insertPayload.fee_usdc).toBeCloseTo(0.01, 6);
    expect(insertPayload.fee_total_usdc).toBeCloseTo(0.01, 6);
  });

  // TB-01 (audit 2026-06-30): a settle reported success but failing on-chain
  // re-verification must be treated as failed (row NOT marked charged).
  it('TB-01: settle re-verification failure → status failed (not charged)', async () => {
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
    mockSettle.mockResolvedValueOnce({ txHash: '0xFAKE', success: true });
    // Forge: facilitator says success, on-chain re-read says mismatch.
    mockVerifySettle.mockResolvedValueOnce({
      ok: false,
      reason: 'AMOUNT_MISMATCH',
    });

    const result = await chargeProtocolFee({
      orchestrationId: 'id-tb01',
      feeBaseUsdc: 1.0,
      feeRate: 0.01,
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('re-verification');
    }
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
      feeBaseUsdc: 1.0,
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
      feeBaseUsdc: 1.0,
      feeRate: 0.01,
    });

    expect(result.status).toBe('already-charged');
    if (result.status === 'already-charged') {
      expect(result.inProgress).toBe(true);
    }
    expect(mockSign).not.toHaveBeenCalled();
  });

  // FT-12b: CHEQUEO MECÁNICO del comentario del paso 3 de `chargeProtocolFee`.
  // El comentario afirma que una fila `failed` NO se reintenta. Si alguien
  // habilita el reintento (upsert, DELETE previo, `.upsert(onConflict)`, etc.)
  // este test se pone rojo y obliga a releer la advertencia de doble pago que
  // vive junto a ese comentario (HU-201 / merge 700341a: una fila `failed`
  // puede llevar el hash de un broadcast que SÍ ocurrió).
  it('FT-12b: existing failed row does NOT retry the charge (comment guard)', async () => {
    process.env.WASIAI_PROTOCOL_FEE_WALLET =
      '0x1111111111111111111111111111111111111111';

    // La fila `failed` existe y lleva evidencia de broadcast (HU-201).
    stubSelect({ data: { status: 'failed', tx_hash: '0xBROADCASTED' } });
    // El insert choca con la PK `orchestration_id` — es lo que hace Postgres
    // cuando la fila leída arriba ya ocupa la clave.
    stubInsert({ error: { code: '23505', message: 'duplicate key' } });

    const result = await chargeProtocolFee({
      orchestrationId: 'id-12b',
      feeBaseUsdc: 1.0,
      feeRate: 0.01,
    });

    expect(result.status).toBe('already-charged');
    if (result.status === 'already-charged') {
      expect(result.inProgress).toBe(true);
    }
    // Lo que realmente importa: no se vuelve a mover plata.
    expect(mockSign).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
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

    const result = await chargeProtocolFee({
      orchestrationId: 'id-13',
      feeBaseUsdc: 1.0,
      feeRate: 0.01,
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('network down');
    }
    expect(logSpy.error).toHaveBeenCalled();
  });

  // FT-14 (AC-6): sign throws → failed
  it('FT-14: marks failed when sign throws', async () => {
    process.env.WASIAI_PROTOCOL_FEE_WALLET =
      '0x1111111111111111111111111111111111111111';

    stubSelect({ data: null });
    stubInsert({});
    stubUpdate({});

    mockSign.mockRejectedValueOnce(new Error('sig failure'));

    const result = await chargeProtocolFee({
      orchestrationId: 'id-14',
      feeBaseUsdc: 1.0,
      feeRate: 0.01,
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('sig failure');
    }
    expect(logSpy.error).toHaveBeenCalled();
  });

  // NIT-2 (AC-3 wiring): sign() throwing a viem "insufficient funds for gas"
  // is relabeled `operator-funding-low` (message + structured log reason) yet
  // the control flow is unchanged — still {status:'failed'}, never rejects
  // (CD-5).
  it('NIT-2: sign() insufficient-funds → relabeled operator-funding-low, still failed', async () => {
    process.env.WASIAI_PROTOCOL_FEE_WALLET =
      '0x1111111111111111111111111111111111111111';
    stubSelect({ data: null });
    stubInsert({});
    stubUpdate({});
    mockSign.mockRejectedValueOnce(
      new Error('insufficient funds for gas * price + value'),
    );

    const result = await chargeProtocolFee({
      orchestrationId: 'id-nit2-sign',
      feeBaseUsdc: 1.0,
      feeRate: 0.01,
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('operator funding low');
    }
    // CD-5: reason surfaced in the log, but no new control-flow branch.
    expect(
      logSpy.error.mock.calls.some(
        (c) => (c[0] as { reason?: string })?.reason === 'operator-funding-low',
      ),
    ).toBe(true);
  });

  // NIT-2 (AC-3 wiring): settle() throwing insufficient-funds → same relabel,
  // still failed, never rejects.
  it('NIT-2: settle() insufficient-funds → relabeled operator-funding-low, still failed', async () => {
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
    mockSettle.mockRejectedValueOnce(
      new Error('insufficient funds for gas * price + value'),
    );

    const result = await chargeProtocolFee({
      orchestrationId: 'id-nit2-settle',
      feeBaseUsdc: 1.0,
      feeRate: 0.01,
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('operator funding low');
    }
  });

  // FT-15 (CD-B): never rejects even on DB error
  it('FT-15: never rejects even if DB throws on select', async () => {
    process.env.WASIAI_PROTOCOL_FEE_WALLET =
      '0x1111111111111111111111111111111111111111';

    // El primer .from() lanza sincrónicamente
    mockFrom.mockImplementationOnce(() => {
      throw new Error('connection refused');
    });

    await expect(
      chargeProtocolFee({
        orchestrationId: 'id-15',
        feeBaseUsdc: 1.0,
        feeRate: 0.01,
      }),
    ).resolves.toMatchObject({ status: 'failed' });
    expect(logSpy.error).toHaveBeenCalled();
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
      feeBaseUsdc: 1.0,
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
        feeBaseUsdc: 1.0,
        feeRate: 1.5, // fee > budget
      }),
    ).rejects.toBeInstanceOf(ProtocolFeeError);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WKH-195 — fee-charge decimals-aware (feeUsdcToWei reusa usdToAtomic de
// WKH-192). Seam #1: alimenta el leg de plataforma de chargeProtocolFee y (por
// import de firma) los legs creator/referral de fee-split.settleFeeSplits.
// Legacy = BigInt(round(usd*1e6)) * BigInt(1e12) (asumía 18d hardcodeado).
// ════════════════════════════════════════════════════════════════════════════
describe('WKH-195 fee-charge decimals-aware', () => {
  // Fórmula legacy inline (18d) para la convergencia byte-idéntica (CD-2/CD-5).
  const legacyWei = (usd: number): string =>
    String(BigInt(Math.round(usd * 1_000_000)) * BigInt(1_000_000_000_000));

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
    mockVerifySettle.mockReset();
    mockVerifySettle.mockResolvedValue({ ok: true });
    // Reset al default chain de HOY (Kite/PYUSD 18d) — cada test que necesite
    // otro decimals lo sobreescribe explícitamente.
    mockSupportedTokens.current = [
      { symbol: 'PYUSD', address: '0x0', decimals: 18 },
    ];
  });

  afterEach(() => {
    // Restaurar el default 18d para no filtrar a suites posteriores.
    mockSupportedTokens.current = [
      { symbol: 'PYUSD', address: '0x0', decimals: 18 },
    ];
    if (originalWallet === undefined) {
      delete process.env.WASIAI_PROTOCOL_FEE_WALLET;
    } else {
      process.env.WASIAI_PROTOCOL_FEE_WALLET = originalWallet;
    }
  });

  // T1-A (AC-1, AC-3, CD-2): convergencia byte-idéntica Kite 18d, ≥3 valores
  // incluyendo precisión de 6 decimales.
  it('T1-A: feeUsdcToWei(usd) === legacy en Kite 18d (byte-a-byte, ≥3 valores)', () => {
    mockSupportedTokens.current = [
      { symbol: 'PYUSD', address: '0x0', decimals: 18 },
    ];
    for (const usd of [1.5, 0.333333, 100, 0.000001]) {
      expect(feeUsdcToWei(usd)).toBe(legacyWei(usd));
    }
  });

  // T1-B (AC-1, CD-5): Base 6d divergente — el atómico 6d es 10¹² menor que 18d.
  it('T1-B: feeUsdcToWei en Base 6d es el atómico 6d y DIVERGE del legacy 18d', () => {
    mockSupportedTokens.current = [
      { symbol: 'USDC', address: '0x0', decimals: 6 },
    ];
    expect(feeUsdcToWei(1.5)).toBe('1500000');
    expect(feeUsdcToWei(1.5)).not.toBe(legacyWei(1.5));
    for (const x of [1.5, 0.333333, 100, 0.000001, 42.42]) {
      expect(BigInt(feeUsdcToWei(x)) * 10n ** 12n).toBe(BigInt(legacyWei(x)));
    }
  });

  // T1-C (AC-4, CD-4): fallback undefined/[] → 18d, sin throw.
  it('T1-C: supportedTokens undefined/[] → fallback 18d (legacy) sin throw', () => {
    for (const tokens of [
      undefined,
      [] as { symbol: string; address: string; decimals: number }[],
    ]) {
      mockSupportedTokens.current = tokens;
      for (const usd of [1.5, 100, 0.000001]) {
        expect(() => feeUsdcToWei(usd)).not.toThrow();
        expect(feeUsdcToWei(usd)).toBe(legacyWei(usd));
      }
    }
  });

  // T1-D (AC-1, AC-4): el leg de plataforma de chargeProtocolFee no se rompe;
  // firma el value byte-idéntico al legacy y JAMÁS rechaza la promise.
  it('T1-D: chargeProtocolFee happy path → sign(value)===legacy, status charged', async () => {
    process.env.WASIAI_PROTOCOL_FEE_WALLET =
      '0x1111111111111111111111111111111111111111';
    mockSupportedTokens.current = [
      { symbol: 'PYUSD', address: '0x0', decimals: 18 },
    ];
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
    mockSettle.mockResolvedValueOnce({ txHash: '0xABC', success: true });

    // feeBaseUsdc=1.0 × rate 0.01 = 0.01; default splits 10000/0/0 → plataforma
    // recibe el total 0.01.
    const platformAmount = 0.01;
    const result = await chargeProtocolFee({
      orchestrationId: 'id-195-t1d',
      feeBaseUsdc: 1.0,
      feeRate: 0.01,
    });

    expect(result.status).toBe('charged');
    expect(mockSign).toHaveBeenCalledTimes(1);
    const signArg = mockSign.mock.calls[0]?.[0] as { value: string };
    expect(signArg.value).toBe(feeUsdcToWei(platformAmount));
    expect(signArg.value).toBe(legacyWei(platformAmount));
  });
});
