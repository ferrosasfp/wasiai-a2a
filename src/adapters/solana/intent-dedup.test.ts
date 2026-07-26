/**
 * Cap + TTL del seam de idempotencia Solana (fix-pack P1, hallazgo 5).
 *
 * `_intentSignatures` no tenía cota: una entrada por intent, para siempre →
 * leak de memoria en un proceso de larga vida.
 *
 * ⚠️ Ese Map es lo que hace IDEMPOTENTE el settle de un leg Solana. Si una
 * entrada desaparece MIENTRAS EL INTENT SIGUE VIVO, un retry re-broadcastea y
 * SE PAGA DOS VECES. Por eso la política es fail-safe hacia CONSERVAR:
 *   · TTL con 2× de margen sobre la COTA ESTIMADA de vida de un run
 *     (5 steps × 300 s de undici = 25 min ⇒ TTL default 50 min).
 *   · Override con PISO = la ventana protegida (25 min con los defaults).
 *   · Cap SOFT con VENTANA PROTEGIDA: nunca se desaloja algo joven.
 *
 * ⚠️ AR MENOR-1: la iteración anterior derivaba estos números de
 * `TIMEOUT_COMPOSE_MS` afirmando que «un run no puede sobrevivir a su propio
 * timeout». Era FALSO — `middleware/timeout.ts` manda el 504 y NO cancela nada
 * (sin `AbortController`/`signal`, y `ssrf-dispatcher.ts` no fija
 * `headersTimeout`/`bodyTimeout`). No existe cota dura; los números se derivan
 * ahora de la cota ESTIMADA y el piso ya no se vende como garantía. Ver
 * `T-TTL-11`.
 */

import { PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const PAY_TO = 'So11111111111111111111111111111111111111112';
const OPERATOR = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
const SIG_A = 'A'.repeat(64);
const SIG_B = 'B'.repeat(64);

// ── Boundary de red mockeada (mismo patrón que payment.test.ts) ──────────
const fakeConnection = {
  getParsedTransaction: vi.fn(
    (..._a: unknown[]): Promise<unknown> => Promise.resolve(null),
  ),
  getTokenAccountBalance: vi.fn(
    (..._a: unknown[]): Promise<unknown> =>
      Promise.resolve({ value: { amount: '1000000' } }),
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

vi.mock('@solana/spl-token', () => ({
  getOrCreateAssociatedTokenAccount: vi.fn((..._a: unknown[]) =>
    Promise.resolve({ address: new PublicKey(PAY_TO) }),
  ),
  createTransferInstruction: vi.fn((..._a: unknown[]) => ({
    keys: [],
    programId: new PublicKey(MINT),
    data: Buffer.alloc(0),
  })),
  getAssociatedTokenAddressSync: vi.fn(
    (..._a: unknown[]) => new PublicKey(OPERATOR),
  ),
}));

const mockSendAndConfirm = vi.fn();
vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  return {
    ...actual,
    sendAndConfirmTransaction: (...a: unknown[]) => mockSendAndConfirm(...a),
  };
});

const logSpy = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../lib/logger.js', () => ({ getLogger: () => logSpy }));

import {
  _intentDedupPolicy,
  _intentDedupSize,
  _resetSolanaClients,
  _seedIntentSignature,
  SolanaPaymentAdapter,
} from './payment.js';

/** Default de `TIMEOUT_COMPOSE_MS` (routes/compose.ts). NO es cota de ejecución. */
const COMPOSE_TIMEOUT_MS = 180_000;
/** Cota ESTIMADA de vida de un run: 5 steps × 300 s (default de undici) = 25 min. */
const ESTIMATED_RUN_BOUND_MS = 5 * 300_000;
/** Ventana protegida: max(cota, TIMEOUT_COMPOSE_MS × 2) = 25 min. */
const PROTECTED_WINDOW_MS = ESTIMATED_RUN_BOUND_MS;
/** TTL default: max(cota × 2, 180s × 10, 30 min) = 50 min. */
const DEFAULT_TTL_MS = ESTIMATED_RUN_BOUND_MS * 2;

function cleanEnv(): void {
  delete process.env.SOLANA_INTENT_DEDUP_TTL_MS;
  delete process.env.SOLANA_INTENT_DEDUP_MAX_ENTRIES;
  delete process.env.TIMEOUT_COMPOSE_MS;
}

describe('seam de idempotencia Solana — cap + TTL (hallazgo P1-5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetSolanaClients();
    cleanEnv();
    mockSendAndConfirm.mockResolvedValue(SIG_A);
  });

  afterEach(() => {
    _resetSolanaClients();
    cleanEnv();
  });

  // ── TTL ────────────────────────────────────────────────────────────────

  it('T-TTL-1: una entrada FRESCA sigue siendo idempotente (no re-broadcastea)', async () => {
    const adapter = new SolanaPaymentAdapter();
    // La firma previa verifica on-chain → se reusa.
    fakeConnection.getParsedTransaction.mockResolvedValue({
      meta: {
        err: null,
        preTokenBalances: [],
        postTokenBalances: [
          { owner: PAY_TO, mint: MINT, uiTokenAmount: { amount: '1000000' } },
        ],
      },
    });
    _seedIntentSignature('run-1:0', SIG_B, 1_000); // 1s de antigüedad

    const res = await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'run-1:0',
    });

    expect(res).toEqual({ txHash: SIG_B, success: true });
    expect(mockSendAndConfirm).not.toHaveBeenCalled(); // NO re-broadcast
  });

  it('T-TTL-2: una entrada EXPIRADA se trata como ausente (getSettledSignature)', async () => {
    const adapter = new SolanaPaymentAdapter();

    _seedIntentSignature('fresca', SIG_A, DEFAULT_TTL_MS - 1_000);
    _seedIntentSignature('vencida', SIG_B, DEFAULT_TTL_MS + 1_000);

    expect(adapter.getSettledSignature('fresca')).toBe(SIG_A);
    expect(adapter.getSettledSignature('vencida')).toBeUndefined();
  });

  it('T-TTL-3: leer una entrada expirada la BORRA (no queda basura)', () => {
    const adapter = new SolanaPaymentAdapter();
    _seedIntentSignature('vencida', SIG_B, DEFAULT_TTL_MS + 1);
    expect(_intentDedupSize()).toBe(1);

    adapter.getSettledSignature('vencida');

    expect(_intentDedupSize()).toBe(0);
  });

  it('T-TTL-4: el barrido en el `set` limpia las expiradas', async () => {
    const adapter = new SolanaPaymentAdapter();
    for (let i = 0; i < 5; i++) {
      _seedIntentSignature(`vieja-${i}`, SIG_B, DEFAULT_TTL_MS + 10_000);
    }
    expect(_intentDedupSize()).toBe(5);

    // Un settle nuevo dispara el barrido lazy.
    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'nueva',
    });

    expect(_intentDedupSize()).toBe(1); // sólo la nueva
    expect(adapter.getSettledSignature('nueva')).toBe(SIG_A);
  });

  // ── EL invariante de dinero ────────────────────────────────────────────

  it('T-TTL-5 (INVARIANTE): una entrada NO puede expirar dentro de la cota estimada de un compose-run', () => {
    const adapter = new SolanaPaymentAdapter();
    // Se prueba en el borde exacto de la cota estimada y con margen: nada dentro
    // de la ventana expira.
    for (const age of [
      0,
      1,
      COMPOSE_TIMEOUT_MS,
      COMPOSE_TIMEOUT_MS * 2,
      ESTIMATED_RUN_BOUND_MS - 1,
      ESTIMATED_RUN_BOUND_MS,
      PROTECTED_WINDOW_MS,
      DEFAULT_TTL_MS - 1,
    ]) {
      _resetSolanaClients();
      _seedIntentSignature('vivo', SIG_A, age);
      expect(
        adapter.getSettledSignature('vivo'),
        `una entrada de ${age}ms NO debe expirar (cota estimada del run: ${ESTIMATED_RUN_BOUND_MS}ms)`,
      ).toBe(SIG_A);
    }
  });

  it('T-TTL-6 (INVARIANTE): el TTL default duplica la cota estimada de un run', () => {
    const adapter = new SolanaPaymentAdapter();
    // Justo por debajo del TTL: vive. Justo por encima: expira.
    _seedIntentSignature('borde-vive', SIG_A, DEFAULT_TTL_MS - 1);
    expect(adapter.getSettledSignature('borde-vive')).toBe(SIG_A);

    _resetSolanaClients();
    _seedIntentSignature('borde-muere', SIG_A, DEFAULT_TTL_MS + 1);
    expect(adapter.getSettledSignature('borde-muere')).toBeUndefined();

    // AR MENOR-1: el margen se mide contra la COTA ESTIMADA (25 min), no contra
    // `TIMEOUT_COMPOSE_MS` (que no gobierna la ejecución). Con el TTL viejo de
    // 30 min este assert daba 1.2 y fallaba.
    expect(
      _intentDedupPolicy().ttlMs / ESTIMATED_RUN_BOUND_MS,
    ).toBeGreaterThanOrEqual(2);
  });

  it('T-TTL-7 (FAIL-SAFE del knob): un override peligrosamente corto se eleva al piso', () => {
    const adapter = new SolanaPaymentAdapter();
    // Un operador pide 1 segundo de TTL — expiraría DENTRO de la ventana en la
    // que el desalojo considera la entrada intocable. Se eleva al piso.
    process.env.SOLANA_INTENT_DEDUP_TTL_MS = '1000';

    _seedIntentSignature('run-vivo', SIG_A, 60_000); // 1 min: run en curso
    expect(adapter.getSettledSignature('run-vivo')).toBe(SIG_A);

    _resetSolanaClients();
    _seedIntentSignature('en-el-piso', SIG_A, PROTECTED_WINDOW_MS - 1);
    expect(adapter.getSettledSignature('en-el-piso')).toBe(SIG_A);

    _resetSolanaClients();
    _seedIntentSignature('pasado-el-piso', SIG_A, PROTECTED_WINDOW_MS + 1);
    expect(adapter.getSettledSignature('pasado-el-piso')).toBeUndefined();
  });

  it('T-TTL-8: un override RAZONABLE (mayor al piso) se respeta', () => {
    const adapter = new SolanaPaymentAdapter();
    // 40 min > piso 25 min (con el piso viejo de 6 min este valor era 10 min).
    process.env.SOLANA_INTENT_DEDUP_TTL_MS = String(2_400_000);

    _seedIntentSignature('vive', SIG_A, 2_399_000);
    expect(adapter.getSettledSignature('vive')).toBe(SIG_A);

    _resetSolanaClients();
    _seedIntentSignature('muere', SIG_A, 2_401_000);
    expect(adapter.getSettledSignature('muere')).toBeUndefined();
  });

  it('T-TTL-9: el TTL sigue a TIMEOUT_COMPOSE_MS (si el operador sube el timeout)', () => {
    const adapter = new SolanaPaymentAdapter();
    process.env.TIMEOUT_COMPOSE_MS = String(600_000); // 10 min por run
    // TTL default = max(cota×2 = 50min, 10min × 10 = 100min, 30min) = 100 min.
    _seedIntentSignature('vive', SIG_A, 99 * 60_000);
    expect(adapter.getSettledSignature('vive')).toBe(SIG_A);

    _resetSolanaClients();
    _seedIntentSignature('muere', SIG_A, 101 * 60_000);
    expect(adapter.getSettledSignature('muere')).toBeUndefined();
  });

  it('T-TTL-11 (AR MENOR-1): el piso del knob es la cota ESTIMADA, no TIMEOUT_COMPOSE_MS × 2', () => {
    // El texto viejo prometía «un run no puede sobrevivir a su propio timeout» y
    // de ahí sacaba un piso de 6 min. `middleware/timeout.ts` sólo manda el 504
    // (no cancela: sin AbortController/signal) y `ssrf-dispatcher.ts` no fija
    // headersTimeout/bodyTimeout ⇒ la ejecución puede pasarse largo del timeout.
    // El piso tiene que derivar de la cota estimada por hops, no del timeout.
    process.env.SOLANA_INTENT_DEDUP_TTL_MS = '1';
    const p = _intentDedupPolicy();

    expect(p.estimatedMaxRunWallClockMs).toBe(ESTIMATED_RUN_BOUND_MS);
    expect(p.ttlMs).toBe(PROTECTED_WINDOW_MS);
    expect(p.ttlMs).toBeGreaterThanOrEqual(p.estimatedMaxRunWallClockMs);
    // El piso viejo (6 min) era MENOR que la cota real (25 min): el knob prometía
    // una garantía que no daba.
    expect(p.ttlMs).toBeGreaterThan(COMPOSE_TIMEOUT_MS * 2);
    // Coherencia interna: un TTL por debajo de la ventana protegida haría que una
    // entrada expire mientras el desalojo la considera intocable.
    expect(p.ttlMs).toBeGreaterThanOrEqual(p.protectedWindowMs);
  });

  it('T-TTL-10: env inválida → default (nunca NaN, que dejaría todo vivo o todo muerto)', () => {
    const adapter = new SolanaPaymentAdapter();
    process.env.SOLANA_INTENT_DEDUP_TTL_MS = 'abc';

    _seedIntentSignature('vive', SIG_A, DEFAULT_TTL_MS - 1);
    expect(adapter.getSettledSignature('vive')).toBe(SIG_A);

    _resetSolanaClients();
    _seedIntentSignature('muere', SIG_A, DEFAULT_TTL_MS + 1);
    expect(adapter.getSettledSignature('muere')).toBeUndefined();
  });

  // ── Cap ────────────────────────────────────────────────────────────────

  it('T-CAP-1: el cap DESALOJA las más viejas (fuera de la ventana protegida)', async () => {
    const adapter = new SolanaPaymentAdapter();
    process.env.SOLANA_INTENT_DEDUP_MAX_ENTRIES = '3';

    // 5 entradas VIEJAS (fuera de la ventana protegida, dentro del TTL).
    const age = PROTECTED_WINDOW_MS + 60_000;
    for (let i = 0; i < 5; i++) {
      _seedIntentSignature(`vieja-${i}`, SIG_B, age - i * 1_000);
    }
    expect(_intentDedupSize()).toBe(5);

    // El settle nuevo dispara el barrido: 6 entradas → cap 3.
    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'nueva',
    });

    expect(_intentDedupSize()).toBe(3);
    // La nueva SIEMPRE sobrevive (es la más joven).
    expect(adapter.getSettledSignature('nueva')).toBe(SIG_A);
    // Las más viejas se fueron primero (insertion order).
    expect(adapter.getSettledSignature('vieja-0')).toBeUndefined();
    expect(adapter.getSettledSignature('vieja-1')).toBeUndefined();
    expect(adapter.getSettledSignature('vieja-2')).toBeUndefined();
  });

  it('T-CAP-2 (FAIL-SAFE): con TODAS dentro de la ventana protegida NO se desaloja nada', async () => {
    const adapter = new SolanaPaymentAdapter();
    process.env.SOLANA_INTENT_DEDUP_MAX_ENTRIES = '2';

    // 4 entradas JOVENES (posibles runs en curso).
    for (let i = 0; i < 4; i++) {
      _seedIntentSignature(`joven-${i}`, SIG_B, 1_000 + i);
    }

    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'nueva',
    });

    // El cap se EXCEDE a propósito: desalojar una entrada viva habilitaría un
    // doble pago. Ante la duda, conservar.
    expect(_intentDedupSize()).toBe(5);
    for (let i = 0; i < 4; i++) {
      expect(adapter.getSettledSignature(`joven-${i}`)).toBe(SIG_B);
    }
  });

  it('T-CAP-3: el cap excedido con todo protegido emite un warn (señal operativa), una vez por episodio', async () => {
    const adapter = new SolanaPaymentAdapter();
    process.env.SOLANA_INTENT_DEDUP_MAX_ENTRIES = '1';
    for (let i = 0; i < 3; i++) {
      _seedIntentSignature(`joven-${i}`, SIG_B, 1_000);
    }

    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'n1',
    });
    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'n2',
    });

    const capWarns = logSpy.warn.mock.calls.filter((c) =>
      String(c[1]).includes('ventana protegida'),
    );
    expect(capWarns).toHaveLength(1); // no spamea DENTRO del mismo episodio
    expect(capWarns[0]?.[0]).toMatchObject({ max: 1 });
  });

  it('T-CAP-6 (AR MENOR-2): el warn se RE-ARMA cuando el tamaño baja del cap (no es once-per-proceso)', async () => {
    const adapter = new SolanaPaymentAdapter();
    const capWarns = (): unknown[] =>
      logSpy.warn.mock.calls.filter((c) =>
        String(c[1]).includes('ventana protegida'),
      );

    // Episodio 1: cap saturado con todo protegido.
    process.env.SOLANA_INTENT_DEDUP_MAX_ENTRIES = '1';
    for (let i = 0; i < 3; i++)
      _seedIntentSignature(`joven-${i}`, SIG_B, 1_000);
    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'n1',
    });
    expect(capWarns()).toHaveLength(1);

    // Recuperación: el tamaño vuelve a estar por debajo del cap → flag re-armado.
    process.env.SOLANA_INTENT_DEDUP_MAX_ENTRIES = '100';
    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'n2',
    });
    expect(capWarns()).toHaveLength(1); // sano: no loguea al recuperarse

    // Episodio 2 (el que el warn-once-per-proceso PERDÍA en silencio).
    process.env.SOLANA_INTENT_DEDUP_MAX_ENTRIES = '1';
    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'n3',
    });
    expect(capWarns()).toHaveLength(2);
  });

  it('T-CAP-7 (AR MENOR-2): el re-armado también ocurre cuando el DESALOJO alcanza', async () => {
    const adapter = new SolanaPaymentAdapter();
    const capWarns = (): unknown[] =>
      logSpy.warn.mock.calls.filter((c) =>
        String(c[1]).includes('ventana protegida'),
      );
    process.env.SOLANA_INTENT_DEDUP_MAX_ENTRIES = '2';

    // Episodio 1: 3 jóvenes + la nueva = 4 > 2, todas protegidas → warn.
    for (let i = 0; i < 3; i++)
      _seedIntentSignature(`joven-${i}`, SIG_B, 1_000);
    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'n1',
    });
    expect(capWarns()).toHaveLength(1);

    // Las 3 envejecen más allá de la ventana protegida (mismo key, storedAt
    // viejo) → el desalojo del próximo `set` sí puede bajar del cap.
    for (let i = 0; i < 3; i++) {
      _seedIntentSignature(`joven-${i}`, SIG_B, PROTECTED_WINDOW_MS + 60_000);
    }
    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'n2',
    });
    expect(_intentDedupSize()).toBe(2); // desalojó las 3 viejas
    expect(capWarns()).toHaveLength(1);

    // Episodio 2: vuelve la saturación con todo protegido → warn nuevo.
    for (let i = 3; i < 6; i++)
      _seedIntentSignature(`joven-${i}`, SIG_B, 1_000);
    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'n3',
    });
    expect(capWarns()).toHaveLength(2);
  });

  it('T-CAP-4: el desalojo respeta el borde exacto de la ventana protegida', async () => {
    const adapter = new SolanaPaymentAdapter();
    process.env.SOLANA_INTENT_DEDUP_MAX_ENTRIES = '1';

    // Justo EN el borde ⇒ protegida (la comparación es `<=`).
    _seedIntentSignature('en-el-borde', SIG_B, PROTECTED_WINDOW_MS);
    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'n1',
    });
    expect(adapter.getSettledSignature('en-el-borde')).toBe(SIG_B);

    // Un ms más vieja ⇒ desalojable.
    _resetSolanaClients();
    _seedIntentSignature('pasado-el-borde', SIG_B, PROTECTED_WINDOW_MS + 1);
    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'n2',
    });
    expect(adapter.getSettledSignature('pasado-el-borde')).toBeUndefined();
  });

  it('T-CAP-5: env de cap inválida → default 10.000 (no desaloja de más)', async () => {
    const adapter = new SolanaPaymentAdapter();
    process.env.SOLANA_INTENT_DEDUP_MAX_ENTRIES = 'abc';
    const age = PROTECTED_WINDOW_MS + 60_000;
    for (let i = 0; i < 20; i++) {
      _seedIntentSignature(`vieja-${i}`, SIG_B, age);
    }

    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'nueva',
    });

    expect(_intentDedupSize()).toBe(21); // muy por debajo de 10.000
  });

  // ── El self-heal sigue funcionando ─────────────────────────────────────

  it('T-HEAL-1: firma previa que NO verifica → se borra y se re-emite (self-heal intacto)', async () => {
    const adapter = new SolanaPaymentAdapter();
    // La firma previa no está confirmada on-chain.
    fakeConnection.getParsedTransaction.mockResolvedValue(null);
    _seedIntentSignature('run-1:0', SIG_B, 1_000);
    mockSendAndConfirm.mockResolvedValue(SIG_A);

    const res = await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'run-1:0',
    });

    // Re-broadcast con firma nueva, y el seam quedó apuntando a la nueva.
    expect(mockSendAndConfirm).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ txHash: SIG_A, success: true });
    expect(adapter.getSettledSignature('run-1:0')).toBe(SIG_A);
  });

  it('T-HEAL-2: el self-heal RENUEVA la antigüedad (la entrada nueva no hereda la vieja)', async () => {
    const adapter = new SolanaPaymentAdapter();
    fakeConnection.getParsedTransaction.mockResolvedValue(null);
    // Entrada casi vencida, pero aún viva.
    _seedIntentSignature('run-1:0', SIG_B, DEFAULT_TTL_MS - 5_000);
    mockSendAndConfirm.mockResolvedValue(SIG_A);

    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'run-1:0',
    });

    // Si hubiera heredado el `storedAt` viejo, expiraría en 5s. No debe.
    process.env.SOLANA_INTENT_DEDUP_TTL_MS = String(PROTECTED_WINDOW_MS);
    expect(adapter.getSettledSignature('run-1:0')).toBe(SIG_A);
  });

  it('T-HEAL-3: un settle nuevo sobre un intentId expirado re-emite (no reusa la firma vencida)', async () => {
    const adapter = new SolanaPaymentAdapter();
    _seedIntentSignature('viejo', SIG_B, DEFAULT_TTL_MS + 10_000);
    mockSendAndConfirm.mockResolvedValue(SIG_A);

    const res = await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'viejo',
    });

    // La entrada vencida NO se reusó → se broadcasteó de nuevo.
    expect(mockSendAndConfirm).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ txHash: SIG_A, success: true });
    // Y NO se llamó al verify de la firma vencida.
    expect(fakeConnection.getParsedTransaction).not.toHaveBeenCalled();
  });

  // ── Sin timers colgados ───────────────────────────────────────────────

  it('T-NOTIMER: el barrido es lazy — no se registra ningún setInterval', async () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const adapter = new SolanaPaymentAdapter();

    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'n1',
    });
    adapter.getSettledSignature('n1');

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
