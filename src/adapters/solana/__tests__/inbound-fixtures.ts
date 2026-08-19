/**
 * FIXTURES DEL COBRO INBOUND SOLANA — WKH-314. Helper compartido, **no** una suite.
 *
 * ── CD-12: LOS FIXTURES SE DERIVAN DE LA MISMA LIBRERIA QUE LOS CONSUME ────
 *
 * `'x'.repeat(88)` **no es base58** (la `x` sí está en el alfabeto, pero el string no
 * decodifica a 64 bytes) y `'0'.repeat(32)` directamente tiene caracteres que el
 * alfabeto no contiene. Un fixture así no explota donde se escribe: explota **lejos**,
 * dentro del decoder, y el test termina midiendo el manejo de un input imposible en
 * lugar del guard que decía medir.
 *
 * Acá: las pubkeys salen de `Keypair.generate()` (o sea, ed25519 de verdad) y las
 * firmas de `base58Encode` sobre 64 bytes, que es exactamente lo que produce la cadena.
 *
 * ⚠️ NUNCA importar un `.test.ts` desde otro: eso DUPLICA sus suites en el reporte
 * (medido en WKH-307). Todo lo compartido vive acá.
 */

import { Keypair } from '@solana/web3.js';
import { base58Encode } from '../base58.js';

/** Una pubkey base58 de 32 bytes EXACTOS, derivada de una llave ed25519 real. */
export function freshPubkey(): string {
  return Keypair.generate().publicKey.toBase58();
}

/**
 * Una firma base58 de 64 bytes exactos — el largo real de una firma ed25519.
 * El `seed` hace el fixture DETERMINISTA cuando el test necesita repetir la misma
 * firma en dos llamadas.
 */
export function freshSignature(seed = 0): string {
  const bytes = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    // Nunca 0 en la primera posición: un byte cero líder cambia el largo del base58 y
    // el fixture dejaría de parecerse a una firma real.
    bytes[i] = ((i * 7 + seed * 13 + 1) % 255) + 1;
  }
  return base58Encode(bytes);
}

/** Una entrada de `pre/postTokenBalances` con la forma que devuelve el RPC. */
export function balanceEntry(args: {
  accountIndex: number;
  mint: string;
  owner?: string | undefined;
  amount: string;
}): {
  accountIndex: number;
  mint: string;
  owner?: string | undefined;
  uiTokenAmount: { amount: string };
} {
  const entry: {
    accountIndex: number;
    mint: string;
    owner?: string | undefined;
    uiTokenAmount: { amount: string };
  } = {
    accountIndex: args.accountIndex,
    mint: args.mint,
    uiTokenAmount: { amount: args.amount },
  };
  if (args.owner !== undefined) entry.owner = args.owner;
  return entry;
}

/**
 * Una transacción parseada con la forma que devuelve `getParsedTransaction`.
 *
 * `accountKeys` se emite en la forma `{ pubkey: PublicKey, signer, writable }`, que es
 * la que devuelve el RPC para mensajes parseados — la misma que el código tiene que
 * saber leer.
 */
export function parsedTx(args: {
  accountKeys: string[];
  blockTime?: number | null;
  version?: unknown;
  loadedAddresses?: { writable?: unknown; readonly?: unknown } | null;
  meta?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const meta: Record<string, unknown> = { ...(args.meta ?? {}) };
  if (args.loadedAddresses !== undefined) {
    meta.loadedAddresses = args.loadedAddresses;
  }
  return {
    blockTime: args.blockTime === undefined ? 1_700_000_000 : args.blockTime,
    version: args.version,
    transaction: {
      message: {
        accountKeys: args.accountKeys.map((pubkey) => ({
          pubkey: { toBase58: () => pubkey },
          signer: false,
          writable: false,
        })),
      },
    },
    meta: args.meta === null ? null : meta,
  };
}
