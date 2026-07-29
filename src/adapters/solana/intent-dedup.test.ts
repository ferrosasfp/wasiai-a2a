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
  resolveSettleLeaseMs: () => 120_000,
  PROBE_OK_MARKER: 'WKH307_PROBE_OK',
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
        { owner: PAY_TO, mint: MINT, uiTokenAmount: { amount: '0' } },
      ],
      postTokenBalances: [
        { owner: PAY_TO, mint: MINT, uiTokenAmount: { amount: AMOUNT } },
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
    // Y no se devuelve un éxito inventado: la tx está pero sus términos no se
    // pudieron validar contra el parseo ⟹ fail-closed explícito.
    expect(String(err)).toMatch(/SETTLE_SIGNED_TERMS_MISMATCH/);
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
