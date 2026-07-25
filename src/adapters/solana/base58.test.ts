/**
 * Unit tests del codec base58 puro (fix-pack CR de WKH-235a, MNR-2).
 *
 * `base58Encode` es LOAD-BEARING para el path de dinero: produce el `txHash` del
 * settle recuperado tras un timeout de confirmación, y ese string termina en el
 * ledger (`settle_signature`). Antes de este archivo la suite lo ejercitaba con
 * UN solo vector, sin roundtrip ni test directo.
 *
 * Estrategia: property test de roundtrip `decode(encode(bytes)) === bytes` sobre
 * un set de vectores que incluye explícitamente ceros líderes, buffer todo-ceros,
 * bytes altos (0xff), longitudes 1/32/64 y casos pseudo-aleatorios DETERMINISTAS
 * (PRNG sembrado con constante — NO `Math.random()`, el test debe ser
 * reproducible byte a byte en cada corrida).
 */

import { describe, expect, it } from 'vitest';
import { base58DecodeToBytes, base58Encode } from './base58.js';

/** LCG determinista (Numerical Recipes) — mismo output en toda corrida. */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 24; // byte alto: mejor distribuido que el bajo en un LCG
  };
}

function bytesOf(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function zeros(n: number): Uint8Array {
  return new Uint8Array(n);
}

function filled(n: number, value: number): Uint8Array {
  return new Uint8Array(n).fill(value);
}

function pseudoRandom(len: number, seed: number): Uint8Array {
  const next = makePrng(seed);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = next();
  return out;
}

/** Vectores fijos (nombre → bytes). Todos deben cerrar el roundtrip. */
const VECTORS: Array<[string, Uint8Array]> = [
  ['buffer vacío', zeros(0)],
  ['1 byte cero (todo-ceros len 1)', zeros(1)],
  ['2 bytes cero (todo-ceros len 2)', zeros(2)],
  ['32 bytes cero (todo-ceros len 32)', zeros(32)],
  ['63 bytes cero (todo-ceros len 63)', zeros(63)],
  ['64 bytes cero (placeholder pre-firma de web3.js)', zeros(64)],
  ['1 cero líder + payload', bytesOf(0x00, 0x01)],
  ['2 ceros líderes + payload', bytesOf(0x00, 0x00, 0x01)],
  ['2 ceros líderes + bytes altos', bytesOf(0x00, 0x00, 0xff, 0xff)],
  [
    '63 ceros líderes + 0x01 (vector de payment.test)',
    (() => {
      const b = zeros(64);
      b[63] = 1;
      return b;
    })(),
  ],
  ['1 byte alto', bytesOf(0xff)],
  ['32 bytes 0xff', filled(32, 0xff)],
  ['64 bytes 0xff', filled(64, 0xff)],
  ['len 1 arbitrario', bytesOf(0x7f)],
  ['len 32 arbitrario', pseudoRandom(32, 0xc0ffee)],
  ['len 64 arbitrario (tamaño firma ed25519)', pseudoRandom(64, 0xdecafbad)],
  ['cero interno (no líder)', bytesOf(0x01, 0x00, 0x00, 0x01)],
  ['cero final', bytesOf(0x01, 0x00)],
  ['mezcla ceros líderes + cero final', bytesOf(0x00, 0x01, 0x00)],
];

describe('base58 codec (WKH-235a fix-pack, MNR-2)', () => {
  it('vector conocido: 0x0000287fb4cd → "11233QC4"', () => {
    const bytes = bytesOf(0x00, 0x00, 0x28, 0x7f, 0xb4, 0xcd);
    expect(base58Encode(bytes)).toBe('11233QC4');
    expect(Array.from(base58DecodeToBytes('11233QC4'))).toEqual(
      Array.from(bytes),
    );
  });

  it.each(
    VECTORS,
  )('roundtrip decode(encode(bytes)) === bytes — %s', (_name, bytes) => {
    const encoded = base58Encode(bytes);
    expect(Array.from(base58DecodeToBytes(encoded))).toEqual(Array.from(bytes));
  });

  it('roundtrip sobre 256 buffers pseudo-aleatorios DETERMINISTAS (longitudes 1..64)', () => {
    // Semilla constante ⇒ el set es idéntico en cada corrida (reproducible).
    const next = makePrng(0x5eed1234);
    for (let n = 0; n < 256; n++) {
      const len = (next() % 64) + 1;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = next();
      const encoded = base58Encode(bytes);
      expect(
        Array.from(base58DecodeToBytes(encoded)),
        `roundtrip falló para n=${n} len=${len} bytes=${Array.from(bytes).join(',')}`,
      ).toEqual(Array.from(bytes));
    }
  });

  it('roundtrip sobre buffers con 0..8 ceros líderes + payload determinista', () => {
    const next = makePrng(0xa11ce);
    for (let lead = 0; lead <= 8; lead++) {
      const bytes = new Uint8Array(lead + 8);
      // Primer byte del payload forzado no-cero para que `lead` sea exacto.
      bytes[lead] = (next() % 255) + 1;
      for (let i = lead + 1; i < bytes.length; i++) bytes[i] = next();
      const encoded = base58Encode(bytes);
      expect(encoded.startsWith('1'.repeat(lead))).toBe(true);
      expect(encoded[lead]).not.toBe('1');
      expect(Array.from(base58DecodeToBytes(encoded))).toEqual(
        Array.from(bytes),
      );
    }
  });

  it('un buffer todo-ceros de N bytes codifica exactamente N "1" (fija el bound `bytes.length - 1`)', () => {
    // El `- 1` del loop de ceros líderes NO es un off-by-one: `digits` queda en
    // `[0]` y aporta el '1' del último byte. Si alguien lo "simplifica" a
    // `< bytes.length`, este test rompe con N+1 chars.
    for (const n of [1, 2, 32, 63, 64]) {
      expect(base58Encode(zeros(n))).toBe('1'.repeat(n));
    }
  });

  it('encode del buffer vacío es el string vacío (y su decode vuelve vacío)', () => {
    expect(base58Encode(zeros(0))).toBe('');
    expect(base58DecodeToBytes('')).toHaveLength(0);
  });

  it('decode rechaza caracteres fuera del alfabeto base58 (0, O, I, l)', () => {
    for (const bad of ['0', 'O', 'I', 'l', '5+5', '11233QC4!']) {
      expect(() => base58DecodeToBytes(bad)).toThrow(/not valid base58/);
    }
  });
});
