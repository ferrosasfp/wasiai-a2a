import type { Connection } from '@solana/web3.js';

/**
 * Solana devnet chain registration (WKH-234).
 *
 * W0 scaffold — real env-resolution (cluster/RPC/CAIP-2/sentinel) lands in W3.
 * Devnet-only (CD-4): no `-mainnet` variant.
 */
export type SolanaNetwork = 'devnet';

export function getSolanaNetwork(_opts?: {
  network?: SolanaNetwork;
}): SolanaNetwork {
  return 'devnet';
}

export function getSolanaConnection(): Connection {
  throw new Error('NOT_IMPLEMENTED: getSolanaConnection (W3)');
}

export function getSolanaCaip2(): string {
  throw new Error('NOT_IMPLEMENTED: getSolanaCaip2 (W3)');
}

export function getSolanaSyntheticChainId(): number {
  throw new Error('NOT_IMPLEMENTED: getSolanaSyntheticChainId (W3)');
}
