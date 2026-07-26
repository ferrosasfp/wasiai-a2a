/**
 * Wiring REAL del settle Solana — la mitad OFFLINE del ex-"devnet e2e"
 * (P1, hallazgo 6).
 *
 * ─── POR QUÉ EXISTE ESTE ARCHIVO ──────────────────────────────────────────
 * El "e2e de devnet" que había (`payment.test.ts`, `describe.runIf(E2E)` →
 * "settles a real SPL transfer on devnet") NO probaba nada. Dos defectos
 * independientes, los dos verificados:
 *
 *  1. Estaba SIEMPRE apagado en CI: `SOLANA_DEVNET_E2E` no se setea en ningún
 *     lado del repo, así que el `describe.runIf` nunca corría.
 *  2. Y con el flag PRENDIDO seguía sin probar nada: vivía en un archivo que
 *     mockea `./chain.js`, `@solana/spl-token` y `sendAndConfirmTransaction` a
 *     nivel módulo. `vi.importActual('./payment.js')` desmockea el módulo
 *     PEDIDO, no sus dependencias, así que el "settle real en devnet" resolvía
 *     contra el operator falso y el `sendAndConfirmTransaction` falso.
 *     Demostración: con `SOLANA_DEVNET_E2E=1` + un `SOLANA_E2E_PAYTO`
 *     cualquiera, el test PASABA en 270 ms, sin red, sin
 *     `SOLANA_OPERATOR_PRIVATE_KEY` y sin fondos — asertando `success: true`
 *     sobre `FAKE_SIG`, o sea sobre su propio mock.
 *
 * ─── QUÉ PRUEBA ESTE ARCHIVO (y qué NO) ───────────────────────────────────
 * La parte del settle cuyo valor NO depende de la red: la CONSTRUCCIÓN de la
 * transferencia. Acá `@solana/spl-token` (`createTransferInstruction`,
 * `getAssociatedTokenAddressSync`), `Transaction` y `PublicKey` son los REALES;
 * lo único falso es el borde de red (`getOrCreateAssociatedTokenAccount`, que
 * consulta el RPC, y `sendAndConfirmTransaction`, que broadcastea).
 *
 * Eso convierte en asertable lo que el test viejo fingía: el monto que viaja
 * on-chain, la DIRECCIÓN de la transferencia y quién firma. Los tres son
 * bugs de dinero silenciosos — un source/destination invertido transfiere
 * PLATA AJENA HACIA el operador y `settle()` igual devuelve `success: true`.
 *
 * NO prueba: que la tx sea aceptada por un cluster, que el ATA exista, ni que
 * haya fondos. Eso es inevitablemente red y vive en
 * `devnet-e2e.manual.test.ts` (manual, con runbook).
 *
 * Determinista y offline: el operator sale de una seed fija, no de
 * `Keypair.generate()`.
 */

import {
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Keypair, PublicKey, type Transaction } from '@solana/web3.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** USDC devnet (el default documentado de `chain.ts`). */
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const PAY_TO = 'So11111111111111111111111111111111111111112';

/** Operator DETERMINISTA (seed fija) — sin esto el test no sería reproducible. */
const OPERATOR = Keypair.fromSeed(new Uint8Array(32).fill(7));

// ── Único borde falso #1: la config/red (chain.ts) ────────────────────────
// El operator es un Keypair REAL (firma de verdad); la Connection es un stub
// porque acá no se llega a usar (el único consumidor, el getOrCreate del ATA,
// también está mockeado).
const fakeConnection = { __stub: 'connection' };
vi.mock('./chain.js', () => ({
  getSolanaConnection: vi.fn((..._a: unknown[]) => fakeConnection),
  getSolanaOperatorKeypair: vi.fn((..._a: unknown[]) => OPERATOR),
  getSolanaUsdcMint: vi.fn((..._a: unknown[]) => MINT),
  getSolanaUsdcDecimals: vi.fn((..._a: unknown[]) => 6),
  getSolanaCommitment: vi.fn((..._a: unknown[]) => 'confirmed'),
  getSolanaCaip2: vi.fn((..._a: unknown[]) => 'solana:devnet-test'),
}));

// ── Único borde falso #2: la lectura RPC del ATA ──────────────────────────
// `createTransferInstruction` y `getAssociatedTokenAddressSync` quedan REALES
// (son puros). Sólo `getOrCreateAssociatedTokenAccount` se sustituye, porque
// consulta/crea la cuenta contra el cluster — y devuelve la ATA derivada con la
// función REAL, así que las direcciones son las de producción.
vi.mock('@solana/spl-token', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/spl-token')>();
  return {
    ...actual,
    getOrCreateAssociatedTokenAccount: vi.fn(
      async (
        _connection: unknown,
        _payer: unknown,
        mint: PublicKey,
        owner: PublicKey,
      ) => ({ address: actual.getAssociatedTokenAddressSync(mint, owner) }),
    ),
  };
});

// ── Único borde falso #3: el broadcast ────────────────────────────────────
// Se CAPTURA la Transaction real que el adapter construyó.
const sent: { tx?: Transaction; signers?: unknown; options?: unknown } = {};
const CONFIRMED_SIG = 'z'.repeat(64);
vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  return {
    ...actual,
    sendAndConfirmTransaction: vi.fn(
      async (
        _connection: unknown,
        tx: Transaction,
        signers: unknown,
        options: unknown,
      ) => {
        sent.tx = tx;
        sent.signers = signers;
        sent.options = options;
        return CONFIRMED_SIG;
      },
    ),
  };
});

