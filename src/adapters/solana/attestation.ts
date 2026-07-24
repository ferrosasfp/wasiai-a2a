import type { AttestationAdapter, AttestEvent, AttestRef } from '../types.js';

/**
 * Solana attestation stub (WKH-234 / DT-5).
 *
 * ERC-8004-style attestation on Solana is OUT of scope. Unlike the EVM stubs
 * (which return a stub txHash), this throws NOT_IMPLEMENTED explicitly — the
 * Solana rail is settle-only and no consumer path should ever reach attest().
 */
export class SolanaAttestationAdapter implements AttestationAdapter {
  readonly name = 'solana';
  readonly chainId: number;

  constructor(chainId: number) {
    this.chainId = chainId;
  }

  async attest(
    _event: AttestEvent,
  ): Promise<{ txHash: string; proofUrl: string }> {
    throw new Error('NOT_IMPLEMENTED: solana attestation (DT-5)');
  }

  async verify(_ref: AttestRef): Promise<boolean> {
    throw new Error('NOT_IMPLEMENTED: solana attestation verify (DT-5)');
  }
}
