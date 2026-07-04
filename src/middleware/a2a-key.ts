/**
 * A2A Key Middleware — Fastify preHandler hook
 * WKH-34-W4: Agentic Economy L3
 *
 * When x-a2a-key header is present: hash -> lookup -> validate -> debit -> execute.
 * When absent: delegate to existing x402 requirePayment() flow.
 */
import crypto from 'node:crypto';
import type {
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify';
import { resolveChainKey } from '../adapters/chain-resolver.js';
import {
  getAdaptersBundle,
  getDefaultChainKey,
  getInitializedChainKeys,
} from '../adapters/registry.js';
import type { ChainKey } from '../adapters/types.js';
import { getLogger } from '../lib/logger.js';
import { PLACEHOLDER_FEE_USD } from '../lib/pricing-constants.js';
import { budgetService } from '../services/budget.js';
import {
  delegationService,
  exceedsPerTxLimit,
} from '../services/delegation.js';
import { identityService, isIdentityVerified } from '../services/identity.js';
import { keySessionService } from '../services/key-session.js';
import { receiptService } from '../services/receipt.js';
import {
  AgentKeyBudgetExhaustedError,
  AgentKeyInactiveError,
  AgentKeyNotFoundError,
  DailyLimitExceededError,
  DelegationExpiredError,
  DelegationNotFoundError,
  DelegationRevokedError,
  DelegationTotalLimitExceededError,
  DestCapExceededError,
  OwnershipMismatchError,
  SessionBudgetExhaustedError,
  SessionExpiredError,
  SessionTokenInvalidError,
} from '../services/security/errors.js';
import { verifySignedAuth } from '../services/signed-auth.js';
import type {
  A2AAgentKeyRow,
  DelegationDebitContext,
  DelegationRow,
  KeySessionDebitContext,
  KeySessionRow,
  SignedAuthErrorCode,
  SignedAuthHeaders,
} from '../types/index.js';
import { type PaymentMiddlewareOptions, requirePayment } from './x402.js';

const log = getLogger('a2a-key');

// ── Fastify augmentation (CD-2: no any) ────────────────────

declare module 'fastify' {
  interface FastifyRequest {
    a2aKeyRow?: A2AAgentKeyRow;
    gaslessEstimatedCostUsd?: number; // WKH-59
    gaslessChainKey?: ChainKey; // WKH-138 (gasless multichain) — resuelto una vez en preHandler A

    composeEstimatedCostUsd?: number; // WKH-59 (real-price-debit) — CD-9
    composeDestination?: string | undefined; // WKH-125 (cap por destino del step 0)
    resolvedChainId?: number; // WKH-59 (real-price-debit) DT-D
    delegationRow?: DelegationRow; // WKH-101
    delegationContext?: DelegationDebitContext; // WKH-101 DT-11 (débito per-step)
    keySessionRow?: KeySessionRow; // WKH-121
    keySessionContext?: KeySessionDebitContext; // WKH-121 (débito per-step)
    skipMiddlewareDebit?: boolean; // WKH-127: orchestrate debita post-plan en el service
  }
}

// ── Error codes for 403 responses ──────────────────────────

type A2AKeyMiddlewareErrorCode =
  | 'KEY_NOT_FOUND'
  | 'KEY_INACTIVE'
  | 'DAILY_LIMIT'
  | 'INSUFFICIENT_BUDGET'
  | 'PER_CALL_LIMIT'
  | 'CHAIN_NOT_SUPPORTED';
// TD-sprint-security WKH-61 MNR-2: 'SCOPE_DENIED' removed from this union.
// Scope enforcement moved to composeService.compose post-resolveAgent
// (see doc/sdd/059-wkh-61-sec-scope-1/); the middleware never emits it.

function send403(
  reply: FastifyReply,
  code: A2AKeyMiddlewareErrorCode,
  message: string,
) {
  return reply.status(403).send({ error: message, error_code: code });
}

// ── WKH-101: delegation 403/401 error codes (branch session) ───

type DelegationMiddlewareErrorCode =
  | 'DELEGATION_REVOKED'
  | 'DELEGATION_EXPIRED'
  | 'DELEGATION_TX_LIMIT_EXCEEDED'
  | 'DELEGATION_TOTAL_LIMIT_EXCEEDED'
  | 'AGENT_KEY_BUDGET_EXHAUSTED'
  | 'DELEGATION_CHAIN_NOT_ALLOWED'
  | 'OWNERSHIP_MISMATCH'
  | 'KEY_INACTIVE'
  // AR-MNR-1: límites del parent RPC bajo delegación (antes caían en 503).
  | 'DAILY_LIMIT'
  | 'KEY_NOT_FOUND'
  | 'DELEGATION_NOT_FOUND';

function send403delegation(
  reply: FastifyReply,
  code: DelegationMiddlewareErrorCode,
  message: string,
) {
  return reply.status(403).send({ error: message, error_code: code });
}

// ── WKH-121: key-session 403 error codes (branch sess) ─────────

type KeySessionMiddlewareErrorCode =
  | 'SESSION_EXPIRED'
  | 'KEY_INACTIVE'
  | 'SESSION_BUDGET_EXHAUSTED'
  | 'AGENT_KEY_BUDGET_EXHAUSTED'
  | 'OWNERSHIP_MISMATCH'
  | 'SESSION_TOKEN_INVALID'
  // prefijos del parent RPC bajo sesión (increment_a2a_key_spend).
  | 'DAILY_LIMIT'
  | 'KEY_NOT_FOUND';

function send403session(
  reply: FastifyReply,
  code: KeySessionMiddlewareErrorCode,
  message: string,
) {
  return reply.status(403).send({ error: message, error_code: code });
}

// ── WKH-123: signed-auth helpers (per-request signature, opt-in) ─

/**
 * Mapea un `SignedAuthErrorCode` al HTTP correcto: 403 para
 * `FUNDING_WALLET_NOT_BOUND` (AC-9), 401 para el resto (AC-3..AC-6).
 */
function sendSignedAuthError(
  reply: FastifyReply,
  code: SignedAuthErrorCode,
): FastifyReply {
  const status = code === 'FUNDING_WALLET_NOT_BOUND' ? 403 : 401;
  return reply.status(status).send({ error_code: code });
}

/**
 * Extrae los 3 headers de firma del request. NUNCA loguea sus valores (CD-5).
 * Ausencia → campos undefined (back-compat bearer si require_signature:false).
 */
function extractSignedHeaders(request: FastifyRequest): SignedAuthHeaders {
  const pick = (h: string | string[] | undefined): string | undefined =>
    typeof h === 'string' ? h : undefined;
  return {
    signature: pick(request.headers['x-a2a-signature']),
    nonce: pick(request.headers['x-a2a-nonce']),
    timestamp: pick(request.headers['x-a2a-timestamp']),
  };
}

// ── x402 delegation helper ─────────────────────────────────

async function runX402Fallback(
  x402Handlers: ReturnType<typeof requirePayment>,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  for (const h of x402Handlers) {
    // x402 handlers are typed as sync (preHandlerHookHandler) but implemented
    // as async. We call them with a done callback AND await the potential promise.
    await new Promise<void>((resolve, reject) => {
      try {
        // Cast to extract the actual return value, which may be a Promise
        const maybePromise = h.call(
          request.server,
          request,
          reply,
          (err?: Error) => {
            if (err) reject(err);
            else resolve();
          },
        ) as unknown;
        // If the handler is actually async, it returns a Promise
        if (maybePromise instanceof Promise) {
          maybePromise.then(() => resolve(), reject);
        }
      } catch (err) {
        reject(err);
      }
    });
    if (reply.sent) return;
  }
}

// ── WKH-101: chain resolution helper (branch session) ─────────
// Replica EXACTA del bloque master (a2a-key.ts §6). Se mantiene en sync con
// ese bloque (no se refactoriza el master para no arriesgar CD-5 backward-compat).
// Devuelve null si ya envió una respuesta de error (reply.sent).
function resolveTargetChain(
  request: FastifyRequest,
  reply: FastifyReply,
): { chainId: number; chainKey: string; assetSymbol: string } | null {
  const headerRaw = request.headers['x-payment-chain'];
  const headerOverride = typeof headerRaw === 'string' ? headerRaw : undefined;
  const defaultChainKey = getDefaultChainKey();

  let chainKey = resolveChainKey({ headerOverride });
  if (!chainKey) {
    if (headerOverride !== undefined) {
      reply.status(400).send({
        error_code: 'CHAIN_NOT_SUPPORTED',
        error: `Chain '${headerOverride}' is not a recognized slug or chainId`,
      });
      return null;
    }
    chainKey = defaultChainKey ?? undefined;
    if (!chainKey) {
      reply.status(500).send({
        error_code: 'REGISTRY_NOT_INITIALIZED',
        error: 'No chains initialized in registry',
      });
      return null;
    }
  }

  const bundle = getAdaptersBundle(chainKey);
  if (!bundle) {
    reply.status(400).send({
      error_code: 'CHAIN_NOT_SUPPORTED',
      error: `Chain '${chainKey}' is not initialized. Initialized: ${getInitializedChainKeys().join(', ')}`,
    });
    return null;
  }

  const chainId = bundle.chainConfig.chainId;
  const assetSymbol = bundle.payment.supportedTokens[0]?.symbol ?? 'UNKNOWN';
  return { chainId, chainKey, assetSymbol };
}

// ── Auth credential extraction ──────────────────────────────
// DT-2 (WKH-BEARER-AUTH): Priority order: x-a2a-key > Bearer wasi_a2a_* > x402.
// Devuelve el raw token a2a o undefined (→ fallback x402). Sin side effects.
// C2 (audit 2026-07-01): exported so route handlers derive the a2a credential
// with the SAME logic the auth middleware uses (x-a2a-key OR Bearer
// wasi_a2a_*). Reading only `x-a2a-key` at the route made a Bearer-authenticated
// caller look un-keyed to compose (a2aKey=undefined), wrongly triggering the
// operator-signed EIP-3009 branch (C2 operator-wallet drain).
export function extractRawKey(request: FastifyRequest): string | undefined {
  const headerKey = request.headers['x-a2a-key'];
  if (headerKey && typeof headerKey === 'string') {
    return headerKey;
  }
  // Check Authorization: Bearer wasi_a2a_* (DT-1/DT-3: case-insensitive scheme, case-sensitive prefix)
  const authHeader = request.headers.authorization;
  if (authHeader && typeof authHeader === 'string') {
    const match = /^bearer\s+(.+)$/i.exec(authHeader);
    if (match?.[1]?.startsWith('wasi_a2a_')) {
      return match[1];
    }
  }
  return undefined;
}

// WKH-59: rutas que mueven valor on-chain (POST /gasless/transfer) inyectan
// el costo real vía request.gaslessEstimatedCostUsd desde un preHandler
// upstream. WKH-59 (real-price-debit): /compose inyecta el precio real del
// primer step vía request.composeEstimatedCostUsd. El resto de las rutas
// siguen con $1 placeholder (backward-compat).
// CD-7: el middleware NO lee request.body — solo campos augmentados.
// CD-9: composeEstimatedCostUsd y gaslessEstimatedCostUsd son distintos.
// DT-F: orden compose-first (rutas mutuamente excluyentes, sin colisión real).
function resolveEstimatedCostUsd(request: FastifyRequest): number {
  return typeof request.composeEstimatedCostUsd === 'number'
    ? request.composeEstimatedCostUsd
    : typeof request.gaslessEstimatedCostUsd === 'number'
      ? request.gaslessEstimatedCostUsd
      : PLACEHOLDER_FEE_USD;
}

// ── BRANCH DELEGACIÓN (WKH-101) ──────────────────────────────
// El regex Bearer YA captura wasi_a2a_session_* (empieza con wasi_a2a_).
// El branch va DESPUÉS de extraer rawKey + estimatedCostUsd y ANTES de la
// resolución master-key. El path master (CD-5) queda intacto.
// Self-terminating: siempre responde o augmenta request + return (void).
async function resolveDelegationAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  rawKey: string,
  estimatedCostUsd: number,
): Promise<unknown> {
  try {
    // 1. lookup por hash (AC-5)
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const delegation = await delegationService.lookupByTokenHash(hash);
    if (!delegation) {
      return reply.status(401).send({
        error: 'Session token not found',
        error_code: 'INVALID_SESSION_TOKEN',
      });
    }

    // 2. revoked / expired (AC-6) — pre-debit (re-chequeado bajo lock, CD-10)
    if (delegation.revoked_at !== null) {
      return send403delegation(
        reply,
        'DELEGATION_REVOKED',
        'Delegation has been revoked',
      );
    }
    if (Date.now() >= new Date(delegation.expires_at).getTime()) {
      return send403delegation(
        reply,
        'DELEGATION_EXPIRED',
        'Delegation has expired',
      );
    }

    // 3. cargar parent key (DT-9)
    const parentKey = await delegationService.getParentKey(delegation.key_id);
    if (!parentKey?.is_active) {
      return send403delegation(
        reply,
        'KEY_INACTIVE',
        'Parent agent key is inactive',
      );
    }

    // 4. resolver chain/bundle → chainId (REUSO del bloque master).
    const chain = resolveTargetChain(request, reply);
    if (!chain) return; // resolveTargetChain ya envió la respuesta de error
    const { chainId, chainKey, assetSymbol } = chain;
    request.resolvedChainId = chainId;

    // 5. DT-3 allowed_chains: vacío = SIN restricción (paridad master keys).
    //    Solo restringe si tiene elementos Y el chainId resuelto NO está.
    if (
      delegation.policy.allowed_chains.length > 0 &&
      !delegation.policy.allowed_chains.includes(chainId)
    ) {
      return send403delegation(
        reply,
        'DELEGATION_CHAIN_NOT_ALLOWED',
        `chain ${chainId} not in delegation allowed_chains`,
      );
    }

    // H1 (audit 2026-07-01): respect `skipMiddlewareDebit` exactly like the
    // master path (resolveMasterAuth §7). Routes that bill the REAL cost
    // post-plan in the service (all `/orchestrate*` routes set the flag) MUST
    // NOT be charged the flat `PLACEHOLDER_FEE_USD` ($1) step-0 debit here.
    // Before this fix, delegation callers were debited $1 unconditionally on
    // EVERY `/orchestrate`, `/orchestrate/plan` (a documented zero-debit quote)
    // and `/orchestrate/execute` and NEVER refunded on `no_agents` /
    // `no_relevant_agent` / `insufficient_funds` / pipeline failure — a
    // guaranteed, repeatable $1/call drain of the parent budget + delegation
    // `total_spent`.
    //
    // TRADE-OFF (documented for review): with the flag set, the delegation
    // step-0 is not billed by ANY layer for `/orchestrate*` (the service's
    // post-plan debit is gated on `billingKeyRow`, which excludes
    // delegation/session), so orchestrate step-0 becomes non-billed for
    // delegation callers (steps 1..N are still billed by compose via
    // `delegationContext`). This fails SAFE (never over-charges) and mirrors the
    // `/orchestrate/plan` zero-debit contract. Extending the service to bill
    // delegation/session step-0 post-plan is left as a follow-up. On `/compose`
    // (flag unset) the real-price step-0 debit + refund path is unchanged.
    if (!request.skipMiddlewareDebit) {
      // 6. AC-7 per-tx del STEP 0 (antes de debitar).
      if (
        exceedsPerTxLimit(delegation.policy.max_amount_per_tx, estimatedCostUsd)
      ) {
        return send403delegation(
          reply,
          'DELEGATION_TX_LIMIT_EXCEEDED',
          'Estimated cost exceeds per-transaction limit',
        );
      }

      // 7. AC-8/AC-9 débito ATÓMICO del STEP 0 (CD-12).
      request.log.info(
        { delegationId: delegation.id, chainKey, chainId, assetSymbol },
        'a2a-key.delegation.debit',
      );
      try {
        // WKH-125b: la delegación hereda el cap por destino de la parent key. El
        // step-0 de un compose bajo delegación DEBE propagar `composeDestination`
        // (canonicalizado por routes/compose.ts:resolveComposePriceHandler) al RPC
        // debit_delegation_and_parent → debit_with_dest_policy. Sin esto el RPC
        // recibía p_destination=NULL y el cap por destino se evadía (bypass).
        // CONDICIONAL (espeja el branch session, CD-7): sólo con composeDestination
        // pasamos el 6º arg; si no, la llamada de 5 args queda INTACTA (back-compat).
        if (request.composeDestination) {
          await delegationService.debitDelegationAndParent(
            delegation.id,
            parentKey.owner_ref,
            parentKey.id,
            chainId,
            estimatedCostUsd,
            request.composeDestination,
          );
        } else {
          await delegationService.debitDelegationAndParent(
            delegation.id,
            parentKey.owner_ref,
            parentKey.id,
            chainId,
            estimatedCostUsd,
          );
        }
      } catch (debitErr) {
        // WKH-125b: cap por destino excedido bajo delegación → HTTP 402 (no 403),
        // espejando el branch session. El budget NO se decrementó (rollback de la tx).
        if (debitErr instanceof DestCapExceededError) {
          return reply.status(402).send({
            error: `chain ${chainId} destination cap exceeded`,
            error_code: 'DEST_CAP_EXCEEDED',
          });
        }
        if (debitErr instanceof DelegationTotalLimitExceededError) {
          return send403delegation(
            reply,
            'DELEGATION_TOTAL_LIMIT_EXCEEDED',
            'Total delegation budget exceeded',
          );
        }
        if (debitErr instanceof AgentKeyBudgetExhaustedError) {
          return send403delegation(
            reply,
            'AGENT_KEY_BUDGET_EXHAUSTED',
            'Parent agent key budget exhausted',
          );
        }
        if (debitErr instanceof DelegationRevokedError) {
          return send403delegation(
            reply,
            'DELEGATION_REVOKED',
            'Delegation has been revoked',
          );
        }
        if (debitErr instanceof DelegationExpiredError) {
          return send403delegation(
            reply,
            'DELEGATION_EXPIRED',
            'Delegation has expired',
          );
        }
        // AR-MNR-1: límites de la parent key bajo delegación → 403 semántico
        // (antes caían en `throw debitErr` → outer catch → 503 + leak PG).
        if (debitErr instanceof DailyLimitExceededError) {
          return send403delegation(
            reply,
            'DAILY_LIMIT',
            'Daily spending limit exceeded',
          );
        }
        if (debitErr instanceof AgentKeyInactiveError) {
          return send403delegation(
            reply,
            'KEY_INACTIVE',
            'Parent agent key is inactive',
          );
        }
        if (debitErr instanceof AgentKeyNotFoundError) {
          return send403delegation(
            reply,
            'KEY_NOT_FOUND',
            'Parent agent key not found',
          );
        }
        if (debitErr instanceof DelegationNotFoundError) {
          return send403delegation(
            reply,
            'DELEGATION_NOT_FOUND',
            'Delegation not found',
          );
        }
        if (debitErr instanceof OwnershipMismatchError) {
          return send403delegation(
            reply,
            'OWNERSHIP_MISMATCH',
            'Delegation ownership mismatch',
          );
        }
        throw debitErr; // unexpected → outer catch → 503
      }
    }

    // 8. augment + SET delegationContext para los steps 2..N (DT-11/DT-7).
    //    effectiveRow inyecta el scoping de la policy (allowed_*) para que
    //    composeService.compose aplique checkScoping sin tocar compose/authz.
    const effectiveRow: A2AAgentKeyRow = {
      ...parentKey,
      allowed_registries:
        delegation.policy.allowed_registries.length > 0
          ? delegation.policy.allowed_registries
          : null,
      allowed_agent_slugs:
        delegation.policy.allowed_agent_slugs.length > 0
          ? delegation.policy.allowed_agent_slugs
          : null,
    };
    effectiveRow.erc8004_verified = isIdentityVerified(parentKey);
    request.a2aKeyRow = effectiveRow;
    request.delegationRow = delegation;
    request.delegationContext = {
      delegationId: delegation.id,
      ownerRef: parentKey.owner_ref,
      keyId: parentKey.id,
      maxAmountPerTx: delegation.policy.max_amount_per_tx,
    };

    // 9. remaining budget header (CD-12: mismo chainId del bundle).
    const remaining = await budgetService.getBalance(
      parentKey.id,
      chainId,
      parentKey.owner_ref,
    );
    reply.header('x-a2a-remaining-budget', remaining);
    return; // fin del branch — NO seguir al flujo master key
  } catch (err) {
    // log SIN token; 503 service error (igual que el catch master).
    request.log.error(
      { err: err instanceof Error ? err.message : 'unknown' },
      'a2a-key delegation branch error',
    );
    return reply.status(503).send({
      error: 'SERVICE_ERROR',
      message: 'Delegation service temporarily unavailable',
    });
  }
}

