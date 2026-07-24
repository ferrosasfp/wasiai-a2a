/**
 * Unit tests for SolanaPaymentAdapter (WKH-234, AC-2 / AC-7).
 *
 * The real settle (build+sign+broadcast+confirm) is exercised with a MOCKED
 * `@solana/web3.js` + `@solana/spl-token` + `./chain.js` (no network in CI). A
 * devnet integration test is gated behind `SOLANA_DEVNET_E2E=1` (importActual).
 *
 * CD-11: every `vi.fn` uses a rest param `(..._a: unknown[])` to avoid TS2556.
 * CD-12: `mock.calls[N]` accesses are guarded (noUncheckedIndexedAccess).
 */

import { PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const PAY_TO = 'So11111111111111111111111111111111111111112';
const OPERATOR = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
const FAKE_SIG = '5'.repeat(64);

// ── Mock the network boundary (chain.ts) ─────────────────────────────────
const fakeConnection = {
  getParsedTransaction: vi.fn((..._a: unknown[]): Promise<unknown> =>
    Promise.resolve(null),
  ),
};
vi.mock('./chain.js', () => ({
  getSolanaConnection: vi.fn((..._a: unknown[]) => fakeConnection),
  getSolanaOperatorKeypair: vi.fn((..._a: unknown[]) => ({
    publicKey: new PublicKey(OPERATOR),
    secretKey: new Uint8Array(64),
  })),
  getSolanaUsdcMint: vi.fn((..._a: unknown[]) => MINT),
  getSolanaUsdcDecimals: vi.fn((..._a: unknown[]) => 6),
  getSolanaCommitment: vi.fn((..._a: unknown[]) => 'confirmed'),
  getSolanaCaip2: vi.fn((..._a: unknown[]) => 'solana:test'),
}));

// ── Mock spl-token instruction builders ──────────────────────────────────
const mockGetOrCreateAta = vi.fn((..._a: unknown[]) =>
  Promise.resolve({ address: new PublicKey(PAY_TO) }),
);
const mockCreateTransferIx = vi.fn((..._a: unknown[]) => ({
  keys: [],
  programId: new PublicKey(MINT),
  data: Buffer.alloc(0),
}));
vi.mock('@solana/spl-token', () => ({
  getOrCreateAssociatedTokenAccount: (...a: unknown[]) => mockGetOrCreateAta(...a),
  createTransferInstruction: (...a: unknown[]) => mockCreateTransferIx(...a),
}));

// ── Mock sendAndConfirmTransaction (keep PublicKey/Transaction real) ──────
const mockSendAndConfirm = vi.fn((..._a: unknown[]) => Promise.resolve(FAKE_SIG));
vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  return {
    ...actual,
    sendAndConfirmTransaction: (...a: unknown[]) => mockSendAndConfirm(...a),
  };
});

import { _resetSolanaClients, SolanaPaymentAdapter } from './payment.js';

