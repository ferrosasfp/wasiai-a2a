/**
 * Mainnet support tests for signAndSettleDownstream (068).
 *
 * Verifica que `WASIAI_DOWNSTREAM_NETWORK=avalanche-mainnet` cambia chainId,
 * USDC contract, network tag a `eip155:43114`, y que el default `fuji`
 * (sin env-var) preserva el comportamiento histórico WKH-55.
 */

import { parseUnits } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types/index.js';

const FUJI_USDC = '0x5425890298aed601595a70AB815c96711a31Bc65';
const AVALANCHE_USDC = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';
const OPERATOR_ADDR = '0xf432baf09e7ba99ab44ff1d68c83f1234567Ba00' as const;
const PAYTO_ADDR = '0x000000000000000000000000000000000000aBcD' as const;

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'a1',
    slug: 'agent-1',
    name: 'Agent 1',
    description: '',
    capabilities: ['x'],
    priceUsdc: 0.5,
    registry: 'wasiai-v2',
    invokeUrl: 'https://wasiai-v2.example/api/agents/agent-1/invoke',
    invocationNote: '',
    verified: true,
    status: 'active',
    payment: {
      method: 'x402',
      asset: 'USDC',
      chain: 'avalanche',
      contract: PAYTO_ADDR,
    },
    ...overrides,
  };
}

function makeLogger() {
  return { warn: vi.fn(), info: vi.fn() };
}

const mockSignTypedData = vi.fn();
const mockReadContract = vi.fn();

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({ readContract: mockReadContract })),
    createWalletClient: vi.fn(() => ({ signTypedData: mockSignTypedData })),
  };
});

vi.mock('viem/accounts', () => ({
  privateKeyToAccount: vi.fn(() => ({
    address: OPERATOR_ADDR,
    signTypedData: mockSignTypedData,
  })),
}));

async function importWithEnv(env: {
  network?: 'fuji' | 'avalanche-mainnet';
  fujiUsdc?: string;
  avalancheUsdc?: string;
}) {
  process.env.WASIAI_DOWNSTREAM_X402 = 'true';
  process.env.OPERATOR_PRIVATE_KEY = `0x${'a'.repeat(64)}`;
  process.env.FUJI_RPC_URL = 'https://api.avax-test.network/ext/bc/C/rpc';
  process.env.AVALANCHE_RPC_URL = 'https://api.avax.network/ext/bc/C/rpc';
  if (env.network) {
    process.env.WASIAI_DOWNSTREAM_NETWORK = env.network;
  } else {
    delete process.env.WASIAI_DOWNSTREAM_NETWORK;
  }
  if (env.fujiUsdc) process.env.FUJI_USDC_ADDRESS = env.fujiUsdc;
  else delete process.env.FUJI_USDC_ADDRESS;
  if (env.avalancheUsdc) process.env.AVALANCHE_USDC_ADDRESS = env.avalancheUsdc;
  else delete process.env.AVALANCHE_USDC_ADDRESS;
  vi.resetModules();
  return await import('./downstream-payment.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WASIAI_DOWNSTREAM_X402;
  delete process.env.WASIAI_DOWNSTREAM_NETWORK;
  delete process.env.OPERATOR_PRIVATE_KEY;
  delete process.env.FUJI_RPC_URL;
  delete process.env.AVALANCHE_RPC_URL;
  delete process.env.FUJI_USDC_ADDRESS;
  delete process.env.AVALANCHE_USDC_ADDRESS;
});

