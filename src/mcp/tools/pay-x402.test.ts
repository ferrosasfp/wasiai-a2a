/**
 * pay_x402 Tests — AC-1, AC-2, AC-3, AC-4 + maxAmountWei guard.
 */

import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../types.js';

// ── Mocks (top-level per E12) ────────────────────────────────
const mockSign = vi.fn();
vi.mock('../../adapters/registry.js', () => ({
  getPaymentAdapter: () => ({
    sign: mockSign,
    settle: vi.fn(),
    verify: vi.fn(),
  }),
}));

// BLQ-1: validateGatewayUrl uses node:dns; keep it permissive in tests.
vi.mock('node:dns', () => ({
  promises: {
    lookup: vi.fn().mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ]),
  },
}));

import { MCPToolError } from '../types.js';
import { payX402 } from './pay-x402.js';

// ── Helpers ─────────────────────────────────────────────────

const silentLogger = pino({ level: 'silent' });

const ctx: ToolContext = {
  requestId: 'req-1',
  tokenPrefix: 'abcd1234',
  log: silentLogger,
};

function makeResponse(
  status: number,
  body: unknown,
  init?: { headers?: Record<string, string> },
): Response {
  const isJson = typeof body === 'object' && body !== null;
  const headers = new Headers({
    'content-type': isJson ? 'application/json' : 'text/plain',
    ...(init?.headers ?? {}),
  });
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers });
}

const baseInput = {
  gatewayUrl: 'https://gw.example',
  endpoint: '/thing',
  method: 'POST' as const,
  payload: { q: 1 },
};

const sample402Body = {
  error: 'payment required',
  x402Version: 2 as const,
  accepts: [
    {
      scheme: 'exact',
      network: 'kite-testnet',
      maxAmountRequired: '1000000000000000000',
      resource: '/thing',
      description: 'Test',
      mimeType: 'application/json',
      payTo: '0x0000000000000000000000000000000000000001',
      maxTimeoutSeconds: 300,
      asset: '0x0000000000000000000000000000000000000002',
      extra: null,
      merchantName: 'Test',
    },
  ],
};

beforeEach(() => {
  mockSign.mockReset();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('payX402', () => {
  it('AC-1: 402 -> sign -> retry 200 returns txHash + amountPaid', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(makeResponse(402, sample402Body));
    fetchMock.mockResolvedValueOnce(
      makeResponse(
        200,
        { done: true },
        { headers: { 'payment-response': '0xabc' } },
      ),
    );
    mockSign.mockResolvedValueOnce({
      xPaymentHeader: 'base64-payload',
      paymentRequest: {},
    });

    const out = await payX402(baseInput, ctx);

    expect(mockSign).toHaveBeenCalledWith({
      to: '0x0000000000000000000000000000000000000001',
      value: '1000000000000000000',
      timeoutSeconds: 300,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondCall = fetchMock.mock.calls[1];
    const secondInit = secondCall[1] as RequestInit;
    const secondHeaders = secondInit.headers as Record<string, string>;
    expect(secondHeaders['payment-signature']).toBe('base64-payload');
    expect(out).toEqual({
      status: 200,
      result: { done: true },
      txHash: '0xabc',
      amountPaid: '1000000000000000000',
    });
  });

  it('AC-2: non-402 response passes through without signing', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(makeResponse(200, { immediate: true }));

    const out = await payX402(baseInput, ctx);

    expect(mockSign).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.status).toBe(200);
    expect(out.result).toEqual({ immediate: true });
    expect(out.txHash).toBeUndefined();
  });

  it('AC-3: sign() throws -> MCPToolError(-32001) with message, no stack', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(makeResponse(402, sample402Body));
    mockSign.mockRejectedValueOnce(new Error('OPERATOR_PRIVATE_KEY not set'));

    let caught: unknown;
    try {
      await payX402(baseInput, ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPToolError);
    const err = caught as MCPToolError;
    expect(err.code).toBe(-32001);
    expect(err.message).toContain('Signing failed');
    expect(err.message).toContain('OPERATOR_PRIVATE_KEY');
    // Response payload shape (router-serialized) must not include stack — our
    // MCPToolError never carries a stack in its `.data`.
    expect(err.data).toBeUndefined();
  });

  it('AC-4: retry returns 500 -> MCPToolError(-32002) with status + body', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(makeResponse(402, sample402Body));
    fetchMock.mockResolvedValueOnce(makeResponse(500, 'upstream boom'));
    mockSign.mockResolvedValueOnce({
      xPaymentHeader: 'sig',
      paymentRequest: {},
    });

    let caught: unknown;
    try {
      await payX402(baseInput, ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPToolError);
    const err = caught as MCPToolError;
    expect(err.code).toBe(-32002);
    expect(err.message).toMatch(/Upstream gateway error/);
    expect(err.data).toMatchObject({ status: 500 });
    const data = err.data as { body: string };
    expect(data.body).toContain('upstream boom');
  });

  it('maxAmountWei guard: gateway requests more than allowed -> -32002 without signing', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(makeResponse(402, sample402Body));

    const input = { ...baseInput, maxAmountWei: '500' };

    let caught: unknown;
    try {
      await payX402(input, ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MCPToolError);
    const err = caught as MCPToolError;
    expect(err.code).toBe(-32002);
    expect(err.message).toMatch(/exceeds maxAmountWei/);
    expect(mockSign).not.toHaveBeenCalled();
  });
});
