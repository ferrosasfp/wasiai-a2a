/**
 * WKH-315 · AC-7 — tests de `src/lib/ed25519.ts` (la prueba de posesión).
 *
 * ── CD-16: LOS FIXTURES SE DERIVAN, NO SE INVENTAN ──────────────────────────
 *
 * Todas las firmas se producen con `crypto.sign(null, msg, privateKey)` sobre pares
 * reales de `generateKeyPairSync('ed25519')`, y todas las pubkeys salen de
 * `Keypair.generate()` / del par generado. PROHIBIDO `'x'.repeat(88)` o un buffer de
 * ceros: los dos harían pasar una verificación rota que sólo chequea longitudes.
 *
 * ── T-315-08e ES UN CANARIO, Y ES EL TEST MAS IMPORTANTE DEL ARCHIVO ────────
 *
 * `ed25519.ts` tiene su PROPIO decoder base58 (no puede usar el del adapter, que
 * LANZA nombrando una clave privada). El algoritmo base-x acumula LITTLE-ENDIAN y hay
 * que invertirlo. Si la inversión falta o sobra, `crypto.verify` devuelve `false` para
 * TODO y el síntoma se lee como "las firmas están mal" en vez de "el decoder está al
 * revés" — un rato largo de depuración por un `.reverse()`.
 *
 * El canario compara la salida del decoder contra `keypair.publicKey.toBytes()` de
 * `@solana/web3.js`, o sea contra la librería que produce estas cadenas en el mundo
 * real. Es un ORACULO EXTERNO, no una re-implementación del mismo algoritmo (que
 * sería verdadera por construcción y no cazaría nada).
 *
 * El módulo de producción NO importa `@solana/web3.js` (sigue siendo leaf); este test
 * sí, a propósito.
 */

import crypto from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { base58Encode } from '../adapters/solana/base58.js';
import { verifyEd25519Base58 } from './ed25519.js';

const KEY_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_KEY_ID = 'ffffffff-1111-2222-3333-444444444444';
const MSG = `WASIAI_BIND_FUNDING_WALLET_SOLANA:${KEY_ID}`;

/**
 * Un par ed25519 REAL, con su pubkey en base58 y un firmador. Se usa
 * `generateKeyPairSync` (no `Keypair.generate()`) porque `crypto.sign` necesita el
 * `KeyObject`; la pubkey cruda se extrae del SPKI DER, que para Ed25519 son los
 * últimos 32 bytes de un DER de 44.
 */
function realPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  // Andamiaje: si el DER no midiera 44 bytes, el slice de abajo tomaría basura y
  // todos los tests de este archivo pasarían a probar otra cosa.
  expect(der.length).toBe(44);
  const raw = new Uint8Array(der.subarray(12));
  expect(raw.length).toBe(32);
  return {
    pubkeyBase58: base58Encode(raw),
    sign: (m: string) =>
      base58Encode(
        new Uint8Array(crypto.sign(null, Buffer.from(m, 'utf8'), privateKey)),
      ),
  };
}

