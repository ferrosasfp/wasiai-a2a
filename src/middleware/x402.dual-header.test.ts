/**
 * x402 Middleware — Dual payment-header acceptance tests (WKH-117, AC-10)
 *
 * Validates the `X-PAYMENT` alias of `payment-signature`:
 *   - T-DH-1 (AC-3): X-PAYMENT only → 200, verify/settle 1×.
 *   - T-DH-2 (AC-3/regresión): payment-signature only → 200 (unchanged).
 *   - T-DH-3 (AC-4): both present → X-PAYMENT wins (precedence).
 *   - T-DH-4 (AC-5): neither → 402 challenge.
 *   - T-DH-5 (AC-6): x-passport-session + X-PAYMENT → paymentOrigin='passport'.
 *   - T-DH-6 (edge/AC-4): X-PAYMENT='' + valid payment-signature → legacy wins.
 *   - T-DH-7 (edge/AC-3): X-PAYMENT invalid base64 → 402 legacy error string.
 *
 * Strategy: Fastify in-memory + vi.mock the payment adapter registry to
 * skip real Pieverse + viem calls (we test middleware glue only).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the adapter registry BEFORE importing the middleware (CD-7: COMPLETE mock).
const mockVerify = vi.fn().mockResolvedValue({ valid: true });
const mockSettle = vi
  .fn()
  .mockResolvedValue({ txHash: '0xdeadbeef', success: true });
const mockAdapter = {
  verify: (...args: unknown[]) => mockVerify(...args),
  settle: (...args: unknown[]) => mockSettle(...args),
  getToken: vi
    .fn()
    .mockReturnValue('0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e'),
  getNetwork: vi.fn().mockReturnValue('kite-mainnet'),
  getScheme: vi.fn().mockReturnValue('exact'),
  getMerchantName: vi.fn().mockReturnValue('wasiai-a2a-test'),
  getMaxTimeoutSeconds: vi.fn().mockReturnValue(30),
  quote: vi.fn().mockResolvedValue({ amountWei: '1000000' }),
};

vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: () => mockAdapter,
  getDefaultChainKey: () => 'kite-ozone-testnet',
  getAdaptersBundle: () => ({ chainConfig: { chainId: 2368 } }),
  getInitializedChainKeys: () => ['kite-ozone-testnet'],
}));

import { buildPassportPaymentHeader } from '../__tests__/fixtures/passport-shape.js';
import { requirePayment } from './x402.js';

describe('x402 middleware — Dual payment-header (X-PAYMENT alias, WKH-117)', () => {
  const ORIGINAL_WALLET = process.env.KITE_WALLET_ADDRESS;

  beforeEach(() => {
    vi.clearAllMocks();
    mockVerify.mockResolvedValue({ valid: true });
    mockSettle.mockResolvedValue({ txHash: '0xdeadbeef', success: true });
    process.env.KITE_WALLET_ADDRESS =
      '0x000000000000000000000000000000000000dEaD';
  });

  afterEach(() => {
    if (ORIGINAL_WALLET === undefined) {
      delete process.env.KITE_WALLET_ADDRESS;
    } else {
      process.env.KITE_WALLET_ADDRESS = ORIGINAL_WALLET;
    }
  });

  // Helper: build a Fastify app that captures paymentOrigin and returns ok.
  function buildApp(): {
    app: ReturnType<typeof Fastify>;
    getOrigin: () => string | undefined;
  } {
    const app = Fastify();
    let capturedOrigin: string | undefined;
    app.post(
      '/test',
      { preHandler: requirePayment({ description: 'test' }) },
      async (req: FastifyRequest, reply: FastifyReply) => {
        capturedOrigin = req.paymentOrigin;
        return reply.send({ ok: true });
      },
    );
    return { app, getOrigin: () => capturedOrigin };
  }

  // ── T-DH-1 (AC-3): X-PAYMENT only → 200, verify/settle 1× ──

  it('T-DH-1: X-PAYMENT only (no payment-signature) → 200, verify/settle 1×, payment-response header', async () => {
    const { app } = buildApp();
    await app.ready();
    try {
      const { headers } = buildPassportPaymentHeader();
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { 'x-payment': headers['payment-signature'] },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(mockVerify).toHaveBeenCalledTimes(1);
      expect(mockSettle).toHaveBeenCalledTimes(1);
      expect(res.headers['payment-response']).toBe('0xdeadbeef');
    } finally {
      await app.close();
    }
  });

  // ── T-DH-2 (AC-3/regresión): payment-signature only → 200 (unchanged) ──

  it('T-DH-2: payment-signature only → 200, verify/settle 1× (legacy unchanged)', async () => {
    const { app } = buildApp();
    await app.ready();
    try {
      const { headers } = buildPassportPaymentHeader();
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { 'payment-signature': headers['payment-signature'] },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(mockVerify).toHaveBeenCalledTimes(1);
      expect(mockSettle).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  // ── T-DH-3 (AC-4): both present, X-PAYMENT wins ──

  it('T-DH-3: both headers present → X-PAYMENT value wins (precedence)', async () => {
    const { app } = buildApp();
    await app.ready();
    try {
      const canonical = buildPassportPaymentHeader({
        from: '0x1111111111111111111111111111111111111111',
      });
      const legacy = buildPassportPaymentHeader({
        from: '0x2222222222222222222222222222222222222222',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: {
          'x-payment': canonical.headers['payment-signature'],
          'payment-signature': legacy.headers['payment-signature'],
        },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(mockVerify).toHaveBeenCalledTimes(1);
      const verifyArg = mockVerify.mock.calls[0][0] as {
        authorization: { from: string };
      };
      expect(verifyArg.authorization.from).toBe(
        '0x1111111111111111111111111111111111111111',
      );
    } finally {
      await app.close();
    }
  });

  // ── T-DH-4 (AC-5): neither → 402 challenge ──

  it('T-DH-4: no payment header → 402 with x402 challenge body', async () => {
    const { app } = buildApp();
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        payload: {},
      });

      expect(res.statusCode).toBe(402);
      const body = res.json() as {
        error: string;
        accepts: unknown[];
        x402Version: number;
      };
      expect(body.error).toBeDefined();
      expect(Array.isArray(body.accepts)).toBe(true);
      expect(body.x402Version).toBe(2);
      expect(mockVerify).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  // ── T-DH-5 (AC-6): x-passport-session + X-PAYMENT → paymentOrigin='passport' ──

  it('T-DH-5: x-passport-session=true + X-PAYMENT → paymentOrigin=passport, 200', async () => {
    const { app, getOrigin } = buildApp();
    await app.ready();
    try {
      const { headers } = buildPassportPaymentHeader();
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: {
          'x-payment': headers['payment-signature'],
          'x-passport-session': 'true',
        },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(getOrigin()).toBe('passport');
    } finally {
      await app.close();
    }
  });

  // ── T-DH-6 (edge/AC-4): X-PAYMENT='' + valid payment-signature → legacy wins ──

  it('T-DH-6: empty X-PAYMENT + valid payment-signature → legacy wins, 200', async () => {
    const { app } = buildApp();
    await app.ready();
    try {
      const { headers } = buildPassportPaymentHeader();
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: {
          'x-payment': '',
          'payment-signature': headers['payment-signature'],
        },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(mockVerify).toHaveBeenCalledTimes(1);
      expect(mockSettle).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  // ── T-DH-7 (edge/AC-3): X-PAYMENT invalid base64 → 402 legacy error string ──

  it('T-DH-7: X-PAYMENT with invalid base64 → 402 with legacy error string (CD-10)', async () => {
    const { app } = buildApp();
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { 'x-payment': 'not-valid-base64-$$$' },
        payload: {},
      });

      expect(res.statusCode).toBe(402);
      const body = res.json() as { error: string };
      expect(body.error).toMatch(/^Invalid payment-signature format: /);
    } finally {
      await app.close();
    }
  });
});
