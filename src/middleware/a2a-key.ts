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
import { identityService } from '../services/identity.js';
import type { A2AAgentKeyRow } from '../types/index.js';
import { type PaymentMiddlewareOptions, requirePayment } from './x402.js';

// ── Fastify augmentation (CD-2: no any) ────────────────────

declare module 'fastify' {
  interface FastifyRequest {
    a2aKeyRow?: A2AAgentKeyRow;
    gaslessEstimatedCostUsd?: number; // WKH-59
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
    // upstream. El resto de las rutas siguen con $1 placeholder (backward-compat).
    // CD-7: el middleware NO lee request.body — solo el campo augmentado.
    const estimatedCostUsd =
      typeof request.gaslessEstimatedCostUsd === 'number'
        ? request.gaslessEstimatedCostUsd
        : 1.0;

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

      // 6. Resolve target chain per-request (WKH-MULTICHAIN W2)
      // Priority: explicit `x-payment-chain` header > registry default.
      // CD-16: NO discovery calls here (manifest fallback is delegated to
      // the upstream caller, wasiai-v2 propagates the header).
      // CD-6: resolver is a pure in-memory function — no I/O.
      const headerRaw = request.headers['x-payment-chain'];
      const headerOverride =
        typeof headerRaw === 'string' ? headerRaw : undefined;
      const defaultChainKey = getDefaultChainKey();

      let chainKey = resolveChainKey({ headerOverride });
      if (!chainKey) {
        if (headerOverride !== undefined) {
          // CD-14: header present but unrecognised → 400, never silent default.
          return reply.status(400).send({
            error_code: 'CHAIN_NOT_SUPPORTED',
            error: `Chain '${headerOverride}' is not a recognized slug or chainId`,
          });
        }
        // Header absent → fall back to registry default.
        chainKey = defaultChainKey ?? undefined;
        if (!chainKey) {
          return reply.status(500).send({
            error_code: 'REGISTRY_NOT_INITIALIZED',
            error: 'No chains initialized in registry',
          });
        }
      }

      const bundle = getAdaptersBundle(chainKey);
      if (!bundle) {
        // DT-C: recognised slug but not present in the initialised registry.
        return reply.status(400).send({
          error_code: 'CHAIN_NOT_SUPPORTED',
          error: `Chain '${chainKey}' is not initialized. Initialized: ${getInitializedChainKeys().join(', ')}`,
        });
      }

      // CD-12: chainId for debit AND for post-debit getBalance MUST come from
      // the SAME bundle. Do NOT read from getChainConfig() anywhere below.
      const chainId = bundle.chainConfig.chainId;
      const assetSymbol = bundle.payment.supportedTokens[0]?.symbol ?? 'UNKNOWN';

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
