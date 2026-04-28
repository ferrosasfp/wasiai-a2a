/**
 * Outbound URL Validator — neutral SSRF protection core (WKH-62).
 *
 * Generalized from `src/mcp/url-validator.ts` (MCP-coupled). This module is
 * domain-neutral: returns a `Result<URL, ValidationFailure>` instead of
 * throwing. Domain-specific wrappers (`validateGatewayUrl` in MCP,
 * `validateRegistryUrl` here) translate failures into their respective
 * exception types.
 *
 * Rules (5 stages):
 *  1. Must parse as a URL.
 *  2. Protocol must be http: or https:.
 *  3. Hostname must NOT be a blocked literal (`localhost`, `*.local`,
 *     `*.localhost`).
 *  4. If the env-configured allowlist is set (CSV of hostnames), only hosts
 *     in the list bypass the private-IP check (literal block stays in
 *     effect).
 *  5. DNS-resolved addresses must NOT fall in private/loopback/link-local
 *     ranges (IPv4 + IPv6, including `::ffff:` IPv4-mapped forms).
 *
 * CD-A1: this function NEVER throws — every error path returns a
 * `Result.Err`. Domain wrappers do the throwing.
 * CD-A7: uses `dns.lookup` (not `resolve`/`resolve4`) so that `/etc/hosts`
 * and NSS apply, matching the real `fetch` behaviour.
 * CD-6: NO imports from `../mcp/`.
 */

import { promises as dns } from 'node:dns';

// ─── Types ──────────────────────────────────────────────────────────────

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type SSRFCategory =
  | 'invalid-url'
  | 'invalid-protocol'
  | 'blocked-literal'
  | 'allowlist'
  | 'private-ip'
  | 'dns-lookup-failed';

export interface ValidationFailure {
  category: SSRFCategory;
  reason: string;
}

export interface ValidateOutboundOpts {
  /**
   * Name of the env var holding a CSV of hostnames allowed to bypass the
   * private-IP check (literal block still applies). When unset, no
   * allowlist is enforced (rule 4 noop).
   */
  allowlistEnvVar?: string;
}

// ─── Error class (domain wrapper for registry-side callers) ────────────

export class SSRFViolationError extends Error {
  public field?: string;
  public readonly reason: string;
  public readonly category: SSRFCategory;

  constructor(reason: string, category: SSRFCategory, field?: string) {
    super(reason);
    this.name = 'SSRFViolationError';
    this.reason = reason;
    this.category = category;
    this.field = field;
  }
}

// ─── IPv4 helpers ──────────────────────────────────────────────────────

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

// ─── IPv6 helpers ──────────────────────────────────────────────────────

/**
 * True when `ip` is an IPv6 literal that belongs to a reserved/private
 * range.
 *
 * Handles:
 *  - `::1`, `0:0:0:0:0:0:0:1`                 — loopback
 *  - `::`, `0:0:0:0:0:0:0:0`                  — unspecified
 *  - `fc00::/7` (`fc..`/`fd..`)               — unique local
 *  - `fe80::/10` (`fe8`/`fe9`/`fea`/`feb`)    — link-local
 *  - `::ffff:a.b.c.d` (dotted IPv4-mapped)    — DT-B (WKH-62)
 *  - `::ffff:abcd:efgh` (hex IPv4-mapped)     — DT-B (WKH-62)
 */
function isPrivateIPv6(ip: string): boolean {
  // TD-sprint-security MNR-2: defensive normalization — strip optional
  // bracket form (e.g. "[::1]") before classification. Node's URL.hostname
  // strips brackets for us, but callers passing raw addresses (tests,
  // future code paths) shouldn't slip past private-range checks.
  const lower = ip.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
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

  // DT-B: IPv4-mapped IPv6 — bypass that the legacy MCP validator missed.
  // Case A: ::ffff:a.b.c.d (dotted form)
  const dotted = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted && isPrivateIPv4(dotted[1])) return true;
  // Case B: ::ffff:abcd:efgh (hex compressed form)
  const hex = bare.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${
      lo & 0xff
    }`;
    if (isPrivateIPv4(ipv4)) return true;
  }
  return false;
}

// ─── Hostname literal blocks ───────────────────────────────────────────

/**
 * True for literal hostnames that MUST be rejected regardless of DNS.
 * Literal block is NOT bypassable via allowlist (CD-AC-4).
 */
function isBlockedHostnameLiteral(hostname: string): boolean {
  // TD-sprint-security MNR-3: RFC 1035 § 3.1 allows trailing dot
  // ("localhost." == FQDN localhost). Strip it before matching so the
  // literal block can't be bypassed via `http://localhost./...`.
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost') return true;
  if (h.endsWith('.local')) return true;
  if (h.endsWith('.localhost')) return true;
  return false;
}

