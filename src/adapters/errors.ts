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
 * HU-192: ¿qué le pasó al VALOR del transfer cuando el gasless falló?
 *
 * Existe porque `routes/gasless.ts` reembolsa el débito del caller cuando el
 * transfer falla, y ese refund SÓLO es correcto si el valor NO salió del wallet
 * del operador. Si la tx ya se broadcasteó y su suerte es desconocida (timeout
 * de receipt, relayer que no contestó), reembolsar podría pagar dos veces: el
 * destinatario recibe los tokens Y el caller recupera su budget.
 *
 *   - `'not-moved'`: el valor NO se movió y NO puede moverse por este intento.
 *     Falla ANTES del broadcast (cap/mínimo/wallet/firma/gas insuficiente) o
 *     revert on-chain confirmado (la tx existe pero no transfirió nada).
 *     ⟹ el débito del caller es reembolsable.
 *   - `'unknown'`: la tx se broadcasteó (o pudo haberse broadcasteado) y no
 *     sabemos si se confirmó. ⟹ NO reembolsable inline; queda un log loud para
 *     reconciliación manual/on-chain.
 *
 * REGLA para adapters nuevos: el parámetro es OBLIGATORIO a propósito. Si estás
 * agregando un throw después de haber mandado la tx a la red y no sabés si
 * aterrizó, es `'unknown'`. Nunca pongas `'not-moved'` "por si acaso": eso
 * infla el budget del caller, que es peor que no reembolsarle.
 */
export type GaslessValueDisposition = 'not-moved' | 'unknown';

/**
 * `GaslessTransferError` is thrown by chain adapters whose gasless module is
 * IMPLEMENTED (Avalanche/Base, WKH-138) when the on-chain sign/submit/receipt
 * step fails: signature error, `writeContract` reject, on-chain revert, or
 * receipt timeout. It carries `statusCode` + `code` for a well-formed body if
 * ever surfaced by the error boundary — but the `routes/gasless.ts` handler
 * already catches and returns a generic `500 gasless transfer failed`, so this
 * error is primarily a typed signal for logging/tests (distinct from
 * `GaslessNotSupportedError`, which is the stub/501 path).
 *
 * HU-192: además transporta `valueDisposition`, que decide si el débito del
 * caller se reembolsa (ver `GaslessValueDisposition`).
 */
export class GaslessTransferError extends Error {
  readonly statusCode = 500;
  readonly code = 'gasless_transfer_failed';
  readonly chain: string;
  readonly valueDisposition: GaslessValueDisposition;

  constructor(
    chain: string,
    message: string,
    valueDisposition: GaslessValueDisposition,
  ) {
    super(message);
    this.name = 'GaslessTransferError';
    this.chain = chain;
    this.valueDisposition = valueDisposition;
  }
}
