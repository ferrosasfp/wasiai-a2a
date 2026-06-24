/**
 * Adaptive input-retry LLM helper — WKH-130 (W2)
 *
 * Given an input object that an upstream agent rejected (4xx with field-errors)
 * and the list of field names it flagged, asks Claude Haiku to regenerate a
 * corrected input that keeps every existing key and fills the missing fields
 * with plausible values inferred from their names.
 *
 * Contract (CD-11): this helper NEVER throws toward compose. Every failure
 * path — missing ANTHROPIC_API_KEY, empty missingFields, circuit-breaker open,
 * timeout, API error, non-object JSON — degrades to `return null`.
 *
 * CD-12 (no-leak): logs only carry `agentSlug` + `missingFields` (names).
 * The raw `failedInput` / regenerated input are NEVER logged.
 */

import Anthropic from '@anthropic-ai/sdk';
import { anthropicCircuitBreaker } from '../../lib/circuit-breaker.js';

// DT-3: Haiku is hardcoded. The master path has NO input_schema, so selectModel
// (which reads a schema) is not applicable here.
const MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 30_000;

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
  'You fix failed JSON inputs for an autonomous agent. Given a JSON input object that was\n' +
  'rejected and the list of field names the agent requires, return a corrected JSON input\n' +
  'that (a) keeps every existing key/value from the original input, and (b) adds the missing\n' +
  'fields with plausible values inferred from the field names (e.g. an email-like field gets\n' +
  'an email, an amount/price field gets a number, an id/uuid field gets a uuid-like string,\n' +
  'a name field gets a name, a country/iso field gets a country code). Do NOT invent fields\n' +
  'that were not requested. Return ONLY the JSON object, no markdown, no prose.';

/**
 * Regenerates a corrected input for `agentSlug` using the rejected input and
 * the agent's required field names. Returns the corrected object, or `null`
 * when the LLM is unavailable / the response is not a JSON object.
 *
 * @param failedInput the input object the agent rejected.
 * @param missingFields field names the agent flagged as missing/invalid.
 * @param agentSlug the agent slug (for the prompt + logs).
 * @param agentDescription optional agent description (included in the prompt).
 */
export async function regenerateInputFromErrors(
  failedInput: Record<string, unknown>,
  missingFields: string[],
  agentSlug: string,
  agentDescription?: string,
): Promise<Record<string, unknown> | null> {
  // CD-7: no LLM configured → degrade silently.
  const client = getAnthropicClient();
  if (!client) return null;
  // Defensive: nothing to fix.
  if (missingFields.length === 0) return null;

  const userPrompt = [
    `Agent: ${agentSlug}${
      agentDescription ? `\nWhat it does: ${agentDescription}` : ''
    }`,
    'Failed input (JSON):',
    JSON.stringify(failedInput, null, 2),
    'Required field names the agent is missing or rejected:',
    missingFields.join(', '),
    'Return ONLY the corrected JSON input object.',
  ].join('\n');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await anthropicCircuitBreaker.execute(() =>
      client.messages.create(
        {
          model: MODEL,
          max_tokens: 1024,
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

    const parsed = JSON.parse(text);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    // CD-11: CircuitOpenError, timeout (abort), API error, JSON parse → null.
    console.error('[input-retry]', {
      agentSlug,
      missingFields,
      status: 'regenerate-failed',
    });
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
