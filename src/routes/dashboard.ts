/**
 * Dashboard Routes — Analytics UI + API endpoints
 * WKH-27: Dashboard Analytics
 * WKH-54: /api/stats + /api/events gated by optional DASHBOARD_ADMIN_TOKEN.
 *         When env var is set → X-Admin-Token header is required.
 *         When unset → endpoints remain public (local dev behavior).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify';
import { eventService } from '../services/event.js';

/**
 * Admin-token preHandler. Opt-in: only active when DASHBOARD_ADMIN_TOKEN
 * is configured. Callers must supply it via `X-Admin-Token` header.
 */
const requireAdminToken: preHandlerAsyncHookHandler = async (request, reply) => {
  const expected = process.env.DASHBOARD_ADMIN_TOKEN;
  if (!expected) return; // not configured → allow (dev mode)
  const provided = request.headers['x-admin-token'];
  if (typeof provided !== 'string' || provided !== expected) {
    return reply.status(401).send({
      error: 'unauthorized',
      message: 'X-Admin-Token header required for dashboard API',
    });
  }
};

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read HTML at startup (not per-request)
const CHAIN_EXPLORER_URL =
  process.env.CHAIN_EXPLORER_URL ||
  process.env.KITE_EXPLORER_URL ||
  'https://testnet.kitescan.ai';
const dashboardHtml = readFileSync(
  resolve(__dirname, '../static/dashboard.html'),
  'utf-8',
).replace('{{CHAIN_EXPLORER_URL}}', CHAIN_EXPLORER_URL);

const dashboardRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /dashboard
   * Serve the dashboard HTML
   */
  fastify.get(
    '/',
    { config: { rateLimit: false } },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.type('text/html').send(dashboardHtml);
    },
  );

  /**
   * GET /dashboard/api/stats
   * Aggregated KPIs for the dashboard (cached 30s)
   */
  let statsCache: { data: unknown; expiresAt: number } | null = null;
  const STATS_CACHE_TTL_MS = 30_000;

  fastify.get(
    '/api/stats',
    { config: { rateLimit: false }, preHandler: requireAdminToken },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const now = Date.now();
        if (statsCache && now < statsCache.expiresAt) {
          return reply.send(statsCache.data);
        }
        const stats = await eventService.stats();
        statsCache = { data: stats, expiresAt: now + STATS_CACHE_TTL_MS };
        return reply.send(stats);
      } catch (err) {
        return reply.status(500).send({
          error: err instanceof Error ? err.message : 'Failed to get stats',
        });
      }
    },
  );

  /**
   * GET /dashboard/api/events
   * Recent events list
   */
  fastify.get<{ Querystring: { limit?: string } }>(
    '/api/events',
    { config: { rateLimit: false }, preHandler: requireAdminToken },
    async (request, reply: FastifyReply) => {
      try {
        const parsed = parseInt(request.query.limit ?? '20', 10);
        const limit = Number.isNaN(parsed) ? 20 : parsed;
        const events = await eventService.recent(limit);
        return reply.send({ events, total: events.length });
      } catch (err) {
        return reply.status(500).send({
          error: err instanceof Error ? err.message : 'Failed to get events',
        });
      }
    },
  );
};

export default dashboardRoutes;
