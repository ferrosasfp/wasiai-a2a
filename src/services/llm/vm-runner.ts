/**
 * VM Runner — WKH-60 / SEC-RCE-1
 *
 * Standalone helper to execute LLM-generated transform functions in an
 * isolated `node:vm` context. Replaces `new Function('output', body)` which
 * shares the calling realm's globals (process, require, fetch, eval,
 * setTimeout, etc) and is therefore equivalent to RCE if the LLM is
 * prompt-injected.
 *
 * Hardening:
 *  - `vm.runInNewContext` with an empty sandbox containing only `output`.
 *  - `timeout` aborts infinite loops (synchronous CPU time only — async work
 *    cannot escape the sandbox because the sandbox has no timer/promise APIs).
 *  - `contextCodeGeneration: { strings: false, wasm: false }` blocks
 *    `eval`, `new Function`, and `WebAssembly.compile` from inside the
 *    transformFn.
 *  - The body is wrapped in `(function(output){ ... })(output)` so a transformFn
 *    that uses bare `return` (the format Anthropic returns for backwards-compat
 *    with `new Function`) still works.
 *
 * Note: the sandbox starts empty, so `process`, `require`, `fetch`, `import`,
 * `globalThis`, etc. are `undefined` inside the transformFn. Any attempt to
 * reference them throws a `ReferenceError`, which we re-wrap as
 * `TransformExecutionError`.
 */

import * as vm from 'node:vm';

/**
 * Thrown when the transformFn raises any error during execution
 * (ReferenceError, TypeError, syntax errors at compile time, throws inside
 * the function body, etc).
 *
 * The original error is preserved in `cause` for telemetry — but callers
 * MUST NOT leak `cause.message` into HTTP responses (CD-14): it can echo
 * adversarial payload fragments.
 */
export class TransformExecutionError extends Error {
  public readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'TransformExecutionError';
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * Thrown when the transformFn exceeds the configured CPU-time budget.
 * Distinct from `TransformExecutionError` so the bridge can surface a
 * specific telemetry signal (`bridge_error: 'TIMEOUT'`).
 */
export class TransformTimeoutError extends Error {
  public readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`transform execution timed out after ${timeoutMs}ms`);
    this.name = 'TransformTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Execute a transform function body in an isolated VM context.
 *
 * @param transformFnBody  Function body as returned by the LLM. The body is
 *                         wrapped in `(function(output){ <body> })(output)`
 *                         so bare `return` statements work.
 * @param output           Input value bound to the `output` variable inside
 *                         the sandbox. Passed by reference — the transformFn
 *                         CAN mutate nested objects, so the caller MUST treat
 *                         the original `output` as poisoned post-call.
 * @param timeoutMs        Synchronous CPU-time budget. Must be > 0.
 *
 * @throws TransformExecutionError  on syntax error, ReferenceError, runtime throw.
 * @throws TransformTimeoutError    when CPU time exceeds `timeoutMs`.
 */
export function executeTransformInVm(
  transformFnBody: string,
  output: unknown,
  timeoutMs: number,
): unknown {
  if (typeof transformFnBody !== 'string') {
    throw new TransformExecutionError(
      'transformFnBody must be a string',
    );
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TransformExecutionError(
      `timeoutMs must be a positive finite number, got ${String(timeoutMs)}`,
    );
  }

  // Sandbox contains ONLY `output`. No process / require / fetch / eval /
  // setTimeout / globalThis / etc. Each call gets a fresh sandbox so the
  // transformFn cannot persist state across invocations.
  const sandbox: { output: unknown } = { output };
  const context = vm.createContext(sandbox, {
    codeGeneration: { strings: false, wasm: false },
  });

  // Wrap so `return ...;` at the top of `transformFnBody` works (this is the
  // shape Anthropic returns — see generateTransformFn).
  const wrapped = `(function(output){ ${transformFnBody} })(output)`;

  try {
    return vm.runInContext(wrapped, context, {
      timeout: timeoutMs,
      displayErrors: false,
    });
  } catch (err) {
    // node:vm throws an Error with code 'ERR_SCRIPT_EXECUTION_TIMEOUT' when
    // the timeout fires. The error object on Node 20+ has `.code` for that
    // case; fall back to message-string match for forward-compat.
    const e = err as { code?: string; message?: string };
    if (
      e?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ||
      (typeof e?.message === 'string' && e.message.includes('Script execution timed out'))
    ) {
      throw new TransformTimeoutError(timeoutMs);
    }
    throw new TransformExecutionError(
      'transform function threw during execution',
      err,
    );
  }
}
