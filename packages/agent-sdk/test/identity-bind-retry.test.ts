import type { PublicClient, WalletClient } from 'viem';
import { encodeAbiParameters, pad, toEventSelector, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WasiAgent } from '../src/agent.js';
import { IdentityMintError } from '../src/errors.js';

const testAccount = privateKeyToAccount(generatePrivateKey());
const REGISTRY = '0x4444444444444444444444444444444444444444' as const;

interface JsonResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
function res(status: number, body: unknown): JsonResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// Log `Registered` real (topics + data) con primitivas viem; agentId = tokenId.
function registeredLog(agentId: bigint, agentURI: string) {
  return {
    address: REGISTRY,
    topics: [
      toEventSelector('Registered(uint256,string,address)'),
      pad(toHex(agentId)),
      pad(testAccount.address),
    ],
    data: encodeAbiParameters([{ type: 'string' }], [agentURI]),
  };
}

function baseConfig(over: Partial<Parameters<typeof WasiAgent>[1]> = {}) {
  return {
    a2aBase: 'http://x',
    network: 'base-sepolia',
    rpcUrl: 'http://x',
    chainId: 84532,
    enableIdentityMint: true,
    identityRegistryAddress: REGISTRY,
    identityBindRetryMax: 6,
    identityBindRetryDelayMs: 5000,
    ...over,
  };
}

function makeClients() {
  const walletClient = {
    writeContract: vi.fn(async () => '0xmint' as `0x${string}`),
    account: testAccount,
    chain: undefined,
  } as unknown as WalletClient;
  const publicClient = {
    waitForTransactionReceipt: vi.fn(async () => ({
      logs: [registeredLog(4242n, 'data:application/json;base64,xxx')],
    })),
  } as unknown as PublicClient;
  return { walletClient, publicClient };
}

/**
 * fetch mock: responde fijo a deposit-info/signup/funding-wallet/deposit y
 * delega /auth/erc8004/bind a `bindHandler` (recibe el nº de intento, 0-indexed).
 */
function makeFetch(opts: {
  bindHandler: (attempt: number) => JsonResponse;
  bindCounter: { n: number };
}) {
  return vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/auth/deposit-info')
      return res(200, {
        networks: [
          {
            chain_id: 84532,
            slug: 'base-sepolia',
            treasury: '0x2222222222222222222222222222222222222222',
            token: {
              symbol: 'USDC',
              address: '0x3333333333333333333333333333333333333333',
              decimals: 6,
            },
            min_confirmations: 1,
          },
        ],
      });
    if (path === '/auth/agent-signup')
      return res(200, { key: 'wasi_a2a_SECRET', key_id: 'kid-m' });
    if (path === '/auth/funding-wallet') return res(200, {});
    if (path === '/auth/deposit')
      return res(200, { balance: '1.0', chain_id: 84532 });
    if (path === '/auth/erc8004/bind') {
      const attempt = opts.bindCounter.n;
      opts.bindCounter.n += 1;
      return opts.bindHandler(attempt);
    }
    return res(404, {});
  }) as unknown as typeof fetch;
}

