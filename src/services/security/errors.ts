/**
 * Security Errors — WKH-53
 *
 * Central tipo de error para ownership guards en app-layer.
 * PROHIBIDO lanzar new Error('...') genérico en paths de ownership (CD-A2).
 */
import crypto from 'node:crypto';
import { getLogger } from '../../lib/logger.js';

const log = getLogger('security');

export class OwnershipMismatchError extends Error {
  readonly code = 'OWNERSHIP_MISMATCH' as const;
  constructor() {
    super('Ownership mismatch');
    this.name = 'OwnershipMismatchError';
  }
}

/**
 * WKH-35 (CD-2): deposit replay guard. Lanzado por budgetService.registerDeposit
 * cuando la PG fn v2 detecta unique_violation sobre (chain_id, tx_hash) y hace
 * `RAISE EXCEPTION 'DEPOSIT_ALREADY_CREDITED'`. El mismo (chain, tx) jamás se
 * acredita dos veces.
 */
export class DepositAlreadyCreditedError extends Error {
  readonly code = 'DEPOSIT_ALREADY_CREDITED' as const;
  constructor() {
    super('Deposit already credited');
    this.name = 'DepositAlreadyCreditedError';
  }
}

/**
 * WKH-35 FIX-1 (BLQ-MED-1): funding-wallet binding errors.
 *
 * The deposit treasury is shared, so validating only `Transfer.to` lets an
 * attacker front-run another caller's txHash and claim the deposit. To close
 * the hijack a caller must first bind a funding wallet (with proof of control)
 * and every credited deposit must originate from that wallet.
 */

/** Signature did not recover to the claimed wallet → 403. */
export class FundingWalletProofInvalidError extends Error {
  readonly code = 'FUNDING_WALLET_PROOF_INVALID' as const;
  constructor() {
    super('Funding wallet proof of control is invalid');
    this.name = 'FundingWalletProofInvalidError';
  }
}

/** Wallet already bound to a (possibly other) key → 409. */
export class FundingWalletAlreadyBoundError extends Error {
  readonly code = 'FUNDING_WALLET_ALREADY_BOUND' as const;
  constructor() {
    super('Funding wallet is already bound to a key');
    this.name = 'FundingWalletAlreadyBoundError';
  }
}

/** /deposit attempted before binding a funding wallet → 403, cero crédito. */
export class FundingWalletNotBoundError extends Error {
  readonly code = 'FUNDING_WALLET_NOT_BOUND' as const;
  constructor() {
    super('No funding wallet bound to this key');
    this.name = 'FundingWalletNotBoundError';
  }
}

/** Depositor (Transfer.from) != bound funding wallet → 403, cero crédito. */
export class FundingWalletMismatchError extends Error {
  readonly code = 'FUNDING_WALLET_MISMATCH' as const;
  constructor() {
    super('Depositor does not match the bound funding wallet');
    this.name = 'FundingWalletMismatchError';
  }
}

/**
 * WKH-100: ERC-8004 identity binding errors (Fase 1).
 *
 * Estas error classes son un vehículo opcional — el handler puede mapear los
 * `reason` del reader directamente a status+error_code sin lanzarlas. Se crean
 * para consistencia con el codebase y reuso en tests.
 */

/** El AgentID ya está bindeado para esta key/chain → 409. */
export class Erc8004AlreadyBoundError extends Error {
  readonly code = 'ERC8004_ALREADY_BOUND' as const;
  constructor() {
    super('ERC-8004 identity already bound');
    this.name = 'Erc8004AlreadyBoundError';
  }
}

/** `ownerOf`/`tokenURI` revierte (token inexistente) → 404. */
export class Erc8004TokenNotFoundError extends Error {
  readonly code = 'ERC8004_TOKEN_NOT_FOUND' as const;
  constructor() {
    super('ERC-8004 token not found');
    this.name = 'Erc8004TokenNotFoundError';
  }
}

/** `getChainId()` del RPC != chainId esperado de la red → 502. */
export class Erc8004ChainMismatchError extends Error {
  readonly code = 'ERC8004_CHAIN_MISMATCH' as const;
  constructor() {
    super('ERC-8004 chain mismatch');
    this.name = 'Erc8004ChainMismatchError';
  }
}

