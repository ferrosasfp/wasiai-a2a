/**
 * Backpressure Middleware — In-flight request counter
 * WKH-18: Hardening — AC-7
 *
 * Rejects new /orchestrate requests when in-flight count >= max (default 20).
 */

import type { preHandlerAsyncHookHandler } from 'fastify'

let inFlight = 0

export function createBackpressureHandler(opts?: { max?: number }): preHandlerAsyncHookHandler {
  const maxInFlight = opts?.max ?? parseInt(process.env.BACKPRESSURE_MAX ?? '20')

  return async (request, reply) => {
    if (inFlight >= maxInFlight) {
      return reply.status(503).send({
        error: 'Service overloaded',
        code: 'BACKPRESSURE',
        requestId: request.id,
      })
    }
    inFlight++
    // Decrement when response completes (always, even on error)
    reply.raw.on('close', () => {
      inFlight--
    })
  }
}

export function getInFlightCount(): number {
  return inFlight
}

/** For testing: reset counter */
export function resetInFlightCount(): void {
  inFlight = 0
}
