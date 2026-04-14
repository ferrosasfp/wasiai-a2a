/**
 * MCP Server — Fastify plugin (WKH-MCP-X402).
 *
 * Registers `POST /` under whatever prefix the caller supplies (expected
 * `/mcp` per `src/index.ts`). Pipeline per request:
 *   1. @fastify/rate-limit (route-level config, token-keyed)  — AC-12
 *   2. createMcpAuthHandler preHandler                         — AC-11 / AC-13
 *   3. dispatch() over the JSON-RPC body                       — AC-14..AC-18
 */

import type { FastifyPluginAsync } from 'fastify';
import { createMcpAuthHandler } from './auth.js';
import { mcpRateLimitConfig } from './rate-limit.js';
import { dispatch } from './router.js';
import { MCP_ERRORS, type ToolContext } from './types.js';

const mcpPlugin: FastifyPluginAsync = async (fastify) => {
  const authHandler = createMcpAuthHandler();

  // AC-12: @fastify/rate-limit throws its error builder output. Re-shape it
  // here as a JSON-RPC 2.0 envelope instead of letting the global error
  // boundary flatten it.
  fastify.setErrorHandler((err, _request, reply) => {
    const candidate = err as Error & { code?: string; statusCode?: number };
    if (candidate.code === 'RATE_LIMIT_EXCEEDED') {
      return reply.status(candidate.statusCode ?? 429).send({
        jsonrpc: '2.0',
        error: {
          code: MCP_ERRORS.TOO_MANY_REQUESTS,
          message: 'Too Many Requests',
        },
        id: null,
      });
    }
    // Fall through: let the caller's error boundary handle other errors.
    throw err;
  });

  fastify.post<{ Body: unknown }>(
    '/',
    {
      config: { rateLimit: mcpRateLimitConfig() },
      preHandler: [authHandler],
    },
    async (request, reply) => {
      const ctx: ToolContext = {
        requestId: request.id,
        tokenPrefix: request.mcpTokenPrefix ?? '',
        log: request.log,
      };
      const response = await dispatch(request.body, ctx);
      return reply.status(200).send(response);
    },
  );
};

export default mcpPlugin;
