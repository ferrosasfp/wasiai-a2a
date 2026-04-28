/**
 * WKH-57: Pricing público de Anthropic API por modelo.
 * Fuente: https://console.anthropic.com/pricing (verificar en cada actualización).
 *
 * MUST be validated against Anthropic console pricing page before deploy.
 * If real prices differ, update ONLY the values; do NOT rename keys.
 */

// PRICING — validated 2026-04-28 against https://platform.claude.com/docs/en/about-claude/pricing
// Haiku 4.5: $1/MTok input, $5/MTok output (NOT $0.80/$4.00 — those are Haiku 3.5 values)
// Sonnet 4.6: $3/MTok input, $15/MTok output
export const PRICING_USD_PER_M_TOKENS = {
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
} as const;

export type PricedModel = keyof typeof PRICING_USD_PER_M_TOKENS;

/** Cost en USD para un par (tokensIn, tokensOut) bajo `model`. Pure. */
export function computeCostUsd(
  model: PricedModel,
  tokensIn: number,
  tokensOut: number,
): number {
  const p = PRICING_USD_PER_M_TOKENS[model];
  return (tokensIn / 1_000_000) * p.input + (tokensOut / 1_000_000) * p.output;
}
