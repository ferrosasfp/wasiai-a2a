/**
 * RPC transport builder with automatic fallback (OP-04, audit 2026-06-30).
 *
 * Previously every viem client used a SINGLE RPC endpoint (`http(SINGLE_RPC)`).
 * A single provider outage / rate-limit therefore took down the whole money-path
 * for that chain (settle, deposit verification, gas estimation). viem's
 * `fallback([...])` transport transparently rotates to the next transport on a
 * failed request, so a secondary RPC keeps the chain available.
 *
 * Resolution per chain:
 *   1. primary   — the existing env-configured URL (unchanged behaviour).
 *   2. secondary — optional `<CHAIN>_RPC_URL_FALLBACK` env.
 *   3. public    — a sane built-in public endpoint for that chain.
 *
 * `fallback()` is built from the de-duplicated, non-empty list in that order.
 * When ONLY the primary is set, the public default is still appended so a single
 * env config gains redundancy for free WITHOUT changing the primary's behaviour
 * (the primary is always tried first). When the primary is unset, the fallback /
 * public still allow the client to function (it never silently breaks).
 */
import { fallback, http, type Transport } from 'viem';

/**
 * Built-in public RPC endpoints per chainId. Last-resort fallback so a chain is
 * never left with zero transports. These are well-known public endpoints; an
 * operator should still set a dedicated primary (+ optional fallback) env for
 * production throughput.
 */
const PUBLIC_RPC_BY_CHAIN_ID: Readonly<Record<number, string>> = {
  // Avalanche
  43114: 'https://api.avax.network/ext/bc/C/rpc',
  43113: 'https://api.avax-test.network/ext/bc/C/rpc',
  // Base
  8453: 'https://mainnet.base.org',
  84532: 'https://sepolia.base.org',
  // Kite (gokite public RPCs)
  2366: 'https://rpc.gokite.ai/',
  2368: 'https://rpc-testnet.gokite.ai/',
};

export interface BuildRpcTransportArgs {
  /** The existing env-configured primary URL (may be undefined). */
  primary: string | undefined;
  /** Name of the optional `<CHAIN>_RPC_URL_FALLBACK` env var. */
  fallbackEnv: string;
  /** chainId used to look up the built-in public fallback. */
  chainId: number;
}

/**
 * Builds a viem `fallback([...])` transport: `[primary?, secondary?, public?]`,
 * de-duplicated, non-empty, in priority order. Always returns a usable transport
 * (worst case: just the public endpoint). When the resulting list has a single
 * URL it is still wrapped in `fallback([...])`, which behaves identically to a
 * bare `http()` for that single endpoint.
 */
export function buildRpcTransport(args: BuildRpcTransportArgs): Transport {
  const { primary, fallbackEnv, chainId } = args;
  const secondary = process.env[fallbackEnv]?.trim() || undefined;
  const publicUrl = PUBLIC_RPC_BY_CHAIN_ID[chainId];

  const urls: string[] = [];
  for (const url of [primary, secondary, publicUrl]) {
    if (url && url.trim().length > 0 && !urls.includes(url)) {
      urls.push(url);
    }
  }

  // Defensive: if somehow no URL is available, fall back to viem's default
  // transport (http() with no URL → uses the chain's built-in rpcUrls). Keeps
  // the previous "http(undefined)" behaviour for that edge case.
  if (urls.length === 0) return http();

  return fallback(urls.map((u) => http(u)));
}
