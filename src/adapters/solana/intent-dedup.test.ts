/**
 * WKH-307 — IDEMPOTENCIA DURABLE DEL SETTLE SOLANA: los ACs, medidos en broadcasts.
 *
 * ── LA UNIDAD DE MEDIDA ────────────────────────────────────────────────────
 *
 * Casi toda aserción de este archivo termina en
 * `expect(sendRawTransaction).toHaveBeenCalledTimes(N)` con `N ∈ {0,1}`, más el monto
 * y el destino cuando `N = 1`. La pregunta que responde cada test es *¿salió una
 * transmisión? ¿cuántas? ¿de cuánto y a quién?* — **nunca** *¿se llamó a tal función
 * interna?* ni *¿existe tal variable?*. Un AC que se satisface por construcción no
 * mide nada.
 *
 * ── DESTINO DE LA BATERÍA ANTERIOR (26 tests) ──────────────────────────────
 *
 * Este archivo candaba una política de `Map` en memoria —TTL, cap, ventana protegida,
 * reloj inyectable— que WKH-307 elimina ENTERA. Un test de una política borrada no
 * puede sobrevivir a la política. Conteo auditado: **23 eliminados · 2 invertidos ·
 * 1 migrado**.
 *
 * | # | Test anterior | Destino | Por qué |
 * |---|---|---|---|
 * | 1 | `T-TTL-1: una entrada FRESCA sigue siendo idempotente` | ELIMINADO | La propiedad sobrevive en `T-IDM-03`, pero sin TTL el escenario "fresca" no existe |
 * | 2 | `T-TTL-2: una entrada EXPIRADA se trata como ausente` | ELIMINADO | No hay expiración |
 * | 3 | `T-TTL-3: leer una entrada expirada la BORRA` | ELIMINADO | ídem |
 * | 4 | `T-TTL-4: el barrido en el set limpia las expiradas` | ELIMINADO | No hay barrido |
 * | 5 | `T-TTL-5 (INVARIANTE): no puede expirar dentro de la cota estimada` | ELIMINADO | Nada expira |
 * | 6 | `T-TTL-6 (INVARIANTE): el TTL default duplica la cota estimada` | ELIMINADO | ídem |
 * | 7 | `T-TTL-7 (FAIL-SAFE del knob): override corto se eleva al piso` | ELIMINADO | El knob se retiró de `.env.example` |
 * | 8 | `T-TTL-8: un override RAZONABLE se respeta` | ELIMINADO | ídem |
 * | 9 | `T-TTL-9: el TTL sigue a TIMEOUT_COMPOSE_MS` | ELIMINADO | ídem |
 * | 10 | `T-TTL-10: env inválida → default` | ELIMINADO | ídem |
 * | 11 | `T-TTL-11 (AR MENOR-1): el piso del knob es la cota ESTIMADA` | ELIMINADO | ídem |
 * | 12 | `T-CAP-1: el cap DESALOJA las más viejas` | ELIMINADO | No hay cap (una tabla no tiene el leak que el cap acotaba) |
 * | 13 | `T-CAP-2 (FAIL-SAFE): todas protegidas → no se desaloja nada` | ELIMINADO | ídem |
 * | 14 | `T-CAP-3: el cap excedido emite un warn una vez por episodio` | ELIMINADO | ídem |
 * | 15 | `T-CAP-4: el desalojo respeta el borde exacto de la ventana` | ELIMINADO | ídem |
 * | 16 | `T-CAP-5: env de cap inválida → default 10.000` | ELIMINADO | ídem |
 * | 17 | `T-CAP-6 (AR MENOR-2): el warn se RE-ARMA al bajar del cap` | ELIMINADO | ídem |
 * | 18 | `T-CAP-7 (AR MENOR-2): el re-armado también con el DESALOJO` | ELIMINADO | ídem |
 * | 19 | `T-CLK-1: el reloj del seam es inyectable y el RESTORE vuelve al real` | ELIMINADO | El reloj pasa a ser el de Postgres. No hay reloj de proceso que inyectar |
 * | 20 | `T-CLK-2: el módulo ARRANCA con el reloj real` | ELIMINADO | ídem |
 * | 21 | `T-NOTIMER: el barrido es lazy — ningún setInterval` | ELIMINADO | No hay barrido |
 * | 22 | `T-HEAL-2: el self-heal RENUEVA la antigüedad` | ELIMINADO | Mecánica de retención pura |
 * | 23 | `T-HEAL-3: settle nuevo sobre un intentId expirado re-emite` | ELIMINADO | Dependía de la expiración. **La propiedad legítima que cubría —una tx que nunca aterrizó se puede reintentar— sobrevive MEJOR en `T-IDM-06b`**: ahí el blockhash expirado es una PRUEBA, no una inferencia por tiempo |
 * | 24 | `T-HEAL-1: firma previa que NO verifica → se borra y se re-emite` | **INVERTIDO** → `T-IDM-12` | Cambio de conducta declarado (R-3) |
 * | 25 | `T-P1-2a: firma que no verifica + re-broadcast que falla → no queda huérfana` | **INVERTIDO** → `T-IDM-12` | Ya no hay re-broadcast que pueda dejar huérfana |
 * | 26 | `T-P1-2b: firma que SÍ verifica → la entrada SOBREVIVE (N retries, CERO broadcasts)` | **MIGRADO** → `T-IDM-03b` | La propiedad es exactamente la de la HU; sólo cambia el almacén |
 *
 * ── SOBRE EL DOBLE DEL LEDGER ──────────────────────────────────────────────
 *
 * `fakeLedger` emula la PK y el índice UNIQUE PARCIAL de verdad (un `Map` que rechaza
 * el segundo insert, un `Set` de firmas que rechaza la repetida). Eso NO es
 * "re-implementar el SQL y afirmar sobre la re-implementación": lo que el `.sql`
 * garantiza se verifica **extrayendo y evaluando sus predicados** en
 * `test/wkh307-solana-settle-intents.migration.test.ts`. Acá el doble existe para que
 * el ADAPTER pueda ejercitar los caminos que esas garantías habilitan.
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const PAY_TO = 'So11111111111111111111111111111111111111112';
const PAY_TO_B = 'Vote111111111111111111111111111111111111111';
/**
 * ⚠️ Keypair REAL, no un doble con `secretKey` en ceros. `tx.serialize()` VERIFICA las
 * firmas, así que un secreto falso hace que el adapter explote al serializar — el test
 * fallaría por el doble y no por el código. Con un keypair real la firma es válida, y
 * además dos transacciones con el MISMO mensaje bajo el MISMO blockhash producen la
 * MISMA firma, que es exactamente el escenario que ejercita T-IDM-08.
 */
const OPERATOR_KEYPAIR = Keypair.generate();
const OPERATOR = OPERATOR_KEYPAIR.publicKey.toBase58();
const AMOUNT = '3000000';

/** Un blockhash válido: 32 bytes en base58 (una pubkey sirve). */
const freshBlockhash = () => Keypair.generate().publicKey.toBase58();
/** Blockhashes forzados por el test (se consumen en orden). */
const blockhashQueue: string[] = [];

// ── El doble de la CONEXIÓN. `sendRawTransaction` es la unidad de medida ────
/** Estado que devuelve `getSignatureStatuses` (null = ausente tras buscar historico). */
const presenceState: { value: { err: unknown } | null } = {
  value: { err: null },
};
/** La tx NO esta en la cadena (el nodo respondio habiendo buscado su historico). */
function onChainAbsent() {
  presenceState.value = null;
}
/** La tx esta en la cadena pero FALLO on-chain. */
function onChainFailed() {
  presenceState.value = { err: { InstructionError: [0, 'Custom'] } };
}

const fakeConnection = {
  getParsedTransaction: vi.fn(
    (..._a: unknown[]): Promise<unknown> => Promise.resolve(null),
  ),
  getTokenAccountBalance: vi.fn(
    (..._a: unknown[]): Promise<unknown> =>
      Promise.resolve({ value: { amount: '1000000000' } }),
  ),
  /**
   * ⚠️ Devuelve un blockhash FRESCO en cada llamada, como un RPC real (los bloques
   * avanzan). Si devolviera siempre el mismo, dos settles distintos producirían el
   * MISMO mensaje y por lo tanto la MISMA firma, y todo test con más de un intent
   * chocaría contra el UNIQUE — fallando por el doble y no por el código.
   *
   * `blockhashQueue` permite a un test FORZAR una repetición, que es justamente el
   * escenario de colisión de T-IDM-08.
   */
  getLatestBlockhash: vi.fn(
    (
      ..._a: unknown[]
    ): Promise<{
      blockhash: string;
      lastValidBlockHeight: number;
    }> =>
      Promise.resolve({
        blockhash: blockhashQueue.shift() ?? freshBlockhash(),
        lastValidBlockHeight: 1000,
      }),
  ),
  sendRawTransaction: vi.fn((..._a: unknown[]) => Promise.resolve('sent')),
  confirmTransaction: vi.fn((..._a: unknown[]) =>
    Promise.resolve({ value: { err: null } }),
  ),
  getBlockHeight: vi.fn((..._a: unknown[]) => Promise.resolve(900)),
  // AR re-review MNR-1: el preflight MIDE la ventana de historico del RPC, porque de
  // ella depende que un `absent` signifique algo. Default = holgada.
  getSlot: vi.fn((..._a: unknown[]) => Promise.resolve(200_000_000)),
  getFirstAvailableBlock: vi.fn((..._a: unknown[]) => Promise.resolve(1)),
  /**
   * AR BLQ-MEDIO-1: la determinacion NEGATIVA ya no sale de un `null` de
   * `getParsedTransaction` (que tambien significa "este nodo no lo tiene indexado"),
   * sino de `getSignatureStatuses` con `searchTransactionHistory`.
   *
   * Default = PRESENTE y sin error. `onChainAbsent()` lo pone en ausente para los
   * tests que modelan "la tx no aterrizo".
   */
  getSignatureStatuses: vi.fn((..._a: unknown[]) =>
    Promise.resolve({ value: [presenceState.value] }),
  ),
};
vi.mock('./chain.js', () => ({
  getSolanaConnection: vi.fn((..._a: unknown[]) => fakeConnection),
  getSolanaOperatorKeypair: vi.fn((..._a: unknown[]) => OPERATOR_KEYPAIR),
  getSolanaUsdcMint: vi.fn((..._a: unknown[]) => MINT),
  getSolanaUsdcDecimals: vi.fn((..._a: unknown[]) => 6),
  getSolanaCommitment: vi.fn((..._a: unknown[]) => 'confirmed'),
  getSolanaCaip2: vi.fn((..._a: unknown[]) => 'solana:test'),
}));

