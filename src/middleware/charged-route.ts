/**
 * HU-193 — `chargedRoute`: armado de la cadena de preHandlers de una ruta que
 * COBRA, con la validación de forma OBLIGATORIA y siempre ANTES del cobro.
 *
 * ── LA REGLA QUE ENCARNA ESTE COMPONENTE ──────────────────────────────────
 *
 *   • Error por la FORMA del pedido (cuerpo malformado, campo faltante, tipo
 *     incorrecto, parámetro fuera de rango, credencial ausente): se decide con
 *     los datos que el caller mandó, ANTES de cobrar. NO se cobra. Va acá.
 *
 *   • Error de EJECUCIÓN (el agente downstream falló, el RPC dio timeout, la
 *     transferencia revirtió, el recurso no existe, no es tuyo, está en estado
 *     terminal): no se puede prever sin hacer I/O ni sin saber quién llama. Eso
 *     NO va acá — ahí el reembolso sigue siendo la única herramienta, y por eso
 *     los fixes de `/compose` (HU-188) y `/gasless` (HU-192) siguen siendo
 *     necesarios y NO los reemplaza este componente.
 *
 * ── POR QUÉ "NO COBRAR" LE GANA A "COBRAR Y DEVOLVER" ─────────────────────
 *
 * Sirve para los DOS rieles porque corre antes de que cualquiera de los dos
 * cobre:
 *
 *   • x402: el caller paga por llamada, on-chain, y puede no tener cuenta con
 *     nosotros. No hay saldo interno que acreditar → un rechazo post-cobro es
 *     plata perdida para el caller. Además el gas del cobro entrante lo paga
 *     NUESTRA wallet de operador (`middleware/x402.ts` → `settle()` →
 *     `wasiai-facilitator` firma con `OPERATOR_PRIVATE_KEY`), así que cada
 *     pedido malformado que se cobra nos cuesta gas por una transacción que no
 *     sirvió para nada.
 *
 *   • prepago (Agent Key): el reembolso es posible, pero cobrar-y-devolver
 *     arrastra efectos que un cobro-que-no-ocurrió no tiene:
 *       - contadores de límite inflados: ver `services/budget.ts:548-550` — el
 *         `total_spent` de la delegación quedaba consumido con dinero YA
 *         reembolsado (self-DoS: el caller se auto-bloqueaba con pedidos
 *         malformados). Se parcheó revirtiendo también el contador, pero ese
 *         parche existe SÓLO porque el cobro ocurrió;
 *       - ventana de saldo incorrecto entre el débito y el crédito: una llamada
 *         concurrente puede recibir "saldo insuficiente" sin que falte saldo;
 *       - ruido en el rastro de dinero: cada rechazo deja recibos de débito,
 *         crédito y comisión que ensucian la cadena de recibos y
 *         `/dashboard/trace`.
 *
 * ── LA PROPIEDAD QUE SE BUSCA ─────────────────────────────────────────────
 *
 * Que sea IMPOSIBLE cablear una ruta que cobra sin declarar su validación
 * previa. Se logra con dos capas:
 *
 *   1. TIPOS: `validate` es un campo REQUERIDO de `ChargedRouteSpec`. No hay
 *      default. Y el opt-out no es `[]` silencioso: es
 *      `{ skip: '<motivo escrito>' }`, así que "no valido nada" queda firmado en
 *      el código (y congelado por el guard estructural, T-META-05). Además
 *      `PreChargeCheck` es SÍNCRONA y no recibe el `FastifyRequest` completo
 *      (recibe `PreChargeInput`: body/params/query/headers, en vista inmutable),
 *      así que por construcción no puede leer `request.a2aKeyRow` /
 *      `resolvedChainId`, no puede DECIDIR con el resultado de una I/O asíncrona
 *      (DNS, DB, RPC — ver `PreChargeCheck`) y no puede mutar el input que el
 *      handler usa después. Es decir: no puede colarse acá una validación de
 *      ejecución disfrazada.
 *
 *   2. TEST DE ESTRUCTURA: `routes/charged-routes.meta.test.ts` registra TODOS
 *      los plugins de la app (la lista se deriva del propio `src/index.ts`, así
 *      que un plugin nuevo que no se escanee rompe el test), recorre las rutas
 *      realmente registradas (`onRoute`) y falla si alguna tiene un handler
 *      marcado `CHARGES_CALLER` sin un `PRE_CHARGE_VALIDATION` ANTES en la
 *      cadena. La lista de excepciones está congelada, así que una ruta nueva
 *      que cobre sin validar rompe el test.
 *
 * LÍMITE HONESTO: la capa 1 no es total hoy. `requirePaymentOrA2AKey` sigue
 * exportado y `/compose`, `/orchestrate` y `/gasless` lo llaman directo (no se
 * migran en esta HU, por pedido explícito: un componente probado en 8 rutas
 * antes que un refactor grande sin verificar). Mientras exista ese export
 * público, el compilador no puede impedir el bypass; lo que lo impide es la
 * capa 2. Para volver la capa 1 total habría que migrar esas 5 rutas y dejar de
 * exportar `requirePaymentOrA2AKey` fuera de este módulo (ver el work-item).
 */

