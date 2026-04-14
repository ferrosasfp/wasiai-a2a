/**
 * MCP URL Validator — SSRF protection for outbound fetches (pay_x402 /
 * get_payment_quote).
 *
 * Rules:
 *  1. Must parse as a URL.
 *  2. Protocol must be http: or https:.
 *  3. Hostname must resolve to a PUBLIC IP — private/link-local/loopback
 *     ranges are rejected.
 *  4. Literal hostnames `localhost` and `*.local` are rejected.
 *  5. If MCP_GATEWAY_ALLOWLIST is set (CSV of hostnames), only hosts in
 *     the list are allowed.
 *
 * Throws MCPToolError(-32602) whenever a rule is violated.
 */

import { promises as dns } from 'node:dns';
import { MCP_ERRORS, MCPToolError } from './types.js';

/**
 * Parses a dotted IPv4 into its numeric octets. Returns null if not IPv4.
 */
function parseIPv4(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (part.length === 0 || part.length > 3) return null;
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    octets.push(n);
  }
  return [octets[0], octets[1], octets[2], octets[3]];
}

/**
 * True when `ip` (IPv4 dotted) falls inside a reserved/private range.
 */
function isPrivateIPv4(ip: string): boolean {
  const octets = parseIPv4(ip);
  if (!octets) return false;
  const [a, b] = octets;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 10.0.0.0/8 — private
  if (a === 10) return true;
  // 172.16.0.0/12 — private
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 — private
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 — link-local (includes cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8 — "this network" (unspecified)
  if (a === 0) return true;
  return false;
}

/**
 * True when `ip` is an IPv6 literal that belongs to a reserved/private range.
 * Handles ::1 (loopback), fc00::/7 (unique local), fe80::/10 (link-local).
 */
function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // Loopback
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
  // Unspecified
  if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return true;
  // Strip zone id (e.g. "fe80::1%eth0")
  const bare = lower.split('%')[0];
  // fc00::/7 — first byte 0xFC or 0xFD (first hex pair "fc" or "fd")
  if (/^fc[0-9a-f]{2}:/.test(bare) || /^fd[0-9a-f]{2}:/.test(bare)) return true;
  // fe80::/10 — first 10 bits are 1111 1110 10 — first hex pair starts with
  // "fe8", "fe9", "fea" or "feb".
  if (/^fe[89ab][0-9a-f]:/.test(bare)) return true;
  return false;
}

/**
 * True for literal hostnames that MUST be rejected regardless of DNS.
 */
function isBlockedHostnameLiteral(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost') return true;
  if (h.endsWith('.local')) return true;
  if (h.endsWith('.localhost')) return true;
  return false;
}

/**
 * Reads MCP_GATEWAY_ALLOWLIST env (CSV of hostnames) and returns the parsed
 * set. Empty set means "no allowlist configured".
 */
function loadAllowlist(): Set<string> {
  const raw = process.env.MCP_GATEWAY_ALLOWLIST;
  if (!raw || raw.trim().length === 0) return new Set();
  const entries = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return new Set(entries);
}

/**
 * Validates that `rawUrl` is safe to fetch from this process. Throws
 * MCPToolError(-32602) whenever a rule is violated. Returns the parsed URL
 * on success.
 *
 * Performs DNS resolution for hostnames; callers must await.
 */
export async function validateGatewayUrl(rawUrl: string): Promise<URL> {
  // 1. Parse
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new MCPToolError(
      MCP_ERRORS.INVALID_PARAMS,
      'gatewayUrl is not a valid URL',
    );
  }

  // 2. Protocol
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new MCPToolError(
      MCP_ERRORS.INVALID_PARAMS,
      `gatewayUrl protocol not allowed: ${parsed.protocol}`,
    );
  }

  // 3. Literal hostname block (localhost / *.local)
  const hostname = parsed.hostname;
  if (isBlockedHostnameLiteral(hostname)) {
    throw new MCPToolError(
      MCP_ERRORS.INVALID_PARAMS,
      `gatewayUrl hostname not allowed: ${hostname}`,
    );
  }

  // 4. Allowlist enforcement (if configured) — uses the original hostname,
  //    not the resolved IP.
  const allowlist = loadAllowlist();
  if (allowlist.size > 0 && !allowlist.has(hostname.toLowerCase())) {
    throw new MCPToolError(
      MCP_ERRORS.INVALID_PARAMS,
      `gatewayUrl host not in MCP_GATEWAY_ALLOWLIST: ${hostname}`,
    );
  }

  // 5. Resolve and reject private/loopback/link-local ranges. If the
  //    hostname is already an IP literal, dns.lookup returns it as-is.
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'dns lookup failed';
    throw new MCPToolError(
      MCP_ERRORS.INVALID_PARAMS,
      `gatewayUrl DNS lookup failed: ${msg}`,
    );
  }

  for (const { address, family } of addresses) {
    if (family === 4 && isPrivateIPv4(address)) {
      throw new MCPToolError(
        MCP_ERRORS.INVALID_PARAMS,
        `gatewayUrl resolves to non-public IPv4: ${address}`,
      );
    }
    if (family === 6 && isPrivateIPv6(address)) {
      throw new MCPToolError(
        MCP_ERRORS.INVALID_PARAMS,
        `gatewayUrl resolves to non-public IPv6: ${address}`,
      );
    }
  }

  return parsed;
}
