/**
 * Schema Transform Service — WKH-14 (+ WKH-57 + WKH-60)
 *
 * Uses Claude Sonnet to generate a JS transform function when the output
 * of step N is incompatible with the inputSchema of step N+1.
 * Caches transforms in-memory (L1) and in Supabase kite_schema_transforms (L2).
 *
 * WKH-60 / SEC-RCE-1 hardening:
 *  - LLM-generated transformFn is executed in node:vm sandbox (no `new Function`).
 *  - L2 cache is scoped by owner_ref (cross-tenant cache poisoning blocked).
 *  - Cached fn body is HMAC-signed (when SCHEMA_TRANSFORM_HMAC_KEY is set);
 *    rows whose signature does not verify are treated as miss.
 *  - When ownerId is undefined (anonymous x402 caller), L2 read + L2 persist
 *    are bypassed (never-cache mode). L1 still works for the lifetime of the
 *    process.
 */

import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../../lib/supabase.js';
import type { TransformResult } from '../../types/index.js';
import { schemaHash } from './canonical-json.js';
import { computeCostUsd, type PricedModel } from './pricing.js';
import { selectModel } from './select-model.js';
import { signTransformFn, verifyTransformFn } from './transform-hmac.js';
import {
  TransformExecutionError,
  TransformTimeoutError,
  executeTransformInVm,
} from './vm-runner.js';

const TIMEOUT_MS = 30_000;
// Sandboxed transform execution budget. 1s is generous for legitimate
// JSON-shape transforms; an infinite loop or runaway recursion is killed
// by node:vm before user-visible latency degrades.
const VM_TIMEOUT_MS = 1_000;

// ─── L1 In-memory cache ────────────────────────────────────────
// Key: `${sourceAgentId}:${targetAgentId}:${schemaHash}:${ownerId ?? '__anon__'}`
const l1Cache = new Map<string, string>();

// One-shot warning so the operator notices missing HMAC config without
// flooding logs on every call.
let hmacWarnEmitted = false;
function getHmacKey(): string | undefined {
  const k = process.env.SCHEMA_TRANSFORM_HMAC_KEY;
  if (typeof k === 'string' && k.length > 0) return k;
  if (!hmacWarnEmitted) {
    hmacWarnEmitted = true;
    console.warn(
      '[Transform] SCHEMA_TRANSFORM_HMAC_KEY not configured — running in degraded mode (cached transformFn integrity NOT verified). Set the env var in production.',
    );
  }
  return undefined;
}

/** Test-only escape hatch so unit tests can re-arm the warn-once flag. */
export function _resetHmacWarn(): void {
  hmacWarnEmitted = false;
}

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
 *
 * WKH-60: executed in node:vm sandbox (no `new Function`). The sandbox has
 * NO access to process / require / fetch / eval / setTimeout / globalThis.
 *
 * @throws TransformExecutionError on syntax error or runtime throw.
 * @throws TransformTimeoutError when CPU time exceeds VM_TIMEOUT_MS.
 */
function applyTransformFn(transformFn: string, output: unknown): unknown {
  return executeTransformInVm(transformFn, output, VM_TIMEOUT_MS);
}

/**
 * Calls Claude (model selected by caller) to generate a JS transform function.
 * Returns the function body as a string (to be executed by executeTransformInVm),
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
 * Returns null if not found OR if HMAC verification fails.
 *
 * @param ownerId  REQUIRED — caller's owner_ref. When undefined the caller
 *                 MUST NOT call this function (use never-cache mode).
 *                 Filters by `.eq('owner_ref', ownerId)` (4-eq chain).
 */
