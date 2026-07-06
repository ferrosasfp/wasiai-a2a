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

// WKH-144 MNR-1(b): registry mock so `verifyDefaultChainSettle` can be driven
// through the "default bundle cannot be resolved" branch on a mainnet vs testnet
// default chainKey. Only `verifyDefaultChainSettle` touches these; the direct
// `verifySettledTx` tests never call registry.
const mockGetDefaultChainKey = vi.fn<() => string | null>();
const mockGetAdaptersBundle = vi.fn<(k?: string) => unknown>();
vi.mock('./registry.js', () => ({
  getDefaultChainKey: () => mockGetDefaultChainKey(),
  getAdaptersBundle: (k?: string) => mockGetAdaptersBundle(k),
}));

import {
  _resetSettleVerifier,
  isSettleVerifyEnabled,
  verifyDefaultChainSettle,
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

// WKH-144: testnet chainKey (kite-ozone-testnet, 2368) maps to KITE_RPC_URL.
// Used to prove the historical fail-OPEN on RPC_UNAVAILABLE is preserved.
const TESTNET_CHAIN_KEY = 'kite-ozone-testnet' as const;
const TESTNET_CHAIN_ID = 2368;

function testnetArgs(
  overrides?: Partial<Parameters<typeof verifySettledTx>[0]>,
) {
  return baseArgs({
    chainKey: TESTNET_CHAIN_KEY,
    chainId: TESTNET_CHAIN_ID,
    ...overrides,
  });
}

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

  it('MAINNET: BLOCKS + WARNS on a TRANSPORT error (RPC unreachable) — fail-CLOSED (WKH-144)', async () => {
    // WKH-144: on mainnet a2a will NOT trust the facilitator blind when it
    // cannot independently re-read the tx → fail-CLOSED with a distinguishable
    // reason (warn:true marks it an RPC outage, not a definitive contradiction).
    const transportErr = new HttpRequestError({
      url: 'https://rpc.kite.test',
      status: 503,
    });
    mockGetReceipt.mockRejectedValue(transportErr);
    const res = await verifySettledTx(baseArgs());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('RPC_UNAVAILABLE_MAINNET_FAILCLOSED');
    expect(res.warn).toBe(true);
  });

  it('MAINNET: BLOCKS + WARNS on a generic network error (fetch failed) — fail-CLOSED (WKH-144)', async () => {
    mockGetReceipt.mockRejectedValue(new Error('fetch failed'));
    const res = await verifySettledTx(baseArgs());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('RPC_UNAVAILABLE_MAINNET_FAILCLOSED');
    expect(res.warn).toBe(true);
  });

  it('MAINNET: retries once then BLOCKS+WARNS if the retry is also a transport error (WKH-144)', async () => {
    mockGetReceipt
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await verifySettledTx(baseArgs());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('RPC_UNAVAILABLE_MAINNET_FAILCLOSED');
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

  it('MAINNET: BLOCKS + WARNS when the RPC URL is unset (RPC_UNAVAILABLE) — fail-CLOSED (WKH-144)', async () => {
    // No RPC configured → a2a cannot independently check. On mainnet this is now
    // fail-CLOSED (the settle must not proceed on facilitator trust alone).
    delete process.env.KITE_MAINNET_RPC_URL;
    delete process.env.KITE_RPC_URL;
    _resetSettleVerifier();
    const res = await verifySettledTx(baseArgs());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('RPC_UNAVAILABLE_MAINNET_FAILCLOSED');
    expect(res.warn).toBe(true);
  });

  it('MAINNET: BLOCKS + WARNS when getChainId throws a transport error — fail-CLOSED (WKH-144)', async () => {
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [transferLog({ token: TOKEN, to: PAY_TO, value: REQUIRED })],
    });
    mockGetChainId.mockRejectedValue(new Error('fetch failed'));
    const res = await verifySettledTx(baseArgs());
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('RPC_UNAVAILABLE_MAINNET_FAILCLOSED');
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

// WKH-144: on TESTNET the historical fail-OPEN behaviour is preserved
// byte-for-byte (CD-1). Every "couldn't independently check on-chain" path must
// still return `{ ok:true, reason:'RPC_UNAVAILABLE', warn:true }`.
describe('verifySettledTx — TESTNET fail-OPEN preserved (WKH-144)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetSettleVerifier();
    process.env = { ...ORIGINAL_ENV };
    // Testnet (kite-ozone-testnet) resolves KITE_RPC_URL.
    process.env.KITE_RPC_URL = 'https://rpc.kite-testnet.test';
    process.env.SETTLE_VERIFY_ONCHAIN = 'true';
    process.env.SETTLE_VERIFY_CONFIRM_WAIT_MS = '0';
    mockGetChainId.mockResolvedValue(TESTNET_CHAIN_ID);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    _resetSettleVerifier();
  });

  it('TESTNET: ALLOWS + WARNS on a TRANSPORT error (getTransactionReceipt) — fail-OPEN', async () => {
    mockGetReceipt.mockRejectedValue(
      new HttpRequestError({
        url: 'https://rpc.kite-testnet.test',
        status: 503,
      }),
    );
    const res = await verifySettledTx(testnetArgs());
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('RPC_UNAVAILABLE');
    expect(res.warn).toBe(true);
  });

  it('TESTNET: ALLOWS + WARNS when the RPC URL is unset (no client) — fail-OPEN', async () => {
    delete process.env.KITE_RPC_URL;
    delete process.env.KITE_MAINNET_RPC_URL;
    _resetSettleVerifier();
    const res = await verifySettledTx(testnetArgs());
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('RPC_UNAVAILABLE');
    expect(res.warn).toBe(true);
  });

  it('TESTNET: ALLOWS + WARNS when getChainId throws a transport error — fail-OPEN', async () => {
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [transferLog({ token: TOKEN, to: PAY_TO, value: REQUIRED })],
    });
    mockGetChainId.mockRejectedValue(new Error('fetch failed'));
    const res = await verifySettledTx(testnetArgs());
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('RPC_UNAVAILABLE');
    expect(res.warn).toBe(true);
  });

  it('TESTNET: a DEFINITIVE contradiction still fail-CLOSED (TX_NOT_FOUND, no regression)', async () => {
    // CD-2: the mainnet gate must NOT weaken definitive contradictions on testnet.
    mockGetReceipt.mockRejectedValue(
      new TransactionReceiptNotFoundError({ hash: FAKE_TX }),
    );
    const res = await verifySettledTx(testnetArgs({ txHash: FAKE_TX }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('TX_NOT_FOUND');
    expect(res.warn).toBeFalsy();
  });

  it('TESTNET: kill-switch OFF → no-op pass (DISABLED), never reads chain (CD-3)', async () => {
    process.env.SETTLE_VERIFY_ONCHAIN = 'false';
    const res = await verifySettledTx(testnetArgs({ txHash: FAKE_TX }));
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('DISABLED');
    expect(mockGetReceipt).not.toHaveBeenCalled();
  });
});

