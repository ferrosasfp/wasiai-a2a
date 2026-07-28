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
 * configurado responde 503 en dev Y prod (este `POST` mueve dinero — nunca abierto).
 * Comparación timing-safe (reusa el patrón de `requireAdminToken`).
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
      message: 'Reconciliation API not configured',
    });
  }
  const provided = request.headers['x-admin-token'];
  if (typeof provided !== 'string') {
    return reply.status(401).send({
      error: 'unauthorized',
      message: 'X-Admin-Token header required for reconciliation API',
    });
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return reply.status(401).send({
      error: 'unauthorized',
      message: 'X-Admin-Token header required for reconciliation API',
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
   * Gateado por requireAdminToken + isArbiterEnabled. La validación autoritativa
   * vive en arbiterService.resolveHold; acá sólo un shape-check defensivo.
   */
  fastify.post<{ Params: { intentId: string } }>(
    '/api/arbitrations/:intentId/resolve',
    { config: { rateLimit: false }, preHandler: requireAdminToken },
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
   */
  fastify.get(
    '/api/reconciliation',
    { config: { rateLimit: false }, preHandler: requireAdminToken },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const [pending, drift] = await Promise.all([
          reconciliationService.listPending(),
          reconciliationService.driftCheck(),
        ]);
        return reply.send({
          pending,
          drift,
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
          ...(outcome.status === 'awaiting_manual_settle_evidence'
            ? {
                action_required:
                  'The hop2 payment result is UNKNOWN and this intent was NOT resolved. The reconciler will not resend hop2 blind (that could pay the seller twice). Check the chain for a hop2 disbursement to the seller, then resolve with that evidence.',
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
};

export default dashboardRoutes;
