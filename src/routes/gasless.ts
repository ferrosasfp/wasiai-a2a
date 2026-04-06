/**
 * Gasless Routes (WKH-29) — testnet PYUSD only.
 * Registrado condicionalmente a GASLESS_ENABLED=true desde src/index.ts.
 */
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { getGaslessStatus } from '../lib/gasless-signer.js'

const gaslessRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/status', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const status = await getGaslessStatus()
      return reply.send(status)
    } catch (err) {
      // H-1: NUNCA re-emitir err.message (puede contener env vars o secretos).
      // Log interno con clase del error; respuesta genérica al cliente.
      fastify.log.error(
        { errorClass: err instanceof Error ? err.constructor.name : 'unknown' },
        'gasless status failed',
      )
      return reply.status(500).send({ error: 'gasless status failed' })
    }
  })
}

export default gaslessRoutes
