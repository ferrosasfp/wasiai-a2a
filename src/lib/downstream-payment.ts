/**
 * Downstream x402 Payment — chain-aware thin orchestrator (WKH-112 / BASE-07).
 *
 * Resolves the destination chain from `agent.payment.chain` via `normalizeChainSlug`,
 * validates it is initialized in the registry (fail-loud `CHAIN_NOT_SUPPORTED`), and
 * delegates sign + verify + settle to `getPaymentAdapter(chainKey)`. The EIP-3009
 * signature is owned by the adapter (per-chain EIP-712 domain) — NEVER reimplemented
 * inline (CD-9). NEVER throws (CD-7): every async step is wrapped and returns `null`
 * with a skip-code.
 */
import { createPublicClient, erc20Abi, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { normalizeChainSlug } from '../adapters/chain-resolver.js';
import {
  getAdaptersBundle,
  getInitializedChainKeys,
  getPaymentAdapter,
} from '../adapters/registry.js';
import type { ChainKey } from '../adapters/types.js';
import type { Agent, DownstreamLogger } from '../types/index.js';

// Re-export for backward-compat: callers historically import
// `DownstreamLogger` from this module (e.g. compose.ts). The canonical
// definition now lives in `types/index.ts` (TD-WKH-55-4 / CR-MNR-3).
export type { DownstreamLogger };

// CD-NEW-SDD-3: read the flag ONCE at module load
const DOWNSTREAM_FLAG = process.env.WASIAI_DOWNSTREAM_X402 === 'true';

/**
 * EIP-3009 authorization window (`validBefore`) in seconds, passed to
 * `adapter.sign({ ..., timeoutSeconds })`. Reproduces the legacy
 * `VALID_BEFORE_SECONDS = 300` so the Avalanche path keeps its observable 300s
 * window (CD-1). The adapter default is 60s — omitting this regressed the
 * window (AR BLQ-MED-1).
 */
const DOWNSTREAM_AUTH_WINDOW_SECONDS = 300;

/**
 * Maps each `ChainKey` to the env-var NAME that holds its RPC URL (DT-3).
 * This is NOT a hardcode of chain (CD-3 tolerates env-var names): the actual
 * URL comes from the process env at runtime. The `Record<ChainKey, string>`
 * covers all 6 keys to satisfy TS strict, even though only the 3 testnets are
 * exercised in this HU (mainnet is Scope OUT).
 */
const RPC_ENV_BY_CHAIN: Record<ChainKey, string> = {
  'avalanche-fuji': 'FUJI_RPC_URL',
  'avalanche-mainnet': 'AVALANCHE_RPC_URL',
  'base-sepolia': 'BASE_TESTNET_RPC_URL',
  'base-mainnet': 'BASE_MAINNET_RPC_URL',
  'kite-ozone-testnet': 'KITE_RPC_URL',
  'kite-mainnet': 'KITE_MAINNET_RPC_URL',
};

// ─── Public types ───────────────────────────────────────────────────
export interface DownstreamResult {
  txHash: `0x${string}`;
  blockNumber?: number; // opcional — el adapter SettleResult no lo expone (TD-WKH-112-01)
  settledAmount: string; // atomic units; = value.toString()
}

export type DownstreamSkipCode =
  | 'FLAG_OFF'
  | 'NO_PAYMENT_FIELD'
  | 'METHOD_NOT_SUPPORTED'
  | 'CHAIN_NOT_SUPPORTED'
  | 'INVALID_PAY_TO_FORMAT'
  | 'ZERO_PAY_TO'
  | 'INVALID_PRICE'
  | 'INSUFFICIENT_BALANCE'
  | 'BALANCE_READ_FAILED'
  | 'SIGNING_FAILED'
  | 'VERIFY_FAILED'
  | 'SETTLE_FAILED';

// ─── Internal helpers ───────────────────────────────────────────────

/**
 * Validates payTo format and rejects the zero-address (R-1 mitigation).
 * Returns { ok: true, addr } or { ok: false, code }.
 */
function validatePayTo(
  contract: string,
):
  | { ok: true; addr: `0x${string}` }
  | { ok: false; code: 'INVALID_PAY_TO_FORMAT' | 'ZERO_PAY_TO' } {
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) {
    return { ok: false, code: 'INVALID_PAY_TO_FORMAT' };
  }
  if (contract.toLowerCase() === '0x0000000000000000000000000000000000000000') {
    return { ok: false, code: 'ZERO_PAY_TO' };
  }
  return { ok: true, addr: contract as `0x${string}` };
}

// ─── Public API (SINGLE functional export) ──────────────────────────

