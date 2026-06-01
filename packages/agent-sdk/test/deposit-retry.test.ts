import type { PublicClient, WalletClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WasiAgent } from '../src/agent.js';
import { ProvisionError } from '../src/errors.js';

const testAccount = privateKeyToAccount(generatePrivateKey());

const TREASURY = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x3333333333333333333333333333333333333333';

interface JsonResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
function res(status: number, body: unknown): JsonResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function depositInfoBody() {
  return {
    networks: [
      {
        chain_id: 84532,
        slug: 'base-sepolia',
        treasury: TREASURY,
        token: { symbol: 'USDC', address: TOKEN, decimals: 6 },
        min_confirmations: 1,
      },
    ],
  };
}

function baseConfig(over: Partial<Parameters<typeof WasiAgent>[1]> = {}) {
  return {
    a2aBase: 'http://x',
    network: 'base-sepolia',
    rpcUrl: 'http://x',
    chainId: 84532,
    depositRetryMax: 6,
    depositRetryDelayMs: 5000,
    ...over,
  };
}

function makeClients() {
  const walletClient = {
    writeContract: vi.fn(async () => '0xabc' as `0x${string}`),
    account: testAccount,
    chain: undefined,
  } as unknown as WalletClient;
  const publicClient = {
    waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
  } as unknown as PublicClient;
  return { walletClient, publicClient };
}

/**
 * Crea un fetch mock que responde fijo a deposit-info/signup/funding-wallet/me y
 * delega el comportamiento de /auth/deposit a `depositHandler` (recibe el nº de
 * intento, 0-indexed).
 */
function makeFetch(opts: {
  depositHandler: (attempt: number) => JsonResponse;
  meBody?: unknown;
  depositCounter: { n: number };
}) {
  return vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/auth/deposit-info') return res(200, depositInfoBody());
    if (path === '/auth/agent-signup')
      return res(200, { key: 'wasi_a2a_SECRET', key_id: 'kid-1' });
    if (path === '/auth/funding-wallet') return res(200, {});
    if (path === '/auth/me') return res(200, opts.meBody ?? { budget: {} });
    if (path === '/auth/deposit') {
      const attempt = opts.depositCounter.n;
      opts.depositCounter.n += 1;
      return opts.depositHandler(attempt);
    }
    return res(404, {});
  }) as unknown as typeof fetch;
}

describe('provision() — deposit retry (WKH-105)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('INSUFFICIENT_CONFIRMATIONS x2 luego 200 → resuelve OK (3 intentos, balance del 200)', async () => {
    const depositCounter = { n: 0 };
    const fetchImpl = makeFetch({
      depositCounter,
      depositHandler: (attempt) => {
        if (attempt < 2)
          return res(400, { error_code: 'INSUFFICIENT_CONFIRMATIONS' });
        return res(200, { balance: '5.0', chain_id: 84532 });
      },
    });
    const { walletClient, publicClient } = makeClients();
    const agent = new WasiAgent(
      testAccount,
      baseConfig({ fetchImpl, walletClient, publicClient }),
    );

    const p = agent.provision({ ownerRef: 'o', amount: '1.0' });
    await vi.runAllTimersAsync();
    const result = await p;

    expect(depositCounter.n).toBe(3);
    expect(result.balance).toBe('5.0');
    expect(result.chainId).toBe(84532);
  });

  it('DEPOSIT_ALREADY_CREDITED → resuelve OK leyendo balance de /auth/me (1 intento de deposit, no lanza)', async () => {
    const depositCounter = { n: 0 };
    const fetchImpl = makeFetch({
      depositCounter,
      depositHandler: () =>
        res(409, { error_code: 'DEPOSIT_ALREADY_CREDITED' }),
      meBody: { budget: { '84532': '7.5' } },
    });
    const { walletClient, publicClient } = makeClients();
    const agent = new WasiAgent(
      testAccount,
      baseConfig({ fetchImpl, walletClient, publicClient }),
    );

    const p = agent.provision({ ownerRef: 'o', amount: '1.0' });
    await vi.runAllTimersAsync();
    const result = await p;

    expect(depositCounter.n).toBe(1); // sin reintentos: ALREADY_CREDITED es éxito
    expect(result.balance).toBe('7.5');
  });

  it('RECIPIENT_MISMATCH → falla INMEDIATO sin reintentos (1 intento)', async () => {
    const depositCounter = { n: 0 };
    const fetchImpl = makeFetch({
      depositCounter,
      depositHandler: () => res(400, { error_code: 'RECIPIENT_MISMATCH' }),
    });
    const { walletClient, publicClient } = makeClients();
    const agent = new WasiAgent(
      testAccount,
      baseConfig({ fetchImpl, walletClient, publicClient }),
    );

    const p = agent.provision({ ownerRef: 'o', amount: '1.0' });
    const settled = p.catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await settled;

    expect(depositCounter.n).toBe(1);
    expect(err).toBeInstanceOf(ProvisionError);
    expect(err.step).toBe('deposit');
  });

  it('timeout: siempre INSUFFICIENT_CONFIRMATIONS → ProvisionError(deposit) tras depositRetryMax+1 intentos', async () => {
    const depositCounter = { n: 0 };
    const fetchImpl = makeFetch({
      depositCounter,
      depositHandler: () =>
        res(400, { error_code: 'INSUFFICIENT_CONFIRMATIONS' }),
    });
    const { walletClient, publicClient } = makeClients();
    const agent = new WasiAgent(
      testAccount,
      baseConfig({
        fetchImpl,
        walletClient,
        publicClient,
        depositRetryMax: 3,
        depositRetryDelayMs: 1000,
      }),
    );

    const p = agent.provision({ ownerRef: 'o', amount: '1.0' });
    const settled = p.catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await settled;

    // 1 inicial + 3 reintentos = 4 intentos
    expect(depositCounter.n).toBe(4);
    expect(err).toBeInstanceOf(ProvisionError);
    expect(err.step).toBe('deposit');
  });
});
