import type { AttestationAdapter, AttestEvent, AttestRef } from '../types.js';

/**
 * Base attestation stub (WKH-104 / BASE-01).
 *
 * Mirror of `AvalancheAttestationAdapter`. ERC-8004 attestation on Base is
 * out of scope for MVP (placeholder — future HU may wire EAS or similar).
 * Returns a stub txHash so downstream consumers don't break.
 */
export class BaseAttestationAdapter implements AttestationAdapter {
  readonly name = 'base';
  readonly chainId: number;

  constructor(chainId: number) {
    this.chainId = chainId;
  }

  async attest(
    _event: AttestEvent,
  ): Promise<{ txHash: string; proofUrl: string }> {
    console.warn('[base] attestation stub — ERC-8004 not implemented');
    return { txHash: '0x0', proofUrl: '' };
  }

  async verify(_ref: AttestRef): Promise<boolean> {
    return true;
  }
}
