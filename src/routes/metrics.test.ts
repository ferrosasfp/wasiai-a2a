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

// OP-09 (audit 2026-06-30): the /metrics fail-closed gate now keys off
// `isMainnetDeployment()` (mainnet chain in the registry), NOT `NODE_ENV`.
// Mock the registry so each test can drive the deployment network: a mainnet
// chainId (8453 = base-mainnet) vs a testnet chainId (84532 = base-sepolia).
const mockChainKeys = vi.fn<() => string[]>(() => []);
const mockChainConfig = vi.fn<(key?: string) => { chainId: number }>(() => ({
  chainId: 84532,
}));
vi.mock('../adapters/registry.js', () => ({
  getInitializedChainKeys: () => mockChainKeys(),
  getChainConfig: (key?: string) => mockChainConfig(key),
}));

import metricsRoutes from './metrics.js';

const ORIGINAL_METRICS_TOKEN = process.env.METRICS_TOKEN;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

/** Drives `isMainnetDeployment()` to true (a mainnet chain in the registry). */
function deployMainnet() {
  mockChainKeys.mockReturnValue(['base-mainnet']);
  mockChainConfig.mockReturnValue({ chainId: 8453 });
}

/** Drives `isMainnetDeployment()` to false (testnet-only registry). */
function deployTestnet() {
  mockChainKeys.mockReturnValue(['base-sepolia']);
  mockChainConfig.mockReturnValue({ chainId: 84532 });
}

async function buildApp() {
  const app = Fastify();
  await app.register(metricsRoutes, { prefix: '/metrics' });
  await app.ready();
  return app;
}

beforeEach(() => {
  delete process.env.METRICS_TOKEN;
  // Default: testnet deployment (open-when-unset). NODE_ENV is irrelevant to
  // the gate now, but cleared to keep F-07 dev assumptions intact.
  delete process.env.NODE_ENV;
  deployTestnet();
});

afterEach(() => {
  if (ORIGINAL_METRICS_TOKEN === undefined) delete process.env.METRICS_TOKEN;
  else process.env.METRICS_TOKEN = ORIGINAL_METRICS_TOKEN;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
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

describe('GET /metrics — OP-09 fail-closed on MAINNET (not NODE_ENV)', () => {
  it('returns 503 when METRICS_TOKEN is unset AND the deployment is MAINNET', async () => {
    deployMainnet();
    delete process.env.METRICS_TOKEN;
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/metrics/' });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });

  it('stays OPEN (200) when METRICS_TOKEN unset on a TESTNET deploy (even NODE_ENV=production)', async () => {
    // Testnet demo runs NODE_ENV=production but settles on testnet chains —
    // OP-09 must NOT 503 the testnet scraper. This is the MNR-2 regression.
    process.env.NODE_ENV = 'production';
    deployTestnet();
    delete process.env.METRICS_TOKEN;
    const app = await buildApp();
    try {
      const res = await app.inject({ method: 'GET', url: '/metrics/' });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('mainnet + METRICS_TOKEN set + correct token → 200', async () => {
    deployMainnet();
    process.env.METRICS_TOKEN = 'secret-token';
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/metrics/',
        headers: { authorization: 'Bearer secret-token' },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
