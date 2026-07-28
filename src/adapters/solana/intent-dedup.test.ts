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
  _setIntentDedupClock,
  SolanaPaymentAdapter,
} from './payment.js';

/** Default de `TIMEOUT_COMPOSE_MS` (routes/compose.ts). NO es cota de ejecución. */
const COMPOSE_TIMEOUT_MS = 180_000;
/**
 * Cota ESTIMADA de vida de un run: 5 steps × 300 s (default de undici) = 25 min.
 *
 * AR it3 MENOR-2: el `5` se deja como literal INDEPENDIENTE a propósito (el código
 * lo toma de `lib/compose-limits.ts`). Es el tripwire: si alguien sube el máximo de
 * steps de `/compose`, la cota del código escala y esta batería FALLA, obligando a
 * re-revisar a mano el margen del TTL en vez de desalinearlo en silencio.
 */
const ESTIMATED_RUN_BOUND_MS = 5 * 300_000;
/** Ventana protegida: max(cota, TIMEOUT_COMPOSE_MS × 2) = 25 min. */
const PROTECTED_WINDOW_MS = ESTIMATED_RUN_BOUND_MS;
/** TTL default: max(cota × 2, 180s × 10, 30 min) = 50 min. */
const DEFAULT_TTL_MS = ESTIMATED_RUN_BOUND_MS * 2;

/**
 * HU-196 — época fija del reloj inyectado del seam.
 *
 * Toda esta batería declara la antigüedad de una entrada (`_seedIntentSignature`)
 * y después assertea cómo la trata la política. Con el reloj REAL hay dos
 * lecturas distintas (el alta y la evaluación), así que la edad efectiva es
 * `edad declarada + latencia del test`: los asserts de BORDE EXACTO (`T-CAP-4`
 * con `edad === ventana protegida`, y los `±1 ms` de `T-TTL-6/7/10`) miden algo
 * distinto de lo que declaran. Congelando el reloj, la edad declarada ES la que
 * ve el desalojo y el borde queda exacto en las dos direcciones.
 *
 * NO es `vi.useFakeTimers()`: no se toca ningún timer global (el barrido sigue
 * siendo lazy — ver `T-NOTIMER`) y el port se restaura en el `afterEach`, así que
 * no puede contaminar nada. El valor concreto es irrelevante, sólo importa que no
 * avance; se elige un epoch pasado para que `T-CLK-1` pueda distinguirlo del
 * reloj real.
 */
