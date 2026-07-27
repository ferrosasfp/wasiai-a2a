/**
 * Tasks Routes — A2A Protocol task management
 * WKH-23 (baseline)
 * WKH-54 (ownership isolation): every endpoint now requires an A2A key or
 *        x402 payment and filters by `request.a2aKeyRow.owner_ref`.
 *
 * HU-193 (no-charge-before-validating): los 5 endpoints cobran $1
 * (`PLACEHOLDER_FEE_USD`) en el middleware de pago, ANTES del handler. Todo lo
 * que este plugin rechaza por FORMA (UUID inválido, body no-objeto, status fuera
 * del enum, append sin nada que appendear) se decide ahora en la cadena
 * pre-cobro (`middleware/charged-route.ts`), así que ya no se cobra por ellos.
 *
 * ⚠️ CAMBIO DE CONTRATO (declarado): el riel x402 anónimo NO PUEDE operar acá.
 * Todos los endpoints derivan el tenant de `request.a2aKeyRow.owner_ref` y el
 * middleware x402 nunca setea `a2aKeyRow` (no aporta identidad de tenant; ver
 * WKH-63). Antes, un caller x402 pagaba on-chain y recibía **500** — porque
 * `getOwnerRef` lanzaba — sin recurso y sin reembolso posible. Ahora el pedido
 * se rechaza con **403 A2A_KEY_REQUIRED antes de cobrar**. El status cambia
 * (402/500 → 403) y el caller deja de perder plata por un rechazo garantizado.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { refundStep0Debit } from '../lib/step0-refund.js';
import {
  chargedRoute,
  type PreChargeCheck,
  requireA2AKeyPresence,
} from '../middleware/charged-route.js';
import {
  TaskNotFoundError,
  TerminalStateError,
  taskService,
} from '../services/task.js';
import type { TaskState } from '../types/index.js';
import { TASK_STATES } from '../types/index.js';

// ── UUID validation helper ──────────────────────────────────
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUUID(id: string): boolean {
  return UUID_RE.test(id);
}

/**
 * Extract the authenticated caller's owner_ref from the request.
 * Middleware `requirePaymentOrA2AKey` guarantees `request.a2aKeyRow` is
 * set for all authenticated paths. A missing value is treated as an auth
 * bug (defense-in-depth 500).
 *
 * HU-193: el caller x402 (que NO tiene `a2aKeyRow`) ya no llega hasta acá — lo
 * corta `requireA2AKeyPresence` en la cadena pre-cobro, con 403 y sin cobrar.
 * Este throw queda como defensa de un bug de auth, no como camino alcanzable.
 */
function getOwnerRef(request: FastifyRequest): string {
  const ownerRef = request.a2aKeyRow?.owner_ref;
  if (!ownerRef) {
    throw new Error('auth middleware did not populate a2aKeyRow.owner_ref');
  }
  return ownerRef;
}

// ── HU-193: validaciones de FORMA (puras y síncronas) ───────────────────────
// Cada una es la MISMA función que usa el handler como defense-in-depth. El
// guard REAL es el check pre-cobro; el del handler protege contra un
// reordenamiento futuro de la cadena de preHandlers (patrón `validateComposeBody`,
// HU-188).

const A2A_KEY_REQUIRED_MESSAGE =
  'Task management requires an authenticated a2a-key. The x402 anonymous path has no tenant identity, so it cannot own or read tasks.';

type RejectionBody = { error: string };

/** Params `:id` con formato UUID. */
function validateTaskId(params: unknown): RejectionBody | null {
  const id = (params as { id?: unknown } | undefined)?.id;
  if (typeof id !== 'string' || !isValidUUID(id)) {
    return { error: 'Invalid UUID format' };
  }
  return null;
}

/** Body presente y objeto (el 400 histórico `Invalid request body`). */
function validateObjectBody(body: unknown): RejectionBody | null {
  if (body === null || typeof body !== 'object') {
    return { error: 'Invalid request body' };
  }
  return null;
}

/** `status` dentro del enum A2A (query string del list, body del PATCH). */
function validateStatusValue(status: unknown): RejectionBody | null {
  if (!status || !TASK_STATES.includes(status as TaskState)) {
    return { error: `Invalid status: ${status}` };
  }
  return null;
}

