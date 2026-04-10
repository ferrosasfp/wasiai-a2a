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
// budgetService import retained as comment — re-enable when deposit verification lands (WKH-35)
// import { budgetService } from '../services/budget.js'
import type { A2AAgentKeyRow, CreateKeyInput } from '../types/index.js'

// ── Helper: resolve caller key from x-a2a-key header ────────

async function resolveCallerKey(request: FastifyRequest): Promise<A2AAgentKeyRow | null> {
  // DT-2 (WKH-BEARER-FIX): Priority order: x-a2a-key > Bearer wasi_a2a_* > null
  let rawKey: string | undefined

  const headerValue = request.headers['x-a2a-key']
  if (headerValue && typeof headerValue === 'string') {
    rawKey = headerValue
  } else {
    // DT-1/DT-3: case-insensitive scheme, case-sensitive prefix (same as a2a-key.ts:86-93)
    const authHeader = request.headers['authorization']
    if (authHeader && typeof authHeader === 'string') {
      const match = /^bearer\s+(.+)$/i.exec(authHeader)
      if (match && match[1].startsWith('wasi_a2a_')) {
        rawKey = match[1]
      }
    }
  }

  if (!rawKey) return null

  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex')
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
   * BLQ-5: Disabled until on-chain verification is implemented.
   * The atomic registerDeposit service (BLQ-4 fix) is ready for re-enable.
   */
  fastify.post('/deposit', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.status(501).send({
      error: 'deposit_verification_pending',
      message: 'Deposit endpoint requires on-chain verification via PaymentAdapter.verify() (WKH-35). Currently disabled for safety.',
      documentation: 'https://github.com/ferrosasfp/wasiai-a2a/blob/main/doc/architecture/CHAIN-ADAPTIVE.md',
    })
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
