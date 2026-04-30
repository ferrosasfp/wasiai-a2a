// handlers.mjs — pure tool handlers + helpers shared by stdio and HTTP transports.
//
// Tools (DT-J fixed scope, no health/version/poll):
//   - discover_agents     — GET /api/v1/capabilities passthrough
//   - get_payment_quote   — probe endpoint, parse 402 challenge, NO signature
//   - pay_x402            — full probe→sign→retry x402 flow
//
// This module is consumed by both:
//   - src/index.mjs    → stdio bootstrap (npm start, Claude Console managed)
//   - api/mcp.mjs      → HTTP Streamable transport (Vercel Serverless)
//
// Reuse invariant (CD-3, CD-4, AC-16): both transports MUST delegate to the
// exact same handler functions. Drift between transports is a bug.

import { randomBytes } from 'node:crypto';
import { signX402Envelope } from './sign.mjs';
import { isPathOnly } from './url-validator.mjs';
import * as log from './log.mjs';

// ── Top-level input sanitizer (AC-10, V5.4 explicit scope: top-level only) ─
const FORBIDDEN_INPUT_KEYS = ['OPERATOR_PRIVATE_KEY', 'signature', 'authorization'];

export function sanitizeInput(toolName, input) {
  if (!input || typeof input !== 'object') return input;
  const clean = {};
  let hadForbidden = false;
  for (const [k, v] of Object.entries(input)) {
    if (FORBIDDEN_INPUT_KEYS.includes(k)) {
      hadForbidden = true;
      continue;
    }
    clean[k] = v;
  }
  if (hadForbidden) {
    log.warnOnce(
      `forbidden-input-${toolName}`,
      'mcp.input.forbidden-keys-stripped',
      { tool: toolName },
    );
  }
  // NOTE: deeply-nested keys are NOT inspected. Documented in README §Security.
  return clean;
}

// ── SSRF guard: post-resolution endpoint validation (BLQ-iter2-1) ──────────
//
// resolveEndpoint validates that the resolved URL matches the configured
// gateway (host + protocol) AFTER the WHATWG URL parser has handled any
// tricks (backslash, encoded chars, etc.). Combined with `redirect:'error'`
// in fetch() calls, this ensures the signed envelope cannot be redirected
// cross-origin via a hostile gateway 3xx response.
//
// Defense-in-depth layers:
//   1. isPathOnly() rejects absolute URLs and backslash chars early
//   2. resolveEndpoint() validates target.host === gw.host post-parse
//   3. fetch() with redirect:'error' rejects any 3xx (even legitimate)
//
// Why post-resolution: the WHATWG URL parser treats `\` as `/` for special
// schemes (https:/http:), so endpoints like `/\evil.com/x`, `/\\evil.com`,
// `/\@evil.com`, etc. resolve to https://evil.com/... when combined with
// the gateway base. String-shape heuristics ("starts with /", "no //") can
// be bypassed by these backslash variants. Validating AFTER `new URL(...)`
// is the only reliable approach: we compare what the parser actually
// produced to the configured gateway's host+protocol — i.e. what fetch()
// would actually call. If they don't match, reject before any network or
// signing operation.
//
// Why redirect:'error' (BLQ-iter3-1): WHATWG fetch only strips
// Authorization/Cookie/Proxy-Authorization on cross-origin redirects.
// Custom headers like `payment-signature` (carrying the EIP-3009 envelope)
// are FORWARDED to the redirect target. A hostile gateway responding with
// `302 Location: https://evil.com/...` would leak the signed envelope to
// the attacker host, which can be replayed to drain the operator wallet.
// Rejecting any 3xx at fetch level closes that class entirely.
//
// Returns { ok: true, url: string } on success, { ok: false, error } on
// rejection. Caller maps `ok:false` to the canonical validation response.
export function resolveEndpoint(endpoint, gatewayUrl) {
  // MNR-iter3-1: defensive type/empty check before URL parsing.
  if (typeof endpoint !== 'string' || !endpoint.length) {
    return { ok: false, error: 'endpoint must be a non-empty string' };
  }
  // gatewayUrl is a URL instance (loadConfig returns it from validateGatewayUrl).
  // Defensive: accept a string too, in case a future caller passes a string.
  const gw = gatewayUrl instanceof URL ? gatewayUrl : new URL(gatewayUrl);
  let target;
  try {
    target = new URL(endpoint, gw);
  } catch {
    return { ok: false, error: 'endpoint could not be resolved against the gateway' };
  }
  if (target.host !== gw.host || target.protocol !== gw.protocol) {
    return {
      ok: false,
      error: 'endpoint must resolve to the configured gateway (host and protocol must match)',
    };
  }
  return { ok: true, url: target.toString() };
}