async function getFromL2(
  sourceAgentId: string,
  targetAgentId: string,
  schemaHashValue: string,
  ownerId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('kite_schema_transforms')
    .select('transform_fn, transform_fn_sig, hit_count')
    .eq('source_agent_id', sourceAgentId)
    .eq('target_agent_id', targetAgentId)
    .eq('schema_hash', schemaHashValue)
    .eq('owner_ref', ownerId)
    .single();

  if (error || !data) return null;

  const transformFn = data.transform_fn as string;
  const sig = data.transform_fn_sig as string | null;

  // WKH-60: integrity check. When HMAC key is configured, a row WITHOUT a sig
  // is rejected (treated as miss + warn) so a rogue admin can't bypass HMAC
  // by writing a row with NULL sig.
  const hmacKey = getHmacKey();
  if (hmacKey !== undefined) {
    if (typeof sig !== 'string' || sig.length === 0) {
      console.warn(
        `[Transform] L2 row missing transform_fn_sig (key=${sourceAgentId}:${targetAgentId}:${schemaHashValue.slice(0, 8)}…) — treating as cache miss`,
      );
      return null;
    }
    if (!verifyTransformFn(transformFn, sig, hmacKey)) {
      console.warn(
        `[Transform] L2 HMAC verify FAILED (key=${sourceAgentId}:${targetAgentId}:${schemaHashValue.slice(0, 8)}…) — treating as cache miss`,
      );
      return null;
    }
  }
  // Else degraded mode: warn-once already emitted in getHmacKey().

  // Update hit_count (fire-and-forget — no await)
  void supabase
    .from('kite_schema_transforms')
    .update({
      hit_count: (data.hit_count ?? 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('source_agent_id', sourceAgentId)
    .eq('target_agent_id', targetAgentId)
    .eq('schema_hash', schemaHashValue)
    .eq('owner_ref', ownerId);

  return transformFn;
}

/**
 * Persists a transform function to L2 (Supabase).
 * Uses upsert to handle race conditions.
 *
 * @param ownerId  REQUIRED — caller's owner_ref. When undefined the caller
 *                 MUST NOT call this function (use never-cache mode).
 */
async function persistToL2(
  sourceAgentId: string,
  targetAgentId: string,
  schemaHashValue: string,
  transformFn: string,
  ownerId: string,
): Promise<void> {
  const hmacKey = getHmacKey();
  const sig =
    hmacKey !== undefined ? signTransformFn(transformFn, hmacKey) : null;

  await supabase.from('kite_schema_transforms').upsert(
    {
      source_agent_id: sourceAgentId,
      target_agent_id: targetAgentId,
      schema_hash: schemaHashValue,
      owner_ref: ownerId,
      transform_fn: transformFn,
      transform_fn_sig: sig,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'source_agent_id,target_agent_id,schema_hash,owner_ref' },
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
 * 3. L2 hit? → apply cached fn, update L1   (only if ownerId !== undefined)
 * 4. Miss? → LLM generate → persist L2 + L1 → apply
 *
 * WKH-60 ownership scoping:
 *  - L1 cache key is `${src}:${tgt}:${hash}:${ownerId ?? '__anon__'}` so two
 *    callers with different owner_ref never share an L1 entry.
 *  - L2 read + persist are bypassed entirely when ownerId === undefined.
 *
 * @param sourceAgentId ID of the agent that produced output
 * @param targetAgentId ID of the agent that will consume the transformed output
 * @param output The raw output from the source agent
 * @param inputSchema The JSON Schema expected by the target agent
 * @param ownerId The owner_ref of the caller (a2a_agent_keys.owner_ref). When
 *                undefined (anonymous x402), L2 cache is bypassed.
 */
export async function maybeTransform(
  sourceAgentId: string,
  targetAgentId: string,
  output: unknown,
  inputSchema: Record<string, unknown> | undefined,
  ownerId?: string,
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

  // WKH-57 (DT-B): cache key includes deterministic schema fingerprint.
  // WKH-60: cache key ALSO includes ownerId so different tenants never share
  // an L1 entry.
  const schemaHashValue = schemaHash(inputSchema);
  const ownerSegment = ownerId ?? '__anon__';
  const cacheKey = `${sourceAgentId}:${targetAgentId}:${schemaHashValue}:${ownerSegment}`;

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

  // 3. L2 cache hit (Supabase) — ONLY when ownerId is defined.
  // never-cache mode for anonymous callers (x402 path) avoids leaking cached
  // fns generated for one tenant into another tenant's pipeline.
  if (ownerId !== undefined) {
    const l2Fn = await getFromL2(
      sourceAgentId,
      targetAgentId,
      schemaHashValue,
      ownerId,
    );
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
  }

  // 4. Cache miss → LLM with model selector + retry verification (WKH-57)
  const schema = inputSchema ?? {};
  const model = selectModel(inputSchema);

  // Attempt 1
  const attempt1 = await generateTransformFn(output, schema, model, []);
  const transformed1 = applyTransformFn(attempt1.fn, output);

  if (isCompatible(transformed1, inputSchema)) {
    // Happy path — persist (only when authenticated) and return.
    if (ownerId !== undefined) {
      persistToL2(
        sourceAgentId,
        targetAgentId,
        schemaHashValue,
        attempt1.fn,
        ownerId,
      ).catch((err: unknown) => {
        console.error(
          `[Transform] Failed to persist to L2 for ${cacheKey}:`,
          err,
        );
      });
      l1Cache.set(cacheKey, attempt1.fn);
    }

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
    // Retry succeeded — persist (only when authenticated) with attempt2.fn.
    if (ownerId !== undefined) {
      persistToL2(
        sourceAgentId,
        targetAgentId,
        schemaHashValue,
        attempt2.fn,
        ownerId,
      ).catch((err: unknown) => {
        console.error(
          `[Transform] Failed to persist to L2 for ${cacheKey}:`,
          err,
        );
      });
      l1Cache.set(cacheKey, attempt2.fn);
    }

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

// Re-export the VM error classes so callers (compose service, integration
// tests) can branch on TransformTimeoutError without importing vm-runner
// directly.
export { TransformExecutionError, TransformTimeoutError };

/** Clears L1 cache — for testing only */
export function _clearL1Cache(): void {
  l1Cache.clear();
}
