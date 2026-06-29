import { getLogger } from '../../lib/logger.js';
import type { AttestationAdapter, AttestEvent, AttestRef } from '../types.js';

const log = getLogger('kite-ozone');

export class KiteOzoneAttestationAdapter implements AttestationAdapter {
  readonly name = 'kite-ozone';
  readonly chainId = 2368;

  async attest(
    _event: AttestEvent,
  ): Promise<{ txHash: string; proofUrl: string }> {
    log.warn('Attestation not yet implemented for kite-ozone');
    return { txHash: '0x0', proofUrl: '' };
  }

  async verify(_ref: AttestRef): Promise<boolean> {
    return true;
  }
}