// ── Redirect-error detection (BLQ-iter3-1) ─────────────────────────────────
//
// fetch() with `redirect:'error'` throws TypeError('fetch failed') with
// `cause` containing a message like "redirect mode is set to 'error'".
// We detect this and surface a stable, non-leaky error string to the caller
// instead of the raw undici internals.
export function isRedirectError(e) {
  const msgs = [];
  if (typeof e?.message === 'string') msgs.push(e.message);
  if (typeof e?.cause?.message === 'string') msgs.push(e.cause.message);
  return msgs.some(m => /redirect/i.test(m));
}

export const REDIRECT_REFUSED_MSG = 'gateway responded with redirect; refusing to follow';

// ── Cap guard resolver (AC-11, V6.2 priority per-call > env > undefined) ───
export function resolveMaxAmountGuard(perCall, envDefault) {
  if (perCall !== undefined && perCall !== null) {
    try {
      const b = BigInt(perCall);
      if (b < 0n) throw new Error('negative');
      return b;
    } catch {
      throw new Error(`invalid maxAmountWei in input: ${perCall}`);
    }
  }
  return envDefault;  // bigint | undefined
}

// ── discover_agents handler (AC-1) ─────────────────────────────────────────
export async function discoverAgentsHandler(rawInput, cfg) {
  const input = sanitizeInput('discover_agents', rawInput ?? {});
  const url = new URL('/api/v1/capabilities', cfg.gatewayUrl);
  if (input.query) url.searchParams.set('query', input.query);
  if (input.maxPrice !== undefined) url.searchParams.set('maxPrice', String(input.maxPrice));
  if (Array.isArray(input.capabilities) && input.capabilities.length) {
    url.searchParams.set('capabilities', input.capabilities.join(','));
  }
  log.info('tool.discover_agents.request', {
    tool: 'discover_agents', stage: 'fetch', gateway: cfg.gatewayUrl.toString(),
    operator: cfg.operatorAddress, ok: true,
  });
  // MNR-1: homologar try/catch con payX402Handler.
  let res;
  try {
    res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(cfg.payTimeoutMs),
      // BLQ-iter3-1: never follow gateway redirects (envelope leak class).
      redirect: 'error',
    });
  } catch (e) {
    // BLQ-iter3-1: translate undici redirect-error into a stable message.
    if (isRedirectError(e)) {
      log.warn('tool.discover_agents.redirect-refused', {
        tool: 'discover_agents', stage: 'probe', gateway: cfg.gatewayUrl.toString(),
        operator: cfg.operatorAddress, ok: false,
      });
      return { ok: false, stage: 'probe', error: REDIRECT_REFUSED_MSG };
    }
    log.warn('tool.discover_agents.error', {
      tool: 'discover_agents', stage: 'fetch', gateway: cfg.gatewayUrl.toString(),
      operator: cfg.operatorAddress, ok: false, error: e.message,
    });
    return { ok: false, stage: 'probe', error: `gateway request failed: ${e.message}` };
  }
  let body;
  try { body = await res.json(); } catch { body = {}; }
  log.info('tool.discover_agents.response', {
    tool: 'discover_agents', stage: 'done', gateway: cfg.gatewayUrl.toString(),
    operator: cfg.operatorAddress, ok: res.status === 200, status: res.status,
  });
  // AC-1: return body unchanged.
  return body;
}

