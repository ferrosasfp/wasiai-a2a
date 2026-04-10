/**
 * Gasless Routes (WKH-29 + WKH-38) -- chain-adaptive gasless transfers.
 */
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { getGaslessAdapter } from '../adapters/registry.js'

const gaslessRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/status', { config: { rateLimit: false } }, async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const status = await getGaslessAdapter().status()
      return reply.send(status)
    } catch (err) {
      fastify.log.error({ errorClass: err instanceof Error ? err.constructor.name : 'unknown' }, 'gasless status failed')
      return reply.status(500).send({ error: 'gasless status failed' })
    }
  })

  fastify.post('/transfer', async (req: FastifyRequest, reply: FastifyReply) => {
    const status = await getGaslessAdapter().status()
    if (status.funding_state !== 'ready') {
      return reply.status(503).send({ error: 'gasless_not_operational', message: `Gasless module is not operational (funding_state: ${status.funding_state})`, documentation: 'https://github.com/ferrosasfp/wasiai-a2a/blob/main/doc/architecture/CHAIN-ADAPTIVE.md' })
    }
    const body = req.body as { to?: string; value?: string }
    if (!body?.to || !body?.value) return reply.status(400).send({ error: 'missing required fields: to, value' })
    try {
      const result = await getGaslessAdapter().transfer({ to: body.to as `0x${string}`, value: BigInt(body.value) })
      return reply.send(result)
    } catch (err) {
      fastify.log.error({ errorClass: err instanceof Error ? err.constructor.name : 'unknown' }, 'gasless transfer failed')
      return reply.status(500).send({ error: 'gasless transfer failed' })
    }
  })
}

export default gaslessRoutes