// ── KEY-SESSION (WKH-121) ────────────────────────────────────
// Server-side session keys (SIN EIP-712). Va DESPUÉS del branch WKH-101
// (wasi_a2a_session_*) y ANTES del path master. Los prefijos son mutuamente
// exclusivos: 'wasi_a2a_session_x'.startsWith('wasi_a2a_sess_') === false.
// Self-terminating: siempre responde o augmenta request + return (void).
async function resolveKeySessionAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  rawKey: string,
  estimatedCostUsd: number,
): Promise<unknown> {
  try {
    // 1. lookup por hash O(1) (AC-4/AC-5).
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const session = await keySessionService.lookupByTokenHash(hash);
    if (!session) {
      return reply.status(401).send({
        error: 'Session token not found',
        error_code: 'SESSION_TOKEN_INVALID',
      });
    }

    // 2. revoked / expired (AC-6) — pre-debit (re-chequeado bajo lock, DT-3).
    if (session.revoked_at !== null) {
      return send403session(
        reply,
        'SESSION_TOKEN_INVALID',
        'Session token has been revoked',
      );
    }
    if (Date.now() >= new Date(session.expires_at).getTime()) {
      return send403session(reply, 'SESSION_EXPIRED', 'Session has expired');
    }

    // 3. cargar parent key y verificar is_active (AC-7).
    const parentKey = await keySessionService.getParentKey(session.key_id);
    if (!parentKey?.is_active) {
      return send403session(
        reply,
        'KEY_INACTIVE',
        'Parent agent key is inactive',
      );
    }

    // 3b. WKH-123 (AC-2): per-request signature opt-in (HMAC-SHA256). Va
    //     DESPUÉS del lookup+is_active y ANTES del debit (CD-11). Si la
    //     sesión NO exige firma → flujo bearer idéntico al pre-WKH-123
    //     (headers de firma ignorados, CD-1/AC-7). El `hash` (L~470) es el
    //     token_hash; HMAC lo usa hex SIN 0x.
    if (session.require_signature === true) {
      const headers = extractSignedHeaders(request);
      if (
        typeof headers.signature !== 'string' ||
        headers.signature.length === 0
      ) {
        return reply.status(401).send({ error_code: 'SIGNATURE_REQUIRED' });
      }
      const signedResult = await verifySignedAuth({
        tokenHashHex: hash,
        method: request.method.toUpperCase(),
        path: request.url.split('?')[0] ?? request.url,
        headers,
        scheme: {
          kind: 'hmac',
          signingSecretHash: session.signing_secret_hash,
        },
      });
      if (!signedResult.ok) {
        return sendSignedAuthError(reply, signedResult.code);
      }
    }

    // 4. resolver chain/bundle → chainId (REUSO del bloque master).
    const chain = resolveTargetChain(request, reply);
    if (!chain) return; // resolveTargetChain ya envió la respuesta de error
    const { chainId, chainKey, assetSymbol } = chain;
    request.resolvedChainId = chainId;

    // 5. AC-8/AC-9 débito ATÓMICO del STEP 0 (sesión + parent).
    // H1 (audit 2026-07-01): respect `skipMiddlewareDebit` like resolveMasterAuth
    // §7. `/orchestrate*` routes bill the real cost post-plan in the service, so
    // the flat $1 placeholder step-0 debit here must be skipped — otherwise a
    // key-session caller was charged $1 on every orchestrate call (including the
    // zero-debit `/orchestrate/plan` quote) and never refunded. Same documented
    // trade-off as the delegation branch (orchestrate step-0 becomes non-billed
    // for session callers; steps 1..N still billed by compose via
    // `keySessionContext`; `/compose` real-price debit+refund unchanged).
    if (!request.skipMiddlewareDebit) {
      request.log.info(
        { sessionId: session.id, chainKey, chainId, assetSymbol },
        'a2a-key.session.debit',
      );
      try {
        // WKH-125 (AC-6 fix): la sesión hereda el cap por destino de la parent
        // key. El step-0 de un compose DEBE propagar `composeDestination`
        // (augmentado por routes/compose.ts:resolveComposePriceHandler) al RPC
        // `debit_session_and_parent` → `debit_with_dest_policy`. Sin esto el RPC
        // recibía `p_destination=NULL`, caía a `increment_a2a_key_spend` y el cap
        // por destino se evadía por completo (bypass del cap con session key).
        // CONDICIONAL (espeja el branch master, CD-8b): sólo cuando hay
        // `composeDestination` pasamos el 6º arg destino; si no, la llamada de
        // 5 args queda INTACTA (back-compat para callers sin destino/política,
        // el RPC se comporta idéntico al pre-fix, AC-5).
        if (request.composeDestination) {
          await keySessionService.debitSessionAndParent(
            session.id,
            parentKey.owner_ref,
            parentKey.id,
            chainId,
            estimatedCostUsd,
            request.composeDestination,
          );
        } else {
          await keySessionService.debitSessionAndParent(
            session.id,
            parentKey.owner_ref,
            parentKey.id,
            chainId,
            estimatedCostUsd,
          );
        }
      } catch (debitErr) {
        // WKH-125 (AC-2/AC-6): cap por destino excedido bajo session key → HTTP
        // 402 (no 403), espejando el branch master. El budget NO se decrementó
        // (rollback de la tx en el RPC).
        if (debitErr instanceof DestCapExceededError) {
          return reply.status(402).send({
            error: `chain ${chainId} destination cap exceeded`,
            error_code: 'DEST_CAP_EXCEEDED',
          });
        }
        if (debitErr instanceof SessionBudgetExhaustedError) {
          return send403session(
            reply,
            'SESSION_BUDGET_EXHAUSTED',
            'Session budget exhausted',
          );
        }
        if (debitErr instanceof SessionExpiredError) {
          return send403session(
            reply,
            'SESSION_EXPIRED',
            'Session has expired',
          );
        }
        if (debitErr instanceof SessionTokenInvalidError) {
          return send403session(
            reply,
            'SESSION_TOKEN_INVALID',
            'Session token has been revoked',
          );
        }
        if (debitErr instanceof AgentKeyBudgetExhaustedError) {
          return send403session(
            reply,
            'AGENT_KEY_BUDGET_EXHAUSTED',
            'Parent agent key budget exhausted',
          );
        }
        if (debitErr instanceof DailyLimitExceededError) {
          return send403session(
            reply,
            'DAILY_LIMIT',
            'Daily spending limit exceeded',
          );
        }
        if (debitErr instanceof AgentKeyInactiveError) {
          return send403session(
            reply,
            'KEY_INACTIVE',
            'Parent agent key is inactive',
          );
        }
        if (debitErr instanceof AgentKeyNotFoundError) {
          return send403session(
            reply,
            'KEY_NOT_FOUND',
            'Parent agent key not found',
          );
        }
        if (debitErr instanceof OwnershipMismatchError) {
          return send403session(
            reply,
            'OWNERSHIP_MISMATCH',
            'Session ownership mismatch',
          );
        }
        throw debitErr; // unexpected → outer catch → 503
      }
    }

    // 6. augment + SET keySessionContext (AC-4/AC-10/DT-4). effectiveRow
    //    inyecta el scope efectivo de la sesión (intersección): por dimensión
    //    `effective = (session === null) ? parent : session`. La sesión ya fue
    //    validada ⊆ padre en creación (CD-4).
    const effectiveRow: A2AAgentKeyRow = {
      ...parentKey,
      allowed_registries:
        session.allowed_registries === null
          ? parentKey.allowed_registries
          : session.allowed_registries,
      allowed_agent_slugs:
        session.allowed_agent_slugs === null
          ? parentKey.allowed_agent_slugs
          : session.allowed_agent_slugs,
      allowed_categories:
        session.allowed_categories === null
          ? parentKey.allowed_categories
          : session.allowed_categories,
    };
    effectiveRow.erc8004_verified = isIdentityVerified(parentKey);
    request.a2aKeyRow = effectiveRow;
    request.keySessionRow = session;
    request.keySessionContext = {
      sessionId: session.id,
      ownerRef: parentKey.owner_ref,
      keyId: parentKey.id,
    };

    // 7. remaining budget header (mismo chainId del bundle).
    const remaining = await budgetService.getBalance(
      parentKey.id,
      chainId,
      parentKey.owner_ref,
    );
    reply.header('x-a2a-remaining-budget', remaining);
    return; // fin del branch — NO seguir al flujo master key
  } catch (err) {
    request.log.error(
      { err: err instanceof Error ? err.message : 'unknown' },
      'a2a-key session branch error',
    );
    return reply.status(503).send({
      error: 'SERVICE_ERROR',
      message: 'Key-session service temporarily unavailable',
    });
  }
}