// ── get_payment_quote handler (AC-2) ───────────────────────────────────────
export async function getPaymentQuoteHandler(rawInput, cfg) {
  const input = sanitizeInput('get_payment_quote', rawInput ?? {});
  const { endpoint, method = 'POST', payload } = input;
  if (!endpoint || typeof endpoint !== 'string') {
    return { ok: false, stage: 'input', error: 'endpoint required' };
  }
  // BLQ-1 (iter 1): early shape check — reject absolute / protocol-relative
  // URLs and the backslash-bypass class before any URL parsing work.
  if (!isPathOnly(endpoint)) {
    return {
      ok: false,
      stage: 'validation',
      error: 'endpoint must be a path starting with / (absolute URLs are rejected)',
    };
  }
  // BLQ-iter2-1 + BLQ-iter3-1: defense-in-depth SSRF guard. The
  // post-resolution check ensures the resolved URL's host+protocol match
  // the configured gateway, and `redirect:'error'` on fetch below blocks
  // hostile 3xx responses that would otherwise leak the probe (or a future
  // signed envelope) to an attacker host.
  const resolved = resolveEndpoint(endpoint, cfg.gatewayUrl);
  if (!resolved.ok) {
    return { ok: false, stage: 'validation', error: resolved.error };
  }
  if (!['compose', 'orchestrate'].some(m => endpoint.includes(`/api/v1/${m}`))) {
    log.warn('tool.get_payment_quote.unexpected-endpoint', { endpoint });
  }
  const url = resolved.url;
  // AC-2: NO payment-signature header here.
  const headers = { 'Content-Type': 'application/json' };
  log.info('tool.get_payment_quote.probe', {
    tool: 'get_payment_quote', stage: 'probe', gateway: cfg.gatewayUrl.toString(),
    operator: cfg.operatorAddress, ok: true,
  });
  // MNR-1: homologar try/catch con payX402Handler.
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(cfg.payTimeoutMs),
      // BLQ-iter3-1: never follow gateway redirects.
      redirect: 'error',
    });
  } catch (e) {
    if (isRedirectError(e)) {
      log.warn('tool.get_payment_quote.redirect-refused', {
        tool: 'get_payment_quote', stage: 'probe', gateway: cfg.gatewayUrl.toString(),
        operator: cfg.operatorAddress, ok: false,
      });
      return { ok: false, stage: 'probe', error: REDIRECT_REFUSED_MSG };
    }
    log.warn('tool.get_payment_quote.probe-error', {
      tool: 'get_payment_quote', stage: 'probe', gateway: cfg.gatewayUrl.toString(),
      operator: cfg.operatorAddress, ok: false, error: e.message,
    });
    return { ok: false, stage: 'probe', error: `gateway request failed: ${e.message}` };
  }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  log.info('tool.get_payment_quote.done', {
    tool: 'get_payment_quote', stage: 'done', gateway: cfg.gatewayUrl.toString(),
    operator: cfg.operatorAddress, ok: res.status === 402 || res.status === 200, status: res.status,
  });
  // MNR-4: HTTP 200 (free endpoint) is a valid outcome — return ok:true.
  if (res.status === 200) {
    return { ok: true, stage: 'free', status: 200, body };
  }
  if (res.status !== 402) {
    return { ok: false, stage: 'probe', status: res.status, body };
  }
  const accepts = body.accepts?.[0];
  if (!accepts) {
    return { ok: false, stage: 'probe', error: 'invalid 402: missing accepts[0]', body };
  }
  return {
    ok: true,
    stage: 'quote',
    quote: accepts,
    raw: body,
  };
}

