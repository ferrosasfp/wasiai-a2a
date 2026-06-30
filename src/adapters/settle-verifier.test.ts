/**
 * Settle re-verifier unit tests — TB-01 (audit 2026-06-30).
 *
 * Proves the money-path fix: a forged `{ settled: true, fake hash }` settle is
 * REJECTED by the independent on-chain re-read, while a real settle (tx really
 * moved >= required to payTo) PASSES. Mocks viem `createPublicClient` (exemplar:
 * deposit-verifier.test.ts). `SETTLE_VERIFY_CONFIRM_WAIT_MS=0` keeps tests fast.
 */

import {
  encodeAbiParameters,
  HttpRequestError,
  parseAbiParameters,
  TransactionReceiptNotFoundError,
} from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetReceipt = vi.fn();
const mockGetChainId = vi.fn();

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getTransactionReceipt: mockGetReceipt,
      getChainId: mockGetChainId,
    })),
  };
});

import {
  _resetSettleVerifier,
  isSettleVerifyEnabled,
  verifySettledTx,
} from './settle-verifier.js';

const PAY_TO = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const SENDER = '0x3333333333333333333333333333333333333333';
const TOKEN = '0x4444444444444444444444444444444444444444';
const OTHER_TOKEN = '0x6666666666666666666666666666666666666666';

const REAL_TX =
  '0xabc1230000000000000000000000000000000000000000000000000000000000' as `0x${string}`;
const FAKE_TX =
  '0xdead000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;

const TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function topicAddr(addr: string): `0x${string}` {
  return `0x${'0'.repeat(24)}${addr.slice(2)}` as `0x${string}`;
}

function transferLog(opts: { token: string; to: string; value: bigint }) {
  return {
    address: opts.token,
    topics: [TRANSFER_TOPIC0, topicAddr(SENDER), topicAddr(opts.to)] as [
      `0x${string}`,
      `0x${string}`,
      `0x${string}`,
    ],
    data: encodeAbiParameters(parseAbiParameters('uint256'), [opts.value]),
  };
}

const ORIGINAL_ENV = { ...process.env };

// Kite-mainnet chainKey (2366) maps to KITE_MAINNET_RPC_URL in resolveRpcUrl.
const CHAIN_KEY = 'kite-mainnet' as const;
const CHAIN_ID = 2366;
const REQUIRED = 10n * 10n ** 18n;

function baseArgs(overrides?: Partial<Parameters<typeof verifySettledTx>[0]>) {
  return {
    chainKey: CHAIN_KEY,
    chainId: CHAIN_ID,
    txHash: REAL_TX,
    payTo: PAY_TO,
    tokenAddress: TOKEN,
    requiredAmountAtomic: REQUIRED,
    ...overrides,
  };
}

