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

function setupLLMResponse(transformFn: string) {
  mockCreate.mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify({ transformFn }) }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  _clearL1Cache();
  process.env.ANTHROPIC_API_KEY = 'test-key';

  // Re-setup from mock chain after clearAllMocks.
  // WKH-57 W2: cache key includes schema_hash.
  // WKH-60 W3: cache key ALSO includes owner_ref → 4-eq chain
  // (source_agent_id, target_agent_id, schema_hash, owner_ref) before .single().
  // Chain: from().select(...).eq(src).eq(tgt).eq(hash).eq(owner).single()
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
  const eq4 = vi.fn().mockReturnValue({ single });
  const eq3 = vi.fn().mockReturnValue({ eq: eq4, single });
  const eq2 = vi.fn().mockReturnValue({ eq: eq3, single });
  const eq1 = vi.fn().mockReturnValue({ eq: eq2, single });
  const select = vi.fn().mockReturnValue({ eq: eq1 });
  // Update chain (fire-and-forget): .update().eq().eq().eq().eq()
  const updateEqChain = vi.fn().mockReturnThis();
  const update = vi.fn().mockReturnValue({ eq: updateEqChain });
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

    // WKH-60: pass ownerId so the L2 path (read + persist) runs.
    const result = await maybeTransform(
      'agent-a',
      'agent-b',
      { text: 'hello' },
      { required: ['query'], properties: { query: { type: 'string' } } },
      'tenant-1',
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

    // First call — primes L1 (ownerId required for L1 to be populated; the
    // implementation only writes L1 when persistence is enabled, i.e. when
    // ownerId is defined).
    await maybeTransform(
      'agent-a',
      'agent-b',
      { text: 'hello' },
      { required: ['query'] },
      'tenant-1',
    );

    vi.clearAllMocks();
    // Re-setup from mock but keep L1 (don't call _clearL1Cache).
    // WKH-60 W3: 4-eq chain incl. schema_hash + owner_ref.
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
    const eq4b = vi.fn().mockReturnValue({ single: single2 });
    const eq3b = vi.fn().mockReturnValue({ eq: eq4b, single: single2 });
    const eq2b = vi.fn().mockReturnValue({ eq: eq3b, single: single2 });
    const eq1b = vi.fn().mockReturnValue({ eq: eq2b, single: single2 });
    vi.mocked(supabase.from).mockReturnValue({
      select: vi.fn().mockReturnValue({ eq: eq1b }),
      update: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnThis() }),
      upsert: vi.fn().mockResolvedValue({ error: null }),
    } as unknown as ReturnType<typeof supabase.from>);

    // Second call — L1 hit (same ownerId)
    const result = await maybeTransform(
      'agent-a',
      'agent-b',
      { text: 'world' },
      { required: ['query'] },
      'tenant-1',
    );

    expect(result.cacheHit).toBe(true);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // T-3: L2 cache hit → no LLM call
  it('T-3: L2 Supabase hit returns transform without calling LLM', async () => {
    // WKH-60 W3: 4-eq chain incl. schema_hash + owner_ref.
    // The row already has a transform_fn_sig in case HMAC is configured —
    // when it isn't (default in tests), the field is ignored and the body
    // is trusted (degraded mode warn-once).
    const single3 = vi.fn().mockResolvedValue({
      data: {
        transform_fn: 'return { query: output.text };',
        transform_fn_sig: null,
        hit_count: 5,
      },
      error: null,
      count: null,
      status: 200,
      statusText: 'OK',
    });
    const eq4c = vi.fn().mockReturnValue({ single: single3 });
    const eq3c = vi.fn().mockReturnValue({ eq: eq4c, single: single3 });
    const eq2c = vi.fn().mockReturnValue({ eq: eq3c, single: single3 });
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
      'tenant-1',
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
