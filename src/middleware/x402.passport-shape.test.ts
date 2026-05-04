/**
 * x402 Middleware — Passport-shape signature acceptance tests (WKH-69)
 *
 * Tests cover:
 *   - T-AC1-1: Passport-shape header → decodeXPayment parses without throw
 *   - T-AC1-2: adapter mock accepts → request.paymentOrigin === 'passport', 200
 *   - T-AC6-1: round-trip buildPassportPaymentHeader → handler consumes shape OK
 *   - T-AC8-1: no x-passport-session header → request.paymentOrigin === 'eoa'
 *
 * Strategy: Fastify in-memory + vi.mock the payment adapter registry to
 * skip real Pieverse + viem calls (we are testing middleware glue, not
 * the adapter itself — that's covered by payment.contract.test.ts).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the adapter registry BEFORE importing the middleware.
const mockVerify = vi.fn().mockResolvedValue({ valid: true });
const mockSettle = vi
  .fn()
  .mockResolvedValue({ txHash: '0xdeadbeef', success: true });
const mockAdapter = {
  verify: (...args: unknown[]) => mockVerify(...args),
  settle: (...args: unknown[]) => mockSettle(...args),
  getToken: vi.fn().mockReturnValue('0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e'),
  getNetwork: vi.fn().mockReturnValue('kite-mainnet'),
  getScheme: vi.fn().mockReturnValue('exact'),
  getMerchantName: vi.fn().mockReturnValue('wasiai-a2a-test'),
  getMaxTimeoutSeconds: vi.fn().mockReturnValue(30),
};

vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: () => mockAdapter,
}));

import { decodeXPayment, requirePayment } from './x402.js';
import { buildPassportPaymentHeader, buildEoaPaymentHeader } from '../../test/fixtures/passport-shape.js';

describe('x402 middleware — Passport-shape acceptance (WKH-69)', () => {
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

  // ── T-AC1-1: decodeXPayment parses Passport-shape header ──

  it('T-AC1-1: decodeXPayment parses Passport-shape header without throw', () => {
    const { headers } = buildPassportPaymentHeader();
    const decoded = decodeXPayment(headers['payment-signature']);
    expect(decoded.authorization).toBeDefined();
    expect(decoded.authorization.from).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(typeof decoded.signature).toBe('string');
    expect(decoded.signature).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  // ── T-AC1-2: handler sets paymentOrigin='passport' on success ──

  it('T-AC1-2: x-passport-session=true → handler sets paymentOrigin=passport, 200', async () => {
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
    await app.ready();

    try {
      const { headers } = buildPassportPaymentHeader();
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers,
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(capturedOrigin).toBe('passport');
      expect(mockVerify).toHaveBeenCalledTimes(1);
      expect(mockSettle).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  // ── T-AC6-1: round-trip fixture → middleware happy path ──

  it('T-AC6-1: round-trip Passport fixture → middleware accepts shape end-to-end', async () => {
    const app = Fastify();
    app.post(
      '/test',
      { preHandler: requirePayment({ description: 'test' }) },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await app.ready();

    try {
      const { headers, paymentRequest } = buildPassportPaymentHeader({
        value: '5000000', // 5 USDC
      });
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers,
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      // adapter.verify received the same authorization shape
      expect(mockVerify).toHaveBeenCalledTimes(1);
      const verifyArg = mockVerify.mock.calls[0][0] as {
        authorization: { from: string; value: string };
      };
      expect(verifyArg.authorization.from).toBe(paymentRequest.authorization.from);
      expect(verifyArg.authorization.value).toBe('5000000');
    } finally {
      await app.close();
    }
  });

  // ── T-AC8-1: no Passport header → paymentOrigin='eoa', backward compat ──

  it('T-AC8-1: no x-passport-session → handler sets paymentOrigin=eoa (backward compat)', async () => {
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
    await app.ready();

    try {
      const { headers } = buildEoaPaymentHeader();
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers,
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(capturedOrigin).toBe('eoa');
    } finally {
      await app.close();
    }
  });

  // ── Edge: x-passport-session value 'false' → eoa (not truthy) ──

  it('T-AC8-2: x-passport-session=false → paymentOrigin=eoa (strict truthy parse)', async () => {
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
    await app.ready();

    try {
      const { headers } = buildEoaPaymentHeader();
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { ...headers, 'x-passport-session': 'false' },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(capturedOrigin).toBe('eoa');
    } finally {
      await app.close();
    }
  });
});
