// url-validator.mjs — SSRF guard standalone (V3 BLOQUEANTE).
//
// validateGatewayUrl(rawUrl, { allowDevPrivate?, allowlist?, dnsLookup? })
// → returns parsed URL on success, throws SSRFViolationError otherwise.
//
// dnsLookup is an optional injection point used by tests. In production it
// defaults to dns.lookup from node:dns/promises.

import dns from 'node:dns/promises';

export class SSRFViolationError extends Error {
  constructor(msg, category) {
    super(msg);
    this.name = 'SSRFViolationError';
    this.category = category;
  }
}

export function isPrivateIPv4(ip) {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some(x => Number.isNaN(x) || x < 0 || x > 255)) return false;
  if (o[0] === 10) return true;          // RFC 1918
  if (o[0] === 127) return true;         // loopback
  if (o[0] === 169 && o[1] === 254) return true; // link-local + AWS metadata
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // RFC 1918
  if (o[0] === 192 && o[1] === 168) return true; // RFC 1918
  if (o[0] === 0) return true;           // 0.0.0.0/8
  return false;
}

export function isPrivateIPv6(ip) {
  const lc = ip.toLowerCase();
  if (lc === '::1' || lc === '::') return true;
  // ULA fc00::/7 (fc.., fd..)
  if (/^fc[0-9a-f]{2}:/.test(lc) || /^fd[0-9a-f]{2}:/.test(lc)) return true;
  // link-local fe80::/10 → fe80..febf
  if (/^fe[89ab][0-9a-f]:/.test(lc)) return true;
  // IPv4-mapped (::ffff:x.x.x.x).
  const v4mapped = lc.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4mapped) return isPrivateIPv4(v4mapped[1]);
  return false;
}

export async function validateGatewayUrl(
  rawUrl,
  { allowDevPrivate = false, allowlist = [], dnsLookup = dns.lookup } = {},
) {
  // 1. Parse.
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SSRFViolationError('invalid url', 'parse');
  }

  // 2. Scheme.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SSRFViolationError(`disallowed scheme: ${url.protocol}`, 'scheme');
  }
  if (url.protocol === 'http:' && !allowDevPrivate) {
    throw new SSRFViolationError('http:// requires NODE_ENV=development', 'scheme');
  }

  // 3. Strip trailing dot (RFC 1035) before literal comparison.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');

  // 4. Literal block.
  if (host === 'localhost' || /\.local$/.test(host) || /\.localhost$/.test(host)) {
    if (!allowDevPrivate) {
      throw new SSRFViolationError(`literal-blocked host: ${host}`, 'literal');
    }
  }

  // 5. Allowlist bypass — early return.
  if (allowlist.includes(host)) return url;

  // 6. DNS resolve and reject any private IP.
  let resolved;
  try {
    resolved = await dnsLookup(host, { all: true });
  } catch (e) {
    throw new SSRFViolationError(`dns lookup failed: ${e.code ?? e.message}`, 'dns');
  }
  for (const r of resolved) {
    if (r.family === 4 && isPrivateIPv4(r.address) && !allowDevPrivate) {
      throw new SSRFViolationError(`private IPv4: ${r.address}`, 'private-ipv4');
    }
    if (r.family === 6 && isPrivateIPv6(r.address) && !allowDevPrivate) {
      throw new SSRFViolationError(`private IPv6: ${r.address}`, 'private-ipv6');
    }
  }
  return url;
}
