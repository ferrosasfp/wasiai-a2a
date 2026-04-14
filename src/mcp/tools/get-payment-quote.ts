/**
 * get_payment_quote — Probe an endpoint to determine whether it requires
 * x402 payment. GET + parse `X402Response.accepts[0]` if 402, else
 * `{ required: false }`. No signing.
 *
 * BLQ-1: gatewayUrl is validated through validateGatewayUrl() before the
 * outbound fetch to prevent SSRF.
 */

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
  // BLQ-1: SSRF guard — rejects non-http(s), private IPs, localhost,
  // link-local, and hosts not in MCP_GATEWAY_ALLOWLIST (if configured).
  await validateGatewayUrl(input.gatewayUrl);

  const url = `${input.gatewayUrl}${input.endpoint}`;
  const res = await fetch(url, { method: 'GET' });

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
