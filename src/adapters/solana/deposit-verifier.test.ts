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
/**
 * El mint que el doble de `chain.js` reporta como el USDC configurado.
 *
 * ⚠️ DOS COSAS QUE PARECEN COSMETICAS Y NO LO SON (fix-pack CR · MNR-7).
 *
 * 1. **`vi.hoisted`, para que el fixture y el mock sean EL MISMO VALOR.** Antes el
 *    literal estaba escrito dos veces —una en `const MINT` y otra adentro de
 *    `getSolanaUsdcMint`— sin ningún assert que los atara. Dos copias que tienen que
 *    coincidir y nadie verifica que coincidan: cambiar una sola dejaba TODOS los tests
 *    de términos pasando por la razón equivocada (`MINT_MISMATCH` en todos lados).
 *    `vi.hoisted` es la forma admitida de compartir un valor con una factory hoisteada.
 * 2. **Ya no es `So111…112`.** Ese es el mint canónico de **wSOL**, usado como fixture
 *    de USDC: un valor que MIENTE sobre qué representa, y el mismo que produjo el falso
 *    rojo de `T-315-12c` (su tirada de 40 unos matcheaba el needle de un guard de
 *    secretos). Ahora es el mint de USDC devnet, que es lo que el fixture dice ser.
 */
const MINT = vi.hoisted(() => '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');
const mockGetSignatureStatuses = vi.hoisted(() => vi.fn());
const mockGetParsedTransaction = vi.hoisted(() => vi.fn());

