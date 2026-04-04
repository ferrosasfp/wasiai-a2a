/**
 * Orchestrate Routes — Goal-based orchestration
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { orchestrateService } from '../services/orchestrate.js'
import { requirePayment } from '../middleware/x402.js'

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
      preHandler: requirePayment({
        description: 'WasiAI Orchestration Service — Goal-based AI agent orchestration',
      }),
    },
    async (request, reply: FastifyReply) => {
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
      } catch (err: unknown) {
        // Timeout — 504
        if (
          err instanceof Error &&
          'code' in err &&
          (err as NodeJS.ErrnoException).code === 'ORCHESTRATION_TIMEOUT'
        ) {
          return reply.status(504).send({ error: 'Orchestration timeout: exceeded 120s' })
        }
        // Capacidades faltantes — 422
        if (
          err instanceof Error &&
          'code' in err &&
          (err as NodeJS.ErrnoException).code === 'MISSING_CAPABILITIES'
        ) {
          return reply.status(422).send({
            error: 'Cannot build pipeline',
            missingCapabilities: ((err as unknown) as { missingCapabilities: string[] }).missingCapabilities,
          })
        }
        return reply.status(500).send({
          error: err instanceof Error ? err.message : 'Orchestration failed',
        })
      }
    },
  )
}

export default orchestrateRoutes
