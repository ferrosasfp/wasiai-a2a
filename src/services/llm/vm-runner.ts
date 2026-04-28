/**
 * VM Runner — WKH-60 / SEC-RCE-1 (hardened post-AR)
 *
 * Standalone helper to execute LLM-generated transform functions in an
 * isolated `worker_threads` Worker that, in turn, runs the body inside a
 * `node:vm` context. Replaces `new Function('output', body)` which shares the
 * calling realm's globals (process, require, fetch, eval, setTimeout, etc.)
 * and is therefore equivalent to RCE if the LLM is prompt-injected.
 *
 * ## Why worker_threads + vm (and not just vm)
 *
 * `node:vm` alone does NOT provide a security boundary (Node.js docs are
 * explicit about this). Three classes of escape were verified pre-fix:
 *
 *  1. Host-realm prototype chain — `output.constructor.constructor("...")()`
 *     reaches the calling realm's `Function` constructor and gains full
 *     access to `process`, `require`, etc., bypassing the empty sandbox.
 *
 *  2. Microtask escape — `Promise.resolve().then(exfil)` schedules a
 *     callback in the calling realm's microtask queue. The vm `timeout`
 *     option only kills synchronous CPU; the microtask fires AFTER
 *     `runInContext` returns, mutating shared objects post-hoc.
 *
 *  3. IIFE wrapper breakout — `})(output); ATTACK; (function(o){` closes
 *     the wrapper IIFE, runs arbitrary code in the outer scope of the
 *     compiled script (still inside vm but with the same prototype-chain
 *     issue as #1), and re-opens an empty IIFE so the wrapper template
 *     parses correctly.
 *
 * The fix combines two layers:
 *
 *  - **Worker thread isolation.** Each transform runs in a separate Node
 *    worker. `worker.terminate()` synchronously kills the thread including
 *    every pending microtask, timer, and Promise callback. This closes #2.
 *    A `resourceLimits` cap also caps heap so a malicious body cannot OOM
 *    the parent process.
 *
 *  - **vm context inside the worker, with `output` parsed INSIDE the
 *    context.** The body runs in `vm.runInContext` with
 *    `codeGeneration: { strings: false, wasm: false }`, so `eval`,
 *    `new Function`, and `Function` (called as a constructor — including
 *    via `output.constructor.constructor`) all throw "Code generation from
 *    strings disallowed" inside the vm. CRUCIALLY, `output` is serialized
 *    to JSON in the worker and parsed back via `JSON.parse(...)` inside the
 *    vm context, so its prototype chain comes from the vm realm's
 *    `Object.prototype` (not the worker realm). This closes #1 and #3.
 *
 * The wrapper template
 *   `var output = JSON.parse('<json>'); (function(output){ <body> })(output)`
 * is robust against IIFE breakout: even if the body closes the IIFE and
 * tries to call `output.constructor.constructor("...")`, the constructor is
 * the vm-realm `Function` whose `[[Call]]` is gated by codeGeneration.
 *
 * ## Performance
 *
 * Worker startup is ~5–15 ms per call. Acceptable because every call here
 * is on the LLM-bridge path (one Anthropic request is ~1500 ms), and the
 * worker only runs on cache MISS. L1 / L2 hits never reach this code path
 * — wait, they do: `applyTransformFn` is called for cached fns too, so the
 * worker overhead is paid on every transform. If this becomes a hotspot,
 * pool the worker (out of scope for this fix).
 *
 * ## API stability
 *
 * The exported function name `executeTransformInVm` is preserved for the
 * callers in `transform.ts`. The signature changed from synchronous to
 * `Promise<unknown>` because workers are inherently async; all callers
 * already live inside the async `maybeTransform`, so the callers `await`
 * the result.
 */

import { Worker } from 'node:worker_threads';

/**
 * Thrown when the transformFn raises any error during execution
 * (ReferenceError, TypeError, syntax errors at compile time, throws inside
 * the function body, worker-side error events, etc).
 *
 * The original error is preserved in `cause` for telemetry — but callers
 * MUST NOT leak `cause.message` into HTTP responses (CD-14): it can echo
 * adversarial payload fragments.
 */
