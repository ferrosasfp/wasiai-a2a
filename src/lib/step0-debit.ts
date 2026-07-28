/**
 * HU-193 (no-charge-before-validating): fuente ÚNICA del monto del débito step-0.
 *
 * Vivía como función privada en `middleware/a2a-key.ts` (`resolveEstimatedCostUsd`).
 * Se extrae SIN cambiar la expresión ni el orden de precedencia porque ahora la
 * necesitan DOS lados que tienen que coincidir exactamente:
 *
 *   1. el middleware, para decidir cuánto DEBITAR (los 3 branches: master,
 *      delegación, key-session);
 *   2. `lib/step0-refund.ts`, para decidir cuánto ACREDITAR cuando la ruta
 *      rechaza el pedido después del cobro.
 *
 * Si el refund calculara el monto por su cuenta y las dos expresiones divergieran,
 * el credit podría devolver MÁS de lo debitado (inflar el budget es peor que el
 * bug original). Con una sola función eso es imposible por construcción.
 *
 * CD-7 del middleware original: NO lee `request.body`, sólo campos augmentados.
 * Rutas que no inyectan nada (`/registries`, `/tasks`) → `PLACEHOLDER_FEE_USD`.
 */

import type { FastifyRequest } from 'fastify';
import { PLACEHOLDER_FEE_USD } from './pricing-constants.js';

/**
 * Monto en USD que el middleware de pago debita (o debitó) por el step-0 de este
 * request. Orden compose-first (DT-F del original: rutas mutuamente excluyentes).
 */
export function resolveStep0DebitUsd(request: FastifyRequest): number {
  return typeof request.composeEstimatedCostUsd === 'number'
    ? request.composeEstimatedCostUsd
    : typeof request.gaslessEstimatedCostUsd === 'number'
      ? request.gaslessEstimatedCostUsd
      : PLACEHOLDER_FEE_USD;
}
