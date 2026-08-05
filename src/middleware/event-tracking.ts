/**
 * Event Tracking Middleware — Fastify onResponse hook
 * WKH-EVENT-TRACKING: Global event tracking for dashboard analytics
 *
 * Tracks request events on allowlisted route prefixes via eventService.track().
 * Fire-and-forget: errors are logged but never propagate to clients.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  type DownstreamSkipCode,
  type PublicDownstreamSkipCode,
  parseSkippedMarker,
} from '../lib/downstream-skip-code.js';
import { eventService } from '../services/event.js';

// ── DT-2: Allowlisted route prefixes (safer than denylist) ──

const TRACKED_PREFIXES = [
  '/discover',
  '/orchestrate',
  '/compose',
  '/auth/agent-signup',
  '/gasless/status',
];

/**
 * Formato de `a2a_events.event_type` (DT-3). Vive acá, en el único módulo que lo
 * escribe, y se exporta para que quien lo CONSULTE (el trace del dashboard,
 * WKH-191x) no reimplemente el string y se desincronice en silencio.
 */
export function buildEventType(method: string, endpoint: string): string {
  return `request:${method}:${endpoint}`;
}

/**
 * WKH-191x — retiene los skip-codes PÚBLICOS del leg downstream de un pipeline
 * para que el evento los persista en `a2a_events.metadata`.
 *
 * Por qué existe: `toPublicSkipCode` sólo alimentaba la respuesta HTTP y los logs
 * (`compose.ts`), así que el motivo por el que un leg no se pagó no quedaba en
 * ninguna tabla y era imposible contarlo después. `metadata` es `jsonb`, así que
 * esto NO necesita migración.
 *
 * Sólo lee `steps[].downstreamSettle`, cuyo tipo es
 * `` `skipped:${PublicDownstreamSkipCode}` ``: es imposible por tipos que entre acá
 * un código INTERNO (los que revelan flags, allow-list de mainnet o el estado de
 * la wallet del operador). NO toca la lógica de decisión de dinero.
 *
 * Guarda un array VACÍO cuando el pipeline no tuvo skips: la ausencia de la clave
 * significa "este tráfico es anterior a la señal", que no es lo mismo que "cero
 * skips", y la pantalla distingue los dos casos.
 */
export function noteDownstreamSkips(
  request: FastifyRequest,
  steps: ReadonlyArray<{ downstreamSettle?: string | undefined }> | undefined,
  /**
   * Motivos INTERNOS de los mismos legs, en el array que el route le PRESTÓ al
   * pipeline (`ComposeRequest.downstreamSkipCauses`). Se pasan aparte y no se
   * leen de `steps` a propósito: el `StepResult` es la superficie que se
   * serializa al caller, y estos códigos son los que `toPublicSkipCode`
   * genericiza justamente para no salir de casa.
   *
   * Ausente ⟹ el route no pidió el canal de operador y `downstreamSkipCauses`
   * queda sin setear, o sea que la fila del evento NO gana la clave. Eso es
   * "esta ruta no reporta causas", que no es lo mismo que "cero causas" — la
   * misma distinción ausente/vacío que ya sostiene `downstreamSkips`.
   */
  causes?: ReadonlyArray<DownstreamSkipCode> | undefined,
): void {
  const codes: PublicDownstreamSkipCode[] = [];
  for (const step of steps ?? []) {
    const code = parseSkippedMarker(step?.downstreamSettle);
    if (code) codes.push(code);
  }
  request.downstreamSkips = codes;
  if (causes) request.downstreamSkipCauses = [...causes];
}

// ── Fastify augmentation for start time (DT-4) ─────────────

declare module 'fastify' {
  interface FastifyRequest {
    /** Epoch ms timestamp set by onRequest hook for latency calculation */
    _eventTrackingStartMs?: number;
    /**
     * WKH-191x — skip-codes PÚBLICOS del leg downstream de este request, seteados
     * por `noteDownstreamSkips` en las rutas que corren un pipeline. Vocabulario
     * público SIEMPRE (ver el docstring de `noteDownstreamSkips`).
     */
    downstreamSkips?: PublicDownstreamSkipCode[];
    /**
     * Motivos INTERNOS de esos mismos legs (canal de OPERADOR). Vocabulario
     * INTERNO SIEMPRE: sólo se persiste en `a2a_events`, que se lee desde
     * `/dashboard/trace` detrás de un gate admin fail-closed. NUNCA se escribe
     * en una respuesta HTTP.
     */
    downstreamSkipCauses?: DownstreamSkipCode[];
  }
}

// ── Hook registration ───────────────────────────────────────

export function registerEventTracking(fastify: FastifyInstance): void {
  // DT-4: Store start time in onRequest
  fastify.addHook('onRequest', async (request: FastifyRequest) => {
    request._eventTrackingStartMs = Date.now();
  });

  // DT-1: onResponse fires after response is fully sent (accurate latency)
  fastify.addHook(
    'onResponse',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const url = request.url;
      const isTracked = TRACKED_PREFIXES.some((prefix) =>
        url.startsWith(prefix),
      );
      if (!isTracked) return;

      const method = request.method;
      const statusCode = reply.statusCode;
      const latencyMs =
        request._eventTrackingStartMs != null
          ? Date.now() - request._eventTrackingStartMs
          : undefined;
      const status: 'success' | 'failed' =
        statusCode < 400 ? 'success' : 'failed';

      // DT-3: eventType format request:<method>:<route>
      const eventType = buildEventType(method, url.split('?')[0] ?? url);

      // CD-2: fire-and-forget with .catch() — never block or propagate
      eventService
        .track({
          eventType,
          status,
          latencyMs,
          metadata: {
            endpoint: url.split('?')[0],
            method,
            statusCode,
            responseTimeMs: latencyMs,
            timestamp: new Date().toISOString(),
            requestId: request.id,
            // WKH-69: tag inbound payment origin (set by x402.ts middleware
            // when payment header parsed). Spread-conditional so legacy rows
            // without paymentOrigin do NOT add a key with value undefined.
            ...(request.paymentOrigin
              ? { payment_origin: request.paymentOrigin }
              : {}),
            // WKH-191x: motivo público de los legs que NO se pagaron. Mismo patrón
            // spread-condicional que `payment_origin`: las filas de rutas que no
            // corren pipeline NO ganan una clave con `undefined`.
            ...(request.downstreamSkips
              ? { downstreamSkips: request.downstreamSkips }
              : {}),
            // Motivo INTERNO de esos mismos legs, para el canal de OPERADOR. El
            // público de arriba colapsa cuatro causas con cuatro dueños distintos
            // en `NOT_CONFIGURED`, y ese colapso es correcto para el caller pero
            // deja al operador sin poder diagnosticar. `a2a_events` es admin-only
            // (`/dashboard/trace`, gate fail-closed), así que acá el código
            // interno no filtra nada. Mismo spread-condicional.
            ...(request.downstreamSkipCauses
              ? { downstreamSkipCauses: request.downstreamSkipCauses }
              : {}),
          },
        })
        .catch((err: unknown) => {
          request.log.error(
            { err: err instanceof Error ? err.message : 'unknown' },
            'event-tracking: failed to track event',
          );
        });
    },
  );
}
