/**
 * Settle re-verifier (TB-01, audit 2026-06-30).
 *
 * After the facilitator reports a successful settle (`{ settled: true,
 * transactionHash }`), the gateway used to TRUST that JSON and immediately grant
 * access / debit budget WITHOUT ever reading the tx on-chain. A compromised or
 * buggy facilitator (or a forged `{ settled: true, transactionHash: '0xdead…' }`
 * body) could therefore unlock the money-path with a fake/replayed/insufficient
 * tx hash.
 *
 * This module performs an INDEPENDENT on-chain re-read of the returned tx hash
 * BEFORE access is granted / budget is debited, reusing the SAME viem primitives
 * as `deposit-verifier.ts` (`getTransactionReceipt` → `status === 'success'`,
 * `getChainId`, Transfer-log decode → recipient === payTo, token, amount ≥
 * required). Unlike the deposit verifier:
 *   - the expected recipient is the settle `payTo` (NOT the treasury);
 *   - the amount must be `>= requiredAmount` (NOT an exact match);
 *   - a short confirmation wait is allowed (a just-settled tx may need a block).
 *
 * Gated behind `SETTLE_VERIFY_ONCHAIN` (default 'true') so it can be disabled
 * instantly if it ever regresses (operator kill-switch). When disabled, this
 * module is a no-op `{ ok: true }` and behaviour is byte-for-byte as before.
 */
import type { PublicClient } from 'viem';
import { createPublicClient, decodeEventLog, parseAbiItem } from 'viem';
import { buildRpcTransport } from '../lib/rpc-transport.js';
import { isMainnetChainKey } from './chain-resolver.js';
import {
  resolveChainObject,
  resolveRpcFallbackEnv,
  resolveRpcUrl,
} from './deposit-verifier.js';
import { getAdaptersBundle, getDefaultChainKey } from './registry.js';
import type { ChainKey } from './types.js';

export type SettleVerificationReason =
  | 'DISABLED' // kill-switch off — treated as ok (never blocks)
  | 'RPC_UNAVAILABLE' // a2a couldn't independently check on TESTNET — fail-OPEN (allowed)
  | 'RPC_UNAVAILABLE_MAINNET_FAILCLOSED' // WKH-144: couldn't check on MAINNET — fail-CLOSED (blocked)
  | 'TX_NOT_FOUND' // node DEFINITIVELY reports no such tx — fail-CLOSED
  | 'TX_REVERTED'
  | 'CHAIN_MISMATCH'
  | 'RECIPIENT_MISMATCH'
  | 'TOKEN_MISMATCH'
  | 'AMOUNT_MISMATCH';

export interface SettleVerification {
  /**
   * Whether the settle is ALLOWED to proceed.
   *
   * MNR-1 (audit 2026-06-30): error classification follows fail-OPEN on
   * transport / fail-CLOSED on contradiction:
   *  - DISABLED (kill-switch off) → ok:true.
   *  - VERIFIED (tx really settled >= required to payTo) → ok:true.
   *  - RPC_UNAVAILABLE ("I couldn't check": RPC unreachable / timeout / network
   *    error / provider 5xx) on TESTNET → ok:true + `warn:true`. The facilitator
   *    already broadcast + receipt-checked the tx; a2a degrades to the prior
   *    trusted behaviour only when it literally cannot reach a node.
   *  - WKH-144: the SAME "I couldn't check" on MAINNET
   *    (RPC_UNAVAILABLE_MAINNET_FAILCLOSED) → ok:false + `warn:true`. With real
   *    money on the line, a2a will NOT trust the facilitator blind; the
   *    `warn:true` marks it as an RPC outage (recoverable) so an operator can
   *    tell it apart from a DEFINITIVE contradiction (possible forgery).
   *  - Any DEFINITIVE on-chain contradiction (reverted, recipient/token/amount
   *    mismatch, or the node DEFINITIVELY reports no such tx) → ok:false with no
   *    `warn`. This is the forgery signal TB-01 exists to catch.
   */
  ok: boolean;
  reason?: SettleVerificationReason;
  /**
   * True for either "couldn't independently check on-chain" outcome:
   *  - testnet RPC_UNAVAILABLE (ok:true, fail-OPEN), or
   *  - mainnet RPC_UNAVAILABLE_MAINNET_FAILCLOSED (ok:false, fail-CLOSED, WKH-144).
   * In BOTH cases the settle was decided WITHOUT an independent on-chain
   * confirmation — callers SHOULD log a WARNING. `warn:true` with `ok:false`
   * distinguishes an RPC outage from a definitive on-chain contradiction.
   */
  warn?: boolean;
}

