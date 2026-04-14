/**
 * MCP URL Validator Tests — SSRF protection for pay_x402 /
 * get_payment_quote (BLQ-1).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPToolError } from './types.js';

// Mock dns BEFORE importing the module under test.
const mockLookup = vi.fn();
vi.mock('node:dns', () => ({
  promises: {
    lookup: (...args: unknown[]) => mockLookup(...args),
  },
}));

import { validateGatewayUrl } from './url-validator.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  mockLookup.mockReset();
  // Reset env to a clean slate for allowlist tests
  delete process.env.MCP_GATEWAY_ALLOWLIST;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('validateGatewayUrl', () => {
  it('accepts https URL resolving to public IPv4', async () => {
    mockLookup.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
    ]);
    const url = await validateGatewayUrl('https://example.com');
    expect(url).toBeInstanceOf(URL);
    expect(url.hostname).toBe('example.com');
  });

  it('accepts http URL resolving to public IPv4', async () => {
    mockLookup.mockResolvedValueOnce([
      { address: '8.8.8.8', family: 4 },
    ]);
    const url = await validateGatewayUrl('http://dns.google');
    expect(url.protocol).toBe('http:');
  });

  it('rejects invalid URL', async () => {
    let caught: unknown;
    try {
      await validateGatewayUrl('not a url');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPToolError);
    expect((caught as MCPToolError).code).toBe(-32602);
  });

  it('rejects file:// protocol', async () => {
    let caught: unknown;
    try {
      await validateGatewayUrl('file:///etc/passwd');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPToolError);
    expect((caught as MCPToolError).code).toBe(-32602);
    expect((caught as MCPToolError).message).toContain('file:');
  });

  it('rejects ftp:// protocol', async () => {
    let caught: unknown;
    try {
      await validateGatewayUrl('ftp://example.com/file');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPToolError);
    expect((caught as MCPToolError).code).toBe(-32602);
  });

  it('rejects literal hostname localhost', async () => {
    let caught: unknown;
    try {
      await validateGatewayUrl('http://localhost:8080/x');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPToolError);
    expect((caught as MCPToolError).message).toContain('localhost');
  });

  it('rejects *.local hostnames', async () => {
    let caught: unknown;
    try {
      await validateGatewayUrl('https://printer.local/x');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPToolError);
    expect((caught as MCPToolError).message).toContain('printer.local');
  });

  it('rejects host resolving to 127.0.0.1', async () => {
    mockLookup.mockResolvedValueOnce([
      { address: '127.0.0.1', family: 4 },
    ]);
    let caught: unknown;
    try {
      await validateGatewayUrl('https://evil.example.com');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPToolError);
    expect((caught as MCPToolError).message).toContain('127.0.0.1');
  });

  it('rejects AWS metadata IP 169.254.169.254', async () => {
    mockLookup.mockResolvedValueOnce([
      { address: '169.254.169.254', family: 4 },
    ]);
    let caught: unknown;
    try {
      await validateGatewayUrl('https://metadata.example');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPToolError);
    expect((caught as MCPToolError).message).toContain('169.254.169.254');
  });

  it('rejects 10.0.0.1 (RFC1918)', async () => {
    mockLookup.mockResolvedValueOnce([
      { address: '10.0.0.1', family: 4 },
    ]);
    let caught: unknown;
    try {
      await validateGatewayUrl('https://internal.example');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPToolError);
    expect((caught as MCPToolError).message).toContain('10.0.0.1');
  });

  it('rejects 192.168.1.1', async () => {
    mockLookup.mockResolvedValueOnce([
      { address: '192.168.1.1', family: 4 },
    ]);
    let caught: unknown;
    try {
      await validateGatewayUrl('https://router.example');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPToolError);
  });

  it('rejects 172.16.5.5 (RFC1918)', async () => {
    mockLookup.mockResolvedValueOnce([
      { address: '172.16.5.5', family: 4 },
    ]);
    let caught: unknown;
    try {
      await validateGatewayUrl('https://internal.example');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPToolError);
  });

  it('rejects IPv6 loopback ::1', async () => {
    mockLookup.mockResolvedValueOnce([
      { address: '::1', family: 6 },
    ]);
    let caught: unknown;
    try {
      await validateGatewayUrl('https://v6.example');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPToolError);
  });

  it('rejects IPv6 link-local fe80::', async () => {
    mockLookup.mockResolvedValueOnce([
      { address: 'fe80::1', family: 6 },
    ]);
    let caught: unknown;
    try {
      await validateGatewayUrl('https://v6ll.example');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPToolError);
  });

  it('rejects when ANY resolved address is private (dual-stack)', async () => {
    mockLookup.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
      { address: '::1', family: 6 },
    ]);
    let caught: unknown;
    try {
      await validateGatewayUrl('https://mixed.example');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPToolError);
  });

  it('enforces allowlist — host in list passes', async () => {
    process.env.MCP_GATEWAY_ALLOWLIST = 'gw.example.com,another.example';
    mockLookup.mockResolvedValueOnce([
      { address: '93.184.216.34', family: 4 },
    ]);
    const url = await validateGatewayUrl('https://gw.example.com/x');
    expect(url.hostname).toBe('gw.example.com');
  });

  it('enforces allowlist — host not in list rejected', async () => {
    process.env.MCP_GATEWAY_ALLOWLIST = 'gw.example.com';
    let caught: unknown;
    try {
      await validateGatewayUrl('https://other.example');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPToolError);
    expect((caught as MCPToolError).message).toContain('MCP_GATEWAY_ALLOWLIST');
    // dns must not be called if allowlist already rejects
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('rejects when dns lookup fails', async () => {
    mockLookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
    let caught: unknown;
    try {
      await validateGatewayUrl('https://does-not-resolve.invalid');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPToolError);
    expect((caught as MCPToolError).message).toContain('DNS lookup failed');
  });
});
