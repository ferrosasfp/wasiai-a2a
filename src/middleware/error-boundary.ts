/**
 * Error Boundary — Global error handler normalizing all errors
 * WKH-18: Hardening — AC-3, AC-4
 *
 * All errors go through here. Response shape:
 * { error: string, code: string, details?: object, requestId: string }
 */

import type { FastifyInstance } from 'fastify'

interface AppError {
  message: string
  statusCode?: number
  code?: string
  stack?: string
  validation?: unknown[]
  retryAfterMs?: number
  orchestrationId?: string
}

function toAppError(err: unknown): AppError {
  if (err instanceof Error) {
    return err as unknown as AppError
  }
  return { message: String(err) }
}

export function registerErrorBoundary(fastify: FastifyInstance): void {
  fastify.setErrorHandler((rawError: unknown, request, reply) => {
    const error = toAppError(rawError)
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

    // BLQ-3: Extract orchestrationId from error if present (e.g. /orchestrate failures)
    const orchestrationId = error.orchestrationId ?? undefined

    // 2. Custom errors with code (CircuitOpenError, rate-limit, backpressure, timeout, etc.)
    if (error.code && typeof error.code === 'string') {
      const statusCode = error.statusCode ?? 500
      const body: Record<string, unknown> = {
        error: error.message,
        code: error.code,
        requestId,
      }
      // Include retryAfterMs for rate-limit errors (AC-1)
      if (typeof error.retryAfterMs === 'number') {
        body.retryAfterMs = error.retryAfterMs
      }
      if (orchestrationId) body.orchestrationId = orchestrationId
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
    const defaultBody: Record<string, unknown> = {
      error: isDev ? error.message : 'Internal server error',
      code: 'INTERNAL_ERROR',
      details: isDev ? { stack: error.stack } : undefined,
      requestId,
    }
    if (orchestrationId) defaultBody.orchestrationId = orchestrationId
    return reply.status(error.statusCode ?? 500).send(defaultBody)
  })
}
