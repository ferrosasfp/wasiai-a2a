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

/**
 * HU-198: lee la disposición del valor de un error del camino GASLESS, o
 * `undefined` si el error no la aporta.
 *
 * ⚠️ POR QUÉ NO ES UN `instanceof` A SECAS: idéntico motivo que
 * `readSettleValueDisposition` (abajo) — `instanceof` compara identidad de CLASE, y
 * esa identidad es por-registro-de-módulos, así que un consumidor cargado con
 * `vi.resetModules()` + `import()` dinámico (o dos copias del paquete en el árbol de
 * dependencias) ve otra clase y el `instanceof` da `false`.
 *
 * DIRECCIÓN DEL FALLO ACÁ (documentada porque es lo contrario de lo que parece):
 * `routes/gasless.ts` defaultea a `'unknown'` y sólo reembolsa con `'not-moved'`, así
 * que un `instanceof` que falla NO produce un reembolso indebido: produce un reembolso
 * OMITIDO. O sea que el bug no puede pagar dos veces — deja al caller cobrado por un
 * transfer que PROBADAMENTE no se movió, y en silencio. Sigue siendo plata que le
 * debemos al caller, por eso se arregla; pero la severidad es "under-refund", no
 * "double-pay".
 *
 * `GaslessNotSupportedError` es el stub que tira ANTES de tocar la red ⟹ `'not-moved'`.
 */
export function readGaslessValueDisposition(
  err: unknown,
): GaslessValueDisposition | undefined {
  if (err instanceof GaslessTransferError) return err.valueDisposition;
  if (err instanceof GaslessNotSupportedError) return 'not-moved';
  if (!err || typeof err !== 'object') return undefined;
  const candidate = err as { name?: unknown; valueDisposition?: unknown };
  if (candidate.name === 'GaslessTransferError') {
    return candidate.valueDisposition === 'not-moved' ||
      candidate.valueDisposition === 'unknown'
      ? candidate.valueDisposition
      : undefined;
  }
  if (candidate.name === 'GaslessNotSupportedError') return 'not-moved';
  return undefined;
}

/**
 * HU-198: ¿qué le pasó al VALOR cuando el hop HTTP al facilitator NO contestó?
 *
 * MISMA FORMA que `GaslessValueDisposition` (arriba) y por la MISMA razón, pero
 * para el otro eje: allá el broadcast lo hace el gateway con viem, acá lo hace un
 * TERCERO (el facilitator) y nosotros sólo esperamos su respuesta HTTP.
 *
 * EL HECHO MECÁNICO que obliga a distinguir: **abortar el request HTTP al
 * facilitator NO cancela un broadcast**. Cuando el techo de wall-clock corta la
 * espera de `POST /settle`, la plata puede haber salido igual; lo único que
 * perdimos es la RESPUESTA que traía el `txHash`. O sea que el gateway no pasa de
 * "pagó" a "no pagó", pasa de "sé el resultado" a "NO sé el resultado".
 *
 *   - `'not-sent'`: el request PROBADAMENTE nunca llegó al facilitator (DNS que no
 *     resuelve, conexión rechazada, URL inválida) ⟹ no hubo broadcast ⟹ el leg se
 *     puede tratar como no pagado y reintentar.
 *   - `'unknown'`: el request SALIÓ y no sabemos qué pasó del otro lado (techo de
 *     wall-clock, socket cortado a mitad, error no clasificable) ⟹ el pago PUDO
 *     haberse ejecutado. PROHIBIDO reintentarlo a ciegas (doble pago) y PROHIBIDO
 *     marcarlo como "no cobrado" (el destinatario puede tener la plata).
 *
 * REGLA para clasificar caminos nuevos (espejo de `GaslessValueDisposition`): el
 * default es `'unknown'`. `'not-sent'` se reserva para el error que DEMUESTRA que
 * no hubo request; nunca se pone "por si acaso", porque un `'not-sent'` falso es
 * lo que habilita el doble pago.
 */
export type SettleValueDisposition = 'not-sent' | 'unknown';

