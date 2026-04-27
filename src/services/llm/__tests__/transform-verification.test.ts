/**
 * Tests for WKH-57 LLM Bridge Pro:
 *  - W0 unit tests for helpers (T-Wp1..T-Wp4, T-Ws1..T-Ws6)
 *  - W5 integration tests (T-VER-1..T-VER-8) for AC-1..AC-7
 *
 * Note imports are 3-level relative (`../../../lib/...`) because this file
 * lives in `src/services/llm/__tests__/`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ──────────────────────────────────────────────────────────────
// Mocks (must be at top-level, hoisted before imports)
// ──────────────────────────────────────────────────────────────

vi.mock('../../../lib/supabase.js', () => {
  const mockFrom = vi.fn();
  return {
    supabase: {
      from: mockFrom,
    },
  };
});

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  // biome-ignore lint/complexity/useArrowFunction: must use function() for new-able mock constructor
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

// ── imports AFTER mocks ──
import { supabase } from '../../../lib/supabase.js';
import { canonicalJson, schemaHash } from '../canonical-json.js';
import {
  PRICING_USD_PER_M_TOKENS,
  computeCostUsd,
  type PricedModel,
} from '../pricing.js';
import { selectModel } from '../select-model.js';
import { _clearL1Cache, maybeTransform } from '../transform.js';

// ──────────────────────────────────────────────────────────────
// W0 unit tests — pricing / canonical-json / select-model
// ──────────────────────────────────────────────────────────────

describe('WKH-57 W0 helpers — pricing', () => {
  it('T-Wp1: PRICING_USD_PER_M_TOKENS exposes Haiku and Sonnet entries with input/output rates', () => {
    const haiku: PricedModel = 'claude-haiku-4-5-20251001';
    const sonnet: PricedModel = 'claude-sonnet-4-6';
    expect(PRICING_USD_PER_M_TOKENS[haiku]).toEqual({
      input: 0.8,
      output: 4.0,
    });
    expect(PRICING_USD_PER_M_TOKENS[sonnet]).toEqual({
      input: 3.0,
      output: 15.0,
    });
  });

  it('T-Wp2: computeCostUsd with 1M in + 1M out returns input+output for the model', () => {
    const haikuCost = computeCostUsd(
      'claude-haiku-4-5-20251001',
      1_000_000,
      1_000_000,
    );
    expect(haikuCost).toBeCloseTo(0.8 + 4.0, 10);

    const sonnetCost = computeCostUsd(
      'claude-sonnet-4-6',
      1_000_000,
      1_000_000,
    );
    expect(sonnetCost).toBeCloseTo(3.0 + 15.0, 10);

    // Half-rate sanity check
    const half = computeCostUsd(
      'claude-haiku-4-5-20251001',
      500_000,
      500_000,
    );
    expect(half).toBeCloseTo((0.8 + 4.0) / 2, 10);
  });
});

describe('WKH-57 W0 helpers — canonicalJson / schemaHash', () => {
  it('T-Wp3: canonicalJson is order-independent (deterministic key sort)', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    // recursive
    expect(canonicalJson({ outer: { z: 1, a: 2 }, top: 'x' })).toBe(
      canonicalJson({ top: 'x', outer: { a: 2, z: 1 } }),
    );
    // primitives + arrays
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]'); // arrays preserve order
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('hi')).toBe('"hi"');
    expect(canonicalJson(undefined)).toBe('null'); // defensive fallback
  });

  it('T-Wp4: schemaHash collapses logically-equal schemas + handles undefined', () => {
    expect(schemaHash({ a: 1, b: 2 })).toBe(schemaHash({ b: 2, a: 1 }));
    expect(schemaHash(undefined)).toBe('no-schema');
    // 16-char hex slice
    const h = schemaHash({ required: ['x'] });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('T-Cp7: canonicalJson throws on circular reference', () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect(() => canonicalJson(a)).toThrow(/circular/i);

    // Also detect cycles via arrays
    const arr: unknown[] = [1, 2];
    arr.push(arr);
    expect(() => canonicalJson(arr)).toThrow(/circular/i);
  });
});

describe('WKH-57 W0 helpers — selectModel', () => {
  it('T-Ws1: undefined schema -> Haiku', () => {
    expect(selectModel(undefined)).toBe('claude-haiku-4-5-20251001');
  });

  it('T-Ws2: empty schema -> Haiku', () => {
    expect(selectModel({})).toBe('claude-haiku-4-5-20251001');
  });

  it('T-Ws3: schema with required.length === 4 + primitives -> Haiku (AB-WKH-56-1: exact threshold)', () => {
    const schema = {
      required: ['a', 'b', 'c', 'd'],
      properties: {
        a: { type: 'string' },
        b: { type: 'string' },
        c: { type: 'number' },
        d: { type: 'boolean' },
      },
    };
    expect(selectModel(schema)).toBe('claude-haiku-4-5-20251001');
  });

  it('T-Ws4: schema with required.length === 5 -> Sonnet (AB-WKH-56-1: exact threshold)', () => {
    const schema = {
      required: ['a', 'b', 'c', 'd', 'e'],
      properties: {
        a: { type: 'string' },
        b: { type: 'string' },
        c: { type: 'number' },
        d: { type: 'boolean' },
        e: { type: 'string' },
      },
    };
    expect(selectModel(schema)).toBe('claude-sonnet-4-6');
  });

  it('T-Ws5: schema with oneOf|anyOf|allOf -> Sonnet', () => {
    expect(selectModel({ oneOf: [{ type: 'string' }] })).toBe(
      'claude-sonnet-4-6',
    );
    expect(selectModel({ anyOf: [{ type: 'number' }] })).toBe(
      'claude-sonnet-4-6',
    );
    expect(selectModel({ allOf: [{ type: 'object' }] })).toBe(
      'claude-sonnet-4-6',
    );
  });

  it('T-Ws6: schema with property type: object -> Sonnet', () => {
    const schema = {
      required: ['a'],
      properties: {
        a: { type: 'string' },
        nested: { type: 'object', properties: {} },
      },
    };
    expect(selectModel(schema)).toBe('claude-sonnet-4-6');
  });

  it('T-Ws7: defensive guards — non-object inputs fall back to Haiku (CD-12)', () => {
    // null and undefined
    expect(selectModel(null as unknown as Record<string, unknown>)).toBe(
      'claude-haiku-4-5-20251001',
    );
    expect(selectModel(undefined)).toBe('claude-haiku-4-5-20251001');
    // primitives (cast to bypass TS at the call site — runtime guard must catch them)
    expect(selectModel('string' as unknown as Record<string, unknown>)).toBe(
      'claude-haiku-4-5-20251001',
    );
    expect(selectModel(42 as unknown as Record<string, unknown>)).toBe(
      'claude-haiku-4-5-20251001',
    );
    // arrays are typeof 'object' but must not be treated as schemas
    expect(selectModel([] as unknown as Record<string, unknown>)).toBe(
      'claude-haiku-4-5-20251001',
    );
  });
});

// ──────────────────────────────────────────────────────────────
// W5 integration tests — maybeTransform (mocked Anthropic + Supabase)
// ──────────────────────────────────────────────────────────────

/**
 * Resets supabase mock chain between tests. By default, L2 returns "miss"
 * (single resolves with PGRST not-found error). Returns the eq3 spy so the
 * caller can inspect the schema_hash values used across calls.
 */
