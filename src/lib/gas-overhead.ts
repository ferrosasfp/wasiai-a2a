/**
 * Step gas-overhead pass-through (audit 2026-06-25; live calc 2026-06-24).
 *
 * The gateway settles each pipeline step on-chain DOWNSTREAM from its operator
 * wallet (`signAndSettleDownstream`) and pays the gas of that settlement. The
 * agent's price is pure pass-through (caller pays it, agent receives it), but
 * the settlement gas was NOT covered — for cheap agents / multi-step pipelines
 * the only revenue (1% protocol fee) is smaller than the gas → the gateway
 * loses money ON MAINNET. This module computes a per-step gas overhead that the
 * caller pays ON TOP of the agent price, so the gateway recovers its own
 * settlement gas. The overhead is gateway margin: it is NOT settled to the
 * agent (the downstream settle keeps paying exactly `agent.priceUsdc`).
 *
 * Value resolution (mirrors wasiai-v2 `overhead.ts`):
 *  1. Gate: MAINNET chain IDs only. Testnet / unknown → 0 immediately (no RPC,
 *     no cache) so testnet behaviour is byte-for-byte identical to before.
 *  2. OPERATOR override: if `STEP_GAS_OVERHEAD_USD_<chainId>` or the flat
 *     `STEP_GAS_OVERHEAD_USD` is set & valid → pin that value (manual control,
 *     no live calc), clamped to [0, MAX].
 *  3. LIVE calc: `gas = gasPrice(wei) × GAS_UNITS / 1e18 × nativeTokenUsd`,
 *     rounded to 6 decimals, clamped to [0, MAX]. Sources for nativeTokenUsd:
 *     CoinGecko free API → env fallback (`<SYM>_USD_FALLBACK`). Chainlink is
 *     intentionally OMITTED here (no Chainlink reader in the gateway; CoinGecko
 *     is enough for a per-step margin and keeps this module self-contained).
 *  4. In-memory cache per chain (TTL ~60s) so we don't RPC+fetch on every step.
 *  5. Timeout (~2s) + fail-open: any error / timeout in the live calc degrades
 *     to the static env value → 0. The function NEVER throws — billing must not
 *     break on a network blip.
 *
 * Env:
 *  - `STEP_GAS_OVERHEAD_USD` / `STEP_GAS_OVERHEAD_USD_<CHAINID>` — operator pin /
 *    live-calc fallback.
 *  - RPC URLs per chain reuse each adapter's env (see `resolveRpcUrl`).
 *  - `<SYM>_USD_FALLBACK` (e.g. `AVAX_USD_FALLBACK`) — last-resort native price.
 */
import type { Chain, PublicClient } from 'viem';
import { createPublicClient, http } from 'viem';
import { getAvalancheChain } from '../adapters/avalanche/chain.js';
import { getBaseChain } from '../adapters/base/chain.js';
import { getKiteChain } from '../adapters/kite-ozone/chain.js';

/**
 * Canonical mainnet chain IDs the gateway settles on. Mirrors the mainnet
 * aliases in `chain-resolver.ts` (43114 avalanche-mainnet, 8453 base-mainnet,
 * 2366 kite-mainnet). Testnet IDs (43113 fuji, 84532 base-sepolia, 2368
 * kite-ozone) are intentionally absent → they resolve to 0 overhead.
 */
const MAINNET_CHAIN_IDS: ReadonlySet<number> = new Set([43114, 8453, 2366]);

/**
 * Sanity clamp for the per-step overhead. A per-step settlement gas cost above
 * $1.00 would be pathological; values outside [0, MAX] (or non-finite) are
 * treated as misconfiguration and coerced to 0 (fail-safe: never overcharge).
 */
const MAX_OVERHEAD_USD = 1.0;

/** Gas units assumed per downstream settle (mirrors wasiai-v2 GAS_UNITS). */
const GAS_UNITS = 80_000n;

/** Live-calc timeout — fail-open to env/0 if the RPC+price round-trip stalls. */
const LIVE_CALC_TIMEOUT_MS = 2_000;