import { _resetSolanaClients, SolanaPaymentAdapter } from './payment.js';

/** Decodifica el layout REAL de la instrucción Transfer de SPL: tag(1) + u64 LE. */
function decodeTransfer(data: Uint8Array): { tag: number; amount: bigint } {
  const buf = Buffer.from(data);
  return { tag: buf[0] as number, amount: buf.readBigUInt64LE(1) };
}

describe('settle Solana — construcción REAL de la transferencia (P1 hallazgo 6)', () => {
  beforeEach(() => {
    _resetSolanaClients();
    delete sent.tx;
    delete sent.signers;
    delete sent.options;
  });

  it('T-P1-6a: la instrucción es un SPL Transfer al TOKEN PROGRAM real, con el monto EXACTO en u64 LE', async () => {
    const adapter = new SolanaPaymentAdapter();
    const res = await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '3000000', // 3 USDC con 6 decimales
      intentId: 'wiring:0:payTo',
    });

    expect(res).toEqual({ txHash: CONFIRMED_SIG, success: true });

    const tx = sent.tx;
    expect(tx).toBeDefined();
    // Una sola instrucción: el adapter no mete nada más en la tx de un leg.
    expect(tx?.instructions).toHaveLength(1);
    const ix = tx?.instructions[0];
    // Program id REAL del SPL Token program (no un mock que dice "sí").
    expect(ix?.programId.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());

    const decoded = decodeTransfer(ix?.data as Uint8Array);
    expect(decoded.tag).toBe(3); // 3 = Transfer en el layout SPL
    // ⚠️ El corazón: el monto que realmente viaja on-chain, byte a byte.
    expect(decoded.amount).toBe(3000000n);
  });

  it('T-P1-6b: la DIRECCIÓN de la transferencia es operador → payTo (un swap sería robo silencioso)', async () => {
    const adapter = new SolanaPaymentAdapter();
    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1000000',
      intentId: 'wiring:1:payTo',
    });

    const mint = new PublicKey(MINT);
    const expectedFrom = getAssociatedTokenAddressSync(
      mint,
      OPERATOR.publicKey,
    );
    const expectedTo = getAssociatedTokenAddressSync(
      mint,
      new PublicKey(PAY_TO),
    );
    // Las dos ATAs son DISTINTAS: si fueran iguales el test no probaría el orden.
    expect(expectedFrom.toBase58()).not.toBe(expectedTo.toBase58());

    const keys = sent.tx?.instructions[0]?.keys;
    // Layout SPL Transfer: [0]=source, [1]=destination, [2]=owner/authority.
    expect(keys?.[0]?.pubkey.toBase58()).toBe(expectedFrom.toBase58());
    expect(keys?.[1]?.pubkey.toBase58()).toBe(expectedTo.toBase58());
    // El authority es el operador Y firma.
    expect(keys?.[2]?.pubkey.toBase58()).toBe(OPERATOR.publicKey.toBase58());
    expect(keys?.[2]?.isSigner).toBe(true);
  });

  it('T-P1-6c: firma el OPERADOR y el commitment configurado viaja al broadcast', async () => {
    const adapter = new SolanaPaymentAdapter();
    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1',
      intentId: 'wiring:2:payTo',
    });

    // Un único signer, y es el operador (no el payTo, no un keypair efímero).
    expect(Array.isArray(sent.signers)).toBe(true);
    const signers = sent.signers as Keypair[];
    expect(signers).toHaveLength(1);
    expect(signers[0]?.publicKey.toBase58()).toBe(
      OPERATOR.publicKey.toBase58(),
    );
    expect(sent.options).toEqual({ commitment: 'confirmed' });
  });

  it('T-P1-6d: montos de borde se codifican exactos (1 atómico y un monto grande)', async () => {
    const adapter = new SolanaPaymentAdapter();

    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1', // el mínimo transferible
      intentId: 'wiring:3:payTo',
    });
    expect(
      decodeTransfer(sent.tx?.instructions[0]?.data as Uint8Array),
    ).toEqual({ tag: 3, amount: 1n });

    // 400 USDC: el monto de la remesa insignia. Un `Number` intermedio acá sería
    // un redondeo de plata; el layout u64 lo tiene que reproducir exacto.
    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '400000000',
      intentId: 'wiring:4:payTo',
    });
    expect(
      decodeTransfer(sent.tx?.instructions[0]?.data as Uint8Array),
    ).toEqual({ tag: 3, amount: 400000000n });
  });

  it('T-P1-6e: la instrucción construida es BYTE-IDÉNTICA a la que produce spl-token directo', async () => {
    // Anti-tautología: se compara contra la instrucción canónica armada por la
    // librería REAL, no contra el resultado del propio adapter.
    const adapter = new SolanaPaymentAdapter();
    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '2500000',
      intentId: 'wiring:5:payTo',
    });

    const mint = new PublicKey(MINT);
    const canonical = createTransferInstruction(
      getAssociatedTokenAddressSync(mint, OPERATOR.publicKey),
      getAssociatedTokenAddressSync(mint, new PublicKey(PAY_TO)),
      OPERATOR.publicKey,
      2500000n,
    );

    const actualIx = sent.tx?.instructions[0];
    expect(Buffer.from(actualIx?.data as Uint8Array).toString('hex')).toBe(
      Buffer.from(canonical.data).toString('hex'),
    );
    expect(actualIx?.keys.map((k) => k.pubkey.toBase58())).toEqual(
      canonical.keys.map((k) => k.pubkey.toBase58()),
    );
  });
});
