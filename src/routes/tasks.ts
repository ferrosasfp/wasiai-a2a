/**
 * Tasks Routes — A2A Protocol task management
 * WKH-23 (baseline)
 * WKH-54 (ownership isolation): every endpoint now requires an A2A key or
 *        x402 payment and filters by `request.a2aKeyRow.owner_ref`.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  TaskNotFoundError,
  TerminalStateError,
  taskService,
} from '../services/task.js';
import type { TaskState } from '../types/index.js';
import { TASK_STATES } from '../types/index.js';
import { requirePaymentOrA2AKey } from '../middleware/a2a-key.js';

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
 */
function getOwnerRef(request: FastifyRequest): string {
  const ownerRef = request.a2aKeyRow?.owner_ref;
  if (!ownerRef) {
    throw new Error('auth middleware did not populate a2aKeyRow.owner_ref');
  }
  return ownerRef;
}

const tasksRoutes: FastifyPluginAsync = async (fastify) => {
  // WKH-54: all /tasks/* require authentication + ownership isolation.
  const authPreHandler = requirePaymentOrA2AKey({
    description: 'WasiAI A2A Tasks — CRUD requires API key or x402 payment',
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
    { preHandler: authPreHandler },
    async (request, reply: FastifyReply) => {
      const body = request.body;
      if (body === null || typeof body !== 'object') {
        return reply.status(400).send({ error: 'Invalid request body' });
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
    { preHandler: authPreHandler },
    async (request, reply: FastifyReply) => {
      const { status, context_id, limit } = request.query;

      if (status && !TASK_STATES.includes(status as TaskState)) {
        return reply.status(400).send({ error: `Invalid status: ${status}` });
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
    { preHandler: authPreHandler },
    async (request, reply: FastifyReply) => {
      if (!isValidUUID(request.params.id)) {
        return reply.status(400).send({ error: 'Invalid UUID format' });
      }
      const task = await taskService.get(getOwnerRef(request), request.params.id);
      if (!task) {
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
    { preHandler: authPreHandler },
    async (request, reply: FastifyReply) => {
      if (!isValidUUID(request.params.id)) {
        return reply.status(400).send({ error: 'Invalid UUID format' });
      }
      if (!request.body || typeof request.body !== 'object') {
        return reply.status(400).send({ error: 'Invalid request body' });
      }
      const { status } = request.body;

      if (!status || !TASK_STATES.includes(status as TaskState)) {
        return reply.status(400).send({ error: `Invalid status: ${status}` });
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
          return reply.status(404).send({ error: 'Task not found' });
        }
        if (err instanceof TerminalStateError) {
          return reply.status(409).send({ error: err.message });
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
    { preHandler: authPreHandler },
    async (request, reply: FastifyReply) => {
      if (!isValidUUID(request.params.id)) {
        return reply.status(400).send({ error: 'Invalid UUID format' });
      }
      if (!request.body || typeof request.body !== 'object') {
        return reply.status(400).send({ error: 'Invalid request body' });
      }
      const { messages, artifacts } = request.body;

      if (!messages && !artifacts) {
        return reply
          .status(400)
          .send({ error: 'Must provide messages or artifacts to append' });
      }

      try {
        const task = await taskService.append(
          getOwnerRef(request),
          request.params.id,
          { messages, artifacts },
        );
        return reply.send(task);
      } catch (err) {
        if (err instanceof TaskNotFoundError) {
          return reply.status(404).send({ error: 'Task not found' });
        }
        if (err instanceof TerminalStateError) {
          return reply.status(409).send({ error: err.message });
        }
        throw err;
      }
    },
  );
};

export default tasksRoutes;
