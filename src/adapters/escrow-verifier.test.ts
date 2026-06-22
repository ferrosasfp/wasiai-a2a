/**
 * Escrow verifier unit tests — WKH-126b (W1/W4).
 *
 * Covers AC-1, AC-2, AC-10 + CD-3/CD-8/CD-10. Mocks viem `createPublicClient`
 * preservando `formatUnits`/`decodeEventLog`/`parseAbiItem`/`parseUnits`/
 * `keccak256`/`stringToBytes`/`encodeAbiParameters` (espejo de
 * deposit-verifier.test.ts). El verifier lee `process.env` para RPC / escrow
 * contract / confirmations, así que env se setea/limpia por test +
 * `_resetEscrowVerifier()`. Aserciones sobre `{ ok, reason }` (no substrings).
 */

import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  stringToBytes,
} from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import {
  _resetEscrowVerifier,
  resolveEscrowContract,
  verifyEscrowDeposit,
} from './escrow-verifier.js';
import type { AdaptersBundle, ChainKey, TokenSpec } from './types.js';

// ─── Fixtures ────────────────────────────────────────────────────────────
const ESCROW_KITE = '0x1111111111111111111111111111111111111111' as const;
const ESCROW_BASE = '0x7777777777777777777777777777777777777777' as const;
const OTHER_CONTRACT = '0x2222222222222222222222222222222222222222' as const;
const DEPOSITOR = '0x3333333333333333333333333333333333333333' as const;
const KITE_USDC = '0x4444444444444444444444444444444444444444' as `0x${string}`;
const BASE_USDC = '0x5555555555555555555555555555555555555555' as `0x${string}`;

const TX_HASH =
  '0xabc1230000000000000000000000000000000000000000000000000000000000' as `0x${string}`;

const KEY_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const KEY_ID_HASH = keccak256(stringToBytes(KEY_UUID));
const OTHER_KEY_ID_HASH = keccak256(stringToBytes('other-uuid'));

function topicAddr(addr: string): `0x${string}` {
  return `0x${'0'.repeat(24)}${addr.slice(2)}` as `0x${string}`;
}

