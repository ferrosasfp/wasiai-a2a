import type { PublicClient, WalletClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WasiAgent } from '../src/agent.js';
import { WasiAgentError } from '../src/errors.js';

const PK = generatePrivateKey();
const testAccount = privateKeyToAccount(PK);

interface JsonResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
function res(status: number, body: unknown): JsonResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function baseConfig(over: Partial<Parameters<typeof WasiAgent>[1]> = {}) {
  return {
    a2aBase: 'http://x',
    network: 'base-sepolia',
    rpcUrl: 'http://x',
    chainId: 84532,
    ...over,
  };
}

describe('anti-leak + config (AC-10/AC-11)', () => {
  let realFetch: typeof globalThis.fetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
    // Si el SDK toca el fetch REAL, este spy lo detecta (AC-11: todo por config).
    globalThis.fetch = vi.fn(async () => {
      throw new Error('REAL_FETCH_INVOKED');
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('AC-10: toJSON/toString redactan PK y token key', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
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
        return res(200, { key: 'wasi_a2a_TOPSECRET', key_id: 'kid-z' });
      if (path === '/auth/funding-wallet') return res(200, {});
      if (path === '/auth/deposit')
        return res(200, { balance: '1.0', chain_id: 84532 });
      return res(404, {});
    }) as unknown as typeof fetch;

    const walletClient = {
      writeContract: vi.fn(async () => '0xabc' as `0x${string}`),
      account: testAccount,
      chain: undefined,
    } as unknown as WalletClient;
    const publicClient = {
      waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
    } as unknown as PublicClient;

    const agent = new WasiAgent(
      testAccount,
      baseConfig({ fetchImpl, walletClient, publicClient }),
    );
    await agent.provision({ ownerRef: 'o', amount: '1.0' });

    const serialized = JSON.stringify(agent);
    const str = agent.toString();
    const noPk = PK.replace(/^0x/, '');
    for (const blob of [serialized, str]) {
      expect(blob).not.toContain('wasi_a2a_TOPSECRET');
      expect(blob).not.toContain(noPk);
      expect(blob).not.toContain(PK);
    }
    // toJSON expone solo metadata pública
    expect(JSON.parse(serialized)).toEqual({
      network: 'base-sepolia',
      chainId: 84532,
      address: testAccount.address,
      keyId: 'kid-z',
    });
    // AC-11: ningún fetch real invocado
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('AC-10: error tipado no filtra PK ni key en message/JSON', async () => {
    const fetchImpl = vi.fn(async () =>
      res(500, { error: 'boom', secret: 'wasi_a2a_TOPSECRET' }),
    ) as unknown as typeof fetch;
    const agent = new WasiAgent(testAccount, baseConfig({ fetchImpl }));
    const err = (await agent
      .provision({ ownerRef: 'o', amount: '1.0' })
      .catch((e) => e)) as WasiAgentError;
    expect(err).toBeInstanceOf(WasiAgentError);
    expect(err.message).not.toContain('wasi_a2a_TOPSECRET');
    // cause es no-enumerable → no aparece en JSON.stringify del error
    expect(JSON.stringify(err)).not.toContain('wasi_a2a_TOPSECRET');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('config inválida → WasiAgentError(INVALID_CONFIG)', () => {
    expect(
      () =>
        new WasiAgent(testAccount, {
          a2aBase: '',
          network: 'base-sepolia',
          rpcUrl: 'http://x',
          chainId: 84532,
        }),
    ).toThrowError(WasiAgentError);
  });
});
