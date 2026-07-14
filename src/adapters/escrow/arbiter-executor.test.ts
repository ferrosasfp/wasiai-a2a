/**
 * Arbiter executor — WKH-191g unit tests (espejo de debit-executor.test.ts).
 *
 * Cubre §8: resolveDispute happy (evento+nonce matcheado → confirmed), revert →
 * not_moved, timeout → ambiguous, receipt-success sin evento → ambiguous, sin
 * ARBITER_PRIVATE_KEY/RPC → not_moved (nunca lanza), writeContract throw →
 * not_moved, idempotencia (2ª resolve mismo nonce → revert NonceAlreadyUsed →
 * not_moved), lock/release happy+revert, y deriveArbiterNonce (bit 255, determinismo,
 * unicidad, rango disjunto).
 *
 * Mockea `createWalletClient`/`createPublicClient` de viem preservando
 * `decodeEventLog`/`parseAbiItem`/`encodeAbiParameters`/`keccak256`/`stringToBytes`/
 * `encodePacked`. `privateKeyToAccount` real (viem/accounts).
 */

import {
  BaseError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  stringToBytes,
  WaitForTransactionReceiptTimeoutError,
} from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ESCROW_ABI } from './abi.js';

const mockWriteContract = vi.fn();
const mockWaitForReceipt = vi.fn();
const mockSimulateContract = vi.fn();

// WKH-194: capturamos las llamadas a log.warn para verificar (T3/CD-2) que el
// secreto NUNCA se loguea — sólo flags booleanos present/weak. vi.hoisted evita
// el TDZ: el factory de vi.mock (hoisteado) referencia mockLogWarn.
const { mockLogWarn } = vi.hoisted(() => ({ mockLogWarn: vi.fn() }));
vi.mock('../../lib/logger.js', () => ({
  getLogger: () => ({
    warn: mockLogWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

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
      simulateContract: mockSimulateContract,
    })),
  };
});

import {
  _resetArbiterExecutor,
  ARBITER_NONCE_COLLISION_REASON,
  deriveArbiterNonce,
  executeLockForDispute,
  executeReleaseDispute,
  executeResolveDispute,
  getArbiterNonceSecret,
} from './arbiter-executor.js';

// WKH-194: secreto de test (≥32 chars) para las llamadas de deriveArbiterNonce.
const TEST_SECRET = 'x'.repeat(64);

const ESCROW = '0x7777777777777777777777777777777777777777' as `0x${string}`;
const OTHER_CONTRACT =
  '0x2222222222222222222222222222222222222222' as `0x${string}`;
const ARBITER = '0x9999999999999999999999999999999999999999';
const SELLER = '0x3333333333333333333333333333333333333333';
const TX_HASH =
  '0xabc1230000000000000000000000000000000000000000000000000000000000' as `0x${string}`;

const KEY_ID_HASH = keccak256(stringToBytes('key-uuid'));
const OTHER_KEY_ID_HASH = keccak256(stringToBytes('other-uuid'));

const SELLER_AMOUNT = 1_500_000n;
const NONCE = deriveArbiterNonce(KEY_ID_HASH, 'intent-1', TEST_SECRET);

const ORIGINAL_ENV = { ...process.env };

function topicAddr(addr: string): `0x${string}` {
  return `0x${'0'.repeat(24)}${addr.slice(2)}` as `0x${string}`;
}