vi.mock('./chain.js', () => ({
  getSolanaConnection: () => ({
    getSignatureStatuses: mockGetSignatureStatuses,
    getParsedTransaction: mockGetParsedTransaction,
  }),
  getSolanaUsdcMint: () => MINT,
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
  /**
   * OPCIONAL a propósito: `owner` es opcional en el tipo de `@solana/web3.js`, así que
   * un fixture que lo exija no puede expresar el caso que el RPC produce de verdad
   * (fix-pack AR MNR-2).
   */
  owner?: string;
  amount: string;
}

const uiAmount = (amount: string) => ({
  amount,
  decimals: 6,
  uiAmount: Number(amount) / 1e6,
  uiAmountString: String(Number(amount) / 1e6),
});

const toBalances = (bs: Bal[]) =>
  bs.map((b) => {
    const base = {
      accountIndex: b.accountIndex,
      mint: b.mint,
      uiTokenAmount: uiAmount(b.amount),
    };
    // El campo se OMITE (no se manda `owner: undefined`): así el fixture tiene la
    // forma exacta de una respuesta del RPC que no lo incluye.
    return b.owner === undefined ? base : { ...base, owner: b.owner };
  });

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
  'A2A_DEPOSIT_OWNER_SOLANA',
  'A2A_DEPOSIT_ENABLED_SOLANA',
  'SOLANA_USDC_MINT_DEVNET',
] as const;

describe('WKH-315 · verifySolanaDeposit', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
    process.env.A2A_DEPOSIT_OWNER_SOLANA = OWNER;
    process.env.A2A_DEPOSIT_ENABLED_SOLANA = 'true';
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

  // ── FIX-PACK AR · BLQ-MED-1: un `amount` ILEGIBLE es indeterminación ─────
  //
  // Ninguno de los 33 casos originales de este archivo tenía un `amount` que
  // `BigInt()` rechazara, y por eso el guard podía fallar ABIERTO sin que nada se
  // pusiera rojo.
  describe('BLQ-MED-1: un `amount` que no parsea NUNCA se ignora en silencio', () => {
    /**
     * Tesorería con 1000 USDC que recibe 1 USDC, con el `amount` del lado `pre`
     * ILEGIBLE. Es el escenario exacto del exploit.
     */
    const treasuryTx = (preAmount: string, postAmount: string) =>
      parsedTx({
        keys: [DEPOSITOR, DEPOSITOR_ATA, OUR_ATA],
        pre: [
          { accountIndex: 1, mint: MINT, owner: DEPOSITOR, amount: '10000000' },
          { accountIndex: 2, mint: MINT, owner: OWNER, amount: preAmount },
        ],
        post: [
          { accountIndex: 1, mint: MINT, owner: DEPOSITOR, amount: '9000000' },
          { accountIndex: 2, mint: MINT, owner: OWNER, amount: postAmount },
        ],
      });

    it('BLQ-MED-1: `amount` ilegible del lado PRE ⇒ UNKNOWN, y NUNCA acredita el saldo entero de la tesorería', async () => {
      // ⚠️ EL MUTANTE. Con el `continue` original, `preOurs` colapsaba a 0n y el
      // delta pasaba a ser `postOurs` COMPLETO: 1001 USDC acreditados por un depósito
      // de 1, o sea el saldo de tesorería regalado por un string mal formado.
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      // ⚠️ LOS SEIS IMPORTAN, Y TRES NO LANZAN. `BigInt('')` y `BigInt('   ')` dan
      // `0n` y `BigInt('0x10')` da `16n`: un `try/catch` alrededor de `BigInt` NO los
      // ve. Sin ellos en esta lista, el fix quedaría cubierto sólo para las formas que
      // sí tiran.
      // Las tres últimas las agregó el re-AR: el regex las corta y el `try` no las
      // veía — `BigInt(' 42 ')` y `BigInt('\n42\n')` dan `42n` (ignoran el espaciado)
      // y `BigInt('+5')` da `5n`. Un `amount` con espacios o signo no es un monto que
      // este RPC produzca: es un dato de otra procedencia.
      for (const unreadable of [
        '1.0',
        '1e9',
        '',
        '0x10',
        'abc',
        '   ',
        ' 42 ',
        '\n42\n',
        '+5',
      ]) {
        mockGetParsedTransaction.mockResolvedValue(
          treasuryTx(unreadable, '1001000000'),
        );

        const res = await verifySolanaDeposit({ signature: SIGNATURE });

        expect(res.ok, unreadable).toBe(false);
        if (res.ok) {
          throw new Error(
            `acreditó ${res.amountUsd} USDC con un pre-balance ilegible (${unreadable})`,
          );
        }
        expect(res.reason, unreadable).toBe('DEPOSIT_VERIFICATION_UNKNOWN');
        // Y explícitamente NO una negativa medida: el 400 diría "tu plata fue a otro
        // lado", que es una afirmación sobre la cadena que este dato no sostiene.
        expect(res.reason, unreadable).not.toBe('RECIPIENT_MISMATCH');
        // ⚠️ CUAL GUARD HABLO, NO SOLO QUE ALGUIEN HABLO. Sin esto, el mutante
        // sobrevive: con el `continue` restaurado el delta se mide mal (1001 USDC) y
        // el veredicto UNKNOWN lo termina dando el guard de ATRIBUCION del depositante,
        // que mira las mismas entradas. El test quedaría verde afirmando una propiedad
        // que el código ya no tiene — la vacuidad de siempre, con otro disfraz.
        //
        // ⚠️⚠️ Y SON DOS NEEDLES, NO UNO, PORQUE UN NEEDLE ENVEJECE. Con sólo
        // `'deposit ATA'` este test volvió a sobrevivir en la iteración 2: el
        // invariante de conservación —que es NUEVO— también dice "deposit ATA" en su
        // detalle, así que el needle dejó de identificar a un guard sin que nadie lo
        // tocara. La conjunción es lo único que hoy sólo puede decir ESTE guard: los
        // de atribución dicen "unreadable" pero "for the configured mint", y el de
        // conservación dice "deposit ATA" pero no "unreadable".
        expect(res.detail, unreadable).toContain('deposit ATA');
        expect(res.detail, unreadable).toContain(
          'unreadable uiTokenAmount.amount',
        );
      }
    });

    it('BLQ-MED-1: `amount` ilegible del lado POST ⇒ UNKNOWN (sub-medir tampoco es medir)', async () => {
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(
        treasuryTx('1000000000', '1e9'),
      );

      const res = await verifySolanaDeposit({ signature: SIGNATURE });

      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toBe('DEPOSIT_VERIFICATION_UNKNOWN');
      expect(res.reason).not.toBe('RECIPIENT_MISMATCH');
    });

    it('BLQ-MED-1: el andamiaje — el MISMO fixture con los dos `amount` legibles SI acredita 1 USDC', async () => {
      // Sin esto, los dos tests de arriba podrían estar verdes por cualquier otra
      // razón (una env, un fixture roto) y no por el `amount` ilegible.
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(
        treasuryTx('1000000000', '1001000000'),
      );

      const res = await verifySolanaDeposit({ signature: SIGNATURE });

      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('unreachable');
      expect(res.amountUsd).toBe('1');
      expect(res.amountAtomic).toBe(1000000n);
    });

    it('BLQ-MED-1: un `amount` ilegible en una entrada de NUESTRO mint que no es la ATA también da UNKNOWN', async () => {
      // La atribución del depositante lee TODAS las entradas del mint, no sólo la ATA.
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(
        parsedTx({
          keys: [DEPOSITOR, DEPOSITOR_ATA, OUR_ATA],
          pre: [
            { accountIndex: 1, mint: MINT, owner: DEPOSITOR, amount: '10.5' },
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
      expect(res.reason).toBe('DEPOSIT_VERIFICATION_UNKNOWN');
      expect(res.reason).not.toBe('DEPOSITOR_AMBIGUOUS');
    });
  });

  // ── FIX-PACK it2 · BLQ-MED-3: la indeterminación por AUSENCIA ────────────
  //
  // BLQ-MED-1 cerró la indeterminación del VALOR (un `amount` ilegible). Esta cierra
  // la de la PRESENCIA: una lista que no vino, o una FILA que falta dentro de una
  // lista que sí vino. El daño reproducido es el mismo —el saldo entero de la
  // tesorería acreditado— por una puerta que ninguna validación de campo podía ver.
  describe('BLQ-MED-3: una lista o una fila AUSENTE nunca se lee como un cero medido', () => {
    /** Una tx cruda, para poder OMITIR piezas que `parsedTx` siempre construye. */
    const rawTx = (
      meta: unknown,
      keys: string[] = [DEPOSITOR, DEPOSITOR_ATA, OUR_ATA],
    ) => ({
      meta,
      transaction: {
        message: {
          accountKeys: keys.map((k, i) => ({
            pubkey: new PublicKey(k),
            signer: i === 0,
            writable: true,
          })),
        },
      },
    });

    const bal = (accountIndex: number, owner: string, amount: string) => ({
      accountIndex,
      mint: MINT,
      owner,
      uiTokenAmount: uiAmount(amount),
    });

    it('BLQ-MED-3: `pre` NO lista nuestra ATA ⇒ UNKNOWN por conservación, y NUNCA acredita los 1001 USDC de tesorería', async () => {
      // ⚠️ EL CASO QUE MAS DUELE Y EL MENOS VISIBLE: las dos listas están presentes,
      // ningún campo es ilegible, y sin embargo el delta medido sobre UNA cuenta es
      // el saldo entero de la tesorería. Lo único que lo delata es cruzarlo contra lo
      // que los orígenes efectivamente pagaron.
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(
        rawTx({
          err: null,
          // La ATA de depósito (accountIndex 2) NO aparece acá, aunque ya tenía 1000.
          preTokenBalances: [bal(1, DEPOSITOR, '10000000')],
          postTokenBalances: [
            bal(1, DEPOSITOR, '9000000'),
            bal(2, OWNER, '1001000000'),
          ],
        }),
      );

      const res = await verifySolanaDeposit({ signature: SIGNATURE });

      expect(res.ok).toBe(false);
      if (res.ok) {
        throw new Error(
          `acreditó ${res.amountUsd} USDC (esperado: ningún crédito)`,
        );
      }
      expect(res.reason).toBe('DEPOSIT_VERIFICATION_UNKNOWN');
      // ⚠️ Y POR EL MOTIVO CORRECTO. Sin esto el test sobrevive a la mutación del
      // invariante: el veredicto lo daría cualquier otro guard y el nombre mentiría.
      expect(res.detail).toContain('conservation check failed');
    });

    it('BLQ-MED-3 (andamiaje): el MISMO escenario con la fila presente acredita 1 USDC, no 1001', async () => {
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(
        rawTx({
          err: null,
          preTokenBalances: [
            bal(1, DEPOSITOR, '10000000'),
            bal(2, OWNER, '1000000000'),
          ],
          postTokenBalances: [
            bal(1, DEPOSITOR, '9000000'),
            bal(2, OWNER, '1001000000'),
          ],
        }),
      );

      const res = await verifySolanaDeposit({ signature: SIGNATURE });

      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('unreachable');
      expect(res.amountUsd).toBe('1');
    });

    it('BLQ-MED-3: el invariante es `<=`, no `==` — una tx que además paga a otra cuenta del mint SI acredita', async () => {
      // El origen baja 8 (5 a nuestra ATA + 3 a un tercero). Exigir igualdad
      // rechazaría un depósito legítimo; el peligro es acreditar de MAS, no de menos.
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(
        rawTx(
          {
            err: null,
            preTokenBalances: [
              bal(1, DEPOSITOR, '10000000'),
              bal(2, OWNER, '0'),
              bal(3, OTHER_DEPOSITOR, '0'),
            ],
            postTokenBalances: [
              bal(1, DEPOSITOR, '2000000'),
              bal(2, OWNER, '5000000'),
              bal(3, OTHER_DEPOSITOR, '3000000'),
            ],
          },
          [DEPOSITOR, DEPOSITOR_ATA, OUR_ATA, FOREIGN_ATA],
        ),
      );

      const res = await verifySolanaDeposit({ signature: SIGNATURE });

      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('unreachable');
      expect(res.amountUsd).toBe('5');
    });

    it('BLQ-MED-3: `preTokenBalances` AUSENTE ⇒ UNKNOWN, NUNCA DEPOSITOR_AMBIGUOUS (400 sobre un campo que no vino)', async () => {
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(
        rawTx({ err: null, postTokenBalances: [bal(2, OWNER, '1001000000')] }),
      );

      const res = await verifySolanaDeposit({ signature: SIGNATURE });

      expect(res.ok).toBe(false);
      if (res.ok) {
        throw new Error(
          `acreditó ${res.amountUsd} USDC sin lista de saldos previos`,
        );
      }
      expect(res.reason).toBe('DEPOSIT_VERIFICATION_UNKNOWN');
      expect(res.reason).not.toBe('DEPOSITOR_AMBIGUOUS');
      expect(res.detail).toContain('no token balance list');
    });

    it('BLQ-MED-3: `postTokenBalances` AUSENTE ⇒ UNKNOWN, NUNCA RECIPIENT_MISMATCH', async () => {
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(
        rawTx({ err: null, preTokenBalances: [bal(2, OWNER, '1000000000')] }),
      );

      const res = await verifySolanaDeposit({ signature: SIGNATURE });

      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toBe('DEPOSIT_VERIFICATION_UNKNOWN');
      expect(res.reason).not.toBe('RECIPIENT_MISMATCH');
      expect(res.detail).toContain('no token balance list');
    });

    it('BLQ-MED-3: un delta NEGATIVO ⇒ UNKNOWN, no RECIPIENT_MISMATCH (una cuenta que recibe no puede perder saldo)', async () => {
      // Las dos listas están y son legibles, pero se contradicen. Un número imposible
      // dice "los datos están mal", no "tu plata fue a otro lado".
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(
        rawTx({
          err: null,
          preTokenBalances: [bal(2, OWNER, '1000000000')],
          postTokenBalances: [bal(2, OWNER, '999000000')],
        }),
      );

      const res = await verifySolanaDeposit({ signature: SIGNATURE });

      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toBe('DEPOSIT_VERIFICATION_UNKNOWN');
      expect(res.reason).not.toBe('RECIPIENT_MISMATCH');
      expect(res.detail).toContain('NEGATIVE');
    });

    it('MENOR-1: sin `transaction` o sin `accountKeys` NO LANZA — devuelve UNKNOWN (500 vs 503)', async () => {
      // ⚠️ La cabecera del módulo promete "NUNCA lanza" y era falso: la ruta no
      // envuelve la llamada, así que un `TypeError` salía como 500 y SIN el evento
      // durable que AC-6 exige. Una promesa de la cabecera se verifica o se corrige.
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      const meta = {
        err: null,
        preTokenBalances: [bal(2, OWNER, '0')],
        postTokenBalances: [bal(2, OWNER, '5000000')],
      };
      for (const broken of [
        { meta }, // sin `transaction`
        { meta, transaction: {} }, // sin `message`
        { meta, transaction: { message: {} } }, // sin `accountKeys`
        { meta, transaction: { message: { accountKeys: null } } },
      ]) {
        const label = JSON.stringify(broken.transaction ?? 'sin transaction');
        mockGetParsedTransaction.mockResolvedValue(broken);

        // `resolves` y no un try/catch: un throw acá pone el test rojo con el stack
        // del TypeError, que es exactamente el síntoma que se está cerrando.
        const res = await verifySolanaDeposit({ signature: SIGNATURE });

        expect(res.ok, label).toBe(false);
        if (res.ok) throw new Error('unreachable');
        expect(res.reason, label).toBe('DEPOSIT_VERIFICATION_UNKNOWN');
        expect(res.detail, label).toContain('no account key list');
      }
    });
  });

  // ── FIX-PACK AR · MNR-2: un `owner` AUSENTE no es "fue a otro lado" ──────
  describe('MNR-2: un `owner` que el RPC no mandó es un dato ausente, no una negativa', () => {
    it('MNR-2: nuestra ATA SIN `owner` en pre/post ⇒ acredita igual (mint + dirección ya la identifican)', async () => {
      // ⚠️ Antes salía `RECIPIENT_MISMATCH`: una afirmación de que la plata fue a otro
      // lado, hecha sobre un campo que el nodo no mandó. Y el depositante legítimo
      // quedaba bloqueado para siempre, porque el veredicto es determinista.
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
            { accountIndex: 2, mint: MINT, amount: '0' }, // sin `owner`
          ],
          post: [
            {
              accountIndex: 1,
              mint: MINT,
              owner: DEPOSITOR,
              amount: '5000000',
            },
            { accountIndex: 2, mint: MINT, amount: '5000000' }, // sin `owner`
          ],
        }),
      );

      const res = await verifySolanaDeposit({ signature: SIGNATURE });

      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('unreachable');
      expect(res.amountUsd).toBe('5');
      expect(res.ata).toBe(OUR_ATA);
      expect(res.depositor).toBe(DEPOSITOR);
    });

    it('MNR-2: el `owner` PRESENTE y distinto sigue descalificando (el control no se debilitó)', async () => {
      // El caso de arriba no puede haber abierto la puerta a "cualquier owner sirve".
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

    it('MNR-2: la cuenta de ORIGEN sin `owner` ⇒ UNKNOWN, no DEPOSITOR_AMBIGUOUS', async () => {
      // Bajó saldo, así que ES un origen — pero el nodo no dijo de quién. "No pude
      // preguntar" (503, reintentable) en vez de "hay más de un candidato" (400).
      mockGetSignatureStatuses.mockResolvedValue(finalizedStatus());
      mockGetParsedTransaction.mockResolvedValue(
        parsedTx({
          keys: [DEPOSITOR, DEPOSITOR_ATA, OUR_ATA],
          pre: [
            { accountIndex: 1, mint: MINT, amount: '10000000' }, // sin `owner`
            { accountIndex: 2, mint: MINT, owner: OWNER, amount: '0' },
          ],
          post: [
            { accountIndex: 1, mint: MINT, amount: '5000000' },
            { accountIndex: 2, mint: MINT, owner: OWNER, amount: '5000000' },
          ],
        }),
      );

      const res = await verifySolanaDeposit({ signature: SIGNATURE });

      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toBe('DEPOSIT_VERIFICATION_UNKNOWN');
      expect(res.reason).not.toBe('DEPOSITOR_AMBIGUOUS');
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
      process.env.A2A_DEPOSIT_ENABLED_SOLANA = 'false';

      const res = await verifySolanaDeposit({ signature: SIGNATURE });

      expect(res.ok).toBe(false);
      if (res.ok) throw new Error('unreachable');
      expect(res.reason).toBe('DEPOSIT_ACCOUNT_NOT_CONFIGURED');
      // ⚠️ Cero red: el corte es antes de cualquier I/O.
      expect(mockGetSignatureStatuses).not.toHaveBeenCalled();
      expect(mockGetParsedTransaction).not.toHaveBeenCalled();
    });

    it('sin `A2A_DEPOSIT_OWNER_SOLANA` ⇒ DEPOSIT_ACCOUNT_NOT_CONFIGURED, cero red', async () => {
      delete process.env.A2A_DEPOSIT_OWNER_SOLANA;
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
