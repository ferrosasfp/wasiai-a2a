/**
 * Rate Limit Middleware — @fastify/rate-limit wrapper
 * WKH-18: Hardening — AC-1, AC-2
 *
 * Tiered rate limiting:
 * - Global default: RATE_LIMIT_MAX (env, default 60/min)
 * - Per-route overrides via routeConfig for sensitive endpoints
 *
 * Endpoints exempt (rateLimit: false): /, /health, /discover, /gasless/status,
 * /.well-known/agent.json — these are read-only and cheap to serve.
 *
 * Heavy endpoints (/orchestrate, /compose) get their own lower limits
 * via route-level config.rateLimit overrides.
 */

import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';

const rateLimitErrorBuilder = (
  _request: unknown,
  context: { ban?: boolean; ttl: number },
) => {
  const err = new Error('Too Many Requests') as Error & {
    statusCode: number;
    code: string;
    retryAfterMs: number;
  };
  err.statusCode = context.ban ? 403 : 429;
  err.code = 'RATE_LIMIT_EXCEEDED';
  err.retryAfterMs = context.ttl;
  return err;
};

export async function registerRateLimit(
  fastify: FastifyInstance,
): Promise<void> {
  const max = parseInt(process.env.RATE_LIMIT_MAX ?? '60', 10);
  const timeWindow = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10);

  await fastify.register(rateLimit, {
    global: true,
    max,
    timeWindow,
    errorResponseBuilder: rateLimitErrorBuilder,
  });
}

/**
 * Route-level rate limit config for heavy endpoints.
 * Usage: { config: { rateLimit: orchestrateRateLimit() } }
 */
export function orchestrateRateLimit() {
  return {
    max: parseInt(process.env.RATE_LIMIT_ORCHESTRATE_MAX ?? '10', 10),
    timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10),
    errorResponseBuilder: rateLimitErrorBuilder,
  };
}

export function authSignupRateLimit() {
  return {
    max: parseInt(process.env.RATE_LIMIT_SIGNUP_MAX ?? '5', 10),
    timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10),
    errorResponseBuilder: rateLimitErrorBuilder,
  };
}
