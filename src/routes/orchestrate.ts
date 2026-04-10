/**
 * Orchestrate Routes — Goal-based orchestration with LLM planning
 *
 * WKH-13: orchestrationId generated here (not in service),
 * passed to service, always available for response/error.
 * WKH-18: Backpressure + timeout preHandlers, structured logging, error boundary.
 */

import crypto from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { orchestrateService } from '../services/orchestrate.js'
import { requirePaymentOrA2AKey } from '../middleware/a2a-key.js'
import { createBackpressureHandler } from '../middleware/backpressure.js'
import { createTimeoutHandler } from '../middleware/timeout.js'

type OrchestrateBody = {
  goal: string
  budget: number
  preferCapabilities?: string[]
  maxAgents?: number
}

const orchestrateRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: OrchestrateBody }>(
    '/',
    {
      schema: {
        body: {
          type: 'object',
          required: ['goal', 'budget'],
          properties: {
            goal: { type: 'string', minLength: 1, maxLength: 2000 },
            budget: { type: 'number', exclusiveMinimum: 0, maximum: 100000 },
            maxAgents: { type: 'integer', minimum: 1, maximum: 20 },
            preferCapabilities: {
              type: 'array',
              items: { type: 'string', maxLength: 100 },
              maxItems: 20,
            },
          },
        },
      },
      preHandler: [
        createBackpressureHandler(),
        createTimeoutHandler(parseInt(process.env.TIMEOUT_ORCHESTRATE_MS ?? '120000')),
        ...requirePaymentOrA2AKey({
          description: 'WasiAI Orchestration Service — Goal-based AI agent orchestration',
        }),
      ],
    },
    async (request, reply: FastifyReply) => {
      const orchestrationId = crypto.randomUUID()

      try {
        const body = request.body

        request.log.info({ orchestrationId }, 'Orchestration started')

        // BLQ-2: bail early if timeout already sent 504
        if (reply.sent) return

        const result = await orchestrateService.orchestrate(
          {
            goal: body.goal.trim(),
            budget: body.budget,
            preferCapabilities: body.preferCapabilities,
            maxAgents: body.maxAgents,
          },
          orchestrationId,
        )

        // BLQ-2: bail early if timeout fired during orchestration
        if (reply.sent) return

        const kiteTxHash = request.paymentTxHash
        return reply.send({ kiteTxHash, ...result })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Orchestration failed'
        request.log.error({ orchestrationId, err: message }, 'Orchestration failed')
        // Attach orchestrationId to the error for the error boundary
        const wrappedErr = err instanceof Error ? err : new Error(message)
        ;(wrappedErr as Error & { orchestrationId?: string }).orchestrationId = orchestrationId
        throw wrappedErr
      }
    },
  )
}

export default orchestrateRoutes
