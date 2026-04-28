/**
 * Tests for `src/lib/url-validator.ts` — neutral SSRF protection core
 * (WKH-62).
 *
 * Mirrors the test pattern from `src/mcp/url-validator.test.ts`:
 *  - DNS is mocked at the `node:dns` module level BEFORE importing the
 *    module under test.
 *  - Each test that hits stage 5 (DNS lookup) sets a fresh
 *    `mockLookup.mockResolvedValueOnce(...)`.
 *
 * Coverage matrix (T-LIB-01..T-LIB-18):
 *   01  empty string                     → invalid-url
 *   02  whitespace string                → invalid-url
 *   03  malformed URL                    → invalid-url
 *   04  file:// protocol                 → invalid-protocol
 *   05  data: protocol                   → invalid-protocol
 *   06  javascript: protocol             → invalid-protocol
 *   07  ftp: protocol                    → invalid-protocol
 *   08  literal localhost                → blocked-literal
 *   09  literal *.local                  → blocked-literal
 *   10  literal *.localhost              → blocked-literal
 *   11  IPv4 0.0.0.0                     → private-ip
 *   12  IPv4 10.0.0.1                    → private-ip
 *   13  IPv4 169.254.169.254             → private-ip
 *   14  IPv6 ::1                         → private-ip
 *   15  allowlist bypass private-IP      → ok
 *   16  allowlist NOT bypass literal     → blocked-literal
 *   17  IPv6 ::ffff:169.254.169.254      → private-ip (DT-B dotted)
 *   18  IPv6 ::ffff:a9fe:a9fe            → private-ip (DT-B hex)
 *   + happy path: public IPv4
 *   + happy path: public IPv6
 *   + DNS lookup failure                 → dns-lookup-failed
 *   + validateRegistryUrl throws SSRFViolationError
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockLookup = vi.fn();
vi.mock('node:dns', () => ({
  promises: {
    lookup: (...args: unknown[]) => mockLookup(...args),
  },
}));

import {
  SSRFViolationError,
  validateOutboundUrl,
  validateRegistryUrl,
} from './url-validator.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  mockLookup.mockReset();
  delete process.env.DISCOVERY_SSRF_ALLOWLIST;
  delete process.env.MCP_GATEWAY_ALLOWLIST;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('validateOutboundUrl — core (Result-style, never throws)', () => {
  // ── Stage 1: invalid URL (CD-A4 edge cases) ───────────────────────

  it('T-LIB-01: empty string is invalid-url', async () => {
    const r = await validateOutboundUrl('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.category).toBe('invalid-url');
  });

  it('T-LIB-02: whitespace string is invalid-url', async () => {
    const r = await validateOutboundUrl('   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.category).toBe('invalid-url');
  });

  it('T-LIB-03: malformed URL is invalid-url', async () => {
    const r = await validateOutboundUrl('http://[invalid');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.category).toBe('invalid-url');
  });

  // ── Stage 2: protocol blocks ──────────────────────────────────────

  it('T-LIB-04: file:// protocol is invalid-protocol', async () => {
    const r = await validateOutboundUrl('file:///etc/passwd');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.category).toBe('invalid-protocol');
      expect(r.error.reason).toBe('file:');
    }
  });

  it('T-LIB-05: data: protocol is invalid-protocol', async () => {
    const r = await validateOutboundUrl('data:text/plain;base64,SGVsbG8=');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.category).toBe('invalid-protocol');
  });

  it('T-LIB-06: javascript: protocol is invalid-protocol', async () => {
    const r = await validateOutboundUrl('javascript:alert(1)');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.category).toBe('invalid-protocol');
  });

  it('T-LIB-07: ftp: protocol is invalid-protocol', async () => {
    const r = await validateOutboundUrl('ftp://example.com/file');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.category).toBe('invalid-protocol');
  });

  // ── Stage 3: literal hostname blocks ──────────────────────────────

  it('T-LIB-08: literal localhost is blocked-literal', async () => {
    const r = await validateOutboundUrl('http://localhost:8080/x');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.category).toBe('blocked-literal');
      expect(r.error.reason).toBe('localhost');
    }
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('T-LIB-09: *.local hostname is blocked-literal', async () => {
    const r = await validateOutboundUrl('https://printer.local/x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.category).toBe('blocked-literal');
  });

  it('T-LIB-10: *.localhost hostname is blocked-literal', async () => {
    const r = await validateOutboundUrl('https://api.localhost/x');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.category).toBe('blocked-literal');
  });

  // ── Stage 5: private IP rejection ─────────────────────────────────

  it('T-LIB-11: IPv4 0.0.0.0 is private-ip', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '0.0.0.0', family: 4 }]);
    const r = await validateOutboundUrl('https://anywhere.example');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.category).toBe('private-ip');
      expect(r.error.reason).toContain('0.0.0.0');
    }
  });

  it('T-LIB-12: IPv4 10.0.0.1 (RFC1918) is private-ip', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    const r = await validateOutboundUrl('https://internal.example');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.category).toBe('private-ip');
      expect(r.error.reason).toContain('10.0.0.1');
    }
  });

  it('T-LIB-13: IPv4 169.254.169.254 (cloud metadata) is private-ip', async () => {
    mockLookup.mockResolvedValueOnce([
      { address: '169.254.169.254', family: 4 },
    ]);
    const r = await validateOutboundUrl('https://metadata.example');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.category).toBe('private-ip');
      expect(r.error.reason).toContain('169.254.169.254');
    }
  });

  it('T-LIB-14: IPv6 ::1 is private-ip', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '::1', family: 6 }]);
    const r = await validateOutboundUrl('https://v6.example');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.category).toBe('private-ip');
  });

  // ── Stage 4: allowlist behaviour (AC-4) ───────────────────────────

  it('T-LIB-15: DISCOVERY_SSRF_ALLOWLIST host bypasses private-IP check', async () => {
    process.env.DISCOVERY_SSRF_ALLOWLIST = 'example.com';
    mockLookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    const r = await validateOutboundUrl('https://example.com/x', {
      allowlistEnvVar: 'DISCOVERY_SSRF_ALLOWLIST',
    });
    // AC-4: allowlist bypasses rule 5; OK even though DNS resolves to 127.
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.hostname).toBe('example.com');
  });

  it('T-LIB-16: allowlist does NOT bypass literal localhost block', async () => {
    process.env.DISCOVERY_SSRF_ALLOWLIST = 'localhost';
    const r = await validateOutboundUrl('http://localhost', {
      allowlistEnvVar: 'DISCOVERY_SSRF_ALLOWLIST',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.category).toBe('blocked-literal');
  });

  // ── DT-B: IPv6-mapped IPv4 detection (new vector) ────────────────

  it('T-LIB-17: IPv6 ::ffff:169.254.169.254 (dotted) is private-ip', async () => {
    mockLookup.mockResolvedValueOnce([
      { address: '::ffff:169.254.169.254', family: 6 },
    ]);
    const r = await validateOutboundUrl('https://bypass.example');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.category).toBe('private-ip');
  });

  it('T-LIB-18: IPv6 ::ffff:a9fe:a9fe (hex form of 169.254.169.254) is private-ip', async () => {
    mockLookup.mockResolvedValueOnce([
      { address: '::ffff:a9fe:a9fe', family: 6 },
    ]);
    const r = await validateOutboundUrl('https://hexbypass.example');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.category).toBe('private-ip');
  });

  // ── Happy paths + DNS failure ─────────────────────────────────────

  it('accepts public IPv4 address', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    const r = await validateOutboundUrl('https://example.com');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.hostname).toBe('example.com');
  });

  it('accepts public IPv6 address', async () => {
    mockLookup.mockResolvedValueOnce([
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
    const r = await validateOutboundUrl('https://v6public.example');
    expect(r.ok).toBe(true);
  });

  it('returns dns-lookup-failed when dns rejects', async () => {
    mockLookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
    const r = await validateOutboundUrl('https://does-not-resolve.invalid');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.category).toBe('dns-lookup-failed');
      expect(r.error.reason).toContain('ENOTFOUND');
    }
  });
});

describe('validateRegistryUrl — domain wrapper (throws SSRFViolationError)', () => {
  it('throws SSRFViolationError with category "private-ip" for 10.0.0.1', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    let caught: unknown;
    try {
      await validateRegistryUrl('http://internal.example');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SSRFViolationError);
    if (caught instanceof SSRFViolationError) {
      expect(caught.category).toBe('private-ip');
      expect(caught.reason).toContain('10.0.0.1');
    }
  });

  it('returns parsed URL for public host', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
    const url = await validateRegistryUrl('https://example.com/discover');
    expect(url).toBeInstanceOf(URL);
    expect(url.hostname).toBe('example.com');
  });

  it('uses DISCOVERY_SSRF_ALLOWLIST (not MCP_GATEWAY_ALLOWLIST)', async () => {
    // DISCOVERY_SSRF_ALLOWLIST grants bypass; MCP_GATEWAY_ALLOWLIST should
    // be irrelevant on the registry path.
    process.env.DISCOVERY_SSRF_ALLOWLIST = 'internal.test';
    process.env.MCP_GATEWAY_ALLOWLIST = ''; // explicitly empty
    mockLookup.mockResolvedValueOnce([{ address: '192.168.1.1', family: 4 }]);
    const url = await validateRegistryUrl('https://internal.test/x');
    expect(url.hostname).toBe('internal.test');
  });
});