// ── pay_x402 handler (AC-3, AC-4, AC-5, AC-11) ─────────────────────────────
export async function payX402Handler(rawInput, cfg) {
  const startedAt = Date.now();
  const input = sanitizeInput('pay_x402', rawInput ?? {});
  const { endpoint, method = 'POST', payload, maxAmountWei } = input;

  if (!endpoint || typeof endpoint !== 'string') {
    return { ok: false, stage: 'input', error: 'endpoint required' };
  }
  // BLQ-1 (iter 1): early shape check — reject absolute / protocol-relative
  // URLs and the backslash-bypass class before any URL parsing work.
  if (!isPathOnly(endpoint)) {
    return {
      ok: false,
      stage: 'validation',
      error: 'endpoint must be a path starting with / (absolute URLs are rejected)',
    };
  }
  // BLQ-iter2-1: authoritative SSRF guard at URL resolution time. The
  // WHATWG URL parser treats `\` as `/` for special schemes, so without
  // post-resolution validation an endpoint like `/\evil.com/x` would
  // resolve to https://evil.com/x. By validating that the resolved URL's
  // host+protocol match the gateway AFTER `new URL(endpoint, gateway)`,
  // we close the backslash-bypass class even if isPathOnly() ever regresses.
  // BLQ-iter3-1: complement with `redirect:'error'` on each fetch() so that
  // a hostile gateway 3xx (Location: https://evil.com/...) cannot be used
  // to leak the signed envelope cross-origin (custom headers like
  // payment-signature are NOT stripped by WHATWG redirect-safe rules).
  const resolved = resolveEndpoint(endpoint, cfg.gatewayUrl);
  if (!resolved.ok) {
    return { ok: false, stage: 'validation', error: resolved.error };
  }
  const url = resolved.url;

  // [1] Probe (no signature)
  let probeRes;
  try {
    probeRes = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(cfg.payTimeoutMs),
      // BLQ-iter3-1: never follow gateway redirects.
      redirect: 'error',
    });
  } catch (e) {
    if (isRedirectError(e)) {
      log.warn('tool.pay_x402.redirect-refused', {
        tool: 'pay_x402', stage: 'probe', gateway: cfg.gatewayUrl.toString(),
        operator: cfg.operatorAddress, ok: false,
      });
      return { ok: false, stage: 'probe', error: REDIRECT_REFUSED_MSG };
    }
    log.warn('tool.pay_x402.probe-error', {
      tool: 'pay_x402', stage: 'probe', gateway: cfg.gatewayUrl.toString(),
      operator: cfg.operatorAddress, ok: false, error: e.message,
    });
    return { ok: false, stage: 'probe', error: `gateway request failed: ${e.message}` };
  }
  const probeText = await probeRes.text();
  let probeBody;
  try { probeBody = JSON.parse(probeText); } catch { probeBody = { raw: probeText }; }

  if (probeRes.status === 200) {
    // Free endpoint — no payment required.
    log.info('tool.pay_x402.free', {
      tool: 'pay_x402', stage: 'free', gateway: cfg.gatewayUrl.toString(),
      operator: cfg.operatorAddress, ok: true, status: 200,
    });
    return { ok: true, stage: 'free', status: 200, result: probeBody, latencyMs: Date.now() - startedAt };
  }
  if (probeRes.status !== 402) {
    log.warn('tool.pay_x402.probe-non-402', {
      tool: 'pay_x402', stage: 'probe', gateway: cfg.gatewayUrl.toString(),
      operator: cfg.operatorAddress, ok: false, status: probeRes.status,
    });
    return { ok: false, stage: 'probe', status: probeRes.status, body: probeBody };
  }
  const accepts = probeBody.accepts?.[0];
  if (!accepts || !accepts.payTo || !accepts.maxAmountRequired) {
    return { ok: false, stage: 'probe', error: 'invalid 402: missing accepts[0]', body: probeBody };
  }

  // MNR-AR-2: warn on network mismatch between the 402 challenge and our chainId.
  // The signed domain.chainId is `cfg.chainId`, so submitting on a different
  // network is operator-side misconfiguration that must be visible in logs.
  const expectedNetwork = `eip155:${cfg.chainId}`;
  if (accepts.network && accepts.network !== expectedNetwork) {
    // MNR-iter2-1: do NOT include `event` in payload — it would clobber
    // the canonical event name passed as the first arg to log.warn().
    log.warn('tool.pay_x402.chain-mismatch', {
      tool: 'pay_x402', stage: 'probe',
      gateway: cfg.gatewayUrl.toString(), operator: cfg.operatorAddress,
      ok: false, expected: expectedNetwork, received: accepts.network,
    });
  }

  // [2] Cap guard (AC-11) BEFORE signing
  let guard;
  try {
    guard = resolveMaxAmountGuard(maxAmountWei, cfg.maxAmountWeiDefault);
  } catch (e) {
    return { ok: false, stage: 'sign', error: e.message };
  }
  let requested;
  try {
    requested = BigInt(accepts.maxAmountRequired);
  } catch {
    return { ok: false, stage: 'probe', error: 'invalid 402: maxAmountRequired not BigInt-parseable', body: probeBody };
  }
  if (guard !== undefined && requested > guard) {
    return {
      ok: false,
      stage: 'sign',
      error: 'amount exceeds maxAmountWei guard',
      requested: requested.toString(),
      max: guard.toString(),
    };
  }

  // [3] Sign (AC-3, AC-5)
  let envelope;
  try {
    const validBefore = BigInt(Math.floor(Date.now() / 1000) + 300);
    const nonce = '0x' + randomBytes(32).toString('hex');
    envelope = await signX402Envelope({
      to: accepts.payTo,
      value: requested,
      validBefore,
      nonce,
      chainId: cfg.chainId,
      contract: cfg.contract,
      domainName: cfg.domainName,
      domainVersion: cfg.domainVersion,
    });
  } catch (e) {
    // AC-5: never expose PK in error message.
    // BLQ-2: sanitize agent-facing error. viem's signTypedData throws verbose
    // messages that expose internals; we keep them in stderr only.
    log.error('tool.pay_x402.sign-error', {
      tool: 'pay_x402', stage: 'sign', gateway: cfg.gatewayUrl.toString(),
      operator: cfg.operatorAddress, ok: false, error: e.message,
    });
    // Allow our own well-known throw messages through so the agent can
    // distinguish "config missing" from "signing failed". Anything else
    // gets a stable, non-verbose label.
    const isOurOwn = typeof e.message === 'string'
      && e.message.includes('OPERATOR_PRIVATE_KEY missing at sign-time');
    return {
      ok: false,
      stage: 'sign',
      error: isOurOwn
        ? `signing failed: ${e.message}`
        : 'signing failed (see stderr logs)',
    };
  }

  log.info('tool.pay_x402.signed', {
    tool: 'pay_x402', stage: 'sign-ok', gateway: cfg.gatewayUrl.toString(),
    operator: cfg.operatorAddress, ok: true,
    signature: envelope.signature,  // logger truncates to 10 chars
  });

  // [4] Retry with payment-signature header
  // BLQ-iter3-1: this is the CRITICAL fetch — it carries the signed EIP-3009
  // envelope in `payment-signature`. WHATWG fetch does NOT strip custom
  // headers on cross-origin redirects (only Authorization/Cookie/Proxy-
  // Authorization), so without `redirect:'error'` a gateway responding 302
  // would leak the envelope to the attacker host, who can replay it on the
  // legitimate gateway and drain the operator wallet.
  let settleRes;
  try {
    settleRes = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'payment-signature': envelope.envelopeBase64,
      },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(cfg.payTimeoutMs),
      // BLQ-iter3-1: never follow gateway redirects. Even the legitimate
      // gateway must answer settle directly (200/4xx/5xx).
      redirect: 'error',
    });
  } catch (e) {
    if (isRedirectError(e)) {
      log.warn('tool.pay_x402.redirect-refused', {
        tool: 'pay_x402', stage: 'settle', gateway: cfg.gatewayUrl.toString(),
        operator: cfg.operatorAddress, ok: false,
      });
      return { ok: false, stage: 'settle', error: REDIRECT_REFUSED_MSG };
    }
    log.warn('tool.pay_x402.settle-error', {
      tool: 'pay_x402', stage: 'settle', gateway: cfg.gatewayUrl.toString(),
      operator: cfg.operatorAddress, ok: false, error: e.message,
    });
    return { ok: false, stage: 'settle', error: `gateway settle failed: ${e.message}` };
  }
  const settleText = await settleRes.text();
  let settleBody;
  try { settleBody = JSON.parse(settleText); } catch { settleBody = { raw: settleText }; }

  log.info('tool.pay_x402.settle', {
    tool: 'pay_x402', stage: 'settle', gateway: cfg.gatewayUrl.toString(),
    operator: cfg.operatorAddress, ok: settleRes.status === 200, status: settleRes.status,
  });

  if (settleRes.status !== 200) {
    return { ok: false, stage: 'settle', status: settleRes.status, body: settleBody };
  }

  // V8.1: response NEVER includes signature/authorization plain.
  return {
    ok: true,
    stage: 'settled',
    status: 200,
    result: settleBody,
    kiteTxHash: settleBody?.kiteTxHash,
    latencyMs: Date.now() - startedAt,
  };
}

