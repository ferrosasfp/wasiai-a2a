/**
 * pay_x402 — Client-side x402 flow: initial fetch -> detect 402 -> EIP-712
 * sign via KiteOzonePaymentAdapter -> retry with payment-signature header.
 *
 * Signing is delegated entirely to `getPaymentAdapter().sign()` (CD-1).
 * This tool MUST NOT settle or verify via the adapter (CD-7).
 *
 * BLQ-1: gatewayUrl is validated through validateGatewayUrl() before each
 * outbound fetch to prevent SSRF.
 * MNR-2: AbortError from the global fetch timeout maps to -32002.
 * MNR-3: env `MCP_MAX_AMOUNT_WEI_DEFAULT` provides a safe default amount
 * guard when the caller does not supply `maxAmountWei`.
 */

import { getPaymentAdapter } from '../../adapters/registry.js';
import type { SignResult } from '../../adapters/types.js';
import type { X402Response } from '../../types/index.js';
import {
  MCP_ERRORS,
  MCPToolError,
  type PayX402Input,
  type PayX402Output,
  type ToolContext,
} from '../types.js';
import { validateGatewayUrl } from '../url-validator.js';

async function parseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  const text = await response.text();
  return text.length > 0 ? text : null;
}

/**
 * Performs `fetch` and translates an AbortError (timeout) into a structured
 * -32002 MCPToolError so callers can distinguish timeouts from network
 * errors (MNR-2).
 */
async function fetchWithTimeoutMapping(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new MCPToolError(
        MCP_ERRORS.UPSTREAM_GATEWAY,
        `Gateway timeout after ${timeoutMs}ms`,
      );
    }
    throw err;
  }
}

/**
 * Resolves the effective maxAmountWei guard. Priority:
 *   1. caller-provided input.maxAmountWei
 *   2. env MCP_MAX_AMOUNT_WEI_DEFAULT
 *   3. undefined (no guard)
 */
function resolveMaxAmountWei(input: PayX402Input): string | undefined {
  if (input.maxAmountWei !== undefined) return input.maxAmountWei;
  const envDefault = process.env.MCP_MAX_AMOUNT_WEI_DEFAULT;
  if (envDefault && envDefault.length > 0) return envDefault;
  return undefined;
}

export async function payX402(
  input: PayX402Input,
  _ctx: ToolContext,
): Promise<PayX402Output> {
  // BLQ-1: SSRF guard — rejects non-http(s), private IPs, localhost,
  // link-local, and hosts not in MCP_GATEWAY_ALLOWLIST (if configured).
  await validateGatewayUrl(input.gatewayUrl);

  const timeoutMs = parseInt(process.env.MCP_PAY_TIMEOUT_MS ?? '30000', 10);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const url = `${input.gatewayUrl}${input.endpoint}`;
  const method = input.method ?? 'POST';
  const baseHeaders: Record<string, string> = {
    'content-type': 'application/json',
    ...(input.headers ?? {}),
  };

  const maxAmountWei = resolveMaxAmountWei(input);

  try {
    const res1 = await fetchWithTimeoutMapping(
      url,
      {
        method,
        headers: baseHeaders,
        body:
          input.payload !== undefined ? JSON.stringify(input.payload) : undefined,
        signal: controller.signal,
      },
      timeoutMs,
    );

    // AC-2: non-402 -> return directly, no signing.
    if (res1.status !== 402) {
      return {
        status: res1.status,
        result: await parseBody(res1),
      };
    }

    // AC-1 / AC-4 path: parse 402 body.
    let body: X402Response;
    try {
      body = (await res1.json()) as X402Response;
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

    // maxAmountWei guard — applies when caller provides input.maxAmountWei
    // or when MCP_MAX_AMOUNT_WEI_DEFAULT is configured (MNR-3).
    if (maxAmountWei !== undefined) {
      try {
        if (BigInt(accept.maxAmountRequired) > BigInt(maxAmountWei)) {
          throw new MCPToolError(
            MCP_ERRORS.UPSTREAM_GATEWAY,
            'Gateway requested amount exceeds maxAmountWei guard',
            {
              requested: accept.maxAmountRequired,
              max: maxAmountWei,
            },
          );
        }
      } catch (err) {
        if (err instanceof MCPToolError) throw err;
        throw new MCPToolError(
          MCP_ERRORS.UPSTREAM_GATEWAY,
          'Invalid wei amount in 402 response',
        );
      }
    }

    // AC-1: Sign (CD-1: only sign, never settle/verify).
    let signResult: SignResult;
    try {
      const adapter = getPaymentAdapter();
      signResult = await adapter.sign({
        to: accept.payTo as `0x${string}`,
        value: accept.maxAmountRequired,
        timeoutSeconds: accept.maxTimeoutSeconds,
      });
    } catch (err) {
      // AC-3: map to -32001 without stack.
      const message = err instanceof Error ? err.message : 'unknown error';
      throw new MCPToolError(
        MCP_ERRORS.TOOL_EXECUTION,
        `Signing failed: ${message}`,
      );
    }

    // AC-1: retry with payment-signature header.
    const res2 = await fetchWithTimeoutMapping(
      url,
      {
        method,
        headers: {
          ...baseHeaders,
          'payment-signature': signResult.xPaymentHeader,
        },
        body:
          input.payload !== undefined ? JSON.stringify(input.payload) : undefined,
        signal: controller.signal,
      },
      timeoutMs,
    );

    if (!res2.ok) {
      // AC-4: non-2xx on retry -> -32002 with status + body.
      const bodyText = await res2.text();
      throw new MCPToolError(
        MCP_ERRORS.UPSTREAM_GATEWAY,
        'Upstream gateway error after payment',
        { status: res2.status, body: bodyText },
      );
    }

    const parsed = await parseBody(res2);
    const txHashHeader = res2.headers.get('payment-response');

    return {
      status: res2.status,
      result: parsed,
      txHash: txHashHeader ?? undefined,
      amountPaid: accept.maxAmountRequired,
    };
  } finally {
    clearTimeout(timer);
  }
}
