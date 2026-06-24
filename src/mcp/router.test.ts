/**
 * MCP Router Integration Tests — AC-14, AC-15, AC-16, AC-17.
 *
 * Mounts the plugin with a known MCP_TOKEN_HASH and asserts the JSON-RPC
 * envelope behaviour for tools/list, bad bodies, unknown methods and logging.
 */

import crypto from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks at top-level (E12 pattern). tools/list doesn't hit services, but
// mocking preemptively keeps the test isolated from adapter init.
vi.mock('../services/discovery.js', () => ({
  discoveryService: {
    discover: vi.fn(async () => ({ agents: [], total: 0, registries: [] })),
    getAgent: vi.fn(async () => null),
  },
}));

vi.mock('../services/orchestrate.js', () => ({
  orchestrateService: {
    orchestrate: vi.fn(),
  },
}));

vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: () => ({
    sign: vi.fn(),
    settle: vi.fn(),
    verify: vi.fn(),
  }),
}));

import { discoveryService } from './../services/discovery.js';
import mcpPlugin from './index.js';

const mockDiscover = vi.mocked(discoveryService.discover);

function sha256Hex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

const VALID = 'the-secret';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.MCP_TOKEN_HASH = sha256Hex(VALID);
  process.env.MCP_RATE_LIMIT_MAX = '1000';
  process.env.MCP_RATE_LIMIT_WINDOW_MS = '60000';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.clearAllMocks();
});

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(rateLimit, {
    global: true,
    max: 10000,
    timeWindow: 60000,
  });
  await app.register(mcpPlugin, { prefix: '/mcp' });
  await app.ready();
  return app;
}

