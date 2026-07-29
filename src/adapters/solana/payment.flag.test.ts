/**
 * WKH-302 — bandera de transición del settle Solana (T-AC3, T-AC4, T-CD15).
 *
 * La pregunta que estos tests contestan no es "¿devolvió 200?" sino **quién firmó**.
 * Por eso cada caso asserta sobre los dos caminos a la vez: si el camino nuevo
 * corre, el keypair local NO se resuelve y NO se transmite nada; si corre el
 * legado, el hop HTTP NO se invoca. Nunca los dos para el mismo `intentId` (AC-3).
 *
 * ─── RE-ANCLAJE DEL MERGE CON WKH-307/308 ─────────────────────────────────────
 * Este archivo se escribió contra un `settle()` que ya no existe. Lo que cambió:
 *
 *  1. La idempotencia era un `Map` de proceso; ahora es una TABLA (WKH-307). Sin
 *     dobles del ledger y del preflight, `settle()` fail-closea en el paso 0 y
 *     todos los casos se ponen rojos por el motivo equivocado.
 *  2. El adapter dejó de usar `sendAndConfirmTransaction` (ese helper re-firma
 *     adentro, así que era imposible conocer la firma ANTES de transmitir, que es
 *     lo que exige la invariante I2). Ahora es `getLatestBlockhash` → `tx.sign` →
 *     `sendRawTransaction`. El espía del broadcast local pasó a ser ése, y la firma
 *     local ya no es una constante del test: la deriva la transacción real.
 *  3. `getSettledSignature` pasó a ser asíncrona y devuelve un `SettledPeek`.
 *
 * Cada test re-anclado lleva escrito qué asertaba, contra qué estado, por qué ese
 * estado cambió y qué asserta ahora.
 */

import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, type PublicKey, Transaction } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const PAY_TO = 'So11111111111111111111111111111111111111112';
/** Operator DETERMINISTA: `tx.sign()` es real, así que la seed no puede ser random. */
const OPERATOR = Keypair.fromSeed(new Uint8Array(32).fill(7));
const FACILITATOR_SIG = '7'.repeat(64);
/** Firma ya presente en el ledger, para los casos que arrancan de un estado sembrado. */
const SEEDED_SIG = '9'.repeat(64);

const BLOCKHASH = Keypair.fromSeed(
  new Uint8Array(32).fill(9),
).publicKey.toBase58();

/** Broadcasts locales observados (uno por `sendRawTransaction`). */
const broadcasts: Uint8Array[] = [];

const fakeConnection = {
  getLatestBlockhash: vi.fn(async (..._a: unknown[]) => ({
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 1000,
  })),
  sendRawTransaction: vi.fn(async (raw: Uint8Array, ..._a: unknown[]) => {
    broadcasts.push(raw);
    return 'sent';
  }),
  confirmTransaction: vi.fn(async (..._a: unknown[]) => ({
    value: { err: null },
  })),
  getBlockHeight: vi.fn(async (..._a: unknown[]) => 2000),
  // Por defecto: el nodo BUSCÓ su histórico y la firma no está ⟹ ausencia probada.
  getSignatureStatuses: vi.fn(
    (..._a: unknown[]): Promise<unknown> => Promise.resolve({ value: [null] }),
  ),
  getParsedTransaction: vi.fn(
    (..._a: unknown[]): Promise<unknown> => Promise.resolve(null),
  ),
  getTokenAccountBalance: vi.fn(
    (..._a: unknown[]): Promise<unknown> =>
      Promise.resolve({ value: { amount: '1000000' } }),
  ),
};

/** Espía del keypair LOCAL: si esto se llama con la bandera ON, algo está mal. */
const mockGetOperatorKeypair = vi.fn((..._a: unknown[]) => OPERATOR);

vi.mock('./chain.js', () => ({
  getSolanaConnection: vi.fn((..._a: unknown[]) => fakeConnection),
  getSolanaOperatorKeypair: (...a: unknown[]) => mockGetOperatorKeypair(...a),
  getSolanaUsdcMint: vi.fn((..._a: unknown[]) => MINT),
  getSolanaUsdcDecimals: vi.fn((..._a: unknown[]) => 6),
  getSolanaCommitment: vi.fn((..._a: unknown[]) => 'confirmed'),
  getSolanaCaip2: vi.fn((..._a: unknown[]) => 'solana:test'),
  getSolanaNetwork: vi.fn((..._a: unknown[]) => 'devnet'),
}));

