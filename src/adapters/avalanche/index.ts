import type { AdaptersBundle } from '../types.js';
import {
  type AvalancheNetwork,
  getAvalancheChain,
  getAvalancheNetwork,
} from './chain.js';

/**
 * Avalanche adapter factory (WKH-MULTICHAIN / 086 W1).
 *
 * Returns an `AdaptersBundle` ready to be inserted into the multi-chain
 * registry `Map<ChainKey, AdaptersBundle>`. Network is determined by
 * `opts.network` (preferred) or `AVALANCHE_NETWORK` env (legacy / standalone).
 *
 * The registry dispatcher (`buildBundle()` in `registry.ts`) always passes
 * `network` explicitly — 'fuji' for `avalanche-fuji`, 'mainnet' for
 * `avalanche-mainnet`.
 */
export async function createAvalancheAdapters(opts?: {
  network?: AvalancheNetwork;
}): Promise<AdaptersBundle> {
  const network = getAvalancheNetwork(opts);
  const { AvalanchePaymentAdapter } = await import('./payment.js');
  const { AvalancheAttestationAdapter } = await import('./attestation.js');
  const { AvalancheGaslessAdapter } = await import('./gasless.js');

  const chain = getAvalancheChain(network);
  const chainId = chain.id;
  const explorerUrl =
    network === 'mainnet'
      ? 'https://snowtrace.io'
      : 'https://testnet.snowtrace.io';
  const name = network === 'mainnet' ? 'Avalanche' : 'Avalanche Fuji';

  return {
    payment: new AvalanchePaymentAdapter({ network }),
    attestation: new AvalancheAttestationAdapter(chainId),
    gasless: new AvalancheGaslessAdapter(chainId),
    identity: null,
    chainConfig: {
      name,
      chainId,
      explorerUrl,
    },
  };
}
