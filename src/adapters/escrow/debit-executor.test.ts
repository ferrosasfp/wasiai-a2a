/**
 * Debit executor (hop 1) — WKH-191b unit tests.
 *
 * Cubre: T-8 (confirmations pasado + `Debited` no encontrado → ambiguous),
 * T-11 (receipt reverted → not_moved → fallback; money-safe), + happy
 * (Debited matcheado → confirmed), pre-broadcast (writeContract throw →
 * not_moved), receipt timeout → ambiguous, y sin PK/RPC → not_moved.
 *
 * Mockea `createWalletClient`/`createPublicClient` de viem preservando
 * `decodeEventLog`/`parseAbiItem`/`encodeAbiParameters`/`keccak256`/`stringToBytes`
 * (espejo de escrow-verifier.test.ts). `privateKeyToAccount` real (viem/accounts).
 */

import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  stringToBytes,
  WaitForTransactionReceiptTimeoutError,
} from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockWriteContract = vi.fn();
const mockWaitForReceipt = vi.fn();

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createWalletClient: vi.fn(() => ({
      account: { address: '0x9999999999999999999999999999999999999999' },
      writeContract: mockWriteContract,
    })),
    createPublicClient: vi.fn(() => ({
      waitForTransactionReceipt: mockWaitForReceipt,
    })),
  };
});

vi.mock('../../lib/supabase.js', () => ({
  supabase: { rpc: vi.fn() },
}));

import { supabase } from '../../lib/supabase.js';
import {
  _resetDebitExecutor,
  executeDebitHop1,
  getEscrowReceiptTimeoutMs,
  recordDebitHop1,
  recordDebitSettleStatus,
} from './debit-executor.js';

const mockRpc = vi.mocked(supabase.rpc);

const ESCROW = '0x7777777777777777777777777777777777777777' as `0x${string}`;
const OTHER_CONTRACT =
  '0x2222222222222222222222222222222222222222' as `0x${string}`;
const OPERATOR = '0x9999999999999999999999999999999999999999';
const TX_HASH =
  '0xabc1230000000000000000000000000000000000000000000000000000000000' as `0x${string}`;

const KEY_ID_HASH = keccak256(stringToBytes('key-uuid'));
const OTHER_KEY_ID_HASH = keccak256(stringToBytes('other-uuid'));

const AMOUNT = 1_500_000n;
const DEADLINE = 9_999_999_999n;
const NONCE = 7n;
const SIGNATURE = `0x${'ab'.repeat(65)}`;

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
    keyIdHash: KEY_ID_HASH,
    amount: AMOUNT,
    deadline: DEADLINE,
    nonce: NONCE,
    signature: SIGNATURE,
  };
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  // PK válido + RPC → clients se construyen (el executor no cae a not_moved).
  process.env.OPERATOR_PRIVATE_KEY = `0x${'1'.repeat(64)}`;
  process.env.BASE_TESTNET_RPC_URL = 'https://rpc.example/base-sepolia';
  vi.clearAllMocks();
  _resetDebitExecutor();
  mockWriteContract.mockResolvedValue(TX_HASH);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetDebitExecutor();
});

// ── happy: Debited matcheado → confirmed ──
describe('happy path — Debited matcheado → confirmed', () => {
  it('receipt success + Debited(keyId,nonce) → { kind: confirmed }', async () => {
    mockWaitForReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 42n,
      logs: [
        debitedLog({
          contract: ESCROW,
          keyId: KEY_ID_HASH,
          operator: OPERATOR,
          amount: AMOUNT,
          nonce: NONCE,
        }),
      ],
    });

    const out = await executeDebitHop1(baseArgs());
    expect(out.kind).toBe('confirmed');
    if (out.kind === 'confirmed') {
      expect(out.txHash).toBe(TX_HASH);
      expect(out.blockNumber).toBe(42n);
    }
  });
});