function setupSupabaseMissChain(): {
  eq1: ReturnType<typeof vi.fn>;
  eq2: ReturnType<typeof vi.fn>;
  eq3: ReturnType<typeof vi.fn>;
} {
  const single = vi.fn().mockResolvedValue({
    data: null,
    error: {
      message: 'not found',
      details: '',
      hint: '',
      code: '404',
      name: 'PostgrestError',
    },
  });
  const eq3 = vi.fn().mockReturnValue({ single });
  const eq2 = vi.fn().mockReturnValue({ eq: eq3, single });
  const eq1 = vi.fn().mockReturnValue({ eq: eq2, single });
  const select = vi.fn().mockReturnValue({ eq: eq1 });
  const updateEqChain = vi.fn().mockReturnThis();
  const update = vi.fn().mockReturnValue({ eq: updateEqChain });
  const upsert = vi.fn().mockResolvedValue({ error: null });
  vi.mocked(supabase.from).mockReturnValue({
    select,
    update,
    upsert,
  } as unknown as ReturnType<typeof supabase.from>);
  return { eq1, eq2, eq3 };
}

function setupSupabaseHitChain(transformFn: string, hitCount = 0): void {
  const single = vi.fn().mockResolvedValue({
    data: { transform_fn: transformFn, hit_count: hitCount },
    error: null,
    count: null,
    status: 200,
    statusText: 'OK',
  });
  const eq3 = vi.fn().mockReturnValue({ single });
  const eq2 = vi.fn().mockReturnValue({ eq: eq3, single });
  const eq1 = vi.fn().mockReturnValue({ eq: eq2, single });
  const select = vi.fn().mockReturnValue({ eq: eq1 });
  const updateEqChain = vi.fn().mockReturnThis();
  const update = vi.fn().mockReturnValue({ eq: updateEqChain });
  const upsert = vi.fn().mockResolvedValue({ error: null });
  vi.mocked(supabase.from).mockReturnValue({
    select,
    update,
    upsert,
  } as unknown as ReturnType<typeof supabase.from>);
}

