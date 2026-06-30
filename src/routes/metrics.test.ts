/**
 * Metrics Route Tests — F-07 (audit 2026-06-29): optional METRICS_TOKEN auth.
 *
 * Behaviour matrix:
 *  - METRICS_TOKEN unset  → /metrics OPEN (200, backward-compatible).
 *  - METRICS_TOKEN set    → 401 without/with wrong token; 200 with the right
 *    token via `Authorization: Bearer` OR `x-metrics-token`.
 */

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// renderMcpMetrics is exercised by the metrics handler; stub it to a fixed
// string so these tests stay focused on the auth gate.
vi.mock('../mcp/metrics.js', () => ({
  renderMcpMetrics: () => '# mcp metrics',
}));

import metricsRoutes from './metrics.js';

const ORIGINAL_METRICS_TOKEN = process.env.METRICS_TOKEN;

async function buildApp() {
  const app = Fastify();
  await app.register(metricsRoutes, { prefix: '/metrics' });
  await app.ready();
  return app;
}

beforeEach(() => {
  delete process.env.METRICS_TOKEN;
});

afterEach(() => {
  if (ORIGINAL_METRICS_TOKEN === undefined) delete process.env.METRICS_TOKEN;
  else process.env.METRICS_TOKEN = ORIGINAL_METRICS_TOKEN;
});

describe('GET /metrics — F-07 optional auth', () => {
  it('is OPEN (200) when METRICS_TOKEN is unset (backward-compatible)', async () => {
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/metrics/' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('wasiai_uptime_seconds');
    } finally {
      await app.close();
    }
  });

  it('returns 401 when METRICS_TOKEN is set but no token is provided', async () => {
    process.env.METRICS_TOKEN = 'secret-token';
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/metrics/' });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('returns 401 when METRICS_TOKEN is set and a WRONG token is provided', async () => {
    process.env.METRICS_TOKEN = 'secret-token';
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/metrics/',
        headers: { authorization: 'Bearer wrong-token' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('returns 200 with the correct token via Authorization: Bearer', async () => {
    process.env.METRICS_TOKEN = 'secret-token';
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/metrics/',
        headers: { authorization: 'Bearer secret-token' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('wasiai_uptime_seconds');
    } finally {
      await app.close();
    }
  });

  it('returns 200 with the correct token via x-metrics-token header', async () => {
    process.env.METRICS_TOKEN = 'secret-token';
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/metrics/',
        headers: { 'x-metrics-token': 'secret-token' },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
