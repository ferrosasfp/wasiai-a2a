/**
 * Chain resolver utility (WKH-MULTICHAIN / 086).
 *
 * Pure module — does NOT import from `./registry`. Translates header values
 * and agent manifest values into the canonical `ChainKey` slug, applying the
 * priority defined in DT-1:
 *
 *   (1) explicit header `x-payment-chain`
 *   (2) agent manifest `payment.chain`
 *   (3) default (handled by the caller — this module returns `undefined`)
 *
 * Header value format (DT-E) accepts both slugs and numeric chainIds.
 *
 * CD-19: anti-prototype-pollution — uses `Object.hasOwn()` on a record with a
 * `null` prototype so callers can pass arbitrary input safely.
 */

import type { ChainKey } from './types.js';

const SLUG_ALIASES: Record<string, ChainKey> = Object.assign(
  Object.create(null) as Record<string, ChainKey>,
  {
    // avalanche-fuji aliases
    '43113': 'avalanche-fuji',
    'avalanche-fuji': 'avalanche-fuji',
    'avalanche-testnet': 'avalanche-fuji',
    avalanche: 'avalanche-fuji',
    fuji: 'avalanche-fuji',

    // avalanche-mainnet aliases
    '43114': 'avalanche-mainnet',
    'avalanche-mainnet': 'avalanche-mainnet',

    // kite-ozone-testnet aliases
    '2368': 'kite-ozone-testnet',
    'kite-ozone-testnet': 'kite-ozone-testnet',
    'kite-testnet': 'kite-ozone-testnet',

    // kite-mainnet aliases
    '2366': 'kite-mainnet',
    'kite-mainnet': 'kite-mainnet',

    // base-mainnet aliases (DT-7: 'base' alone → mainnet, convención comunidad)
    '8453': 'base-mainnet',
    'base-mainnet': 'base-mainnet',
    base: 'base-mainnet',

    // base-sepolia aliases
    '84532': 'base-sepolia',
    'base-sepolia': 'base-sepolia',
    'base-testnet': 'base-sepolia',

    // tempo-testnet aliases (WKH-090) — estáticos (el resolver es puro, NO lee
    // el flag; CD-7). Conocer el slug NO expone el rail con flag OFF: el bundle
    // no existe → getAdaptersBundle('tempo-testnet') = undefined → guard (2)
    // devuelve CHAIN_NOT_SUPPORTED.
    '42429': 'tempo-testnet', // V1 — chainId de Tempo testnet "Moderato"
    'tempo-testnet': 'tempo-testnet',
    tempo: 'tempo-testnet',

    // solana-devnet aliases (WKH-234) — estáticos (resolver puro, NO lee el
    // flag; CD-7/CD-8). Conocer el slug NO expone el rail con flag OFF: el
    // bundle no existe → getAdaptersBundle('solana-devnet') = undefined →
    // CHAIN_NOT_SUPPORTED. Devnet-only (CD-4): sin `solana-mainnet`.
    'solana-devnet': 'solana-devnet',
    solana: 'solana-devnet',
  } satisfies Record<string, ChainKey>,
);

/**
 * Normalizes a raw header / manifest value into a `ChainKey`.
 *
 * Returns `undefined` for any unknown input. Total — never throws, never
 * returns the default silently (callers MUST decide what to do on undefined).
 */
export function normalizeChainSlug(raw: string): ChainKey | undefined {
  if (typeof raw !== 'string') return undefined;
  const key = raw.trim().toLowerCase();
  if (key.length === 0) return undefined;
  return Object.hasOwn(SLUG_ALIASES, key) ? SLUG_ALIASES[key] : undefined;
}

/**
 * Resolves the priority chain (header > manifest > undefined). Caller is
 * responsible for falling back to the registry default when the result is
 * `undefined` AND the header was absent — see CD-14.
 *
 * If `headerOverride` is present but unrecognized, the function returns
 * `undefined` (caller MUST treat as 400 CHAIN_NOT_SUPPORTED — do NOT silently
 * fall through to the manifest or default).
 */
export function resolveChainKey(input: {
  headerOverride?: string | undefined;
  agentManifestChain?: string | undefined;
}): ChainKey | undefined {
  if (typeof input.headerOverride === 'string') {
    return normalizeChainSlug(input.headerOverride);
  }
  if (typeof input.agentManifestChain === 'string') {
    return normalizeChainSlug(input.agentManifestChain);
  }
  return undefined;
}
