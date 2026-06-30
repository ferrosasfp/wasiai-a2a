/**
 * get_payment_quote — Probe an endpoint to determine whether it requires
 * x402 payment. GET + parse `X402Response.accepts[0]` if 402, else
 * `{ required: false }`. No signing.
 *
 * BLQ-1: gatewayUrl is validated through validateGatewayUrl() before the
 * outbound fetch to prevent SSRF.
 */

import { ssrfFetch } from '../../lib/ssrf-dispatcher.js';
import type { X402Response } from '../../types/index.js';
import {
  type GetPaymentQuoteInput,
  type GetPaymentQuoteOutput,
  MCP_ERRORS,
  MCPToolError,
  type ToolContext,
} from '../types.js';
import { validateGatewayUrl } from '../url-validator.js';

export async function getPaymentQuote(
  input: GetPaymentQuoteInput,
  _ctx: ToolContext,
): Promise<GetPaymentQuoteOutput> {
  // BLQ-1: SSRF guard (first defense) — rejects non-http(s), private IPs,
  // localhost, link-local, and hosts not in MCP_GATEWAY_ALLOWLIST.
  await validateGatewayUrl(input.gatewayUrl);

  // WKH-SEC-04 (CD-1 / DT-1): validate the FINAL URL (`gatewayUrl + endpoint`)
  // built via `new URL(endpoint, gatewayUrl)`, which normalizes the userinfo
  // bypass to its real host, before any fetch.
  const url = new URL(input.endpoint, input.gatewayUrl).toString();
  await validateGatewayUrl(url);

  // F-02 (audit 2026-06-29): route through ssrfFetch so this MCP probe inherits
  // the connect-time SSRF guard + the H-1 manual redirect re-validation (was
  // bypassing the dispatcher via global fetch).
  const res = await ssrfFetch(url, { method: 'GET' });

  // AC-5: non-402 => no payment required.
  if (res.status !== 402) {
    return { required: false };
  }

  // AC-6: parse body.
  let body: X402Response;
  try {
    body = (await res.json()) as X402Response;
  } catch {
    throw new MCPToolError(
      MCP_ERRORS.UPSTREAM_GATEWAY,
      'Invalid 402 response: body is not JSON',
    );
  }
  const accept = body.accepts?.[0];
  if (!accept) {
    throw new MCPToolError(
      MCP_ERRORS.UPSTREAM_GATEWAY,
      'Invalid 402 response: missing accepts[0]',
    );
  }

  return {
    required: true,
    amount: accept.maxAmountRequired,
    token: accept.asset,
    network: accept.network,
    description: accept.description,
  };
}
