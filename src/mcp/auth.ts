/**
 * MCP Auth — X-MCP-Token validation via SHA-256 + timingSafeEqual (CD-13)
 *
 * Tokens are stored as sha256 hashes in two env vars:
 *   - MCP_TOKEN_HASH  (single hex64)
 *   - MCP_TOKENS      (JSON array of hex64)
 *
 * Fail-closed: if no hashes are configured, every request gets 503. Never
 * "allow all" (AC-13).
 */

import crypto from 'node:crypto';
import type {
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify';

// ── Fastify augmentation (CD-2: no any) ─────────────────────

declare module 'fastify' {
  interface FastifyRequest {
    /** First 8 chars of the authenticated MCP token (CD-3) */
    mcpTokenPrefix?: string;
  }
}

const HEX64_RE = /^[0-9a-f]{64}$/i;

/**
 * Read and validate MCP token hashes from env.
 *
 * @throws Error if MCP_TOKENS is not valid JSON or contains non-hex64 entries.
 *         Startup-time failure is preferred over silent mis-config (AB-035).
 */
export function loadMcpTokenHashes(): string[] {
  const hashes: string[] = [];

  const single = process.env.MCP_TOKEN_HASH?.trim();
  if (single && single.length > 0) {
    if (!HEX64_RE.test(single)) {
      throw new Error(
        'MCP_TOKEN_HASH must be a 64-char hex string (sha256 of the bearer token)',
      );
    }
    hashes.push(single.toLowerCase());
  }

  const many = process.env.MCP_TOKENS?.trim();
  if (many && many.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(many);
    } catch {
      throw new Error('MCP_TOKENS must be a JSON array of hex64 strings');
    }
    if (!Array.isArray(parsed)) {
      throw new Error('MCP_TOKENS must be a JSON array of hex64 strings');
    }
    for (const entry of parsed) {
      if (typeof entry !== 'string' || !HEX64_RE.test(entry)) {
        throw new Error(
          'MCP_TOKENS contains a non-hex64 entry; expected sha256 hex digests',
        );
      }
      hashes.push(entry.toLowerCase());
    }
  }

  return hashes;
}

function unauthorizedResponse(reply: FastifyReply): void {
  reply.status(401).send({
    jsonrpc: '2.0',
    error: { code: -32600, message: 'Unauthorized' },
    id: null,
  });
}

/**
 * Build a Fastify preHandler hook that validates the X-MCP-Token header.
 *
 * - No config -> every request returns 503 (fail-closed).
 * - Missing / empty token -> 401 JSON-RPC.
 * - Timing-safe comparison against every configured hash (CD-13).
 * - On success: decorate request with first-8-char token prefix (CD-3).
 */
export function createMcpAuthHandler(): preHandlerAsyncHookHandler {
  const hashes = loadMcpTokenHashes();

  if (hashes.length === 0) {
    return async (_req: FastifyRequest, reply: FastifyReply) => {
      reply.status(503).send({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'MCP auth not configured' },
        id: null,
      });
    };
  }

  // Pre-compute Buffers once; length always 32 bytes (SHA-256).
  const expectedBuffers = hashes.map((h) => Buffer.from(h, 'hex'));

  return async (request: FastifyRequest, reply: FastifyReply) => {
    const raw = request.headers['x-mcp-token'];
    const token = typeof raw === 'string' ? raw : '';
    if (token.length === 0) {
      unauthorizedResponse(reply);
      return;
    }

    const tokenHashHex = crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');
    const tokenHashBuf = Buffer.from(tokenHashHex, 'hex');

    // Compare against every configured hash; DO NOT early-return (timing).
    let match = false;
    for (const expected of expectedBuffers) {
      if (
        expected.length === tokenHashBuf.length &&
        crypto.timingSafeEqual(expected, tokenHashBuf)
      ) {
        match = true;
        // NO break — compare every entry to keep constant timing.
      }
    }

    if (!match) {
      unauthorizedResponse(reply);
      return;
    }

    request.mcpTokenPrefix = token.slice(0, 8);
  };
}
