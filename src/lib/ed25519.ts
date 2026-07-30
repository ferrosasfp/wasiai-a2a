/**
 * Verificación de firmas ed25519 sobre entradas base58 (WKH-315 · AC-7).
 *
 * Módulo **leaf**: cero imports del proyecto (igual que `wallet-format.ts`), cero
 * dependencias nuevas. Es la prueba de posesión de una wallet Solana: el owner
 * firma `WASIAI_BIND_FUNDING_WALLET_SOLANA:<key_id>` con su llave y acá se verifica
 * contra la pubkey que declara.
 *
 * ── POR QUE ESTE GATE NO ES OPCIONAL ────────────────────────────────────────
 *
 * Las firmas de una cuenta de Solana son PUBLICAS vía `getSignaturesForAddress`
 * sobre la ATA de depósito. Un atacante no necesita front-runear nada: hace polling
 * de la cuenta de depósito, toma la firma del depósito de otro y la presenta como
 * propia. Y el UNIQUE que existe para proteger GARANTIZA QUE EL LEGITIMO PIERDA: su
 * firma ya fue "acreditada"… a otro. Sin este bind, el anti-replay se vuelve el
 * aliado del ladrón.
 *
 * Con el bind, ese ataque termina en 403 **sin insertar fila**, así que el
 * depositante legítimo sigue pudiendo reclamar.
 *
 * ── POR QUE `node:crypto` Y NO `tweetnacl` ──────────────────────────────────
 *
 * `tweetnacl` NO está declarada en `package.json`: entra sólo como transitiva de
 * `@solana/web3.js`. `src/adapters/solana/base58.ts` ya documenta la decisión de la
 * casa para el caso idéntico de `bs58` ("depender de ella sería depender de un
 * detalle de resolución ajeno"). Usarla acá repetiría eso, y encima en un control de
 * seguridad. `node:crypto` verifica ed25519 nativo, con cero dependencias.
 *
 * ── POR QUE `boolean` NO VIOLA CD-3 ────────────────────────────────────────
 *
 * CD-3 exige tres valores para toda consulta a un sistema EXTERNO ("está / no está /
 * no pude preguntar"). Acá no hay sistema externo: es un cómputo criptográfico local
 * y determinístico. No existe un tercer valor que se pueda perder. Cualquier fallo
 * (charset, longitud, verificación) es indistinguible de "la firma no es válida" y se
 * traduce al mismo 403 que la rama EVM.
 */

import crypto from 'node:crypto';

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Una pubkey ed25519 cruda. */
const PUBKEY_BYTES = 32;
/** Una firma ed25519 cruda. */
const SIGNATURE_BYTES = 64;

/**
 * Prefijo SPKI DER **fijo** de 12 bytes para una clave pública Ed25519
 * (`AlgorithmIdentifier` = 1.3.101.112, sin parámetros). Concatenado con los 32
 * bytes crudos da los 44 bytes que `crypto.createPublicKey` acepta como `spki`.
 *
 * Es fijo por el estándar (RFC 8410 §4), no una heurística: no hay longitudes
 * variables ni campos opcionales que dependan de la clave.
 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Decodifica `s` de base58 a bytes en orden **BIG-ENDIAN**, o `null` si el charset es
 * inválido. DEVUELVE, NUNCA LANZA (corre sobre input del caller).
 *
 * ⚠️ EL GOTCHA DE ENDIANNESS QUE CUESTA HORAS. El algoritmo base-x estándar (el mismo
 * de `wallet-format.ts` y de `bs58`) acumula dígitos base-256 **LITTLE-ENDIAN**:
 * `acc[0]` es el byte MENOS significativo, y los `1` iniciales de la cadena —que
 * representan bytes cero de ALTO orden— se empujan al FINAL del array. El orden real
 * de la pubkey es ese array **INVERTIDO**.
 *
 * Si no se invierte, `crypto.verify` devuelve `false` para absolutamente todo y el
 * síntoma parece "la firma está mal" en vez de "el decoder está al revés". Por eso el
 * test `T-315-08e` es un CANARIO: compara la salida de este decoder contra
 * `Keypair.generate().publicKey.toBytes()` de `@solana/web3.js` (la librería que
 * produce estas cadenas en el mundo real). El módulo de producción NO importa
 * `@solana/web3.js`; el test sí.
 *
 * PROHIBIDO `base58DecodeToBytes` (`adapters/solana/base58.ts`) acá: LANZA con el
 * literal `'SOLANA_OPERATOR_PRIVATE_KEY is not valid base58'`, y un typo del usuario
 * no puede producir una falsa alarma de secreto en los logs.
 */
function base58Decode(s: string): Uint8Array | null {
  if (typeof s !== 'string' || s.length === 0) return null;
  const acc: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let carry = BASE58_ALPHABET.indexOf(s[i] as string);
    if (carry < 0) return null; // char fuera del charset base58
    for (let j = 0; j < acc.length; j++) {
      carry += (acc[j] as number) * 58;
      acc[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      acc.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Cada `1` inicial representa un byte cero de ALTO orden → va al final del
  // acumulador little-endian, y al principio una vez invertido.
  for (let i = 0; i < s.length && s[i] === '1'; i++) {
    acc.push(0);
  }
  return new Uint8Array(acc.reverse());
}

/**
 * `true` si `signatureBase58` es una firma ed25519 válida de `message` (UTF-8) hecha
 * con la llave privada de `pubkeyBase58`.
 *
 * **NUNCA lanza** y **NUNCA loguea** el mensaje ni la firma. Cualquier fallo —charset
 * inválido, longitud distinta de 32/64, clave que el runtime rechaza, verificación
 * negativa— es `false`, y el caller lo traduce a 403 `FUNDING_WALLET_PROOF_INVALID`,
 * el mismo código que la rama EVM.
 */
export function verifyEd25519Base58(
  message: string,
  pubkeyBase58: string,
  signatureBase58: string,
): boolean {
  const pubkey = base58Decode(pubkeyBase58);
  if (pubkey === null || pubkey.length !== PUBKEY_BYTES) return false;

  const signature = base58Decode(signatureBase58);
  if (signature === null || signature.length !== SIGNATURE_BYTES) return false;

  try {
    const der = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pubkey)]);
    const keyObject = crypto.createPublicKey({
      key: der,
      format: 'der',
      type: 'spki',
    });
    // El `null` como algoritmo es CORRECTO Y OBLIGATORIO para Ed25519: la curva ya
    // define el hash (SHA-512 internamente), así que pasar un digest explícito es un
    // error. No es un "sin algoritmo" descuidado.
    return crypto.verify(
      null,
      Buffer.from(message, 'utf8'),
      keyObject,
      Buffer.from(signature),
    );
  } catch {
    // Un input mal formado que igual pasó las longitudes (p.ej. una pubkey que no
    // está en la curva) hace que el runtime rechace la clave. Es indistinguible de
    // "la firma no verifica" y se trata igual: fail-closed, sin filtrar el detalle.
    return false;
  }
}