export interface VerifySettledTxArgs {
  chainKey: ChainKey;
  chainId: number;
  txHash: `0x${string}`;
  /** Expected recipient (the settle `payTo`). Compared case-insensitively. */
  payTo: string;
  /** Expected token contract (ERC-20). Compared case-insensitively. */
  tokenAddress: string;
  /** Minimum atomic amount that must have reached `payTo`. */
  requiredAmountAtomic: bigint;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

/**
 * Kill-switch. Default ON ('true'); any value other than a recognized
 * falsy literal keeps it ON (fail-safe — verification stays enabled unless an
 * operator EXPLICITLY disables it). Re-read per call (no cache) so the switch
 * can be flipped without a redeploy if the env is hot-reloaded.
 */
export function isSettleVerifyEnabled(): boolean {
  const raw = process.env.SETTLE_VERIFY_ONCHAIN?.trim().toLowerCase();
  if (raw === undefined || raw === '') return true; // default ON
  return !['false', '0', 'no', 'off'].includes(raw);
}

/**
 * Short confirmation wait (ms) before the on-chain re-read. A just-settled tx
 * may not be in the latest block yet on the node we query. Kept small so we
 * never add meaningful latency / risk a request timeout. 0 disables the wait.
 */
function resolveConfirmWaitMs(): number {
  const raw = process.env.SETTLE_VERIFY_CONFIRM_WAIT_MS?.trim();
  if (raw === undefined || raw === '') return 1_500;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 1_500;
  return n;
}

// ── Lazy publicClient cache per ChainKey (mirrors deposit-verifier) ──

const _clients = new Map<ChainKey, PublicClient>();

function getClient(chainKey: ChainKey): PublicClient | null {
  const cached = _clients.get(chainKey);
  if (cached) return cached;
  const rpcUrl = resolveRpcUrl(chainKey);
  if (!rpcUrl) return null;
  const chain = resolveChainObject(chainKey);
  const client = createPublicClient({
    chain,
    // OP-04 (audit 2026-06-30): RPC fallback (primary > env fallback > public).
    transport: buildRpcTransport({
      primary: rpcUrl,
      fallbackEnv: resolveRpcFallbackEnv(chainKey),
      chainId: chain.id,
    }),
  }) as PublicClient;
  _clients.set(chainKey, client);
  return client;
}

/** TEST-ONLY — clears the publicClient cache. */
export function _resetSettleVerifier(): void {
  _clients.clear();
}

/**
 * MNR-1 (audit 2026-06-30): classify an error thrown by `getTransactionReceipt`
 * into the two TB-01 buckets:
 *   - DEFINITIVE "tx not on chain" → the node ANSWERED and has no such receipt
 *     (`TransactionReceiptNotFoundError` / `TransactionNotFoundError`) →
 *     `TX_NOT_FOUND` (fail-CLOSED). This is the forgery signal: a fake hash that
 *     the chain has never seen.
 *   - TRANSPORT / CONNECTIVITY → a2a could not reach a node to check at all
 *     (HTTP error, timeout, RPC request error, network/`fetch failed`,
 *     ECONNREFUSED, provider 5xx). → `RPC_UNAVAILABLE` (fail-OPEN).
 *
 * Only viem's "receipt-not-found" classes are treated as definitive; EVERYTHING
 * else degrades to RPC_UNAVAILABLE so a transient outage never rejects a valid,
 * facilitator-confirmed settle.
 */
function classifyReceiptError(
  err: unknown,
): 'TX_NOT_FOUND' | 'RPC_UNAVAILABLE' {
  const names = new Set<string>();
  let cursor: unknown = err;
  // Walk the viem error cause chain (errors wrap their cause).
  for (let depth = 0; depth < 8 && cursor; depth++) {
    if (cursor instanceof Error && typeof cursor.name === 'string') {
      names.add(cursor.name);
    }
    cursor =
      cursor && typeof cursor === 'object' && 'cause' in cursor
        ? (cursor as { cause?: unknown }).cause
        : undefined;
  }
  if (
    names.has('TransactionReceiptNotFoundError') ||
    names.has('TransactionNotFoundError')
  ) {
    return 'TX_NOT_FOUND';
  }
  return 'RPC_UNAVAILABLE';
}

/**
 * WKH-144: canonical mainnet detection for the settle re-verify gate. Single
 * choke-point (CD-7) — the BODY now lives in `chain-resolver.ts` (pure module,
 * no viem / no registry) so the downstream mainnet opt-in gate
 * (`downstream-payment.ts`, fix-pack AR-profundo FIX 1b) can reuse the SAME
 * classifier without importing this viem-heavy module. Re-exported here
 * unchanged so every existing call-site and the WKH-150 naming-invariant guard
 * test (which cross-checks it against the independent viem `Chain.testnet`
 * boolean) keep importing it from `settle-verifier`.
 */
export { isMainnetChainKey };

/**
 * WKH-144: single decision point for a "couldn't independently check on-chain"
 * (RPC_UNAVAILABLE) outcome. On TESTNET this preserves the historical fail-OPEN
 * byte-for-byte (`{ ok:true, reason:'RPC_UNAVAILABLE', warn:true }`, CD-1). On
 * MAINNET it flips to fail-CLOSED (`ok:false`) with a distinguishable reason so
 * an operator can tell an RPC outage apart from a definitive contradiction
 * (AC-5). Never throws (CD-4).
 *
 * ⚠️ DEPENDENCIA DE SEGURIDAD (fix-pack CR, residuo señalado): esta función
 * clasifica por el STRING del slug (`isMainnetChainKey`), o sea justo lo que el
 * ⚠️ de `chain-resolver.ts` (sobre `isMainnetChainKey`) desaconseja para
 * decisiones de dinero. Es CORRECTO hoy sólo porque
 * `registry.assertNoSlugDestinationDrift()` (vía `checkChainEnvironmentCoherence`,
 * llamada desde `initAdapters`) LANZA al arrancar cuando el destino
 * real de un bundle contradice el mainnet-ness de su slug (fix-pack it2
 * BLQ-ALTO-1): con ese assert en pie, "slug testnet" implica "destino testnet".
 *
 * ⇒ Si alguien ABLANDA ese assert (lo baja a warning, lo scopea a un subconjunto
 * de chains, o agrega un factory que resuelva su chain en call-time sin cubrirlo),
 * este gate vuelve a fail-OPEN sobre settles de MAINNET REAL — la regresión exacta
 * de WKH-144. En ese caso hay que migrar esta función a
 * `classifyDestinationEnvironment(destination)` (que mira el chainId/CAIP-2 real)
 * y pasarle el destino, no el slug. Ver `TD-MAINNET-GATE-USA-CHAINCONFIG`
 * (`MULTI-CHAIN.md` §10).
 */
export function rpcUnavailableResult(chainKey: ChainKey): SettleVerification {
  if (isMainnetChainKey(chainKey)) {
    return {
      ok: false,
      reason: 'RPC_UNAVAILABLE_MAINNET_FAILCLOSED',
      warn: true,
    };
  }
  return { ok: true, reason: 'RPC_UNAVAILABLE', warn: true };
}

/**
 * Re-reads `txHash` on-chain and asserts it really settled `>= requiredAmount`
 * of `tokenAddress` to `payTo` on `chainId`. Returns `{ ok: false, reason }` on
 * a DEFINITIVE on-chain contradiction (reverted / wrong recipient / wrong token
 * / insufficient amount / tx the node confirms isn't on chain) — the caller MUST
 * treat that as a failed settle (no grant / no debit). When the kill-switch is
 * OFF, returns `{ ok: true, reason: 'DISABLED' }`.
 *
 * MNR-1 (audit 2026-06-30): when a2a CANNOT independently check (RPC unreachable
 * / timeout / network error / provider 5xx), returns `{ ok: true, reason:
 * 'RPC_UNAVAILABLE', warn: true }` (fail-OPEN) so a transient a2a-side RPC outage
 * never rejects a valid, facilitator-confirmed settle. Callers MUST log a warning.
 *
 * NEVER throws — every error is classified into TX_NOT_FOUND (fail-closed) or
 * RPC_UNAVAILABLE (fail-open).
 */
export async function verifySettledTx(
  args: VerifySettledTxArgs,
): Promise<SettleVerification> {
  if (!isSettleVerifyEnabled()) {
    return { ok: true, reason: 'DISABLED' };
  }

  const {
    chainKey,
    chainId,
    txHash,
    payTo,
    tokenAddress,
    requiredAmountAtomic,
  } = args;

  // Defensive: malformed expected addresses → cannot verify safely → fail.
  if (!ADDRESS_RE.test(payTo) || !ADDRESS_RE.test(tokenAddress)) {
    return { ok: false, reason: 'RECIPIENT_MISMATCH' };
  }

  const client = getClient(chainKey);
  // No RPC configured for this chain → a2a cannot independently check.
  // MNR-1: this is "couldn't check", NOT a forgery. WKH-144: fail-OPEN on
  // testnet, fail-CLOSED on mainnet (decided in one place by rpcUnavailableResult).
  if (!client) return rpcUnavailableResult(chainKey);

  // Short confirmation wait — a just-settled tx may need a block to be visible.
  const waitMs = resolveConfirmWaitMs();
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  let receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch (firstErr) {
    // One retry after a short wait — covers propagation lag for a real tx.
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      receipt = await client.getTransactionReceipt({ hash: txHash });
    } catch (retryErr) {
      // MNR-1: classify. A DEFINITIVE "no such receipt" (the node answered, the
      // tx isn't on chain) → fail-CLOSED TX_NOT_FOUND (forged hash). A transport
      // failure (couldn't reach a node) → fail-OPEN RPC_UNAVAILABLE.
      const reason = classifyReceiptError(retryErr ?? firstErr);
      if (reason === 'TX_NOT_FOUND') {
        return { ok: false, reason: 'TX_NOT_FOUND' };
      }
      // WKH-144: fail-OPEN on testnet, fail-CLOSED on mainnet (single choke-point).
      return rpcUnavailableResult(chainKey);
    }
  }

