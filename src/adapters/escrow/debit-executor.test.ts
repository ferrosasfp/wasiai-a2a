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
// HU-198: `getLogger` devuelve un child NUEVO en cada llamada, así que no se puede
// espiar la instancia después de que el módulo cargó. Se mockea la fábrica para que
// todos los `getLogger` compartan el mismo spy.
const mockLogError = vi.fn();

vi.mock('../../lib/logger.js', () => ({
  getLogger: () => ({
    error: (...a: unknown[]) => mockLogError(...a),
    warn: () => {},
    info: () => {},
    debug: () => {},
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

  it('T-198: acepta el status resolving_settle y lo pasa tal cual', async () => {
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
      status: 'resolving_settle',
    });

    expect(mockRpc).toHaveBeenCalledWith(
      'record_debit_settle_status',
      expect.objectContaining({ p_status: 'resolving_settle' }),
    );
  });

  it('T-198: un error del RPC se LOGUEA (antes se descartaba en silencio) y NO tira', async () => {
    // POR QUÉ IMPORTA: si la migración de HU-198 no está aplicada, el RPC responde
    // `INVALID_SETTLE_STATUS` al escribir `resolving_settle`, la fila se queda en
    // `hop1_confirmed` (que SÍ es auto-reclamable) y el reconciliador puede volver a
    // re-enviar el hop 2 a ciegas. Antes eso pasaba sin dejar rastro: el error del
    // RPC se descartaba. El log es la única señal de que el candado no cerró.
    mockLogError.mockClear();
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'INVALID_SETTLE_STATUS: resolving_settle' },
      // biome-ignore lint/suspicious/noExplicitAny: supabase rpc test double
    } as any);

    // NO tira: el caller está en un camino de money-safety y un throw perdería el
    // veredicto del settle. Devuelve el hecho (AR BLQ-MEDIO-2): el estado NO quedó
    // escrito, y eso ahora es un dato que el caller puede leer.
    //
    // AR de HU-202, BLOQUEANTE 2 — Y ES `write_failed`, NO `rejected_by_guard`. El RPC
    // tiró, o sea que el UPDATE nunca corrió: nadie sabe si otro tiene el lease. Es la
    // causa cuyo remedio es la INFRA, no el intent, y el `false` colapsado la hacía
    // indistinguible de un rechazo ordenado del guard.
    await expect(
      recordDebitSettleStatus({
        intentId: 'intent-1',
        ownerRef: 'tenant-A',
        keyId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        nonce: '7',
        status: 'resolving_settle',
      }),
    ).resolves.toEqual({
      outcome: 'write_failed',
      detail: 'INVALID_SETTLE_STATUS: resolving_settle',
    });

    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'resolving_settle',
        detail: 'INVALID_SETTLE_STATUS: resolving_settle',
      }),
      expect.stringContaining('was NOT updated'),
    );
  });

  // ── AR BLQ-MEDIO-2: el 0-row silencioso es un modo de fallo PROPIO ──
  //
  // El guard de transición (migración 20260728000000) hace que un UPDATE de 0 filas sea
  // un RESULTADO NORMAL, no un error. Con el `RETURNS void` original el caller no podía
  // distinguir "quedó escrito" de "el guard lo rechazó y la fila SIGUE auto-reclamable",
  // así que el candado de la HU colgaba de un write incapaz de reportar su fracaso. La
  // propiedad afirmada es que ese caso se detecta Y se grita: si no, la fila queda
  // auto-reclamable y el reconciliador puede re-enviar el hop 2 a ciegas.
  it('T-198-AR: applied=false (guard rechazó el write) → rejected_by_guard + log loud, sin error del RPC', async () => {
    mockLogError.mockClear();
    mockRpc.mockResolvedValue({
      data: [{ applied: false, current_status: 'settled' }],
      error: null,
      // biome-ignore lint/suspicious/noExplicitAny: supabase rpc test double
    } as any);

    const ok = await recordDebitSettleStatus({
      intentId: 'intent-1',
      ownerRef: 'tenant-A',
      keyId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      nonce: '7',
      status: 'resolving_settle',
    });

    // NO hubo `error` del RPC y aun así el write no se aplicó: exactamente el modo de
    // fallo que el `if (error)` NO cubría.
    //
    // AR de HU-202, BLOQUEANTE 2 — ACÁ SÍ ES `rejected_by_guard`, Y ES LO OPUESTO al test
    // de arriba: el UPDATE corrió, afectó 0 filas, y el estado real de la fila viaja en el
    // resultado. Los dos tests dan `expect.not` del otro, así que el día que alguien los
    // vuelva a colapsar en un booleano, uno de los dos se pone rojo.
    expect(ok).toEqual({
      outcome: 'rejected_by_guard',
      currentStatus: 'settled',
    });
    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({
        applied: false,
        status: 'resolving_settle',
        // AR#2 BLQ-BAJO-1: el estado REAL viaja al log para poder nombrarlo.
        currentStatus: 'settled',
      }),
      expect.stringContaining('REJECTED this write'),
    );
  });

  // ── AR#2 BLQ-BAJO-1: la alerta dice el HECHO, no una consecuencia inventada ──
  it('T-198-AR2: la alerta NOMBRA el estado real y NO afirma que la fila sigue auto-reclamable', async () => {
    // La versión anterior afirmaba "the row REMAINS auto-claimable and the reconciler
    // could resend hop2 blind". Es FALSO en todos los casos alcanzables: `applied=false`
    // sólo ocurre desde estados que ni el lado settle ni el refund pueden reclamar para
    // mandar un hop 2. Y en el caso F la verdad es que el seller YA cobró dos veces, así
    // que el mensaje mandaba al operador a mirar lo que no era.
    mockLogError.mockClear();
    mockRpc.mockResolvedValue({
      data: [{ applied: false, current_status: 'resolved_settled' }],
      error: null,
      // biome-ignore lint/suspicious/noExplicitAny: supabase rpc test double
    } as any);

    await recordDebitSettleStatus({
      intentId: 'intent-1',
      ownerRef: 'tenant-A',
      keyId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      nonce: '7',
      status: 'resolving_settle',
    });

    const msg = String(mockLogError.mock.calls[0]?.[1]);
    // Dice el HECHO: qué quería escribir y en qué estado quedó.
    expect(msg).toContain('resolved_settled');
    expect(msg).toMatch(/KEEPS its current status/);
    // Y pide LEER antes de concluir, en vez de dar un diagnóstico.
    expect(msg).toMatch(/not a diagnosis/i);
    // PROHIBIDO volver a la afirmación falsa.
    expect(msg).not.toMatch(/auto-claimable/i);
    expect(msg).not.toMatch(/resend hop2 blind/i);
  });

  it('T-198-AR: applied=true → true y NINGÚN log de error', async () => {
    // Contra-ejemplo: sin esto, loguear siempre pasaría el test de arriba y la señal
    // dejaría de significar algo.
    mockLogError.mockClear();
    mockRpc.mockResolvedValue({
      data: [{ applied: true, current_status: 'resolving_settle' }],
      error: null,
      // biome-ignore lint/suspicious/noExplicitAny: supabase rpc test double
    } as any);

    const ok = await recordDebitSettleStatus({
      intentId: 'intent-1',
      ownerRef: 'tenant-A',
      keyId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      nonce: '7',
      status: 'resolving_settle',
    });

    expect(ok).toEqual({ outcome: 'applied' });
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it('T-198-AR: RPC viejo (data null, sin applied) → NO confirmado (no se asume que cerró)', async () => {
    // Orden de release inverso: el código nuevo con el RPC viejo (`RETURNS void`)
    // devuelve `null`. Se trata como NO confirmado a propósito: preferimos un warn de
    // más a creer que el candado cerró cuando no sabemos.
    mockLogError.mockClear();
    mockRpc.mockResolvedValue({
      data: null,
      error: null,
      // biome-ignore lint/suspicious/noExplicitAny: supabase rpc test double
    } as any);

    const ok = await recordDebitSettleStatus({
      intentId: 'intent-1',
      ownerRef: 'tenant-A',
      keyId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      nonce: '7',
      status: 'resolving_settle',
    });

    // AR de HU-202, BLOQUEANTE 2 — `write_failed`, NO `rejected_by_guard`: sin el flag
    // `applied` no hay NINGÚN hecho sobre la fila, así que afirmar "el guard me rechazó"
    // sería inventarlo. La distinción importa justo acá, en el orden de release inverso.
    expect(ok).toEqual({
      outcome: 'write_failed',
      detail: 'RPC returned no `applied` flag',
    });
    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({ applied: null }),
      expect.stringContaining('no `applied` flag'),
    );
  });
});
