/**
 * HU-203 — ¿el débito del caller se le DEVUELVE, o hay evidencia de que el pago pudo
 * haber salido igual?
 *
 * POR QUÉ EXISTE ESTE MÓDULO. `services/compose.ts` reembolsa el débito per-step
 * cuando el step tira, y ese reembolso sólo es correcto si el valor NO se movió. El
 * settle inbound del step (caller → gateway, EIP-3009 firmado por el operador) puede
 * fallar de dos maneras que NO son prueba de que no se pagó:
 *
 *   · el facilitator contesta `200 { success:false, txHash:"0x…" }` — nos deja UN HASH
 *     DE BROADCAST EN LA MANO. En modo `pieverse`, que es el DEFAULT de producción
 *     (`KITE_FACILITATOR_MODE`), la respuesta se pasa verbatim, así que este caso es el
 *     camino vivo, no un borde teórico;
 *   · el hop HTTP no da una respuesta utilizable (techo de wall-clock, socket cortado,
 *     non-2xx, cuerpo ilegible) ⟹ `FacilitatorSettleError` con
 *     `valueDisposition: 'unknown'` (HU-198/HU-201). Abortar el request NO cancela un
 *     broadcast: lo único que perdimos es la RESPUESTA.
 *
 * En los dos casos, reembolsar significa que la plata sale DOS VECES de nuestro lado:
 * el agente cobró on-chain y el caller recuperó su budget. Es pérdida del operador.
 *
 * LA ASIMETRÍA ES DELIBERADA, en las dos direcciones:
 *   · retener de más deja al caller cobrado por un step que no le entregó valor. Es
 *     plata que le debemos y se le devuelve a mano — por eso cada retención se anota en
 *     un evento durable que alguien LISTA (ver `buildSettleUnknownEvent`), en vez de
 *     morir en un log;
 *   · reembolsar de más es plata que ya no se recupera. Por eso el único caso que
 *     conserva el reembolso automático es aquel en que el facilitator contestó, con un
 *     veredicto LEGIBLE, que no settleó, y SIN darnos ningún hash.
 *
 * Es la misma doctrina que `hasBroadcastEvidence` / `readSettleValueDisposition`
 * (`adapters/errors.ts`) aplican al camino de los payment intents; este módulo la lleva
 * al camino del budget de la agent key, que tiene otro modelo de datos y otro punto de
 * reembolso.
 */

import {
  hasBroadcastEvidence,
  readSettleValueDisposition,
} from '../adapters/errors.js';

/**
 * Por qué no se devuelve la plata.
 *
 *   · `'broadcast-hash'`: el facilitator dijo `success:false` PERO devolvió un hash.
 *   · `'no-facilitator-answer'`: el hop no produjo una respuesta con veredicto legible.
 */
export type SettleWithholdingReason =
  | 'broadcast-hash'
  | 'no-facilitator-answer';

export interface SettleWithholding {
  reason: SettleWithholdingReason;
  /**
   * La evidencia de broadcast cuando existe, `null` cuando el hop no contestó y no hay
   * nada que anotar. NO se valida el formato, por la misma regla que
   * `hasBroadcastEvidence`: un hash que no reconocemos significa que no entendimos la
   * respuesta, y no entenderla es lo contrario de tener una prueba.
   */
  txHash: string | null;
  /** Mensaje humano; es lo que termina en el evento durable y en el log. */
  detail: string;
}

/**
 * Error que transporta la decisión de dinero desde el punto del settle hasta el punto
 * del reembolso, que en `compose` están separados por toda la pila de un step.
 *
 * Se usa SÓLO para el eje `2xx { success:false, txHash }`. El otro eje ya viaja tipado
 * como `FacilitatorSettleError` desde los adapters y no se re-envuelve: envolverlo
 * perdería su `valueDisposition`, que es lo que distingue `'not-sent'` (reembolsable)
 * de `'unknown'` (no reembolsable).
 */
export class SettleRefundWithheldError extends Error {
  readonly code = 'settle_refund_withheld';
  readonly withholding: SettleWithholding;

  constructor(withholding: SettleWithholding) {
    super(withholding.detail);
    this.name = 'SettleRefundWithheldError';
    this.withholding = withholding;
  }
}

/**
 * ⚠️ POR QUÉ NO ES UN `instanceof` A SECAS: mismo motivo que
 * `readSettleValueDisposition` (`adapters/errors.ts`) — `instanceof` compara IDENTIDAD
 * DE CLASE, que es por-registro-de-módulos. Una suite con `vi.resetModules()` +
 * `import()` dinámico ve otra copia de la clase, el `instanceof` da `false`, y la
 * decisión de dinero se cae al camino de "falló" ⟹ reembolso indebido. Se chequea por
 * FORMA; el `instanceof` queda como primer intento porque es el camino normal en
 * producción.
 */
function readWithheldPayload(err: unknown): SettleWithholding | undefined {
  if (err instanceof SettleRefundWithheldError) return err.withholding;
  if (!err || typeof err !== 'object') return undefined;
  const candidate = err as { name?: unknown; withholding?: unknown };
  if (candidate.name !== 'SettleRefundWithheldError') return undefined;
  const payload = candidate.withholding;
  if (!payload || typeof payload !== 'object') return undefined;
  const { reason, txHash, detail } = payload as {
    reason?: unknown;
    txHash?: unknown;
    detail?: unknown;
  };
  if (reason !== 'broadcast-hash' && reason !== 'no-facilitator-answer')
    return undefined;
  return {
    reason,
    txHash: typeof txHash === 'string' ? txHash : null,
    detail: typeof detail === 'string' ? detail : '',
  };
}