const mockGetOrCreateAta = vi.fn(
  async (
    _connection: unknown,
    _payer: unknown,
    mint: PublicKey,
    owner: PublicKey,
  ) => ({ address: getAssociatedTokenAddressSync(mint, owner) }),
);
// `createTransferInstruction` y `getAssociatedTokenAddressSync` quedan REALES (son
// puros): la transacción que se firma y transmite en los casos locales es la de
// producción. Sólo se sustituye el getOrCreate del ATA, que consulta el RPC.
vi.mock('@solana/spl-token', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/spl-token')>();
  return {
    ...actual,
    getOrCreateAssociatedTokenAccount: (
      c: unknown,
      p: unknown,
      m: PublicKey,
      o: PublicKey,
    ) => mockGetOrCreateAta(c, p, m, o),
  };
});

// ── Doble del ledger durable (WKH-307) ────────────────────────────────────────
// Es una máquina de estados, no un `() => ok`: la mitad de este archivo prueba
// EXACTAMENTE las transiciones (`claimed` → firma → `confirmed`, y las ramas de
// recuperación), así que un doble sin estado no podría distinguirlas.
type LedgerRow = {
  status: 'claimed' | 'signed' | 'confirmed';
  signature?: string;
  lvbh?: string;
};
const rows = new Map<string, LedgerRow>();
/** Arranca un caso desde un estado ya existente, sin fabricarlo con settles previos. */
function seedLedger(intentId: string, row: LedgerRow): void {
  rows.set(intentId, row);
}

const mockClaim = vi.fn(async (a: { intentId: string }) => {
  const r = rows.get(a.intentId);
  if (!r) {
    rows.set(a.intentId, { status: 'claimed' });
    return { outcome: 'claimed', attempts: 1 };
  }
  if (r.status === 'confirmed') {
    return { outcome: 'confirmed', signature: r.signature };
  }
  if (r.status === 'signed') {
    return {
      outcome: 'signed',
      signature: r.signature,
      lastValidBlockHeight: r.lvbh ?? null,
    };
  }
  // Fila `claimed` re-encontrada: en el doble el lease siempre está vencido, así
  // que se re-reclama. La rama `in_progress` (lease vivo) tiene tests propios en
  // `settle-ledger.test.ts` y no es lo que este archivo mide.
  return { outcome: 'claimed', attempts: 2 };
});
const mockRecordSigned = vi.fn(
  async (a: {
    intentId: string;
    signature: string;
    lastValidBlockHeight: string;
  }) => {
    rows.set(a.intentId, {
      status: 'signed',
      signature: a.signature,
      lvbh: a.lastValidBlockHeight,
    });
    return { ok: true, attempts: 1 };
  },
);
const mockRecordConfirmed = vi.fn(
  async (a: { intentId: string; signature: string }) => {
    const r = rows.get(a.intentId);
    if (!r || r.signature !== a.signature) {
      return { ok: false, reason: 'signature_mismatch', detail: 'x' };
    }
    rows.set(a.intentId, { ...r, status: 'confirmed' });
    return { ok: true };
  },
);
const mockReclaim = vi.fn(async (a: { intentId: string }) => {
  const r = rows.get(a.intentId);
  if (r) rows.set(a.intentId, { status: 'claimed' });
  return { ok: true };
});

vi.mock('./settle-ledger.js', () => ({
  claimSettleIntent: (a: { intentId: string }) => mockClaim(a),
  recordSignedIntent: (a: {
    intentId: string;
    signature: string;
    lastValidBlockHeight: string;
  }) => mockRecordSigned(a),
  recordConfirmedIntent: (a: { intentId: string; signature: string }) =>
    mockRecordConfirmed(a),
  reclaimExpiredIntent: (a: { intentId: string }) => mockReclaim(a),
  readSettleIntent: vi.fn(async (intentId: string) => {
    const r = rows.get(intentId);
    if (!r) return { state: 'none' };
    if (r.status === 'confirmed' && r.signature) {
      return { state: 'settled', signature: r.signature };
    }
    return { state: 'in_progress' };
  }),
  probeSettleLedger: vi.fn(async () => ({ probe: 'ok' })),
}));
vi.mock('./schema-preflight.js', () => ({
  ensureSolanaSchemaReady: vi.fn(async () => ({ ok: true })),
  warmSolanaSchemaPreflight: vi.fn(),
  _resetSolanaSchemaPreflight: vi.fn(),
  BLOCKHASH_VALIDITY_SLOTS: 150,
}));

import { base58Encode } from './base58.js';
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

