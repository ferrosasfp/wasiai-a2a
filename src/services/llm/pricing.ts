/**
 * WKH-57: Pricing público de Anthropic API por modelo.
 * Fuente: https://console.anthropic.com/pricing (verificar en cada actualización).
 *
 * MUST be validated against Anthropic console pricing page before deploy.
 * If real prices differ, update ONLY the values; do NOT rename keys.
 */

// PRICING [VALIDATION REQUIRED]: validar contra console.anthropic.com pre-deploy
// VALIDATE before deploy — see SDD §11. No console access available during F3
// implementation; values come from work-item §DT-F. CD-6 + CD-11.
export const PRICING_USD_PER_M_TOKENS = {
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4.0 },
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
