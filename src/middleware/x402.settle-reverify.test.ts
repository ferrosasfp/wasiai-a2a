/**
 * x402 Middleware — settle re-verify catch-path (WKH-144 MNR-1a)
 *
 * The `catch` around `verifySettledTx` used to hardcode
 * `{ ok: true, reason: 'RPC_UNAVAILABLE', warn: true }` — a network-agnostic
 * fail-OPEN. If a throw happens in the try (e.g. a malformed `BigInt`), MAINNET
 * would blindly grant access. This proves the catch now gates via
 * `rpcUnavailableResult(chainKey)`:
 *   - MAINNET  → fail-CLOSED → 402, no access (paymentVerified NOT set)
 *   - TESTNET  → fail-OPEN   → 200, access granted (byte-identical to before)
 *
 * Harness cloned from `x402.binding.test.ts`: Fastify in-memory + mocked
 * registry (kite-mainnet 18-dec / kite-ozone-testnet 18-dec). `verifySettledTx`
 * is mocked to THROW while `rpcUnavailableResult` stays REAL (importOriginal).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KITE_TOKEN = '0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e';

const kiteAdapter = {
  verify: vi.fn().mockResolvedValue({ valid: true }),
  settle: vi.fn().mockResolvedValue({ txHash: '0xdeadbeef', success: true }),
  getToken: vi.fn().mockReturnValue(KITE_TOKEN),
  getNetwork: vi.fn().mockReturnValue('eip155:2366'),
  getScheme: vi.fn().mockReturnValue('exact'),
  getMerchantName: vi.fn().mockReturnValue('wasiai-a2a-test'),
  getMaxTimeoutSeconds: vi.fn().mockReturnValue(300),
  quote: vi.fn().mockResolvedValue({
    amountWei: '1000000000000000000',
    token: { symbol: 'KITE', address: KITE_TOKEN, decimals: 18 },
    facilitatorUrl: 'http://mock',
  }),
};

// A bundle carrying a supportedTokens[0] so the settle re-verify block runs.
function bundleFor(chainId: number) {
  return {
    chainConfig: { chainId },
    payment: {
      vmFamily: 'evm',
      supportedTokens: [{ address: KITE_TOKEN, decimals: 18 }],
    },
  };
}

const mockGetAdaptersBundle = vi.fn((chainKey?: string) => {
  if (chainKey === 'kite-mainnet') return bundleFor(2366);
  if (chainKey === 'kite-ozone-testnet') return bundleFor(2368);
  return undefined;
});

// HU-204: `acceptsInboundPayment` (la regla del guard de inbound) sale del
// módulo REAL — un stub podría mentir y dejar el guard verde sin existir. Los
// bundles de arriba ya declaran `payment.vmFamily: 'evm'`, así que pasan.
vi.mock('../adapters/registry.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../adapters/registry.js')>();
  return {
    acceptsInboundPayment: actual.acceptsInboundPayment,
    getInboundPaymentChainKeys: () => ['kite-mainnet', 'kite-ozone-testnet'],
    getPaymentAdapter: () => kiteAdapter,
    getAdaptersBundle: (chainKey?: string) => mockGetAdaptersBundle(chainKey),
    getInitializedChainKeys: () => ['kite-mainnet', 'kite-ozone-testnet'],
    getDefaultChainKey: () => 'kite-ozone-testnet',
  };
});

// Nonce anti-replay: mock supabase so the pre-settle insert is a no-op.
const mockNonceInsert = vi.fn().mockResolvedValue({ data: null, error: null });
vi.mock('../lib/supabase.js', () => ({
  supabase: {
    from: vi.fn(() => ({ insert: (...a: unknown[]) => mockNonceInsert(...a) })),
    rpc: vi.fn(),
  },
}));

// WKH-144 MNR-1a: force the verifier to THROW so the catch is exercised. Keep
// `rpcUnavailableResult` REAL so the catch's mainnet/testnet gate is the actual
// production logic under test.
vi.mock('../adapters/settle-verifier.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../adapters/settle-verifier.js')>();
  return {
    ...actual,
    verifySettledTx: vi.fn(() => {
      throw new Error('boom (simulated malformed BigInt / :443)');
    }),
  };
});

import { buildEoaPaymentHeader } from '../__tests__/fixtures/passport-shape.js';
import { requirePayment } from './x402.js';

const SERVER_WALLET = '0x000000000000000000000000000000000000dEaD';
const KITE_VALUE = '1000000000000000000';

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

describe('x402 settle re-verify catch-path (WKH-144 MNR-1a)', () => {
  const ORIGINAL_WALLET = process.env.KITE_WALLET_ADDRESS;

  beforeEach(() => {
    vi.clearAllMocks();
    kiteAdapter.verify.mockResolvedValue({ valid: true });
    kiteAdapter.settle.mockResolvedValue({
      txHash: '0xdeadbeef',
      success: true,
    });
    mockNonceInsert.mockResolvedValue({ data: null, error: null });
    process.env.KITE_WALLET_ADDRESS = SERVER_WALLET;
  });

  afterEach(() => {
    if (ORIGINAL_WALLET === undefined) delete process.env.KITE_WALLET_ADDRESS;
    else process.env.KITE_WALLET_ADDRESS = ORIGINAL_WALLET;
  });

  it('MAINNET: verifier throws → fail-CLOSED → 402, access NOT granted', async () => {
    const app = buildApp();
    await app.ready();
    try {
      const { headers } = buildEoaPaymentHeader({
        to: SERVER_WALLET,
        value: KITE_VALUE,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { ...headers, 'x-payment-chain': 'kite-mainnet' },
        payload: {},
      });
      expect(res.statusCode).toBe(402);
      expect(res.json()).not.toEqual({ paid: true });
    } finally {
      await app.close();
    }
  });

  it('TESTNET: verifier throws → fail-OPEN preserved → 200, access granted', async () => {
    const app = buildApp();
    await app.ready();
    try {
      const { headers } = buildEoaPaymentHeader({
        to: SERVER_WALLET,
        value: KITE_VALUE,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/test',
        headers: { ...headers, 'x-payment-chain': 'kite-ozone-testnet' },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ paid: true });
    } finally {
      await app.close();
    }
  });
});
