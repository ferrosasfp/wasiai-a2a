/**
 * ABI minimo del contrato WasiAttestation (Ozone / Kite Testnet).
 * Hardcodeado como `as const` para inferencia de tipos en viem writeContract.
 *
 * Contrato deployado externamente. Este ABI es el contrato de integracion.
 */
export const ATTESTATION_ABI = [
  {
    name: 'attest',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'orchestrationId', type: 'string' },
      { name: 'agents', type: 'string[]' },
      { name: 'totalCostUsdc', type: 'uint256' },
      { name: 'timestamp', type: 'uint256' },
      { name: 'resultHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    name: 'getAttestation',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'orchestrationId', type: 'string' },
    ],
    outputs: [
      { name: 'agents', type: 'string[]' },
      { name: 'totalCostUsdc', type: 'uint256' },
      { name: 'timestamp', type: 'uint256' },
      { name: 'resultHash', type: 'bytes32' },
      { name: 'exists', type: 'bool' },
    ],
  },
  {
    name: 'AttestationCreated',
    type: 'event',
    inputs: [
      { name: 'orchestrationId', type: 'string', indexed: true },
      { name: 'resultHash', type: 'bytes32', indexed: false },
    ],
  },
] as const
