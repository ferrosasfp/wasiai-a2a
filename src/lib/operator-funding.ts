/**
 * Operator funding classifier — WKH-71 (AC-3).
 *
 * Central place that recognises the crude viem/RPC error raised when a
 * transaction signed with `OPERATOR_PRIVATE_KEY` cannot be broadcast because
 * the operator wallet has no native gas left ("insufficient funds for gas",
 * "gas required exceeds allowance", …). Callers use it to relabel that opaque
 * error with an identifiable reason (`operator-funding-low` / "operator funding
 * low") for logs and error messages, instead of propagating a generic RPC
 * string or an anonymous 500.
 *
 * This module ONLY classifies and formats strings. It does NOT sign, read
 * balances, or touch the network — the actual balance monitoring lives in the
 * separate cron monitor (mcp-servers/wasiai-x402). It never throws.
 *
 * Scope guard (CD-5): callers of this helper MUST NOT change their control
 * flow based on the classification beyond the error message/log — e.g.
 * `chargeProtocolFee` keeps its "never rejects the promise" invariant.
 */

/** Stable machine-readable reason surfaced in logs and wrapped error messages. */
export const OPERATOR_FUNDING_LOW_REASON = 'operator-funding-low';

/** Human-readable label used when a plain message is more appropriate. */
export const OPERATOR_FUNDING_LOW_MESSAGE = 'operator funding low';

/**
 * Substrings (case-insensitive) that viem / EVM RPCs use when a transaction
 * fails specifically because the signer wallet cannot cover gas. Kept narrow
 * on purpose: only funding-related failures map to `operator-funding-low`.
 * Generic timeouts / RPC-down errors are intentionally NOT included so the
 * classification stays truthful (a timeout is not proof of an empty wallet).
 */
const FUNDING_LOW_PATTERNS: readonly string[] = [
  'insufficient funds for gas',
  'insufficient funds',
  'gas required exceeds allowance',
  'insufficient balance for transfer',
  "sender doesn't have enough funds",
  'not enough funds',
  // viem InsufficientFundsError: `nodeMessage` and `shortMessage` variants
  // that DON'T contain the literal "insufficient funds" substring (NIT-1).
  'exceeds transaction sender account balance',
  'exceeds the balance of the account',
];

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return '';
}

/**
 * True when the error looks like an operator-wallet gas-funding failure.
 * Never throws; returns `false` for anything it cannot recognise.
 */
export function isOperatorFundingLowError(err: unknown): boolean {
  const msg = extractMessage(err).toLowerCase();
  if (msg.length === 0) return false;
  return FUNDING_LOW_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Classify an error into an identifiable shape for logging / messaging.
 *
 * When the error is a funding-low failure, `reason` is
 * `operator-funding-low` and `message` is prefixed with the stable reason so
 * the original crude string is preserved (grep-able) but no longer anonymous.
 * Otherwise `reason` is `null` and `message` is the untouched original.
 */
export function classifyOperatorError(err: unknown): {
  reason: string | null;
  fundingLow: boolean;
  message: string;
} {
  const original = extractMessage(err) || 'unknown error';
  if (isOperatorFundingLowError(err)) {
    return {
      reason: OPERATOR_FUNDING_LOW_REASON,
      fundingLow: true,
      message: `${OPERATOR_FUNDING_LOW_MESSAGE}: ${original}`,
    };
  }
  return { reason: null, fundingLow: false, message: original };
}
