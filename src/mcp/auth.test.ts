/**
 * MCP Auth Tests — AC-11, AC-13 (+ fail-closed + malformed MCP_TOKENS).
 */

import crypto from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpAuthHandler, loadMcpTokenHashes } from './auth.js';

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.MCP_TOKEN_HASH;
  delete process.env.MCP_TOKENS;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
});

async function buildApp() {
  const app = Fastify({ logger: false });
  const authHandler = createMcpAuthHandler();
  app.post('/mcp', { preHandler: [authHandler] }, async (_req, reply) =>
    reply.send({ jsonrpc: '2.0', result: { ok: true }, id: 1 }),
  );
  await app.ready();
  return app;
}

describe('MCP auth — loadMcpTokenHashes', () => {
  it('AC-13: accepts a valid MCP_TOKEN_HASH (hex64)', () => {
    process.env.MCP_TOKEN_HASH = sha256Hex('token-one');
    const hashes = loadMcpTokenHashes();
    expect(hashes).toHaveLength(1);
    expect(hashes[0]).toBe(sha256Hex('token-one').toLowerCase());
  });

  it('AC-13: accepts MCP_TOKENS JSON array of hex64', () => {
    const a = sha256Hex('a');
    const b = sha256Hex('b');
    process.env.MCP_TOKENS = JSON.stringify([a, b]);
    const hashes = loadMcpTokenHashes();
    expect(hashes).toEqual([a.toLowerCase(), b.toLowerCase()]);
  });

  it('AB-035: throws on malformed MCP_TOKENS JSON', () => {
    process.env.MCP_TOKENS = '{not-json';
    expect(() => loadMcpTokenHashes()).toThrow(/JSON array/);
  });

  it('AB-035: throws when MCP_TOKENS contains non-hex64 entries', () => {
    process.env.MCP_TOKENS = JSON.stringify(['not-a-hash']);
    expect(() => loadMcpTokenHashes()).toThrow(/hex64|non-hex64/);
  });

  it('throws on malformed MCP_TOKEN_HASH (not 64 hex chars)', () => {
    process.env.MCP_TOKEN_HASH = 'deadbeef';
    expect(() => loadMcpTokenHashes()).toThrow(/64-char hex/);
  });
});

describe('MCP auth — handler', () => {
  it('fail-closed: returns 503 when no MCP_TOKEN_HASH nor MCP_TOKENS', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'x-mcp-token': 'anything' },
      payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as {
      jsonrpc: string;
      error: { code: number; message: string };
      id: null;
    };
    expect(body.error.code).toBe(-32603);
    expect(body.error.message).toMatch(/not configured/i);
    await app.close();
  });

  it('AC-11: 401 JSON-RPC when header is missing', async () => {
    process.env.MCP_TOKEN_HASH = sha256Hex('secret');
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as {
      jsonrpc: string;
      error: { code: number; message: string };
      id: null;
    };
    expect(body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'Unauthorized' },
      id: null,
    });
    await app.close();
  });

  it('AC-13: matches MCP_TOKEN_HASH and passes the request through', async () => {
    process.env.MCP_TOKEN_HASH = sha256Hex('the-secret');
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'x-mcp-token': 'the-secret' },
      payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      jsonrpc: '2.0',
      result: { ok: true },
      id: 1,
    });
    await app.close();
  });

  it('AC-13: matches the second entry of MCP_TOKENS array', async () => {
    process.env.MCP_TOKENS = JSON.stringify([
      sha256Hex('alpha'),
      sha256Hex('beta'),
    ]);
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'x-mcp-token': 'beta' },
      payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('accepts Authorization: Bearer <token> as fallback', async () => {
    process.env.MCP_TOKEN_HASH = sha256Hex('bearer-secret');
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: 'Bearer bearer-secret' },
      payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('prefers X-MCP-Token over Authorization when both present', async () => {
    process.env.MCP_TOKEN_HASH = sha256Hex('x-mcp-wins');
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'x-mcp-token': 'x-mcp-wins',
        authorization: 'Bearer wrong-bearer',
      },
      payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('AC-13: no-match returns 401 JSON-RPC', async () => {
    process.env.MCP_TOKEN_HASH = sha256Hex('correct');
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'x-mcp-token': 'wrong' },
      payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as {
      jsonrpc: string;
      error: { code: number; message: string };
      id: null;
    };
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toBe('Unauthorized');
    await app.close();
  });
});