export class TransformExecutionError extends Error {
  // We keep `cause` as a public read-only field for forward-compat with
  // the Error.cause builtin (Node 16.9+), so callers can both
  //   err.cause                    (from the standard Error.cause)
  // and
  //   (err as TransformExecutionError).cause
  // without surprises. The constructor uses the second-arg `{ cause }`
  // form when supplied so the cause is also visible to native tooling
  // (util.inspect, error chaining, etc).
  public readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'TransformExecutionError';
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * Thrown when the transformFn exceeds the configured CPU-time budget OR
 * when the worker itself fails to settle within the budget (in which case
 * the parent terminates it). Distinct from `TransformExecutionError` so
 * the bridge can surface a specific telemetry signal
 * (`bridge_error: 'TIMEOUT'`).
 */
export class TransformTimeoutError extends Error {
  public readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`transform execution timed out after ${timeoutMs}ms`);
    this.name = 'TransformTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

// ─── Worker script ──────────────────────────────────────────────
// Inline script string evaluated by the Worker (`eval: true`). Uses
// CommonJS require because workers spawned with `eval: true` always run as
// CommonJS regardless of the parent's package type. This avoids needing a
// separate compiled .js file in dist/, keeps the security-critical code
// next to its caller, and keeps the build pipeline unchanged.
//
// The script:
//   1. Receives { body, output, timeoutMs } via workerData.
//   2. Builds a vm context with codeGeneration disabled.
//   3. Constructs a script that parses `output` from a JSON string INSIDE
//      the vm context, so the resulting object inherits from the vm
//      realm's Object.prototype (whose Function ctor is gated).
//   4. Wraps the body in `(function(output){ <body> })(output)` so a body
//      that uses bare `return` (the format Anthropic returns) works.
//   5. Runs the script with vm's own `timeout` for sync CPU. The worker
//      terminate() in the parent is the kill-switch for async leaks.
//   6. Posts back {ok, value} or {ok:false, error}. The value is JSON
//      round-tripped on the way out so the parent never sees vm-realm
//      objects (which would otherwise leak through if the body returned a
//      proxy or an object with a custom toJSON, etc).
const WORKER_SCRIPT = `
  const { parentPort, workerData } = require('node:worker_threads');
  const vm = require('node:vm');

  try {
    const sandbox = {};
    const ctx = vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
    });

    // Serialize output to JSON in the worker realm, then JSON.parse INSIDE
    // the vm context. The parsed object's prototype chain belongs to the
    // vm realm — its constructor.constructor is the vm-realm Function,
    // which is blocked by codeGeneration.strings = false. This closes the
    // host-realm prototype-chain escape.
    //
    // We embed the JSON string with JSON.stringify-of-a-string (double
    // encoding) so the resulting source code is a literal string with all
    // quotes, backslashes, and control characters escaped — never a
    // template that the LLM body could break out of by injecting closing
    // quotes into the input itself.
    const outputJSON = JSON.stringify(workerData.output);
    const wrapped =
      'var output = JSON.parse(' + JSON.stringify(outputJSON) + ');' +
      '(function(output){ ' + workerData.body + ' })(output)';

    const result = vm.runInContext(wrapped, ctx, {
      timeout: workerData.timeoutMs,
      displayErrors: false,
    });

    // Round-trip the result so the parent receives a structured-clone-safe
    // POJO. undefined → null because postMessage cannot transfer undefined
    // at the top level cleanly.
    const safeResult = result === undefined ? null : JSON.parse(JSON.stringify(result));
    parentPort.postMessage({ ok: true, value: safeResult });
  } catch (err) {
    const code = err && err.code ? String(err.code) : '';
    const message = err && err.message ? String(err.message) : String(err);
    parentPort.postMessage({ ok: false, error: message, code });
  }
`;

// Internal payload shape the worker posts back. Kept private because
// callers only see the resolved value or thrown error.
interface WorkerOk {
  ok: true;
  value: unknown;
}
interface WorkerErr {
  ok: false;
  error: string;
  code: string;
}
type WorkerMsg = WorkerOk | WorkerErr;

/**
 * Execute a transform function body in an isolated worker_threads Worker
 * that internally runs `node:vm` with a restricted context.
 *
 * @param transformFnBody  Function body as returned by the LLM. The body is
 *                         wrapped in `(function(output){ <body> })(output)`
 *                         INSIDE the vm context so bare `return` works.
 * @param output           Input value bound to the `output` variable inside
 *                         the sandbox. JSON-cloned twice on the way in
 *                         (once into `workerData`, once via `JSON.parse`
 *                         inside the vm) so the body NEVER receives a
 *                         reference to the parent's object — this means
 *                         mutations inside the body are not visible to the
 *                         caller (a behavioural change vs the legacy
 *                         `new Function` path, where mutations leaked).
 * @param timeoutMs        Synchronous CPU-time budget. Must be > 0. The
 *                         vm-level timeout enforces sync CPU; the worker
 *                         terminate() (parent-side, after `timeoutMs +
 *                         WORKER_KILL_GRACE_MS`) enforces async cleanup.
 *
 * @throws TransformExecutionError  on syntax error, ReferenceError, runtime
 *                                  throw, worker error event, or non-zero
 *                                  exit code.
 * @throws TransformTimeoutError    when CPU time exceeds `timeoutMs` (the
 *                                  vm-level timeout fires) OR the worker
 *                                  fails to settle in time (the parent
 *                                  kill-switch fires).
 */
export async function executeTransformInVm(
  transformFnBody: string,
  output: unknown,
  timeoutMs: number,
): Promise<unknown> {
  if (typeof transformFnBody !== 'string') {
    throw new TransformExecutionError('transformFnBody must be a string');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TransformExecutionError(
      `timeoutMs must be a positive finite number, got ${String(timeoutMs)}`,
    );
  }

  // Pre-clone output in the parent so any custom toJSON / getters / proxy
  // traps run in the parent realm (where they have no privileges they
  // didn't already have) BEFORE the value crosses into the worker. This
  // makes workerData a structured-clone-safe POJO.
  let safeInput: unknown;
  try {
    safeInput = JSON.parse(JSON.stringify(output));
  } catch (err) {
    throw new TransformExecutionError('output is not JSON-serializable', err);
  }

  // Parent-side kill-switch: fires `WORKER_KILL_GRACE_MS` after the vm
  // timeout window, so the worker has a chance to settle naturally first.
  const WORKER_KILL_GRACE_MS = 500;

  return new Promise<unknown>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(WORKER_SCRIPT, {
        eval: true,
        workerData: { body: transformFnBody, output: safeInput, timeoutMs },
        // Cap heap so a malicious body cannot OOM the parent. 64 MB old
        // gen + 16 MB young gen is generous for JSON-shape transforms;
        // anything larger should be a red flag.
        resourceLimits: {
          maxOldGenerationSizeMb: 64,
          maxYoungGenerationSizeMb: 16,
        },
      });
    } catch (err) {
      reject(
        new TransformExecutionError('failed to start transform worker', err),
      );
      return;
    }

