/**
 * Timeout Middleware — Configurable request timeout
 * WKH-18: Hardening — AC-8 (120s orchestrate), AC-9 (60s compose)
 */

import type { preHandlerAsyncHookHandler } from 'fastify'

export function createTimeoutHandler(timeoutMs: number): preHandlerAsyncHookHandler {
  return async (request, reply) => {
    const timer = setTimeout(() => {
      if (!reply.sent) {
        reply.status(504).send({
          error: 'Request timeout',
          code: 'TIMEOUT',
          requestId: request.id,
        })
      }
    }, timeoutMs)

    // Clean up timer when response is sent
    reply.raw.on('close', () => clearTimeout(timer))
  }
}
