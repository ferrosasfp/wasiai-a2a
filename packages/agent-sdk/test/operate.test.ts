import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import { WasiAgent } from '../src/agent.js';
import { InsufficientBudgetError } from '../src/errors.js';

const testAccount = privateKeyToAccount(generatePrivateKey());

interface JsonResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
function res(status: number, body: unknown): JsonResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function discoverBody() {
  return {
    agents: [
      {
        id: 'a1',
        name: 'Cheap',
        slug: 'cheap',
        priceUsdc: 0.5,
        registry: 'Reg One',
        registry_id: 'reg-1',
        verified: false,
      },
      {
        id: 'a2',
        name: 'Pricey',
        slug: 'pricey',
        priceUsdc: 5,
        registry: 'Reg Two',
        registry_id: 'reg-2',
        verified: true,
      },
    ],
    total: 2,
    registries: ['reg-1', 'reg-2'],
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

describe('operate()', () => {
  it('AC-6: primer agente dentro de budget → compose con steps[{agent,registry,input:{}}] → payload', async () => {
    let composeBody: unknown;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === '/discover') return res(200, discoverBody());
      if (path === '/compose') {
        composeBody = JSON.parse(String(init?.body));
        return res(200, { kiteTxHash: '0xkite', output: 'done' });
      }
      return res(404, {});
    }) as unknown as typeof fetch;

    const agent = new WasiAgent(
      testAccount,
      baseConfig({ fetchImpl, maxAgentBudgetUsd: 1 }),
    );
    const op = await agent.operate({ goal: 'summarize' });

    expect(op.operated).toBe(true);
    expect(op.agentSlug).toBe('cheap');
    expect(op.kiteTxHash).toBe('0xkite');
    expect(composeBody).toEqual({
      steps: [{ agent: 'cheap', registry: 'reg-1', input: {} }],
    });
  });

  it('AC-6: sin candidato en budget → {operated:false, NO_AGENT_IN_BUDGET}', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/discover') return res(200, discoverBody());
      return res(404, {});
    }) as unknown as typeof fetch;

    const agent = new WasiAgent(
      testAccount,
      baseConfig({ fetchImpl, maxAgentBudgetUsd: 0.1 }),
    );
    const op = await agent.operate({ goal: 'summarize' });
    expect(op).toEqual({ operated: false, reason: 'NO_AGENT_IN_BUDGET' });
  });

  it('AC-7: compose 403 INSUFFICIENT_BUDGET → InsufficientBudgetError sin retry', async () => {
    let composeCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/discover') return res(200, discoverBody());
      if (path === '/compose') {
        composeCalls++;
        return res(403, {
          error_code: 'INSUFFICIENT_BUDGET',
          chain_id: 84532,
        });
      }
      return res(404, {});
    }) as unknown as typeof fetch;

    const agent = new WasiAgent(testAccount, baseConfig({ fetchImpl }));
    await expect(agent.operate({ goal: 'g' })).rejects.toBeInstanceOf(
      InsufficientBudgetError,
    );
    expect(composeCalls).toBe(1); // sin retry
  });

  it('AC-7/OBS-1: compose 402 → InsufficientBudgetError', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/discover') return res(200, discoverBody());
      if (path === '/compose') return res(402, { error: 'payment required' });
      return res(404, {});
    }) as unknown as typeof fetch;

    const agent = new WasiAgent(testAccount, baseConfig({ fetchImpl }));
    await expect(agent.operate({ goal: 'g' })).rejects.toBeInstanceOf(
      InsufficientBudgetError,
    );
  });
});
