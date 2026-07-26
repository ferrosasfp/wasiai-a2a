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

import { PublicKey, type Transaction } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const PAY_TO = 'So11111111111111111111111111111111111111112';
const OPERATOR = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
const FAKE_SIG = '5'.repeat(64);

// ── Mock the network boundary (chain.ts) ─────────────────────────────────
const fakeConnection = {
  getParsedTransaction: vi.fn(
    (..._a: unknown[]): Promise<unknown> => Promise.resolve(null),
  ),
  // CR-2 (WKH-234): lectura del balance del ATA del operador (pre-flight).
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

// ── Mock sendAndConfirmTransaction (keep PublicKey/Transaction real) ──────
const mockSendAndConfirm = vi.fn((..._a: unknown[]) =>
  Promise.resolve(FAKE_SIG),
);
vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  return {
    ...actual,
    sendAndConfirmTransaction: (...a: unknown[]) => mockSendAndConfirm(...a),
  };
});

import { getSolanaUsdcDecimals } from './chain.js';
import { _resetSolanaClients, SolanaPaymentAdapter } from './payment.js';

describe('SolanaPaymentAdapter (WKH-234)', () => {
  beforeEach(() => {
    _resetSolanaClients();
    vi.clearAllMocks();
    // `clearAllMocks` NO borra implementaciones, así que un `mockReturnValue`
    // de un test se filtraría a los siguientes. Se re-fija el default (6).
    vi.mocked(getSolanaUsdcDecimals).mockReturnValue(6);
    fakeConnection.getParsedTransaction.mockResolvedValue(null);
    fakeConnection.getTokenAccountBalance.mockResolvedValue({
      value: { amount: '1000000' },
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
    expect(res.txHash).toBe(FAKE_SIG);
    expect(mockGetOrCreateAta).toHaveBeenCalledTimes(2); // operator + payTo ATAs
    expect(mockCreateTransferIx).toHaveBeenCalledTimes(1);
    expect(mockSendAndConfirm).toHaveBeenCalledTimes(1);

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
    expect(first.txHash).toBe(FAKE_SIG);
    expect(mockSendAndConfirm).toHaveBeenCalledTimes(1);

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
    expect(retry.txHash).toBe(FAKE_SIG);
    expect(mockSendAndConfirm).toHaveBeenCalledTimes(1); // STILL 1 — no re-emit
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

    // TransactionExpiredTimeoutError expone `signature` (base58) como campo.
    const timeoutErr = Object.assign(
      new Error('Transaction was not confirmed in 30.00 seconds'),
      { signature: FAKE_SIG },
    );
    mockSendAndConfirm.mockRejectedValueOnce(timeoutErr);
    mockConfirmedTx();

    const res = await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId,
    });

    expect(res.success).toBe(true);
    expect(res.txHash).toBe(FAKE_SIG);
    // La firma se consultó on-chain una vez y NO se re-emitió el transfer.
    expect(fakeConnection.getParsedTransaction).toHaveBeenCalledTimes(1);
    expect(mockSendAndConfirm).toHaveBeenCalledTimes(1);
    expect(mockCreateTransferIx).toHaveBeenCalledTimes(1);

    // `_intentSignatures` quedó poblado: un retry con el MISMO intentId es un
    // idempotent-hit (verify de la firma previa, cero broadcasts nuevos).
    const retry = await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId,
    });
    expect(retry.txHash).toBe(FAKE_SIG);
    expect(mockSendAndConfirm).toHaveBeenCalledTimes(1);
    expect(mockCreateTransferIx).toHaveBeenCalledTimes(1);
  });

  it('T-235a-AC1b: timeout sin `signature` en el error → la firma se deriva de la tx ya firmada (Transaction.signature)', async () => {
    const adapter = new SolanaPaymentAdapter();
    // sendAndConfirmTransaction firma el MISMO objeto Transaction in-place antes
    // de broadcastear → la firma sobrevive al throw. Buffer con al menos un byte
    // no-cero (63 ceros + 0x01) ⇒ base58 '1'×63 + '2'.
    const rawSig = Buffer.alloc(64);
    rawSig[63] = 1;
    mockSendAndConfirm.mockImplementationOnce((..._a: unknown[]) => {
      const tx = _a[1] as Transaction;
      tx.signatures = [
        { publicKey: new PublicKey(OPERATOR), signature: rawSig },
      ];
      return Promise.reject(new Error('socket hang up'));
    });
    mockConfirmedTx();

    const res = await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'ctx-timeout:1:payTo',
    });

    expect(res.success).toBe(true);
    expect(res.txHash).toBe(`${'1'.repeat(63)}2`);
    expect(mockSendAndConfirm).toHaveBeenCalledTimes(1);
  });

  it('T-235a-AC1b0: `Transaction.signature` todo-ceros (placeholder pre-firma) → NO es firma derivable, propaga el error y cero lecturas on-chain', async () => {
    const adapter = new SolanaPaymentAdapter();
    // Guard MNR-3 (fix-pack AR): 64 bytes en cero es el placeholder de web3.js,
    // no una firma. Su base58 ('1'×64) NO es consultable on-chain y contaminaría
    // el ledger (`settle_signature`) si se aceptara como txHash.
    mockSendAndConfirm.mockImplementationOnce((..._a: unknown[]) => {
      const tx = _a[1] as Transaction;
      tx.signatures = [
        { publicKey: new PublicKey(OPERATOR), signature: Buffer.alloc(64) },
      ];
      return Promise.reject(new Error('socket hang up'));
    });
    mockConfirmedTx(); // aunque la cadena diría "pagado", no hay firma que consultar

    await expect(
      adapter.settle({
        payTo: PAY_TO,
        amountAtomic: '1000000',
        intentId: 'ctx-timeout:1b0:payTo',
      }),
    ).rejects.toThrow('socket hang up');
    expect(fakeConnection.getParsedTransaction).not.toHaveBeenCalled();
    expect(mockSendAndConfirm).toHaveBeenCalledTimes(1);
  });

  it('T-235a-AC2: timeout + tx NO confirmada on-chain → propaga el error original (sin regresión)', async () => {
    const adapter = new SolanaPaymentAdapter();
    const timeoutErr = Object.assign(new Error('not confirmed in 30.00s'), {
      signature: FAKE_SIG,
    });
    mockSendAndConfirm.mockRejectedValueOnce(timeoutErr);
    fakeConnection.getParsedTransaction.mockResolvedValue(null); // no está on-chain

    await expect(
      adapter.settle({
        payTo: PAY_TO,
        amountAtomic: '1000000',
        intentId: 'ctx-timeout:2:payTo',
      }),
    ).rejects.toThrow('not confirmed in 30.00s');
    expect(mockSendAndConfirm).toHaveBeenCalledTimes(1);
  });

  it('T-235a-AC2b: timeout + tx confirmada pero INVÁLIDA (monto insuficiente) → NO se trata como éxito', async () => {
    const adapter = new SolanaPaymentAdapter();
    const timeoutErr = Object.assign(new Error('blockhash expired'), {
      signature: FAKE_SIG,
    });
    mockSendAndConfirm.mockRejectedValueOnce(timeoutErr);
    mockConfirmedTx('500000'); // transferido < requerido

    await expect(
      adapter.settle({
        payTo: PAY_TO,
        amountAtomic: '1000000',
        intentId: 'ctx-timeout:3:payTo',
      }),
    ).rejects.toThrow('blockhash expired');
    expect(mockSendAndConfirm).toHaveBeenCalledTimes(1);
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
    mockSendAndConfirm.mockRejectedValueOnce(sendErr);
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
    expect(mockSendAndConfirm).toHaveBeenCalledTimes(1);
    expect(mockCreateTransferIx).toHaveBeenCalledTimes(1);
  });

  it('T-235a-AC2c: fallo ANTES de firmar (sin firma derivable) → propaga el error, cero lecturas on-chain', async () => {
    const adapter = new SolanaPaymentAdapter();
    mockSendAndConfirm.mockRejectedValueOnce(
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

  it('T-235a-AC2d: recovery cuyo verify() lanza (RPC caído) → propaga el error original', async () => {
    const adapter = new SolanaPaymentAdapter();
    const timeoutErr = Object.assign(new Error('confirm timeout'), {
      signature: FAKE_SIG,
    });
    mockSendAndConfirm.mockRejectedValueOnce(timeoutErr);
    fakeConnection.getParsedTransaction.mockRejectedValue(new Error('429 rpc'));

    await expect(
      adapter.settle({
        payTo: PAY_TO,
        amountAtomic: '1000000',
        intentId: 'ctx-timeout:5:payTo',
      }),
    ).rejects.toThrow('confirm timeout');
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
    expect(mockSendAndConfirm).not.toHaveBeenCalled();
  });

  // ── Fix-pack AR-profundo FIX 2 — peek del seam de idempotencia ──────────
  it('T-FIX2-adapter: getSettledSignature() expone la firma del intent settleado (lectura pura, sin RPC) y undefined si no existe', async () => {
    const adapter = new SolanaPaymentAdapter();
    const intentId = 'ctx-fix2:0:payTo';

    // Intent desconocido → undefined, y NO toca la red.
    expect(adapter.getSettledSignature(intentId)).toBeUndefined();
    expect(adapter.getSettledSignature('otro-intent')).toBeUndefined();
    expect(mockSendAndConfirm).not.toHaveBeenCalled();
    expect(fakeConnection.getParsedTransaction).not.toHaveBeenCalled();

    await adapter.settle({ payTo: PAY_TO, amountAtomic: '1000000', intentId });

    // Post-settle: la firma confirmada queda visible para el pre-flight del
    // caller (que así NO corta por fondos un leg YA pagado).
    expect(adapter.getSettledSignature(intentId)).toBe(FAKE_SIG);
    expect(adapter.getSettledSignature('otro-intent')).toBeUndefined();
    // Sigue siendo una lectura pura: un solo broadcast (el del settle).
    expect(mockSendAndConfirm).toHaveBeenCalledTimes(1);
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
