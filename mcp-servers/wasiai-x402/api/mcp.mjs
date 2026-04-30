// SPDX-License-Identifier: MIT
// api/mcp.mjs — Vercel Serverless Function exposing the wasiai-x402 MCP
// server over HTTP Streamable transport (WKH-65, AC-1..AC-16).
//
// Deployment shape:
//   - Vercel Node.js Serverless (NOT Edge: timingSafeEqual + viem need
//     full Node crypto + Buffer; DT-B).
//   - Stateless mode (DT-F, CD-8): a fresh `Server` + transport instance
//     per request. No in-memory session — Vercel functions can be
//     scheduled across machines and short-lived.
//   - maxDuration 60s (DT-C, AC-10) covers the worst-case x402 flow:
//     probe + sign + settle + Kite/Avalanche confirmations.
//
// Auth (AC-5/AC-6/AC-7, CD-1/CD-2/CD-7):
//   - Bearer token validated BEFORE parsing the JSON-RPC body.
//   - timingSafeEqual via src/auth.mjs (CD-2).
//   - Function refuses to start if MCP_BEARER_TOKEN or OPERATOR_PRIVATE_KEY
//     is missing — returns 500 with a structured stderr log line, never
//     "auth disabled".
//
// CORS (AC-9, DT-G):
//   - MCP_CORS_ALLOWED_ORIGINS is a CSV of explicit origins. Default empty
//     ⇒ deny all cross-origin (Claude Console proxies server-side, so
//     "deny all" is the safe default).
//   - Preflight OPTIONS replies 204 with empty Allow-Origin if the origin
//     is not in the allowlist (browsers will block cross-origin XHR).
//
// Reuse (CD-3, CD-4):
//   - Handlers come from ../src/handlers.mjs — same code path as stdio.
//   - Config validation comes from ../src/config.mjs unchanged.
//   - Logger comes from ../src/log.mjs (stderr → Vercel Logs).

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig, ConfigError } from '../src/config.mjs';
import { SSRFViolationError } from '../src/url-validator.mjs';
import * as log from '../src/log.mjs';
import { validateBearerToken, AuthError } from '../src/auth.mjs';
import {
  TOOL_DESCRIPTORS,
  discoverAgentsHandler,
  getPaymentQuoteHandler,
  payX402Handler,
} from '../src/handlers.mjs';

// ── JSON helper for short error replies ────────────────────────────────────
function jsonError(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── CORS preflight handler (AC-9) ──────────────────────────────────────────
function corsPreflightResponse(request) {
  const origin = request.headers.get('origin') ?? '';
  const allowed = (process.env.MCP_CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Only echo the origin back when it is explicitly in the allowlist.
  // For any other origin (or missing var), we omit Allow-Origin entirely
  // so the browser refuses the cross-origin request (deny-by-default).
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
  if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  return new Response(null, { status: 204, headers });
}

// ── Wrap handler return as MCP CallTool result ────────────────────────────
function asToolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

// ── Build a fresh Server bound to the shared handlers ─────────────────────
//
// One Server instance per request (stateless, CD-8). The handlers below
// close over `cfg` so each request uses freshly-validated config.
function buildServer(cfg) {
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
      log.error('mcp.http.tool.unhandled', {
        tool: name, ok: false, error: e.message,
      });
      return asToolResult({ ok: false, stage: 'unhandled', error: e.message });
    }
  });

  return server;
}

// ── Vercel Serverless handler ─────────────────────────────────────────────
//
// Vercel Node.js runtime supports the Web Standards `(req: Request) =>
// Response | Promise<Response>` signature for `*.mjs` files in /api when
// they `export default`. We rely on that exclusively — no req/res shim.
//
// Order of operations (CD-7, AC-5, AC-6):
//   1. CORS preflight → 204 (no auth required for OPTIONS).
//   2. Reject non-POST methods → 405.
//   3. Load config — if MCP_BEARER_TOKEN or OPERATOR_PRIVATE_KEY missing
//      or gateway URL invalid, fail with 500 BEFORE inspecting the body.
//   4. Validate bearer token (timing-safe) BEFORE parsing the body.
//   5. Hand the request off to WebStandardStreamableHTTPServerTransport.
export default async function handler(request) {
  // 1. CORS preflight (AC-9).
  if (request.method === 'OPTIONS') {
    return corsPreflightResponse(request);
  }

  // 2. Method gate — only POST. Streamable HTTP also supports GET (SSE) and
  //    DELETE (session close), but in stateless mode we don't need either,
  //    and Claude Console only uses POST for our use case (DT-F).
  if (request.method !== 'POST') {
    return jsonError(405, { error: 'method not allowed' });
  }

  // 3. Config + bearer token presence (CD-7, AC-7).
  let cfg;
  try {
    cfg = await loadConfig();
  } catch (e) {
    // MNR-iter2-1: do NOT include `event` in the fields payload; it would
    // clobber the canonical event name passed as the first arg.
    if (e instanceof ConfigError || e instanceof SSRFViolationError) {
      log.error('mcp.http.config-error', {
        stage: 'startup', ok: false, error: e.message,
      });
      return jsonError(500, { error: 'server misconfigured' });
    }
    log.error('mcp.http.config-error-unexpected', {
      stage: 'startup', ok: false, error: e.message,
    });
    return jsonError(500, { error: 'server misconfigured' });
  }

  const expectedToken = process.env.MCP_BEARER_TOKEN;
  if (!expectedToken) {
    log.error('mcp.http.missing-bearer-token', {
      stage: 'startup', ok: false,
    });
    return jsonError(500, { error: 'server misconfigured' });
  }

  // 4. Auth (AC-5, AC-6, CD-2).
  try {
    validateBearerToken(request.headers.get('authorization') ?? '', expectedToken);
  } catch (e) {
    if (e instanceof AuthError) {
      // CD-1 / CD-5: never log the presented header (could be the right
      // token, a partial guess, or unrelated PII).
      log.warn('mcp.http.unauthorized', {
        stage: 'verify', ok: false,
      });
      return jsonError(401, { error: 'unauthorized' });
    }
    log.error('mcp.http.auth-unexpected', {
      stage: 'verify', ok: false, error: e.message,
    });
    return jsonError(500, { error: 'server error' });
  }

  // 5. Setup MCP server + transport per request (CD-8, DT-H stateless).
  const server = buildServer(cfg);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: no Mcp-Session-Id header
    enableJsonResponse: true,      // simpler request/response (no SSE) for
                                   // Vercel function lifecycle
  });
  await server.connect(transport);

  // 6. Delegate. WebStandardStreamableHTTPServerTransport.handleRequest
  //    returns a Web Standard Response — Vercel forwards it verbatim.
  return await transport.handleRequest(request);
}
