import { getLogger } from '../../lib/logger.js';
import type { AttestationAdapter, AttestEvent, AttestRef } from '../types.js';

const log = getLogger('tempo');

/**
 * Tempo attestation stub (WKH-090 / HU-090).
 *
 * Registra el "Receipt" de MPP (mapping DT-1). Impl real (ERC-8004 / EAS)
 * fuera de v1 — mirror de `BaseAttestationAdapter`. Devuelve un stub txHash
 * para que los consumidores downstream no se rompan.
 */
export class TempoAttestationAdapter implements AttestationAdapter {
  readonly name = 'tempo';
  readonly chainId: number;

  constructor(chainId: number) {
    this.chainId = chainId;
  }

  async attest(
    _event: AttestEvent,
  ): Promise<{ txHash: string; proofUrl: string }> {
    log.warn('attestation stub — MPP Receipt not persisted on-chain in v1');
    return { txHash: '0x0', proofUrl: '' };
  }

  async verify(_ref: AttestRef): Promise<boolean> {
    return true;
  }
}
