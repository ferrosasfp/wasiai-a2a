/**
 * Arbiter LLM classifier — WKH-139 v2 (W1.3)
 *
 * Ante una disputa que el motor de reglas NO puede resolver (evidencia
 * contradictoria/rota), pide a Claude una decisión **acotada** a
 * `{release, refund, split(+pct)}` a partir de un **resumen de evidencia
 * on-chain/DB** (montos, conteos, flags de integridad — NUNCA texto libre de las
 * partes, CD-1/CD-8). El LLM **no** toca fondos: sólo sugiere un desenlace que el
 * árbitro luego capea y ejecuta por los primitivos probados.
 *
 * Contrato (CD-9, nunca-throw): TODA ruta de salida devuelve `null` —
 * ANTHROPIC_API_KEY ausente, breaker abierto, timeout/abort, JSON no parseable,
 * shape inválido, `decision` fuera de `{release,refund,split}`, `splitPct` fuera
 * de `[0,100]`. Logs SIN datos sensibles (sólo flags/conteos).
 *
 * Exemplar (espejo estructural): src/services/llm/input-retry.ts.
 */

import Anthropic from '@anthropic-ai/sdk';
import { anthropicCircuitBreaker } from '../../lib/circuit-breaker.js';
import { getLogger } from '../../lib/logger.js';
import {
  getInputRetryMaxTokens,
  getInputRetryModel,
  getLlmTimeoutMs,
} from '../llm/models.js';

const log = getLogger('arbiter-llm');

/** Resumen de evidencia on-chain/DB (montos/conteos/flags). NUNCA texto libre. */
export interface EvidenceSummary {
  authorizedUsd: number;
  consumedUsd: number;
  voucherCount: number;
  vouchersTotalUsd: number;
  proofChainOk: boolean;
  receiptSettleTotalUsd: number | null;
  ambiguityReason: string;
}

export interface LlmDecision {
  decision: 'release' | 'refund' | 'split';
  splitPct?: number;
  reasoning: string;
}

/** Lazily-initialized Anthropic client (singleton for connection reuse). */
let _anthropicClient: Anthropic | null = null;
function getAnthropicClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!_anthropicClient) {
    _anthropicClient = new Anthropic({ apiKey });
  }
  return _anthropicClient;
}

const SYSTEM_PROMPT =
  'You are a deterministic dispute arbiter for a payment escrow. You receive ONLY\n' +
  'on-chain/database evidence about a metered payment session (amounts in USD,\n' +
  'voucher counts, receipt totals, integrity flags). You NEVER receive free-form\n' +
  'text from the parties. Decide the outcome of the dispute and return ONLY a JSON\n' +
  'object with this exact shape: {"decision":"release"|"refund"|"split",\n' +
  '"splitPct":<0-100 number, ONLY when decision is "split">,"reasoning":"<short>"}.\n' +
  'release = pay the whole deposit to the seller; refund = return the whole deposit\n' +
  'to the buyer; split = pay splitPct%% of the deposit to the seller (the rest is\n' +
  'refunded). Base the split on how much of the authorized deposit the metered usage\n' +
  'supports. Return ONLY the JSON object, no markdown, no prose.';

/**
 * Sugiere un desenlace acotado para una disputa ambigua. Devuelve la decisión o
 * `null` cuando el LLM no está disponible / la respuesta es inválida (fail-closed:
 * el árbitro traduce `null` a `arb_hold`, CD-10).
 */
export async function classifyAmbiguous(
  summary: EvidenceSummary,
): Promise<LlmDecision | null> {
  // CD-9: sin LLM configurado → degrade silencioso.
  const client = getAnthropicClient();
  if (!client) return null;

  const userPrompt = [
    'Dispute evidence (on-chain/DB only):',
    `authorized_deposit_usd: ${summary.authorizedUsd}`,
    `metered_consumed_usd: ${summary.consumedUsd}`,
    `voucher_count: ${summary.voucherCount}`,
    `vouchers_total_usd: ${summary.vouchersTotalUsd}`,
    `proof_chain_ok: ${summary.proofChainOk}`,
    `receipt_settle_total_usd: ${
      summary.receiptSettleTotalUsd === null
        ? 'none'
        : summary.receiptSettleTotalUsd
    }`,
    `why_ambiguous: ${summary.ambiguityReason}`,
    'Return ONLY the JSON decision object.',
  ].join('\n');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getLlmTimeoutMs());

  try {
    const response = await anthropicCircuitBreaker.execute(() =>
      client.messages.create(
        {
          model: getInputRetryModel(),
          max_tokens: getInputRetryMaxTokens(),
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }],
        },
        { signal: controller.signal },
      ),
    );

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('')
      .trim();

    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    const decision = obj.decision;
    // Schema acotado: sólo los 3 desenlaces (CD-1).
    if (
      decision !== 'release' &&
      decision !== 'refund' &&
      decision !== 'split'
    ) {
      return null;
    }
    const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : '';

    if (decision === 'split') {
      const pct = obj.splitPct;
      // splitPct obligatorio y en [0,100] para split.
      if (
        typeof pct !== 'number' ||
        !Number.isFinite(pct) ||
        pct < 0 ||
        pct > 100
      ) {
        return null;
      }
      return { decision: 'split', splitPct: pct, reasoning };
    }
    return { decision, reasoning };
  } catch {
    // CD-9: CircuitOpenError, timeout (abort), API error, JSON parse → null.
    // Log SIN datos sensibles (sólo el motivo de ambigüedad + flag).
    log.error(
      { ambiguityReason: summary.ambiguityReason, status: 'classify-failed' },
      'classify-failed',
    );
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
