/**
 * Rate Limit Middleware — @fastify/rate-limit wrapper
 * WKH-18: Hardening — AC-1, AC-2
 *
 * Applies per-IP rate limiting with env-configurable thresholds.
 * Uses default errorResponseBuilder (returns Error with statusCode=429).
 * The error boundary normalizes the response shape.
 */

import type { FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'

export async function registerRateLimit(fastify: FastifyInstance): Promise<void> {
  const max = parseInt(process.env.RATE_LIMIT_MAX ?? '10')
  const timeWindow = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000')

  // global: true applies rate limiting to ALL routes by default.
  // Routes that should be exempt must set config: { rateLimit: false }.
  await fastify.register(rateLimit, {
    global: true,
    max,
    timeWindow,
    errorResponseBuilder: (_request, context) => {
      const err = new Error('Too Many Requests') as Error & {
        statusCode: number
        code: string
        retryAfterMs: number
      }
      // context.ban means 403, otherwise 429
      err.statusCode = context.ban ? 403 : 429
      err.code = 'RATE_LIMIT_EXCEEDED'
      err.retryAfterMs = context.ttl
      return err
    },
  })
}
