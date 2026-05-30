import type { AttestationAdapter, AttestEvent, AttestRef } from '../types.js';

/**
 * Avalanche attestation stub (WKH-MULTICHAIN / 086 W1).
 *
 * Mirror of `KiteOzoneAttestationAdapter`. ERC-8004 attestation on Avalanche
 * is out of scope for MVP (MI-2 RESUELTO en SDD). Returns a stub txHash so
 * downstream consumers don't break.
 */
export class AvalancheAttestationAdapter implements AttestationAdapter {
  readonly name = 'avalanche';
  readonly chainId: number;

  constructor(chainId: number) {
    this.chainId = chainId;
  }

  async attest(
    _event: AttestEvent,
  ): Promise<{ txHash: string; proofUrl: string }> {
    console.warn('[avalanche] attestation stub — ERC-8004 not implemented');
    return { txHash: '0x0', proofUrl: '' };
  }

  async verify(_ref: AttestRef): Promise<boolean> {
    return true;
  }
}
