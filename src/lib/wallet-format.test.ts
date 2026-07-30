/**
 * Tests for src/lib/wallet-format.ts (WKH-143b · single source EVM validator).
 *
 * Módulo leaf puro — sin mocks (mismo estilo que price.test.ts). Garantiza que
 * `isValidWallet` es el criterio EXACTO que comparte el write-path del publish
 * con el money-path de cobro (`resolveRecipients`) — CD-1.
 */

import nodeCrypto from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { base58Encode } from '../adapters/solana/base58.js';
import {
  ADDRESS_RE,
  isValidPayoutWallet,
  isValidSolanaAddress,
  isValidSolanaSignature,
  isValidWallet,
} from './wallet-format.js';

describe('isValidWallet (CD-1)', () => {
  it('accepts a valid EVM address (0x + 40 hex, lower/upper/mixed case)', () => {
    expect(isValidWallet('0x1111111111111111111111111111111111111111')).toBe(
      true,
    );
    expect(isValidWallet('0xABCDEF0123456789abcdef0123456789ABCDEF01')).toBe(
      true,
    );
    expect(isValidWallet('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(
      true,
    );
  });

  it('rejects empty string, short/long, non-hex, missing 0x, null, undefined, non-string', () => {
    expect(isValidWallet('')).toBe(false);
    expect(isValidWallet('0xshort')).toBe(false);
    // 39 hex (too short)
    expect(isValidWallet('0x111111111111111111111111111111111111111')).toBe(
      false,
    );
    // 41 hex (too long)
    expect(isValidWallet('0x11111111111111111111111111111111111111111')).toBe(
      false,
    );
    // non-hex char (g)
    expect(isValidWallet('0x111111111111111111111111111111111111111g')).toBe(
      false,
    );
    // missing 0x prefix
    expect(isValidWallet('1111111111111111111111111111111111111111')).toBe(
      false,
    );
    expect(isValidWallet(null)).toBe(false);
    expect(isValidWallet(undefined)).toBe(false);
    expect(isValidWallet(12345 as unknown as string)).toBe(false);
  });

  it('ADDRESS_RE is the exact EVM format regex (no EIP-55 checksum)', () => {
    expect(ADDRESS_RE.source).toBe('^0x[0-9a-fA-F]{40}$');
  });
});

// WKH-234 — validador Solana base58 puro (CD-7) + dispatch namespace-aware.
describe('isValidSolanaAddress (WKH-234, AC-5)', () => {
  it('accepts a valid base58 32-byte pubkey (mint / owner)', () => {
    // USDC-SPL Circle devnet default mint (DT-9).
    expect(
      isValidSolanaAddress('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
    ).toBe(true);
    // wSOL mint + System Program (all-'1') — both canonical 32-byte pubkeys.
    expect(
      isValidSolanaAddress('So11111111111111111111111111111111111111112'),
    ).toBe(true);
    expect(isValidSolanaAddress('11111111111111111111111111111111')).toBe(true);
  });

  it('rejects invalid charset (0/O/I/l, punctuation), an EVM 0x address, and empty', () => {
    expect(isValidSolanaAddress('O0Il')).toBe(false); // base58-excluded chars
    expect(isValidSolanaAddress('notbase58!!!')).toBe(false); // punctuation
    expect(
      isValidSolanaAddress('0x5425890298aed601595a70AB815c96711a31Bc65'),
    ).toBe(false); // EVM address is not valid base58 (contains 0)
    expect(isValidSolanaAddress('')).toBe(false);
  });

  it('rejects a base58 string that decodes to ≠ 32 bytes', () => {
    expect(isValidSolanaAddress('short')).toBe(false); // < 32 bytes
    // 44 'z' chars decode to >32 bytes.
    expect(isValidSolanaAddress('z'.repeat(50))).toBe(false);
  });
});

describe('isValidPayoutWallet dispatch (WKH-234, AC-1/AC-5)', () => {
  const EVM = '0x5425890298aed601595a70AB815c96711a31Bc65';
  const SOL = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

  it("ns 'evm' accepts a 0x address and rejects base58 (byte-identical EVM)", () => {
    expect(isValidPayoutWallet(EVM, 'evm')).toBe(true);
    expect(isValidPayoutWallet(SOL, 'evm')).toBe(false);
  });

  it("ns 'solana' accepts a base58 pubkey and rejects a 0x address", () => {
    expect(isValidPayoutWallet(SOL, 'solana')).toBe(true);
    expect(isValidPayoutWallet(EVM, 'solana')).toBe(false);
  });
});

// ── WKH-315 · isValidSolanaSignature (AC-1 / AC-8) ──────────────────────────
//
// Este predicado decide si un `tx_hash` de `POST /auth/deposit` es una FIRMA de
// Solana. Si acepta cosas que no lo son, el verificador sale a la red con basura;
// si rechaza firmas legítimas, el depósito es irreclamable.
//
// CD-16 — los fixtures se DERIVAN de la librería que los consume: una firma de
// Solana es una firma ed25519 cruda de 64 bytes, así que se firma de verdad con
// `node:crypto` y se codifica en base58. PROHIBIDO `'x'.repeat(88)` o un buffer de
// ceros: los dos pasarían un predicado de longitud roto.
describe('isValidSolanaSignature (WKH-315, AC-1/AC-8)', () => {
  /** Firma ed25519 REAL de 64 bytes, en base58 — la forma exacta de un txid. */
  function realSignatureBase58(): string {
    const { privateKey } = nodeCrypto.generateKeyPairSync('ed25519');
    const sig = nodeCrypto.sign(
      null,
      Buffer.from('WKH-315 fixture'),
      privateKey,
    );
    // Andamiaje: si esto no fuera 64 bytes, el resto del describe no probaría nada.
    expect(sig.length).toBe(64);
    return base58Encode(new Uint8Array(sig));
  }

  it('T-315-W02a: acepta una firma ed25519 REAL de 64 bytes codificada en base58', () => {
    expect(isValidSolanaSignature(realSignatureBase58())).toBe(true);
  });

  it('T-315-W02b: RECHAZA una pubkey de 32 bytes — 32 ≠ 64 y confundirlas manda a la red una firma inexistente', () => {
    const pubkey = Keypair.generate().publicKey.toBase58();
    // Andamiaje: la pubkey SI es base58 válida como address (o sea que el rechazo
    // viene de la longitud, no del charset).
    expect(isValidSolanaAddress(pubkey)).toBe(true);
    expect(isValidSolanaSignature(pubkey)).toBe(false);
  });

  it("T-315-W02c: RECHAZA '0xbad' y cualquier hash EVM — los dos predicados son MUTUAMENTE EXCLUYENTES", () => {
    // Este es el caso literal de `auth.test.ts`: sigue fallando los DOS predicados
    // ⇒ sigue dando INVALID_INPUT en el mismo lugar (CD-1).
    expect(isValidSolanaSignature('0xbad')).toBe(false);
    expect(isValidSolanaSignature(`0x${'a'.repeat(64)}`)).toBe(false);
    // El alfabeto base58 no contiene '0': ningún `0x…` puede ser base58.
    expect(isValidSolanaSignature('0')).toBe(false);
  });

  it('T-315-W02d: RECHAZA charset inválido SIN LANZAR (es input del caller)', () => {
    // '0', 'O', 'I', 'l' están FUERA del alfabeto base58. `base58DecodeToBytes` del
    // adapter LANZA acá con un mensaje que nombra SOLANA_OPERATOR_PRIVATE_KEY: un
    // typo del usuario no puede producir una falsa alarma de secreto en los logs.
    expect(() => isValidSolanaSignature('0OIl'.repeat(30))).not.toThrow();
    expect(isValidSolanaSignature('0OIl'.repeat(30))).toBe(false);
    expect(isValidSolanaSignature('')).toBe(false);
    expect(isValidSolanaSignature('!!!')).toBe(false);
  });

  it('T-315-W02e: RECHAZA 63 y 65 bytes — la cota es EXACTA, no "al menos"', () => {
    expect(
      isValidSolanaSignature(base58Encode(new Uint8Array(63).fill(9))),
    ).toBe(false);
    expect(
      isValidSolanaSignature(base58Encode(new Uint8Array(65).fill(9))),
    ).toBe(false);
    expect(
      isValidSolanaSignature(base58Encode(new Uint8Array(64).fill(9))),
    ).toBe(true);
  });

  it('T-315-W02f: NO normaliza la caja — existe una firma válida cuya versión bajada de caja NO lo es', () => {
    // Bajar de caja una cadena base58 la DESTRUYE. La forma de PROBAR que el
    // predicado no normaliza es exhibir un contraejemplo: si internamente hiciera
    // `toLowerCase()`, aceptaría las dos y la última aserción se pondría roja.
    //
    // Búsqueda DETERMINISTICA (relleno por fórmula, sin azar): mismo resultado en
    // cada corrida — no es un test que dependa del reloj ni de una semilla oculta.
    let found: string | null = null;
    for (let i = 0; i < 2000 && found === null; i++) {
      const bytes = new Uint8Array(64);
      for (let j = 0; j < 64; j++) bytes[j] = (i * 31 + j * 17) & 0xff;
      const enc = base58Encode(bytes);
      const low = enc.toLowerCase();
      if (enc !== low && !isValidSolanaSignature(low)) found = enc;
    }
    // Andamiaje: si la búsqueda no encontró contraejemplo, este test NO prueba la
    // propiedad y tiene que FALLAR, no pasar en silencio.
    expect(found).not.toBeNull();
    const sig = found as string;
    expect(isValidSolanaSignature(sig)).toBe(true);
    expect(isValidSolanaSignature(sig.toLowerCase())).toBe(false);
  });
});