describe('SolanaPaymentAdapter (WKH-234)', () => {
  beforeEach(() => {
    _resetSolanaClients();
    vi.clearAllMocks();
    fakeConnection.getParsedTransaction.mockResolvedValue(null);
  });

  afterEach(() => {
    _resetSolanaClients();
  });

  it('T-234-AC2: settle() builds + broadcasts an SPL transfer → { success, txHash }', async () => {
    const adapter = new SolanaPaymentAdapter();
    const res = await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'ctx-1:0:payTo',
    });

    expect(res.success).toBe(true);
    expect(res.txHash).toBe(FAKE_SIG);
    expect(mockGetOrCreateAta).toHaveBeenCalledTimes(2); // operator + payTo ATAs
    expect(mockCreateTransferIx).toHaveBeenCalledTimes(1);
    expect(mockSendAndConfirm).toHaveBeenCalledTimes(1);

    // amount threaded as bigint into the transfer instruction (arg index 3).
    const call = mockCreateTransferIx.mock.calls[0];
    expect(call?.[3]).toBe(1000000n);
  });

  it('T-234-AC7: retry with an already-confirmed intentId → NO re-broadcast, returns prior signature via verify()', async () => {
    const adapter = new SolanaPaymentAdapter();
    const intentId = 'ctx-1:0:payTo';

    // First settle broadcasts once.
    const first = await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId,
    });
    expect(first.txHash).toBe(FAKE_SIG);
    expect(mockSendAndConfirm).toHaveBeenCalledTimes(1);

    // verify() re-reads the tx on-chain: a confirmed transfer of >= amount to
    // payTo's balance (post - pre delta).
    fakeConnection.getParsedTransaction.mockResolvedValue({
      meta: {
        err: null,
        preTokenBalances: [
          { owner: PAY_TO, mint: MINT, uiTokenAmount: { amount: '0' } },
        ],
        postTokenBalances: [
          { owner: PAY_TO, mint: MINT, uiTokenAmount: { amount: '1000000' } },
        ],
      },
    });

    // Retry with the SAME intentId → idempotent hit, no second broadcast.
    const retry = await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId,
    });
    expect(retry.success).toBe(true);
    expect(retry.txHash).toBe(FAKE_SIG);
    expect(mockSendAndConfirm).toHaveBeenCalledTimes(1); // STILL 1 — no re-emit
    expect(fakeConnection.getParsedTransaction).toHaveBeenCalledTimes(1);
  });

  it('verify() rejects a tx whose on-chain transfer is < required amount', async () => {
    const adapter = new SolanaPaymentAdapter();
    fakeConnection.getParsedTransaction.mockResolvedValue({
      meta: {
        err: null,
        preTokenBalances: [
          { owner: PAY_TO, mint: MINT, uiTokenAmount: { amount: '0' } },
        ],
        postTokenBalances: [
          { owner: PAY_TO, mint: MINT, uiTokenAmount: { amount: '500000' } },
        ],
      },
    });
    const res = await adapter.verify({
      signature: FAKE_SIG,
      payTo: PAY_TO,
      amountAtomic: '1000000',
    });
    expect(res.valid).toBe(false);
  });

  it('verify() rejects a tx not found / failed on-chain', async () => {
    const adapter = new SolanaPaymentAdapter();
    fakeConnection.getParsedTransaction.mockResolvedValue(null);
    const res = await adapter.verify({
      signature: FAKE_SIG,
      payTo: PAY_TO,
      amountAtomic: '1000000',
    });
    expect(res.valid).toBe(false);
  });

  it('exposes the VM-agnostic surface (scheme, mint, caip2, tokens)', () => {
    const adapter = new SolanaPaymentAdapter();
    expect(adapter.vmFamily).toBe('solana');
    expect(adapter.getScheme()).toBe('spl-transfer');
    expect(adapter.getMint()).toBe(MINT);
    expect(adapter.getNetwork()).toBe('solana:test');
    expect(adapter.supportedTokens[0]?.mint).toBe(MINT);
    expect(adapter.supportedTokens[0]?.decimals).toBe(6);
  });
});

// ── Gated devnet integration (no network in CI — CD-6) ───────────────────
const E2E = process.env.SOLANA_DEVNET_E2E === '1';
describe.runIf(E2E)('SolanaPaymentAdapter — devnet e2e (gated)', () => {
  it('settles a real SPL transfer on devnet', async () => {
    const actual = await vi.importActual<typeof import('./payment.js')>(
      './payment.js',
    );
    const adapter = new actual.SolanaPaymentAdapter();
    const res = await adapter.settle({
      payTo: process.env.SOLANA_E2E_PAYTO as string,
      amountAtomic: process.env.SOLANA_E2E_AMOUNT_ATOMIC ?? '1',
      intentId: `e2e:${Date.now()}`,
    });
    expect(res.success).toBe(true);
    expect(typeof res.txHash).toBe('string');
  });
});
