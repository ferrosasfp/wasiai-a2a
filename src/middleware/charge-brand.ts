/**
 * HU-193: marcas (brands) sobre los preHandlers que participan del cobro.
 *
 * Existen para que un TEST pueda recorrer las rutas realmente registradas
 * (`onRoute`) y decidir, sin una lista hardcodeada de paths, si una ruta cobra y
 * si declaró su validación pre-cobro. Ver `routes/charged-routes.meta.test.ts`.
 *
 * Módulo propio (y sin dependencias) a propósito: `charged-route.ts` importa
 * `a2a-key.ts` para armar la cadena, así que si las marcas vivieran ahí el
 * `a2a-key.ts` → `charged-route.ts` cerraría un ciclo de imports en el
 * money-path. Acá no hay ciclo posible.
 *
 * Se usan `Symbol` (no strings) para que la marca no colisione con ninguna
 * propiedad que Fastify o un plugin pongan sobre la función, y `defineProperty`
 * no-enumerable para que no aparezca en serializaciones/logs del handler.
 */

/** El handler cobra al caller (débito prepago y/o settle x402 inbound). */
export const CHARGES_CALLER: unique symbol = Symbol('wasiai.chargesCaller');

/**
 * El handler valida la FORMA del pedido antes de cualquier cobro. Guarda la
 * justificación cuando la ruta declara explícitamente que no tiene nada que
 * validar (`{ skip: '<motivo>' }`).
 */
export const PRE_CHARGE_VALIDATION: unique symbol = Symbol(
  'wasiai.preChargeValidation',
);

type Branded = Record<symbol, unknown>;

function brand(fn: unknown, key: symbol, value: unknown): void {
  Object.defineProperty(fn as object, key, {
    value,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

/** Marca un preHandler como "este cobra". Idempotente por call-site. */
export function markChargesCaller<T>(handler: T): T {
  brand(handler, CHARGES_CALLER, true);
  return handler;
}

/** Marca un preHandler como validación pre-cobro (o como skip justificado). */
export function markPreChargeValidation<T>(handler: T, detail: string): T {
  brand(handler, PRE_CHARGE_VALIDATION, detail);
  return handler;
}

export function chargesCaller(handler: unknown): boolean {
  return (handler as Branded)?.[CHARGES_CALLER] === true;
}

/** Devuelve la justificación/descripción, o `null` si el handler no está marcado. */
export function preChargeValidationDetail(handler: unknown): string | null {
  const detail = (handler as Branded)?.[PRE_CHARGE_VALIDATION];
  return typeof detail === 'string' ? detail : null;
}
