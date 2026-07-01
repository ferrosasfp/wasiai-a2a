/**
 * WKH-57: Pricing público de Anthropic API por modelo.
 * Fuente: https://console.anthropic.com/pricing (verificar en cada actualización).
 *
 * MUST be validated against Anthropic console pricing page before deploy.
 * If real prices differ, update ONLY the values; do NOT rename keys.
 */
import { getLogger } from '../../lib/logger.js';

const log = getLogger('pricing');

// PRICING — validated 2026-04-28 against https://platform.claude.com/docs/en/about-claude/pricing
// Haiku 4.5: $1/MTok input, $5/MTok output (NOT $0.80/$4.00 — those are Haiku 3.5 values)
// Sonnet 5: $3/MTok input, $15/MTok output (sticker). Intro promo $2/$10 in effect
// until 2026-08-31; we keep the $3/$15 sticker convention here.
export const PRICING_USD_PER_M_TOKENS = {
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0 },
  'claude-sonnet-5': { input: 3.0, output: 15.0 },
} as const;

export type PricedModel = keyof typeof PRICING_USD_PER_M_TOKENS;

/**
 * DEFAULT_PRICING — precio seguro para un model ID fuera de la tabla.
 * CD-10: usa el rate CONOCIDO más alto (Sonnet $3/$15) para NUNCA
 * sub-reportar costo en telemetría (over-estimate > under-estimate).
 */
const DEFAULT_PRICING = { input: 3.0, output: 15.0 } as const;

/**
 * Cost en USD para un par (tokensIn, tokensOut) bajo `model`.
 * WKH-135: tolerante a un model ID env-driven fuera de la tabla — usa
 * DEFAULT_PRICING + `log.warn`, NUNCA throw (CD-2/CD-10). La rama de modelo
 * conocido es byte-idéntica al cálculo previo.
 */
export function computeCostUsd(
  model: string,
  tokensIn: number,
  tokensOut: number,
): number {
  const known = Object.hasOwn(PRICING_USD_PER_M_TOKENS, model);
  const p = known
    ? PRICING_USD_PER_M_TOKENS[model as PricedModel]
    : DEFAULT_PRICING;
  if (!known) {
    log.warn(
      { model, fallback: DEFAULT_PRICING },
      'unknown model ID not in PRICING_USD_PER_M_TOKENS; using safe default price (no throw)',
    );
  }
  return (tokensIn / 1_000_000) * p.input + (tokensOut / 1_000_000) * p.output;
}
