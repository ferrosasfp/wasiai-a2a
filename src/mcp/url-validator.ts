/**
 * MCP URL Validator — SSRF protection for outbound fetches (pay_x402 /
 * get_payment_quote).
 *
 * WKH-62 refactor: this is now a thin adapter over `src/lib/url-validator.ts`.
 * The core validation logic lives in `src/lib/` (domain-neutral, returns
 * `Result`). This module preserves the legacy MCP contract:
 *  - `validateGatewayUrl(rawUrl: string): Promise<URL>` (same signature)
 *  - throws `MCPToolError(-32602)` (same exception type)
 *  - error messages keep the `gatewayUrl ...` prefix (CD-3, CD-5)
 *
 * Allowlist env var: `MCP_GATEWAY_ALLOWLIST` (unchanged).
 */

import {
  type ValidationFailure,
  validateOutboundUrl,
} from '../lib/url-validator.js';
import { MCP_ERRORS, MCPToolError } from './types.js';

/**
 * Maps a core `ValidationFailure` to the legacy MCP message string.
 * Strings here MUST stay byte-equivalent to what
 * `src/mcp/url-validator.test.ts` expects (CD-3).
 */
function mapMcpMessage(failure: ValidationFailure): string {
  switch (failure.category) {
    case 'invalid-url':
      return 'gatewayUrl is not a valid URL';
    case 'invalid-protocol':
      return `gatewayUrl protocol not allowed: ${failure.reason}`;
    case 'blocked-literal':
      return `gatewayUrl hostname not allowed: ${failure.reason}`;
    case 'allowlist':
      return `gatewayUrl host not in MCP_GATEWAY_ALLOWLIST: ${failure.reason}`;
    case 'private-ip':
      // core reason: "URL resolves to non-public IPv{4,6}: <address>"
      return failure.reason.replace(/^URL/, 'gatewayUrl');
    case 'dns-lookup-failed':
      return `gatewayUrl DNS lookup failed: ${failure.reason}`;
  }
}

/**
 * Validates that `rawUrl` is safe to fetch from this process. Throws
 * MCPToolError(-32602) whenever a rule is violated. Returns the parsed URL
 * on success.
 *
 * Performs DNS resolution for hostnames; callers must await.
 */
export async function validateGatewayUrl(rawUrl: string): Promise<URL> {
  const result = await validateOutboundUrl(rawUrl, {
    allowlistEnvVar: 'MCP_GATEWAY_ALLOWLIST',
  });
  if (!result.ok) {
    throw new MCPToolError(
      MCP_ERRORS.INVALID_PARAMS,
      mapMcpMessage(result.error),
    );
  }
  return result.value;
}
