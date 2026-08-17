/**
 * WKH-360 · CAPA 2 — el preHandler que lee la traza de contratación ENTRANTE.
 *
 * Corre ANTES DE TODO en la cadena de preHandlers de `/compose` y de las TRES de
 * `/orchestrate*`: antes de la validación de forma, antes de la resolución de
 * capacidades, antes del preHandler de precio y —lo que importa— antes de
 * `requirePaymentOrA2AKey` y de `markSkipMiddlewareDebitHandler`. O sea que
 * cualquier corte de acá ocurre con CERO movimiento de plata.
 *
 * Qué decide, en el orden normativo de `readInboundContracting` (CD-16):
 *  · la traza entrante YA NOS CONTIENE            → `CONTRACTING_LOOP_DETECTED`
 *  · la profundidad llegó al techo                → `CONTRACTING_DEPTH_EXCEEDED`
 *  · alguno de los dos headers es ilegible        → `*_MALFORMED`
 *  · todo bien                                     → deja la traza en el request
 *
 * ⛔ LO QUE ESTA CAPA NO CIERRA, y por eso su error lo DICE en el body (CD-6): la
 * detección transitiva depende de que cada intermediario REENVÍE los headers. Contra
 * una contraparte que los borra a propósito, esta capa no ve nada y lo que queda en
 * pie es la capa 1 (identidad del destino, que no consulta ningún header del caller)
 * y el techo de profundidad. El texto sale de
 * `CONTRACTING_LAYER2_BEST_EFFORT_NOTE`, que es UNA constante del leaf, así que lo
 * que el caller lee y lo que el test asserta no pueden divergir.
 *
 * ⚠️ Este middleware NO decide dinero y no lo toca. Devuelve un veredicto y aborta;
 * quien cobra está más abajo en la cadena.
 *
 * Por qué el `error_code` en SNAKE (familia 1): en este repo un rechazo de dominio
 * sobre un body BIEN FORMADO usa `error_code` (`AGENT_NOT_FOUND`,
 * `REGISTRY_UNAVAILABLE`, `QUOTE_STALE`), mientras `code` señala un body MAL armado
 * y `errorCode` (camel) es el resultado de un pipeline que arrancó. Un bucle de
 * contratación es lo primero. El VALOR sale de la misma constante del leaf que usa el
 * camel del Sitio 3 (CD-19): un cliente matchea un solo string aunque tenga que
 * mirar dos claves.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  CONTRACTING_CHAIN_HEADER,
  CONTRACTING_CHAIN_MALFORMED,
  CONTRACTING_DEPTH_EXCEEDED,
  CONTRACTING_DEPTH_HEADER,
  CONTRACTING_LAYER2_BEST_EFFORT_NOTE,
  CONTRACTING_LOOP_DETECTED,
  contractingErrorMessage,
  readInboundContracting,
  resolveContractingDepthMax,
  resolveSelfHosts,
} from '../lib/contracting-chain.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** WKH-360: traza de contratación entrante, YA validada. */
    contractingChain?: string[];
    /** WKH-360: profundidad de contratación entrante, YA validada. */
    contractingDepth?: number;
  }
}

/**
 * El preHandler. Idiom Fastify 5: `return reply.status(...).send(...)` aborta el
 * lifecycle de preHandlers, así que nada de lo que viene después corre — y lo que
 * viene después incluye los dos middlewares de débito.
 */
export async function contractingGuardHandler(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // El `hint` es el `Host` por el que entró la petición. Agrandar el conjunto de
  // identidad sólo puede producir MÁS rechazos (ver la monotonía en el leaf), así
  // que que el caller lo influya no es un bypass: es un auto-DoS de su propio
  // request.
  const { hosts: selfHosts } = resolveSelfHosts(request.hostname);
  const depthMax = resolveContractingDepthMax();

  const verdict = readInboundContracting(
    {
      chain: request.headers[CONTRACTING_CHAIN_HEADER],
      depth: request.headers[CONTRACTING_DEPTH_HEADER],
    },
    selfHosts,
    depthMax,
  );

  if (verdict.ok) {
    // Ausente ⇒ `[]` y `0`. NO se setean claves que cambien el shape del request
    // para el 100% del tráfico de hoy más allá de estos dos campos aditivos.
    request.contractingChain = verdict.chain;
    request.contractingDepth = verdict.depth;
    return;
  }

  // ── Rechazo. CERO plata movida: este preHandler corre antes de los débitos. ──
  const isLoop = verdict.code === CONTRACTING_LOOP_DETECTED;

  request.log.warn(
    {
      code: verdict.code,
      layer: isLoop ? 'chain' : 'depth',
      // NUNCA el valor de los headers: los escribe un tercero y un header de 8 KB
      // en el log es amplificación de volumen con una sola petición. Sale el
      // TAMAÑO, que es lo que un operador necesita para diagnosticar.
      chainHeaderChars:
        typeof request.headers[CONTRACTING_CHAIN_HEADER] === 'string'
          ? (request.headers[CONTRACTING_CHAIN_HEADER] as string).length
          : null,
      depthMax,
      selfHostCount: selfHosts.length,
    },
    'contracting-guard.rejected',
  );

  return reply.status(400).send({
    error: contractingErrorMessage(verdict.code),
    error_code: verdict.code,
    ...(isLoop && { layer: 'chain' as const }),
    ...(verdict.code === CONTRACTING_DEPTH_EXCEEDED && {
      depth: verdict.depth,
      depthMax: verdict.depthMax,
    }),
    // CD-6: la limitación de esta capa va en el BODY, no sólo en un comentario. Un
    // coordinador que recibe este rechazo tiene que poder saber que la cobertura
    // depende de que la cadena entera reenvíe los headers — si no, leería el
    // rechazo como una garantía de que los bucles están cerrados.
    note: CONTRACTING_LAYER2_BEST_EFFORT_NOTE,
    ...(verdict.code === CONTRACTING_CHAIN_MALFORMED && {
      reason: verdict.reason,
    }),
  });
}
