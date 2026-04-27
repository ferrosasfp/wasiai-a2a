/**
 * Schema Transform Service — WKH-14
 *
 * Uses Claude Sonnet to generate a JS transform function when the output
 * of step N is incompatible with the inputSchema of step N+1.
 * Caches transforms in-memory (L1) and in Supabase kite_schema_transforms (L2).
 */

import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../../lib/supabase.js';
import type { TransformResult } from '../../types/index.js';
import { schemaHash } from './canonical-json.js';
import { computeCostUsd, type PricedModel } from './pricing.js';
import { selectModel } from './select-model.js';

const TIMEOUT_MS = 30_000;

// ─── L1 In-memory cache ────────────────────────────────────────
// Key: `${sourceAgentId}:${targetAgentId}`
const l1Cache = new Map<string, string>();

// ─── Helpers ───────────────────────────────────────────────────

/**
 * Checks if output already satisfies inputSchema.
 * Heuristic: if inputSchema defines "required" fields (JSON Schema style),
 * verify all required keys exist in output. If no schema or no required → compatible.
 */
function isCompatible(
  output: unknown,
  inputSchema: Record<string, unknown> | undefined,
): boolean {
  if (!inputSchema) return true;
  if (typeof output !== 'object' || output === null) return false;

  const required = inputSchema.required;
  if (!Array.isArray(required) || required.length === 0) return true;

  const outputKeys = new Set(Object.keys(output as Record<string, unknown>));
  return required.every(
    (key: unknown) => typeof key === 'string' && outputKeys.has(key),
  );
}

/**
 * Applies a transform function string to an output value.
 * The transform fn is a JS function body that receives `output` and returns the transformed value.
 * Uses `new Function` — NOT eval().
 *
 * @throws if transformFn is invalid JS or throws at runtime
 */
function applyTransformFn(transformFn: string, output: unknown): unknown {
  // eslint-disable-next-line no-new-func
  const fn = new Function('output', transformFn);
  return fn(output) as unknown;
}

/**
 * Calls Claude (model selected by caller) to generate a JS transform function.
 * Returns the function body as a string (to be used with new Function('output', body)),
 * plus token usage for cost telemetry (WKH-57).
 *
 * If `missingFields` is non-empty (retry attempt), the system prompt is enriched
 * with the names of required fields the previous attempt failed to produce
 * (CD-10: nombre específico del campo, no genérico).
 *
 * @throws on API error, timeout, or invalid JSON response
 */
async function generateTransformFn(
  output: unknown,
  inputSchema: Record<string, unknown>,
  model: PricedModel,
  missingFields: string[],
): Promise<{ fn: string; tokensIn: number; tokensOut: number }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const client = new Anthropic({ apiKey });

  let systemPrompt =
    'Eres un experto en transformación de schemas JSON. Dado un valor de output y un inputSchema JSON Schema, genera SOLO el cuerpo de una función JavaScript (sin declaración de función) que recibe `output` y retorna el objeto transformado para satisfacer el inputSchema. Responde SOLO con JSON válido, sin markdown.';

  // CD-10: si el primer intento falló por campos requeridos faltantes, agregar
  // los nombres específicos al systemPrompt para guiar al LLM.
  if (missingFields.length > 0) {
    systemPrompt +=
      `\n\nPREVIOUS ATTEMPT FAILED: missing required fields [${missingFields.join(
        ', ',
      )}]. ` +
      'The transformFn MUST produce an object that contains ALL of these fields.';
  }

  const userPrompt = `Output actual (valor real del agente anterior):
${JSON.stringify(output, null, 2)}

InputSchema esperado por el siguiente agente (JSON Schema):
${JSON.stringify(inputSchema, null, 2)}

Responde con este JSON exacto:
{
  "transformFn": "<cuerpo JS que recibe output y retorna el objeto transformado>"
}

Ejemplo válido de transformFn:
"return { query: output.text || output.content || String(output), ...output };"
`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await client.messages.create(
      {
        model,
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      },
      { signal: controller.signal },
    );

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('')
      .trim();

    const parsed = JSON.parse(text) as Record<string, unknown>;

    const fn = parsed.transformFn;
    if (typeof fn !== 'string' || fn.trim().length === 0) {
      throw new Error('LLM returned empty or invalid transformFn');
    }

    const tokensIn = response.usage?.input_tokens ?? 0;
    const tokensOut = response.usage?.output_tokens ?? 0;

    return { fn, tokensIn, tokensOut };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Retrieves transform function from L2 (Supabase), updates hit_count.
 * Returns null if not found.
 */