/** In-memory cache TTL per chain (ms). Avoids one RPC+fetch per pipeline step. */
const CACHE_TTL_MS = 60_000;

/**
 * Per-chain live-calc config. `coingeckoId` drives the CoinGecko price lookup
 * and the `<SYM>_USD_FALLBACK` env name. Kite (2366) has no reliable CoinGecko
 * listing for its native token → `coingeckoId: undefined` → live calc cannot
 * price it → falls back to the static env (or 0).
 */
interface ChainGasConfig {
  coingeckoId: string | undefined;
  fallbackEnv: string | undefined; // `<SYM>_USD_FALLBACK`
  gasUnits: bigint;
}

const CHAIN_GAS_CONFIG: Readonly<Record<number, ChainGasConfig>> = {
  43114: {
    coingeckoId: 'avalanche-2',
    fallbackEnv: 'AVAX_USD_FALLBACK',
    gasUnits: GAS_UNITS,
  },
  8453: {
    coingeckoId: 'ethereum',
    fallbackEnv: 'ETH_USD_FALLBACK',
    gasUnits: GAS_UNITS,
  },
  2366: {
    // Kite native token has no reliable CoinGecko id → no live price → env/0.
    coingeckoId: undefined,
    fallbackEnv: undefined,
    gasUnits: GAS_UNITS,
  },
};

// ── Env override parsing (operator pin / static fallback) ────────

/**
 * Parses a raw env value into a safe, clamped USD overhead. Returns `undefined`
 * when the var is absent or invalid so the caller can fall back.
 */
function parseOverheadEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > MAX_OVERHEAD_USD) return MAX_OVERHEAD_USD;
  return n;
}

/**
 * Resolves the static env overhead for a chain: per-chain override wins over
 * the flat default. Returns `undefined` if neither is set/valid.
 */
function resolveStaticEnvOverhead(chainId: number): number | undefined {
  const perChain = parseOverheadEnv(
    process.env[`STEP_GAS_OVERHEAD_USD_${chainId}`],
  );
  if (perChain !== undefined) return perChain;
  return parseOverheadEnv(process.env.STEP_GAS_OVERHEAD_USD);
}

function clampOverhead(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > MAX_OVERHEAD_USD) return MAX_OVERHEAD_USD;
  return n;
}

// ── RPC + chain object resolution (reuse adapter env / helpers) ──

/**
 * RPC URL per mainnet chainId, from the SAME env vars used by each adapter
 * (`deposit-verifier.resolveRpcUrl`). Returns `undefined` if not set.
 */
function resolveMainnetRpcUrl(chainId: number): string | undefined {
  switch (chainId) {
    case 43114:
      return process.env.AVALANCHE_RPC_URL;
    case 8453:
      return process.env.BASE_MAINNET_RPC_URL;
    case 2366:
      return process.env.KITE_MAINNET_RPC_URL ?? process.env.KITE_RPC_URL;
    default:
      return undefined;
  }
}

/** viem `chain` object per mainnet chainId (reuses adapter chain helpers). */
function resolveMainnetChainObject(chainId: number): Chain | undefined {
  switch (chainId) {
    case 43114:
      return getAvalancheChain('mainnet');
    case 8453:
      return getBaseChain('mainnet');
    case 2366:
      return getKiteChain();
    default:
      return undefined;
  }
}

// ── Lazy publicClient cache per chainId ─────────────────────────

const _clients = new Map<number, PublicClient>();

function getPublicClient(chainId: number): PublicClient | null {
  const cached = _clients.get(chainId);
  if (cached) return cached;
  const rpcUrl = resolveMainnetRpcUrl(chainId);
  const chain = resolveMainnetChainObject(chainId);
  if (!rpcUrl || !chain) return null;
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl),
  }) as PublicClient;
  _clients.set(chainId, client);
  return client;
}

// ── In-memory overhead cache per chainId (TTL) ──────────────────

interface CacheEntry {
  value: number;
  expiresAt: number;
}
const _cache = new Map<number, CacheEntry>();

