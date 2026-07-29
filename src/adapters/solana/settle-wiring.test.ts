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
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
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
/**
 * WKH-307: la Connection dejó de ser un `{ __stub }` inerte. El adapter ya no usa
 * `sendAndConfirmTransaction` (ese helper sobrescribe el blockhash y RE-FIRMA adentro,
 * así que sería imposible conocer la firma antes de transmitir), sino
 * `getLatestBlockhash` → `tx.sign` → `sendRawTransaction` → `confirmTransaction`.
 *
 * ⚠️ Y `sendRawTransaction` recibe un BUFFER SERIALIZADO, no un objeto: la captura se
 * REHIDRATA con `Transaction.from(raw)`, que preserva instrucciones, `programId`,
 * `keys` y `data`. Las aserciones de bytes de abajo siguen valiendo SIN aflojarse.
 */
const BLOCKHASH = Keypair.fromSeed(
  new Uint8Array(32).fill(9),
).publicKey.toBase58();
const sent: { raw?: Uint8Array; options?: unknown } = {};
const fakeConnection = {
  getLatestBlockhash: vi.fn(async (..._a: unknown[]) => ({
    blockhash: BLOCKHASH,
    lastValidBlockHeight: 1000,
  })),
  sendRawTransaction: vi.fn(async (raw: Uint8Array, options: unknown) => {
    sent.raw = raw;
    sent.options = options;
    return 'sent';
  }),
  confirmTransaction: vi.fn(async (..._a: unknown[]) => ({
    value: { err: null },
  })),
  getBlockHeight: vi.fn(async (..._a: unknown[]) => 900),
  getParsedTransaction: vi.fn(async (..._a: unknown[]) => null),
};

/** La `Transaction` que el adapter construyó, rehidratada desde el buffer. */
function sentTx(): Transaction {
  if (!sent.raw) throw new Error('no se transmitió ninguna transacción');
  return Transaction.from(Buffer.from(sent.raw));
}
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

// ── El ledger y el preflight ──────────────────────────────────────────────
// Sin estos dobles, `settle()` intentaría hablar con el `supabase` que
// `vitest.config.ts` apunta a localhost, el reclamo fallaría y —por FAIL-CLOSED— los
// 5 tests se pondrían rojos POR EL MOTIVO EQUIVOCADO (el guard funcionando, no la
// construcción de la transferencia rota).
const ledgerSignatures = new Set<string>();
vi.mock('./settle-ledger.js', () => ({
  claimSettleIntent: vi.fn(async () => ({ outcome: 'claimed', attempts: 1 })),
  recordSignedIntent: vi.fn(async (a: { signature: string }) => {
    if (ledgerSignatures.has(a.signature)) {
      return { ok: false, reason: 'signature_collision', detail: 'dup' };
    }
    ledgerSignatures.add(a.signature);
    return { ok: true, attempts: 1 };
  }),
  recordConfirmedIntent: vi.fn(async () => ({ ok: true })),
  reclaimExpiredIntent: vi.fn(async () => ({ ok: true })),
  readSettleIntent: vi.fn(async () => ({ state: 'none' })),
  probeSettleLedger: vi.fn(async () => ({ probe: 'ok' })),
}));
vi.mock('./schema-preflight.js', () => ({
  ensureSolanaSchemaReady: vi.fn(async () => ({ ok: true })),
  warmSolanaSchemaPreflight: vi.fn(),
  _resetSolanaSchemaPreflight: vi.fn(),
}));

import { _resetSolanaClients, SolanaPaymentAdapter } from './payment.js';

/** Decodifica el layout REAL de la instrucción Transfer de SPL: tag(1) + u64 LE. */
function decodeTransfer(data: Uint8Array): { tag: number; amount: bigint } {
  const buf = Buffer.from(data);
  return { tag: buf[0] as number, amount: buf.readBigUInt64LE(1) };
}

describe('settle Solana — construcción REAL de la transferencia (P1 hallazgo 6)', () => {
  beforeEach(() => {
    _resetSolanaClients();
    ledgerSignatures.clear();
    delete sent.raw;
    delete sent.options;
  });

  it('T-P1-6a: la instrucción es un SPL Transfer al TOKEN PROGRAM real, con el monto EXACTO en u64 LE', async () => {
    const adapter = new SolanaPaymentAdapter();
    const res = await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '3000000', // 3 USDC con 6 decimales
      intentId: 'wiring:0:payTo',
    });

    // La firma que devuelve el settle es la de la tx que se transmitió.
    expect(res.success).toBe(true);
    expect(res.txHash).toBeTruthy();

    const tx = sentTx();
    // Una sola instrucción: el adapter no mete nada más en la tx de un leg.
    expect(tx.instructions).toHaveLength(1);
    const ix = tx.instructions[0];
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

    const keys = sentTx().instructions[0]?.keys;
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

    // Un único firmante, y es el operador (no el payTo, no un keypair efímero).
    // Se lee de la tx REHIDRATADA: la firma viaja DENTRO del buffer serializado.
    const sigs = sentTx().signatures;
    expect(sigs).toHaveLength(1);
    expect(sigs[0]?.publicKey.toBase58()).toBe(OPERATOR.publicKey.toBase58());
    expect(sigs[0]?.signature).not.toBeNull();
    // El commitment configurado viaja al broadcast (ahora como preflightCommitment).
    expect(sent.options).toEqual({ preflightCommitment: 'confirmed' });
  });

  it('T-P1-6d: montos de borde se codifican exactos (1 atómico y un monto grande)', async () => {
    const adapter = new SolanaPaymentAdapter();

    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '1', // el mínimo transferible
      intentId: 'wiring:3:payTo',
    });
    expect(
      decodeTransfer(sentTx().instructions[0]?.data as Uint8Array),
    ).toEqual({ tag: 3, amount: 1n });

    // 400 USDC: el monto de la remesa insignia. Un `Number` intermedio acá sería
    // un redondeo de plata; el layout u64 lo tiene que reproducir exacto.
    await adapter.settle({
      payTo: PAY_TO,
      amountAtomic: '400000000',
      intentId: 'wiring:4:payTo',
    });
    expect(
      decodeTransfer(sentTx().instructions[0]?.data as Uint8Array),
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

    const actualIx = sentTx().instructions[0];
    expect(Buffer.from(actualIx?.data as Uint8Array).toString('hex')).toBe(
      Buffer.from(canonical.data).toString('hex'),
    );
    expect(actualIx?.keys.map((k) => k.pubkey.toBase58())).toEqual(
      canonical.keys.map((k) => k.pubkey.toBase58()),
    );
  });
});
