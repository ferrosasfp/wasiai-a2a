import { base, baseSepolia } from 'viem/chains';

/**
 * Base chain registration (WKH-104 / BASE-01).
 *
 * Re-export the viem-defined chains directly — Base (8453) and Base Sepolia
 * (84532) are first-class viem entries since viem ^2.47.6 (DT-4 RESUELTO).
 */
export { base, baseSepolia };

export type BaseNetwork = 'testnet' | 'mainnet';

/**
 * Resolve the active Base network for call-sites outside the registry
 * factory (the factory itself always passes `network` explicitly).
 *
 * Priority:
 *   1. Explicit `opts.network` argument.
 *   2. `BASE_NETWORK` env var ('mainnet' activa mainnet, anything else → testnet).
 *   3. Fallback to 'testnet' (Base Sepolia) — conservador (CD-4).
 *
 * CD-11 (defense-in-depth, Auto-Blindaje WKH-59): si `BASE_NETWORK` tiene un
 * valor que no es 'mainnet'/'testnet'/vacío, emit `console.warn` ONCE por
 * proceso explicando el fallback. Previene silent misconfig.
 */
let _warnedBaseNetwork = false;
export function getBaseNetwork(opts?: { network?: BaseNetwork }): BaseNetwork {
  if (opts?.network) return opts.network;
  const env = process.env.BASE_NETWORK;
  if (env === 'mainnet') return 'mainnet';
  if (
    env !== undefined &&
    env !== '' &&
    env !== 'testnet' &&
    !_warnedBaseNetwork
  ) {
    _warnedBaseNetwork = true;
    console.warn(
      `[base] BASE_NETWORK="${env}" is not 'mainnet' or 'testnet' — defaulting to 'testnet'`,
    );
  }
  return 'testnet';
}

export function getBaseChain(network: BaseNetwork) {
  return network === 'mainnet' ? base : baseSepolia;
}

/** TEST-ONLY — reset warn-once flag (CD-17). */
export function _resetBaseChain(): void {
  _warnedBaseNetwork = false;
}
