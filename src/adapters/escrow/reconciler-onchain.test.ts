/**
 * Reconciler on-chain reader — WKH-191c unit tests (T-1..T-4).
 *
 * Cubre: T-1 (Debited match → 'confirmed'), T-2 (success sin Debited / reverted →
 * 'not_confirmed'), T-3 (getTransactionReceipt throw / RPC ausente / txHash null →
 * 'indeterminate', NUNCA decide), T-4 (readEscrowBalanceAtomic OK→bigint / error→null).
 *
 * Mockea `createPublicClient` de viem preservando
 * `decodeEventLog`/`parseAbiItem`/`encodeAbiParameters`/`keccak256`/`stringToBytes`
 * (espejo de debit-executor.test.ts).
 */

import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  stringToBytes,
} from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetReceipt = vi.fn();
const mockReadContract = vi.fn();

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getTransactionReceipt: mockGetReceipt,
      readContract: mockReadContract,
    })),
  };
});

import {
  _resetReconcilerOnchain,
  readEscrowBalanceAtomic,
  reverifyDebitedByTxHash,
} from './reconciler-onchain.js';

const ESCROW = '0x7777777777777777777777777777777777777777' as `0x${string}`;
const OTHER_CONTRACT =
  '0x2222222222222222222222222222222222222222' as `0x${string}`;
const OPERATOR = '0x9999999999999999999999999999999999999999';
const TX_HASH =
  '0xabc1230000000000000000000000000000000000000000000000000000000000';

const KEY_ID_HASH = keccak256(stringToBytes('key-uuid'));
const OTHER_KEY_ID_HASH = keccak256(stringToBytes('other-uuid'));

const NONCE = 7n;

const ORIGINAL_ENV = { ...process.env };

function topicAddr(addr: string): `0x${string}` {
  return `0x${'0'.repeat(24)}${addr.slice(2)}` as `0x${string}`;
}

// Debited(bytes32 indexed keyId, address indexed operator, uint256 amount, uint256 nonce)
function debitedLog(opts: {
  contract: `0x${string}`;
  keyId: `0x${string}`;
  operator: string;
  amount: bigint;
  nonce: bigint;
}) {
  return {
    address: opts.contract,
    topics: [
      keccak256(
        stringToBytes('Debited(bytes32,address,uint256,uint256)'),
      ) as `0x${string}`,
      opts.keyId,
      topicAddr(opts.operator),
    ] as [`0x${string}`, `0x${string}`, `0x${string}`],
    data: encodeAbiParameters(parseAbiParameters('uint256, uint256'), [
      opts.amount,
      opts.nonce,
    ]),
  };
}

function baseArgs() {
  return {
    chainKey: 'base-sepolia' as const,
    escrowContract: ESCROW,
    txHash: TX_HASH,
    keyIdHash: KEY_ID_HASH,
    nonce: NONCE,
  };
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.BASE_TESTNET_RPC_URL = 'https://rpc.example/base-sepolia';
  vi.clearAllMocks();
  _resetReconcilerOnchain();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('reverifyDebitedByTxHash (WKH-191c on-chain re-verify)', () => {
  it('T-1: receipt success con Debited match (keyId+nonce) → confirmed', async () => {
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      logs: [
        debitedLog({
          contract: ESCROW,
          keyId: KEY_ID_HASH,
          operator: OPERATOR,
          amount: 1_500_000n,
          nonce: NONCE,
        }),
      ],
    });
    const result = await reverifyDebitedByTxHash(baseArgs());
    expect(result).toBe('confirmed');
  });

  it('T-2a: receipt success SIN Debited (logs de otra address / vacíos) → not_confirmed', async () => {
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      logs: [
        debitedLog({
          contract: OTHER_CONTRACT, // otra address → se ignora
          keyId: KEY_ID_HASH,
          operator: OPERATOR,
          amount: 1_500_000n,
          nonce: NONCE,
        }),
      ],
    });
    expect(await reverifyDebitedByTxHash(baseArgs())).toBe('not_confirmed');

    // Debited del escrow pero con OTRO keyId → tampoco matchea.
    mockGetReceipt.mockResolvedValue({
      status: 'success',
      logs: [
        debitedLog({
          contract: ESCROW,
          keyId: OTHER_KEY_ID_HASH,
          operator: OPERATOR,
          amount: 1_500_000n,
          nonce: NONCE,
        }),
      ],
    });
    expect(await reverifyDebitedByTxHash(baseArgs())).toBe('not_confirmed');
  });

  it('T-2b: receipt reverted → not_confirmed (el debit no ocurrió)', async () => {
    mockGetReceipt.mockResolvedValue({ status: 'reverted', logs: [] });
    expect(await reverifyDebitedByTxHash(baseArgs())).toBe('not_confirmed');
  });

  it('T-3a: getTransactionReceipt throw → indeterminate (NO decide)', async () => {
    mockGetReceipt.mockRejectedValue(new Error('RPC down'));
    expect(await reverifyDebitedByTxHash(baseArgs())).toBe('indeterminate');
  });

  it('T-3b: RPC ausente (sin RPC URL) → indeterminate', async () => {
    delete process.env.BASE_TESTNET_RPC_URL;
    _resetReconcilerOnchain();
    expect(await reverifyDebitedByTxHash(baseArgs())).toBe('indeterminate');
    // NUNCA llegó a consultar la cadena.
    expect(mockGetReceipt).not.toHaveBeenCalled();
  });

  it('T-3c: txHash null / sin 0x → indeterminate (huérfano sin hash, no asumir refund)', async () => {
    expect(await reverifyDebitedByTxHash({ ...baseArgs(), txHash: null })).toBe(
      'indeterminate',
    );
    expect(
      await reverifyDebitedByTxHash({ ...baseArgs(), txHash: 'deadbeef' }),
    ).toBe('indeterminate');
    expect(mockGetReceipt).not.toHaveBeenCalled();
  });
});

describe('readEscrowBalanceAtomic (WKH-191c drift source of truth)', () => {
  it('T-4a: readContract OK → bigint', async () => {
    mockReadContract.mockResolvedValue(4_200_000n);
    const bal = await readEscrowBalanceAtomic({
      chainKey: 'base-sepolia',
      escrowContract: ESCROW,
      keyIdHash: KEY_ID_HASH,
    });
    expect(bal).toBe(4_200_000n);
  });

  it('T-4b: readContract error → null (drift no-computable, no asumir 0)', async () => {
    mockReadContract.mockRejectedValue(new Error('RPC down'));
    const bal = await readEscrowBalanceAtomic({
      chainKey: 'base-sepolia',
      escrowContract: ESCROW,
      keyIdHash: KEY_ID_HASH,
    });
    expect(bal).toBeNull();
  });

  it('T-4c: RPC ausente → null', async () => {
    delete process.env.BASE_TESTNET_RPC_URL;
    _resetReconcilerOnchain();
    const bal = await readEscrowBalanceAtomic({
      chainKey: 'base-sepolia',
      escrowContract: ESCROW,
      keyIdHash: KEY_ID_HASH,
    });
    expect(bal).toBeNull();
    expect(mockReadContract).not.toHaveBeenCalled();
  });
});
