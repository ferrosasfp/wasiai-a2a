import type { AdaptersBundle } from '../types.js';
import { type BaseNetwork, getBaseChain, getBaseNetwork } from './chain.js';

/**
 * Base adapter factory (WKH-104 / BASE-01).
 *
 * Returns an `AdaptersBundle` ready to be inserted into the multi-chain
 * registry `Map<ChainKey, AdaptersBundle>`. Network is determined by
 * `opts.network` (preferred) or `BASE_NETWORK` env (standalone / tools).
 *
 * The registry dispatcher (`buildBundle()` in `registry.ts`) always passes
 * `network` explicitly — 'testnet' for `base-sepolia`, 'mainnet' for
 * `base-mainnet`.
 */
export async function createBaseAdapters(opts?: {
  network?: BaseNetwork;
}): Promise<AdaptersBundle> {
  const network = getBaseNetwork(opts);
  const { BasePaymentAdapter } = await import('./payment.js');
  const { BaseAttestationAdapter } = await import('./attestation.js');
  const { BaseGaslessAdapter } = await import('./gasless.js');

  const chain = getBaseChain(network);
  const chainId = chain.id;
  const explorerUrl =
    network === 'mainnet'
      ? 'https://basescan.org'
      : 'https://sepolia.basescan.org';
  const name = network === 'mainnet' ? 'Base' : 'Base Sepolia';

  return {
    payment: new BasePaymentAdapter({ network }),
    attestation: new BaseAttestationAdapter(chainId),
    gasless: new BaseGaslessAdapter(chainId),
    identity: null,
    chainConfig: {
      name,
      chainId,
      explorerUrl,
    },
  };
}