// DisputeResolved(bytes32 indexed keyId, address indexed arbiter, address indexed seller, uint256 sellerAmount, uint256 nonce)
function resolvedLog(opts: {
  contract: `0x${string}`;
  keyId: `0x${string}`;
  arbiter: string;
  seller: string;
  sellerAmount: bigint;
  nonce: bigint;
}) {
  return {
    address: opts.contract,
    topics: [
      keccak256(
        stringToBytes(
          'DisputeResolved(bytes32,address,address,uint256,uint256)',
        ),
      ) as `0x${string}`,
      opts.keyId,
      topicAddr(opts.arbiter),
      topicAddr(opts.seller),
    ] as [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`],
    data: encodeAbiParameters(parseAbiParameters('uint256, uint256'), [
      opts.sellerAmount,
      opts.nonce,
    ]),
  };
}

// DisputeLocked(bytes32 indexed keyId, address indexed arbiter, uint256 amount, uint256 totalLocked)
function lockedLog(opts: {
  contract: `0x${string}`;
  keyId: `0x${string}`;
  arbiter: string;
  amount: bigint;
  totalLocked: bigint;
}) {
  return {
    address: opts.contract,
    topics: [
      keccak256(
        stringToBytes('DisputeLocked(bytes32,address,uint256,uint256)'),
      ) as `0x${string}`,
      opts.keyId,
      topicAddr(opts.arbiter),
    ] as [`0x${string}`, `0x${string}`, `0x${string}`],
    data: encodeAbiParameters(parseAbiParameters('uint256, uint256'), [
      opts.amount,
      opts.totalLocked,
    ]),
  };
}

// DisputeReleased(bytes32 indexed keyId, address indexed arbiter, uint256 releasedAmount)
function releasedLog(opts: {
  contract: `0x${string}`;
  keyId: `0x${string}`;
  arbiter: string;
  releasedAmount: bigint;
}) {
  return {
    address: opts.contract,
    topics: [
      keccak256(
        stringToBytes('DisputeReleased(bytes32,address,uint256)'),
      ) as `0x${string}`,
      opts.keyId,
      topicAddr(opts.arbiter),
    ] as [`0x${string}`, `0x${string}`, `0x${string}`],
    data: encodeAbiParameters(parseAbiParameters('uint256'), [
      opts.releasedAmount,
    ]),
  };
}

function resolveArgs() {
  return {
    chainKey: 'base-sepolia' as const,
    escrowContract: ESCROW,
    keyIdHash: KEY_ID_HASH,
    seller: SELLER,
    sellerAmount: SELLER_AMOUNT,
    nonce: NONCE,
  };
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.ARBITER_PRIVATE_KEY = `0x${'1'.repeat(64)}`;
  process.env.BASE_TESTNET_RPC_URL = 'https://rpc.example/base-sepolia';
  vi.clearAllMocks();
  _resetArbiterExecutor();
  mockWriteContract.mockResolvedValue(TX_HASH);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetArbiterExecutor();
});

// ── executeResolveDispute happy → confirmed ──
describe('executeResolveDispute — DisputeResolved(keyId,nonce) → confirmed', () => {
  it('receipt success + evento matcheado (keyId Y nonce) → confirmed', async () => {
    mockWaitForReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 42n,
      logs: [
        resolvedLog({
          contract: ESCROW,
          keyId: KEY_ID_HASH,
          arbiter: ARBITER,
          seller: SELLER,
          sellerAmount: SELLER_AMOUNT,
          nonce: NONCE,
        }),
      ],
    });

    const out = await executeResolveDispute(resolveArgs());
    expect(out.kind).toBe('confirmed');
    if (out.kind === 'confirmed') {
      expect(out.txHash).toBe(TX_HASH);
      expect(out.blockNumber).toBe(42n);
    }
  });

  it('evento con nonce distinto (mismo keyId) → ambiguous (no matchea)', async () => {
    mockWaitForReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 42n,
      logs: [
        resolvedLog({
          contract: ESCROW,
          keyId: KEY_ID_HASH,
          arbiter: ARBITER,
          seller: SELLER,
          sellerAmount: SELLER_AMOUNT,
          nonce: NONCE + 1n,
        }),
      ],
    });

    const out = await executeResolveDispute(resolveArgs());
    expect(out.kind).toBe('ambiguous');
    if (out.kind === 'ambiguous') {
      expect(out.reason).toBe('DISPUTE_RESOLVED_NOT_FOUND');
    }
  });
});

// ── revert → not_moved ──
describe('executeResolveDispute — revert → not_moved (money-safe)', () => {
  it('receipt status=reverted → { not_moved, REVERTED }', async () => {
    mockWaitForReceipt.mockResolvedValue({
      status: 'reverted',
      blockNumber: 42n,
      logs: [],
    });

    const out = await executeResolveDispute(resolveArgs());
    expect(out.kind).toBe('not_moved');
    if (out.kind === 'not_moved') {
      expect(out.reason).toBe('REVERTED');
      expect(out.txHash).toBe(TX_HASH);
    }
  });
});

// ── timeout → ambiguous ──
describe('executeResolveDispute — receipt timeout → ambiguous', () => {
  it('waitForTransactionReceipt lanza timeout → { ambiguous, RECEIPT_TIMEOUT, txHash }', async () => {
    mockWaitForReceipt.mockRejectedValue(
      new WaitForTransactionReceiptTimeoutError({ hash: TX_HASH }),
    );

    const out = await executeResolveDispute(resolveArgs());
    expect(out.kind).toBe('ambiguous');
    if (out.kind === 'ambiguous') {
      expect(out.reason).toBe('RECEIPT_TIMEOUT');
      expect(out.txHash).toBe(TX_HASH);
    }
  });
});

// ── receipt success sin evento → ambiguous ──
describe('executeResolveDispute — receipt success sin evento → ambiguous', () => {
  it('logs vacíos → { ambiguous, DISPUTE_RESOLVED_NOT_FOUND }', async () => {
    mockWaitForReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 42n,
      logs: [],
    });

    const out = await executeResolveDispute(resolveArgs());
    expect(out.kind).toBe('ambiguous');
    if (out.kind === 'ambiguous') {
      expect(out.reason).toBe('DISPUTE_RESOLVED_NOT_FOUND');
      expect(out.txHash).toBe(TX_HASH);
    }
  });

  it('DisputeResolved de OTRO contrato → ambiguous', async () => {
    mockWaitForReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 42n,
      logs: [
        resolvedLog({
          contract: OTHER_CONTRACT,
          keyId: KEY_ID_HASH,
          arbiter: ARBITER,
          seller: SELLER,
          sellerAmount: SELLER_AMOUNT,
          nonce: NONCE,
        }),
      ],
    });

    const out = await executeResolveDispute(resolveArgs());
    expect(out.kind).toBe('ambiguous');
  });

  it('DisputeResolved de OTRO keyId → ambiguous', async () => {
    mockWaitForReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 42n,
      logs: [
        resolvedLog({
          contract: ESCROW,
          keyId: OTHER_KEY_ID_HASH,
          arbiter: ARBITER,
          seller: SELLER,
          sellerAmount: SELLER_AMOUNT,
          nonce: NONCE,
        }),
      ],
    });

    const out = await executeResolveDispute(resolveArgs());
    expect(out.kind).toBe('ambiguous');
  });
});

// ── sin ARBITER_PRIVATE_KEY / sin RPC → not_moved (nunca lanza) ──
describe('executeResolveDispute — sin ARBITER_PRIVATE_KEY / RPC → not_moved', () => {
  it('ARBITER_PRIVATE_KEY ausente → not_moved ARBITER_KEY_OR_RPC_UNSET, sin tocar cadena', async () => {
    delete process.env.ARBITER_PRIVATE_KEY;
    _resetArbiterExecutor();

    const out = await executeResolveDispute(resolveArgs());
    expect(out.kind).toBe('not_moved');
    if (out.kind === 'not_moved') {
      expect(out.reason).toBe('ARBITER_KEY_OR_RPC_UNSET');
    }
    expect(mockWriteContract).not.toHaveBeenCalled();
  });

  it('no reusa OPERATOR_PRIVATE_KEY: con solo OPERATOR seteado → not_moved (CD-5)', async () => {
    delete process.env.ARBITER_PRIVATE_KEY;
    process.env.OPERATOR_PRIVATE_KEY = `0x${'2'.repeat(64)}`;
    _resetArbiterExecutor();

    const out = await executeResolveDispute(resolveArgs());
    expect(out.kind).toBe('not_moved');
    expect(mockWriteContract).not.toHaveBeenCalled();
  });

  it('RPC url ausente → not_moved', async () => {
    delete process.env.BASE_TESTNET_RPC_URL;
    _resetArbiterExecutor();

    const out = await executeResolveDispute(resolveArgs());
    expect(out.kind).toBe('not_moved');
    expect(mockWriteContract).not.toHaveBeenCalled();
  });
});

// ── writeContract throw pre-broadcast → not_moved ──
describe('executeResolveDispute — writeContract throw → not_moved (WRITE_FAILED)', () => {
  it('el submit lanza → { not_moved, WRITE_FAILED } sin txHash', async () => {
    mockWriteContract.mockRejectedValue(new Error('nonce too low'));

    const out = await executeResolveDispute(resolveArgs());
    expect(out.kind).toBe('not_moved');
    if (out.kind === 'not_moved') {
      expect(out.reason).toBe('WRITE_FAILED');
      expect(out.txHash).toBeUndefined();
    }
    expect(mockWaitForReceipt).not.toHaveBeenCalled();
  });
});

// ── idempotencia: 2ª resolve mismo nonce → revert NonceAlreadyUsed → not_moved ──
describe('executeResolveDispute — idempotencia (mismo nonce → NonceAlreadyUsed revert)', () => {
  it('2ª ejecución con el MISMO nonce revierte → not_moved (exactly-once)', async () => {
    // 1ª: confirmada.
    mockWaitForReceipt.mockResolvedValueOnce({
      status: 'success',
      blockNumber: 42n,
      logs: [
        resolvedLog({
          contract: ESCROW,
          keyId: KEY_ID_HASH,
          arbiter: ARBITER,
          seller: SELLER,
          sellerAmount: SELLER_AMOUNT,
          nonce: NONCE,
        }),
      ],
    });
    const first = await executeResolveDispute(resolveArgs());
    expect(first.kind).toBe('confirmed');

    // 2ª con el MISMO nonce derivado: el guard on-chain NonceAlreadyUsed revierte.
    mockWaitForReceipt.mockResolvedValueOnce({
      status: 'reverted',
      blockNumber: 43n,
      logs: [],
    });
    const second = await executeResolveDispute(resolveArgs());
    expect(second.kind).toBe('not_moved');
    if (second.kind === 'not_moved') expect(second.reason).toBe('REVERTED');
  });
});

// ── executeLockForDispute happy + revert ──
describe('executeLockForDispute', () => {
  function lockArgs() {
    return {
      chainKey: 'base-sepolia' as const,
      escrowContract: ESCROW,
      keyIdHash: KEY_ID_HASH,
      amount: SELLER_AMOUNT,
    };
  }

  it('DisputeLocked(keyId) matcheado → confirmed', async () => {
    mockWaitForReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 7n,
      logs: [
        lockedLog({
          contract: ESCROW,
          keyId: KEY_ID_HASH,
          arbiter: ARBITER,
          amount: SELLER_AMOUNT,
          totalLocked: SELLER_AMOUNT,
        }),
      ],
    });
    const out = await executeLockForDispute(lockArgs());
    expect(out.kind).toBe('confirmed');
  });

  it('revert → not_moved REVERTED', async () => {
    mockWaitForReceipt.mockResolvedValue({
      status: 'reverted',
      blockNumber: 7n,
      logs: [],
    });
    const out = await executeLockForDispute(lockArgs());
    expect(out.kind).toBe('not_moved');
    if (out.kind === 'not_moved') expect(out.reason).toBe('REVERTED');
  });

  it('receipt success sin evento → ambiguous DISPUTE_LOCKED_NOT_FOUND', async () => {
    mockWaitForReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 7n,
      logs: [],
    });
    const out = await executeLockForDispute(lockArgs());
    expect(out.kind).toBe('ambiguous');
    if (out.kind === 'ambiguous') {
      expect(out.reason).toBe('DISPUTE_LOCKED_NOT_FOUND');
    }
  });
});

// ── executeReleaseDispute happy + revert ──
describe('executeReleaseDispute', () => {
  function releaseArgs() {
    return {
      chainKey: 'base-sepolia' as const,
      escrowContract: ESCROW,
      keyIdHash: KEY_ID_HASH,
    };
  }

  it('DisputeReleased(keyId) matcheado → confirmed', async () => {
    mockWaitForReceipt.mockResolvedValue({
      status: 'success',
      blockNumber: 9n,
      logs: [
        releasedLog({
          contract: ESCROW,
          keyId: KEY_ID_HASH,
          arbiter: ARBITER,
          releasedAmount: SELLER_AMOUNT,
        }),
      ],
    });
    const out = await executeReleaseDispute(releaseArgs());
    expect(out.kind).toBe('confirmed');
  });

  it('revert → not_moved REVERTED', async () => {
    mockWaitForReceipt.mockResolvedValue({
      status: 'reverted',
      blockNumber: 9n,
      logs: [],
    });
    const out = await executeReleaseDispute(releaseArgs());
    expect(out.kind).toBe('not_moved');
    if (out.kind === 'not_moved') expect(out.reason).toBe('REVERTED');
  });
});

// ── deriveArbiterNonce — pura, disjunta, determinista (con secreto, WKH-194) ──
describe('deriveArbiterNonce (CD-3/§7 + WKH-194 secreto)', () => {
  // T1 · bit-255 con secreto (AC-4)
  it('(a) T1 · bit 255 SIEMPRE seteado (con secreto)', () => {
    const n = deriveArbiterNonce(KEY_ID_HASH, 'intent-1', TEST_SECRET);
    expect((n >> 255n) & 1n).toBe(1n);
    expect(n >= 2n ** 255n).toBe(true);
  });

  it('(b) determinista: 2 llamadas iguales (mismo secreto) → mismo nonce', () => {
    const a = deriveArbiterNonce(KEY_ID_HASH, 'intent-xyz', TEST_SECRET);
    const b = deriveArbiterNonce(KEY_ID_HASH, 'intent-xyz', TEST_SECRET);
    expect(a).toBe(b);
  });

  it('(c) distinto para (keyId,intentId) distinto', () => {
    const a = deriveArbiterNonce(KEY_ID_HASH, 'intent-a', TEST_SECRET);
    const b = deriveArbiterNonce(KEY_ID_HASH, 'intent-b', TEST_SECRET);
    const c = deriveArbiterNonce(OTHER_KEY_ID_HASH, 'intent-a', TEST_SECRET);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('(d) rango disjunto: >= 2^255 (nunca colisiona con nonce de debit de muestra)', () => {
    const n = deriveArbiterNonce(KEY_ID_HASH, 'intent-1', TEST_SECRET);
    expect(n >= 2n ** 255n).toBe(true);
    expect(n < 2n ** 256n).toBe(true);
    // nonces de debit honestos viven en [0, 2^255) — p.ej. 7n
    expect(n).not.toBe(7n);
  });

  // T2 · no-re-derivable / pura (AC-5/CD-2): secreto DISTINTO → nonce DISTINTO.
  it('(e) T2 · secreto distinto (mismos inputs públicos) → nonce distinto (no re-derivable)', () => {
    const same1 = deriveArbiterNonce(KEY_ID_HASH, 'intent-1', TEST_SECRET);
    const same2 = deriveArbiterNonce(KEY_ID_HASH, 'intent-1', TEST_SECRET);
    expect(same1).toBe(same2); // pura dado el secreto
    const withA = deriveArbiterNonce(KEY_ID_HASH, 'intent-1', 'a'.repeat(64));
    const withB = deriveArbiterNonce(KEY_ID_HASH, 'intent-1', 'b'.repeat(64));
    // Un buyer con keyId+intentId públicos pero SIN el secreto no puede reproducirlo.
    expect(withA).not.toBe(withB);
    expect(withA).not.toBe(same1);
  });
});

// ── T3 · getArbiterNonceSecret — fail-closed + CD-2 (nunca loguea el valor) ──
describe('getArbiterNonceSecret (T3 · AC-3/CD-2/CD-3)', () => {
  // Espeja `openssl rand -hex 32`: 64 chars sobre el alfabeto [0-9a-f] (16 únicos).
  const HEX_RANDOM = '0123456789abcdef'.repeat(4); // 64 chars, 16 caracteres únicos

  it('undefined/""/whitespace/<32 chars → null; hex-random (alta entropía) → el string', () => {
    delete process.env.ARBITER_NONCE_SECRET;
    expect(getArbiterNonceSecret()).toBeNull();

    process.env.ARBITER_NONCE_SECRET = '';
    expect(getArbiterNonceSecret()).toBeNull();

    process.env.ARBITER_NONCE_SECRET = '   ';
    expect(getArbiterNonceSecret()).toBeNull();

    process.env.ARBITER_NONCE_SECRET = 'short'; // <32
    expect(getArbiterNonceSecret()).toBeNull();

    // Alta entropía (≥32 chars y ≥16 caracteres únicos) → aceptado.
    process.env.ARBITER_NONCE_SECRET = HEX_RANDOM;
    expect(getArbiterNonceSecret()).toBe(HEX_RANDOM);
  });

  it('AR MNR-1: secreto ≥32 chars pero de BAJA entropía → null (weak)', () => {
    // Trivial: 32 chars idénticos (1 carácter único) → crackeable offline desde
    // el nonce público → debe tratarse como weak (fallback fail-closed).
    process.env.ARBITER_NONCE_SECRET = 'a'.repeat(32);
    expect(getArbiterNonceSecret()).toBeNull();

    // Secuencia repetida corta: '12'*16 = 32 chars, 2 caracteres únicos → weak.
    process.env.ARBITER_NONCE_SECRET = '12'.repeat(16);
    expect(getArbiterNonceSecret()).toBeNull();

    // Justo por debajo del umbral: 15 caracteres únicos rellenados a 48 → weak.
    process.env.ARBITER_NONCE_SECRET = '0123456789abcde'.repeat(4).slice(0, 48);
    expect(getArbiterNonceSecret()).toBeNull();

    // Contraste: el hex-random legítimo (16 únicos) NO se rechaza.
    process.env.ARBITER_NONCE_SECRET = HEX_RANDOM;
    expect(getArbiterNonceSecret()).toBe(HEX_RANDOM);
  });

  it('CD-2: el valor del secreto NUNCA aparece en los args de log.warn', () => {
    process.env.ARBITER_NONCE_SECRET = HEX_RANDOM;
    mockLogWarn.mockClear();
    getArbiterNonceSecret(); // fuerte → no warn, pero verificamos igual
    // Débil por largo → warn con {present, weak}; el valor no debe filtrarse.
    process.env.ARBITER_NONCE_SECRET = 'weaksecret'; // <32
    mockLogWarn.mockClear();
    expect(getArbiterNonceSecret()).toBeNull();
    // Débil por baja entropía → warn con {present, weak}; el valor no debe filtrarse.
    const lowEntropy = 'lowentropyvalue'.repeat(4); // 60 chars, pocos únicos
    process.env.ARBITER_NONCE_SECRET = lowEntropy;
    expect(getArbiterNonceSecret()).toBeNull();
    // Ausente → warn con {present:false}.
    delete process.env.ARBITER_NONCE_SECRET;
    expect(getArbiterNonceSecret()).toBeNull();

    for (const call of mockLogWarn.mock.calls) {
      const meta = call[0] as Record<string, unknown>;
      const msg = String(call[1] ?? '');
      // El objeto de contexto sólo lleva flags booleanos present/weak.
      for (const k of Object.keys(meta)) {
        expect(['present', 'weak']).toContain(k);
      }
      // Ni el objeto serializado ni el mensaje contienen ningún secreto.
      expect(JSON.stringify(meta)).not.toContain('weaksecret');
      expect(JSON.stringify(meta)).not.toContain(lowEntropy);
      expect(JSON.stringify(meta)).not.toContain(HEX_RANDOM);
      expect(msg).not.toContain('weaksecret');
      expect(msg).not.toContain(lowEntropy);
      expect(msg).not.toContain(HEX_RANDOM);
    }
  });
});

// ── T7 · diagnóstico post-mortem NonceAlreadyUsed en executeResolveDispute (AC-7) ──
describe('executeResolveDispute — diagnóstico colisión de nonce (T7 · AC-7/CD-5)', () => {
  // selector de NonceAlreadyUsed() — data cruda del revert (sin args).
  const NONCE_ERR_DATA = keccak256(stringToBytes('NonceAlreadyUsed()')).slice(
    0,
    10,
  ) as `0x${string}`;

  function revertedReceipt() {
    mockWaitForReceipt.mockResolvedValue({
      status: 'reverted',
      blockNumber: 42n,
      logs: [],
    });
  }

  it('(a) simulate revierte NonceAlreadyUsed → reason=NONCE_ALREADY_USED', async () => {
    revertedReceipt();
    const revertErr = new ContractFunctionRevertedError({
      abi: ESCROW_ABI,
      functionName: 'resolveDispute',
      data: NONCE_ERR_DATA,
    });
    mockSimulateContract.mockRejectedValue(
      new BaseError('reverted', { cause: revertErr }),
    );

    const out = await executeResolveDispute(resolveArgs());
    expect(out.kind).toBe('not_moved');
    if (out.kind === 'not_moved') {
      expect(out.reason).toBe(ARBITER_NONCE_COLLISION_REASON);
      expect(out.txHash).toBe(TX_HASH);
    }
  });

  it('(b) simulate revierte OTRO custom error (no colisión) → REVERTED', async () => {
    revertedReceipt();
    // ContractFunctionRevertedError SIN data decodable a NonceAlreadyUsed.
    const revertErr = new ContractFunctionRevertedError({
      abi: ESCROW_ABI,
      functionName: 'resolveDispute',
    });
    mockSimulateContract.mockRejectedValue(
      new BaseError('reverted', { cause: revertErr }),
    );

    const out = await executeResolveDispute(resolveArgs());
    expect(out.kind).toBe('not_moved');
    if (out.kind === 'not_moved') expect(out.reason).toBe('REVERTED');
  });

  it('(c) simulate rechaza con error genérico (RPC down) → REVERTED (nunca lanza)', async () => {
    revertedReceipt();
    mockSimulateContract.mockRejectedValue(new Error('RPC connection lost'));

    const out = await executeResolveDispute(resolveArgs());
    expect(out.kind).toBe('not_moved');
    if (out.kind === 'not_moved') expect(out.reason).toBe('REVERTED');
  });
});
