/**
 * Event Tracking Middleware — Fastify onResponse hook
 * WKH-EVENT-TRACKING: Global event tracking for dashboard analytics
 *
 * Tracks request events on allowlisted route prefixes via eventService.track().
 * Fire-and-forget: errors are logged but never propagate to clients.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { eventService } from '../services/event.js'

// ── DT-2: Allowlisted route prefixes (safer than denylist) ──

const TRACKED_PREFIXES = [
  '/discover',
  '/orchestrate',
  '/compose',
  '/auth/agent-signup',
  '/gasless/status',
]

// ── Fastify augmentation for start time (DT-4) ─────────────

declare module 'fastify' {
  interface FastifyRequest {
    /** Epoch ms timestamp set by onRequest hook for latency calculation */
    _eventTrackingStartMs?: number
  }
}

// ── Hook registration ───────────────────────────────────────

export function registerEventTracking(fastify: FastifyInstance): void {
  // DT-4: Store start time in onRequest
  fastify.addHook('onRequest', async (request: FastifyRequest) => {
    request._eventTrackingStartMs = Date.now()
  })

  // DT-1: onResponse fires after response is fully sent (accurate latency)
  fastify.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.url
    const isTracked = TRACKED_PREFIXES.some((prefix) => url.startsWith(prefix))
    if (!isTracked) return

    const method = request.method
    const statusCode = reply.statusCode
    const latencyMs =
      request._eventTrackingStartMs != null
        ? Date.now() - request._eventTrackingStartMs
        : undefined
    const status: 'success' | 'failed' = statusCode < 400 ? 'success' : 'failed'

    // DT-3: eventType format request:<method>:<route>
    const eventType = `request:${method}:${url.split('?')[0]}`

    // CD-2: fire-and-forget with .catch() — never block or propagate
    eventService
      .track({
        eventType,
        status,
        latencyMs,
        metadata: {
          endpoint: url.split('?')[0],
          method,
          statusCode,
          responseTimeMs: latencyMs,
          timestamp: new Date().toISOString(),
          requestId: request.id,
        },
      })
      .catch((err: unknown) => {
        request.log.error(
          { err: err instanceof Error ? err.message : 'unknown' },
          'event-tracking: failed to track event',
        )
      })
  })
}
