/**
 * Compose Routes — Multi-agent pipelines
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { composeService } from '../services/compose.js'
import type { ComposeStep } from '../types/index.js'
import { requirePayment } from '../middleware/x402.js'

type ComposeBody = {
  steps: ComposeStep[]
  maxBudget?: number
}

const composeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: ComposeBody }>(
    '/',
    {
      preHandler: requirePayment({
        description: 'WasiAI Compose Service — Multi-agent pipeline execution',
      }),
    },
    async (request, reply: FastifyReply) => {
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

        const kiteTxHash = request.kiteTxHash
        return reply.send({ kiteTxHash, ...result })
      } catch (err) {
        return reply.status(500).send({
          error: err instanceof Error ? err.message : 'Compose failed',
        })
      }
    },
  )
}

export default composeRoutes
