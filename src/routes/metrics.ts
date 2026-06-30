/**
 * Prometheus Metrics Endpoint — Open source APM
 * Exposes /metrics in Prometheus text format for Grafana/VictoriaMetrics scraping.
 *
 * Tracks: request count, latency histogram, error rate, active connections.
 * Zero external dependencies — uses Fastify hooks + in-memory counters.
 */

import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { isProduction } from '../lib/env.js';
import { renderMcpMetrics } from '../mcp/metrics.js';

/**
 * F-07 (audit 2026-06-29) + OP-09 (audit 2026-06-30): bearer/header auth for
 * /metrics. When `METRICS_TOKEN` is set, the endpoint requires a matching token
 * (via `Authorization: Bearer <token>` or the `x-metrics-token` header).
 *
 * OP-09 fail-closed: when `METRICS_TOKEN` is UNSET, the endpoint is fail-CLOSED
 * IN PRODUCTION (503 — metrics may leak route/error/latency internals) and stays
 * OPEN in dev for frictionless local scraping. Mirrors the dashboard admin-token
 * pattern (`routes/dashboard.ts:requireAdminToken`). Returns null when
 * authorized, or a sent 401/503 reply otherwise.
 */
function enforceMetricsToken(
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply | null {
  const expected = process.env.METRICS_TOKEN?.trim();
  if (!expected) {
    // OP-09: fail-closed in production, passthrough in dev (mirrors dashboard).
    if (isProduction()) {
      return reply.status(503).send({
        error: 'service_unavailable',
        message: 'Metrics endpoint not configured',
      });
    }
    return null; // not configured + non-prod → open (dev mode)
  }

  const authHeader = request.headers.authorization;
  const bearer = authHeader?.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : undefined;
  const headerToken = request.headers['x-metrics-token'];
  const provided =
    bearer ??
    (typeof headerToken === 'string' ? headerToken.trim() : undefined);

  if (provided === undefined || !constantTimeEquals(provided, expected)) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
  return null;
}

/**
 * Constant-time string comparison — avoids leaking the token length/prefix via
 * response timing. Returns false immediately on length mismatch (lengths are not
 * secret) and uses `timingSafeEqual` for equal-length inputs.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ── Metric storage ───────────────────────────────────────────
interface RouteStat {
  count: number;
  errors: number;
  totalMs: number;
  buckets: Record<string, number>; // histogram buckets
}

const stats = new Map<string, RouteStat>();
let activeRequests = 0;
const startTime = Date.now();

const BUCKETS = [10, 50, 100, 200, 500, 1000, 2000, 5000];

function getOrCreate(key: string): RouteStat {
  let s = stats.get(key);
  if (!s) {
    s = { count: 0, errors: 0, totalMs: 0, buckets: {} };
    for (const b of BUCKETS) s.buckets[String(b)] = 0;
    s.buckets['+Inf'] = 0;
    stats.set(key, s);
  }
  return s;
}

// ── Routes ───────────────────────────────────────────────────

const metricsRoutes: FastifyPluginAsync = async (fastify) => {
  // Hook into every request for metric collection
  fastify.addHook('onRequest', async () => {
    activeRequests++;
  });
  fastify.addHook(
    'onResponse',
    async (request: FastifyRequest, reply: FastifyReply) => {
      activeRequests--;
      const url = request.routeOptions?.url ?? request.url;
      const method = request.method;
      const key = `${method} ${url}`;
      const durationMs = reply.elapsedTime;

      const s = getOrCreate(key);
      s.count++;
      s.totalMs += durationMs;
      if (reply.statusCode >= 400) s.errors++;

      // Fill histogram buckets (getOrCreate seeds every bucket + '+Inf' to 0).
      for (const b of BUCKETS) {
        const bk = String(b);
        if (durationMs <= b) s.buckets[bk] = (s.buckets[bk] ?? 0) + 1;
      }
      s.buckets['+Inf'] = (s.buckets['+Inf'] ?? 0) + 1;
    },
  );

  /**
   * GET /metrics — Prometheus text exposition format
   */
  fastify.get(
    '/',
    { config: { rateLimit: false } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // F-07: gate on METRICS_TOKEN when configured (open when unset).
      const unauthorized = enforceMetricsToken(request, reply);
      if (unauthorized) return unauthorized;

      const lines: string[] = [];

      // Uptime
      const uptimeS = ((Date.now() - startTime) / 1000).toFixed(0);
      lines.push('# HELP wasiai_uptime_seconds Server uptime in seconds');
      lines.push('# TYPE wasiai_uptime_seconds gauge');
      lines.push(`wasiai_uptime_seconds ${uptimeS}`);

      // Active requests
      lines.push('# HELP wasiai_active_requests Current in-flight requests');
      lines.push('# TYPE wasiai_active_requests gauge');
      lines.push(`wasiai_active_requests ${activeRequests}`);

      // Per-route request count
      lines.push(
        '# HELP wasiai_http_requests_total Total HTTP requests by route and method',
      );
      lines.push('# TYPE wasiai_http_requests_total counter');
      for (const [key, s] of stats) {
        const [method, route] = key.split(' ', 2);
        lines.push(
          `wasiai_http_requests_total{method="${method}",route="${route}"} ${s.count}`,
        );
      }

      // Per-route errors
      lines.push(
        '# HELP wasiai_http_errors_total Total HTTP error responses (4xx/5xx)',
      );
      lines.push('# TYPE wasiai_http_errors_total counter');
      for (const [key, s] of stats) {
        const [method, route] = key.split(' ', 2);
        if (s.errors > 0) {
          lines.push(
            `wasiai_http_errors_total{method="${method}",route="${route}"} ${s.errors}`,
          );
        }
      }

      // Per-route latency histogram
      lines.push(
        '# HELP wasiai_http_duration_ms HTTP request duration in milliseconds',
      );
      lines.push('# TYPE wasiai_http_duration_ms histogram');
      for (const [key, s] of stats) {
        const [method, route] = key.split(' ', 2);
        for (const [bucket, count] of Object.entries(s.buckets)) {
          lines.push(
            `wasiai_http_duration_ms_bucket{method="${method}",route="${route}",le="${bucket}"} ${count}`,
          );
        }
        lines.push(
          `wasiai_http_duration_ms_sum{method="${method}",route="${route}"} ${s.totalMs.toFixed(0)}`,
        );
        lines.push(
          `wasiai_http_duration_ms_count{method="${method}",route="${route}"} ${s.count}`,
        );
      }

      // Node.js process metrics
      const mem = process.memoryUsage();
      lines.push('# HELP wasiai_memory_rss_bytes Resident set size in bytes');
      lines.push('# TYPE wasiai_memory_rss_bytes gauge');
      lines.push(`wasiai_memory_rss_bytes ${mem.rss}`);
      lines.push('# HELP wasiai_memory_heap_used_bytes Heap used in bytes');
      lines.push('# TYPE wasiai_memory_heap_used_bytes gauge');
      lines.push(`wasiai_memory_heap_used_bytes ${mem.heapUsed}`);

      // WKH-MCP-X402: append MCP tool metrics (AC-18).
      lines.push(renderMcpMetrics());

      return reply
        .type('text/plain; version=0.0.4; charset=utf-8')
        .send(`${lines.join('\n')}\n`);
    },
  );
};

export default metricsRoutes;