/** TEST-ONLY — clears the overhead cache and the publicClient cache. */
export function _resetGasOverheadCache(): void {
  _cache.clear();
  _clients.clear();
}

// ── Native token price (CoinGecko → env fallback) ───────────────

/**
 * Native token USD price for a chain. CoinGecko free API first, then the
 * configured `<SYM>_USD_FALLBACK` env. Returns `undefined` if no price can be
 * obtained (no coingeckoId / fetch fails / no fallback).
 */
async function getNativeTokenUsd(
  config: ChainGasConfig,
): Promise<number | undefined> {
  if (config.coingeckoId !== undefined) {
    try {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${config.coingeckoId}&vs_currencies=usd`,
      );
      if (res.ok) {
        const data = (await res.json()) as Record<string, { usd?: number }>;
        const price = data[config.coingeckoId]?.usd;
        if (typeof price === 'number' && price > 0) return price;
      }
    } catch {
      /* fall through to env fallback */
    }
  }

  if (config.fallbackEnv !== undefined) {
    const fallback = Number(process.env[config.fallbackEnv] ?? '');
    if (Number.isFinite(fallback) && fallback > 0) return fallback;
  }

  return undefined;
}

/**
 * Live gas overhead for a mainnet chain: `gasPrice × gasUnits / 1e18 ×
 * nativeTokenUsd`, rounded to 6 decimals and clamped. Throws if the chain
 * cannot be priced (no client / no price) — the caller fails open to env/0.
 */
async function calcLiveOverhead(chainId: number): Promise<number> {
  const config = CHAIN_GAS_CONFIG[chainId];
  if (!config) throw new Error(`no gas config for chain ${chainId}`);

  const client = getPublicClient(chainId);
  if (!client) throw new Error(`no public client for chain ${chainId}`);

  const [gasPrice, tokenUsd] = await Promise.all([
    client.getGasPrice(),
    getNativeTokenUsd(config),
  ]);

  if (tokenUsd === undefined) {
    throw new Error(`no native token price for chain ${chainId}`);
  }

  const gasCostNative = Number(gasPrice * config.gasUnits) / 1e18;
  const gas = Math.round(gasCostNative * tokenUsd * 1_000_000) / 1_000_000;
  return clampOverhead(gas);
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Per-step gas overhead (USD) charged to the caller on top of the agent price,
 * to cover the gateway's downstream settlement gas.
 *
 * @param chainId numeric chain id of the settlement chain (the same one used to
 *   debit the caller per step).
 * @returns the overhead in USD; ALWAYS 0 on testnet / unknown chain. On mainnet:
 *   operator env pin if set, else a live gas estimate (cached ~60s), else the
 *   static env fallback, else 0. NEVER throws (fail-open to env/0).
 */
export async function getStepGasOverheadUsd(chainId: number): Promise<number> {
  // Gate: only mainnet chains incur the overhead. Everything else → 0.
  if (!MAINNET_CHAIN_IDS.has(chainId)) return 0;

  // Operator override wins over live calc (manual pin / kill-switch).
  const staticEnv = resolveStaticEnvOverhead(chainId);
  if (staticEnv !== undefined) return staticEnv;

  // Cache hit (live value, fresh).
  const now = Date.now();
  const cached = _cache.get(chainId);
  if (cached && cached.expiresAt > now) return cached.value;

  // Live calc with timeout + fail-open. Any failure → 0 (no static env here:
  // resolveStaticEnvOverhead already returned above if one was configured).
  try {
    const value = await Promise.race([
      calcLiveOverhead(chainId),
      new Promise<number>((_, reject) =>
        setTimeout(
          () => reject(new Error('gas overhead timeout')),
          LIVE_CALC_TIMEOUT_MS,
        ),
      ),
    ]);
    _cache.set(chainId, { value, expiresAt: now + CACHE_TTL_MS });
    return value;
  } catch {
    // Fail-open: a transient RPC/price error must never break billing. 0 is the
    // safe value (caller pays only the agent price, as before live calc).
    return 0;
  }
}
