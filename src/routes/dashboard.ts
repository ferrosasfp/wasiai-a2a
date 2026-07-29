/**
 * Dashboard Routes — Analytics UI + API endpoints
 * WKH-27: Dashboard Analytics
 * WKH-54: /api/stats + /api/events gated by optional DASHBOARD_ADMIN_TOKEN.
 *         When env var is set → X-Admin-Token header is required.
 *         When unset → endpoints remain public (local dev behavior).
 */

import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify';
import { isEscrowSettleEnabled } from '../adapters/escrow/debit-capture.js';
import { isProduction } from '../lib/env.js';
import { arbiterService, isArbiterEnabled } from '../services/arbiter.js';
import { eventService } from '../services/event.js';
import {
  ReconciliationError,
  reconciliationService,
} from '../services/reconciliation.js';
import { traceService } from '../services/trace.js';
import { ArbiterError } from '../types/arbiter.js';

/**
 * WKH-191c: mapea ReconciliationError.code → HTTP (disclosure-safe, patrón
 * `sendArbiterAdminError`). `INDETERMINATE`/`SETTLE_FAILED`/`FLAG_OFF` normalmente
 * llegan como outcome del service (200); acá sólo si se lanzaran como error.
 */
function sendReconciliationError(
  reply: FastifyReply,
  err: unknown,
): FastifyReply {
  if (err instanceof ReconciliationError) {
    switch (err.code) {
      case 'NOT_PENDING':
        return reply.status(409).send({ error_code: 'NOT_PENDING' });
      case 'INTENT_NOT_FOUND':
        return reply.status(404).send({ error_code: 'INTENT_NOT_FOUND' });
      case 'FLAG_OFF':
        return reply.status(409).send({ error_code: 'FLAG_OFF' });
      case 'INDETERMINATE':
        return reply.status(200).send({ status: 'indeterminate' });
      case 'SETTLE_FAILED':
        return reply.status(200).send({ status: 'settle_failed' });
      default:
        return reply.status(500).send({ error_code: 'RECONCILIATION_FAILED' });
    }
  }
  return reply.status(500).send({ error_code: 'RECONCILIATION_FAILED' });
}

/**
 * WKH-189: mapea ArbiterError.code → HTTP (disclosure-safe). Espejo local de
 * `sendArbiterError` de payments.ts (privado de ese módulo, no se importa).
 */
function sendArbiterAdminError(
  reply: FastifyReply,
  err: unknown,
): FastifyReply {
  if (err instanceof ArbiterError) {
    switch (err.code) {
      case 'INVALID_INPUT':
        return reply.status(422).send({ error_code: 'INVALID_INPUT' });
      case 'OWNERSHIP_MISMATCH':
        return reply.status(403).send({ error_code: 'OWNERSHIP_MISMATCH' });
      case 'INTENT_NOT_FOUND':
        return reply.status(404).send({ error_code: 'INTENT_NOT_FOUND' });
      case 'INTENT_NOT_OPEN':
        return reply.status(409).send({ error_code: 'INTENT_NOT_OPEN' });
      case 'CHAIN_NOT_SUPPORTED':
        return reply.status(422).send({ error_code: 'CHAIN_NOT_SUPPORTED' });
      default:
        return reply.status(500).send({ error_code: 'ARBITER_FAILED' });
    }
  }
  return reply.status(500).send({ error_code: 'ARBITER_FAILED' });
}

/**
 * Admin-token preHandler. Opt-in: only active when DASHBOARD_ADMIN_TOKEN
 * is configured. Callers must supply it via `X-Admin-Token` header.
 *
 * Uses crypto.timingSafeEqual to prevent byte-by-byte timing recovery of
 * the admin token. Length-normalized buffer comparison rejects
 * mismatched-length tokens before the constant-time check.
 */
const requireAdminToken: preHandlerAsyncHookHandler = async (
  request,
  reply,
) => {
  const expected = process.env.DASHBOARD_ADMIN_TOKEN;
  if (!expected) {
    // AC-1/AC-2 (CD-1): fail-closed in production, passthrough in dev.
    if (isProduction()) {
      return reply.status(503).send({
        error: 'service_unavailable',
        message: 'Dashboard API not configured',
      });
    }
    return; // not configured + non-prod → allow (dev mode)
  }
  const provided = request.headers['x-admin-token'];
  if (typeof provided !== 'string') {
    return reply.status(401).send({
      error: 'unauthorized',
      message: 'X-Admin-Token header required for dashboard API',
    });
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return reply.status(401).send({
      error: 'unauthorized',
      message: 'X-Admin-Token header required for dashboard API',
    });
  }
};