  if (receipt.status !== 'success') {
    return { ok: false, reason: 'TX_REVERTED' };
  }

  let onchainChainId: number;
  try {
    onchainChainId = await client.getChainId();
  } catch {
    // Transport failure reading chain id → couldn't check. WKH-144: fail-OPEN
    // on testnet, fail-CLOSED on mainnet (single choke-point).
    return rpcUnavailableResult(chainKey);
  }
  if (onchainChainId !== chainId) {
    return { ok: false, reason: 'CHAIN_MISMATCH' };
  }

  const expectedToken = tokenAddress.toLowerCase();
  const expectedTo = payTo.toLowerCase();

  let tokenLogSeen = false;
  let amountToPayTo: bigint | undefined;
  for (const logEntry of receipt.logs) {
    if (logEntry.address.toLowerCase() !== expectedToken) continue;
    let decoded: ReturnType<
      typeof decodeEventLog<readonly [typeof TRANSFER_EVENT], 'Transfer'>
    >;
    try {
      decoded = decodeEventLog({
        abi: [TRANSFER_EVENT],
        eventName: 'Transfer',
        data: logEntry.data,
        topics: logEntry.topics,
      });
    } catch {
      continue;
    }
    tokenLogSeen = true;
    const { to, value } = decoded.args;
    if (to.toLowerCase() === expectedTo) {
      // Sum all matching transfers to payTo (defensive — usually one).
      amountToPayTo = (amountToPayTo ?? 0n) + value;
    }
  }

