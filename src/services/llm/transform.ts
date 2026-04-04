/**
 * Schema Transform Service — WKH-14
 *
 * Uses Claude Sonnet to generate a JS transform function when the output
 * of step N is incompatible with the inputSchema of step N+1.
 * Caches transforms in-memory (L1) and in Supabase kite_schema_transforms (L2).
 */

import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../../lib/supabase.js'
import type { TransformResult } from '../../types/index.js'

const MODEL = 'claude-sonnet-4-20250514'
const TIMEOUT_MS = 30_000

// ─── L1 In-memory cache ────────────────────────────────────────
// Key: `${sourceAgentId}:${targetAgentId}`
const l1Cache = new Map<string, string>()

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
  if (!inputSchema) return true
  if (typeof output !== 'object' || output === null) return false

  const required = inputSchema['required']
  if (!Array.isArray(required) || required.length === 0) return true

  const outputKeys = new Set(Object.keys(output as Record<string, unknown>))
  return required.every((key: unknown) => typeof key === 'string' && outputKeys.has(key))
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
  const fn = new Function('output', transformFn)
  return fn(output) as unknown
}

/**
 * Calls Claude Sonnet to generate a JS transform function.
 * Returns the function body as a string (to be used with new Function('output', body)).
 *
 * @throws on API error, timeout, or invalid JSON response
 */
async function generateTransformFn(
  output: unknown,
  inputSchema: Record<string, unknown>,
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured')
  }

  const client = new Anthropic({ apiKey })

  const systemPrompt =
    'Eres un experto en transformación de schemas JSON. Dado un valor de output y un inputSchema JSON Schema, genera SOLO el cuerpo de una función JavaScript (sin declaración de función) que recibe `output` y retorna el objeto transformado para satisfacer el inputSchema. Responde SOLO con JSON válido, sin markdown.'

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
`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      },
      { signal: controller.signal },
    )

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('')
      .trim()

    const parsed = JSON.parse(text) as Record<string, unknown>

    const fn = parsed['transformFn']
    if (typeof fn !== 'string' || fn.trim().length === 0) {
      throw new Error('LLM returned empty or invalid transformFn')
    }

    return fn
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Retrieves transform function from L2 (Supabase), updates hit_count.
 * Returns null if not found.
 */
async function getFromL2(
  sourceAgentId: string,
  targetAgentId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('kite_schema_transforms')
    .select('transform_fn, hit_count')
    .eq('source_agent_id', sourceAgentId)
    .eq('target_agent_id', targetAgentId)
    .single()

  if (error || !data) return null

  // Update hit_count (fire-and-forget — no await)
  void supabase
    .from('kite_schema_transforms')
    .update({
      hit_count: (data.hit_count ?? 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('source_agent_id', sourceAgentId)
    .eq('target_agent_id', targetAgentId)

  return data.transform_fn as string
}

/**
 * Persists a transform function to L2 (Supabase).
 * Uses upsert to handle race conditions.
 */
async function persistToL2(
  sourceAgentId: string,
  targetAgentId: string,
  transformFn: string,
): Promise<void> {
  await supabase
    .from('kite_schema_transforms')
    .upsert(
      {
        source_agent_id: sourceAgentId,
        target_agent_id: targetAgentId,
        transform_fn: transformFn,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'source_agent_id,target_agent_id' },
    )
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
  const start = Date.now()

  // 1. Compatible? → skip
  if (isCompatible(output, inputSchema)) {
    return {
      transformedOutput: output,
      cacheHit: 'SKIPPED',
      latencyMs: Date.now() - start,
    }
  }

  const cacheKey = `${sourceAgentId}:${targetAgentId}`

  // 2. L1 cache hit
  const l1Fn = l1Cache.get(cacheKey)
  if (l1Fn) {
    const transformedOutput = applyTransformFn(l1Fn, output)
    return {
      transformedOutput,
      cacheHit: true,
      latencyMs: Date.now() - start,
    }
  }

  // 3. L2 cache hit (Supabase)
  const l2Fn = await getFromL2(sourceAgentId, targetAgentId)
  if (l2Fn) {
    l1Cache.set(cacheKey, l2Fn)
    const transformedOutput = applyTransformFn(l2Fn, output)
    return {
      transformedOutput,
      cacheHit: true,
      latencyMs: Date.now() - start,
    }
  }

  // 4. Cache miss → LLM
  const schema = inputSchema ?? {}
  const transformFn = await generateTransformFn(output, schema)

  // Persist async to L2 (don't block on this)
  persistToL2(sourceAgentId, targetAgentId, transformFn).catch((err: unknown) => {
    console.error(`[Transform] Failed to persist to L2 for ${cacheKey}:`, err)
  })

  // Update L1
  l1Cache.set(cacheKey, transformFn)

  const transformedOutput = applyTransformFn(transformFn, output)
  return {
    transformedOutput,
    cacheHit: false,
    latencyMs: Date.now() - start,
  }
}

/** Clears L1 cache — for testing only */
export function _clearL1Cache(): void {
  l1Cache.clear()
}
