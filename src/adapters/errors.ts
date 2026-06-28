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
