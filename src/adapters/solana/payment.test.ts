/**
 * Unit tests for SolanaPaymentAdapter (WKH-234, AC-2 / AC-7).
 *
 * The real settle (build+sign+broadcast+confirm) is exercised with a MOCKED
 * `@solana/web3.js` + `@solana/spl-token` + `./chain.js` (no network in CI). A
 * devnet integration test is gated behind `SOLANA_DEVNET_E2E=1` (importActual).
 *
 * CD-11: every `vi.fn` uses a rest param `(..._a: unknown[])` to avoid TS2556.
 * CD-12: `mock.calls[N]` accesses are guarded (noUncheckedIndexedAccess).
 */

import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const PAY_TO = 'So11111111111111111111111111111111111111112';
/** Keypair REAL: `tx.serialize()` VERIFICA las firmas (un secreto falso explota). */
const OPERATOR_KEYPAIR = Keypair.fromSeed(new Uint8Array(32).fill(7));
const OPERATOR = OPERATOR_KEYPAIR.publicKey.toBase58();
/**
 * Blockhashes válidos (32 bytes base58), deterministas y DISTINTOS por llamada — como
 * un RPC real, donde los bloques avanzan.
 *
 * ⚠️ Hace falta que sean distintos porque `createTransferInstruction` está mockeada a
 * una instrucción FIJA: sin variar el blockhash, dos settles producirían el MISMO
 * mensaje y por lo tanto la MISMA firma, chocando contra el UNIQUE (el escenario que
 * T-IDM-08 ejercita a propósito, y que acá sería sólo ruido del doble).
 */
const blockhashFor = (n: number) =>
  Keypair.fromSeed(new Uint8Array(32).fill(9 + (n % 200))).publicKey.toBase58();
let blockhashSeq = 0;
const BLOCKHASH = blockhashFor(0);
const FAKE_SIG = '5'.repeat(64);