const mockGetOrCreateAta = vi.fn((..._a: unknown[]) =>
  Promise.resolve({ address: new PublicKey(PAY_TO) }),
);
vi.mock('@solana/spl-token', () => ({
  getOrCreateAssociatedTokenAccount: (...a: unknown[]) =>
    mockGetOrCreateAta(...a),
  createTransferInstruction: (..._a: unknown[]) => ({
    keys: [],
    programId: new PublicKey(MINT),
    data: Buffer.alloc(0),
  }),
  getAssociatedTokenAddressSync: (..._a: unknown[]) => new PublicKey(OPERATOR),
}));

// ── EL DOBLE DEL LEDGER, con PK y UNIQUE PARCIAL emulados ──────────────────
type Row = {
  status: 'claimed' | 'signed' | 'confirmed';
  payTo: string;
  amountAtomic: string;
  mint: string;
  signature: string | null;
  lastValidBlockHeight: string | null;
  attempts: number;
};

const fakeLedger = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  signatures: new Set<string>(),
  /** `true` ⟹ el lease del reclamo se considera vencido (la fila es tomable). */
  leaseExpired: false,
  /** Fuerza `store_unavailable` en el reclamo. */
  claimFails: null as string | null,
  probeVerdict: { probe: 'ok' } as unknown,
  reset() {
    this.rows.clear();
    this.signatures.clear();
    this.leaseExpired = false;
    this.claimFails = null;
    this.probeVerdict = { probe: 'ok' };
  },
}));

const claimMock = vi.hoisted(() => vi.fn());
const recordSignedMock = vi.hoisted(() => vi.fn());
const recordConfirmedMock = vi.hoisted(() => vi.fn());
const reclaimMock = vi.hoisted(() => vi.fn());
const readMock = vi.hoisted(() => vi.fn());
const probeMock = vi.hoisted(() => vi.fn());

vi.mock('./settle-ledger.js', () => ({
  claimSettleIntent: claimMock,
  recordSignedIntent: recordSignedMock,
  recordConfirmedIntent: recordConfirmedMock,
  reclaimExpiredIntent: reclaimMock,
  readSettleIntent: readMock,
  probeSettleLedger: probeMock,
}));

// ⚠️ `schema-preflight.js` NO se mockea: se usa el REAL, para poder medir su
// MEMOIZACIÓN (T-IDM-10b) sobre el `probeSettleLedger` mockeado de arriba.
import { _resetSolanaClients, SolanaPaymentAdapter } from './payment.js';

/** Instala el comportamiento del ledger emulando PK + UNIQUE parcial. */
function wireLedger() {
  claimMock.mockImplementation(
    async (a: {
      intentId: string;
      payTo: string;
      amountAtomic: string;
      mint: string;
    }) => {
      if (fakeLedger.claimFails) {
        return { outcome: 'store_unavailable', detail: fakeLedger.claimFails };
      }
      const existing = fakeLedger.rows.get(a.intentId) as Row | undefined;
      if (!existing) {
        // El INSERT gana: la PK garantiza que sólo uno llegue acá.
        fakeLedger.rows.set(a.intentId, {
          status: 'claimed',
          payTo: a.payTo,
          amountAtomic: a.amountAtomic,
          mint: a.mint,
          signature: null,
          lastValidBlockHeight: null,
          attempts: 1,
        } satisfies Row);
        return { outcome: 'claimed', attempts: 1 };
      }
      // Los términos mandan por encima del estado (AC-8).
      if (
        existing.payTo !== a.payTo ||
        existing.amountAtomic !== a.amountAtomic ||
        existing.mint !== a.mint
      ) {
        return { outcome: 'terms_conflict', status: existing.status };
      }
      if (existing.status === 'claimed') {
        if (!fakeLedger.leaseExpired) return { outcome: 'in_progress' };
        existing.attempts += 1;
        return { outcome: 'claimed', attempts: existing.attempts };
      }
      if (existing.status === 'signed') {
        return {
          outcome: 'signed',
          signature: existing.signature,
          lastValidBlockHeight: existing.lastValidBlockHeight,
        };
      }
      return { outcome: 'confirmed', signature: existing.signature };
    },
  );

  recordSignedMock.mockImplementation(
    async (a: {
      intentId: string;
      signature: string;
      lastValidBlockHeight: string;
    }) => {
      const row = fakeLedger.rows.get(a.intentId) as Row | undefined;
      if (row?.status !== 'claimed') {
        return { ok: false, reason: 'not_claimed', detail: 'not claimed' };
      }
      // EL ÍNDICE UNIQUE PARCIAL: la misma firma no puede existir dos veces.
      if (fakeLedger.signatures.has(a.signature)) {
        return {
          ok: false,
          reason: 'signature_collision',
          detail: 'duplicate key',
        };
      }
      fakeLedger.signatures.add(a.signature);
      row.status = 'signed';
      row.signature = a.signature;
      row.lastValidBlockHeight = a.lastValidBlockHeight;
      return { ok: true, attempts: row.attempts };
    },
  );

  recordConfirmedMock.mockImplementation(
    async (a: { intentId: string; signature: string }) => {
      const row = fakeLedger.rows.get(a.intentId) as Row | undefined;
      if (!row || row.signature !== a.signature) {
        return { ok: false, reason: 'signature_mismatch', detail: 'mismatch' };
      }
      row.status = 'confirmed';
      return { ok: true };
    },
  );

  reclaimMock.mockImplementation(
    async (a: { intentId: string; signature: string }) => {
      const row = fakeLedger.rows.get(a.intentId) as Row | undefined;
      if (row?.status !== 'signed' || row.signature !== a.signature) {
        return { ok: false, reason: 'not_signed', detail: 'not signed' };
      }
      row.status = 'claimed';
      row.signature = null;
      row.lastValidBlockHeight = null;
      row.attempts += 1;
      return { ok: true };
    },
  );

  readMock.mockImplementation(async (intentId: string) => {
    const row = fakeLedger.rows.get(intentId) as Row | undefined;
    if (!row) return { state: 'none' };
    if (row.status === 'confirmed' && row.signature) {
      return { state: 'confirmed', signature: row.signature };
    }
    if (row.status === 'signed' && row.signature) {
      return { state: 'signed', signature: row.signature };
    }
    return { state: 'claimed' };
  });

  probeMock.mockImplementation(async () => fakeLedger.probeVerdict);
}

/** Siembra una fila con el estado que el test necesita ejercitar. */
function seedRow(intentId: string, over: Partial<Row> = {}) {
  const row: Row = {
    status: 'confirmed',
    payTo: PAY_TO,
    amountAtomic: AMOUNT,
    mint: MINT,
    signature: 'PriorSignature1111',
    lastValidBlockHeight: '1000',
    attempts: 1,
    ...over,
  };
  fakeLedger.rows.set(intentId, row);
  if (row.signature !== null) fakeLedger.signatures.add(row.signature);
}

/** Hace que la tx `verify()` bien para `payTo`/`amount`. */
function onChainOk() {
  fakeConnection.getParsedTransaction.mockResolvedValue({
    meta: {
      err: null,
      preTokenBalances: [
        {
          accountIndex: 1,
          owner: PAY_TO,
          mint: MINT,
          uiTokenAmount: { amount: '0' },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          owner: PAY_TO,
          mint: MINT,
          uiTokenAmount: { amount: AMOUNT },
        },
      ],
    },
  });
}

const req = (intentId: string, over: Record<string, unknown> = {}) => ({
  payTo: PAY_TO,
  amountAtomic: AMOUNT,
  intentId,
  ...over,
});

let adapter: SolanaPaymentAdapter;

beforeEach(() => {
  vi.clearAllMocks();
  fakeLedger.reset();
  wireLedger();
  fakeConnection.getParsedTransaction.mockResolvedValue(null);
  presenceState.value = { err: null };
  blockhashQueue.length = 0;
  fakeConnection.getBlockHeight.mockResolvedValue(900);
  fakeConnection.getSlot.mockResolvedValue(200_000_000);
  fakeConnection.getFirstAvailableBlock.mockResolvedValue(1);
  delete process.env.SOLANA_RPC_LEDGER_HISTORY_DECLARED_SUFFICIENT;
  _resetSolanaClients();
  adapter = new SolanaPaymentAdapter();
});

