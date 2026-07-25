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

import { buildEoaPaymentHeader } from '../__tests__/fixtures/passport-shape.js';
import {
  _resetDefaultChainWarnDedup,
  DEFAULT_CHAIN_WARN_NO_KEY,
  DEFAULT_CHAIN_WARN_WINDOW_MS,
  requirePayment,
} from './x402.js';

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
    // vi.clearAllMocks() resets call history but NOT mockImplementation, so the
    // per-test quote overrides (WKH money-path tests) would leak; restore the
    // default flat-1-token quote here.
    baseAdapter.quote.mockResolvedValue({
      amountWei: '1000000',
      token: {
        symbol: 'USDC',
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        decimals: 6,
      },
      facilitatorUrl: 'http://mock',
    });
    kiteAdapter.quote.mockResolvedValue({
      amountWei: '1000000000000000000',
      token: {
        symbol: 'KITE',
        address: '0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e',
        decimals: 18,
      },
      facilitatorUrl: 'http://mock',
    });
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
      expect(body.accepts[0]!.network).toBe('eip155:84532');
      expect(body.accepts[0]!.asset).toBe(
        '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      );
      expect(body.accepts[0]!.maxAmountRequired).toBe('1000000');
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
      expect(body.accepts[0]!.network).toBe('eip155:2368');
      expect(body.accepts[0]!.maxAmountRequired).toBe('1000000000000000000');
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
      // WKH-SEC-03: align value with the kite default quote (18-dec). The
      // fixture default ('1000000', 6-dec) would now reject as underpay vs the
      // kite 10^18 requirement — that is the CD-7 dimensional separation, not a
      // regression. Routing here is the kite default, so use the 18-dec value.
      const { headers } = buildEoaPaymentHeader({
        value: '1000000000000000000',
      });
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

  // WKH-234: `solana` is now a recognized slug (→ solana-devnet), so the
  // "unrecognised" branch uses `solana-mainnet` — which is NOT recognized
  // (devnet-only, CD-4). Same assertion, same branch.
  it('T-AC4a: x-payment-chain=solana-mainnet → 400 CHAIN_NOT_SUPPORTED (not recognised)', async () => {
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
        headers: { 'x-payment-chain': 'solana-mainnet' },
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
      expect(body.accepts[0]!.maxAmountRequired).toBe('1000000');
      expect(body.accepts[0]!.maxAmountRequired).not.toBe(
        '1000000000000000000',
      );
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
      expect(bodyBase.accepts[0]!.maxAmountRequired).toBe('7777777');
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
      expect(bodyDefault.accepts[0]!.maxAmountRequired).toBe('7777777');
    } finally {
      await appDefault.close();
    }
  });

  // ── WKH money-path fix: per-request x402ChallengeAmountUsd injection ──
  // A route preHandler (e.g. /compose) injects `request.x402ChallengeAmountUsd`
  // so the 402 challenge advertises the REAL pipeline cost, converted to atomic
  // units by the resolved chain's adapter (honoring per-chain decimals). The
  // flat 1 USD default applies only when nothing is injected.

  it('T-CHALLENGE-USD: injected x402ChallengeAmountUsd → adapter.quote called with it, challenge reflects it (Base 6-dec)', async () => {
    // Base mock quote echoes the requested USD amount at 6 decimals so we can
    // assert the real per-request figure flows end-to-end.
    baseAdapter.quote.mockImplementation(async (usd: number) => ({
      amountWei: String(Math.round(usd * 1e6)),
      token: {
        symbol: 'USDC',
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        decimals: 6,
      },
      facilitatorUrl: 'http://mock',
    }));

    const app = Fastify();
    // preHandler injects the per-request amount BEFORE the x402 challenge runs,
    // mirroring routes/compose.ts:resolveComposePriceHandler.
    app.post(
      '/test',
      {
        preHandler: [
          async (req: FastifyRequest) => {
            (
              req as unknown as { x402ChallengeAmountUsd?: number }
            ).x402ChallengeAmountUsd = 0.00101; // cheap agent + 1% fee
          },
          ...requirePayment({ description: 'test' }),
        ],
      },
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
      // adapter.quote received the injected per-request USD figure, NOT the 1 USD default.
      expect(baseAdapter.quote).toHaveBeenCalledWith(0.00101);
      const body = res.json() as ChallengeBody;
      // 0.00101 USDC at 6 decimals = 1010 atomic — the REAL cost, not 1000000.
      expect(body.accepts[0]!.maxAmountRequired).toBe('1010');
      expect(body.accepts[0]!.maxAmountRequired).not.toBe('1000000');
    } finally {
      await app.close();
    }
  });

  it('T-CHALLENGE-USD-DEFAULT: NO injection → adapter.quote called with 1 (back-compat default)', async () => {
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
      expect(baseAdapter.quote).toHaveBeenCalledWith(1);
    } finally {
      await app.close();
    }
  });

  it('T-CHALLENGE-USD-ATOMIC-WINS: opts.amount (atomic) beats injected amountUsd (quote not consulted)', async () => {
    const app = Fastify();
    app.post(
      '/test',
      {
        preHandler: [
          async (req: FastifyRequest) => {
            (
              req as unknown as { x402ChallengeAmountUsd?: number }
            ).x402ChallengeAmountUsd = 0.5;
          },
          ...requirePayment({ description: 'test', amount: '7777777' }),
        ],
      },
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
      expect(body.accepts[0]!.maxAmountRequired).toBe('7777777');
      // atomic override short-circuits quote() entirely.
      expect(baseAdapter.quote).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  // ── WKH-175: el default deja de ser silencioso + eco de la chain ──
  // Aditivo: NO cambia el default ni lo hace obligatorio (el request sin header
  // sigue resolviendo a kite y devolviendo el mismo 402).

  const DEFAULT_WARN_MSG =
    'payment chain resolved by default (x-payment-chain absent)';

  /**
   * App con `req.log.warn` y `req.log.debug` espiados (el hook global corre
   * antes del preHandler).
   */
  async function makeAppWithWarnSpy(): Promise<{
    app: ReturnType<typeof Fastify>;
    warnSpy: ReturnType<typeof vi.fn>;
    debugSpy: ReturnType<typeof vi.fn>;
  }> {
    const warnSpy = vi.fn();
    const debugSpy = vi.fn();
    const app = Fastify();
    app.addHook('preHandler', async (req: FastifyRequest) => {
      req.log.warn = warnSpy as unknown as FastifyRequest['log']['warn'];
      req.log.debug = debugSpy as unknown as FastifyRequest['log']['debug'];
    });
    app.post(
      '/test',
      { preHandler: requirePayment({ description: 'test' }) },
      async (_req: FastifyRequest, reply: FastifyReply) =>
        reply.send({ ok: true }),
    );
    await app.ready();
    return { app, warnSpy, debugSpy };
  }

  it('T-175-X1: sin x-payment-chain → warn del default + header x-a2a-payment-chain en el 402', async () => {
    _resetDefaultChainWarnDedup();
    const { app, warnSpy } = await makeAppWithWarnSpy();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        payload: {},
      });

      // Back-compat: mismo 402 challenge en la chain default.
      expect(res.statusCode).toBe(402);
      const body = res.json() as ChallengeBody;
      expect(body.accepts[0]!.network).toBe('eip155:2368');

      const warnCall = warnSpy.mock.calls.find(
        (c) => c[1] === DEFAULT_WARN_MSG,
      );
      expect(warnCall).toBeDefined();
      // Fix-pack MNR-1: fields del warn = chain + header + identidad del caller
      // + ruta/método. En el path x402 puro NO hay agent-key → sentinel.
      expect(warnCall?.[0]).toMatchObject({
        chainKey: 'kite-ozone-testnet',
        header: 'x-payment-chain',
        keyId: DEFAULT_CHAIN_WARN_NO_KEY,
        method: 'POST',
        route: '/test',
      });
      expect(res.headers['x-a2a-payment-chain']).toBe('kite-ozone-testnet');
    } finally {
      await app.close();
    }
  });

  it('T-175-X2: con x-payment-chain=base-sepolia → sin warn de default + header con ese slug', async () => {
    _resetDefaultChainWarnDedup();
    const { app, warnSpy } = await makeAppWithWarnSpy();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { 'x-payment-chain': 'base-sepolia' },
        payload: {},
      });

      expect(res.statusCode).toBe(402);
      expect(warnSpy.mock.calls.some((c) => c[1] === DEFAULT_WARN_MSG)).toBe(
        false,
      );
      expect(res.headers['x-a2a-payment-chain']).toBe('base-sepolia');
    } finally {
      await app.close();
    }
  });

  // Fix-pack MNR-1 (semántica NUEVA): el dedup ya no es por slug de chain sino
  // por identidad del caller + ventana temporal. En el path x402 puro todos los
  // requests comparten el sentinel `no-agent-key` → el mismo caller dentro de la
  // ventana sigue dando 1 solo warn (este test conserva su expectativa, pero
  // ahora por "mismo caller", no por "mismo slug").
  it('T-175-X3: 2 requests del MISMO caller sin header → 1 solo warn (ventana), header en ambos', async () => {
    _resetDefaultChainWarnDedup();
    const { app, warnSpy } = await makeAppWithWarnSpy();
    try {
      for (let i = 0; i < 2; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/test',
          payload: {},
        });
        expect(res.headers['x-a2a-payment-chain']).toBe('kite-ozone-testnet');
      }
      expect(
        warnSpy.mock.calls.filter((c) => c[1] === DEFAULT_WARN_MSG),
      ).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('T-175-X4: slug desconocido → 400 intacto, sin eco ni warn de default', async () => {
    _resetDefaultChainWarnDedup();
    const { app, warnSpy } = await makeAppWithWarnSpy();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { 'x-payment-chain': 'solana-mainnet' },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      expect((res.json() as ErrorBody).error_code).toBe('CHAIN_NOT_SUPPORTED');
      expect(res.headers['x-a2a-payment-chain']).toBeUndefined();
      expect(warnSpy.mock.calls.some((c) => c[1] === DEFAULT_WARN_MSG)).toBe(
        false,
      );
    } finally {
      await app.close();
    }
  });

  // ── Fix-pack MNR-4: el `debug` per-request es el control compensatorio que
  // hace aceptable el dedup del warn. Sin este test se podía borrar esa línea
  // sin que nada falle.
  it('T-175-X5: 3 requests sin header → 3 debug (per-request) + 1 warn (ventana)', async () => {
    _resetDefaultChainWarnDedup();
    const { app, warnSpy, debugSpy } = await makeAppWithWarnSpy();
    try {
      for (let i = 0; i < 3; i++) {
        await app.inject({ method: 'POST', url: '/test', payload: {} });
      }
      const debugCalls = debugSpy.mock.calls.filter(
        (c) => c[1] === DEFAULT_WARN_MSG,
      );
      expect(debugCalls).toHaveLength(3);
      expect(debugCalls[0]?.[0]).toMatchObject({
        chainKey: 'kite-ozone-testnet',
        keyId: DEFAULT_CHAIN_WARN_NO_KEY,
        route: '/test',
      });
      expect(
        warnSpy.mock.calls.filter((c) => c[1] === DEFAULT_WARN_MSG),
      ).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  // ── Fix-pack MNR-1: la ventana temporal hace que un problema PERSISTENTE
  // vuelva a avisar (el dedup viejo warneaba una vez por proceso y nunca más).
  it('T-175-X6: pasada la ventana, el mismo caller VUELVE a warnear', async () => {
    _resetDefaultChainWarnDedup();
    const t0 = 1_800_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);
    const { app, warnSpy } = await makeAppWithWarnSpy();
    try {
      await app.inject({ method: 'POST', url: '/test', payload: {} });
      // Dentro de la ventana → sigue deduplicado.
      nowSpy.mockReturnValue(t0 + DEFAULT_CHAIN_WARN_WINDOW_MS - 1);
      await app.inject({ method: 'POST', url: '/test', payload: {} });
      expect(
        warnSpy.mock.calls.filter((c) => c[1] === DEFAULT_WARN_MSG),
      ).toHaveLength(1);
      // Fuera de la ventana → re-avisa.
      nowSpy.mockReturnValue(t0 + DEFAULT_CHAIN_WARN_WINDOW_MS);
      await app.inject({ method: 'POST', url: '/test', payload: {} });
      expect(
        warnSpy.mock.calls.filter((c) => c[1] === DEFAULT_WARN_MSG),
      ).toHaveLength(2);
    } finally {
      nowSpy.mockRestore();
      await app.close();
    }
  });
});
