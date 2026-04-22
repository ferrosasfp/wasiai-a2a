/**
 * Security Errors — WKH-53
 *
 * Central tipo de error para ownership guards en app-layer.
 * PROHIBIDO lanzar new Error('...') genérico en paths de ownership (CD-A2).
 */
import crypto from 'node:crypto';

export class OwnershipMismatchError extends Error {
  readonly code = 'OWNERSHIP_MISMATCH' as const;
  constructor() {
    super('Ownership mismatch');
    this.name = 'OwnershipMismatchError';
  }
}

/**
 * PII-safe logger para cross-owner attempts.
 * Loguea hash SHA-256 truncado — nunca el keyId/ownerId en claro (CD-A3).
 */
export function logOwnershipMismatch(
  op: 'getBalance' | 'deactivate',
  keyId: string,
  ownerId: string,
): void {
  const hash = (v: string): string =>
    crypto.createHash('sha256').update(v).digest('hex').slice(0, 16);
  console.warn('[security] ownership mismatch', {
    op,
    keyIdHash: hash(keyId),
    ownerIdHash: hash(ownerId),
    ts: new Date().toISOString(),
  });
}