/**
 * Resolve the destination chain, delegate sign + verify + settle to its adapter.
 * NEVER throws (CD-7).
 *
 * Returns `null` in any of these cases (each logged with its skip-code):
 *  - flag `WASIAI_DOWNSTREAM_X402` is not 'true'        → FLAG_OFF
 *  - agent.payment absent                               → NO_PAYMENT_FIELD
 *  - method !== 'x402'                                  → METHOD_NOT_SUPPORTED
 *  - chain unrecognized or not initialized in registry  → CHAIN_NOT_SUPPORTED
 *  - payTo invalid or zero                              → INVALID_PAY_TO_FORMAT / ZERO_PAY_TO
 *  - priceUsdc not a finite positive number             → INVALID_PRICE
 *  - operator balance < required value                  → INSUFFICIENT_BALANCE
 *  - balance read RPC failure                           → BALANCE_READ_FAILED
 *  - adapter.sign throws                                → SIGNING_FAILED
 *  - adapter.verify throws or returns valid=false       → VERIFY_FAILED
 *  - adapter.settle throws or returns success=false     → SETTLE_FAILED
 *
 * Returns `DownstreamResult` ONLY when the adapter confirmed `success: true`.
 */
export async function signAndSettleDownstream(
  agent: Agent,
  logger: DownstreamLogger,
): Promise<DownstreamResult | null> {
  // 1. Flag check (zero overhead when off)
  if (!DOWNSTREAM_FLAG) {
    return null;
  }

  // 2. agent.payment presence
  if (!agent.payment) {
    logger.info(
      { agentSlug: agent.slug, code: 'NO_PAYMENT_FIELD' },
      '[Downstream] agent.payment absent — skipped',
    );
    return null;
  }

  // 3. method check
  if (agent.payment.method !== 'x402') {
    logger.info(
      {
        agentSlug: agent.slug,
        method: agent.payment.method,
        code: 'METHOD_NOT_SUPPORTED',
      },
      `[Downstream] method=${agent.payment.method} not supported — skipped`,
    );
    return null;
  }

  // 4. Resolve the chain ONCE (CD-6). Fail-loud if unrecognized or not
  //    initialized in the registry — PROHIBITED to fall back to a default
  //    or cross-chain (CD-4 / AC-4).
  const chainKey = normalizeChainSlug(agent.payment.chain);
  const bundle = chainKey ? getAdaptersBundle(chainKey) : undefined;
  if (!chainKey || !bundle) {
    logger.warn(
      {
        agentSlug: agent.slug,
        chain: agent.payment.chain,
        code: 'CHAIN_NOT_SUPPORTED',
        initialized: getInitializedChainKeys(),
      },
      `[Downstream] chain=${agent.payment.chain} not supported/initialized — skipped`,
    );
    return null;
  }

  // 5. payTo validation (R-1)
  const payToCheck = validatePayTo(agent.payment.contract);
  if (!payToCheck.ok) {
    logger.warn(
      {
        agentSlug: agent.slug,
        contract: agent.payment.contract,
        code: payToCheck.code,
      },
      '[Downstream] payTo validation failed',
    );
    return null;
  }

  // 6. priceUsdc guard (non-finite / non-positive)
  if (!Number.isFinite(agent.priceUsdc) || agent.priceUsdc <= 0) {
    logger.warn(
      {
        agentSlug: agent.slug,
        code: 'INVALID_PRICE',
        priceUsdc: agent.priceUsdc,
      },
      '[Downstream] priceUsdc must be a finite positive number',
    );
    return null;
  }

  // 7. Resolve the adapter (same chainKey — CD-6). `getPaymentAdapter` could
  //    throw if the registry were uninitialized, but step 4 already validated
  //    `getAdaptersBundle(chainKey) !== undefined`.
  const adapter = getPaymentAdapter(chainKey);

  // 8. Compute the atomic value with the ADAPTER's decimals (CD-8). Kite/PYUSD
  //    is 18-dec — using a fixed 6 would sign a 10^12× wrong value.
  const decimals = adapter.supportedTokens[0].decimals;
  let value: bigint;
  try {
    value = parseUnits(String(agent.priceUsdc), decimals);
  } catch (e) {
    logger.warn(
      { agentSlug: agent.slug, code: 'INVALID_PRICE', detail: String(e) },
      '[Downstream] parseUnits failed',
    );
    return null;
  }

  // 9. Pre-flight balance check, chain-aware (DT-3). Ephemeral public client
  //    derived from the bundle chainId + the RPC env for this chain. Fail-soft
  //    when no RPC is configured (the facilitator will still settle).
  const rpc = process.env[RPC_ENV_BY_CHAIN[chainKey]];
  if (!rpc) {
    logger.info(
      {
        agentSlug: agent.slug,
        chain: chainKey,
        code: 'BALANCE_PRECHECK_SKIPPED',
      },
      `[Downstream] balance pre-check skipped (no RPC for ${chainKey})`,
    );
  } else {
    const pk = process.env.OPERATOR_PRIVATE_KEY;
    if (pk?.startsWith('0x')) {
      const operator = privateKeyToAccount(pk as `0x${string}`).address;
      const publicClient = createPublicClient({
        chain: {
          id: bundle.chainConfig.chainId,
          name: bundle.chainConfig.name,
          nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
          rpcUrls: { default: { http: [rpc] } },
        },
        transport: http(rpc),
      });
      let balance: bigint;
      try {
        balance = (await publicClient.readContract({
          address: adapter.getToken(),
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [operator],
        })) as bigint;
      } catch (e) {
        logger.warn(
          {
            agentSlug: agent.slug,
            code: 'BALANCE_READ_FAILED',
            detail: String(e),
          },
          '[Downstream] balance read RPC failed',
        );
        return null;
      }
      if (balance < value) {
        logger.warn(
          {
            agentSlug: agent.slug,
            code: 'INSUFFICIENT_BALANCE',
            balance: balance.toString(),
            required: value.toString(),
          },
          '[Downstream] insufficient balance',
        );
        return null;
      }
    }
  }

  // 10-12. Delegate sign + verify + settle to the adapter (CD-9). The whole
  //         block is wrapped to preserve NEVER-throws (CD-7): adapter.verify /
  //         adapter.settle CAN throw (e.g. Kite pieverse network error).
  try {
    // 10. Sign EIP-3009 via the adapter (per-chain EIP-712 domain).
    let signed: Awaited<ReturnType<typeof adapter.sign>>;
    try {
      signed = await adapter.sign({
        to: payToCheck.addr,
        value: value.toString(),
        // CD-1 / AR BLQ-MED-1: preserve the legacy 300s EIP-3009 window.
        timeoutSeconds: DOWNSTREAM_AUTH_WINDOW_SECONDS,
      });
    } catch (e) {
      logger.warn(
        { agentSlug: agent.slug, code: 'SIGNING_FAILED', detail: String(e) },
        '[Downstream] adapter.sign failed',
      );
      return null;
    }

    // The network for verify/settle comes from the SAME signed.paymentRequest
    // (coherence chain — CD-6 / AC-5). Fall back to adapter.getNetwork() only
    // to satisfy TS strict (network is string|undefined in the type, but the
    // adapters always populate it); both resolve to the SAME chain.
    const network = signed.paymentRequest.network ?? adapter.getNetwork();
    const proof = {
      authorization: signed.paymentRequest.authorization,
      signature: signed.paymentRequest.signature,
      network,
    };

    // 11. Verify via the adapter.
    let verifyRes: Awaited<ReturnType<typeof adapter.verify>>;
    try {
      verifyRes = await adapter.verify(proof);
    } catch (e) {
      logger.warn(
        { agentSlug: agent.slug, code: 'VERIFY_FAILED', detail: String(e) },
        '[Downstream] adapter.verify threw',
      );
      return null;
    }
    if (!verifyRes.valid) {
      logger.warn(
        {
          agentSlug: agent.slug,
          code: 'VERIFY_FAILED',
          error: verifyRes.error,
        },
        '[Downstream] adapter.verify returned valid=false',
      );
      return null;
    }

    // 12. Settle via the adapter.
    let settleRes: Awaited<ReturnType<typeof adapter.settle>>;
    try {
      settleRes = await adapter.settle(proof);
    } catch (e) {
      logger.warn(
        { agentSlug: agent.slug, code: 'SETTLE_FAILED', detail: String(e) },
        '[Downstream] adapter.settle threw',
      );
      return null;
    }
    if (!settleRes.success || !settleRes.txHash) {
      logger.warn(
        {
          agentSlug: agent.slug,
          code: 'SETTLE_FAILED',
          error: settleRes.error,
        },
        '[Downstream] adapter.settle returned success=false',
      );
      return null;
    }

    // 13. Success. blockNumber is OMITTED — SettleResult does not expose it
    //     (DT-1 opción C / TD-WKH-112-01). txHash intact.
    return {
      txHash: settleRes.txHash as `0x${string}`,
      settledAmount: value.toString(),
    };
  } catch (e) {
    // Defensive outer catch (CD-7): nothing in the inner blocks should reach
    // here, but if anything unexpected throws, we still return null.
    logger.warn(
      { agentSlug: agent.slug, code: 'SETTLE_FAILED', detail: String(e) },
      '[Downstream] unexpected error during sign/verify/settle',
    );
    return null;
  }
}