// ── Mock the network boundary (chain.ts) ─────────────────────────────────
/** Estado que devuelve `getSignatureStatuses` (null = ausente tras buscar historico). */
const presenceState: { value: { err: unknown } | null } = {
  value: { err: null },
};
const fakeConnection = {
  getParsedTransaction: vi.fn(
    (..._a: unknown[]): Promise<unknown> => Promise.resolve(null),
  ),
  // CR-2 (WKH-234): lectura del balance del ATA del operador (pre-flight).
  getTokenAccountBalance: vi.fn(
    (..._a: unknown[]): Promise<unknown> =>
      Promise.resolve({ value: { amount: '1000000' } }),
  ),
  // WKH-307: el adapter dejó de usar `sendAndConfirmTransaction` (ese helper
  // sobrescribe el blockhash y RE-FIRMA adentro, así que sería imposible conocer la
  // firma ANTES de transmitir — que es lo que la invariante I2 necesita).
  getLatestBlockhash: vi.fn((..._a: unknown[]) =>
    Promise.resolve({
      blockhash: blockhashFor(blockhashSeq++),
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

// ── Mock spl-token instruction builders ──────────────────────────────────
const mockGetOrCreateAta = vi.fn((..._a: unknown[]) =>
  Promise.resolve({ address: new PublicKey(PAY_TO) }),
);
const mockCreateTransferIx = vi.fn((..._a: unknown[]) => ({
  keys: [],
  programId: new PublicKey(MINT),
  data: Buffer.alloc(0),
}));
const mockGetAtaSync = vi.fn((..._a: unknown[]) => new PublicKey(OPERATOR));
vi.mock('@solana/spl-token', () => ({
  getOrCreateAssociatedTokenAccount: (...a: unknown[]) =>
    mockGetOrCreateAta(...a),
  createTransferInstruction: (...a: unknown[]) => mockCreateTransferIx(...a),
  getAssociatedTokenAddressSync: (...a: unknown[]) => mockGetAtaSync(...a),
}));

// ── T-PAY-04: el helper que la HU ABANDONA ────────────────────────────────
// `sendAndConfirmTransaction` sobrescribe el blockhash y RE-FIRMA adentro, así que
// mientras se lo use es IMPOSIBLE conocer la firma antes de transmitir — y sin eso la
// invariante I2 (persistir antes de broadcastear) no puede existir. El doble queda
// para poder afirmar que registra CERO llamadas en todos los caminos.
const mockSendAndConfirm = vi.fn((..._a: unknown[]) => Promise.resolve('nope'));
vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  return {
    ...actual,
    sendAndConfirmTransaction: (...a: unknown[]) => mockSendAndConfirm(...a),
  };
});

// ── El ledger y el preflight ──────────────────────────────────────────────
// Sin estos dobles, `settle()` hablaría con el `supabase` que `vitest.config.ts`
// apunta a localhost, el reclamo fallaría y —por FAIL-CLOSED— todo test que llegue a
// settle() se pondría rojo POR EL MOTIVO EQUIVOCADO.
const ledgerRows = new Map<string, { signature: string | null }>();
const ledgerSignatures = new Set<string>();
const claimMock = vi.fn(async (a: { intentId: string }) => {
  const row = ledgerRows.get(a.intentId);
  if (!row) {
    ledgerRows.set(a.intentId, { signature: null });
    return { outcome: 'claimed' as const, attempts: 1 };
  }
  if (row.signature) {
    return { outcome: 'confirmed' as const, signature: row.signature };
  }
  return { outcome: 'in_progress' as const };
});
const recordSignedMock = vi.fn(
  async (a: {
    intentId: string;
    signature: string;
    lastValidBlockHeight: string;
  }) => {
    if (ledgerSignatures.has(a.signature)) {
      return {
        ok: false as const,
        reason: 'signature_collision' as const,
        detail: 'dup',
      };
    }
    ledgerSignatures.add(a.signature);
    const row = ledgerRows.get(a.intentId);
    if (row) row.signature = a.signature;
    return { ok: true as const, attempts: 1 };
  },
);
const recordConfirmedMock = vi.fn(async () => ({ ok: true as const }));
type PeekRead =
  | { state: 'none' }
  | { state: 'claimed' }
  | { state: 'signed'; signature: string }
  | { state: 'confirmed'; signature: string }
  | { state: 'unknown'; detail: string };
const readMock = vi.fn(async (intentId: string): Promise<PeekRead> => {
  const row = ledgerRows.get(intentId);
  if (!row) return { state: 'none' };
  return row.signature
    ? { state: 'confirmed', signature: row.signature }
    : { state: 'claimed' };
});
vi.mock('./settle-ledger.js', () => ({
  claimSettleIntent: (...a: unknown[]) =>
    claimMock(...(a as [{ intentId: string }])),
  recordSignedIntent: (...a: unknown[]) =>
    recordSignedMock(
      ...(a as [
        { intentId: string; signature: string; lastValidBlockHeight: string },
      ]),
    ),
  recordConfirmedIntent: () => recordConfirmedMock(),
  reclaimExpiredIntent: vi.fn(async () => ({ ok: true })),
  readSettleIntent: (...a: unknown[]) => readMock(...(a as [string])),
  probeSettleLedger: vi.fn(async () => ({ probe: 'ok' })),
}));
vi.mock('./schema-preflight.js', () => ({
  ensureSolanaSchemaReady: vi.fn(async () => ({ ok: true })),
  warmSolanaSchemaPreflight: vi.fn(),
  _resetSolanaSchemaPreflight: vi.fn(),
}));

import { readSettleValueDisposition } from '../errors.js';
import { base58Encode } from './base58.js';
import { getSolanaUsdcDecimals } from './chain.js';
import { _resetSolanaClients, SolanaPaymentAdapter } from './payment.js';

/**
 * La firma que el adapter persistió ANTES de transmitir (invariante I2). WKH-307: ya
 * no hay una `FAKE_SIG` fija que el doble del broadcast devuelva — la firma la produce
 * el adapter al firmar, y ES la que viaja on-chain.
 */
const persistedSig = (n = 0): string | undefined =>
  recordSignedMock.mock.calls[n]?.[0]?.signature;

describe('SolanaPaymentAdapter (WKH-234)', () => {
  beforeEach(() => {
    _resetSolanaClients();
    vi.clearAllMocks();
    ledgerRows.clear();
    ledgerSignatures.clear();
    // `clearAllMocks` NO borra implementaciones, así que un `mockReturnValue`
    // de un test se filtraría a los siguientes. Se re-fija el default (6).
    vi.mocked(getSolanaUsdcDecimals).mockReturnValue(6);
    fakeConnection.getParsedTransaction.mockResolvedValue(null);
    presenceState.value = { err: null };
    fakeConnection.getTokenAccountBalance.mockResolvedValue({
      value: { amount: '1000000' },
    });
    // Secuencia reiniciada por test ⟹ el primer settle de cada test usa BLOCKHASH.
    blockhashSeq = 0;
    fakeConnection.sendRawTransaction.mockResolvedValue('sent');
    fakeConnection.confirmTransaction.mockResolvedValue({
      value: { err: null },
    });
  });

  afterEach(() => {
    _resetSolanaClients();
  });

  // ── quote() — fix-pack P1 hallazgo 3 ──────────────────────────────────
  // `quote()` estaba con 0% de cobertura (verificado con --coverage.include):
  // el fix del monto atómico habría quedado en código que la suite nunca
  // ejecuta, o sea indistinguible de un fix que nunca corre.
  it('T-P1-3a: quote() convierte USD → atómico exacto con los decimals del mint (6)', async () => {
    const adapter = new SolanaPaymentAdapter();

    expect((await adapter.quote(1)).amountWei).toBe('1000000');
    expect((await adapter.quote(0.03)).amountWei).toBe('30000');
    expect((await adapter.quote(1.005)).amountWei).toBe('1005000');
    expect((await adapter.quote(0.000001)).amountWei).toBe('1');
    expect((await adapter.quote(400)).amountWei).toBe('400000000');

    const q = await adapter.quote(1);
    expect(q.token.decimals).toBe(6);
    expect(q.token.symbol).toBe('USDC');
  });

  it('T-P1-3b: quote() honra los decimals del mint — con 9 no hay artefacto de float', async () => {
    // El artefacto de `toFixed(decimals)` aparece a > 6 decimales. Un mint de 9
    // decimales (SOL-like) lo expone: 0.03 daba 29999999 en vez de 30000000.
    vi.mocked(getSolanaUsdcDecimals).mockReturnValue(9);
    const adapter = new SolanaPaymentAdapter();

    expect((await adapter.quote(0.03)).amountWei).toBe('30000000');
    expect((await adapter.quote(0.1)).amountWei).toBe('100000000');
    expect((await adapter.quote(1.005)).amountWei).toBe('1005000000');
    expect((await adapter.quote(1)).token.decimals).toBe(9);
  });

  it('T-P1-3c: quote() con un monto sub-atómico en notación científica NO lanza', async () => {
    // `String(1e-7)` es '1e-7' y `parseUnits` lanza con notación científica.
    const adapter = new SolanaPaymentAdapter();
    await expect(adapter.quote(1e-7)).resolves.toMatchObject({
      amountWei: '0',
    });
  });

  it('T-234-AC2: settle() builds + broadcasts an SPL transfer → { success, txHash }', async () => {
    const adapter = new SolanaPaymentAdapter();
    const res = await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'ctx-1:0:payTo',
    });

    expect(res.success).toBe(true);
    // La firma devuelta es EXACTAMENTE la persistida antes del broadcast.
    expect(res.txHash).toBe(persistedSig());
    expect(res.txHash).toBeTruthy();
    expect(mockGetOrCreateAta).toHaveBeenCalledTimes(2); // operator + payTo ATAs
    expect(mockCreateTransferIx).toHaveBeenCalledTimes(1);
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(1);

    // amount threaded as bigint into the transfer instruction (arg index 3).
    const call = mockCreateTransferIx.mock.calls[0];
    expect(call?.[3]).toBe(1000000n);
  });

  it('T-234-AC7: retry with an already-confirmed intentId → NO re-broadcast, returns prior signature via verify()', async () => {
    const adapter = new SolanaPaymentAdapter();
    const intentId = 'ctx-1:0:payTo';

    // First settle broadcasts once.
    const first = await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId,
    });
    expect(first.txHash).toBe(persistedSig());
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(1);

    // verify() re-reads the tx on-chain: a confirmed transfer of >= amount to
    // payTo's balance (post - pre delta).
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

    // Retry with the SAME intentId → idempotent hit, no second broadcast.
    const retry = await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId,
    });
    expect(retry.success).toBe(true);
    expect(retry.txHash).toBe(persistedSig());
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(1); // STILL 1 — no re-emit
    expect(fakeConnection.getParsedTransaction).toHaveBeenCalledTimes(1);
  });

  it('verify() rejects a tx whose on-chain transfer is < required amount', async () => {
    const adapter = new SolanaPaymentAdapter();
    fakeConnection.getParsedTransaction.mockResolvedValue({
      meta: {
        err: null,
        preTokenBalances: [
          { owner: PAY_TO, mint: MINT, uiTokenAmount: { amount: '0' } },
        ],
        postTokenBalances: [
          { owner: PAY_TO, mint: MINT, uiTokenAmount: { amount: '500000' } },
        ],
      },
    });
    const res = await adapter.verify({
      signature: FAKE_SIG,
      payTo: PAY_TO,
      amountAtomic: '1000000',
    });
    expect(res.valid).toBe(false);
  });

  it('verify() rejects a tx not found / failed on-chain', async () => {
    const adapter = new SolanaPaymentAdapter();
    fakeConnection.getParsedTransaction.mockResolvedValue(null);
    const res = await adapter.verify({
      signature: FAKE_SIG,
      payTo: PAY_TO,
      amountAtomic: '1000000',
    });
    expect(res.valid).toBe(false);
  });

  // ── WKH-235a (AC-1/AC-2) — recuperación de firma tras timeout ───────────

  /** Confirmed tx fixture reusada por los casos de recovery (delta >= required). */
  function mockConfirmedTx(amount = '1000000'): void {
    fakeConnection.getParsedTransaction.mockResolvedValue({
      meta: {
        err: null,
        preTokenBalances: [
          { owner: PAY_TO, mint: MINT, uiTokenAmount: { amount: '0' } },
        ],
        postTokenBalances: [
          { owner: PAY_TO, mint: MINT, uiTokenAmount: { amount } },
        ],
      },
    });
  }

  it('T-235a-AC1: confirmation timeout + tx CONFIRMED on-chain → success con la firma del error, sin segundo transfer', async () => {
    const adapter = new SolanaPaymentAdapter();
    const intentId = 'ctx-timeout:0:payTo';

    // TransactionExpiredTimeoutError expone `signature` (base58) como campo — y en
    // producción es LA MISMA firma que el adapter acaba de firmar y persistir. El
    // doble lo reproduce leyéndola del ledger en vez de inventar una constante: una
    // firma distinta sería un escenario que no puede ocurrir.
    fakeConnection.confirmTransaction.mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(
          new Error('Transaction was not confirmed in 30.00 seconds'),
          { signature: persistedSig() },
        ),
      ),
    );
    mockConfirmedTx();

    const res = await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId,
    });

    expect(res.success).toBe(true);
    expect(res.txHash).toBe(persistedSig());
    // La firma se consultó on-chain una vez y NO se re-emitió el transfer.
    expect(fakeConnection.getParsedTransaction).toHaveBeenCalledTimes(1);
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(mockCreateTransferIx).toHaveBeenCalledTimes(1);

    // El LEDGER quedó poblado: un retry con el MISMO intentId es un idempotent-hit
    // (verify de la firma previa, cero broadcasts nuevos) — y ahora sobrevive a un
    // restart del proceso, que es el motivo de existir de la HU.
    const retry = await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId,
    });
    expect(retry.txHash).toBe(persistedSig());
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(mockCreateTransferIx).toHaveBeenCalledTimes(1);
  });

  it('T-235a-AC1b: error de confirmación SIN `signature` → la firma se deriva de la tx ya firmada', async () => {
    const adapter = new SolanaPaymentAdapter();
    // WKH-307: la tx la firma el ADAPTER antes de transmitir, así que su firma existe
    // y es real. Si el error de confirmación no la trae, se deriva de `tx.signature`
    // — que es EXACTAMENTE la que se persistió antes del broadcast (invariante I2).
    fakeConnection.confirmTransaction.mockRejectedValueOnce(
      new Error('socket hang up'),
    );
    mockConfirmedTx();

    const res = await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'ctx-timeout:1:payTo',
    });

    expect(res.success).toBe(true);
    // La firma recuperada es la MISMA que se persistió antes de transmitir.
    const persisted = recordSignedMock.mock.calls[0]?.[0]?.signature;
    expect(persisted).toBeTruthy();
    expect(res.txHash).toBe(persisted);
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('T-235a-AC1b0: una firma NO derivable nunca se convierte en txHash (guard MNR-3)', async () => {
    // El escenario original —`Transaction.signature` en 64 ceros, el placeholder de
    // web3.js— dejó de ser alcanzable vía `settle()`: el adapter firma con un keypair
    // REAL y, si tras firmar no hay firma, REHÚSA antes de transmitir. La propiedad que
    // el test protege es la misma: **un placeholder jamás viaja como `txHash` ni se
    // persiste como `settle_signature`**. Se fuerza dejando `sign()` sin efecto.
    const adapter = new SolanaPaymentAdapter();
    const signSpy = vi
      .spyOn(Transaction.prototype, 'sign')
      .mockImplementationOnce(function (this: Transaction) {
        this.signatures = [];
      });

    await expect(
      adapter.settle({
        payTo: PAY_TO,
        amountAtomic: '1000000',
        intentId: 'ctx-timeout:1b0:payTo',
      }),
    ).rejects.toThrow(/SETTLE_SIGN_FAILED/);

    // Ni se transmitió, ni se persistió una firma basura, ni se leyó la cadena.
    expect(fakeConnection.sendRawTransaction).not.toHaveBeenCalled();
    expect(recordSignedMock).not.toHaveBeenCalled();
    expect(fakeConnection.getParsedTransaction).not.toHaveBeenCalled();
    signSpy.mockRestore();
  });

  // ══════════════════════════════════════════════════════════════
  // WKH-308 — un settle que SI se pago dejaba de reportarse como pagado
  // ══════════════════════════════════════════════════════════════

  it('T-308-01: nodo ATRASADO tras un fallo de confirmación ⟹ NO se afirma que el leg no se pagó', async () => {
    // EL ESCENARIO REAL: el broadcast salió, la confirmación cortó por timeout, y la tx
    // SI ATERRIZO. Al recuperar, el nodo que responde conoce la firma
    // (`getSignatureStatuses` la reporta presente) pero todavía no la tiene indexada
    // (`getParsedTransaction` da null).
    //
    // ANTES: `verify()` colapsaba ese null con "no está" ⟹ `valid:false` ⟹ el settle se
    // reportaba FALLADO sobre un pago que ocurrió. La contabilidad quedaba diciendo lo
    // contrario de lo que pasó, y ese dato falso es el insumo de un job futuro que
    // trate la fila como pendiente.
    //
    // AHORA: se distingue "no pude comprobarlo" y se transporta como tal.
    const adapter = new SolanaPaymentAdapter();
    fakeConnection.confirmTransaction.mockRejectedValueOnce(
      new Error('Transaction was not confirmed in 30.00 seconds'),
    );
    presenceState.value = { err: null }; // la cadena SI la conoce
    fakeConnection.getParsedTransaction.mockResolvedValue(null); // nodo atrasado

    const err = await adapter
      .settle({
        payTo: PAY_TO,
        amountAtomic: '1000000',
        intentId: 'ctx-308:lagging:payTo',
      })
      .catch((e: Error) => e);

    // EL EFECTO: el error transporta "no sé si se pagó", no "no se pagó". Es lo que
    // hace que el leg NO se contabilice como impago.
    expect(readSettleValueDisposition(err)).toBe('unknown');
    // Y no se re-transmitió nada: seguimos sin saber, y no saber no paga.
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('T-308-02: el caso que NO se puede romper — un settle que DE VERDAD falló sigue fallando', async () => {
    // Contracara obligatoria. Si esto se rompiera, el arreglo habría convertido todo
    // fallo en "no sé" y ningún leg volvería a reportarse como impago.
    const adapter = new SolanaPaymentAdapter();
    fakeConnection.confirmTransaction.mockRejectedValueOnce(
      new Error('not confirmed in 30.00s'),
    );
    presenceState.value = null; // el nodo BUSCÓ su histórico y no la conoce ⟹ absent
    fakeConnection.getParsedTransaction.mockResolvedValue(null);

    const err = await adapter
      .settle({
        payTo: PAY_TO,
        amountAtomic: '1000000',
        intentId: 'ctx-308:genuine:payTo',
      })
      .catch((e: Error) => e);

    // Sin disposición: es un fallo liso, reportable como tal.
    expect(readSettleValueDisposition(err)).toBeUndefined();
    expect(String(err)).toContain('not confirmed in 30.00s');
  });

  it('T-308-03: la tx aterrizó y FALLÓ on-chain ⟹ también es un fallo liso', async () => {
    const adapter = new SolanaPaymentAdapter();
    fakeConnection.confirmTransaction.mockRejectedValueOnce(
      new Error('confirm boom'),
    );
    presenceState.value = { err: { InstructionError: [0, 'Custom'] } };

    const err = await adapter
      .settle({
        payTo: PAY_TO,
        amountAtomic: '1000000',
        intentId: 'ctx-308:onchainfail:payTo',
      })
      .catch((e: Error) => e);

    expect(readSettleValueDisposition(err)).toBeUndefined();
  });

  it('T-235a-AC2: timeout + tx NO confirmada on-chain → propaga el error original (sin regresión)', async () => {
    const adapter = new SolanaPaymentAdapter();
    const timeoutErr = Object.assign(new Error('not confirmed in 30.00s'), {
      signature: FAKE_SIG,
    });
    fakeConnection.confirmTransaction.mockRejectedValueOnce(timeoutErr);
    // WKH-308: "no está on-chain" ahora se PRUEBA (el nodo buscó su histórico y no la
    // conoce), no se infiere de que el parseo no esté disponible.
    presenceState.value = null;
    fakeConnection.getParsedTransaction.mockResolvedValue(null);

    await expect(
      adapter.settle({
        payTo: PAY_TO,
        amountAtomic: '1000000',
        intentId: 'ctx-timeout:2:payTo',
      }),
    ).rejects.toThrow('not confirmed in 30.00s');
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('T-235a-AC2b: timeout + tx confirmada pero INVÁLIDA (monto insuficiente) → NO se trata como éxito', async () => {
    const adapter = new SolanaPaymentAdapter();
    const timeoutErr = Object.assign(new Error('blockhash expired'), {
      signature: FAKE_SIG,
    });
    fakeConnection.confirmTransaction.mockRejectedValueOnce(timeoutErr);
    mockConfirmedTx('500000'); // transferido < requerido

    await expect(
      adapter.settle({
        payTo: PAY_TO,
        amountAtomic: '1000000',
        intentId: 'ctx-timeout:3:payTo',
      }),
    ).rejects.toThrow('blockhash expired');
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('T-235a-AC2e: tx CONFIRMADA pero FALLIDA on-chain (meta.err) → NO se recupera aunque el delta de balances alcance', async () => {
    const adapter = new SolanaPaymentAdapter();
    // Escenario más probable en devnet tras un timeout: `sendAndConfirmTransaction`
    // lanza un SendTransactionError que SÍ trae `signature` (se asigna en runtime),
    // así que entra a recoverConfirmedSettle con un candidato válido. Lo único que
    // lo detiene es el guard `meta.err` de verify() → esta propiedad de seguridad
    // queda FIJADA acá (un refactor que reordene ese guard debe romper este test).
    const sendErr = Object.assign(
      new Error('Transaction simulation failed: custom program error 0x1'),
      { signature: FAKE_SIG },
    );
    fakeConnection.confirmTransaction.mockRejectedValueOnce(sendErr);
    // meta.err NO nulo, pero con pre/postTokenBalances que darían delta suficiente:
    // el rechazo debe venir del `err`, NO de la validación de monto.
    fakeConnection.getParsedTransaction.mockResolvedValue({
      meta: {
        err: { InstructionError: [0, { Custom: 1 }] },
        preTokenBalances: [
          { owner: PAY_TO, mint: MINT, uiTokenAmount: { amount: '0' } },
        ],
        postTokenBalances: [
          { owner: PAY_TO, mint: MINT, uiTokenAmount: { amount: '5000000' } },
        ],
      },
    });

    await expect(
      adapter.settle({
        payTo: PAY_TO,
        amountAtomic: '1000000',
        intentId: 'ctx-failed:0:payTo',
      }),
    ).rejects.toThrow('custom program error 0x1');
    // Se consultó on-chain (el candidato existía) y NO se re-emitió el transfer.
    expect(fakeConnection.getParsedTransaction).toHaveBeenCalledTimes(1);
    expect(fakeConnection.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(mockCreateTransferIx).toHaveBeenCalledTimes(1);
  });

  it('T-235a-AC2c: fallo ANTES de firmar (sin firma derivable) → propaga el error, cero lecturas on-chain', async () => {
    const adapter = new SolanaPaymentAdapter();
    // WKH-307: el punto "antes de firmar" es ahora el fetch del blockhash — sin él no
    // hay tx firmada, así que no hay firma que consultar on-chain.
    fakeConnection.getLatestBlockhash.mockRejectedValueOnce(
      new Error('blockhash fetch failed'),
    );

    await expect(
      adapter.settle({
        payTo: PAY_TO,
        amountAtomic: '1000000',
        intentId: 'ctx-timeout:4:payTo',
      }),
    ).rejects.toThrow('blockhash fetch failed');
    expect(fakeConnection.getParsedTransaction).not.toHaveBeenCalled();
  });

  it('T-235a-AC2d (INVERTIDO por WKH-308): recovery con el RPC caído ⟹ UNKNOWN, no fallo', async () => {
    // ⚠️ CAMBIO DE CONDUCTA DECLARADO. Este test afirmaba que un RPC caído durante la
    // recuperación hacía **propagar el error original**, o sea reportar el leg como
    // FALLADO. Eso es exactamente el falso negativo que WKH-308 cierra: un RPC que no
    // contesta no prueba que el pago no ocurrió — prueba que no pudimos preguntar.
    //
    // Se invierte, no se borra: la propiedad que el test protegía (no inventar un
    // éxito) sigue viva — no se devuelve `success`, se rechaza. Lo que cambia es CÓMO
    // se rechaza: con la incertidumbre transportada en vez de afirmando lo que no
    // sabemos.
    const adapter = new SolanaPaymentAdapter();
    const timeoutErr = Object.assign(new Error('confirm timeout'), {
      signature: FAKE_SIG,
    });
    fakeConnection.confirmTransaction.mockRejectedValueOnce(timeoutErr);
    fakeConnection.getSignatureStatuses.mockRejectedValueOnce(
      new Error('429 rpc'),
    );

    const err = await adapter
      .settle({
        payTo: PAY_TO,
        amountAtomic: '1000000',
        intentId: 'ctx-timeout:5:payTo',
      })
      .catch((e: Error) => e);

    expect(readSettleValueDisposition(err)).toBe('unknown');
    // Y sigue sin devolver un éxito inventado.
    expect(String(err)).not.toContain('success');
  });

  // ── CR-2 (WKH-234) — pre-flight de balance del operador ─────────────────

  it('T-234-CR2-adapter: getOperatorSplBalance() lee el ATA del operador para el mint configurado → monto atómico', async () => {
    const adapter = new SolanaPaymentAdapter();
    fakeConnection.getTokenAccountBalance.mockResolvedValue({
      value: { amount: '7500000' },
    });

    const balance = await adapter.getOperatorSplBalance();

    expect(balance).toBe('7500000');
    // La ATA se deriva SIN red (sync) con (mint, operator.publicKey) — misma
    // derivación que usa settle para la cuenta origen.
    expect(mockGetAtaSync).toHaveBeenCalledTimes(1);
    const ataArgs = mockGetAtaSync.mock.calls[0];
    expect((ataArgs?.[0] as PublicKey).toBase58()).toBe(MINT);
    expect((ataArgs?.[1] as PublicKey).toBase58()).toBe(OPERATOR);
    expect(fakeConnection.getTokenAccountBalance).toHaveBeenCalledTimes(1);
    // Cero broadcasts: es una lectura pura.
    expect(fakeConnection.sendRawTransaction).not.toHaveBeenCalled();
  });

  // ── Fix-pack AR-profundo FIX 2 — peek del seam de idempotencia ──────────
  it('T-FIX2-adapter: getSettledSignature() es ASÍNCRONO y discriminado (DT-8)', async () => {
    // ⚠️ Antes devolvía `string | undefined`, lo que COLAPSABA *"no se pagó"* con
    // *"no sé si se pagó"* — que en un camino de dinero son OPUESTOS: el primero
    // autoriza a cortar por fondos insuficientes, el segundo obliga a fail-closear.
    const adapter = new SolanaPaymentAdapter();
    const intentId = 'ctx-peek:0:payTo';

    // Sin reclamo: `none` (y NO `undefined`, que no distinguía nada).
    expect(await adapter.getSettledSignature(intentId)).toEqual({
      state: 'none',
    });

    // Tras un settle exitoso: `settled` con LA firma.
    await adapter.settle({ payTo: PAY_TO, amountAtomic: '1000000', intentId });
    expect(await adapter.getSettledSignature(intentId)).toEqual({
      state: 'settled',
      signature: persistedSig(),
    });

    // Otro intent sigue en `none`.
    expect(await adapter.getSettledSignature('otro-intent')).toEqual({
      state: 'none',
    });

    // Y un store mudo es `unknown`: NUNCA lanza y NUNCA se lee como "no pagado".
    readMock.mockResolvedValueOnce({ state: 'unknown', detail: 'boom' });
    expect(await adapter.getSettledSignature(intentId)).toEqual({
      state: 'unknown',
    });
  });

  it('T-234-CR2-adapter-throws: RPC/ATA inexistente → LANZA (el caller decide cómo degradar)', async () => {
    const adapter = new SolanaPaymentAdapter();
    fakeConnection.getTokenAccountBalance.mockRejectedValue(
      new Error('could not find account'),
    );
    await expect(adapter.getOperatorSplBalance()).rejects.toThrow(
      'could not find account',
    );
  });

  // ══════════════════════════════════════════════════════════════
  // WKH-307 — EL ORDEN persist → broadcast (T-PAY-*)
  // ══════════════════════════════════════════════════════════════

  it('T-PAY-01: `recordSigned` ocurre ANTES de `sendRawTransaction`, y la firma es LA MISMA', async () => {
    // ⚠️ ESTE ES EL TEST DE LA INVARIANTE I2. Si el orden se invierte, una fila
    // `claimed` deja de demostrar que no se transmitió nada, y el caso
    // "transmitió y se cayó antes de persistir" se vuelve irrecuperable: no se puede
    // distinguir "no salió nada" de "salió y no sé cuál".
    const adapter = new SolanaPaymentAdapter();
    const res = await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'ctx-order:0:payTo',
    });

    const persistOrder = recordSignedMock.mock.invocationCallOrder[0] as number;
    const sendOrder = fakeConnection.sendRawTransaction.mock
      .invocationCallOrder[0] as number;
    expect(persistOrder).toBeLessThan(sendOrder);

    // Y la firma persistida es EXACTAMENTE la transmitida y la devuelta. Persistir
    // una firma distinta de la que sale sería peor que no persistir nada.
    const persisted = persistedSig();
    expect(res.txHash).toBe(persisted);
    const rawSent = fakeConnection.sendRawTransaction.mock.calls[0]?.[0];
    const txSent = Transaction.from(Buffer.from(rawSent as Uint8Array));
    expect(base58Encode(txSent.signature as Buffer)).toBe(persisted);
  });

  it('T-PAY-02: si `recordSigned` NO aplica ⟹ CERO broadcasts (I2 en forma falsable)', async () => {
    const adapter = new SolanaPaymentAdapter();
    recordSignedMock.mockResolvedValueOnce({
      ok: false,
      reason: 'not_claimed',
      detail: 'otro proceso es dueño del reclamo',
    } as never);

    await expect(
      adapter.settle({
        payTo: PAY_TO,
        amountAtomic: '1000000',
        intentId: 'ctx-order:1:payTo',
      }),
    ).rejects.toThrow(/SETTLE_LEDGER_WRITE_REFUSED/);
    expect(fakeConnection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('T-PAY-03: `feePayer`/`recentBlockhash` se setean ANTES de firmar, y el confirm usa LO PERSISTIDO', async () => {
    const adapter = new SolanaPaymentAdapter();
    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'ctx-order:2:payTo',
    });

    // La tx transmitida quedó anclada al blockhash pedido y firmada por el operador:
    // si el blockhash se hubiera seteado DESPUÉS de firmar, la firma no verificaría y
    // `Transaction.from` no podría reconstruirla con ese recentBlockhash.
    const rawSent = fakeConnection.sendRawTransaction.mock.calls[0]?.[0];
    const txSent = Transaction.from(Buffer.from(rawSent as Uint8Array));
    expect(txSent.recentBlockhash).toBe(BLOCKHASH);
    expect(txSent.signatures[0]?.publicKey.toBase58()).toBe(OPERATOR);

    // Y el confirm se hace contra EXACTAMENTE el blockhash/altura persistidos: si
    // difirieran, se estaría esperando la confirmación de otra ventana.
    const confirmArgs = fakeConnection.confirmTransaction.mock
      .calls[0]?.[0] as {
      signature: string;
      blockhash: string;
      lastValidBlockHeight: number;
    };
    expect(confirmArgs.signature).toBe(persistedSig());
    expect(confirmArgs.blockhash).toBe(BLOCKHASH);
    expect(String(confirmArgs.lastValidBlockHeight)).toBe(
      recordSignedMock.mock.calls[0]?.[0]?.lastValidBlockHeight,
    );
  });

  it('T-PAY-04: `sendAndConfirmTransaction` NO se invoca en NINGÚN camino', async () => {
    const adapter = new SolanaPaymentAdapter();

    // (a) camino feliz
    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'ctx-pay04:0:payTo',
    });
    // (b) camino de recuperación tras fallo de confirmación.
    //     ⚠️ Monto DISTINTO a propósito: con el blockhash fijo de este archivo, dos
    //     transferencias del mismo monto al mismo destino producen el MISMO mensaje y
    //     por lo tanto la MISMA firma — que es justo lo que el UNIQUE bloquea (ver
    //     T-IDM-08). Acá se quiere ejercitar el camino, no la colisión.
    fakeConnection.confirmTransaction.mockRejectedValueOnce(
      new Error('confirm timeout'),
    );
    mockConfirmedTx('2000000'); // el delta on-chain tiene que cubrir ESTE monto
    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '2000000',
      intentId: 'ctx-pay04:1:payTo',
    });
    // (c) camino idempotente (el intent de (a), ya confirmado)
    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'ctx-pay04:0:payTo',
    });

    expect(mockSendAndConfirm).toHaveBeenCalledTimes(0);
  });

  it('exposes the VM-agnostic surface (scheme, mint, caip2, tokens)', () => {
    const adapter = new SolanaPaymentAdapter();
    expect(adapter.vmFamily).toBe('solana');
    expect(adapter.getScheme()).toBe('spl-transfer');
    expect(adapter.getMint()).toBe(MINT);
    expect(adapter.getNetwork()).toBe('solana:test');
    expect(adapter.supportedTokens[0]?.mint).toBe(MINT);
    expect(adapter.supportedTokens[0]?.decimals).toBe(6);
  });
});

