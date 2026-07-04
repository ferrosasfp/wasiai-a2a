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
 */
export function isValidWallet(
  wallet: string | null | undefined,
): wallet is string {
  return typeof wallet === 'string' && ADDRESS_RE.test(wallet);
}