const FROZEN_NOW_MS = 1_700_000_000_000;

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
    // El reloj se instala DESPUÉS del reset a propósito: `_resetSolanaClients`
    // limpia el Map y NO toca el port, así que los tests que resetean a mitad de
    // cuerpo (T-TTL-5..10, T-CAP-4) conservan el reloj congelado.
    _setIntentDedupClock(() => FROZEN_NOW_MS);
    mockSendAndConfirm.mockResolvedValue(SIG_A);
  });

  afterEach(() => {
    _resetSolanaClients();
    cleanEnv();
    _setIntentDedupClock(); // vuelve al default de producción (`Date.now`)
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

  // HU-196: este test es EL borde. Con el reloj real la edad efectiva era
  // `PROTECTED_WINDOW_MS + latencia(seed → barrido)`, así que 1 ms de latencia
  // movía el caso «en el borde» al otro lado del `<=`, desalojaba la entrada y el
  // primer assert de acá abajo se ponía rojo (medido: ~1 de cada 14 corridas de la
  // suite COMPLETA, verde corriendo el archivo solo). Con el reloj congelado del
  // `beforeEach` la edad es exactamente la declarada.
  //
  // ⚠️ NO subir la edad sembrada para «darle aire»: eso deja de probar el borde,
  // que es justo el assert que impide que el desalojo se coma una firma que
  // todavía protege un run vivo (= doble pago).
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

  // ── El `delete` del self-heal, en sus DOS direcciones (P1 hallazgo 2) ──
  //
  // El `_intentSignatures.delete(req.intentId)` de `payment.ts:448` estaba
  // LINE-COVERED por T-HEAL-1/T-HEAL-2 pero NO protegido: borrando esa línea
  // entera la suite completa seguía verde (3364 passed). Motivo: en los dos
  // tests el re-broadcast SÍ tiene éxito, y el `rememberIntentSignature` del
  // camino feliz hace `.set()` — que SOBREESCRIBE la entrada vieja igual. O sea
  // que la assertion `getSettledSignature === SIG_A` pasa con y sin el `delete`.
  //
  // Los dos tests de abajo aíslan las dos direcciones en las que ese `delete`
  // cuesta plata, y las dos son mutación-positivas (ver work-item).

  it('T-P1-2a: firma previa que NO verifica + re-broadcast que FALLA → la firma huérfana NO queda en el seam', async () => {
    const adapter = new SolanaPaymentAdapter();
    // La firma previa NO está confirmada on-chain → el settle entra al self-heal.
    fakeConnection.getParsedTransaction.mockResolvedValue(null);
    _seedIntentSignature('run-1:0', SIG_B, 1_000);
    // ...y el re-broadcast fresco falla ANTES de firmar (sin firma derivable ⇒
    // `recoverConfirmedSettle` devuelve undefined y se propaga el error real).
    mockSendAndConfirm.mockRejectedValue(new Error('blockhash not found'));

    await expect(
      adapter.settle({
        payTo: PAY_TO,
        amountAtomic: '1000000',
        intentId: 'run-1:0',
      }),
    ).rejects.toThrow(/blockhash not found/);

    // ⚠️ ESTE es el invariante que el `delete` compra, y el único camino donde se
    // puede observar: como el re-broadcast falló, NADIE llamó a
    // `rememberIntentSignature`, así que si el `delete` no ocurrió la entrada
    // VIEJA (SIG_B, no confirmada on-chain) sobrevive.
    //
    // Por qué cuesta plata: `downstream-payment.ts:322` lee justo este seam
    // (`getSettledSignature`) y con `priorSignature !== undefined` marca el leg
    // como `isIdempotentReplay`, lo que convierte el pre-check de balance de GATE
    // en SONDA (`:368`) — un balance insuficiente deja de cortar. O sea: una firma
    // que la cadena NO reconoce quedaría desactivando el gate
    // `INSUFFICIENT_BALANCE` de todos los retries siguientes de ese leg.
    expect(adapter.getSettledSignature('run-1:0')).toBeUndefined();
    expect(_intentDedupSize()).toBe(0);
  });

  it('T-P1-2b: firma previa que SÍ verifica → la entrada SOBREVIVE (N retries, CERO broadcasts)', async () => {
    const adapter = new SolanaPaymentAdapter();
    // Transferencia confirmada on-chain por el monto exacto del leg.
    fakeConnection.getParsedTransaction.mockResolvedValue({
      meta: {
        err: null,
        preTokenBalances: [
          { owner: PAY_TO, mint: MINT, uiTokenAmount: { amount: '0' } },
        ],
        postTokenBalances: [
          { owner: PAY_TO, mint: MINT, uiTokenAmount: { amount: '1000000' } },
        ],
      },
    });
    _seedIntentSignature('run-1:0', SIG_B, 1_000);

    // TRES retries seguidos del mismo intent. El 3er es el que importa: si el
    // `delete` se volviera incondicional (o se moviera antes del `if
    // (verified.valid)`), el 1er retry devolvería la firma previa PERO dejaría el
    // seam vacío, y el SIGUIENTE retry re-broadcastearía = DOBLE PAGO de un leg
    // ya pagado on-chain.
    for (let i = 0; i < 3; i++) {
      const res = await adapter.settle({
        payTo: PAY_TO,
        amountAtomic: '1000000',
        intentId: 'run-1:0',
      });
      expect(res).toEqual({ txHash: SIG_B, success: true });
      // La entrada sigue viva DESPUÉS de cada hit idempotente.
      expect(adapter.getSettledSignature('run-1:0')).toBe(SIG_B);
      expect(_intentDedupSize()).toBe(1);
    }

    // Nunca se movió plata nueva.
    expect(mockSendAndConfirm).not.toHaveBeenCalled();
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

  // ── HU-196: el reloj del seam ─────────────────────────────────────────

  // OJO: `T-CLK-1` candadea la línea del RESTORE (`_intentDedupClock = clock ??
  // Date.now`), NO el INICIALIZADOR del port. Son dos líneas distintas y la que
  // corre en producción es el inicializador (nadie llama al setter en prod).
  // El inicializador lo candadea `T-CLK-2`. No fusionar los dos tests: cada uno
  // mata una mutación que el otro no ve.
  it('T-CLK-1: el reloj del seam es inyectable y el RESTORE vuelve al reloj real', () => {
    const adapter = new SolanaPaymentAdapter();

    // Con el reloj inyectado, la entrada nace en la época fija.
    _seedIntentSignature('nacida-en-la-epoca-fija', SIG_A, 0);
    expect(adapter.getSettledSignature('nacida-en-la-epoca-fija')).toBe(SIG_A);

    // Restaurar el default = volver a `Date.now`. La premisa se assertea en vez
    // de asumirse: hoy está a años de la época fija, muchísimo más que el TTL.
    _setIntentDedupClock();
    expect(Date.now()).toBeGreaterThan(FROZEN_NOW_MS + DEFAULT_TTL_MS);

    // Por lo tanto, después del restore la entrada se lee como VENCIDA. Si el
    // restore no volviera al reloj real (p. ej. si dejara pegado el reloj
    // inyectado) seguiría viva.
    expect(
      adapter.getSettledSignature('nacida-en-la-epoca-fija'),
    ).toBeUndefined();
  });

  /**
   * T-CLK-2 — el candado del INICIALIZADOR del port (`payment.ts`:
   * `let _intentDedupClock: IntentDedupClock = Date.now`).
   *
   * Es la línea que gobierna producción: nadie llama a `_setIntentDedupClock`
   * fuera de los tests, así que el valor INICIAL del port ES el reloj del
   * money-path. Un default congelado (p. ej. `() => 0`) desactiva los dos guards
   * a la vez, porque `now - storedAt` queda siempre en 0:
   *   · el TTL nunca expira ⇒ una firma vieja se recuerda para siempre;
   *   · el desalojo nunca saca nada ⇒ el `break` de la ventana protegida corta en
   *     la primera entrada y el cap soft de 10k queda inoperante (el leak de
   *     memoria que el fix-pack P1 vino a cerrar).
   *
   * Por qué ningún test lo veía: toda la batería siembra `storedAt` RELATIVO a
   * `intentDedupNow()`, así que un reloj congelado es internamente consistente e
   * indetectable. Y `T-CLK-1` pasa por el setter, que tiene su propio literal
   * `Date.now` (otra línea).
   *
   * Estrategia: instancia FRESCA del módulo (el `beforeEach` ya inyectó el reloj
   * congelado en la instancia de este archivo, así que el valor inicial sólo se
   * puede observar en una copia nueva) + test de EFECTO, no de identidad: se
   * escribe por el camino de producción y se acota el `storedAt` resultante
   * contra `Date.now()` real por los DOS lados.
   */
  it('T-CLK-2: el módulo ARRANCA con el reloj real — candado del inicializador del port, no del restore', async () => {
    // `vi.resetModules()` no toca los `vi.mock` del archivo (siguen registrados),
    // sólo descarta las instancias cacheadas.
    vi.resetModules();
    const fresh = await import('./payment.js');
    const adapter = new fresh.SolanaPaymentAdapter();
    const ttl = fresh._intentDedupPolicy().ttlMs;
    /** Holgura de la cota. Absorbe la latencia real del `settle` mockeado. */
    const TOL_MS = 5_000;

    // Escritura por el camino de PRODUCCIÓN (`settle` → `rememberIntentSignature`)
    // con el port en su valor INICIAL: `storedAt` = lo que devuelva ese reloj.
    const probe = Date.now();
    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'escrita-con-el-reloj-inicial',
    });

    // Ahora se LEE con relojes conocidos. Cada assert acota `storedAt` de un lado:
    //
    //   viva a `probe + ttl - TOL`   ⇔  storedAt >= probe - TOL
    // Un default en el pasado (`() => 0`, o cualquiera desfasado más de TOL hacia
    // atrás) hace que la entrada se lea VENCIDA acá.
    fresh._setIntentDedupClock(() => probe + ttl - TOL_MS);
    expect(
      adapter.getSettledSignature('escrita-con-el-reloj-inicial'),
      'el reloj inicial del port quedó en el PASADO respecto de Date.now()',
    ).toBe(SIG_A);

    //   vencida a `probe + ttl + TOL`  ⇔  storedAt < probe + TOL
    // Un default en el futuro hace que la entrada se lea VIVA acá.
    fresh._setIntentDedupClock(() => probe + ttl + TOL_MS);
    expect(
      adapter.getSettledSignature('escrita-con-el-reloj-inicial'),
      'el reloj inicial del port quedó en el FUTURO respecto de Date.now()',
    ).toBeUndefined();

    // Los dos juntos ⇒ |reloj inicial − Date.now()| < 5 s, sin assertear la
    // identidad de la función: cualquier reloj que no sea el real (congelado o
    // desfasado) rompe uno de los dos.
    fresh._setIntentDedupClock();
  });
});
