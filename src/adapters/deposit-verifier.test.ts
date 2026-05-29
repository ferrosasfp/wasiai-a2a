/**
 * Deposit verifier unit tests — WKH-35 (W1).
 *
 * Covers AC-1, AC-2, AC-6 + CD-5/CD-10/CD-11. Mocks viem `createPublicClient`
 * while preserving `formatUnits`, `decodeEventLog`, `parseAbiItem`, `http`
 * (exemplar: base.test.ts:21-30). The verifier reads `process.env` for RPC /
 * treasury / confirmations, so env is set/cleared per test + `_resetVerifier()`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, parseAbiParameters } from 'viem';

// ─── Mocks ───────────────────────────────────────────────────────────────
const mockGetReceipt = vi.fn();
const mockGetBlockNumber = vi.fn();
const mockGetChainId = vi.fn();

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getTransactionReceipt: mockGetReceipt,
      getBlockNumber: mockGetBlockNumber,
      getChainId: mockGetChainId,
    })),
  };
});

import type { AdaptersBundle, ChainKey, TokenSpec } from './types.js';
import { verifyDeposit, _resetVerifier } from './deposit-verifier.js';

// ─── Fixtures ────────────────────────────────────────────────────────────
const TREASURY = '0x1111111111111111111111111111111111111111' as const;
const OTHER_ADDR = '0x2222222222222222222222222222222222222222' as const;
const SENDER = '0x3333333333333333333333333333333333333333' as const;
const KITE_USDC =
  '0x4444444444444444444444444444444444444444' as `0x${string}`;
const BASE_USDC =
  '0x5555555555555555555555555555555555555555' as `0x${string}`;
const OTHER_TOKEN =
  '0x6666666666666666666666666666666666666666' as `0x${string}`;

const TX_HASH =
  '0xabc1230000000000000000000000000000000000000000000000000000000000' as `0x${string}`;

// Transfer(address indexed from, address indexed to, uint256 value)
const TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function topicAddr(addr: string): `0x${string}` {
  return `0x${'0'.repeat(24)}${addr.slice(2)}` as `0x${string}`;
}

function transferLog(opts: {
  token: `0x${string}`;
  to: string;
  value: bigint;
}) {
  return {
    address: opts.token,
    topics: [
      TRANSFER_TOPIC0,
      topicAddr(SENDER),
      topicAddr(opts.to),
    ] as [`0x${string}`, `0x${string}`, `0x${string}`],
    data: encodeAbiParameters(parseAbiParameters('uint256'), [opts.value]),
  };
}

function makeBundle(opts: {
  chainId: number;
  token: TokenSpec;
}): AdaptersBundle {
  return {
    payment: {
      name: 'test',
      chainId: opts.chainId,
      supportedTokens: [opts.token],
    } as unknown as AdaptersBundle['payment'],
    attestation: {} as unknown as AdaptersBundle['attestation'],
    gasless: {} as unknown as AdaptersBundle['gasless'],
    identity: null,
    chainConfig: {
      name: 'test-chain',
      chainId: opts.chainId,
      explorerUrl: 'https://example.test',
    },
  };
}

const KITE_TOKEN: TokenSpec = {
  symbol: 'PYUSD',
  address: KITE_USDC,
  decimals: 18,
};
const BASE_TOKEN: TokenSpec = {
  symbol: 'USDC',
  address: BASE_USDC,
  decimals: 6,
};

const KITE_BUNDLE = makeBundle({ chainId: 2368, token: KITE_TOKEN });
const BASE_BUNDLE = makeBundle({ chainId: 84532, token: BASE_TOKEN });

const ORIGINAL_ENV = { ...process.env };

function setHappyChain(chainId: number, blockNumber = 100n) {
  mockGetChainId.mockResolvedValue(chainId);
  mockGetBlockNumber.mockResolvedValue(blockNumber + 1n); // confirmations = 2 >= 1
}

describe('verifyDeposit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetVerifier();
    process.env = { ...ORIGINAL_ENV };
    process.env.KITE_RPC_URL = 'https://rpc.kite.test';
    process.env.BASE_TESTNET_RPC_URL = 'https://rpc.base.test';
    process.env.A2A_DEPOSIT_TREASURY_KITE = TREASURY;
    process.env.A2A_DEPOSIT_TREASURY_BASE = TREASURY;
    delete process.env.A2A_DEPOSIT_MIN_CONFIRMATIONS;
    delete process.env.A2A_DEPOSIT_MIN_CONFIRMATIONS_KITE;
    delete process.env.A2A_DEPOSIT_MIN_CONFIRMATIONS_BASE;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    _resetVerifier();
  });

  // T1 — verify OK (Kite 18 dec + Base 6 dec). AC-1, AC-6.
  it('returns ok with amountUsd/recipient/token/tokenSymbol — Kite 18 dec (AC-1)', async () => {
    setHappyChain(2368);
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [transferLog({ token: KITE_USDC, to: TREASURY, value: 10n * 10n ** 18n })],
    });

    const res = await verifyDeposit({
      chainKey: 'kite-ozone-testnet' as ChainKey,
      bundle: KITE_BUNDLE,
      txHash: TX_HASH,
    });

    expect(res.ok).toBe(true);
    expect(res.amountUsd).toBe('10');
    expect(res.token).toBe(KITE_USDC);
    expect(res.tokenSymbol).toBe('PYUSD');
    expect(res.recipient?.toLowerCase()).toBe(TREASURY);
    expect(res.confirmations).toBe(2);
    // FIX-1: el verifier devuelve el depositor (Transfer.from) para el gate.
    expect(res.from?.toLowerCase()).toBe(SENDER);
  });

  it('returns ok — Base 6 dec (AC-1, AC-6)', async () => {
    setHappyChain(84532);
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [transferLog({ token: BASE_USDC, to: TREASURY, value: 10n * 10n ** 6n })],
    });

    const res = await verifyDeposit({
      chainKey: 'base-sepolia' as ChainKey,
      bundle: BASE_BUNDLE,
      txHash: TX_HASH,
    });

    expect(res.ok).toBe(true);
    expect(res.amountUsd).toBe('10');
    expect(res.tokenSymbol).toBe('USDC');
  });

  // T2 — reverted receipt → TX_REVERTED. AC-2.
  it('reverted receipt → TX_REVERTED (AC-2)', async () => {
    mockGetReceipt.mockResolvedValue({
      status: 'reverted',
      blockNumber: 100n,
      logs: [],
    });

    const res = await verifyDeposit({
      chainKey: 'kite-ozone-testnet' as ChainKey,
      bundle: KITE_BUNDLE,
      txHash: TX_HASH,
    });

    expect(res).toEqual({ ok: false, reason: 'TX_REVERTED' });
  });

  // T3 — getTransactionReceipt throws → TX_NOT_FOUND. AC-2.
  it('getTransactionReceipt throws → TX_NOT_FOUND (AC-2)', async () => {
    mockGetReceipt.mockRejectedValue(new Error('not found'));

    const res = await verifyDeposit({
      chainKey: 'kite-ozone-testnet' as ChainKey,
      bundle: KITE_BUNDLE,
      txHash: TX_HASH,
    });

    expect(res).toEqual({ ok: false, reason: 'TX_NOT_FOUND' });
  });

  // T4 — confirmations < min → INSUFFICIENT_CONFIRMATIONS. AC-2.
  it('confirmations below min → INSUFFICIENT_CONFIRMATIONS (AC-2, CD-11)', async () => {
    process.env.A2A_DEPOSIT_MIN_CONFIRMATIONS = '3';
    mockGetChainId.mockResolvedValue(2368);
    mockGetBlockNumber.mockResolvedValue(100n); // confirmations = 1 < 3
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [transferLog({ token: KITE_USDC, to: TREASURY, value: 10n * 10n ** 18n })],
    });

    const res = await verifyDeposit({
      chainKey: 'kite-ozone-testnet' as ChainKey,
      bundle: KITE_BUNDLE,
      txHash: TX_HASH,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('INSUFFICIENT_CONFIRMATIONS');
    expect(res.confirmations).toBe(1);
  });

  // T5 — recipient != treasury → RECIPIENT_MISMATCH. AC-2.
  it('recipient != treasury → RECIPIENT_MISMATCH (AC-2)', async () => {
    setHappyChain(2368);
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [transferLog({ token: KITE_USDC, to: OTHER_ADDR, value: 10n * 10n ** 18n })],
    });

    const res = await verifyDeposit({
      chainKey: 'kite-ozone-testnet' as ChainKey,
      bundle: KITE_BUNDLE,
      txHash: TX_HASH,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('RECIPIENT_MISMATCH');
  });

  // T6 — token != supportedTokens[0] → TOKEN_MISMATCH. AC-2.
  it('token != supportedTokens[0] → TOKEN_MISMATCH (AC-2)', async () => {
    setHappyChain(2368);
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [transferLog({ token: OTHER_TOKEN, to: TREASURY, value: 10n * 10n ** 18n })],
    });

    const res = await verifyDeposit({
      chainKey: 'kite-ozone-testnet' as ChainKey,
      bundle: KITE_BUNDLE,
      txHash: TX_HASH,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('TOKEN_MISMATCH');
  });

  // T7 — declared amount != on-chain → AMOUNT_MISMATCH. AC-2.
  it('declared amount != on-chain → AMOUNT_MISMATCH (AC-2)', async () => {
    setHappyChain(2368);
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [transferLog({ token: KITE_USDC, to: TREASURY, value: 10n * 10n ** 18n })],
    });

    const res = await verifyDeposit({
      chainKey: 'kite-ozone-testnet' as ChainKey,
      bundle: KITE_BUNDLE,
      txHash: TX_HASH,
      expectedAmountUsd: '999.00',
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('AMOUNT_MISMATCH');
  });

  // FIX-3 — sub-ulp declared amount must NOT pass (no Number() precision loss).
  it('declared amount differs by 1 wei → AMOUNT_MISMATCH (FIX-3, no precision loss)', async () => {
    setHappyChain(2368);
    // on-chain value = exactly 1 PYUSD (1e18 atomic).
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [transferLog({ token: KITE_USDC, to: TREASURY, value: 10n ** 18n })],
    });

    const res = await verifyDeposit({
      chainKey: 'kite-ozone-testnet' as ChainKey,
      bundle: KITE_BUNDLE,
      txHash: TX_HASH,
      // 1 + 1 wei: Number('1.000000000000000001') === Number('1') colapsa a igual;
      // la comparación BigInt en unidades atómicas DEBE distinguirlos.
      expectedAmountUsd: '1.000000000000000001',
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('AMOUNT_MISMATCH');
  });

  // FIX-3 — declared amount that matches exactly still passes.
  it('declared amount equal to on-chain → ok (FIX-3 canonical match)', async () => {
    setHappyChain(2368);
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [transferLog({ token: KITE_USDC, to: TREASURY, value: 10n ** 18n })],
    });

    const res = await verifyDeposit({
      chainKey: 'kite-ozone-testnet' as ChainKey,
      bundle: KITE_BUNDLE,
      txHash: TX_HASH,
      expectedAmountUsd: '1',
    });

    expect(res.ok).toBe(true);
    expect(res.amountUsd).toBe('1');
  });

  // T8 — decimals correct per chain (CD-10/CD-11): exact amountUsd.
  it('decimals per chain: 18-dec → USD and 6-dec → USD exact (CD-10/CD-11)', async () => {
    // Kite 18 dec: 1.5 PYUSD.
    setHappyChain(2368);
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [transferLog({ token: KITE_USDC, to: TREASURY, value: 15n * 10n ** 17n })],
    });
    const kite = await verifyDeposit({
      chainKey: 'kite-ozone-testnet' as ChainKey,
      bundle: KITE_BUNDLE,
      txHash: TX_HASH,
    });
    expect(kite.amountUsd).toBe('1.5');

    _resetVerifier();
    vi.clearAllMocks();

    // Base 6 dec: 2.5 USDC.
    setHappyChain(84532);
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [transferLog({ token: BASE_USDC, to: TREASURY, value: 2_500_000n })],
    });
    const base = await verifyDeposit({
      chainKey: 'base-sepolia' as ChainKey,
      bundle: BASE_BUNDLE,
      txHash: TX_HASH,
    });
    expect(base.amountUsd).toBe('2.5');
  });

  // T9 — RPC URL absent → RPC_UNAVAILABLE. AC-2.
  it('RPC URL absent → RPC_UNAVAILABLE (AC-2)', async () => {
    delete process.env.KITE_RPC_URL;
    _resetVerifier();

    const res = await verifyDeposit({
      chainKey: 'kite-ozone-testnet' as ChainKey,
      bundle: KITE_BUNDLE,
      txHash: TX_HASH,
    });

    expect(res).toEqual({ ok: false, reason: 'RPC_UNAVAILABLE' });
  });

  // CHAIN_MISMATCH coverage (CD-5): on-chain chainId != bundle.
  it('onchain chainId != bundle → CHAIN_MISMATCH (CD-5)', async () => {
    mockGetChainId.mockResolvedValue(99999);
    mockGetBlockNumber.mockResolvedValue(101n);
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [transferLog({ token: KITE_USDC, to: TREASURY, value: 10n * 10n ** 18n })],
    });

    const res = await verifyDeposit({
      chainKey: 'kite-ozone-testnet' as ChainKey,
      bundle: KITE_BUNDLE,
      txHash: TX_HASH,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('CHAIN_MISMATCH');
  });
});