// WKH-144 NIT-4: the mainnet fail-CLOSED gate must hold for ALL THREE mainnet
// slugs, not just kite-mainnet. Blinds AC-1 across kite/avalanche/base: every
// RPC_UNAVAILABLE return point on a `-mainnet` chain must be ok:false +
// RPC_UNAVAILABLE_MAINNET_FAILCLOSED.
describe('verifySettledTx — mainnet fail-CLOSED across all 3 mainnet chains (WKH-144 NIT-4)', () => {
  // Each mainnet slug + its RPC env (resolveRpcUrl) + chainId. chainId is not
  // reached on the transport-error path (getTransactionReceipt throws first),
  // but included for fidelity with the real bundles.
  const MAINNET_CASES: Array<{
    chainKey: 'kite-mainnet' | 'avalanche-mainnet' | 'base-mainnet';
    rpcEnv: string;
    chainId: number;
  }> = [
    { chainKey: 'kite-mainnet', rpcEnv: 'KITE_MAINNET_RPC_URL', chainId: 2366 },
    {
      chainKey: 'avalanche-mainnet',
      rpcEnv: 'AVALANCHE_RPC_URL',
      chainId: 43114,
    },
    { chainKey: 'base-mainnet', rpcEnv: 'BASE_MAINNET_RPC_URL', chainId: 8453 },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    _resetSettleVerifier();
    process.env = { ...ORIGINAL_ENV };
    process.env.SETTLE_VERIFY_ONCHAIN = 'true';
    process.env.SETTLE_VERIFY_CONFIRM_WAIT_MS = '0';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    _resetSettleVerifier();
  });

  it.each(
    MAINNET_CASES,
  )('$chainKey: transport error → BLOCKS + WARNS (RPC_UNAVAILABLE_MAINNET_FAILCLOSED)', async ({
    chainKey,
    rpcEnv,
    chainId,
  }) => {
    process.env[rpcEnv] = 'https://rpc.mainnet.test';
    _resetSettleVerifier();
    mockGetReceipt.mockRejectedValue(new Error('fetch failed'));
    const res = await verifySettledTx(baseArgs({ chainKey, chainId }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('RPC_UNAVAILABLE_MAINNET_FAILCLOSED');
    expect(res.warn).toBe(true);
  });

  it.each(
    MAINNET_CASES,
  )('$chainKey: no RPC configured → BLOCKS + WARNS (RPC_UNAVAILABLE_MAINNET_FAILCLOSED)', async ({
    chainKey,
    chainId,
  }) => {
    // No RPC env set for this chain → getClient() null → fail-CLOSED on mainnet.
    _resetSettleVerifier();
    const res = await verifySettledTx(baseArgs({ chainKey, chainId }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('RPC_UNAVAILABLE_MAINNET_FAILCLOSED');
    expect(res.warn).toBe(true);
  });
});

// WKH-144 MNR-1(b): the `verifyDefaultChainSettle` "bundle cannot be resolved"
// fallback used to hardcode `{ ok: true }` (fail-OPEN, network-agnostic) — a
// latent mainnet fail-open. It must now gate via `rpcUnavailableResult`: mainnet
// → ok:false, testnet → ok:true (byte-identical to before on testnet).
describe('verifyDefaultChainSettle — bundle-unresolved gate (WKH-144 MNR-1b)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetSettleVerifier();
    process.env = { ...ORIGINAL_ENV };
    process.env.SETTLE_VERIFY_ONCHAIN = 'true';
    process.env.SETTLE_VERIFY_CONFIRM_WAIT_MS = '0';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    _resetSettleVerifier();
  });

  it('MAINNET default chainKey + unresolved bundle → ok:false (fail-CLOSED)', async () => {
    mockGetDefaultChainKey.mockReturnValue('base-mainnet');
    mockGetAdaptersBundle.mockReturnValue(undefined); // bundle not resolvable
    const res = await verifyDefaultChainSettle({
      txHash: REAL_TX,
      payTo: PAY_TO,
      requiredAmountAtomic: REQUIRED,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('RPC_UNAVAILABLE_MAINNET_FAILCLOSED');
  });

  it('TESTNET default chainKey + unresolved bundle → ok:true (fail-OPEN preserved)', async () => {
    mockGetDefaultChainKey.mockReturnValue('kite-ozone-testnet');
    mockGetAdaptersBundle.mockReturnValue(undefined);
    const res = await verifyDefaultChainSettle({
      txHash: REAL_TX,
      payTo: PAY_TO,
      requiredAmountAtomic: REQUIRED,
    });
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('RPC_UNAVAILABLE');
  });

  it('no default chainKey at all → ok:true (historical fail-OPEN, cannot classify)', async () => {
    mockGetDefaultChainKey.mockReturnValue(null);
    mockGetAdaptersBundle.mockReturnValue(undefined);
    const res = await verifyDefaultChainSettle({
      txHash: REAL_TX,
      payTo: PAY_TO,
      requiredAmountAtomic: REQUIRED,
    });
    expect(res.ok).toBe(true);
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
