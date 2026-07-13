/**
 * Escrow contract ABI (WKH-126b — TS integration of the non-custodial escrow).
 *
 * PROVISIONAL — coordinar forma canónica con WKH-126a (VERIFY-AT-IMPL).
 * El contrato Solidity vive en WKH-126a (fuera de scope). Esta constante es la
 * vista TS de su interfaz; converge byte-a-byte con 126a. Cualquier divergencia
 * se resuelve acá (aislado del handler) — ver Story File §9 R-1.
 *
 * El decode del evento `Deposited` en `escrow-verifier.ts` deriva el item con
 * `parseAbiItem(...)` (topic0 derivado por viem, NUNCA literal — CD-3).
 */

/**
 * ABI escrow tipado viem `as const`.
 *
 * PROVISIONAL — VERIFY-AT-IMPL con WKH-126a (forma, nombres de campos y orden de
 * argumentos deben coincidir con el contrato deployado).
 */
export const ESCROW_ABI = [
  {
    type: 'event',
    name: 'Deposited',
    inputs: [
      { name: 'depositor', type: 'address', indexed: true },
      { name: 'keyId', type: 'bytes32', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'Debited',
    inputs: [
      { name: 'keyId', type: 'bytes32', indexed: true },
      { name: 'operator', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'nonce', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'keyId', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'debit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'keyId', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'nonce', type: 'uint256' }, // DT-14: converge con WKH-126a (debit 5 args)
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'escrowBalance',
    stateMutability: 'view',
    inputs: [{ name: 'keyId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  // ── 191g: arbiter / dispute events (byte-a-byte con IWasiAIEscrow.sol:24-28) ──
  {
    type: 'event',
    name: 'DisputeLocked',
    inputs: [
      { name: 'keyId', type: 'bytes32', indexed: true },
      { name: 'arbiter', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'totalLocked', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'DisputeResolved',
    inputs: [
      { name: 'keyId', type: 'bytes32', indexed: true },
      { name: 'arbiter', type: 'address', indexed: true },
      { name: 'seller', type: 'address', indexed: true },
      { name: 'sellerAmount', type: 'uint256', indexed: false },
      { name: 'nonce', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'DisputeReleased',
    inputs: [
      { name: 'keyId', type: 'bytes32', indexed: true },
      { name: 'arbiter', type: 'address', indexed: true },
      { name: 'releasedAmount', type: 'uint256', indexed: false },
    ],
    anonymous: false,
  },
  // ── 191g: arbiter / dispute functions (byte-a-byte con IWasiAIEscrow.sol:84-94) ──
  {
    type: 'function',
    name: 'lockForDispute',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'keyId', type: 'bytes32' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'resolveDispute',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'keyId', type: 'bytes32' },
      { name: 'seller', type: 'address' },
      { name: 'sellerAmount', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'releaseDispute',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'keyId', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'arbitrationConsent',
    stateMutability: 'view',
    inputs: [{ name: 'keyId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'lockedAmount',
    stateMutability: 'view',
    inputs: [{ name: 'keyId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;