/** `ownerOf(tokenId) != funding_wallet` → 403, sin write. */
export class IdentityOwnershipMismatchError extends Error {
  readonly code = 'IDENTITY_OWNERSHIP_MISMATCH' as const;
  constructor() {
    super('ownerOf does not match funding_wallet');
    this.name = 'IdentityOwnershipMismatchError';
  }
}

/**
 * WKH-100 FIX-PACK (BLQ-MED-1 / DT-21.6): the same ERC-8004 `token_id`+`chain_id`
 * is already bound to ANOTHER active key → 409. Closes the spoofing-by-poisoning
 * residual: a token can back the verified badge of at most one active key.
 * Same pattern as `FundingWalletAlreadyBoundError`.
 */
export class Erc8004TokenAlreadyBoundError extends Error {
  readonly code = 'ERC8004_TOKEN_ALREADY_BOUND' as const;
  constructor() {
    super('ERC-8004 token already bound to another active key');
    this.name = 'Erc8004TokenAlreadyBoundError';
  }
}

/**
 * WKH-101 (Fase 2): EIP-712 delegation / session-key errors.
 *
 * Mapeo error_code ↔ HTTP en routes/middleware (story §4). Las clases siguen el
 * patrón `readonly code = '...' as const` + `name` para que el caller pueda
 * mapear vía `instanceof` sin string-matching. `FundingWalletNotBoundError` YA
 * existe (L59) y se reusa (AC-2) — no se duplica.
 */

/** recover != funding_wallet (case-insensitive), domain divergente o recover falla → 403. */
export class DelegationSignerMismatchError extends Error {
  readonly code = 'DELEGATION_SIGNER_MISMATCH' as const;
  constructor() {
    super('Delegation signer does not match funding wallet');
    this.name = 'DelegationSignerMismatchError';
  }
}

/** `(key_id, nonce)` ya existe → 409 (23505 mapeado). */
export class DelegationNonceReplayError extends Error {
  readonly code = 'DELEGATION_NONCE_REPLAY' as const;
  constructor() {
    super('Delegation nonce already used');
    this.name = 'DelegationNonceReplayError';
  }
}

/** `revoked_at IS NOT NULL` → 403. */
export class DelegationRevokedError extends Error {
  readonly code = 'DELEGATION_REVOKED' as const;
  constructor() {
    super('Delegation has been revoked');
    this.name = 'DelegationRevokedError';
  }
}

/** `now() >= expires_at` → 403. */
export class DelegationExpiredError extends Error {
  readonly code = 'DELEGATION_EXPIRED' as const;
  constructor() {
    super('Delegation has expired');
    this.name = 'DelegationExpiredError';
  }
}

/** `stepCost > max_amount_per_tx` POR STEP → 403. */
export class DelegationTxLimitExceededError extends Error {
  readonly code = 'DELEGATION_TX_LIMIT_EXCEEDED' as const;
  constructor() {
    super('Per-transaction limit exceeded');
    this.name = 'DelegationTxLimitExceededError';
  }
}

/** `total_spent + amount > max_total` → 403 (raised by RPC bajo lock). */
export class DelegationTotalLimitExceededError extends Error {
  readonly code = 'DELEGATION_TOTAL_LIMIT_EXCEEDED' as const;
  constructor() {
    super('Total delegation budget exceeded');
    this.name = 'DelegationTotalLimitExceededError';
  }
}

/** token autenticador es `wasi_a2a_session_*` → 403 (CD-9 sin sub-delegación). */
export class DelegationNotAllowedError extends Error {
  readonly code = 'DELEGATION_NOT_ALLOWED' as const;
  constructor() {
    super('Sub-delegation is not allowed');
    this.name = 'DelegationNotAllowedError';
  }
}

/** `lookupByTokenHash` → null → 401. */
export class InvalidSessionTokenError extends Error {
  readonly code = 'INVALID_SESSION_TOKEN' as const;
  constructor() {
    super('Session token not found');
    this.name = 'InvalidSessionTokenError';
  }
}

/** `allowed_chains` no vacío y `chainId ∉ allowed_chains` → 403 (DT-3). */
export class DelegationChainNotAllowedError extends Error {
  readonly code = 'DELEGATION_CHAIN_NOT_ALLOWED' as const;
  constructor() {
    super('Chain not in delegation allowed_chains');
    this.name = 'DelegationChainNotAllowedError';
  }
}

