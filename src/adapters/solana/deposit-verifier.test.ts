/**
 * WKH-315 — tests de `verifySolanaDeposit`, el corazón del camino de ENTRADA.
 *
 * ── CD-16: LOS FIXTURES TIENEN LA FORMA REAL DEL RPC ────────────────────────
 *
 * `pre/postTokenBalances` se construyen con la forma exacta que devuelve Solana
 * (`{accountIndex, mint, owner, uiTokenAmount:{amount, decimals, uiAmount,
 * uiAmountString}}`) **y con `transaction.message.accountKeys` poblado**, porque el
 * match triple del paso 5b LEE `accountKeys[accountIndex]`. Un fixture sin
 * `accountKeys` hace pasar un test que no prueba el match — es la clase de falso verde
 * que esta HU tiene prohibido.
 *
 * Todas las pubkeys salen de `Keypair.generate()`: cero `'x'.repeat(44)`.
 *
 * ── CD-9: LOS DOBLES CAPTURAN SUS ARGS Y SE ASSERTA SOBRE ELLOS ─────────────
 *
 * `T-315-03b` no verifica un efecto: verifica el ARGUMENTO con el que se llamó a
 * `getParsedTransaction`. Sin eso, `DEPOSIT_COMMITMENT` podría ser `'processed'` y
 * todos los demás tests seguirían verdes.
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Dobles del RPC. Se mockea `chain.js` (la fábrica de la Connection), NO el
//    módulo bajo prueba ni `deposit-account.js`: la resolución de la cuenta de
//    depósito se ejercita de verdad, con env.
const MINT = 'So11111111111111111111111111111111111111112';
const mockGetSignatureStatuses = vi.hoisted(() => vi.fn());
const mockGetParsedTransaction = vi.hoisted(() => vi.fn());

vi.mock('./chain.js', () => ({
  getSolanaConnection: () => ({
    getSignatureStatuses: mockGetSignatureStatuses,
    getParsedTransaction: mockGetParsedTransaction,
  }),
  getSolanaUsdcMint: () => 'So11111111111111111111111111111111111111112',
  getSolanaUsdcDecimals: () => 6,
}));

import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { verifySolanaDeposit } from './deposit-verifier.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const OWNER = Keypair.generate().publicKey.toBase58();
const DEPOSITOR = Keypair.generate().publicKey.toBase58();
const OTHER_DEPOSITOR = Keypair.generate().publicKey.toBase58();
/** Fee-payer tercero (gasless): firma y paga el fee, NO pone los fondos. */
const RELAYER = Keypair.generate().publicKey.toBase58();
const OTHER_MINT = Keypair.generate().publicKey.toBase58();

/** La ATA de depósito, derivada igual que en producción. */
const OUR_ATA = getAssociatedTokenAddressSync(
  new PublicKey(MINT),
  new PublicKey(OWNER),
).toBase58();
const DEPOSITOR_ATA = getAssociatedTokenAddressSync(
  new PublicKey(MINT),
  new PublicKey(DEPOSITOR),
).toBase58();
/** Otra cuenta de token del MISMO owner y MISMO mint — el caso que caza M8. */
const OWNER_SECOND_ACCOUNT = Keypair.generate().publicKey.toBase58();
/** Una ATA que NO es la nuestra (otro owner). */
const FOREIGN_ATA = getAssociatedTokenAddressSync(
  new PublicKey(MINT),
  new PublicKey(OTHER_DEPOSITOR),
).toBase58();

const SIGNATURE = 'SiGnAtUrEfixture315';

interface Bal {
  accountIndex: number;
  mint: string;
  owner: string;
  amount: string;
}

const uiAmount = (amount: string) => ({
  amount,
  decimals: 6,
  uiAmount: Number(amount) / 1e6,
  uiAmountString: String(Number(amount) / 1e6),
});

const toBalances = (bs: Bal[]) =>
  bs.map((b) => ({
    accountIndex: b.accountIndex,
    mint: b.mint,
    owner: b.owner,
    uiTokenAmount: uiAmount(b.amount),
  }));