// Deposited(address indexed depositor, bytes32 indexed keyId, uint256 amount)
function depositedLog(opts: {
  contract: `0x${string}`;
  depositor: string;
  keyId: `0x${string}`;
  amount: bigint;
}) {
  // CD-3: topic0 NO se hardcodea — viem lo deriva del ABI en el decode. Acá el
  // fixture replica el shape del log; el decode real valida que parseAbiItem
  // derive el mismo topic0 (test implícito de no-hardcode).
  return {
    address: opts.contract,
    topics: [
      keccak256(
        stringToBytes('Deposited(address,bytes32,uint256)'),
      ) as `0x${string}`,
      topicAddr(opts.depositor),
      opts.keyId,
    ] as [`0x${string}`, `0x${string}`, `0x${string}`],
    data: encodeAbiParameters(parseAbiParameters('uint256'), [opts.amount]),
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

describe('verifyEscrowDeposit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetEscrowVerifier();
    process.env = { ...ORIGINAL_ENV };
    process.env.KITE_RPC_URL = 'https://rpc.kite.test';
    process.env.BASE_TESTNET_RPC_URL = 'https://rpc.base.test';
    process.env.A2A_ESCROW_CONTRACT_KITE = ESCROW_KITE;
    process.env.A2A_ESCROW_CONTRACT_BASE = ESCROW_BASE;
    delete process.env.A2A_DEPOSIT_MIN_CONFIRMATIONS;
    delete process.env.A2A_DEPOSIT_MIN_CONFIRMATIONS_KITE;
    delete process.env.A2A_DEPOSIT_MIN_CONFIRMATIONS_BASE;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    _resetEscrowVerifier();
  });

  // ── AC-1 — verify OK (Kite 18 dec + Base 6 dec) ──
  it('returns ok with amountUsd/from/tokenSymbol — Kite 18 dec (AC-1)', async () => {
    setHappyChain(2368);
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [
        depositedLog({
          contract: ESCROW_KITE,
          depositor: DEPOSITOR,
          keyId: KEY_ID_HASH,
          amount: 10n * 10n ** 18n,
        }),
      ],
    });

    const res = await verifyEscrowDeposit({
      chainKey: 'kite-ozone-testnet' as ChainKey,
      bundle: KITE_BUNDLE,
      txHash: TX_HASH,
      keyIdHash: KEY_ID_HASH,
    });

    expect(res.ok).toBe(true);
    expect(res.amountUsd).toBe('10');
    expect(res.tokenSymbol).toBe('PYUSD');
    expect(res.from?.toLowerCase()).toBe(DEPOSITOR.toLowerCase());
    expect(res.confirmations).toBe(2);
  });

  it('returns ok — Base 6 dec (AC-1)', async () => {
    setHappyChain(84532);
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [
        depositedLog({
          contract: ESCROW_BASE,
          depositor: DEPOSITOR,
          keyId: KEY_ID_HASH,
          amount: 5n * 10n ** 6n,
        }),
      ],
    });

    const res = await verifyEscrowDeposit({
      chainKey: 'base-sepolia' as ChainKey,
      bundle: BASE_BUNDLE,
      txHash: TX_HASH,
      keyIdHash: KEY_ID_HASH,
    });

    expect(res.ok).toBe(true);
    expect(res.amountUsd).toBe('5');
  });

  // ── AC-2 — insufficient confirmations ──
  it('confirmations < min → INSUFFICIENT_CONFIRMATIONS (AC-2)', async () => {
    process.env.A2A_DEPOSIT_MIN_CONFIRMATIONS_KITE = '5';
    mockGetChainId.mockResolvedValue(2368);
    mockGetBlockNumber.mockResolvedValue(101n); // confirmations = 2 < 5
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [
        depositedLog({
          contract: ESCROW_KITE,
          depositor: DEPOSITOR,
          keyId: KEY_ID_HASH,
          amount: 10n * 10n ** 18n,
        }),
      ],
    });

    const res = await verifyEscrowDeposit({
      chainKey: 'kite-ozone-testnet' as ChainKey,
      bundle: KITE_BUNDLE,
      txHash: TX_HASH,
      keyIdHash: KEY_ID_HASH,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('INSUFFICIENT_CONFIRMATIONS');
  });

  // ── AC-10 / CD-10 — escrow contract not configured ──
  it('resolveEscrowContract resolves per A2A_ESCROW_CONTRACT_<FAMILY> (AC-10)', () => {
    process.env.A2A_ESCROW_CONTRACT_KITE = ESCROW_KITE;
    process.env.A2A_ESCROW_CONTRACT_AVALANCHE = OTHER_CONTRACT;
    process.env.A2A_ESCROW_CONTRACT_BASE = ESCROW_BASE;
    expect(resolveEscrowContract('kite-ozone-testnet' as ChainKey)).toBe(
      ESCROW_KITE,
    );
    expect(resolveEscrowContract('avalanche-fuji' as ChainKey)).toBe(
      OTHER_CONTRACT,
    );
    expect(resolveEscrowContract('base-sepolia' as ChainKey)).toBe(ESCROW_BASE);
  });

  it('escrow contract unset → ESCROW_CONTRACT_NOT_CONFIGURED, zero credit (AC-10/CD-10)', async () => {
    delete process.env.A2A_ESCROW_CONTRACT_KITE;
    expect(resolveEscrowContract('kite-ozone-testnet' as ChainKey)).toBeNull();

    const res = await verifyEscrowDeposit({
      chainKey: 'kite-ozone-testnet' as ChainKey,
      bundle: KITE_BUNDLE,
      txHash: TX_HASH,
      keyIdHash: KEY_ID_HASH,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('ESCROW_CONTRACT_NOT_CONFIGURED');
    // CD-3: NO fallback a OPERATOR_PRIVATE_KEY (a diferencia de resolveTreasury).
    process.env.OPERATOR_PRIVATE_KEY = `0x${'1'.repeat(64)}`;
    expect(resolveEscrowContract('kite-ozone-testnet' as ChainKey)).toBeNull();
  });

  // ── CD-10 — RPC down → RPC_UNAVAILABLE (→ 503 en el handler) ──
  it('RPC URL unset → RPC_UNAVAILABLE (CD-10)', async () => {
    delete process.env.KITE_RPC_URL;
    const res = await verifyEscrowDeposit({
      chainKey: 'kite-ozone-testnet' as ChainKey,
      bundle: KITE_BUNDLE,
      txHash: TX_HASH,
      keyIdHash: KEY_ID_HASH,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('RPC_UNAVAILABLE');
  });

  // ── reverted / not found ──
  it('reverted tx → TX_REVERTED', async () => {
    mockGetReceipt.mockResolvedValue({
      status: 'reverted',
      blockNumber: 100n,
      logs: [],
    });
    const res = await verifyEscrowDeposit({
      chainKey: 'kite-ozone-testnet' as ChainKey,
      bundle: KITE_BUNDLE,
      txHash: TX_HASH,
      keyIdHash: KEY_ID_HASH,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('TX_REVERTED');
  });

  it('receipt throws → TX_NOT_FOUND', async () => {
    mockGetReceipt.mockRejectedValue(new Error('not found'));
    const res = await verifyEscrowDeposit({
      chainKey: 'kite-ozone-testnet' as ChainKey,
      bundle: KITE_BUNDLE,
      txHash: TX_HASH,
      keyIdHash: KEY_ID_HASH,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('TX_NOT_FOUND');
  });

  it('on-chain chainId != bundle → CHAIN_MISMATCH', async () => {
    mockGetChainId.mockResolvedValue(999);
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [],
    });
    const res = await verifyEscrowDeposit({
      chainKey: 'kite-ozone-testnet' as ChainKey,
      bundle: KITE_BUNDLE,
      txHash: TX_HASH,
      keyIdHash: KEY_ID_HASH,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('CHAIN_MISMATCH');
  });

  // ── CD-8 — keyId mismatch / no event ──
  it('Deposited.keyId != keyIdHash → KEY_ID_MISMATCH (CD-8)', async () => {
    setHappyChain(2368);
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [
        depositedLog({
          contract: ESCROW_KITE,
          depositor: DEPOSITOR,
          keyId: OTHER_KEY_ID_HASH,
          amount: 10n * 10n ** 18n,
        }),
      ],
    });
    const res = await verifyEscrowDeposit({
      chainKey: 'kite-ozone-testnet' as ChainKey,
      bundle: KITE_BUNDLE,
      txHash: TX_HASH,
      keyIdHash: KEY_ID_HASH,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('KEY_ID_MISMATCH');
  });

  it('no Deposited log from escrow → DEPOSIT_EVENT_NOT_FOUND', async () => {
    setHappyChain(2368);
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [
        // log de OTRO contrato → ignorado por el filtro de address.
        depositedLog({
          contract: OTHER_CONTRACT,
          depositor: DEPOSITOR,
          keyId: KEY_ID_HASH,
          amount: 10n * 10n ** 18n,
        }),
      ],
    });
    const res = await verifyEscrowDeposit({
      chainKey: 'kite-ozone-testnet' as ChainKey,
      bundle: KITE_BUNDLE,
      txHash: TX_HASH,
      keyIdHash: KEY_ID_HASH,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('DEPOSIT_EVENT_NOT_FOUND');
  });

  // ── CD-8 — amount mismatch; credit always on-chain amount ──
  it('expectedAmountUsd != on-chain amount → AMOUNT_MISMATCH (CD-8)', async () => {
    setHappyChain(2368);
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [
        depositedLog({
          contract: ESCROW_KITE,
          depositor: DEPOSITOR,
          keyId: KEY_ID_HASH,
          amount: 10n * 10n ** 18n,
        }),
      ],
    });
    const res = await verifyEscrowDeposit({
      chainKey: 'kite-ozone-testnet' as ChainKey,
      bundle: KITE_BUNDLE,
      txHash: TX_HASH,
      keyIdHash: KEY_ID_HASH,
      expectedAmountUsd: '9.99', // != 10
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('AMOUNT_MISMATCH');
  });

  it('credits on-chain amount, ignoring matching body.amount (CD-8)', async () => {
    setHappyChain(2368);
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 100n,
      logs: [
        depositedLog({
          contract: ESCROW_KITE,
          depositor: DEPOSITOR,
          keyId: KEY_ID_HASH,
          amount: 10n * 10n ** 18n,
        }),
      ],
    });
    const res = await verifyEscrowDeposit({
      chainKey: 'kite-ozone-testnet' as ChainKey,
      bundle: KITE_BUNDLE,
      txHash: TX_HASH,
      keyIdHash: KEY_ID_HASH,
      expectedAmountUsd: '10',
    });
    expect(res.ok).toBe(true);
    expect(res.amountUsd).toBe('10'); // del evento on-chain, no de body
    expect(res.amountAtomic).toBe(10n * 10n ** 18n);
  });
});