/**
 * Error del hop HTTP a un facilitator de settlement cuando NO hubo respuesta
 * (transporte). Transporta `valueDisposition` para que el consumidor decida sin
 * parsear mensajes de error: un `catch (e)` que sólo mira `e.message` no puede
 * distinguir "no salió" de "no sé", y esa es exactamente la decisión de dinero.
 *
 * NO se usa para un facilitator que SÍ contestó rechazando (HTTP 4xx/5xx con
 * cuerpo, `{ success: false }`): eso es un veredicto del facilitator, no una
 * incógnita de transporte, y sigue por el camino de error preexistente.
 */
export class FacilitatorSettleError extends Error {
  readonly code = 'facilitator_settle_transport_error';
  readonly valueDisposition: SettleValueDisposition;

  constructor(message: string, valueDisposition: SettleValueDisposition) {
    super(message);
    this.name = 'FacilitatorSettleError';
    this.valueDisposition = valueDisposition;
  }
}

/**
 * Clasifica el error de un `fetch` que NO devolvió respuesta.
 *
 * Espejo deliberado de `classifyReceiptError` (`adapters/settle-verifier.ts`):
 * camina la cadena de `cause` (undici anida el error real) y sólo devuelve el
 * veredicto FUERTE ante una señal DEFINITIVA; todo lo demás degrada al lado
 * conservador. Acá el lado conservador es `'unknown'` (a la inversa del verifier,
 * donde lo conservador era no bloquear): ante la duda, asumimos que la plata pudo
 * moverse.
 *
 * `'not-sent'` SÓLO si el motivo prueba que no se estableció el intercambio:
 *   · `ENOTFOUND` / `EAI_AGAIN`  — el nombre no resolvió, no hubo socket.
 *   · `ECONNREFUSED`             — el peer rechazó la conexión.
 *   · `ERR_INVALID_URL`          — la URL nunca fue requestable.
 *
 * `AbortError` / `TimeoutError` (el techo de wall-clock de esta HU) caen a
 * `'unknown'` A PROPÓSITO: el request ya había salido cuando el reloj se cumplió.
 */
const NOT_SENT_CAUSE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ERR_INVALID_URL',
]);

/**
 * Lee la disposición del valor de un error, o `undefined` si el error no la trae.
 *
 * ⚠️ POR QUÉ NO ES UN `instanceof` A SECAS (y por qué importa): `instanceof` compara
 * IDENTIDAD DE CLASE, y esa identidad es por-registro-de-módulos. Cualquier
 * consumidor que se cargue con `vi.resetModules()` + `import()` dinámico (media
 * docena de suites de este repo lo hacen; ver el docstring de
 * `lib/downstream-skip-code.ts`) obtiene OTRA copia de esta clase, así que el
 * `instanceof` da `false` y la decisión de dinero se cae al camino de "falló" — el
 * colapso exacto que este tipo existe para evitar. Cazado con un test rojo en la
 * HU-198, no en teoría.
 *
 * Se chequea por FORMA (`name` + `valueDisposition` con valor del dominio), igual
 * que `classifyReceiptError` (`adapters/settle-verifier.ts`) clasifica por
 * `err.name` en vez de por clase, y por el mismo motivo. El `instanceof` se
 * mantiene como primer intento porque es el camino normal en producción (un solo
 * registro de módulos).
 */
export function readSettleValueDisposition(
  err: unknown,
): SettleValueDisposition | undefined {
  if (err instanceof FacilitatorSettleError) return err.valueDisposition;
  if (!err || typeof err !== 'object') return undefined;
  const candidate = err as { name?: unknown; valueDisposition?: unknown };
  if (candidate.name !== 'FacilitatorSettleError') return undefined;
  return candidate.valueDisposition === 'unknown' ||
    candidate.valueDisposition === 'not-sent'
    ? candidate.valueDisposition
    : undefined;
}

export function classifySettleTransportError(
  err: unknown,
): SettleValueDisposition {
  let cursor: unknown = err;
  // Profundidad 8, igual que `classifyReceiptError`.
  for (let depth = 0; depth < 8 && cursor; depth++) {
    if (cursor && typeof cursor === 'object') {
      const code = (cursor as { code?: unknown }).code;
      if (typeof code === 'string' && NOT_SENT_CAUSE_CODES.has(code)) {
        return 'not-sent';
      }
      cursor = (cursor as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return 'unknown';
}