/**
 * Una tx parseada con la forma REAL: `accountKeys` como `ParsedMessageAccount[]`
 * (`{pubkey: PublicKey, signer, writable}`), en el orden en que los índices los
 * referencian. `keys[0]` es el fee-payer/firmante.
 */
function parsedTx(opts: {
  keys: string[];
  pre: Bal[];
  post: Bal[];
  err?: unknown;
}) {
  return {
    meta: {
      err: opts.err ?? null,
      preTokenBalances: toBalances(opts.pre),
      postTokenBalances: toBalances(opts.post),
    },
    transaction: {
      message: {
        accountKeys: opts.keys.map((k, i) => ({
          pubkey: new PublicKey(k),
          signer: i === 0,
          writable: true,
        })),
      },
    },
  };
}

const finalizedStatus = () => ({
  value: [
    {
      slot: 1,
      confirmations: null,
      err: null,
      confirmationStatus: 'finalized',
    },
  ],
});

/**
 * El happy path: el depositante manda `amount` (atómico) a NUESTRA ATA.
 * `keys[0]` es el propio depositante (paga su fee, AC-12).
 */
function happyTx(amount: string) {
  return parsedTx({
    keys: [DEPOSITOR, DEPOSITOR_ATA, OUR_ATA],
    pre: [
      { accountIndex: 1, mint: MINT, owner: DEPOSITOR, amount: '10000000' },
      { accountIndex: 2, mint: MINT, owner: OWNER, amount: '0' },
    ],
    post: [
      {
        accountIndex: 1,
        mint: MINT,
        owner: DEPOSITOR,
        amount: String(10000000n - BigInt(amount)),
      },
      { accountIndex: 2, mint: MINT, owner: OWNER, amount },
    ],
  });
}

const ENV_KEYS = [
  'A2A_DEPOSIT_SOLANA_OWNER',
  'A2A_SOLANA_DEPOSIT_ENABLED',
  'SOLANA_USDC_MINT_DEVNET',
] as const;

