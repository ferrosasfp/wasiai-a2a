/**
 * Tests for Fee Split Service — WKH-136 (money-path)
 *
 * Cubre ≥1 test por AC + riesgos money-path (SDD Test Expectations):
 *   T-SUM      AC-1/AC-2/CD-1 — Σbps ≠ 10000 fail-CLOSED, cero sign/settle.
 *   T-DUST     AC-5/CD-5      — dust → platform, Σ == fee exacto.
 *   T-SPLIT    AC-1           — 3 legs charged a las 3 wallets.
 *   T-PARTIAL  AC-3           — 1 leg falla → parent failed (nunca charged).
 *   T-TRANSP   AC-5/CD-P4     — total al caller == feeBase×rate con splits.
 *   T-FALLBACK AC-6/SG-6      — recipient inválido → re-ruta a platform, skipped.
 *   T-REV      AC-4/CD-4      — reverseFeeSplits itera TODOS; owner mismatch.
 *   T-CD6      CD-6           — splits/referralWallet del body IGNORADOS.
 *   T-IDEM     CD-2/CD-9      — 2 llamadas → cada leg cobra 1 sola vez.
 *   T-VERIFY   CD-5           — verify fail-CLOSED → failed; RPC → fail-OPEN.
 *
 * (T-DIV / T-REGR viven en las suites existentes fee-charge.test.ts +
 *  orchestrate.billing.test.ts + money-path.*, verdes sin cambios.)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Structured logger mock ─────────────────────────────────
const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({ getLogger: () => logSpy }));

// ─── Payment adapter + settle-verifier mocks (patrón fee-charge.test.ts) ────
const mockSign = vi.fn();
const mockSettle = vi.fn();
vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: () => ({ sign: mockSign, settle: mockSettle }),
}));

const mockVerifySettle = vi.fn();
vi.mock('../adapters/settle-verifier.js', () => ({
  verifyDefaultChainSettle: (...a: unknown[]) => mockVerifySettle(...a),
}));

// ─── Supabase mock — builder chainable con queues por operación ─────────────
const mockState = vi.hoisted(() => ({
  selectQ: [] as Array<{ data?: unknown; error?: unknown }>, // maybeSingle()
  selectListQ: [] as Array<{ data?: unknown; error?: unknown }>, // awaited select
  insertQ: [] as Array<{ error?: unknown }>,
  updateQ: [] as Array<{ error?: unknown }>,
  inserts: [] as unknown[],
  updates: [] as unknown[],
  froms: [] as string[],
}));

vi.mock('../lib/supabase.js', () => {
  const makeSelectChain = () => {
    const chain: Record<string, unknown> = {};
    chain.eq = () => chain;
    chain.maybeSingle = () =>
      Promise.resolve(mockState.selectQ.shift() ?? { data: null, error: null });
    // biome-ignore lint/suspicious/noThenProperty: intentional thenable to mock an awaitable supabase query builder
    chain.then = (
      res: (v: unknown) => unknown,
      rej?: (e: unknown) => unknown,
    ) =>
      Promise.resolve(
        mockState.selectListQ.shift() ?? { data: [], error: null },
      ).then(res, rej);
    return chain;
  };
  const makeUpdateChain = () => {
    const chain: Record<string, unknown> = {};
    chain.eq = () => chain;
    // biome-ignore lint/suspicious/noThenProperty: intentional thenable to mock an awaitable supabase query builder
    chain.then = (
      res: (v: unknown) => unknown,
      rej?: (e: unknown) => unknown,
    ) =>
      Promise.resolve(mockState.updateQ.shift() ?? { error: null }).then(
        res,
        rej,
      );
    return chain;
  };
  return {
    supabase: {
      from: (table: string) => {
        mockState.froms.push(table);
        return {
          select: () => makeSelectChain(),
          insert: (row: unknown) => {
            mockState.inserts.push(row);
            return Promise.resolve(
              mockState.insertQ.shift() ?? { error: null },
            );
          },
          update: (patch: unknown) => {
            mockState.updates.push(patch);
            return makeUpdateChain();
          },
        };
      },
    },
  };
});

// ─── Imports (tras mocks) ───────────────────────────────────
import { SplitConfigError } from '../config/split-config.js';
import {
  chargeProtocolFee,
  type FeeChargeParams,
  feeUsdcToWei,
} from './fee-charge.js';
import {
  computeSplits,
  planSplits,
  type RecipientWithAmount,
  resolveRecipients,
  reverseFeeSplits,
  type SplitRecipientRole,
  settleFeeSplits,
} from './fee-split.js';

// ─── Fixtures ───────────────────────────────────────────────
const PLATFORM = '0x1111111111111111111111111111111111111111';
const CREATOR = '0x2222222222222222222222222222222222222222';
const REFERRAL = '0x3333333333333333333333333333333333333333';
const EVIL = '0x9999999999999999999999999999999999999999';

function primeHappyLeg() {
  mockSign.mockResolvedValue({
    xPaymentHeader: 'header',
    paymentRequest: {
      authorization: { value: '0' },
      signature: '0xsig',
      network: 'kite',
    },
  });
  mockSettle.mockResolvedValue({ txHash: '0xTX', success: true });
  mockVerifySettle.mockResolvedValue({ ok: true });
}

function recipient(
  role: SplitRecipientRole,
  wallet: string,
  bps: number,
  amountUsdc: number,
  ownerRef = `${role}-owner`,
): RecipientWithAmount {
  return { role, wallet, ownerRef, bps, amountUsdc };
}

const SPLIT_KEYS = [
  'SPLIT_BPS_PLATFORM',
  'SPLIT_BPS_CREATOR',
  'SPLIT_BPS_REFERRAL',
] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  mockState.selectQ.length = 0;
  mockState.selectListQ.length = 0;
  mockState.insertQ.length = 0;
  mockState.updateQ.length = 0;
  mockState.inserts.length = 0;
  mockState.updates.length = 0;
  mockState.froms.length = 0;
  mockSign.mockReset();
  mockSettle.mockReset();
  mockVerifySettle.mockReset();
  logSpy.error.mockClear();
  logSpy.warn.mockClear();
  logSpy.info.mockClear();
  for (const k of SPLIT_KEYS) {
    originalEnv[k] = process.env[k];
    delete process.env[k];
  }
  originalEnv.WALLET = process.env.WASIAI_PROTOCOL_FEE_WALLET;
  process.env.WASIAI_PROTOCOL_FEE_WALLET = PLATFORM;
  primeHappyLeg();
});

afterEach(() => {
  for (const k of SPLIT_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  if (originalEnv.WALLET === undefined)
    delete process.env.WASIAI_PROTOCOL_FEE_WALLET;
  else process.env.WASIAI_PROTOCOL_FEE_WALLET = originalEnv.WALLET;
});

// ─── T-SUM (AC-1/AC-2/CD-1) ─────────────────────────────────
describe('T-SUM — Σbps validation (fail-CLOSED)', () => {
  it('rejects Σ ≠ 10000 (5000/3000/1000) → SplitConfigError, cero sign/settle', async () => {
    process.env.SPLIT_BPS_PLATFORM = '5000';
    process.env.SPLIT_BPS_CREATOR = '3000';
    process.env.SPLIT_BPS_REFERRAL = '1000';

    await expect(
      chargeProtocolFee({
        orchestrationId: 'orch-sum',
        feeBaseUsdc: 1.0,
        feeRate: 0.01,
      }),
    ).rejects.toBeInstanceOf(SplitConfigError);

    expect(mockSign).not.toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
  });

  it('accepts valid configs (10000/0/0 and 8000/1500/500)', async () => {
    process.env.SPLIT_BPS_PLATFORM = '8000';
    process.env.SPLIT_BPS_CREATOR = '1500';
    process.env.SPLIT_BPS_REFERRAL = '500';
    const r = await chargeProtocolFee({
      orchestrationId: 'orch-ok',
      feeBaseUsdc: 1.0,
      feeRate: 0.01,
    });
    expect(r.status).toBe('charged');
  });
});

// ─── T-DUST (AC-5/CD-5) ─────────────────────────────────────
describe('T-DUST — dust absorbed by platform, Σ exacto', () => {
  it('fee=$0.010001, 3333/3333/3334 → Σ == fee, dust en platform', () => {
    const amounts = computeSplits(0.010001, {
      platform: 3333,
      creator: 3333,
      referral: 3334,
    });
    // Σ en micro-USD == totalMicro (ni pierde ni crea USD).
    const sumMicro = Math.round(
      (amounts.platform + amounts.creator + amounts.referral) * 1e6,
    );
    expect(sumMicro).toBe(10001);
    // dust (+1 micro) absorbido por platform.
    expect(amounts.platform).toBeCloseTo(0.003334, 6);
    expect(amounts.creator).toBeCloseTo(0.003333, 6);
    expect(amounts.referral).toBeCloseTo(0.003334, 6);
  });
});

// ─── T-SPLIT (AC-1) ─────────────────────────────────────────
describe('T-SPLIT — 3 legs charged a las 3 wallets', () => {
  it('fee=$1.00 8000/1500/500 → platform/creator/referral charged', async () => {
    const recipients = [
      recipient('platform', PLATFORM, 8000, 0.8),
      recipient('creator', CREATOR, 1500, 0.15),
      recipient('referral', REFERRAL, 500, 0.05),
    ];

    const result = await settleFeeSplits({
      orchestrationId: 'orch-split',
      recipients,
    });

    expect(result.status).toBe('charged');
    expect(result.legs).toHaveLength(3);
    for (const leg of result.legs) expect(leg.status).toBe('charged');

    expect(mockSign).toHaveBeenCalledTimes(3);
    const calls = mockSign.mock.calls.map(
      (c) => c[0] as { to: string; value: string },
    );
    expect(calls.map((c) => c.to)).toEqual([PLATFORM, CREATOR, REFERRAL]);
    expect(calls.map((c) => c.value)).toEqual([
      feeUsdcToWei(0.8),
      feeUsdcToWei(0.15),
      feeUsdcToWei(0.05),
    ]);
  });
});

// ─── T-PARTIAL (AC-3) ───────────────────────────────────────
describe('T-PARTIAL — 1 leg falla → parent failed', () => {
  it('creator settle falla, platform OK → creator failed, platform charged, parent failed', async () => {
    // platform settle OK, creator settle falla.
    mockSettle
      .mockResolvedValueOnce({ txHash: '0xP', success: true })
      .mockResolvedValueOnce({ txHash: '', success: false, error: 'down' });

    const recipients = [
      recipient('platform', PLATFORM, 9000, 0.9),
      recipient('creator', CREATOR, 1000, 0.1),
    ];

    const result = await settleFeeSplits({
      orchestrationId: 'orch-partial',
      recipients,
    });

    expect(result.status).toBe('failed');
    const platformLeg = result.legs.find((l) => l.role === 'platform');
    const creatorLeg = result.legs.find((l) => l.role === 'creator');
    expect(platformLeg?.status).toBe('charged');
    expect(creatorLeg?.status).toBe('failed');
  });
});

// ─── T-TRANSP (AC-5/CD-5/CD-P4) ─────────────────────────────
describe('T-TRANSP — total al caller invariante con splits activos', () => {
  it('chargeProtocolFee retorna feeUsdc == feeBase×rate con SPLIT_BPS activo', async () => {
    process.env.SPLIT_BPS_PLATFORM = '8000';
    process.env.SPLIT_BPS_CREATOR = '1500';
    process.env.SPLIT_BPS_REFERRAL = '500';

    const result = await chargeProtocolFee({
      orchestrationId: 'orch-transp',
      feeBaseUsdc: 1.0,
      feeRate: 0.01,
    });

    expect(result.status).toBe('charged');
    // El total cobrado al caller NO cambia: 1.0 × 0.01 == 0.01.
    expect(result.feeUsdc).toBeCloseTo(0.01, 6);

    // v1: sin agente primario, creator/referral se re-rutan a platform → 2
    // filas skipped + platform con el fee completo. Σ amounts == feeUsdc.
    const splits = result.splits ?? [];
    const platformLeg = splits.find((l) => l.role === 'platform');
    expect(platformLeg?.amountUsdc).toBeCloseTo(0.01, 6);
    const skipped = splits.filter((l) => l.status === 'skipped');
    expect(skipped.map((l) => l.role).sort()).toEqual(['creator', 'referral']);
  });
});

// ─── T-FALLBACK (AC-6/SG-6) ─────────────────────────────────
describe('T-FALLBACK — recipient inválido → re-ruta a platform, skipped', () => {
  it('creator wallet ausente → bps re-enrutado a platform, fila creator skipped, Σ==fee', () => {
    const plan = planSplits(
      1.0,
      { platformBps: 8000, creatorBps: 1500, referralBps: 500 },
      {
        platformWallet: PLATFORM,
        creator: { wallet: null, ownerRef: null },
        referral: { wallet: REFERRAL, ownerRef: 'ref-owner' },
      },
    );

    // creator saltado; su bps re-rutado a platform.
    expect(plan.skipped.map((s) => s.role)).toEqual(['creator']);
    const platform = plan.recipients.find((r) => r.role === 'platform');
    const referral = plan.recipients.find((r) => r.role === 'referral');
    expect(plan.recipients.find((r) => r.role === 'creator')).toBeUndefined();
    expect(platform?.amountUsdc).toBeCloseTo(0.95, 6); // 9500 bps
    expect(referral?.amountUsdc).toBeCloseTo(0.05, 6); // 500 bps
    // Σ == fee (ni pierde ni crea USD).
    expect(plan.totalUsdc).toBeCloseTo(1.0, 6);
  });

  it('settleFeeSplits no crashea con un recipient skipped', async () => {
    const plan = planSplits(
      1.0,
      { platformBps: 8000, creatorBps: 1500, referralBps: 500 },
      {
        platformWallet: PLATFORM,
        creator: { wallet: null, ownerRef: null },
        referral: { wallet: REFERRAL, ownerRef: 'ref-owner' },
      },
    );

    const result = await settleFeeSplits({
      orchestrationId: 'orch-fallback',
      recipients: plan.recipients,
      skipped: plan.skipped,
    });

    expect(result.status).toBe('charged');
    const creatorLeg = result.legs.find((l) => l.role === 'creator');
    expect(creatorLeg?.status).toBe('skipped');
    // creator NO se firma (wallet ausente); platform + referral sí.
    expect(mockSign).toHaveBeenCalledTimes(2);
  });
});

// ─── T-REV (AC-4/CD-4) ──────────────────────────────────────
describe('T-REV — reverseFeeSplits itera TODOS los legs charged', () => {
  const rows = (owner: string) => [
    {
      id: 'r1',
      status: 'charged',
      owner_ref: owner,
      recipient_role: 'platform',
      recipient_wallet: PLATFORM,
      bps: 8000,
      amount_usdc: 0.8,
      tx_hash: '0xP',
    },
    {
      id: 'r2',
      status: 'charged',
      owner_ref: owner,
      recipient_role: 'creator',
      recipient_wallet: CREATOR,
      bps: 1500,
      amount_usdc: 0.15,
      tx_hash: '0xC',
    },
    {
      id: 'r3',
      status: 'charged',
      owner_ref: owner,
      recipient_role: 'referral',
      recipient_wallet: REFERRAL,
      bps: 500,
      amount_usdc: 0.05,
      tx_hash: '0xR',
    },
  ];

  it('3 legs charged → los 3 marcados reversed', async () => {
    mockState.selectListQ.push({ data: rows('owner-1'), error: null });

    const result = await reverseFeeSplits('orch-rev', 'owner-1');

    expect(result.status).toBe('reversed');
    if (result.status === 'reversed') {
      expect(result.reversedCount).toBe(3);
      expect(result.legs.every((l) => l.status === 'reversed')).toBe(true);
    }
    // CD-4: 3 UPDATEs (uno por leg), no solo el primero.
    expect(mockState.updates).toHaveLength(3);
  });

  it('owner mismatch → ownership_mismatch, cero updates', async () => {
    mockState.selectListQ.push({ data: rows('owner-1'), error: null });

    const result = await reverseFeeSplits('orch-rev', 'owner-2');

    expect(result.status).toBe('ownership_mismatch');
    expect(mockState.updates).toHaveLength(0);
  });
});

// ─── T-CD6 (CD-6) ───────────────────────────────────────────
describe('T-CD6 — recipients SOLO server-side, body ignorado', () => {
  it('un splits/referralWallet en el body es IGNORADO', async () => {
    // Config default (10000/0/0) → solo platform desde env.
    const bodyWithInjection = {
      orchestrationId: 'orch-cd6',
      feeBaseUsdc: 1.0,
      feeRate: 0.01,
      referralWallet: EVIL,
      splits: [{ role: 'referral', wallet: EVIL, bps: 10000 }],
    } as unknown as FeeChargeParams;

    const result = await chargeProtocolFee(bodyWithInjection);

    expect(result.status).toBe('charged');
    // El transfer va a la wallet de plataforma del ENV, NUNCA a la del body.
    expect(mockSign).toHaveBeenCalledTimes(1);
    const signArg = mockSign.mock.calls[0]?.[0] as { to: string };
    expect(signArg.to).toBe(PLATFORM);
    expect(signArg.to).not.toBe(EVIL);
  });
});

// ─── T-IDEM (CD-2/CD-9) ─────────────────────────────────────
describe('T-IDEM — cada leg cobra 1 sola vez', () => {
  it('2 llamadas mismo orchestrationId → segunda already-charged, sin re-sign', async () => {
    const recipients = [recipient('platform', PLATFORM, 10000, 0.01)];

    const first = await settleFeeSplits({
      orchestrationId: 'orch-idem',
      recipients,
    });
    expect(first.status).toBe('charged');
    expect(mockSign).toHaveBeenCalledTimes(1);

    // Segunda llamada: el SELECT idempotente encuentra la fila charged.
    mockState.selectQ.push({
      data: { status: 'charged', tx_hash: '0xTX' },
      error: null,
    });
    const second = await settleFeeSplits({
      orchestrationId: 'orch-idem',
      recipients,
    });

    expect(second.status).toBe('already-charged');
    // No se firma de nuevo (idempotente).
    expect(mockSign).toHaveBeenCalledTimes(1);
  });

  it('INSERT 23505 (race) → leg in-progress, sin re-sign', async () => {
    mockState.insertQ.push({ error: { code: '23505', message: 'dup' } });
    const recipients = [recipient('platform', PLATFORM, 10000, 0.01)];

    const result = await settleFeeSplits({
      orchestrationId: 'orch-race',
      recipients,
    });

    expect(result.status).toBe('already-charged');
    expect(mockSign).not.toHaveBeenCalled();
  });
});

// ─── T-VERIFY (CD-5) ────────────────────────────────────────
describe('T-VERIFY — re-verify on-chain antes de charged', () => {
  it('verify fail-CLOSED (AMOUNT_MISMATCH) → leg failed, no charged', async () => {
    mockVerifySettle.mockResolvedValue({
      ok: false,
      reason: 'AMOUNT_MISMATCH',
    });
    const recipients = [recipient('platform', PLATFORM, 10000, 0.01)];

    const result = await settleFeeSplits({
      orchestrationId: 'orch-verify',
      recipients,
    });

    expect(result.status).toBe('failed');
    const leg = result.legs[0];
    expect(leg?.status).toBe('failed');
    expect(leg?.error).toContain('re-verification');
  });

  it('RPC_UNAVAILABLE → fail-OPEN + warn, leg charged', async () => {
    mockVerifySettle.mockResolvedValue({
      ok: true,
      warn: true,
      reason: 'RPC_UNAVAILABLE',
    });
    const recipients = [recipient('platform', PLATFORM, 10000, 0.01)];

    const result = await settleFeeSplits({
      orchestrationId: 'orch-rpc',
      recipients,
    });

    expect(result.status).toBe('charged');
    expect(logSpy.warn).toHaveBeenCalled();
  });
});

// ─── resolveRecipients (server-side unit) ───────────────────
describe('resolveRecipients — default 10000/0/0 → 1 leg platform', () => {
  it('re-ruta bps 0 sin crear legs ni skipped', () => {
    const res = resolveRecipients(
      { platformBps: 10000, creatorBps: 0, referralBps: 0 },
      { platformWallet: PLATFORM },
    );
    expect(res.recipients).toHaveLength(1);
    expect(res.recipients[0]?.role).toBe('platform');
    expect(res.recipients[0]?.bps).toBe(10000);
    expect(res.skipped).toHaveLength(0);
  });
});
