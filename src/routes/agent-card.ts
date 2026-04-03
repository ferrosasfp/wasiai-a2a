import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { discoveryService } from '../services/discovery.js'
import { registryService } from '../services/registry.js'
import { agentCardService, resolveBaseUrl } from '../services/agent-card.js'

const agentCardRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /agents/:slug/agent-card
   * Returns an A2A-compliant Agent Card for the given agent.
   */
  fastify.get(
    '/:slug/agent-card',
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

      // ⚠️ CD-9: Agent.registry = name, NOT id. Match by name.
      const registries = await registryService.getEnabled()
      const registryConfig = registries.find((r) => r.name === agent.registry)

      if (!registryConfig) {
        return reply.status(404).send({ error: 'Agent not found' })
      }

      const baseUrl = resolveBaseUrl(request)
      const card = agentCardService.buildAgentCard(agent, registryConfig, baseUrl)

      return reply.send(card)
    },
  )
}

export default agentCardRoutes