// ── El ex-"devnet e2e" se ELIMINÓ de este archivo (P1, hallazgo 6) ────────
//
// Había acá un `describe.runIf(SOLANA_DEVNET_E2E === '1')` llamado "settles a
// real SPL transfer on devnet" que NO probaba nada, y no podía probar nada
// VIVIENDO EN ESTE ARCHIVO: `vi.importActual('./payment.js')` desmockea el
// módulo pedido pero NO sus dependencias, así que el "settle real" resolvía
// contra el `./chain.js` mockeado de la línea 31 y el
// `sendAndConfirmTransaction` mockeado de la línea 64.
//
// Demostrado antes de borrarlo: con `SOLANA_DEVNET_E2E=1` y un
// `SOLANA_E2E_PAYTO` cualquiera, PASABA en 270 ms sin red, sin
// `SOLANA_OPERATOR_PRIVATE_KEY` y sin fondos, asertando `success: true` sobre
// `FAKE_SIG` — es decir, sobre su propio mock.
//
// Reemplazado por un split honesto:
//  · `settle-wiring.test.ts`      — OFFLINE y siempre activo en CI. Construye la
//    transferencia con el `@solana/spl-token` REAL y asertea monto/dirección/
//    firmante sobre los bytes de la instrucción.
//  · `devnet-e2e.manual.test.ts`  — la parte que SÍ necesita red, sin mocks,
//    opt-in por env y con runbook. Falla ruidosamente si le faltan las envs, en
//    vez de pasar en vacío.
