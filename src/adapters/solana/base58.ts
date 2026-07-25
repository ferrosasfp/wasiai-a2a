/**
 * Base58 codec PURO para el adapter Solana (fix-pack CR de WKH-235a, MNR-1).
 *
 * Unifica las dos copias que vivían duplicadas en `chain.ts`
 * (`base58DecodeToBytes` + alfabeto) y `payment.ts` (`base58Encode` + otra copia
 * del alfabeto). Move puro: mismo algoritmo base-x, mismo comportamiento.
 *
 * Decisión conservada de WKH-234/235a: NO se agrega `bs58` como dependencia —
 * no está declarada en `package.json` (solo entra como transitiva de
 * `@solana/web3.js`), así que depender de ella sería depender de un detalle de
 * resolución ajeno. Ambas funciones son puras y sin dependencias externas.
 *
 * Load-bearing: `base58Encode` produce el `txHash` del settle recuperado, que
 * termina en el ledger (`settle_signature`) → su roundtrip está fijado por
 * `base58.test.ts`.
 */

export const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Codifica bytes a string base58 (algoritmo base-x estándar). PURO — no
 * depende de `bs58`. Se usa para derivar la firma base58 de una tx YA firmada
 * (`Transaction.signature` es un Buffer) cuando el error de confirmación no la
 * trae.
 */
export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  const digits: number[] = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i] as number;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] as number) << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  // El `- 1` NO es un off-by-one: compensa el caso todo-ceros, donde `digits`
  // queda en `[0]` y el loop de abajo ya emite el '1' del último byte cero. Con
  // `< bytes.length` se emitiría un '1' de más (N+1 chars para N bytes cero).
  // NO "simplificar": rompe el encoding de cualquier buffer con ceros líderes.
  for (let k = 0; k < bytes.length - 1 && bytes[k] === 0; k++) out += '1';
  for (let q = digits.length - 1; q >= 0; q--) {
    out += BASE58_ALPHABET[digits[q] as number];
  }
  return out;
}

/**
 * Decodifica un string base58 a bytes (algoritmo base-x estándar). PURO — no
 * depende de `bs58`. Usado para el secret-key del operator (`chain.ts`) y como
 * inverso del encoder en los tests de roundtrip.
 *
 * El mensaje de error se conserva tal cual del call-site original (el
 * secret-key del operator) para no cambiar comportamiento observable.
 */
export function base58DecodeToBytes(s: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let carry = BASE58_ALPHABET.indexOf(s[i] as string);
    if (carry < 0) {
      throw new Error('SOLANA_OPERATOR_PRIVATE_KEY is not valid base58');
    }
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] as number) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < s.length && s[i] === '1'; i++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}
