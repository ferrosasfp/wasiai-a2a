/**
 * Unit tests para signAndSettleDownstream (WKH-55).
 * Mocks: viem (signTypedData + readContract), fetch global, viem/accounts.
 * NO E2E contra Fuji RPC (CD-7).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseUnits } from 'viem';
import type { Agent } from '../types/index.js';

// IMPORTANTE: el flag se lee al module load, asi que tenemos que setearlo
// ANTES de importar el modulo bajo test. Para tests con flag off vs on,
// usamos vi.resetModules() y re-import dinamico.

// ─── Helpers de mocking ─────────────────────────────────────────────

const FUJI_USDC = '0x5425890298aed601595a70AB815c96711a31Bc65';
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

// Mock viem — solo lo usado (DT-K)
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

// Helper para reset/import el modulo con env especifico
async function importWithFlag(flagOn: boolean) {
  process.env.WASIAI_DOWNSTREAM_X402 = flagOn ? 'true' : '';
  process.env.OPERATOR_PRIVATE_KEY = `0x${'a'.repeat(64)}`;
  process.env.FUJI_RPC_URL = 'https://api.avax-test.network/ext/bc/C/rpc';
  process.env.FUJI_USDC_ADDRESS = FUJI_USDC;
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
  delete process.env.OPERATOR_PRIVATE_KEY;
  delete process.env.FUJI_RPC_URL;
  delete process.env.FUJI_USDC_ADDRESS;
});

// ─── T-W2-01: flag off → returns null sin tocar nada (CD-NEW-SDD-7, AC-1) ──
describe('signAndSettleDownstream — flag off', () => {
  it('returns null without calling viem or fetch when flag is unset', async () => {
    // Arrange
    const { signAndSettleDownstream } = await importWithFlag(false);
    const agent = makeAgent();
    const logger = makeLogger();
    const fetchSpy = vi.mocked(globalThis.fetch);

    // Act
    const result = await signAndSettleDownstream(agent, logger);

    // Assert
    expect(result).toBeNull();
    expect(mockSignTypedData).not.toHaveBeenCalled();
    expect(mockReadContract).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─── T-W2-02..14: flag on, varios escenarios ────────────────────────
describe('signAndSettleDownstream — flag on', () => {
  // T-W2-02: agent.payment undefined → null + log info (AC-5 caso ausente)
  it('returns null when agent.payment is undefined', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const agent = makeAgent({ payment: undefined });
    const logger = makeLogger();
    const result = await signAndSettleDownstream(agent, logger);
    expect(result).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'NO_PAYMENT_FIELD' }),
      expect.any(String),
    );
  });

  // T-W2-03: method !== 'x402' → null (AC-5)
  it('returns null when method is not x402', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const agent = makeAgent({
      payment: {
        method: 'blockchain-direct',
        chain: 'avalanche',
        contract: PAYTO_ADDR,
      },
    });
    const result = await signAndSettleDownstream(agent, makeLogger());
    expect(result).toBeNull();
    expect(mockSignTypedData).not.toHaveBeenCalled();
  });

  // T-W2-04: chain !== 'avalanche' → null (AC-6)
  it('returns null when chain is not avalanche', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const agent = makeAgent({
      payment: { method: 'x402', chain: 'polygon', contract: PAYTO_ADDR },
    });
    const result = await signAndSettleDownstream(agent, makeLogger());
    expect(result).toBeNull();
    expect(mockSignTypedData).not.toHaveBeenCalled();
  });

  // T-W2-05: payTo formato invalido → null (R-1)
  it('returns null when contract has invalid format', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const agent = makeAgent({
      payment: {
        method: 'x402',
        chain: 'avalanche',
        contract: '0xZZZ' as `0x${string}`,
      },
    });
    const logger = makeLogger();
    const result = await signAndSettleDownstream(agent, logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INVALID_PAY_TO_FORMAT' }),
      expect.any(String),
    );
  });

  // T-W2-06: payTo zero-address → null
  it('returns null when contract is zero-address', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    const agent = makeAgent({
      payment: {
        method: 'x402',
        chain: 'avalanche',
        contract: '0x0000000000000000000000000000000000000000',
      },
    });
    const logger = makeLogger();
    const result = await signAndSettleDownstream(agent, logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ZERO_PAY_TO' }),
      expect.any(String),
    );
  });

  // T-W2-07: balance < value → null (AC-10)
  it('returns null when operator balance < required value', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockReadContract.mockResolvedValueOnce(0n); // balance 0
    const logger = makeLogger();
    const result = await signAndSettleDownstream(makeAgent(), logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INSUFFICIENT_BALANCE' }),
      expect.any(String),
    );
    expect(mockSignTypedData).not.toHaveBeenCalled();
  });

  // T-W2-08: balance read RPC throws → null
  it('returns null when balance read RPC fails', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockReadContract.mockRejectedValueOnce(new Error('RPC down'));
    const logger = makeLogger();
    const result = await signAndSettleDownstream(makeAgent(), logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'BALANCE_READ_FAILED' }),
      expect.any(String),
    );
  });

  // T-W2-09: signTypedData throws → null
  it('returns null when signTypedData throws', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockReadContract.mockResolvedValueOnce(parseUnits('100', 6));
    mockSignTypedData.mockRejectedValueOnce(new Error('keystore error'));
    const logger = makeLogger();
    const result = await signAndSettleDownstream(makeAgent(), logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SIGNING_FAILED' }),
      expect.any(String),
    );
  });

  // T-W2-10: facilitator /verify devuelve verified=false → null (AC-4)
  it('returns null when /verify returns verified=false', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockReadContract.mockResolvedValueOnce(parseUnits('100', 6));
    mockSignTypedData.mockResolvedValueOnce('0xSIG');
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ verified: false }), { status: 200 }),
    );
    const logger = makeLogger();
    const result = await signAndSettleDownstream(makeAgent(), logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'VERIFY_FAILED' }),
      expect.any(String),
    );
  });

  // T-W2-11: facilitator /settle 500 → null (AC-4)
  it('returns null when /settle returns 500', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
    mockReadContract.mockResolvedValueOnce(parseUnits('100', 6));
    mockSignTypedData.mockResolvedValueOnce('0xSIG');
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ verified: true }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const logger = makeLogger();
    const result = await signAndSettleDownstream(makeAgent(), logger);
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'SETTLE_FAILED' }),
      expect.any(String),
    );
  });

  // T-W2-12: happy path → returns DownstreamResult (AC-3 unit-level)
  it('returns DownstreamResult when /verify ok and /settle ok', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
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
    const result = await signAndSettleDownstream(makeAgent(), makeLogger());
    expect(result).toEqual({
      txHash: '0xTX',
      blockNumber: 12345,
      settledAmount: '500000',
    });
  });

  // T-W2-13: domain EIP-712 verification (AC-2, CD-8)
  it('signs with correct EIP-712 domain (USDC Fuji) and TransferWithAuthorization', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
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
          name: 'USD Coin',
          version: '2',
          chainId: 43113,
          verifyingContract: FUJI_USDC,
        }),
        primaryType: 'TransferWithAuthorization',
        message: expect.objectContaining({
          to: PAYTO_ADDR, // AC-8: payTo es agent.payment.contract
          value: 500000n, // AC-9: 0.5 USDC * 10^6
          validAfter: 0n,
        }),
      }),
    );
  });

  // T-W2-14: AC-9 — guard de decimales
  it('computes atomic value with 6 decimals (NOT 18 like Kite/PYUSD)', async () => {
    const { signAndSettleDownstream } = await importWithFlag(true);
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
    const agent = makeAgent({ priceUsdc: 0.5 });
    await signAndSettleDownstream(agent, makeLogger());

    // value en el message debe ser 500000n, NO 500000000000000000n (Kite-PYUSD-18)
    const callArg = mockSignTypedData.mock.calls[0][0];
    expect(callArg.message.value).toBe(500000n);
    expect(callArg.message.value).not.toBe(500000000000000000n);
  });
});
