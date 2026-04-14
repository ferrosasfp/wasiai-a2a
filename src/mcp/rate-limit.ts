/**
 * MCP Rate Limit — per-token config for @fastify/rate-limit (route-level).
 *
 * Key generator = sha256(X-MCP-Token) truncated to 16 hex chars, prefixed
 * with `mcp:` (BLQ-2: never use the raw token as the rate-limit key). Falls
 * back to `req.ip` when no token is present.
 *
 * Error builder returns a real Error instance so @fastify/rate-limit can
 * enrich headers (CD-12 / AB-026 #3). parseInt is guarded with NaN /
 * non-positive fallbacks (MNR-1).
 */

import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';

interface RateLimitErrorContext {
  ban?: boolean;
  ttl: number;
}

const mcpRateLimitErrorBuilder = (
  _request: unknown,
  context: RateLimitErrorContext,
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

/**
 * Reads a positive-integer env var with a safe fallback for NaN / <=0.
 */
function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function mcpRateLimitConfig() {
  const max = readPositiveInt('MCP_RATE_LIMIT_MAX', 30);
  const timeWindow = readPositiveInt('MCP_RATE_LIMIT_WINDOW_MS', 60000);
  return {
    max,
    timeWindow,
    keyGenerator: (req: FastifyRequest): string => {
      const raw = req.headers['x-mcp-token'];
      const token = Array.isArray(raw) ? raw[0] : (raw ?? '');
      if (typeof token !== 'string' || token.length === 0) return req.ip;
      // BLQ-2: never expose the raw token as a rate-limit bucket key. Hash
      // then truncate — enough entropy to avoid collisions across tokens.
      return (
        'mcp:' +
        crypto.createHash('sha256').update(token).digest('hex').slice(0, 16)
      );
    },
    errorResponseBuilder: mcpRateLimitErrorBuilder,
  };
}
