/**
 * WKH-302 — bandera de transición del settle Solana (T-AC3, T-AC4, T-CD15).
 *
 * La pregunta que estos tests contestan no es "¿devolvió 200?" sino **quién firmó**.
 * Por eso cada caso asserta sobre los dos caminos a la vez: si el camino nuevo
 * corre, el keypair local NO se resuelve y `sendAndConfirmTransaction` NO se llama;
 * si corre el legado, el hop HTTP NO se invoca. Nunca los dos para el mismo
 * `intentId` (AC-3).
 */

import { PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const PAY_TO = 'So11111111111111111111111111111111111111112';
const OPERATOR = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
const LOCAL_SIG = '5'.repeat(64);
const FACILITATOR_SIG = '7'.repeat(64);

const fakeConnection = {
  getParsedTransaction: vi.fn(
    (..._a: unknown[]): Promise<unknown> => Promise.resolve(null),
  ),
  getTokenAccountBalance: vi.fn(
    (..._a: unknown[]): Promise<unknown> =>
      Promise.resolve({ value: { amount: '1000000' } }),
  ),
};

/** Espía del keypair LOCAL: si esto se llama con la bandera ON, algo está mal. */
const mockGetOperatorKeypair = vi.fn((..._a: unknown[]) => ({
  publicKey: new PublicKey(OPERATOR),
  secretKey: new Uint8Array(64),
}));

vi.mock('./chain.js', () => ({
  getSolanaConnection: vi.fn((..._a: unknown[]) => fakeConnection),
  getSolanaOperatorKeypair: (...a: unknown[]) => mockGetOperatorKeypair(...a),
  getSolanaUsdcMint: vi.fn((..._a: unknown[]) => MINT),
  getSolanaUsdcDecimals: vi.fn((..._a: unknown[]) => 6),
  getSolanaCommitment: vi.fn((..._a: unknown[]) => 'confirmed'),
  getSolanaCaip2: vi.fn((..._a: unknown[]) => 'solana:test'),
  getSolanaNetwork: vi.fn((..._a: unknown[]) => 'devnet'),
}));

const mockGetOrCreateAta = vi.fn((..._a: unknown[]) =>
  Promise.resolve({ address: new PublicKey(PAY_TO) }),
);
const mockCreateTransferIx = vi.fn((..._a: unknown[]) => ({
  keys: [],
  programId: new PublicKey(MINT),
  data: Buffer.alloc(0),
}));
vi.mock('@solana/spl-token', () => ({
  getOrCreateAssociatedTokenAccount: (...a: unknown[]) =>
    mockGetOrCreateAta(...a),
  createTransferInstruction: (...a: unknown[]) => mockCreateTransferIx(...a),
  getAssociatedTokenAddressSync: (..._a: unknown[]) => new PublicKey(OPERATOR),
}));

/** Espía del broadcast LOCAL: la firma con llave propia del gateway. */
const mockSendAndConfirm = vi.fn((..._a: unknown[]) =>
  Promise.resolve(LOCAL_SIG),
);
vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  return {
    ...actual,
    sendAndConfirmTransaction: (...a: unknown[]) => mockSendAndConfirm(...a),
  };
});

import { readSettleValueDisposition } from '../errors.js';
import { _resetSolanaClients, SolanaPaymentAdapter } from './payment.js';

const savedEnv = new Map<string, string | undefined>();
const ENV_KEYS = [
  'SOLANA_SETTLE_VIA_FACILITATOR',
  'SOLANA_FACILITATOR_URL',
  'SOLANA_FACILITATOR_API_KEY',
  'WASIAI_FACILITATOR_URL',
  'FACILITATOR_API_KEY',
];

function saveEnv(): void {
  const env = new Map(Object.entries(process.env));
  for (const k of ENV_KEYS) savedEnv.set(k, env.get(k));
  for (const k of ENV_KEYS) delete process.env[k];
}

function restoreEnv(): void {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv.clear();
}

/** Respuesta 200 del facilitator, tal como la define §6.2 del contrato. */
function okPayoutResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      signature: FACILITATOR_SIG,
      network: 'solana:devnet',
      payTo: PAY_TO,
      amountAtomic: '3000000',
      alreadySettled: false,
      ...overrides,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  saveEnv();
  _resetSolanaClients();
  mockSendAndConfirm.mockClear();
  mockGetOperatorKeypair.mockClear();
  mockGetOrCreateAta.mockClear();
  // Estado del RPC por test: si no se resetea, el mock de un caso (null / throw /
  // tx fallida) se filtra al siguiente y el orden pasa a decidir el resultado.
  fakeConnection.getParsedTransaction.mockReset();
  fakeConnection.getParsedTransaction.mockResolvedValue(null);
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  restoreEnv();
  fetchSpy.mockRestore();
  vi.clearAllMocks();
});

