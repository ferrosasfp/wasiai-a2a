/**
 * HU-194: clave de idempotencia del REFUND LÓGICO.
 *
 * ── QUÉ PROBLEMA RESUELVE ─────────────────────────────────────────────────
 *
 * `refund_a2a_key_spend` puede COMMITEAR y perderse la respuesta (socket reset,
 * timeout post-commit, pod matado). `budgetService.credit` rechaza, el call-site
 * encola en `a2a_refund_outbox` y el sweep reintenta: el caller cobra DOS VECES.
 * Con esta clave, el reintento es un no-op del lado de Postgres
 * (`a2a_refund_applications` + `refund_idem_claim`, migración
 * 20260727000000_hu194_refund_idempotency).
 *
 * ── QUÉ IDENTIFICA (y qué NO) ─────────────────────────────────────────────
 *
 * La clave identifica el refund LÓGICO, no el INTENTO:
 *   - todos los intentos del mismo refund (el credit del call-site + los N
 *     reintentos del sweep) comparten clave ⟹ se aplica UNA vez;
 *   - dos refunds legítimos DISTINTOS de la misma operación tienen claves
 *     distintas ⟹ NO se colapsan y no se pierde ningún crédito real.
 *
 * Composición: `v1:<keyId>:<chainId>:<operationId>:<slot>`
 *   - `keyId` + `chainId`: a qué budget vuelve la plata. Los incluimos para que
 *     ninguna clave pueda cruzar tenants ni chains ni por accidente ni a mano.
 *   - `operationId`: UUID de la OPERACIÓN que dejó el débito. Nunca es un valor
 *     que venga del caller (ver abajo).
 *   - `slot`: el refund lógico DENTRO de esa operación. Es la pieza que evita el
 *     colapso: en /compose, el step 3 puede tener DOS refunds legítimos — el del
 *     primer débito (`compose-step:3:d1`) y el del débito del retry adaptativo
 *     (`compose-step:3:d2`, `services/compose.ts` PASO 6b). Misma key, misma
 *     chain, mismo monto, mismo destino, misma operación: si la clave no los
 *     distinguiera, el segundo crédito (dinero REAL del caller) se descartaría
 *     como "duplicado".
 *
 * El `reason` NO forma parte de la clave, a propósito. Un mismo refund lógico se
 * encola con `reason` distinto según CÓMO falló (`:refund-failed` vs
 * `:refund-threw`); si el reason entrara en la clave, esos dos caminos darían
 * claves distintas y el sweep podría acreditar dos veces. `reason` queda como
 * campo de auditoría del outbox.
 *
 * ── POR QUÉ NO `request.id` NI `orchestrationId` ──────────────────────────
 *
 * Ambos son o pueden ser CALLER-CONTROLLED:
 *   - `request.id` sale del header `request-id` cuando el caller lo manda
 *     (`Fastify({ genReqId })` sólo cubre el caso en que NO viene).
 *   - `POST /orchestrate/execute` recibe `orchestrationId` en el body
 *     (`routes/orchestrate.ts`, `OrchestrateExecuteBody`).
 * Un caller que repite el mismo id en dos requests haría que su SEGUNDO refund
 * (legítimo, de un débito distinto) se descarte como duplicado. Por eso el
 * `operationId` es siempre un UUID generado server-side por operación:
 * `requestRefundIdemBase(request)` para las rutas, `composeRunId` para el
 * pipeline de compose, un UUID propio por ejecución en orchestrate.
 */

import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** HU-194: UUID server-side por request, base de las claves de refund. */
    refundIdemBase?: string;
  }
}

/** Versión del formato de clave. Cambiarla invalida la dedup de claves viejas. */
export const REFUND_IDEM_VERSION = 'v1';

export interface RefundIdemParts {
  /** `a2a_agent_keys.id` cuyo budget se acredita. */
  keyId: string;
  /** Chain del budget que se acredita. */
  chainId: number;
  /** UUID server-side de la operación que dejó el débito. */
  operationId: string;
  /**
   * Refund lógico dentro de la operación (`gasless`, `compose-step0`,
   * `compose-step:3:d1`, `orchestrate-step0`, `step0`...). NO debe depender de
   * CÓMO falló el intento.
   */
  slot: string;
}

/**
 * UUID server-side memoizado en el request. Estable para todos los refunds de
 * ese request (el credit original y el enqueue del outbox comparten clave) y
 * único entre requests (dos requests = dos débitos = dos refunds legítimos).
 */
export function requestRefundIdemBase(request: FastifyRequest): string {
  const existing = request.refundIdemBase;
  if (existing !== undefined) return existing;
  const base = crypto.randomUUID();
  request.refundIdemBase = base;
  return base;
}

/**
 * Parámetro de idempotencia de `budgetService.credit*`. Es un OBJETO, no un
 * `string`, a propósito: un `destination` suelto no puede terminar en la posición
 * de la clave por error (el compilador lo rechaza). REQUERIDO en las 4 variantes
 * de credit para que ningún call-site nuevo pueda olvidarlo en silencio.
 *
 * `idemKey: null` = sin dedup, comportamiento IDÉNTICO al de antes de HU-194.
 * Se usa sólo para las filas del outbox encoladas ANTES de la migración (su
 * `idem_key` es NULL y no hay forma de deducirlo: nadie registró el crédito
 * original).
 */
export interface RefundIdem {
  idemKey: string | null;
}

/** Arma la clave del refund lógico. Determinista para las mismas partes. */
export function refundIdemKey(parts: RefundIdemParts): string {
  return [
    REFUND_IDEM_VERSION,
    parts.keyId,
    String(parts.chainId),
    parts.operationId,
    parts.slot,
  ].join(':');
}
