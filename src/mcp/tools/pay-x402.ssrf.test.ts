/**
 * pay_x402 — SSRF Hardening Tests (WKH-SEC-04).
 *
 * Verifies the final-URL SSRF defense (CD-1 / DT-1): pay_x402 builds the
 * fetch target as `new URL(endpoint, gatewayUrl)` and validates THAT URL
 * before any fetch, closing the userinfo bypass (`@169.254.169.254`) that
 * previously routed to link-local metadata hosts even though `gatewayUrl`
 * itself was a benign public host.
 *
 * Follows the scaffold of `src/services/discovery.ssrf.test.ts` (CD-3):
 *   mock node:dns + vi.stubGlobal('fetch') + assert fetch NOT called when the
 *   final URL resolves to a private/link-local IP.
 *
 * Also covers the schema-layer first defense (AC-2 / DT-3): endpoint must
 * start with `/`.
 */

import { Ajv } from 'ajv';
import addFormatsRaw from 'ajv-formats';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INPUT_SCHEMAS } from '../schemas.js';
import { MCPToolError, type ToolContext } from '../types.js';

// Mock dns BEFORE importing the module under test (CD-3).
const mockLookup = vi.fn();
vi.mock('node:dns', () => ({
  promises: {
    lookup: (...args: unknown[]) => mockLookup(...args),
  },
}));

// Adapter must not be exercised — these tests reject before signing.
vi.mock('../../adapters/registry.js', () => ({
  getPaymentAdapter: () => ({
    sign: vi.fn(),
  }),
}));

import { payX402 } from './pay-x402.js';

const ctx: ToolContext = {
  requestId: 'req-1',
  tokenPrefix: 'abcd1234',
  log: pino({ level: 'silent' }),
};

const mockFetch = vi.fn();

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  mockLookup.mockReset();
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
  delete process.env.MCP_GATEWAY_ALLOWLIST;
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

describe('payX402 — SSRF hardening (WKH-SEC-04)', () => {
  it('AC-5: userinfo bypass (@169.254.169.254) is NEUTRALIZED by new URL — host stays gw.example, never targets metadata', async () => {
    // The dangerous legacy path was raw concat:
    //   `https://gw.example` + `@169.254.169.254/foo`
    //     = `https://gw.example@169.254.169.254/foo`  → host = 169.254.169.254
    // With `new URL(endpoint, gatewayUrl)` the `@…` is normalized into a PATH
    // on gw.example, so the final URL is `https://gw.example/@169.254.169.254/foo`
    // (host = gw.example). The fetch, if any, targets the safe gateway host —
    // it can NEVER reach 169.254.169.254.
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await payX402(
      { gatewayUrl: 'https://gw.example', endpoint: '@169.254.169.254/foo' },
      ctx,
    );

    // Whatever happens, the only host ever fetched is the safe gateway.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchedUrl = mockFetch.mock.calls[0]?.[0] as string;
    // The authority/host is the safe gateway, NOT the link-local literal.
    expect(new URL(fetchedUrl).hostname).toBe('gw.example');
  });

  it('AC-1/AC-5: final URL resolving to a private IP (10.0.0.1) → rejected, no fetch', async () => {
    // gatewayUrl public (first defense), but the final host resolves private.
    mockLookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]) // gatewayUrl
      .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]); // final URL

    let caught: unknown;
    try {
      await payX402(
        {
          gatewayUrl: 'https://gw.example',
          endpoint: '//internal.attacker.example/foo',
        },
        ctx,
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MCPToolError);
    expect((caught as MCPToolError).code).toBe(-32602);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('AC-4: legitimate endpoint (/x402/pay) on a public gateway is not broken — fetch IS called', async () => {
    // Both gatewayUrl and final URL resolve to the same public host.
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const out = await payX402(
      { gatewayUrl: 'https://gw.example', endpoint: '/x402/pay' },
      ctx,
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://gw.example/x402/pay',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(out.status).toBe(200);
  });
});

describe('pay_x402 schema — endpoint path restriction (AC-2 / DT-3)', () => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  // ajv-formats default-export interop (mirrors router.ts).
  const addFormats =
    (addFormatsRaw as unknown as { default?: (a: Ajv) => void }).default ??
    (addFormatsRaw as unknown as (a: Ajv) => void);
  addFormats(ajv);
  const validate = ajv.compile(INPUT_SCHEMAS.pay_x402);

  it('rejects an endpoint that does not start with "/"', () => {
    const ok = validate({
      gatewayUrl: 'https://gw.example',
      endpoint: '@169.254.169.254/foo',
    });
    expect(ok).toBe(false);
  });

  it('accepts a path endpoint starting with "/"', () => {
    const ok = validate({
      gatewayUrl: 'https://gw.example',
      endpoint: '/x402/pay',
    });
    expect(ok).toBe(true);
  });
});
