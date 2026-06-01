import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import { WasiAgent } from '../src/agent.js';

const testAccount = privateKeyToAccount(generatePrivateKey());

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

describe('getReputation()', () => {
  it('AC-8: agent-card con computedReputation → lo retorna', async () => {
    const rep = {
      score: 87,
      tasks_settled: 12,
      success_rate: 0.92,
      total_volume_usdc: 3.5,
      source: 'off-chain' as const,
    };
    const fetchImpl = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/agents/cheap/agent-card')
        return res(200, { name: 'Cheap', computedReputation: rep });
      return res(404, {});
    }) as unknown as typeof fetch;

    const agent = new WasiAgent(testAccount, baseConfig({ fetchImpl }));
    const out = await agent.getReputation({ agentSlug: 'cheap' });
    expect(out).toEqual(rep);
  });

  it('AC-8: agent-card sin el campo → null', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/agents/cheap/agent-card')
        return res(200, { name: 'Cheap' });
      return res(404, {});
    }) as unknown as typeof fetch;

    const agent = new WasiAgent(testAccount, baseConfig({ fetchImpl }));
    const out = await agent.getReputation({ agentSlug: 'cheap' });
    expect(out).toBeNull();
  });
});
