/**
 * get_payment_quote Tests — AC-5, AC-6.
 */

import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../types.js';

// BLQ-1: validateGatewayUrl uses node:dns; keep it permissive in tests.
vi.mock('node:dns', () => ({
  promises: {
    lookup: vi
      .fn()
      .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
  },
}));

// F-02 (audit 2026-06-29): the tool now fetches via `ssrfFetch` (undici + the
// SSRF dispatcher) instead of global fetch. Mock the dispatcher boundary to
// delegate to the stubbed global `fetch` so these tests keep asserting the
// tool's URL/GET/response behaviour without a real socket.
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

function makeResponse(status: number, body: unknown): Response {
  const isJson = typeof body === 'object' && body !== null;
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: {
      'content-type': isJson ? 'application/json' : 'text/plain',
    },
  });
}

const input = { gatewayUrl: 'https://gw.example', endpoint: '/price' };

const sample402Body = {
  error: 'payment required',
  x402Version: 2 as const,
  accepts: [
    {
      scheme: 'exact',
      network: 'kite-testnet',
      maxAmountRequired: '1000000000000000000',
      resource: '/price',
      description: 'Pay for price feed',
      mimeType: 'application/json',
      payTo: '0x0000000000000000000000000000000000000001',
      maxTimeoutSeconds: 300,
      asset: '0xusdt',
      extra: null,
      merchantName: 'Test',
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getPaymentQuote', () => {
  it('AC-5: non-402 endpoint returns { required: false }', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(makeResponse(200, { ok: true }));

    const out = await getPaymentQuote(input, ctx);
    expect(out).toEqual({ required: false });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gw.example/price',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('AC-6: 402 endpoint parses accepts[0] and returns amount/token/network/description', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(makeResponse(402, sample402Body));

    const out = await getPaymentQuote(input, ctx);
    expect(out).toEqual({
      required: true,
      amount: '1000000000000000000',
      token: '0xusdt',
      network: 'kite-testnet',
      description: 'Pay for price feed',
    });
  });
});