afterEach(() => {
  _resetSolanaClients();
});

// ══════════════════════════════════════════════════════════════
// AC-1 — sin reclamo no hay transmisión
// ══════════════════════════════════════════════════════════════

describe('WKH-307 · AC-1: el reclamo gobierna la transmisión', () => {
  it('T-IDM-01a: reclamo rechazado ⟹ CERO broadcasts y settle() rechaza', async () => {
    fakeLedger.claimFails = 'db down';
    await expect(adapter.settle(req('run:0'))).rejects.toThrow();
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
  });

  it('T-IDM-01b: el reclamo ocurre ANTES del primer broadcast (orden, no coincidencia)', async () => {
    await adapter.settle(req('run:0'));
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
    const claimOrder = claimMock.mock.invocationCallOrder[0] as number;
    const sendOrder = fakeConnection.sendRawTransaction.mock
      .invocationCallOrder[0] as number;
    expect(claimOrder).toBeLessThan(sendOrder);
  });

  it('T-IDM-01c: si `recordSigned` no aplica, NO se transmite (invariante I2)', async () => {
    recordSignedMock.mockResolvedValue({
      ok: false,
      reason: 'not_claimed',
      detail: 'someone else owns it',
    });
    await expect(adapter.settle(req('run:0'))).rejects.toThrow(
      /SETTLE_LEDGER_WRITE_REFUSED/,
    );
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
  });
});

// ══════════════════════════════════════════════════════════════
// AC-2 — concurrencia
// ══════════════════════════════════════════════════════════════

