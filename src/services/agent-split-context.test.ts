/**
 * Tests for Agent Split Context — WKH-143 (money-path seam)
 *
 * Cubre la resolución server-side del creator/referral del agente primario:
 *   T-CTX-REG      AC-2    — registry externo + metadata.payTo / payment.contract.
 *   T-CTX-SELF     AC-3    — self-published + getSplitContextRow → payoutWallet.
 *   T-CTX-MISS     AC-4    — sin payTo / payout_wallet → creator null (→ SG-6).
 *   T-CTX-NOAGENT  AC-7    — agent undefined → {null,null}.
 *   T-CTX-THROW    AC-4/CD-10 — query rechaza → best-effort {null,null} (no propaga).
 *   T-CTX-REF-NULL DT-6    — referral SIEMPRE null en v1.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Structured logger mock ─────────────────────────────────
const logSpy = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock('../lib/logger.js', () => ({ getLogger: () => logSpy }));

// ─── publishedAgentService mock (self-published branch) ─────────────────────
const mockGetSplitContextRow = vi.fn();
vi.mock('./agent.js', () => ({
  publishedAgentService: {
    getSplitContextRow: (...a: unknown[]) => mockGetSplitContextRow(...a),
  },
}));

// ─── Imports (tras mocks) ───────────────────────────────────
import type { Agent } from '../types/index.js';
import { SELF_PUBLISHED_REGISTRY_ID } from '../types/index.js';
import { resolveAgentSplitContext } from './agent-split-context.js';

// ─── Fixtures ───────────────────────────────────────────────
const PAYOUT = '0x2222222222222222222222222222222222222222';
// Referrer payout wallet (WKH-143c), distinto del creator.
const W_REF = '0x3333333333333333333333333333333333333333';

function agent(partial: Partial<Agent>): Agent {
  return { registry_id: 'kite', slug: 'some-agent', ...partial } as Agent;
}

// WKH-143c: aislar `SPLIT_BPS_REFERRAL` para que la suite existente
// (T-CTX-*/T-143B-*) corra con referral OFF (byte-idéntico) y cada test de
// referral setee su propio valor (patrón split-config.test.ts:145-157).
const originalReferralBps = { value: undefined as string | undefined };

beforeEach(() => {
  originalReferralBps.value = process.env.SPLIT_BPS_REFERRAL;
  delete process.env.SPLIT_BPS_REFERRAL;
});

afterEach(() => {
  if (originalReferralBps.value === undefined)
    delete process.env.SPLIT_BPS_REFERRAL;
  else process.env.SPLIT_BPS_REFERRAL = originalReferralBps.value;
  vi.clearAllMocks();
});

