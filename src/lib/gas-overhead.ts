/**
 * Step gas-overhead pass-through (audit 2026-06-25).
 *
 * The gateway settles each pipeline step on-chain DOWNSTREAM from its operator
 * wallet (`signAndSettleDownstream`) and pays the gas of that settlement. The
 * agent's price is pure pass-through (caller pays it, agent receives it), but
 * the settlement gas was NOT covered — for cheap agents / multi-step pipelines
 * the only revenue (1% protocol fee) is smaller than the gas → the gateway
 * loses money ON MAINNET. This module computes a flat per-step gas overhead
 * that the caller pays ON TOP of the agent price, so the gateway recovers its
 * own settlement gas. The overhead is gateway margin: it is NOT settled to the
 * agent (the downstream settle keeps paying exactly `agent.priceUsdc`).
 *
 * Design:
 *  - Gated to MAINNET chain IDs only. On any testnet (or unknown chain) → 0,
 *    so testnet behaviour is byte-for-byte identical to before this module.
 *  - The VALUE is an OPERATOR decision read from env (default 0). A live gas
 *    estimation (cf. wasiai-v2 `overhead.ts`) is a future enhancement — out of
 *    scope here; this is a flat, operator-configured number.
 *  - Env: `STEP_GAS_OVERHEAD_USD` (flat default) and optional per-chain
 *    override `STEP_GAS_OVERHEAD_USD_<CHAINID>` (e.g. `STEP_GAS_OVERHEAD_USD_43114`).
 *  - Safety: clamped to [0, MAX] and `Number.isFinite`; anything invalid → 0.
 */

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
 * Per-step gas overhead (USD) charged to the caller on top of the agent price,
 * to cover the gateway's downstream settlement gas.
 *
 * @param chainId numeric chain id of the settlement chain (the same one used to
 *   debit the caller per step).
 * @returns the overhead in USD; ALWAYS 0 on testnet / unknown chain, and 0 when
 *   no env is configured (zero behaviour change by default).
 */
export function getStepGasOverheadUsd(chainId: number): number {
  // Gate: only mainnet chains incur the overhead. Everything else → 0.
  if (!MAINNET_CHAIN_IDS.has(chainId)) return 0;

  // Per-chain override wins over the flat default.
  const perChain = parseOverheadEnv(
    process.env[`STEP_GAS_OVERHEAD_USD_${chainId}`],
  );
  if (perChain !== undefined) return perChain;

  const flat = parseOverheadEnv(process.env.STEP_GAS_OVERHEAD_USD);
  if (flat !== undefined) return flat;

  // No config → 0 (default: no change in behaviour).
  return 0;
}
