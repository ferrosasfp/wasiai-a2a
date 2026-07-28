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
import { ssrfFetch } from '../../lib/ssrf-dispatcher.js';
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
 * Nombres de error que significan "el request se abortó por un presupuesto de
 * tiempo". Los DOS hacen falta (HU-195 fix-pack, AR MNR-6):
 *
 *   · `AbortError` — lo que produce `controller.abort()`, o sea el
 *     `MCP_PAY_TIMEOUT_MS` de esta herramienta.
 *   · `TimeoutError` — lo que produce `AbortSignal.timeout`, o sea el techo de
 *     hop de `OUTBOUND_HOP_TIMEOUT_MS` que `ssrfFetch` adjunta (un `DOMException`
 *     con `name === 'TimeoutError'`, verificado empíricamente).
 *
 * Con los defaults de hoy (`MCP_PAY_TIMEOUT_MS = 30_000 <
 * OUTBOUND_HOP_TIMEOUT_MS = 60_000`) gana siempre el primero, así que el segundo
 * es inalcanzable — pero se rompe en cuanto un operador sube esa env por arriba
 * del techo del hop: el timeout dejaría de mapear al -32002 estructurado y
 * saldría como error crudo.
 */
const TIMEOUT_ERROR_NAMES = new Set(['AbortError', 'TimeoutError']);

/**
 * Performs `fetch` and translates a timeout abort into a structured -32002
 * MCPToolError so callers can distinguish timeouts from network errors (MNR-2).
 */
async function fetchWithTimeoutMapping(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    // F-02 (audit 2026-06-29): route through ssrfFetch so the MCP outbound
    // payment fetches inherit the connect-time SSRF guard + the H-1 manual
    // redirect re-validation (was bypassing the dispatcher via global fetch).
    return await ssrfFetch(url, init);
  } catch (err) {
    if (err instanceof Error && TIMEOUT_ERROR_NAMES.has(err.name)) {
      throw new MCPToolError(
        MCP_ERRORS.UPSTREAM_GATEWAY,
        // El presupuesto EFECTIVO es el más corto de los dos, así que se nombran
        // los dos en vez de mentir con uno solo.
        `Gateway timeout (budget: MCP_PAY_TIMEOUT_MS=${timeoutMs}ms or the outbound hop ceiling, whichever is shorter)`,
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
  // BLQ-1: SSRF guard (first defense) — rejects non-http(s), private IPs,
  // localhost, link-local, and hosts not in MCP_GATEWAY_ALLOWLIST.
  await validateGatewayUrl(input.gatewayUrl);

  // WKH-SEC-04 (CD-1 / DT-1): the actual fetch targets `gatewayUrl + endpoint`.
  // Build the final URL with `new URL(endpoint, gatewayUrl)` so the userinfo
  // bypass (e.g. endpoint `@169.254.169.254/foo`) is normalized to its real
  // host, then validate THAT URL before any fetch. Validating only
  // `gatewayUrl` is insufficient (the endpoint can re-target the host).
  const url = new URL(input.endpoint, input.gatewayUrl).toString();
  await validateGatewayUrl(url);

  const timeoutMs = parseInt(process.env.MCP_PAY_TIMEOUT_MS ?? '30000', 10);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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
        ...(input.payload !== undefined
          ? { body: JSON.stringify(input.payload) }
          : {}),
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
        ...(input.payload !== undefined
          ? { body: JSON.stringify(input.payload) }
          : {}),
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
