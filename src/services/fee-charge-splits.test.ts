/**
 * Tests for the fee-split SEAM on chargeProtocolFee — WKH-143 (money-path)
 *
 * Verifica que la firma ampliada (`creator`/`referral`) transporta el contexto
 * hasta `resolveRecipients`, que MNR-3 cierra los 3 returns tempranos y que el
 * default 10000/0/0 sigue byte-idéntico. Reusa el mock supabase multi-`.eq`
 * (queues por operación) de `fee-split.test.ts:44-103`.
 *
 *   T-CREATOR-CHARGE  AC-2/AC-3 — creator wallet válida + CREATOR>0 → leg creator.
 *   T-REF-WIRE        DT-1/DT-6 — referral wallet válida + REFERRAL>0 → leg referral.
 *   T-FALLBACK-SG6    AC-4      — creator null + CREATOR>0 → fila skipped, no aborta.
 *   T-MNR3-CHARGED    AC-6      — leg falla + existing charged → failed.
 *   T-MNR3-PENDING    AC-6      — leg falla + existing pending → failed.
 *   T-MNR3-23505      AC-6      — leg falla + insert 23505 → failed.
 *   T-BYTEID          AC-5/CD-1 — default 10000/0/0 → 1 leg plataforma, cero splits.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Structured logger mock ─────────────────────────────────
const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({ getLogger: () => logSpy }));

// ─── Payment adapter + settle-verifier mocks ────────────────
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
  inserts: [] as Array<Record<string, unknown>>,
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
          insert: (row: Record<string, unknown>) => {
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
import { chargeProtocolFee, type FeeChargeParams } from './fee-charge.js';

// ─── Fixtures ───────────────────────────────────────────────
const PLATFORM_WALLET = '0x1111111111111111111111111111111111111111';
const CREATOR_WALLET = '0x2222222222222222222222222222222222222222';
const REFERRAL_WALLET = '0x3333333333333333333333333333333333333333';

const SPLIT_KEYS = [
  'SPLIT_BPS_PLATFORM',
  'SPLIT_BPS_CREATOR',
  'SPLIT_BPS_REFERRAL',
  'WASIAI_PROTOCOL_FEE_WALLET',
] as const;
const original: Record<string, string | undefined> = {};

function primeHappyLeg() {
  mockSign.mockResolvedValue({
    paymentRequest: {
      authorization: { value: '0' },
      signature: '0xsig',
      network: 'kite',
    },
  });
  mockSettle.mockResolvedValue({ txHash: '0xTX', success: true });
  mockVerifySettle.mockResolvedValue({ ok: true });
}

function resetState() {
  mockState.selectQ = [];
  mockState.selectListQ = [];
  mockState.insertQ = [];
  mockState.updateQ = [];
  mockState.inserts = [];
  mockState.updates = [];
  mockState.froms = [];
}

beforeEach(() => {
  for (const k of SPLIT_KEYS) {
    original[k] = process.env[k];
    delete process.env[k];
  }
  process.env.WASIAI_PROTOCOL_FEE_WALLET = PLATFORM_WALLET;
  resetState();
  vi.clearAllMocks();
  primeHappyLeg();
});

afterEach(() => {
  for (const k of SPLIT_KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

function setSplit(platform: string, creator: string, referral: string) {
  process.env.SPLIT_BPS_PLATFORM = platform;
  process.env.SPLIT_BPS_CREATOR = creator;
  process.env.SPLIT_BPS_REFERRAL = referral;
}

const BASE: FeeChargeParams = {
  orchestrationId: 'orch-1',
  feeBaseUsdc: 1,
  feeRate: 0.01,
};

describe('chargeProtocolFee — creator/referral seam (WKH-143)', () => {
  // T-CREATOR-CHARGE (AC-2/AC-3)
  it('T-CREATOR-CHARGE: transports a valid creator → creator leg written, feeUsdc unchanged', async () => {
    setSplit('8000', '2000', '0');
    // creator leg: select(null) → insert(ok) → sign/settle/verify → update(ok)
    // platform:    select(null) → insert(ok) → sign/settle/verify → update(ok)
    mockState.selectQ = [
      { data: null, error: null },
      { data: null, error: null },
    ];
    mockState.insertQ = [{ error: null }, { error: null }];
    mockState.updateQ = [{ error: null }, { error: null }];

    const result = await chargeProtocolFee({
      ...BASE,
      creator: { wallet: CREATOR_WALLET, ownerRef: 'creator-owner' },
    });

    expect(result.status).toBe('charged');
    // feeUsdc == feeBase * rate — los splits SUBDIVIDEN, no cambian el total.
    expect(result.feeUsdc).toBe(0.01);
    const creatorInsert = mockState.inserts.find(
      (r) => r.recipient_role === 'creator',
    );
    expect(creatorInsert).toBeDefined();
    expect(creatorInsert?.recipient_wallet).toBe(CREATOR_WALLET);
    expect(creatorInsert?.owner_ref).toBe('creator-owner');
  });

  // T-REF-WIRE (DT-1/DT-6) — proves the signature carries `referral` to resolveRecipients
  it('T-REF-WIRE: transports a valid referral → referral leg written', async () => {
    setSplit('8000', '0', '2000');
    mockState.selectQ = [
      { data: null, error: null },
      { data: null, error: null },
    ];
    mockState.insertQ = [{ error: null }, { error: null }];
    mockState.updateQ = [{ error: null }, { error: null }];

    const result = await chargeProtocolFee({
      ...BASE,
      referral: { wallet: REFERRAL_WALLET, ownerRef: 'ref-owner' },
    });

    expect(result.status).toBe('charged');
    const referralInsert = mockState.inserts.find(
      (r) => r.recipient_role === 'referral',
    );
    expect(referralInsert).toBeDefined();
    expect(referralInsert?.recipient_wallet).toBe(REFERRAL_WALLET);
  });

  // T-FALLBACK-SG6 (AC-4)
  it('T-FALLBACK-SG6: creator null + CREATOR>0 → skipped row, bps re-routed to platform, charge not aborted', async () => {
    setSplit('8000', '2000', '0');
    // settleFeeSplits: recordSkipped(creator) → insert(ok). No chargeLeg.
    // platform: select(null) → insert(ok) → sign/settle/verify → update(ok)
    mockState.selectQ = [{ data: null, error: null }];
    mockState.insertQ = [{ error: null }, { error: null }];
    mockState.updateQ = [{ error: null }];

    const result = await chargeProtocolFee({ ...BASE, creator: null });

    expect(result.status).toBe('charged');
    const skippedRow = mockState.inserts.find(
      (r) => r.recipient_role === 'creator',
    );
    expect(skippedRow?.status).toBe('skipped');
    // platform leg absorbe el bps del creador → cobra el feeUsdc completo.
    const platformLeg = result.splits?.find((s) => s.role === 'platform');
    expect(platformLeg?.amountUsdc).toBe(0.01);
  });

  // T-MNR3-CHARGED (AC-6)
  it('T-MNR3-CHARGED: creator leg fails + platform already charged → aggregate failed', async () => {
    setSplit('8000', '2000', '0');
    // creator leg fails via on-chain re-verify mismatch.
    mockVerifySettle
      .mockResolvedValueOnce({ ok: false, reason: 'AMOUNT_MISMATCH' }) // creator
      .mockResolvedValue({ ok: true });
    // creator: select(null) → insert(ok) → sign/settle ok → verify FAIL → markLegFailed update
    // platform: select → existing charged (early return, no sign/settle)
    mockState.selectQ = [
      { data: null, error: null },
      { data: { status: 'charged', tx_hash: '0xPLAT' }, error: null },
    ];
    mockState.insertQ = [{ error: null }];
    mockState.updateQ = [{ error: null }]; // markLegFailed(creator)

    const result = await chargeProtocolFee({
      ...BASE,
      creator: { wallet: CREATOR_WALLET, ownerRef: 'creator-owner' },
    });

    expect(result.status).toBe('failed');
  });

  // T-MNR3-PENDING (AC-6)
  it('T-MNR3-PENDING: creator leg fails + platform pending → aggregate failed', async () => {
    setSplit('8000', '2000', '0');
    mockVerifySettle
      .mockResolvedValueOnce({ ok: false, reason: 'AMOUNT_MISMATCH' })
      .mockResolvedValue({ ok: true });
    mockState.selectQ = [
      { data: null, error: null },
      { data: { status: 'pending', tx_hash: null }, error: null },
    ];
    mockState.insertQ = [{ error: null }];
    mockState.updateQ = [{ error: null }];

    const result = await chargeProtocolFee({
      ...BASE,
      creator: { wallet: CREATOR_WALLET, ownerRef: 'creator-owner' },
    });

    expect(result.status).toBe('failed');
  });

  // T-MNR3-23505 (AC-6)
  it('T-MNR3-23505: creator leg fails + platform insert unique_violation → aggregate failed', async () => {
    setSplit('8000', '2000', '0');
    mockVerifySettle
      .mockResolvedValueOnce({ ok: false, reason: 'AMOUNT_MISMATCH' })
      .mockResolvedValue({ ok: true });
    // creator: select(null) → insert(ok) → sign/settle → verify FAIL → markLegFailed update
    // platform: select(null) → insert 23505
    mockState.selectQ = [
      { data: null, error: null },
      { data: null, error: null },
    ];
    mockState.insertQ = [{ error: null }, { error: { code: '23505' } }];
    mockState.updateQ = [{ error: null }];

    const result = await chargeProtocolFee({
      ...BASE,
      creator: { wallet: CREATOR_WALLET, ownerRef: 'creator-owner' },
    });

    expect(result.status).toBe('failed');
  });

  // T-FEE-TOTAL (WKH-167 AC-1/AC-2) — el INSERT a a2a_protocol_fees persiste
  // fee_total_usdc = fee TOTAL (feeUsdc = budget×rate) Y fee_usdc = pata
  // plataforma post-split. Con 8000/2000/0 ambos DIFIEREN (total 0.01 vs
  // plataforma 0.008), así el assert prueba que no son el mismo valor.
  it('T-FEE-TOTAL: persists fee_total_usdc (total) and fee_usdc (platform leg) — both correct', async () => {
    setSplit('8000', '2000', '0');
    mockState.selectQ = [
      { data: null, error: null },
      { data: null, error: null },
    ];
    mockState.insertQ = [{ error: null }, { error: null }];
    mockState.updateQ = [{ error: null }, { error: null }];

    const result = await chargeProtocolFee({
      ...BASE,
      creator: { wallet: CREATOR_WALLET, ownerRef: 'creator-owner' },
    });

    expect(result.status).toBe('charged');
    // El INSERT a a2a_protocol_fees es el leg de plataforma (tiene fee_wallet;
    // los legs de a2a_fee_splits usan recipient_wallet).
    const feesInsert = mockState.inserts.find(
      (r) => r.fee_wallet !== undefined,
    );
    expect(feesInsert).toBeDefined();
    // fee_usdc = pata plataforma post-split (8000 bps de 0.01 = 0.008) — intacto.
    expect(feesInsert?.fee_usdc).toBe(0.008);
    // fee_total_usdc = fee TOTAL (feeUsdc = budget×rate = 0.01) — aditivo WKH-167.
    expect(feesInsert?.fee_total_usdc).toBe(0.01);
    // El total retornado al caller coincide con fee_total_usdc persistido.
    expect(feesInsert?.fee_total_usdc).toBe(result.feeUsdc);
  });

  // T-BYTEID (AC-5/CD-1)
  it('T-BYTEID: default 10000/0/0 → single platform leg, no a2a_fee_splits writes', async () => {
    // No SPLIT_BPS_* env set → default 10000/0/0.
    // platform only: select(null) → insert(ok) → sign/settle/verify → update(ok)
    mockState.selectQ = [{ data: null, error: null }];
    mockState.insertQ = [{ error: null }];
    mockState.updateQ = [{ error: null }];

    const result = await chargeProtocolFee({ ...BASE });

    expect(result.status).toBe('charged');
    expect(result.splits).toHaveLength(1);
    expect(result.splits?.[0]?.role).toBe('platform');
    expect(result.splits?.[0]?.amountUsdc).toBe(0.01);
    // cero writes a a2a_fee_splits (byte-idéntico).
    expect(mockState.froms).not.toContain('a2a_fee_splits');
  });
});