describe('resolveAgentSplitContext', () => {
  // T-CTX-NOAGENT (AC-7)
  it('T-CTX-NOAGENT: returns {null,null} for undefined agent', async () => {
    const ctx = await resolveAgentSplitContext(undefined);
    expect(ctx).toEqual({ creator: null, referral: null });
    expect(mockGetSplitContextRow).not.toHaveBeenCalled();
  });

  // T-CTX-REG (AC-2) — canonical metadata.payTo
  it('T-CTX-REG: external registry + metadata.payTo → creator with ownerRef=slug', async () => {
    const ctx = await resolveAgentSplitContext(
      agent({ slug: 'ext-agent', metadata: { payTo: PAYOUT } }),
    );
    expect(ctx.creator).toEqual({ wallet: PAYOUT, ownerRef: 'ext-agent' });
    expect(ctx.referral).toBeNull();
  });

  // T-CTX-REG (AC-2) — fallback metadata.payment.contract
  it('T-CTX-REG: external registry falls back to metadata.payment.contract', async () => {
    const ctx = await resolveAgentSplitContext(
      agent({
        slug: 'ext-agent',
        metadata: { payment: { contract: PAYOUT } },
      }),
    );
    expect(ctx.creator).toEqual({ wallet: PAYOUT, ownerRef: 'ext-agent' });
  });

  // T-CTX-MISS (AC-4) — external registry with no payTo/payment.contract
  it('T-CTX-MISS: external registry without payTo → creator null', async () => {
    const ctx = await resolveAgentSplitContext(
      agent({ slug: 'ext-agent', metadata: {} }),
    );
    expect(ctx.creator).toBeNull();
    expect(ctx.referral).toBeNull();
  });

  // T-CTX-SELF (AC-3) — self-published with payout wallet
  it('T-CTX-SELF: self-published + payoutWallet → creator with ownerRef=row.owner_ref', async () => {
    mockGetSplitContextRow.mockResolvedValue({
      ownerRef: 'owner-123',
      payoutWallet: PAYOUT,
      referrerRef: null,
    });
    const ctx = await resolveAgentSplitContext(
      agent({ registry_id: SELF_PUBLISHED_REGISTRY_ID, slug: 'my-agent' }),
    );
    expect(mockGetSplitContextRow).toHaveBeenCalledWith('my-agent');
    expect(ctx.creator).toEqual({ wallet: PAYOUT, ownerRef: 'owner-123' });
    expect(ctx.referral).toBeNull();
  });

  // T-CTX-MISS (AC-4) — self-published with payout_wallet=null
  it('T-CTX-MISS: self-published with payoutWallet null → creator null', async () => {
    mockGetSplitContextRow.mockResolvedValue({
      ownerRef: 'owner-123',
      payoutWallet: null,
      referrerRef: null,
    });
    const ctx = await resolveAgentSplitContext(
      agent({ registry_id: SELF_PUBLISHED_REGISTRY_ID, slug: 'my-agent' }),
    );
    expect(ctx.creator).toBeNull();
  });

  // T-CTX-MISS (AC-4) — self-published, row not found (null)
  it('T-CTX-MISS: self-published row not found → creator null', async () => {
    mockGetSplitContextRow.mockResolvedValue(null);
    const ctx = await resolveAgentSplitContext(
      agent({ registry_id: SELF_PUBLISHED_REGISTRY_ID, slug: 'missing' }),
    );
    expect(ctx.creator).toBeNull();
  });

  // T-CTX-THROW (AC-4/CD-10) — query rejects → best-effort, does not propagate
  it('T-CTX-THROW: query error → best-effort {null,null} without throwing', async () => {
    mockGetSplitContextRow.mockRejectedValue(new Error('DB down'));
    const ctx = await resolveAgentSplitContext(
      agent({ registry_id: SELF_PUBLISHED_REGISTRY_ID, slug: 'my-agent' }),
    );
    expect(ctx).toEqual({ creator: null, referral: null });
    expect(logSpy.error).toHaveBeenCalled();
  });

  // T-CTX-REF-NULL (DT-6) — referral always null, even if referrer_ref is set
  it('T-CTX-REF-NULL: referral is always null even with referrer_ref set', async () => {
    mockGetSplitContextRow.mockResolvedValue({
      ownerRef: 'owner-123',
      payoutWallet: PAYOUT,
      referrerRef: 'referrer-abc',
    });
    const ctx = await resolveAgentSplitContext(
      agent({ registry_id: SELF_PUBLISHED_REGISTRY_ID, slug: 'my-agent' }),
    );
    expect(ctx.referral).toBeNull();
  });

  // ── WKH-143b — write-path integration over the read-side ────────────

  // T-143B-CREATOR (AC-7) — the payout_wallet the write-path persists resolves
  // to a real, non-null creator leg (creator cobra, sin código nuevo de cobro).
  it('T-143B-CREATOR: write-path payoutWallet → resolveAgentSplitContext builds a non-null creator with that wallet (AC-7)', async () => {
    // Exactly the shape getSplitContextRow returns once the write-path persisted
    // payout_wallet (referrer opaque, inert).
    mockGetSplitContextRow.mockResolvedValue({
      ownerRef: 'owner-xyz',
      payoutWallet: PAYOUT,
      referrerRef: 'ref-opaque',
    });

    const ctx = await resolveAgentSplitContext(
      agent({ registry_id: SELF_PUBLISHED_REGISTRY_ID, slug: 'paid-agent' }),
    );

    expect(mockGetSplitContextRow).toHaveBeenCalledWith('paid-agent');
    expect(ctx.creator).toEqual({ wallet: PAYOUT, ownerRef: 'owner-xyz' });
    // Referral persisted opaque but INERT (WKH-143c) — never resolved here.
    expect(ctx.referral).toBeNull();
  });

  // T-143B-BYTEID (DT-4/CD-6 + CD-8/AC-5) — referral inert + byte-identical default.
  it('T-143B-BYTEID: referrerRef set stays referral:null (inert); payout_wallet null → creator:null (byte-identical default)', async () => {
    // (a) referral inert even with referrer_ref present.
    mockGetSplitContextRow.mockResolvedValueOnce({
      ownerRef: 'owner-xyz',
      payoutWallet: PAYOUT,
      referrerRef: 'ref-abc',
    });
    const withRef = await resolveAgentSplitContext(
      agent({ registry_id: SELF_PUBLISHED_REGISTRY_ID, slug: 'a1' }),
    );
    expect(withRef.referral).toBeNull();

    // (b) default (no write-path): payout_wallet null → no creator → byte-identical.
    mockGetSplitContextRow.mockResolvedValueOnce({
      ownerRef: 'owner-xyz',
      payoutWallet: null,
      referrerRef: null,
    });
    const defaultCtx = await resolveAgentSplitContext(
      agent({ registry_id: SELF_PUBLISHED_REGISTRY_ID, slug: 'a2' }),
    );
    expect(defaultCtx).toEqual({ creator: null, referral: null });
  });

  // ── WKH-143c — referral real (Opción B) ─────────────────────────────

  // T-REF-RESOLVE (AC-6, CD-B1) — referrer resuelve a payout_wallet real ≠ creator.
  it('T-REF-RESOLVE: referrer_ref resolves to a real payout_wallet → referral leg', async () => {
    process.env.SPLIT_BPS_REFERRAL = '500';
    mockGetSplitContextRow
      .mockResolvedValueOnce({
        ownerRef: 'owner-A',
        payoutWallet: PAYOUT,
        referrerRef: 'B',
      })
      .mockResolvedValueOnce({
        ownerRef: 'owner-B',
        payoutWallet: W_REF,
        referrerRef: null,
      });

    const ctx = await resolveAgentSplitContext(
      agent({ registry_id: SELF_PUBLISHED_REGISTRY_ID, slug: 'A' }),
    );

    expect(ctx.creator).toEqual({ wallet: PAYOUT, ownerRef: 'owner-A' });
    expect(ctx.referral).toEqual({ wallet: W_REF, ownerRef: 'owner-B' });
    expect(mockGetSplitContextRow).toHaveBeenCalledWith('A');
    expect(mockGetSplitContextRow).toHaveBeenCalledWith('B');
  });

  // T-REF-INVALID (AC-2) — referrer row invalid (null payout) → referral null.
  it('T-REF-INVALID: referrer without payout_wallet → referral null, creator intact', async () => {
    process.env.SPLIT_BPS_REFERRAL = '500';
    mockGetSplitContextRow
      .mockResolvedValueOnce({
        ownerRef: 'owner-A',
        payoutWallet: PAYOUT,
        referrerRef: 'B',
      })
      .mockResolvedValueOnce(null);

    const ctx = await resolveAgentSplitContext(
      agent({ registry_id: SELF_PUBLISHED_REGISTRY_ID, slug: 'A' }),
    );

    expect(ctx.referral).toBeNull();
    expect(ctx.creator).toEqual({ wallet: PAYOUT, ownerRef: 'owner-A' });
  });

  // T-REF-SELF-DEDUP (AC-7, CD-B2) — referrer wallet == creator (distinto casing) → null.
  it('T-REF-SELF-DEDUP: referrer wallet equals creator (case-insensitive) → referral null', async () => {
    process.env.SPLIT_BPS_REFERRAL = '500';
    mockGetSplitContextRow
      .mockResolvedValueOnce({
        ownerRef: 'owner-A',
        payoutWallet: PAYOUT,
        referrerRef: 'B',
      })
      .mockResolvedValueOnce({
        ownerRef: 'owner-B',
        payoutWallet: PAYOUT.toUpperCase(),
        referrerRef: null,
      });

    const ctx = await resolveAgentSplitContext(
      agent({ registry_id: SELF_PUBLISHED_REGISTRY_ID, slug: 'A' }),
    );

    expect(ctx.referral).toBeNull();
    expect(ctx.creator).toEqual({ wallet: PAYOUT, ownerRef: 'owner-A' });
  });

  // T-REF-BPS-OFF (AC-1, CD-B4/CD-P3) — referral OFF → cero 2ª query.
  it('T-REF-BPS-OFF: SPLIT_BPS_REFERRAL unset → referral null and only one lookup', async () => {
    mockGetSplitContextRow.mockResolvedValue({
      ownerRef: 'owner-A',
      payoutWallet: PAYOUT,
      referrerRef: 'B',
    });

    const ctx = await resolveAgentSplitContext(
      agent({ registry_id: SELF_PUBLISHED_REGISTRY_ID, slug: 'A' }),
    );

    expect(ctx.referral).toBeNull();
    expect(mockGetSplitContextRow).toHaveBeenCalledTimes(1);
  });

  // T-REF-NO-REFERRER (AC-3) — referralActive but no referrer_ref → cero 2ª query.
  it('T-REF-NO-REFERRER: referrer_ref null → referral null and only one lookup', async () => {
    process.env.SPLIT_BPS_REFERRAL = '500';
    mockGetSplitContextRow.mockResolvedValue({
      ownerRef: 'owner-A',
      payoutWallet: PAYOUT,
      referrerRef: null,
    });

    const ctx = await resolveAgentSplitContext(
      agent({ registry_id: SELF_PUBLISHED_REGISTRY_ID, slug: 'A' }),
    );

    expect(ctx.referral).toBeNull();
    expect(mockGetSplitContextRow).toHaveBeenCalledTimes(1);
  });

  // T-REF-THROW (AC-5, CD-B3) — 2ª query rechaza → referral null, creator preservado.
  it('T-REF-THROW: referrer lookup rejects → referral null, creator preserved, logged', async () => {
    process.env.SPLIT_BPS_REFERRAL = '500';
    mockGetSplitContextRow
      .mockResolvedValueOnce({
        ownerRef: 'owner-A',
        payoutWallet: PAYOUT,
        referrerRef: 'B',
      })
      .mockRejectedValueOnce(new Error('DB down'));

    const ctx = await resolveAgentSplitContext(
      agent({ registry_id: SELF_PUBLISHED_REGISTRY_ID, slug: 'A' }),
    );

    expect(ctx.referral).toBeNull();
    expect(ctx.creator).toEqual({ wallet: PAYOUT, ownerRef: 'owner-A' });
    expect(logSpy.error).toHaveBeenCalled();
  });
});
