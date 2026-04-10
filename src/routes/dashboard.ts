/**
 * Dashboard Routes — Analytics UI + API endpoints
 * WKH-27: Dashboard Analytics
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { eventService } from '../services/event.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Read HTML at startup (not per-request)
const CHAIN_EXPLORER_URL = process.env.CHAIN_EXPLORER_URL || process.env.KITE_EXPLORER_URL || 'https://testnet.kitescan.ai'
const dashboardHtml = readFileSync(
  resolve(__dirname, '../static/dashboard.html'),
  'utf-8',
).replace('{{CHAIN_EXPLORER_URL}}', CHAIN_EXPLORER_URL)

const dashboardRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /dashboard
   * Serve the dashboard HTML
   */
  fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.type('text/html').send(dashboardHtml)
  })

  /**
   * GET /dashboard/api/stats
   * Aggregated KPIs for the dashboard
   */
  fastify.get('/api/stats', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const stats = await eventService.stats()
      return reply.send(stats)
    } catch (err) {
      return reply.status(500).send({
        error: err instanceof Error ? err.message : 'Failed to get stats',
      })
    }
  })

  /**
   * GET /dashboard/api/events
   * Recent events list
   */
  fastify.get(
    '/api/events',
    async (
      request: FastifyRequest<{ Querystring: { limit?: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const parsed = parseInt(request.query.limit ?? '20', 10)
        const limit = Number.isNaN(parsed) ? 20 : parsed
        const events = await eventService.recent(limit)
        return reply.send({ events, total: events.length })
      } catch (err) {
        return reply.status(500).send({
          error: err instanceof Error ? err.message : 'Failed to get events',
        })
      }
    },
  )
}

export default dashboardRoutes