/** parent budget[chainId] insuficiente (INSUFFICIENT_BUDGET del RPC) → 403. */
export class AgentKeyBudgetExhaustedError extends Error {
  readonly code = 'AGENT_KEY_BUDGET_EXHAUSTED' as const;
  constructor() {
    super('Parent agent key budget exhausted');
    this.name = 'AgentKeyBudgetExhaustedError';
  }
}

/** RPC `INVALID_AMOUNT` (importe de débito NULL / negativo / NaN) → 400/input error. */
export class InvalidDebitAmountError extends Error {
  readonly code = 'DEBIT_INVALID_AMOUNT' as const;
  constructor() {
    super('Debit amount must be a non-negative number');
    this.name = 'InvalidDebitAmountError';
  }
}

/**
 * WKH-101 FIX-PACK (AR-MNR-1 / AR-MNR-2): error classes para los prefijos del
 * RPC chain `debit_delegation_and_parent` → `increment_a2a_key_spend` que antes
 * caían en el fallback `throw new Error('Failed to debit delegation: <raw PG>')`
 * y resultaban en 503 + leak del mensaje crudo de Postgres al body del cliente.
 * Todos mapean a 403 (límites de la parent key bajo delegación).
 */

/** RPC `DAILY_LIMIT` (parent key daily cap) bajo delegación → 403. */
export class DailyLimitExceededError extends Error {
  readonly code = 'DAILY_LIMIT' as const;
  constructor() {
    super('Daily spending limit exceeded');
    this.name = 'DailyLimitExceededError';
  }
}

/** RPC `KEY_INACTIVE` (parent key deactivated) bajo delegación → 403. */
export class AgentKeyInactiveError extends Error {
  readonly code = 'KEY_INACTIVE' as const;
  constructor() {
    super('Parent agent key is inactive');
    this.name = 'AgentKeyInactiveError';
  }
}

/** RPC `KEY_NOT_FOUND` (parent key inexistente) bajo delegación → 403. */
export class AgentKeyNotFoundError extends Error {
  readonly code = 'KEY_NOT_FOUND' as const;
  constructor() {
    super('Parent agent key not found');
    this.name = 'AgentKeyNotFoundError';
  }
}

/** RPC `DELEGATION_NOT_FOUND` (delegación inexistente bajo lock) → 403. */
export class DelegationNotFoundError extends Error {
  readonly code = 'DELEGATION_NOT_FOUND' as const;
  constructor() {
    super('Delegation not found');
    this.name = 'DelegationNotFoundError';
  }
}

/**
 * WKH-121 (Fase server-side): key-session errors (sin EIP-712).
 *
 * Mapeo error_code ↔ HTTP en routes/middleware (story §Contrato). Las clases
 * siguen el patrón `readonly code = '...' as const` + `name`. `OwnershipMismatchError`
 * (L9) y `AgentKey*`/`DailyLimitExceededError` (L225+) YA existen y se reusan.
 */

/** `lookupByTokenHash` → null, o RPC `SESSION_NOT_FOUND`/`SESSION_REVOKED` → 401/403. */
export class SessionTokenInvalidError extends Error {
  readonly code = 'SESSION_TOKEN_INVALID' as const;
  constructor() {
    super('Session token not found or invalid');
    this.name = 'SessionTokenInvalidError';
  }
}

/** `now() >= session.expires_at` → 403. */
export class SessionExpiredError extends Error {
  readonly code = 'SESSION_EXPIRED' as const;
  constructor() {
    super('Session has expired');
    this.name = 'SessionExpiredError';
  }
}

/** `spent + amount > max_budget_usd` → 403 (raised by RPC bajo lock). */
export class SessionBudgetExhaustedError extends Error {
  readonly code = 'SESSION_BUDGET_EXHAUSTED' as const;
  constructor() {
    super('Session budget exhausted');
    this.name = 'SessionBudgetExhaustedError';
  }
}

/**
 * WKH-125 (AC-2): el acumulado por destino en la ventana + el monto excedería
 * `max_usd` de la política → HTTP **402** (raised by RPC `debit_with_dest_policy`
 * bajo lock). El budget de la key NO se decrementa (rollback de la tx).
 */
