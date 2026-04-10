/**
 * Auth Routes — A2A Agent Key endpoints
 * WKH-34: Agentic Economy Primitives L3
 *
 * POST /agent-signup  — Create new agent key (AC-13)
 * POST /deposit       — Register deposit (AC-14)
 * GET  /me            — Get key status (AC-15)
 * POST /bind/:chain   — Placeholder for on-chain binding (AC-16)
 */

import crypto from 'node:crypto'
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { identityService } from '../services/identity.js'
import { budgetService } from '../services/budget.js'
import type { A2AAgentKeyRow, CreateKeyInput, DepositInput } from '../types/index.js'

// ── Helper: resolve caller key from x-a2a-key header ────────

async function resolveCallerKey(request: FastifyRequest): Promise<A2AAgentKeyRow | null> {
  const headerValue = request.headers['x-a2a-key']
  if (!headerValue || typeof headerValue !== 'string') return null

  const keyHash = crypto.createHash('sha256').update(headerValue).digest('hex')
  return identityService.lookupByHash(keyHash)
}

// ── Routes ──────────────────────────────────────────────────

const authRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * POST /agent-signup — Create a new agent key (AC-13)
   */
  fastify.post('/agent-signup', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as Partial<CreateKeyInput> | undefined

    if (!body?.owner_ref || typeof body.owner_ref !== 'string' || body.owner_ref.trim() === '') {
      return reply.status(400).send({ error: 'owner_ref is required and must be a non-empty string' })
    }

    try {
      const result = await identityService.createKey({
        owner_ref: body.owner_ref,
        display_name: body.display_name,
        daily_limit_usd: body.daily_limit_usd,
        allowed_registries: body.allowed_registries,
        allowed_agent_slugs: body.allowed_agent_slugs,
        allowed_categories: body.allowed_categories,
        max_spend_per_call_usd: body.max_spend_per_call_usd,
      })

      return reply.status(201).send(result)
    } catch (err) {
      fastify.log.error(
        { errorClass: err instanceof Error ? err.constructor.name : 'unknown' },
        'agent-signup failed',
      )
      return reply.status(500).send({ error: 'Failed to create agent key' })
    }
  })

  /**
   * POST /deposit — Register a deposit (AC-14)
   */
  fastify.post('/deposit', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as Partial<DepositInput> | undefined

    if (!body?.key_id || !body?.chain_id || !body?.token || !body?.amount || !body?.tx_hash) {
      return reply.status(400).send({ error: 'Missing required fields: key_id, chain_id, token, amount, tx_hash' })
    }

    // Resolve caller key from header
    const callerKey = await resolveCallerKey(req)
    if (!callerKey || !callerKey.is_active) {
      return reply.status(403).send({ error: 'Invalid or inactive API key' })
    }

    // Verify caller owns the key_id
    if (callerKey.id !== body.key_id) {
      return reply.status(403).send({ error: 'API key does not own the specified key_id' })
    }

    try {
      // TODO(WKH-35): verify deposit on-chain via PaymentAdapter.verify
      const balance = await budgetService.registerDeposit(
        body.key_id,
        body.chain_id,
        body.amount,
      )

      return reply.status(200).send({
        balance,
        chain_id: body.chain_id,
      })
    } catch (err) {
      fastify.log.error(
        { errorClass: err instanceof Error ? err.constructor.name : 'unknown' },
        'deposit failed',
      )
      return reply.status(500).send({ error: 'Failed to register deposit' })
    }
  })

  /**
   * GET /me — Get key status (AC-15)
   */
  fastify.get('/me', async (req: FastifyRequest, reply: FastifyReply) => {
    const callerKey = await resolveCallerKey(req)
    if (!callerKey || !callerKey.is_active) {
      return reply.status(403).send({ error: 'Invalid or inactive API key' })
    }

    return reply.status(200).send({
      key_id: callerKey.id,
      display_name: callerKey.display_name,
      budget: callerKey.budget,
      daily_limit_usd: callerKey.daily_limit_usd,
      daily_spent_usd: callerKey.daily_spent_usd,
      daily_reset_at: callerKey.daily_reset_at,
      scoping: {
        allowed_registries: callerKey.allowed_registries,
        allowed_agent_slugs: callerKey.allowed_agent_slugs,
        allowed_categories: callerKey.allowed_categories,
        max_spend_per_call_usd: callerKey.max_spend_per_call_usd,
      },
      is_active: callerKey.is_active,
      bindings: {
        erc8004_identity: callerKey.erc8004_identity,
        kite_passport: callerKey.kite_passport,
        agentkit_wallet: callerKey.agentkit_wallet,
      },
      created_at: callerKey.created_at,
    })
  })

  /**
   * POST /bind/:chain — Placeholder (AC-16)
   */
  fastify.post('/bind/:chain', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.status(501).send({
      status: 'not_implemented',
      message: 'On-chain identity binding is planned for Fase 2. See doc/architecture/CHAIN-ADAPTIVE.md',
    })
  })
}

export default authRoutes