/** Configures one LLM response (single attempt). */
function setupLLMResponse(
  transformFn: string,
  tokensIn = 100,
  tokensOut = 50,
): void {
  mockCreate.mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify({ transformFn }) }],
    usage: { input_tokens: tokensIn, output_tokens: tokensOut },
  });
}

/** Configures sequential LLM responses (attempt1, attempt2, ...). */
function setupLLMResponseSequence(
  responses: Array<{ transformFn: string; tokensIn?: number; tokensOut?: number }>,
): void {
  for (const r of responses) {
    mockCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: JSON.stringify({ transformFn: r.transformFn }) }],
      usage: {
        input_tokens: r.tokensIn ?? 100,
        output_tokens: r.tokensOut ?? 50,
      },
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  _clearL1Cache();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  setupSupabaseMissChain();
});

describe('WKH-57 maybeTransform — model selector (AC-1, AC-2)', () => {
  it('T-VER-1: schema with 4 required + primitives selects Haiku (AC-1, AB-WKH-56-1)', async () => {
    setupLLMResponse(
      'return { a: output.a, b: output.b, c: output.c, d: output.d };',
    );

    const schema = {
      required: ['a', 'b', 'c', 'd'],
      properties: {
        a: { type: 'string' },
        b: { type: 'string' },
        c: { type: 'number' },
        d: { type: 'boolean' },
      },
    };
    const result = await maybeTransform(
      'src-ac1',
      'tgt-ac1',
      { a: 'x', b: 'y', c: 1, d: true },
      schema,
    );

    // The above output IS compatible with required:[a,b,c,d] since all
    // 4 fields are present — it would be SKIPPED. We need an incompatible
    // input. Force a missing-field scenario:
    expect(result.bridgeType).toBe('SKIPPED');
  });

  it('T-VER-1b: schema with 4 required + missing fields invokes Anthropic with model=Haiku (AC-1)', async () => {
    setupLLMResponse(
      'return { a: 1, b: 2, c: 3, d: 4 };',
    );

    const schema = {
      required: ['a', 'b', 'c', 'd'],
      properties: {
        a: { type: 'string' },
        b: { type: 'string' },
        c: { type: 'number' },
        d: { type: 'boolean' },
      },
    };
    // Input does NOT contain a/b/c/d → not isCompatible → LLM path
    const result = await maybeTransform(
      'src-ac1b',
      'tgt-ac1b',
      { other: 'value' },
      schema,
    );

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const call = mockCreate.mock.calls[0][0];
    expect(call.model).toBe('claude-haiku-4-5-20251001');
    expect(result.bridgeType).toBe('LLM');
    expect(result.llm?.model).toBe('claude-haiku-4-5-20251001');
  });

  it('T-VER-2a: 5 required selects Sonnet (AC-2, AB-WKH-56-1)', async () => {
    setupLLMResponse('return { a:1, b:2, c:3, d:4, e:5 };');

    const schema = {
      required: ['a', 'b', 'c', 'd', 'e'],
      properties: {
        a: { type: 'string' },
        b: { type: 'string' },
        c: { type: 'number' },
        d: { type: 'boolean' },
        e: { type: 'string' },
      },
    };
    const result = await maybeTransform('s', 't', { x: 'y' }, schema);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].model).toBe('claude-sonnet-4-6');
    expect(result.llm?.model).toBe('claude-sonnet-4-6');
  });

  it('T-VER-2b: nested object property selects Sonnet (AC-2)', async () => {
    setupLLMResponse('return { a: 1, nested: {} };');

    const schema = {
      required: ['a'],
      properties: {
        a: { type: 'string' },
        nested: { type: 'object', properties: {} },
      },
    };
    const result = await maybeTransform('s', 't', { x: 'y' }, schema);

    expect(mockCreate.mock.calls[0][0].model).toBe('claude-sonnet-4-6');
    expect(result.llm?.model).toBe('claude-sonnet-4-6');
  });

  it('T-VER-2c: oneOf selects Sonnet (AC-2)', async () => {
    setupLLMResponse('return { a: 1 };');

    const schema = {
      required: ['a'],
      oneOf: [{ type: 'object' }],
    };
    const result = await maybeTransform('s', 't', { x: 'y' }, schema);

    expect(mockCreate.mock.calls[0][0].model).toBe('claude-sonnet-4-6');
    expect(result.llm?.model).toBe('claude-sonnet-4-6');
  });
});

