#!/usr/bin/env node
// index.mjs — MCP server bootstrap (stdio transport).
//
// Tools (DT-J fixed scope, no health/version/poll):
//   - discover_agents     — GET /api/v1/capabilities passthrough
//   - get_payment_quote   — probe endpoint, parse 402 challenge, NO signature
//   - pay_x402            — full probe→sign→retry x402 flow
//
// Logger to stderr only (DT-L). Stdout is reserved for MCP JSON-RPC frames.
//
// WKH-65: handlers + helpers extracted to ./handlers.mjs so the HTTP transport
// (api/mcp.mjs) reuses the exact same logic. We re-export them here to
// preserve the public surface that tests import from '../src/index.mjs'
// (CD-3, AC-16: stdio behavior unchanged).

import { config as dotenvConfig } from 'dotenv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, ConfigError } from './config.mjs';
import { SSRFViolationError } from './url-validator.mjs';
import * as log from './log.mjs';
import {
  TOOL_DESCRIPTORS,
  discoverAgentsHandler,
  getPaymentQuoteHandler,
  payX402Handler,
} from './handlers.mjs';

// Re-export the shared handler API so existing tests/imports keep working.
// AC-16 invariant: stdio transport behavior is unchanged; the only diff is
// where the implementation lives (CD-3: handlers.mjs is the single source
// of truth for stdio + HTTP).
export {
  sanitizeInput,
  resolveEndpoint,
  resolveMaxAmountGuard,
  TOOL_DESCRIPTORS,
  REDIRECT_REFUSED_MSG,
  discoverAgentsHandler,
  getPaymentQuoteHandler,
  payX402Handler,
} from './handlers.mjs';

// ── Wrap a handler return as an MCP CallTool result ────────────────────────
function asToolResult(value) {
  return {
    content: [
      { type: 'text', text: JSON.stringify(value) },
    ],
  };
}

// ── MCP server bootstrap ───────────────────────────────────────────────────
async function main() {
  // Load .env in dev (no-op in Claude Console managed env).
  dotenvConfig();
  if (!process.env.WASIAI_GATEWAY_URL && process.env.NODE_ENV !== 'production') {
    log.warnOnce('dotenv-missing', 'mcp.dotenv', { hint: '.env missing or empty in dev' });
  }

  // Config fail-fast (AC-6, AC-8, CD-16: exit only at startup).
  let cfg;
  try {
    cfg = await loadConfig();
  } catch (e) {
    if (e instanceof ConfigError || e instanceof SSRFViolationError) {
      process.stderr.write(`[wasiai-x402] CONFIG ERROR: ${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }
  log.info('mcp.startup', {
    tool: '_lifecycle', stage: 'startup', ok: true,
    operator: cfg.operatorAddress,
    gateway: cfg.gatewayUrl.toString(),
    chainId: cfg.chainId,
  });

  const server = new Server(
    { name: 'wasiai-x402', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DESCRIPTORS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      switch (name) {
        case 'discover_agents': {
          const r = await discoverAgentsHandler(args, cfg);
          return asToolResult(r);
        }
        case 'get_payment_quote': {
          const r = await getPaymentQuoteHandler(args, cfg);
          return asToolResult(r);
        }
        case 'pay_x402': {
          const r = await payX402Handler(args, cfg);
          return asToolResult(r);
        }
        default:
          return asToolResult({ ok: false, stage: 'input', error: `unknown tool: ${name}` });
      }
    } catch (e) {
      log.error('mcp.tool.unhandled', {
        tool: name, ok: false, error: e.message,
      });
      // CD-16: never process.exit() inside a tool handler.
      return asToolResult({ ok: false, stage: 'unhandled', error: e.message });
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info('mcp.connected', { tool: '_lifecycle', stage: 'connected', ok: true, transport: 'stdio' });
}

// Only run main() when invoked directly (allows test imports without bootstrap).
const isDirectInvocation =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/src/index.mjs') ||
  process.argv[1]?.endsWith('\\src\\index.mjs');

if (isDirectInvocation) {
  main().catch(e => {
    process.stderr.write(`[wasiai-x402] FATAL: ${e.message}\n`);
    process.exit(1);
  });
}