/** El append necesita al menos `messages` o `artifacts`. */
function validateAppendBody(body: unknown): RejectionBody | null {
  const invalid = validateObjectBody(body);
  if (invalid) return invalid;
  const b = body as { messages?: unknown; artifacts?: unknown };
  if (!b.messages && !b.artifacts) {
    return { error: 'Must provide messages or artifacts to append' };
  }
  return null;
}

const reject = (body: RejectionBody | null) =>
  body ? { status: 400, body } : null;

const taskIdCheck: PreChargeCheck = (input) =>
  reject(validateTaskId(input.params));
const objectBodyCheck: PreChargeCheck = (input) =>
  reject(validateObjectBody(input.body));
const appendBodyCheck: PreChargeCheck = (input) =>
  reject(validateAppendBody(input.body));
/** El `status` del PATCH vive en el body; el del list, en la query. */
const statusBodyCheck: PreChargeCheck = (input) => {
  const invalid = validateObjectBody(input.body);
  if (invalid) return { status: 400, body: invalid };
  return reject(
    validateStatusValue((input.body as { status?: unknown }).status),
  );
};
/**
 * En el list, `status` es OPCIONAL. Se replica EXACTO el guard histórico
 * (`if (status && !TASK_STATES.includes(...))`): un `?status=` vacío es falsy y
 * NO era un 400, así que sigue sin serlo (contrato sin cambios).
 */
const listStatusCheck: PreChargeCheck = (input) => {
  const status = (input.query as { status?: unknown } | undefined)?.status;
  if (!status) return null;
  return reject(validateStatusValue(status));
};

