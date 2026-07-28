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
  assertGasOverheadConfigured,
  GasOverheadUnavailableError,
  getStepGasOverheadUsd,
  LIVE_CALC_TIMEOUT_MS,
  PRICE_HOP_TIMEOUT_MS,
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

  // HU-195: el `Promise.race` de getCachedOverhead hace que el CALLER se rinda a
  // los 2 s, pero NO abortaba este fetch — el socket sobrevivía a su propio
  // timeout (hasta 300 s de INACTIVIDAD de undici, y sin cota ninguna contra un
  // peer que trickle-feedea). El hop tiene que traer su propio presupuesto.
  it('T-195-GAS-1: el hop de CoinGecko sale con un AbortSignal de wall-clock', async () => {
    process.env.AVALANCHE_RPC_URL = 'https://rpc.example/avax';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ 'avalanche-2': { usd: 30 } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await getStepGasOverheadUsd(AVAX_MAINNET);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1] as { signal?: unknown };
    expect(init).toBeDefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.signal as AbortSignal).aborted).toBe(false);
  });

  // ── HU-195 fix-pack (AR BLQ-BAJO-1 / BLQ-BAJO-2) ──────────────────────────
  //
  // T-195-GAS-1 (arriba) sólo mira que el `signal` EXISTA, así que el mutante
  // `AbortSignal.timeout(300_000)` — que reintroduce EXACTAMENTE el bug que la HU
  // dice arreglar — sobrevivía (29 passed, 0 rojos). Y el VALOR del techo no es
  // cosmético: si el hop se aborta dentro del presupuesto de la race, el fallback
  // de env se vuelve alcanzable y el guard fail-closed G-02 pasa a fail-open.
  //
  // Estos tres tests candadean las DOS puntas del presupuesto:
  //   · demasiado CORTO (≤ race) → GAS-2/GAS-3 rojos (valor 0.06 / no throw).
  //   · demasiado LARGO (300_000, o sin `signal`) → GAS-2 rojo (no aborta).
  //
  // `AbortSignal.timeout` no expone sus ms, así que se testea el EFECTO: un fetch
  // que cuelga hasta que lo aborten, midiendo (a) el valor devuelto y (b) cuándo
  // muere el socket. Los timers de `AbortSignal.timeout` NO los controla
  // `vi.useFakeTimers` (viven en los timers internos de Node), así que el reloj es
  // real: ~2.5 s por test.
  const HANG_UNTIL_ABORTED = () => {
    let signal: AbortSignal | undefined;
    let calledAt = 0;
    const fetchMock = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) => {
        signal = init?.signal;
        calledAt = Date.now();
        return new Promise<never>((_resolve, reject) => {
          // Mismo contrato que undici: el abort RECHAZA el fetch.
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason as Error);
          });
        });
      },
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    return {
      get signal() {
        return signal;
      },
      get calledAt() {
        return calledAt;
      },
    };
  };

  /** Espera el abort del signal con cota. Devuelve ms desde `calledAt`, o null. */
  async function waitForAbort(
    signal: AbortSignal,
    calledAt: number,
    budgetMs: number,
  ): Promise<number | null> {
    if (signal.aborted) return Date.now() - calledAt;
    const aborted = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), budgetMs);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    return aborted ? Date.now() - calledAt : null;
  }

  it('T-195-GAS-2: CoinGecko colgado ⇒ MISMO valor que antes del techo (fail-open 0 fuera de prod), Y el socket muere', async () => {
    process.env.AVALANCHE_RPC_URL = 'https://rpc.example/avax';
    // Con el fallback de env PRESENTE es donde se ve el cambio de semántica: si
    // el hop abortara dentro del presupuesto de la race, `getNativeTokenUsd`
    // caería acá y devolvería 0.06 en vez del 0/undefined histórico.
    process.env.AVAX_USD_FALLBACK = '30';
    const probe = HANG_UNTIL_ABORTED();

    const startedAt = Date.now();
    const result = await getStepGasOverheadUsd(AVAX_MAINNET);
    const elapsed = Date.now() - startedAt;

    // (a) SEMÁNTICA PRESERVADA: la race se rinde ⇒ irresoluble ⇒ 0 fuera de prod.
    // Medición pre-HU-195 (sin `signal`): result=0 elapsedMs=2004.
    // Con el techo mal puesto (= LIVE_CALC_TIMEOUT_MS): result=0.06 elapsedMs=2003.
    expect(result).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(LIVE_CALC_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(LIVE_CALC_TIMEOUT_MS * 2);

    // (b) EL SOCKET SE ABORTA — y DESPUÉS de que la race se rindió, no antes.
    const signal = probe.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    const abortedAfterMs = await waitForAbort(
      signal as AbortSignal,
      probe.calledAt,
      PRICE_HOP_TIMEOUT_MS * 3,
    );
    expect(abortedAfterMs).not.toBeNull();
    expect(abortedAfterMs as number).toBeGreaterThanOrEqual(
      LIVE_CALC_TIMEOUT_MS,
    );
    expect(abortedAfterMs as number).toBeLessThan(PRICE_HOP_TIMEOUT_MS * 2);
  }, 20_000);

  it('T-195-GAS-3: CoinGecko colgado EN PRODUCCIÓN ⇒ sigue lanzando GasOverheadUnavailableError (fail-closed G-02 intacto)', async () => {
    process.env.AVALANCHE_RPC_URL = 'https://rpc.example/avax';
    process.env.AVAX_USD_FALLBACK = '30';
    const savedNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    HANG_UNTIL_ABORTED();
    try {
      await expect(getStepGasOverheadUsd(AVAX_MAINNET)).rejects.toThrow(
        GasOverheadUnavailableError,
      );
    } finally {
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNodeEnv;
    }
  }, 20_000);

  it('T-195-GAS-4: INVARIANTE — el techo del hop es ESTRICTAMENTE mayor que el presupuesto de la race', () => {
    expect(PRICE_HOP_TIMEOUT_MS).toBeGreaterThan(LIVE_CALC_TIMEOUT_MS);
    // Y sigue MUY por debajo del default de undici que motivó la HU.
    expect(PRICE_HOP_TIMEOUT_MS).toBeLessThan(300_000);
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

// ── G-02 fail-closed in production / G-01 boot assertion ────────────────────

describe('G-02 fail-closed (production) + G-01 boot assertion', () => {
  const SAVE_KEYS = [
    'NODE_ENV',
    'STEP_GAS_OVERHEAD_USD',
    `STEP_GAS_OVERHEAD_USD_${AVAX_MAINNET}`,
    `STEP_GAS_OVERHEAD_USD_${BASE_MAINNET}`,
    `STEP_GAS_OVERHEAD_USD_${KITE_MAINNET}`,
    'AVALANCHE_RPC_URL',
    'AVAX_USD_FALLBACK',
  ];
  const saved: Record<string, string | undefined> = {};
  const realFetch = global.fetch;

  beforeEach(() => {
    for (const k of SAVE_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    vi.clearAllMocks();
    _resetGasOverheadCache();
    mockGetGasPrice.mockResolvedValue(BigInt(25_000_000_000));
  });
  afterEach(() => {
    for (const k of SAVE_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    global.fetch = realFetch;
  });

  it('mainnet + production + unresolvable → THROWS GasOverheadUnavailableError (fail-closed)', async () => {
    process.env.NODE_ENV = 'production';
    // No env pin, no RPC → live calc cannot run → fail-closed in prod.
    await expect(getStepGasOverheadUsd(AVAX_MAINNET)).rejects.toBeInstanceOf(
      GasOverheadUnavailableError,
    );
  });

  it('mainnet + production + env pin set → returns the pin (no throw)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.STEP_GAS_OVERHEAD_USD = '0.03';
    expect(await getStepGasOverheadUsd(AVAX_MAINNET)).toBe(0.03);
  });

  it('testnet + production + unresolvable → 0 (never throws on testnet)', async () => {
    process.env.NODE_ENV = 'production';
    expect(await getStepGasOverheadUsd(FUJI)).toBe(0);
  });

  it('mainnet + NON-production + unresolvable → fail-open 0 (legacy)', async () => {
    delete process.env.NODE_ENV;
    expect(await getStepGasOverheadUsd(AVAX_MAINNET)).toBe(0);
  });

  it('assertGasOverheadConfigured: production + missing mainnet pin → throws listing the chain', () => {
    process.env.NODE_ENV = 'production';
    expect(() =>
      assertGasOverheadConfigured([AVAX_MAINNET, KITE_MAINNET]),
    ).toThrow(/2366/);
  });

  it('assertGasOverheadConfigured: production + flat pin covers all mainnet chains → no throw', () => {
    process.env.NODE_ENV = 'production';
    process.env.STEP_GAS_OVERHEAD_USD = '0.02';
    expect(() =>
      assertGasOverheadConfigured([AVAX_MAINNET, BASE_MAINNET, KITE_MAINNET]),
    ).not.toThrow();
  });

  it('assertGasOverheadConfigured: per-chain pins cover each mainnet chain → no throw', () => {
    process.env.NODE_ENV = 'production';
    process.env[`STEP_GAS_OVERHEAD_USD_${AVAX_MAINNET}`] = '0.02';
    process.env[`STEP_GAS_OVERHEAD_USD_${KITE_MAINNET}`] = '0.07';
    expect(() =>
      assertGasOverheadConfigured([AVAX_MAINNET, KITE_MAINNET]),
    ).not.toThrow();
  });

  it('assertGasOverheadConfigured: testnet-only chains → no throw even unset', () => {
    process.env.NODE_ENV = 'production';
    expect(() =>
      assertGasOverheadConfigured([FUJI, BASE_SEPOLIA, KITE_TESTNET]),
    ).not.toThrow();
  });

  it('assertGasOverheadConfigured: NON-production → no-op (never throws)', () => {
    delete process.env.NODE_ENV;
    expect(() =>
      assertGasOverheadConfigured([AVAX_MAINNET, KITE_MAINNET]),
    ).not.toThrow();
  });
});
