/**
 * Prometheus Metrics Endpoint — Open source APM
 * Exposes /metrics in Prometheus text format for Grafana/VictoriaMetrics scraping.
 *
 * Tracks: request count, latency histogram, error rate, active connections.
 * Zero external dependencies — uses Fastify hooks + in-memory counters.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

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

      // Fill histogram buckets
      for (const b of BUCKETS) {
        if (durationMs <= b) s.buckets[String(b)]++;
      }
      s.buckets['+Inf']++;
    },
  );

  /**
   * GET /metrics — Prometheus text exposition format
   */
  fastify.get(
    '/',
    { config: { rateLimit: false } },
    async (_request: FastifyRequest, reply: FastifyReply) => {
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

      return reply
        .type('text/plain; version=0.0.4; charset=utf-8')
        .send(`${lines.join('\n')}\n`);
    },
  );
};

export default metricsRoutes;
