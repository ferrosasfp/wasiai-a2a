/**
 * Tests for Schema Transform Service — WKH-14
 * 5 tests: T-1 through T-5
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────

// Mock supabase module
vi.mock('../../lib/supabase.js', () => {
  const mockSingle = vi.fn();
  const mockEq = vi.fn();
  const mockSelect = vi.fn();
  const mockUpdate = vi.fn();
  const mockUpsert = vi.fn();
  const mockFrom = vi.fn();

  mockEq.mockReturnThis();
  mockSelect.mockReturnThis();
  mockUpdate.mockReturnThis();
  mockFrom.mockReturnValue({
    select: mockSelect,
    eq: mockEq,
    single: mockSingle,
    update: mockUpdate,
    upsert: mockUpsert,
  });

  return {
    supabase: {
      from: mockFrom,
    },
  };
});

// Mock Anthropic SDK
const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  // biome-ignore lint/complexity/useArrowFunction: must use function() for new-able mock constructor
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

import { supabase } from '../../lib/supabase.js';
// Import after mocks
import { _clearL1Cache, maybeTransform } from './transform.js';

// ─── Setup ───────────────────────────────────────────────────

function getFromMock<T>(obj: unknown, ...path: string[]): T {
  return path.reduce(
    (o: Record<string, unknown>, k) => o[k] as Record<string, unknown>,
    obj as Record<string, unknown>,
  ) as unknown as T;
}

function _setupSupabaseMiss() {
  const single = getFromMock<ReturnType<typeof vi.fn>>(
    supabase.from('x'),
    'single',
  );
  single.mockResolvedValue({
    data: null,
    error: {
      message: 'not found',
      details: '',
      hint: '',
      code: '404',
      name: 'PostgrestError',
    },
  });
}

function _setupSupabaseHit(transformFn: string, hitCount = 0) {
  const single = getFromMock<ReturnType<typeof vi.fn>>(
    supabase.from('x'),
    'single',
  );
  single.mockResolvedValue({
    data: { transform_fn: transformFn, hit_count: hitCount },
    error: null,
    count: null,
    status: 200,
    statusText: 'OK',
  });
}

function setupLLMResponse(transformFn: string) {
  mockCreate.mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify({ transformFn }) }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  _clearL1Cache();
  process.env.ANTHROPIC_API_KEY = 'test-key';

  // Re-setup from mock chain after clearAllMocks
  // Chain: from().select('...').eq('source_agent_id', x).eq('target_agent_id', y).single()
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
  const eq2 = vi.fn().mockReturnValue({ single });
  const eq1 = vi.fn().mockReturnValue({ eq: eq2, single });
  const select = vi.fn().mockReturnValue({ eq: eq1 });
  const update = vi.fn().mockReturnValue({ eq: vi.fn().mockReturnThis() });
  const upsert = vi.fn().mockResolvedValue({ error: null });
  vi.mocked(supabase.from).mockReturnValue({
    select,
    update,
    upsert,
  } as unknown as ReturnType<typeof supabase.from>);
});

// ─── Tests ───────────────────────────────────────────────────

describe('maybeTransform', () => {
  // T-1: Cache miss → LLM → persists to L2
  it('T-1: cache miss calls LLM and persists to Supabase', async () => {
    setupLLMResponse('return { query: output.text };');

    const result = await maybeTransform(
      'agent-a',
      'agent-b',
      { text: 'hello' },
      { required: ['query'], properties: { query: { type: 'string' } } },
    );

    expect(result.cacheHit).toBe(false);
    expect(result.transformedOutput).toEqual({ query: 'hello' });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(supabase.from).toHaveBeenCalledWith('kite_schema_transforms');
  });

  // T-2: L1 cache hit → no LLM call
  it('T-2: second call for same pair uses L1 cache (no LLM)', async () => {
    setupLLMResponse('return { query: output.text };');

    // First call — primes L1
    await maybeTransform(
      'agent-a',
      'agent-b',
      { text: 'hello' },
      { required: ['query'] },
    );

    vi.clearAllMocks();
    // Re-setup from mock but keep L1 (don't call _clearL1Cache)
    const single2 = vi.fn().mockResolvedValue({
      data: null,
      error: {
        message: 'not found',
        details: '',
        hint: '',
        code: '404',
        name: 'PostgrestError',
      },
    });
    const eq2b = vi.fn().mockReturnValue({ single: single2 });
    const eq1b = vi.fn().mockReturnValue({ eq: eq2b, single: single2 });
    vi.mocked(supabase.from).mockReturnValue({
      select: vi.fn().mockReturnValue({ eq: eq1b }),
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnThis() }),
      upsert: vi.fn().mockResolvedValue({ error: null }),
    } as unknown as ReturnType<typeof supabase.from>);

    // Second call — L1 hit
    const result = await maybeTransform(
      'agent-a',
      'agent-b',
      { text: 'world' },
      { required: ['query'] },
    );

    expect(result.cacheHit).toBe(true);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // T-3: L2 cache hit → no LLM call
  it('T-3: L2 Supabase hit returns transform without calling LLM', async () => {
    const single3 = vi.fn().mockResolvedValue({
      data: { transform_fn: 'return { query: output.text };', hit_count: 5 },
      error: null,
      count: null,
      status: 200,
      statusText: 'OK',
    });
    const eq2c = vi.fn().mockReturnValue({ single: single3 });
    const eq1c = vi.fn().mockReturnValue({ eq: eq2c, single: single3 });
    vi.mocked(supabase.from).mockReturnValue({
      select: vi.fn().mockReturnValue({ eq: eq1c }),
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnThis() }),
      upsert: vi.fn().mockResolvedValue({ error: null }),
    } as unknown as ReturnType<typeof supabase.from>);

    const result = await maybeTransform(
      'agent-c',
      'agent-d',
      { text: 'hello' },
      { required: ['query'] },
    );

    expect(result.cacheHit).toBe(true);
    expect(result.transformedOutput).toEqual({ query: 'hello' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // T-4: Compatible schemas → SKIPPED
  it('T-4: compatible output skips transform entirely', async () => {
    const output = { query: 'hello', context: 'world' };
    const inputSchema = {
      required: ['query'],
      properties: { query: { type: 'string' } },
    };

    const result = await maybeTransform(
      'agent-e',
      'agent-f',
      output,
      inputSchema,
    );

    expect(result.cacheHit).toBe('SKIPPED');
    expect(result.transformedOutput).toEqual(output);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(supabase.from).not.toHaveBeenCalled();
  });

  // T-5: LLM error → propagates
  it('T-5: LLM API error propagates with descriptive message', async () => {
    mockCreate.mockRejectedValue(new Error('API rate limit exceeded'));

    await expect(
      maybeTransform(
        'agent-g',
        'agent-h',
        { text: 'hello' },
        { required: ['query'] },
      ),
    ).rejects.toThrow('API rate limit exceeded');
  });
});