describe('MCP router', () => {
  it('AC-14: tools/list returns 4 tools with name/description/inputSchema', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'x-mcp-token': VALID,
        'content-type': 'application/json',
      },
      payload: { jsonrpc: '2.0', method: 'tools/list', id: 1 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      jsonrpc: string;
      id: number;
      result: {
        tools: Array<{
          name: string;
          description: string;
          inputSchema: Record<string, unknown>;
        }>;
      };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result.tools).toHaveLength(4);
    expect(body.result.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'pay_x402',
        'get_payment_quote',
        'discover_agents',
        'orchestrate',
      ]),
    );
    for (const tool of body.result.tools) {
      expect(typeof tool.description).toBe('string');
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }
    await app.close();
  });

  it('AC-15: body that is not JSON-RPC returns HTTP 200 with error -32700', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'x-mcp-token': VALID,
        'content-type': 'application/json',
      },
      payload: { foo: 'bar' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      jsonrpc: string;
      id: null;
      error: { code: number; message: string };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32700);
    expect(body.error.message).toBe('Parse error');
    expect(body.id).toBeNull();
    await app.close();
  });

  it('AC-16: tools/call with unknown name returns error -32601', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'x-mcp-token': VALID,
        'content-type': 'application/json',
      },
      payload: {
        jsonrpc: '2.0',
        method: 'tools/call',
        id: 7,
        params: { name: 'unknown_tool', arguments: {} },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: number;
      error: { code: number; message: string };
    };
    expect(body.id).toBe(7);
    expect(body.error.code).toBe(-32601);
    expect(body.error.message).toBe('Method not found');
    await app.close();
  });

  it('AC-16: root method (not tools/*) returns -32601', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'x-mcp-token': VALID,
        'content-type': 'application/json',
      },
      payload: { jsonrpc: '2.0', method: 'unknown', id: 2 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      error: { code: number; message: string };
    };
    expect(body.error.code).toBe(-32601);
    await app.close();
  });

  it('AC-17: logs requestId + 8-char token prefix + tool + durationMs on tool call', async () => {
    // Build the app with an onRequest hook that captures log.info calls BEFORE
    // the instance is ready. The hook wraps each request's pino logger.
    const logs: Array<Record<string, unknown>> = [];
    const app = Fastify({ logger: false });
    await app.register(rateLimit, {
      global: true,
      max: 10000,
      timeWindow: 60000,
    });
    app.addHook('onRequest', async (request) => {
      const captured = request.log;
      const info = captured.info.bind(captured);
      captured.info = function patchedInfo(...args: unknown[]) {
        if (
          args.length > 0 &&
          typeof args[0] === 'object' &&
          args[0] !== null
        ) {
          logs.push(args[0] as Record<string, unknown>);
        }
        const apply = info as (...a: unknown[]) => void;
        apply(...args);
      } as typeof captured.info;
    });
    await app.register(mcpPlugin, { prefix: '/mcp' });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'x-mcp-token': VALID,
        'content-type': 'application/json',
      },
      payload: {
        jsonrpc: '2.0',
        method: 'tools/call',
        id: 9,
        params: { name: 'discover_agents', arguments: { query: 'foo' } },
      },
    });
    expect(res.statusCode).toBe(200);
    const entry = logs.find((l) => l.tool === 'discover_agents');
    expect(entry).toBeDefined();
    expect(typeof entry?.requestId).toBe('string');
    expect(entry?.mcpToken).toBe(VALID.slice(0, 8));
    expect(typeof entry?.durationMs).toBe('number');
    expect(entry?.success).toBe(true);
    await app.close();
  });

  // ── Audit 2026-06-24 (P1-6): JSON-RPC error-code dispatch ──────

  it('P1-6: tools/call where the tool name is missing → -32601 (method not found)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'x-mcp-token': VALID, 'content-type': 'application/json' },
      // params present but no `name` field → isToolName(undefined) === false.
      payload: {
        jsonrpc: '2.0',
        method: 'tools/call',
        id: 21,
        params: { arguments: {} },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: number;
      error: { code: number; message: string };
    };
    expect(body.id).toBe(21);
    expect(body.error.code).toBe(-32601);
    expect(body.error.message).toBe('Method not found');
    await app.close();
  });

  it('P1-6: tools/call with schema-invalid args → -32602 (invalid params) with errors', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'x-mcp-token': VALID, 'content-type': 'application/json' },
      // discover_agents schema: maxPrice minimum 0 → -5 fails validation.
      payload: {
        jsonrpc: '2.0',
        method: 'tools/call',
        id: 22,
        params: { name: 'discover_agents', arguments: { maxPrice: -5 } },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: number;
      error: { code: number; message: string; data?: { errors?: unknown[] } };
    };
    expect(body.id).toBe(22);
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toBe('Invalid params');
    // The Ajv validation errors are surfaced for the caller to debug.
    expect(Array.isArray(body.error.data?.errors)).toBe(true);
    await app.close();
  });

  it('P1-6: tools/call rejecting additionalProperties → -32602 (invalid params)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'x-mcp-token': VALID, 'content-type': 'application/json' },
      payload: {
        jsonrpc: '2.0',
        method: 'tools/call',
        id: 23,
        // discover_agents has additionalProperties:false.
        params: { name: 'discover_agents', arguments: { unexpected: 'x' } },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { error: { code: number } };
    expect(body.error.code).toBe(-32602);
    await app.close();
  });

  it('P1-6: tool handler throwing a generic error → -32001 (tool execution) preserving its message', async () => {
    mockDiscover.mockRejectedValueOnce(
      new Error('downstream registry exploded'),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'x-mcp-token': VALID, 'content-type': 'application/json' },
      payload: {
        jsonrpc: '2.0',
        method: 'tools/call',
        id: 24,
        params: { name: 'discover_agents', arguments: { query: 'kyc' } },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      id: number;
      error: { code: number; message: string };
    };
    expect(body.id).toBe(24);
    // The dispatcher maps a generic thrown Error to TOOL_EXECUTION (-32001).
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toBe('downstream registry exploded');
    await app.close();
  });

  it('P1-6: non-Error thrown from a tool handler → -32001 with generic message', async () => {
    // discoveryService.discover rejecting with a non-Error value.
    mockDiscover.mockRejectedValueOnce('string failure');
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'x-mcp-token': VALID, 'content-type': 'application/json' },
      payload: {
        jsonrpc: '2.0',
        method: 'tools/call',
        id: 25,
        params: { name: 'discover_agents', arguments: { query: 'kyc' } },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toBe('Tool execution failed');
    await app.close();
  });
});
