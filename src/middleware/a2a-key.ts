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
import { budgetService } from '../services/budget.js';
import {
  delegationService,
  exceedsPerTxLimit,
} from '../services/delegation.js';
import { identityService, isIdentityVerified } from '../services/identity.js';
import {
  AgentKeyBudgetExhaustedError,
  AgentKeyInactiveError,
  AgentKeyNotFoundError,
  DailyLimitExceededError,
  DelegationExpiredError,
  DelegationNotFoundError,
  DelegationRevokedError,
  DelegationTotalLimitExceededError,
  OwnershipMismatchError,
} from '../services/security/errors.js';
import type {
  A2AAgentKeyRow,
  DelegationDebitContext,
  DelegationRow,
} from '../types/index.js';
import { type PaymentMiddlewareOptions, requirePayment } from './x402.js';

// ── Fastify augmentation (CD-2: no any) ────────────────────

declare module 'fastify' {
  interface FastifyRequest {
    a2aKeyRow?: A2AAgentKeyRow;
    gaslessEstimatedCostUsd?: number; // WKH-59
    composeEstimatedCostUsd?: number; // WKH-59 (real-price-debit) — CD-9
    resolvedChainId?: number; // WKH-59 (real-price-debit) DT-D
    delegationRow?: DelegationRow; // WKH-101
    delegationContext?: DelegationDebitContext; // WKH-101 DT-11 (débito per-step)
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

// ── Middleware factory ──────────────────────────────────────

export function requirePaymentOrA2AKey(
  x402Opts: PaymentMiddlewareOptions,
): preHandlerAsyncHookHandler[] {
  const x402Handlers = requirePayment(x402Opts);

  const handler: preHandlerAsyncHookHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    // DT-2 (WKH-BEARER-AUTH): Priority order: x-a2a-key > Bearer wasi_a2a_* > x402
    let rawKey: string | undefined;

    const headerKey = request.headers['x-a2a-key'];
    if (headerKey && typeof headerKey === 'string') {
      rawKey = headerKey;
    } else {
      // Check Authorization: Bearer wasi_a2a_* (DT-1/DT-3: case-insensitive scheme, case-sensitive prefix)
      const authHeader = request.headers.authorization;
      if (authHeader && typeof authHeader === 'string') {
        const match = /^bearer\s+(.+)$/i.exec(authHeader);
        if (match?.[1].startsWith('wasi_a2a_')) {
          rawKey = match[1];
        }
      }
    }

    if (!rawKey) {
      // No a2a key -- delegate to x402 flow
      await runX402Fallback(x402Handlers, request, reply);
      return;
    }

    // WKH-59: rutas que mueven valor on-chain (POST /gasless/transfer) inyectan
    // el costo real vía request.gaslessEstimatedCostUsd desde un preHandler
    // upstream. WKH-59 (real-price-debit): /compose inyecta el precio real del
    // primer step vía request.composeEstimatedCostUsd. El resto de las rutas
    // siguen con $1 placeholder (backward-compat).
    // CD-7: el middleware NO lee request.body — solo campos augmentados.
    // CD-9: composeEstimatedCostUsd y gaslessEstimatedCostUsd son distintos.
    // DT-F: orden compose-first (rutas mutuamente excluyentes, sin colisión real).
    const estimatedCostUsd =
      typeof request.composeEstimatedCostUsd === 'number'
        ? request.composeEstimatedCostUsd
        : typeof request.gaslessEstimatedCostUsd === 'number'
          ? request.gaslessEstimatedCostUsd
          : 1.0;

    // ── BRANCH DELEGACIÓN (WKH-101) ──────────────────────────
    // El regex Bearer YA captura wasi_a2a_session_* (empieza con wasi_a2a_).
    // El branch va DESPUÉS de extraer rawKey + estimatedCostUsd y ANTES de la
    // resolución master-key. El path master (CD-5) queda intacto.
    if (rawKey.startsWith('wasi_a2a_session_')) {
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
        const parentKey = await delegationService.getParentKey(
          delegation.key_id,
        );
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

        // 6. AC-7 per-tx del STEP 0 (antes de debitar).
        if (
          exceedsPerTxLimit(
            delegation.policy.max_amount_per_tx,
            estimatedCostUsd,
          )
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
          await delegationService.debitDelegationAndParent(
            delegation.id,
            parentKey.owner_ref,
            parentKey.id,
            chainId,
            estimatedCostUsd,
          );
        } catch (debitErr) {
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
      const debitResult = await budgetService.debit(
        keyRow.id,
        chainId,
        estimatedCostUsd,
      );
      if (!debitResult.success) {
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

      // 8. Augment request (AC-4)
      keyRow.erc8004_verified = isIdentityVerified(keyRow); // WKH-100 AC-6, derivado, sin RPC (DT-17)
      request.a2aKeyRow = keyRow;

      // 9. Set remaining budget header (AC-1) — read balance AFTER debit
      // CD-12: uses the SAME chainId resolved from the bundle above.
      const postDebitBalance = await budgetService.getBalance(
        keyRow.id,
        chainId,
        keyRow.owner_ref,
      );
      reply.header('x-a2a-remaining-budget', postDebitBalance);
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
  };

  return [handler];
}