// ─── Allowlist loader ──────────────────────────────────────────────────

/**
 * Reads the configured env var (CSV of hostnames) and returns the parsed
 * set. Empty set when env var name is not provided OR the var is unset/
 * empty.
 */
function loadAllowlist(envVarName: string | undefined): Set<string> {
  if (!envVarName) return new Set();
  const raw = process.env[envVarName];
  if (!raw || raw.trim().length === 0) return new Set();
  const entries = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return new Set(entries);
}

// ─── Core validator (Result-style — never throws) ─────────────────────

/**
 * Validates that `rawUrl` is safe to fetch from this process. NEVER throws
 * (CD-A1) — failures are encoded in the returned `Result`.
 *
 * Performs DNS resolution for hostnames; callers must await.
 *
 * `reason` carries the DATUM that triggered the failure (e.g. `'127.0.0.1'`
 * or `'file:'`) so domain wrappers can build their own error messages
 * without relying on string parsing.
 */
export async function validateOutboundUrl(
  rawUrl: string,
  opts?: ValidateOutboundOpts,
): Promise<Result<URL, ValidationFailure>> {
  // 1. Parse
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      error: { category: 'invalid-url', reason: 'invalid URL' },
    };
  }

  // 2. Protocol
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      error: {
        category: 'invalid-protocol',
        reason: parsed.protocol,
      },
    };
  }

  // 3. Literal hostname block (localhost / *.local / *.localhost)
  const hostname = parsed.hostname;
  if (isBlockedHostnameLiteral(hostname)) {
    return {
      ok: false,
      error: { category: 'blocked-literal', reason: hostname },
    };
  }

  // 4. Allowlist enforcement (when configured) — uses original hostname.
  //    AC-4: hosts in the list bypass the private-IP check (rule 5);
  //    literal block (rule 3) is NOT bypassable.
  const allowlist = loadAllowlist(opts?.allowlistEnvVar);
  const hostInAllowlist =
    allowlist.size > 0 && allowlist.has(hostname.toLowerCase());

  if (allowlist.size > 0 && !hostInAllowlist) {
    return {
      ok: false,
      error: { category: 'allowlist', reason: hostname },
    };
  }

  // If the host IS in the allowlist, skip rule 5 (private-IP check). This
  // is the only behaviour change vs the legacy MCP validator: there, the
  // allowlist gated the request but DNS check still ran. For SSRF-allowed
  // internal hosts (AC-4), bypass is the desired semantics.
  if (hostInAllowlist) {
    return { ok: true, value: parsed };
  }

  // 5. Resolve and reject private/loopback/link-local ranges. If the
  //    hostname is already an IP literal, dns.lookup returns it as-is.
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'dns lookup failed';
    return {
      ok: false,
      error: { category: 'dns-lookup-failed', reason: msg },
    };
  }

  for (const { address, family } of addresses) {
    if (family === 4 && isPrivateIPv4(address)) {
      return {
        ok: false,
        error: {
          category: 'private-ip',
          reason: `URL resolves to non-public IPv4: ${address}`,
        },
      };
    }
    if (family === 6 && isPrivateIPv6(address)) {
      return {
        ok: false,
        error: {
          category: 'private-ip',
          reason: `URL resolves to non-public IPv6: ${address}`,
        },
      };
    }
  }

  return { ok: true, value: parsed };
}

// ─── Domain wrapper for registry-side callers ─────────────────────────

/**
 * Registry-side wrapper. Validates `rawUrl` against the
 * `DISCOVERY_SSRF_ALLOWLIST` env var and throws `SSRFViolationError` on
 * failure.
 *
 * Used by:
 *  - `src/services/discovery.ts` (runtime fetches against registries)
 *  - `src/routes/registries.ts` (POST/PATCH write-time validation)
 *  - `src/services/registry.ts` (defense-in-depth in service layer)
 */
export async function validateRegistryUrl(rawUrl: string): Promise<URL> {
  const result = await validateOutboundUrl(rawUrl, {
    allowlistEnvVar: 'DISCOVERY_SSRF_ALLOWLIST',
  });
  if (!result.ok) {
    throw new SSRFViolationError(result.error.reason, result.error.category);
  }
  return result.value;
}
