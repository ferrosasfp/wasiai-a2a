/**
 * Pricing constants — shared placeholder/fallback values for compose &
 * orchestrate billing.
 *
 * Single source of truth for the "registry-miss" fallback fee: when an
 * agent's `priceUsdc` is 0, null, NaN, or otherwise unparseable (a config
 * error in the registry), the gateway debits this flat amount so the step is
 * still billed honestly instead of being charged $0.
 *
 * Previously hardcoded as the literal `1.0` in four production sites
 * (a2a-key middleware, compose service + route, orchestrate service). Audit
 * 2026-06-24 (M7): centralized here so the value is defined once.
 */

/** Flat fallback fee (USD) debited per step when the agent price is invalid. */
export const PLACEHOLDER_FEE_USD = 1.0;
