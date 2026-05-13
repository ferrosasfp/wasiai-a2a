import { avalanche, avalancheFuji } from 'viem/chains';

/**
 * Avalanche chain registration (WKH-MULTICHAIN / 086 W1).
 *
 * Re-export the viem-defined chains directly — Avalanche C-Chain (43114) and
 * Fuji testnet (43113) are first-class viem entries, no `defineChain()` needed.
 */
export { avalanche, avalancheFuji };

export type AvalancheNetwork = 'fuji' | 'mainnet';

/**
 * Resolve the active Avalanche network for call-sites outside the registry
 * factory (the factory itself always passes `network` explicitly).
 *
 * Priority:
 *   1. Explicit `opts.network` argument.
 *   2. `AVALANCHE_NETWORK` env var (accepts 'fuji' or 'mainnet').
 *   3. Fallback to 'fuji' (testnet).
 */
export function getAvalancheNetwork(opts?: {
  network?: AvalancheNetwork;
}): AvalancheNetwork {
  if (opts?.network) return opts.network;
  const env = process.env.AVALANCHE_NETWORK;
  return env === 'mainnet' ? 'mainnet' : 'fuji';
}

export function getAvalancheChain(network: AvalancheNetwork) {
  return network === 'mainnet' ? avalanche : avalancheFuji;
}