/**
 * La firma local es la de la tx REAL: se deriva, no se declara.
 *
 * ⚠️ Se usa `base58Encode`, el MISMO del adapter, y no `new PublicKey(sig)`: una firma
 * son 64 bytes y `PublicKey` sólo acepta 32, así que eso lanza «Invalid public key».
 */
function localSignature(raw: Uint8Array): string {
  const sig = Transaction.from(Buffer.from(raw)).signature;
  if (!sig) throw new Error('la transacción transmitida no venía firmada');
  return base58Encode(sig);
}

/** El único broadcast local del caso, o falla el test si no hubo exactamente uno. */
function onlyBroadcast(): Uint8Array {
  const raw = broadcasts[0];
  if (!raw) throw new Error('no se transmitió ninguna transacción');
  return raw;
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  saveEnv();
  _resetSolanaClients();
  rows.clear();
  broadcasts.length = 0;
  mockGetOperatorKeypair.mockClear();
  mockGetOrCreateAta.mockClear();
  mockClaim.mockClear();
  mockRecordSigned.mockClear();
  mockRecordConfirmed.mockClear();
  mockReclaim.mockClear();
  fakeConnection.sendRawTransaction.mockClear();
  // Estado del RPC por test: si no se resetea, el mock de un caso (null / throw /
  // tx fallida) se filtra al siguiente y el orden pasa a decidir el resultado.
  fakeConnection.getParsedTransaction.mockReset();
  fakeConnection.getParsedTransaction.mockResolvedValue(null);
  fakeConnection.getSignatureStatuses.mockReset();
  fakeConnection.getSignatureStatuses.mockResolvedValue({ value: [null] });
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
    expect(broadcasts).toHaveLength(0);
    expect(mockGetOrCreateAta).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('★ bandera OFF: firma el gateway; el hop HTTP NUNCA se invoca', async () => {
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'false';
    const adapter = new SolanaPaymentAdapter();
    const res = await adapter.settle(settleReq('run-off:0'));

    expect(res.success).toBe(true);
    expect(broadcasts).toHaveLength(1);
    // La firma devuelta es la de la transacción que REALMENTE se transmitió.
    expect(res.txHash).toBe(localSignature(onlyBroadcast()));
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
    expect(broadcasts).toHaveLength(0);
  });

  it('★ la cota de expiración se FABRICA y se anota (no se le pide al facilitator)', async () => {
    // El facilitator NO devuelve `lastValidBlockHeight` y su tabla tampoco lo tiene,
    // así que el gateway se fabrica su propia COTA SUPERIOR: altura medida al recibir
    // la respuesta + validez del blockhash (150) + margen por desfasaje entre nodos
    // (150). Errar por arriba hace esperar de más; errar por abajo es un doble pago.
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
    process.env.SOLANA_FACILITATOR_URL = 'https://facilitator.test';
    fetchSpy.mockResolvedValue(okPayoutResponse());

    await new SolanaPaymentAdapter().settle(settleReq('run-cota:0'));

    expect(mockRecordSigned).toHaveBeenCalledTimes(1);
    const arg = mockRecordSigned.mock.calls[0]?.[0];
    expect(arg?.signature).toBe(FACILITATOR_SIG);
    // getBlockHeight() = 2000 en el doble ⟹ 2000 + 150 + 150.
    expect(arg?.lastValidBlockHeight).toBe('2300');
  });

  it('★ un 2xx NO alcanza para saltar a `confirmed` (verify-before-trust)', async () => {
    // La cadena todavía no respalda la firma (el doble responde ausencia), así que la
    // fila queda en `signed` y un retry posterior la reconcilia. `confirmed` es un
    // estado del que no se vuelve: llegar ahí con un 2xx como única evidencia dejaría
    // la fila condenada si después la cadena dijera que no está.
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
    process.env.SOLANA_FACILITATOR_URL = 'https://facilitator.test';
    fetchSpy.mockResolvedValue(okPayoutResponse());

    const res = await new SolanaPaymentAdapter().settle(settleReq('run-vbt:0'));

    expect(res.success).toBe(true);
    expect(mockRecordConfirmed).not.toHaveBeenCalled();
    expect(rows.get('run-vbt:0')?.status).toBe('signed');
  });
});

