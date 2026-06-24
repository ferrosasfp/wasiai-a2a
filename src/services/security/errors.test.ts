/**
 * Security Errors — structural unit tests (audit 2026-06-24, P2-7)
 *
 * Cada error de seguridad expone un contrato estable que el resto del codebase
 * consume vía `instanceof` + `.code` (mapeo error_code ↔ HTTP en
 * routes/middleware). Estos tests blindan ese contrato:
 *   - cada clase extiende Error (instanceof Error → el error-boundary la captura)
 *   - `.name` === nombre de la clase (logging legible, no "Error" genérico)
 *   - `.code` es el literal `as const` documentado (mapeo HTTP)
 *   - `.message` no es vacío (observabilidad)
 *
 * NO tautológicos: si alguien renombra un `code` o quita `extends Error`, el
 * test rompe (es exactamente el invariante que el codebase asume).
 */
import { describe, expect, it } from 'vitest';
import * as errors from './errors.js';
import { logOwnershipMismatch } from './errors.js';

// ── Tabla de contrato: [ClassName, expectedCode] ─────────────
// El expectedCode es el literal documentado en errors.ts (readonly code).
const ERROR_CONTRACT: ReadonlyArray<[string, string]> = [
  ['OwnershipMismatchError', 'OWNERSHIP_MISMATCH'],
  ['DepositAlreadyCreditedError', 'DEPOSIT_ALREADY_CREDITED'],
  ['FundingWalletProofInvalidError', 'FUNDING_WALLET_PROOF_INVALID'],
  ['FundingWalletAlreadyBoundError', 'FUNDING_WALLET_ALREADY_BOUND'],
  ['FundingWalletNotBoundError', 'FUNDING_WALLET_NOT_BOUND'],
  ['FundingWalletMismatchError', 'FUNDING_WALLET_MISMATCH'],
  ['Erc8004AlreadyBoundError', 'ERC8004_ALREADY_BOUND'],
  ['Erc8004TokenNotFoundError', 'ERC8004_TOKEN_NOT_FOUND'],
  ['Erc8004ChainMismatchError', 'ERC8004_CHAIN_MISMATCH'],
  ['IdentityOwnershipMismatchError', 'IDENTITY_OWNERSHIP_MISMATCH'],
  ['Erc8004TokenAlreadyBoundError', 'ERC8004_TOKEN_ALREADY_BOUND'],
  ['DelegationSignerMismatchError', 'DELEGATION_SIGNER_MISMATCH'],
  ['DelegationNonceReplayError', 'DELEGATION_NONCE_REPLAY'],
  ['DelegationRevokedError', 'DELEGATION_REVOKED'],
  ['DelegationExpiredError', 'DELEGATION_EXPIRED'],
  ['DelegationTxLimitExceededError', 'DELEGATION_TX_LIMIT_EXCEEDED'],
  ['DelegationTotalLimitExceededError', 'DELEGATION_TOTAL_LIMIT_EXCEEDED'],
  ['DelegationNotAllowedError', 'DELEGATION_NOT_ALLOWED'],
  ['InvalidSessionTokenError', 'INVALID_SESSION_TOKEN'],
  ['DelegationChainNotAllowedError', 'DELEGATION_CHAIN_NOT_ALLOWED'],
  ['AgentKeyBudgetExhaustedError', 'AGENT_KEY_BUDGET_EXHAUSTED'],
  ['DailyLimitExceededError', 'DAILY_LIMIT'],
  ['AgentKeyInactiveError', 'KEY_INACTIVE'],
  ['AgentKeyNotFoundError', 'KEY_NOT_FOUND'],
  ['DelegationNotFoundError', 'DELEGATION_NOT_FOUND'],
  ['SessionTokenInvalidError', 'SESSION_TOKEN_INVALID'],
  ['SessionExpiredError', 'SESSION_EXPIRED'],
  ['SessionBudgetExhaustedError', 'SESSION_BUDGET_EXHAUSTED'],
  ['DestCapExceededError', 'DEST_CAP_EXCEEDED'],
  ['SessionNotAllowedError', 'SESSION_NOT_ALLOWED'],
  ['SessionNotFoundError', 'SESSION_NOT_FOUND'],
  ['SignatureRequiredError', 'SIGNATURE_REQUIRED'],
  ['SignatureInvalidError', 'SIGNATURE_INVALID'],
  ['NonceReplayError', 'NONCE_REPLAY'],
  ['TimestampExpiredError', 'TIMESTAMP_EXPIRED'],
  ['SigningSecretNotSetError', 'SIGNING_SECRET_NOT_SET'],
];