// ── T-8: confirmations pasado + Debited no encontrado → ambiguous ──
describe('T-8 confirmations + DEBITED_EVENT_NOT_FOUND (CD-8/§6)', () => {
  it('waitForTransactionReceipt recibe confirmations=resolveMinConfirmations; sin Debited → ambiguous', async () => {
    // receipt success pero SIN ningún log Debited del escrow.
    mockWaitForReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 42n,
      logs: [],
    });

    const out = await executeDebitHop1(baseArgs());

    // CD-8: confirmations pasado explícitamente (base-sepolia default = 1).
    expect(mockWaitForReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ hash: TX_HASH, confirmations: 1 }),
    );
    expect(out.kind).toBe('ambiguous');
    if (out.kind === 'ambiguous') {
      expect(out.reason).toBe('DEBITED_EVENT_NOT_FOUND');
      expect(out.txHash).toBe(TX_HASH);
    }
  });

  it('Debited de OTRO keyId (log del escrow) → sigue ambiguous (no matchea)', async () => {
    mockWaitForReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 42n,
      logs: [
        debitedLog({
          contract: ESCROW,
          keyId: OTHER_KEY_ID_HASH,
          operator: OPERATOR,
          amount: AMOUNT,
          nonce: NONCE,
        }),
      ],
    });

    const out = await executeDebitHop1(baseArgs());
    expect(out.kind).toBe('ambiguous');
    if (out.kind === 'ambiguous') {
      expect(out.reason).toBe('DEBITED_EVENT_NOT_FOUND');
    }
  });

  it('Debited emitido por OTRO contrato (no el escrow) → ambiguous', async () => {
    mockWaitForReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 42n,
      logs: [
        debitedLog({
          contract: OTHER_CONTRACT,
          keyId: KEY_ID_HASH,
          operator: OPERATOR,
          amount: AMOUNT,
          nonce: NONCE,
        }),
      ],
    });

    const out = await executeDebitHop1(baseArgs());
    expect(out.kind).toBe('ambiguous');
  });
});

// ── T-11: receipt reverted → not_moved → fallback (money-safe) ──
describe('T-11 receipt reverted → not_moved (R-2, money-safe)', () => {
  it('receipt status=reverted (p.ej. NonceAlreadyUsed) → { kind: not_moved, REVERTED }', async () => {
    // R-2: si hop 1 revierte, el operador NO recibió fondos (o el retry revierte por
    // NonceAlreadyUsed y nets zero). settleEscrowAware cae al seam operador-custodial.
    mockWaitForReceipt.mockResolvedValue({
      status: 'reverted',
      blockNumber: 42n,
      logs: [],
    });

    const out = await executeDebitHop1(baseArgs());
    expect(out.kind).toBe('not_moved');
    if (out.kind === 'not_moved') {
      expect(out.reason).toBe('REVERTED');
      expect(out.txHash).toBe(TX_HASH);
    }
  });
});

// ── pre-broadcast: writeContract lanza → not_moved (AC-3) ──
describe('writeContract lanza (pre-broadcast) → not_moved (AC-3)', () => {
  it('el submit lanza → { kind: not_moved, WRITE_FAILED } sin txHash', async () => {
    mockWriteContract.mockRejectedValue(new Error('nonce too low'));

    const out = await executeDebitHop1(baseArgs());
    expect(out.kind).toBe('not_moved');
    if (out.kind === 'not_moved') {
      expect(out.reason).toBe('WRITE_FAILED');
      expect(out.txHash).toBeUndefined();
    }
    expect(mockWaitForReceipt).not.toHaveBeenCalled();
  });
});

// ── receipt timeout → ambiguous (la tx PUDO minarse) ──
describe('receipt timeout → ambiguous (CD-8)', () => {
  it('waitForTransactionReceipt lanza timeout → { kind: ambiguous, RECEIPT_TIMEOUT, txHash }', async () => {
    mockWaitForReceipt.mockRejectedValue(
      new WaitForTransactionReceiptTimeoutError({ hash: TX_HASH }),
    );

    const out = await executeDebitHop1(baseArgs());
    expect(out.kind).toBe('ambiguous');
    if (out.kind === 'ambiguous') {
      expect(out.reason).toBe('RECEIPT_TIMEOUT');
      expect(out.txHash).toBe(TX_HASH);
    }
  });
});

// ── sin PK / sin RPC → not_moved (nunca lanza) ──
describe('sin PK / sin RPC → not_moved OPERATOR_KEY_OR_RPC_UNSET', () => {
  it('OPERATOR_PRIVATE_KEY ausente → not_moved sin tocar la cadena', async () => {
    delete process.env.OPERATOR_PRIVATE_KEY;
    _resetDebitExecutor();

    const out = await executeDebitHop1(baseArgs());
    expect(out.kind).toBe('not_moved');
    if (out.kind === 'not_moved') {
      expect(out.reason).toBe('OPERATOR_KEY_OR_RPC_UNSET');
    }
    expect(mockWriteContract).not.toHaveBeenCalled();
  });

  it('RPC url ausente → not_moved', async () => {
    delete process.env.BASE_TESTNET_RPC_URL;
    _resetDebitExecutor();

    const out = await executeDebitHop1(baseArgs());
    expect(out.kind).toBe('not_moved');
    expect(mockWriteContract).not.toHaveBeenCalled();
  });
});