describe('T-AC4 — con la bandera ausente todo es idéntico a pre-302', () => {
  it('★ bandera UNSET: mismo resultado y mismo firmante que antes de la HU', async () => {
    // Sin la variable en el entorno en absoluto.
    expect(process.env.SOLANA_SETTLE_VIA_FACILITATOR).toBeUndefined();
    const res = await new SolanaPaymentAdapter().settle(settleReq('run-un:0'));

    expect(res.success).toBe(true);
    expect(broadcasts).toHaveLength(1);
    expect(res.txHash).toBe(localSignature(onlyBroadcast()));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("★ un valor truthy-pero-no-'true' NO activa el camino nuevo", async () => {
    // La comparación es literal contra 'true'. `Boolean(process.env.X)` daría
    // true para cualquiera de estos, incluido el string 'false'.
    for (const v of ['1', 'TRUE', 'yes', 'false', '']) {
      process.env.SOLANA_SETTLE_VIA_FACILITATOR = v;
      broadcasts.length = 0;
      fetchSpy.mockClear();
      const res = await new SolanaPaymentAdapter().settle(
        settleReq(`run-v-${v}:0`),
      );
      expect(broadcasts).toHaveLength(1);
      expect(res.txHash).toBe(localSignature(onlyBroadcast()));
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });

  it('el RECLAMO sigue ANTES de la ramificación (común a los dos caminos)', async () => {
    // RE-ANCLADO. Asertaba que la firma del facilitator quedaba en el `Map` de
    // idempotencia del proceso, contra un `settle()` cuyo seam era ese Map. WKH-307 lo
    // reemplazó por una tabla, y con eso la propiedad que importa dejó de ser "quedó
    // algo en el seam" y pasó a ser CD-14: **el reclamo es la primera operación y la
    // bandera se lee después**. Eso es más fuerte que lo que asertaba antes, y es
    // exactamente lo que un rebase podría romper sin que nada más se ponga rojo.
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
    process.env.SOLANA_FACILITATOR_URL = 'https://facilitator.test';
    let claimedBeforePost: boolean | undefined;
    fetchSpy.mockImplementation(() => {
      claimedBeforePost = mockClaim.mock.calls.length === 1;
      return Promise.resolve(okPayoutResponse());
    });

    await new SolanaPaymentAdapter().settle(settleReq('run-shared:0'));

    expect(claimedBeforePost).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('AR 4º sitio — una negativa NO probada nunca autoriza re-emitir', () => {
  // Hallazgo propio, en el camino LEGADO (bandera OFF), que es el de producción hoy.
  // `verify()` devolvía `valid:false` tanto cuando la cadena dice "esa tx falló" como
  // cuando `getParsedTransaction` devuelve `null` — y `null` puede ser un nodo sin ese
  // pedazo de historia, uno atrasado o un índice degradado. Con `valid:false` el código
  // BORRABA el seam y volvía a firmar: doble pago.

  it('★ un RPC que LANZA no borra la fila ni re-emite', async () => {
    // RE-ANCLADO. Asertaba contra el `Map` en memoria (`getSettledSignature` sincrónica
    // devolviendo un string) y contaba broadcasts de `sendAndConfirmTransaction`. Los
    // dos desaparecieron con WKH-307. El estado equivalente hoy es una fila `confirmed`
    // en la tabla, y el RPC que lanza es `getSignatureStatuses`.
    seedLedger('run-idem3:0', { status: 'confirmed', signature: SEEDED_SIG });
    fakeConnection.getSignatureStatuses.mockRejectedValue(
      new Error('RPC down'),
    );

    await expect(
      new SolanaPaymentAdapter().settle(settleReq('run-idem3:0')),
    ).rejects.toThrow(/SETTLE_PRESENCE_UNKNOWN/);

    expect(broadcasts).toHaveLength(0);
    expect(rows.get('run-idem3:0')).toEqual({
      status: 'confirmed',
      signature: SEEDED_SIG,
    });
  });

  it('control: una negativa DEMOSTRADA (ausente + blockhash expirado) SÍ se auto-cura', async () => {
    // RE-ANCLADO AL ESTADO `signed`. Antes corría contra una fila ya pagada y esperaba
    // DOS broadcasts: eso hoy sería el bug, no el control — con el ledger durable una
    // fila `confirmed` que la cadena no respalda RECHAZA, porque sus causas
    // (contabilidad corrupta, un RPC mintiendo, un fork) no se arreglan pagando de nuevo.
    //
    // La auto-curación legítima vive un estado más abajo, en `signed`, y exige DOS
    // pruebas: la firma no está en la cadena (el nodo buscó su histórico) Y su blockhash
    // ya murió. Ahí re-firmar es correcto, y es lo que este control desarma: sin él, un
    // fix que bloqueara TODO retry pasaría los tests de arriba igual.
    seedLedger('run-idem4:0', {
      status: 'signed',
      signature: SEEDED_SIG,
      lvbh: '1000',
    });
    // Ausencia PROBADA (`{value:[null]}` por defecto) + altura 2000 > 1000 ⟹ expirada.
    const res = await new SolanaPaymentAdapter().settle(
      settleReq('run-idem4:0'),
    );

    expect(mockReclaim).toHaveBeenCalledTimes(1);
    expect(broadcasts).toHaveLength(1); // re-emitió, correctamente
    expect(res.success).toBe(true);
    expect(res.txHash).toBe(localSignature(onlyBroadcast()));
  });

  it('EL HALLAZGO SE CERRÓ: un `null` del nodo ya NO re-emite', async () => {
    // ⚠️ ESTE TEST ESTÁ INVERTIDO A PROPÓSITO. Antes se llamaba
    // «DOCUMENTA EL HALLAZGO ABIERTO: un `null` del nodo todavía re-emite» y fijaba
    // DOS broadcasts para que nadie creyera que el 4º sitio estaba cerrado.
    //
    // Se puso rojo **porque el hallazgo se cerró**, no porque se haya roto algo.
    // WKH-307 sacó la determinación de ausencia de `getParsedTransaction` (cuyo `null`
    // mezcla "no existe" con "este nodo no lo tiene") y la pasó a
    // `getSignatureStatuses(..., {searchTransactionHistory:true})`, que sólo devuelve
    // `null` DESPUÉS de haber buscado. Un nodo que conoce la firma pero no la tiene
    // parseada ahora da `unknown`, y `unknown` no autoriza nada.
    seedLedger('run-idem5:0', {
      status: 'signed',
      signature: SEEDED_SIG,
      lvbh: '1000',
    });
    // El status dice que la firma ESTÁ (presente, sin error)...
    fakeConnection.getSignatureStatuses.mockResolvedValue({
      value: [{ err: null, confirmationStatus: 'confirmed' }],
    });
    // ...pero este nodo no la tiene parseada. Antes: `valid:false` ⟹ re-emitir.
    fakeConnection.getParsedTransaction.mockResolvedValue(null);

    await expect(
      new SolanaPaymentAdapter().settle(settleReq('run-idem5:0')),
    ).rejects.toThrow(/SETTLE_IN_FLIGHT_UNRESOLVED/);

    expect(broadcasts).toHaveLength(0); // ← el riesgo, ahora cerrado
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
    expect(broadcasts).toHaveLength(0);
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
    expect(broadcasts).toHaveLength(0);
  });

  it('★ la firma NO se anota con un valor derivado de un error', async () => {
    // RE-ANCLADO. Asertaba `getSettledSignature(...)` `undefined` sobre el Map de
    // proceso. Hoy la fila SIEMPRE existe cuando se llega acá (el reclamo va antes de
    // la ramificación, CD-14), así que "no hay nada" ya no se puede leer del estado.
    // Lo que la propiedad significa de verdad es que la ESCRITURA DE LA FIRMA no
    // ocurre, y eso se asserta directo sobre el ledger.
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
    process.env.SOLANA_FACILITATOR_URL = 'https://facilitator.test';
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'PAYOUT_IN_PROGRESS' } }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(
      new SolanaPaymentAdapter().settle(settleReq('run-err:0')),
    ).rejects.toThrow();

    expect(mockRecordSigned).not.toHaveBeenCalled();
    expect(rows.get('run-err:0')?.signature).toBeUndefined();
  });

  it('★ una re-firma legítima con la bandera ON tampoco toca la llave local', async () => {
    // El SEGUNDO sitio que transmite: la cola de `settleAlreadySigned`, después de
    // probar que la firma vieja no puede aterrizar. Si la bandera sólo se respetara en
    // la rama `claimed`, un intent que llegue por acá firmaría con la LLAVE LOCAL con
    // la bandera ON — justo lo que CD-15 prohíbe, y sin ningún test rojo.
    process.env.SOLANA_SETTLE_VIA_FACILITATOR = 'true';
    process.env.SOLANA_FACILITATOR_URL = 'https://facilitator.test';
    fetchSpy.mockResolvedValue(okPayoutResponse());
    seedLedger('run-resign:0', {
      status: 'signed',
      signature: SEEDED_SIG,
      lvbh: '1000',
    });

    const res = await new SolanaPaymentAdapter().settle(
      settleReq('run-resign:0'),
    );

    expect(res.txHash).toBe(FACILITATOR_SIG);
    expect(mockReclaim).toHaveBeenCalledTimes(1);
    expect(mockGetOperatorKeypair).not.toHaveBeenCalled();
    expect(broadcasts).toHaveLength(0);
  });
});