const tasksRoutes: FastifyPluginAsync = async (fastify) => {
  // WKH-54: all /tasks/* require authentication + ownership isolation.
  // HU-193: la cadena la arma `chargedRoute`, que EXIGE declarar la validación
  // de forma y la pone siempre antes del cobro. `requireA2AKeyPresence` va
  // primero en los 5 endpoints (el riel x402 no puede tener tasks).
  const paymentOpts = {
    description: 'WasiAI A2A Tasks — CRUD requires API key or x402 payment',
  };
  const preHandlersFor = (checks: PreChargeCheck[]) =>
    chargedRoute({
      validate: [requireA2AKeyPresence(A2A_KEY_REQUIRED_MESSAGE), ...checks],
      payment: paymentOpts,
    });

  /**
   * POST /tasks — Create a new task (AC-2)
   */
  fastify.post<{
    Body: {
      contextId?: string;
      messages?: unknown[];
      artifacts?: unknown[];
      metadata?: Record<string, unknown>;
    };
  }>(
    '/',
    { preHandler: preHandlersFor([objectBodyCheck]) },
    async (request, reply: FastifyReply) => {
      const body = request.body;
      // HU-193: defense-in-depth (guard real: `objectBodyCheck` pre-cobro).
      const invalid = validateObjectBody(body);
      if (invalid) {
        return reply.status(400).send(invalid);
      }

      const task = await taskService.create(getOwnerRef(request), {
        contextId: body.contextId,
        messages: body.messages,
        artifacts: body.artifacts,
        metadata: body.metadata,
      });

      return reply.status(201).send(task);
    },
  );

  /**
   * GET /tasks — List tasks with filters (AC-4)
   * Scoped to the caller's owner_ref.
   */
  fastify.get<{
    Querystring: {
      status?: string;
      context_id?: string;
      limit?: string;
    };
  }>(
    '/',
    { preHandler: preHandlersFor([listStatusCheck]) },
    async (request, reply: FastifyReply) => {
      const { status, context_id, limit } = request.query;

      // HU-193: defense-in-depth (guard real: `listStatusCheck` pre-cobro).
      if (status) {
        const invalid = validateStatusValue(status);
        if (invalid) return reply.status(400).send(invalid);
      }

      const parsedLimit = limit ? parseInt(limit, 10) : undefined;
      const safeLimit =
        parsedLimit !== undefined && Number.isFinite(parsedLimit)
          ? parsedLimit
          : undefined;

      const tasks = await taskService.list(getOwnerRef(request), {
        status: status as TaskState | undefined,
        contextId: context_id,
        limit: safeLimit,
      });

      return reply.send({ tasks, total: tasks.length });
    },
  );

  /**
   * GET /tasks/:id — Get a task by ID (AC-3)
   * Returns 404 for both "not found" and "not yours" (existence not leaked).
   */
  fastify.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: preHandlersFor([taskIdCheck]) },
    async (request, reply: FastifyReply) => {
      // HU-193: defense-in-depth (guard real: `taskIdCheck` pre-cobro).
      const invalidId = validateTaskId(request.params);
      if (invalidId) {
        return reply.status(400).send(invalidId);
      }
      const task = await taskService.get(
        getOwnerRef(request),
        request.params.id,
      );
      if (!task) {
        // HU-193 (residuo): "no existe" y "no es tuya" son indistinguibles a
        // propósito, y ambas necesitan un read a la DB con el `owner_ref` del
        // caller → no adelantable. No se entregó ninguna lectura: se devuelve el
        // débito (riel prepago).
        await refundStep0Debit(request, 'tasks.get-one:not-found');
        return reply.status(404).send({ error: 'Task not found' });
      }
      return reply.send(task);
    },
  );

  /**
   * PATCH /tasks/:id/status — Update task status (AC-5)
   * ⚠️ DEBE registrarse ANTES que PATCH /:id (CD-12)
   */
  fastify.patch<{
    Params: { id: string };
    Body: { status: string };
  }>(
    '/:id/status',
    { preHandler: preHandlersFor([taskIdCheck, statusBodyCheck]) },
    async (request, reply: FastifyReply) => {
      // HU-193: defense-in-depth (guards reales: `taskIdCheck` +
      // `statusBodyCheck`, pre-cobro).
      const invalidId = validateTaskId(request.params);
      if (invalidId) {
        return reply.status(400).send(invalidId);
      }
      const invalidBody = validateObjectBody(request.body);
      if (invalidBody) {
        return reply.status(400).send(invalidBody);
      }
      const { status } = request.body;
      const invalidStatus = validateStatusValue(status);
      if (invalidStatus) {
        return reply.status(400).send(invalidStatus);
      }

      try {
        const task = await taskService.updateStatus(
          getOwnerRef(request),
          request.params.id,
          status as TaskState,
        );
        return reply.send(task);
      } catch (err) {
        if (err instanceof TaskNotFoundError) {
          // HU-193 (residuo): read + ownership → no adelantable. Nada se
          // actualizó.
          await refundStep0Debit(request, 'tasks.patch-status:not-found');
          return reply.status(404).send({ error: 'Task not found' });
        }
        if (err instanceof TerminalStateError) {
          // F-05 (audit 2026-06-29): static client message — the 409 already
          // conveys the terminal-state condition; no raw err.message.
          // HU-193 (residuo): el estado terminal se lee de la fila → no
          // adelantable. La transición fue rechazada, nada cambió.
          await refundStep0Debit(request, 'tasks.patch-status:terminal-state');
          return reply.status(409).send({
            error: 'Task is in a terminal state and cannot be updated',
          });
        }
        throw err;
      }
    },
  );

  /**
   * PATCH /tasks/:id — Append messages/artifacts (AC-6)
   */
  fastify.patch<{
    Params: { id: string };
    Body: { messages?: unknown[]; artifacts?: unknown[] };
  }>(
    '/:id',
    { preHandler: preHandlersFor([taskIdCheck, appendBodyCheck]) },
    async (request, reply: FastifyReply) => {
      // HU-193: defense-in-depth (guards reales: `taskIdCheck` +
      // `appendBodyCheck`, pre-cobro).
      const invalidId = validateTaskId(request.params);
      if (invalidId) {
        return reply.status(400).send(invalidId);
      }
      const invalidBody = validateAppendBody(request.body);
      if (invalidBody) {
        return reply.status(400).send(invalidBody);
      }
      const { messages, artifacts } = request.body;

      try {
        const task = await taskService.append(
          getOwnerRef(request),
          request.params.id,
          { messages, artifacts },
        );
        return reply.send(task);
      } catch (err) {
        if (err instanceof TaskNotFoundError) {
          // HU-193 (residuo): read + ownership → no adelantable.
          await refundStep0Debit(request, 'tasks.patch-append:not-found');
          return reply.status(404).send({ error: 'Task not found' });
        }
        if (err instanceof TerminalStateError) {
          // F-05 (audit 2026-06-29): static client message — the 409 already
          // conveys the terminal-state condition; no raw err.message.
          // HU-193 (residuo): estado terminal leído de la fila; nada se appendeó.
          await refundStep0Debit(request, 'tasks.patch-append:terminal-state');
          return reply.status(409).send({
            error: 'Task is in a terminal state and cannot be updated',
          });
        }
        throw err;
      }
    },
  );
};

export default tasksRoutes;