// ── getEscrowReceiptTimeoutMs — env parse ──
describe('getEscrowReceiptTimeoutMs', () => {
  it('default 60000; env válido >0 override; inválido → default', () => {
    delete process.env.ESCROW_DEBIT_RECEIPT_TIMEOUT_MS;
    expect(getEscrowReceiptTimeoutMs()).toBe(60_000);
    process.env.ESCROW_DEBIT_RECEIPT_TIMEOUT_MS = '90000';
    expect(getEscrowReceiptTimeoutMs()).toBe(90_000);
    process.env.ESCROW_DEBIT_RECEIPT_TIMEOUT_MS = '0';
    expect(getEscrowReceiptTimeoutMs()).toBe(60_000);
    process.env.ESCROW_DEBIT_RECEIPT_TIMEOUT_MS = 'nope';
    expect(getEscrowReceiptTimeoutMs()).toBe(60_000);
  });
});

// ── recordDebitHop1 wrapper — invoca el RPC con los args exactos (p_nonce string) ──
// Reemplaza el placeholder tautológico de debit-capture.test.ts:543 (CR MNR-1).
// El wrapper es la superficie testeable; la idempotencia COALESCE real vive en el
// SQL de la migración (integración, no simulable acá sin Postgres).
describe('recordDebitHop1 wrapper (CD-3/BLQ-DR) — llama record_debit_hop1', () => {
  const WRAP_ARGS = {
    intentId: 'intent-1',
    ownerRef: 'tenant-A',
    keyId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    nonce: '7',
    txHash: TX_HASH,
  };

  it('invoca el RPC con p_intent_id/p_owner_ref/p_key_id/p_nonce(string)/p_tx_hash', async () => {
    mockRpc.mockResolvedValue({
      data: [{ persisted_tx_hash: TX_HASH }],
      error: null,
      // biome-ignore lint/suspicious/noExplicitAny: supabase rpc test double
    } as any);

    const persisted = await recordDebitHop1(WRAP_ARGS);

    expect(mockRpc).toHaveBeenCalledWith('record_debit_hop1', {
      p_intent_id: 'intent-1',
      p_owner_ref: 'tenant-A',
      p_key_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      p_nonce: '7', // NUMERIC uint256 → string (CD-S1), nunca Number
      p_tx_hash: TX_HASH,
    });
    // p_nonce viaja como string, no coerción numérica.
    const rpcArgs = mockRpc.mock.calls[0]?.[1] as { p_nonce: unknown };
    expect(typeof rpcArgs.p_nonce).toBe('string');
    expect(persisted).toBe(TX_HASH);
  });

  it('idempotencia: un 2º call que devuelve el hash existente (COALESCE) → retorna ese hash', async () => {
    // La 1ª escritura gana en el RPC (COALESCE del SQL). Simulamos el retorno: el
    // wrapper propaga el persisted_tx_hash EFECTIVO de la fila, no un nuevo hash.
    const EXISTING = TX_HASH;
    mockRpc.mockResolvedValue({
      data: [{ persisted_tx_hash: EXISTING }],
      error: null,
      // biome-ignore lint/suspicious/noExplicitAny: supabase rpc test double
    } as any);

    const persisted = await recordDebitHop1({
      ...WRAP_ARGS,
      // un retry pasa un tx tentativo distinto; el RPC devuelve el existente.
      txHash:
        '0xdead000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
    });

    expect(persisted).toBe(EXISTING);
  });

  it('RPC sin filas (data null/empty) → retorna null', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: null,
      // biome-ignore lint/suspicious/noExplicitAny: supabase rpc test double
    } as any);

    expect(await recordDebitHop1(WRAP_ARGS)).toBeNull();
  });
});

// ── recordDebitSettleStatus wrapper — flip terminal del ciclo de vida ──
describe('recordDebitSettleStatus wrapper — llama record_debit_settle_status', () => {
  it('invoca el RPC con p_status y p_nonce(string)', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: null,
      // biome-ignore lint/suspicious/noExplicitAny: supabase rpc test double
    } as any);

    await recordDebitSettleStatus({
      intentId: 'intent-1',
      ownerRef: 'tenant-A',
      keyId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      nonce: '7',
      status: 'reconciliation_pending',
    });

    expect(mockRpc).toHaveBeenCalledWith('record_debit_settle_status', {
      p_intent_id: 'intent-1',
      p_owner_ref: 'tenant-A',
      p_key_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      p_nonce: '7',
      p_status: 'reconciliation_pending',
    });
    const rpcArgs = mockRpc.mock.calls[0]?.[1] as { p_nonce: unknown };
    expect(typeof rpcArgs.p_nonce).toBe('string');
  });
});