describe('WKH-315 · verifySolanaDeposit', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
    process.env.A2A_DEPOSIT_SOLANA_OWNER = OWNER;
    process.env.A2A_SOLANA_DEPOSIT_ENABLED = 'true';
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // ── Andamiaje: el escenario feliz funciona ────────────────────────────────
  it('happy path: acredita el monto DE LA CADENA con el depositante correcto', async () => {
    mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
    mockGetParsedTransaction.mockResolvedValue(happyTx('5000000'));

    const res = await verifySolanaDeposit({ signature: SIGNATURE });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.amountAtomic).toBe(5000000n);
    expect(res.amountUsd).toBe('5');
    expect(res.depositor).toBe(DEPOSITOR);
    expect(res.ata).toBe(OUR_ATA);
    expect(res.mint).toBe(MINT);
    expect(res.signature).toBe(SIGNATURE);
  });

  // ── AC-2 / M1 / M2: la finalidad ─────────────────────────────────────────
  describe('AC-2: finalidad — se LEE, no se hereda (M1, M2)', () => {
    it("T-315-03: confirmationStatus 'confirmed' ⇒ DEPOSIT_NOT_FINALIZED, sin acreditar", async () => {
      mockGetSignatureStatuses.mockResolvedValue({
        value: [
          {
            slot: 1,
            confirmations: 3,
            err: null,
            confirmationStatus: 'confirmed',
          },
        ],
      });

      const res = await verifySolanaDeposit({ signature: SIGNATURE });

      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toBe('DEPOSIT_NOT_FINALIZED');
      // ⚠️ Y NO se llegó a leer los términos: sin finalidad no hay nada que validar.
      expect(mockGetParsedTransaction).not.toHaveBeenCalled();
    });

    it("T-315-03: 'processed' ⇒ DEPOSIT_NOT_FINALIZED (negativa MEDIDA, reintentable)", async () => {
      mockGetSignatureStatuses.mockResolvedValue({
        value: [
          {
            slot: 1,
            confirmations: 0,
            err: null,
            confirmationStatus: 'processed',
          },
        ],
      });
      const res = await verifySolanaDeposit({ signature: SIGNATURE });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toBe('DEPOSIT_NOT_FINALIZED');
    });

    it('T-315-07 (M2): confirmationStatus AUSENTE ⇒ DEPOSIT_VERIFICATION_UNKNOWN, NUNCA "todavía no" ni finalized', async () => {
      // ⚠️ EL MUTANTE M2. El campo es OPCIONAL en el tipo del SDK, así que su
      // ausencia es un caso real. Leerla como 'finalized' acreditaría sin garantía;
      // leerla como 'not_finalized' AFIRMARIA una medición que el nodo no dio.
      mockGetSignatureStatuses.mockResolvedValue({
        value: [{ slot: 1, confirmations: null, err: null }],
      });

      const res = await verifySolanaDeposit({ signature: SIGNATURE });

      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toBe('DEPOSIT_VERIFICATION_UNKNOWN');
      expect(res.reason).not.toBe('DEPOSIT_NOT_FINALIZED');
      expect(mockGetParsedTransaction).not.toHaveBeenCalled();
    });

    it('un confirmationStatus desconocido ⇒ unknown (no se adivina)', async () => {
      mockGetSignatureStatuses.mockResolvedValue({
        value: [
          {
            slot: 1,
            confirmations: null,
            err: null,
            confirmationStatus: 'rooted',
          },
        ],
      });
      const res = await verifySolanaDeposit({ signature: SIGNATURE });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toBe('DEPOSIT_VERIFICATION_UNKNOWN');
    });

    it("T-315-03b (M1, CD-9): getParsedTransaction se invoca con commitment 'finalized' — ASSERT SOBRE EL ARG CAPTURADO", async () => {
      // ⚠️ SIN ESTE TEST, `DEPOSIT_COMMITMENT` podría ser 'confirmed' o
      // `getSolanaCommitment()` (env-driven, default 'confirmed') y TODOS los demás
      // tests de este archivo seguirían verdes. La garantía de finalidad de los
      // TERMINOS no tiene ningún otro observable.
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(happyTx('5000000'));

      await verifySolanaDeposit({ signature: SIGNATURE });

      expect(mockGetParsedTransaction).toHaveBeenCalledTimes(1);
      const [sig, opts] = mockGetParsedTransaction.mock.calls[0] as [
        string,
        { commitment: string; maxSupportedTransactionVersion: number },
      ];
      expect(sig).toBe(SIGNATURE);
      expect(opts.commitment).toBe('finalized');
      expect(opts.maxSupportedTransactionVersion).toBe(0);
    });

    it('T-315-03b: getSignatureStatuses se invoca con searchTransactionHistory:true (CD-9)', async () => {
      // Sin `searchTransactionHistory`, un `null` no distingue "no existe" de "no
      // está en mi caché reciente" y `absent` dejaría de ser una prueba de ausencia.
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(happyTx('5000000'));

      await verifySolanaDeposit({ signature: SIGNATURE });

      expect(mockGetSignatureStatuses).toHaveBeenCalledWith([SIGNATURE], {
        searchTransactionHistory: true,
      });
    });
  });

  // ── AC-6 / CD-14 / M3 / M4: los tres valores ─────────────────────────────
  describe('AC-6: "no pude preguntar" NUNCA es una negativa (CD-14, M3, M4)', () => {
    it('T-315-07 (M3): getSignatureStatuses TIRA ⇒ unknown, NUNCA absent', async () => {
      // ⚠️ EL MUTANTE M3. Un throw de red leído como `absent` le dice al depositante
      // "tu depósito no existe" cuando lo único cierto es que no pudimos preguntar.
      // Es plata real declarada inexistente por un timeout.
      mockGetSignatureStatuses.mockRejectedValue(new Error('ETIMEDOUT'));

      const res = await verifySolanaDeposit({ signature: SIGNATURE });

      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toBe('DEPOSIT_VERIFICATION_UNKNOWN');
      expect(res.reason).not.toBe('TX_ABSENT');
      expect(res.detail).toContain('ETIMEDOUT');
    });

    it('T-315-07 (M3): un array de status ausente o vacío ⇒ unknown, NUNCA absent', async () => {
      for (const bad of [null, {}, { value: null }, { value: [] }]) {
        mockGetSignatureStatuses.mockResolvedValue(bad);
        const res = await verifySolanaDeposit({ signature: SIGNATURE });
        expect(res.ok, JSON.stringify(bad)).toBe(false);
        if (res.ok) throw new Error('unreachable');
        expect(res.reason, JSON.stringify(bad)).toBe(
          'DEPOSIT_VERIFICATION_UNKNOWN',
        );
      }
    });

    it('status null DESPUES de haber buscado el histórico ⇒ TX_ABSENT (la única negativa admitida)', async () => {
      mockGetSignatureStatuses.mockResolvedValue({ value: [null] });
      const res = await verifySolanaDeposit({ signature: SIGNATURE });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toBe('TX_ABSENT');
    });

    it('status.err ⇒ TX_FAILED (aterrizó y falló: nada se movió, la firma es terminal)', async () => {
      mockGetSignatureStatuses.mockResolvedValue({
        value: [
          {
            slot: 1,
            confirmations: null,
            err: { InstructionError: [0, 'Custom'] },
            confirmationStatus: 'finalized',
          },
        ],
      });
      const res = await verifySolanaDeposit({ signature: SIGNATURE });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toBe('TX_FAILED');
      expect(mockGetParsedTransaction).not.toHaveBeenCalled();
    });

    it('T-315-07b (M4): status finalized pero SIN meta ⇒ unknown, NUNCA RECIPIENT_MISMATCH', async () => {
      // ⚠️ EL MUTANTE M4, y es el error más sutil del archivo. "El status dice que
      // está pero este nodo no la tiene parseada" ≠ "los términos no coinciden".
      // Devolver un mismatch acá afirmaría en un log que la plata fue a otro lado
      // —falso— y le negaría el crédito a un depósito legítimo por una causa
      // transitoria. Es la lección literal de `payment.ts`.
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      for (const bad of [null, {}, { meta: null }]) {
        mockGetParsedTransaction.mockResolvedValue(bad);
        const res = await verifySolanaDeposit({ signature: SIGNATURE });
        expect(res.ok, JSON.stringify(bad)).toBe(false);
        if (res.ok) throw new Error('unreachable');
        expect(res.reason, JSON.stringify(bad)).toBe(
          'DEPOSIT_VERIFICATION_UNKNOWN',
        );
        expect(res.reason).not.toBe('RECIPIENT_MISMATCH');
        expect(res.reason).not.toBe('MINT_MISMATCH');
      }
    });

    it('getParsedTransaction TIRA ⇒ unknown', async () => {
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockRejectedValue(new Error('ECONNRESET'));
      const res = await verifySolanaDeposit({ signature: SIGNATURE });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toBe('DEPOSIT_VERIFICATION_UNKNOWN');
      expect(res.detail).toContain('ECONNRESET');
    });

    it('meta.err ⇒ TX_FAILED', async () => {
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(
        parsedTx({ keys: [DEPOSITOR], pre: [], post: [], err: { X: 1 } }),
      );
      const res = await verifySolanaDeposit({ signature: SIGNATURE });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toBe('TX_FAILED');
    });

    it('verifySolanaDeposit NUNCA lanza, ni con basura total del RPC', async () => {
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue({
        meta: {
          err: null,
          preTokenBalances: undefined,
          postTokenBalances: undefined,
        },
        transaction: { message: { accountKeys: undefined } },
      });
      await expect(
        verifySolanaDeposit({ signature: SIGNATURE }),
      ).resolves.toBeDefined();
    });
  });

  // ── AC-4 / AC-5 / M8: los términos, distinguibles ────────────────────────
  describe('AC-4 / AC-5: MINT_MISMATCH y RECIPIENT_MISMATCH son DISTINGUIBLES', () => {
    it('T-315-06: otro mint a nuestra cuenta ⇒ MINT_MISMATCH (no RECIPIENT_MISMATCH)', async () => {
      // El caller mandó el token equivocado. Distinto de mandar el correcto al
      // lugar equivocado: dos errores, dos remediaciones.
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(
        parsedTx({
          keys: [DEPOSITOR, OUR_ATA],
          pre: [
            { accountIndex: 1, mint: OTHER_MINT, owner: OWNER, amount: '0' },
          ],
          post: [
            {
              accountIndex: 1,
              mint: OTHER_MINT,
              owner: OWNER,
              amount: '5000000',
            },
          ],
        }),
      );

      const res = await verifySolanaDeposit({ signature: SIGNATURE });

      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toBe('MINT_MISMATCH');
      expect(res.reason).not.toBe('RECIPIENT_MISMATCH');
    });

    it('T-315-05: el mint correcto a OTRA ATA ⇒ RECIPIENT_MISMATCH, sin crédito y SIN reembolso', async () => {
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(
        parsedTx({
          keys: [DEPOSITOR, DEPOSITOR_ATA, FOREIGN_ATA],
          pre: [
            {
              accountIndex: 1,
              mint: MINT,
              owner: DEPOSITOR,
              amount: '10000000',
            },
            {
              accountIndex: 2,
              mint: MINT,
              owner: OTHER_DEPOSITOR,
              amount: '0',
            },
          ],
          post: [
            {
              accountIndex: 1,
              mint: MINT,
              owner: DEPOSITOR,
              amount: '5000000',
            },
            {
              accountIndex: 2,
              mint: MINT,
              owner: OTHER_DEPOSITOR,
              amount: '5000000',
            },
          ],
        }),
      );

      const res = await verifySolanaDeposit({ signature: SIGNATURE });

      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toBe('RECIPIENT_MISMATCH');
    });

    it('T-315-05 (M8): el match es TRIPLE — una cuenta del MISMO owner y MISMO mint que NO es la ATA no cuenta', async () => {
      // ⚠️ EL MUTANTE M8, Y EL FIXTURE ESTA ORDENADO PARA CAZARLO. La entrada que NO
      // es la ATA va PRIMERA en las listas, así que un `find` por `(owner, mint)`
      // —como el `checkTerms` de `payment.ts`— tomaría ESA y mediría 999 USDC en vez
      // de los 5 que realmente llegaron a la cuenta publicada. Sub-medir o
      // sobre-medir el delta es acreditar un monto que no ocurrió.
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(
        parsedTx({
          keys: [DEPOSITOR, DEPOSITOR_ATA, OUR_ATA, OWNER_SECOND_ACCOUNT],
          pre: [
            { accountIndex: 3, mint: MINT, owner: OWNER, amount: '0' },
            { accountIndex: 2, mint: MINT, owner: OWNER, amount: '0' },
            {
              accountIndex: 1,
              mint: MINT,
              owner: DEPOSITOR,
              amount: '10000000',
            },
          ],
          post: [
            { accountIndex: 3, mint: MINT, owner: OWNER, amount: '999000000' },
            { accountIndex: 2, mint: MINT, owner: OWNER, amount: '5000000' },
            {
              accountIndex: 1,
              mint: MINT,
              owner: DEPOSITOR,
              amount: '5000000',
            },
          ],
        }),
      );

      const res = await verifySolanaDeposit({ signature: SIGNATURE });

      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('unreachable');
      // 5 USDC (la ATA), NO 999 (la otra cuenta del mismo owner).
      expect(res.amountUsd).toBe('5');
      expect(res.amountAtomic).toBe(5000000n);
      expect(res.ata).toBe(OUR_ATA);
    });

    it('M8: el mint correcto y el owner correcto pero una DIRECCION que no es la ATA ⇒ RECIPIENT_MISMATCH', async () => {
      // Sin el 3er término del match (la dirección), esto pasaría como válido.
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(
        parsedTx({
          keys: [DEPOSITOR, DEPOSITOR_ATA, OWNER_SECOND_ACCOUNT],
          pre: [
            {
              accountIndex: 1,
              mint: MINT,
              owner: DEPOSITOR,
              amount: '10000000',
            },
            { accountIndex: 2, mint: MINT, owner: OWNER, amount: '0' },
          ],
          post: [
            {
              accountIndex: 1,
              mint: MINT,
              owner: DEPOSITOR,
              amount: '5000000',
            },
            { accountIndex: 2, mint: MINT, owner: OWNER, amount: '5000000' },
          ],
        }),
      );

      const res = await verifySolanaDeposit({ signature: SIGNATURE });

      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toBe('RECIPIENT_MISMATCH');
    });

    it('M8: la ATA correcta pero con OTRO owner declarado ⇒ RECIPIENT_MISMATCH', async () => {
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(
        parsedTx({
          keys: [DEPOSITOR, DEPOSITOR_ATA, OUR_ATA],
          pre: [
            {
              accountIndex: 1,
              mint: MINT,
              owner: DEPOSITOR,
              amount: '10000000',
            },
            {
              accountIndex: 2,
              mint: MINT,
              owner: OTHER_DEPOSITOR,
              amount: '0',
            },
          ],
          post: [
            {
              accountIndex: 1,
              mint: MINT,
              owner: DEPOSITOR,
              amount: '5000000',
            },
            {
              accountIndex: 2,
              mint: MINT,
              owner: OTHER_DEPOSITOR,
              amount: '5000000',
            },
          ],
        }),
      );
      const res = await verifySolanaDeposit({ signature: SIGNATURE });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toBe('RECIPIENT_MISMATCH');
    });

    it('un delta de 0 sobre nuestra ATA ⇒ RECIPIENT_MISMATCH (nada llegó)', async () => {
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(
        parsedTx({
          keys: [DEPOSITOR, OUR_ATA],
          pre: [{ accountIndex: 1, mint: MINT, owner: OWNER, amount: '7' }],
          post: [{ accountIndex: 1, mint: MINT, owner: OWNER, amount: '7' }],
        }),
      );
      const res = await verifySolanaDeposit({ signature: SIGNATURE });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toBe('RECIPIENT_MISMATCH');
    });
  });

  // ── AC-7 / AC-15 / M9 / M10: el depositante ──────────────────────────────
  describe('AC-15: el depositante es el owner que BAJA, no el fee-payer (M9, M10)', () => {
    it('T-315-16b (M9): con fee-payer TERCERO (gasless), el depositante es el que BAJA', async () => {
      // ⚠️ EL MUTANTE M9. En Solana el fee-payer puede ser un relayer que no puso un
      // centavo. Atribuirle el depósito haría que el gate rechace al dueño real de
      // los fondos — y con el UNIQUE de por medio, su firma queda quemada.
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(
        parsedTx({
          // keys[0] = RELAYER: firma y paga el fee, y NO tiene token balances.
          keys: [RELAYER, DEPOSITOR_ATA, OUR_ATA],
          pre: [
            {
              accountIndex: 1,
              mint: MINT,
              owner: DEPOSITOR,
              amount: '10000000',
            },
            { accountIndex: 2, mint: MINT, owner: OWNER, amount: '0' },
          ],
          post: [
            {
              accountIndex: 1,
              mint: MINT,
              owner: DEPOSITOR,
              amount: '5000000',
            },
            { accountIndex: 2, mint: MINT, owner: OWNER, amount: '5000000' },
          ],
        }),
      );

      const res = await verifySolanaDeposit({ signature: SIGNATURE });

      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('unreachable');
      expect(res.depositor).toBe(DEPOSITOR);
      expect(res.depositor).not.toBe(RELAYER);
    });

    it('T-315-16 (M10): DOS owners de origen ⇒ DEPOSITOR_AMBIGUOUS, no "tomo el primero"', async () => {
      // ⚠️ EL MUTANTE M10. Adivinar cuál de dos es el depositante es exactamente
      // donde se pierde el gate: elegir mal atribuye el depósito a quien no lo hizo.
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(
        parsedTx({
          keys: [DEPOSITOR, DEPOSITOR_ATA, OUR_ATA, FOREIGN_ATA],
          pre: [
            {
              accountIndex: 1,
              mint: MINT,
              owner: DEPOSITOR,
              amount: '10000000',
            },
            {
              accountIndex: 3,
              mint: MINT,
              owner: OTHER_DEPOSITOR,
              amount: '10000000',
            },
            { accountIndex: 2, mint: MINT, owner: OWNER, amount: '0' },
          ],
          post: [
            {
              accountIndex: 1,
              mint: MINT,
              owner: DEPOSITOR,
              amount: '7000000',
            },
            {
              accountIndex: 3,
              mint: MINT,
              owner: OTHER_DEPOSITOR,
              amount: '8000000',
            },
            { accountIndex: 2, mint: MINT, owner: OWNER, amount: '5000000' },
          ],
        }),
      );

      const res = await verifySolanaDeposit({ signature: SIGNATURE });

      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toBe('DEPOSITOR_AMBIGUOUS');
    });

    it('CERO owners de origen ⇒ DEPOSITOR_AMBIGUOUS, nunca un undefined que se cuele', async () => {
      // Imposible si el delta de destino es > 0, pero el compilador no lo sabe y un
      // `!` sería una aserción sin chequeo.
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(
        parsedTx({
          keys: [DEPOSITOR, OUR_ATA],
          pre: [{ accountIndex: 1, mint: MINT, owner: OWNER, amount: '0' }],
          post: [
            { accountIndex: 1, mint: MINT, owner: OWNER, amount: '5000000' },
          ],
        }),
      );
      const res = await verifySolanaDeposit({ signature: SIGNATURE });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toBe('DEPOSITOR_AMBIGUOUS');
    });

    it('una cuenta de origen que se CIERRA en la misma tx sigue contando como origen', async () => {
      // El `owner` está poblado en `preTokenBalances` aun si la cuenta desaparece de
      // `post`. Sin leer de `pre`, ese depositante quedaría invisible.
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(
        parsedTx({
          keys: [DEPOSITOR, DEPOSITOR_ATA, OUR_ATA],
          pre: [
            {
              accountIndex: 1,
              mint: MINT,
              owner: DEPOSITOR,
              amount: '5000000',
            },
            { accountIndex: 2, mint: MINT, owner: OWNER, amount: '0' },
          ],
          // La cuenta 1 no aparece en post: se cerró tras vaciarse.
          post: [
            { accountIndex: 2, mint: MINT, owner: OWNER, amount: '5000000' },
          ],
        }),
      );
      const res = await verifySolanaDeposit({ signature: SIGNATURE });
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('unreachable');
      expect(res.depositor).toBe(DEPOSITOR);
    });
  });

  // ── AC-1 / M16: el monto ─────────────────────────────────────────────────
  describe('AC-1: el monto acreditado es SIEMPRE el de la cadena (M16)', () => {
    it('T-315-02 (M16): el caller declara 10 y la cadena dice 5 ⇒ AMOUNT_MISMATCH', async () => {
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(happyTx('5000000'));

      const res = await verifySolanaDeposit({
        signature: SIGNATURE,
        expectedAmountUsd: '10',
      });

      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toBe('AMOUNT_MISMATCH');
    });

    it('T-315-02: el monto declarado que COINCIDE deja pasar, y el acreditado es el de la cadena', async () => {
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(happyTx('5000000'));

      const res = await verifySolanaDeposit({
        signature: SIGNATURE,
        expectedAmountUsd: '5',
      });

      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('unreachable');
      expect(res.amountUsd).toBe('5');
    });

    it('AMOUNT_MISMATCH por 1 unidad atómica — comparación BigInt vs BigInt, sin pérdida de precisión', async () => {
      // ⚠️ PROHIBIDO `usdToAtomicUnits` / `Number()`: un float64 colapsa
      // 1.000000000000000001 a 1 y esta diferencia se volvería invisible.
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(happyTx('5000001'));

      const res = await verifySolanaDeposit({
        signature: SIGNATURE,
        expectedAmountUsd: '5',
      });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toBe('AMOUNT_MISMATCH');
    });

    it('un monto declarado NO PARSEABLE ⇒ AMOUNT_MISMATCH (nunca un throw)', async () => {
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(happyTx('5000000'));
      for (const bad of ['abc', '', '1.2.3', '-1']) {
        const res = await verifySolanaDeposit({
          signature: SIGNATURE,
          expectedAmountUsd: bad,
        });
        expect(res.ok, bad).toBe(false);
        if (res.ok) throw new Error('unreachable');
        expect(res.reason, bad).toBe('AMOUNT_MISMATCH');
      }
    });

    it('T-315-10 (AC-9 diferido): un depósito de 0.000001 SI acredita — hoy no hay mínimo', async () => {
      // AC-9 quedó diferido: se testea la AUSENCIA del mínimo, para que si alguien
      // introduce uno más adelante sea una decisión visible y no un accidente.
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(happyTx('1'));

      const res = await verifySolanaDeposit({ signature: SIGNATURE });

      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('unreachable');
      expect(res.amountAtomic).toBe(1n);
      expect(res.amountUsd).toBe('0.000001');
    });
  });

  // ── AC-11 / T-315-18: el flag y el choke-point ───────────────────────────
  describe('AC-11: el flag es el choke-point y corta ANTES de la red', () => {
    it('T-315-18: con el flag OFF ⇒ DEPOSIT_ACCOUNT_NOT_CONFIGURED y CERO llamadas al RPC', async () => {
      process.env.A2A_SOLANA_DEPOSIT_ENABLED = 'false';

      const res = await verifySolanaDeposit({ signature: SIGNATURE });

      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toBe('DEPOSIT_ACCOUNT_NOT_CONFIGURED');
      // ⚠️ Cero red: el corte es antes de cualquier I/O.
      expect(mockGetSignatureStatuses).not.toHaveBeenCalled();
      expect(mockGetParsedTransaction).not.toHaveBeenCalled();
    });

    it('sin `A2A_DEPOSIT_SOLANA_OWNER` ⇒ DEPOSIT_ACCOUNT_NOT_CONFIGURED, cero red', async () => {
      delete process.env.A2A_DEPOSIT_SOLANA_OWNER;
      const res = await verifySolanaDeposit({ signature: SIGNATURE });
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toBe('DEPOSIT_ACCOUNT_NOT_CONFIGURED');
      expect(mockGetSignatureStatuses).not.toHaveBeenCalled();
    });
  });

  // ── CD-14: la FORMA prohibida no está en el archivo ──────────────────────
  it('CD-14 (estático): ningún `if (err) return <veredicto definitivo>` en el verificador', async () => {
    // La regla se grepea como FORMA, no se confía a la revisión: todo camino de
    // error tiene que terminar en DEPOSIT_VERIFICATION_UNKNOWN, y el archivo no
    // puede contener un `catch` que devuelva TX_ABSENT / MINT_MISMATCH / etc.
    const { readFileSync } = await import('node:fs');
    const { dirname, resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), 'deposit-verifier.ts'),
      'utf8',
    );
    const code = src
      .split('\n')
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
      })
      .join('\n');

    // Cada bloque `catch { ... }` de este archivo: o no retorna nada (ignora la
    // entrada), o retorna UNKNOWN. Nunca una negativa medida.
    const catchBlocks = [
      ...code.matchAll(/catch\s*(?:\([^)]*\))?\s*\{([\s\S]*?)\n {2}\}/g),
    ];
    for (const [, body] of catchBlocks) {
      const b = body ?? '';
      for (const forbidden of [
        'TX_ABSENT',
        'TX_FAILED',
        'MINT_MISMATCH',
        'RECIPIENT_MISMATCH',
        'DEPOSIT_NOT_FINALIZED',
        'DEPOSITOR_AMBIGUOUS',
      ]) {
        expect(b, `catch devuelve ${forbidden}`).not.toContain(forbidden);
      }
    }
    // Andamiaje: si el regex no encontró ningún catch, el loop de arriba no probó
    // nada. El archivo TIENE catches.
    expect(catchBlocks.length).toBeGreaterThan(0);

    // `DEPOSIT_COMMITMENT` es un literal, no una llamada a la env-driven.
    expect(code).toMatch(/const DEPOSIT_COMMITMENT = 'finalized' as const;/);
    expect(code).not.toMatch(/getSolanaCommitment/);
  });
});
