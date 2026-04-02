/**
 * Orchestrate Routes — Goal-based orchestration
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { orchestrateService } from '../services/orchestrate.js'

const orchestrateRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /orchestrate
   * Execute goal-based orchestration
   *
   * Body:
   * {
   *   "goal": "Analyze token 0xABC and tell me if it's safe to buy",
   *   "budget": 0.50,
   *   "preferCapabilities": ["token-analysis", "risk-assessment"],
   *   "maxAgents": 3
   * }
   */
  fastify.post(
    '/',
    async (
      request: FastifyRequest<{
        Body: {
          goal: string
          budget: number
          preferCapabilities?: string[]
          maxAgents?: number
        }
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const body = request.body

        if (!body.goal) {
          return reply.status(400).send({ error: 'Missing required field: goal' })
        }

        if (!body.budget || body.budget <= 0) {
          return reply.status(400).send({ error: 'Missing or invalid budget' })
        }

        const result = await orchestrateService.orchestrate({
          goal: body.goal,
          budget: body.budget,
          preferCapabilities: body.preferCapabilities,
          maxAgents: body.maxAgents,
        })

        return reply.send(result)
      } catch (err) {
        return reply.status(500).send({
          error: err instanceof Error ? err.message : 'Orchestration failed',
        })
      }
    },
  )
}

export default orchestrateRoutes
