import type { PublicClient, WalletClient } from 'viem';
import { parseUnits } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
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
        min_confirmations: 2,
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
    ...over,
  };
}

describe('provision()', () => {
  it('AC-1/AC-2: happy path en orden, parseUnits con decimals, espera min_confirmations, result sin key/PK', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === '/auth/deposit-info') return res(200, depositInfoBody());
      if (path === '/auth/agent-signup')
        return res(200, { key: 'wasi_a2a_SECRET', key_id: 'kid-1' });
      if (path === '/auth/funding-wallet') return res(200, {});
      if (path === '/auth/deposit')
        return res(200, { balance: '1.0', chain_id: 84532 });
      return res(404, {});
    }) as unknown as typeof fetch;

    const writeContract = vi.fn(async () => '0xabc' as `0x${string}`);
    const waitForTransactionReceipt = vi.fn(async () => ({
      status: 'success',
    }));
    const walletClient = {
      writeContract,
      account: testAccount,
      chain: undefined,
    } as unknown as WalletClient;
    const publicClient = {
      waitForTransactionReceipt,
    } as unknown as PublicClient;

    const agent = new WasiAgent(
      testAccount,
      baseConfig({ fetchImpl, walletClient, publicClient }),
    );
    const result = await agent.provision({ ownerRef: 'o', amount: '1.0' });

    // orden secuencial
    expect(calls).toEqual([
      '/auth/deposit-info',
      '/auth/agent-signup',
      '/auth/funding-wallet',
      '/auth/deposit',
    ]);
    // parseUnits con los decimals del token (6 → 1_000_000)
    expect(writeContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: TOKEN,
        functionName: 'transfer',
        args: [TREASURY, parseUnits('1.0', 6)],
      }),
    );
    // espera las min_confirmations del deposit-info
    expect(waitForTransactionReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ confirmations: 2 }),
    );
    // result sin secretos
    expect(result).toEqual({
      keyId: 'kid-1',
      balance: '1.0',
      chainId: 84532,
      fundingWallet: testAccount.address,
      txHash: '0xabc',
    });
    expect(JSON.stringify(result)).not.toContain('wasi_a2a_SECRET');
  });

  it('AC-3: transfer revert → ProvisionError step=transfer', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/auth/deposit-info') return res(200, depositInfoBody());
      if (path === '/auth/agent-signup')
        return res(200, { key: 'wasi_a2a_X', key_id: 'kid-2' });
      if (path === '/auth/funding-wallet') return res(200, {});
      return res(404, {});
    }) as unknown as typeof fetch;

    const walletClient = {
      writeContract: vi.fn(async () => {
        throw new Error('execution reverted');
      }),
      account: testAccount,
      chain: undefined,
    } as unknown as WalletClient;
    const publicClient = {
      waitForTransactionReceipt: vi.fn(),
    } as unknown as PublicClient;

    const agent = new WasiAgent(
      testAccount,
      baseConfig({ fetchImpl, walletClient, publicClient }),
    );
    await expect(
      agent.provision({ ownerRef: 'o', amount: '1.0' }),
    ).rejects.toMatchObject({ name: 'ProvisionError', step: 'transfer' });
  });

  it('AC-3: RPC down en waitReceipt → ProvisionError step=transfer', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/auth/deposit-info') return res(200, depositInfoBody());
      if (path === '/auth/agent-signup')
        return res(200, { key: 'wasi_a2a_X', key_id: 'kid-3' });
      if (path === '/auth/funding-wallet') return res(200, {});
      return res(404, {});
    }) as unknown as typeof fetch;

    const walletClient = {
      writeContract: vi.fn(async () => '0xfff' as `0x${string}`),
      account: testAccount,
      chain: undefined,
    } as unknown as WalletClient;
    const publicClient = {
      waitForTransactionReceipt: vi.fn(async () => {
        throw new Error('RPC unavailable');
      }),
    } as unknown as PublicClient;

    const agent = new WasiAgent(
      testAccount,
      baseConfig({ fetchImpl, walletClient, publicClient }),
    );
    const err = await agent
      .provision({ ownerRef: 'o', amount: '1.0' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ProvisionError);
    expect(err.step).toBe('transfer');
  });

  it('treasury null → ProvisionError step=transfer', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/auth/deposit-info')
        return res(200, {
          networks: [
            {
              chain_id: 84532,
              slug: 'base-sepolia',
              treasury: null,
              token: { symbol: 'USDC', address: TOKEN, decimals: 6 },
              min_confirmations: 2,
            },
          ],
        });
      return res(404, {});
    }) as unknown as typeof fetch;
    const agent = new WasiAgent(testAccount, baseConfig({ fetchImpl }));
    await expect(
      agent.provision({ ownerRef: 'o', amount: '1.0' }),
    ).rejects.toMatchObject({ step: 'transfer' });
  });
});
