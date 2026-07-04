/**
 * Adapter-layer typed errors.
 *
 * `GaslessNotSupportedError` is thrown by chain adapters whose gasless module
 * is a stub (Base/Avalanche MVP). It carries `statusCode` + `code` so the
 * global error boundary (src/middleware/error-boundary.ts) surfaces a
 * well-formed `501` JSON body — `{ error, code, requestId }` — instead of an
 * opaque `500`. This does NOT implement gasless; it only ensures the
 * unsupported path fails cleanly.
 */
export class GaslessNotSupportedError extends Error {
  readonly statusCode = 501;
  readonly code = 'gasless_not_supported_on_chain';
  readonly chain: string;

  constructor(chain: string, message: string) {
    super(message);
    this.name = 'GaslessNotSupportedError';
    this.chain = chain;
  }
}

/**
 * `GaslessTransferError` is thrown by chain adapters whose gasless module is
 * IMPLEMENTED (Avalanche/Base, WKH-138) when the on-chain sign/submit/receipt
 * step fails: signature error, `writeContract` reject, on-chain revert, or
 * receipt timeout. It carries `statusCode` + `code` for a well-formed body if
 * ever surfaced by the error boundary — but the `routes/gasless.ts` handler
 * already catches and returns a generic `500 gasless transfer failed`, so this
 * error is primarily a typed signal for logging/tests (distinct from
 * `GaslessNotSupportedError`, which is the stub/501 path).
 */
export class GaslessTransferError extends Error {
  readonly statusCode = 500;
  readonly code = 'gasless_transfer_failed';
  readonly chain: string;

  constructor(chain: string, message: string) {
    super(message);
    this.name = 'GaslessTransferError';
    this.chain = chain;
  }
}
