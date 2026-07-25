/**
 * Solana identity binding (WKH-234).
 *
 * No on-chain identity binding for the Solana rail — the bundle carries
 * `identity: null` (mirror of avalanche/base). Kept as an explicit export so
 * `index.ts` reads uniformly against the EVM exemplars.
 */
export const solanaIdentity = null;
