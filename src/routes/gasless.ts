/**
 * Gasless Routes (WKH-29 + WKH-38) — testnet PYUSD only.
 * Always registered (DT-1, WKH-38). Status returns 200 with funding_state.
 * Transfer returns 503 when not ready (AC-5).
 */
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import {
  getGaslessStatus,
  signTransferWithAuthorization,
  submitGaslessTransfer,
} from '../lib/gasless-signer.js'

const gaslessRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /gasless/status — always 200, structured funding_state (AC-1..AC-4, AC-6).
   */
  fastify.get('/status', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const status = await getGaslessStatus()
      return reply.send(status)
    } catch (err) {
      // CD-3: getGaslessStatus should never throw, but defensive fallback.
      // H-1: NUNCA re-emitir err.message (puede contener env vars o secretos).
      fastify.log.error(
        { errorClass: err instanceof Error ? err.constructor.name : 'unknown' },
        'gasless status failed',
      )
      return reply.status(500).send({ error: 'gasless status failed' })
    }
  })

  /**
   * POST /gasless/transfer — 503 guard when funding_state !== 'ready' (AC-5).
   * Reuses signTransferWithAuthorization + submitGaslessTransfer pipeline (CD-5).
   */
  fastify.post('/transfer', async (req: FastifyRequest, reply: FastifyReply) => {
    // AC-5: check operational status first
    const status = await getGaslessStatus()
    if (status.funding_state !== 'ready') {
      return reply.status(503).send({
        error: 'gasless_not_operational',
        message: `Gasless module is not operational (funding_state: ${status.funding_state})`,
        documentation: 'https://github.com/ferrosasfp/wasiai-a2a/blob/main/doc/architecture/CHAIN-ADAPTIVE.md',
      })
    }

    // CD-5: reuse existing pipeline
    const body = req.body as { to?: string; value?: string }
    if (!body?.to || !body?.value) {
      return reply.status(400).send({ error: 'missing required fields: to, value' })
    }

    try {
      const payload = await signTransferWithAuthorization({
        to: body.to as `0x${string}`,
        value: BigInt(body.value),
      })
      const result = await submitGaslessTransfer(payload)
      return reply.send(result)
    } catch (err) {
      // CD-1: sanitize errors — never expose PK or internal details
      fastify.log.error(
        { errorClass: err instanceof Error ? err.constructor.name : 'unknown' },
        'gasless transfer failed',
      )
      return reply.status(500).send({ error: 'gasless transfer failed' })
    }
  })
}

export default gaslessRoutes