// ── Tool descriptors for MCP tools/list ────────────────────────────────────
export const TOOL_DESCRIPTORS = [
  {
    name: 'discover_agents',
    description: 'List capabilities/agents available at the WasiAI gateway. Optional filters: query, maxPrice, capabilities[].',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text query passed to /api/v1/capabilities.' },
        maxPrice: { type: 'number', description: 'Max price filter (gateway-defined unit).' },
        capabilities: { type: 'array', items: { type: 'string' }, description: 'Capability names filter.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_payment_quote',
    description: 'Probe a paid endpoint without signing; return the 402 challenge as a quote (payTo, maxAmountRequired, network).',
    inputSchema: {
      type: 'object',
      properties: {
        endpoint: { type: 'string', description: 'Path or absolute URL of the paid endpoint (e.g. /api/v1/orchestrate).' },
        method: { type: 'string', description: 'HTTP method (default POST).' },
        payload: { type: 'object', description: 'Request body to send during the probe.' },
      },
      required: ['endpoint'],
      additionalProperties: false,
    },
  },
  {
    name: 'pay_x402',
    description: 'Execute a full x402 payment flow: probe → sign EIP-3009 → retry with payment-signature header.',
    inputSchema: {
      type: 'object',
      properties: {
        endpoint: { type: 'string' },
        method: { type: 'string' },
        payload: { type: 'object' },
        maxAmountWei: {
          type: ['string', 'number'],
          description: 'Per-call cap in wei (overrides MCP_MAX_AMOUNT_WEI_DEFAULT). Priority: per-call > env > undefined.',
        },
      },
      required: ['endpoint'],
      additionalProperties: false,
    },
  },
];
