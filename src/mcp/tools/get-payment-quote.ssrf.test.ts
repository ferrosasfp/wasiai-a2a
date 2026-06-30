/**
 * get_payment_quote — SSRF Hardening Tests (WKH-SEC-04).
 *
 * Same final-URL defense as pay_x402 (CD-1 / DT-1): the fetch target is built
 * via `new URL(endpoint, gatewayUrl)` and validated before the fetch, so the
 * userinfo bypass (`@169.254.169.254`) cannot re-target an internal host.
 *
 * Follows the scaffold of `src/services/discovery.ssrf.test.ts` (CD-3).
 */

import { Ajv } from 'ajv';
import addFormatsRaw from 'ajv-formats';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INPUT_SCHEMAS } from '../schemas.js';
import { MCPToolError, type ToolContext } from '../types.js';

const mockLookup = vi.fn();
vi.mock('node:dns', () => ({
  promises: {
    lookup: (...args: unknown[]) => mockLookup(...args),
  },
}));

// F-02 (audit 2026-06-29): the tool fetches via `ssrfFetch`; delegate to the
// stubbed global `fetch` so the "fetch NOT called on SSRF block" assertions
// keep observing the same mock.
vi.mock('../../lib/ssrf-dispatcher.js', () => ({
  ssrfFetch: (input: string | URL, init?: RequestInit) =>
    (globalThis.fetch as typeof fetch)(input, init),
}));

import { getPaymentQuote } from './get-payment-quote.js';

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

describe('getPaymentQuote — SSRF hardening (WKH-SEC-04)', () => {
  it('AC-5: userinfo bypass (@169.254.169.254) is NEUTRALIZED by new URL — host stays gw.example', async () => {
    // `new URL('@169.254.169.254/foo', 'https://gw.example')` normalizes the
    // `@…` into a PATH on gw.example (host = gw.example), so the fetch can
    // never target the link-local metadata host (vs. the legacy raw-concat
    // `https://gw.example@169.254.169.254/foo`).
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await getPaymentQuote(
      { gatewayUrl: 'https://gw.example', endpoint: '@169.254.169.254/foo' },
      ctx,
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const fetchedUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(new URL(fetchedUrl).hostname).toBe('gw.example');
  });

  it('AC-1/AC-5: final URL resolving to a private IP (10.0.0.1) → rejected, no fetch', async () => {
    mockLookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]) // gatewayUrl
      .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]); // final URL

    let caught: unknown;
    try {
      await getPaymentQuote(
        {
          gatewayUrl: 'https://gw.example',
          endpoint: '//internal.attacker.example/quote',
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

  it('AC-4: legitimate endpoint (/price) on a public gateway is not broken — fetch IS called', async () => {
    mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const out = await getPaymentQuote(
      { gatewayUrl: 'https://gw.example', endpoint: '/price' },
      ctx,
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://gw.example/price',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(out).toEqual({ required: false });
  });
});

describe('get_payment_quote schema — endpoint path restriction (AC-2 / DT-3)', () => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const addFormats =
    (addFormatsRaw as unknown as { default?: (a: Ajv) => void }).default ??
    (addFormatsRaw as unknown as (a: Ajv) => void);
  addFormats(ajv);
  const validate = ajv.compile(INPUT_SCHEMAS.get_payment_quote);

  it('rejects an endpoint that does not start with "/"', () => {
    const ok = validate({
      gatewayUrl: 'https://gw.example',
      endpoint: '@169.254.169.254/quote',
    });
    expect(ok).toBe(false);
  });

  it('accepts a path endpoint starting with "/"', () => {
    const ok = validate({
      gatewayUrl: 'https://gw.example',
      endpoint: '/price',
    });
    expect(ok).toBe(true);
  });
});
