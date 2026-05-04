/**
 * requirePassport Middleware — Fastify preHandler hook (WKH-69)
 *
 * Optional opt-in guard that rejects inbound x402 requests that did NOT
 * arrive with an `x-passport-session` hint header. Off by default, mounted
 * only when `PASSPORT_REQUIRE_INBOUND=true` (literal, case-sensitive).
 *
 * Behavior (env-gated, AC-10):
 *   - PASSPORT_REQUIRE_INBOUND unset / empty / any value other than 'true'
 *     → factory returns [] (NOT mounted).
 *   - PASSPORT_REQUIRE_INBOUND === 'true'
 *     → handler reads `request.paymentOrigin` (set by `requirePayment` from
 *       x402.ts upstream). If 'passport', passthrough. Otherwise (including
 *       'eoa' or undefined / misconfigured chain), 403 PASSPORT_REQUIRED.
 *
 * MUST be mounted AFTER requirePayment in the route's preHandler array,
 * because requirePayment is the producer of `request.paymentOrigin`.
 *
 * This factory follows the canonical opt-in pattern of `requireForwardKey()`
 * in src/middleware/forward-key.ts (lines 66-127).
 *
 * Logging discipline: NEVER logs the header value. Only logs the boolean
 * `paymentOrigin` for ops debugging.
 */
import type {
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify';

const PASSPORT_REQUIRE_ENV = 'PASSPORT_REQUIRE_INBOUND';

/**
 * Factory for the requirePassport middleware.
 *
 * SECURITY CAVEAT: The `x-passport-session` header used internally is
 * client-controlled — this middleware provides POLICY-DECLARATION only,
 * not adversarial security. See doc/passport-onboarding.md § Security
 * caveat for details. Real Passport-vs-EOA distinction is deferred to
 * the smoke-test resolution.
 *
 * @returns array of zero or one preHandlers depending on env config.
 */
export function requirePassport(): preHandlerAsyncHookHandler[] {
  // Strict literal 'true' — explicit on/off semantics, no truthy coercion
  // (matches WASIAI_DOWNSTREAM_X402 pattern in .env.example).
  if (process.env[PASSPORT_REQUIRE_ENV] !== 'true') {
    return [];
  }

  const handler: preHandlerAsyncHookHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    if (request.paymentOrigin !== 'passport') {
      // Fail-secure: undefined paymentOrigin (e.g. middleware mounted out
      // of order) gets 403 too. CD-WKH69-10.
      request.log.warn(
        { paymentOrigin: request.paymentOrigin ?? 'undefined' },
        'passport-required: rejected non-passport request',
      );
      return reply.status(403).send({
        error: 'Passport session required',
        error_code: 'PASSPORT_REQUIRED',
      });
    }
    // paymentOrigin === 'passport' → passthrough.
  };

  return [handler];
}