import type {
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify';
import {
  extractRawKeyFromHeaders,
  type PaymentRouteHooks,
  requirePaymentOrA2AKey,
} from './a2a-key.js';
import { markPreChargeValidation } from './charge-brand.js';
import type { PaymentMiddlewareOptions } from './x402.js';

/**
 * Lo ÚNICO que ve una validación pre-cobro: los datos crudos que mandó el
 * caller. No incluye `a2aKeyRow`, `resolvedChainId` ni nada que produzca el
 * middleware de auth/pago — si tu check necesita eso, no es un check de forma y
 * no puede correr pre-cobro (va al residuo, con reembolso si el riel lo permite).
 *
 * `readonly` acá protege el BINDING, no el objeto apuntado: `input.body = x` no
 * compila, pero `(input.body as Record<string, unknown>).x = 1` sí, y el HANDLER
 * vería el cuerpo mutado. Por eso los cuatro campos se entregan envueltos en una
 * vista inmutable (ver `readonlyView`).
 */
export interface PreChargeInput {
  readonly body: unknown;
  readonly params: unknown;
  readonly query: unknown;
  readonly headers: FastifyRequest['headers'];
}

/**
 * Vista de sólo-lectura, RECURSIVA y perezosa, sobre los datos del caller.
 *
 * POR QUÉ EXISTE: un `PreChargeCheck` debe ser puro. Sin esto, un check podía
 * reescribir el body/params/query que el handler valida DESPUÉS (y que se manda
 * al service), o sea reintroducir por la puerta de atrás el input no validado
 * que esta HU busca frenar. `Object.freeze` sobre el objeto de Fastify también
 * lo lograría, pero mutaría el objeto REAL del request (el handler perdería la
 * capacidad de mutarlo, en silencio, en todas las rutas que usen el
 * componente); `structuredClone` costaría una copia del body en el money-path.
 * El Proxy no copia nada, no toca el objeto original y su coste es O(1) por
 * propiedad realmente leída.
 *
 * Cualquier escritura lanza `TypeError`: el request muere en el preHandler de
 * validación, o sea ANTES del cobro (un check con bug no le cuesta plata al
 * caller).
 */
const READONLY_TRAPS: ProxyHandler<object> = {
  // Sin `receiver` a propósito: un getter corre con `this === target`, no con el
  // proxy, así que no rompe accesos a slots internos.
  get: (target, prop) => readonlyView(Reflect.get(target, prop)),
  set: (_target, prop) => {
    throw new TypeError(
      `PreChargeInput is read-only: a pre-charge check tried to set '${String(prop)}'`,
    );
  },
  defineProperty: (_target, prop) => {
    throw new TypeError(
      `PreChargeInput is read-only: a pre-charge check tried to define '${String(prop)}'`,
    );
  },
  deleteProperty: (_target, prop) => {
    throw new TypeError(
      `PreChargeInput is read-only: a pre-charge check tried to delete '${String(prop)}'`,
    );
  },
  setPrototypeOf: () => {
    throw new TypeError(
      'PreChargeInput is read-only: a pre-charge check tried to set its prototype',
    );
  },
};

function readonlyView<T>(value: T): T {
  // Sólo objetos y arrays. Primitivas ya son inmutables; las funciones se
  // devuelven tal cual (envolverlas rompería `this`).
  if (typeof value !== 'object' || value === null) return value;
  return new Proxy(value as object, READONLY_TRAPS) as T;
}

/** Respuesta de rechazo: status + body EXACTO que ya devolvía la ruta. */
export interface PreChargeRejection {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/**
 * Check puro y SÍNCRONO. `null` = pasa.
 *
 * QUÉ GARANTIZA LA SINCRONÍA (exactamente): el tipo no devuelve `Promise`, así
 * que un check NO PUEDE esperar el resultado de una API asíncrona. Todas las
 * fuentes de I/O que importan acá son asíncronas y basadas en promesas
 * (`dns.lookup`/`dns.promises` del guard SSRF, `supabase-js`, los RPC de los
 * adapters, `fetch`): un check no puede **decidir** con ninguna de ellas, así
 * que no puede convertirse en oráculo de resolución de nombres, de existencia de
 * filas ni de estado on-chain, ni disparar un fan-out remoto pre-cobro.
 *
 * QUÉ NO GARANTIZA: que no haya I/O en absoluto. La I/O SÍNCRONA sigue siendo
 * alcanzable desde JS (`fs.readFileSync`, `execSync`), y por lo tanto un check
 * podría hacerla. Eso no se puede impedir con tipos; lo frena la review — y
 * ninguno de los checks de este repo importa nada de eso. La propiedad que el
 * diseño necesita es la de arriba (sin oráculo asíncrono), no "cero I/O".
 */
export type PreChargeCheck = (
  input: PreChargeInput,
) => PreChargeRejection | null;

export interface ChargedRouteSpec {
  /**
   * OBLIGATORIO. Los checks de forma, en orden (gana el primero que rechaza), o
   * `{ skip: '<motivo>' }` si la ruta de verdad no tiene nada validable sin I/O.
   */
  readonly validate: readonly PreChargeCheck[] | { readonly skip: string };
  /** Idéntico al argumento de `requirePaymentOrA2AKey` (challenge x402). */
  readonly payment: PaymentMiddlewareOptions;
  /** Hooks opcionales del middleware de pago (p.ej. `onDebitOrphaned`). */
  readonly hooks?: PaymentRouteHooks;
}

function isSkip(
  validate: ChargedRouteSpec['validate'],
): validate is { readonly skip: string } {
  return !Array.isArray(validate);
}

/**
 * Cadena completa de preHandlers para una ruta que cobra:
 *   [ validación de forma (pre-cobro) , middleware de pago ]
 *
 * La ruta NO vuelve a llamar `requirePaymentOrA2AKey`: el orden queda acá y no
 * se puede invertir desde el call-site.
 */
export function chargedRoute(
  spec: ChargedRouteSpec,
): preHandlerAsyncHookHandler[] {
  const checks: readonly PreChargeCheck[] = isSkip(spec.validate)
    ? []
    : spec.validate;
  const detail = isSkip(spec.validate)
    ? `skip: ${spec.validate.skip}`
    : `${checks.length} check(s)`;

  const validationHandler: preHandlerAsyncHookHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    // Vista inmutable: un check no puede reescribir lo que el handler valida y
    // manda al service (ver `readonlyView`). `freeze` cubre el contenedor;
    // `readonlyView`, los objetos apuntados.
    const input: PreChargeInput = Object.freeze({
      body: readonlyView(request.body),
      params: readonlyView(request.params),
      query: readonlyView(request.query),
      headers: readonlyView(request.headers),
    });
    for (const check of checks) {
      const rejection = check(input);
      if (rejection) {
        // Idiom Fastify 5: `return reply...` aborta el resto de la cadena de
        // preHandlers, así que el middleware de pago NUNCA corre → no se debita
        // ni se emite/settlea el challenge x402.
        return reply.status(rejection.status).send(rejection.body);
      }
    }
  };
  markPreChargeValidation(validationHandler, detail);

  return [
    validationHandler,
    ...requirePaymentOrA2AKey(spec.payment, spec.hooks),
  ];
}

/**
 * Check reusable: exige que el caller PRESENTE una credencial a2a (header
 * `x-a2a-key` o `Authorization: Bearer wasi_a2a_*`).
 *
 * OJO — presencia, NO validez: la credencial se verifica después, en el
 * middleware de pago (que es quien puede hacer el lookup). Este check sólo
 * decide lo que ya se puede decidir sin I/O: un caller que no manda credencial
 * NUNCA va a poder operar sobre recursos con dueño (`/registries`, `/tasks`),
 * porque el riel x402 anónimo no aporta identidad de tenant (WKH-63: un sentinel
 * compartido sería un IDOR cross-tenant). Ese pedido está condenado al 403, así
 * que cobrarle el challenge x402 es cobrar por un rechazo garantizado.
 */
export function requireA2AKeyPresence(message: string): PreChargeCheck {
  return (input) =>
    extractRawKeyFromHeaders(input.headers) === undefined
      ? {
          status: 403,
          body: {
            error: 'a2a-key required',
            error_code: 'A2A_KEY_REQUIRED',
            message,
          },
        }
      : null;
}
