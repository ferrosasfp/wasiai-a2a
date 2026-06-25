/**
 * Auth Routes — key status (WKH-34, AC-15).
 *
 * Pure reorganization of `src/routes/auth.ts` (refactor B2, 2026-06-24).
 * GET /me — Get key status.
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { keccak256, stringToBytes } from 'viem';
import { resolveCallerKey } from './parsers.js';

export const meRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /me — Get key status (AC-15)
   */
  fastify.get('/me', async (req: FastifyRequest, reply: FastifyReply) => {
    const callerKey = await resolveCallerKey(req);
    if (!callerKey?.is_active) {
      return reply.status(403).send({ error: 'Invalid or inactive API key' });
    }

    return reply.status(200).send({
      key_id: callerKey.id,
      key_id_hash: keccak256(stringToBytes(callerKey.id)),
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
    });
  });
};
