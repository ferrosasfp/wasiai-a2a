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
import { getChainConfig } from '../adapters/registry.js';
import { authzService } from '../services/authz.js';
import { budgetService } from '../services/budget.js';
import { identityService } from '../services/identity.js';
import type { A2AAgentKeyRow } from '../types/index.js';
import { type PaymentMiddlewareOptions, requirePayment } from './x402.js';

// ── Fastify augmentation (CD-2: no any) ────────────────────

declare module 'fastify' {
  interface FastifyRequest {
    a2aKeyRow?: A2AAgentKeyRow;
  }
}

// ── Error codes for 403 responses ──────────────────────────

type A2AKeyMiddlewareErrorCode =
  | 'KEY_NOT_FOUND'
  | 'KEY_INACTIVE'
  | 'DAILY_LIMIT'
  | 'INSUFFICIENT_BUDGET'
  | 'SCOPE_DENIED'
  | 'PER_CALL_LIMIT';

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

    // DT-2 placeholder cost estimation (MNR-2: single const)
    const estimatedCostUsd = 1.0;

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

      // 5. Check scoping via authzService
      const scopingResult = authzService.checkScoping(keyRow, {});
      if (!scopingResult.allowed) {
        return send403(
          reply,
          'SCOPE_DENIED',
          scopingResult.reason ?? 'Scope denied',
        );
      }

      // 6. Check per_call_limit
      if (keyRow.max_spend_per_call_usd !== null) {
        if (estimatedCostUsd > parseFloat(keyRow.max_spend_per_call_usd)) {
          return send403(
            reply,
            'PER_CALL_LIMIT',
            'Estimated cost exceeds per-call limit',
          );
        }
      }

      // 7. Optimistic debit BEFORE execution (BLQ-1/2/3/4 fix)
      // Like Stripe/AWS: charge first, deliver after.
      // The PG function increment_a2a_key_spend is atomic with FOR UPDATE,
      // so this eliminates the race condition (BLQ-4) and ensures failed
      // requests are charged (BLQ-1), debit failures are surfaced (BLQ-2),
      // and service errors return 503 (BLQ-3).
      const chainId = getChainConfig().chainId;
      const debitResult = await budgetService.debit(
        keyRow.id,
        chainId,
        estimatedCostUsd,
      );
      if (!debitResult.success) {
        return send403(
          reply,
          'INSUFFICIENT_BUDGET',
          debitResult.error ?? 'Budget debit failed',
        );
      }

      // 8. Augment request (AC-4)
      request.a2aKeyRow = keyRow;

      // 9. Set remaining budget header (AC-1) — read balance AFTER debit
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
