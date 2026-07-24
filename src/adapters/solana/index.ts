import type { AdaptersBundle } from '../types.js';
import { getSolanaNetwork, type SolanaNetwork } from './chain.js';

/**
 * Solana adapter factory (WKH-234).
 *
 * Returns an `AdaptersBundle` for the multi-chain registry
 * `Map<ChainKey, AdaptersBundle>`. Mirror of `createAvalancheAdapters`:
 * lazy `await import()` of the concrete adapters, `identity: null`.
 *
 * `chainConfig.chainId` uses the NO-EVM synthetic sentinel (DT-8) — it is NEVER
 * used to build a viem client (Solana settles via @solana/web3.js).
 *
 * W0 scaffold — real chain-config resolution wires in W3.
 */
export async function createSolanaAdapters(opts?: {
  network?: SolanaNetwork;
}): Promise<AdaptersBundle> {
  const network = getSolanaNetwork(opts);
  const { SolanaPaymentAdapter } = await import('./payment.js');
  const { SolanaAttestationAdapter } = await import('./attestation.js');
  const { SolanaGaslessAdapter } = await import('./gasless.js');
  const { getSolanaSyntheticChainId } = await import('./chain.js');
  const { solanaIdentity } = await import('./identity.js');

  const chainId = getSolanaSyntheticChainId();

  return {
    payment: new SolanaPaymentAdapter(),
    attestation: new SolanaAttestationAdapter(chainId),
    gasless: new SolanaGaslessAdapter(chainId),
    identity: solanaIdentity,
    chainConfig: {
      name: network === 'devnet' ? 'Solana Devnet' : 'Solana',
      chainId,
      explorerUrl: 'https://explorer.solana.com?cluster=devnet',
    },
  };
}
