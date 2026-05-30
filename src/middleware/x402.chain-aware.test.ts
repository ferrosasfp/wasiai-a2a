/**
 * x402 Middleware — chain-aware payment path tests (WKH-111 / BASE-06)
 *
 * Tests cover (EARS ACs from the SDD):
 *   - T-AC1 / T-CD9: challenge 402 routed to Base → 6-dec amount + Base network/asset
 *   - T-AC2:         verify+settle routed to Base adapter, 200 + payment-response hash
 *   - T-AC3a:        ZERO regression — challenge without header → Kite default (18-dec)
 *   - T-AC3b:        ZERO regression — verify+settle without header → default adapter
 *   - T-AC4a:        unrecognised slug → 400 CHAIN_NOT_SUPPORTED
 *   - T-AC4b:        recognised but not-initialized → 400 CHAIN_NOT_SUPPORTED + list
 *   - T-AC5:         coherence — same chainKey across challenge/verify/settle
 *   - T-OPTS-AMOUNT: opts.amount override wins over quote, with/without header
 *
 * Strategy: Fastify in-memory + vi.mock the adapter registry with a per-chainKey
 * dispatcher (Base mock 6-dec + Kite mock 18-dec). `resolveChainKey` is left REAL
 * (pure) so the alias mapping is exercised end-to-end. No viem/facilitator mocking.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock the adapter registry BEFORE importing the middleware ──

const mockBaseVerify = vi.fn().mockResolvedValue({ valid: true });
const mockBaseSettle = vi
  .fn()
  .mockResolvedValue({ txHash: '0xbeef', success: true });
const mockKiteVerify = vi.fn().mockResolvedValue({ valid: true });
const mockKiteSettle = vi
  .fn()
  .mockResolvedValue({ txHash: '0xdeadbeef', success: true });

const baseAdapter = {
  verify: (...a: unknown[]) => mockBaseVerify(...a),
  settle: (...a: unknown[]) => mockBaseSettle(...a),
  getToken: vi
    .fn()
    .mockReturnValue('0x036CbD53842c5426634e7929541eC2318f3dCF7e'),
  getNetwork: vi.fn().mockReturnValue('eip155:84532'),
  getScheme: vi.fn().mockReturnValue('exact'),
  getMerchantName: vi.fn().mockReturnValue('wasiai-a2a-test'),
  getMaxTimeoutSeconds: vi.fn().mockReturnValue(60),
  quote: vi.fn().mockResolvedValue({
    amountWei: '1000000',
    token: {
      symbol: 'USDC',
      address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      decimals: 6,
    },
    facilitatorUrl: 'http://mock',
  }),
};

const kiteAdapter = {
  verify: (...a: unknown[]) => mockKiteVerify(...a),
  settle: (...a: unknown[]) => mockKiteSettle(...a),
  getToken: vi
    .fn()
    .mockReturnValue('0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e'),
  getNetwork: vi.fn().mockReturnValue('eip155:2368'),
  getScheme: vi.fn().mockReturnValue('exact'),
  getMerchantName: vi.fn().mockReturnValue('wasiai-a2a-test'),
  getMaxTimeoutSeconds: vi.fn().mockReturnValue(300),
  quote: vi.fn().mockResolvedValue({
    amountWei: '1000000000000000000',
    token: {
      symbol: 'KITE',
      address: '0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e',
      decimals: 18,
    },
    facilitatorUrl: 'http://mock',
  }),
};

const mockGetPaymentAdapter = vi.fn((chainKey?: string) =>
  chainKey === 'base-sepolia' ? baseAdapter : kiteAdapter,
);

vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: (chainKey?: string) => mockGetPaymentAdapter(chainKey),
  // Simulate a registry with kite-ozone-testnet + base-sepolia initialized.
  getAdaptersBundle: (chainKey?: string) => {
    if (chainKey === undefined) return { chainConfig: { chainId: 2368 } };
    if (chainKey === 'base-sepolia') return { chainConfig: { chainId: 84532 } };
    if (chainKey === 'kite-ozone-testnet')
      return { chainConfig: { chainId: 2368 } };
    return undefined; // e.g. avalanche-fuji → recognised but not initialized
  },
  getInitializedChainKeys: () => ['kite-ozone-testnet', 'base-sepolia'],
  getDefaultChainKey: () => 'kite-ozone-testnet',
}));

import { buildEoaPaymentHeader } from '../../test/fixtures/passport-shape.js';
import { requirePayment } from './x402.js';

interface ChallengeBody {
  error: string;
  x402Version: number;
  accepts: Array<{
    network: string;
    asset: string;
    maxAmountRequired: string;
  }>;
}

interface ErrorBody {
  error_code: string;
  error: string;
}

describe('x402 middleware — chain-aware payment path (WKH-111 / BASE-06)', () => {
  const ORIGINAL_WALLET = process.env.KITE_WALLET_ADDRESS;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBaseVerify.mockResolvedValue({ valid: true });
    mockBaseSettle.mockResolvedValue({ txHash: '0xbeef', success: true });
    mockKiteVerify.mockResolvedValue({ valid: true });
    mockKiteSettle.mockResolvedValue({ txHash: '0xdeadbeef', success: true });
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

  // ── T-AC1: challenge routed to Base → 6-dec amount + Base network/asset ──

  it('T-AC1: challenge with x-payment-chain=base-sepolia → 402 Base 6-dec', async () => {
    const app = Fastify();
    app.post(
      '/test',
      { preHandler: requirePayment({ description: 'test' }) },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { 'x-payment-chain': 'base-sepolia' },
        payload: {},
      });

      expect(res.statusCode).toBe(402);
      const body = res.json() as ChallengeBody;
      expect(body.accepts[0].network).toBe('eip155:84532');
      expect(body.accepts[0].asset).toBe(
        '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      );
      expect(body.accepts[0].maxAmountRequired).toBe('1000000');
    } finally {
      await app.close();
    }
  });

  // ── T-AC2: verify+settle routed to Base adapter ──

  it('T-AC2: payment-signature + base-sepolia → verify/settle on Base, 200 + tx hash', async () => {
    const app = Fastify();
    app.post(
      '/test',
      { preHandler: requirePayment({ description: 'test' }) },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await app.ready();

    try {
      const { headers } = buildEoaPaymentHeader();
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { ...headers, 'x-payment-chain': 'base-sepolia' },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['payment-response']).toBe('0xbeef');
      expect(mockBaseVerify).toHaveBeenCalledTimes(1);
      expect(mockBaseSettle).toHaveBeenCalledTimes(1);
      // The adapter was resolved with the Base chainKey (never default/undefined).
      expect(
        mockGetPaymentAdapter.mock.calls.every((c) => c[0] === 'base-sepolia'),
      ).toBe(true);
      expect(mockGetPaymentAdapter).not.toHaveBeenCalledWith(undefined);
    } finally {
      await app.close();
    }
  });

  // ── T-AC3a: ZERO regression — challenge without header → Kite default ──

  it('T-AC3a: no x-payment-chain → 402 Kite default 18-dec (byte-identical)', async () => {
    const app = Fastify();
    app.post(
      '/test',
      { preHandler: requirePayment({ description: 'test' }) },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        payload: {},
      });

      expect(res.statusCode).toBe(402);
      const body = res.json() as ChallengeBody;
      expect(body.accepts[0].network).toBe('eip155:2368');
      expect(body.accepts[0].maxAmountRequired).toBe('1000000000000000000');
    } finally {
      await app.close();
    }
  });

  // ── T-AC3b: ZERO regression — verify+settle without header → default adapter ──

  it('T-AC3b: no header + valid signature → resolved adapter is NOT base-sepolia', async () => {
    const app = Fastify();
    app.post(
      '/test',
      { preHandler: requirePayment({ description: 'test' }) },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
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
      expect(mockKiteVerify).toHaveBeenCalledTimes(1);
      expect(mockKiteSettle).toHaveBeenCalledTimes(1);
      // No header → default chainKey resolved ('kite-ozone-testnet'); never Base.
      expect(
        mockGetPaymentAdapter.mock.calls.some((c) => c[0] === 'base-sepolia'),
      ).toBe(false);
    } finally {
      await app.close();
    }
  });

  // ── T-AC4a: unrecognised slug → 400 CHAIN_NOT_SUPPORTED ──

  it('T-AC4a: x-payment-chain=solana → 400 CHAIN_NOT_SUPPORTED (not recognised)', async () => {
    const app = Fastify();
    app.post(
      '/test',
      { preHandler: requirePayment({ description: 'test' }) },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { 'x-payment-chain': 'solana' },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body = res.json() as ErrorBody;
      expect(body.error_code).toBe('CHAIN_NOT_SUPPORTED');
      expect(body.error).toContain('not a recognized slug or chainId');
    } finally {
      await app.close();
    }
  });

  // ── T-AC4b: recognised but not-initialized → 400 + initialized list ──

  it('T-AC4b: x-payment-chain=avalanche-fuji (not initialized) → 400 + list', async () => {
    const app = Fastify();
    app.post(
      '/test',
      { preHandler: requirePayment({ description: 'test' }) },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { 'x-payment-chain': 'avalanche-fuji' },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body = res.json() as ErrorBody;
      expect(body.error_code).toBe('CHAIN_NOT_SUPPORTED');
      expect(body.error).toContain(
        'Initialized: kite-ozone-testnet, base-sepolia',
      );
    } finally {
      await app.close();
    }
  });

  // ── T-AC5: coherence — same chainKey across challenge/verify/settle ──

  it('T-AC5: base-sepolia + signature → every adapter resolution uses base-sepolia', async () => {
    const app = Fastify();
    app.post(
      '/test',
      { preHandler: requirePayment({ description: 'test' }) },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await app.ready();

    try {
      const { headers } = buildEoaPaymentHeader();
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { ...headers, 'x-payment-chain': 'base-sepolia' },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(mockGetPaymentAdapter.mock.calls.length).toBeGreaterThan(0);
      expect(
        mockGetPaymentAdapter.mock.calls.every((c) => c[0] === 'base-sepolia'),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  // ── T-CD9: default Base amount is 6-dec, NOT the 18-dec literal ──

  it('T-CD9: Base challenge amount is 6-dec, never the 18-dec literal', async () => {
    const app = Fastify();
    app.post(
      '/test',
      { preHandler: requirePayment({ description: 'test' }) },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { 'x-payment-chain': 'base-sepolia' },
        payload: {},
      });

      expect(res.statusCode).toBe(402);
      const body = res.json() as ChallengeBody;
      expect(body.accepts[0].maxAmountRequired).toBe('1000000');
      expect(body.accepts[0].maxAmountRequired).not.toBe('1000000000000000000');
    } finally {
      await app.close();
    }
  });

  // ── T-OPTS-AMOUNT: opts.amount override wins over quote ──

  it('T-OPTS-AMOUNT: opts.amount override is used over the quote (Base + no header)', async () => {
    const appBase = Fastify();
    appBase.post(
      '/test',
      {
        preHandler: requirePayment({ description: 'test', amount: '7777777' }),
      },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await appBase.ready();

    try {
      const resBase = await appBase.inject({
        method: 'POST',
        url: '/test',
        headers: { 'x-payment-chain': 'base-sepolia' },
        payload: {},
      });
      expect(resBase.statusCode).toBe(402);
      const bodyBase = resBase.json() as ChallengeBody;
      expect(bodyBase.accepts[0].maxAmountRequired).toBe('7777777');
    } finally {
      await appBase.close();
    }

    const appDefault = Fastify();
    appDefault.post(
      '/test',
      {
        preHandler: requirePayment({ description: 'test', amount: '7777777' }),
      },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await appDefault.ready();

    try {
      const resDefault = await appDefault.inject({
        method: 'POST',
        url: '/test',
        payload: {},
      });
      expect(resDefault.statusCode).toBe(402);
      const bodyDefault = resDefault.json() as ChallengeBody;
      expect(bodyDefault.accepts[0].maxAmountRequired).toBe('7777777');
    } finally {
      await appDefault.close();
    }
  });
});