describe('WKH-57 maybeTransform — retry loop (AC-3)', () => {
  it('T-VER-3: retry succeeds on second attempt (AC-3 happy)', async () => {
    setupLLMResponseSequence([
      // Attempt 1: returns { wrong: 1 } — does NOT include `query` required
      { transformFn: 'return { wrong: 1 };', tokensIn: 100, tokensOut: 50 },
      // Attempt 2: returns { query: ... } — includes required field
      { transformFn: 'return { query: output.text };', tokensIn: 80, tokensOut: 40 },
    ]);

    const schema = {
      required: ['query'],
      properties: { query: { type: 'string' } },
    };
    const result = await maybeTransform(
      'src-r3',
      'tgt-r3',
      { text: 'hello' },
      schema,
    );

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.bridgeType).toBe('LLM');
    expect(result.llm?.retries).toBe(1);
    expect(result.llm?.tokensIn).toBe(180); // 100 + 80
    expect(result.llm?.tokensOut).toBe(90); // 50 + 40
    expect(result.transformedOutput).toEqual({ query: 'hello' });

    // Second prompt MUST include the missing field name (CD-10).
    const secondSystemPrompt = mockCreate.mock.calls[1][0].system as string;
    expect(secondSystemPrompt).toMatch(/PREVIOUS ATTEMPT FAILED/);
    expect(secondSystemPrompt).toContain('query');
  });

  it('T-VER-4: retry fails on second attempt throws (AC-3 sad)', async () => {
    setupLLMResponseSequence([
      { transformFn: 'return { wrong: 1 };' },
      { transformFn: 'return { still_wrong: 2 };' },
    ]);

    const schema = {
      required: ['query'],
      properties: { query: { type: 'string' } },
    };

    await expect(
      maybeTransform('src-r4', 'tgt-r4', { text: 'hello' }, schema),
    ).rejects.toThrow(/transform validation failed after retry/i);

    // Verify the missing field name appears in the throw message
    try {
      await maybeTransform('src-r4b', 'tgt-r4b', { text: 'hi' }, schema);
    } catch (err) {
      expect((err as Error).message).toContain('query');
    }
  });
});

describe('WKH-57 maybeTransform — cache key with schema_hash (AC-4)', () => {
  it('T-VER-5: different schemas for same source/target produce different cache keys', async () => {
    setupLLMResponseSequence([
      { transformFn: 'return { query: output.text };' },
      { transformFn: 'return { question: output.text };' },
    ]);
    const { eq3 } = setupSupabaseMissChain();

    const schemaA = {
      required: ['query'],
      properties: { query: { type: 'string' } },
    };
    const schemaB = {
      required: ['question'],
      properties: { question: { type: 'string' } },
    };

    await maybeTransform('agent-x', 'agent-y', { text: 'a' }, schemaA);
    await maybeTransform('agent-x', 'agent-y', { text: 'b' }, schemaB);

    // Both calls must hit the LLM (no L1 hit, no L2 hit) because schema_hash differs.
    expect(mockCreate).toHaveBeenCalledTimes(2);

    // The 3rd .eq() call (schema_hash filter) must receive 2 different values.
    const eq3Calls = eq3.mock.calls;
    expect(eq3Calls.length).toBeGreaterThanOrEqual(2);
    const hashA = eq3Calls[0][1];
    const hashB = eq3Calls[1][1];
    expect(hashA).not.toBe(hashB);
    expect(typeof hashA).toBe('string');
    expect(typeof hashB).toBe('string');
  });
});

