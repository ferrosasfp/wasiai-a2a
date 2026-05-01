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
// WKH-66 W2.5 (insert-only DT-J): rate limit + balance gate integration.
import { getKvClient } from '../src/kv-client.mjs';
import { checkRateLimit, hashBearer } from '../src/rate-limit.mjs';
import {
  checkBalanceWithClaim,
  releaseClaim,
} from '../src/balance-guard.mjs';
import { getAvaxClient } from '../src/avax-client.mjs';

// ── JSON helper for short error replies ────────────────────────────────────
function jsonError(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── CORS allowlist parser (AC-9, MNR-AR-2) ────────────────────────────────
//
// Returns the literal origin to echo back, or null if the request origin is
// not in MCP_CORS_ALLOWED_ORIGINS. Note: '*' is NOT supported as a wildcard
// (deny-by-default literal match — see .env.example for rationale).
function resolveAllowedOrigin(request) {
  const origin = request.headers.get('origin') ?? '';
  if (!origin) return null;
  const allowed = (process.env.MCP_CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

// ── CORS preflight handler (AC-9) ──────────────────────────────────────────
function corsPreflightResponse(request) {
  const echoOrigin = resolveAllowedOrigin(request);
  // Only echo the origin back when it is explicitly in the allowlist.
  // For any other origin (or missing var), we omit Allow-Origin entirely
  // so the browser refuses the cross-origin request (deny-by-default).
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
  if (echoOrigin) {
    headers['Access-Control-Allow-Origin'] = echoOrigin;
    headers['Vary'] = 'Origin';
  }
  return new Response(null, { status: 204, headers });
}

// ── Wrap handler return as MCP CallTool result ────────────────────────────
function asToolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

// ── WKH-66 W2.5: balance gate wrapper for pay_x402 (DT-J §11) ─────────────
//
// Wraps payX402Handler with:
//   1. Pre-call: checkBalanceWithClaim — fail-secure on KV/RPC down.
//   2. try: invoke handler (untouched src/handlers.mjs).
//   3. finally: releaseClaim (best-effort, never throws).
//
// The balance gate runs ONLY for pay_x402. discover_agents and
// get_payment_quote bypass this wrapper (they don't sign).
//
// Inputs derived from cfg + env:
//   - operator      : viem privateKeyToAccount(cfg.operatorPrivateKey).address
//   - chainId       : MCP_OPERATOR_CHAIN_ID (default 43114 mainnet)
//   - usdcAddress   : AVALANCHE_USDC_ADDRESS (default canonical Circle USDC)
//   - rpcUrl        : AVALANCHE_RPC_URL
//   - threshold     : MCP_BALANCE_THRESHOLD_USDC (default 0.50)
//   - requestedWei  : args.maxAmountWei (cast to BigInt)
export async function runWithBalanceGate(args, cfg, runHandler) {
  // cfg.operatorAddress is already derived inside loadConfig (which has
  // already run on every request — see step 5). We re-use it here so we
  // never need to touch the PK in the balance-gate code path (defense in
  // depth: the PK stays in process.env + sign.mjs only).
  const operator = cfg.operatorAddress;
  if (!operator) {
    log.error('mcp.balance.operator-derive-failed', {
      stage: 'balance-gate', error: 'cfg.operatorAddress missing',
    });
    return { ok: false, stage: 'balance-gate', error: 'operator derivation failed' };
  }

  const chainId = parseInt(process.env.MCP_OPERATOR_CHAIN_ID ?? '43114', 10);
  const usdcAddress = process.env.AVALANCHE_USDC_ADDRESS
    ?? '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';
  const rpcUrl = process.env.AVALANCHE_RPC_URL
    ?? 'https://api.avax.network/ext/bc/C/rpc';

  // MNR-AR-2: validate MCP_BALANCE_THRESHOLD_USDC before use. parseFloat('abc')
  // returns NaN, parseFloat('-1') returns -1 — both would silently bypass the
  // gate (NaN comparisons always false; negative thresholds approve anything).
  const thresholdRaw = process.env.MCP_BALANCE_THRESHOLD_USDC ?? '0.50';
  const threshold = parseFloat(thresholdRaw);
  if (!Number.isFinite(threshold) || threshold < 0) {
    log.error('mcp.balance-gate.invalid-threshold', {
      thresholdRaw, stage: 'config', ok: false,
    });
    return { ok: false, stage: 'balance-gate', error: 'invalid threshold config' };
  }

  let requestedWei;
  try {
    if (args?.maxAmountWei == null) {
      // No amount provided — we can't reserve a specific claim. Reject early
      // rather than gate against a default that hides operator drain.
      return {
        ok: false, stage: 'balance-gate',
        error: 'maxAmountWei required (balance gate cannot reserve a claim without it)',
      };
    }
    requestedWei = BigInt(args.maxAmountWei);
  } catch {
    return { ok: false, stage: 'balance-gate', error: 'maxAmountWei must be a bigint-parseable string' };
  }

  const kv = getKvClient();
  // MNR-CR-3 + MNR-CR-4: reuse the singleton viem PublicClient instead of
  // instantiating one per request.
  const publicClient = getAvaxClient(rpcUrl);

  const gate = await checkBalanceWithClaim({
    operator,
    chainId,
    requestedWei,
    threshold,
    kvClient: kv,
    publicClient,
    usdcAddress,
  });
  if (!gate.ok) return gate;

  try {
    return await runHandler();
  } finally {
    await releaseClaim({
      claimKey: gate.claimKey,
      requestedWei,
      kvClient: kv,
    });
  }
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
          // WKH-66 W2.5 — Balance gate + atomic claim wrapper (DT-J §11).
          // Insert-only: payX402Handler itself stays untouched (CD-1).
          const gateResult = await runWithBalanceGate(args, cfg, () => payX402Handler(args, cfg));
          return asToolResult(gateResult);
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
// Order of operations (CD-7, AC-5, AC-6, MNR-CR-6):
//   1. CORS preflight → 204 (no auth required for OPTIONS).
//   2. Reject non-POST methods → 405.
//   3. Bearer token presence + timing-safe verify — BEFORE any DNS or
//      gateway-URL validation. An unauth caller must never trigger
//      validateGatewayUrl (which does DNS lookups for SSRF defense).
//   4. loadConfig() — validate OPERATOR_PRIVATE_KEY, gateway URL, etc.
//      Only authenticated callers reach this step.
//   5. Setup MCP server + transport per request (stateless, CD-8).
//   6. Hand the request off to WebStandardStreamableHTTPServerTransport,
//      then close transport + server in `finally` (MNR-CR-1).
//   7. Echo Access-Control-Allow-Origin on the response if the request
//      origin is in the allowlist (MNR-AR-2 — browsers need it on POST).
// Web Standards handler — pure (Request) => Promise<Response>. The Vercel
// adapter at the bottom of this file converts between Express-style (req, res)
// and this Web Standards signature. We keep the core handler in this shape
// to (a) match the test surface (tests/http.test.mjs expects (Request)→Response)
// and (b) avoid leaking Node req/res specifics into the rest of the codebase.
export async function webHandler(request) {
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

  // 3. Bearer token presence + verify (MNR-CR-6: BEFORE loadConfig).
  //
  //    Why first: loadConfig() runs validateGatewayUrl(), which performs
  //    DNS lookups + literal-host checks against WASIAI_GATEWAY_URL. If we
  //    let an unauthenticated caller drive that path, we expose a free
  //    DNS-lookup primitive (and waste compute on every 401). Verifying the
  //    bearer first keeps unauthenticated traffic strictly off the
  //    config/SSRF code path.
  //
  //    AC-7 still holds: if MCP_BEARER_TOKEN is missing, we return 500
  //    without ever calling loadConfig — the auth-disabled scenario is
  //    impossible.
  const expectedToken = process.env.MCP_BEARER_TOKEN;
  if (!expectedToken) {
    log.error('mcp.http.missing-bearer-token', {
      stage: 'startup', ok: false,
    });
    return jsonError(500, { error: 'server misconfigured' });
  }
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

  // 4. WKH-66 W2.5 — Rate limit (DT-J §11). Runs AFTER bearer auth so an
  //    unauthenticated caller never touches KV. Fail-open: KV down → allow,
  //    so an Upstash outage doesn't take the MCP offline. The bearer hash
  //    is sha256 trunc 16 (CD-14) so KV inspector can't enumerate bearers.
  //
  //    Defaults match .env.example: 5 req/min per bearer, 60s window.
  try {
    const kv = getKvClient();
    const presented = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/, '');
    const bearerHash16 = hashBearer(presented);
    const perMin = parseInt(process.env.MCP_RATE_LIMIT_PER_MIN ?? '5', 10);
    const windowSec = parseInt(process.env.MCP_RATE_LIMIT_WINDOW_SEC ?? '60', 10);
    const rl = await checkRateLimit({ bearerHash16, kvClient: kv, perMin, windowSec });
    if (!rl.ok) {
      log.warn('mcp.http.rate-limited', { stage: 'rate-limit', retryAfter: rl.retryAfter });
      return new Response(
        JSON.stringify({ error: 'rate limit exceeded', retryAfter: rl.retryAfter }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(rl.retryAfter),
          },
        },
      );
    }
  } catch (e) {
    // Defensive: rate-limit module is fail-open by design, but if anything
    // upstream (getKvClient, hashBearer) throws we MUST NOT 500 the request.
    log.warn('mcp.http.rate-limit-error', { stage: 'rate-limit', error: e?.message ?? 'unknown' });
  }

  // 5. Config (CD-7, AC-7) — only after auth so unauth callers never
  //    trigger DNS / SSRF validation work.
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
  //    MNR-CR-1: try/finally to clean up transport + server even though
  //    stateless mode does not accumulate session state today. Defensive
  //    against future config changes (e.g. enableJsonResponse:false ⇒ SSE).
  let response;
  try {
    response = await transport.handleRequest(request);
  } finally {
    try { await transport.close?.(); } catch { /* ignore — best-effort cleanup */ }
    try { await server.close?.(); } catch { /* ignore — best-effort cleanup */ }
  }

  // 7. MNR-AR-2: echo Access-Control-Allow-Origin on POST responses for
  //    origins explicitly in the allowlist. Browsers require this header
  //    on the actual response (not just the preflight) for the JS to read
  //    the body. We don't mutate the response if the origin is not allowed
  //    or missing — same deny-by-default semantics as preflight.
  const echoOrigin = resolveAllowedOrigin(request);
  if (echoOrigin) {
    response.headers.set('Access-Control-Allow-Origin', echoOrigin);
    response.headers.set('Vary', 'Origin');
  }
  return response;
}

// ── Vercel Express-style adapter ──────────────────────────────────────────
//
// Vercel Functions in /api default to `shouldAddHelpers: true`, which means
// the runtime invokes the handler as `(req, res) => void` and waits for
// `res.end()` before completing the response. Returning a Web Standards
// `Response` from such a handler causes the function to hang until timeout
// (witnessed during WKH-65 deploy validation: 60s timeout regardless of
// auth state).
//
// This adapter converts:
//   - Express IncomingMessage `req` ⇒ Web Standards `Request`
//   - Web Standards `Response` ⇒ Express ServerResponse `res`
//
// Body handling: Vercel's body parser may have already populated `req.body`.
// We serialize it back to JSON for the Web Standards Request body so the MCP
// SDK transport can `await request.json()` as expected. For non-POST methods
// the body is undefined.
export default async function vercelHandler(req, res) {
  try {
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host || 'wasiai-x402-mcp.vercel.app';
    const url = new URL(req.url || '/', `${protocol}://${host}`);

    // Build headers as Web Standards Headers
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        for (const vv of v) headers.append(k, vv);
      } else {
        headers.set(k, v);
      }
    }

    // Body: only for methods that can carry one
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      if (req.body !== undefined) {
        // Vercel pre-parsed the body. Serialize back to JSON if object/array.
        if (typeof req.body === 'string') {
          body = req.body;
        } else if (Buffer.isBuffer(req.body)) {
          body = req.body;
        } else {
          body = JSON.stringify(req.body);
        }
      }
    }

    const webRequest = new Request(url, {
      method: req.method,
      headers,
      body,
    });

    const response = await webHandler(webRequest);

    // Pipe Response back to res
    res.statusCode = response.status;
    for (const [k, v] of response.headers) {
      res.setHeader(k, v);
    }
    const text = await response.text();
    res.end(text);
  } catch (e) {
    log.error('mcp.http.adapter-error', {
      stage: 'adapter', ok: false, error: e.message,
    });
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'internal' }));
  }
}