describe('verifySettledTx (TB-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetSettleVerifier();
    process.env = { ...ORIGINAL_ENV };
    process.env.KITE_MAINNET_RPC_URL = 'https://rpc.kite.test';
    process.env.SETTLE_VERIFY_ONCHAIN = 'true';
    process.env.SETTLE_VERIFY_CONFIRM_WAIT_MS = '0';
    mockGetChainId.mockResolvedValue(CHAIN_ID);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    _resetSettleVerifier();
  });

  it('PASSES a real settle (correct recipient, token, amount)', async () => {
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [transferLog({ token: TOKEN, to: PAY_TO, value: REQUIRED })],
    });
    const res = await verifySettledTx(baseArgs());
    expect(res.ok).toBe(true);
  });

  it('PASSES when settled amount exceeds required (>=)', async () => {
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [transferLog({ token: TOKEN, to: PAY_TO, value: REQUIRED + 1n })],
    });
    const res = await verifySettledTx(baseArgs());
    expect(res.ok).toBe(true);
  });

  it('REJECTS a forged hash the node DEFINITIVELY has no receipt for (TX_NOT_FOUND, fail-CLOSED)', async () => {
    // viem throws TransactionReceiptNotFoundError when the node answered and the
    // tx simply isn't on chain — the TB-01 forgery signal. Both attempts throw it.
    const notFound = new TransactionReceiptNotFoundError({ hash: FAKE_TX });
    mockGetReceipt.mockRejectedValue(notFound);
    const res = await verifySettledTx(baseArgs({ txHash: FAKE_TX }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('TX_NOT_FOUND');
    expect(res.warn).toBeFalsy();
  });

  it('ALLOWS + WARNS on a TRANSPORT error (RPC unreachable) — fail-OPEN (MNR-1)', async () => {
    // a2a literally couldn't reach a node (HTTP/network error). The facilitator
    // already broadcast + receipt-checked the tx → trust it, do not reject.
    const transportErr = new HttpRequestError({
      url: 'https://rpc.kite.test',
      status: 503,
    });
    mockGetReceipt.mockRejectedValue(transportErr);
    const res = await verifySettledTx(baseArgs());
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('RPC_UNAVAILABLE');
    expect(res.warn).toBe(true);
  });

  it('ALLOWS + WARNS on a generic network error (fetch failed) — fail-OPEN (MNR-1)', async () => {
    mockGetReceipt.mockRejectedValue(new Error('fetch failed'));
    const res = await verifySettledTx(baseArgs());
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('RPC_UNAVAILABLE');
    expect(res.warn).toBe(true);
  });

  it('retries once then ALLOWS+WARNS if the retry is also a transport error (MNR-1)', async () => {
    mockGetReceipt
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await verifySettledTx(baseArgs());
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('RPC_UNAVAILABLE');
    expect(mockGetReceipt).toHaveBeenCalledTimes(2);
  });

  it('REJECTS a reverted tx (TX_REVERTED)', async () => {
    mockGetReceipt.mockResolvedValue({
      status: 'reverted',
      blockNumber: 100n,
      logs: [],
    });
    const res = await verifySettledTx(baseArgs());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('TX_REVERTED');
  });

  it('REJECTS a tx on the wrong chain (CHAIN_MISMATCH)', async () => {
    mockGetChainId.mockResolvedValue(8453);
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [transferLog({ token: TOKEN, to: PAY_TO, value: REQUIRED })],
    });
    const res = await verifySettledTx(baseArgs());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('CHAIN_MISMATCH');
  });

  it('REJECTS when the transfer went to a different recipient (RECIPIENT_MISMATCH)', async () => {
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [transferLog({ token: TOKEN, to: OTHER, value: REQUIRED })],
    });
    const res = await verifySettledTx(baseArgs());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('RECIPIENT_MISMATCH');
  });

  it('REJECTS when no transfer of the expected token is present (TOKEN_MISMATCH)', async () => {
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [transferLog({ token: OTHER_TOKEN, to: PAY_TO, value: REQUIRED })],
    });
    const res = await verifySettledTx(baseArgs());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('TOKEN_MISMATCH');
  });

  it('REJECTS when the settled amount is below required (AMOUNT_MISMATCH)', async () => {
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [transferLog({ token: TOKEN, to: PAY_TO, value: REQUIRED - 1n })],
    });
    const res = await verifySettledTx(baseArgs());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('AMOUNT_MISMATCH');
  });

  it('ALLOWS + WARNS when the RPC URL is unset (RPC_UNAVAILABLE) — fail-OPEN (MNR-1)', async () => {
    // No RPC configured → a2a cannot independently check → trust facilitator.
    delete process.env.KITE_MAINNET_RPC_URL;
    delete process.env.KITE_RPC_URL;
    _resetSettleVerifier();
    const res = await verifySettledTx(baseArgs());
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('RPC_UNAVAILABLE');
    expect(res.warn).toBe(true);
  });

  it('ALLOWS + WARNS when getChainId throws a transport error — fail-OPEN (MNR-1)', async () => {
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [transferLog({ token: TOKEN, to: PAY_TO, value: REQUIRED })],
    });
    mockGetChainId.mockRejectedValue(new Error('fetch failed'));
    const res = await verifySettledTx(baseArgs());
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('RPC_UNAVAILABLE');
    expect(res.warn).toBe(true);
  });

  it('kill-switch OFF → no-op pass (DISABLED), never reads chain', async () => {
    process.env.SETTLE_VERIFY_ONCHAIN = 'false';
    const res = await verifySettledTx(baseArgs({ txHash: FAKE_TX }));
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('DISABLED');
    expect(mockGetReceipt).not.toHaveBeenCalled();
  });
});

describe('isSettleVerifyEnabled', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('defaults ON when unset', () => {
    delete process.env.SETTLE_VERIFY_ONCHAIN;
    expect(isSettleVerifyEnabled()).toBe(true);
  });

  it('stays ON for unrecognized values (fail-safe)', () => {
    process.env.SETTLE_VERIFY_ONCHAIN = 'maybe';
    expect(isSettleVerifyEnabled()).toBe(true);
  });

  it('OFF only for explicit falsy literals', () => {
    for (const v of ['false', '0', 'no', 'off', 'OFF']) {
      process.env.SETTLE_VERIFY_ONCHAIN = v;
      expect(isSettleVerifyEnabled()).toBe(false);
    }
  });
});
