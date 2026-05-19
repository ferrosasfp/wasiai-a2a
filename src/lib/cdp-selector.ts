/**
 * CDP Facilitator Selector (WKH-106 BASE-03).
 *
 * Pure function — no side-effects, no env reads inside the function body.
 * The caller passes `cdpFacilitatorUrl` (typically sourced from
 * `process.env.CDP_FACILITATOR_URL`) and the agent's manifest-declared
 * facilitator URL (optional). The selector decides which URL the settle
 * call should target.
 *
 * Rules (DT-3, AC-2, AC-5, AC-7, CD-2, CD-5, CD-6):
 *   - If chainKey does NOT start with 'base-' → never apply CDP override,
 *     return the agent manifest facilitator URL (may be undefined → caller
 *     falls back to adapter default).
 *   - If chainKey starts with 'base-' AND `cdpFacilitatorUrl` is a non-empty
 *     string → return `cdpFacilitatorUrl`.
 *   - Otherwise (Base chain but no CDP URL) → return the agent manifest
 *     facilitator URL (may be undefined → caller falls back to adapter
 *     default, preserving AC-5 no-regression behaviour).
 *
 * The function does NOT read `process.env` directly (CD-6) — testable
 * without env mocking.
 */

import type { ChainKey } from '../adapters/types.js';

export interface SelectFacilitatorUrlInput {
  /** Resolved chain key. Selector only activates when `chainKey.startsWith('base-')`. */
  chainKey: ChainKey;
  /** Value of `process.env.CDP_FACILITATOR_URL`. Pass `undefined` or `''` when unset. */
  cdpFacilitatorUrl?: string;
  /**
   * Optional URL declared in the agent's manifest (`metadata.facilitatorUrl`)
   * or resolved upstream. When CDP override does NOT apply, the selector
   * returns this value as-is (may be `undefined`, in which case the caller
   * should fall back to the adapter default).
   */
  agentManifestFacilitatorUrl?: string;
}

/**
 * Returns the facilitator URL that the settle call should target.
 *
 * `undefined` return = caller should use the adapter default (i.e. no
 * override). This preserves the contract that absent CDP env var on Base
 * routes the settle through the existing wasiai-facilitator path.
 */
export function selectFacilitatorUrl(
  input: SelectFacilitatorUrlInput,
): string | undefined {
  const { chainKey, cdpFacilitatorUrl, agentManifestFacilitatorUrl } = input;

  // CD-5: selector only activates on Base chains. Kite / Avalanche untouched.
  const isBaseChain = chainKey.startsWith('base-');

  if (!isBaseChain) {
    return agentManifestFacilitatorUrl;
  }

  // AC-2: CDP override only when env var is a non-empty string.
  if (typeof cdpFacilitatorUrl === 'string' && cdpFacilitatorUrl.length > 0) {
    return cdpFacilitatorUrl;
  }

  // AC-5: no CDP env → preserve manifest URL (or undefined → adapter default).
  return agentManifestFacilitatorUrl;
}
