/**
 * MCP Rate Limit Test — AC-12.
 *
 * Sends MCP_RATE_LIMIT_MAX + 1 requests within the same window; the final
 * one must return HTTP 429 with JSON-RPC error code -32029.
 */

import crypto from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpRateLimitConfig } from './rate-limit.js';

// Minimal shape of FastifyRequest that keyGenerator actually reads. Building
// a stub via this type avoids `as unknown as FastifyRequest` (CD-2).
type KeyGenReq = Pick<FastifyRequest, 'headers' | 'ip'>;
const asReq = (r: KeyGenReq): FastifyRequest => r as FastifyRequest;

vi.mock('../services/discovery.js', () => ({
  discoveryService: {
    discover: vi.fn(),
    getAgent: vi.fn(),
  },
}));
vi.mock('../services/orchestrate.js', () => ({
  orchestrateService: { orchestrate: vi.fn() },
}));
vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: () => ({
    sign: vi.fn(),
    settle: vi.fn(),
    verify: vi.fn(),
  }),
}));

import mcpPlugin from './index.js';

const VALID = 'rl-test-token';
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.MCP_TOKEN_HASH = crypto
    .createHash('sha256')
    .update(VALID)
    .digest('hex');
  process.env.MCP_RATE_LIMIT_MAX = '30';
  process.env.MCP_RATE_LIMIT_WINDOW_MS = '60000';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(rateLimit, {
    global: true,
    max: 10_000, // global limit far above the MCP limit
    timeWindow: 60_000,
  });
  await app.register(mcpPlugin, { prefix: '/mcp' });
  await app.ready();
  return app;
}

describe('MCP rate-limit', () => {
  it('AC-12: the 31st request within the window returns HTTP 429 + JSON-RPC -32029', async () => {
    const app = await buildApp();

    const body = { jsonrpc: '2.0', method: 'tools/list', id: 1 };
    const headers = {
      'x-mcp-token': VALID,
      'content-type': 'application/json',
    };

    for (let i = 0; i < 30; i++) {
      const ok = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers,
        payload: body,
      });
      expect(ok.statusCode).toBe(200);
    }

    const over = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers,
      payload: body,
    });
    expect(over.statusCode).toBe(429);
    // MCP plugin rewrites the rate-limit error into a JSON-RPC 2.0 envelope.
    const parsed = over.json() as {
      jsonrpc: string;
      error: { code: number; message: string };
      id: null;
    };
    expect(parsed.jsonrpc).toBe('2.0');
    expect(parsed.error.code).toBe(-32029);
    expect(parsed.error.message).toBe('Too Many Requests');
    expect(parsed.id).toBeNull();

    await app.close();
  });

  it('BLQ-2: keyGenerator hashes the token — never returns raw X-MCP-Token', () => {
    const cfg = mcpRateLimitConfig();
    const token = 'super-secret-token-value';
    const req: KeyGenReq = {
      headers: { 'x-mcp-token': token },
      ip: '10.0.0.1',
    };
    const key = cfg.keyGenerator(asReq(req));
    // Must not echo the raw token
    expect(key).not.toBe(token);
    expect(key).not.toContain(token);
    // Must use the documented `mcp:` + 16-hex prefix format
    const expectedPrefix =
      'mcp:' +
      crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
    expect(key).toBe(expectedPrefix);
  });

  it('BLQ-2: keyGenerator falls back to req.ip when no token header is present', () => {
    const cfg = mcpRateLimitConfig();
    const req: KeyGenReq = {
      headers: {},
      ip: '192.0.2.9',
    };
    expect(cfg.keyGenerator(asReq(req))).toBe('192.0.2.9');
  });

  it('MNR-1: parseInt NaN falls back to defaults (max=30, window=60000)', () => {
    process.env.MCP_RATE_LIMIT_MAX = 'not-a-number';
    process.env.MCP_RATE_LIMIT_WINDOW_MS = '-5';
    const cfg = mcpRateLimitConfig();
    expect(cfg.max).toBe(30);
    expect(cfg.timeWindow).toBe(60000);
  });
});
