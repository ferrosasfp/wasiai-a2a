/**
 * Wallet Format — WKH-143b · Validador EVM compartido (single source).
 *
 * Helper PURO de formato de wallet — sin Fastify, sin Supabase, sin adapters.
 * Módulo leaf: NO importa nada del proyecto (evita ciclos), igual que
 * `src/lib/price.ts` ("sin Fastify, sin Supabase, sin adapters").
 *
 * Es la ÚNICA fuente de verdad del criterio EVM (CD-1): tanto el write-path del
 * publish (`routes/agents.ts` + `services/agent.ts`) como el money-path de cobro
 * (`services/fee-split.ts` → `resolveRecipients`) validan wallets con EXACTAMENTE
 * esta función. Prohibido un validador paralelo (checksum EIP-55, longitud
 * distinta).
 */

/**
 * Regex de address EVM: `0x` + 40 hex (mayúsc/minúsc). Formato-only — NO valida
 * checksum EIP-55 ni existencia on-chain. Movido desde `fee-split.ts` para
 * compartir el criterio con el write-path.
 */
export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * `true` si `wallet` es un string con formato de address EVM válido. Un valor
 * `null`/`undefined`/no-string / fuera del formato → `false`.
 *
 * El type-predicate narrowea a `` `0x${string}` `` (no a `string`) — fix-pack
 * CR-MNR-4: es lo que permite que los consumidores que necesitan el tipo de viem
 * lo OBTENGAN del validador en vez de escribir `x as \`0x${string}\`` al lado.
 * Un cast crudo es una aserción sin chequeo; acá el chequeo ya se hizo (el regex
 * garantiza el prefijo `0x`), así que el tipo puede expresarlo. Cambio SOLO de
 * tipos: `` `0x${string}` `` es asignable a `string`, así que los call-sites que
 * sólo querían un booleano/`string` siguen compilando byte-idénticos.
 */
export function isValidWallet(
  wallet: string | null | undefined,
): wallet is `0x${string}` {
  return typeof wallet === 'string' && ADDRESS_RE.test(wallet);
}

/**
 * WKH-234 — validador Solana PURO (CD-7): charset base58 + decode a EXACTAMENTE
 * 32 bytes (pubkey ed25519). NO importa `@solana/web3.js` — preserva el módulo
 * leaf. Algoritmo base-x estándar (mismo que bs58): acumula dígitos base-256
 * little-endian, mapea los `1` iniciales a bytes cero, y verifica longitud 32.
 */
const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const SOLANA_PUBKEY_BYTES = 32;

export function isValidSolanaAddress(w: string): boolean {
  if (typeof w !== 'string' || w.length === 0) return false;
  const bytes: number[] = [];
  for (let i = 0; i < w.length; i++) {
    let carry = BASE58_ALPHABET.indexOf(w[i] as string);
    if (carry < 0) return false; // char fuera del charset base58
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
  // Cada `1` inicial representa un byte cero de alto orden.
  for (let i = 0; i < w.length && w[i] === '1'; i++) {
    bytes.push(0);
  }
  return bytes.length === SOLANA_PUBKEY_BYTES;
}

export type WalletNamespace = 'evm' | 'solana';

/**
 * WKH-234 — valida `w` contra el formato de la familia `ns` (namespace-aware).
 * Despacha al validador EVM (`isValidWallet`) o Solana (`isValidSolanaAddress`).
 */
export function isValidPayoutWallet(w: string, ns: WalletNamespace): boolean {
  return ns === 'solana' ? isValidSolanaAddress(w) : isValidWallet(w);
}