export class DestCapExceededError extends Error {
  readonly code = 'DEST_CAP_EXCEEDED' as const;
  constructor() {
    super('Destination spend cap exceeded');
    this.name = 'DestCapExceededError';
  }
}

/** token autenticador es `wasi_a2a_sess_*` → 403 (CD sin sub-delegación, AC-12). */
export class SessionNotAllowedError extends Error {
  readonly code = 'SESSION_NOT_ALLOWED' as const;
  constructor() {
    super('Sub-delegation is not allowed');
    this.name = 'SessionNotAllowedError';
  }
}

/** session_id inexistente o de otro owner → 404 disclosure-safe (WKH-122, AC-3). */
export class SessionNotFoundError extends Error {
  readonly code = 'SESSION_NOT_FOUND' as const;
  constructor() {
    super('Key session not found');
    this.name = 'SessionNotFoundError';
  }
}

/**
 * WKH-123 (signed auth): per-request signature errors. Mapeo error_code ↔ HTTP
 * en el middleware (story §Contrato). Patrón `readonly code = '...' as const` +
 * `name`. `FundingWalletNotBoundError` (L59) YA existe y se reusa (AC-9).
 */

/** `require_signature:true` y falta `x-a2a-signature` → 401. */
export class SignatureRequiredError extends Error {
  readonly code = 'SIGNATURE_REQUIRED' as const;
  constructor() {
    super('Request signature is required');
    this.name = 'SignatureRequiredError';
  }
}

/** firma presente pero recover≠funding_wallet (master) o HMAC no coincide → 401. */
export class SignatureInvalidError extends Error {
  readonly code = 'SIGNATURE_INVALID' as const;
  constructor() {
    super('Request signature is invalid');
    this.name = 'SignatureInvalidError';
  }
}

/** nonce ya visto para ese token dentro del TTL → 401. */
export class NonceReplayError extends Error {
  readonly code = 'NONCE_REPLAY' as const;
  constructor() {
    super('Signed-auth nonce already used');
    this.name = 'NonceReplayError';
  }
}

/** `x-a2a-timestamp` fuera de `±SIGNED_AUTH_CLOCK_SKEW_SECONDS` → 401. */
export class TimestampExpiredError extends Error {
  readonly code = 'TIMESTAMP_EXPIRED' as const;
  constructor() {
    super('Request timestamp expired or out of window');
    this.name = 'TimestampExpiredError';
  }
}

/** `require_signature:true` en una sesión sin `signing_secret_hash` → 400. */
export class SigningSecretNotSetError extends Error {
  readonly code = 'SIGNING_SECRET_NOT_SET' as const;
  constructor() {
    super('Signing secret is not set for this session');
    this.name = 'SigningSecretNotSetError';
  }
}

/**
 * Operación que detectó el mismatch (PII-safe enum).
 * - `getBalance` / `deactivate`: ownership sobre `a2a_agent_keys` (WKH-53).
 * - `registryUpdate` / `registryDelete`: ownership sobre `registries` (WKH-63).
 * - `agentPublishUpdate` / `agentPublishDelete`: ownership sobre `a2a_agents` (WKH-134).
 * - `delegationRevoke` / `delegationList`: ownership sobre `a2a_delegations` (WKH-101).
 * - `keySessionRevoke` / `keySessionList`: ownership sobre `a2a_key_sessions` (WKH-121).
 * - `requireSignature`: ownership sobre `a2a_agent_keys`/`a2a_key_sessions` (WKH-123).
 */
export type OwnershipOp =
  | 'getBalance'
  | 'deactivate'
  | 'registryUpdate'
  | 'registryDelete'
  | 'agentPublishUpdate'
  | 'agentPublishDelete'
  | 'delegationRevoke'
  | 'delegationList'
  | 'keySessionRevoke'
  | 'keySessionList'
  | 'requireSignature'
  | 'spendPolicySet'
  | 'spendPolicyList'
  | 'spendPolicyDelete';

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
    log.warn(
      {
        op: opOrArgs,
        keyIdHash: hash(keyId ?? ''),
        ownerIdHash: hash(ownerId ?? ''),
        ts: new Date().toISOString(),
      },
      'ownership mismatch',
    );
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
  log.warn(payload, 'ownership mismatch');
}