describe('mintIdentity() — bind retry (WKH-105)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('ERC8004_TOKEN_NOT_FOUND x2 luego 200 → mint OK (3 intentos de bind, tokenId del log)', async () => {
    const bindCounter = { n: 0 };
    const fetchImpl = makeFetch({
      bindCounter,
      bindHandler: (attempt) => {
        if (attempt < 2)
          return res(404, { error_code: 'ERC8004_TOKEN_NOT_FOUND' });
        return res(200, {});
      },
    });
    const { walletClient, publicClient } = makeClients();
    const agent = new WasiAgent(
      testAccount,
      baseConfig({ fetchImpl, walletClient, publicClient }),
    );

    await agent.provision({ ownerRef: 'o', amount: '1.0' });
    const p = agent.mintIdentity();
    await vi.runAllTimersAsync();
    const mint = await p;

    expect(bindCounter.n).toBe(3);
    expect(mint.skipped).toBe(false);
    expect(mint.tokenId).toBe('4242');
    expect(mint.mintTxHash).toBe('0xmint');
  });

  it('RPC_UNAVAILABLE bajo `reason` (forma REAL del server) x1 luego 200 → reintenta y resuelve (2 intentos)', async () => {
    const bindCounter = { n: 0 };
    const fetchImpl = makeFetch({
      bindCounter,
      bindHandler: (attempt) => {
        // El bind path del server manda RPC_UNAVAILABLE bajo `reason` (no error_code).
        if (attempt < 1)
          return res(503, { ok: false, reason: 'RPC_UNAVAILABLE' });
        return res(200, {});
      },
    });
    const { walletClient, publicClient } = makeClients();
    const agent = new WasiAgent(
      testAccount,
      baseConfig({ fetchImpl, walletClient, publicClient }),
    );

    await agent.provision({ ownerRef: 'o', amount: '1.0' });
    const p = agent.mintIdentity();
    await vi.runAllTimersAsync();
    const mint = await p;

    expect(bindCounter.n).toBe(2);
    expect(mint.skipped).toBe(false);
    expect(mint.tokenId).toBe('4242');
    expect(mint.mintTxHash).toBe('0xmint');
  });

  it('ERC8004_ALREADY_BOUND → éxito idempotente (1 intento, no lanza)', async () => {
    const bindCounter = { n: 0 };
    const fetchImpl = makeFetch({
      bindCounter,
      bindHandler: () => res(409, { error_code: 'ERC8004_ALREADY_BOUND' }),
    });
    const { walletClient, publicClient } = makeClients();
    const agent = new WasiAgent(
      testAccount,
      baseConfig({ fetchImpl, walletClient, publicClient }),
    );

    await agent.provision({ ownerRef: 'o', amount: '1.0' });
    const p = agent.mintIdentity();
    await vi.runAllTimersAsync();
    const mint = await p;

    expect(bindCounter.n).toBe(1); // sin reintentos: ALREADY_BOUND es éxito
    expect(mint.skipped).toBe(false);
    expect(mint.tokenId).toBe('4242');
  });

  it('IDENTITY_OWNERSHIP_MISMATCH → falla INMEDIATO sin reintentos (1 intento)', async () => {
    const bindCounter = { n: 0 };
    const fetchImpl = makeFetch({
      bindCounter,
      bindHandler: () =>
        res(403, { error_code: 'IDENTITY_OWNERSHIP_MISMATCH' }),
    });
    const { walletClient, publicClient } = makeClients();
    const agent = new WasiAgent(
      testAccount,
      baseConfig({ fetchImpl, walletClient, publicClient }),
    );

    await agent.provision({ ownerRef: 'o', amount: '1.0' });
    const p = agent.mintIdentity();
    const settled = p.catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await settled;

    expect(bindCounter.n).toBe(1);
    expect(err).toBeInstanceOf(IdentityMintError);
    expect(err.stage).toBe('bind');
  });

  it('timeout: siempre ERC8004_TOKEN_NOT_FOUND → IdentityMintError(bind) tras identityBindRetryMax+1 intentos', async () => {
    const bindCounter = { n: 0 };
    const fetchImpl = makeFetch({
      bindCounter,
      bindHandler: () => res(404, { error_code: 'ERC8004_TOKEN_NOT_FOUND' }),
    });
    const { walletClient, publicClient } = makeClients();
    const agent = new WasiAgent(
      testAccount,
      baseConfig({
        fetchImpl,
        walletClient,
        publicClient,
        identityBindRetryMax: 3,
        identityBindRetryDelayMs: 1000,
      }),
    );

    await agent.provision({ ownerRef: 'o', amount: '1.0' });
    const p = agent.mintIdentity();
    const settled = p.catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await settled;

    // 1 inicial + 3 reintentos = 4 intentos
    expect(bindCounter.n).toBe(4);
    expect(err).toBeInstanceOf(IdentityMintError);
    expect(err.stage).toBe('bind');
    expect(err.message).toContain('identity not visible after 4 attempts');
  });
});
