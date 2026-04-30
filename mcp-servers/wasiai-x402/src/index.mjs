#!/usr/bin/env node
// index.mjs — MCP server bootstrap + 3 tool handlers.
//
// Tools (DT-J fixed scope, no health/version/poll):
//   - discover_agents     — GET /api/v1/capabilities passthrough
//   - get_payment_quote   — probe endpoint, parse 402 challenge, NO signature
//   - pay_x402            — full probe→sign→retry x402 flow
//
// Logger to stderr only (DT-L). Stdout is reserved for MCP JSON-RPC frames.

import { config as dotenvConfig } from 'dotenv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomBytes } from 'node:crypto';
import { loadConfig, ConfigError } from './config.mjs';
import { signX402Envelope } from './sign.mjs';
import { SSRFViolationError } from './url-validator.mjs';
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
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(cfg.payTimeoutMs) });
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
  if (!['compose', 'orchestrate'].some(m => endpoint.includes(`/api/v1/${m}`))) {
    log.warn('tool.get_payment_quote.unexpected-endpoint', { endpoint });
  }
  const url = new URL(endpoint, cfg.gatewayUrl).toString();
  // AC-2: NO payment-signature header here.
  const headers = { 'Content-Type': 'application/json' };
  log.info('tool.get_payment_quote.probe', {
    tool: 'get_payment_quote', stage: 'probe', gateway: cfg.gatewayUrl.toString(),
    operator: cfg.operatorAddress, ok: true,
  });
  const res = await fetch(url, {
    method,
    headers,
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(cfg.payTimeoutMs),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  log.info('tool.get_payment_quote.done', {
    tool: 'get_payment_quote', stage: 'done', gateway: cfg.gatewayUrl.toString(),
    operator: cfg.operatorAddress, ok: res.status === 402, status: res.status,
  });
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
  const url = new URL(endpoint, cfg.gatewayUrl).toString();

  // [1] Probe (no signature)
  let probeRes;
  try {
    probeRes = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(cfg.payTimeoutMs),
    });
  } catch (e) {
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
    log.error('tool.pay_x402.sign-error', {
      tool: 'pay_x402', stage: 'sign', gateway: cfg.gatewayUrl.toString(),
      operator: cfg.operatorAddress, ok: false, error: e.message,
    });
    return { ok: false, stage: 'sign', error: `signing failed: ${e.message}` };
  }

  log.info('tool.pay_x402.signed', {
    tool: 'pay_x402', stage: 'sign-ok', gateway: cfg.gatewayUrl.toString(),
    operator: cfg.operatorAddress, ok: true,
    signature: envelope.signature,  // logger truncates to 10 chars
  });

  // [4] Retry with payment-signature header
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
    });
  } catch (e) {
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
  log.info('mcp.connected', { transport: 'stdio' });
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
