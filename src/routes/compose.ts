/**
 * Compose Routes — Multi-agent pipelines
 */

import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { composeService } from '../services/compose.js'

const composeRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /compose
   * Execute a multi-agent pipeline
   *
   * Body:
   * {
   *   "steps": [
   *     { "agent": "agent-slug", "registry": "wasiai", "input": {...}, "passOutput": false },
   *     { "agent": "another-agent", "input": {...}, "passOutput": true }
   *   ],
   *   "maxBudget": 0.50
   * }
   */
  fastify.post(
    '/',
    async (
      request: FastifyRequest<{
        Body: {
          steps: Array<{
            agent: string
            registry?: string
            input?: Record<string, unknown>
            passOutput?: boolean
          }>
          maxBudget?: number
        }
      }>,
      reply: FastifyReply,
    ) => {
      try {
        const body = request.body

        if (!body.steps || !Array.isArray(body.steps) || body.steps.length === 0) {
          return reply.status(400).send({ error: 'Missing or empty steps array' })
        }

        if (body.steps.length > 5) {
          return reply.status(400).send({ error: 'Maximum 5 steps allowed per pipeline' })
        }

        const result = await composeService.compose({
          steps: body.steps,
          maxBudget: body.maxBudget,
        })

        if (!result.success) {
          return reply.status(400).send(result)
        }

        return reply.send(result)
      } catch (err) {
        return reply.status(500).send({
          error: err instanceof Error ? err.message : 'Compose failed',
        })
      }
    },
  )
}

export default composeRoutes