describe('signAndSettleDownstream — WASIAI_DOWNSTREAM_NETWORK=avalanche-mainnet', () => {
  function mockHappyPath() {
    mockReadContract.mockResolvedValueOnce(parseUnits('100', 6));
    mockSignTypedData.mockResolvedValueOnce('0xSIG');
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ verified: true }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            settled: true,
            transactionHash: '0xTX',
            blockNumber: 12345,
            amount: '500000',
          }),
          { status: 200 },
        ),
      );
  }

  it('signs with chainId=43114 and USDC mainnet contract', async () => {
    const { signAndSettleDownstream } = await importWithEnv({
      network: 'avalanche-mainnet',
    });
    mockHappyPath();
    await signAndSettleDownstream(makeAgent(), makeLogger());

    expect(mockSignTypedData).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: expect.objectContaining({
          name: 'USD Coin',
          chainId: 43114,
          verifyingContract: AVALANCHE_USDC,
        }),
        primaryType: 'TransferWithAuthorization',
      }),
    );
  });

  it('returns DownstreamResult on happy path (mainnet)', async () => {
    const { signAndSettleDownstream } = await importWithEnv({
      network: 'avalanche-mainnet',
    });
    mockHappyPath();
    const result = await signAndSettleDownstream(makeAgent(), makeLogger());
    expect(result).toEqual({
      txHash: '0xTX',
      blockNumber: 12345,
      settledAmount: '500000',
    });
  });

  it('uses canonical avalanche network tag (eip155:43114) in facilitator body', async () => {
    const { signAndSettleDownstream } = await importWithEnv({
      network: 'avalanche-mainnet',
    });
    mockHappyPath();
    await signAndSettleDownstream(makeAgent(), makeLogger());

    const fetchSpy = vi.mocked(globalThis.fetch);
    // Both /verify and /settle bodies should carry network=eip155:43114
    for (const call of fetchSpy.mock.calls) {
      const init = call[1] as RequestInit;
      const body = JSON.parse(String(init.body)) as {
        accepted: { network: string };
      };
      expect(body.accepted.network).toBe('eip155:43114');
    }
  });

  it('respects AVALANCHE_USDC_ADDRESS override', async () => {
    const customMainnet = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    const { signAndSettleDownstream } = await importWithEnv({
      network: 'avalanche-mainnet',
      avalancheUsdc: customMainnet,
    });
    mockHappyPath();
    await signAndSettleDownstream(makeAgent(), makeLogger());

    expect(mockSignTypedData).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: expect.objectContaining({
          verifyingContract: customMainnet,
        }),
      }),
    );
  });

  it('returns null with CONFIG_MISSING when AVALANCHE_RPC_URL absent', async () => {
    process.env.WASIAI_DOWNSTREAM_X402 = 'true';
    process.env.OPERATOR_PRIVATE_KEY = `0x${'a'.repeat(64)}`;
    process.env.FUJI_RPC_URL = 'https://api.avax-test.network/ext/bc/C/rpc';
    process.env.WASIAI_DOWNSTREAM_NETWORK = 'avalanche-mainnet';
    delete process.env.AVALANCHE_RPC_URL;
    vi.resetModules();
    const { signAndSettleDownstream } = await import('./downstream-payment.js');

    const logger = makeLogger();
    const result = await signAndSettleDownstream(makeAgent(), logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'CONFIG_MISSING' }),
      expect.any(String),
    );
  });
});

describe('signAndSettleDownstream — default (WASIAI_DOWNSTREAM_NETWORK absent)', () => {
  it('signs with chainId=43113 and USDC fuji contract (preserves WKH-55 default)', async () => {
    const { signAndSettleDownstream } = await importWithEnv({
      fujiUsdc: FUJI_USDC,
    });
    mockReadContract.mockResolvedValueOnce(parseUnits('100', 6));
    mockSignTypedData.mockResolvedValueOnce('0xSIG');
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ verified: true }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            settled: true,
            transactionHash: '0xTX',
            blockNumber: 1,
            amount: '500000',
          }),
          { status: 200 },
        ),
      );
    await signAndSettleDownstream(makeAgent(), makeLogger());

    expect(mockSignTypedData).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: expect.objectContaining({
          chainId: 43113,
          verifyingContract: FUJI_USDC,
        }),
      }),
    );
  });
});

describe('signAndSettleDownstream — WASIAI_DOWNSTREAM_NETWORK=fuji (explicit)', () => {
  it('explicit testnet selection equals default behavior', async () => {
    const { signAndSettleDownstream } = await importWithEnv({
      network: 'fuji',
      fujiUsdc: FUJI_USDC,
    });
    mockReadContract.mockResolvedValueOnce(parseUnits('100', 6));
    mockSignTypedData.mockResolvedValueOnce('0xSIG');
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ verified: true }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            settled: true,
            transactionHash: '0xTX',
            blockNumber: 1,
            amount: '500000',
          }),
          { status: 200 },
        ),
      );
    await signAndSettleDownstream(makeAgent(), makeLogger());

    expect(mockSignTypedData).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: expect.objectContaining({
          chainId: 43113,
          verifyingContract: FUJI_USDC,
        }),
      }),
    );
  });
});
