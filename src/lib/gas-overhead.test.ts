/**
 * Tests for the step gas-overhead pass-through (audit 2026-06-25; live calc
 * 2026-06-24). Live calc mocks viem (`getGasPrice`) and `global.fetch`
 * (CoinGecko), mirroring wasiai-v2 `overhead-gas-source.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── vi.hoisted — mock viem's createPublicClient before the import ───────────
const { mockGetGasPrice } = vi.hoisted(() => ({
  mockGetGasPrice: vi.fn(),
}));

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getGasPrice: mockGetGasPrice,
    })),
  };
});

import {
  _resetGasOverheadCache,
  getStepGasOverheadUsd,
} from './gas-overhead.js';

const AVAX_MAINNET = 43114;
const BASE_MAINNET = 8453;
const KITE_MAINNET = 2366;
const FUJI = 43113;
const BASE_SEPOLIA = 84532;
const KITE_TESTNET = 2368;

describe('getStepGasOverheadUsd', () => {
  const ENV_KEYS = [
    'STEP_GAS_OVERHEAD_USD',
    `STEP_GAS_OVERHEAD_USD_${AVAX_MAINNET}`,
    `STEP_GAS_OVERHEAD_USD_${BASE_MAINNET}`,
    `STEP_GAS_OVERHEAD_USD_${KITE_MAINNET}`,
    'AVALANCHE_RPC_URL',
    'BASE_MAINNET_RPC_URL',
    'KITE_MAINNET_RPC_URL',
    'KITE_RPC_URL',
    'AVAX_USD_FALLBACK',
    'ETH_USD_FALLBACK',
  ];
  const saved: Record<string, string | undefined> = {};
  const realFetch = global.fetch;

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    vi.clearAllMocks();
    _resetGasOverheadCache();
    // Default: 25 gwei gas price.
    mockGetGasPrice.mockResolvedValue(BigInt(25_000_000_000));
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    global.fetch = realFetch;
  });

  // ── Testnet / unknown → 0, no RPC, no fetch ───────────────────────────────

  it('testnet chainIds → 0 even with env set (no RPC, no fetch)', async () => {
    process.env.STEP_GAS_OVERHEAD_USD = '0.05';
    global.fetch = vi.fn() as unknown as typeof fetch;
    expect(await getStepGasOverheadUsd(FUJI)).toBe(0);
    expect(await getStepGasOverheadUsd(BASE_SEPOLIA)).toBe(0);
    expect(await getStepGasOverheadUsd(KITE_TESTNET)).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockGetGasPrice).not.toHaveBeenCalled();
  });

  it('unknown chainId → 0', async () => {
    process.env.STEP_GAS_OVERHEAD_USD = '0.05';
    expect(await getStepGasOverheadUsd(1)).toBe(0);
    expect(await getStepGasOverheadUsd(999999)).toBe(0);
  });

  // ── Operator env override (pin, no live calc) ─────────────────────────────

  it('mainnet with flat env override → the value (no live calc)', async () => {
    process.env.STEP_GAS_OVERHEAD_USD = '0.02';
    global.fetch = vi.fn() as unknown as typeof fetch;
    expect(await getStepGasOverheadUsd(AVAX_MAINNET)).toBe(0.02);
    expect(await getStepGasOverheadUsd(BASE_MAINNET)).toBe(0.02);
    expect(await getStepGasOverheadUsd(KITE_MAINNET)).toBe(0.02);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockGetGasPrice).not.toHaveBeenCalled();
  });

  it('per-chain override wins over the flat default', async () => {
    process.env.STEP_GAS_OVERHEAD_USD = '0.02';
    process.env[`STEP_GAS_OVERHEAD_USD_${BASE_MAINNET}`] = '0.10';
    expect(await getStepGasOverheadUsd(BASE_MAINNET)).toBe(0.1);
    expect(await getStepGasOverheadUsd(AVAX_MAINNET)).toBe(0.02);
  });

  it('per-chain override applies even without a flat default', async () => {
    process.env[`STEP_GAS_OVERHEAD_USD_${KITE_MAINNET}`] = '0.07';
    expect(await getStepGasOverheadUsd(KITE_MAINNET)).toBe(0.07);
  });

  it('non-finite / non-numeric env override → 0', async () => {
    process.env.STEP_GAS_OVERHEAD_USD = 'abc';
    expect(await getStepGasOverheadUsd(AVAX_MAINNET)).toBe(0);
    process.env.STEP_GAS_OVERHEAD_USD = 'NaN';
    expect(await getStepGasOverheadUsd(AVAX_MAINNET)).toBe(0);
    process.env.STEP_GAS_OVERHEAD_USD = 'Infinity';
    expect(await getStepGasOverheadUsd(AVAX_MAINNET)).toBe(0);
  });

  it('negative env override → clamped to 0', async () => {
    process.env.STEP_GAS_OVERHEAD_USD = '-0.5';
    expect(await getStepGasOverheadUsd(AVAX_MAINNET)).toBe(0);
  });

  it('above-range env override → clamped to MAX (1.0)', async () => {
    process.env.STEP_GAS_OVERHEAD_USD = '5';
    expect(await getStepGasOverheadUsd(AVAX_MAINNET)).toBe(1.0);
  });

  it('empty / whitespace env override → treated as unset (falls to live calc)', async () => {
    // No RPC configured → live calc fails → fail-open 0.
    process.env.STEP_GAS_OVERHEAD_USD = '';
    expect(await getStepGasOverheadUsd(AVAX_MAINNET)).toBe(0);
    process.env.STEP_GAS_OVERHEAD_USD = '   ';
    expect(await getStepGasOverheadUsd(AVAX_MAINNET)).toBe(0);
  });

  // ── Live calc ─────────────────────────────────────────────────────────────

  it('mainnet without override → live calc (gasPrice × CoinGecko)', async () => {
    process.env.AVALANCHE_RPC_URL = 'https://rpc.example/avax';
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ 'avalanche-2': { usd: 30 } }),
    }) as unknown as typeof fetch;

    // gas = 25e9 * 80000 / 1e18 * 30 = 0.002 * 30 = 0.06
    const result = await getStepGasOverheadUsd(AVAX_MAINNET);
    expect(result).toBeCloseTo(0.06, 6);
    expect(mockGetGasPrice).toHaveBeenCalledTimes(1);
  });

  it('mainnet without override, no RPC configured → fail-open 0', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ 'avalanche-2': { usd: 30 } }),
    }) as unknown as typeof fetch;
    expect(await getStepGasOverheadUsd(AVAX_MAINNET)).toBe(0);
    expect(mockGetGasPrice).not.toHaveBeenCalled();
  });

  it('CoinGecko fails, env fallback present → uses fallback price', async () => {
    process.env.AVALANCHE_RPC_URL = 'https://rpc.example/avax';
    process.env.AVAX_USD_FALLBACK = '30';
    global.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network')) as unknown as typeof fetch;

    // gas = 0.002 * 30 = 0.06
    expect(await getStepGasOverheadUsd(AVAX_MAINNET)).toBeCloseTo(0.06, 6);
  });

  it('CoinGecko fails, no env fallback → fail-open 0', async () => {
    process.env.AVALANCHE_RPC_URL = 'https://rpc.example/avax';
    global.fetch = vi
      .fn()
      .mockRejectedValue(new Error('network')) as unknown as typeof fetch;
    expect(await getStepGasOverheadUsd(AVAX_MAINNET)).toBe(0);
  });

  it('live calc timeout → fail-open 0', async () => {
    process.env.AVALANCHE_RPC_URL = 'https://rpc.example/avax';
    // getGasPrice never resolves → Promise.race timeout fires.
    mockGetGasPrice.mockImplementation(() => new Promise(() => {}));
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ 'avalanche-2': { usd: 30 } }),
    }) as unknown as typeof fetch;

    const result = await getStepGasOverheadUsd(AVAX_MAINNET);
    expect(result).toBe(0);
  });

  it('cache hit: 2nd call does not re-fetch / re-RPC', async () => {
    process.env.AVALANCHE_RPC_URL = 'https://rpc.example/avax';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ 'avalanche-2': { usd: 30 } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const first = await getStepGasOverheadUsd(AVAX_MAINNET);
    const second = await getStepGasOverheadUsd(AVAX_MAINNET);
    expect(first).toBeCloseTo(0.06, 6);
    expect(second).toBe(first);
    expect(mockGetGasPrice).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('live calc clamps a pathological value to MAX (1.0)', async () => {
    process.env.BASE_MAINNET_RPC_URL = 'https://rpc.example/base';
    // Huge gas price → gas way above MAX.
    mockGetGasPrice.mockResolvedValue(BigInt('1000000000000000'));
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ethereum: { usd: 3000 } }),
    }) as unknown as typeof fetch;

    expect(await getStepGasOverheadUsd(BASE_MAINNET)).toBe(1.0);
  });

  it('Base mainnet live calc uses ETH (ethereum) CoinGecko id', async () => {
    process.env.BASE_MAINNET_RPC_URL = 'https://rpc.example/base';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ethereum: { usd: 3000 } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    // gas = 0.002 * 3000 = 6 → clamped to MAX 1.0
    const result = await getStepGasOverheadUsd(BASE_MAINNET);
    expect(result).toBe(1.0);
    const calledUrl = (fetchMock.mock.calls[0]?.[0] ?? '') as string;
    expect(calledUrl).toContain('ids=ethereum');
  });

  it('Kite mainnet (no coingeckoId) without override → fail-open 0', async () => {
    process.env.KITE_MAINNET_RPC_URL = 'https://rpc.example/kite';
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    // No coingeckoId, no fallback env → no native price → fail-open 0.
    expect(await getStepGasOverheadUsd(KITE_MAINNET)).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Kite mainnet with env override → uses the env (no live calc)', async () => {
    process.env[`STEP_GAS_OVERHEAD_USD_${KITE_MAINNET}`] = '0.07';
    expect(await getStepGasOverheadUsd(KITE_MAINNET)).toBe(0.07);
  });
});