const settleReq = (intentId: string) => ({
  payTo: PAY_TO,
  amountAtomic: '3000000',
  intentId,
});

describe('T-AC3 — exactamente UN camino por request, nunca los dos', () => {
  it('★ bandera ON: firma el facilitator; el keypair local NUNCA se resuelve', async () => {
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
    process.env.SOLANA_FACILITATOR_URL = 'https://facilitator.test';
    fetchSpy.mockResolvedValue(okPayoutResponse());

    const adapter = new SolanaPaymentAdapter();
    const res = await adapter.settle(settleReq('run-on:0'));

    expect(res.success).toBe(true);
    expect(res.txHash).toBe(FACILITATOR_SIG);
    // El camino de dinero local no se tocó ni para leer la llave.
    expect(mockGetOperatorKeypair).not.toHaveBeenCalled();
    expect(mockSendAndConfirm).not.toHaveBeenCalled();
    expect(mockGetOrCreateAta).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('★ bandera OFF: firma el gateway; el hop HTTP NUNCA se invoca', async () => {
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'false';
    const adapter = new SolanaPaymentAdapter();
    const res = await adapter.settle(settleReq('run-off:0'));

    expect(res.success).toBe(true);
    expect(res.txHash).toBe(LOCAL_SIG);
    expect(mockSendAndConfirm).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('★ el POST lleva el contrato de §6.1 (intentId, payTo, amountAtomic, network)', async () => {
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
    process.env.SOLANA_FACILITATOR_URL = 'https://facilitator.test/';
    fetchSpy.mockResolvedValue(okPayoutResponse());

    await new SolanaPaymentAdapter().settle(settleReq('run-1:2'));

    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://facilitator.test/solana/payout');
    const body = JSON.parse(String((init as RequestInit).body)) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({
      intentId: 'run-1:2',
      payTo: PAY_TO,
      amountAtomic: '3000000',
      network: 'solana:devnet',
    });
  });

  it('alreadySettled:true es un ÉXITO (es un pago que ya ocurrió), no un error', async () => {
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
    process.env.SOLANA_FACILITATOR_URL = 'https://facilitator.test';
    fetchSpy.mockResolvedValue(okPayoutResponse({ alreadySettled: true }));

    const res = await new SolanaPaymentAdapter().settle(settleReq('run-rep:0'));
    expect(res.success).toBe(true);
    expect(res.txHash).toBe(FACILITATOR_SIG);
    expect(mockSendAndConfirm).not.toHaveBeenCalled();
  });
});

describe('T-AC4 — con la bandera ausente todo es idéntico a pre-302', () => {
  it('★ bandera UNSET: mismo resultado y mismo firmante que antes de la HU', async () => {
    // Sin la variable en el entorno en absoluto.
    expect(process.env.SOLANA_SETTLE_VIA_FACILITATOR).toBeUndefined();
    const res = await new SolanaPaymentAdapter().settle(settleReq('run-un:0'));

    expect(res).toEqual({ txHash: LOCAL_SIG, success: true });
    expect(mockSendAndConfirm).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("★ un valor truthy-pero-no-'true' NO activa el camino nuevo", async () => {
    // La comparación es literal contra 'true'. `Boolean(process.env.X)` daría
    // true para cualquiera de estos, incluido el string 'false'.
    for (const v of ['1', 'TRUE', 'yes', 'false', '']) {
      process.env.SOLANA_SETTLE_VIA_FACILITATOR = v;
      mockSendAndConfirm.mockClear();
      fetchSpy.mockClear();
      const res = await new SolanaPaymentAdapter().settle(
        settleReq(`run-v-${v}:0`),
      );
      expect(res.txHash).toBe(LOCAL_SIG);
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });

  it('el seam de idempotencia sigue ANTES de la ramificación (común a los dos)', async () => {
    // 1º pago por el camino nuevo: queda la firma del facilitator en el seam.
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
    process.env.SOLANA_FACILITATOR_URL = 'https://facilitator.test';
    fetchSpy.mockResolvedValue(okPayoutResponse());
    const adapter = new SolanaPaymentAdapter();
    await adapter.settle(settleReq('run-shared:0'));
    expect(adapter.getSettledSignature('run-shared:0')).toBe(FACILITATOR_SIG);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('AR 4º sitio — el seam de idempotencia no se borra ante un RPC que no contesta', () => {
  // Hallazgo propio, en el camino LEGADO (bandera OFF), que es el de producción hoy.
  // `verify()` devolvía `valid:false` tanto cuando la cadena dice "esa tx falló"
  // como cuando `getParsedTransaction` devuelve `null` — y `null` puede ser un nodo
  // sin ese pedazo de historia, uno atrasado o un índice degradado. Con `valid:false`
  // el código BORRABA el seam y volvía a firmar: doble pago, con la única barrera
  // (el Map en memoria) recién eliminada.

  it('★ un RPC que LANZA no borra el seam ni re-emite', async () => {
    const adapter = new SolanaPaymentAdapter();
    await adapter.settle(settleReq('run-idem3:0'));
    fakeConnection.getParsedTransaction.mockRejectedValue(
      new Error('RPC down'),
    );
    try {
      await adapter.settle(settleReq('run-idem3:0'));
      expect.unreachable('debería haber lanzado');
    } catch (e) {
      expect(readSettleValueDisposition(e)).toBe('unknown');
    }
    expect(mockSendAndConfirm).toHaveBeenCalledTimes(1);
    expect(adapter.getSettledSignature('run-idem3:0')).toBe(LOCAL_SIG);
  });

  it('control: una negativa DEMOSTRADA (tx falló on-chain) SÍ se auto-cura', async () => {
    // Desarmar el escenario tiene que cambiar el resultado: si la cadena responde
    // que esa tx se ejecutó y falló, re-emitir es lo correcto. Sin este control, el
    // fix podría estar bloqueando TODO retry y los tests de arriba pasarían igual.
    const adapter = new SolanaPaymentAdapter();
    await adapter.settle(settleReq('run-idem4:0'));
    expect(mockSendAndConfirm).toHaveBeenCalledTimes(1);

    fakeConnection.getParsedTransaction.mockResolvedValue({
      meta: {
        err: { InstructionError: [0, 'Custom'] },
        preTokenBalances: [],
        postTokenBalances: [],
      },
    });
    const res = await adapter.settle(settleReq('run-idem4:0'));
    expect(res.success).toBe(true);
    expect(mockSendAndConfirm).toHaveBeenCalledTimes(2); // re-emitió, correctamente
  });

  it('DOCUMENTA EL HALLAZGO ABIERTO: un `null` del nodo todavía re-emite', async () => {
    // Este test NO celebra el comportamiento: lo FIJA para que el follow-up sea
    // visible y para que nadie crea que el 4º sitio quedó cerrado. `null` también
    // lo devuelve un nodo atrasado o sin ese pedazo de historia, y ahí esto es un
    // doble pago. Apagarlo toca el self-heal de WKH-235a (T-HEAL-1/2, T-P1-2a),
    // que tiene tests propios: requiere ticket, no un fix suelto.
    const adapter = new SolanaPaymentAdapter();
    await adapter.settle(settleReq('run-idem5:0'));
    fakeConnection.getParsedTransaction.mockResolvedValue(null);
    const res = await adapter.settle(settleReq('run-idem5:0'));
    expect(res.success).toBe(true);
    expect(mockSendAndConfirm).toHaveBeenCalledTimes(2); // ← el riesgo, documentado
  });
});

describe('T-CD15 — con la bandera ON no hay fallback a firma local', () => {
  it('★ facilitator caído (5xx) ⇒ lanza y el keypair local NUNCA firma', async () => {
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
    process.env.SOLANA_FACILITATOR_URL = 'https://facilitator.test';
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'BOOM', message: 'x' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(
      new SolanaPaymentAdapter().settle(settleReq('run-down:0')),
    ).rejects.toThrow();

    expect(mockGetOperatorKeypair).not.toHaveBeenCalled();
    expect(mockSendAndConfirm).not.toHaveBeenCalled();
  });

  it('★ error de red ⇒ lanza, sin firmar localmente', async () => {
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
    process.env.SOLANA_FACILITATOR_URL = 'https://facilitator.test';
    fetchSpy.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED'), {
        cause: { code: 'ECONNREFUSED' },
      }),
    );

    await expect(
      new SolanaPaymentAdapter().settle(settleReq('run-net:0')),
    ).rejects.toThrow();
    expect(mockSendAndConfirm).not.toHaveBeenCalled();
  });

  it('★ el seam de idempotencia NO se escribe con un valor derivado de un error', async () => {
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
    process.env.SOLANA_FACILITATOR_URL = 'https://facilitator.test';
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'PAYOUT_IN_PROGRESS' } }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const adapter = new SolanaPaymentAdapter();
    await expect(adapter.settle(settleReq('run-err:0'))).rejects.toThrow();
    expect(adapter.getSettledSignature('run-err:0')).toBeUndefined();
  });
});
