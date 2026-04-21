/**
 * Registries Routes — CRUD for marketplace registrations
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { requirePaymentOrA2AKey } from '../middleware/a2a-key.js';
import { registryService } from '../services/registry.js';
import type { RegistryAuth, RegistrySchema } from '../types/index.js';

const registriesRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /registries
   * List all registered marketplaces
   */
  fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    const registries = await registryService.list();
    return reply.send({
      registries,
      total: registries.length,
    });
  });

  /**
   * GET /registries/:id
   * Get a specific registry
   */
  fastify.get(
    '/:id',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const { id } = request.params;
      const registry = await registryService.get(id);

      if (!registry) {
        return reply.status(404).send({ error: 'Registry not found' });
      }

      return reply.send(registry);
    },
  );

  /**
   * POST /registries
   * Register a new marketplace
   */
  fastify.post<{
    Body: {
      name: string;
      discoveryEndpoint: string;
      invokeEndpoint: string;
      agentEndpoint?: string;
      schema: RegistrySchema;
      auth?: RegistryAuth;
      enabled?: boolean;
    };
  }>(
    '/',
    {
      preHandler: [
        ...requirePaymentOrA2AKey({
          description: 'WasiAI Registry Management — Register marketplace',
        }),
      ],
    },
    async (request, reply: FastifyReply) => {
      try {
        const body = request.body;

        // Validate required fields
        if (
          !body.name ||
          !body.discoveryEndpoint ||
          !body.invokeEndpoint ||
          !body.schema
        ) {
          return reply.status(400).send({
            error:
              'Missing required fields: name, discoveryEndpoint, invokeEndpoint, schema',
          });
        }

        const registry = await registryService.register({
          name: body.name,
          discoveryEndpoint: body.discoveryEndpoint,
          invokeEndpoint: body.invokeEndpoint,
          agentEndpoint: body.agentEndpoint,
          schema: body.schema,
          auth: body.auth,
          enabled: body.enabled ?? true,
        });

        return reply.status(201).send(registry);
      } catch (err) {
        return reply.status(400).send({
          error: err instanceof Error ? err.message : 'Failed to register',
        });
      }
    },
  );

  /**
   * PATCH /registries/:id
   * Update a registry
   */
  fastify.patch<{
    Params: { id: string };
    Body: Record<string, unknown>;
  }>(
    '/:id',
    {
      preHandler: [
        ...requirePaymentOrA2AKey({
          description: 'WasiAI Registry Management — Update marketplace',
        }),
      ],
    },
    async (request, reply: FastifyReply) => {
      try {
        const { id } = request.params;
        const body = request.body;

        const registry = await registryService.update(id, body);
        return reply.send(registry);
      } catch (err) {
        return reply.status(400).send({
          error: err instanceof Error ? err.message : 'Failed to update',
        });
      }
    },
  );

  /**
   * DELETE /registries/:id
   * Delete a registry
   */
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    {
      preHandler: [
        ...requirePaymentOrA2AKey({
          description: 'WasiAI Registry Management — Delete marketplace',
        }),
      ],
    },
    async (request, reply: FastifyReply) => {
      try {
        const { id } = request.params;
        const deleted = await registryService.delete(id);

        if (!deleted) {
          return reply.status(404).send({ error: 'Registry not found' });
        }

        return reply.send({ success: true });
      } catch (err) {
        return reply.status(400).send({
          error: err instanceof Error ? err.message : 'Failed to delete',
        });
      }
    },
  );
};

export default registriesRoutes;