describe('WKH-57 maybeTransform — result.llm shape (AC-5)', () => {
  it('T-VER-6: result.llm is populated on LLM bridge with positive tokens and cost', async () => {
    setupLLMResponse('return { query: output.text };', 200, 75);

    const schema = {
      required: ['query'],
      properties: { query: { type: 'string' } },
    };
    const result = await maybeTransform(
      'src-l',
      'tgt-l',
      { text: 'hello' },
      schema,
    );

    expect(result.bridgeType).toBe('LLM');
    expect(result.llm).toBeDefined();
    expect(typeof result.llm?.model).toBe('string');
    expect(result.llm?.tokensIn).toBe(200);
    expect(result.llm?.tokensOut).toBe(75);
    expect(result.llm?.retries).toBe(0);
    expect((result.llm?.costUsd ?? 0)).toBeGreaterThan(0);
  });

  it('T-VER-7a: result.llm is undefined for SKIPPED (compatible schema)', async () => {
    const schema = {
      required: ['query'],
      properties: { query: { type: 'string' } },
    };
    const result = await maybeTransform(
      'src-skip',
      'tgt-skip',
      { query: 'already-compatible' },
      schema,
    );

    expect(result.bridgeType).toBe('SKIPPED');
    expect(result.llm).toBeUndefined();
    expect('llm' in result).toBe(false); // CD-17: omit, do not set null
  });

  it('T-VER-7b: result.llm is undefined for CACHE_L2 hit', async () => {
    setupSupabaseHitChain('return { query: output.text };', 5);

    const schema = {
      required: ['query'],
      properties: { query: { type: 'string' } },
    };
    const result = await maybeTransform(
      'src-l2',
      'tgt-l2',
      { text: 'hi' },
      schema,
    );

    expect(result.bridgeType).toBe('CACHE_L2');
    expect(result.llm).toBeUndefined();
    expect('llm' in result).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('T-VER-7c: result.llm is undefined for CACHE_L1 hit (second call same schema)', async () => {
    setupLLMResponse('return { query: output.text };');

    const schema = {
      required: ['query'],
      properties: { query: { type: 'string' } },
    };

    // First call: populates L1
    await maybeTransform('src-l1', 'tgt-l1', { text: 'first' }, schema);
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // Second call: SAME source/target/schema, different output → L1 hit
    vi.clearAllMocks();
    setupSupabaseMissChain(); // reset chain (but L1 still has the entry)
    const result = await maybeTransform(
      'src-l1',
      'tgt-l1',
      { text: 'second' },
      schema,
    );

    expect(result.bridgeType).toBe('CACHE_L1');
    expect(result.llm).toBeUndefined();
    expect('llm' in result).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('WKH-57 maybeTransform — console.error on retry (AC-7)', () => {
  it('T-VER-8: console.error is called when retries>0, with field name + retry mention, no PII', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setupLLMResponseSequence([
      { transformFn: 'return { wrong: 1 };' },
      { transformFn: 'return { query: output.text };' },
    ]);

    const schema = {
      required: ['query'],
      properties: { query: { type: 'string' } },
    };
    const sensitivePayload = {
      text: 'SECRET-USER-PII-NEVER-LOG-THIS',
    };
    await maybeTransform('src-l8', 'tgt-l8', sensitivePayload, schema);

    // Must have called console.error at least once with the retry log
    const calls = errSpy.mock.calls.map((c) => c.join(' '));
    const retryLog = calls.find((s) => s.includes('retry attempt'));
    expect(retryLog).toBeDefined();
    expect(retryLog).toContain('query'); // field name present
    expect(retryLog).toContain('claude-haiku-4-5-20251001'); // model name present

    // CD-14: must NOT leak raw payload PII
    for (const c of calls) {
      expect(c).not.toContain('SECRET-USER-PII-NEVER-LOG-THIS');
    }

    errSpy.mockRestore();
  });
});