    let settled = false;

    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      // terminate is async but we don't need to await it — the worker
      // is already done logically, and termination is best-effort
      // cleanup. Swallow the unhandled rejection just in case.
      void worker.terminate().catch(() => {
        /* terminate already-terminated worker is safe to ignore */
      });
      action();
    };

    const killTimer = setTimeout(() => {
      settle(() => reject(new TransformTimeoutError(timeoutMs)));
    }, timeoutMs + WORKER_KILL_GRACE_MS);

    worker.on('message', (msg: WorkerMsg) => {
      settle(() => {
        if (msg.ok) {
          resolve(msg.value);
          return;
        }
        // Distinguish vm-level timeout (ERR_SCRIPT_EXECUTION_TIMEOUT)
        // from generic execution errors so the caller can surface the
        // right telemetry signal.
        if (
          msg.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ||
          /Script execution timed out/i.test(msg.error)
        ) {
          reject(new TransformTimeoutError(timeoutMs));
          return;
        }
        reject(
          new TransformExecutionError(
            'transform function threw during execution',
            new Error(msg.error),
          ),
        );
      });
    });

    worker.on('error', (err) => {
      // Worker-level errors (uncaught exception in the worker script
      // itself, before our try/catch can post a message). Should be
      // rare given the worker script is wrapped in try/catch, but
      // OOM (resourceLimits) reaches here.
      settle(() =>
        reject(
          new TransformExecutionError('worker emitted an error event', err),
        ),
      );
    });

    worker.on('exit', (code) => {
      // Non-zero exit without a prior message means the worker died
      // without reporting (e.g. resourceLimits OOM, native crash). We
      // still want the parent to learn about it.
      if (code === 0) return;
      settle(() =>
        reject(
          new TransformExecutionError(
            `worker exited with non-zero code ${code}`,
          ),
        ),
      );
    });
  });
}
