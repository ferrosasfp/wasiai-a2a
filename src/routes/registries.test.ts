/**
 * Registries Routes Auth Tests — WKH-SEC-01
 * Tests: AC-1 (POST requires auth), AC-2 (DELETE requires auth), AC-2b (PATCH requires auth)
 *
 * DT-8: The `requirePaymentOrA2AKey` middleware delegates to x402 when no
 * `x-a2a-key`/`Authorization` header is present. Depending on env config, the
 * x402 handler may respond with 401, 402 (payment required) or 403. We accept
 * any of the three as proof that the handler rejected the request before
 * reaching `registryService.*`.
 */

import Fastify from 'fastify';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// ── Mocks ───────────────────────────────────────────────────

vi.mock('../services/registry.js', () => ({
  registryService: {
    list: vi.fn(),
    get: vi.fn(),
    register: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../services/identity.js', () => ({
  identityService: {
    createKey: vi.fn(),
    lookupByHash: vi.fn(),
    deactivate: vi.fn(),
  },
}));

vi.mock('../services/budget.js', () => ({
  budgetService: {
    getBalance: vi.fn(),
    debit: vi.fn(),
    registerDeposit: vi.fn(),
  },
}));

vi.mock('../adapters/registry.js', () => ({
  getPaymentAdapter: vi.fn(() => ({
    name: 'mock',
    chainId: 2368,
    supportedTokens: [],
    getScheme: () => 'exact',
    getNetwork: () => 'eip155:2368',
    getToken: () => '0x0000000000000000000000000000000000000000' as const,
    getMaxTimeoutSeconds: () => 60,
    getMerchantName: () => 'WasiAI Test',
    settle: vi.fn(),
    verify: vi.fn(),
    quote: vi.fn(),
    sign: vi.fn(),
  })),
  getChainConfig: vi.fn(() => ({
    name: 'eip155:2368',
    chainId: 2368,
    explorerUrl: 'https://explorer.test',
  })),
  getAttestationAdapter: vi.fn(),
  getGaslessAdapter: vi.fn(),
  getIdentityBindingAdapter: vi.fn(),
  initAdapters: vi.fn(),
  _resetRegistry: vi.fn(),
}));

import { registryService } from '../services/registry.js';
import registriesRoutes from './registries.js';

const mockRegister = vi.mocked(registryService.register);
const mockUpdate = vi.mocked(registryService.update);
const mockDelete = vi.mocked(registryService.delete);

// ── Setup ───────────────────────────────────────────────────

describe('registries routes — auth required (WKH-SEC-01)', () => {
  let app: ReturnType<typeof Fastify>;
  const prevWallet = process.env.KITE_WALLET_ADDRESS;
  const prevPaymentWallet = process.env.PAYMENT_WALLET_ADDRESS;

  beforeAll(async () => {
    // Ensure x402 middleware has a wallet configured, so it reaches the 402
    // (payment-required) branch instead of returning 503 (config error).
    process.env.KITE_WALLET_ADDRESS =
      '0x0000000000000000000000000000000000000001';

    app = Fastify();
    await app.register(registriesRoutes, { prefix: '/registries' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (prevWallet === undefined) delete process.env.KITE_WALLET_ADDRESS;
    else process.env.KITE_WALLET_ADDRESS = prevWallet;
    if (prevPaymentWallet === undefined)
      delete process.env.PAYMENT_WALLET_ADDRESS;
    else process.env.PAYMENT_WALLET_ADDRESS = prevPaymentWallet;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('AC-1: POST /registries without auth header returns 401/402/403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/registries',
      payload: {
        name: 'x',
        discoveryEndpoint: 'https://a',
        invokeEndpoint: 'https://b',
        schema: {},
      },
    });

    expect([401, 402, 403]).toContain(res.statusCode);
    expect(mockRegister).not.toHaveBeenCalled();
  });

  it('AC-2: DELETE /registries/:id without auth header returns 401/402/403', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/registries/abc-123',
    });

    expect([401, 402, 403]).toContain(res.statusCode);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('AC-2b: PATCH /registries/:id without auth header returns 401/402/403', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/registries/abc-123',
      payload: { name: 'new' },
    });

    expect([401, 402, 403]).toContain(res.statusCode);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