// ── MASTER KEY (CD-5) ────────────────────────────────────────
// Path por defecto: rawKey sin prefijo session/sess. Lookup → validar →
// debitar (salvo skipMiddlewareDebit) → augmentar request.
// Self-terminating: responde error o augmenta request + cae al final (void).
async function resolveMasterAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  rawKey: string,
  estimatedCostUsd: number,
): Promise<unknown> {
  let keyRow: A2AAgentKeyRow | null = null;

  try {
    // 1. Hash the key
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    // 2. Look up the row
    keyRow = await identityService.lookupByHash(keyHash);
    if (!keyRow) {
      return send403(reply, 'KEY_NOT_FOUND', 'A2A key not found');
    }

    // 3. Validate is_active
    if (!keyRow.is_active) {
      return send403(reply, 'KEY_INACTIVE', 'A2A key is inactive');
    }

    // 4. Check daily limit with lazy reset
    if (keyRow.daily_limit_usd !== null) {
      const now = new Date();
      const resetAt = new Date(keyRow.daily_reset_at);
      let dailySpent = parseFloat(keyRow.daily_spent_usd);

      // Lazy reset: if past reset time, treat spent as 0
      if (now >= resetAt) {
        dailySpent = 0;
      }

      if (dailySpent >= parseFloat(keyRow.daily_limit_usd)) {
        return send403(reply, 'DAILY_LIMIT', 'Daily spending limit exceeded');
      }
    }

    // 5. Check per_call_limit
    // WKH-61: scoping check removed from middleware (it ran with empty target
    // and 403'd ALL keys with allowed_*). Scope is now enforced per-step in
    // composeService.compose, post-resolveAgent, where the real Agent target
    // is known. See doc/sdd/059-wkh-61-sec-scope-1/.
    if (keyRow.max_spend_per_call_usd !== null) {
      if (estimatedCostUsd > parseFloat(keyRow.max_spend_per_call_usd)) {
        return send403(
          reply,
          'PER_CALL_LIMIT',
          'Estimated cost exceeds per-call limit',
        );
      }
    }

    // 5b. WKH-123 (AC-1): per-request signature opt-in (EIP-712). Va DESPUÉS
    //     del lookup+is_active+limites y ANTES del debit (CD-11). Si la key NO
    //     exige firma → flujo bearer idéntico al pre-WKH-123 (headers de firma
    //     ignorados, CD-1/AC-7). El `keyHash` (L~636) es el token_hash; EIP-712
    //     lo usa como `0x${keyHash}` (lo agrega el service). El server
    //     reconstruye el typed-data; el caller manda SOLO la firma (CD-9).
    if (keyRow.require_signature === true) {
      const headers = extractSignedHeaders(request);
      if (
        typeof headers.signature !== 'string' ||
        headers.signature.length === 0
      ) {
        return reply.status(401).send({ error_code: 'SIGNATURE_REQUIRED' });
      }
      const signedResult = await verifySignedAuth({
        tokenHashHex: keyHash,
        method: request.method.toUpperCase(),
        path: request.url.split('?')[0] ?? request.url,
        headers,
        scheme: { kind: 'eip712', fundingWallet: keyRow.funding_wallet },
      });
      if (!signedResult.ok) {
        return sendSignedAuthError(reply, signedResult.code);
      }
    }

    // 6. Resolve target chain per-request — REUSO del helper resolveTargetChain
    // (WKH-104 TD-DRIFT: deduplicación del bloque master, behavior idéntico CD-1).
    const chain = resolveTargetChain(request, reply);
    if (!chain) return; // resolveTargetChain ya envió la respuesta de error
    const { chainId, chainKey, assetSymbol } = chain;
    request.resolvedChainId = chainId;

    // 7. Optimistic debit BEFORE execution (BLQ-1/2/3/4 fix)
    // Like Stripe/AWS: charge first, deliver after.
    // The PG function increment_a2a_key_spend is atomic with FOR UPDATE,
    // so this eliminates the race condition (BLQ-4) and ensures failed
    // requests are charged (BLQ-1), debit failures are surfaced (BLQ-2),
    // and service errors return 503 (BLQ-3).
    // WKH-127 (CD-9/CD-11): el débito step-0 master se salta cuando orchestrate
    // marcó `skipMiddlewareDebit` — el service debita el costo real post-plan
    // (Opción B). El flag aplica SOLO a este path master; los branches
    // deleg/session retornaron antes y lo IGNORAN.
    if (!request.skipMiddlewareDebit) {
      request.log.info(
        {
          keyId: keyRow.id,
          chainKey,
          chainId,
          asset_symbol: assetSymbol,
          amountUsd: estimatedCostUsd,
        },
        'a2a-key.debit',
      );
      // WKH-125: la llamada step-0 es compartida por master/gasless/x402/compose.
      // CONDICIONAL (CD-8b): sólo cuando hay `composeDestination` (augmentado por
      // routes/compose.ts:resolveComposePriceHandler) pasamos el 6º arg destino;
      // si no, la llamada de 3 args queda INTACTA (no rompe las aserciones de
      // 3-arg de master/gasless/x402, AC-5).
      const debitResult = request.composeDestination
        ? await budgetService.debit(
            keyRow.id,
            chainId,
            estimatedCostUsd,
            undefined,
            undefined,
            request.composeDestination,
            keyRow.owner_ref, // F-04 (audit): owner_ref del caller autenticado
          )
        : await budgetService.debit(
            keyRow.id,
            chainId,
            estimatedCostUsd,
            undefined,
            undefined,
            undefined,
            keyRow.owner_ref, // F-04 (audit): owner_ref del caller autenticado
          );
      if (!debitResult.success) {
        // WKH-125 (AC-2): cap por destino excedido → HTTP 402 (no 403/400). El
        // budget NO se decrementó (rollback de la tx en el RPC).
        if (debitResult.error === 'DEST_CAP_EXCEEDED') {
          return reply.status(402).send({
            error: `chain ${chainId} destination cap exceeded`,
            error_code: 'DEST_CAP_EXCEEDED',
          });
        }
        // AC-8: error message MUST include the target chainId so callers can
        // distinguish cross-chain confusion from generic insufficient-budget.
        // Cold path: extra getBalance call is acceptable (CD-6 only constrains
        // the happy path).
        const balance = await budgetService
          .getBalance(keyRow.id, chainId, keyRow.owner_ref)
          .catch(() => '0');
        request.log.warn(
          {
            keyId: keyRow.id,
            chainKey,
            chainId,
            asset_symbol: assetSymbol,
            balance,
          },
          'a2a-key.insufficient-budget',
        );
        return send403(
          reply,
          'INSUFFICIENT_BUDGET',
          `chain ${chainId} balance is ${balance}`,
        );
      }

      // WKH-124: emit budget_debit receipt for the MASTER debit (best-effort,
      // fire-and-forget CD-B). A failure here NEVER interrupts the request (CD-1).
      receiptService
        .emit({
          ownerRef: keyRow.owner_ref,
          agentKeyId: keyRow.id,
          sessionId: null,
          delegationId: null,
          receiptType: 'budget_debit',
          amountUsd: estimatedCostUsd,
          chainId,
          txHash: null,
          counterparty: null,
          orchestrationId: null,
        })
        .catch((e) =>
          log.warn(
            { detail: e instanceof Error ? e.message : e },
            '[receipts] emit failed',
          ),
        );
    }

    // 8. Augment request (AC-4)
    keyRow.erc8004_verified = isIdentityVerified(keyRow); // WKH-100 AC-6, derivado, sin RPC (DT-17)
    request.a2aKeyRow = keyRow;

    // 9. Set remaining budget header (AC-1) — read balance AFTER debit
    // CD-12: uses the SAME chainId resolved from the bundle above.
    // WKH-127: bajo `skipMiddlewareDebit` el middleware NO debitó, así que leer
    // el balance acá daría un valor no-debitado; el route handler setea este
    // header con el saldo post-débito real que expone el service.
    if (!request.skipMiddlewareDebit) {
      const postDebitBalance = await budgetService.getBalance(
        keyRow.id,
        chainId,
        keyRow.owner_ref,
      );
      reply.header('x-a2a-remaining-budget', postDebitBalance);
    }
  } catch (err) {
    request.log.error(
      {
        err: err instanceof Error ? err.message : 'unknown',
        keyId: keyRow?.id,
      },
      'a2a-key middleware error',
    );
    return reply.status(503).send({
      error: 'SERVICE_ERROR',
      message: 'Budget service temporarily unavailable',
    });
  }
}