/**
 * LOS DOS EJES, en un solo lector. Devuelve `undefined` cuando el error NO aporta
 * evidencia de que el valor pudo moverse — o sea, cuando el reembolso sigue siendo
 * correcto.
 *
 * Un `FacilitatorSettleError` con `'not-sent'` cae acá a `undefined` A PROPÓSITO: ese
 * valor sólo se emite ante una señal que PRUEBA que no hubo request (DNS que no
 * resuelve, conexión rechazada, URL inválida), y esa prueba es justamente lo que
 * mantiene vivo el reembolso legítimo.
 */
export function readSettleWithholding(
  err: unknown,
): SettleWithholding | undefined {
  const direct = readWithheldPayload(err);
  if (direct) return direct;
  if (readSettleValueDisposition(err) !== 'unknown') return undefined;
  return {
    reason: 'no-facilitator-answer',
    txHash: null,
    detail: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Construye la retención del eje `2xx { success:false, txHash }`, o `undefined` si el
 * facilitator no nos dio ningún hash (⟹ el reembolso automático se conserva).
 */
export function withholdingFromSettleResult(
  settleResult: { success: boolean; txHash?: string | undefined },
  detail: string,
): SettleWithholding | undefined {
  if (settleResult.success) return undefined;
  if (!hasBroadcastEvidence(settleResult.txHash)) return undefined;
  return {
    reason: 'broadcast-hash',
    txHash: (settleResult.txHash ?? '').trim(),
    detail,
  };
}

/**
 * `event_type` de los eventos durables que dejan las retenciones del camino OUTBOUND
 * (compose y orchestrate). Espeja `x402_settle_unknown`, que HU-201 dejó para el
 * camino INBOUND en `middleware/x402.ts`.
 */
export const COMPOSE_SETTLE_UNKNOWN_EVENT = 'compose_settle_unknown';

/**
 * La familia COMPLETA de eventos "el settle pudo haber salido y no devolvimos la
 * plata". Es lo que lista `reconciliationService.listAmbiguous()`.
 *
 * `x402_settle_unknown` (inbound, HU-201) entra acá porque hasta HU-203 se escribía
 * pero NO se listaba en ningún lado: quedaba exactamente en el estado que HU-201
 * describe como inaceptable para la cola de intents (plata retenida sin superficie).
 */
export const SETTLE_UNKNOWN_EVENT_TYPES = [
  'x402_settle_unknown',
  COMPOSE_SETTLE_UNKNOWN_EVENT,
] as const;

/**
 * Arma el input de `eventService.track()` para una retención del camino outbound.
 *
 * Es una función PURA (no importa el event service) para que el módulo siga siendo un
 * leaf sin dependencias de servicios: lo consumen `services/compose.ts` y
 * `services/orchestrate.ts`, y `services/reconciliation.ts` lee las filas resultantes.
 * Que la forma se arme en un solo lugar es lo que garantiza que las dos retenciones
 * lleguen a la misma cola con las mismas claves.
 *
 * `refundWithheld:false` NO es contradictorio: significa "el settle quedó sin resolver
 * pero en ESTE punto no había débito propio que retener" (p. ej. el step 0 de compose,
 * cuyo débito lo hace y lo reembolsa `orchestrate`). La fila existe igual para que el
 * settle sin resolver nunca sea invisible.
 */
export function buildSettleUnknownEvent(input: {
  withholding: SettleWithholding;
  withholder: string;
  withheldUsd: number;
  refundWithheld: boolean;
  agentSlug?: string | undefined;
  agentName?: string | undefined;
  registry?: string | undefined;
  step?: number | undefined;
  keyId?: string | undefined;
  ownerRef?: string | undefined;
  chainId?: number | undefined;
  /**
   * HU-306: id del run de `/compose` que produjo la retención, cuando lo hay.
   *
   * ADITIVO Y OPCIONAL: sin él la fila tiene EXACTAMENTE la forma de hoy (`null`), que
   * es la que siguen escribiendo los caminos que no son un pipeline. Existe para que las
   * dos preguntas del mismo run —"¿este settle salió?" (esta fila) y "¿qué pagos ya
   * confirmados quedaron varados?" (la fila `compose_stranded_payment`)— se puedan mirar
   * juntas. NO las mezcla: siguen siendo dos `event_type` distintos y dos listas
   * distintas (CD-8).
   */
  composeRunId?: string | undefined;
}): {
  eventType: string;
  status: 'failed';
  costUsdc: number;
  agentId?: string | undefined;
  agentName?: string | undefined;
  registry?: string | undefined;
  txHash?: string | undefined;
  metadata: Record<string, unknown>;
} {
  const { withholding } = input;
  return {
    eventType: COMPOSE_SETTLE_UNKNOWN_EVENT,
    status: 'failed',
    // El monto que NO se le devolvió al caller. Es la cifra que un humano necesita para
    // reembolsar a mano si la tx resulta no haber aterrizado.
    costUsdc: input.withheldUsd,
    agentId: input.agentSlug,
    agentName: input.agentName,
    registry: input.registry,
    ...(withholding.txHash !== null ? { txHash: withholding.txHash } : {}),
    metadata: {
      error_code: 'SETTLE_REFUND_WITHHELD',
      withholder: input.withholder,
      reason: withholding.reason,
      refund_withheld: input.refundWithheld,
      settle_tx_hash: withholding.txHash,
      withheld_usd: input.withheldUsd,
      step: input.step ?? null,
      key_id: input.keyId ?? null,
      owner_ref: input.ownerRef ?? null,
      chain_id: input.chainId ?? null,
      detail: withholding.detail,
      compose_run_id: input.composeRunId ?? null,
    },
  };
}