type ErrorCtor = new () => Error & { code: string };

describe('security error classes — contract (P2-7)', () => {
  it('every documented error class is exported by the module', () => {
    for (const [className] of ERROR_CONTRACT) {
      expect(
        (errors as Record<string, unknown>)[className],
        `missing export: ${className}`,
      ).toBeTypeOf('function');
    }
  });

  it('the contract table covers EVERY exported error class (no drift)', () => {
    const exportedErrorClasses = Object.entries(errors)
      .filter(
        ([, v]) =>
          typeof v === 'function' &&
          // heuristic: a class whose prototype chains to Error
          (v as { prototype?: unknown }).prototype instanceof Error,
      )
      .map(([name]) => name)
      .sort();

    const documented = ERROR_CONTRACT.map(([name]) => name).sort();
    // Si alguien agrega una error class nueva y olvida documentarla acá, falla.
    expect(documented).toEqual(exportedErrorClasses);
  });

  for (const [className, expectedCode] of ERROR_CONTRACT) {
    describe(className, () => {
      const Ctor = (errors as Record<string, unknown>)[className] as ErrorCtor;
      const instance = new Ctor();

      it('extends Error (error-boundary catchable)', () => {
        expect(instance).toBeInstanceOf(Error);
      });

      it('exposes the documented .code literal', () => {
        expect(instance.code).toBe(expectedCode);
      });

      it('.name equals the class name (legible logging)', () => {
        expect(instance.name).toBe(className);
      });

      it('.message is a non-empty string', () => {
        expect(typeof instance.message).toBe('string');
        expect(instance.message.length).toBeGreaterThan(0);
      });

      it('is throwable and recoverable via instanceof', () => {
        expect(() => {
          throw new Ctor();
        }).toThrow(Ctor);
      });
    });
  }
});

// ── logOwnershipMismatch — PII-safe logging (no leak en claro) ──
describe('logOwnershipMismatch — PII-safe (P2-7)', () => {
  it('positional form (legacy WKH-53) hashes keyId + ownerId, never logs raw', () => {
    const warnings: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      logOwnershipMismatch('getBalance', 'secret-key-id', 'secret-owner');
    } finally {
      console.warn = orig;
    }

    expect(warnings).toHaveLength(1);
    const payload = warnings[0][1] as Record<string, unknown>;
    expect(payload.op).toBe('getBalance');
    // El id/owner crudos NUNCA aparecen — solo su hash truncado.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('secret-key-id');
    expect(serialized).not.toContain('secret-owner');
    expect(typeof payload.keyIdHash).toBe('string');
    expect(typeof payload.ownerIdHash).toBe('string');
  });

  it('object form (WKH-63) hashes resource + caller, includes actualOwnerRef hash when given', () => {
    const warnings: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      logOwnershipMismatch({
        op: 'registryUpdate',
        resourceId: 'reg-secret',
        callerOwnerRef: 'caller-secret',
        actualOwnerRef: 'actual-secret',
      });
    } finally {
      console.warn = orig;
    }

    const payload = warnings[0][1] as Record<string, unknown>;
    expect(payload.op).toBe('registryUpdate');
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('reg-secret');
    expect(serialized).not.toContain('caller-secret');
    expect(serialized).not.toContain('actual-secret');
    expect(typeof payload.resourceIdHash).toBe('string');
    expect(typeof payload.callerOwnerRefHash).toBe('string');
    expect(typeof payload.actualOwnerRefHash).toBe('string');
  });

  it('object form omits actualOwnerRefHash when actualOwnerRef is absent', () => {
    const warnings: unknown[][] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      logOwnershipMismatch({
        op: 'delegationRevoke',
        resourceId: 'del-1',
        callerOwnerRef: 'owner-1',
      });
    } finally {
      console.warn = orig;
    }

    const payload = warnings[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('actualOwnerRefHash');
  });
});