// ── Middleware factory (dispatcher) ──────────────────────────
// Detecta el tipo de credencial y delega al resolver correcto, preservando
// el orden y los early-returns originales: x-a2a-key/Bearer → (session > sess
// > master) ; ausencia → x402 fallback.

export function requirePaymentOrA2AKey(
  x402Opts: PaymentMiddlewareOptions,
): preHandlerAsyncHookHandler[] {
  const x402Handlers = requirePayment(x402Opts);

  const handler: preHandlerAsyncHookHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const rawKey = extractRawKey(request);

    if (!rawKey) {
      // No a2a key -- delegate to x402 flow
      await runX402Fallback(x402Handlers, request, reply);
      return;
    }

    const estimatedCostUsd = resolveEstimatedCostUsd(request);

    // El regex Bearer YA captura wasi_a2a_session_* (empieza con wasi_a2a_).
    // El branch va DESPUÉS de extraer rawKey + estimatedCostUsd y ANTES de la
    // resolución master-key. El path master (CD-5) queda intacto.
    if (rawKey.startsWith('wasi_a2a_session_')) {
      return resolveDelegationAuth(request, reply, rawKey, estimatedCostUsd);
    }

    // Server-side session keys (SIN EIP-712). Va DESPUÉS del branch WKH-101
    // (wasi_a2a_session_*) y ANTES del path master. Los prefijos son mutuamente
    // exclusivos: 'wasi_a2a_session_x'.startsWith('wasi_a2a_sess_') === false.
    if (rawKey.startsWith('wasi_a2a_sess_')) {
      return resolveKeySessionAuth(request, reply, rawKey, estimatedCostUsd);
    }

    return resolveMasterAuth(request, reply, rawKey, estimatedCostUsd);
  };

  return [handler];
}
