/**
 * Tasks Routes — A2A Protocol task management
 * WKH-23
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
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

const tasksRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /tasks — Create a new task (AC-2)
   */
  fastify.post(
    '/',
    async (
      request: FastifyRequest<{
        Body: {
          contextId?: string;
          messages?: unknown[];
          artifacts?: unknown[];
          metadata?: Record<string, unknown>;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const body = request.body;
      if (body === null || typeof body !== 'object') {
        return reply.status(400).send({ error: 'Invalid request body' });
      }

      const task = await taskService.create({
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
   */
  fastify.get(
    '/',
    async (
      request: FastifyRequest<{
        Querystring: {
          status?: string;
          context_id?: string;
          limit?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const { status, context_id, limit } = request.query;

      // Validate status if provided
      if (status && !TASK_STATES.includes(status as TaskState)) {
        return reply.status(400).send({ error: `Invalid status: ${status}` });
      }

      const parsedLimit = limit ? parseInt(limit, 10) : undefined;
      const safeLimit =
        parsedLimit !== undefined && Number.isFinite(parsedLimit)
          ? parsedLimit
          : undefined;

      const tasks = await taskService.list({
        status: status as TaskState | undefined,
        contextId: context_id,
        limit: safeLimit,
      });

      return reply.send({ tasks, total: tasks.length });
    },
  );

  /**
   * GET /tasks/:id — Get a task by ID (AC-3)
   */
  fastify.get(
    '/:id',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      if (!isValidUUID(request.params.id)) {
        return reply.status(400).send({ error: 'Invalid UUID format' });
      }
      const task = await taskService.get(request.params.id);
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
  fastify.patch(
    '/:id/status',
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { status: string };
      }>,
      reply: FastifyReply,
    ) => {
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
   * ⚠️ Registrado DESPUÉS de PATCH /:id/status (CD-12)
   */
  fastify.patch(
    '/:id',
    async (
      request: FastifyRequest<{
        Params: { id: string };
        Body: { messages?: unknown[]; artifacts?: unknown[] };
      }>,
      reply: FastifyReply,
    ) => {
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
        const task = await taskService.append(request.params.id, {
          messages,
          artifacts,
        });
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
