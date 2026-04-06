/**
 * Discovery Routes — Search agents across registries
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { discoveryService } from '../services/discovery.js'

const discoverRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /discover
   * Search agents across all registered marketplaces
   *
   * Query params:
   * - capabilities: comma-separated list of capabilities
   * - q: free text search
   * - maxPrice: maximum price per call in USDC
   * - minReputation: minimum reputation score (0-5)
   * - limit: max results
   * - registry: filter to specific registry
   */
  fastify.get(
    '/',
    async (
      request: FastifyRequest<{
        Querystring: {
          capabilities?: string
          q?: string
          maxPrice?: string
          minReputation?: string
          limit?: string
          registry?: string
        }
      }>,
      reply: FastifyReply,
    ) => {
      const query = request.query

      const result = await discoveryService.discover({
        capabilities: query.capabilities?.split(',').map((s) => s.trim()),
        query: query.q,
        maxPrice: query.maxPrice ? parseFloat(query.maxPrice) : undefined,
        minReputation: query.minReputation ? parseFloat(query.minReputation) : undefined,
        limit: query.limit ? parseInt(query.limit) : undefined,
        registry: query.registry,
      })

      return reply.send(result)
    },
  )

  /**
   * GET /discover/:slug
   * Get a specific agent by slug
   */
  fastify.get(
    '/:slug',
    async (
      request: FastifyRequest<{
        Params: { slug: string }
        Querystring: { registry?: string }
      }>,
      reply: FastifyReply,
    ) => {
      const { slug } = request.params
      const { registry } = request.query

      const agent = await discoveryService.getAgent(slug, registry)

      if (!agent) {
        return reply.status(404).send({ error: 'Agent not found' })
      }

      return reply.send(agent)
    },
  )
}

export default discoverRoutes