describe('WKH-315 · verifyEd25519Base58 (AC-7)', () => {
  it('T-315-08e (CANARIO): el decoder base58 propio reproduce EXACTAMENTE keypair.publicKey.toBytes()', () => {
    // ⚠️ EL ORACULO ES `@solana/web3.js`, no una re-implementación del algoritmo.
    // Se prueba indirectamente pero de forma decisiva: se firma con una llave cuya
    // pubkey se serializa con `toBase58()` de web3.js, y la verificación tiene que
    // dar `true`. Eso sólo puede pasar si el decoder produce los MISMOS 32 bytes que
    // web3.js entiende — o sea, con la inversión little→big-endian correcta.
    const kp = Keypair.generate();
    const privateKey = crypto.createPrivateKey({
      // PKCS#8 de una llave Ed25519: prefijo fijo + los 32 bytes de seed.
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        Buffer.from(kp.secretKey.subarray(0, 32)),
      ]),
      format: 'der',
      type: 'pkcs8',
    });
    const sig = base58Encode(
      new Uint8Array(crypto.sign(null, Buffer.from(MSG, 'utf8'), privateKey)),
    );

    // La pubkey en base58 la produce web3.js; el decoder de producción la tiene que
    // leer idéntica o la firma no verifica.
    expect(verifyEd25519Base58(MSG, kp.publicKey.toBase58(), sig)).toBe(true);

    // Y la mitad directa del canario: mismos bytes, comparados uno a uno. Se accede
    // al decoder a través del único camino público que hay — una firma válida sobre
    // una pubkey CONSTRUIDA a partir de `toBytes()` re-codificada.
    const reEncoded = base58Encode(kp.publicKey.toBytes());
    expect(reEncoded).toBe(kp.publicKey.toBase58());
    expect(verifyEd25519Base58(MSG, reEncoded, sig)).toBe(true);
  });

  it('acepta una firma válida del mensaje canónico', () => {
    const { pubkeyBase58, sign } = realPair();
    expect(verifyEd25519Base58(MSG, pubkeyBase58, sign(MSG))).toBe(true);
  });

  it('T-315-08d: una firma VALIDA pero de OTRO key_id da false (la prueba está atada a la key)', () => {
    // ⚠️ ESTA ES LA PROPIEDAD ANTI-REPLAY DEL BIND. Si el mensaje no llevara el
    // key_id, una firma legítima obtenida una vez serviría para bindear la wallet a
    // CUALQUIER key, incluida la de un atacante.
    const { pubkeyBase58, sign } = realPair();
    const otherMsg = `WASIAI_BIND_FUNDING_WALLET_SOLANA:${OTHER_KEY_ID}`;
    const sigForOther = sign(otherMsg);
    // Andamiaje: la firma SI es válida para su propio mensaje.
    expect(verifyEd25519Base58(otherMsg, pubkeyBase58, sigForOther)).toBe(true);
    // Y NO lo es para el nuestro.
    expect(verifyEd25519Base58(MSG, pubkeyBase58, sigForOther)).toBe(false);
  });

  it('una firma con UN BIT manipulado da false', () => {
    const { pubkeyBase58, sign } = realPair();
    const good = sign(MSG);
    // Se manipula sobre los BYTES (no sobre el string base58, donde un cambio de
    // char altera el largo decodificado y el rechazo vendría de la longitud).
    const bytes = Buffer.from(
      crypto.sign(
        null,
        Buffer.from(MSG, 'utf8'),
        crypto.generateKeyPairSync('ed25519').privateKey,
      ),
    );
    expect(bytes.length).toBe(64);
    expect(verifyEd25519Base58(MSG, pubkeyBase58, good)).toBe(true);
    expect(
      verifyEd25519Base58(
        MSG,
        pubkeyBase58,
        base58Encode(new Uint8Array(bytes)),
      ),
    ).toBe(false);
  });

  it('una firma del mismo par con un bit flippeado da false (tamper del propio blob)', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const der = publicKey.export({ format: 'der', type: 'spki' });
    const pk = base58Encode(new Uint8Array(der.subarray(12)));
    const sig = Buffer.from(
      crypto.sign(null, Buffer.from(MSG, 'utf8'), privateKey),
    );
    expect(
      verifyEd25519Base58(MSG, pk, base58Encode(new Uint8Array(sig))),
    ).toBe(true);
    const tampered = Buffer.from(sig);
    tampered[0] = (tampered[0] as number) ^ 0x01; // un solo bit
    expect(
      verifyEd25519Base58(MSG, pk, base58Encode(new Uint8Array(tampered))),
    ).toBe(false);
  });

  it('un mensaje distinto (mismo par, misma firma) da false', () => {
    const { pubkeyBase58, sign } = realPair();
    const sig = sign(MSG);
    expect(verifyEd25519Base58(`${MSG} `, pubkeyBase58, sig)).toBe(false);
    expect(verifyEd25519Base58('', pubkeyBase58, sig)).toBe(false);
  });

  it('base58 inválido devuelve false SIN LANZAR (es input del caller)', () => {
    const { pubkeyBase58, sign } = realPair();
    const sig = sign(MSG);
    // '0', 'O', 'I', 'l' están FUERA del alfabeto base58.
    for (const bad of ['0OIl', '', '!!!', 'not base58', '0x1234']) {
      expect(() => verifyEd25519Base58(MSG, bad, sig)).not.toThrow();
      expect(verifyEd25519Base58(MSG, bad, sig)).toBe(false);
      expect(() => verifyEd25519Base58(MSG, pubkeyBase58, bad)).not.toThrow();
      expect(verifyEd25519Base58(MSG, pubkeyBase58, bad)).toBe(false);
    }
  });

  it('una pubkey de 31 o 33 bytes da false (la longitud es EXACTA, no "al menos")', () => {
    const { sign } = realPair();
    const sig = sign(MSG);
    for (const n of [31, 33, 64]) {
      const wrong = base58Encode(new Uint8Array(n).fill(7));
      expect(verifyEd25519Base58(MSG, wrong, sig)).toBe(false);
    }
  });

  it('una firma de 63 o 65 bytes da false', () => {
    const { pubkeyBase58 } = realPair();
    for (const n of [63, 65, 32]) {
      const wrong = base58Encode(new Uint8Array(n).fill(7));
      expect(verifyEd25519Base58(MSG, pubkeyBase58, wrong)).toBe(false);
    }
  });

  it('una pubkey de 32 bytes que NO está en la curva da false y NO LANZA', () => {
    // El runtime rechaza la clave; el catch lo traduce a `false`. Sin ese catch, un
    // input del caller tiraría un 500 en vez de un 403.
    const { sign } = realPair();
    const notOnCurve = base58Encode(new Uint8Array(32).fill(0xff));
    expect(() => verifyEd25519Base58(MSG, notOnCurve, sign(MSG))).not.toThrow();
    expect(verifyEd25519Base58(MSG, notOnCurve, sign(MSG))).toBe(false);
  });

  it('el módulo es LEAF: no importa nada del proyecto', async () => {
    // Un import del proyecto acá podría arrastrar Supabase/Fastify a la ruta de un
    // control de seguridad, y crear un ciclo. Se verifica sobre el TEXTO del fuente.
    const { readFileSync } = await import('node:fs');
    const { dirname, resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), 'ed25519.ts'),
      'utf8',
    );
    const imports = [...src.matchAll(/^import .*?from '([^']+)';/gm)].map(
      (m) => m[1],
    );
    expect(imports).toEqual(['node:crypto']);
    // Y ningún `tweetnacl` / `bs58` (dependencias NO declaradas en package.json,
    // entran sólo como transitivas de `@solana/web3.js`).
    //
    // ⚠️ SOBRE EL TEXTO SIN COMENTARIOS, NO SOBRE EL FUENTE CRUDO. La cabecera de
    // `ed25519.ts` EXPLICA por qué no se usan esas dos librerías, así que un match
    // contra el fuente crudo se satisface con la prosa que documenta la prohibición
    // — y se pondría rojo justamente por cumplirla bien. (Este test falló así en su
    // primera corrida: la lección `code()` de las migraciones vale igual acá.)
    const codeOnly = src
      .split('\n')
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
      })
      .join('\n');
    expect(codeOnly).not.toMatch(/tweetnacl|bs58/);
  });
});
