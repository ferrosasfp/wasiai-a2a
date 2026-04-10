/**
 * Error Boundary — Global error handler normalizing all errors
 * WKH-18: Hardening — AC-3, AC-4
 *
 * All errors go through here. Response shape:
 * { error: string, code: string, details?: object, requestId: string }
 */

import type { FastifyInstance } from 'fastify'

export function registerErrorBoundary(fastify: FastifyInstance): void {
  fastify.setErrorHandler((error, request, reply) => {
    const requestId = request.id

    // 1. Fastify schema validation error (AC-4)
    if (error.validation) {
      return reply.status(400).send({
        error: 'Validation failed',
        code: 'VALIDATION_ERROR',
        details: error.validation,
        requestId,
      })
    }

    // 2. Custom errors with code (CircuitOpenError, rate-limit, backpressure, timeout, etc.)
    const errorAsUnknown = error as unknown as { code?: string; statusCode?: number; retryAfterMs?: number }
    if ('code' in error && typeof errorAsUnknown.code === 'string') {
      const statusCode = errorAsUnknown.statusCode ?? 500
      const body: Record<string, unknown> = {
        error: error.message,
        code: errorAsUnknown.code,
        requestId,
      }
      // Include retryAfterMs for rate-limit errors (AC-1)
      if (typeof errorAsUnknown.retryAfterMs === 'number') {
        body.retryAfterMs = errorAsUnknown.retryAfterMs
      }
      return reply.status(statusCode).send(body)
    }

    // 3. Rate limit (fallback -- plugin usually handles directly)
    if (error.statusCode === 429) {
      return reply.status(429).send({
        error: 'Too Many Requests',
        code: 'RATE_LIMIT_EXCEEDED',
        requestId,
      })
    }

    // 4. Default: internal error
    const isDev = process.env.NODE_ENV === 'development'
    return reply.status(error.statusCode ?? 500).send({
      error: isDev ? error.message : 'Internal server error',
      code: 'INTERNAL_ERROR',
      details: isDev ? { stack: error.stack } : undefined,
      requestId,
    })
  })
}