/**
 * WKH-191c: admin-token preHandler FAIL-CLOSED (CD-7). A diferencia del opt-in
 * `requireAdminToken`, este SIEMPRE exige el token: si `DASHBOARD_ADMIN_TOKEN` no está
 * configurado responde 503 en dev Y prod. Comparación timing-safe (reusa el patrón de
 * `requireAdminToken`).
 *
 * ── ESTE ES EL GATE DE TODA ESCRITURA DE DINERO DEL PANEL (HU-207) ──────────
 *
 * Nació para la reconciliación, pero la regla no es de qué módulo es el endpoint: es
 * que la operación mueva o habilite dinero. Un endpoint así no puede quedar abierto por
 * la ausencia de una variable, porque ahí la protección deja de ser una decisión y pasa
 * a ser una coincidencia de configuración: `requireAdminToken` sólo cierra cuando
 * `NODE_ENV` dice EXACTAMENTE `production` (`lib/env.ts`), así que un staging, un
 * preview o un servicio recién creado sin `DASHBOARD_ADMIN_TOKEN` sirve la operación a
 * cualquiera. Fail-closed invierte esa carga: sin secreto no hay operación, y el 503 es
 * un síntoma visible en el primer intento en vez de un agujero silencioso.
 *
 * Los mensajes NO nombran un módulo a propósito (antes decían "reconciliation API"): el
 * gate cubre reconciliación Y arbitraje, y un 503 que nombra el módulo equivocado manda
 * al operador a mirar el lado que no es, justo durante un incidente.
 *
 * Las LECTURAS del panel se quedan con el opt-in `requireAdminToken` (grandfathered en
 * WKH-54): ahí el passthrough de desarrollo no habilita ninguna transferencia y sacarlo
 * traba el desarrollo local sin cerrar nada. Ver `requireAdminTokenForTrace` para la
 * excepción: una lectura cross-tenant NUEVA sí nace fail-closed.
 */
const requireAdminTokenStrict: preHandlerAsyncHookHandler = async (
  request,
  reply,
) => {
  const expected = process.env.DASHBOARD_ADMIN_TOKEN;
  if (!expected) {
    // CD-7: fail-closed SIEMPRE (dev Y prod) — money-moving endpoint.
    return reply.status(503).send({
      error: 'service_unavailable',
      message: 'Admin write API not configured',
    });
  }
  const provided = request.headers['x-admin-token'];
  if (typeof provided !== 'string') {
    return reply.status(401).send({
      error: 'unauthorized',
      message: 'X-Admin-Token header required for admin write API',
    });
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return reply.status(401).send({
      error: 'unauthorized',
      message: 'X-Admin-Token header required for admin write API',
    });
  }
};

/**
 * Comparación timing-safe del admin token (WKH-191x). Normaliza longitud ANTES del
 * `timingSafeEqual` para no filtrar la longitud del token por excepción.
 *
 * TD-TRACE-2: los dos gates de arriba tienen esta misma comparación inline. NO se
 * migraron acá a propósito (son auth de un endpoint que mueve dinero, ya revisada);
 * la deduplicación es una HU aparte.
 */
function adminTokenMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * HU-206 — SEGUNDA CREDENCIAL, EXCLUSIVA DE `release-lease`.
 *
 * ── POR QUÉ SON DOS GATES Y NO UNO (NO UNIFICAR) ────────────────────────────
 *
 * `requireAdminTokenStrict` autentica al operador del panel. Ese mismo
 * `DASHBOARD_ADMIN_TOKEN` abre TAMBIÉN las lecturas cross-tenant (`/api/stats`,
 * `/api/events`, `/api/reconciliation`, `/api/trace`) y las dos escrituras de
 * reconciliación. Entre esas escrituras hay una asimetría de evidencia que el token
 * no distingue:
 *
 *   · `/hop2-evidence` atesta que el seller SÍ cobró, y el hash **se verifica contra la
 *     cadena** antes de escribir nada. Si el operador miente, la cadena lo desmiente:
 *     su seguridad es criptográfica, no procedimental.
 *   · `/release-lease` atesta un NEGATIVO ("no hubo desembolso") que este repo NO puede
 *     verificar, y devuelve la fila al reconciliador, **que reenvía el pago**. Es la
 *     única operación del servicio que vuelve pagable una fila sin prueba.
 *
 * Con una sola credencial, el token que se le presta a alguien para mirar métricas
 * alcanza para habilitar un pago sin evidencia: escalada de privilegio dentro de una
 * misma credencial. Por eso `release-lease` exige `RECONCILIATION_RELEASE_TOKEN`
 * **ADEMÁS** del token de panel, en el header propio `X-Reconciliation-Release-Token`.
 *
 * ⚠️ NO COLAPSAR ESTE GATE CON `requireAdminTokenStrict` POR PARECER DUPLICACIÓN. La
 * duplicación es el punto: son dos secretos con dos audiencias distintas (el panel se
 * comparte con quien opera y observa; este NO). Unificarlos restaura exactamente el
 * agujero que este módulo cierra. Y por la misma razón `/hop2-evidence` NO lo pide: el
 * camino verificable on-chain se deja sin fricción a propósito.
 *
 * ── FORMA ELEGIDA: EL SECRETO ES EL INTERRUPTOR ─────────────────────────────
 *
 * No hay bandera booleana aparte. La operación existe SÓLO si alguien configuró un
 * secreto dedicado, y un secreto no se setea por accidente (un `=true` sí). Un flag
 * adicional agregaría un estado —flag ON + token sin configurar— que tendría que
 * fail-closed igual, y una forma de creerse protegido por haber apagado el flag
 * mientras el secreto sigue puesto. Una sola palanca, una sola fuente de verdad: para
 * cerrar la operación se borra `RECONCILIATION_RELEASE_TOKEN`.
 *
 * ── FAIL-CLOSED EN DEV *Y* PROD (y por qué acá NO se distingue) ─────────────
 *
 * La distinción prod/dev es del gate OPT-IN `requireAdminToken` (lecturas
 * grandfathered de WKH-54): sin token configurado, en no-producción pasa. El gate que
 * hoy protege `release-lease` —`requireAdminTokenStrict`— NO distingue: es 503 en dev
 * y prod desde que existe. Heredar el passthrough acá ataría la operación sin prueba a
 * `NODE_ENV`, y un deploy con `NODE_ENV` sin setear es un footgun real ya documentado
 * en `requireAdminTokenForTrace`. El desarrollo local no se rompe: se configuran las
 * dos variables (ver `.env.example`) igual que hoy se configura una.
 */
const requireReleaseLeaseToken: preHandlerAsyncHookHandler = async (
  request,
  reply,
) => {
  const expected = process.env.RECONCILIATION_RELEASE_TOKEN?.trim();
  if (!expected) {
    // El operador ya pasó `requireAdminTokenStrict`: quien llega acá TIENE el token de
    // panel y le faltó el otro. Ese es justamente el intento de escalada que esta
    // credencial separa, así que se registra (nunca el valor de ningún token).
    request.log.warn(
      { audit: 'RELEASE_LEASE_NOT_CONFIGURED' },
      'release-lease attempted with a valid dashboard token while RECONCILIATION_RELEASE_TOKEN is unset. The operation stays DISABLED (fail-closed, dev and prod): it is the only one that makes a row payable without proof.',
    );
    return reply.status(503).send({
      error: 'service_unavailable',
      message:
        'Release-lease is not configured: it requires its own RECONCILIATION_RELEASE_TOKEN, separate from DASHBOARD_ADMIN_TOKEN',
    });
  }
  const dashboardToken = process.env.DASHBOARD_ADMIN_TOKEN?.trim();
  if (
    dashboardToken !== undefined &&
    adminTokenMatches(expected, dashboardToken)
  ) {
    // Dos variables con el MISMO valor son una sola credencial con dos nombres: la
    // separación quedaría escrita en el código y ausente en la realidad. Fail-closed y
    // ruidoso antes que una defensa nominal.
    request.log.error(
      { audit: 'RELEASE_LEASE_TOKEN_NOT_DISTINCT' },
      'RECONCILIATION_RELEASE_TOKEN is identical to DASHBOARD_ADMIN_TOKEN, so it grants no extra privilege. release-lease stays DISABLED until they are distinct secrets.',
    );
    return reply.status(503).send({
      error: 'service_unavailable',
      message:
        'Release-lease is not configured: RECONCILIATION_RELEASE_TOKEN must be a distinct secret from DASHBOARD_ADMIN_TOKEN',
    });
  }
  if (
    !adminTokenMatches(
      request.headers['x-reconciliation-release-token'],
      expected,
    )
  ) {
    request.log.warn(
      { audit: 'RELEASE_LEASE_TOKEN_REJECTED' },
      'release-lease rejected: valid dashboard token but missing/incorrect X-Reconciliation-Release-Token.',
    );
    return reply.status(401).send({
      error: 'unauthorized',
      message:
        'X-Reconciliation-Release-Token header required for release-lease (a distinct, higher-privilege credential than the dashboard token)',
    });
  }
};

