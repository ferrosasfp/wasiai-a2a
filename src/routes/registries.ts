/**
 * Registries Routes — CRUD for marketplace registrations
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { registryService } from '../services/registry.js'
import type { RegistrySchema, RegistryAuth } from '../types/index.js'

const registriesRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /registries
   * List all registered marketplaces
   */
  fastify.get('/', async (_request: FastifyRequest, reply: FastifyReply) => {
    const registries = registryService.list()
    return reply.send({
      registries,
      total: registries.length,
    })
  })

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
      const { id } = request.params
      const registry = registryService.get(id)

      if (!registry) {
        return reply.status(404).send({ error: 'Registry not found' })
      }

      return reply.send(registry)
    },
  )

  /**
   * POST /registries
   * Register a new marketplace
   */
  fastify.post(
    '/',
    async (
      request: FastifyRequest<{
        Body: {
          name: string
          discoveryEndpoint: string
          invokeEndpoint: string
          agentEndpoint?: string
          schema: RegistrySchema
          auth?: RegistryAuth
          enabled?: boolean
        }
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const body = request.body

        // Validate required fields
        if (!body.name || !body.discoveryEndpoint || !body.invokeEndpoint || !body.schema) {
          return reply.status(400).send({
            error: 'Missing required fields: name, discoveryEndpoint, invokeEndpoint, schema',
          })
        }

        const registry = registryService.register({
          name: body.name,
          discoveryEndpoint: body.discoveryEndpoint,
          invokeEndpoint: body.invokeEndpoint,
          agentEndpoint: body.agentEndpoint,
          schema: body.schema,
          auth: body.auth,
          enabled: body.enabled ?? true,
        })

        return reply.status(201).send(registry)
      } catch (err) {
        return reply.status(400).send({
          error: err instanceof Error ? err.message : 'Failed to register',
        })
      }
    },
  )

  /**
   * PATCH /registries/:id
   * Update a registry
   */
  fastify.patch(
    '/:id',
    async (
      request: FastifyRequest<{ Params: { id: string }; Body: Record<string, unknown> }>,
      reply: FastifyReply,
    ) => {
      try {
        const { id } = request.params
        const body = request.body

        const registry = registryService.update(id, body)
        return reply.send(registry)
      } catch (err) {
        return reply.status(400).send({
          error: err instanceof Error ? err.message : 'Failed to update',
        })
      }
    },
  )

  /**
   * DELETE /registries/:id
   * Delete a registry
   */
  fastify.delete(
    '/:id',
    async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      try {
        const { id } = request.params
        const deleted = registryService.delete(id)

        if (!deleted) {
          return reply.status(404).send({ error: 'Registry not found' })
        }

        return reply.send({ success: true })
      } catch (err) {
        return reply.status(400).send({
          error: err instanceof Error ? err.message : 'Failed to delete',
        })
      }
    },
  )
}

export default registriesRoutes