async function getFromL2(
  sourceAgentId: string,
  targetAgentId: string,
  schemaHashValue: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('kite_schema_transforms')
    .select('transform_fn, hit_count')
    .eq('source_agent_id', sourceAgentId)
    .eq('target_agent_id', targetAgentId)
    .eq('schema_hash', schemaHashValue)
    .single();

  if (error || !data) return null;

  // Update hit_count (fire-and-forget — no await)
  void supabase
    .from('kite_schema_transforms')
    .update({
      hit_count: (data.hit_count ?? 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('source_agent_id', sourceAgentId)
    .eq('target_agent_id', targetAgentId)
    .eq('schema_hash', schemaHashValue);

  return data.transform_fn as string;
}

/**
 * Persists a transform function to L2 (Supabase).
 * Uses upsert to handle race conditions.
 */
async function persistToL2(
  sourceAgentId: string,
  targetAgentId: string,
  schemaHashValue: string,
  transformFn: string,
): Promise<void> {
  await supabase.from('kite_schema_transforms').upsert(
    {
      source_agent_id: sourceAgentId,
      target_agent_id: targetAgentId,
      schema_hash: schemaHashValue,
      transform_fn: transformFn,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'source_agent_id,target_agent_id,schema_hash' },
  );
}

/**
 * Builds a TransformResult for the LLM bridge path. Shared between the
 * happy path (attempt 1) and the retry-happy path (attempt 2). Keeps the
 * returned shape identical to inline construction (no behavioural change).
 */
function buildLLMResult(
  transformedOutput: unknown,
  model: PricedModel,
  tokensIn: number,
  tokensOut: number,
  retries: 0 | 1,
  latencyMs: number,
): TransformResult {
  return {
    transformedOutput,
    cacheHit: false,
    bridgeType: 'LLM',
    latencyMs,
    llm: {
      model,
      tokensIn,
      tokensOut,
      retries,
      costUsd: computeCostUsd(model, tokensIn, tokensOut),
    },
  };
}

// ─── Public API ────────────────────────────────────────────────

/**
 * Maybe transforms output to match next agent's inputSchema.
 *
 * Flow:
 * 1. isCompatible? → SKIPPED (no transform needed)
 * 2. L1 hit? → apply cached fn
 * 3. L2 hit? → apply cached fn, update L1
 * 4. Miss? → LLM generate → persist L2 + L1 → apply
 *
 * @param sourceAgentId ID of the agent that produced output
 * @param targetAgentId ID of the agent that will consume the transformed output
 * @param output The raw output from the source agent
 * @param inputSchema The JSON Schema expected by the target agent
 */
export async function maybeTransform(
  sourceAgentId: string,
  targetAgentId: string,
  output: unknown,
  inputSchema: Record<string, unknown> | undefined,
): Promise<TransformResult> {
  const start = Date.now();

  // 1. Compatible? → skip
  if (isCompatible(output, inputSchema)) {
    return {
      transformedOutput: output,
      cacheHit: 'SKIPPED',
      bridgeType: 'SKIPPED',
      latencyMs: Date.now() - start,
    };
  }

  // WKH-57 (DT-B): cache key includes deterministic schema fingerprint so
  // schema changes do NOT collide with stale entries from a previous schema.
  const schemaHashValue = schemaHash(inputSchema);
  const cacheKey = `${sourceAgentId}:${targetAgentId}:${schemaHashValue}`;

  // 2. L1 cache hit
  const l1Fn = l1Cache.get(cacheKey);
  if (l1Fn) {
    const transformedOutput = applyTransformFn(l1Fn, output);
    return {
      transformedOutput,
      cacheHit: true,
      bridgeType: 'CACHE_L1',
      latencyMs: Date.now() - start,
    };
  }

  // 3. L2 cache hit (Supabase)
  const l2Fn = await getFromL2(sourceAgentId, targetAgentId, schemaHashValue);
  if (l2Fn) {
    l1Cache.set(cacheKey, l2Fn);
    const transformedOutput = applyTransformFn(l2Fn, output);
    return {
      transformedOutput,
      cacheHit: true,
      bridgeType: 'CACHE_L2',
      latencyMs: Date.now() - start,
    };
  }

  // 4. Cache miss → LLM with model selector + retry verification (WKH-57)
  const schema = inputSchema ?? {};
  const model = selectModel(inputSchema);

  // Attempt 1
  const attempt1 = await generateTransformFn(output, schema, model, []);
  const transformed1 = applyTransformFn(attempt1.fn, output);

  if (isCompatible(transformed1, inputSchema)) {
    // Happy path — persist and return
    persistToL2(
      sourceAgentId,
      targetAgentId,
      schemaHashValue,
      attempt1.fn,
    ).catch((err: unknown) => {
      console.error(
        `[Transform] Failed to persist to L2 for ${cacheKey}:`,
        err,
      );
    });
    l1Cache.set(cacheKey, attempt1.fn);

    return buildLLMResult(
      transformed1,
      model,
      attempt1.tokensIn,
      attempt1.tokensOut,
      0,
      Date.now() - start,
    );
  }

  // Attempt 2 — retry with missing fields hint (CD-10)
  const required = Array.isArray(schema.required) ? schema.required : [];
  const transformed1Keys =
    transformed1 !== null && typeof transformed1 === 'object'
      ? new Set(Object.keys(transformed1 as Record<string, unknown>))
      : new Set<string>();
  const missing = required.filter(
    (k): k is string => typeof k === 'string' && !transformed1Keys.has(k),
  );

  // CD-14: log NO leak raw output/schema. Solo nombres de campos + count + model.
  console.error(
    `[Transform] retry attempt 1: missing fields [${missing.join(
      ', ',
    )}] (model=${model})`,
  );

  const attempt2 = await generateTransformFn(output, schema, model, missing);
  const transformed2 = applyTransformFn(attempt2.fn, output);

  const totalIn = attempt1.tokensIn + attempt2.tokensIn;
  const totalOut = attempt1.tokensOut + attempt2.tokensOut;

  if (isCompatible(transformed2, inputSchema)) {
    // Retry succeeded — persist with attempt2.fn
    persistToL2(
      sourceAgentId,
      targetAgentId,
      schemaHashValue,
      attempt2.fn,
    ).catch((err: unknown) => {
      console.error(
        `[Transform] Failed to persist to L2 for ${cacheKey}:`,
        err,
      );
    });
    l1Cache.set(cacheKey, attempt2.fn);

    return buildLLMResult(
      transformed2,
      model,
      totalIn,
      totalOut,
      1,
      Date.now() - start,
    );
  }

  // Retry FAILED — throw with explicit message + missing fields (DT-C, AC-3)
  const transformed2Keys =
    transformed2 !== null && typeof transformed2 === 'object'
      ? new Set(Object.keys(transformed2 as Record<string, unknown>))
      : new Set<string>();
  const missingFinal = required.filter(
    (k): k is string => typeof k === 'string' && !transformed2Keys.has(k),
  );

  throw new Error(
    `transform validation failed after retry: missing required fields [${missingFinal.join(
      ', ',
    )}] in last attempt (model=${model})`,
  );
}

/** Clears L1 cache — for testing only */
export function _clearL1Cache(): void {
  l1Cache.clear();
}
