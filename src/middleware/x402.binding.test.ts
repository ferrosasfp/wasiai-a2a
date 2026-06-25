/**
 * x402 Middleware — inbound binding tests (WKH-SEC-03 / CRIT-1)
 *
 * Cover the `to` + `value` binding check inserted BEFORE verify()/settle():
 *   - T-AC1:        to-mismatch → 402, verify/settle NOT called (CD-1)
 *   - T-AC2:        underpay → 402, verify/settle NOT called (CD-1)
 *   - T-AC3:        correct payment → verify+settle, paymentVerified=true
 *   - T-AC3-overpay: value > required → accepted (DT-3)
 *   - T-AC6:        structured log on reject, body does NOT leak the wallet (CD-2)
 *   - T-3CHAINS:    binding applies on kite/base/avalanche, dimension-aware (CD-7/CD-8)
 *   - T-NOREG:      challenge 402 without header → accepts[0] byte-identical
 *
 * Harness cloned from `x402.chain-aware.test.ts`: Fastify in-memory + mocked
 * adapter registry (Base 6-dec / Kite 18-dec / Avalanche 6-dec).
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
const mockAvaxVerify = vi.fn().mockResolvedValue({ valid: true });
const mockAvaxSettle = vi
  .fn()
  .mockResolvedValue({ txHash: '0xa00a', success: true });

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

const avaxAdapter = {
  verify: (...a: unknown[]) => mockAvaxVerify(...a),
  settle: (...a: unknown[]) => mockAvaxSettle(...a),
  getToken: vi
    .fn()
    .mockReturnValue('0x5425890298aed601595a70AB815c96711a31Bc65'),
  getNetwork: vi.fn().mockReturnValue('eip155:43113'),
  getScheme: vi.fn().mockReturnValue('exact'),
  getMerchantName: vi.fn().mockReturnValue('wasiai-a2a-test'),
  getMaxTimeoutSeconds: vi.fn().mockReturnValue(60),
  quote: vi.fn().mockResolvedValue({
    amountWei: '1000000',
    token: {
      symbol: 'USDC',
      address: '0x5425890298aed601595a70AB815c96711a31Bc65',
      decimals: 6,
    },
    facilitatorUrl: 'http://mock',
  }),
};

const mockGetPaymentAdapter = vi.fn((chainKey?: string) => {
  if (chainKey === 'base-sepolia') return baseAdapter;
  if (chainKey === 'avalanche-fuji') return avaxAdapter;
  return kiteAdapter;
});

// M1 (audit 2026-06-24): the middleware now records the inbound x402 nonce via
// supabase before settle(). Mock it so the anti-replay path is deterministic
// (no real localhost:54321 round-trip). `mockNonceInsert` drives fresh/replay.
const mockNonceInsert = vi.fn().mockResolvedValue({ data: null, error: null });
vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: vi.fn(() => ({ insert: (...a: unknown[]) => mockNonceInsert(...a) })),
    rpc: vi.fn(),
  },
}));

vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: (chainKey?: string) => mockGetPaymentAdapter(chainKey),
  getAdaptersBundle: (chainKey?: string) => {
    if (chainKey === undefined) return { chainConfig: { chainId: 2368 } };
    if (chainKey === 'base-sepolia') return { chainConfig: { chainId: 84532 } };
    if (chainKey === 'avalanche-fuji')
      return { chainConfig: { chainId: 43113 } };
    if (chainKey === 'kite-ozone-testnet')
      return { chainConfig: { chainId: 2368 } };
    return undefined;
  },
  getInitializedChainKeys: () => [
    'kite-ozone-testnet',
    'base-sepolia',
    'avalanche-fuji',
  ],
  getDefaultChainKey: () => 'kite-ozone-testnet',
}));

import { buildEoaPaymentHeader } from '../__tests__/fixtures/passport-shape.js';
import { requirePayment } from './x402.js';

const SERVER_WALLET = '0x000000000000000000000000000000000000dEaD';
const ATTACKER_WALLET = '0x000000000000000000000000000000000000beef';

interface ChallengeBody {
  error: string;
  accepts: Array<{ payTo: string; maxAmountRequired: string }>;
}

function buildApp() {
  const app = Fastify();
  app.post(
    '/test',
    { preHandler: requirePayment({ description: 'test' }) },
    async (request: FastifyRequest, reply: FastifyReply) =>
      reply.send({ paid: request.paymentVerified }),
  );
  return app;
}

describe('x402 middleware — inbound binding (WKH-SEC-03)', () => {
  const ORIGINAL_WALLET = process.env.KITE_WALLET_ADDRESS;

  beforeEach(() => {
    vi.clearAllMocks();
    mockBaseVerify.mockResolvedValue({ valid: true });
    mockBaseSettle.mockResolvedValue({ txHash: '0xbeef', success: true });
    mockKiteVerify.mockResolvedValue({ valid: true });
    mockKiteSettle.mockResolvedValue({ txHash: '0xdeadbeef', success: true });
    mockAvaxVerify.mockResolvedValue({ valid: true });
    mockAvaxSettle.mockResolvedValue({ txHash: '0xa00a', success: true });
    mockNonceInsert.mockResolvedValue({ data: null, error: null });
    process.env.KITE_WALLET_ADDRESS = SERVER_WALLET;
  });

  afterEach(() => {
    if (ORIGINAL_WALLET === undefined) {
      delete process.env.KITE_WALLET_ADDRESS;
    } else {
      process.env.KITE_WALLET_ADDRESS = ORIGINAL_WALLET;
    }
  });

  // ── T-AC1: to-mismatch → 402, verify/settle NOT called (CD-1) ──

  it('T-AC1: to-mismatch → 402 without calling verify/settle', async () => {
    const app = buildApp();
    await app.ready();
    try {
      const { headers } = buildEoaPaymentHeader({
        to: ATTACKER_WALLET,
        value: '1000000',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { ...headers, 'x-payment-chain': 'base-sepolia' },
        payload: {},
      });
      expect(res.statusCode).toBe(402);
      expect(mockBaseVerify).not.toHaveBeenCalled();
      expect(mockBaseSettle).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  // ── T-AC2: underpay → 402, verify/settle NOT called (CD-1) ──

  it('T-AC2: underpay → 402 without calling verify/settle', async () => {
    const app = buildApp();
    await app.ready();
    try {
      const { headers } = buildEoaPaymentHeader({
        to: SERVER_WALLET,
        value: '1',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { ...headers, 'x-payment-chain': 'base-sepolia' },
        payload: {},
      });
      expect(res.statusCode).toBe(402);
      expect(mockBaseVerify).not.toHaveBeenCalled();
      expect(mockBaseSettle).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  // ── T-AC3: correct payment → verify+settle, paymentVerified=true ──

  it('T-AC3: correct to+value → verify+settle, paymentVerified=true', async () => {
    const app = buildApp();
    await app.ready();
    try {
      const { headers } = buildEoaPaymentHeader({
        to: SERVER_WALLET,
        value: '1000000',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { ...headers, 'x-payment-chain': 'base-sepolia' },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ paid: true });
      expect(mockBaseVerify).toHaveBeenCalledTimes(1);
      expect(mockBaseSettle).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  // ── M1 (audit 2026-06-24): x402 INBOUND anti-replay ──

  // Nonce nuevo (insert sin error) → settle se ejecuta. El INSERT registra el
  // nonce con el network del adapter (eip155:84532 para base-sepolia).
  it('M1: fresh nonce → records (network,nonce) and proceeds to settle', async () => {
    const app = buildApp();
    await app.ready();
    try {
      const { headers } = buildEoaPaymentHeader({
        to: SERVER_WALLET,
        value: '1000000',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { ...headers, 'x-payment-chain': 'base-sepolia' },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(mockNonceInsert).toHaveBeenCalledTimes(1);
      expect(mockNonceInsert.mock.calls[0][0]).toMatchObject({
        network: 'eip155:84532',
      });
      expect(mockBaseSettle).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  // Nonce repetido (insert choca con 23505) → 402 X402_REPLAY, settle NO se llama.
  it('M1: replayed nonce (23505) → 402 and settle NOT called', async () => {
    mockNonceInsert.mockResolvedValue({
      data: null,
      error: { code: '23505', message: 'dup' },
    });
    const app = buildApp();
    await app.ready();
    try {
      const { headers } = buildEoaPaymentHeader({
        to: SERVER_WALLET,
        value: '1000000',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { ...headers, 'x-payment-chain': 'base-sepolia' },
        payload: {},
      });
      expect(res.statusCode).toBe(402);
      expect(mockBaseSettle).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  // DB down (insert error no-23505) → fail-open CONSERVADOR: settle SÍ se ejecuta
  // (el nonce EIP-3009 on-chain sigue siendo single-use; esto es defensa en prof.).
  it('M1: nonce DB error (non-23505) → fail-open, settle still runs', async () => {
    mockNonceInsert.mockResolvedValue({
      data: null,
      error: { code: '500', message: 'db down' },
    });
    const app = buildApp();
    await app.ready();
    try {
      const { headers } = buildEoaPaymentHeader({
        to: SERVER_WALLET,
        value: '1000000',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { ...headers, 'x-payment-chain': 'base-sepolia' },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(mockBaseSettle).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  // ── T-AC3-overpay: value > required → accepted (DT-3) ──

  it('T-AC3-overpay: value > required → accepted (overpay allowed)', async () => {
    const app = buildApp();
    await app.ready();
    try {
      const { headers } = buildEoaPaymentHeader({
        to: SERVER_WALLET,
        value: '2000000',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { ...headers, 'x-payment-chain': 'base-sepolia' },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(mockBaseSettle).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  // ── T-AC6: structured log on reject; body does NOT leak the wallet (CD-2) ──

  it('T-AC6: reject logs X402_BINDING_MISMATCH and body does not expose wallet', async () => {
    const app = buildApp();
    const warnSpy = vi.spyOn(app.log, 'warn');
    await app.ready();
    try {
      const { headers } = buildEoaPaymentHeader({
        to: ATTACKER_WALLET,
        value: '1000000',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { ...headers, 'x-payment-chain': 'base-sepolia' },
        payload: {},
      });
      expect(res.statusCode).toBe(402);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ error_code: 'X402_BINDING_MISMATCH' }),
        expect.any(String),
      );
      // CD-2: the human-readable error message must NOT leak the wallet.
      // (accepts[0].payTo intentionally announces it via the x402 protocol.)
      const body = res.json() as ChallengeBody;
      expect(body.error.toLowerCase()).not.toContain('dead');
    } finally {
      warnSpy.mockRestore();
      await app.close();
    }
  });

  // ── T-3CHAINS: binding applies on kite/base/avalanche, dimension-aware ──

  // base/avalanche → 6-dec required '1000000'; kite → 18-dec '1000000000000000000'.
  const chainCases = [
    {
      chain: 'base-sepolia',
      good: '1000000',
      verify: mockBaseVerify,
      settle: mockBaseSettle,
    },
    {
      chain: 'avalanche-fuji',
      good: '1000000',
      verify: mockAvaxVerify,
      settle: mockAvaxSettle,
    },
    {
      chain: 'kite-ozone-testnet',
      good: '1000000000000000000',
      verify: mockKiteVerify,
      settle: mockKiteSettle,
    },
  ];

  for (const tc of chainCases) {
    it(`T-3CHAINS[${tc.chain}]: rejects bad to/value, accepts correct value`, async () => {
      // Bad: attacker recipient → reject, no network call.
      const appBad = buildApp();
      await appBad.ready();
      try {
        const { headers } = buildEoaPaymentHeader({
          to: ATTACKER_WALLET,
          value: '1',
        });
        const res = await appBad.inject({
          method: 'POST',
          url: '/test',
          headers: { ...headers, 'x-payment-chain': tc.chain },
          payload: {},
        });
        expect(res.statusCode).toBe(402);
        expect(tc.verify).not.toHaveBeenCalled();
        expect(tc.settle).not.toHaveBeenCalled();
      } finally {
        await appBad.close();
      }

      // Good: correct recipient + dimension-aligned value → accepted.
      const appGood = buildApp();
      await appGood.ready();
      try {
        const { headers } = buildEoaPaymentHeader({
          to: SERVER_WALLET,
          value: tc.good,
        });
        const res = await appGood.inject({
          method: 'POST',
          url: '/test',
          headers: { ...headers, 'x-payment-chain': tc.chain },
          payload: {},
        });
        expect(res.statusCode).toBe(200);
        expect(tc.verify).toHaveBeenCalledTimes(1);
        expect(tc.settle).toHaveBeenCalledTimes(1);
      } finally {
        await appGood.close();
      }
    });
  }

  // ── T-NOREG: challenge 402 without header → accepts[0] byte-identical ──

  it('T-NOREG: no payment-signature → 402 challenge unchanged (Base)', async () => {
    const app = buildApp();
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
      expect(body.accepts[0].payTo).toBe(SERVER_WALLET);
      expect(body.accepts[0].maxAmountRequired).toBe('1000000');
    } finally {
      await app.close();
    }
  });
});
