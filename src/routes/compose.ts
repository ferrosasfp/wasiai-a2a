/**
 * Compose Routes — Multi-agent pipelines
 * WKH-18: Timeout preHandler, error boundary integration.
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { composeService } from '../services/compose.js'
import type { ComposeStep } from '../types/index.js'
import { requirePaymentOrA2AKey } from '../middleware/a2a-key.js'
import { createTimeoutHandler } from '../middleware/timeout.js'
import { orchestrateRateLimit } from '../middleware/rate-limit.js'

type ComposeBody = {
  steps: ComposeStep[]
  maxBudget?: number
}

const composeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: ComposeBody }>(
    '/',
    {
      config: { rateLimit: orchestrateRateLimit() },
      preHandler: [
        createTimeoutHandler(parseInt(process.env.TIMEOUT_COMPOSE_MS ?? '60000')),
        ...requirePaymentOrA2AKey({
          description: 'WasiAI Compose Service — Multi-agent pipeline execution',
        }),
      ],
    },
    async (request, reply: FastifyReply) => {
      const body = request.body

      if (!body.steps || !Array.isArray(body.steps) || body.steps.length === 0) {
        return reply.status(400).send({
          error: 'Missing or empty steps array',
          code: 'VALIDATION_ERROR',
          requestId: request.id,
        })
      }

      if (body.steps.length > 5) {
        return reply.status(400).send({
          error: 'Maximum 5 steps allowed per pipeline',
          code: 'VALIDATION_ERROR',
          requestId: request.id,
        })
      }

      // BLQ-2: bail early if timeout already sent 504
      if (reply.sent) return

      const result = await composeService.compose({
        steps: body.steps,
        maxBudget: body.maxBudget,
      })

      // BLQ-2: bail early if timeout fired during compose
      if (reply.sent) return

      if (!result.success) {
        return reply.status(400).send({
          ...result,
          requestId: request.id,
        })
      }

      const kiteTxHash = request.paymentTxHash
      return reply.send({ kiteTxHash, ...result })
    },
  )
}

export default composeRoutes
