import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { agentCardService, resolveBaseUrl } from '../services/agent-card.js'

const wellKnownRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /.well-known/agent.json
   * Returns the gateway's own A2A Agent Card.
   */
  fastify.get(
    '/agent.json',
    { config: { rateLimit: false } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const baseUrl = resolveBaseUrl(request)
      const card = agentCardService.buildSelfAgentCard(baseUrl)
      return reply.send(card)
    },
  )
}

export default wellKnownRoutes