/**
 * WKH-191x: gate del trace operativo. **FAIL-CLOSED** (503 en dev Y prod si
 * `DASHBOARD_ADMIN_TOKEN` no está configurado), NO el opt-in `requireAdminToken`.
 *
 * Por qué fail-closed y no opt-in, siendo un GET read-only:
 *  - el payload es cross-tenant y trae `owner_ref`, montos y tx hashes de TODOS los
 *    owners. El opt-in deja la superficie ABIERTA cuando `NODE_ENV` no es
 *    `production`, y un deploy con `NODE_ENV` sin setear es un footgun real.
 *  - el opt-in de `/api/stats` está grandfathered por compatibilidad (WKH-54: ya
 *    tenía consumidores). Este endpoint es NUEVO: no hay cliente al que romper, así
 *    que no hay razón para heredar esa debilidad.
 *
 * La ruta HTML (`GET /dashboard/trace`) sigue siendo pública porque NO contiene
 * datos de tenant: es un cascarón que pide el token y lo manda por header.
 */
const requireAdminTokenForTrace: preHandlerAsyncHookHandler = async (
  request,
  reply,
) => {
  const expected = process.env.DASHBOARD_ADMIN_TOKEN;
  if (!expected) {
    return reply.status(503).send({
      error: 'service_unavailable',
      message: 'Trace API not configured',
    });
  }
  if (!adminTokenMatches(request.headers['x-admin-token'], expected)) {
    return reply.status(401).send({
      error: 'unauthorized',
      message: 'X-Admin-Token header required for trace API',
    });
  }
};

const __dirname = dirname(fileURLToPath(import.meta.url));

// Read HTML at startup (not per-request)
const CHAIN_EXPLORER_URL =
  process.env.CHAIN_EXPLORER_URL ||
  process.env.KITE_EXPLORER_URL ||
  'https://testnet.kitescan.ai';
const dashboardHtml = readFileSync(
  resolve(__dirname, '../static/dashboard.html'),
  'utf-8',
).replace('{{CHAIN_EXPLORER_URL}}', CHAIN_EXPLORER_URL);

/**
 * WKH-191x: pantalla de trace. Sin placeholders a propósito: los nombres de red y
 * las URLs de explorer las resuelve el API contra el registry real, así que el HTML
 * no tiene ni un identificador de chain escrito a mano.
 */
const traceHtml = readFileSync(
  resolve(__dirname, '../static/dashboard-trace.html'),
  'utf-8',
);

const dashboardRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /dashboard
   * Serve the dashboard HTML
   */
  fastify.get(
    '/',
    { config: { rateLimit: false } },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.type('text/html').send(dashboardHtml);
    },
  );

  /**
   * GET /dashboard/trace
   * WKH-191x: pantalla de seguimiento operativo (live trace read-only). Pública
   * como `GET /dashboard`, y sin ningún dato de tenant en el HTML: los datos los
   * pide el browser al API gateada con el token que escribe el operador.
   */
  fastify.get(
    '/trace',
    { config: { rateLimit: false } },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.type('text/html').send(traceHtml);
    },
  );

  /**
   * GET /dashboard/api/trace
   * WKH-191x: salud del rail + últimas llamadas con su rastro de dinero.
   * READ-ONLY: no dispara ningún `/compose` (cada ejecución cuesta dinero).
   * Gate FAIL-CLOSED (`requireAdminTokenForTrace`): devuelve datos cross-tenant.
   */
  fastify.get<{ Querystring: { limit?: string; windowHours?: string } }>(
    '/api/trace',
    { config: { rateLimit: false }, preHandler: requireAdminTokenForTrace },
    async (request, reply: FastifyReply) => {
      try {
        // El clamp autoritativo vive en el service; acá sólo se parsea.
        const limit = Number.parseInt(request.query.limit ?? '', 10);
        const windowHours = Number.parseInt(
          request.query.windowHours ?? '',
          10,
        );
        const snapshot = await traceService.snapshot({
          ...(Number.isNaN(limit) ? {} : { limit }),
          ...(Number.isNaN(windowHours) ? {} : { windowHours }),
        });
        return reply.send(snapshot);
      } catch (err) {
        // Mensaje estático al cliente; el detalle queda en el log del servidor.
        request.log.error(
          { detail: err instanceof Error ? err.message : 'unknown' },
          'dashboard trace failed',
        );
        return reply.status(500).send({ error: 'Failed to get trace' });
      }
    },
  );

  /**
   * GET /dashboard/api/stats
   * Aggregated KPIs for the dashboard (cached 30s)
   */
  let statsCache: { data: unknown; expiresAt: number } | null = null;
  const STATS_CACHE_TTL_MS = 30_000;

  fastify.get(
    '/api/stats',
    { config: { rateLimit: false }, preHandler: requireAdminToken },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const now = Date.now();
        if (statsCache && now < statsCache.expiresAt) {
          return reply.send(statsCache.data);
        }
        const stats = await eventService.stats();
        statsCache = { data: stats, expiresAt: now + STATS_CACHE_TTL_MS };
        return reply.send(stats);
      } catch (err) {
        // F-05 (audit 2026-06-29): static client message; detail logged server-side.
        request.log.error(
          { detail: err instanceof Error ? err.message : 'unknown' },
          'dashboard stats failed',
        );
        return reply.status(500).send({ error: 'Failed to get stats' });
      }
    },
  );

  /**
   * GET /dashboard/api/events
   * Recent events list
   */
  fastify.get<{ Querystring: { limit?: string } }>(
    '/api/events',
    { config: { rateLimit: false }, preHandler: requireAdminToken },
    async (request, reply: FastifyReply) => {
      try {
        const parsed = parseInt(request.query.limit ?? '20', 10);
        const limit = Number.isNaN(parsed) ? 20 : parsed;
        const events = await eventService.recent(limit);
        return reply.send({ events, total: events.length });
      } catch (err) {
        // F-05 (audit 2026-06-29): static client message; detail logged server-side.
        request.log.error(
          { detail: err instanceof Error ? err.message : 'unknown' },
          'dashboard events failed',
        );
        return reply.status(500).send({ error: 'Failed to get events' });
      }
    },
  );

  /**
   * GET /dashboard/api/arbitrations/holds
   * WKH-189: lista los intents en `arb_hold` para la revisión humana admin.
   * CD-5: cross-tenant DELIBERADO (admin ve holds de TODOS los owners). Superficie
   * de ALTO PRIVILEGIO, gateada por requireAdminToken + isArbiterEnabled.
   */
  fastify.get(
    '/api/arbitrations/holds',
    { config: { rateLimit: false }, preHandler: requireAdminToken },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!isArbiterEnabled()) {
        return reply.status(404).send({ error_code: 'NOT_FOUND' }); // AC-8/CD-7
      }
      try {
        const holds = await arbiterService.listHolds();
        return reply.send({ holds, total: holds.length });
      } catch (err) {
        request.log.error(
          { detail: err instanceof Error ? err.message : 'unknown' },
          'list holds failed',
        );
        return sendArbiterAdminError(reply, err);
      }
    },
  );

  /**
   * POST /dashboard/api/arbitrations/:intentId/resolve
   * WKH-189: override humano (release/refund/split) de un intent en `arb_hold`.
   * La validación autoritativa vive en arbiterService.resolveHold; acá sólo un
   * shape-check defensivo.
   *
   * HU-207 — GATE FAIL-CLOSED (`requireAdminTokenStrict`), NO el opt-in.
   *
   * Esta es la única ESCRITURA del panel que quedó con `requireAdminToken`, y `resolveHold`
   * termina en `executeArbitration`: settlea al seller o reembolsa al buyer. O sea que el
   * endpoint movía dinero detrás de un gate que se abre solo cuando falta
   * `DASHBOARD_ADMIN_TOKEN` y `NODE_ENV` no dice exactamente `production`. Producción está
   * configurada, así que esto no fue un incidente; el problema es que la protección
   * dependía de dos variables acertadas en CADA entorno, y un staging o un servicio nuevo
   * sin el token abría el movimiento de fondos a cualquiera. Ahora sin secreto no hay
   * operación, en dev y en prod, como sus pares de reconciliación.
   *
   * El hermano `GET /api/arbitrations/holds` se queda con el opt-in a propósito: es la
   * lectura grandfathered de WKH-54 y no habilita ninguna transferencia.
   */
  fastify.post<{ Params: { intentId: string } }>(
    '/api/arbitrations/:intentId/resolve',
    { config: { rateLimit: false }, preHandler: requireAdminTokenStrict },
    async (request, reply: FastifyReply) => {
      if (!isArbiterEnabled()) {
        return reply.status(404).send({ error_code: 'NOT_FOUND' }); // AC-8/CD-7
      }
      const body = (request.body ?? {}) as {
        decision?: string;
        splitPct?: number;
        resolvedBy?: string;
        note?: string;
      };
      if (
        body.decision !== 'release' &&
        body.decision !== 'refund' &&
        body.decision !== 'split'
      ) {
        return reply.status(422).send({ error_code: 'INVALID_INPUT' });
      }
      try {
        const outcome = await arbiterService.resolveHold(
          request.params.intentId,
          {
            decision: body.decision,
            ...(body.splitPct !== undefined ? { splitPct: body.splitPct } : {}),
            resolvedBy: body.resolvedBy ?? null,
            note: body.note ?? null,
          },
        );
        return reply.status(200).send({
          decision: outcome.decision,
          method: outcome.method,
          status: outcome.status,
          settleUsd: outcome.settleUsd,
          residualUsd: outcome.residualUsd,
          txHash: outcome.txHash,
        });
      } catch (err) {
        request.log.error(
          {
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'resolveHold failed',
        );
        return sendArbiterAdminError(reply, err);
      }
    },
  );

  /**
   * GET /dashboard/api/reconciliation
   * WKH-191c: surface read-only del motor de reconciliación (AC-1/AC-7). Lista los
   * intents pending + el drift budget-vs-escrow. Corre con el flag OFF (solo lectura).
   * Opt-in `requireAdminToken` (cross-tenant admin, ALTO PRIVILEGIO).
   *
   * HU-201 (AR BLQ-MEDIO-2) suma `ambiguous`: los intents `failed_ambiguous`, donde el
   * deposit del buyer QUEDÓ RETENIDO y el resultado del settle es desconocido. Es la
   * ÚNICA superficie de esas filas en el camino no-escrow (el default) — sin esto, el
   * endurecimiento de HU-201 cambiaba un reembolso indebido ruidoso por una retención
   * silenciosa. Ver `AmbiguousIntentRow` en `services/reconciliation.ts`.
   *
   * HU-203 suma `ambiguous.settleUnknown`: la MISMA pregunta sobre el camino del budget
   * de la agent key (`compose` / `orchestrate`) y sobre el inbound x402, que no crean
   * payment intents y por lo tanto no tienen dónde escribir un `settle_outcome`. Va
   * ANIDADO dentro de `ambiguous` a propósito: dos listas hermanas de plata retenida se
   * miran por turnos y una de las dos termina sin mirar. Ver `SettleUnknownEventRow`.
   *
   * HU-306 suma `ambiguous.strandedRuns`: los runs de `/compose` que fallaron DESPUÉS de
   * que algún step YA cobró on-chain. Es plata que salió y NO vuelve, y hasta esta HU su
   * única evidencia (`StepResult.downstreamTxHash`) moría con la respuesta HTTP.
   *
   * ⚠️ ES OTRA PREGUNTA que `settleUnknown`, y por eso es otra lista (CD-8): allá el
   * settle quedó SIN RESOLVER y hay que ir a mirar la cadena; acá el settle SE CONFIRMÓ
   * y no hay nada que reconciliar — la acción humana es contar, ver si crece y decidir si
   * hace falta un techo por pipeline. Mezclarlas obligaría al operador a separar a mano
   * dos acciones opuestas. Ver `StrandedRunRow` en `services/reconciliation.ts`.
   *
   * SOLO LECTURA, como el resto de este endpoint: cero remediación automática (AC-7).
   * El handler NO cambia — la lista viaja anidada en el mismo objeto `ambiguous`.
   */
  fastify.get(
    '/api/reconciliation',
    { config: { rateLimit: false }, preHandler: requireAdminToken },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const [pending, drift, ambiguous] = await Promise.all([
          reconciliationService.listPending(),
          reconciliationService.driftCheck(),
          reconciliationService.listAmbiguous(),
        ]);
        return reply.send({
          pending,
          drift,
          ambiguous,
          flagEnabled: isEscrowSettleEnabled(),
        });
      } catch (err) {
        request.log.error(
          { detail: err instanceof Error ? err.message : 'unknown' },
          'reconciliation read failed',
        );
        return reply.status(500).send({ error_code: 'RECONCILIATION_FAILED' });
      }
    },
  );

  /**
   * POST /dashboard/api/reconciliation/:intentId/resolve
   * WKH-191c: resuelve exactly-one-side un intent pending (money-moving). FAIL-CLOSED
   * (`requireAdminTokenStrict`, CD-7). El gate del flag `ESCROW_SETTLE_ENABLED` vive
   * DENTRO del service (AC-8). Mapea ReconciliationError.code → HTTP (disclosure-safe).
   */
  fastify.post<{ Params: { intentId: string } }>(
    '/api/reconciliation/:intentId/resolve',
    { config: { rateLimit: false }, preHandler: requireAdminTokenStrict },
    async (request, reply: FastifyReply) => {
      try {
        const outcome = await reconciliationService.resolveIntent(
          request.params.intentId,
        );
        return reply.status(200).send({
          status: outcome.status,
          ...(outcome.side !== undefined ? { side: outcome.side } : {}),
          ...(outcome.txHash !== undefined ? { txHash: outcome.txHash } : {}),
          // AR BLQ-BAJO-1: el operador necesita saber QUÉ hacer, no sólo un slug. Este
          // estado es el único que le pide una acción fuera del panel (ir a la cadena),
          // así que viaja con su instrucción. No revela nada que el admin no vea ya.
          // AR de HU-202, BLOQUEANTE 3 — ESTE MENSAJE NOMBRABA UNA ACCIÓN INEXISTENTE.
          // Decía "resolvé con esa evidencia" y no había con qué: el único remedio real
          // era un `UPDATE` a mano contra producción. Ahora nombra los dos verbos que sí
          // existen, con la asimetría de evidencia explícita (uno verifica, el otro atesta).
          ...(outcome.status === 'awaiting_manual_settle_evidence'
            ? {
                action_required:
                  'The hop2 payment result is UNKNOWN and this intent was NOT resolved. The reconciler will not resend hop2 blind (that could pay the seller twice). Check the chain for a hop2 disbursement to the seller, then use one of: POST /dashboard/api/reconciliation/:intentId/hop2-evidence with {txHash, resolvedBy} if the seller WAS paid (the hash is verified on-chain before anything is written), or POST /dashboard/api/reconciliation/:intentId/release-lease with {resolvedBy, note} to attest that no disbursement exists and hand the row back to the reconciler. That second one is the only operation that makes a row payable WITHOUT proof, so it needs a second, distinct credential on top of the dashboard token: header X-Reconciliation-Release-Token (env RECONCILIATION_RELEASE_TOKEN). Without it configured the operation stays disabled.',
              }
            : {}),
        });
      } catch (err) {
        request.log.error(
          {
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'resolveIntent failed',
        );
        return sendReconciliationError(reply, err);
      }
    },
  );

  /**
   * POST /dashboard/api/reconciliation/:intentId/hop2-evidence
   *
   * AR de HU-202, BLOQUEANTE 3 (salida 1). Cierra una fila leaseada CON evidencia
   * on-chain: el `txHash` que manda el operador se VERIFICA contra la cadena (token,
   * destinatario `pay_to`, monto ≥ el firmado) ANTES de escribir nada. Money-moving en el
   * sentido de que flipea un terminal ⟹ `requireAdminTokenStrict` (fail-closed), igual que
   * `/resolve`. El gate del flag vive DENTRO del service.
   */
  fastify.post<{
    Params: { intentId: string };
    Body: { txHash?: unknown; resolvedBy?: unknown; note?: unknown };
  }>(
    '/api/reconciliation/:intentId/hop2-evidence',
    { config: { rateLimit: false }, preHandler: requireAdminTokenStrict },
    async (request, reply: FastifyReply) => {
      const body = request.body ?? {};
      // Validación de forma ANTES de tocar el service: un `txHash` que no es 0x-hex no es
      // evidencia de nada, y `resolvedBy` es lo que vuelve auditable la acción.
      const txHash = typeof body.txHash === 'string' ? body.txHash.trim() : '';
      const resolvedBy =
        typeof body.resolvedBy === 'string' ? body.resolvedBy.trim() : '';
      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash) || resolvedBy === '') {
        return reply.status(400).send({ error_code: 'INVALID_EVIDENCE' });
      }
      try {
        const outcome = await reconciliationService.resolveWithHop2Evidence(
          request.params.intentId,
          {
            txHash,
            resolvedBy,
            note: typeof body.note === 'string' ? body.note : null,
          },
        );
        return reply.status(200).send({
          status: outcome.status,
          ...(outcome.txHash !== undefined ? { txHash: outcome.txHash } : {}),
          ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
        });
      } catch (err) {
        request.log.error(
          {
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'resolveWithHop2Evidence failed',
        );
        return sendReconciliationError(reply, err);
      }
    },
  );

  /**
   * POST /dashboard/api/reconciliation/:intentId/release-lease
   *
   * AR de HU-202, BLOQUEANTE 3 (salida 2). Libera el lease sobre una ATESTACIÓN humana de
   * que NO hay desembolso al seller en la cadena, y devuelve la fila al reconciliador.
   *
   * ⚠️ Es la única operación que vuelve pagable una fila sin prueba, así que su seguridad
   * es procedimental: DOS credenciales + `resolvedBy` y `note` OBLIGATORIOS, que quedan en
   * el log de auditoría. Deliberadamente NO existe ningún camino por tiempo hacia acá:
   * liberar por edad reabre el doble pago (caso F).
   *
   * HU-206 — cadena de dos gates, en este orden y NO unificables:
   *   1. `requireAdminTokenStrict`   → el token del panel (`DASHBOARD_ADMIN_TOKEN`).
   *   2. `requireReleaseLeaseToken`  → el secreto propio (`RECONCILIATION_RELEASE_TOKEN`).
   * El hermano `/hop2-evidence` se queda SÓLO con (1) a propósito: su hash se verifica
   * on-chain, así que el camino con prueba no paga fricción. El porqué completo está en el
   * header de `requireReleaseLeaseToken`.
   */
  fastify.post<{
    Params: { intentId: string };
    Body: { resolvedBy?: unknown; note?: unknown };
  }>(
    '/api/reconciliation/:intentId/release-lease',
    {
      config: { rateLimit: false },
      preHandler: [requireAdminTokenStrict, requireReleaseLeaseToken],
    },
    async (request, reply: FastifyReply) => {
      const body = request.body ?? {};
      const resolvedBy =
        typeof body.resolvedBy === 'string' ? body.resolvedBy.trim() : '';
      const note = typeof body.note === 'string' ? body.note.trim() : '';
      // Los dos son obligatorios A PROPÓSITO: una liberación sin autor ni motivo es
      // indistinguible del `UPDATE` a mano que este endpoint viene a reemplazar.
      if (resolvedBy === '' || note === '') {
        return reply.status(400).send({ error_code: 'ATTESTATION_REQUIRED' });
      }
      // HU-206: rastro del INTENTO autorizado, no sólo del efecto. El service ya loguea
      // la liberación aplicada (`ESCROW_HOP2_LEASE_RELEASED_BY_ATTESTATION`), pero sus
      // salidas `flag_off` / `not_leased` no dejan ninguna, y "quién ejerció la credencial
      // de mayor privilegio" tiene que constar aunque la fila no se haya movido.
      request.log.warn(
        {
          intentId: request.params.intentId,
          resolvedBy,
          note,
          audit: 'ESCROW_HOP2_LEASE_RELEASE_REQUESTED',
        },
        'release-lease authorized (dashboard token + release token) and about to run: a human is attesting that no on-chain disbursement to the seller exists.',
      );
      try {
        const outcome = await reconciliationService.releaseHop2Lease(
          request.params.intentId,
          { resolvedBy, note },
        );
        return reply.status(200).send({
          status: outcome.status,
          ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
        });
      } catch (err) {
        request.log.error(
          {
            intentId: request.params.intentId,
            resolvedBy,
            errorClass: err instanceof Error ? err.constructor.name : 'unknown',
          },
          'releaseHop2Lease failed',
        );
        return sendReconciliationError(reply, err);
      }
    },
  );
};

export default dashboardRoutes;