  if (!tokenLogSeen) return { ok: false, reason: 'TOKEN_MISMATCH' };
  if (amountToPayTo === undefined) {
    return { ok: false, reason: 'RECIPIENT_MISMATCH' };
  }
  if (amountToPayTo < requiredAmountAtomic) {
    return { ok: false, reason: 'AMOUNT_MISMATCH' };
  }

  return { ok: true };
}

/**
 * Convenience wrapper for the DEFAULT-chain settle consumers (compose downstream
 * settle, protocol-fee transfer) that call `getPaymentAdapter()` (no explicit
 * chainKey). Resolves the default bundle's chainKey / chainId / token and
 * delegates to `verifySettledTx`. Returns `{ ok: true, reason: 'DISABLED' }`
 * when the kill-switch is off. When the default bundle cannot be resolved
 * (registry not initialized in a test) a2a cannot independently check —
 * WKH-144 (MNR-1): this is gated exactly like every other "couldn't check"
 * outcome via `rpcUnavailableResult` (fail-OPEN on testnet byte-identical,
 * fail-CLOSED on mainnet). Reachable only with a mis-initialized registry, but
 * closed for consistency so no verifier fallback fails-open with real money.
 */
export async function verifyDefaultChainSettle(args: {
  txHash: string;
  payTo: string;
  requiredAmountAtomic: bigint;
}): Promise<SettleVerification> {
  if (!isSettleVerifyEnabled()) return { ok: true, reason: 'DISABLED' };

  const chainKey = getDefaultChainKey();
  const bundle = chainKey ? getAdaptersBundle(chainKey) : undefined;
  // WKH-234: narrow the `PaymentAdapter` union via `vmFamily`. Settle re-verify
  // is viem-only (EVM); a non-EVM adapter yields `undefined` → the existing
  // fail-OPEN/CLOSED guard below (unreachable for EVM chains).
  const payment = bundle?.payment;
  const token =
    payment?.vmFamily === 'evm' ? payment.supportedTokens[0] : undefined;
  if (!chainKey || !bundle || !token) {
    // Registry not initialized (e.g. unit test) — cannot independently check.
    // WKH-144: testnet fail-OPEN, mainnet fail-CLOSED (single choke-point). When
    // the chainKey itself is unresolvable, default to the historical fail-OPEN.
    return chainKey ? rpcUnavailableResult(chainKey) : { ok: true };
  }
  if (!args.txHash.startsWith('0x')) {
    return { ok: false, reason: 'TX_NOT_FOUND' };
  }
  return verifySettledTx({
    chainKey,
    chainId: bundle.chainConfig.chainId,
    txHash: args.txHash as `0x${string}`,
    payTo: args.payTo,
    tokenAddress: token.address,
    requiredAmountAtomic: args.requiredAmountAtomic,
  });
}