describe('WKH-307 · AC-2: dos settle() concurrentes, una sola transferencia', () => {
  it('T-IDM-02: `Promise.allSettled` sobre el mismo intentId ⟹ EXACTAMENTE 1 broadcast', async () => {
    // La PK emulada rechaza el segundo insert, igual que Postgres.
    const results = await Promise.allSettled([
      adapter.settle(req('run:0')),
      adapter.settle(req('run:0')),
    ]);
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    // La perdedora RECHAZA: nunca devuelve success:true sobre un pago ajeno.
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════
// AC-3 / AC-5 — el hit idempotente, y que sobreviva al restart
// ══════════════════════════════════════════════════════════════

describe('WKH-307 · AC-3/AC-5: el pago ya hecho no se repite', () => {
  it('T-IDM-03: fila `confirmed` + verify válido ⟹ esa firma, 0 broadcasts, y SE RE-VERIFICÓ', async () => {
    seedRow('run:0');
    onChainOk();
    const res = await adapter.settle(req('run:0'));
    expect(res).toEqual({ txHash: 'PriorSignature1111', success: true });
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
    // La firma NO se devolvió sin preguntarle a la cadena (verify-before-trust).
    expect(fakeConnection.getParsedTransaction).toHaveBeenCalled();
  });

  it('T-IDM-03b (absorbe T-P1-2b): N retries, CERO broadcasts', async () => {
    seedRow('run:0');
    onChainOk();
    for (let i = 0; i < 5; i++) {
      const res = await adapter.settle(req('run:0'));
      expect(res.txHash).toBe('PriorSignature1111');
    }
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
  });

  it('T-IDM-05: EL TEST QUE CANDA EL MOTIVO DE LA HU — instancia nueva sin estado en memoria', async () => {
    // La fila ya está `confirmed` en el store. El adapter se crea DESPUÉS del reset,
    // o sea con cero memoria de proceso: es el escenario exacto del restart que antes
    // hacía re-transmitir un SPL transfer REAL.
    seedRow('run:0');
    onChainOk();
    _resetSolanaClients();
    const freshAdapter = new SolanaPaymentAdapter();
    const res = await freshAdapter.settle(req('run:0'));
    expect(res).toEqual({ txHash: 'PriorSignature1111', success: true });
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
  });
});

// ══════════════════════════════════════════════════════════════
// AC-4 — indisponibilidad del store
// ══════════════════════════════════════════════════════════════

describe('WKH-307 · AC-4: "no sé" nunca paga', () => {
  it('T-IDM-04: los tres modos de indisponibilidad ⟹ 0 broadcasts y ningún success', async () => {
    // (1) el seam devuelve store_unavailable
    fakeLedger.claimFails = 'rpc error';
    await expect(adapter.settle(req('run:0'))).rejects.toThrow(
      /SETTLE_LEDGER_UNAVAILABLE/,
    );

    // (2) el seam LANZA
    fakeLedger.claimFails = null;
    claimMock.mockRejectedValueOnce(new Error('connection reset'));
    await expect(adapter.settle(req('run:1'))).rejects.toThrow();

    // (3) forma inesperada / respuesta degradada
    claimMock.mockResolvedValueOnce({
      outcome: 'store_unavailable',
      detail: 'no usable row',
    });
    await expect(adapter.settle(req('run:2'))).rejects.toThrow();

    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
  });
});

// ══════════════════════════════════════════════════════════════
// AC-6 — la rama `signed`, con sus tres salidas por DEMOSTRACIÓN
// ══════════════════════════════════════════════════════════════

describe('WKH-307 · AC-6: una firma persistida se resuelve contra la cadena', () => {
  it('T-IDM-06a: `signed` + confirmada on-chain ⟹ esa firma, 0 broadcasts, fila a `confirmed`', async () => {
    seedRow('run:0', { status: 'signed', signature: 'SignedSig999' });
    onChainOk();
    const res = await adapter.settle(req('run:0'));
    expect(res).toEqual({ txHash: 'SignedSig999', success: true });
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
    expect((fakeLedger.rows.get('run:0') as Row).status).toBe('confirmed');
  });

  it('T-IDM-06b: `signed` + NO confirmada + blockhash MUERTO ⟹ re-firma y EXACTAMENTE 1 broadcast', async () => {
    // Sustituye a T-HEAL-3, y mejor: la salida es una PRUEBA (la altura pasó el
    // último bloque válido), no una inferencia por tiempo.
    seedRow('run:0', {
      status: 'signed',
      signature: 'ExpiredSig777',
      lastValidBlockHeight: '500',
    });
    // AR BLQ-MEDIO-1: la ausencia la PRUEBA el nodo respondiendo tras buscar su
    // histórico. Un `null` de `getParsedTransaction` no alcanza: también significa
    // "este nodo no lo tiene indexado", y sobre esa lectura se re-transmitía.
    onChainAbsent();
    fakeConnection.getParsedTransaction.mockResolvedValue(null);
    fakeConnection.getBlockHeight.mockResolvedValue(900); // 900 > 500 ⟹ muerta

    const res = await adapter.settle(req('run:0'));
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
    // La firma vieja quedó archivada y la nueva es DISTINTA.
    expect(res.txHash).not.toBe('ExpiredSig777');
    expect(reclaimMock).toHaveBeenCalledWith({
      intentId: 'run:0',
      signature: 'ExpiredSig777',
    });
  });

  it('T-IDM-06c: `signed` + NO confirmada + blockhash VIVO ⟹ 0 broadcasts y rechazo', async () => {
    // Todavía podría aterrizar. Es la única ventana donde el sistema dice "no sé
    // todavía" — y "no sé" nunca autoriza pagar.
    seedRow('run:0', {
      status: 'signed',
      signature: 'InFlightSig555',
      lastValidBlockHeight: '1500',
    });
    onChainAbsent();
    fakeConnection.getParsedTransaction.mockResolvedValue(null);
    fakeConnection.getBlockHeight.mockResolvedValue(900); // 900 <= 1500 ⟹ viva

    await expect(adapter.settle(req('run:0'))).rejects.toThrow(
      /SETTLE_IN_FLIGHT_UNRESOLVED/,
    );
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
  });
});

// ══════════════════════════════════════════════════════════════
// AC-8 — los términos del intent
// ══════════════════════════════════════════════════════════════

describe('WKH-307 · AC-8: otros términos no son el mismo pago', () => {
  it('T-IDM-07: destino o monto distintos ⟹ 0 broadcasts y SIN devolver la firma previa', async () => {
    for (const over of [{ payTo: PAY_TO_B }, { amountAtomic: '9999999' }]) {
      fakeLedger.reset();
      wireLedger();
      seedRow('run:0', { signature: 'PaidToSomeoneElse' });
      onChainOk();
      fakeConnection.sendRawTransaction.mockClear();

      const err = await adapter
        .settle(req('run:0', over))
        .catch((e: Error) => e);
      expect(String(err)).toMatch(/SETTLE_INTENT_CONFLICT/);
      expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
      // Y el error NO filtra la firma del pago ajeno.
      expect(String(err)).not.toContain('PaidToSomeoneElse');
    }
  });

  it('T-IDM-07b: el mint distinto también entra por terms_conflict', async () => {
    seedRow('run:0', { mint: 'OtherMint1111111111111111111111111111111' });
    await expect(adapter.settle(req('run:0'))).rejects.toThrow(
      /SETTLE_INTENT_CONFLICT/,
    );
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
  });
});

// ══════════════════════════════════════════════════════════════
// AC-9 — la colisión de firma
// ══════════════════════════════════════════════════════════════

describe('WKH-307 · AC-9: dos legs idénticos no pueden compartir firma', () => {
  it('T-IDM-08: colisión ⟹ el adapter RE-FIRMA y transmite con una firma distinta', async () => {
    // Escenario real: dos legs del mismo run al MISMO agente por el MISMO monto. Bajo
    // el mismo blockhash el mensaje es idéntico ⟹ la misma firma ed25519 ⟹ UNA sola
    // transferencia contabilizada como DOS pagos. El UNIQUE lo hace imposible.
    const shared = freshBlockhash();
    // Los dos legs arrancan bajo EL MISMO blockhash ⟹ mismo mensaje ⟹ misma firma.
    blockhashQueue.push(shared, shared);

    const first = await adapter.settle(req('run:0'));
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(1);

    // El segundo leg colisiona; el doble emula el 23505 y el adapter tiene que
    // re-firmar. La tercera llamada a getLatestBlockhash ya devuelve uno fresco.
    const second = await adapter.settle(req('run:1'));
    expect(second.txHash).not.toBe(first.txHash);
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(2);
    // Nunca dos filas con la misma firma.
    expect(fakeLedger.signatures.size).toBe(2);
  });

  it('T-IDM-08b: agotados los intentos ⟹ CERO broadcasts y rechazo', async () => {
    // El blockhash nunca cambia ⟹ la firma siempre colisiona.
    recordSignedMock.mockResolvedValue({
      ok: false,
      reason: 'signature_collision',
      detail: 'duplicate key',
    });
    await expect(adapter.settle(req('run:0'))).rejects.toThrow(
      /SETTLE_SIGNATURE_COLLISION_EXHAUSTED/,
    );
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
  });
});

// ══════════════════════════════════════════════════════════════
// AC-10 — el lease
// ══════════════════════════════════════════════════════════════

describe('WKH-307 · AC-10: un reclamo huérfano no traba la plata para siempre', () => {
  it('T-IDM-09a: `claimed` FUERA del lease ⟹ se toma el relevo y sale 1 broadcast', async () => {
    // Seguro por DEMOSTRACIÓN: una fila `claimed` no tiene firma, y la firma se
    // persiste ANTES de transmitir ⟹ nunca se transmitió nada.
    seedRow('run:0', { status: 'claimed', signature: null });
    fakeLedger.leaseExpired = true;
    await adapter.settle(req('run:0'));
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('T-IDM-09b: `claimed` DENTRO del lease ⟹ 0 broadcasts', async () => {
    seedRow('run:0', { status: 'claimed', signature: null });
    fakeLedger.leaseExpired = false;
    await expect(adapter.settle(req('run:0'))).rejects.toThrow(
      /SETTLE_IN_PROGRESS/,
    );
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
  });
});

// ══════════════════════════════════════════════════════════════
// AC-11 — el preflight, y su COSTO
// ══════════════════════════════════════════════════════════════

describe('WKH-307 · AC-11: el gate de esquema se ejecuta', () => {
  it('T-IDM-10a: veredicto negativo ⟹ 0 broadcasts y rechazo con el motivo del esquema', async () => {
    fakeLedger.probeVerdict = { probe: 'table_missing', detail: 'no relation' };
    await expect(adapter.settle(req('run:0'))).rejects.toThrow(
      /SETTLE_LEDGER_SCHEMA_UNAVAILABLE: table_missing/,
    );
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
    // Ni siquiera se reclamó: el preflight es la PRIMERA operación.
    expect(claimMock).not.toHaveBeenCalled();
  });

  it('T-IDM-10b: SE AFIRMA EL COSTO — 1 solo probe en 3 settles (memoización)', async () => {
    // Lección HU-208 M5: toda afirmación del tipo "no agrega costo" tiene que asertar
    // el costo, no describirlo.
    await adapter.settle(req('run:0'));
    await adapter.settle(req('run:1'));
    await adapter.settle(req('run:2'));
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(3);
    expect(probeMock).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════════
// R-3 — la INVERSIÓN de T-HEAL-1 / T-P1-2a
// ══════════════════════════════════════════════════════════════

describe('WKH-307 · R-3: una firma confirmada que no verifica NO se re-emite', () => {
  it('T-IDM-12: `confirmed` + verify FALLA ⟹ 0 broadcasts y rechazo', async () => {
    // ⚠️ CAMBIO DE CONDUCTA DECLARADO. El seam viejo borraba la entrada y
    // re-broadcasteaba (self-heal). Con store durable, "la firma registrada no
    // verifica" es un RPC mintiendo o contabilidad corrupta: ninguna se arregla
    // pagando de nuevo. Este test afirma lo CONTRARIO de T-HEAL-1/T-P1-2a.
    seedRow('run:0');
    onChainAbsent(); // la firma registrada NO está en la cadena
    fakeConnection.getParsedTransaction.mockResolvedValue(null);
    await expect(adapter.settle(req('run:0'))).rejects.toThrow(
      /SETTLE_CONFIRMED_BUT_UNVERIFIABLE/,
    );
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
  });
});

// ══════════════════════════════════════════════════════════════
// AR BLQ-MEDIO-1 — un `null` de RPC NO prueba ausencia
//
// EL DOBLE PAGO CONCRETO QUE ESTOS TESTS CIERRAN: se firma, se persiste, se
// transmite y la tx SÍ aterriza, pero `confirmTransaction` corta por timeout. Dos
// minutos después llega el retry. `getBlockHeight` pega contra el nodo de la punta
// (altura > lastValid ✓) y la lectura de la tx pega contra OTRO nodo del pool que
// todavía no indexó ese bloque → `null`. Con la lógica anterior eso se leía como
// "expiró sin aterrizar" ⟹ segundo SPL transfer REAL sobre un pago ya hecho. En
// Solana no hay backstop on-chain: no se puede deshacer.
// ══════════════════════════════════════════════════════════════

describe('WKH-307 · AR BLQ-MEDIO-1: la ausencia se PRUEBA, no se infiere', () => {
  it('T-IDM-13: nodo ATRASADO (tx presente pero sin parsear) + blockhash muerto ⟹ CERO broadcasts', async () => {
    // ⚠️ ESTE ES EL TEST DEL HALLAZGO. Las dos condiciones que antes bastaban para
    // re-pagar están puestas a propósito: el blockhash murió Y `getParsedTransaction`
    // devuelve `null`. Lo único que cambia es que el nodo, preguntado por el estado de
    // la firma, dice que SÍ la tiene.
    seedRow('run:0', {
      status: 'signed',
      signature: 'LandedButUnindexed',
      lastValidBlockHeight: '500',
    });
    fakeConnection.getBlockHeight.mockResolvedValue(900); // 900 > 500 ⟹ blockhash muerto
    fakeConnection.getParsedTransaction.mockResolvedValue(null); // nodo atrasado
    presenceState.value = { err: null }; // …pero la firma ESTÁ en la cadena

    const err = await adapter.settle(req('run:0')).catch((e: Error) => e);

    // Lo único que importa: NO salió un segundo transfer.
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
    expect(reclaimMock).not.toHaveBeenCalled();
    // ⚠️ Y el MOTIVO importa (AR re-review MNR-3). Antes esto daba
    // `SETTLE_SIGNED_TERMS_MISMATCH`, cuyo log afirma "está en la cadena pero con
    // OTROS términos" — FALSO, y manda a un operador a investigar un pago equivocado
    // que no existe. Un nodo que conoce la firma pero no la tiene indexada es
    // "no sé", no "no coincide".
    expect(String(err)).toMatch(/SETTLE_IN_FLIGHT_UNRESOLVED/);
    expect(String(err)).not.toMatch(/TERMS_MISMATCH/);
  });

  it('T-IDM-14: el RPC de presencia NO contesta + blockhash muerto ⟹ CERO broadcasts', async () => {
    // "No pude preguntar" nunca autoriza re-pagar.
    seedRow('run:0', {
      status: 'signed',
      signature: 'UnknownSig',
      lastValidBlockHeight: '500',
    });
    fakeConnection.getBlockHeight.mockResolvedValue(900);
    fakeConnection.getSignatureStatuses.mockRejectedValueOnce(
      new Error('429 rate limited'),
    );

    await expect(adapter.settle(req('run:0'))).rejects.toThrow(
      /SETTLE_IN_FLIGHT_UNRESOLVED/,
    );
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
    expect(reclaimMock).not.toHaveBeenCalled();
  });

  it('T-IDM-14b: una respuesta de presencia con forma inesperada tampoco autoriza', async () => {
    seedRow('run:0', {
      status: 'signed',
      signature: 'WeirdSig',
      lastValidBlockHeight: '500',
    });
    fakeConnection.getBlockHeight.mockResolvedValue(900);
    for (const shape of [null, {}, { value: [] }, { value: 'nope' }]) {
      fakeConnection.getSignatureStatuses.mockResolvedValueOnce(shape as never);
      await expect(adapter.settle(req('run:0'))).rejects.toThrow(
        /SETTLE_IN_FLIGHT_UNRESOLVED/,
      );
    }
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
  });

  it('T-IDM-15: la tx aterrizó y FALLÓ on-chain ⟹ re-firmar SÍ es correcto (1 broadcast)', async () => {
    // Una tx grabada con error es TERMINAL: la transferencia no ocurrió y esa firma
    // nunca puede volver a ejecutarse. Acá re-pagar es lo correcto — y antes este caso
    // estaba COLAPSADO con "no la encuentro" dentro del mismo `{valid:false}`.
    seedRow('run:0', {
      status: 'signed',
      signature: 'FailedSig',
      lastValidBlockHeight: '500',
    });
    onChainFailed();
    fakeConnection.getBlockHeight.mockResolvedValue(900);

    const res = await adapter.settle(req('run:0'));
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(res.txHash).not.toBe('FailedSig');
  });

  it('T-IDM-16: `confirmed` cuya presencia NO se pudo consultar ⟹ error TRANSITORIO, no condena', async () => {
    // Antes un hipo del RPC sobre una fila `confirmed` daba
    // SETTLE_CONFIRMED_BUT_UNVERIFIABLE, que es el rechazo PERMANENTE que exige
    // intervención humana. Un intent sano no puede quedar condenado por un 429.
    seedRow('run:0');
    fakeConnection.getSignatureStatuses.mockRejectedValueOnce(
      new Error('503 upstream'),
    );

    await expect(adapter.settle(req('run:0'))).rejects.toThrow(
      /SETTLE_PRESENCE_UNKNOWN/,
    );
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
  });

  it('T-IDM-17: la determinación negativa usa `searchTransactionHistory`', async () => {
    // Sin buscar el histórico, un nodo que podó bloques viejos contesta "no la tengo"
    // sobre una tx que sí existe — y eso es exactamente lo que autoriza el re-pago.
    seedRow('run:0', {
      status: 'signed',
      signature: 'AbsentSig',
      lastValidBlockHeight: '500',
    });
    onChainAbsent();
    fakeConnection.getBlockHeight.mockResolvedValue(900);

    await adapter.settle(req('run:0'));

    expect(fakeConnection.getSignatureStatuses).toHaveBeenCalledWith(
      ['AbsentSig'],
      { searchTransactionHistory: true },
    );
  });
});

// ══════════════════════════════════════════════════════════════
// AR re-review — las tres reservas
// ══════════════════════════════════════════════════════════════

describe('WKH-307 · AR re-review: términos, expiración y alcance de `absent`', () => {
  it('T-IDM-18 (MNR-3): nodo atrasado sobre una fila `confirmed` ⟹ transitorio, NO la condena', async () => {
    // El efecto colateral que ganamos para "el RPC tira" no valía para "el nodo conoce
    // la firma pero no la tiene indexada": ese caso caía en
    // SETTLE_CONFIRMED_BUT_UNVERIFIABLE, que es el rechazo PERMANENTE que exige
    // intervención humana. Por una causa transitoria.
    seedRow('run:0');
    presenceState.value = { err: null }; // el status dice: está en la cadena
    fakeConnection.getParsedTransaction.mockResolvedValue(null); // pero no indexada acá

    const err = await adapter.settle(req('run:0')).catch((e: Error) => e);

    expect(String(err)).toMatch(/SETTLE_PRESENCE_UNKNOWN/);
    expect(String(err)).not.toMatch(/CONFIRMED_BUT_UNVERIFIABLE/);
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
  });

  it('T-IDM-18b (MNR-3): términos que REALMENTE no coinciden siguen dando mismatch', async () => {
    // La contracara: el estado `landed_mismatch` no se volvió inalcanzable. Si la tx
    // está, se puede parsear, y el delta NO cubre el monto, eso sí es un desajuste real.
    seedRow('run:0', { status: 'signed', signature: 'MismatchSig' });
    presenceState.value = { err: null };
    fakeConnection.getParsedTransaction.mockResolvedValue({
      meta: {
        err: null,
        preTokenBalances: [
          {
            accountIndex: 1,
            owner: PAY_TO,
            mint: MINT,
            uiTokenAmount: { amount: '0' },
          },
        ],
        // delta = 1, muy por debajo de AMOUNT
        postTokenBalances: [
          {
            accountIndex: 1,
            owner: PAY_TO,
            mint: MINT,
            uiTokenAmount: { amount: '1' },
          },
        ],
      },
    });

    const err = await adapter.settle(req('run:0')).catch((e: Error) => e);
    expect(String(err)).toMatch(/SETTLE_SIGNED_TERMS_MISMATCH/);
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
  });

  it('T-IDM-19 (MNR-2): `landed_failed` con el blockhash VIVO ⟹ 0 broadcasts', async () => {
    // Una tx grabada con error es terminal EN EL CASO NORMAL, pero un re-org que la
    // saque de la cadena canónica mientras su blockhash sigue vivo la vuelve
    // re-ejecutable — y esta vez podría tener éxito, sobre un intent que ya re-pagó.
    // Exigir la expiración también acá elimina la única ventana donde dos
    // transferencias pueden coexistir.
    seedRow('run:0', {
      status: 'signed',
      signature: 'FailedButAliveSig',
      lastValidBlockHeight: '1500',
    });
    onChainFailed();
    fakeConnection.getBlockHeight.mockResolvedValue(900); // 900 <= 1500 ⟹ vivo

    await expect(adapter.settle(req('run:0'))).rejects.toThrow(
      /SETTLE_IN_FLIGHT_UNRESOLVED/,
    );
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
    expect(reclaimMock).not.toHaveBeenCalled();
  });

  it('T-IDM-19b (MNR-2): `landed_failed` con el blockhash MUERTO sí re-firma', async () => {
    // La contracara: con la prueba de expiración en la mano, re-pagar sigue siendo
    // correcto (la transferencia no ocurrió y esa firma ya no puede ejecutarse).
    seedRow('run:0', {
      status: 'signed',
      signature: 'FailedAndDeadSig',
      lastValidBlockHeight: '500',
    });
    onChainFailed();
    fakeConnection.getBlockHeight.mockResolvedValue(900); // 900 > 500 ⟹ muerto

    const res = await adapter.settle(req('run:0'));
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(res.txHash).not.toBe('FailedAndDeadSig');
  });
});

// ══════════════════════════════════════════════════════════════
// AR re-review MNR-1 — la precondición de despliegue de `absent`
// ══════════════════════════════════════════════════════════════

describe('WKH-307 · MNR-1: `absent` depende de que el RPC retenga histórico', () => {
  it('T-IDM-20: retención MEDIDA e INSUFICIENTE ⟹ el leg NO settlea (0 broadcasts)', async () => {
    // Un endpoint que retiene menos que la validez de un blockhash devuelve `null`
    // sobre transacciones que SÍ existen, justo en la ventana donde el código usa ese
    // `null` para autorizar re-firmar. Sin esta medición era un supuesto tácito.
    fakeConnection.getSlot.mockResolvedValue(1_000);
    fakeConnection.getFirstAvailableBlock.mockResolvedValue(900); // retiene 100 < 150

    await expect(adapter.settle(req('run:0'))).rejects.toThrow(
      /SETTLE_LEDGER_SCHEMA_UNAVAILABLE: rpc_history_insufficient/,
    );
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
    expect(claimMock).not.toHaveBeenCalled();
  });

  it('T-IDM-20b: retención HOLGADA ⟹ el leg settlea normal', async () => {
    fakeConnection.getSlot.mockResolvedValue(200_000_000);
    fakeConnection.getFirstAvailableBlock.mockResolvedValue(1);
    await adapter.settle(req('run:0'));
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('T-IDM-20c: retención NO MEDIBLE y SIN la declaración ⟹ CORTA (0 broadcasts)', async () => {
    // No medir NO es evidencia de histórico insuficiente — pero tampoco de lo
    // contrario, y los dos errores no cuestan lo mismo: permitir de más produce un
    // `absent` falso ⟹ segundo pago IRREVERSIBLE; cortar de más produce un arranque
    // fallido, ruidoso y reversible en un minuto.
    delete process.env.SOLANA_RPC_LEDGER_HISTORY_DECLARED_SUFFICIENT;
    fakeConnection.getFirstAvailableBlock.mockRejectedValue(
      new Error('Method not found'),
    );

    await expect(adapter.settle(req('run:0'))).rejects.toThrow(
      /SETTLE_LEDGER_SCHEMA_UNAVAILABLE: rpc_history_unmeasurable/,
    );
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
  });

  it('T-IDM-20c2: el error dice EXACTAMENTE cómo salir', async () => {
    // Un fail-closed sin salida escrita es un callejón: el operador tiene que poder
    // actuar sin leer el código.
    delete process.env.SOLANA_RPC_LEDGER_HISTORY_DECLARED_SUFFICIENT;
    fakeConnection.getFirstAvailableBlock.mockRejectedValue(
      new Error('Method not found'),
    );
    const err = await adapter.settle(req('run:0')).catch((e: Error) => e);
    expect(String(err)).toContain(
      'SOLANA_RPC_LEDGER_HISTORY_DECLARED_SUFFICIENT',
    );
    expect(String(err)).toContain('SOLANA_RPC_URL');
  });

  it('T-IDM-20c3: NO MEDIBLE pero DECLARADA ⟹ arranca (la decisión queda en la config)', async () => {
    process.env.SOLANA_RPC_LEDGER_HISTORY_DECLARED_SUFFICIENT = 'true';
    fakeConnection.getFirstAvailableBlock.mockRejectedValue(
      new Error('Method not found'),
    );
    await adapter.settle(req('run:0'));
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
    delete process.env.SOLANA_RPC_LEDGER_HISTORY_DECLARED_SUFFICIENT;
  });

  it('T-IDM-20c4: la declaración NO tiene default permisivo', async () => {
    // Un valor ausente, vacío o distinto de `true` NO puede leerse como permiso: es
    // exactamente el error que esta HU viene cazando (lo que falta no autoriza).
    fakeConnection.getFirstAvailableBlock.mockRejectedValue(
      new Error('Method not found'),
    );
    for (const v of [undefined, '', 'false', '1', 'yes', 'TRUE']) {
      if (v === undefined) {
        delete process.env.SOLANA_RPC_LEDGER_HISTORY_DECLARED_SUFFICIENT;
      } else {
        process.env.SOLANA_RPC_LEDGER_HISTORY_DECLARED_SUFFICIENT = v;
      }
      _resetSolanaClients();
      const fresh = new SolanaPaymentAdapter();
      await expect(fresh.settle(req(`run:${String(v)}`))).rejects.toThrow(
        /rpc_history_unmeasurable/,
      );
    }
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
    delete process.env.SOLANA_RPC_LEDGER_HISTORY_DECLARED_SUFFICIENT;
  });

  it('T-IDM-20d: la medición se MEMOIZA — 1 sola vez en 3 settles', async () => {
    // Misma disciplina que T-IDM-10b: una afirmación de "no agrega costo" se asierta.
    await adapter.settle(req('run:0'));
    await adapter.settle(req('run:1'));
    await adapter.settle(req('run:2'));
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(3);
    expect(fakeConnection.getFirstAvailableBlock).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════════
// DT-8 — el peek asíncrono
// ══════════════════════════════════════════════════════════════

describe('WKH-307 · DT-8: getSettledSignature es async y discriminado', () => {
  it('T-IDM-11: los 4 valores de SettledPeek', async () => {
    readMock.mockResolvedValueOnce({ state: 'none' });
    expect(await adapter.getSettledSignature('x')).toEqual({ state: 'none' });

    readMock.mockResolvedValueOnce({ state: 'confirmed', signature: 'S1' });
    expect(await adapter.getSettledSignature('x')).toEqual({
      state: 'settled',
      signature: 'S1',
    });

    // `signed` y `claimed` colapsan a in_progress: reclamado, sin confirmar.
    readMock.mockResolvedValueOnce({ state: 'signed', signature: 'S2' });
    expect(await adapter.getSettledSignature('x')).toEqual({
      state: 'in_progress',
    });
    readMock.mockResolvedValueOnce({ state: 'claimed' });
    expect(await adapter.getSettledSignature('x')).toEqual({
      state: 'in_progress',
    });

    // Un store mudo NO es "no se pagó".
    readMock.mockResolvedValueOnce({ state: 'unknown', detail: 'boom' });
    expect(await adapter.getSettledSignature('x')).toEqual({
      state: 'unknown',
    });
  });
});

// ══════════════════════════════════════════════════════════════
// WKH-319 — el fail-open del camino de SALIDA (`checkTerms`)
// ══════════════════════════════════════════════════════════════
//
// ── POR QUÉ LA SUITE NO PODÍA VER EL BUG ──────────────────────────────────
//
// Las 6 fixtures que existían usaban `preTokenBalances: [{owner: PAY_TO, amount:'0'}]`,
// y `'0'` es **la ÚNICA forma donde el bug es indistinguible del comportamiento
// correcto**: con el saldo previo en cero, `delta = post - 0 = post`, que es
// exactamente lo que el código roto calculaba. Además ninguna traía `accountIndex`,
// que el esquema real del SDK exige — o sea que modelaban una respuesta que el RPC
// nunca manda. Un fixture "del tipo correcto" que pasa por casualidad.
//
// ── LA UNIDAD DE MEDIDA DE ESTA BATERÍA ───────────────────────────────────
//
// Todo se observa por el camino REAL de producción (`settle()`), nunca llamando a la
// función privada. Los tres veredictos son distinguibles desde afuera porque los tres
// tienen consecuencias DISTINTAS sobre el dinero:
//
//   · match         → devuelve la firma previa, cero broadcasts;
//   · mismatch      → `SETTLE_CONFIRMED_BUT_UNVERIFIABLE` (condena PERMANENTE);
//   · indeterminate → `SETTLE_PRESENCE_UNKNOWN` (transitorio, el retry re-pregunta).

/** Entrada de balance con la forma REAL del RPC (CD-4/CD-11). */
function tb(
  amount: string,
  over: { accountIndex?: number; owner?: string; mint?: string } = {},
): Record<string, unknown> {
  return {
    accountIndex: over.accountIndex ?? 1,
    mint: over.mint ?? MINT,
    owner: over.owner ?? PAY_TO,
    uiTokenAmount: {
      amount,
      decimals: 6,
      uiAmount: null,
      uiAmountString: amount,
    },
  };
}

/** Lamports de una cuenta de token EXISTENTE (rent-exempt). Un `1` prueba menos. */
const RENT_EXEMPT_LAMPORTS = 2039280;

type TermsOutcome =
  | { kind: 'match'; detail: '' }
  | { kind: 'mismatch'; detail: string }
  | { kind: 'indeterminate'; detail: string };

/**
 * Corre `settle()` sobre una fila `confirmed` y traduce el resultado al veredicto de
 * TÉRMINOS. Ningún caso de esta batería puede transmitir: se asserta acá adentro.
 */
async function termsOutcome(
  meta: unknown,
  requiredAtomic: string = AMOUNT,
): Promise<TermsOutcome> {
  vi.clearAllMocks();
  fakeLedger.reset();
  wireLedger();
  presenceState.value = { err: null }; // la firma ESTÁ en la cadena
  seedRow('run:terms', {
    status: 'confirmed',
    signature: 'TermsSig',
    amountAtomic: requiredAtomic,
  });
  fakeConnection.getParsedTransaction.mockResolvedValue(meta);

  const out = await adapter
    .settle(req('run:terms', { amountAtomic: requiredAtomic }))
    .catch((e: Error) => e);

  expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
  if (!(out instanceof Error)) {
    expect(out).toEqual({ txHash: 'TermsSig', success: true });
    return { kind: 'match', detail: '' };
  }
  const msg = String(out);
  const indeterminate = /SETTLE_PRESENCE_UNKNOWN: [^(]*\(([\s\S]*)\)$/.exec(
    msg,
  );
  if (indeterminate?.[1] !== undefined) {
    return { kind: 'indeterminate', detail: indeterminate[1] };
  }
  const mismatch =
    /SETTLE_CONFIRMED_BUT_UNVERIFIABLE: [^(]*\(landed_mismatch: ([\s\S]*)\)$/.exec(
      msg,
    );
  if (mismatch?.[1] !== undefined) {
    return { kind: 'mismatch', detail: mismatch[1] };
  }
  throw new Error(`veredicto de términos no reconocido: ${msg}`);
}

describe('WKH-319 · AC-1: una lista AUSENTE no es una lista vacía', () => {
  it('T-319-1: LA REPRO — `payTo` GASTA 100 USDC con `pre` ausente ⟹ NUNCA landed_ok', async () => {
    // La transacción es AJENA: `payTo` aparece como PAGADOR y no recibe nada de
    // nosotros. Con el `?? []`, `delta` dejaba de ser un delta y pasaba a ser el
    // SALDO ABSOLUTO de payTo (4900 USDC) — o sea que la firma de una tx de un
    // tercero se certificaba como "nuestro pago llegó".
    const out = await termsOutcome(
      { meta: { err: null, postTokenBalances: [tb('4900000000')] } },
      '1000000',
    );
    expect(out.kind).toBe('indeterminate');
    expect(out.detail).toMatch(/^terms_/);
    expect(out.detail).toMatch(/^terms_list_absent/);
  });

  it('T-319-1b: las CINCO formas de la lista ⟹ las cinco indeterminadas', async () => {
    const credit = [tb(AMOUNT)];
    const debit = [tb('0')];
    const forms: Array<[string, unknown]> = [
      ['pre ausente', { err: null, postTokenBalances: credit }],
      [
        'pre null',
        { err: null, preTokenBalances: null, postTokenBalances: credit },
      ],
      ['post ausente', { err: null, preTokenBalances: debit }],
      [
        'post null',
        { err: null, preTokenBalances: debit, postTokenBalances: null },
      ],
      ['las dos ausentes', { err: null }],
    ];
    for (const [name, meta] of forms) {
      const out = await termsOutcome({ meta });
      expect(`${name}: ${out.kind}`).toBe(`${name}: indeterminate`);
      expect(out.detail).toMatch(/^terms_list_absent/);
    }
    // Y con `required = 0` tampoco: no medir sigue siendo no medir, aunque el
    // umbral sea trivial de alcanzar.
    const cero = await termsOutcome({ meta: { err: null } }, '0');
    expect(cero.kind).toBe('indeterminate');
  });

  it('T-319-2: `pre: []` PRESENTE Y VACÍA con post acreditando ⟹ NO es "saldo previo cero"', async () => {
    // Una lista vacía y una fila ausente en una lista poblada son la MISMA pregunta
    // sin responder: ¿esta cuenta tenía saldo antes? El único dato que la responde
    // son los lamports, y acá dicen que la cuenta YA EXISTÍA.
    const out = await termsOutcome({
      meta: {
        err: null,
        preTokenBalances: [],
        postTokenBalances: [tb(AMOUNT)],
        preBalances: [1_000_000_000, RENT_EXEMPT_LAMPORTS],
        postBalances: [1_000_000_000, RENT_EXEMPT_LAMPORTS],
      },
    });
    expect(out.kind).toBe('indeterminate');
    expect(out.detail).toMatch(/^terms_pre_row_missing/);
  });
});

describe('WKH-319 · AC-3/AC-4/AC-5: completitud del conjunto receptor', () => {
  it('T-319-3: `pre` poblada pero SIN nuestra fila, con la cuenta ya existente ⟹ indeterminado', async () => {
    const out = await termsOutcome({
      meta: {
        err: null,
        // La lista trae otra cuenta (otro owner), o sea que NO está vacía: lo que
        // falta es justo nuestra fila.
        preTokenBalances: [tb('7000000', { accountIndex: 5, owner: PAY_TO_B })],
        postTokenBalances: [
          tb('7000000', { accountIndex: 5, owner: PAY_TO_B }),
          tb(AMOUNT),
        ],
        preBalances: [
          1_000_000_000,
          RENT_EXEMPT_LAMPORTS,
          0,
          0,
          0,
          RENT_EXEMPT_LAMPORTS,
        ],
        postBalances: [
          1_000_000_000,
          RENT_EXEMPT_LAMPORTS,
          0,
          0,
          0,
          RENT_EXEMPT_LAMPORTS,
        ],
      },
    });
    expect(out.kind).toBe('indeterminate');
    expect(out.detail).toMatch(/^terms_pre_row_missing/);
  });

  it('T-319-4: `preBalances` ausente o corto ⟹ indeterminado — `undefined` NO es `0`', async () => {
    const base = {
      err: null,
      preTokenBalances: [],
      postTokenBalances: [tb(AMOUNT, { accountIndex: 4 })],
    };
    for (const [name, meta] of [
      ['preBalances ausente', base],
      // Índice 4 fuera de rango: la lista existe pero no llega hasta nuestra cuenta.
      ['preBalances corto', { ...base, preBalances: [1_000_000_000, 0] }],
      ['preBalances no-array', { ...base, preBalances: 'nope' }],
    ] as Array<[string, unknown]>) {
      const out = await termsOutcome({ meta });
      expect(`${name}: ${out.kind}`).toBe(`${name}: indeterminate`);
      expect(out.detail).toMatch(/^terms_pre_row_missing/);
    }
  });

  it('T-319-9: la ATA creada EN LA MISMA TX sigue acreditando (AC-4)', async () => {
    // ⚠️ EL CANARIO CONTRA LA SOBRE-CORRECCIÓN (M15). Un arreglo que exige la fila
    // en `pre` SIEMPRE rechaza el primer pago que le hacemos a un agente nuevo —
    // rechazar de más también es un arreglo roto.
    const out = await termsOutcome({
      meta: {
        err: null,
        preTokenBalances: [],
        postTokenBalances: [tb(AMOUNT, { accountIndex: 4 })],
        // 0 lamports en `pre` = la cuenta NO EXISTÍA. Una cuenta de token que
        // existe es rent-exempt (> 0), así que las dos causas se distinguen.
        preBalances: [1_000_000_000, 0, 0, 0, 0],
        postBalances: [999_000_000, 0, 0, 0, RENT_EXEMPT_LAMPORTS],
      },
    });
    expect(out.kind).toBe('match');
  });

  it('T-319-10: la regla ESPEJO del lado `post` (AC-5)', async () => {
    // Una cuenta nuestra que se CIERRA en la tx desaparece de `post`, y su saldo
    // posterior real es 0. Sin la regla simétrica el delta se ve MÁS CHICO y sale un
    // `landed_mismatch` falso sobre un pago REAL — el mismo error, al revés.
    const meta = (postLamports: number) => ({
      err: null,
      preTokenBalances: [
        tb('0', { accountIndex: 3 }),
        tb('5000000000', { accountIndex: 7 }),
      ],
      // idx 3 desapareció; idx 7 recibió AMOUNT.
      postTokenBalances: [tb('5003000000', { accountIndex: 7 })],
      preBalances: [
        1_000_000_000,
        0,
        0,
        RENT_EXEMPT_LAMPORTS,
        0,
        0,
        0,
        RENT_EXEMPT_LAMPORTS,
      ],
      postBalances: [
        1_000_000_000,
        0,
        0,
        postLamports,
        0,
        0,
        0,
        RENT_EXEMPT_LAMPORTS,
      ],
    });
    // Cuenta cerrada (0 lamports) ⟹ medible ⟹ el pago se acredita.
    expect((await termsOutcome({ meta: meta(0) })).kind).toBe('match');
    // La cuenta SIGUE existiendo pero su fila no vino ⟹ lista truncada.
    const truncated = await termsOutcome({ meta: meta(RENT_EXEMPT_LAMPORTS) });
    expect(truncated.kind).toBe('indeterminate');
    expect(truncated.detail).toMatch(/^terms_post_row_missing/);
  });
});

describe('WKH-319 · AC-2/AC-9: entradas ilegibles, sin lanzar', () => {
  it('T-319-5: entradas con forma inválida ⟹ indeterminado, y `checkTerms` NO lanza', async () => {
    // `preTokenBalances: [null]` tiraba TypeError en el primer `b.mint`. Si el
    // veredicto llegara por `terms_threw` el guard interno no existiría — el `try`
    // externo lo estaría tapando. Por eso se exige `terms_entry_shape`.
    const post = [tb(AMOUNT)];
    for (const [name, pre] of [
      ['[null]', [null]],
      [
        'sin accountIndex',
        [{ mint: MINT, owner: PAY_TO, uiTokenAmount: { amount: '0' } }],
      ],
      [
        'uiTokenAmount vacío',
        [{ accountIndex: 1, mint: MINT, owner: PAY_TO, uiTokenAmount: {} }],
      ],
      [
        'amount no-string',
        [
          {
            accountIndex: 1,
            mint: MINT,
            owner: PAY_TO,
            uiTokenAmount: { amount: 0 },
          },
        ],
      ],
    ] as Array<[string, unknown]>) {
      const out = await termsOutcome({
        meta: { err: null, preTokenBalances: pre, postTokenBalances: post },
      });
      expect(`${name}: ${out.kind}`).toBe(`${name}: indeterminate`);
      expect(out.detail).toMatch(/^terms_entry_shape/);
      expect(out.detail).not.toMatch(/terms_threw/);
    }
  });

  it('T-319-6: la familia de `amount` que `BigInt` acepta o convierte mal', async () => {
    // ⚠️ `try { BigInt(x) } catch {}` NO alcanza para los cuatro primeros: el catch
    // NI SE EJECUTA. BigInt('')=0n, BigInt('   ')=0n, BigInt('0x10')=16n.
    for (const amount of [
      '',
      '   ',
      '0x10',
      '+5',
      '1.0',
      '1e9',
      '-1',
      '1_000',
      // BigInt() ACEPTA el whitespace envolvente: daría 5000000000n en silencio.
      '\n5000000000\n',
    ]) {
      const out = await termsOutcome({
        meta: {
          err: null,
          preTokenBalances: [tb(amount)],
          postTokenBalances: [tb('5000010000')],
        },
      });
      expect(`${JSON.stringify(amount)}: ${out.kind}`).toBe(
        `${JSON.stringify(amount)}: indeterminate`,
      );
      expect(out.detail).toMatch(/^terms_amount_unreadable/);
    }
  });

  it('T-319-5b: `mint` no-string y `uiTokenAmount` no-objeto ⟹ indeterminado', async () => {
    const post = [tb(AMOUNT)];
    for (const [name, pre] of [
      [
        'mint no-string',
        [
          {
            accountIndex: 1,
            mint: 7,
            owner: PAY_TO,
            uiTokenAmount: { amount: '0' },
          },
        ],
      ],
      [
        'uiTokenAmount null',
        [{ accountIndex: 1, mint: MINT, owner: PAY_TO, uiTokenAmount: null }],
      ],
      [
        'uiTokenAmount string',
        [{ accountIndex: 1, mint: MINT, owner: PAY_TO, uiTokenAmount: '0' }],
      ],
      [
        'accountIndex fraccionario',
        [
          {
            accountIndex: 1.5,
            mint: MINT,
            owner: PAY_TO,
            uiTokenAmount: { amount: '0' },
          },
        ],
      ],
    ] as Array<[string, unknown]>) {
      const out = await termsOutcome({
        meta: { err: null, preTokenBalances: pre, postTokenBalances: post },
      });
      expect(`${name}: ${out.kind}`).toBe(`${name}: indeterminate`);
      expect(out.detail).toMatch(/^terms_entry_shape/);
    }
  });

  it('T-319-5c: OTRO mint no cuenta, y un `accountIndex` repetido no se puede medir', async () => {
    // Un token cualquiera acreditado a `payTo` en la misma tx NO es nuestro pago.
    const otroMint = await termsOutcome({
      meta: {
        err: null,
        preTokenBalances: [
          tb('0'),
          tb('0', { accountIndex: 8, mint: PAY_TO_B }),
        ],
        postTokenBalances: [
          tb('0'),
          tb('999000000', { accountIndex: 8, mint: PAY_TO_B }),
        ],
      },
    });
    expect(otroMint.kind).toBe('mismatch');

    // La MISMA cuenta listada dos veces son datos incoherentes, no un saldo.
    const duplicado = await termsOutcome({
      meta: {
        err: null,
        preTokenBalances: [tb('0'), tb('0')],
        postTokenBalances: [tb(AMOUNT)],
      },
    });
    expect(duplicado.kind).toBe('indeterminate');
    expect(duplicado.detail).toMatch(/^terms_duplicate_index/);
  });

  it('T-319-5d: un monto REQUERIDO ilegible no es "requerido cero"', async () => {
    const out = await termsOutcome(
      {
        meta: {
          err: null,
          preTokenBalances: [tb('0')],
          postTokenBalances: [tb(AMOUNT)],
        },
      },
      '1.5',
    );
    expect(out.kind).toBe('indeterminate');
    expect(out.detail).toMatch(/^terms_required_unreadable/);
  });

  it('T-319-11: si `checkTerms` lanzara, `probeSettlementPresence` sigue sin lanzar', async () => {
    // Cinturón Y tirantes (CD-6): el guard no puede sostenerse sobre su propio
    // razonamiento. Se fuerza un throw DENTRO de la lectura de las listas.
    const meta: Record<string, unknown> = { err: null, postTokenBalances: [] };
    Object.defineProperty(meta, 'preTokenBalances', {
      get() {
        throw new Error('rpc payload exploded');
      },
      enumerable: true,
    });
    const out = await termsOutcome({ meta });
    expect(out.kind).toBe('indeterminate');
    expect(out.detail).toMatch(/^terms_threw: rpc payload exploded/);
  });
});

describe('WKH-319 · AC-6/AC-7/AC-8: el veredicto', () => {
  it('T-319-7: delta NEGATIVO ⟹ indeterminado, NUNCA landed_mismatch (AC-6)', async () => {
    // Para una tx que construimos nosotros esto es físicamente imposible: el destino
    // no gasta. Un `mismatch` acá es SETTLE_CONFIRMED_BUT_UNVERIFIABLE, o sea condena
    // permanente con salida manual, por una causa que nunca se midió.
    const out = await termsOutcome({
      meta: {
        err: null,
        preTokenBalances: [tb('5000000000')],
        postTokenBalances: [tb('1000000')],
      },
    });
    expect(out.kind).toBe('indeterminate');
    expect(out.detail).toMatch(/^terms_negative_delta/);
  });

  it('T-319-8: DOS cuentas del mismo owner+mint ⟹ agregación por accountIndex (AC-7)', async () => {
    // Con el `.find()` los dos lados resolvían a la PRIMERA entrada de cada lista,
    // sin exigir que fuera la misma cuenta: acá daría delta 0 ⟹ landed_mismatch
    // sobre un pago REAL. La de delta 0 va primera en `post` a propósito.
    const out = await termsOutcome({
      meta: {
        err: null,
        preTokenBalances: [
          tb('0', { accountIndex: 3 }),
          tb('5000000000', { accountIndex: 7 }),
        ],
        postTokenBalances: [
          tb('0', { accountIndex: 3 }),
          tb('5003000000', { accountIndex: 7 }),
        ],
      },
    });
    expect(out.kind).toBe('match');
  });

  it('T-319-8b: el `find` resolviendo a cuentas DISTINTAS fabricaba un landed_ok', async () => {
    // El caso explotable del `.find()`, reproducido: `payTo` tiene dos token
    // accounts del mismo mint y NO recibió NADA en esta tx. `post` lista primero la
    // cuenta gorda (B, 5000 USDC) y `pre` lista sólo la flaca (A, 0). Los dos `find`
    // resolvían a cuentas DISTINTAS ⟹ delta = 5000000000 - 0 ⟹ **landed_ok sobre
    // una transferencia que nunca ocurrió**. Emparejar por `accountIndex` lo mata.
    const out = await termsOutcome({
      meta: {
        err: null,
        preTokenBalances: [tb('0', { accountIndex: 3 })],
        postTokenBalances: [
          tb('5000000000', { accountIndex: 7 }),
          tb('0', { accountIndex: 3 }),
        ],
        // La cuenta gorda YA EXISTÍA antes de la tx: su fila falta en `pre`, y eso
        // es una lista truncada, no una ATA recién creada.
        preBalances: [
          1_000_000_000,
          0,
          0,
          RENT_EXEMPT_LAMPORTS,
          0,
          0,
          0,
          RENT_EXEMPT_LAMPORTS,
        ],
        postBalances: [
          1_000_000_000,
          0,
          0,
          RENT_EXEMPT_LAMPORTS,
          0,
          0,
          0,
          RENT_EXEMPT_LAMPORTS,
        ],
      },
    });
    expect(out.kind).toBe('indeterminate');
    expect(out.detail).toMatch(/^terms_pre_row_missing/);
  });

  it('T-319-12: la negativa MEDIDA sigue viva — landed_mismatch NO es inalcanzable (AC-8, CD-9)', async () => {
    // ⚠️ REFUERZO DE T-IDM-18b contra la SOBRE-CORRECCIÓN (M16). Si esta aserción
    // alguna vez hay que aflojarla, el arreglo se pasó: convirtió una negativa
    // demostrada en una indeterminación.
    const out = await termsOutcome(
      {
        meta: {
          err: null,
          preTokenBalances: [tb('0')],
          postTokenBalances: [tb('1')],
        },
      },
      '1000000',
    );
    expect(out.kind).toBe('mismatch');
    expect(out.detail).toMatch(/on-chain transfer 1 < required 1000000/);
  });

  it('T-319-7b: `owner` ausente — sub-medir no autoriza afirmar la negativa', async () => {
    // Una entrada de nuestro mint sin `owner` sólo puede SUMAR al lado que no
    // medimos. Si aun así el delta medido ALCANZA, la afirmación positiva es sólida;
    // si NO alcanza, no se puede afirmar la negativa. (W2 la vuelve medible.)
    const anon = {
      accountIndex: 9,
      mint: MINT,
      uiTokenAmount: { amount: '1', decimals: 6, uiAmount: null },
    };
    const noAlcanza = await termsOutcome({
      meta: {
        err: null,
        preTokenBalances: [
          tb('0'),
          { ...anon, uiTokenAmount: { amount: '0' } },
        ],
        postTokenBalances: [tb('1'), anon],
      },
    });
    expect(noAlcanza.kind).toBe('indeterminate');
    expect(noAlcanza.detail).toMatch(/^terms_unclassifiable_entry/);

    const alcanza = await termsOutcome({
      meta: {
        err: null,
        preTokenBalances: [
          tb('0'),
          { ...anon, uiTokenAmount: { amount: '0' } },
        ],
        postTokenBalances: [tb(AMOUNT), anon],
      },
    });
    expect(alcanza.kind).toBe('match');
  });
});

describe('WKH-319 · AC-10/AC-11/AC-12: la indeterminación llega a los consumidores', () => {
  it('T-319-13: fila `confirmed` + `pre` ausente ⟹ SETTLE_PRESENCE_UNKNOWN, no la condena', async () => {
    seedRow('run:0');
    presenceState.value = { err: null };
    fakeConnection.getParsedTransaction.mockResolvedValue({
      meta: { err: null, postTokenBalances: [tb('4900000000')] },
    });

    const err = await adapter.settle(req('run:0')).catch((e: Error) => e);

    expect(String(err)).toMatch(/SETTLE_PRESENCE_UNKNOWN/);
    expect(String(err)).toMatch(/terms_list_absent/);
    expect(String(err)).not.toMatch(/CONFIRMED_BUT_UNVERIFIABLE/);
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
  });

  it('T-319-14: fila `signed` + blockhash EXPIRADO + `pre` ausente ⟹ ni confirma ni re-transmite', async () => {
    // ⚠️ EL PEOR CASO, Y EL QUE MIDE LA PLATA. Antes del arreglo esta misma entrada
    // daba `landed_ok`: la fila se marcaba `confirmed`, se devolvía `success:true`,
    // **el agente nunca cobraba** y el reintento quedaba CLAUSURADO para siempre.
    seedRow('run:0', {
      status: 'signed',
      signature: 'InFlightSig',
      lastValidBlockHeight: '100',
    });
    presenceState.value = { err: null };
    fakeConnection.getBlockHeight.mockResolvedValue(900); // 900 > 100 ⟹ expirado
    fakeConnection.getParsedTransaction.mockResolvedValue({
      meta: { err: null, postTokenBalances: [tb('4900000000')] },
    });

    const err = await adapter.settle(req('run:0')).catch((e: Error) => e);

    expect(String(err)).toMatch(/SETTLE_IN_FLIGHT_UNRESOLVED/);
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(0);
    expect(recordConfirmedMock).not.toHaveBeenCalled();
    expect(reclaimMock).not.toHaveBeenCalled();
    // La fila sigue reconciliable: `signed`, con su cota intacta.
    expect(fakeLedger.rows.get('run:0')).toMatchObject({
      status: 'signed',
      signature: 'InFlightSig',
      lastValidBlockHeight: '100',
    });
  });

  it('T-319-15: timeout de confirmación + `pre` ausente ⟹ SETTLE_UNKNOWN, no SETTLE_FAILED', async () => {
    // `recoverConfirmedSettle`: la incertidumbre viaja con `valueDisposition:'unknown'`
    // hasta el leg, que la publica como SETTLE_UNKNOWN. Un `landed_mismatch` acá se
    // degradaría a SETTLE_FAILED — una negativa falsa sobre un leg nunca determinado.
    presenceState.value = { err: null };
    fakeConnection.confirmTransaction.mockRejectedValueOnce(
      new Error('Transaction was not confirmed in 30.00 seconds'),
    );
    fakeConnection.getParsedTransaction.mockResolvedValue({
      meta: { err: null, postTokenBalances: [tb('4900000000')] },
    });

    const err = await adapter.settle(req('run:0')).catch((e: Error) => e);

    expect((err as { name?: string }).name).toBe('FacilitatorSettleError');
    expect((err as { valueDisposition?: string }).valueDisposition).toBe(
      'unknown',
    );
    // Se transmitió UNA vez (el settle original), y NO se re-transmitió.
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(recordConfirmedMock).not.toHaveBeenCalled();
  });
});
