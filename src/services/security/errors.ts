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
 * Operación que detectó el mismatch (PII-safe enum).
 * - `getBalance` / `deactivate`: ownership sobre `a2a_agent_keys` (WKH-53).
 * - `registryUpdate` / `registryDelete`: ownership sobre `registries` (WKH-63).
 */
export type OwnershipOp =
  | 'getBalance'
  | 'deactivate'
  | 'registryUpdate'
  | 'registryDelete';

/**
 * PII-safe logger para cross-owner attempts.
 * Loguea hash SHA-256 truncado — nunca el resourceId/ownerRef en claro (CD-A3).
 *
 * Soporta dos formas:
 *   1. Posicional (legacy WKH-53): `logOwnershipMismatch(op, keyId, ownerId)`.
 *   2. Objeto (WKH-63 fix-pack): incluye `actualOwnerRef` opcional para
 *      diagnóstico cross-tenant en `registries` (también hasheado).
 */
export function logOwnershipMismatch(
  op: 'getBalance' | 'deactivate',
  keyId: string,
  ownerId: string,
): void;
export function logOwnershipMismatch(args: {
  op: OwnershipOp;
  resourceId: string;
  callerOwnerRef: string;
  actualOwnerRef?: string;
}): void;
export function logOwnershipMismatch(
  opOrArgs:
    | OwnershipOp
    | {
        op: OwnershipOp;
        resourceId: string;
        callerOwnerRef: string;
        actualOwnerRef?: string;
      },
  keyId?: string,
  ownerId?: string,
): void {
  const hash = (v: string): string =>
    crypto.createHash('sha256').update(v).digest('hex').slice(0, 16);

  if (typeof opOrArgs === 'string') {
    // Legacy positional form (WKH-53).
    console.warn('[security] ownership mismatch', {
      op: opOrArgs,
      keyIdHash: hash(keyId ?? ''),
      ownerIdHash: hash(ownerId ?? ''),
      ts: new Date().toISOString(),
    });
    return;
  }

  // Object form (WKH-63 fix-pack).
  const payload: Record<string, string> = {
    op: opOrArgs.op,
    resourceIdHash: hash(opOrArgs.resourceId),
    callerOwnerRefHash: hash(opOrArgs.callerOwnerRef),
    ts: new Date().toISOString(),
  };
  if (opOrArgs.actualOwnerRef !== undefined) {
    payload.actualOwnerRefHash = hash(opOrArgs.actualOwnerRef);
  }
  console.warn('[security] ownership mismatch', payload);
}
